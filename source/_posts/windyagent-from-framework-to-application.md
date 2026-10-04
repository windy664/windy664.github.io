---
title: WindyAgent 的下一步思考：借助 Java Harness 做 Minecraft Agent 应用？
date: 2026-10-04 23:00:00
tags: [WindyAgent, Agent, AgentScope, Minecraft, 架构复盘]
categories: [思考]
---

> **本文是想法记录，不是进展公告。** 截至写作时，我还没有为 WindyAgent 接入 Java Harness，也没有完成原型、迁移或部署。下面的框架比较、实现步骤和部署形态，都是待验证的设想。

过去几个月，我写了不少 WindyAgent 的文章：ReAct、Plan-Execute、跨服总线、工具安全闸、长期记忆、Skill、上下文压缩……每解决一个问题，就给自己的 Agent 补一个模块。代码确实越写越多，我却越来越不确定：**我到底在做 Minecraft 服务器运维应用，还是在维护一套通用 Agent 框架？**

准备智能体软件工厂比赛的[参赛方案](https://github.com/windy664/Torine-hackathon-agent-ts)时，我开始思考：应用能否借助现成的 Agent 能力，把精力留给任务适配、约束和验收？这是比赛给我的启发。回头看 WindyAgent，我才进一步想到：既然 Java 生态里也有 Agent Harness，未来是否可以不再从工具调用循环开始自己造？目前这还只是一个问题，没有变成 WindyAgent 的改造。

<!-- more -->

## 功能越来越全，可靠性却没有同步增长

WindyAgent 最初的目标很清楚：让服主用自然语言查看服务器状态、处理玩家问题，在关键操作前得到审批。为了实现它，我逐步写了自己的 LLM Provider、ReAct 循环、计划执行、会话管理、失败检测、工具缓存、跨服能力发现和 Skill 引擎。[项目 README](https://github.com/windy664/WindyAgent) 现在列出的功能，已经很像一套 Agent 平台。

但「有这个模块」和「这个模块在真实并发、重复请求、重启恢复后仍然正确」是两回事。回看代码时，一个让我担心的例子是工具缓存：它默认开启，按工具名和参数复用成功结果。查询与有副作用的操作如果共用这套策略，可能产生错误；缓存的 `ToolResult` 还保留旧的 `toolCallId`，命中后原样回传，可能让新一轮工具调用与结果 ID 对不上。这些是从代码推断出的风险，还需要针对性的复现和测试，不能写成已经发生的线上故障。[工具循环](https://github.com/windy664/WindyAgent/blob/master/agent-runtime/src/main/kotlin/org/windy/windyagent/tools/AgentLoop.kt)

这不是改掉一个缓存 bug 就能结束的事。审批要能在等待时保存状态，恢复后不能重复执行；同一会话并发请求不能互相覆盖历史；一次工具调用超时，后台任务也得真正停止。每项都需要设计、测试和持续维护。我以前写过[「从 Hermes Agent 偷了 10 个设计」](https://windy664.github.io/2026/06/18/stealing-from-hermes-agent/)；现在意识到，把十个设计分别移植过来，也意味着我要负责它们组合起来之后的行为。

## 智能体软件工厂比赛给我的启发

比赛方案让我注意到一种分工：用 [OpenCode](https://github.com/anomalyco/opencode) 这类现成编码 Agent 承担通用执行能力，应用侧重点处理任务拆分、输入输出契约、检查和反馈。我想把这个思路拿来重新审视 WindyAgent，但还没有在 Minecraft 运维场景里验证它。

Minecraft 运维也有自己的独特问题：Velocity 只看得到代理层，世界和物品数据在 Bukkit/Paper 子服；同一个「在线人数」可能来自不同节点；踢人、执行命令、修改世界都有不同的授权边界。**这些问题，通用 Harness 不会替我决定。** 如果尝试这条路，我需要把精力放在工具语义、跨服通信、权限映射和可验证的执行结果上。

## 哪些 Java 框架值得先验证

从公开资料看，我目前最想先试的是 [AgentScope Java 2.0](https://github.com/agentscope-ai/agentscope-java)。它区分较小的 `ReActAgent` 与带工作区、会话持久化、上下文管理、权限和人工介入能力的 `HarnessAgent`。这些能力看起来与 WindyAgent 的需求接近，官方也提供了[从 HarnessAgent 开始的示例](https://github.com/agentscope-ai/agentscope-java/blob/main/docs/v2/en/docs/quickstart.md)。但我还没有做接入原型，无法判断它在实际 Minecraft 环境中的适配成本。

另外几套也值得看，但适用场景不同：

| 框架 | 目前想验证的问题 |
| --- | --- |
| [AgentScope Java](https://github.com/agentscope-ai/agentscope-java) | 如果做原型，先验证审批恢复、会话隔离和工具接入。 |
| [Spring AI Alibaba](https://github.com/alibaba/spring-ai-alibaba) | 如果 Agent 独立部署为 Spring 服务，再比较 Agent Framework 和 Graph 是否适合。 |
| [LangChain4j](https://docs.langchain4j.dev/tutorials/agents/) | 模型、工具和聊天记忆值得了解；`langchain4j-agentic` 的成熟度需要单独评估。 |
| [Koog](https://github.com/JetBrains/koog) | Kotlin 接入方式值得比较，尤其要验证人工审批能否可靠恢复。 |

这张表是阅读资料后的待验证清单，不是已经完成的选型，更不是生产测试结果。即使将来更换框架，Minecraft 操作的正确性仍需用实际场景验收。

## 如果尝试重做，我会先验证一条链路

设想中的第一步，是评估现有 Velocity/Bukkit 插件和跨服执行接口有哪些能复用，再尝试把「查询子服状态」「查询在线玩家」接成只读工具。目标是让 Agent 从管理员问题出发，调用工具并返回带来源的结果，同时核对模型看到的工具定义与服务器真实能力是否一致。现在还没有这个原型。

如果只读链路可行，才考虑第二步：尝试加入一个需要审批的动作，例如踢出玩家。验收条件应当具体：审批前不执行；拒绝后不执行；批准后只执行一次；等待审批期间重启，恢复后仍能知道动作处于什么状态。框架有审批机制，不等于应用已经正确处理了 Minecraft 的权限和重复执行。

前两步通过后，才有条件讨论部署形态。完整 Harness 带工作区、持久化等能力，我初步倾向于试独立 Java 进程，由 Velocity 插件承担入口和游戏通信；如果「一个 JAR 放进代理端」是硬要求，还要另做原型验证依赖、类加载、资源占用和关闭流程。目前没有做这些测量，部署形式尚未确定。

只有这条链路稳定后，我才会考虑记忆、Skill、定时巡检和多 Agent 等后续能力。旧代码里哪些 Minecraft 能力能复用、通用 Agent 运行时是否值得替换，都要等原型结果出来再决定。

## 写在最后

WindyAgent 让我学到很多：工具调用协议为什么严格、会话历史为什么会损坏、审批为什么不只是弹一个确认框。自己实现一遍有学习价值。但作为应用开发者，下一步更重要的是让服主能可靠地完成一个真实任务。

目前我只是倾向于探索「基于成熟 Java Harness 做 Minecraft 运维应用」这条路。下一步如果真要行动，应先做最小原型和故障场景验证，再决定是否迁移、迁移多少。文章记录的是一次想法变化，不代表 WindyAgent 已经开始重构。
