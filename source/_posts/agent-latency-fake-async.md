---
title: 一句「你好」要等三次 LLM——我从 Hermes 偷来的功能，反手把 Agent 拖慢了
date: 2026-06-21 17:30:00
tags: [Agent, 性能优化, 架构反思, 工程反思]
categories: [AI 应用]
---

三天前我写了篇[《从 Hermes Agent 偷了 10 个设计》](/2026/06/18/stealing-from-hermes-agent/)，把上下文压缩、用户画像、子任务并行、成本路由一股脑搬进了自己的 MC 服务器管理 Agent。当时挺得意。

今天我发现，自从那次「增强」之后，**在控制台发一句「你好」要卡好几秒才回**。

这篇讲我怎么把锅找出来的——结论有点打脸：让 Agent「更聪明」的那几个组件，全都悄悄记在了**回复延迟**这本账上，而其中最致命的一个，注释里明明白白写着「异步」。

<!-- more -->

## 症状：最简单的请求，最慢的响应

「你好」是整个系统里最该秒回的输入：没有工具调用、没有多步推理，便宜模型一次往返就该出结果。可它偏偏是最慢的之一。

第一反应是模型慢或者网络抖。但同一个模型、同样的网络，直接打一次 `chat("你好")` 是很快的。慢的是**我那一层 Agent 编排**。于是我去读 `AgentRouter.run()` 的每一步，按「这一步会不会打 LLM」逐行过。

一条消息进来，Router 依次做这些事：

1. 召回长期记忆 —— 纯关键词检索，内存里跑，**不打 LLM**，无辜。
2. 召回用户画像 —— 读个 JSON，**不打 LLM**，无辜。
3. 上下文压缩 —— 只有历史超阈值才摘要，新会话不触发，无辜。
4. 工具集选择 —— 启发式，无辜。
5. **子任务并行编排**（TRUSTED 才走）—— ⚠️ 这里打 LLM。
6. 选 Agent、跑 ReAct 工具循环 —— 真正生成回复，该打的一次。
7. **更新用户画像** —— ⚠️ 这里又打 LLM。

第 6 步是必须的。问题出在 5 和 7。

## 元凶一：注释写着「异步」，代码是同步阻塞

先看第 7 步。原代码长这样：

```kotlin
// 8. 异步更新用户画像
profileManager?.let { pm ->
    val reply = response.message.take(500)
    val fast = fastLlm ?: llmProvider
    runCatching { pm.updateFromConversation(context.sessionId, context.userMessage, reply, fast) }
}
return response
```

注释写着「异步更新用户画像」。我当时大概也是真心想让它异步的。但 `runCatching { ... }` **根本不是异步**——它只是把异常吞掉，整段代码就在当前线程里老老实实跑完，才轮到 `return response`。

而 `updateFromConversation` 里面是什么？

```kotlin
fun updateFromConversation(sessionId: String, userMessage: String, assistantReply: String, llm: LLMProvider) {
    // ...拼一个「从对话里抽取用户特征」的 prompt...
    val resp = llm.chat("你是用户画像提取器，只输出 JSON。", listOf(LLMMessage.User(updatePrompt)))
    // ...解析 JSON 合并进画像...
}
```

一次**完整的 LLM 往返**。

也就是说：回复早就在第 6 步生成好了，用户却看不到——因为程序卡在第 7 步，正等着另一个 LLM 把这轮对话「抽成画像」。**画像更新的延迟，被算进了用户等待回复的时间里。** 凡是开了画像功能，每一条消息都白等这一次。

`runCatching` 给人的错觉很危险：它读起来像是「我已经把这事兜住了、不用管了」，但它兜的是**异常**，不是**线程**。包在里面的同步阻塞调用，一秒都不会少等。

## 元凶二：给「你好」也跑了一次任务拆分

再看第 5 步。子任务编排器的本意是：复杂请求先用 LLM 拆成几个子任务并行跑。逻辑是这样的：

```kotlin
if (sa != null && context.trust == TrustLevel.TRUSTED) {
    val subTasks = runCatching { sa.plan(context.userMessage) }.getOrNull()
    if (subTasks != null && subTasks.size >= 2) {
        // ...并行执行...
    }
}
```

`sa.plan()` 也是一次 LLM 调用。而它的触发条件只有「是不是受信任用户」——**完全没看请求本身复不复杂**。

讽刺的是，这个 Router 里早就有一套**廉价的启发式**（`heuristic()`），能瞬间把「你好」判成 `SIMPLE`，连模型都不用碰。可 `plan()` 偏偏跑在它**前面**。结果就是：一个管理员发「你好」，先被拉去做一次「任务拆分」，拆完发现只有一个子任务、不并行，才落回正常流程。

## 账算出来：一句「你好」= 三次串行 LLM

把 TRUSTED 用户发「你好」的开销拼起来：

```
plan()         → 一次 LLM（白拆）
ReAct 回复     → 一次 LLM（该打的）
画像更新       → 一次 LLM（本该后台，却同步阻塞）
```

三次**串行**往返，前后两次对「你好」这种输入毫无意义。普通用户没有 plan() 那一刀，也有两次。「等好久」就是这么来的。

## 修：让异步真异步，让廉价启发式当门卫

两刀，都不难。

**第一刀**，画像更新丢进后台线程池，并顺手加节流（同一会话 60 秒内最多更一次，做成 config 键）：

```kotlin
private val profilePool = Executors.newSingleThreadExecutor { r ->
    Thread(r, "windyagent-profile").apply { isDaemon = true }
}

private fun updateProfileAsync(sessionId: String, userMessage: String, reply: String) {
    val pm = profileManager ?: return
    // ...节流：距上次太近就 return...
    profilePool.execute {
        runCatching { pm.updateFromConversation(sessionId, userMessage, reply, fast) }
    }
}
```

现在 `return response` 不再等画像。`runCatching` 这次是真的只兜异常了——因为它被包在 `profilePool.execute {}` 里，跑在另一条线程上。

**第二刀**，让 `plan()` 先过启发式这道门，明显简单的请求直接跳过：

```kotlin
if (sa != null && context.trust == TrustLevel.TRUSTED
        && heuristic(context.userMessage) != Verdict.SIMPLE) {
    val subTasks = runCatching { sa.plan(context.userMessage) }.getOrNull()
    // ...
}
```

「你好」判 `SIMPLE`，连 `plan()` 的门都进不来。

修完，TRUSTED 用户的「你好」从三次串行 LLM 砍到一次；普通用户从两次砍到一次。画像和拆分能力一个没删，只是不再挡在回复前面。

## 我从这事上记住的三条

**一，「异步」是个动作，不是个注释。** 想让某段代码不阻塞主流程，得真的把它交给另一条线程/协程/队列。`runCatching`、`try/catch`、`.also{}` 这些读起来很「顺手处理掉了」的写法，一个都不会帮你换线程。下次再看到注释和代码语气不一致，先信代码。

**二，回复关键路径上的每一次 LLM 调用，都是要还的延迟债。** 加功能的时候，每个组件单独看都「不贵」「挺聪明」，但它们会一个个排到用户和回复之间。判断一个增强值不值得，不能只问「它能让 Agent 更强吗」，得问「它配在主路径上、对最简单的那条输入也要收费吗」。那些**为对话之外的目的**服务的工作（画像、记忆整合、日志分析），几乎都该挪到后台。

**三，便宜的启发式，要放在昂贵的元调用前面当门卫。** 我这套 Router 本来就有一层能秒判简单/复杂的廉价逻辑，结果最贵的 `plan()` 反而跑在它前头。顺序错了，再好的快速路径也白搭。先用零成本的规则把绝大多数简单请求筛掉，剩下拿不准的再交给模型——这跟我之前写[启发式优先、LLM 兜底](/2026/06/18/stealing-from-hermes-agent/)的取向是一致的，只是这次我自己把顺序摆反了。

偷设计是好事，Hermes 那几个组件本身都没问题。出问题的是我把它们**接线的位置**——好东西接错了地方，一样能把体验拖垮。
