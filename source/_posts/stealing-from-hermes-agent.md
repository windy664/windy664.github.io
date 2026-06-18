---
title: 从 Hermes Agent 偷了 10 个设计——AI Agent 功能增强实战
date: 2026-06-18 18:00:00
tags: [Agent, 架构, Hermes, 开源, 功能设计]
categories: [AI 应用]
---

NousResearch 的 [hermes-agent](https://github.com/NousResearch/hermes-agent) 是一个自学习 AI Agent 框架，有 200+ 模型支持、多平台网关、技能市场、FTS5 历史搜索等特性。我们的 MC 服务器管理 Agent 已经有基础能力（工具调用、跨服总线、知识库、安全护栏），但在上下文管理、成本控制、可观测性上有明显短板。

这篇文章讲我们从 Hermes 学到了什么，怎么把 10 个设计搬过来适配到自己的架构里。

<!-- more -->

## 1. 上下文压缩：别直接截断

我们原来的 `trimHistory()` 直接删最旧的消息。对话超过 20 轮后，早期的重要上下文（玩家名、操作结果、约定）全丢了。

Hermes 的做法是 **trajectory compression**——用 LLM 把旧消息摘要成一条。

```kotlin
class ContextCompressor(
    private val llm: LLMProvider,
    private val threshold: Int = 16,
    private val keepRecent: Int = 6
) {
    fun compress(history: MutableList<LLMMessage>): MutableList<LLMMessage> {
        if (history.size <= threshold) return history
        val splitPoint = (history.size - keepRecent).coerceAtLeast(1)
        val oldMessages = history.subList(0, splitPoint)
        val recentMessages = history.subList(splitPoint, history.size)

        val transcript = oldMessages.mapNotNull { m ->
            when (m) {
                is LLMMessage.User -> "[用户] ${m.content}"
                is LLMMessage.Assistant -> "[助手] ${m.content ?: ""}"
                is LLMMessage.ToolResults -> "[工具结果] ${m.results.size} 条"
            }
        }.joinToString("\n")

        val summary = llm.chat(SUMMARIZE_PROMPT,
            listOf(LLMMessage.User("请压缩以下对话记录：\n\n${transcript.take(6000)}"))
        ).textContent?.trim() ?: return history

        return mutableListOf(
            LLMMessage.User("[至此的对话摘要]\n$summary"),
            *recentMessages.toTypedArray()
        )
    }
}
```

关键设计：**摘要放在 user 消息里而非 system prompt**。这样 system prompt + 工具定义保持稳定，可被 LLM provider 的前缀缓存命中（省 token）。

## 2. 工具结果缓存：别重复调

LLM 在多轮对话中可能重复请求同一个查询（连续查同一玩家余额）。缓存避免浪费：

```kotlin
class ToolResultCache(maxSize: Int = 128, ttlMs: Long = 300_000) {
    private val cache = object : LinkedHashMap<String, Entry>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>?) =
            size > maxSize
    }
    fun get(toolName: String, inputJson: String): ToolResult? { /* LRU + TTL */ }
    fun put(toolName: String, inputJson: String, result: ToolResult) {
        if (result.isError) return  // 失败不缓存，允许重试
    }
}
```

用 SHA-256 做 key，避免大 JSON 字符串占用内存。

## 3. 失败模式检测：别让 Agent 死循环

Agent 调同一个工具 3 次相同参数 = 循环。连续 4 次失败 = 反复失败。单工具累计 15+ 次 = 失控。

```kotlin
class FailureDetector {
    fun record(toolName: String, inputJson: String, result: ToolResult): Verdict {
        // 检测 1：连续相同调用
        // 检测 2：连续失败
        // 检测 3：单工具累计超限
    }
    enum class Verdict { OK, LOOP, REPEATED_FAILURE, TOO_MANY_CALLS }
}
```

## 4. 成本感知路由：简单问题别用贵模型

Hermes 用 Nous Portal 做模型路由。我们的做法更简单——在 LLMProvider 层加一个 CostRouter 装饰器：

```kotlin
class CostRouter(
    private val expensive: LLMProvider,
    private val cheap: LLMProvider
) : LLMProvider {
    override fun chat(systemPrompt: String, messages: List<LLMMessage>, tools: List<AgentTool>): LLMResponse {
        val score = complexityScore(lastUserMessage, tools.size)
        val chosen = if (score >= COMPLEX_THRESHOLD) expensive else cheap
        return chosen.chat(systemPrompt, messages, tools)
    }
}
```

复杂度评分：长度 + 多步信号 + 编号步骤 + 工具数量 + 代码关键词。闲聊/简单查询走便宜模型，复杂推理走贵模型。

## 5. 用户画像：记住玩家偏好

Hermes 用 Honcho 做辩证式用户建模。我们用更轻量的方案——每次对话后异步用 LLM 提取关键信息：

```kotlin
data class UserProfile(
    val sessionId: String,
    var playstyle: String = "",       // 玩法偏好
    var communicationStyle: String = "", // 沟通风格
    var frequentCommands: MutableMap<String, Int> = mutableMapOf(),
    var preferences: MutableMap<String, String> = mutableMapOf(),
    var recentTopics: MutableList<String> = mutableListOf()
)
```

下次对话时画像拼入 userMessage，让 Agent 更懂用户。

## 6. FTS5 历史搜索

长期记忆只记"结论"，历史对话记"原文"。SQLite FTS5 全文检索让 Agent 能搜到过去的对话片段：

```kotlin
class SessionStore(dbPath: Path) {
    // CREATE VIRTUAL TABLE chat_fts USING fts5(content, content=chat_history, content_rowid=id)
    fun search(query: String, topK: Int, sessionId: String?): List<Triple<String, String, Long>>
}
```

FTS5 不可用时降级为 LIKE 搜索。

## 7. 训练数据轨迹

记录每次 Agent 交互的完整轨迹（输入→工具调用→结果→输出），可导出为 SFT 微调格式。这是 Hermes 的 `batch_runner` 思路——用生产数据训练更好的工具调用模型。

## 8. 自我检查

Agent 回复前自动检查：是否泄露内部信息（API key、堆栈）、是否有幻觉（引用不存在的工具/玩家）。规则检查零 LLM 成本，深度检查用便宜模型。

## 9. 记忆整合

长期记忆只增不删会越来越臃肿。定期用 LLM 合并语义重复的记忆：

```kotlin
class MemoryConsolidator(memory: FileLongTermMemory, llm: LLMProvider) {
    fun consolidate(): Int {
        // 按 scope 分组 → 找语义重复对 → LLM 合并 → 删除旧的
    }
}
```

## 10. Prompt 版本化

SystemPrompt 不硬编码，存文件，支持版本历史。改 prompt 不用重启，旧版本可回滚。

## 没抄的

- **多平台网关**（Telegram/Discord/QQ）：MC 场景不需要
- **容器隔离执行**：MC 服务器本身就是进程
- **社区技能市场**：MC 生态小，不需要

## 教训

抄设计不抄代码。Hermes 是 Python 项目，我们是 Kotlin；Hermes 是通用 Agent，我们是 MC 专属。每个功能都要重新设计适配自己的架构——装饰器模式包装 LLMProvider、可选注入、异步更新、向后兼容。
