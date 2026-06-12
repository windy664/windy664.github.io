---
title: Mohist 系混合服务端的两个深坑——被冻结的主线程，和不触发的调度器
date: 2026-06-13 01:10:00
tags: [Minecraft, NeoForge, 调试, 工程反思]
categories: [工程化]
---

我的 Agent 子服端跑在一台 Youer（Mohist 系的 NeoForge + Bukkit 混合服务端）上。混合端最大的特点是「既能上 Forge/NeoForge 的模组，又能上 Bukkit 插件」，但代价是 Bukkit API 那套是**移植/模拟**出来的，行为和原版 Spigot 有微妙差异。这篇记两个把我坑了半天的真实 bug，以及它们共同指向的一条经验。

<!-- more -->

## 坑一：命令执行全部 5 秒超时，但不是网络问题

现象：中心 Agent 让子服执行命令（`run_command`），全部卡 5000ms 超时。但**检索类操作（查命令目录）却好好的**。

第一反应是总线/网络。但子服日志明明写着「已连接中枢、注册成功」，连接没问题。差别在哪？检索是**纯读、不碰主线程**；而执行命令要调 `Bukkit.dispatchCommand`，这必须在**主线程**跑（Bukkit API 非线程安全）。

我的代码是：在总线订阅线程上收到请求，用调度器跳回主线程执行，再阻塞等结果。所以问题被锁定在「主线程那头没动」。

翻日志翻到这一行：

```
Server empty for 60 seconds, pausing
```

**没有玩家在线，服务器把自己暂停了。** MC 新版的 `pause-when-empty-seconds`（默认 60 秒空服暂停）会停掉主线程 tick。主线程不转，我跳过去的任务永远不执行，于是阻塞到超时。我测试时正好没人在线，必踩。

改 `server.properties` 关掉空服暂停（`pause-when-empty-seconds=-1`），坑一解决。**但这其实只解了一半**——我当时没意识到。

## 坑二：暂停关了，还是超时

关掉暂停、确认日志里没有 `pausing` 了，命令还是超时。这下网络、暂停都排除了，只剩一个可能：**跳回主线程这个动作本身没生效。**

回想之前还有个伏笔：我做能力目录同步时，用 `runTaskLaterAsynchronously`（Bukkit 调度器的延迟异步任务）建目录，那个任务**从来没触发过**——当时我以为是时机问题，改成了独立线程绕过去。现在串起来了：

> **Youer / Mohist 系混合端的 Bukkit 调度器，对插件任务不可靠。** 我那个「跳回主线程」用的 `Bukkit.getScheduler().runTask(...)`，和当初那个不触发的异步任务，是同一个调度器。

检索不碰主线程所以没事；但凡需要主线程的动作（执行命令、广播、踢人）都中招。

## 修法：绕过 Bukkit 调度器，直接用底层 MinecraftServer

NeoForge 的 `MinecraftServer` 本身就实现了 `Executor` 接口——它的 `execute(Runnable)` 会把任务排进**主线程的任务队列**，下一 tick 执行。这是 Forge/NeoForge 世界里「在主线程跑代码」的标准做法，比 Bukkit 调度器底层、可靠得多。

于是我的「跳主线程」改成：反射拿到底层 `MinecraftServer`，优先用它的 `execute()`，拿不到再回退 Bukkit 调度器。

```kotlin
// 优先 NMS/NeoForge 的 MinecraftServer（它本身是 Executor），回退 Bukkit 调度器
private fun mainExecutor(): Executor? = runCatching {
    val craftServer = Bukkit.getServer()
    craftServer.javaClass.getMethod("getServer").invoke(craftServer) as? Executor
}.getOrNull()
```

巧的是这招在原版 Paper 上也通用（CraftServer.getServer() 同样返回一个是 Executor 的 MinecraftServer）。一处修复，两边都稳。

## 一条经验，两个旁证

> 在混合服务端上，别把关键时序托付给 Bukkit 调度器；底层的 `MinecraftServer` 执行器更可靠。

而我能把这两个坑都挖出来，靠的是同一件事：**可观测性**。坑一是补了日志才看见 `pausing`；坑二是我给子服端的命令处理加了「收到中心指令 / 回复中心」的成对日志，三方（中心调用日志、子服收发日志、执行结果）能对上，才定位到「请求到了、但执行卡住」而不是「请求没到」。

混合端的兼容是「尽力而为」的——它实现了大部分 Bukkit API，但「大部分」意味着总有边角行为和原版不一样。遇到「在 Spigot 上好好的，在混合端就抽风」的事，先怀疑那些**跨线程、靠调度器、依赖 tick** 的地方。这类坑不会写在文档里，只能靠日志一行行逼出来。
