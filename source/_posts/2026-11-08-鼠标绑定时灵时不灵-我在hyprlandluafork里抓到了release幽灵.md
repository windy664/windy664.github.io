---
title: 鼠标绑定时灵时不灵，我在 Hyprland Lua fork 里抓到了 release 幽灵
date: 2026-11-08 21:30:00
tags:
  - Linux
  - Omarchy
  - Hyprland
  - Rust
  - 折腾
categories:
  - 踩坑
description: 点击 dock 图标自动收回抽屉这个小功能，做出来却时灵时不灵。排查一路从日志被自己删掉，查到 hyprctl binds 里一个从没主动要过的 release flag，最后 29 次点击 29 次命中收尾。
---

我的桌面上有一个「抽屉」：按 Super+S 呼出一个 special workspace（`special:scratchpad`），里面塞着 QQ、Spotify 这类常驻但不想占工作区的窗口，再按一次收回去。上一篇文章结尾提过 dock 会把这个抽屉掏空，那是 dock 的最小化逻辑误伤，修完之后我又盯上了另一个不顺手的地方：抽屉开着的时候，点一下抽屉外面的任何地方，它应该自己收回去，就像 macOS 上点开一个菜单再点别处菜单自动收起。翻遍 Omarchy 的设置，没有这个功能，于是我决定自己写一个，顺便开源成了 [dock-minimize-rs](https://github.com/windy664/dock-minimize-rs)。

这个功能的最终形态很小：一个 Rust 写的一次性检查命令，加一条鼠标绑定。但通往最终形态的路上，我撞上了「时灵时不灵」这种最烦人的 bug——功能大多数时候正常，偶尔失灵，复现规律找不到，日志里一片空白。这篇按时间线把整个排查过程记下来，包括我自己把证据销毁掉的那段。

<!-- more -->

## 先让事件守护干这活，结果它抢跑

第一版方案没碰鼠标绑定，走的是 Hyprland 事件订阅：`drawer-watch watch`，一个常驻小守护进程，连上 Hyprland 的 socket2 事件口，盯 `activewindowv2` 事件（焦点变化），发现焦点落在抽屉外的窗口上就把抽屉收回去。核心循环长这样：

```rust
for line in reader.lines() {
    let line = line?;
    if let Some(addr) = line.strip_prefix("activewindowv2>>") {
        if addr.trim().is_empty() {
            continue;
        }
        let Some(cmd_sock) = get_hypr_socket() else { continue };
        let Some(special) = open_special_name(&cmd_sock) else {
            continue; // 没有抽屉开着，什么都不做
        };
        let Some(active_ws) = active_window_workspace(&cmd_sock) else {
            continue;
        };
        if active_ws != special {
            stash(&cmd_sock, &special, "focus moved outside");
        }
    }
}
```

逻辑看着严丝合缝：焦点出去了才收，焦点在抽屉里不动。装上实测，抽屉确实会收——但我只是把鼠标划过去，根本没点，它就收了。我给 agent 的反馈原话是：「这次是鼠标浮到外面抽屉就收回去了 我要的是那种点击外部再收的」。

原因很快想明白了：Omarchy 默认开着 `input:follow_mouse = 1`，焦点跟着鼠标走，鼠标划过窗口焦点就切过去，`activewindowv2` 照发，守护进程照收。悬停和点击在事件层面长的一模一样，这条路线区分不了二者。要区分，就得把判断挪到鼠标按键本身上去。

## 换鼠标绑定，先撞上 fork 的第一层墙

思路换成：给鼠标左键（button 272，`mouse:272`）绑一个钩子，每次点击时跑一次检查，抽屉开着且光标不在抽屉窗口上就收回去。这个方案后来定型成 `drawer-watch click`，一个跑完就退的一次性命令。

第一个坑在绑定之前就等着：这套 Omarchy 的 Hyprland 是带 Lua 配置的 fork（0.57.0），dispatch 的参数是按 Lua 表达式解析的。也就是说原生 Hyprland 那套 `dispatch toggle_special scratchpad` 的字符串写法在这里发不出去，得包一层 fork 提供的 `hl.dsp.*`：

```lua
-- 可用
hl.dsp.exec_cmd("/home/torin/.local/bin/drawer-watch click")
hl.dsp.workspace.toggle_special("scratchpad")

-- 原生写法，多数失效
-- dispatch toggle_special scratchpad
```

配套的命令行工具也不全：`hyprctl keyword` 直接回 "unknown request"，改配置只剩改 Lua 文件加热重载这一条路。另外抽屉开着的时候，`hyprctl j/activeworkspace` 报的还是底下的普通工作区，special workspace 只在 `j/monitors` 的 `specialWorkspace` 字段里露面。这是后话，先记下。

mouse bind 的合法写法，文档里没有，最后是从 Hyprland 二进制里 `strings` 出来的：`hl.bind` 接受一个 options 表，`click = true` 表示点击绑定，`mouse = true` 是拖拽绑定，二者互斥（错误信息是 "mouse is exclusive"），`non_consuming = true` 表示不吞掉事件。我当时的第一版绑定是这样的：

```lua
hl.bind("mouse:272", hl.dsp.exec_cmd("/home/torin/.local/bin/drawer-watch click"),
        { click = true })
```

`click = true` 的语义直觉上非常对路：绑定在鼠标松开时触发，也就是"点完一下才收"，这不就是我要的点击外部收回吗。还顺手把 `input:special_fallthrough` 打开了，让点击能穿透抽屉落到下层窗口：

```lua
-- ~/.config/hypr/input.lua
hl.config({
  input = {
    special_fallthrough = true,
  },
})
```

`drawer-watch click` 的判断逻辑：

```rust
fn click() {
    let Some(cmd_sock) = get_hypr_socket() else { return };
    let Some(special) = open_special_name(&cmd_sock) else { return }; // 没抽屉开着
    if cursor_over_drawer_window(&cmd_sock, &special) {
        return; // 点在抽屉自己的窗口上，保持打开
    }
    stash(&cmd_sock, &special, "outside click");
}
```

装上，试，抽屉能收。当时是 11 月 1 日凌晨，我把这个版本提交成 `f77f1ac drawer-watch: click-to-stash mode, the recommended setup`，觉得这活收工了。

## 时灵时不灵

用了一个小时，反馈来了：「还是没反应呀」。改。又试，「ok」。再试，「不行」。

这种"有时好有时坏"的反馈最磨人：你没法定义失败条件，也就没法稳定复现。能做的只有加日志，看失败的点击到底卡在哪一步。我在 `click()` 的每个分支都埋了 trace，写进 `/tmp/drawer-watch.log`：没 socket 写一条，没抽屉写一条，点在抽屉窗口上写一条，收回写一条。理论上任何一次点击，不管结果如何，日志里都应该多一行。

然后我看到了日志，整个文件只有一行：

```
stash special:scratchpad (outside click)
```

一行成功的 stash，时间是上午 10:31。这之前用户（就是我自己）明明点过好几次、失败过好几次，日志里却什么都没有。没有失败记录，连「没抽屉开着」这种日常记录都没有。这指向一个比「判断逻辑写错」严重得多的事实：**失败的点击，二进制压根没有被调起来**。绑定钩子本身就没触发，后面所有逻辑根本没机会跑。

头号嫌疑很快找到了：`hyprctl binds` 里有一条 Omarchy 自带的 `mouse:272` 绑定，「Move window」，拖拽移动窗口用的。同样的按键上挂着两条绑定，它把按下事件抢走消费掉，我的绑定自然收不到。对策是给我的绑定加 `non_consuming = true`，声明不消费事件、各走各的：

```lua
hl.bind("mouse:272", hl.dsp.exec_cmd("/home/torin/.local/bin/drawer-watch click"),
        { click = true, non_consuming = true })
```

加上之后确实好了一些——至少 10:31 那次成功过。但很快，反馈升级成了那句定性的话：「抽屉问题那个有时候正常有时候失败」。加了 non_consuming，问题从「完全不行」变成了「时灵时不灵」。升级方向对了，但真凶不在那。

## 日志先毁尸灭迹，再谈定位

上午 10:34，我（通过 agent）重新检查日志文件，又只看到一行 stash，还是 10:31 那条。这不对：从 10:31 到 10:34 之间用户点过鼠标、失败过，trace 是追加写，失败记录去哪了？

回头读代码，问题出在日志写入的实现上：其中一条写入路径用了 `std::fs::write`。这个函数是**截断写**，每次调用把整个文件清空重写。于是每一次成功的 stash，都会把之前积累的所有失败记录一并抹掉。10:31 那次成功的 stash，销毁了它之前的一切证据。我在找失败现场，而我的日志代码每次成功都把现场抹掉了。

这是整个排查里最蠢也最值得记的一幕：不是 Hyprland 的坑，是我自己的日志代码在"成功时清空日志"。修法很简单，统一走一个追加写的 `log()`，`stash()` 也改过去：

```rust
fn log(msg: &str) {
    eprintln!("drawer-watch: {msg}");
}
```

同时给 `click()` 补上光标位置的记录，让每条日志都带上现场：

```rust
fn click() {
    let Some(cmd_sock) = get_hypr_socket() else {
        log("click: no command socket");
        return;
    };
    let cursor = hypr_cmd(&cmd_sock, "cursorpos");
    let Some(special) = open_special_name(&cmd_sock) else {
        log("click: no drawer open");
        return;
    };
    if cursor_over_drawer_window(&cmd_sock, &special) {
        log("click: cursor over drawer window, keep open");
        return;
    }
    log(&format!("click: stashing {special}, cursor was {cursor:?}"));
    stash(&cmd_sock, &special, "outside click");
}
```

重编译装好，然后被动观察：什么都不改，等着用户（还是我自己）正常用电脑，45 秒里任何一次左键点击都应该留下日志。45 秒后看日志——零条。绑定确实一次都没触发。铁证：问题在绑定的触发环节，不在判断逻辑。

## 真凶在 hyprctl binds 的 flags 里

绑定注册了吗？触发条件是什么？`hyprctl binds` 会列出每条绑定的完整属性。找到我的那条：

```
bind
	flags: release, non_consuming, click
	modmask: 0
	submap:
	key: mouse:272
	keycode: 0
	catchall: false
	description:
	dispatcher: HL.Dispatcher(exec_cmd)
```

三个 flag 并排躺在那里，其中 `release` 非常扎眼——我从头到尾没有主动要求过 release 语义。翻 Lua stub 里的绑定选项（`click`、`release`、`long_press`、`transparent`）再对照行为，结论出来了：**这个 fork 里 `click = true` 隐含了 `release`**，click 绑定统一在松开时触发。这解释了它为什么"语义直觉正确"，也埋下了雷。

雷怎么爆的？机制层面只能推断，但拼图是完整的：`non_consuming = true` 的含义是按下事件放行给窗口表面——这正是点击穿透所必需的；而 release 绑定的回调，依赖按下那一下在绑定状态机里留下的状态。按下被放走了，状态机经常没走到"等待 release"那一拍，等你松开按键，回调直接丢掉。点空桌面偶尔能成（按下路径碰巧走通），点窗口上就常常丢（按下被表面接走）。这就是"时灵时不灵"的全部内容：release 回调能否活着，取决于按下那一下落在什么表面上——一个从绑定声明上完全看不出来的隐式依赖。

## 修复，去掉 click = true

既然 `click = true` 隐含 release 而 release 不可靠，那就不要它。普通绑定（不带 click flag）的 mouse:272 在按下时触发，按下触发不依赖松开路径，没有可丢的回调：

```lua
hl.bind("mouse:272", hl.dsp.exec_cmd("/home/torin/.local/bin/drawer-watch click"),
        { non_consuming = true })
```

`hyprctl reload` 之后验证注册状态：

```
bind
	flags: non_consuming
	modmask: 0
	submap:
	key: mouse:272
	keycode: 0
	catchall: false
	description:
	dispatcher: HL.Dispatcher(exec_cmd)
```

flags 里只剩 `non_consuming`，`release` 和 `click` 都消失了，触发时机变成按下即触发。

这个改动有两个副作用，都想过。一是按下触发意味着"点击"提前了一瞬，对收回抽屉这个动作没有影响；二是每次左键按下都会跑一遍 `click()`——抽屉没开时就是两次 IPC 查询（查 monitors 确认没有 special workspace）然后退出，开销可以忽略。点在抽屉自己的窗口上时，`cursor_over_drawer_window` 会按矩形判定放行，抽屉保持打开，这也是原逻辑。

## 30 次点击 30 次命中

剩下的是量化验证。我正常使用电脑两分半钟，随便点，然后看日志：

```
[02:38:15.515] click: no drawer open
[02:38:16.305] click: no drawer open
[02:38:26.006] click: no drawer open
[02:38:27.046] click: no drawer open
[02:38:28.771] click: no drawer open
[02:38:30.793] click: no drawer open
[02:38:32.040] click: no drawer open
[02:38:32.958] click: no drawer open
[02:38:35.137] click: no drawer open
[02:38:36.590] click: no drawer open
[02:38:39.620] click: no drawer open
[02:38:41.296] click: no drawer open
[02:38:41.632] click: no drawer open
[02:39:45.833] click: no drawer open
[02:39:49.854] click: no drawer open
[02:39:51.723] click: no drawer open
[02:39:53.250] click: no drawer open
[02:39:53.722] click: no drawer open
[02:39:54.573] click: no drawer open
[02:39:55.417] click: no drawer open
[02:39:55.830] click: no drawer open
[02:40:03.189] click: no drawer open
[02:40:05.372] click: no drawer open
[02:40:13.431] click: no drawer open
[02:40:17.774] click: no drawer open
[02:40:35.594] click: no drawer open
[02:40:36.548] click: no drawer open
[02:40:40.404] click: no drawer open
[02:40:44.706] click: no drawer open
```

30 行，30 次点击，一次不少（时间戳是 UTC，本地时间 10:38 到 10:40）。抽屉没开着，所以每条都是 "no drawer open"——这条日志本身就是要的结果：它证明**每一次左键按下，钩子都触发了**。对比改成按下触发之前，同样是被动观察，45 秒零记录。绑定从"经常丢"变成了"每次都在"。抽屉开着的实际收回场景，之后实点验证也没有再失手过。

10:43，修复提交：`0ab15ef Fix intermittent outside-click stash; document fork release-bind gotcha`，commit message 里同时记了两件事：修掉间歇性失灵，以及把 fork 的 release 陷阱写进 README：

> **Fork gotcha:** do *not* add `click = true` on this Hyprland Lua fork. Click-flag binds fire on button *release*, and with `non_consuming` set the release callback is regularly dropped, so the stash only works intermittently (the bind registers as `release` in `hyprctl binds` — that's the tell). A plain non-consuming bind fires on press and fires every time; verified against 29/29 real clicks.

最后的成品是三段配置加一个小工具。`input.lua` 里放行点击穿透，`bindings.lua` 末尾一条按下触发的非消费绑定：

```lua
-- ~/.config/hypr/input.lua — 让点击穿透抽屉落到下层窗口
hl.config({ input = { special_fallthrough = true } })

-- ~/.config/hypr/bindings.lua — 点击抽屉外部收回它
hl.bind("mouse:272", hl.dsp.exec_cmd("/home/torin/.local/bin/drawer-watch click"),
        { non_consuming = true })
```

因为绑定不消费事件、fallthrough 又开着，同一次点击在收回抽屉的同时，还能落到下层窗口上完成焦点切换——点一下，两件事都办了，和 macOS 的体验一致。

## 顺手记两条 fork 硬知识

排查过程中挖出来的两个坑，跟这次 bug 无关，但做任何 special workspace 相关的逻辑都会撞上，记在这里。

第一条：抽屉（special workspace）开着的时候，`hyprctl j/activeworkspace` 报的仍然是底下的普通工作区，special workspace 只出现在 `j/monitors` 里每个显示器的 `specialWorkspace` 字段。所以 `drawer-watch` 判断"有没有抽屉开着"从来不查 activeworkspace，而是遍历 monitors：

```rust
fn open_special_name(cmd_sock: &Path) -> Option<String> {
    let monitors: Value = serde_json::from_str(&hypr_cmd(cmd_sock, "j/monitors")).ok()?;
    monitors.as_array()?.iter().find_map(|m| {
        let name = m
            .get("specialWorkspace")
            .and_then(|sw| sw.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        }
    })
}
```

调试 special workspace 逻辑时如果一直"看不到抽屉开着"，先检查是不是查错了字段。这条后来也写进了 README 的 quirk 段。

第二条：抽屉窗口的命中判定用的是最朴素的矩形包含——取 `j/clients` 里所有属于抽屉工作区的窗口，拿光标坐标对着每个窗口的 `at` + `size` 做包含测试：

```rust
if cx >= x && cx < x + w && cy >= y && cy < y + h {
    return true;
}
```

光标落在任何一个抽屉窗口的矩形里就保持打开。两个窗口的矩形并集中间如果有视觉空隙，点在空隙上也会被判成"点在抽屉上"——目前抽屉里 QQ 和 Spotify 的窗口几乎是拼满的，这个误差可以接受，真遇上再说。

## 复盘

回头看，这个 bug 的每一步都有迹可循，只是当时看不见。

时灵时不灵的根源，是 release 回调的存活依赖按下路径的状态，而按下路径的状态取决于点击落在什么表面上。表现出来的"随机"，底下是完全确定的条件分支，只是条件藏在了 `hyprctl binds` 的 flags 里，绑定声明上看不出来。以后在这套 fork 上做鼠标绑定，我落地第一件事就是 `hyprctl binds` 看注册出来的 flags——声明写的是什么不重要，注册成什么样才作数。

另一个教训花了我更久才咽下去：从 11 月 1 日凌晨第一版 click 绑定，到上午 10 点真正开始排查，中间的每一次"不行"，失败证据都被 `stash()` 里那次截断写抹掉了。等我想看现场的时候，现场已经被自己人清得只剩一条成功记录。修 bug 先修日志，这句话我以前当口号听，这次是照着日志文件里仅剩的一行字体会到的。

至于同一晚并行折腾的颜色过饱和、模拟调亮度，那是另外两个故事，等它们也水落石出再写。
