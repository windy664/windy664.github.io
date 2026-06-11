---
title: 设计可替换的 LLM 抽象层——Anthropic 原生协议 vs OpenAI 兼容协议
date: 2026-06-11 21:40:00
tags: [LLM, Agent, 架构设计, 设计模式]
categories: [AI 应用]
---

做商业化 AI 产品时，「LLM 必须可替换」几乎是硬需求——因为你的用户不一定用得起 Claude。这篇讲怎么设计一个 Provider 抽象层，把 Anthropic 原生协议和 OpenAI 兼容协议藏在同一个接口后面。

<!-- more -->

## 为什么要做这层抽象

我的 Agent 面向 Minecraft 服主，定价敏感。如果代码里写死了 Claude，会出两个问题：

1. **成本**：很多服主用不起 Claude API，更想接国产模型（如小米 mimo）或本地 Ollama
2. **绑定**：模型迭代极快，硬绑一家等于把自己锁死

所以从第一天就定下：**LLM 层是策略，可在配置里切换**。配置长这样：

```yaml
llm:
  provider: openai          # claude | openai | ollama
  api-key: "xxx"
  api-base-url: "https://token-plan-cn.xiaomimimo.com/v1"
  model: "mimo-v2.5-pro"
```

## 接口设计：把「对话」抽象出来

核心是一个极简接口（Kotlin）：

```kotlin
interface LLMProvider {
    val name: String
    fun chat(
        systemPrompt: String,
        messages: List<LLMMessage>,
        tools: List<AgentTool>
    ): LLMResponse
}
```

关键在于 `LLMMessage` 和 `LLMResponse` 是**与具体厂商无关的内部表示**，用 sealed interface 描述：

```kotlin
sealed interface LLMMessage {
    data class User(val content: String) : LLMMessage
    data class Assistant(val content: String?, val toolCalls: List<ToolCall> = emptyList()) : LLMMessage
    data class ToolResults(val results: List<ToolResult>) : LLMMessage
}
```

每个 Provider 的职责，就是把这套中立结构**翻译成自己协议的请求**，再把响应**翻译回中立结构**。这就是典型的**适配器模式**——内部说「普通话」，各 Provider 负责跟自己的「方言」互转。

## 两种协议，差在哪

虽然都是「发消息、可能调工具、拿回复」，但 Anthropic 原生协议和 OpenAI 兼容协议在细节上处处不同：

| 维度 | Anthropic（`/v1/messages`） | OpenAI 兼容（`/v1/chat/completions`） |
|---|---|---|
| system prompt | 顶层独立字段 `system` | 塞进 `messages`，role=`system` |
| 助手回复结构 | `content` 是 block 数组（text / tool_use 混排） | `choices[0].message`，工具在 `tool_calls` |
| 工具定义 | `input_schema`（JSON Schema） | `function.parameters`（JSON Schema） |
| 触发工具的停止原因 | `stop_reason: "tool_use"` | `finish_reason: "tool_calls"` |
| 工具结果回传 | 一个 `tool_result` block，放在 **user** 消息里 | 一条独立消息，role=`tool` |
| 鉴权头 | `x-api-key` + `anthropic-version` | `Authorization: Bearer` |

举两个最容易踩的差异：

**① 工具结果的「身份」不同。** OpenAI 用一个独立的 `role: "tool"` 消息回传执行结果；而 Anthropic 没有 tool 角色，工具结果是包在 **user** 消息里的一个 `tool_result` block。翻译层必须感知这个差异。

**② 助手消息的结构不同。** Anthropic 的一条助手回复可以同时包含文字和多个工具调用（block 数组混排）；OpenAI 把文字放 `content`、工具放 `tool_calls` 两个并列字段。

正因如此，Claude 用官方 SDK（`anthropic-java`）接入，而 mimo / Ollama 这类 OpenAI 协议的，我用 OkHttp 手写一个 `OpenAICompatProvider` 统一处理——它们的协议长得几乎一样，连 Ollama 都暴露了 `/v1/chat/completions`。

## Provider 之上：ReAct 循环

有了统一接口，Agent 的主循环就跟具体模型彻底解耦了：

```kotlin
fun run(context: AgentContext): AgentResponse {
    val messages = context.history.toMutableList()
    messages += LLMMessage.User(context.userMessage)

    for (i in 0 until maxIterations) {
        val response = llmProvider.chat(systemPrompt, messages, tools)
        when (response.stopReason) {
            END_TURN -> return done(response.textContent)     // 模型说完了
            TOOL_USE -> {                                      // 模型要调工具
                messages += LLMMessage.Assistant(response.textContent, response.toolCalls)
                val results = response.toolCalls.map { execute(it) }
                messages += LLMMessage.ToolResults(results)    // 把结果塞回去，继续循环
            }
            else -> return failed(response.stopReason)
        }
    }
    return failed("max iterations reached")
}
```

这就是 **ReAct（Reason + Act）** 的骨架：模型推理 → 调工具 → 把工具结果喂回去 → 再推理，直到它给出最终答复或撞上迭代上限。注意这段代码里**完全没有任何厂商字样**——换模型只是换配置。

## 设计模式视角

- **策略模式**：`LLMProvider` 是策略接口，运行时按配置选具体实现
- **适配器模式**：每个 Provider 把中立的 `LLMMessage`/`LLMResponse` 适配到各自的协议
- **依赖倒置**：Agent 依赖抽象接口，不依赖任何具体 SDK；高层逻辑对模型一无所知

一个落地小细节：Kotlin 的 `when` 分支引用 `ClaudeProvider` 时，类是**惰性加载**的——只要用户配的是 openai，`anthropic-java` SDK 的类压根不会被加载。所以哪怕 SDK 较重，也不拖累只用国产模型的用户。

## 面试考点小结

- **可替换抽象层**：用接口隔离「能力」与「实现」，策略 + 适配器 + 依赖倒置三件套
- **协议差异要吃透**：system 位置、工具结果回传方式、stop/finish reason、消息结构，是 LLM 接入最容易踩的点
- **ReAct 循环**：推理-行动-观察的闭环，主循环应与模型无关
- **中立内部模型**：先设计与厂商无关的数据结构，再各自翻译，是多 Provider 架构的核心
- **惰性加载**：把重依赖隔离在具体实现里，按需触发，不影响不用它的路径
