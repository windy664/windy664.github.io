---
title: 我花了一整天试图破解小米 HyperOS 2.0 的 BootLoader 加密，结果被上了一课
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

# 我花了一整天试图破解小米 HyperOS 2.0 的 BootLoader 加密，结果被上了一课

> 利益相关：一个想 root 自己手机的普通用户，被小米的安全工程师教做人了。

---

## 先说结论

**没 root 的情况下，HyperOS 2.0 的 BootLoader 绑定加密无解。**

不是"很难"，是"理论上不可能"。小米这次把 RSA 私钥放在了服务器端，你在客户端做的任何操作，最终都要服务器点头。而服务器会检查你的设备有没有在小米社区申请过解锁授权。没授权？30001 错误，谢谢惠顾。

想绕过？你需要改数据里的 `rom_version` 字段。想改数据？你需要解密。想解密？你需要 RSA 私钥。私钥在哪？在小米服务器上。

**死锁了。**

下面是我这一天的完整折腾记录。

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

用 `strings` 配合十六进制编辑器翻了半天，挖出来不少东西。

**RSA 公钥**（`classes2.dex` 偏移 7116962）：

```
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxPEmV1vZ60qc39gWvaSc
7QgV/Ltc95eTBiWsRcN5VDeqjGwRPmk7TBXvU+YQ6q2LrfiaDQYg8ZwxjwUTsWoL
J7l8AHE0WdUEvdV36+BMbB9w7ts2IISZZNnJyyZleU+SImWYRybKkTPX//Ld/bgK
NFz3dxJzYxLXdKzcZogHLI2Mvvj31/ZmqvKuRxXBQ2iU4oSPthQRXFY+KbQJ1Z3Z
sFzMJfGaY1jj+8ymUd4zWGXgztQLuvpUNtiVHGW1WhP8854yJqbQ1VcqfIueKR74
qoQgUbXHFuYbvz6B0c+bEgJ/tn/bXcM8Zo8aADFgZNCChbzAhB9wf3zx2RLJe7aN
awIDAQAB
```

RSA-2048，公钥指数 65537。

**其他密钥**（`classes2.dex` 偏移 6167000-6169000 区域）：

| 偏移 | 值 | 用途 |
|------|-----|------|
| 6167963 | `0102030405060708` | 旧版 AES IV（新版没用了）|
| 6168451 | `10f29ff413c89c8de02349cb3eb9a5f5...` | HMAC 签名密钥 |
| 6168583 | `158a7dbb3a76489a81a76ecd24a452be` | 未知，可能是另一个 AES 密钥 |

**关键字符串**：`RSA/ECB/PKCS1Padding`、`mEncrytedKey`（注意 typo）、`mSecretKey`、`encryptMsg`、`LogEncryptor`……

到这里我已经意识到情况不对了——有 RSA 公钥，意味着新版用的是非对称加密。公钥在客户端，私钥在服务器。这意味着我**永远解不了**客户端的加密数据。

---

## 加密协议：小米到底改了什么

### 旧版（MIUI）

```python
DATA_PASS = b"20nr1aobv2xi8ax4"   # 硬编码
DATA_IV = b"0102030405060708"      # 硬编码
```

AES-128-CBC，密钥写死在代码里。谁都能解。GitHub 上的工具就是利用这个。

### 新版（HyperOS 2.0）

整个推翻重来了：

1. 每次请求生成**随机 AES 密钥**（`KeyGenerator.getInstance("AES")`）
2. AES-CBC 加密 JSON 数据
3. **RSA-2048 公钥加密 AES 密钥**
4. 拼接格式：`#&^<RSA加密的AES密钥>!!<AES加密的数据>^&#`
5. HMAC-SHA1 签名（签名密钥没变）

关键区别：**AES 密钥每次都不一样，而且被 RSA 保护了**。旧版的硬编码密钥完全没用。

RSA 公钥虽然在 DEX 里能找到，但**私钥只在服务器上**。你能加密，但你解不了。

---

## 七种方法，七种死法

### 方法一：跑原始绕过脚本

改了一下 logcat 解析逻辑，因为新版格式变了——`args` 和 `headers` 合并成一行了：

```python
if data.startswith("#&^") and "!!" in data:
    inner = data[3:-3]
    parts = inner.split("!!")
    # parts[0] = RSA 加密的 AES 密钥
    # parts[1] = AES 加密的数据
```

解析没问题，下一步解密直接炸：

```
ValueError: Data must be padded to 16 byte boundary in CBC mode
```

废话。这是 RSA 加密后的东西，你拿 AES 密钥去解，当然不对。

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

后来想明白了：服务器在检查 `serviceToken`（在 Cookie 头里）。Settings 应用发请求的时候会带上这个 token，但我拿不到。

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

但 token 是加密存储的，没有 root 看不到。

### 方法七：Frida 动态 Hook

最后一招。Frida 可以在运行时 hook Java 方法，我想 hook `LogEncryptor` 截获 AES 密钥。

```bash
pip3 install frida frida-tools
adb push frida-server /data/local/tmp/
adb shell "/data/local/tmp/frida-server -D"
# Unable to load SELinux policy: Permission denied
```

frida-server 要 root。又是一堵墙。

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

1. **服务器能解密新格式**。Settings 发的 RSA+AES 数据，服务器处理成功了（30001 不是 10000）。
2. **问题在授权不在加密**。服务器拒绝是因为设备没授权，不是解密失败。
3. **原来的绕过思路是对的**。改 `V816`→`V14` 应该能绕过，但我改不了数据。

我还看到 Settings 应用每隔一秒重试一次，每次都 30001。它自己也搞不定。

---

## 为什么所有方法都失败

| 方法 | 卡在哪 |
|------|--------|
| 原始脚本 | 新加密解不了 |
| 降级 Settings | 系统阻止安装 |
| app_process | 没有 DEX 转换工具 |
| 伪造请求 | 缺 serviceToken |
| mitmproxy | HTTPS 要 CA 证书（要 root）|
| iptables | 要 root |
| strace | 要 root |
| 提取 serviceToken | 权限不够 |
| Frida | frida-server 要 root |

**每条路最后都指向同一个问题：没有 root。**

而 root 需要解锁 BL，解锁 BL 需要绕过加密，绕过加密需要 root。

小米这次的设计思路很清晰：**把信任根放在服务器端**。客户端只有公钥，能加密但解不了。所有关键操作都要服务器配合。而服务器只认两种情况：要么你在小米社区申请过授权，要么你把 `rom_version` 改成 MIUI 格式让它以为你是老设备。

前者是官方流程，后者需要你能修改加密数据——但你改不了。

---

## 新旧对比

| | 旧版 (MIUI) | 新版 (HyperOS 2.0) |
|---|---|---|
| 加密 | AES-128-CBC，密钥硬编码 | RSA-2048 + AES-128-CBC，密钥随机 |
| 数据格式 | 纯 Base64 | `#&^...!!...^&#` |
| 密钥位置 | DEX 里写死了 | RSA 私钥只在服务器 |
| Settings 降级 | 能装 | 装不了 |
| 服务器验证 | 只看格式 | 看授权状态 |
| 绕过难度 | 改个字段就行 | 理论上不可能 |

---

## 还能怎么办

虽然这次失败了，但列几个方向：

**内核提权漏洞**：HyperOS 2.0 基于 Android 14，如果找到提权漏洞（CVE-2024-53150 那种级别），可能拿到临时 root。但漏洞可遇不可求，小米还会快速修补。

**MTK BROM 模式**：联发科设备有 BROM 模式，理论上可以短接测试点进入。但新芯片已经锁了 BROM，需要授权。

**ISP 直读**：用编程器直接读 eMMC/UFS。要拆机、焊接、专业设备。成本高风险大。

**社区申请**：最正规的途径。去小米社区内测中心申请。但中国版审核很严。

---

## 写在最后

折腾了一整天，白忙活。但也不是完全没收获——至少把 HyperOS 2.0 的加密协议从头到尾扒了一遍，从 DEX 里提取了 RSA 公钥和 HMAC 密钥，搞清楚了整个绑定流程的链路。

最大的教训：**安全是动态的**。去年能用的方法今年就不行了。小米这次的加密升级确实到位——RSA 私钥放服务器端，客户端永远拿不到，这个设计本身就没有绕过的空间。

除非你能攻破小米的服务器。

（别真去干啊。）

---

*2026-09-26 记录，基于 HyperOS 2.0.6.0.UMQCNXM。系统更新后加密机制可能有变化。*
