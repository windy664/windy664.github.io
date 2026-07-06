---
title: 给 Agent 加工具的单一扩展口——ToolContributor
date: 2026-07-06 22:20:00
tags: [Agent, 架构, 工具, Kotlin, LLM]
categories: [架构]
---

Agent 的工具（function calling）很容易长成一堆散装注册：这里 `extraTools += KnowledgeSearchTool(...)`，那里 `extraTools += RememberTool(...)`，散在各处。我的 Agent 有两个入口——Velocity 中心节点、Bukkit 嵌入式——同一组核心工具在两边各手写一遍。加一个核心工具要改两处，还老忘一处。这篇讲我怎么把「加工具」收敛成一个扩展口。

<!-- more -->

## 问题不只是 DRY

如果只是重复，抽个函数就完了。但散装注册还挡着另外三件我想要的事：

1. **可选依赖要能零开销跳过**。记忆、MCP 这些是可选的——依赖为 null 时对应工具就不该存在。散装写法里到处是 `memory?.let { extraTools += RememberTool(it) }`，判断散落各处。
2. **工具需要「来源/域」的概念**。我想在日志里知道每个工具是哪来的，将来还想「按域过滤」「按信任分权」。但我不想给每个 `AgentTool` 都加一个 `category` 字段——那是给几十个工具类背元数据。
3. **一个坏来源别拖垮全体**。某个 MCP server 加载抛异常，不该让整个工具装配崩掉。

## 抽象：一个来源 = 一个 Contributor

把「一组工具 + 它的可用性判断」打成一个东西：

```kotlin
interface ToolContributor {
    /** 来源/域名（如 "knowledge"、"mcp"）——作日志标识，也天然当分类 */
    val name: String
    /** 依赖未满足则 false，tools() 不会被调用 */
    fun isAvailable(): Boolean = true
    /** 惰性产出该来源的工具 */
    fun tools(): List<AgentTool>
}
```

有个设计取舍值得点一下：`name` 既是日志标识，**又天然充当分类**。所以我不用给每个 `AgentTool` 加 category 字段——分类的粒度落在「来源」上，而不是「工具」上。这个选择后面会回报。

大多数来源不值得单开一个类，给个闭包适配器：

```kotlin
class SimpleToolContributor(
    override val name: String,
    private val available: () -> Boolean = { true },
    private val supplier: () -> List<AgentTool>,
) : ToolContributor {
    override fun isAvailable() = available()
    override fun tools() = supplier()
}
```

## 装配：过滤 + 隔离 + 记账

一个装配器把来源清单汇成最终工具列表，每个来源单独 `try` 隔离：

```kotlin
object ToolAssembly {
    fun assemble(contributors: List<ToolContributor>, log: (String) -> Unit = {}): List<AgentTool> {
        val out = ArrayList<AgentTool>()
        for (c in contributors) {
            if (!runCatching { c.isAvailable() }.getOrDefault(false)) continue
            val ts = runCatching { c.tools() }.getOrElse {
                log("[Tools] ${c.name} — 加载失败：${it.message}"); emptyList()
            }
            if (ts.isNotEmpty()) { out += ts; log("[Tools] ${c.name} — ${ts.size} 个") }
        }
        return out
    }
}
```

前面那三件事在这 15 行里全落地了：`isAvailable` 为假就零开销跳过；`runCatching` 让坏来源只丢自己、不拖累别人；`log` 顺手把「哪个来源上了几个工具」打出来。

## 核心工具收敛成一处

于是平台无关的那几组核心工具集中定义，两个 runner 各自 `extraTools += ToolAssembly.assemble(CoreToolContributors.of(...))`：

```kotlin
object CoreToolContributors {
    fun of(knowledge, expander, ragMinHits, usageTracker, memory, mcpServers) = listOf(
        SimpleToolContributor("knowledge") {
            listOf(KnowledgeSearchTool(knowledge, expander, ragMinHits), KnowledgeWriteTool(knowledge))
        },
        SimpleToolContributor("usage", available = { usageTracker != null }) {
            listOf(LlmUsageTool(usageTracker!!))
        },
        SimpleToolContributor("memory", available = { memory != null }) {
            listOf(RememberTool(memory!!))
        },
        SimpleToolContributor("mcp", available = { mcpServers.isNotEmpty() }) {
            McpLoader.load(mcpServers)
        },
    )
}
```

加一个核心工具，从「两个 runner 各改一行、还得记得两边同步」变成「往这个清单加一项」。可选的 `usage`/`memory`/`mcp` 用 `available` 表达，等价于原来散落各处的 `?.let`，但判断集中了。平台特有的工具（本地命令 vs 远程命令、技能、能力目录）仍由各 runner 自己装配——它们本就该不一样。

## 为什么「来源粒度」是对的过滤闸

回到前面那个取舍。为什么分类落在来源、而不是工具？因为我真正想要的过滤，天然就是来源粒度的：

- **按信任分权**：普通玩家触发的会话，不上「写记忆」「执行命令」这类来源；
- **按消息只上相关域**：一句纯闲聊，不必把整个 MCP 工具集塞进 prompt（这也是省 token，见 [成本都烧在哪](/2026/06/13/token-cost-and-data-hygiene/)）。

这些闸只要在 `assemble` 里按 `contributor` 过滤一遍就行，是一个有意义、好维护的粒度。如果当初把分类做到 tool 级，我就得给每个工具背 `{domain, minTrust, ...}` 一堆字段，然后在工具级做过滤——粒度太细，反而没有一个来源那样清晰的边界。

顺带，我原来那套「每插件一组工具」的 `PluginIntegration` 本就是 `ToolContributor` 的一个特例。MCP、技能、平台本地工具，现在也都能收编成贡献者，走同一个装配口。

## 写在最后

Agent 的能力面很容易越长越乱——今天接个知识库、明天接个 MCP、后天加个技能，如果每次都是「在某个 runner 里再 `+=` 一行」，用不了多久你就说不清「这个 Agent 到底有哪些工具、哪些来源、缺依赖时会怎样」。

给「来源」一个一等公民的抽象，把扩展口收敛到一处，代价是一个接口加一个装配器——非常小。回报是：加工具只改一处、可选依赖自动跳过、坏来源自我隔离，以及一个将来做分权/可观测/按需上工具都能落脚的、有意义的过滤粒度。工具多了以后，这点结构就是你还能不能讲清楚自己 Agent 的分界线。
