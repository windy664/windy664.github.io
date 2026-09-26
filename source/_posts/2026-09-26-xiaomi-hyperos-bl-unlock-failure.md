---
title: 硬刚小米 HyperOS 2.0 BootLoader 加密：一场注定失败的逆向工程
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

# 硬刚小米 HyperOS 2.0 BootLoader 加密：一场注定失败的逆向工程

> 利益相关：一个想 root 自己手机的普通用户，被小米的安全工程师教做人了。

---

## 先说结论

**没 root 的情况下，HyperOS 2.0 的 BootLoader 绑定加密无解。**

不是"很难"，是"理论上不可能"。小米这次用了硬件级安全签名 + 服务端 RSA 私钥 + nonce 防重放的三重保护，你在客户端做的任何操作，最终都要服务器点头。而服务器会检查你的设备有没有在小米社区申请过解锁授权。没授权？30001 错误，谢谢惠顾。

想绕过？你需要改数据里的 `rom_version` 字段。想改数据？你需要能伪造设备签名。想伪造签名？你需要设备的硬件密钥——那个密钥烧在芯片里，拿不出来。

**死锁了。**

下面是我这一天的完整折腾记录，以及从 Settings APK 里逆向出来的完整加密协议。

---

## 起因

事情很简单。我手里有一台 Redmi Note 12，想解锁 BootLoader 刷个 Magisk 玩玩。以前 MIUI 时代这事不难，GitHub 上一搜一堆工具，改个字段就能绕过去。结果这次折腾了一整天，试了七八种方法，全部失败。

先交代一下设备：

| 项目 | 值 |
|------|-----|
| 型号 | Redmi Note 12（代号 sunstone）|
| 系统 | HyperOS 2.0.6.0.UMQCNXM（中国版）|
| Android | 14 |
| 芯片 | 联发科 MT6833（天玑 6020）|
| 指纹 | `Redmi/sunstone/sunstone:14/UKQ1.240624.001/OS2.0.6.0.UMQCNXM:user/release-keys` |

中国版。这是个关键点。国际版的限制可能没这么死。

---

## 第一步：看看前人怎么搞的

我去 GitHub 上搜了一圈，找到三个主要的绕过项目。

### MlgmXyysd/Xiaomi-HyperOS-BootLoader-Bypass

最早的 Python 实现。原理很直白：通过 logcat 监听 `CloudDeviceStatus` 标签，捕获 Settings 应用发送的绑定请求，解密数据，把 `rom_version` 从 `V816`（HyperOS）改成 `V14`（MIUI），重新加密签名，发给服务器。

核心就这几行：

```python
args = json.loads(decryptData(args))
args["rom_version"] = args["rom_version"].replace("V816", "V14")
args = json.dumps(args, separators=(",", ":"))
sign = signData(args)
```

加密方式是 AES-128-CBC，密钥硬编码：`20nr1aobv2xi8ax4`，IV：`0102030405060708`。简单粗暴。

### K0lb3/Xiaomi-HyperOS-BootLoader-Bypass-Python-Port

上面那个的 Python 移植版，逻辑一样。

### TheAirBlow/HyperSploit

C# 写的，内置了一份旧版 Settings APK（没打补丁的），直接帮你降级安装。代码里有这么一行：

```csharp
if (text.StartsWith("#&^")) return null;  // 新格式，搞不定
```

看到 `#&^` 开头就直接返回 null。说明作者早就知道新格式搞不定了。

---

## 第二步：扒 Settings APK

我把设备上的 Settings APK 拉出来：

```bash
adb pull /system_ext/priv-app/Settings/Settings.apk /tmp/Settings_device.apk
```

105MB，里面一堆 DEX 文件。我主要看 `classes2.dex` 和 `classes4.dex`。

用 JADX 1.5.6 反编译，出了 18108 个类，127 个错误。重点看 `com.android.settings.bootloader` 包下的几个类：

- `LogEncryptor.java` — 日志加密器
- `CloudDeviceStatus.java` — 绑定流程核心
- `Utils.java` — 工具类（账号、设备ID、签名等）
- `MiuiFidSigner.java` — 硬件级设备签名

---

## 加密协议：小米到底改了什么

### 旧版（MIUI 时代）

```python
DATA_PASS = b"20nr1aobv2xi8ax4"   # 硬编码
DATA_IV = b"0102030405060708"      # 硬编码
```

AES-128-CBC，密钥写死在代码里。谁都能解。GitHub 上的工具就是利用这个。

### 新版（HyperOS 2.0）

**注意：这里有个关键误解需要澄清。**

之前我一直在研究 `LogEncryptor` 类，以为它就是请求加密的核心。实际上，**`LogEncryptor` 只用于 logcat 日志加密，不是请求数据加密**。真正的请求数据是明文 form data 发出去的，靠的是 HMAC 签名 + 硬件设备凭证来保证完整性。

#### LogEncryptor（日志加密）

这个类的构造函数里有一套完整的 RSA+AES 混合加密：

```java
// AES-256，不是 128！
KeyGenerator keyGenerator = KeyGenerator.getInstance("AES");
keyGenerator.init(256);
SecretKey secretKeyGenerateKey = keyGenerator.generateKey();

// RSA-2048 公钥加密 AES 密钥
Cipher cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding");
cipher.init(Cipher.ENCRYPT_MODE, publicKey);
this.mEncrytedKey = Base64.encodeToString(cipher.doFinal(secretKeyGenerateKey.getEncoded()), 2);
```

加密后的日志格式：`#&^<RSA加密的AES密钥>!!<AES加密的数据>^&#`

- **AES 算法**：AES-256-CBC（不是之前猜的 AES-128）
- **IV**：`"bootloaderXiaomi"`（16 字节，不是旧版的 `0102030405060708`）
- **AES 密钥**：每次请求随机生成，被 RSA-2048 公钥保护
- **RSA 公钥**：硬编码在 DEX 里，私钥只在服务器上

这个加密只用在 `Log.i()` 输出的日志里，方便开发者调试。**实际发给服务器的 POST 数据不走这个加密。**

#### 真正的请求签名机制

`CloudDeviceStatus.bindAccountWithDevice()` 是绑定流程的核心。它做的事情是：

**1. 收集设备信息**

```java
map.put("userId", accountName);           // 小米账号
map.put("device", Utils.getModDevice());  // 设备代号
map.put("rom_version", Build.VERSION.INCREMENTAL);  // ROM 版本
map.put("cloudsp_devId", Utils.getDeviceId(context)); // 设备 ID
map.put("cloudsp_cpuId", getHardwardId(context));     // CPU ID
map.put("cloudsp_product", Build.DEVICE);  // 产品名
map.put("cloudsp_fid", fid);               // 安全设备 ID
map.put("cloudsp_nonce", getNonce(context, fid)); // 防重放 nonce
```

**2. 硬件签名**

```java
byte[] signData = getSignData(context, map);
map.put("cloudp_sign", Utils.binToHex(signData).toLowerCase());
```

`getSignData()` 的签名内容是：所有 `cloudsp_` 开头的字段按字典序排列拼接，前面加上路径。然后调用 `MiuiFidSigner.signWithDeviceCredential()` 进行硬件级签名。

**3. HMAC 签名**

```java
Mac mac = Mac.getInstance("HmacSHA1");
mac.init(new SecretKeySpec("10f29ff413c89c8de02349cb3eb9a5f510f29ff413c89c8de02349cb3eb9a5f5".getBytes(), "HmacSHA1"));
String sign = binToHex(mac.doFinal(("POST\n/v1/unlock/applyBind\ndata=" + data + "&sid=miui_sec_android").getBytes()));
```

HMAC 密钥没变，还是那个 64 字符的硬编码值。

**4. 带上 Cookie 认证**

```java
ExtendedAuthToken authToken = Utils.getAuthToken(context);
String encryptedAccountName = Utils.getEncryptedAccountName(context);
cookie = "serviceToken=" + authToken.authToken + ";cUserId=" + encryptedAccountName;
```

**5. 发送请求**

```java
new XHttpClient().syncPost("https://unlock.update.miui.com/v1/unlock/applyBind", headers, formData);
```

POST 数据就是普通的 form data，没有额外加密。安全靠的是：
- **serviceToken** 验证身份
- **cloudp_sign** 验证数据完整性（硬件签名）
- **sign** 验证请求完整性（HMAC）
- **nonce** 防重放攻击

---

## 关键组件分析

### MiuiFidSigner — 硬件签名

```java
public class MiuiFidSigner {
    // 获取安全设备 ID
    public static String getFid(Context context) {
        SecurityDeviceCredentialAbility ability = new SecurityDeviceCredentialAbility(context);
        return ability.getSecurityDeviceId();
    }
    
    // 用设备凭证签名
    public static byte[] signWithDeviceCredential(Context context, byte[] data, boolean flag) {
        SecurityDeviceCredentialAbility ability = new SecurityDeviceCredentialAbility(context);
        return ability.signWithDeviceCredential(data, flag);
    }
}
```

`SecurityDeviceCredentialAbility` 是小米的安全 SDK，底层调用的是芯片级安全模块（TrustZone/TEE）。设备私钥烧在硬件里，软件层面**拿不出来**。你只能让它帮你签名，但你不知道签名密钥是什么。

这就是为什么你没法伪造签名——你需要这台特定设备的硬件密钥，而这个密钥从不离开安全区域。

### Utils — 工具类

```java
// 获取小米账号
Account[] accounts = AccountManager.get(context).getAccountsByType("com.xiaomi");

// 获取设备 ID
XDeviceInfo.syncGet(context).deviceId;

// 获取硬件 ID（CPU ID）
SystemProperties.get("ro.boot.cpuid", "");  // 或 /proc/serial_num

// 获取 IMSI（SIM 卡标识）
String imsi = telephonyManager.getSubscriberId(subscriptionId);
// IMSI 会被 SHA-256 加盐哈希：
String hashedImsi = SHA256(imsi + "2jkkewm2OPMBEz7yhl1nZ995OMjOKr6q7gm1Dl0T3EwxmycEIcwr8W3tQIwPLqhm");

// 获取 auth token
AccountManager.getAuthToken(account, "micloudfind", ...);
```

### CloudDeviceStatus — 完整流程

```
bindAccountWithDevice(context)
├── Utils.getAccountName()        // 小米账号名
├── Utils.getModDevice()          // 设备代号
├── Utils.getDeviceId()           // 设备 ID
├── getHardwardId()               // CPU ID
├── MiuiFidSigner.getFid()        // 安全设备 ID
├── getNonce(context, fid)        // 从服务器获取 nonce
│   └── GET /v1/micloud/nonce
├── getSignData(context, map)     // 硬件签名
│   └── MiuiFidSigner.signWithDeviceCredential()
├── getHMacSign(path, data)       // HMAC-SHA1 签名
├── getCookie(context)            // serviceToken + cUserId
│   └── Utils.getAuthToken()
└── XHttpClient.syncPost()        // 发送请求
    └── POST https://unlock.update.miui.com/v1/unlock/applyBind
```

---

## 更多组件分析

### BootloaderApplyActivity — 解锁警告

用户在开发者选项里点击"设备解锁状态"时，会先进入一个 **5 步警告流程**。每步都有 5 秒倒计时，不能跳过：

1. 警告解锁会清除数据
2. 警告解锁会失去保修
3. 警告解锁可能导致安全风险
4. 警告解锁后可能无法收到系统更新
5. 最终确认（"接受"按钮）

最后一步调用 `setEnabled(true)`，设置系统属性：

```java
SystemProperties.set("persist.fastboot.enable", "1");  // 接受
SystemProperties.set("persist.fastboot.enable", "0");  // 拒绝
```

这个属性只是让用户"同意"解锁流程，**不是解锁本身**。真正的绑定在 `BootloaderStatusActivity` 里。

### HeartbeatJobService — 心跳机制

绑定成功后，Settings 会注册一个**每日心跳任务**（Job ID: 44012）：

```java
// JobDispatcher.java
new JobInfo.Builder(44012, new ComponentName(context, HeartbeatJobService.class))
    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)  // 需要网络
    .setPeriodic(86400000L)   // 每24小时
    .setPersisted(true)       // 重启后继续
    .build();
```

心跳的逻辑：

```java
// HeartbeatJobService.java
if (canSendHeartbeat(context)) {
    int count = CloudDeviceStatus.sendHeartbeat(context);
    if (count >= 30) {
        cancelHeartbeatJob(context);  // 30次后取消（约30天）
    }
}
```

`canSendHeartbeat()` 检查：
1. `ro.secureboot.lockstate` 必须是 `"locked"`（BL 还锁着）
2. 当前小米账号必须和绑定时的账号一致

心跳请求发到 `/v1/unlock/deviceHeartbeat`，携带 `cpuId`、`fid`、`product`、`uid` 和硬件签名。

### SecurityDeviceCredentialAbility — 硬件签名 SDK

这是小米的安全 SDK，通过 Binder IPC 与系统服务通信。它尝试连接两个服务：

```java
// 优先尝试小米账号服务
Intent intent1 = new Intent("com.xiaomi.account.action.BIND_SECURITY_DEVICE_CREDENTIAL");
intent1.setPackage("com.xiaomi.account");

// 备选：查找设备服务
Intent intent2 = new Intent("com.xiaomi.finddevice.action.BIND_SECURITY_DEVICE_CREDENTIAL");
intent2.setPackage("com.xiaomi.finddevice");
```

底层系统服务名是 `miui.sedc`（Security Device Credential），通过 `ServiceManager.getService("miui.sedc")` 获取 Binder。

AIDL 接口 `ISecurityDeviceCredentialManager` 定义了 4 个方法：

| 方法 | 事务 ID | 用途 |
|------|---------|------|
| `isThisDeviceSupported()` | 1 | 检查设备是否支持硬件签名 |
| `getSecurityDeviceId()` | 2 | 获取安全设备 ID (fid) |
| `sign(type, data, flag)` | 3 | 用设备凭证签名数据 |
| `forceReload()` | 4 | 强制重新加载设备凭证 |

`signWithDeviceCredential(data, flag)` 实际上调用的是 `sign(1, data, flag)`，类型参数 1 表示使用设备凭证签名。

**关键点**：如果硬件服务未就绪（errorCode -101），会自动重试（每500ms），最多等10秒。这说明硬件签名依赖于 TEE/TrustZone 的初始化。

### RootManagementPreferenceController — 针对性封锁

代码里有一个**针对特定设备的硬编码检查**：

```java
if (SystemProperties.getInt("ro.product.first_api_level", 31) > 30 
    || isDeviceIn("sunstone", "moonstone")) {
    // 显示"不支持 Root"页面
    intent.setClassName(SECURITY_CENTER_PACKAGE_NAME, 
        "com.miui.permcenter.root.NotSupportRootActivity");
}
```

**sunstone** 就是 Redmi Note 12，**moonstone** 是 Redmi Note 12 Pro。小米直接把这两款设备列入了"不支持 Root"的黑名单，即使你通过了所有其他检查，也会被这个页面拦住。

而且这个检查只在 `IS_STABLE_VERSION && !IS_INTERNATIONAL_BUILD` 时生效——也就是说**国际版和开发版不受此限制**。

### OemUnlockPreferenceController — 标准 Android 解锁

开发者选项里还有一个标准的 OEM 解锁开关，使用 Android 原生的 `OemLockManager`：

```java
OemLockManager oemLockManager = (OemLockManager) context.getSystemService("oem_lock");
oemLockManager.setOemUnlockAllowedByUser(true);  // 允许解锁
```

但这个开关**只是告诉系统"用户同意解锁"**，实际解锁还是需要通过小米的绑定流程。而且如果设备是 SIM 锁定的（运营商锁），这个开关会被禁用。

### ExtendedAuthToken — Token 结构

serviceToken 实际上是两个值的组合：

```java
public final class ExtendedAuthToken {
    public final String authToken;  // 实际的 token
    public final String security;   // 安全密钥
    
    public static ExtendedAuthToken parse(String str) {
        String[] parts = str.split(",");
        return new ExtendedAuthToken(parts[0], parts[1]);
    }
}
```

从 AccountManager 获取时，返回格式是 `authToken,security`。发请求时只用 `authToken` 部分放在 Cookie 里。

### FidNonce — Nonce 生成

nonce 的生成过程：

```java
// 构建 JSON
JSONObject json = new JSONObject();
json.put("tp", "n");           // 类型：n=native, wb=web_view
json.put("nonce", generated);  // 基于服务器时间生成
json.put("v", version);        // 版本号

// Base64 编码
String plain = Base64.encodeToString(json.toString().getBytes("UTF-8"), 10);

// 用设备凭证签名
byte[] signature = fidSigner.sign(plain.getBytes("UTF-8"));
String sign = Base64.encode(signature, 10);
```

最终 nonce 值是 `plain` + `sign` 的组合，发给 `/v1/micloud/nonce` 验证。

---

## 关键发现：30001

在折腾过程中，我一直用 logcat 监听 `CloudDeviceStatus`。虽然我自己的伪造请求全是 10000，但我捕获到了 **Settings 应用自己发的请求的服务器响应**：

```json
{
  "code": 30001,
  "description": "绑定失败，请前往小米社区内测中心申请授权后重试"
}
```

这个信息量很大：

1. **服务器能处理请求**。Settings 发的数据，服务器解析成功了（30001 不是 10000）。
2. **问题在授权不在加密**。服务器拒绝是因为设备没授权，不是签名验证失败。
3. **原来的绕过思路理论上是对的**。改 `V816`→`V14` 应该能绕过，但我改不了数据——因为数据被硬件签名保护了。

我还看到 Settings 应用每隔一秒重试一次，每次都 30001。它自己也搞不定。

---

## 七种方法，七种死法

### 方法一：跑原始绕过脚本

改了一下 logcat 解析逻辑，因为新版格式变了——日志从明文变成了 `#&^...!!...^&#` 的 RSA+AES 加密格式：

```python
if data.startswith("#&^") and "!!" in data:
    inner = data[3:-3]
    parts = inner.split("!!")
    # parts[0] = RSA 加密的 AES 密钥（256-bit，随机生成）
    # parts[1] = AES-CBC 加密的数据（IV = "bootloaderXiaomi"）
```

解析没问题，下一步解密直接炸：

```
ValueError: Data must be padded to 16 byte boundary in CBC mode
```

废话。这是 RSA 加密后的东西，你拿 AES 密钥去解，当然不对。而且就算你解开了，那也只是**日志**，不是实际请求数据。

### 方法二：降级 Settings APK

HyperSploit 内置了旧版 Settings APK，那个版本用旧加密。我想着装上去就能用旧方法了。

```bash
adb install /tmp/Settings.apk
# INSTALL_FAILED_INVALID_APK: Package com.android.settings are not updateable
```

不让装。Settings 是系统核心应用，HyperOS 直接禁止降级。

我不死心，试了 session 安装、先卸载再装、各种姿势。最后卸载成功了但安装还是失败，差点把 Settings 搞没，赶紧用 `cmd package install-existing com.android.settings` 恢复回去。

**教训：别手贱卸载系统应用。**

### 方法三：app_process 跑 Java

想在设备上跑一段 Java 代码，反射调用 `AccountManager` 拿 serviceToken。

```bash
javac GetToken.java
adb push GetToken.class /data/local/tmp/
adb shell "cd /data/local/tmp && app_process / GetToken"
# Aborted
```

崩了。Android 运行时需要 DEX 格式，不认 `.class` 文件。设备上没有 `d8` 工具，本地也没装 Android SDK。死路。

### 方法四：伪造请求

既然解不了原始请求，我从头造一个。从设备上收集了所有信息，构造 JSON，把 `rom_version` 设成 `V14`，HMAC 签名，发出去。

```python
data = {
    "authType": 2,
    "clientVersion": "1.0",
    "deviceId": device_id,
    "fingerprint": fp,
    "nonce": nonce,
    "rom_version": "V14",
    # ...
}
```

结果：**所有请求都返回 `10000`（参数异常）**。

完整数据、最小数据、不带 nonce、不带签名、带 Cookie、V14、V816——全 10000。连空数据都 10000。

后来想明白了：服务器在检查 `serviceToken`（在 Cookie 头里）。Settings 应用发请求的时候会带上这个 token，但我拿不到。而且就算拿到了 token，没有硬件签名 `cloudp_sign`，服务器也不会认。

### 方法五：拦截 HTTP 流量

**mitmproxy**：设置了 adb reverse 和设备代理，一个包都没捕获到。HTTPS 流量加密的，HTTP 代理拦不住。要解密 HTTPS 需要在设备上装 CA 证书——又要 root。

**iptables**：`Permission denied (you must be root)`。

**strace**：`ptrace(PTRACE_SEIZE): Operation not permitted`。

所有能看网络流量的方法都要 root。

### 方法六：提取 serviceToken

serviceToken 在 AccountManager 里。我试了 `content query`、`service call account`、`dumpsys account`、`am startservice`、直接读 SharedPreferences……

`dumpsys account` 能看到账号存在：

```
Account {name=2807***558, type=com.xiaomi}
```

但 token 是加密存储的，没有 root 看不到。而且就算拿到了 token，也还需要硬件签名。

### 方法七：Frida 动态 Hook

最后一招。Frida 可以在运行时 hook Java 方法，我想 hook `CloudDeviceStatus` 截获完整请求。

```bash
pip3 install frida frida-tools
adb push frida-server /data/local/tmp/
adb shell "/data/local/tmp/frida-server -D"
# Unable to load SELinux policy: Permission denied
```

frida-server 要 root。又是一堵墙。

---

## 为什么所有方法都失败

| 方法 | 卡在哪 |
|------|--------|
| 原始脚本 | 日志格式变了，而且日志≠请求数据 |
| 降级 Settings | 系统阻止安装 |
| app_process | 没有 DEX 转换工具 |
| 伪造请求 | 缺 serviceToken + 硬件签名 |
| mitmproxy | HTTPS 要 CA 证书（要 root）|
| iptables | 要 root |
| strace | 要 root |
| 提取 serviceToken | 权限不够 |
| Frida | frida-server 要 root |

**每条路最后都指向同一个问题：没有 root。**

而 root 需要解锁 BL，解锁 BL 需要绕过加密，绕过加密需要 root。

小米这次的设计思路很清晰：**把信任根放在硬件和服务器端**。

- 设备私钥烧在芯片里（TrustZone/TEE），软件拿不出来
- RSA 私钥在服务器上，客户端只有公钥
- serviceToken 在加密存储里，没有 root 看不到
- 所有关键操作都要服务器配合

你没有 root，就看不到 serviceToken；没有 serviceToken，服务器就不理你；没有硬件密钥，你就伪造不了签名。

---

## 新旧对比

| | 旧版 (MIUI) | 新版 (HyperOS 2.0) |
|---|---|---|
| 请求签名 | HMAC-SHA1（密钥硬编码）| HMAC-SHA1 + 硬件设备凭证 |
| 日志加密 | 无 | RSA-2048 + AES-256-CBC |
| 数据格式 | 纯 Base64 | `#&^...!!...^&#`（仅日志）|
| 密钥位置 | DEX 里写死了 | 硬件安全模块 + 服务器 |
| 设备验证 | 只看格式 | 硬件签名 + nonce + serviceToken |
| Settings 降级 | 能装 | 装不了 |
| 绕过难度 | 改个字段就行 | 理论上不可能 |

---

## 完整协议逆向结果

以下是通过 JADX 静态分析得到的完整协议细节，供安全研究人员参考：

### 请求流程

```
1. getAccountName()     → 小米账号名
2. getDeviceId()        → XDeviceInfo.deviceId
3. getHardwardId()      → CPU ID (ro.boot.cpuid 或 /proc/serial_num)
4. getFid()             → SecurityDeviceCredentialAbility.getSecurityDeviceId()
5. getNonce(fid)        → GET /v1/micloud/nonce?cloudsp_devId=...&cloudsp_fid=...&userId=...
6. 组装参数              → userId, device, rom_version, cloudsp_*, heartbeat_mode
7. getSignData()        → "POST&/mic/binding/v1/identified/device/account&cloudsp_cpuId=...&cloudsp_devId=..."
                         → MiuiFidSigner.signWithDeviceCredential(data, true)
8. getHMacSign()        → HMAC-SHA1("POST\n/v1/unlock/applyBind\ndata={json}&sid=miui_sec_android")
9. getCookie()          → "serviceToken={authToken};cUserId={encryptedUserId}"
10. POST /v1/unlock/applyBind  → form data {sid, data(json), sign}
```

### 密钥一览

| 密钥 | 值 | 用途 |
|------|-----|------|
| HMAC 密钥 | `10f29ff413c89c8de02349cb3eb9a5f510f29ff413c89c8de02349cb3eb9a5f5` | 请求签名 |
| 日志 AES IV | `bootloaderXiaomi` | 日志加密（不影响请求）|
| 日志 RSA 公钥 | `MIIBIjAN...AQAB`（RSA-2048）| 日志 AES 密钥加密 |
| 设备凭证 | 硬件安全模块存储 | 请求数据签名 |
| IMSI 盐值 | `2jkkewm2OPMBEz7yhl1nZ995OMjOKr6q7gm1Dl0T3EwxmycEIcwr8W3tQIwPLqhm` | IMSI 哈希 |

### API 端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/v1/micloud/nonce` | GET | 获取防重放 nonce |
| `/v1/unlock/applyBind` | POST | 绑定设备账号 |
| `/v1/unlock/deviceHeartbeat` | POST | 设备心跳 |

### 服务器域名

- 中国版：`https://unlock.update.miui.com`
- 国际版：`https://unlock.update.intl.miui.com`

### 系统服务架构

```
Settings App
├── BootloaderApplyActivity    → 5步警告 → persist.fastboot.enable
├── BootloaderStatusActivity   → 绑定入口 → CloudDeviceStatus
├── HeartbeatJobService        → 每日心跳 → /v1/unlock/deviceHeartbeat
│
├── MiuiFidSigner              → 硬件签名代理
│   └── SecurityDeviceCredentialAbility
│       ├── com.xiaomi.account (BIND_SECURITY_DEVICE_CREDENTIAL)
│       └── com.xiaomi.finddevice (BIND_SECURITY_DEVICE_CREDENTIAL)
│           └── miui.sedc (系统服务, Binder IPC)
│               ├── isThisDeviceSupported()
│               ├── getSecurityDeviceId()
│               ├── sign(type, data, flag)
│               └── forceReload()
│
├── Utils
│   ├── AccountManager → serviceToken (micloudfind)
│   ├── XDeviceInfo → deviceId
│   ├── SystemProperties → ro.boot.cpuid, ro.product.mod_device
│   ├── TelephonyManager → IMSI (SHA-256 + salt)
│   └── SharedPreferences → encrypted_user_id
│
└── CloudDeviceStatus
    ├── getNonce() → GET /v1/micloud/nonce
    ├── getSignData() → MiuiFidSigner.signWithDeviceCredential()
    ├── getHMacSign() → HMAC-SHA1 (硬编码密钥)
    ├── getCookie() → serviceToken + cUserId
    └── syncPost() → POST /v1/unlock/applyBind
```

### 设备黑名单

小米对特定设备做了**硬编码封锁**，即使通过了所有绑定检查也无法 Root：

| 设备代号 | 型号 | 封锁方式 |
|----------|------|----------|
| sunstone | Redmi Note 12 | `NotSupportRootActivity` |
| moonstone | Redmi Note 12 Pro | `NotSupportRootActivity` |

条件：`ro.product.first_api_level > 30` 或设备代号在黑名单中。
仅对中国稳定版生效，国际版和开发版不受影响。

---

## 还能怎么办

### 方向一：内核提权漏洞（最有希望）

HyperOS 2.0 基于 Android 14，出厂安全补丁大约在 2024 年中期。这意味着 **2024 年下半年到 2025 年初公开的内核 CVE 可能未被修补**。

#### 已知的内核提权漏洞

**USB 子系统（已被野外利用的 0day）：**

| CVE | 子系统 | 类型 | 补丁时间 | 利用条件 |
|-----|--------|------|----------|----------|
| CVE-2024-53104 | USB Video Class (UVC) | 越界写入 → 提权 | 2025-02 | 需要物理 USB 访问 |
| CVE-2024-53197 | USB Audio ALSA | 越界写入 → 提权 | 2025-04 | 需要物理 USB 访问 |
| CVE-2024-53150 | USB | 信息泄露 | 2025-04 | 需要物理 USB 访问 |

这三个 CVE 是 Cellebrite 法证工具使用的漏洞链，由 Amnesty International 披露。它们被用于定向攻击，需要插入恶意 USB 设备触发。**纯软件无法利用。**

**纯软件提权（不需要物理访问）：**

| CVE | 子系统 | 类型 | 补丁时间 |
|-----|--------|------|----------|
| CVE-2024-50264 | Net | 提权 | 2025-04 |
| CVE-2024-56556 | Binder | 提权 | 2025-04 |
| CVE-2024-46852 | dma-buf | 提权 | 2025-03 |
| CVE-2024-43097 | Skia | 提权 | 2024-12 |

这几个不需要物理访问，但目前**没有公开的利用代码**。如果有人写出 PoC，就有机会。

**MediaTek 特定漏洞（影响 MT6833）：**

2026 年 9 月的 MediaTek 安全公告中有 11 个 CVE 影响 MT6833：

| CVE | 组件 | 类型 | 严重性 |
|-----|------|------|--------|
| CVE-2026-20501 | vdec（视频解码器）| 堆溢出 | High |
| CVE-2026-20502 | vdec（视频解码器）| 堆溢出 | High |
| CVE-2026-20503 | Modem | 断言失败 | High |
| CVE-2026-20506 | Audio HAL | UAF → 提权 | Medium |
| CVE-2026-20508 | Power HAL | 类型混淆 → 提权 | Medium |
| CVE-2026-20509 | Power HAL | 栈溢出 → 提权 | Medium |
| CVE-2026-20510 | Camera | 双重释放 → 提权 | Medium |

这些漏洞影响 MT6833，但目前没有公开利用代码。vdec 的堆溢出尤其值得关注——视频解码器是内核态驱动，如果能触发溢出写入可控数据，理论上可以实现提权。

#### mtk-su / mtk-easy-su

GitHub 上有 1178★ 的 `JunioJsv/mtk-easy-su`，利用 CVE-2020-0069（MediaTek 内核驱动漏洞）获取 root。但：

- 支持的芯片：MT6750、MT6761、MT6762 等老芯片
- **MT6833 不在支持列表中**
- 漏洞在 2020 年 3 月已修补，HyperOS 2.0 肯定已修复

#### 判断

你的设备出厂安全补丁约 2024 年中期，以下 CVE **可能未修补**：

- CVE-2024-53104（2025年2月补丁）
- CVE-2024-53197（2025年4月补丁）
- CVE-2024-50264（2025年4月补丁）
- CVE-2024-56556（2025年4月补丁）

**确认方法**：

```bash
adb shell getprop ro.build.version.security_patch
```

如果返回的日期早于 2025-03-01，那这些漏洞大概率没修补。

**最有希望的方向**：

1. **CVE-2024-50264（Net 子系统）** 和 **CVE-2024-56556（Binder）**：纯软件提权，不需要 USB 物理访问。关注 XDA 和 GitHub 上是否有人写出 PoC。
2. **CVE-2026-20501/20502（MediaTek vdec）**：堆溢出，影响 MT6833，但目前没有公开利用。
3. **关注 [KernelSU](https://kernelsu.org) 的 MediaTek 支持进展**：如果能拿到临时 root（哪怕一次），就可以提取 serviceToken + hook 硬件签名，绕过整条链路。

### 方向二：物理方法

**MTK BROM 模式**：联发科设备有 BROM（Boot ROM）模式，理论上可以通过短接测试点进入下载模式，然后用 mtkclient 工具读写分区。但：

- MT6833（Dimensity 6020）是较新的芯片，BROM 可能已锁
- 需要拆机、找到测试点、焊接
- 有变砖风险

**ISP 直读**：用编程器直接读 eMMC/UFS 芯片。需要拆机、焊接、专业设备（如 RT809H）。成本高、风险大，但理论上可以读出所有分区数据。

### 方向三：官方途径

**小米社区申请**：最正规的途径。去小米社区内测中心申请解锁授权。中国版审核很严，但这是唯一不需要找漏洞、不需要拆机的路。

**国际版 ROM**：如果能刷国际版 ROM，限制可能没这么死。但刷 ROM 本身就需要解锁 BL……又是死锁。

### 方向四：等

说实话，等别人写好内核漏洞利用代码可能比自己找漏洞更现实。建议关注：

- [XDA Developers](https://forum.xda-developers.com) 的 Redmi Note 12 板块
- [GitHub](https://github.com) 搜索 `CVE-2024-50264`、`CVE-2024-56556`、`mt6833 root`
- [MediaTek 安全公告](https://www.mediatek.com/product-security-bulletin) 的更新

---

## 写在最后

折腾了一整天，白忙活。但也不是完全没收获——至少把 HyperOS 2.0 的加密协议从头到尾扒了一遍，从 DEX 里提取了所有密钥，搞清楚了整个绑定流程的链路。

最大的教训：**安全是动态的**。去年能用的方法今年就不行了。小米这次的安全设计确实到位——硬件级签名 + 服务端 RSA + nonce 防重放，三层保护，每一层都需要不同的突破手段。

想同时突破三层？除非你能物理访问芯片内部，或者找到内核提权漏洞。

**最后的希望在内核**。Android 14 的内核有不少已知 CVE（CVE-2024-50264、CVE-2024-56556 等），如果有人写出利用代码，拿到一次临时 root，就能提取 serviceToken，就能 hook 硬件签名，就能绕过整条链路。但这一切的前提是——有人先搞出 PoC。

对于普通用户来说，最靠谱的路还是去小米社区申请解锁授权。

---

*2026-09-26 记录，基于 HyperOS 2.0.6.0.UMQCNXM。系统更新后加密机制可能有变化。*
*技术分析基于 JADX 静态反编译，未进行动态调试（需要 root）。*
*内核漏洞信息基于 Android Security Bulletin 和 MediaTek Security Bulletin，截至 2026-09-26。*
