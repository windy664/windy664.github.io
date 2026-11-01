---
title: 10 Designs I Borrowed from Hermes Agent — Practical AI Agent Enhancements
date: 2026-06-18 18:00:00
tags: [Agent, Architecture, Hermes, Open Source, Feature Design]
categories: [AI Applications]
---

NousResearch's [hermes-agent](https://github.com/NousResearch/hermes-agent) is a self-learning AI agent framework with 200+ model support, multi-platform gateways, a skill marketplace, FTS5 history search, and more. Our Minecraft server management agent already has the basics (tool calling, cross-server bus, knowledge base, safety guardrails), but it has clear weaknesses in context management, cost control, and observability.

This post covers what we learned from Hermes and how we adapted 10 of its designs into our own architecture.

<!-- more -->

## 1. Context Compression: Don't Just Truncate

Our original `trimHistory()` simply deleted the oldest messages. After 20+ turns of conversation, important early context (player names, operation results, agreements) was all gone.

Hermes uses **trajectory compression** — an LLM summarizes old messages into a single one.

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
                is LLMMessage.User -> "[User] ${m.content}"
                is LLMMessage.Assistant -> "[Assistant] ${m.content ?: ""}"
                is LLMMessage.ToolResults -> "[Tool results] ${m.results.size} entries"
            }
        }.joinToString("\n")

        val summary = llm.chat(SUMMARIZE_PROMPT,
            listOf(LLMMessage.User("Please compress the following conversation transcript:\n\n${transcript.take(6000)}"))
        ).textContent?.trim() ?: return history

        return mutableListOf(
            LLMMessage.User("[Summary of conversation so far]\n$summary"),
            *recentMessages.toTypedArray()
        )
    }
}
```

Key design decision: **the summary goes into a user message, not the system prompt**. This keeps the system prompt + tool definitions stable, so they can hit the LLM provider's prefix cache (saving tokens).

## 2. Tool Result Caching: Don't Call Twice

In multi-turn conversations, the LLM may repeatedly request the same query (checking the same player's balance over and over). Caching avoids the waste:

```kotlin
class ToolResultCache(maxSize: Int = 128, ttlMs: Long = 300_000) {
    private val cache = object : LinkedHashMap<String, Entry>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>?) =
            size > maxSize
    }
    fun get(toolName: String, inputJson: String): ToolResult? { /* LRU + TTL */ }
    fun put(toolName: String, inputJson: String, result: ToolResult) {
        if (result.isError) return  // Don't cache failures; allow retries
    }
}
```

We use SHA-256 for the key to avoid holding large JSON strings in memory.

## 3. Failure Pattern Detection: Don't Let the Agent Spin in a Loop

Agent calling the same tool 3 times with identical arguments = loop. 4 consecutive failures = repeated failure. 15+ cumulative calls to a single tool = out of control.

```kotlin
class FailureDetector {
    fun record(toolName: String, inputJson: String, result: ToolResult): Verdict {
        // Check 1: consecutive identical calls
        // Check 2: consecutive failures
        // Check 3: cumulative per-tool call limit
    }
    enum class Verdict { OK, LOOP, REPEATED_FAILURE, TOO_MANY_CALLS }
}
```

## 4. Cost-Aware Routing: Don't Use an Expensive Model for Simple Questions

Hermes uses Nous Portal for model routing. Our approach is simpler — a CostRouter decorator at the LLMProvider layer:

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

Complexity scoring: message length + multi-step signals + numbered steps + tool count + code keywords. Chit-chat and simple queries go to the cheap model; complex reasoning goes to the expensive one.

## 5. User Profiles: Remember Player Preferences

Hermes uses Honcho for dialectical user modeling. We went lighter — after each conversation, we asynchronously extract key information with an LLM:

```kotlin
data class UserProfile(
    val sessionId: String,
    var playstyle: String = "",       // gameplay preferences
    var communicationStyle: String = "", // communication style
    var frequentCommands: MutableMap<String, Int> = mutableMapOf(),
    var preferences: MutableMap<String, String> = mutableMapOf(),
    var recentTopics: MutableList<String> = mutableListOf()
)
```

On the next conversation, the profile is injected into the userMessage so the agent understands the user better.

## 6. FTS5 History Search

Long-term memory only stores "conclusions"; the conversation history stores the "raw text." SQLite FTS5 full-text search lets the agent find fragments of past conversations:

```kotlin
class SessionStore(dbPath: Path) {
    // CREATE VIRTUAL TABLE chat_fts USING fts5(content, content=chat_history, content_rowid=id)
    fun search(query: String, topK: Int, sessionId: String?): List<Triple<String, String, Long>>
}
```

When FTS5 is unavailable, it falls back to LIKE search.

## 7. Training Data Trajectories

Record the full trajectory of every agent interaction (input → tool calls → results → output), exportable in SFT fine-tuning format. This follows Hermes' `batch_runner` idea — use production data to train a better tool-calling model.

## 8. Self-Check

Before the agent replies, it automatically checks: is it leaking internal information (API keys, stack traces)? Is it hallucinating (referencing nonexistent tools or players)? Rule-based checks cost zero LLM calls; deeper checks use the cheap model.

## 9. Memory Consolidation

A long-term memory that only grows becomes bloated. Periodically use an LLM to merge semantically duplicate memories:

```kotlin
class MemoryConsolidator(memory: FileLongTermMemory, llm: LLMProvider) {
    fun consolidate(): Int {
        // Group by scope → find semantically duplicate pairs → merge with LLM → delete the old ones
    }
}
```

## 10. Prompt Versioning

The SystemPrompt is not hardcoded — it's stored in a file with version history. Changing a prompt doesn't require a restart, and old versions can be rolled back.

## What We Didn't Copy

- **Multi-platform gateways** (Telegram/Discord/QQ): not needed for the MC scenario
- **Containerized isolated execution**: the MC server is itself a process
- **Community skill marketplace**: the MC ecosystem is small, not needed

## Lessons

Copy designs, not code. Hermes is a Python project; we're on Kotlin. Hermes is a general-purpose agent; ours is MC-specific. Every feature had to be redesigned to fit our architecture — the decorator pattern wrapping LLMProvider, optional injection, async updates, and backward compatibility.
