---
title: Gradle 的两个 JDK——Gradle JVM 和 Toolchain 到底有什么区别
date: 2026-06-11 21:20:00
tags: [Gradle, 构建工具, JDK]
categories: [工程化]
---

「找到无效的 Gradle JDK 配置」「Gradle 9 要求 JDK 17+，可我项目编译目标是 Java 11」——这些困惑的根源，是没分清 Gradle JVM 和 Toolchain 是两个独立的东西。

<!-- more -->

## 一个让人迷糊的报错

我把项目的编译目标从 Java 25 改成 Java 11 后，IDEA 突然报：

```
找到无效的 Gradle JDK 配置
```

第一反应是：「我不是要 Java 11 吗？把 Gradle 的 JDK 设成 11 不就行了？」——结果设成 11 之后更糟，Gradle 直接起不来，因为 **Gradle 9.x 自己要求 JDK 17+**。

这里的关键，是 Gradle 世界里有**两个完全独立的 JDK 概念**，搞混了就会陷入「按下葫芦浮起瓢」的循环。

## 两个 JDK，各管各的

| | Gradle JVM | Toolchain |
|---|---|---|
| 作用 | 运行 Gradle 工具本身（daemon） | 编译/测试**你的代码** |
| 谁决定 | IDE 设置 / `JAVA_HOME` / `org.gradle.java.home` | `build.gradle` 里的 `java.toolchain` |
| 版本要求 | 取决于 Gradle 版本（Gradle 9 要 17+） | 取决于你的项目目标（我这里要 11） |
| 能一样吗 | 可以不一样 | 可以不一样 |

一句话：**Gradle 用 JDK A 把自己跑起来，然后调用 JDK B 来编译你的代码。A 和 B 完全可以是不同版本。**

我的正确配置是：

- **Gradle JVM** = 本机 Zulu JDK 21（满足 Gradle 9 的 17+ 要求）
- **Toolchain** = Java 11（编译产物字节码 major 55，照顾 Java 11 运行环境）

```groovy
// build.gradle —— 这是 Toolchain，只管编译目标，跟 Gradle 自己用哪个 JDK 无关
java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(11)
    }
}
```

```
# IDEA: Settings → Build Tools → Gradle → Gradle JVM
# 这是 Gradle JVM，选一个 ≥17 的 JDK（我选 Zulu 21）
```

## Toolchain 的妙处：声明式、自动下载

老式做法是 `sourceCompatibility` / `targetCompatibility`，它们只是给 `javac` 传 `-source`/`-target`，**前提是你机器上得有那个 JDK**，否则交叉编译各种坑。

Toolchain 把这件事变成**声明式**：

> 「我这个模块要用 Java 11 编译」——具体去哪找 Java 11、本机没有怎么办，交给 Gradle。

配合 **foojay-resolver-convention** 插件，Gradle 甚至能**自动下载**缺失的 JDK：

```groovy
// settings.gradle
plugins {
    id 'org.gradle.toolchains.foojay-resolver-convention' version '1.0.0'
}
```

这就是为什么我本机只装了 JDK 21，却能编译出 Java 11 字节码——foojay 在背后悄悄拉了个 JDK 11 toolchain。团队协作时尤其香：每个人的 Gradle JVM 五花八门，但只要 toolchain 声明一致，**产物字节码就一致**，不会出现「在我机器上是好的」。

> 顺带一个坑：foojay-resolver `0.8.0` 与 Gradle 9 不兼容——它内部引用了 Gradle 9 已删除的 `JvmVendorSpec.IBM_SEMERU` 字段，升到 `1.0.0` 才好。插件与 Gradle 大版本的兼容性也要留意。

## 为什么 Gradle JVM 不能随便降

Gradle 自身是 Java 写的，每个 Gradle 版本对运行它的 JDK 有最低要求：

| Gradle 版本 | 运行所需最低 JDK |
|---|---|
| Gradle 7 | 8 |
| Gradle 8 | 8 |
| Gradle 9 | 17 |

我把 Gradle JVM 设成 11 后 Gradle 9 起不来，就是撞了这条线。**Gradle JVM 的下限由 Gradle 版本定，跟你项目编译成几不沾边。**

## 心智模型

把它想成做菜：

- **Gradle JVM** = 厨房的灶台（得够新才能开火）
- **Toolchain** = 这道菜要求的火候（可以跟灶台最高功率不同）

灶台再高级，也不妨碍你用小火慢炖一道 Java 11 的菜。

## 面试考点小结

- **Gradle JVM ≠ Toolchain**：前者运行 Gradle 本身，后者编译你的代码，版本相互独立
- **Toolchain 是声明式的**，配合 foojay 可自动下载 JDK，解决「交叉编译要本机有对应 JDK」的痛点
- **Gradle 版本对运行 JDK 有下限**（Gradle 9 → JDK 17+），与项目编译目标无关
- **团队一致性**：统一 toolchain 声明，保证产物字节码一致，避免环境漂移
- **排错思路**：看到「无效的 Gradle JDK」先分清报的是 Gradle JVM 还是 toolchain
