---
title: 我赌 ThreadLocal 够用——然后并行工具调用把它掀了
date: 2026-07-06 21:30:00
tags: [Agent, 并发, ThreadLocal, 安全, Kotlin]
categories: [AI 应用]
---

在 [给会动手的 Agent 上护栏](/2026/06/13/guardrails-for-acting-agent/) 那篇里，我讲过怎么把「触发者的信任级别」从 Agent 入口传到深层的命令执行工具。当时我用了一个 `ThreadLocal`，还很得意地写了一句：

> Agent 单次运行在单线程内同步执行，入口处把信任级别塞进 ThreadLocal，工具内读取，运行结束清掉。既传到了深处，又没污染接口。

这句话里藏着一个前提——**单线程同步执行**。后来我为了降延迟，把工具调用改成了并行。前提没了，这个 ThreadLocal 就静默地失效了，而且失效的方式最难查。

<!-- more -->

## ThreadLocal 当时解决的问题

先回顾。信任级别在 Agent 入口就知道了（谁触发的：超管？控制台？普通玩家？），但真正执行 `/kick`、`/op` 这类命令的工具藏在 ReAct 循环深处。我不想给 `AgentTool` 接口加参数把它一路穿下去，于是用请求级 ThreadLocal：

```kotlin
object RequestContext {
    private val trust = ThreadLocal<TrustLevel>()
    fun enter(level: TrustLevel, ...) { trust.set(level) }
    fun clear() { trust.remove() }
    // 默认 UNTRUSTED（最保守）：未设置时也不会误放高危命令
    fun current(): TrustLevel = trust.get() ?: TrustLevel.UNTRUSTED
}
```

注意那个 `?: UNTRUSTED` 默认值。它是「安全侧」的默认——读不到就当最不可信处理，宁可拦错也不放错。记住这个，它决定了后面 bug 长什么样。

## 并行工具执行掀翻了前提

为了缩短一轮里多个工具调用的总等待，我把它们丢进线程池并发跑：

```kotlin
private val toolPool = Executors.newCachedThreadPool { r ->
    Thread(r, "windyagent-tool").apply { isDaemon = true }
}
```

问题立刻来了：**ThreadLocal 是「当前线程」的本地存储，它不会自动传到线程池里的工具线程**。工具在 `windyagent-tool` 线程上执行，`trust.get()` 读不到入口线程 set 的值，于是走进那个 `?: UNTRUSTED` 默认分支。

后果具体到症状就是：**超管在控制台让 AI 帮忙踢个人，被拦了。** 明明是最高信任的来源，工具线程却把它当成陌生玩家，高危操作被误判为不可信而拒绝。

## 为什么这个 bug「安全但恼人」，而且最难查

这里要停一下看那个默认值的两面性。因为默认是 `UNTRUSTED`：

- 它**不会**朝危险方向失效——不会把一个不可信来源误判成可信、然后放行 `stop`。安全边界没破。
- 但它**会**朝可用方向失效——把可信来源误判成不可信、拦掉合法操作。功能坏了。

方向是对的（宁可拦错），可这也正是它难查的原因：**没有异常、没有报错、没有栈**。工具「成功地」读到了一个合法的默认值 `UNTRUSTED`，一切照常运行，只是行为悄悄错了。ThreadLocal 失效永远是这种「读到默认值」的静默失效，不是抛错，你只能靠「诶这个操作怎么被拦了」反推。

## 修法：把上下文显式快照，跨线程搬过去

ThreadLocal 传不过去，那就别指望它自动传。主线程派发前取一个**不可变值快照**，每个工具线程进来先 `restore`，用完 `clear`：

```kotlin
data class Snapshot(val trust: TrustLevel, val session: String, val unattended: Boolean)
fun snapshot(): Snapshot = Snapshot(current(), sessionId(), unattended())
fun restore(s: Snapshot) { trust.set(s.trust); /* ... */ }
```

```kotlin
val ctxSnapshot = RequestContext.snapshot()          // 主线程取快照
val futures = calls.map { tc ->
    CompletableFuture.supplyAsync({
        RequestContext.restore(ctxSnapshot)          // 工具线程恢复本次请求的信任级别
        try {
            tools.find { it.name == tc.name }?.execute(tc.id, tc.inputJson)
        } finally { RequestContext.clear() }         // 线程池会复用线程，必须清
    }, toolPool)
}
```

那个 `finally { clear() }` 不是可选的。线程池**复用**线程——如果不清，下一个请求复用到这根线程时会读到上一个请求残留的信任级别，那就从「误拦」变成「串号放行」，性质严重得多。

## 为什么不用 InheritableThreadLocal

有人会说：不是有 `InheritableThreadLocal` 吗，子线程自动继承父线程的值。**在线程池里它更坏。** `InheritableThreadLocal` 只在**创建新线程**那一刻从父线程拷一次值。线程池的线程是复用的、早就创建好了，它继承的是「池子第一次造这根线程时」那个父线程的陈旧值——可能是别人的信任级别。你以为拿到了安全，其实拿到了一颗定时炸弹。

显式 `snapshot`/`restore` 反而是这里唯一稳的做法：值在派发的那一刻确定，跟着任务走，不依赖线程的身世。

## 和「并行组 ctx 快照」不是一回事

我在 [4 轮安全审计挖出 32 个问题](/2026/06/18/agent-security-audit-32-issues/) 里提过另一个并行 bug：ReAct 步骤间共享的 `ctx: MutableMap` 被多线程并发读写，修法是每线程 `HashMap(ctx)` 快照。那个是**共享可变状态的并发写**问题。这篇是**ThreadLocal 不跨线程传播**问题。两者都是「并行破坏了某个隐式假设」，但一个是数据竞争、一个是上下文丢失，别混。

## 教训

任何依赖「执行模型」的隐式上下文——ThreadLocal、当前线程、调用栈——在你把执行从「同步单线程」改成「并行/异步」的那一刻，都会静默失效。而 ThreadLocal 的失效尤其阴——它读到的是默认值，不报错，是所有失效方式里最难反查的一种。

结论很简单：**只要一个上下文可能要跨线程，就把它显式化成一个值对象，跟着任务传，而不是钉在线程上。** 我那句「单线程同步执行，够用了」，赌的是执行模型永远不变。执行模型是最不该被赌的东西。
