---
title: 命令的输出根本没回给我——一次在混合端抓 TPS 的曲折
date: 2026-06-14 22:00:00
tags: [Minecraft, 混合端, 反射, 踩坑]
categories: [踩坑]
---

我想在控制台上显示每个世界的分维度 TPS。NeoForge 自带 `/neoforge tps`，在服务器控制台敲一下，明明白白四行输出：主世界、下界、末地、整体。于是我写了段代码去「跑这个命令、抓它的输出」——然后**一个字都抓不到**。这篇是这趟曲折的复盘：我一开始抓错了地方，以及混合端上「够不到的数据」该怎么撬。

<!-- more -->

## 第一版：造个假 CommandSender 去接输出

Bukkit 跑命令是 `Bukkit.dispatchCommand(sender, cmd)`，命令的回执会发给那个 `sender`。所以我的思路很自然：**造一个假的 `CommandSender`，让它把收到的 `sendMessage` 文本攒起来**，然后派它去跑 `neoforge tps`。

`CommandSender` 接口方法一大堆，挨个实现太蠢，我用动态代理：

```kotlin
Proxy.newProxyInstance(..., arrayOf(CommandSender::class.java)) { _, method, args ->
    when (method.name) {
        "sendMessage" -> { 收集 args 里的文本; null }
        "hasPermission", "isOp" -> true   // 让 op 级命令跑得动
        ...
    }
}
```

逻辑通顺，编译通过，部署。实测——回执是空的。日志里我还特意打了「未捕获到 `/neoforge tps` 输出」。可我在控制台手敲同一条命令，四行 TPS 明明就在那儿。

## 真因：它的输出压根没走 sender，走的是日志

卡了一会儿才反应过来：**`/neoforge tps` 的输出是直接打到服务器 log4j 日志的，不是回给命令 sender 的。** 我那个假 sender 守在「sendMessage」这个门口，可人家根本不从这个门出去。我抓错了地方。

这其实是个很值得记的认知误区：**「命令的输出」和「命令发给 sender 的回执」不是一回事。** 很多命令（尤其是这种偏诊断、面向控制台的）是直接 `logger.info(...)` 往日志里写的，sender 那条路根本没数据。

## 第二版：那就去日志那头守着

输出既然进了 log4j，那我就**临时在 log4j 上挂一个采集器**：跑命令前挂上，跑完把这段时间打出来的日志收集起来，按内容过滤出含 TPS 的行，再把采集器摘掉。

不想编译期依赖 log4j-core（宿主运行时才有），所以全程反射 + 动态代理一个 `Appender` 挂到根 logger 上：

```kotlin
fun capture(windowMs: Long, trigger: () -> Unit): List<String> {
    val sink = Collections.synchronizedList(ArrayList<String>())
    val detach = attach(sink)        // 反射给 root logger 挂代理 Appender
    try { trigger(); Thread.sleep(windowMs) }   // 异步派发命令 + 开个短窗口
    finally { detach() }             // 摘掉，别污染人家日志系统
    return sink
}
```

跑 `neoforge tps`、开 600ms 窗口、抓含 "TPS" 的行——成了，四行分维度 TPS 拿到了。代价是这段时间会把别的日志也一起收进来，所以**靠内容过滤**，而不是假设这窗口里只有我要的。

## 配套的坑：整体 TPS，Youer 也不给

顺带一提，连「整体 TPS」我都踩了坑。`Bukkit.getServer().getTPS()` 是 Paper 的扩展，我的 Youer（NeoForge 混合端）没有，调用直接返回 -1——我那个主动巡检的哨兵因此**卡顿告警一直不触发**，等于瞎了一只眼。

修法是退到 NMS 反射，读 `MinecraftServer` 的平均 tick 耗时算 TPS：

```kotlin
// 先试 Bukkit getTPS()（Paper 有）；拿不到退 NMS
getAverageTickTimeNanos() / getAverageTickTime()  // 方法名按映射试
→ 回退字段 tickTimesNanos / tickTimes（long[] 求平均）
→ TPS = min(20, 1000 / mspt)
```

NeoForge 用官方映射，方法名能直接反射到，Youer 上一把就读出了真实的 20.0。

## 撬棍是反射，但每一处都要能降级

这趟下来我对混合端「够不到的 API」有了套固定打法：**反射 + 动态代理**几乎是万能撬棍——假 sender、假 Appender、读 NMS 私有字段，都是它。但混合端形态太杂（Youer、Mohist、Arclight、各版本……），**每一处反射都得 `runCatching` 兜底降级**，撬不动就退回一个合理的「未知 / -1 / 空」，绝不能让一个读不到的指标把整条功能搞崩。

还有个副产品：既然不同核心（NeoForge / Paper / Spigot）能力差这么多，我干脆加了「子服核心类型探测」——先认出它是什么，再决定挂哪些专属能力（比如只有 forge 系才挂「分维度 TPS / 模组清单」）。**先认环境，再上能力**，比到处 try-catch 优雅。

## 写在最后

这趟最大的收获不是那段 log4j 反射代码，是一句话：**「拿数据」之前，先搞清楚数据到底流到哪去了。** 我默认「命令输出会回 sender」，结果在一个完全合理的命令上栽了——它就是不走那条路。

调试卡住的时候，与其继续打磨「怎么更好地守在 sender 门口」，不如退一步问：**我守的这个门，数据真的从这儿过吗？** 很多时候，bug 不在你写的逻辑里，在你那个没说出口的假设里。
