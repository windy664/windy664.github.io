---
title: 4 Rounds of Security Audits on an AI Agent Uncovered 32 Issues
date: 2026-06-18 16:00:00
tags: [Agent, Security, Audit, Performance, Kotlin]
categories: [AI Applications]
---

An AI agent for managing an MC server: 142 Kotlin source files covering an HTTP service, a TCP bus, Groovy script execution, SQLite storage, and LLM calls. Before going live, I ran 4 rounds of systematic security audits, going deeper each round, and found and fixed 32 issues in total.

This article walks through how each issue was found and fixed, grouped by severity.

<!-- more -->

## Round 1: Infrastructure Layer (17 issues)

### CRITICAL: No Request Body Size Limit → OOM

```kotlin
// DashboardServer.kt
private fun body(ex: HttpExchange): String =
    ex.requestBody.use { it.readBytes().toString(StandardCharsets.UTF_8) }
```

An attacker could POST a few GB of data and blow up memory. Fix: add a 512KB cap.

```kotlin
private fun body(ex: HttpExchange): String {
    val max = 512 * 1024
    return ex.requestBody.use { stream ->
        val buf = ByteArray(max + 1); var total = 0
        while (total < buf.size) {
            val n = stream.read(buf, total, buf.size - total)
            if (n < 0) break; total += n
        }
        if (total > max) throw IllegalArgumentException("Request body too large")
        String(buf, 0, total, StandardCharsets.UTF_8)
    }
}
```

### CRITICAL: Incomplete Hand-Rolled JSON Escaping

```kotlin
private fun jstr(s: String): String =
    "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"")
        .replace("\n", " ").replace("\r", " ") + "\""
```

It missed `\t`, control characters, and Unicode. An error message containing a tab would produce invalid JSON. Fix: just use Jackson.

```kotlin
private fun jstr(s: String): String = mapper.writeValueAsString(s)
```

### HIGH: Socket Bus Secret Sent in Plaintext

When a sub-server registers, the `secret` is sent over raw TCP, so anyone sniffing the network can grab it. This is an architecture-level problem; at the code level I could only add a TODO comment reminding myself to use TLS in deployment.

### HIGH: SQLite Heatmap Full Table Scan

```sql
SELECT join_ts FROM sessions  -- no WHERE, full table scan
```

Once the data grows, this query becomes extremely slow. Fix: add `WHERE join_ts > 30 days ago`.

### HIGH: sessions Table Only Ever Grows

The events table has `pruneEvents()` to clean up expired data, but the sessions table doesn't. Fix: have pruneEvents clean up sessions as well.

### MEDIUM: Command Selector Regex False Positive

```kotlin
private val DANGEROUS_SELECTOR = Regex("@[aer]\\b")
```

The `@e` in `@everyone` gets matched. Fix: `@[aer](?:\s|$)` requires a following space or end of line.

## Round 2: Concurrency and Resources (7 issues)

### HIGH: SessionManager Is Not Thread-Safe

`computeIfAbsent { mutableListOf() }` returns a plain ArrayList, and concurrent modification from multiple threads throws ConcurrentModificationException. Fix: `Collections.synchronizedList` + LRU eviction.

### HIGH: No Size Limit on LLM Provider Response Bodies

All 3 Providers (OpenAI / Ollama / Claude Embedding) read responses with `resp.body!!.string()`. A malicious LLM server could send several GB of data. Fix: `resp.body?.bytes()` + an 8MB check.

### MEDIUM: KeywordKnowledgeStore Re-Lowercases on Every Search

```kotlin
private fun score(e: KnowledgeEntry, terms: List<String>): Int {
    val title = e.title.lowercase()   // lowercased on every search
    val tags = e.tags.joinToString(" ").lowercase()
    val content = e.content.lowercase()
```

Searching a large knowledge base does O(n) redundant allocations. Fix: precompute `Prepared(titleLc, tagsLc, contentLc)` at build time.

## Round 3: Workflow Engine (5 issues)

### HIGH: No ThreadInterrupt in Groovy Scripts → Infinite Loop Freezes Everything

SkillEngine has a ThreadInterrupt AST transform, but WorkflowEngine's `evalExpression` and `dispatchScript` don't. `while(true){}` blocks forever.

```kotlin
// Fix: add compilerConfig
private val compilerConfig = CompilerConfiguration().apply {
    addCompilationCustomizers(ASTTransformationCustomizer(ThreadInterrupt::class.java))
}
```

### HIGH: Parallel Groups Share ctx Without Synchronization

Parallel steps share the same `ctx: MutableMap` (a LinkedHashMap), read and written concurrently from multiple threads. Fix: give each thread a snapshot copy with `HashMap(ctx)`.

### MEDIUM: No Depth Limit on Workflow Recursion

A workflow calls a skill, and that skill is itself a workflow — infinite recursion → StackOverflow. Fix: `MAX_RECURSE_DEPTH = 5`.

## Round 4: LLM Providers (3 issues)

All 3 Providers' `body!!.string()` had both an NPE risk and no size limit. Fixed uniformly to `resp.body?.bytes()` + an 8MB check.

## Summary

| Severity | Count | Typical Issues |
|---------|------|---------|
| CRITICAL | 2 | OOM, JSON injection |
| HIGH | 14 | Thread safety, secret leakage, infinite loops, full table scans |
| MEDIUM | 12 | Regex false positives, redundant computation, missing indexes |
| LOW | 4 | No CORS, no heartbeat, persist too frequent |

**Lesson learned**: security audits should be done layer by layer — first sweep the infrastructure (HTTP/TCP/SQL), then concurrency, then business logic, and finally LLM interactions. Each layer has its own problem patterns; mixing them together makes things easy to miss.
