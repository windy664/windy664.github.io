---
title: 花了一整天硬刚小米 HyperOS 2.0 的 BootLoader 加密，被教做人了
date: 2026-09-26 21:00:00
tags:
  - Android
  - 逆向工程
  - 小米
  - HyperOS
  - BootLoader
  - ADB
  - 加密
categories:
  - 技术分享
---

# 花了一整天硬刚小米 HyperOS 2.0 的 BootLoader 加密，被教做人了

## 写在前面

事情是这样的。我手里有一台 Redmi Note 12，想解锁 BootLoader 刷个 Magisk 玩玩。以前 MIUI 时代这事挺简单的，GitHub 上一搜一堆工具，改个 `rom_version` 字段就能绕过去。结果这次折腾了一整天，试了七八种方法，全部失败。

写这篇文章把整个过程记录下来，一是给自己做个笔记，二是给后来的人提个醒——HyperOS 2.0 这次的加密升级是真的到位了，不是以前那种随便改改就能绕过去的水平。

## 设备信息

先交代一下我这台机器的情况：

- **型号**：Redmi Note 12（代号 sunstone，型号 22101317C）
- **系统**：HyperOS 2.0.6.0.UMQCNXM（中国版）
- **Android**：14
- **芯片**：联发科 MT6833（天玑 6020）
- **Build ID**：UKQ1.240624.001
- **指纹**：`Redmi/sunstone/sunstone:14/UKQ1.240624.001/OS2.0.6.0.UMQCNXM:user/release-keys`

中国版设备，这是个关键点。国际版的限制可能没这么严。

## 先说结论

**没 root 的情况下，HyperOS 2.0 的 BL 绑定加密基本无解。**

小米这次的思路很清晰：把加密密钥的私钥放在服务器端，客户端只有公钥。你能在本地做的一切操作，都需要服务器配合才能完成。而服务器会检查你的设备有没有在小米社区申请过解锁授权。没授权？对不起，30001 错误，滚去小米社区申请。

想绕过？你需要改数据里的 `rom_version` 字段。想改数据？你需要解密。想解密？你需要 RSA 私钥。RSA 私钥在哪？在小米服务器上。

死锁了。

## 开始干活：先看看别人怎么做的

### 读 GitHub 项目

我先去 GitHub 上搜了一圈，找到三个主要的绕过项目：

**1. MlgmXyysd/Xiaomi-HyperOS-BootLoader-Bypass**

这是最早的 Python 实现。原理很简单：通过 logcat 监听 `CloudDeviceStatus` 标签，捕获 Settings 应用发送的绑定请求，解密数据，把 `rom_version` 从 `V816`（HyperOS）改成 `V14`（MIUI），重新加密签名，发给服务器。

核心代码就几行：

```python
args = json.loads(decryptData(args))
args["rom_version"] = args["rom_version"].replace("V816", "V14")
args = json.dumps(args, separators=(",", ":"))
sign = signData(args)
```

加密方式是 AES-128-CBC，密钥硬编码在代码里：`20nr1aobv2xi8ax4`，IV 是 `0102030405060708`。

**2. K0lb3/Xiaomi-HyperOS-BootLoader-Bypass-Python-Port**

上面那个项目的 Python 移植版，逻辑基本一样。

**3. TheAirBlow/HyperSploit**

C# 写的，有个很骚的操作——它内置了一份旧版的 Settings APK（没打补丁的那种），直接帮你降级。关键代码里有这么一行：

```csharp
private static string? Decrypt(string text) {
    if (text.StartsWith("#&^")) return null;  // 新格式，搞不定
    // ... 用硬编码密钥解密 ...
}
```

看到 `#&^` 开头就直接返回 null，说明作者已经知道新格式搞不定了。

### 看看设备上的 Settings APK

我把设备上的 Settings APK 拉出来看看：

```bash
adb pull /system_ext/priv-app/Settings/Settings.apk /tmp/Settings_device.apk
```

105MB，挺大的。APK 里面一堆 DEX 文件，我主要看 `classes2.dex` 和 `classes4.dex`。

用 `strings` 命令配合十六进制编辑器翻了半天，找到了不少东西：

**RSA 公钥**（在 `classes2.dex` 偏移 7116962 的位置）：

```
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxPEmV1vZ60qc39gWvaSc
7QgV/Ltc95eTBiWsRcN5VDeqjGwRPmk7TBXvU+YQ6q2LrfiaDQYg8ZwxjwUTsWoL
J7l8AHE0WdUEvdV36+BMbB9w7ts2IISZZNnJyyZleU+SImWYRybKkTPX//Ld/bgK
NFz3dxJzYxLXdKzcZogHLI2Mvvj31/ZmqvKuRxXBQ2iU4oSPthQRXFY+KbQJ1Z3Z
sFzMJfGaY1jj+8ymUd4zWGXgztQLuvpUNtiVHGW1WhP8854yJqbQ1VcqfIueKR74
qoQgUbXHFuYbvz6B0c+bEgJ/tn/bXcM8Zo8aADFgZNCChbzAhB9wf3zx2RLJe7aN
awIDAQAB
```

RSA-2048，公钥指数 65537。模数以 `0xc4f126575bd9eb4a9cdfd816bda49ced` 开头。

**其他找到的密钥**：

| 偏移 | 值 | 用途 |
|------|-----|------|
| 6167963 | `0102030405060708` | 旧版 AES IV（还在，但新版不用了）|
| 6168451 | `10f29ff413c89c8de02349cb3eb9a5f5...` | HMAC 签名密钥（64字节）|
| 6168583 | `158a7dbb3a76489a81a76ecd24a452be` | 不确定，可能是另一个 AES 密钥 |

**关键字符串**：

- `RSA/ECB/PKCS1Padding` — RSA 加密算法
- `mEncrytedKey` — 加密后的 AES 密钥字段（注意拼写，typo 了）
- `mSecretKey` — 原始 AES 密钥字段
- `encryptMsg` / `wrapEncryptMsg` — 加密方法名
- `SYM_ENCRYPT_ALGORITHM_IV` — IV 的常量名
- `LogEncryptor` — 加密器的类名，在 `com.android.settings.bootloader` 包下

## 加密协议：从 AES 到 RSA+AES

### 旧版（MIUI 时代）

简单粗暴，AES-128-CBC 硬编码密钥：

```python
DATA_PASS = b"20nr1aobv2xi8ax4"   # 16字节，写死在代码里
DATA_IV = b"0102030405060708"      # 8字节，也写死了
```

数据就是 JSON 直接加密，base64 编码。谁都能解。GitHub 上的工具就是利用这个——你知道密钥，就能解密、修改、重新加密。

### 新版（HyperOS 2.0）

小米把加密方案换了。不是小修小补，是整个推翻重来。

新流程：

1. 每次请求生成一个**随机 AES 密钥**（`KeyGenerator.getInstance("AES")`）
2. 用这个 AES 密钥加密 JSON 数据（AES-CBC-PKCS5Padding）
3. 用 RSA-2048 公钥加密 AES 密钥（RSA-ECB-PKCS1Padding）
4. 把两个加密结果拼在一起：`#&^RSA加密的AES密钥!!AES加密的数据^&#`
5. HMAC-SHA1 签名（签名密钥没变）

关键区别：**AES 密钥是随机的，每次请求都不一样**。旧版的硬编码密钥完全没用了。

而且 RSA 公钥虽然在 DEX 里能找到，但**私钥只在服务器上**。你加密了 AES 密钥，但你解不了。只有小米的服务器能解。

## 开搞：七种方法全部失败

### 方法一：直接跑原始绕过脚本

我想着先把原来的脚本跑起来看看，至少能知道新格式长什么样。

原来的脚本用正则匹配 logcat 输出，一行一行读 `args:` 和 `headers:`。但新版的格式变了，`args` 和 `headers` 合并到一行里了，用 `#&^` 和 `^&#` 包起来，中间用 `!!` 分隔。

我改了一下解析逻辑：

```python
if data.startswith("#&^") and "!!" in data:
    inner = data[3:-3]
    parts = inner.split("!!")
    if len(parts) == 2:
        args = parts[0]      # RSA 加密的 AES 密钥
        headers = parts[1]   # AES 加密的数据
```

能解析了，但下一步解密直接报错：

```
ValueError: Data must be padded to 16 byte boundary in CBC mode
```

废话，这是 RSA 加密后的 AES 密钥，不是 AES 加密的数据。你拿 AES 密钥去解 RSA 加密的东西，当然不对。

### 方法二：降级 Settings APK

HyperSploit 内置了旧版的 Settings APK，那个版本用的是旧加密。我想着把它装上去，不就能用旧的绕过方法了吗？

```bash
adb install /tmp/Settings.apk
```

结果：

```
INSTALL_FAILED_INVALID_APK: Package com.android.settings are not updateable
```

HyperOS 直接不让装。Settings 是系统核心应用，不让降级。

我不死心，试了好几种方法：

- 直接安装：不行
- `adb root` 然后替换系统文件：`adbd cannot run as root`，没有 root
- 用 `pm install-create` 的 session 安装：不行
- 先 `pm uninstall --user 0` 卸载再装：卸载成功了，但安装还是失败
- 最后用 `cmd package install-existing com.android.settings` 把 Settings 恢复回去，差点把手机搞砖

**教训**：别随便卸载系统应用。

### 方法三：在设备上跑 Java 代码

我想着能不能用 `app_process` 在设备上跑一段 Java 代码，直接调用 `AccountManager` 拿到 serviceToken。

写了个简单的 Java 程序，用反射访问 `ActivityThread` 和 `AccountManager`：

```java
public class GetToken {
    public static void main(String[] args) {
        Class<?> atClass = Class.forName("android.app.ActivityThread");
        Method currentAT = atClass.getMethod("currentActivityThread");
        Object at = currentAT.invoke(null);
        // ... 反射拿 AccountManager ...
    }
}
```

编译，推送到设备，运行：

```bash
javac GetToken.java
adb push GetToken.class /data/local/tmp/
adb shell "cd /data/local/tmp && app_process / GetToken"
```

结果：`Aborted`。直接崩了。

我以为是 `.class` 格式的问题（Android 需要 DEX），试了 `dalvikvm`：

```bash
adb shell "dalvikvm -cp GetToken.class GetToken"
```

结果：`ClassNotFoundException`。`.class` 文件确实不能直接用，需要转成 DEX 格式。但设备上没有 `d8` 或 `dx` 工具，本地也没装 Android SDK。

这条路也堵死了。

### 方法四：伪造绑定请求

既然解不了原始请求，那我从头造一个呢？

我从设备上收集了所有需要的信息：

```python
device_id = device.shell("settings get secure android_id").strip()
model = device.shell("getprop ro.product.model").strip()
fp = device.shell("getprop ro.build.fingerprint").strip()
# ... 还有一堆 ...
```

然后构造 JSON 数据，把 `rom_version` 设成 `V14`，用 HMAC-SHA1 签名，发给服务器：

```python
data = {
    "authType": 2,
    "clientVersion": "1.0",
    "deviceId": device_id,
    "fingerprint": fp,
    "nonce": nonce,
    "rom_version": "V14",  # 伪装成 MIUI
    # ... 其他字段 ...
}
sign = signData(json.dumps(data, separators=(",", ":")))
req = Request(f"{API}/v1/unlock/applyBind",
    data=urlencode({"data": data_str, "sid": "miui_sec_android", "sign": sign}).encode(),
    headers={"Content-Type": "application/x-www-form-urlencoded"},
    method="POST")
```

结果：`{"code":10000,"description":"参数异常"}`

试了各种变体——完整数据、最小数据、不带 nonce、不带签名、带 Cookie、V14、V816——全部返回 10000。

连空数据都返回 10000。这说明服务器在检查一些我没提供的东西。后来想想，大概率是缺了 `serviceToken`——Settings 应用发请求的时候会在 Cookie 里带上这个 token，但我拿不到。

### 方法五：拦截 HTTP 请求

既然我构造不了请求，那我拦截 Settings 应用自己发的请求，看看它发了什么？

**mitmproxy 方案**：

```bash
adb reverse tcp:8080 tcp:8080
adb shell "settings put global http_proxy 127.0.0.1:8080"
mitmdump --listen-port 8080
```

等了半天，一个包都没捕获到。原因是 HTTPS 流量走的是加密通道，HTTP 代理根本拦不住。而且要在设备上安装 mitmproxy 的 CA 证书才能解密 HTTPS，那又需要 root。

**iptables 方案**：

```bash
adb shell "iptables -t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT --to-port 8080"
```

`Permission denied (you must be root)`。iptables 也要 root。

**strace 方案**：

```bash
adb shell "strace -p 26278 -e trace=network -s 4096"
```

`ptrace(PTRACE_SEIZE, 26278): Operation not permitted`。strace 也要 root。

所有能拦截网络流量的方法都需要 root。没有 root 就是个瞎子。

### 方法六：从 AccountManager 提取 serviceToken

serviceToken 是小米账号的认证 token，存在 Android 的 AccountManager 里。Settings 应用发请求的时候会从 AccountManager 取这个 token，放到 Cookie 头里。

我想尽办法去拿这个 token：

```bash
# content query 试试
adb shell "content query --uri content://com.xiaomi.account.provider/account"
# -> Could not find provider

# service call 调 AccountManager
adb shell "service call account 17"
# -> account can't be found

# dumpsys 看看有没有
adb shell "dumpsys account"
# -> 只能看到账号名 "2807***558"，看不到 token

# am startservice 触发
adb shell "am startservice -n com.xiaomi.account/.authenticator.XmAuthenticationService \
    --es action getAuthToken --es accountType com.xiaomi"
# -> 服务启动了，但 token 拿不到

# 直接读 SharedPreferences
adb shell "ls /data/data/com.xiaomi.account/shared_prefs/"
# -> Permission denied
```

`dumpsys account` 能看到账号存在（`Account {name=2807***558, type=com.xiaomi}`），但 token 是加密存储的，没有 root 读不到。

### 方法七：Frida 动态 Hook

最后一招了。Frida 是个动态 instrumentation 工具，可以在运行时 hook Java 方法。我想着 hook Settings 应用的 `LogEncryptor` 类，把 AES 密钥截获下来。

```bash
pip3 install frida frida-tools
wget "https://github.com/frida/frida/releases/download/17.19.0/frida-server-17.19.0-android-arm64.xz"
xz -d frida-server.xz
adb push frida-server /data/local/tmp/
adb shell "chmod +x /data/local/tmp/frida-server"
adb shell "/data/local/tmp/frida-server -D"
```

结果：

```
Unable to load SELinux policy from the kernel: Failed to open file 
'/sys/fs/selinux/policy': Permission denied
```

frida-server 需要 root 权限。SELinux 策略读不了，进程也 attach 不上。

七种方法，全部失败。

## 关键发现：30001 错误

在折腾的过程中，我一直在用 logcat 监听 `CloudDeviceStatus` 标签。虽然我自己的伪造请求全部返回 10000，但我捕获到了 Settings 应用自己发的请求的**服务器响应**：

```json
{
  "code": 30001,
  "description": "绑定失败，请前往小米社区内测中心申请授权后重试",
  "descEN": "Couldn't add. Please go to Mi Community to apply for authorization and try again."
}
```

这个信息量很大：

1. **服务器能解密新格式**。Settings 应用发的 RSA+AES 加密数据，服务器处理成功了（返回的是 30001 而不是 10000）。
2. **问题不在加密，在授权**。服务器拒绝不是因为解密失败，而是因为这台设备/这个账号没有获得解锁授权。
3. **原来的绕过思路是对的**。如果能把 `rom_version` 从 `V816` 改成 `V14`，服务器可能会跳过授权检查（MIUI 时代的设备没有这个限制）。

但问题就在于——**改不了**。

我还注意到 Settings 应用在不停地重试，每隔一秒钟发一次请求，每次都拿到 30001。看来 Settings 应用自己也有重试机制，但服务器每次都拒绝。

## 完整的加密协议

既然都分析到这了，把完整的协议整理一下：

### 数据格式

旧版：
```
<Base64 编码的 AES 加密数据>
```

新版：
```
#&^<Base64(RSA加密的AES密钥)>!!<Base64(AES加密的数据)>^&#
```

### 加密流程

```
1. 获取 nonce（GET /v1/micloud/nonce?sid=miui_sec_android）
2. 构造 JSON 数据（包含 nonce、设备信息、rom_version 等）
3. 生成随机 AES-128 密钥
4. AES-CBC-PKCS5Padding 加密 JSON → encryptedData
5. RSA-ECB-PKCS1Padding 加密 AES 密钥 → encryptedKey
6. 拼接：#&^<Base64(encryptedKey)>!!<Base64(encryptedData)>^&#
7. HMAC-SHA1 签名（签名内容：POST\n/v1/unlock/applyBind\ndata=<JSON>&sid=miui_sec_android）
8. POST 到 /v1/unlock/applyBind
```

### HMAC 签名

签名密钥（从 DEX 里提取的，没变）：

```
10f29ff413c89c8de02349cb3eb9a5f510f29ff413c89c8de02349cb3eb9a5f5
```

签名内容格式：

```
POST\n/v1/unlock/applyBind\ndata=<完整的JSON字符串>&sid=miui_sec_android
```

### API 端点

- 获取 nonce：`GET https://unlock.update.miui.com/v1/micloud/nonce?sid=miui_sec_android`
- 绑定请求：`POST https://unlock.update.miui.com/v1/unlock/applyBind`

## 为什么所有方法都失败

总结一下每个方法卡在哪里：

| 方法 | 卡在哪 |
|------|--------|
| 原始脚本 | 新加密格式解不了 |
| 降级 Settings | HyperOS 阻止安装 |
| app_process | 设备上没有 DEX 转换工具 |
| 伪造请求 | 缺 serviceToken，服务器不认 |
| mitmproxy | HTTPS 拦截需要 CA 证书（要 root）|
| iptables | 需要 root |
| strace | 需要 root |
| 提取 serviceToken | AccountManager 权限不够 |
| Frida | frida-server 需要 root |

看到规律了吗？**每条路最后都指向同一个问题：没有 root。**

而获取 root 需要解锁 BL，解锁 BL 需要绕过加密，绕过加密需要 root。

死锁。

小米这次的设计确实聪明——把 RSA 私钥放服务器端，客户端永远拿不到。你在本地做的任何操作，最终都要服务器点头才行。而服务器只认两种情况：要么你的设备在小米社区申请过授权，要么你把 `rom_version` 改成 MIUI 的格式让它以为你是老设备。

前者是官方途径，后者需要你能修改加密数据——但你改不了，因为你没有 RSA 私钥。

## 对比一下新旧版本

| | 旧版 (MIUI) | 新版 (HyperOS 2.0) |
|---|---|---|
| 加密 | AES-128-CBC，密钥硬编码 | RSA-2048 + AES-128-CBC，密钥随机 |
| 数据格式 | 纯 Base64 | `#&^...!!...^&#` 分隔 |
| 密钥在哪 | DEX 里写死了 | RSA 私钥只在服务器 |
| Settings 降级 | 能装 | 装不了 |
| 服务器验证 | 只看格式 | 看授权状态 |
| 绕过难度 | 改个字段就行 | 基本不可能 |

## 还有什么能试的

虽然这次失败了，但还是列几个可能的方向，万一以后有人能搞出来呢：

**1. 内核提权漏洞**

HyperOS 2.0 基于 Android 14，如果找到一个内核提权漏洞（比如 CVE-2024-53150 那种级别的），可能能拿到临时 root。有了 root 就能提取 serviceToken，伪造请求。

但这种漏洞可遇不可求，而且小米会通过 OTA 快速修补。你还在研究怎么利用，人家已经发补丁了。

**2. MTK BROM 模式**

这台是联发科设备。MTK 有个 BROM（Boot ROM）模式，理论上可以通过短接测试点进入，然后用 SP Flash Tool 刷机。

但新版本的 MTK 芯片已经锁了 BROM，需要授权才能用。而且就算能刷，刷入修改过的 boot.img 也可能触发 dm-verity 验证失败。

**3. ISP 直读**

用编程器（比如 RT809H）直接读取 eMMC/UFS 芯片的数据，修改系统分区。

需要拆机、焊接、专业设备。成本高，风险大，搞不好手机就变砖了。

**4. 社区申请**

最正规的途径。去小米社区（bbs.xiaomi.cn）的内测中心申请解锁授权。

但中国版设备审核很严，不是想申请就能过的。

## 写在最后

折腾了一整天，结果是白忙活。但也不算完全没收获：

- 逆向分析了 HyperOS 2.0 的加密协议，从 AES 到 RSA+AES 的演变过程搞清楚了
- 从 DEX 文件里提取了 RSA 公钥、HMAC 密钥等关键参数
- 理解了小米 BL 解锁的完整链路：logcat 监听 → 数据加密 → HMAC 签名 → 服务器验证
- 踩了不少坑（差点把 Settings 搞没了）

最大的教训是：**安全这个东西是动态的**。去年还能用的方法，今年可能就不行了。小米这次的加密升级确实到位——RSA 私钥放服务器端，客户端永远拿不到，这个设计本身就没有绕过的空间。

除非你能攻破小米的服务器（别真去干啊）。

---

*2026-09-26 记录，基于 HyperOS 2.0.6.0.UMQCNXM。系统更新后加密机制可能有变化。*
