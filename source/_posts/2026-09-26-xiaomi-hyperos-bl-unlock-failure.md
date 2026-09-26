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

## 前言

小米手机的 BootLoader 解锁一直是个热门话题。从早期的 MIUI 到现在的 HyperOS，小米不断加强解锁机制。本文记录了我尝试通过 ADB 解锁 Redmi Note 12 BootLoader 的完整过程——一个从充满希望到最终认清现实的技术探索之旅。

**最终结果**：失败了。但失败的过程中，我们深入分析了小米 HyperOS 2.0 的加密协议，发现了从 AES-128-CBC 到 RSA+AES 混合加密的演变，并尝试了至少 6 种不同的绕过方法。

## 一、设备信息

| 项目 | 值 |
|------|-----|
| 设备型号 | Redmi Note 12 (sunstone) |
| 产品代号 | 22101317C |
| 系统版本 | HyperOS 2.0.6.0.UMQCNXM (中国版) |
| Android 版本 | 14 |
| Build ID | UKQ1.240624.001 |
| 芯片平台 | MediaTek MT6833 (Dimensity 6020) |
| Build 指纹 | `Redmi/sunstone/sunstone:14/UKQ1.240624.001/OS2.0.6.0.UMQCNXM:user/release-keys` |

这是一台运行 HyperOS 2.0 的中国版 Redmi Note 12。小米在中国版设备上对 BootLoader 解锁施加了严格的限制。

## 二、技术背景：小米 BootLoader 解锁机制

### 2.1 传统的解锁流程

小米的 BootLoader 解锁流程大致如下：

1. 用户在开发者选项中绑定小米账号
2. 等待一定时间（通常 7 天）
3. 使用小米官方解锁工具解锁

这个过程的关键是**绑定账号**这一步。设备会向小米服务器发送一个绑定请求，包含设备信息和账号信息。

### 2.2 HyperOS 的新限制

从 HyperOS 开始，小米加强了解锁限制：

- **绑定请求加密**：从简单的 AES 加密升级到 RSA+AES 混合加密
- **服务器端验证**：服务器检查设备是否获得解锁授权
- **社区授权**：需要在小米社区内测中心申请授权

### 2.3 已知的绕过方案

GitHub 上有几个知名的绕过项目：

- **MlgmXyysd/Xiaomi-HyperOS-BootLoader-Bypass**：Python 脚本，通过修改加密数据中的 `rom_version` 字段绕过限制
- **K0lb3/Xiaomi-HyperOS-BootLoader-Bypass-Python-Port**：上述项目的 Python 移植版
- **TheAirBlow/HyperSploit**：C# 工具，包含旧版 Settings APK

这些工具的核心原理是：
1. 通过 logcat 捕获绑定请求的加密数据
2. 解密数据（使用已知的 AES 密钥）
3. 修改 `rom_version` 字段（从 `V816` 改为 `V14`，伪装成 MIUI 设备）
4. 重新加密并签名
5. 发送到服务器

## 三、Phase 1：信息收集

### 3.1 阅读 GitHub 仓库

首先，我仔细阅读了两个主要的绕过项目：

**MlgmXyysd/Xiaomi-HyperOS-BootLoader-Bypass**

这个项目使用 Python 通过 ADB 拦截和修改绑定请求。核心代码：

```python
# 解密函数
def decryptData(data: str) -> str:
    data = base64.b64decode(data)
    cipher = AES.new(key=DATA_PASS, mode=AES.MODE_CBC, iv=DATA_IV)
    decrypted = cipher.decrypt(data)
    unpad_PKCS5 = lambda s: s[0 : -s[-1]]
    return unpad_PKCS5(decrypted)

# 主要修改
args = json.loads(decryptData(args))
args["rom_version"] = args["rom_version"].replace("V816", "V14")
args = json.dumps(args, separators=(",", ":"))
sign = signData(args)
```

**TheAirBlow/HyperSploit**

这是一个 C# 工具，内置了旧版的 Settings APK。它的解密逻辑：

```csharp
private static string? Decrypt(string text) {
    if (text.StartsWith("#&^")) return null;  // 新格式 = 已修补
    using var aes = Aes.Create();
    aes.Key = "20nr1aobv2xi8ax4"u8.ToArray();
    aes.IV = "0102030405060708"u8.ToArray();
    // ... AES-CBC 解密 ...
}
```

注意 `if (text.StartsWith("#&^")) return null;` 这行——它检测到新格式后直接返回 null，说明 HyperSploit 不支持新的加密格式。

### 3.2 分析设备上的 Settings APK

我们从设备上提取了 Settings APK 进行分析：

```bash
adb pull /system_ext/priv-app/Settings/Settings.apk /tmp/Settings_device.apk
```

APK 大小约 105MB，包含多个 DEX 文件。我们重点关注 `classes2.dex` 和 `classes4.dex`。

### 3.3 DEX 文件逆向分析

使用 `strings` 和十六进制编辑器分析 DEX 文件，我们发现了以下关键信息：

**RSA 公钥**（位于 `classes2.dex` 偏移 7116962）：

```
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxPEmV1vZ60qc39gWvaSc
7QgV/Ltc95eTBiWsRcN5VDeqjGwRPmk7TBXvU+YQ6q2LrfiaDQYg8ZwxjwUTsWoL
J7l8AHE0WdUEvdV36+BMbB9w7ts2IISZZNnJyyZleU+SImWYRybKkTPX//Ld/bgK
NFz3dxJzYxLXdKzcZogHLI2Mvvj31/ZmqvKuRxXBQ2iU4oSPthQRXFY+KbQJ1Z3Z
sFzMJfGaY1jj+8ymUd4zWGXgztQLuvpUNtiVHGW1WhP8854yJqbQ1VcqfIueKR74
qoQgUbXHFuYbvz6B0c+bEgJ/tn/bXcM8Zo8aADFgZNCChbzAhB9wf3zx2RLJe7aN
awIDAQAB
```

**其他密钥**（位于 `classes2.dex` 偏移 6167000-6169000）：

| 偏移 | 值 | 用途 |
|------|-----|------|
| 6167963 | `0102030405060708` | 旧版 AES IV |
| 6168451 | `10f29ff413c89c8de02349cb3eb9a5f5...` | HMAC 签名密钥 |
| 6168583 | `158a7dbb3a76489a81a76ecd24a452be` | 未知密钥（16字节）|

**关键字符串**：

- `RSA/ECB/PKCS1Padding`：RSA 加密算法
- `mEncrytedKey`：加密密钥字段名
- `mSecretKey`：秘密密钥字段名
- `encryptMsg`：加密消息方法名
- `wrapEncryptMsg`：包装加密消息方法名
- `SYM_ENCRYPT_ALGORITHM_IV`：对称加密算法 IV
- `LogEncryptor`：日志加密器类名

## 四、Phase 2：加密协议分析

### 4.1 旧版加密（MIUI 时代）

旧版使用简单的 AES-128-CBC 加密：

```python
# 硬编码的密钥和 IV
DATA_PASS = b"20nr1aobv2xi8ax4"  # 16字节 AES 密钥
DATA_IV = b"0102030405060708"     # 8字节 IV

# 解密
cipher = AES.new(key=DATA_PASS, mode=AES.MODE_CBC, iv=DATA_IV)
decrypted = cipher.decrypt(base64.b64decode(data))
```

数据格式是明文 JSON，直接加密后 base64 编码。

### 4.2 新版加密（HyperOS 2.0）

新版使用 RSA+AES 混合加密，流程如下：

1. **生成随机 AES 密钥**：`KeyGenerator.getInstance("AES")`
2. **加密数据**：使用 AES-CBC 加密 JSON 数据
3. **加密 AES 密钥**：使用 RSA-2048 公钥加密 AES 密钥
4. **组合格式**：`#&^RSA加密的AES密钥!!AES加密的数据^&#`
5. **HMAC 签名**：使用 HMAC-SHA1 签名数据

数据格式变为：

```
#&^<RSA加密的AES密钥(Base64)>!!<AES加密的数据(Base64)>^&#
```

### 4.3 HMAC 签名

签名算法不变：

```python
SIGN_KEY = b"10f29ff413c89c8de02349cb3eb9a5f510f29ff413c89c8de02349cb3eb9a5f5"

def signData(data: str) -> str:
    h = HMAC.new(SIGN_KEY, digestmod=SHA1)
    h.update(
        f"POST\n/v1/unlock/applyBind\ndata={data}&sid=miui_sec_android".encode("ascii")
    )
    return h.hexdigest().lower()
```

### 4.4 API 端点

- **绑定请求**：`https://unlock.update.miui.com/v1/unlock/applyBind`
- **获取 Nonce**：`https://unlock.update.miui.com/v1/micloud/nonce?sid=miui_sec_android`
- **签名方式**：HMAC-SHA1

## 五、Phase 3：尝试绕过

### 5.1 尝试 1：使用原始绕过脚本

首先，我尝试直接使用修改后的绕过脚本：

```python
# 修改了 logcat 解析逻辑以处理新格式
if data.startswith("#&^") and "!!" in data:
    inner = data[3:-3]  # 去掉 #&^ 和 ^&#
    parts = inner.split("!!")
    if len(parts) == 2:
        args = parts[0]  # RSA 加密的 AES 密钥
        headers = parts[1]  # AES 加密的数据
```

**结果**：`ValueError: Data must be padded to 16 byte boundary in CBC mode`

原因：新格式使用 RSA+AES 混合加密，直接用旧的 AES 密钥解密会失败。

### 5.2 尝试 2：降级 Settings APK

HyperSploit 内置了旧版的 Settings APK，尝试降级：

```bash
# 提取 HyperSploit 内置的 Settings APK
# 尝试安装
adb install /tmp/Settings.apk
```

**结果**：`INSTALL_FAILED_INVALID_APK: Package com.android.settings are not updateable`

HyperOS 2.0 阻止了 Settings 应用的降级。

尝试了多种方法：

```bash
# 方法1：直接安装
adb install /tmp/Settings.apk

# 方法2：替换系统文件（需要 root）
adb root  # 失败：adbd cannot run as root

# 方法3：使用 session 安装
adb shell pm install-create
adb shell pm install-write ...
adb shell pm install-commit ...

# 方法4：卸载后安装
adb shell pm uninstall --user 0 com.android.settings
adb install /tmp/Settings.apk  # 仍然失败

# 恢复 Settings
adb shell cmd package install-existing com.android.settings
```

### 5.3 尝试 3：app_process 运行 Java 代码

尝试在设备上运行自定义 Java 代码来访问 Android API：

```java
// GetToken.java - 通过反射访问 AccountManager
public class GetToken {
    public static void main(String[] args) {
        Class<?> atClass = Class.forName("android.app.ActivityThread");
        Method currentAT = atClass.getMethod("currentActivityThread");
        Object at = currentAT.invoke(null);
        
        Method getSystemContext = atClass.getMethod("getSystemContext");
        Object context = getSystemContext.invoke(at);
        
        Class<?> amClass = Class.forName("android.accounts.AccountManager");
        Method getMethod = amClass.getMethod("get", Class.forName("android.content.Context"));
        Object am = getMethod.invoke(null, context);
        
        Method getAccounts = amClass.getMethod("getAccountsByType", String.class);
        Object[] accounts = (Object[]) getAccounts.invoke(am, "com.xiaomi");
        // ...
    }
}
```

编译并推送：

```bash
javac GetToken.java
adb push GetToken.class /data/local/tmp/
adb shell "cd /data/local/tmp && app_process / GetToken"
```

**结果**：`Aborted`

尝试了多种方法：

```bash
# 方法1：app_process
adb shell "app_process / GetToken"  # Aborted

# 方法2：dalvikvm
adb shell "dalvikvm -cp GetToken.class GetToken"  # ClassNotFoundException

# 方法3：dalvikvm64
adb shell "dalvikvm64 -cp GetToken.class GetToken"  # ClassNotFoundException

# 方法4：带 CLASSPATH
adb shell "CLASSPATH=/data/local/tmp/GetToken.class app_process /system/bin GetToken"  # Aborted
```

问题在于 `.class` 文件不能直接被 Android 运行时加载——需要转换为 DEX 格式。但设备上没有 `d8` 或 `dx` 工具。

### 5.4 尝试 4：伪造绑定请求

既然无法解密原始请求，我尝试从头构建一个新的请求：

```python
# 构建 JSON 数据
data = {
    "authType": 2,
    "clientVersion": "1.0",
    "device": device_prop,
    "description": description,
    "deviceId": device_id,
    "factor": "Redmi Note 12",
    "fingerprint": fp,
    "hardware": device_prop,
    "host": "10.0.0.1",
    "identifier": fp,
    "is64bit": True,
    "language": lang,
    "model": model,
    "nonce": nonce,
    "nonceServer": nonce,
    "os": "Android",
    "platform": "mt6833",
    "product": product,
    "region": region,
    "romVersion": version,
    "rom_version": "V14",  # 伪装成 MIUI
    "timezone": "+08:00",
}

# 签名
sign = signData(json.dumps(data, separators=(",", ":")))

# 发送请求
req = Request(
    f"{API}/v1/unlock/applyBind",
    data=urlencode({"data": data_str, "sid": "miui_sec_android", "sign": sign}).encode(),
    headers={"Content-Type": "application/x-www-form-urlencoded"},
    method="POST",
)
```

**结果**：`{"code":10000,"description":"参数异常"}`

测试了多种变体：

| 测试 | 结果 |
|------|------|
| 完整数据 + V14 | 10000 参数异常 |
| 完整数据 + V816 | 10000 参数异常 |
| 最小数据 | 10000 参数异常 |
| 不带 nonce | 10000 参数异常 |
| 空数据 | 10000 参数异常 |
| 不带签名 | 10000 参数异常 |
| 带 Cookie | 10000 参数异常 |

所有请求都返回相同的错误。这说明服务器在检查请求时有额外的验证逻辑，可能需要：
- 有效的 serviceToken（在 Cookie 中）
- 特定的请求头
- 有效的设备签名

### 5.5 尝试 5：拦截 HTTP 请求

尝试了多种方法拦截 Settings 应用的 HTTP 请求：

**方法 1：mitmproxy**

```bash
# 设置 adb reverse 端口转发
adb reverse tcp:8080 tcp:8080

# 设置设备代理
adb shell "settings put global http_proxy 127.0.0.1:8080"

# 启动 mitmdump
mitmdump --listen-port 8080
```

**结果**：没有捕获到任何流量。原因：HTTPS 流量不走 HTTP 代理，且无法在设备上安装 mitmproxy 的 CA 证书。

**方法 2：iptables 重定向**

```bash
adb shell "iptables -t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT --to-port 8080"
```

**结果**：`Permission denied (you must be root)`

**方法 3：strace 拦截**

```bash
adb shell "strace -p 26278 -e trace=network -s 4096"
```

**结果**：`ptrace(PTRACE_SEIZE, 26278): Operation not permitted`

### 5.6 尝试 6：获取 serviceToken

serviceToken 存储在 Android 的 AccountManager 中，是发送请求的关键认证信息。

**尝试的方法**：

```bash
# 方法1：content query
adb shell "content query --uri content://com.xiaomi.account.provider/account"
# 结果：Could not find provider

# 方法2：AccountManager 服务调用
adb shell "service call account 17"  # GET_AUTH_TOKEN
# 结果：account can't be found

# 方法3：dumpsys
adb shell "dumpsys account"
# 结果：只能看到账号名称，看不到 token

# 方法4：am startservice
adb shell "am startservice -n com.xiaomi.account/.authenticator.XmAuthenticationService \
    --es action getAuthToken --es accountType com.xiaomi --es authTokenType serviceToken"
# 结果：服务启动但无法获取 token

# 方法5：读取 SharedPreferences
adb shell "ls /data/data/com.xiaomi.account/shared_prefs/"
# 结果：Permission denied
```

**根本原因**：serviceToken 存储在受保护的系统区域，没有 root 权限无法访问。

### 5.7 尝试 7：Frida Hook

最后尝试使用 Frida 动态 hook Settings 进程：

```bash
# 安装 frida
pip3 install frida frida-tools

# 下载 frida-server
wget "https://github.com/frida/frida/releases/download/17.19.0/frida-server-17.19.0-android-arm64.xz"
xz -d frida-server.xz
adb push frida-server /data/local/tmp/
adb shell "chmod +x /data/local/tmp/frida-server"

# 运行 frida-server
adb shell "/data/local/tmp/frida-server -D"
```

**结果**：

```
Unable to load SELinux policy from the kernel: Failed to open file 
'/sys/fs/selinux/policy': Permission denied
```

Frida-server 需要 root 权限才能运行。

## 六、关键发现：服务器返回 30001

在所有尝试中，我们捕获到了一个关键信息。当我们监控 logcat 时，看到 Settings 应用自己发送的绑定请求：

```
CloudDeviceStatus: stateCode: 200
CloudDeviceStatus: content: {"code":30001,"description":"绑定失败，请前往小米社区内测中心申请授权后重试","descCN":"绑定失败，请前往小米社区内测中心申请授权后重试","descEN":"Couldn't add. Please go to Mi Community to apply for authorization and try again."}
```

这意味着：

1. **服务器可以解密新格式** - Settings 应用发送的加密请求被服务器成功处理
2. **问题是授权，不是加密** - 服务器拒绝是因为设备/账号未获得解锁授权
3. **`rom_version` 检查可能是关键** - 原始绕过通过改 V816→V14 来绕过这个检查

但问题是：**我们无法修改加密数据**，因为：
- 新格式使用 RSA+AES 混合加密
- 没有 RSA 私钥无法解密 AES 密钥
- 没有 root 无法获取 serviceToken 来伪造新请求

## 七、技术细节：完整的加密协议分析

### 7.1 LogEncryptor 类

Settings APK 中的 `LogEncryptor` 类负责加密日志数据。关键方法：

```java
// com.android.settings.bootloader.LogEncryptor
public class LogEncryptor {
    private PublicKey mPublicKey;  // RSA 公钥
    private SecretKey mSecretKey;  // AES 密钥
    
    // 生成 AES 密钥
    KeyGenerator keyGen = KeyGenerator.getInstance("AES");
    keyGen.init(128);
    mSecretKey = keyGen.generateKey();
    
    // 加密 AES 密钥
    Cipher rsaCipher = Cipher.getInstance("RSA/ECB/PKCS1Padding");
    rsaCipher.init(Cipher.ENCRYPT_MODE, mPublicKey);
    byte[] encryptedKey = rsaCipher.doFinal(mSecretKey.getEncoded());
    
    // 加密数据
    Cipher aesCipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
    aesCipher.init(Cipher.ENCRYPT_MODE, mSecretKey, new IvParameterSpec(IV));
    byte[] encryptedData = aesCipher.doFinal(data.getBytes());
}
```

### 7.2 数据格式

旧格式（纯 AES）：
```
<Base64 编码的 AES 加密数据>
```

新格式（RSA+AES 混合）：
```
#&^<Base64 编码的 RSA 加密 AES 密钥>!!<Base64 编码的 AES 加密数据>^&#
```

### 7.3 签名机制

HMAC-SHA1 签名，签名内容：

```
POST\n/v1/unlock/applyBind\ndata=<JSON数据>&sid=miui_sec_android
```

签名密钥：
```
10f29ff413c89c8de02349cb3eb9a5f510f29ff413c89c8de02349cb3eb9a5f5
```

### 7.4 API 请求流程

```
设备 → 服务器: GET /v1/micloud/nonce?sid=miui_sec_android
服务器 → 设备: {"code":0,"data":{"nonce":"..."}}

设备: 生成 JSON 数据（包含 nonce）
设备: 生成随机 AES 密钥
设备: AES-CBC 加密 JSON 数据
设备: RSA 加密 AES 密钥
设备: 组合格式 #&^RSA!!AES^&#
设备: HMAC-SHA1 签名

设备 → 服务器: POST /v1/unlock/applyBind
  data=<JSON>&sid=miui_sec_android&sign=<HMAC>
服务器: 验证 HMAC
服务器: RSA 解密 AES 密钥
服务器: AES 解密数据
服务器: 检查 rom_version 和授权状态
服务器 → 设备: {"code":30001,...} 或 {"code":0,...}
```

## 八、失败原因总结

### 8.1 核心障碍

| 障碍 | 原因 | 是否可解决 |
|------|------|-----------|
| RSA 私钥 | 服务器持有，不在设备上 | ❌ 不可能 |
| serviceToken | 存储在受保护的 AccountManager 中 | ❌ 需要 root |
| Settings 降级 | HyperOS 阻止降级 | ❌ 需要 root |
| app_process | 设备上无法运行自定义 Java | ❌ 缺少工具 |
| Frida | frida-server 需要 root | ❌ 需要 root |
| iptables | 需要 root 权限 | ❌ 需要 root |
| strace | 需要 root 权限 | ❌ 需要 root |

### 8.2 根本原因

**没有 root 权限是所有问题的根源。**

小米在 HyperOS 2.0 中：
1. 将加密从简单的 AES 升级到 RSA+AES 混合加密
2. RSA 私钥只存在于服务器端
3. 所有能获取关键信息的方法都需要 root 权限
4. Settings 应用无法降级

这形成了一个**死锁**：
- 解锁 BL 需要绕过加密
- 绕过加密需要 root 权限
- 获取 root 权限需要解锁 BL

### 8.3 对比旧版

| 特性 | 旧版 (MIUI) | 新版 (HyperOS 2.0) |
|------|-------------|---------------------|
| 加密方式 | AES-128-CBC | RSA-2048 + AES-128-CBC |
| AES 密钥 | 硬编码 | 随机生成 |
| 密钥保护 | 无 | RSA 加密 |
| 数据格式 | 纯 Base64 | `#&^...!!...^&#` |
| Settings 降级 | 可能 | 被阻止 |
| 服务器验证 | 仅格式 | 授权状态 |

## 九、可能的解决方案

虽然这次失败了，但以下方向可能值得探索：

### 9.1 获取 root 权限

- **利用漏洞**：寻找 HyperOS 2.0 的提权漏洞
- **工程模式**：某些设备可以通过工程模式获取临时 root
- **降级固件**：刷入旧版固件（但可能需要 BL 解锁）

### 9.2 修改设备系统

- **Magisk**：通过 Magisk 获取 root（需要 BL 解锁）
- **自定义 Recovery**：刷入 TWRP（需要 BL 解锁）
- **修改 boot.img**：注入 root 权限（需要 BL 解锁）

### 9.3 社会工程学

- **申请小米社区授权**：官方途径，但审核严格
- **联系小米客服**：说明解锁需求
- **购买开发者账号**：某些开发者账号有解锁权限

### 9.4 硬件方法

- **EDL 模式**：高通设备的紧急下载模式（MTK 设备不适用）
- **ISP 直读**：通过 ISP 直接读取闪存（需要专业设备）
- **拆机短接**：某些设备可以通过短接测试点进入特殊模式

## 十、总结

这次逆向工程虽然失败了，但收获了很多：

### 10.1 技术收获

1. **深入理解了小米的加密演变**：从简单的 AES 到 RSA+AES 混合加密
2. **学习了 Android 安全机制**：AccountManager、SELinux、权限系统
3. **实践了多种逆向工具**：DEX 分析、logcat 监控、网络抓包
4. **理解了 BL 解锁的完整流程**：从绑定账号到服务器验证

### 10.2 经验教训

1. **安全是动态的**：旧的绕过方法会被修补
2. **加密设计很重要**：RSA+AES 混合加密比纯 AES 更安全
3. **权限是关键**：没有 root 权限，很多操作无法进行
4. **服务器验证不可绕过**：即使修改了客户端数据，服务器仍可拒绝

### 10.3 最终建议

如果你也想解锁小米 HyperOS 设备的 BootLoader：

1. **首先尝试官方途径**：申请小米社区授权
2. **了解风险**：解锁 BL 会清除数据，可能影响保修
3. **备份数据**：解锁前务必备份重要数据
4. **保持耐心**：官方途径可能需要等待

## 附录 A：关键文件路径

| 文件 | 说明 |
|------|------|
| `/system_ext/priv-app/Settings/Settings.apk` | Settings 应用 |
| `classes2.dex` | 包含 LogEncryptor 类 |
| `classes4.dex` | 包含默认加密参数 |
| `/data/system/users/0/accounts.db` | AccountManager 数据库 |

## 附录 B：使用的工具

| 工具 | 用途 |
|------|------|
| adb | Android 调试桥 |
| Python 3 | 脚本编写 |
| pycryptodome | 加密算法 |
| adbutils | ADB Python 库 |
| frida | 动态 hook（未成功）|
| mitmproxy | 网络抓包（未成功）|
| jadx | DEX 反编译 |
| strings | 字符串提取 |
| hexedit | 十六进制编辑 |

## 附录 C：参考链接

- [MlgmXyysd/Xiaomi-HyperOS-BootLoader-Bypass](https://github.com/MlgmXyysd/Xiaomi-HyperOS-BootLoader-Bypass)
- [K0lb3/Xiaomi-HyperOS-BootLoader-Bypass-Python-Port](https://github.com/K0lb3/Xiaomi-HyperOS-BootLoader-Bypass-Python-Port)
- [TheAirBlow/HyperSploit](https://github.com/TheAirBlow/HyperSploit)
- [小米社区内测中心](https://bbs.xiaomi.cn/)

---

*本文记录于 2026 年 9 月 26 日，基于 HyperOS 2.0.6.0.UMQCNXM 版本。随着系统更新，文中描述的加密机制可能会有变化。*
