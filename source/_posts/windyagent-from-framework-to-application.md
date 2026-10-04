---
title: 从造 Agent 框架到做 Minecraft Agent 应用：WindyAgent 的一次转向
date: 2026-10-04 23:00:00
tags: [WindyAgent, Agent, AgentScope, Minecraft, 架构复盘]
categories: [AI 应用]
---

过去几个月，我写了不少 WindyAgent 的文章：ReAct、Plan-Execute、跨服总线、工具安全闸、长期记忆、Skill、上下文压缩……每解决一个问题，就给自己的 Agent 补一个模块。代码确实越写越多，我却越来越不确定：**我到底在做 Minecraft 服务器运维应用，还是在维护一套通用 Agent 框架？**

最近做另一个项目 [Torine](https://github.com/windy664/Torine-hackathon-agent-ts) 时，这个问题变得很具体。Torine 用现成的 OpenCode 执行编码任务，我写的是任务适配、约束和验收。回头看 WindyAgent，我开始认真考虑：既然 Java 生态里已经有 Agent Harness，为什么还要从工具调用循环开始自己造？

<!-- more -->

## 功能越来越全，可靠性却没有同步增长

WindyAgent 最初的目标很清楚：让服主用自然语言查看服务器状态、处理玩家问题，在关键操作前得到审批。为了实现它，我逐步写了自己的 LLM Provider、ReAct 循环、计划执行、会话管理、失败检测、工具缓存、跨服能力发现和 Skill 引擎。[项目 README](https://github.com/windy664/WindyAgent) 现在列出的功能，已经很像一套 Agent 平台。

但「有这个模块」和「这个模块在真实并发、重复请求、重启恢复后仍然正确」是两回事。重新检查代码时，我发现一个足够说明问题的例子：工具缓存默认开启，按工具名和参数复用成功结果。这个策略把查询和有副作用的操作混在一起；缓存的 `ToolResult` 还保留了旧的 `toolCallId`，命中后原样回传，可能让新一轮的工具调用与结果 ID 对不上。类似问题不一定在演示时出现，却会在系统长期运行后变得难查。[工具循环](https://github.com/windy664/WindyAgent/blob/master/agent-runtime/src/main/kotlin/org/windy/windyagent/tools/AgentLoop.kt)

这不是改掉一个缓存 bug 就能结束的事。审批要能在等待时保存状态，恢复后不能重复执行；同一会话并发请求不能互相覆盖历史；一次工具调用超时，后台任务也得真正停止。每项都需要设计、测试和持续维护。我以前写过[「从 Hermes Agent 偷了 10 个设计」](https://windy664.github.io/2026/06/18/stealing-from-hermes-agent/)；现在意识到，把十个设计分别移植过来，也意味着我要负责它们组合起来之后的行为。

## Torine 给我的提醒：把精力放在应用的独特部分

Torine 没有重新实现一个编码 Agent。它把 [OpenCode](https://github.com/anomalyco/opencode) 当执行引擎，自己处理比赛任务的拆分、输入输出契约、检查和反馈。这种分工让我能直接围绕题目改应用逻辑，而不是先解决模型消息、工具协议和会话恢复。

Minecraft 运维也有自己的独特问题：Velocity 只看得到代理层，世界和物品数据在 Bukkit/Paper 子服；同一个「在线人数」可能来自不同节点；踢人、执行命令、修改世界都有不同的授权边界。**这些问题，通用 Harness 不会替我决定。** 我应该把时间花在工具的语义、跨服通信、权限映射和可验证的执行结果上。

## Java 框架怎么选

我目前最想验证的是 [AgentScope Java 2.0](https://github.com/agentscope-ai/agentscope-java)。它区分较小的 `ReActAgent` 与带工作区、会话持久化、上下文管理、权限和人工介入能力的 `HarnessAgent`。这与 WindyAgent 的需求比较贴近，官方也提供了[从 HarnessAgent 开始的示例](https://github.com/agentscope-ai/agentscope-java/blob/main/docs/v2/en/docs/quickstart.md)。

另外几套也值得看，但适用场景不同：

| 框架 | 我对 WindyAgent 的当前判断 |
| --- | --- |
| [AgentScope Java](https://github.com/agentscope-ai/agentscope-java) | 优先做原型，重点验证审批恢复、会话隔离和工具接入。 |
| [Spring AI Alibaba](https://github.com/alibaba/spring-ai-alibaba) | Agent Framework 和 Graph 能编排复杂流程；若 Agent 独立部署为 Spring 服务，值得进一步比较。 |
| [LangChain4j](https://docs.langchain4j.dev/tutorials/agents/) | 模型、工具和聊天记忆很实用；其 `langchain4j-agentic` 模块目前被官方标为实验性。 |
| [Koog](https://github.com/JetBrains/koog) | Kotlin 项目接入自然，但我需要先验证可恢复的人工审批是否满足运维场景。 |

这里的「优先」是选型判断，不是说框架已经替 WindyAgent 通过了生产测试。换框架只会改变通用运行时的维护成本；Minecraft 操作的正确性，仍要用实际场景验收。

## 如果重做，我会从一条链路开始

第一步保留现有的 Velocity/Bukkit 插件和跨服执行接口，把「查询子服状态」「查询在线玩家」接成只读工具。让一个 Agent 从管理员问题出发，调用工具，返回带来源的结果。先确认模型看到的工具定义与服务器真实能力一致。

第二步加一个需要审批的动作，例如踢出玩家。验收条件要具体：审批前不执行；拒绝后不执行；批准后只执行一次；等待审批期间重启，恢复后仍能知道动作处于什么状态。框架有审批机制，不等于应用已经正确处理了 Minecraft 的权限和重复执行。

第三步再决定部署形态。完整 Harness 带工作区、持久化等能力，我倾向先放在独立 Java 进程里，让 Velocity 插件做入口和游戏通信。如果「一个 JAR 放进代理端」是硬要求，再用小范围原型验证依赖、类加载、资源占用和关闭流程。部署形式应该由测量结果决定。

只有这条链路稳定后，我才会考虑迁移记忆、Skill、定时巡检和多 Agent。旧代码里有价值的 Minecraft 能力可以继续用；通用 Agent 运行时则逐步交给专门维护它的项目。

## 写在最后

WindyAgent 让我学到很多：工具调用协议为什么严格、会话历史为什么会损坏、审批为什么不只是弹一个确认框。自己实现一遍有学习价值。但作为应用开发者，下一步更重要的是让服主能可靠地完成一个真实任务。

现在我的方向是把 WindyAgent 收敛成一个基于成熟 Java Harness 的 Minecraft 运维应用。先做原型和故障场景验证，再决定迁移范围；这篇文章记录的是方向改变，还不是迁移完成公告。
