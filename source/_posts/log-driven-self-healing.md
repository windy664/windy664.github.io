---
title: 从日志到自愈——AI Agent 的闭环运维是怎么跑通的
date: 2026-06-18 12:00:00
tags: [Agent, 运维, 日志, 自愈, Minecraft]
categories: [AI 应用]
---

大多数 AI Agent 停留在「你问我答」——管理员发指令，Agent 执行。但运维的真正痛点不是「执行命令」，而是**发现问题**。服务器半夜 3 点报了个 OutOfMemoryError，没人看到，早上起来玩家全掉光了。

这篇讲我们怎么把「日志监控 → AI 诊断 → 方案审批 → 自动修复」这条链跑通的。

<!-- more -->

## 问题：日志报错了，谁来看？

Minecraft 服务器的日志在 `logs/latest.log`，每小时几千行。管理员不可能盯着看。传统的解法是装日志告警插件（如 Sentry），但告警出来后还是要人去分析、判断、操作。

我们要做的是：**AI 看日志 → AI 分析 → AI 出方案 → 人只需要点「批准」。**

## 第一步：日志监控

一个 daemon 线程，每 30 秒扫描 `latest.log` 的新增内容：

```kotlin
class LogWatcher(
    private val logFiles: List<File>,
    private val onError: (LogError) -> Unit
) {
    private val lastOffset = ConcurrentHashMap<File, Long>()
    private val dedup = ConcurrentHashMap<String, Long>()

    private fun scan() {
        for (f in logFiles) {
            val offset = lastOffset[f] ?: 0L
            val newLines = readLines(f, offset)
            lastOffset[f] = f.length()

            for ((i, line) in newLines.withIndex()) {
                val match = matchError(line) ?: continue
                // 去重：同一错误 5 分钟内不重复报
                if (dedup(match.pattern)) continue
                onError(LogError(line, context = newLines.subList(i-5, i+5)))
            }
        }
    }
}
```

关键设计：
- **只读增量**：记录文件偏移量，不重复扫描
- **模式匹配**：`ERROR` / `Exception` / `OutOfMemoryError` / `WARN`
- **去重**：同一错误模式 5 分钟内只报一次
- **洪泛防护**：每分钟最多推 30 条，超出丢弃

## 第二步：跨机器传输

日志在 Bukkit 子服上，Agent 在 Velocity 中心。需要把错误信息从子服推到中心。

复用了现有的跨服总线（本来是用来派发命令的），加了一个 `publishError` 单向推送通道：

```kotlin
// 子服侧
interface MessageBus {
    fun publishError(errorJson: String) {}  // 新增
}

// 中心侧
interface MessageBus {
    fun onError(handler: (String) -> Unit) {}  // 新增
}
```

错误信息经总线到达中心，存入 `RecentErrorBuffer`（环形缓冲，100 条，持久化到 `errors.json`）。

## 第三步：AI 诊断 + 方案审批

这是最有意思的部分。Agent 不是被动等管理员来问「有什么报错」，而是**每次对话开始时主动检查**：

```
管理员: "帮我查一下 Steve 的余额"
AI:   [自动检查最近异常]
      "先说一下，最近检测到 2 条日志异常：
       • [ERROR] earth — java.lang.OutOfMemoryError
       • [WARN] lobby — TPS 降到 15.2
       需要我分析吗？还是先查 Steve 的余额？"
```

管理员说「分析一下」，Agent 读取更多日志上下文，然后生成多个方案：

```
AI:   分析结果：
      根因：堆内存不足（当前 -Xmx 1G，模组服至少需要 2G）

      方案 A：增大堆内存（改启动脚本 -Xmx 2G）
        风险：低，需要重启
        适用：长期解决

      方案 B：安装 ClearLagg 插件定期清理实体
        风险：中，可能误删玩家建筑实体
        适用：临时缓解

      方案 C：限制怪物生成数量（改 bukkit.yml）
        风险：低，不影响现有实体
        适用：预防性措施

      推荐方案 A。选哪个？
```

管理员回复「A」，Agent 执行修改启动脚本的操作。

## 架构全景

```
Bukkit 子服                    总线              Velocity 中心
                                                   
LogWatcher (30s/次)                                    
  → 检测 ERROR ───publishError──→ errorBuffer.add()
  → 本地审计日志                        ↓
                                  Agent 对话开始
                                    → get_recent_errors()
                                    → read_log(更多上下文)
                                    → 分析根因
                                    → 生成 2-3 方案
                                    → 展示给管理员
                                    → 管理员选择
                                    → 执行方案
```

## 反思：闭环才是关键

单独的日志监控、单独的 AI 诊断、单独的审批系统——都不难。**难的是把它们串成一个闭环。**

- 日志监控发现问题 → 自动推给 Agent（不是等人来看）
- Agent 读上下文分析 → 生成多个方案（不是只报错误）
- 方案交给管理员选 → 执行（不是只给建议）

每一步的输出是下一步的输入。管理员只需要在最后一步做决策，前面的分析工作全由 AI 完成。

**做 Agent 产品最重要的设计原则：让人只做人该做的决策，把其余所有工作交给机器。**
