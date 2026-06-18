---
title: 给 AI Agent 做了 4 轮安全审计，挖出 32 个问题
date: 2026-06-18 16:00:00
tags: [Agent, 安全, 审计, 性能, Kotlin]
categories: [AI 应用]
---

一个 MC 服务器管理 AI Agent，142 个 Kotlin 源文件，涉及 HTTP 服务、TCP 总线、Groovy 脚本执行、SQLite 存储、LLM 调用。上线前做了 4 轮系统性安全审计，逐轮深入，共发现并修复 32 个问题。

这篇文章按严重程度分类讲每个问题的发现过程和修复方案。

<!-- more -->

## 第一轮：基础设施层（17 个）

### CRITICAL：请求体无大小限制 → OOM

```kotlin
// DashboardServer.kt
private fun body(ex: HttpExchange): String =
    ex.requestBody.use { it.readBytes().toString(StandardCharsets.UTF_8) }
```

攻击者 POST 几 GB 数据就能撑爆内存。修复：加 512KB 上限。

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

### CRITICAL：手写 JSON 转义不完整

```kotlin
private fun jstr(s: String): String =
    "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"")
        .replace("\n", " ").replace("\r", " ") + "\""
```

漏了 `\t`、控制字符、Unicode。含 tab 的错误消息会生成非法 JSON。修复：直接用 Jackson。

```kotlin
private fun jstr(s: String): String = mapper.writeValueAsString(s)
```

### HIGH：Socket 总线密钥明文传输

子服注册时 `secret` 在裸 TCP 上发送，网络嗅探即可获取。这是架构层面的问题，代码层面只能加 TODO 注释提醒部署时用 TLS。

### HIGH：SQLite heatmap 全表扫描

```sql
SELECT join_ts FROM sessions  -- 无 WHERE，全表扫描
```

数据量大后查询极慢。修复：加 `WHERE join_ts > 30天前`。

### HIGH：sessions 表只增不减

events 表有 `pruneEvents()` 清理过期数据，但 sessions 表没有。修复：pruneEvents 同时清理 sessions。

### MEDIUM：命令选择器正则误判

```kotlin
private val DANGEROUS_SELECTOR = Regex("@[aer]\\b")
```

`@everyone` 的 `@e` 会被匹配。修复：`@[aer](?:\s|$)` 要求后跟空格或行尾。

## 第二轮：并发与资源（7 个）

### HIGH：SessionManager 线程不安全

`computeIfAbsent { mutableListOf() }` 返回普通 ArrayList，多线程并发修改会 ConcurrentModificationException。修复：`Collections.synchronizedList` + LRU 淘汰。

### HIGH：LLM Provider 响应体无大小限制

3 个 Provider（OpenAI / Ollama / Claude Embedding）都用 `resp.body!!.string()` 读响应。恶意 LLM 服务端可发几 GB 数据。修复：`resp.body?.bytes()` + 8MB 检查。

### MEDIUM：KeywordKnowledgeStore 每次搜索重复 lowercase

```kotlin
private fun score(e: KnowledgeEntry, terms: List<String>): Int {
    val title = e.title.lowercase()   // 每次搜索都 lowercase
    val tags = e.tags.joinToString(" ").lowercase()
    val content = e.content.lowercase()
```

大知识库搜索 O(n) 冗余分配。修复：构建时预计算 `Prepared(titleLc, tagsLc, contentLc)`。

## 第三轮：工作流引擎（5 个）

### HIGH：Groovy 脚本无 ThreadInterrupt → 死循环卡死

SkillEngine 有 ThreadInterrupt AST，但 WorkflowEngine 的 `evalExpression` 和 `dispatchScript` 没有。`while(true){}` 永久阻塞。

```kotlin
// 修复：加 compilerConfig
private val compilerConfig = CompilerConfiguration().apply {
    addCompilationCustomizers(ASTTransformationCustomizer(ThreadInterrupt::class.java))
}
```

### HIGH：并行组 ctx 共享无同步

并行步骤共享同一个 `ctx: MutableMap`（LinkedHashMap），多线程并发读写。修复：每线程 `HashMap(ctx)` 快照副本。

### MEDIUM：工作流递归无深度限制

工作流调技能，技能又是工作流，无限递归 → StackOverflow。修复：`MAX_RECURSE_DEPTH = 5`。

## 第四轮：LLM Provider（3 个）

3 个 Provider 的 `body!!.string()` 都有 NPE 风险 + 无大小限制。统一修复为 `resp.body?.bytes()` + 8MB 检查。

## 总结

| 严重程度 | 数量 | 典型问题 |
|---------|------|---------|
| CRITICAL | 2 | OOM、JSON 注入 |
| HIGH | 14 | 线程安全、密钥泄露、死循环、全表扫描 |
| MEDIUM | 12 | 正则误判、冗余计算、缺索引 |
| LOW | 4 | 无 CORS、无心跳、persist 过频 |

**教训**：安全审计要分层做——先扫基础设施（HTTP/TCP/SQL），再扫并发，再扫业务逻辑，最后扫 LLM 交互。每层的问题模式不同，混在一起容易漏。
