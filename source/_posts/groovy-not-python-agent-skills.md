---
title: 别人的 Agent 技能都用 Python，我的偏用 Groovy——这才是关键
date: 2026-06-15 22:00:00
tags: [Agent, LLM, 技能, Groovy, JVM, 创新]
categories: [AI 应用]
---

聊 Agent「技能」（skill / tool）的文章，几乎默认一件事：**技能 = 一段 Python**。Anthropic 的 Agent Skills、各家的 code interpreter、一堆开源 Agent 框架——背后都是「在一个沙箱化的 Python 运行时里跑脚本」。

WindyAgent 的技能不是 Python，是 **Groovy**。这不是我图省事乱选的，恰恰是这个项目里我最得意的一个决定。讲讲为什么。

<!-- more -->

## 先问一个根本问题：技能的价值来自哪

一个 Agent 技能值不值钱，不取决于它用什么语言写，而取决于**它能多直接地碰到它要管的那个系统**。

WindyAgent 管的是一台 **Minecraft Java 服务端**——一个跑在 JVM 上的活进程，里头有在线玩家对象、世界状态、各种插件（经济、领地、菜单……）的 API。一个技能要有用，得能摸到这些**活的东西**。

现在假设技能是 Python。Python 进程和 Java 服务端是**两个运行时**。Python 想读「当前在线玩家」，得通过某种桥——RPC、命令行、HTTP——把请求发给 Java 那边，序列化、反序列化、再把结果传回来。想调某个插件的 API？对不起，那是个 Java 对象，Python 这边压根没有，你得先在 Java 侧包一层接口暴露出去。**每加一种能力，都要在桥上再凿一个洞。**

## Groovy 的杀招：和宿主同一个 JVM

Groovy 编译成 JVM 字节码，跑在**同一个 JVM 里**。这意味着技能脚本能**直接持有那个活着的 `Server` 对象**：

```groovy
// 注入进来的就是宿主进程里真实的对象，不是某个代理/快照
def p = server.getPlayerExact(args.player)
if (p == null) return "玩家不在线"
p.inventory.addItem(new ItemStack(Material.DIAMOND, 5))
server.broadcastMessage("§e欢迎 VIP §b${p.name}§e！")
```

没有 IPC，没有序列化边界，没有「先在 Java 侧暴露接口」。脚本拿到的 `server`、`plugins` 就是宿主进程里那一份。服主想让 Agent 调任何已装插件的能力，**写几行 Groovy 就行，不用我改一行框架代码、更不用重新编译**。

这就是把「技能协议」和「技能执行器」分开看的好处：

> Anthropic 的 Agent Skills 规范（`SKILL.md`、渐进式披露、name+description 暴露）本身是**语言无关的协议**。我照搬了它的「形状」，但执行器选了 Groovy——因为我的宿主是 JVM。**协议跟谁学，执行器选谁是你宿主的母语。**

## 动态类型，正好治「跨插件调用」

还有个意外之喜。服务端插件五花八门，我没法在编译期就依赖每一个（也不该）。Groovy 是 JVM 上的**动态语言**，运行时派发方法，这让「软依赖某个插件」变得很自然：

```groovy
// 没装 Vault 也不会编译报错——运行时才解析这个类
if (plugins.getPlugin("Vault") != null) {
    def econ = Class.forName("net.milkbowl.vault.economy.Economy")
    def rsp = server.servicesManager.getRegistration(econ)
    rsp?.provider?.depositPlayer(p, args.coins as double)  // 动态派发，无需编译期类型
}
```

换成静态语言，你要么编译期就得拿到 Vault 的依赖，要么写一堆反射样板。Groovy 直接 `Class.forName` + 动态调用，既软依赖又干净。一个 Agent 要面对「服主装了什么我事先不知道」的世界，动态类型在这里是真·优势。

## 代价：没有沙箱，所以信任边界换了地方

天下没有白吃的午餐。Groovy 在宿主 JVM 里裸跑，**没有 Python 沙箱那种隔离**——脚本理论上能干 JVM 能干的一切。

所以我没有把信任寄托在「沙箱」上，而是搬到了**文件系统**这条边界：能往服务器的 `skills/` 目录放文件的人，本来就有这台机器的完整权限。技能由**服主亲手写、亲自审**，审一次就冻结成一条确定性能力。框架这边能加的护栏（主线程执行 + 超时看门狗、参数预校验、每次记审计）都加上，但最后一道防线是「人审过」，不是「机器关得住」。

这套取舍我在[技能机制那篇](/2026/06/15/skill-system-not-llm-eval/)里展开过——核心就一句：**不让 LLM 现场写代码，让服主写好、Agent 按名调用。** 既然代码是可信的人写的、审过的，那「没沙箱」就从致命问题变成了可接受的工程权衡，换来的是和宿主进程零距离的能力。

## 小结

- 技能的价值 = 它能多直接地碰到目标系统。我的目标系统在 JVM 上，所以技能也该在 JVM 上。
- **Groovy-in-JVM** 让技能直接持有活的宿主对象，零 IPC、零桥接；动态类型还顺手解决了「跨插件软依赖」。
- 代价是放弃沙箱隔离，于是把信任边界换成「服主写、审过的文件」。

「Agent 技能都用 Python」是个被默认惯了的假设。但**执行器该选你宿主的母语**——当宿主是一台 Java 游戏服务器时，Groovy 比 Python 合身得多。这一步我觉得是 WindyAgent 真正不太一样的地方。
