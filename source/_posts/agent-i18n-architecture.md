---
title: AI Agent 要会说双语——MC 服务器管理 Agent 的多语言架构
date: 2026-06-18 14:00:00
tags: [Agent, i18n, 架构, Minecraft, 多语言]
categories: [AI 应用]
---

MC 服务器的玩家来自全球。一个中文服主开的服，可能有英文玩家加入。Agent 的控制台、命令响应、告警通知、行为标签——如果全是中文，英文玩家看不懂；如果全是英文，中文服主用着别扭。

更深层的问题：**Agent 的系统提示是中文写的，LLM 回复也是中文。如果服务器面向国际玩家，Agent 的广播消息、踢人理由、欢迎语都应该用玩家的母语。**

这篇文章讲怎么从架构层面解决 Agent 的多语言问题——不只是 UI 翻译，而是让 Agent 本身具备多语言能力。

<!-- more -->

## 问题：Agent 的语言在哪里硬编码了？

扫了一遍代码，发现语言散落在三个层面：

1. **Dashboard UI**（前端）：220+ 个字符串硬编码中文——导航、按钮、表单、告警标签
2. **命令响应**（后端）：80+ 个玩家可见消息——`/ai help` 输出、审批通知、错误提示
3. **Agent 行为**（数据层）：玩家标签（"萌新"/"肝帝"）、行为分布（"建造"/"战斗"）、分群名称

三层的翻译策略不同：

| 层面 | 翻译时机 | 谁负责 |
|------|---------|-------|
| Dashboard UI | 切换语言时 | 前端 JS |
| 命令响应 | 服务器启动时 | 后端 Messages 对象 |
| Agent 行为标签 | 不翻译（数据层） | 前端 Tlabel() 映射 |

## 第一层：Dashboard——Agent 的控制台

Dashboard 是单文件 HTML 打包进 jar。不能拆文件、不能加构建工具。

方案：**内嵌语言包 + data-i18n 属性**。

```javascript
const LANGS = {
  'zh-CN': {
    'sidebar.ops': '运维总览',
    'chat.welcome_title': '你好，腐竹 🌸',
    'alert.OFFLINE': '掉线',
    // ... 220+ 条
  },
  'en': {
    'sidebar.ops': 'Dashboard',
    'chat.welcome_title': 'Hello, Admin 🌸',
    'alert.OFFLINE': 'Offline',
    // ...
  }
};

const T = k => (LANGS[lang] || LANGS['zh-CN'])[k] || k;
```

HTML 元素标记翻译键，JS 动态内容直接调 `T()`。

### 后端标签的坑

BehaviorAnalytics 返回的玩家标签是中文的（"萌新"、"建筑党"），因为 behavior 模块设计上不依赖 core（纯数据层）。Dashboard 切英文后这些标签不会自动翻译。

解法不改 behavior 模块——**前端加映射表 + 正则匹配带参数的 segment**：

```javascript
const BACKEND_LABELS = {
  '萌新': 'tag.newbie', '常驻玩家': 'tag.regular', '肝帝': 'tag.hardcore',
  '建筑党': 'tag.builder', '挖矿党': 'tag.miner',
};
const SEG_PATTERNS = [
  [/^核心\(在线≥(\d+)分\)$/, m => Tf('seg.core', m[1])],
  [/^活跃\(近(\d+)天\)$/, m => Tf('seg.active', m[1])],
];
function Tlabel(s) {
  if (BACKEND_LABELS[s]) return T(BACKEND_LABELS[s]);
  for (const [re, fn] of SEG_PATTERNS) { const m = s.match(re); if (m) return fn(m); }
  return s;
}
```

## 第二层：命令响应——Agent 的嘴

`/ai help`、`/ai approve`、审批通知、错误提示——这些是 Agent 直接对玩家说的话。

core 模块不能依赖平台 API，所以自建 Messages 对象：

```kotlin
object Messages {
    private var lang = "zh_cn"
    fun init(language: String) { lang = language.lowercase().replace("-", "_") }
    fun t(key: String): String = LANGS[lang]?.get(key) ?: LANGS["zh_cn"]?.get(key) ?: key
    fun t(key: String, vararg args: Any): String {
        var s = t(key)
        args.forEachIndexed { i, v -> s = s.replace("%${i + 1}", v.toString()) }
        return s
    }
    private val LANGS = mapOf(
        "zh_cn" to mapOf(
            "cmd.usage" to "[WindyAgent] 用法：/ai <消息>",
            "cmd.rate_limited" to "[WindyAgent] 请求太频繁，请稍后再试。",
            // ... 80+ 条
        ),
        "en" to mapOf(
            "cmd.usage" to "[WindyAgent] Usage: /ai <message>",
            "cmd.rate_limited" to "[WindyAgent] Too many requests, please try again later.",
        )
    )
}
```

所有 `sendMessage()` 和命令响应用 `Messages.t(key)` 替代硬编码。

### 命令别名的处理

命令的 `name` 是英文主触发词（history / status / approve），`aliases` 保留中文别名（历史 / 状态 / 批准）。两种语言的触发词都能用，不受语言设置影响。

## 第三层：Agent 行为——数据层不翻译

玩家标签（"萌新"、"肝帝"）和分群名称（"核心(在线≥300分)"）是 BehaviorAnalytics 输出的结构化数据。这些数据被 Dashboard、总线、Agent 工具等多个消费方使用。

**翻译是展示层的责任，不是数据层的。** 如果在数据层翻译，会导致：
- 存储混乱（同一个标签存了中英两种文字）
- 查询困难（WHERE tag = 'Newbie' 还是 WHERE tag = '萌新'？）
- 消费方耦合（总线 JSON 里混了翻译逻辑）

正确做法：数据层始终输出中文 key，展示层按语言翻译。

## 未来：Agent 本身要会多语言

当前的 i18n 只覆盖了 UI 和命令响应。更深层的问题是：**Agent 的 LLM 回复本身是中文的**。

如果一个英文玩家用英文问 Agent "how much is this item?"，Agent 应该用英文回复。这需要：

1. **系统提示感知语言**：检测用户输入语言，动态调整回复语言
2. **工具结果翻译**：`get_balance` 返回的 "玩家余额：1000 金币" 应该根据玩家语言输出
3. **广播消息多语言**：`broadcast` 工具应该能按玩家语言发送不同版本

这些是下一步要做的——让 Agent 从"会说中文"进化到"会说双语"。

## 教训

1. **i18n 要从第一天做**。后补 220 个字符串的工作量是新建时的 5-10 倍。
2. **数据层和展示层的语言要分开**。数据层输出 key，展示层翻译。
3. **单文件 HTML 的 i18n 比框架项目更难**。没有组件隔离，全靠运行时 `T()` 调用，漏一个就是一个 bug。
4. **UI 翻译只是第一步**。真正的多语言 Agent 要让 LLM 本身具备多语言回复能力。
