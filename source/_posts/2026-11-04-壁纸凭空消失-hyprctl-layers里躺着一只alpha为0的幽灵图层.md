---
title: 壁纸凭空消失，hyprctl layers 里躺着一只 alpha 为 0 的幽灵图层
date: 2026-10-22 01:21:00
tags:
  - Linux
  - Omarchy
  - Hyprland
  - quickshell
  - 折腾
categories:
  - 踩坑
description: 桌面壁纸突然没了，应用和顶栏却都正常。一查不是壁纸守护进程挂了，而是 quickshell 背景图层的 alpha 卡在 0，连官方 IPC 都救不回来。
---

我的主力机已经换成 Omarchy 一个月，壁纸系统出过两回幺蛾子。第一回是锁屏后 DPMS 唤醒，壁纸层被重建给刷没了，那件事十天前的文章已经写过，我也给上游交了 issue。第二回就是昨天——壁纸突然没了，但屏幕里其它东西都在，顶栏、dock、QQ、浏览器全正常，只有背景变成了一片深色。锁屏并没有触发，所以这次不能再赖 DPMS。

这篇记第二回的排查过程。关键词是 `hyprctl layers`、`alpha = 0`、以及 Omarchy 源码里一段赤裸裸的注释。

<!-- more -->

## 先怀疑最老派的原因

看到壁纸消失，第一反应是壁纸守护进程死了。在 GNOME 时代这种症状见得太多，多半是设置壁纸的后台进程（swww、hyprpaper、nitrogen 之类）挂掉或者软链接失效。我第一反应就是列进程：

```bash
$ pgrep -af "swww|hyprpaper|mpvpaper|wpaperd"
$
```

一个都没有。但 Omarchy 4.x 本来就不用这些。它整个桌面壳（顶栏、dock、壁纸、锁屏）都是 quickshell 一层一层画出来的，壁纸不是后台程序在"设置"，而是 quickshell 自己注册了一个 `WlrLayer.Background` 图层，在上面画一张 `Image`。

这个结构不算秘密，但网上讲 Omarchy 4 壁纸机制的文章不多。简单说：

- 当前壁纸的真实路径存在 `~/.local/state/omarchy/current/background` 这个软链接里；
- quickshell 的 `Background.qml` 插件里有一个 `readlinkProc`，定时 `readlink -f` 读这个软链接；
- 读出来的路径交给 `Image` 组件作为 `source`，铺满整个屏幕的 layer-shell 背景层；
- 插件同时暴露了一个 IpcHandler，target 叫 `background`，外部进程可以通过 `quickshell ipc call background setInstant <path>` 强制刷新。

所以我先看软链接有没有坏：

```bash
$ ls -la ~/.local/state/omarchy/current/background
lrwxrwxrwx 1 torin torin 86 11月 3日 23:29 background -> /home/torin/.cache/random-wallpapers/bing-thidOHRSchwarzwaldAutumn_ZH-CN6323627599.jpg

$ readlink -f ~/.local/state/omarchy/current/background
/home/torin/.cache/random-wallpapers/bing-thidOHRSchwarzwaldAutumn_ZH-CN6323627599.jpg
$ f=$(readlink -f ~/.local/state/omarchy/current/background)
$ [[ -n "$f" && -f "$f" ]] && echo "EXISTS: $f" || echo "MISSING"
EXISTS: /home/torin/.cache/random-wallpapers/bing-thidOHRSchwarzwaldAutumn_ZH-CN6323627599.jpg
```

软链接和目标文件都活着，不是传统意义上的"壁纸丢了"。那只能是图层本身出了问题。

## hyprctl layers 把病灶照出来

`hyprctl layers` 会列出每个输出上所有 layer-shell 表面的位置和元数据。之前修锁屏壁纸 bug 时用过它，这次我又把它翻出来。输出是这样的：

```
Monitor HDMI-A-1:
	Layer level 0 (background):
		Layer 56085cfdf6a0: xywh: 0 0 2048 1152, a: 0, namespace: omarchy-background, pid: 2879929
	Layer level 1 (bottom):
	Layer level 2 (top):
		Layer 56085b4ce430: xywh: 0 0 2048 26, a: 1, namespace: omarchy-bar, pid: 2879929
		Layer 56085c356bc0: xywh: 879 1092 290 54, a: 1, namespace: omarchy-dock, pid: 2879929
	Layer level 3 (overlay):
```

三个图层来自同一个 quickshell 进程（pid 2879929），分辨率也对。但 bar 和 dock 的 `a:` 都是 1，只有 background 的 `a:` 是 0。

这里的 `a` 我理解成 alpha（quickshell 内部也用这个字母表示透明度），0 就是完全不可见。所以症状不是壁纸没了，而是壁纸层被系统认为透明度为 0。顶上没东西压着它，但 compositor 就是把它当成透明在混成。结果整个桌面只剩 compositor 的默认背景色，看起来壁纸消失。

## IPC 刷新，没用

quickshell 给 `Background.qml` 注册了 IpcHandler，target 叫 `background`，有几个方法：

```qml
IpcHandler {
  target: "background"

  function refresh(): void {
    root.refreshBackground()
  }

  function set(path: string): void {
    root.setBackground(path, false)
  }

  function setInstant(path: string): void {
    root.setBackground(path, true)
  }
}
```

理论上可以绕开 `readlink` 轮询，直接让 quickshell 重设壁纸。我试了两条命令：

```bash
$ quickshell -p /usr/share/omarchy/shell ipc call background setInstant \
    "/home/torin/.cache/random-wallpapers/bing-thidOHRSchwarzwaldAutumn_ZH-CN6323627599.jpg"
```

命令没报错，但 `hyprctl layers` 再看，background 仍然是 `a: 0`。又试了一次 `background refresh`，结果一样。

这说明问题不在壁纸路径解析，也不在 `Image` 组件加载图片。调用 `setInstant` 时 quickshell 确实会重新设置 `displayedBackground`，但 layer-shell 表面的可见性状态在 compositor 那头已经卡死，quickshell 这一侧再刷新也推不动 alpha 值。

## 源码里早就承认了

卡住之后我又去翻 `Background.qml` 源码，想确认是不是我漏了什么开关。翻到 `PanelWindow` 那一段，有一行注释直接让我笑了：

```qml
PanelWindow {
  id: panel
  ...
  color: "transparent"
  // Keep render updates enabled. The background layer has been observed to
  // lose its committed buffer while parked with updatesEnabled=false,
  // leaving a black desktop until omarchy-shell is restarted. The wallpaper
  // itself is static, so this favors correctness over a small render-loop
  // optimization.
  updatesEnabled: true
```

注释说：背景层曾经被观察到"在 parked with updatesEnabled=false 的状态下丢失已提交的缓冲区"，表现就是黑桌面，必须重启 omarchy-shell。Omarchy 为了绕过这个毛病，已经把 `updatesEnabled: true` 写死了。也就是说，这个 bug 上游（quickshell 或 Hyprland 的 layer-shell 实现）本来就有，Omarchy 用了 keep-updates-enabled 来缓解，但看来还是没完全挡住。

我这次触发它的条件不是 updatesEnabled=false，而是用户正常使用中突然就 alpha=0 了。具体触发条件我不清楚，可能是 quickshell 内部某个渲染状态机和 compositor 的 layer alpha 同步断了。总之这是一个 Omarchy 官方都知道但没根除的问题，注释本身就是诊断书。

## 重启 shell，最朴素的解

既然 IPC 刷新不管用，源码注释的终极解就是重启 omarchy-shell：

```bash
$ omarchy-restart-shell
```

等几秒再看：

```
Monitor HDMI-A-1:
	Layer level 0 (background):
		Layer 56085cfdf6a0: xywh: 0 0 2048 1152, a: 1, namespace: omarchy-background, pid: 1218438
```

同一个 layer ID（56085cfdf6a0），但进程 pid 换成了 1218438，`a:` 也恢复成 1。壁纸回来了。重启 shell 的几秒钟里顶栏和 dock 会闪一下，因为 quickshell 整个进程被拉起；不过所有样式覆盖（`~/.config/omarchy/shell.toml`、`shell.json`）都是持久化的，重启后毛玻璃、图标、透明参数都会原样恢复，不需要重新调。

## 顺手破的另一起悬案

排查这桩壁纸案的时候，我还顺带找到了之前顶栏毛玻璃"莫名失效"的真凶。不是 bug，是 feature：同一个 quickshell 的 `Bar.qml` 里，顶栏空白处双击会切换毛玻璃。

```qml
onDoubleClicked: function(mouse) {
  if (suppressClick) {
    suppressClick = false
    return
  }
  if (mouse.button === Qt.LeftButton) {
    root.toggleTransparency()
    mouse.accepted = true
  }
}
```

`toggleTransparency()` 会翻转 `~/.config/omarchy/shell.json` 里的 `bar.transparent`。之前顶栏毛玻璃突然变成全白，我还以为是什么主题切换的 bug，结果发现是双击顶栏空白处误触了。再双击一次就恢复。这个手势没有 UI 提示，文档里也不容易找到，堪称另一个"alpha 陷阱"。

## 复盘

壁纸消失和顶栏变白的两个 case，表面症状不同，根子却有点相通：它们都是 quickshell 图层状态的问题，而且状态变化的原因藏在用户看不到的手势或内部状态机里。

这次排查给我的提醒有三条：

第一，Omarchy 4.x 的壁纸不是由 swww、hyprpaper 这类独立守护进程负责的，而是 quickshell 的 layer-shell 图层。遇到壁纸没了，先看 `hyprctl layers`，再看目标文件，比传统思路快。

第二，quickshell 暴露的 IPC 接口（`quickshell ipc call background ...`）能刷新壁纸路径，但刷新不了已经卡死的 layer alpha。官方源码的注释已经写明 restart shell 是兜底方案，不用犹豫。

第三，这类 layer-shell 桌面的调试信息其实就在手边：`hyprctl layers`、`hyprctl clients`、quickshell 的 IpcHandler，都是直接看 compositor 状态的窗口。问题不是黑盒，只是症状很容易让你往错误方向联想。

锁屏后壁纸黑的 issue（omacom/omarchy#12554）我月初已经交了，等待上游。昨天这出非锁屏触发的新剧情，我也准备整理一下追加到同一个 issue 里，或者单独开一条。至少现在，再遇到这种情况，我不会先跑去检查壁纸文件了。
