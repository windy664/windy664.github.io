---
title: 为什么 Velocity 插件必须打 fat jar——插件类加载与依赖隔离
date: 2026-06-11 22:00:00
tags: [Velocity, 类加载, Gradle, Minecraft]
categories: [工程化]
---

写 Velocity 插件时，把第三方库（OkHttp、Jackson、SDK…）直接 `implementation` 进去，运行时一加载就 `ClassNotFoundException`。原因是 Velocity 不会帮你下载运行时依赖——你必须自己打 fat jar。

<!-- more -->

## 现象

我的 Velocity 插件依赖了好几个库：anthropic SDK、OkHttp、Jackson、SnakeYAML。本地编译一切正常，丢进服务器一启动：

```
java.lang.NoClassDefFoundError: okhttp3/OkHttpClient
```

编译期能找到、运行期找不到——这是典型的「依赖没被打进产物」。

## 根因：Velocity 不管你的第三方库

不同平台对「插件的第三方依赖」处理方式差别很大：

| 平台 | 第三方库怎么来 |
|---|---|
| Bukkit/Spigot | `plugin.yml` 的 `libraries:` 声明，服务器启动时从 Maven 下载 |
| Paper | Plugin Loader / library loader，可声明 Maven 坐标自动拉取 |
| **Velocity** | **没有等价机制——你得自己把库打进 JAR** |

Velocity 在加载插件时，只保证 **Velocity API 本身**（以及它自带的 gson、guava、netty、adventure 等）在 classpath 上。你额外引的库，它一概不管。所以解决办法只有一个：**把依赖 shade 进插件 JAR**，即打 fat jar（uber jar）。

## 用 Shadow 打 fat jar

Gradle 用 `com.gradleup.shadow` 插件：

```groovy
plugins {
    id 'org.jetbrains.kotlin.jvm' version '2.2.20'
    id 'com.gradleup.shadow' version '9.4.2'
}

dependencies {
    // Velocity 运行时自带，编译可见、不打包
    compileOnly 'com.velocitypowered:velocity-api:3.1.1'

    // 这些 Velocity 不提供，必须 shade 进 JAR
    implementation 'com.anthropic:anthropic-java:2.34.0'
    implementation 'com.squareup.okhttp3:okhttp:4.12.0'
    implementation 'com.fasterxml.jackson.core:jackson-databind:2.17.0'
    implementation 'org.yaml:snakeyaml:2.2'
}

shadowJar {
    archiveClassifier.set('')   // 产物就叫 xxx.jar，不带 -all 后缀
}
```

两个关键点：

- **`compileOnly` vs `implementation`**：平台**运行时已提供**的（velocity-api）用 `compileOnly`——编译时要它做类型检查，但不能打进 JAR（否则和平台自带的冲突）。平台**不提供**的用 `implementation`，由 shadow 打包。
- **fat jar 的本质**：把所有 `implementation` 依赖的 class 解压、合并进同一个 JAR。

## 类加载隔离：为什么要 relocate

Velocity 给每个插件一个**独立的 PluginClassLoader**。这带来一个隐患：如果两个插件都 shade 了 Jackson，但版本不同，各自的 classloader 加载各自的版本——大多时候没事，但一旦涉及平台自带库的版本冲突就会爆。

典型场景：Velocity 自带了某版本的 gson/guava，你的依赖又传递引入了**另一个版本**并 shade 进来，运行时就可能 `NoSuchMethodError`。

解法是 **relocate（包重定位）**——把 shade 进来的库改个包名：

```groovy
shadowJar {
    relocate 'com.fasterxml.jackson', 'org.windy.windyagent.libs.jackson'
    relocate 'okhttp3', 'org.windy.windyagent.libs.okhttp3'
}
```

这样你的 `org.windy.windyagent.libs.jackson` 跟任何人的 `com.fasterxml.jackson` 都不会撞车。代价是 JAR 变大、构建变慢，但换来确定性——对要发给一堆陌生服主的插件来说，这个确定性很值。

> 经验法则：**只 relocate 那些容易和平台/其他插件冲突的通用库**（json、http、日志门面等）。冷门、专用的库一般不必。

## 顺带：fat jar 会不会很大

会。anthropic SDK 拖着 OkHttp、Kotlin stdlib 一堆传递依赖，最终 JAR 轻松上十几 MB。优化手段：

- `minimize()`：shadow 做 tree-shaking，删掉没被引用到的 class（但对反射加载的库要小心，可能误删）
- 把可选 Provider 拆成独立产物，按需分发

## 面试考点小结

- **平台依赖模型差异**：Bukkit/Paper 有运行时库加载机制，Velocity 没有，必须 fat jar
- **`compileOnly` vs `implementation`**：区分「平台已提供」与「需自带」，是插件依赖管理的核心判断
- **插件类加载隔离**：每个插件独立 classloader，既隔离也可能因 shade 引入版本冲突
- **relocate（包重定位）**：解决 shade 库与平台/其他插件的版本冲突，用确定性换体积
- **fat jar 取舍**：体积 vs 确定性，可用 `minimize()` 或拆产物缓解
