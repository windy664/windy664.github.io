---
title: 我把 Agent 技能从 Groovy 换成了 Kether——不是打脸，是同一条路走到底
date: 2026-07-15 22:00:00
tags: [Agent, Groovy, Kether, TabooLib, 安全, DSL, Minecraft]
categories: [AI 应用]
---

一个月前我写了篇[《别人的 Agent 技能都用 Python，我的偏用 Groovy》](/2026/06/15/groovy-not-python-agent-skills/)，核心论点是：**执行器该选宿主的母语**——宿主在 JVM 上，技能也该在 JVM 上，Groovy 让你零距离拿到活的 Server 对象，零 IPC、零桥接。

一个月后我把 Groovy 换掉了。换成了 [TabooLib](https://github.com/TabooLib/taboolib) 的 **Kether**——一个受限的 DSL 脚本引擎。

这看起来像打脸。但我想说的是：**这不是推翻上一篇的论点，是沿着同一条线往下走了一步。** 上一篇解决的问题（为什么要 JVM 语言、为什么要和宿主零距离）依然成立；这次解决的是上一篇末尾我自己埋的那个隐患——"没有沙箱，信任边界在文件系统"这个工程权衡，到底能不能做得更干净。

<!-- more -->

## 先说 Groovy 真实踩过的坑

上一篇写"代价是放弃沙箱"的时候，我其实已经知道这是个问题，但心态是"能接受"。跑了几个礼拜之后，我发现"能接受"和"做得好"之间差了整整一个量级。

### 坑一：有人真写了 System.exit(0)

不是假设场景。一个服主在技能里写了：

```groovy
// "重启服务器"的技能——他以为 System.exit 会让进程优雅退出
System.exit(0)
```

服务器直接挂了。没有优雅退出，没有保存数据，就是一个 `kill`。当然这是服主自己写的，怪不到框架——但问题在于，**框架居然允许这种事发生**。一个"技能"能把整个进程杀掉，这在任何正常的安全模型里都不该是可接受的。

### 坑二：Thread.sleep 卡死主线程

Bukkit API 是非线程安全的，所以我让技能在主线程跑。有人写了：

```groovy
Thread.sleep(30000)  // "等30秒再发奖励"
```

主线程冻结 30 秒。TPS 直接掉到 0。看门狗能解除 Agent 这边的等待——但**看门狗没法强杀一个正在主线程上空转的脚本**。强行中断 Java 主线程？那等于崩服。上一篇写过这个局限，但当时我觉得"超时 + 提醒"够了。不够。

### 坑三："服主审过"在多人团队里不成立

上一篇说信任边界是"服主写、亲自审"。但真实的服务器团队里，有 RCON 管理员、有子管理员、有"帮服主写技能的热心玩家"。谁审？审了谁？版本控制呢？一个 `.groovy` 文件改了一行 `Thread.sleep(0)` 变成 `Thread.sleep(600000)`——谁来发现？

**"人审过"作为最后一道防线，取决于人的纪律。而纪律不是工程手段。**

这些问题的共同指向是：上一篇的架构里，安全模型是**外挂的**——护栏、看门狗、审计日志，全都是"堵"的思路。真正该做的是把安全**内化进执行器本身**。

## Kether：一个只能调已注册动作的 DSL

[TabooLib](https://github.com/TabooLib/taboolib) 是 Minecraft 插件开发的跨平台框架，基于 Kotlin，特点是极轻量（30KB 起步）和跨 Bukkit/BungeeCord/Velocity。它内置了一个叫 **Kether** 的脚本引擎。

Kether 不是通用编程语言。它是一个 **DSL**（Domain-Specific Language），语法是 S-expression 风格的动作链：

```kether
tell "Hello World"
command "say 服务器维护中"
action-bar color "&a" text "欢迎回来"
check player has permission "admin"
if * &eq true then tell "你是管理员" else tell "你不是"
```

看起来像玩具？关键在它的执行模型：

> **Kether 只能调用已注册的 action。** 没有注册的动作，在语法层面就不存在——不是"调了会报错"，是"根本编译不过"。

这意味着什么？

- `System.exit`？不存在。没注册过这个 action。
- `Thread.sleep`？不存在。
- 文件 I/O、网络请求、反射、`Class.forName`？全都不存在。
- 你想让技能能做什么，**必须先在 Java/Kotlin 侧注册一个 action**，明确定义它做什么、参数是什么、有什么前置检查。

这就从"开放沙箱 + 黑名单"变成了"受限 DSL + 白名单"。

用一个比喻：Groovy 方案是**给了你整栋大楼的钥匙，然后在几扇门上贴了"别进"的纸条**；Kether 方案是**只给你该进的那几间房的钥匙，其余的门你连钥匙都没有**。

## 安全模型的内化：从"外挂护栏"到"执行器自带"

上一篇的安全方案是这样的：

```
技能脚本 (Groovy)
    ↓
参数预校验 ← 外挂
    ↓
GroovyShell 执行
    ↓
超时看门狗 ← 外挂
    ↓
审计日志 ← 外挂
    ↓
"服主审过" ← 信任假设
```

每一层护栏都是外挂的，都可以被绕过（`Thread.sleep` 绕过看门狗，`System.exit` 绕过一切）。

迁移后的方案：

```
技能脚本 (Kether)
    ↓
参数预校验 ← 保留
    ↓
Kether 编译（compile） ← 语法验证，非法动作直接拒绝
    ↓
Kether 执行（dryRun / 真实执行） ← 只能调已注册 action
    ↓
审计日志 ← 保留
```

看门狗**不需要了**——因为 Kether 里根本写不出能卡主线程的东西。`System.exit` 这类操作在语法层面就被排除了。安全不再依赖"外挂护栏 + 人审"，而是**内化进了执行器的表达能力边界**。

更具体地说，这次迁移加了一个 `skill_validate` 的远程验证机制：

```kotlin
// 两种验证模式
when (mode) {
    "compile" -> engine.compile(script)   // 语法检查：动作是否存在、参数是否合法
    "dryRun"  -> engine.dryRun(script)    // 模拟执行：返回 success/error + 操作列表
}
```

Velocity 中心端（代理服务器）不能执行 Bukkit Kether——但可以通过 RPC 委托目标子服验证。这意味着技能在部署前就能被**静态验证**，而不是到了运行时才发现写错了。

上一篇我说"最后一道防线是人，不是代码"。现在我要修正这句话：**最后一道防线可以是执行器的表达能力边界，人是倒数第二道。**

## 迁移的具体工作

这次改动是 38 个文件、+566/-529 行。说大不大，说小不小。记录一下关键步骤。

### 依赖替换

```kotlin
// 之前
compileOnly("org.codehaus.groovy:groovy:3.0.22")

// 之后
compileOnly("io.izzel.taboolib:common:6.3.0-4bced1a")
compileOnly("io.izzel.taboolib:common-platform-api:6.3.0-4bced1a")
compileOnly("io.izzel.taboolib:platform-bukkit:6.3.0-4bced1a")
compileOnly("io.izzel.taboolib:minecraft-kether:6.3.0-4bced1a")
```

注意是 `compileOnly`，不是 `shaded`（打包进去）。服务端必须**已经装了 TabooLib**，否则技能功能降级。这是一个有意的决定——我不想把 TabooLib 的 30KB 塞进 WindyAgent 的 fat jar，因为很多服务器本身就在用 TabooLib。

### 运行时检测 + 优雅降级

如果服务端没装 TabooLib，不能崩。加了 `isKetherRuntimeMissing()` 方法：

```kotlin
private fun isKetherRuntimeMissing(e: Throwable): Boolean {
    var current: Throwable? = e
    while (current != null) {
        if (current is NoClassDefFoundError || current is ClassNotFoundException) {
            val msg = current.message?.lowercase() ?: ""
            if (msg.contains("taboolib") || msg.contains("kether")) return true
        }
        val msg = current.message?.lowercase() ?: ""
        if (msg.contains("taboolib") || msg.contains("kether")) return true
        current = current.cause
    }
    return false
}
```

走异常链，判断是不是 TabooLib 缺失导致的。是的话，打一条警告日志，返回 `null`——技能功能静默降级，服务器正常运行。

### 系统提示词更新

SystemPrompt.kt 里所有"Groovy"改成"Kether"。更重要的是加了一条：

> Velocity 中心端不可执行 Bukkit Kether，必须用 validate_skill_on_server 委托目标子服验证。

这是因为 Kether 需要 Bukkit API 环境才能编译和执行，而 Velocity 是代理端，没有 Bukkit 运行时。这条约束在 Groovy 时代也存在，但当时没显式写出来——现在 DSL 有编译步骤，必须走远程验证。

### 脚本重写

`.groovy` 文件转成 `.kether`。举个例子：

```groovy
// 旧：Groovy 版 online_report
def p = server.onlinePlayers
def msg = "在线 ${p.size} 人：${p.collect { it.name }.join(', ')}"
return msg
```

```kether
# 新：Kether 版 online_report
def players = online-players
def count = players | size
def names = players | map name | join ", "
tell &f"在线 &a${count} &f人：&a${names}"
```

Kether 的写法更啰嗦，但每一步都是**可验证的**——`online-players`、`size`、`map`、`join` 全是注册好的 action，不会出意外。

## 代价和权衡

说了一堆好处，该说代价了。

### 表达力下降

Kether 不是通用编程语言。复杂的集合操作、异常处理、多层嵌套逻辑——在 Groovy 里几行搞定的事，在 Kether 里可能写不出来，或者写出来可读性很差。

这意味着**某些"高级技能"得退回 Java/Kotlin 侧实现**，注册成自定义 action，再暴露给 Kether 调用。这比"直接在 Groovy 里写"多了一层——你需要在框架代码里新增一个 action 注册。

但反过来想：这层额外的摩擦**恰好就是安全边界**。每一个被暴露给 Kether 的 action，都是你**显式决定**"这个操作是安全的、可以被技能调用的"。这不是限制，这是**受控的能力授予**。

### 跨插件软依赖变难了

上一篇里 Groovy 最得意的一点是：

```groovy
// 没装 Vault 也不会编译报错
def econ = Class.forName("net.milkbowl.vault.economy.Economy")
```

在 Kether 里这不可能了——没有 `Class.forName`。如果你想让技能调用 Vault 的经济 API，你得先在框架侧注册一个 `deposit` action：

```kotlin
@KetherAction(["deposit"])
fun deposit(player: Player, amount: Double) {
    val econ = server.servicesManager.getRegistration(Economy::class.java)?.provider
    econ?.depositPlayer(player, amount)
}
```

然后技能里写：

```kether
deposit player ${player} amount ${coins}
```

多了一步注册，但这个 action 是**类型安全的、可审计的、有前置检查的**。而且注册只需要做一次——之后所有技能都能用。

### TabooLib 依赖

`compileOnly` 意味着服务端得自己装 TabooLib。如果没装，技能功能降级。这比"一个 jar 搞定"多了一个前提条件。

但 TabooLib 在 Minecraft 插件生态里是个**极其常见的依赖**——387 stars、119 forks、574 个 release。很多服主的服务器上本来就有。没有的，警告日志会告诉他装一下。这个代价我认为可以接受。

## 三篇博客的思维链

写到这里，我回头看了一下这三篇（加上之前那篇"不让 LLM 现场写代码"），发现它们其实是**同一条思路的三个切面**：

| | 第一篇（不让 LLM 写代码） | 第二篇（Groovy 不是 Python） | 这一篇（Groovy → Kether） |
|---|---|---|---|
| **解决的问题** | 技能的确定性 | 技能与宿主的接近程度 | 技能的安全模型 |
| **核心决定** | 服主写、Agent 调 | 选 JVM 语言，不选 Python | 选受限 DSL，不选通用语言 |
| **安全策略** | 人审 + 审计 | 信任边界在文件系统 | 执行器自带白名单 |
| **代价** | 不能自动生成 | 没有沙箱 | 表达力下降 |

每一步都是在**同一个方向**上推进：让安全从"外挂"变成"内建"，让信任从"假设"变成"结构"。

## 这条路不是唯一的

最后想强调一点：**这个迁移的前提是宿主在 JVM 上。**

如果 WindyAgent 管的不是 Minecraft Java 服务端，而是一个 Python 后端、一个 Go 微服务——那第二篇的论点（"执行器选宿主的母语"）依然成立，Groovy 的论证依然成立。Kether 不是通用解，它是"宿主是 JVM + 已有 TabooLib 生态"这个特定组合下的最优解。

但思路是通用的：**技能的执行器不该是"什么都能做"的通用运行时，而应该是"恰好够用"的受限环境。** 恰好够用意味着：你需要的能力它有，你不需要的能力它压根没有。不是"能做但被拦住"，是"做不到"。

从 Groovy 到 Kether，从"什么都能做，靠护栏拦"到"只能做注册过的，别的不存在"——这是同一个设计哲学的自然演进。

---

下一篇想聊一个更头疼的问题：技能既然能在「中心」（Velocity 代理端）也能在「子服」（Bukkit 服务端）跑，它到底该**存在哪、在哪执行**。这背后有个绕不开的物理约束。
