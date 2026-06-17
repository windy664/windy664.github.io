---
title: AI 写的代码该不该直接跑——生成代码的安全验证链
date: 2026-06-18 11:00:00
tags: [Agent, 安全, Groovy, LLM, 工程反思]
categories: [AI 应用]
---

当 AI Agent 能「说人话 → 生成代码 → 直接执行」时，最让人不安的问题是：**AI 写的代码，能信吗？**

这个问题不是假设。LLM 会写出看似正确但逻辑有 bug 的代码，会调用不存在的 API，会忽略边界条件。在服务器运维场景下，一段错误的 Groovy 脚本可以清空玩家背包、执行破坏性命令、甚至让服务器崩溃。

<!-- more -->

## 信任链断裂

传统的代码信任模型是：**人写 → 人审 → 人部署。** 每一步都有人类把关。

AI 生成代码后，这个链条断了：

```
用户说意图 → AI 生成代码 → ??? → 执行
```

`???` 这一步就是我们要填的。不能直接执行（太危险），也不能让人逐行审查（太慢、用户也不会审代码）。需要一条**自动化的验证链**。

## 三层验证

### 第一层：编译检查

最基础的一层。Groovy 脚本保存前，用 `GroovyClassLoader.parseClass()` 只编译不执行。

```kotlin
fun compile(script: String): String? = runCatching {
    val loader = GroovyClassLoader(classLoader, compilerConfig)
    loader.parseClass(script, "check.groovy")
    loader.clearCache()
    null  // 通过
}.getOrElse { "编译错误：${it.message}" }
```

这层能捕获：语法错误、类型错误、未解析的引用。**100% 安全，不执行任何代码。**

但编译通过不代表逻辑正确。`player.inventory.addItem(ItemStack(Material.DIAMOND, -1))` 编译没问题，但 `-1` 个钻石会出事。

### 第二层：Dry-run 模拟执行

用 mock 对象替代真实 API，执行脚本并记录「会做什么」，但不做。

```kotlin
fun dryRun(script: String, args: Map<String, Any?>): DryRunResult {
    val ops = mutableListOf<String>()
    val mockServer = MockServer(ops)        // 拦截 server.xxx 调用
    val mockActions = MockActions(ops)      // 拦截命令执行
    val binding = Binding()
    binding.setVariable("server", mockServer)
    binding.setVariable("actions", mockActions)
    // ... 用 mock binding 执行脚本
    return DryRunResult(success = true, operations = ops)
}
```

Mock 对象对常见操作做精确拦截：
- `server.broadcastMessage(msg)` → 记录「📢 全服广播：$msg」
- `player.inventory.addItem(item)` → 记录「🎒 给玩家添加：5x diamond」
- `server.getPlayerExact(name)` → 返回 mock Player（不查真实在线）

**但 mock 不可能覆盖所有 API。** Bukkit 有上千个方法，我们只 mock 了最常用的十几个。未覆盖的方法会走到兜底：

```kotlin
fun methodMissing(name: String, args: Any?): Any? {
    ops.add("⚠️ server.$name(${args}) → 未拦截，可能存在风险")
    return null
}
```

这些 `⚠️` 标记会特别展示给用户：「以下操作未经模拟验证，请人工确认」。

### 第三层：AI 生成代码的来源标记

AI 创建的技能自动标记 `origin: ai_generated`。这个标记不影响执行，但影响信任策略：

- 手动创建的技能（`origin: manual`）：服主写的，信任
- AI 生成的技能（`origin: ai_generated`）：需要 dry-run 后用户确认才保存

系统提示里明确要求：

```
AI 生成代码的安全边界：
① 把 dry-run 结果完整展示给用户
② 如果有未经模拟验证的操作（⚠️ 标记），明确告知
③ 只有用户明确说"确认"后才保存
```

## 错误自愈

代码执行失败时，Agent 不是直接报错，而是自动修复：

```
脚本执行失败：NullPointerException at line 15
→ Agent 读取脚本 + 错误栈
→ 分析：server.getPlayerExact(name) 返回 null（玩家不在线）
→ 修复：加 null 检查
→ 编译检查 ✅
→ dry-run ✅
→ 更新脚本
→ 重新执行
```

连续失败 3 次才放弃，把完整错误日志和诊断报告给用户。

## 反思：安全与便利的平衡

这条验证链不是完美的。Dry-run 的 mock 不可能覆盖所有 API，编译检查不 catch 运行时错误，AI 自己修的代码可能引入新 bug。

但它比两个极端都好：
- **比「直接执行」安全**：至少有编译检查 + 模拟预览
- **比「要求人工审查」实用**：用户不会审 Groovy 代码，但能看懂 dry-run 的「会给玩家发 5 个钻石」

**安全不是绝对的，是分层的。每一层挡住一部分风险，剩下的风险靠标记 + 告警让用户知情。**
