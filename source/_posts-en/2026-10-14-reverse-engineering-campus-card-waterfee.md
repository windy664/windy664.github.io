---
title: "Reverse Engineering G University's Campus Card Mini Program: Feeding Utility Balance Monitoring into My Personal Automation Assistant"
date: 2026-10-14 23:30:00
tags:
  - Reverse Engineering
  - WeChat Mini Program
  - mitmproxy
  - Rust
  - Campus Life
  - Automation
categories:
  - Tech Notes
---

# Reverse Engineering G University's Campus Card Mini Program: Feeding Utility Balance Monitoring into My Personal Automation Assistant

## Preface

I maintain a personal automation assistant called Ru41 (written in Rust: task system + Agent foundation + message push) running on a server in my dorm. Its design doc has had a "utility bill monitoring" item sitting in it for a while: automatically read my dorm's water and electricity balance every day, record the history, and proactively remind me when the balance runs low.

The campus card's top-up entry point lives inside a WeChat mini program, with no public API whatsoever. So began a complete reverse-engineering exercise: from static analysis of the mini program package, through three failed attempts at pure-API login, to a breakthrough via mitmproxy packet capture, and finally wiring the API into Ru41 to get daily monitoring running.

**Final results**:

- Fully reconstructed the ecard platform's authentication and signing mechanism (`MD5(sorted params + "greatge")`)
- Obtained two read-only endpoints (utility balance, daily usage details); token replay verified successfully
- Ru41 gained new `ecard poll/run` commands: daily collection → history persisted → low-balance alerts via Feishu/QQ
- A set of development rules for preventing sensitive information leaks (including CI secrets scanning)

**Redaction note**: The university is referred to as "G University" throughout; related domains are masked as `*.g***.edu.cn`; personal data such as student ID, phone number, token, and room number are all replaced with placeholders. Vendor information (Synjones ecard, Lianyi CAS) refers to publicly available commercial products and is kept as-is.

## 1. Tooling Choices

| Tool | Purpose |
|------|---------|
| strings / grep | Static analysis of the mini program package (wxapkg is encrypted; extract readable strings) |
| mitmproxy | Packet capture and token interception |
| Python (requests) | Endpoint probing and replay verification |
| Rust | Ru41 monitoring module |
| curl | Single-endpoint debugging |

## 2. Static Analysis: What Can Be Dug Out of the Mini Program Package

### 2.1 Locating the Target Package

PC WeChat (the new Linux xwechat) caches mini program packages at:

```bash
~/.xwechat/radium/Applet/packages/<AppID>/<version>/__APP__.wxapkg
```

There were a dozen or so packages in the directory; I located the target one by one using Chinese keywords (note that `strings` only extracts ASCII by default — for Chinese you need `grep -a` to search UTF-8 bytes directly):

```bash
for d in $(ls -t); do
  pkg=$(find "$d" -name "*.wxapkg" | head -1)
  hits=$(LC_ALL=C grep -acE "校园卡|水电|电费|充值" "$pkg" 2>/dev/null || echo 0)
  echo "$d Chinese hits=$hits"
done
```

The package with 5 hits was the target. A further `grep -aoE ".{20}(余额|充值).{20}"` confirmed it: strings like "账户余额" (account balance) and "钱包充值" (wallet top-up) were all present.

### 2.2 Domain and Endpoint Inventory

```bash
strings -n 6 __APP__.wxapkg | grep -oE "https?://[a-zA-Z0-9./_-]+" | sort -u
```

Three key domains turned up (masked):

- `ecarduser.g***.edu.cn` — user services (main API domain)
- `ecardhall.g***.edu.cn` — service hall
- `boss.greatge.net` — vendor admin console (Synjones ecard platform, a public commercial product)

Endpoint extraction (concatenated in the JS as `userServerHost+"path"`):

```
userServerHost:"https://ecarduser.g***.edu.cn/"
/waterfee/checkAccount        # water account type determination
/user/routine/dologin         # login
/user/routine/phonePwdLogin   # password login
/user/routine/sendVerifyCode  # SMS verification code
/user/routine/phoneVerifyCodeLogin
/user/routine/loginTypeList   # list of available login methods
```

The frontend routes also contain `powerFeeUrl:"/powerfee/index"` and `waterFeeUrl:"/waterfee/index"` — note that these are **H5 page paths**, not native pages.

### 2.3 Full Reconstruction of the Signing Algorithm

Searching for `md5`-related context turned up the request signing logic:

```javascript
// Original code extracted from the wxapkg (reformatted)
objKeySort: function(t) {
  delete t.token; delete t.sign;
  for (var n = "", r = Object.keys(t).sort(), a = {}, o = 0; o < r.length; o++)
    a[r[o]] = t[r[o]];
  for (var i in a) n += i + "=" + a[i] + "&";
  return n + e.default.secret   // secret: "greatge"
}
// At the call site:
var c = this.objKeySort(n.data);
n.data.sign = md5(c).toUpperCase();
n.data.token = wx.getStorageSync("token");  // token is added after signing
```

Translated into a rule: **`sign = MD5(k=v& pairs sorted by key + "greatge")` uppercased; token and sign themselves do not participate in signing**. Additionally, every request automatically carries the common fields `from=wxminiprogram` and `wxRequest="wxRequest"` (which do participate in signing).

Reproducing it in Python:

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

Verifying the signature: calling `loginTypeList`, which requires no login state, returned `{"ret":true, ...}` — the signing mechanism was confirmed correct, and I learned that this university's campus card has `SYSTEM_ACCOUNT` (student/employee ID login) enabled.

### 2.4 Unexpected Win: The H5 Pages Are Unencrypted

The utility bill pages are H5 pages embedded in a webview (`/powerfee/index`, `/waterfee/index`). A direct curl fetch returns 73KB of server-side rendered HTML, with all the ajax calls in plain sight:

```javascript
$.ajax({
    url: '/waterfee/getBalance',
    type: "post",
    data: {
        "implType": implType,
        "roomNum": roomNum,
        "buildingNo": buildingNo,
        "from": '', "token": ''   // injected during server-side rendering
    },
    success: function (response) {
        $("#feeTip").html("该房间剩余水量：" + response.obj.formatWaterBalanceStr);
    }
})
```

The H5 also exposed endpoints like `getRoomInfo` (three-level room list), `bindRoomInfo` (room binding), and `feeOrderList` (payment records). **The wxapkg is encrypted, but the H5 is not** — this was the most important breakthrough of the static analysis phase.

## 3. Three Failed Attempts at Pure-API Login

The goal was to obtain a token without the WeChat environment, so the server could query automatically every day. I tried three paths; all failed, but each ruled out a wrong assumption.

### 3.1 dologin: Blocked by openid

Calling it with the parameters from static analysis:

```python
call("user/routine/dologin", {
    "account": "<student ID>",
    "password": hashlib.md5(b"<password>").hexdigest()[8:24],  # the mini program's password transform
    "loginType": "spnsSigner",
})
# {"ret": false, "msg": "获取openid或者unionid失败，请退出小程序重新进入"}
```

The login has a hard server-side dependency on WeChat openid binding (obtained at mini program runtime by exchanging the temporary code from `wx.login` via `oauth/getTicket`). Switching student IDs or loginType (`SYSTEM_ACCOUNT`/`rftSigner`) produced the same error. **Pure API cannot complete the first login** — this path was dead.

### 3.2 CAS Single Sign-On: CODEFALSE

The ecard H5 redirects with a 302 to the university's unified authentication: `sso.g***.edu.cn` → `cas.g***.edu.cn/lyuapServer/login` (Lianyi CAS). CAS has a standard REST protocol, and I even dug the RSA public key parameters out of the frontend SPA's JS:

```javascript
// In app.<hash>.js:
{ CAS: "/lyuapServer", public_exponent: "010001",
  modulus: "413798867d69babed22e0d..." }  // 256 hex digits (1024-bit)
// Submission logic: password is RSA-encrypted, then POSTed to /lyuapServer/v1/tickets
```

I hand-rolled PKCS#1 v1.5 padding + `pow(em, 65537, modulus)` encryption (no dependency libraries needed) and POSTed to `/v1/tickets`:

```python
def rsa_encrypt_pwd(pwd: str) -> str:
    m = pwd.encode(); k = 128; n = k - 3 - len(m); ps = b""
    while len(ps) < n:
        ps += bytes(b for b in os.urandom(n * 2) if b)
    em = b"\x00\x02" + ps[:n] + b"\x00" + m
    c = pow(int.from_bytes(em, "big"), 65537, MODULUS)
    return base64.b64encode(c.to_bytes(k, "big")).decode()
```

The result was uniformly `{"data":{"code":"CODEFALSE"}}` — the CAS-side password isn't synced with the campus card password (or there are encryption details I hadn't reconstructed). This path was shelved for now.

### 3.3 SMS Verification Code: The Closest Attempt

I discovered the `sendVerifyCode` (send SMS) + `phoneVerifyCodeLogin` (code login) combination. Sending actually worked:

```python
call("user/routine/sendVerifyCode", {
    "phoneNumber": "138****0000", "loginType": "SYSTEM_ACCOUNT", "isUpdatePwd": "false"
})
# {"ret": true, "msg": "验证码发送成功"}
```

The SMS arrived on my phone within seconds. But logging in with the 4-digit code I read returned "incorrect SMS verification code" — maybe I misread the code or it expired, or maybe there were login parameter details I hadn't reconstructed. Rather than hammering the resend endpoint, I pivoted to packet capture.

### 3.4 Ruling Out Local Storage Along the Way

The mini program's wx storage lives in MMKV files (`~/.xwechat/radium/Applet/<hash>/local/<AppID>/usrmmkvstorage*/`). Opening them revealed nothing but random bytes — PC WeChat encrypts mini program storage, and strings couldn't extract a single key name. Abandoned.

## 4. The Packet Capture Breakthrough

### 4.1 Installing the mitmproxy CA for the Current User, No Root Needed

On Linux, Chromium-based applications read the NSS shared certificate database, and a user-level install requires no root:

```bash
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n mitmproxy \
  -i ~/.mitmproxy/mitmproxy-ca-cert.pem
```

### 4.2 Environment-Variable Proxy Failed

I tried injecting a proxy by restarting WeChat with `https_proxy=http://127.0.0.1:8080 wechat` — the mini program connected to the network as usual, but zero traffic showed up in the proxy. **The WeChatAppEx mini program runtime ignores system/environment proxies**.

### 4.3 Manual Proxy + mitmproxy Capture Script

Back to the old way: WeChat settings → General settings → Network proxy → manual `127.0.0.1:8080`. mitmdump with a script that only records the target domains:

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

Opened the mini program → tapped into the electricity page → 73 requests captured.

### 4.4 Analyzing the Real Traffic

**Login state acquisition** (the actual call on every mini program launch):

```
POST /user/routine/routine-login
  code=<wx.login temporary code>&openid=o6***&unionid=op***&sno=<student ID>
  &from=wxminiprogram&wxRequest=wxRequest&sign=<signature>&token=<old token>
→ {"code":200, "token":"node0***...", "msg":"登录成功", ...}
```

Key finding: **the request already carries the old token from local storage, and the server accepts it** — the token is long-lived and reused across sessions. This means capturing one token is enough for long-term scripted queries (its exact lifetime needs real-world testing).

**Balance endpoint** (no signature required, token only):

```
POST /powerfee/getBalance
  implType=CGCOMMON1111&schoolAreaNo=81&buildingNo=1859&roomNum=2158&from=wxminiprogram&token=node0***
→ {"ret":true,"obj":{
     "powerBalance":"19.7", "waterBalance":"2.8",
     "formatPowerBalanceStr":"19.70度", "formatWaterBalanceStr":"2.80吨",
     "schoolArea":"***campus","building":"***building","room":"*#***"}}
```

**Daily usage details** (the key to distinguishing top-ups from consumption):

```
POST /powerfee/getDailyDetails
  roomNum=***&lastDate=2026-10&type=2&implType=...&pageNum=1&pageSize=20&token=...
  # type=1 water, type=2 electricity
→ {"dailyDetailsInfos":[
     {"dailyUsed":"12.01","leftUsed":"9.85","dateTime":"2026-10-01"},
     {"dailyUsed":"4.34","leftUsed":"-1.42","dateTime":"2026-10-03"}, ...]}
```

A negative `leftUsed` immediately followed by a jump = overdraft then top-up; top-up events can be identified directly from the data.

### 4.5 Token Replay Verification and WAF Rate Limiting

Replaying `getBalance` verbatim with curl returned exactly what the mini program showed — **the pipeline works**. Along the way I observed the platform's WAF: burst requests from a single IP get their SSL connections reset, recovering automatically after a dozen or so seconds. This directly dictated the collection cadence: 1–2 requests per day, back off on failure, never concurrent.

## 5. Landing in Ru41: The ecard Monitoring Module

### 5.1 Where It Sits in the Architecture

The module fully reuses Ru41's existing source-adapter pattern, with zero changes to the core:

```
ecard run (timer, daily by default)
   ↓ POST /powerfee/getBalance
readings recorded (ecard_reading; same-day overwrite, cross-day becomes history)
   ↓ pure-Rust threshold check (design principle: never hand money math to the Agent)
below threshold → pushed via the default [notify] outlet (Feishu webhook / QQ)
   ↓ ecard_alert records deduplication; at most one alert per day
```

Configuration (local `ru41.toml`, gitignored):

```toml
[sources.ecard]
base_url = "https://ecarduser.g***.edu.cn"
token = "node0***"            # prefer the RU41_ECARD_TOKEN environment variable
impl_type = "CGCOMMON1111"
school_area_no = "**"
building_no = "****"
room_num = "****"
power_threshold = 10.0        # kWh
water_threshold = 1.0         # tons
interval_secs = 86400
```

Usage:

```bash
ru41 ecard poll   # query once (suitable for a daily system cron job)
ru41 ecard run    # long-running daily queries
# Output: {"power": 18.87, "power_label": "18.87度", "water": 2.8, ...}
```

### 5.2 Channel Decoupling

In Ru41, channel knowledge lives only in the assembly layer: business modules just say "I need to notify," and the global `[notify] channel` decides whether it goes through Feishu or QQ — the ecard module receives only an injected `NotifyChannel` trait object, with no channel names anywhere in its code.

### 5.3 Sensitive Information Protection

Reverse engineering involves a batch of sensitive data — token, student ID, phone number — so the development rules establish a clear layering:

| Layer | Contents | Where it goes |
|---|---|---|
| Protocol layer | Endpoints, parameter names, signing algorithm, vendor secret | Code and docs; can be public |
| Account layer | token, openid, student ID, room number | Local config only (gitignored) or environment variables |
| Credential layer | Passwords, SMS verification codes | Memory only, hashed immediately, never persisted |

Supporting measures:

- The university's domains were removed from the code; `base_url` became a local config item
- CI gained secrets scanning: `grep -rInE "node[0-9a-z]{30,}|1[3-9][0-9]{9}|..."` fails the build on any hit (test fixture files with fake data are whitelisted)
- Capture logs moved from /tmp to `~/.config/ru41/` (700 permissions); tests use fake data exclusively

## 6. Pitfalls Encountered

**6.1 strings doesn't show Chinese.** GNU strings only extracts ASCII sequences by default; UTF-8 Chinese gets filtered out entirely. Chinese keywords require `LC_ALL=C grep -a` to search the binary directly.

**6.2 Bitten by my own test for 14 minutes.** I wrote `let body = &bodies.lock().unwrap()[0];` in an integration test — Rust's temporary lifetime extension kept the MutexGuard alive until the end of the scope, so the mock server thread could never acquire the lock on the second request, and the test hung silently. The fix: clone the data out of the lock and release it immediately. **Lesson: never hold a lock guard across an await or across requests.**

**6.3 CAS's CODEFALSE doesn't mean an encryption error.** Lianyi CAS's REST endpoint returns the same `CODEFALSE` for any failure (wrong username, wrong password, wrong encryption), so blindly tweaking encryption details is a waste of time — I later realized the SSO password and the campus card password simply aren't synced.

**6.4 Never assume the token's lifetime.** The capture proved the token works right now and is reused across mini program sessions, but its exact lifespan will only be known the day it expires. The module treats "token expiry returns a clear error → alert me to re-capture manually" as a first-class path, rather than pretending the token lasts forever.

## 7. Compliance and Boundaries

- I only read my own dorm's balance and daily usage, at a call frequency of a few times per day at most — far below normal user behavior on the platform
- I don't touch the top-up ordering endpoint (located at `/user/account/chargePay`; automatic top-up is explicitly out of scope for the first version)
- Publishing the protocol details helps other students on the same platform (Synjones ecard serves a large number of universities) build their own personal automation; personal credentials stay strictly local

## 8. Summary

This reverse engineering took a much more winding path than the last one ([reverse engineering the campus food ordering system](https://windy664.github.io/2026/09/26/2026-09-26-reverse-engineering-gruangroun-xiaoer/)): the signing algorithm from static analysis was completely correct, but **a correct signature doesn't mean you can log in** — the server hard-binds the first login to the WeChat openid, all three pure-API paths dead-ended, and in the end mitmproxy delivered the decisive blow.

Methodological takeaways:

1. **Static first, dynamic second**: the signing algorithm, endpoint inventory, and H5 endpoints were all in place before capture began; the capture only needed to verify and supply a token — a completely different level of efficiency
2. **H5 is a gold mine**: wxapkg encryption protects the native code, but the H5 inside the webview is plaintext
3. **Record the failed paths too**: the three dead ends (dologin, CAS, SMS code) ruled out wrong assumptions, so I won't walk them again when I encounter other features on the same platform
4. **Monitoring needs should respect the platform**: WAF rate limiting isn't an obstacle but a boundary; a query cadence of a few times a day is good for both sides

Now Ru41 glances at my utility balance every morning and pushes a Feishu alert if it drops below 10 kWh. Given October's average consumption of 5.7 kWh per day, the first real alert should arrive soon — and that will be the best possible acceptance test for the whole pipeline.
