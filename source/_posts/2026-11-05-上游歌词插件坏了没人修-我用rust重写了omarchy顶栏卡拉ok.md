---
title: 上游歌词插件坏了没人修，我用 Rust 重写了 Omarchy 顶栏卡拉OK
date: 2026-11-08 10:20:00
description: 给 Omarchy 顶栏重写卡拉OK歌词组件的复盘：Rust 后端多词源并发、QML 只管渲染，重点记录 v0.3.9 面板歌词整体消失那次 count=0 的取证排查。
categories:
  - 技术分享
tags:
  - Linux
  - Rust
  - QML
  - Omarchy
---

## 为什么不等上游了

2026-10-28 我把主力机从 Ubuntu 26.04 (GNOME) 重装成 Omarchy 4.0.6（DHH 那个 Arch + Hyprland 发行版），同一天 Hyprland 0.57 发布。听歌主要用 Spotify 和网易云，我想要的效果很朴素：顶栏常驻当前歌曲的逐行同步歌词，点开还有逐词卡拉OK。

![成品顶栏：歌名歌手封面之外，当前行的歌词常驻在栏上，逐词点亮](/posts/omarchy-lyrics-rs/bar.png)

<!-- more -->

Omarchy 插件生态里有现成的 omarchy-lyrics（Python 后端），我装了。结果顶栏小部件永远不渲染，而且没有任何报错日志。我提了 issue：`crmne/omarchy-lyrics#22`「Bar widget never renders on Omarchy 4.0.6 / Quickshell 0.3.2 (service appears unloaded, no errors logged)」，截至 2026-10-31 还是 OPEN，作者零回复；作者当天发的 v1.2.8 只修了专辑封面下载的安全问题，渲染 bug 一个字没碰。

等不起，就自己写。动手前我把原插件翻了一遍，它留下两条死因线索。第一条是 GitHub Copilot Triage 机器人 10-29 自动诊断出的 Bug B，原话：

> "the widget only treats the boolean `true` as enabled, so a stored string `"false"` does not disable hiding. With no service media state, that leaves the widget at **zero width**."

设置文件里存的是字符串 `"false"`，代码只认布尔 `true`，小部件落在零宽度上，于是什么现象都没有。第二条是我自己的复盘结论：静默失败是第一大敌，原插件这个「无报错但不渲染」拖了我一个多星期。所以重写的铁律定成：service 启动、MPRIS 连接、LRCLIB 请求三个关键节点必须留可查日志。

## 脏活全给 Rust，QML 只渲染

架构上我没有犹豫。后端换 Rust 有两个很具体的原因。其一，调试体验差距太大：QML 里做 HTTP 和 DBus 调用，出错往往就是一行静默的 undefined，连子进程 stderr 都拿不到（后面会讲到）；Rust 侧有类型系统、有 tracing、有单测，动态类型的坑在编译期就死掉。其二，进程隔离换来崩溃自恢复：QML 插件跑在 quickshell 本体进程里，插件逻辑炸了可能把整个 shell 一起带走；独立子进程崩了，QML 侧拉起来就行。

最终形态是这样：

```
Service.qml（薄壳：拉起/监控 lyricsd 子进程，stdio 行式 JSON 转属性）
   ├── BarWidget.qml（顶栏小部件：封面 20px 圆角 + 当前行歌词条 + 手势 + 广告字幕）
   └── KeyboardPanel（歌词面板：LyricsView.qml 3 行视窗 + ControlsBar.qml 控制条）
          ▲ bar.shell.serviceFor("local.lyrics-rs") 读 Service 共享属性
lyricsd（Rust 单二进制，~/.local/bin/lyricsd）
   • zbus: MPRIS 500ms 轮询 + 位置外推
   • 多词源并发抓取（ureq，独立阻塞线程，mpsc 回传）
   • 行/词定位（二分 active_line + active_word），只推变更事件
```

设计原则写在 docs 里的一句原话：「所有'会出 bug 的逻辑'（DBus、HTTP、时间同步、类型解析）都在 Rust；QML 只做渲染和点击，QML 里禁止业务逻辑。」

### stdio 行式 JSON 协议

前后端通信全部走 Service.qml 的 SplitParser 逐行 `JSON.parse`。后端推 track/lines/line/position/status/player 七种事件，QML 回发 refresh/seek/toggle 等命令。两个有代表性的事件长这样（backend/src/main.rs 的 emit 点）：

```jsonc
{"ev":"lines","source":"word:lrc.red","synced":[{"t":12.3,"text":"...","words":[[12300,"词"],...]}]} // main.rs:541
{"ev":"line","index":37,"word":5,"text":"...","rich":"<b>已唱</b><span color=\"#888888\">未唱</span>"} // main.rs:578-586
```

`ev=lines` 是查词结果整体下发，`ev=line` 是当前行推进，`rich` 字段直接带拼好的卡拉OK富文本，QML 拿来就能渲染，不用自己算。

日志要单独说一句：quickshell 抓不到子进程 stderr，所以 lyricsd 双写，stderr 一份、`~/.local/state/omarchy-lyrics-rs/lyricsd.log` 每日滚动一份。立项时定的「三个关键节点必须留可查日志」，就是这么落地的。

### 崩溃自恢复

Service.qml 里子进程退出按指数退避重启：1s 起步、上限 30s（`restartDelayMs = Math.min(30000, 1000 * 2^min(exitCount,5))`），存活超过 60s 就把计数清零，避免偶发一次崩溃之后永远等 30s。真机验收直接 `killall lyricsd`，日志链：

```
lyricsd exited code=15 ... restart in 1000ms
backend: started
fetch result lines=32
```

1 秒内检测退出并重启、查词恢复正常。「崩溃自恢复」从设计变成实锤，就是这条日志链。

## 多词源竞争和词级时间轴

查词是四路并发：词级（lrc.red 的 Apple Music TTML ‖ karalyr）与行级（网易 ‖ LRCLIB）独立线程跑，12 秒兜底，词级命中就用词级；行级内部网易优先，因为华语和港乐覆盖更好。providers.rs 的核心是 `std::thread::scope` + mpsc（karalyr/netease/lrclib 三路写法同理，此处省略）：

```rust
    std::thread::scope(|s| {
        s.spawn(move || {
            let query = format!(
                "{} {}",
                lyrics::clean_title(&m1.title),
                lyrics::clean_artist(&m1.artist)
            );
            if let Some(lines) = fetch_lrc_red(&agent1, &query) {
                let _ = ltx.send(Msg::Word("word:lrc.red".into(), lines));
            }
        });
        // ... karalyr / netease / lrclib 三路同理
        let mut word: Option<(String, Vec<Line>)> = None;
        let mut line: Option<(String, Vec<Line>, bool)> = None;
        let deadline = std::time::Instant::now() + Duration::from_secs(12);
        while (word.is_none() || line.is_none()) && std::time::Instant::now() < deadline {
            match lrx.recv_timeout(Duration::from_millis(200)) {
                Ok(Msg::Word(src, lines)) => word = Some((src, lines)),
                Ok(Msg::Line(src, lines, inst)) => {
                    // 行级内部网易优先（华语/港乐覆盖更好），LRCLIB 做兜底
                    let replace = match &line {
                        Some((cur, _, _)) => src == "line:netease" && cur != "line:netease",
                        None => true,
                    };
                    if replace {
                        line = Some((src, lines, inst));
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        result = match (word, line) {
            (Some((src, lines)), _) => Some(FetchResult { source: src, lines, instrumental: false, generation }),
            (None, Some((src, lines, inst))) => Some(FetchResult { source: src, lines, instrumental: inst, generation }),
            (None, None) => None,
        };
    });
```

karalyr 要交代一句：接入时探测覆盖率仍接近 0，是占位，等库长大后零成本生效。行级备选里原本还有个 binimum.org，2026-10-31 实测它的 API 307 重定向到 lrc.red，是同一家，已退役。

### 从时间轴到逐词点亮

词级时间轴到画面的转换全在 Rust 侧，lyrics.rs 的 `rich_markup`：

```rust
/// 当前行卡拉OK富文本：已唱词加粗，未唱词半透明。
pub fn rich_markup(line: &Line, pos_ms: u32) -> String {
    match &line.words {
        Some(words) if !words.is_empty() => {
            let mut out = String::new();
            for w in words {
                let esc = escape_html(&w.1);
                if w.0 <= pos_ms {
                    out.push_str(&format!("<b>{esc}</b> "));
                } else {
                    out.push_str(&format!("<span color=\"#888888\">{esc}</span> "));
                }
            }
            out.trim_end().to_string()
        }
        _ => format!("<b>{}</b>", escape_html(&line.text)),
    }
}
```

已唱词加粗、未唱词置灰 `#888888`；行级降级时没有 words 数组，走 `_` 分支整行加粗。QML 的 delegate 只负责把 rich 塞进 StyledText，一行业务逻辑都没有。

### 查词之外的小活

元数据清洗剥 `(Remastered 2011)`/`(feat. ...)` 这类括号噪音和零宽字符；候选打分移植自原插件 Model.js，时长漂移超过 30s 一票否决；网易曲名常是简体（電燈膽→电灯胆），文本不可靠，所以时长 ±3s 内优先、否则取第一条。缓存按曲目加 15 秒时长桶哈希落盘。还有个兜底：查空后 30s 自动重查同曲最多 3 次，因为 LRCLIB 会间歇 503，真机《電燈膽》复现过全源落空。

## v0.3.9：面板歌词整体消失的取证排查

这一章是全文核心。

起因是我先报了个小问题：「做了自适应面板长度后，有时候歌词上下间距会变大」。原因清楚：3 行视窗的 ListView 用 StrictlyEnforceRange 把当前行钉在正中，列表首尾时被钳住，空位全挤到一侧，看起来像行距突变。865668a 用「模型首尾补空槽」修它，顺带修了 delegate 里 `root.isCurrent` 的静默失效：

```diff
-    model: root.service ? root.service.lines : []
-    currentIndex: root.currentLine
+    // 模型首尾各补 pad 个空槽：列表开头/结尾时当前行也能钉在正中间，
+    // 否则 StrictlyEnforceRange 被钳住，空位全挤到一侧，看起来像行距突变
+    readonly property int pad: Math.floor(root.windowRows / 2)
+    readonly property var paddedLines: {
+      const ls = root.service && root.service.lines ? root.service.lines : []
+      const head = []
+      const tail = []
+      for (let i = 0; i < pad; i++) { head.push(null); tail.push(null) }
+      return head.concat(ls, tail)
+    }
+
+    model: root.hasLyrics ? root.paddedLines : []
+    // 有词但行号未定（-1）时钉到首槽，避免开局闪跳
+    currentIndex: root.currentLine >= 0 ? root.currentLine + pad : 0
```

```diff
-        font.pixelSize: root.isCurrent ? Style.font.heading : Style.font.subtitle
+        font.pixelSize: isCurrent ? Style.font.heading : Style.font.subtitle
```

第二段那个改动的背景：delegate Item 上定义了 `isCurrent`，Text 里却写 `root.isCurrent`，root 是 LyricsView 根，没有这个属性。正唱的行其实一直没用大字号。

结果 865668a 部署后面板歌词彻底不渲染，控制条三键也不居中。我报给 AI 助手的话是：「这次面板直接看不到歌词了，还有你中间三个组件不会自己居中了」。更诡异的是日志里插件零 QML 报错。

### 去 git 历史里找原因

方向是我自己点破的：「你直接去git历史里找原因不就行了」。方案：部署上一正常版 4d56caa 验证「恢复工作」，再换回 865668a 验证「复现故障」，锁定回归窗口就是这一个 commit。每轮实验的固定前置是同一条命令链：

```
rm -rf ~/.cache/quickshell/qmlcache/* && omarchy restart shell && sleep 8 && omarchy shell local.lyrics-rs panel
```

这么执着于清缓存有前科：quickshell 对插件文件的热重载不重编译，「Local plugin changed, reloading」之后新实例仍跑旧字节码，而 qmlcache 对 config 外的插件路径失效不可靠。不清缓存做实验，看到的可能是旧字节码伪装成「改了没生效」，结论不可信。

### 像素取证在暗色桌面下彻底失败

我先走的弯路是截图对比。整屏差集被顶栏时钟和背景变化污染；改 0.15s 间隔连拍找变暗区域；暗色卡片检测出旧版卡片区域有 39630 个变化像素，新版反而有 189323 个——面板不是没内容，而是内容变得巨大。这个方向解释不了任何东西，截图取证在暗色桌面下彻底失效，放弃，转诊断代码。

### 诊断代码自己先翻车两次

第一次：把 Timer 塞进 KeyboardPanel，默认属性 contentItem 只收 Item，整个插件加载失败。第二次：Timer 里裸写 `panelWidth`，qslog 实录：

```
qs://~/.config/omarchy/plugins/local.lyrics-rs/BarWidget.qml[199:-1]: ReferenceError: panelWidth is not defined
```

这两次翻车有个副产品：确认了 qslog 会记录 JS 错误，后面全靠它。

然后是第一条实锤：`model=null, delegates=0`。ListView 的模型绑定算成了 null。但 status IPC 显示数据流完全健康：

```json
{"track":"起風了 (電視劇《加油, 你是最棒的》主題曲)","playing":true,"line":32,"source":"line:netease","status":"","statusMsg":"","sh...
```

（后端日志截取）数据一路推到了 QML 门口，死在最后一步。继续细化：`model=null` 但 `lines=53`，绑定链条断在 paddedLines；`paddedLines` 本身是好好的 55 元素数组，但 `listView.model` 是 undefined——绑定在赋值环节挂了。

### 二分实验锁凶

A/B 换绑实验的完整对照，三组实测输出原样：

```text
X1  model: root.hasLyrics ? root.paddedLines : []
    → count=0

X2  model: root.service.lines（其余不动）
    → [DIAG2] count=51 visible=true effVis=undefined opacity=1 w=332 h=114 parentVis=true rootVis=true rootOp=1 delegates=9

X3+X4  paddedLines 里 null 换成 {}
    → [DIAG2] count=0 visible=true effVis=undefined opacity=1 w=332 h=114 parentVis=true rootVis=true rootOp=1 delegates=0
```

换回 `service.lines` 就 count=51、delegate 正常实例化；`{}` 也 count=0——问题不在 null，而在「model 绑定引用本组件的 var 属性」这件事本身。

### 离屏复现排除 Qt 本体

为了排除是不是 Qt 本体的问题，我做了个脱离 quickshell 的对照实验：写了 5 版测试 QML，用 `QT_QPA_PLATFORM=offscreen timeout 4 /usr/lib/qt6/bin/qml /tmp/nullmodel_test5.qml` 跑。console.log 被 qml 运行时吞掉，改走 journalctl，最终输出：

```
10月 31 23:05:11 omarchy qml[1851405]: RESULT null-model: 4 / 5  obj-model: 4 / 5
```

独立运行时里，混 null 槽、混 {} 槽的 JS 数组模型 delegate 全部正常实例化（4/5 是视口懒加载的正常行为）。null 槽本身不破坏 delegate 实例化，真凶另有其人，问题只在真实 quickshell 环境的 Qt 6.11 里。加上日志侧清白（零 QML 报错、没有其它被吞的错误），结论收拢成一句话：本地拼接的 JS 数组直接赋给 ListView.model，在 quickshell 的 Qt 6.11 下 count=0、delegate 零实例化，与 null 无关。

### 不跟引擎死磕，换官方姿势

修复决策的逻辑很短：`service.lines` 这个 model 在 X2 里已经实证可用，不动模型是最低风险路径；首尾空档的几何效果，ListView 的 header/footer 完全能实现，首行/尾行照样钉正中。不跟引擎内幕死磕，换更干净的官方姿势。4057386 的核心 diff：

```diff
-    // 模型首尾各补 pad 个空槽：列表开头/结尾时当前行也能钉在正中间，
-    // 否则 StrictlyEnforceRange 被钳住，空位全挤到一侧，看起来像行距突变
+    // 首尾各留 pad 个槽位的空档（header/footer 实现，不动模型）：
+    // 列表开头/结尾时当前行也能钉在正中间，否则 StrictlyEnforceRange 被钳住，
+    // 空位全挤到一侧，看起来像行距突变
     readonly property int pad: Math.floor(root.windowRows / 2)
-    readonly property var paddedLines: {
-      const ls = root.service && root.service.lines ? root.service.lines : []
-      const head = []
-      const tail = []
-      for (let i = 0; i < pad; i++) { head.push(null); tail.push(null) }
-      return head.concat(ls, tail)
-    }
+    header: Item { height: listView.pad * root.rowH }
+    footer: Item { height: listView.pad * root.rowH }

-    model: root.hasLyrics ? root.paddedLines : []
-    // 有词但行号未定（-1）时钉到首槽，避免开局闪跳
-    currentIndex: root.currentLine >= 0 ? root.currentLine + pad : 0
+    model: root.hasLyrics ? root.service.lines : []
+    // 有词但行号未定（-1）时钉到首行，避免开局闪跳
+    currentIndex: root.currentLine >= 0 ? root.currentLine : 0
```

控制条三键「看似不居中」与歌词消失是同一根因，一并修复。LyricsView 最终版的关键段（LyricsView.qml:93-110）：

```qml
    // 首尾各留 pad 个槽位的空档（header/footer 实现，不动模型）：
    // 列表开头/结尾时当前行也能钉在正中间，否则 StrictlyEnforceRange 被钳住，
    // 空位全挤到一侧，看起来像行距突变
    readonly property int pad: Math.floor(root.windowRows / 2)
    header: Item { height: listView.pad * root.rowH }
    footer: Item { height: listView.pad * root.rowH }

    model: root.hasLyrics ? root.service.lines : []
    // 有词但行号未定（-1）时钉到首行，避免开局闪跳
    currentIndex: root.currentLine >= 0 ? root.currentLine : 0
    interactive: false

    // StrictlyEnforceRange：无论怎么动，当前行永远钉在视窗正中的槽位
    highlightRangeMode: ListView.StrictlyEnforceRange
    preferredHighlightBegin: height / 2 - root.rowH / 2
    preferredHighlightEnd: height / 2 + root.rowH / 2
    snapMode: ListView.SnapToItem
    cacheBuffer: root.rowH * 4
```

### 收尾验证

修复后 qslog 实测：

```
[DIAG] count=107 delegates=16 contentY=805.1 cur=37
```

对照修复前 X1 的 `count=0` 和 X3+X4 的 `count=0 ... delegates=0`，delegate 终于实例化了。manifest 0.3.9 → 0.3.10，commit 4057386 后 SYNC-OK 同步部署目录，我确认「还有现在不是挺好的吗」。

## 其余的坑，速览

`root.isCurrent` 那例已经在上一章出现过，另一例同类问题更隐蔽——isAd。顶栏广告字幕自 v1 起从未生效，后端识别、Service 状态、status IPC 全部正常，唯独绑定读错了对象，QML 静默返回 falsy 不报任何错。1a6544f 把属性提升到 root：

```diff
+  // 广告插播中（后端识别 Spotify 广告位：artist 空 → status=ad + 广告文案）
+  // 注意：必须挂在 root 上——此前定义在 Text 内部，绑定里 root.isAd 是 undefined，
+  // QML 静默返回 falsy，广告字幕从未生效过
+  readonly property bool isAd: lyricsService ? lyricsService.status === "ad" : false
```

```diff
-    // 当前行歌词条（StyledText，词级已唱加粗/未唱置灰）
+    // 当前行歌词条（StyledText，词级已唱加粗/未唱置灰）；广告插播时显示广告文案
     Text {
       anchors.verticalCenter: parent.verticalCenter
-      readonly property bool isAd: root.lyricsService && root.lyricsService.status === "ad"
       text: root.isAd ? (root.lyricsService.statusMsg || "广告插播中")
```

修完用真实 Bose 广告验证：顶栏渲染出广告文案（OCR 截图实锤），Bose→Pandora 轮换实时跟踪。教训一句话：「属性提升/改名时必须全局搜引用；readonly property 挂错层级比拼错名字更隐蔽。」

其余几个快速过：StyledText 下纯文本被宿主渲染成链接蓝（f11c84d），规则统一为只有富文本歌词用 StyledText，其余一律 PlainText；Spotify 官方 Linux 客户端不接受 MPRIS 对 Shuffle/LoopStatus 的写入，控制条按钮只显示真实状态、点击无效，mpv/VLC 等正常播放器完全可用；`panel.open()` 把 bool 属性当函数调抛 TypeError、面板打不开，改赋值（eec7ff0）；`Color.border` 不存在报 `Unable to assign [undefined] to QColor`，改 `Color.popups.border`（8e18235）；上游 quickshell 偶发 OpenSSL 段错误，栈完全在 libcrypto 的证书解析里（ASN1_item_d2i_ex / OSSL_DECODER / EVP_KEYMGMT_do_all_provided 三帧，转述），调用链是 QML 加载网络封面图 → Qt Network → OpenSSL 后端解析证书。归责上游不修，插件靠两层自愈扛过去：后端子进程退出走指数退避重启，quickshell 整体崩溃由它自带机制自动重启。

### 后端侧的两个真 bug

Rust 侧也不是没踩坑。第一个：zbus 生成 proxy 默认 `CacheProperties::Lazy`，Position 首读后靠 `PropertiesChanged` 更新缓存，而 Spotify 从不发 Position 的 changed 信号，`position()` 永远返回首读值。修复是显式 `.cache_properties(CacheProperties::No)`。

第二个：换曲后旧 track 的查询结果在 12s 兜底窗口内迟到，把新曲刚载入的 lines 清空并误发 no_lyrics，真机复现是越難越愛→Today。修复是 `FetchResult` 加 generation 代号，换曲/refresh 时 `lookup_gen += 1`，收到不匹配的结果按 stale 丢弃。

### 面板几何怎么量

KeyboardPanel 是全屏 layer surface，`hyprctl layers` 只能给表面不能给卡片，只能截图后按内容结构（行间距/高亮带）量。截图里叠着的 Chromium/Spotify 窗口曾把测量带偏：浅色主题下卡片底色与壁纸同系，要锚内部结构不锚底色。像素级验收实例：v0.2.2 卡高实测 379 物理 px（284 逻辑 px × 1.333 屏幕缩放），与理论值分毫不差。

## 这个组件现在的状态

manifest 0.3.10。功能对标上游 omarchy-lyrics：顶栏逐词卡拉OK、歌词面板（3 行视窗、点击跳播、宽度自适配）、鼠标手势（左键面板、右键暂停、中键下一曲、滚轮切歌）、Spotify 广告识别。MIT 开源在 github.com/windy664/omarchy-lyrics-rs，安装两条命令：

```bash
# 1. 构建并安装后端
git clone https://github.com/windy664/omarchy-lyrics-rs.git
cd omarchy-lyrics-rs/backend
cargo build --release
cp target/release/lyricsd ~/.local/bin/

# 2. 安装插件
omarchy plugin add https://github.com/windy664/omarchy-lyrics-rs --enable
```

面板长这样：3 行视窗，当前行钉在正中间，宽高都随内容自适配；原图在仓库 `docs/screenshots/`。

![歌词面板：3 行视窗居中当前行，下方是播放控制条](/posts/omarchy-lyrics-rs/panel.png)

