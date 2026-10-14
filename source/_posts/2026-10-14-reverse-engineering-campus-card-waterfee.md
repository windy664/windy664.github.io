---
title: 逆向 G 校校园卡小程序：水电余额监控接入个人自动化助手
date: 2026-10-14 23:30:00
tags:
  - 逆向工程
  - 微信小程序
  - mitmproxy
  - Rust
  - 校园生活
  - 自动化
categories:
  - 技术分享
---

# 逆向 G 校校园卡小程序：水电余额监控接入个人自动化助手

## 前言

我在维护一个跑在宿舍服务器上的个人自动化助手 Ru41（Rust 编写，任务系统 + Agent 底座 + 消息推送）。它的设计文档里一直躺着一项「水电费监控」：每天自动读宿舍水电余额、记录历史、余额低了主动提醒我。

校园卡的充值入口在微信小程序里，没有任何公开 API。于是就有了这次完整的逆向实践：从静态分析小程序包，到纯 API 登录的三次失败，再到 mitmproxy 抓包突破，最后把接口接入 Ru41 跑通每日监控。

**最终成果**：

- 完整还原 ecard 平台的认证与签名机制（`MD5(排序参数 + "greatge")`）
- 拿到水电余额、日用量明细两个只读接口，token 重放验证成功
- Ru41 新增 `ecard poll/run` 命令：每日采集 → 历史落库 → 低余额经飞书/QQ 提醒
- 一套防敏感信息泄漏的开发规范（含 CI secrets 扫描）

**脱敏说明**：学校名统一写作「G 校」，相关域名打码为 `*.g***.edu.cn`，学号/手机号/token/房间号等个人数据一律使用占位符。厂商信息（新中新 ecard、联奕 CAS）为公开商业产品，予以保留。

## 一、技术选型

| 工具 | 用途 |
|------|------|
| strings / grep | 小程序包静态分析（wxapkg 加密，提取可读字符串） |
| mitmproxy | 抓包与 token 捕获 |
| Python (requests) | 接口探测与重放验证 |
| Rust | Ru41 监控模块 |
| curl | 单接口调试 |

## 二、静态分析：从小程序包里能挖到什么

### 2.1 定位目标包

PC 微信（Linux 新版 xwechat）的小程序包缓存在：

```bash
~/.xwechat/radium/Applet/packages/<AppID>/<版本>/__APP__.wxapkg
```

目录里有十几个包，逐个用中文关键词定位（注意 `strings` 默认只提 ASCII，中文要 `grep -a` 直接搜 UTF-8 字节）：

```bash
for d in $(ls -t); do
  pkg=$(find "$d" -name "*.wxapkg" | head -1)
  hits=$(LC_ALL=C grep -acE "校园卡|水电|电费|充值" "$pkg" 2>/dev/null || echo 0)
  echo "$d 中文命中=$hits"
done
```

命中 5 次的包就是目标。进一步 `grep -aoE ".{20}(余额|充值).{20}"` 确认：「账户余额」「钱包充值」等字样齐全。

### 2.2 域名与接口清单

```bash
strings -n 6 __APP__.wxapkg | grep -oE "https?://[a-zA-Z0-9./_-]+" | sort -u
```

发现三个关键域名（已打码）：

- `ecarduser.g***.edu.cn` —— 用户服务（API 主域）
- `ecardhall.g***.edu.cn` —— 服务大厅
- `boss.greatge.net` —— 厂商管理端（新中新 ecard 平台，公开商业产品）

接口提取（JS 里以 `userServerHost+"路径"` 形式拼接）：

```
userServerHost:"https://ecarduser.g***.edu.cn/"
/waterfee/checkAccount        # 水费账户类型判定
/user/routine/dologin         # 登录
/user/routine/phonePwdLogin   # 密码登录
/user/routine/sendVerifyCode  # 短信验证码
/user/routine/phoneVerifyCodeLogin
/user/routine/loginTypeList   # 可用登录方式列表
```

前端路由里还有 `powerFeeUrl:"/powerfee/index"`、`waterFeeUrl:"/waterfee/index"` —— 注意这两个是 **H5 页面路径**，不是原生页面。

### 2.3 签名算法完整还原

搜索 `md5` 相关上下文，找到请求签名逻辑：

```javascript
// wxapkg 中提取到的原始代码（格式化过）
objKeySort: function(t) {
  delete t.token; delete t.sign;
  for (var n = "", r = Object.keys(t).sort(), a = {}, o = 0; o < r.length; o++)
    a[r[o]] = t[r[o]];
  for (var i in a) n += i + "=" + a[i] + "&";
  return n + e.default.secret   // secret: "greatge"
}
// 调用处：
var c = this.objKeySort(n.data);
n.data.sign = md5(c).toUpperCase();
n.data.token = wx.getStorageSync("token");  // token 在签名之后才加入
```

翻译成规则就是：**`sign = MD5(按 key 排序的 k=v& 拼接 + "greatge")` 转大写，token 和 sign 本身不参与签名**。另外每个请求会自动附加公共字段 `from=wxminiprogram`、`wxRequest="wxRequest"`（参与签名）。

用 Python 复现：

```python
import hashlib
SECRET = "greatge"

def sign(data: dict) -> str:
    payload = {k: v for k, v in data.items() if k not in ("token", "sign")}
    raw = "".join(f"{k}={payload[k]}&" for k in sorted(payload)) + SECRET
    return hashlib.md5(raw.encode()).hexdigest().upper()

def call(path, data, token=None):
    data = {**data, "from": "wxminiprogram", "wxRequest": "wxRequest"}
    data["sign"] = sign(data)
    if token:
        data["token"] = token
    return requests.post(f"{BASE}/{path}", data=data, timeout=15).json()
```

验证签名正确性：调用无需登录态的 `loginTypeList`，返回 `{"ret":true, ...}`——签名机制确认无误，并得知该校校园卡启用的登录方式是 `SYSTEM_ACCOUNT`（学工号登录）。

### 2.4 意外收获：H5 页面不加密

水电费页面是 webview 内嵌 H5（`/powerfee/index`、`/waterfee/index`），直接 curl 就能拿到 73KB 服务端渲染 HTML，里面的 ajax 调用一览无余：

```javascript
$.ajax({
    url: '/waterfee/getBalance',
    type: "post",
    data: {
        "implType": implType,
        "roomNum": roomNum,
        "buildingNo": buildingNo,
        "from": '', "token": ''   // 服务端渲染时注入
    },
    success: function (response) {
        $("#feeTip").html("该房间剩余水量：" + response.obj.formatWaterBalanceStr);
    }
})
```

H5 还暴露了 `getRoomInfo`（房间三级列表）、`bindRoomInfo`（房间绑定）、`feeOrderList`（缴费记录）等接口。**wxapkg 是加密的，但 H5 不是**——这是静态分析阶段最重要的突破口。

## 三、纯 API 登录的三次失败

目标是脱离微信环境直接拿 token，这样服务器才能每日自动查询。试了三条路，全部失败，但每次都排除了错误假设。

### 3.1 dologin：卡在 openid

按静态分析的参数调用：

```python
call("user/routine/dologin", {
    "account": "<学号>",
    "password": hashlib.md5(b"<密码>").hexdigest()[8:24],  # 小程序的密码变换
    "loginType": "spnsSigner",
})
# {"ret": false, "msg": "获取openid或者unionid失败，请退出小程序重新进入"}
```

登录在服务端强依赖微信 openid 绑定（小程序运行时由 `wx.login` 的临时 code 经 `oauth/getTicket` 换得），换学号、换 loginType（`SYSTEM_ACCOUNT`/`rftSigner`）都同样报错。**纯 API 无法完成首次登录**，这条路死了。

### 3.2 CAS 单点登录：CODEFALSE

ecard 的 H5 会 302 到学校统一认证：`sso.g***.edu.cn` → `cas.g***.edu.cn/lyuapServer/login`（联奕 CAS）。CAS 有标准 REST 协议，前端 SPA 的 JS 里还挖出了 RSA 公钥参数：

```javascript
// app.<hash>.js 中：
{ CAS: "/lyuapServer", public_exponent: "010001",
  modulus: "413798867d69babed22e0d..." }  // 256 位十六进制（1024-bit）
// 提交逻辑：password 经 RSA 加密后 POST /lyuapServer/v1/tickets
```

手写 PKCS#1 v1.5 填充 + `pow(em, 65537, modulus)` 加密密码（不需要任何依赖库），POST 到 `/v1/tickets`：

```python
def rsa_encrypt_pwd(pwd: str) -> str:
    m = pwd.encode(); k = 128; n = k - 3 - len(m); ps = b""
    while len(ps) < n:
        ps += bytes(b for b in os.urandom(n * 2) if b)
    em = b"\x00\x02" + ps[:n] + b"\x00" + m
    c = pow(int.from_bytes(em, "big"), 65537, MODULUS)
    return base64.b64encode(c.to_bytes(k, "big")).decode()
```

结果统一返回 `{"data":{"code":"CODEFALSE"}}`——CAS 侧密码与校园卡密码不同步（或还有未还原的加密细节）。这条路暂时搁置。

### 3.3 短信验证码：最接近的一次

发现 `sendVerifyCode`（发短信）+ `phoneVerifyCodeLogin`（验证码登录）组合。实测发送成功：

```python
call("user/routine/sendVerifyCode", {
    "phoneNumber": "138****0000", "loginType": "SYSTEM_ACCOUNT", "isUpdatePwd": "false"
})
# {"ret": true, "msg": "验证码发送成功"}
```

手机秒收到短信。但用读到的 4 位验证码登录返回「短信验证码不正确」——可能是验证码读错/过期，也可能登录参数还有未还原的细节。没有继续重发轰炸接口，转向抓包。

### 3.4 顺便排除：本地存储

小程序的 wx storage 存在 MMKV 文件里（`~/.xwechat/radium/Applet/<hash>/local/<AppID>/usrmmkvstorage*/`），打开一看全是随机字节——PC 微信对小程序存储做了加密，strings 提不出任何键名。放弃。

## 四、抓包突破

### 4.1 免 root 给当前用户装 mitmproxy CA

Linux 下 Chromium 系应用读 NSS 共享证书库，用户级安装无需 root：

```bash
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n mitmproxy \
  -i ~/.mitmproxy/mitmproxy-ca-cert.pem
```

### 4.2 环境变量代理失败

尝试过 `https_proxy=http://127.0.0.1:8080 wechat` 重启微信注入代理——小程序照常联网但代理里零流量，**WeChatAppEx 小程序运行时忽略系统/环境代理**。

### 4.3 手动代理 + mitmproxy 采集脚本

走老路：微信设置 → 通用设置 → 网络代理 → 手动 `127.0.0.1:8080`。mitmdump 挂一个只记录目标域的脚本：

```python
import json, time
from mitmproxy import http

LOG = "ecard_capture.jsonl"
DOMAINS = ("g***.edu.cn", "greatge.net")

class EcardCapture:
    def response(self, flow: http.HTTPFlow):
        if not any(d in flow.request.pretty_host for d in DOMAINS):
            return
        record = {
            "ts": time.strftime("%H:%M:%S"),
            "method": flow.request.method,
            "url": flow.request.pretty_url,
            "req_body": (flow.request.get_text() or "")[:2000],
            "status": flow.response.status_code,
            "resp_body": (flow.response.get_text() or "")[:4000],
        }
        with open(LOG, "a") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

addons = [EcardCapture()]
```

打开小程序 → 点进电费页 → 73 条请求到手。

### 4.4 真实流量分析

**登录态获取**（小程序每次启动的实际调用）：

```
POST /user/routine/routine-login
  code=<wx.login 临时 code>&openid=o6***&unionid=op***&sno=<学号>
  &from=wxminiprogram&wxRequest=wxRequest&sign=<签名>&token=<旧 token>
→ {"code":200, "token":"node0***...", "msg":"登录成功", ...}
```

关键发现：**请求里已经带着本地存储的旧 token，且服务端接受**——token 是长效的，跨会话复用。这意味着只要抓一次 token，就能长期以脚本身份查询（有效期需实测）。

**余额接口**（无需签名，凭 token）：

```
POST /powerfee/getBalance
  implType=CGCOMMON1111&schoolAreaNo=81&buildingNo=1859&roomNum=2158&from=wxminiprogram&token=node0***
→ {"ret":true,"obj":{
     "powerBalance":"19.7", "waterBalance":"2.8",
     "formatPowerBalanceStr":"19.70度", "formatWaterBalanceStr":"2.80吨",
     "schoolArea":"***校区","building":"***楼","room":"*#***"}}
```

**日用量明细**（区分充值与消耗的关键）：

```
POST /powerfee/getDailyDetails
  roomNum=***&lastDate=2026-10&type=2&implType=...&pageNum=1&pageSize=20&token=...
  # type=1 水，type=2 电
→ {"dailyDetailsInfos":[
     {"dailyUsed":"12.01","leftUsed":"9.85","dateTime":"2026-10-01"},
     {"dailyUsed":"4.34","leftUsed":"-1.42","dateTime":"2026-10-03"}, ...]}
```

`leftUsed` 为负后紧跟跳升 = 先透支再充值，充值事件可以从数据里直接识别。

### 4.5 token 重放验证与 WAF 限流

curl 原样重放 `getBalance`，返回与小程序内完全一致——**链路通了**。过程中观察到平台 WAF：单 IP 突发请求会被 SSL reset 断连，隔十几秒自动恢复。这直接决定了采集节奏：每日 1-2 次请求，失败退避，绝不并发。

## 五、落地 Ru41：ecard 监控模块

### 5.1 架构位置

模块完全复用 Ru41 既有的来源适配器模式，核心零改动：

```
ecard run（定时器，默认每日）
   ↓ POST /powerfee/getBalance
读数落 records（ecard_reading，同日覆盖、跨日成历史）
   ↓ 纯 Rust 阈值判断（设计原则：金额计算不交给 Agent）
低于阈值 → [notify] 默认出口（飞书 webhook / QQ）推送提醒
   ↓ ecard_alert 记录去重，同一天最多提醒一次
```

配置（本地 `ru41.toml`，gitignored）：

```toml
[sources.ecard]
base_url = "https://ecarduser.g***.edu.cn"
token = "node0***"            # 建议环境变量 RU41_ECARD_TOKEN
impl_type = "CGCOMMON1111"
school_area_no = "**"
building_no = "****"
room_num = "****"
power_threshold = 10.0        # 度
water_threshold = 1.0         # 吨
interval_secs = 86400
```

使用：

```bash
ru41 ecard poll   # 查一次（适合系统 cron 每日调用）
ru41 ecard run    # 常驻每日查询
# 输出：{"power": 18.87, "power_label": "18.87度", "water": 2.8, ...}
```

### 5.2 渠道解耦

Ru41 里渠道知识只存在于装配层：业务模块只说「要提醒」，由全局 `[notify] channel` 决定走飞书还是 QQ——ecard 模块拿到的只是注入的 `NotifyChannel` trait 对象，代码里没有任何渠道名。

### 5.3 敏感信息防护

逆向涉及 token、学号、手机号等一批敏感数据，开发规范做了明确分层：

| 层 | 内容 | 去向 |
|---|---|---|
| 协议层 | 端点、参数名、签名算法、厂商 secret | 代码与文档，可公开 |
| 账户层 | token、openid、学号、房间号 | 只进本地配置（gitignored）或环境变量 |
| 凭据层 | 密码、短信验证码 | 只在内存，即时哈希，不落盘 |

配套措施：

- 学校域名从代码中移除，`base_url` 改为本地配置项
- CI 加 secrets 扫描：`grep -rInE "node[0-9a-z]{30,}|1[3-9][0-9]{9}|..."`，命中即失败（测试用的假数据文件加白名单）
- 抓包日志从 /tmp 挪到 `~/.config/ru41/`（700 权限），测试一律使用假数据

## 六、踩坑记录

**6.1 strings 不显示中文。** GNU strings 默认只提 ASCII 序列，UTF-8 中文全被过滤。中文关键词必须 `LC_ALL=C grep -a` 直接搜二进制。

**6.2 被自己的测试坑了 14 分钟。** 集成测试里写了 `let body = &bodies.lock().unwrap()[0];`——Rust 的临时生命周期延长让 MutexGuard 活到作用域结束，mock 服务器线程在第二轮请求时永远拿不到锁，测试挂死无输出。修法：从锁里 clone 出数据立刻释放。**教训：持锁引用不要跨 await 或跨请求。**

**6.3 CAS 的 CODEFALSE 不等于加密错误。** 联奕 CAS 的 REST 端点对任何失败（用户名错、密码错、加密错）都返回同一个 `CODEFALSE`，盲调加密细节是浪费时间——后来意识到 SSO 密码和校园卡密码根本不同步。

**6.4 token 有效期不能假设。** 抓包证明了 token 当下有效、且小程序跨会话复用，但具体寿命只有等它失效那天才知道。模块设计上把「token 失效返回明确错误 → 提醒人工重抓」作为一等路径，而不是假装它永久有效。

## 七、合规与边界

- 只读自己宿舍的余额与日用量，接口调用频率 ≤ 每日数次，远低于平台正常用户行为
- 不碰充值下单接口（已定位 `/user/account/chargePay`，首版明确不做自动充值）
- 协议细节公开有助于同平台（新中新 ecard 服务了大量高校）其他同学做个人自动化；个人凭据严格本地保存

## 八、总结

这次逆向的路径比上次（[校园点餐系统逆向](https://windy664.github.io/2026/09/26/2026-09-26-reverse-engineering-gruangroun-xiaoer/)）曲折得多：静态分析拿到的签名算法完全正确，但**正确的签名不等于能登录**——服务端把首次登录绑死在微信 openid 上，纯 API 三条路全部走不通，最后还是 mitmproxy 一锤定音。

方法论上的收获：

1. **先静态后动态**：签名算法、接口清单、H5 端点都在抓包前就已就位，抓包只需要验证和补 token，效率完全不同
2. **H5 是金矿**：wxapkg 加密防住了原生代码，但 webview 里的 H5 是明文的
3. **失败路径也要记录**：dologin、CAS、短信码三条死路排除了错误假设，下一次遇到同平台其他功能时不用再走
4. **监控类需求要尊重平台**：WAF 限流不是障碍而是边界，每日几次的查询节奏对双方都好

现在 Ru41 每天早上会看一眼我的水电余额，低于 10 度就往飞书推一条提醒。按 10 月日均 5.7 度的消耗，第一次真实提醒应该很快就会到来——那将是对整条链路最好的验收。
