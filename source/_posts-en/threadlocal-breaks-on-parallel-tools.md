---
title: I Bet ThreadLocal Would Be Enough — Then Parallel Tool Calls Blew It Up
date: 2026-07-06 21:30:00
tags: [Agent, Concurrency, ThreadLocal, Security, Kotlin]
categories: [AI Applications]
---

In [Putting Guardrails on an Agent That Can Act](/2026/06/13/guardrails-for-acting-agent/), I wrote about how to pass the "trigger's trust level" from the Agent's entry point down to the deeply buried command-execution tools. Back then I used a `ThreadLocal`, and I rather smugly wrote:

> A single Agent run executes synchronously on one thread. At the entry point, stuff the trust level into a ThreadLocal, read it inside the tools, clear it when the run ends. It reaches the deep layers without polluting the interfaces.

That sentence hid a premise — **single-threaded synchronous execution**. Later, to cut latency, I switched tool calls to run in parallel. The premise was gone, and the ThreadLocal silently stopped working — in the hardest way to debug.

<!-- more -->

## The problem ThreadLocal solved back then

Quick recap. The trust level is known at the Agent's entry point (who triggered it: super admin? console? regular player?), but the tools that actually execute commands like `/kick` and `/op` live deep inside the ReAct loop. I didn't want to add a parameter to the `AgentTool` interface and thread it all the way down, so I used a request-scoped ThreadLocal:

```kotlin
object RequestContext {
    private val trust = ThreadLocal<TrustLevel>()
    fun enter(level: TrustLevel, ...) { trust.set(level) }
    fun clear() { trust.remove() }
    // Default UNTRUSTED (most conservative): unset also won't let high-risk commands through
    fun current(): TrustLevel = trust.get() ?: TrustLevel.UNTRUSTED
}
```

Note that `?: UNTRUSTED` default. It's the "safe side" default — if you can't read a value, treat the caller as least trustworthy; better to block wrongly than to allow wrongly. Remember this, because it determines what the bug later looked like.

## Parallel tool execution destroyed the premise

To shorten the total wait for multiple tool calls in a single turn, I threw them into a thread pool to run concurrently:

```kotlin
private val toolPool = Executors.newCachedThreadPool { r ->
    Thread(r, "windyagent-tool").apply { isDaemon = true }
}
```

The problem appeared immediately: **a ThreadLocal is local to the "current thread" and does not automatically propagate to the pool's tool threads**. The tools ran on `windyagent-tool` threads, where `trust.get()` couldn't see the value set on the entry thread, so execution fell into that `?: UNTRUSTED` default branch.

The concrete symptom: **a super admin asked the AI from the console to kick someone, and got blocked.** The highest-trust source there is, yet the tool thread treated it like a stranger player, and the high-risk operation was wrongly judged untrustworthy and refused.

## Why this bug is "safe but annoying" — and the hardest to track down

Pause here and look at both sides of that default value. Because the default is `UNTRUSTED`:

- It does **not** fail in the dangerous direction — it won't misjudge an untrustworthy source as trustworthy and then let a `stop` through. The security boundary held.
- But it **does** fail in the usability direction — misjudging a trustworthy source as untrustworthy and blocking legitimate operations. The feature broke.

The failure direction was the right one (better to block wrongly), but that's exactly what makes it so hard to find: **no exception, no error, no stack trace**. The tool "successfully" read a perfectly legal default value `UNTRUSTED`; everything ran normally, only the behavior was quietly wrong. ThreadLocal failure is always this kind of silent "read the default" failure — it never throws, and you can only work backwards from "huh, why did this operation get blocked?"

## The fix: snapshot the context explicitly and carry it across threads

If ThreadLocal can't propagate, stop expecting it to. Before dispatching, the main thread takes an **immutable value snapshot**; each tool thread `restore`s it on entry and `clear`s it when done:

```kotlin
data class Snapshot(val trust: TrustLevel, val session: String, val unattended: Boolean)
fun snapshot(): Snapshot = Snapshot(current(), sessionId(), unattended())
fun restore(s: Snapshot) { trust.set(s.trust); /* ... */ }
```

```kotlin
val ctxSnapshot = RequestContext.snapshot()          // snapshot on the main thread
val futures = calls.map { tc ->
    CompletableFuture.supplyAsync({
        RequestContext.restore(ctxSnapshot)          // restore this request's trust level on the tool thread
        try {
            tools.find { it.name == tc.name }?.execute(tc.id, tc.inputJson)
        } finally { RequestContext.clear() }         // the pool reuses threads — clearing is mandatory
    }, toolPool)
}
```

That `finally { clear() }` is not optional. Thread pools **reuse** threads — if you don't clear, the next request that lands on this thread will read the previous request's leftover trust level. That turns "wrongly blocked" into "cross-request authorization leak," which is a far more serious problem.

## Why not InheritableThreadLocal

Someone will say: isn't there `InheritableThreadLocal`, where child threads automatically inherit the parent's value? **In a thread pool it's even worse.** `InheritableThreadLocal` only copies the parent's value at the moment a **new thread is created**. Pool threads are reused and were created long ago — what they inherit is the stale value from whichever parent thread happened to create that pool thread the first time — possibly someone else's trust level. You think you've got safety; what you've actually got is a ticking time bomb.

Explicit `snapshot`/`restore` is actually the only solid approach here: the value is fixed at dispatch time, travels with the task, and doesn't depend on the thread's ancestry.

## Not the same thing as the "parallel-group ctx snapshot"

In [4 Rounds of Security Audits Uncovered 32 Issues](/2026/06/18/agent-security-audit-32-issues/), I mentioned another parallel bug: the `ctx: MutableMap` shared across ReAct steps was being read and written concurrently by multiple threads, and the fix was a per-thread `HashMap(ctx)` snapshot. That one was a **concurrent writes to shared mutable state** problem. This one is a **ThreadLocal doesn't propagate across threads** problem. Both are cases of "parallelism broke an implicit assumption," but one is a data race and the other is context loss — don't conflate them.

## Lessons

Any implicit context that depends on the "execution model" — ThreadLocal, the current thread, the call stack — silently breaks the moment you change execution from "synchronous single-threaded" to "parallel/async". And ThreadLocal failure is especially insidious: it reads a default value without any error, the hardest kind of failure to trace back.

The conclusion is simple: **if a piece of context might ever need to cross threads, make it an explicit value object that travels with the task, instead of nailing it to a thread.** My line "single-threaded synchronous execution, good enough" was a bet that the execution model would never change. The execution model is the last thing you should ever bet on.
