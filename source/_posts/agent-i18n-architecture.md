---
title: AI Agent 双语言架构——从 220 个硬编码中文到中英无缝切换
date: 2026-06-18 14:00:00
tags: [Agent, i18n, 架构, 前端, Kotlin]
categories: [AI 应用]
---

一个 AI Agent 项目，前端 dashboard 是单文件 HTML（打包进 jar），后端是 Kotlin 多模块。所有 UI 文本硬编码中文——220+ 个字符串散落在 HTML 模板和 JS 函数里，后端 80+ 个玩家可见消息写死在 Kotlin 代码中。

这篇文章讲怎么在不拆文件、不引入框架的前提下，给整个项目加上中英双语支持。

<!-- more -->

## 为什么不用 i18n 框架？

Dashboard 是**单文件 HTML**，打包进 jar 发布。引入 react-intl / vue-i18n 意味着要改构建流程、加依赖、拆组件。对于一个嵌入式控制台来说，杀鸡用牛刀。

后端是 Kotlin 多模块（core / bukkit / velocity），core 模块不能依赖任何平台 API。引入 ResourceBundle 意味着要处理 Java 8 兼容性、properties 文件编码、模块加载顺序。

最终方案：**纯 JS 语言包 + Kotlin Messages 对象**，零外部依赖。

## 前端：内嵌语言包 + data-i18n 属性

```javascript
const LANGS = {
  'zh-CN': {
    'title': 'WindyAgent · MC服务器智能助手',
    'login.title': 'WindyAgent 控制台',
    'login.hint': '输入访问令牌进入',
    // ... 220+ 条
  },
  'en': {
    'title': 'WindyAgent · MC Server Assistant',
    'login.title': 'WindyAgent Console',
    'login.hint': 'Enter access token to continue',
    // ...
  }
};

let lang = localStorage.getItem('wa_lang') || 'zh-CN';
const T = k => (LANGS[lang] || LANGS['zh-CN'])[k] || k;
```

HTML 元素用 `data-i18n` 属性标记：

```html
<h2 data-i18n="login.title">WindyAgent 控制台</h2>
<input data-i18n-ph="login.placeholder" placeholder="访问令牌">
```

`applyLang()` 遍历所有带属性的元素批量替换。JS 动态生成的 HTML 直接调 `T('key')`。

### 后端标签的坑

BehaviorAnalytics 模块返回的玩家标签（"萌新"、"建筑党"）和分群名称（"核心(在线≥300分)"）是中文的，因为 behavior 模块不依赖 core（设计上独立）。Dashboard 切英文后这些标签不会自动翻译。

解法：**前端加 BACKEND_LABELS 映射 + 正则匹配带参数的 segment**：

```javascript
const BACKEND_LABELS = {
  '萌新': 'tag.newbie', '常驻玩家': 'tag.regular', '肝帝': 'tag.hardcore',
  '建筑党': 'tag.builder', '挖矿党': 'tag.miner', // ...
};
const SEG_PATTERNS = [
  [/^核心\(在线≥(\d+)分\)$/, (m) => Tf('seg.core', m[1])],
  [/^活跃\(近(\d+)天\)$/, (m) => Tf('seg.active', m[1])],
];
function Tlabel(s) {
  if (BACKEND_LABELS[s]) return T(BACKEND_LABELS[s]);
  for (const [re, fn] of SEG_PATTERNS) { const m = s.match(re); if (m) return fn(m); }
  return s;
}
```

## 后端：core 模块的 Messages 对象

core 不能依赖平台 API，所以自建纯 Kotlin i18n：

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
        "zh_cn" to mapOf("cmd.usage" to "[WindyAgent] 用法：/ai <消息>", ...),
        "en" to mapOf("cmd.usage" to "[WindyAgent] Usage: /ai <message>", ...)
    )
}
```

各平台启动时 `Messages.init(cfg.language())`，后续所有 sendMessage / 命令响应用 `Messages.t(key)`。

### 命令别名的处理

命令的 `name` 字段是英文主触发词（history / status / approve），`aliases` 保留中文别名（历史 / 状态 / 批准）。这样无论语言设置如何，两种语言的触发词都能用。

## 教训

1. **i18n 要从第一天做**。后补的工作量是新建时的 5-10 倍——220 个字符串逐个找、逐个翻译、逐个测试。
2. **单文件 HTML 的 i18n 比框架项目更难**。没有组件隔离，没有编译期检查，全靠运行时 `T()` 调用和 `data-i18n` 属性，漏一个就是一个显示 bug。
3. **数据层和展示层的语言要分开考虑**。behavior 模块返回中文数据是合理的（它是数据层），翻译是展示层的责任。
