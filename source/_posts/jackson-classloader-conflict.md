---
title: 我在 fat jar 那篇里警告过的 Jackson 冲突，今天真的炸了
date: 2026-06-13 21:00:00
tags: [Velocity, 类加载, Jackson, Minecraft, 调试]
categories: [工程化]
---

上一篇讲 fat jar 时，我把 relocate（包重定位）写成「以防万一，大多时候没事」。今天它从「以防万一」变成了「救命」——一个 `NoClassDefFoundError` 刷屏，根因正是我当时随口警告的那个。

<!-- more -->

## 现象：内部类找不到，每两秒刷一次

把 Velocity 端和 Bukkit 端合并成一个通用 jar 之后，子服一连上中枢，VC 控制台就开始刷：

```
java.lang.NoClassDefFoundError:
  com/fasterxml/jackson/databind/util/internal/PrivateMaxEntriesMap$WriteThroughEntry
    at ...PrivateMaxEntriesMap$EntryIterator.next(...)
    at ...LRUMap.contents(...)
    at ...ObjectMapper.writeValueAsBytes(...)
    at org.windy.windyagent.bus.socket.FrameCodec.write(...)
```

socket 总线每次序列化消息都走 Jackson，于是每两秒一次。注意一个细节：**报错的不是 Jackson 主类，而是一个内部类** `PrivateMaxEntriesMap$WriteThroughEntry`——外层类明明加载成功了（整条调用链都在跑），偏偏这个内部类找不到。

## 诊断：排除两个最容易想到的原因

**会不会是 shadow 没把这个类打进 jar？** 解开 jar 翻：

```
com/fasterxml/jackson/databind/util/internal/PrivateMaxEntriesMap$WriteThroughEntry.class  ✓ 在
```

20 个内部类一个不少。**不是漏打。**

**会不会是 Jackson 各组件版本劈叉？**（databind 和 core 版本对不上，是这种内部类报错的经典原因。）查全套：

```
jackson-databind / core / annotations / module-kotlin … 全是 2.18.2
```

**版本一致。** jar 里的 Jackson 是完整且自洽的。

两个常规原因都排除了，那答案只剩一个：**类加载器层面的劈叉**——外层类从一份 Jackson 加载，解析内部类时却跑到了另一份没有这个内部类的 Jackson 里。

## 真凶：我不是 classpath 上唯一的 Jackson

这台 VC 上还装着 TabooLib，Velocity 本身也带 Jackson。同一个 `com.fasterxml.jackson` 包，在不同插件的类加载器之间产生了版本劈叉：我的代码触发加载时，外层类和内部类没落在同一份 Jackson 上，链接就断了。

这正是上一篇我写的那句话：

> 如果两个插件都 shade 了 Jackson，但版本不同……大多时候没事，但一旦涉及平台自带库的版本冲突就会爆。

**「大多时候没事」的赌注，今天输了。**

## 为什么是「现在」才炸

之前单独的 Velocity jar 跑得好好的，总线序列化一直正常。为什么合并之后才炸？

因为我把两端合进一个 jar，**类加载器的图变了**。同样一份 Jackson 2.18.2，在新的加载结构里，恰好触发了那个本就潜伏的冲突。这也是这类 bug 最坑的地方：它不是「改错了」，是「环境变了，惊动了原本睡着的雷」。所以我没在「为什么现在才炸」上耗太久——**根治方案跟触发时机无关**。

## 修复：relocate 隔离

```groovy
shadowJar {
    relocate 'com.fasterxml.jackson', 'org.windy.libs.jackson'
    mergeServiceFiles()   // Jackson 的模块靠 SPI 注册，重定位后服务文件要跟着合并
}
```

把整个 Jackson 改名搬进我自己的包。运行时我的代码只认 `org.windy.libs.jackson`，这份只存在于我的 jar 里，谁都撞不着。验证也简单，解 jar：

```
org/windy/libs/jackson/...   ✓ 在
com/fasterxml/jackson/...     ✗ 没了（全被改名）
```

一个**动手前必查**的坑：relocate 改的是字节码里的类引用，**改不了字符串**。如果代码里有 `Class.forName("com.fasterxml.jackson...")` 这种按字符串硬加载的，relocate 之后会找不到类。所以重定位前先全局搜一遍，确认没有字符串硬引用（我这边都是正常 import + 方法调用，安全）。

## 写在最后

上一篇我把 relocate 当成一种「洁癖」，可做可不做。今天的教训是：**当你要把东西发给一堆陌生环境——别人的服、一堆你没听过的插件——你根本控制不了 classpath 上还躺着谁。**

在这种场景里，relocate 通用库（json、http、日志门面）不是洁癖，是生存策略。「大多时候没事」对自己玩的项目够用；对要交付给陌生环境的产物，你赌不起那个「大多时候」。把不确定性提前 relocate 掉，换来的是「在谁的服上都一样」的确定性——这点确定性，值那点 jar 体积。
