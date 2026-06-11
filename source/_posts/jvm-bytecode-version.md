---
title: 为什么 Java 11 装不了 Java 25 编译的插件——一次跨平台插件的字节码版本踩坑
date: 2026-06-11 21:00:00
tags: [JVM, 字节码, 类加载]
categories: [后端基础]
---

从一个「单 JAR 同时支持 NeoForge 和 Velocity」的需求出发，把 class 文件的 major version、JVM 的向后兼容、以及 `UnsupportedClassVersionError` 的根因聊清楚。

<!-- more -->

## 起因：一个看似合理的需求

我在做一个 Minecraft 服务器的 AI Agent，希望**一个 JAR 同时跑在两个平台上**：

- **NeoForge**（子服 Mod 载体）—— 它的新版本 26.x 强制 **Java 25**
- **Velocity**（群组代理载体）—— 我的目标用户里有人只装了 **Java 11**

我天真地以为：核心逻辑写一份，两个平台各写个适配层，打成一个 JAR 就行。结果构建一跑就崩：

```
Could not resolve net.neoforged.fancymodloader:loader:11.0.13.
  > Dependency resolution is looking for a library compatible with
    JVM runtime version 21, but it is only compatible with
    JVM runtime version 25 or newer.
```

更要命的是：就算我能编译出来，**Java 11 的 Velocity 用户也根本加载不了 Java 25 编译的代码**。这背后是 JVM 一个非常基础、面试常考的机制。

## class 文件里藏着一个版本号

每个 `.class` 文件开头的 8 个字节长这样：

```
CA FE BA BE 00 00 00 45
└─ magic ─┘ └minor┘ └major┘
```

- `0xCAFEBABE` 是 Java class 文件的魔数（一个经典彩蛋）
- 最后两个字节 `0x0045 = 69` 是 **major version**

major version 和 Java 版本固定对应：

| Java 版本 | class major version |
|---|---|
| Java 8 | 52 |
| Java 11 | 55 |
| Java 17 | 61 |
| Java 21 | 65 |
| Java 25 | 69 |

规律：`major = Java版本 + 44`。

## JVM 的铁律：只向后兼容，不向前兼容

JVM 加载类时会**校验 major version**：

> 一个 Java N 的 JVM，只能加载 major version ≤ (N+44) 的 class 文件。

也就是：

- ✅ **Java 25 的 JVM 能跑 Java 8 编译的 class**（向后兼容，老代码永远能跑）
- ❌ **Java 11 的 JVM 不能跑 Java 25 编译的 class**（不向前兼容）

当 Java 11 的 JVM 撞上 major version 69 的 class，直接抛：

```
java.lang.UnsupportedClassVersionError:
  xxx has been compiled by a more recent version of the Java Runtime
  (class file version 69.0), this version of the Java Runtime only
  recognizes class file versions up to 55.0
```

`69.0` 是 Java 25，`55.0` 是 Java 11——错误信息其实把一切都说清楚了。

## 回到我的难题

矛盾现在非常清晰：

| | 运行环境 | 我的字节码必须 |
|---|---|---|
| NeoForge 26.x | Java 25 | 编译时依赖强制 ≥ 25 |
| Velocity 用户 | Java 11 | ≤ 55，即 ≤ Java 11 |

这两个要求**在同一个 JAR 里无法同时满足**：
- NeoForge 的依赖（`fancymodloader`）本身就是 Java 25 编译的，我引用它就必须用 Java 25 工具链编译，产物 major = 69
- 而 major = 69 的 JAR，Java 11 用户加载即报错

「单 JAR 双载体」的美梦在这个版本组合下直接破产。

## 解决思路：按运行环境的「最低版本」编译

JVM 不向前兼容，意味着**字节码版本必须就低不就高**——你想覆盖到的最旧运行环境是谁，就编译成那个版本。

最终方案是**按载体拆分构建产物**：

- `core + Velocity 适配` → 用 **Java 11** 工具链编译 → major 55 → Java 11 用户能装
- `NeoForge 适配` → 用 **Java 25** 编译 → major 69 → 给 Java 25 的子服

核心逻辑编成 Java 11，NeoForge 那边（Java 25）照样能依赖它——因为**高版本能向后兼容低版本字节码**。反过来不行。

> 工程经验：**公共库永远编译到你要支持的最低 Java 版本**。这就是为什么很多流行库到今天还在用 Java 8 做 target——不是它们不想用新特性，而是要照顾运行环境的下限。

## 顺带澄清：编译用的 JDK ≠ 字节码版本

很多人以为「我用 JDK 21 编译，产物就是 Java 21 字节码」。不一定。`javac` 有 `--release` / `-target`：

```bash
# 用 JDK 21 编译，但产出 Java 11 字节码（major 55）
javac --release 11 Foo.java
```

`--release 11` 还会把 API 限制在 Java 11 范围（用了 Java 17 才有的 API 会编译报错），比单纯的 `-target` 更安全。Gradle 的 toolchain 本质就是在帮你管这件事。

## 写在最后

这个坑本质上是「我想偷懒用一个 JAR 通吃所有平台」撞上了「JVM 不向前兼容」这堵硬墙。退一步看，平台各自要求什么 Java 版本是它们自己的事，我能控制的只有「自己的字节码编到多低」。想清楚这一点，拆产物就是顺理成章的结论——而不是一头钻进单 JAR 的牛角尖，再被构建工具反复教做人。

也算给自己提了个醒：跨平台/跨版本的兼容性问题，先看清楚每一端的下限在哪，再决定架构，比埋头写代码重要得多。
