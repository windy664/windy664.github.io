---
title: "四个 AI Agent，四种生态位——Hermes、Harness、Codex、OpenCode 源码深度对比"
date: 2026-08-17 12:00:00
tags: [Agent, LLM, 架构, 开源, Rust, TypeScript, Python, 源码分析]
categories: [AI 应用]
---

四个项目，四种语言，四种完全不同的工程哲学。

工程化的终点是 AGI。这四个项目的代码差异，表面上是架构选择，本质上是对同一个叩问的不同回答：如何让一个智能体可靠地、安全地、可扩展地存在于世界之中？

| 维度   | Hermes Agent     | DeepSeek Harness | OpenAI Codex     | OpenCode          |
| ---- | ---------------- | ---------------- | ---------------- | ----------------- |
| 语言   | Python + Node.js | TypeScript       | Rust             | TypeScript + Bun  |
| 架构   | 巨型类 + 模块提取       | 依赖注入 + 事件溯源      | Trait 抽象 + Actor | C/S + Effect      |
| 核心理念 | 从经验中学习           | 一切皆插件            | 沙箱优先安全           | 模型自由 + Plan/Build |
| 定位   | 自进化 Agent        | 插件化框架            | 编码 Agent CLI     | 模型中立编码 Agent      |

<!-- more -->

[TOC]

AutoGPT 在 2023 年 3 月点燃了「让 LLM 自主操作计算机」的想象，随后 LangChain、AutoGen、MetaGPT 各自定义了多智能体协作的范式。那些项目证明了可能性，但大多停留在概念验证阶段。真正的工程化分化发生在 2025-2026 年：Hermes 走自进化路线，DeepSeek 做插件化框架，OpenAI 押注沙箱安全，OpenCode 以模型中立填补了社区的空白。它们不是竞争对手，是四个不同的生态位。

前三个是厂商主导的项目，各自带着不同的工程基因。第四个 OpenCode 是社区驱动的开源方案，2026 年初因 Anthropic 第三方工具禁令爆发式增长。同一个问题，四个团队给出的答案差异大到像是在做不同的产品。

---

## 一、都是什么来头

### 为什么选这四个

市面上开源 Agent 框架多如牛毛，但大多数停留在「OpenAI API 包装 + 循环」的 demo 阶段，不具备真正的工程完整性。AutoGPT、LangChain Agent、CrewAI 等项目在概念验证上各有贡献，但它们要么止步于原型，要么需要用户自己搭建大量基础设施。本文选取的四个项目走到了下一步：**怎么把 Agent 做成真正能用的工程产品。**

此外，笔者还要单独提一句：在所有模型中立方案中，OpenCode是唯一达到 12.8 万 Stars、支持 100+ Provider 的项目，2026 年初因 Anthropic 第三方工具禁令爆发式增长，填补了「不被厂商锁定」的生态位。

### 技术栈选型的逻辑

你可能会问：为什么 Hermes 选 Python？为什么 Codex 用 Rust？为什么 OpenCode 用 Bun？

这些选择背后不是随机的——每个项目都有自己的「技术门派」：

**Python 派：Hermes Agent**

Nous Research 是做 LLM 微调的团队，Python 是 ML 生态的母语，所有模型权重、推理代码、训练脚本都是用 Python 写的，Agent 不用 Python 反而奇怪。但有意思的是，Hermes 同时重度使用了 Node.js：TUI 用 Electron、Web Dashboard 用前端框架、桌面应用跨平台。这是一个「Python 做大脑，Node.js 做界面」的混合架构——大脑用 Python，门面用 Node。

**TypeScript 派：DeepSeek Harness**

DeepSeek Harness 是 TypeScript 里最讲究的那一支。它本质上是一个框架，需要极强的组合能力。TypeScript 的类型系统 + Cordis 的依赖注入 + pnpm workspace 的 monorepo 管理，让它能把 100+ 个包组织成一个可扩展的整体。

**Rust 派：OpenAI Codex**

一开始你会觉得有点用力过猛——写个 CLI 至于用 Rust 吗？但仔细想想，Codex 需要跨平台沙箱（macOS Seatbelt、Linux Landlock、Windows ACL），需要高性能的终端 UI（ratatui），需要安全的进程隔离。这些场景下，Rust 的性能和安全性是压倒性的。而且 OpenAI 有足够的 Rust 工程师来撑这个选择——不是每个团队都敢在 CLI 项目里上 Rust 的。

**Bun + Effect 派：OpenCode**

这是最年轻也最激进的门派。Bun 的启动速度比 Node.js 快一个数量级（冷启动 ~30ms vs ~200ms），原生 SQLite 支持避免了 `better-sqlite3` 的编译问题，而且 Bun 兼容大部分 Node.js 生态。配合 Effect 框架，OpenCode 获得了类型安全的依赖注入、结构化并发、资源管理——这些在 Node.js 里需要大量样板代码才能实现。社区项目敢选 Bun + Effect 而不是保守的 Node.js，说明 Bun 在 2026 年已经足够成熟，也说明 OpenCode 的维护者偏好「新工具」胜过「稳工具」。

---

## 二、整体架构设计：四种完全不同的哲学

### 2.1 Hermes Agent：巨型类的渐进式拆分

Hermes 的核心类 `AIAgent` 定义在 `run_agent.py` 里。它的 `__init__` 方法有 47 个显式参数，整个函数体只有一行——转发给 `agent.agent_init.init_agent()`。

这 47 个参数只是冰山一角，完整的构造函数签名在迭代中膨胀到了 60+ 个，但大部分被合并或隐藏了。原始的 `run_conversation` 方法有 3900 行。

这听起来像是反模式，但 Hermes 的做法很有意思。它采用了一种「**提取 + 转发器**」的渐进式重构模式：

1. 大方法被提取到 `agent/` 目录下的独立模块中
2. 提取后的函数以 `agent` 作为第一个参数（本质上变成了方法，但写在模块级别）
3. `AIAgent` 上保留一个薄薄的转发方法
4. 测试中 `patch("run_agent.X")` 的契约通过 `_ra()` 懒导入保持兼容

> `Hermes: agent/`（模块拆分目录）

```
agent/
├── agent_init.py          # 初始化逻辑（~1400行）
├── conversation_loop.py   # 对话循环
├── tool_executor.py       # 工具执行
├── context_compressor.py  # 上下文压缩
├── anthropic_adapter.py   # Anthropic 适配
├── gemini_native_adapter.py
├── bedrock_adapter.py
├── subagent_lifecycle.py  # 子 Agent 生命周期
└── ...                    # 60+ 个模块
```

**这个模式的核心思路是：不改变外部接口，只改变内部实现。** `AIAgent` 的使用者不需要知道方法已经被提取到独立模块了——转发方法保证了 API 兼容。这是一种非常务实的重构策略，特别适合大型 Python 项目。

Hermes 的模块依赖链也设计得很巧妙，专门处理了循环导入问题：

> `Hermes: tools/registry.py` → `agent/conversation_loop.py`

```
tools/registry.py  (不导入 model_tools 或工具文件)
    ↑
tools/*.py  (在模块级别导入 tools.registry)
    ↑
model_tools.py  (导入 tools.registry + 所有工具模块)
    ↑
Hermes: run_agent.py, cli.py, batch_runner.py
```

### 2.2 DeepSeek Harness：一切皆插件

DeepSeek Harness 的架构可以用一句话概括：**一切皆 Cordis 插件**。

Cordis 是一个依赖注入和生命周期管理框架，它的设计哲学来自北京大学与 DeepSeek 合作的论文 *A Programming Paradigm for Spatiotemporal Composability*（Shi et al., 2026）。该论文提出了「时空可组合性」理论，核心思想是：

- **时间可组合性**：组件卸载后，它产生的副作用（事件监听、服务注册、定时器）必须能被完整撤销。论文用「可逆效应」（revertible effects）解决——**每个对上下文的修改都配有一个显式的逆函数**。
- **空间可组合性**：组件之间的依赖关系——A 声明需要 B 的能力，当 B 被替换或移除时，A 自动感知并响应。

**它甚至并非纸上谈兵——Koishi 聊天机器人框架用这套机制跑了四年、超过 4000 个社区插件。** 这篇文章里的「事件溯源」「不可变日志」「水龙头拦截」，理论源头都在这篇论文里。

在 Cordis 的世界里：

- 每个服务通过 `ctx.provide()` 提供，通过 `ctx.inject()` 或 `ctx.get()` 消费
- 每个插件挂载得到一个 `Fiber`，有生命周期状态（ACTIVE、UNLOADING、DISPOSED、FAILED）
- 通过 `ctx.effect()` 注册清理逻辑
- 通过 `ctx.on()` 订阅事件

**「能力接缝」模式** 是 DeepSeek Harness 最核心的设计模式。每个主要子系统都有三个角色：

> `DeepSeek: packages/core/`（Cordis 服务架构）

```
1. 服务定义（Service Definition） — 抽象接口和事件
   例：@deepseek-ai/dsh-sandbox

2. 服务提供者（Service Provider） — 具体实现
   例：@deepseek-ai/dsh-sandbox-local

3. 消费者（Consumer） — 使用该能力的工具或功能
   例：@deepseek-ai/dsh-tool-bash
```

这意味着你可以替换任何子系统的实现，只要它满足接口契约。比如你想换一个沙箱后端，只需要写一个新的 Service Provider，不需要改动任何消费者代码。

整个 monorepo 有 100+ 个包，按领域组织：

> `DeepSeek: packages/`（monorepo 目录结构）

```
packages/
├── core/           # 核心：agent、agent-loop、session、scope、tools
├── llm/            # LLM 集成：llm、llm-deepseek、llm-pi-ai、llm-retry
├── shell/          # Shell 执行：tool-bash
├── fs/             # 文件系统：tool-fs
├── sandbox/        # 沙箱：sandbox、sandbox-local
├── client/         # 客户端：40+ UI 组件包
├── interaction/    # 交互：user-approval、permission-presets
├── boot/           # 启动：app-boot
└── ...
```

### 2.3 OpenAI Codex：Rust crate 的模块化拆分

Codex 的架构是典型的 Rust 风格——**每个关注点一个 crate**，通过 Trait 定义抽象接口。

> `Codex: codex-rs/`（crate 目录结构）

```
codex-rs/
├── cli/            # 入口点，clap 命令解析
├── core/           # 核心：Agent 循环、会话、工具路由
├── protocol/       # 共享类型定义
├── tools/          # 工具抽象（ToolExecutor Trait）
├── sandboxing/     # 平台沙箱
├── model-provider/ # 模型提供者抽象
├── config/         # 分层配置系统
├── tui/            # ratatui 终端 UI
├── exec/           # 非交互执行
├── ollama/         # Ollama 本地模型
├── lmstudio/       # LM Studio 本地模型
└── ...             # 100+ 个 crate
```

Codex 的核心抽象是 Trait。比如工具系统的 `ToolExecutor`：

> `Codex: codex-rs/tools/src/tool_executor.rs`

```rust
// codex-rs/tools/src/tool_executor.rs
pub trait ToolExecutor<Invocation>: Send + Sync {
    fn tool_name(&self) -> ToolName;
    fn spec(&self) -> ToolSpec;
    fn exposure(&self) -> ToolExposure;
    fn search_info(&self) -> Option<ToolSearchInfo>;
    fn handle(&self, invocation: Invocation) -> ToolExecutorFuture<'_>;
}
```

**`ToolExposure` 控制工具的可见性**：`Direct`（始终可见）、`Deferred`（可通过工具搜索发现）、`CodeModeOnly`、`Hidden`。这是一种很精细的工具管理方式——不是所有工具都需要直接暴露给模型。

Codex 的通信模式是 Actor/Channel 风格：组件之间通过 `async_channel` 和 `tokio::sync::watch` 通信，事件从核心 Agent 循环流向 TUI 或 app-server。

### 2.4 OpenCode：Client-Server + Effect 的类型级工程

OpenCode 的架构跟前三个都不一样。它是一个 **Client-Server-Agent 三层架构**，而且用了一个大多数前端工程师可能都没听过的框架：**Effect**（一个 TypeScript 的 effect 系统）。

OpenCode 的核心源码在 `packages/opencode/src/` 目录下：

> `OpenCode: packages/opencode/src/`（核心源码结构）

```
packages/opencode/src/
├── server/          # HTTP Server（Effect HttpRouter + HttpServer）
│   ├── server.ts    # 服务端入口，REST + WebSocket + SSE
│   └── routes/      # 15+ 路由模块：session、config、provider、permission...
├── agent/           # Agent 定义（build/plan/general/explore 四种角色）
├── session/         # 会话管理（SQLite + Drizzle ORM）
├── tool/            # 工具系统（Effect Schema 定义参数）
├── provider/        # 100+ Provider 集成（models.dev 目录 + AI SDK）
├── config/          # 8 层配置合并
├── cli/             # CLI + TUI（yargs + @opentui/solid）
└── ...
```

**为什么是 Client-Server？** 因为 OpenCode 要同时服务多种接入方式——你可以用 CLI 一次性运行任务（`opencode run "msg"`），也可以用交互式 TUI（`opencode --mini`），还可以 attach 到已经运行的服务器上（`opencode --mini --attach http://localhost:4096`），甚至以无头模式跑一个常驻服务（`opencode serve`）。

这种多端接入需求，决定了 OpenCode 需要一个独立的 Server 层。它基于 Effect 的 `HttpRouter`/`HttpServer` 实现，对外提供 REST API、WebSocket（用于 PTY 事件流）和 SSE（用于实时事件推送），甚至支持 mDNS 做局域网服务发现。

这意味着多个客户端可以 attach 到同一个 Server，Session 在客户端断开后仍然存活，Server 可以同时服务 Web UI、桌面 App 和 CLI。

**Effect 框架是 OpenCode 的骨架。** 它不是某个库的依赖。它就是运行时：

> `OpenCode: packages/opencode/src/provider.ts`

```typescript
// provider.ts — 用 Layer 组装 Provider
const ProviderLive = Layer.merge(
  Layer.succeed(Config, config),
  Layer.succeed(ModelsDev, modelsDev)
).pipe(Layer.provide(InstanceLayer))
```

Effect 给了 OpenCode 什么？
- **Layer/Context**：类型安全的依赖注入（比 Cordis 更严格的编译时检查）
- **Fiber**：结构化并发——子 Agent 可以跑在独立 Fiber 里，父 Agent 取消时自动清理
- **Stream**：流式处理 LLM 响应，自带背压和错误处理
- **Schema**：编译时类型校验——工具参数定义就是 Schema，JSON Schema 自动派生
- **Deferred**：权限请求/响应的异步协调——用户在 TUI 里按 Y/N，服务端 Deferred 解析

**四种 Agent 角色**（`agent.ts:140-180`）：

| 角色 | 能力 | 用途 |
|------|------|------|
| build（默认） | 全部工具 | 正常编码 |
| plan | 只读 + plan_exit | 先规划再执行 |
| general | 子 Agent | 复杂多步骤任务 |
| explore | 只读子Agent | 代码探索 |

Plan/Build 的切换不是 CLI flag——是运行时 Agent 切换。Plan Agent 被权限规则限制，**LLM 物理上不能调用 edit 工具**。当它调用 `plan_exit` 时，系统询问用户是否批准，批准后注入一条合成用户消息，Session 无缝切到 Build Agent。这个设计比 Hermes/Codex/Claude Code 的「全有或全无」权限模型精细得多。

### 2.5 架构风格对比

看完四个项目的具体架构，现在做一个横向对比：

| 维度 | Hermes | DeepSeek | Codex | OpenCode |
|------|--------|----------|-------|----------|
| 核心模式 | 巨型类 + 模块提取 | 依赖注入 + 事件溯源 | Trait 抽象 + Actor | C/S + Effect 框架 |
| 组合方式 | 函数提取 + 转发器 | 插件挂载 + Fiber | Crate 拆分 + Trait | Layer + Fiber |
| 依赖管理 | 懒导入 + 循环导入保护 | Cordis ctx.provide/get | Rust 模块系统 | Effect Layer/Context |
| 扩展点 | 工具注册表 + 技能系统 | 插件接口 + 能力接缝 | Trait 实现 + 插件系统 | Agent 角色 + .opencode/plugin |
| 类型安全 | 运行时（Python） | 编译时（TypeScript） | 编译时（Rust） | 编译时（Effect Schema） |
| 重构策略 | 渐进式提取 | 插件替换 | Crate 独立演进 | Agent 角色切换 |
| 独特能力 | 技能自进化 | 事件溯源可逆性 | 平台级沙箱 | Plan/Build + 100+ Provider |

### 2.6 工程代价：这些东西只有跑起来才知道

**Hermes：巨型类的维护地狱**

`AIAgent` 的构造函数长这样：

> `Hermes: run_agent.py#L435`

```python
class AIAgent:
    def __init__(
        self,
        base_url: str = None,
        api_key: str = None,
        provider: str = None,
        api_mode: str = None,
        acp_command: str = None,
        # ... 省略 20 个参数 ...
        tool_progress_callback: callable = None,
        tool_start_callback: callable = None,
        thinking_callback: callable = None,
        clarify_callback: callable = None,
        read_terminal_callback: callable = None,
        read_preview_callback: callable = None,
        # ... 再省略 20 个参数 ...
        checkpoint_max_snapshots: int = 20,
        checkpoint_max_total_size_mb: int = 500,
        pass_session_id: bool = False,
        requested_provider: str = None,
    ):
        """Forwarder — see ``agent.agent_init.init_agent``."""
        from agent.agent_init import init_agent
        init_agent(self, base_url=base_url, api_key=api_key, ...)  # ← 全部转发
```

**47 个显式参数，整个函数体就一行转发。** 这在 Python 里意味着什么？意味着你加一个新功能，得先数清楚这 60 个参数里哪些是你要用的。更棘手的是，你漏传一个参数，Python 并不报错——直到深层代码用到这个参数时才炸，堆栈信息指向 `init_agent()` 内部，跟调用者隔了五六层。半夜被叫醒追了半天，才发现是一个参数没传。

然后你开始查堆栈。`Hermes: run_agent.py` → `Hermes: agent/conversation_loop.py` → `Hermes: agent/tool_executor.py` → `Hermes: tools/terminal_tool.py`。追了五层，你发现自己在调试一个 3900 行的函数里提取出来的模块，而这个模块是你同事三个月前拆的，他早就忘了为什么要拆成那样。

`_ra()` 懒导入解决了循环导入：

> `Hermes: agent/conversation_loop.py#L465`

```python
def _ra():
    """Lazy reference to ``run_agent`` so callers can patch
    ``run_agent.handle_function_call`` / ``run_agent._set_interrupt`` /
    ``run_agent.OpenAI`` and have those patches reach this code path.
    """
    import run_agent     # ← 函数内 import，每次调用都走一遍模块查找
    return run_agent
```

但 IDE 再也跳转不到真正的定义了。你按着 Ctrl 点进去，跳到的是 `_ra()` 那个包装函数。开始怀念 Java——至少 Spring 能告诉你 bean 在哪个文件里。

这还不是最恶心的。当你改了一个内部模块的位置，`patch("run_agent.X")` 的测试全部静默失效，20 个 CI 任务全红，报错信息指向一个你已经删掉的函数名。你花两个小时才反应过来：「哦，那个测试还在 mock 旧的导入路径。」

**DeepSeek Harness：太优雅了，优雅到新手想死**

Cordis 这套依赖注入写得很漂亮，但漂亮不等于好用。

新人来了，你让他改个工具执行的超时时间。他打开代码，发现需要先理解 `ctx.provide`、`ctx.inject`、`Fiber` 生命周期、`waterfall` 拦截器、`scope` 隔离、`initiator` 链——改个超时参数，却要理解一套论文级别的概念。等他终于搞懂了，已经把原本要改的那个 bug 忘干净了。

然后 monorepo 开始教你做人。你改了一个底层包，`pnpm build` 提示你要重新构建 30 个依赖包。你按下回车，去接杯水，回来还没跑完。再等一会儿，构建失败了。因为某个你根本没碰过的包有循环依赖。你不想查了，决定先 `git push`，让 CI 帮你跑，然后你下班了。第二天来看 CI 还是红的，因为你忘记更新一个类型定义。

**Codex：Rust 写 Agent，你是认真的吗？**

Rust 很安全，但安全是有代价的。

你改了一行代码，`cargo build`，然后去厕所。回来发现还在编译。又刷了会儿手机，终于过了。但 CI 告诉你 macOS 的 Seatbelt 沙箱规则在旧版本上行为不一致，Linux 那边 Landlock 需要内核 5.13+，Windows 的 ACL 语义跟 Unix 完全不同。你忍不住想：「我只是改了一个命令白名单，为什么要测三个操作系统？」

沙箱默认太严格了，以至于 Agent 连 `ls /usr/include` 都跑不了。你让 Agent 编译一个简单的 C 项目，它上来就报错："Permission denied: /usr/include/stdio.h"。不得不花半天时间调沙箱策略，把 `/usr` 加到白名单里。但加完之后又怕了：Agent 现在是不是能改系统库了？不知不觉活成了一个「策略管理员」，而不是一个 Agent 开发者。

新人想贡献代码，要先学 Rust 的所有权和生命周期，再搞懂 100+ crate 的依赖图，最后还得理解 Landlock 的路径规则是怎么设计的。等他能写出第一个 PR，一个月过去了。项目维护者说你改的 `ToolExecutor` Trait 影响了 15 个实现，需要全部更新——他想了想，「算了，这活儿我自己干吧。」

**OpenCode：Effect 的学习曲线比项目本身还高**

Effect 框架是个好东西。类型安全的依赖注入、结构化并发、自动资源管理。问题是：**你得先学 Effect。** 你打开 `provider.ts`，看到 `Layer.merge`、`Layer.provide`、`Effect.gen`、`Context.Tag`、`Stream.tap`——这些概念在 TypeScript 生态里不常见，大多数前端工程师可能连 `Either` 和 `Option` 都没用过。你得先读完 Effect 的文档（几百页），再理解 OpenCode 怎么用 Effect，然后才能开始改代码。

Bun 运行时也是个变量。Bun 1.3.14 已经很稳定了，但有些 npm 包还是会在 Bun 上跑出奇怪的行为。你 `bun install` 一个依赖，发现它要编译 native 模块，Bun 的编译支持不如 Node.js 成熟——然后去搜 issue，发现有人三个月前就报了同样的 bug，维护者说「等 Bun 修复」。默默地 `bun add` 了一个 workaround。

社区项目的维护质量是个问号。OpenCode 的核心维护者可能就那么几个人。你提了一个 PR，等了两周没人 review；你报了一个 bug，被标记为 「needs-triage」 然后就沉了。这不是 OpenCode 的问题。所有社区项目都有这个风险。但当你的生产环境依赖它的时候，这个风险就变成了你的风险。

### 2.7 运行时代价：跑起来才知道的钱和泪

上面是开发者的痛苦，现在是用户的痛苦。

**启动时各项目在干什么？**

Hermes 第一次调 Anthropic 的时候会卡一下：

> `Hermes: agent/anthropic_adapter.py#L47`

```python
# NOTE: `import anthropic` is deliberately NOT at module top — the SDK pulls
# ~220 ms of imports (anthropic.types, anthropic.lib.tools._beta_runner, etc.)
_anthropic_sdk: Any = ...  # sentinel

def _get_anthropic_sdk():
    global _anthropic_sdk
    if _anthropic_sdk is ...:
        from tools.lazy_deps import ensure as _lazy_ensure
        _lazy_ensure("provider.anthropic", prompt=False)  # ← 没装会自动装
        import anthropic as _sdk        # ← 这里吃 220ms
        _anthropic_sdk = _sdk
    return _anthropic_sdk
```

**220ms 是注释里自己写的，不是我估的。** 而且注意 `_lazy_ensure`。如果 anthropic 包没装，它会自动 `pip install`。这意味着第一次调用可能还要加上下载安装的时间。懒加载是权衡启动内存和首次调用延迟的典型 Python 策略——启动时不花 220ms，但第一次 API 调用要花。对 CLI 工具来说这是合理的选择：大多数命令不需要调 LLM。

Codex 的 WebSocket 预热反过来。你在打字的时候它就先把连接建好了，按回车的时候响应飞快。代价是你需要维持一个长连接在后台跑着，资源开销不小。你开十个会话试试，你的笔记本风扇会感谢你。WebSocket 预热把延迟从请求时前置到了空闲时——适合长会话、多轮对话的场景，但对「开一下就关」的用法来说是浪费。

DeepSeek Harness 启动时要把 100+ 个包的依赖图解析一遍，Cordis 那一套初始化跑完需要点时间。但跑起来之后，所有东西都是编译时确定的，运行开销反而是最小的——前提是你有耐心等它启动。入口在 `boot()` 函数——创建 Cordis Context、安装 Loader 插件、挂载根 Include、等待整棵树 settle、最后审计所有 fiber 是否激活：

> `DeepSeek: packages/boot/app-boot/src/index.ts#L757`

```typescript
export async function boot(
  binName: string,
  absoluteConfigPath: string,
  patches?: PatchOptions[],
  prepare?: (ctx: Context) => Promise<void> | void,
  bareModuleBaseUrl?: string,
): Promise<Context> {
  const ctx = new Context()
  let stage = 'host preparation failed'
  try {
    ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
    ctx.provide('dshHomePath', dshHomePath)
    await ctx.plugin(Loader)          // 安装 Cordis Loader
    await prepare?.(ctx)
    stage = 'plugin tree failed to load'
    await mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl)
    await ctx.get('loader')?.await()  // 等待整棵插件树 settle
    await assertEntriesActivated(ctx, binName)  // 审计：所有 fiber 必须 ACTIVE
    return ctx
  } catch (cause) {
    await ctx.fiber.dispose()
    throw new Error(`${binName}: ${stage}: ...`, { cause })
  }
}
```

这个 `await ctx.get('loader')?.await()` 是关键——它等整个依赖图 resolve 完。每个 fiber 的激活取决于它的 `inject` 依赖是否全部就绪：

> `DeepSeek: vendor/cordis/src/fiber.ts#L611`

```typescript
_refresh() {
  let epoch: string | boolean = false
  epoch = ''
  for (const name of Object.keys(this.inject)) {
    const impl = this._store[name]
    if (!impl) {
      epoch = INACTIVE   // 有一个依赖没就绪 → 整个 fiber INACTIVE
      break
    }
    epoch += ':' + impl.fiber.uid  // 依赖指纹变化 → 触发重载
  }
  this._setEpoch(epoch)
}
```

`_setEpoch()` 是状态机：epoch 从 INACTIVE 变为有效值时触发 `_reload()`（加载插件），反过来触发 `_unload()`（卸载）。**每个 fiber 独立追踪自己的依赖状态**，一个 provider 上线，所有依赖它的 fiber 自动刷新——这就是 Cordis 的「反应式依赖图」。248 个 `package.json` 的依赖图解析，是 Cordis 反应式依赖注入的启动成本——运行时零开销的代价，是启动时要把整张图编译完。

OpenCode 用 Bun，冷启动大概 30ms。比 Node.js 快一个数量级。但启动之后要初始化 Effect Runtime、加载 100+ Provider 的 models.dev 目录、解析多层配置合并——这些加起来可能要 500ms+。

启动入口在 CLI 的 `index.ts`——整个应用就是一条 Effect 管道：

> `OpenCode: packages/cli/src/index.ts#L27`

```typescript
Runtime.run(Commands, Handlers, { version: "local" }).pipe(
  Effect.provide(Daemon.layer),      // 守护进程层
  Effect.provide(NodeServices.layer), // Node 平台服务层
  Effect.scoped,                      // 资源作用域
  NodeRuntime.runMain,                // 启动 Effect Runtime
)
```

`ManagedRuntime.make()` 会把所有 Layer 编译成一张依赖图，这就是「初始化需要点时间」的原因——每个 Layer 的 `build` 都要跑一遍。

Provider 加载通过 models.dev API 拉取全量目录：

> `OpenCode: packages/core/src/models-dev.ts#L175`

```typescript
const fetchApi = Effect.fn("ModelsDev.fetchApi")(function* () {
  return yield* HttpClientRequest.get(`${source}/api.json`).pipe(
    HttpClientRequest.setHeader("User-Agent", USER_AGENT),
    http.execute,
    Effect.flatMap((res) => res.text),
    Effect.timeout("10 seconds"),
  )
})
```

配置合并从全局目录往上遍历，离项目越近的配置优先级越高：

> `OpenCode: packages/core/src/config.ts#L186`

```typescript
const configs = [...(supplementary[0] ?? []), ...direct, ...supplementary.slice(1).flat()]
// global config → project files → .opencode files
```

好消息是 Bun 的 SQLite 是原生的——`bun:sqlite` 直接编译进 Bun 运行时，不需要 `better-sqlite3` 那套 node-gyp + C++ 编译：

> `OpenCode: packages/core/src/database/sqlite.bun.ts#L1`

```typescript
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
```

坏消息是如果你挂了 10 个 MCP Server，每个都要走一次握手（`client.connect()` 默认超时 30 秒）：

> `OpenCode: packages/opencode/src/mcp/index.ts#L218`

```typescript
const connectTransport = Effect.fn("MCP.connectTransport")(function* (
  transport: Transport, timeout: number,
) {
  // ...
  return withTimeout(client.connect(t), timeout).then(() => client)
})
```

10 个 MCP Server 串行握手，每个 30 秒超时上限——启动时间直接翻倍不是开玩笑。Effect Runtime 初始化 + 100+ Provider 加载 + MCP Server 握手，是类型安全框架的启动税：你获得了编译时保证和可组合性，但启动时要把所有 Layer 编译完、所有 Provider 拉下来、所有 Server 连上。

启动之后，用户真正在意的是两件事：响应速度和会话能跑多久不崩。启动速度决定了第一印象，会话的内存管理决定了能用多久。**会话状态管理的完整架构在第七章展开，这里只从「运行时代价」的角度看内存和压缩的实际影响。**

**会话长了，内存就开始教你做人。**

Hermes 的 `IterationBudget` 长这样：

> `Hermes: agent/iteration_budget.py#L17`

```python
class IterationBudget:
    def __init__(self, max_total: int):
        self.max_total = max_total      # 父500，子50
        self._used = 0
        self._lock = threading.Lock()

    def consume(self) -> bool:
        with self._lock:
            if self._used >= self.max_total:
                return False
            self._used += 1
            return True

    def refund(self) -> None:           # ← execute_code 可以退还
        with self._lock:
            if self._used > 0:
                self._used -= 1
```

预算控制本身没问题。但 `AIAgent` 对象把整段对话历史都怼在内存里。你跑一个 200 轮的长任务，打开 `htop` 看着内存一点点往上爬，心里默念「别崩别崩别崩」。

DeepSeek 的事件日志也值得一看。它会一直 append，500 轮可能累积 2000 多个事件对象。`deriveMessages()` 缓存命中时是增量处理，开销不大。但你触发 compaction 试试——`replaceGeneration` 变了，缓存清空，全量重建。Compaction 把旧消息替换成摘要，上下文缩短，LLM 的行为自然会变。

> `DeepSeek: packages/core/session/src/index.ts#L425`

```typescript
export class Session {
  private log: SessionEvent[] = []       // ← append-only，只增不减
  private readonly surfaceManager = new SurfaceManager(this.log)

  deriveMessages(): Message[] {
    const generation = this.surface.replaceGeneration
    if (generation !== this.derivedGeneration) {
      this.derived = []                  // ← 截断后缓存清空，全量重建
      this.derivedNodes = 0
      this.derivedGeneration = generation
    }
    for (const seq of this.surface.nodes.slice(this.derivedNodes)) {
      const msg = this.deriveEventMessage(this.log[seq]!)
      if (msg) this.derived.push(msg)    // ← 增量追加，不重算已有部分
    }
    this.derivedNodes = this.surface.nodes.length
    return [...this.derived]
  }
}
```

截断日志 → `replaceGeneration` 变化 → 缓存失效 → 从头重建。缓存本身没问题，但 compaction 丢失的上下文是找不回来的。

Codex 的 Rollout 序列化到磁盘，内存里只保留当前状态，看起来最聪明。但当你恢复一个 300 轮的大会话时，反序列化那个 JSON 文件的过程慢得让你怀疑自己是不是用 Rust 写了一个 Python 脚本。

> `Codex: codex-rs/rollout/src/recorder.rs#L86`

```rust
pub struct RolloutRecorder {
    tx: Sender<RolloutCmd>,
    writer_task: Arc<RolloutWriterTask>,
    pub(crate) rollout_path: PathBuf,    // ← 文件路径：rollout-<时间戳>-<会话ID>.jsonl
}

// 写入格式：
// $ jq -C . ~/.codex/sessions/rollout-2025-05-07T17-24-21-xxx.jsonl
// 冷数据自动压缩为 .jsonl.zst（zstd）
```

每次工具调用、LLM 响应都追加一行 JSON。恢复时从头 replay——300 轮就是 300+ 行 JSON 逐条解析。

OpenCode 用 SQLite 存 Session（通过 Drizzle ORM），理论上是最稳的。数据库在 Bun 里是原生的，不需要额外的序列化/反序列化。但问题在于 OpenCode 的 Compaction 用了一个专门的 LLM Agent 来做摘要——这意味着压缩本身要花 token、花时间、花钱。而且当 Compaction Agent 摘要的质量不好的时候（比如把关键的技术细节丢了），后续对话就开始出问题。你看着账单上多出来的几美元，安慰自己「至少比 Hermes 便宜」。

> `OpenCode: packages/core/src/session/compaction.ts#L160`

```typescript
export const buildPrompt = (input: {
  readonly previousSummary?: string
  readonly context: readonly string[]
}) => {
  const conversation = `Here is the conversation so far:\n\n<conversation>\n${input.context.join("\n\n")}\n</conversation>`
  if (!input.previousSummary)
    return [conversation,
      "Create a new anchored summary from the conversation history...",
      SUMMARY_TEMPLATE,
    ].join("\n\n")
  // 有旧摘要时，增量更新
  return [conversation,
    `Here is the summary before the <conversation> above:\n\n<prior-summary>\n${input.previousSummary}\n</prior-summary>`,
    SUMMARY_UPDATE_INSTRUCTIONS, SUMMARY_TEMPLATE,
  ].join("\n\n")
}

// 调用 LLM 流式生成摘要（compaction.ts#L201）：
const summarized = yield* dependencies.llm
  .stream(LLM.request({
    model: input.model,
    messages: [Message.user(summaryPrompt)],
    tools: [],
    generation: { maxTokens: summaryOutput },
  }))
```

**上下文压缩是个无底洞。**

Hermes 每压缩一次要调用辅助模型。辅助模型的选择有明确的性能排序：

> `Hermes: agent/auxiliary_client.py#L765`

```python
# Order is measured, not guessed — p50 on a real titling prompt against the
# Nous catalog: gpt-mini-latest 1.40s, claude-haiku-latest 1.55s,
# gemini-flash-latest 2.13s, step-3.7-flash 7.84s, grok-4.1-fast 8.05s.
_FAST_MODEL_FAMILIES: tuple = (
    "gpt-mini-latest",
    "gpt-nano-latest",
    "claude-haiku-latest",
    "gemini-flash-latest",
    # ...
)
```

压缩器用这些廉价模型做摘要——一次 2-5 秒，吃掉几千 tokens。长任务里可能压缩 3-5 次，累计多花 10-25 秒。你觉得"几分钱算什么"，然后回去看 API 账单，发现这个月在压缩上花了 30 刀。因为你的 Agent 天天在跑长任务。

Codex 有两种压缩模式。Token-budget 模式直接开新窗口，不调模型：

> `Codex: codex-rs/core/src/compact_token_budget.rs#L23`

```rust
/// Token-budget compaction skips model/server summarization
/// and installs a fresh context window instead.
pub(crate) async fn run_manual_compact_task(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
) -> CodexResult<()> {
    // ...
    sess.start_new_context_window(step_context, world_state).await;
    // ...
}
```

不花钱，但代价是 Agent 突然失忆了。它不知道之前发现过什么 bug、不知道哪个方案试过不行。你眼睁睁看着它又开始走老路，心说"完了，刚才白干了"。这不是理论推演——[Codex #25792](https://github.com/openai/codex/issues/25792) 里有用户实测：compaction 前进度 97%，compaction 后回退到 42%，AGENTS.md 里的项目规则全部丢失。评论区有人总结得很精辟：「compaction 把执行锚点（AGENTS 规则、任务状态、已完成的工作）和普通对话历史当成了同一种上下文处理」。早期版本更粗暴——[#9505](https://github.com/openai/codex/issues/9505) 记录了 `remove_first_item` 策略：直接删最老的消息，不管它是系统提示还是普通闲聊。

DeepSeek 的事件截断是内存操作，基本免费。`deriveMessages()` 的缓存机制保证了增量处理——但截断点选在哪里是个玄学。`surface.ts` 里的 `replace` 操作会在 compaction 时替换旧节点：

> `DeepSeek: packages/core/session/src/surface.ts#L368`

```typescript
} else if (plan?.kind === 'replace') {
  state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq)
  state.replaceGeneration += 1  // ← 缓存失效标记
}
```

选在工具调用中间，消息历史就缺了一条结果；选在回合中间，状态就不完整。你调了半天，最后决定"只要会话不超过 300 轮就不截断"，然后把内存阈值设到 2GB。

运行时代的每一个问题——启动慢、内存涨、压缩丢上下文——本质上都是同一个问题的不同面：**智能体如何在有限资源下维持长程一致性？** 人类的大脑也有遗忘，但遗忘是有策略的；Agent 的"遗忘"是机械的——要么全记住，要么全丢掉。这四个项目都在用工程手段逼近"有策略的遗忘"，但离真正的认知级遗忘还很远。

---

## 三、Agent 核心循环：怎么让 LLM 可靠地执行任务

Agent 的核心循环是最关键的部分。它决定了 LLM 如何与工具交互、如何处理错误、如何控制执行预算。

### 3.1 Hermes 的对话循环

Hermes 的对话循环在 `agent/conversation_loop.py` 中实现。核心函数 `run_conversation` 驱动一个用户回合：

> `Hermes: agent/conversation_loop.py#L1691`

```
1. 构建回合上下文（用户消息、系统提示、工具定义）
2. 调用 LLM（流式）
3. 如果模型返回工具调用，执行它们（顺序或并发）
4. 循环回到步骤 2，直到模型产生最终文本响应
5. 处理重试、降级、压缩、错误恢复
6. 回合后钩子：后台记忆/技能审查
```

几个关键组件：

**`TurnRetryState`** 跟踪每个回合的重试状态。当 LLM 调用失败时（网络错误、速率限制等），它会记录重试次数、上次错误、冷却时间，决定是否重试以及等待多久。

> `Hermes: agent/turn_retry_state.py#L33`

```python
@dataclass
class TurnRetryState:
    """One-shot recovery guards + restart signals for a single API-call attempt."""

    # ── Per-provider OAuth / credential refresh guards ───────────────────
    codex_auth_retry_attempted: bool = False
    anthropic_auth_retry_attempted: bool = False
    nous_auth_retry_attempted: bool = False
    copilot_auth_retry_attempted: bool = False
    vertex_auth_retry_attempted: bool = False

    # ── Format / payload recovery guards ─────────────────────────────────
    thinking_sig_retry_attempted: bool = False
    invalid_encrypted_content_retry_attempted: bool = False
```

每个 Provider 有独立的重试守卫——Anthropic 的 429 重试、Copilot 的 OAuth 刷新、Vertex 的凭证刷新，互不干扰。这比一个全局 `retry_count` 优雅得多。

**`IterationBudget`** 是线程安全的迭代预算计数器（已在 2.6 节介绍），默认预算：父 Agent 500 次迭代，子 Agent 50 次。

**`repetition_guard.py`** 检测模型是否在循环。如果连续多次产生相同的工具调用和输出，它会中断循环并报告。

> `Hermes: agent/repetition_guard.py#L43`

```python
MIN_FRAGMENT_LENGTH = 400      # 片段至少 400 字符才检测
_REPEAT_WINDOW = 60            # 60 字符的重复窗口
_MIN_REPEAT_COUNT = 5          # 重复 5 次以上
_DOMINANCE_RATIO = 0.5         # 重复内容占比超过 50%

def is_repetition_dominated(text: str) -> bool:
    """True when text is dominated by verbatim repeated fragments."""
    if not isinstance(text, str):
        return False
    n = len(text)
    if n < MIN_FRAGMENT_LENGTH:
        return False
```

检测逻辑很保守：只有 60+ 字符的逐字重复覆盖了片段的 majority 才会触发。普通的截断响应（句子断在词中间、标题重复、相似代码行）不会被误杀。但保守策略有已知盲区——[Hermes #60084](https://github.com/NousResearch/hermes-agent/issues/60084) 报告了两个漏判场景：一是「参数变了但结果没变」的循环（模型用不同 URL 反复 fetch 同一个 404 页面），二是多模态结果的重复检测失效（base64 图片的 `str(result)` 每次都不同，即使内容完全一样）。`repetition_guard` 按调用签名去重，检测不到结果层面的重复——守卫的是「调用」而不是「结果」。

**`conversation_compressor.py`** 在接近模型 token 限制时自动压缩上下文——使用一个廉价的辅助模型（默认 `google/gemini-3-flash-preview`）总结中间回合，保护头部（系统提示、前几轮）和尾部（最近上下文）。

### 3.2 DeepSeek 的事件溯源循环

DeepSeek Harness 的 Agent 循环设计是四个项目中最优雅的。它的核心理念是：**会话日志是唯一真相源，一切都是派生的。**

`SessionStore` 是一个**事件溯源的只追加日志**。每个交互都是一个 `SessionEvent`，带有序列号 `seq`：

> `DeepSeek: packages/core/session/src/index.ts`

```typescript
// 事件类型（简化）
type SessionEvent = 
  | { type: 'turn/start', seq: number, ... }
  | { type: 'turn/end', seq: number, reason: string, ... }
  | { type: 'step/start', seq: number, ... }
  | { type: 'user/message', seq: number, content: string, ... }
  | { type: 'assistant/message', seq: number, content: string, ... }
  | { type: 'tool/call', seq: number, name: string, args: any, ... }
  | { type: 'tool/result', seq: number, result: any, ... }
  | { type: 'approval/asked', seq: number, ... }
  | { type: 'approval/decided', seq: number, action: string, ... }
  // ...
```

**LLM 消息历史是从日志派生的**，而不是直接存储的。`deriveMessages()` 函数从事件日志中重建消息列表。这意味着你可以：
- 在任意时间点重建历史状态
- 审计每个决策的完整上下文
- 实现精确的撤销和重放

Agent 循环是两层结构：

> `DeepSeek: packages/core/agent-loop/src/agent.ts`

```
kick() — 外层驱动循环：while (await this.turn()) {}
  turn() — 打开回合边界，循环执行步骤
    step() — 构建 LLM 请求，流式响应，处理工具调用
      buildRequest() — 从会话历史、系统提示、工具定义组合请求
      executeToolCalls() — 调度工具执行
```

**工具调用调度** 是一个亮点。工具调用被分为 `parallel` 和 `exclusive` 两类：
- Exclusive 调用形成屏障——必须独占执行
- Parallel 调用使用有界滚动池（`maxParallelToolCalls`）
- 结果按模型顺序提交
- 中止时为跳过的调用生成合成错误结果

核心逻辑是：遇到 `exclusive` 调用形成屏障，`parallel` 调用用 `Promise.race` 滚动池并发执行，结果按模型顺序提交（不是完成顺序）。完整的真实代码在 4.4 节。

所有会话事件都是**深度冻结的**（deeply frozen）。`adoptSessionEvent()` 验证并冻结独占事件；`snapshotSessionEvent()` 克隆并冻结导入事件。**不可变性是贯穿整个系统的核心约束。**

### 3.3 Codex 的 Turn 执行

Codex 的 Agent 循环分布在三个层次：

**`Session`**（Codex: `codex-rs/core/src/session/session.rs`）是中心 Agent 上下文，拥有：
- `thread_id` — 唯一线程标识
- `tx_event` — 向 UI 发送事件的 Channel
- `agent_status` — 状态更新的 Watch Channel（Idle、Running 等）
- `state` — 可变会话状态（对话历史等）
- `active_turn` — Mutex 保护的可选活跃回合
- `services` — `SessionServices`（MCP、执行策略、扩展等）
- `conversation` — 实时对话管理器

**`Turn`**（Codex: `codex-rs/core/src/session/turn.rs`）是核心执行单元。每个用户输入触发一个回合：

```
1. 构建上下文（系统提示、对话历史、工具定义）
2. 通过 ModelClientSession 流式请求模型
3. 处理响应事件（文本输出、工具调用、推理）
4. 执行工具调用（Shell 命令、文件操作、MCP 工具）
5. 将工具结果反馈给模型
6. 重复直到模型停止请求工具（或达到限制）
```

**`CodexThread`**（Codex: `codex-rs/core/src/codex_thread.rs`）是公共线程句柄，包装了 `Session` 并提供 `start_or_steer_turn()` API。

**`AgentControl`**（Codex: `codex-rs/core/src/agent/control.rs`）是多 Agent 编排层，管理：
- Agent 注册表（`AgentRegistry`）
- 子 Agent 生成（`SpawnAgentOptions`）
- Agent 间通信（`InterAgentCommunication`）
- Agent 状态跟踪（`watch::Receiver<AgentStatus>`）
- 执行限制器（`AgentExecutionLimiter`）

### 3.4 循环终止条件：真实的判断逻辑

上面讲了循环怎么运转，但更关键的问题是：**循环怎么停？** 让我们贴出四个项目真实的终止条件代码。

**Hermes**：

> `Hermes: agent/conversation_loop.py#L1909`

```python
while (api_call_count < agent.max_iterations   # ← 硬编码上限（默认500）
       and agent.iteration_budget.remaining > 0) \
       or agent._budget_grace_call:             # ← 预算耗尽后的「宽限一次」
    # Grace call: the budget is exhausted but we gave the model one
    # final chance to produce a closing response.
    if agent._budget_grace_call:
        agent._budget_grace_call = False
    elif not agent.iteration_budget.consume():  # ← 原子性消费预算
        _turn_exit_reason = "budget_exhausted"
        agent._safe_print(
            f"\n⚠️  Iteration budget exhausted "
            f"({agent.iteration_budget.used}/{agent.iteration_budget.max_total} iterations used)"
        )
```

注意 `_budget_grace_call`——预算耗尽后还会给模型一次"收尾机会"，让它产生最终响应而不是突然中断。这是一个很人性化的设计。

**DeepSeek Harness**：

> `DeepSeek: packages/core/agent-loop/src/agent.ts#L210-L315`

```typescript
private async kick(): Promise<void> {
    try {
        while (await this.turn()) {}  // ← turn() 返回 false 时停止
    } catch (_error) { ... }
}

private async turn(): Promise<boolean> {
    // ...
    while (true) {                    // ← 步骤循环，靠 break 退出
        const stepEnd = await this.step()
        // max-tokens is sticky: once any step hits the ceiling,
        // later steps are skipped.
        if (turnEnds === null || turnEnds.kind !== 'max-tokens')
            turnEnds = stepEnd
        if (stepEnd.kind !== 'completed') break  // ← 非正常完成则退出步骤循环
    }
}

// step() 内部的重试逻辑：
while (true) {
    // ... 流式请求 LLM ...
    if (finish.kind === 'error' || finish.kind === 'aborted') {
        const action = await this.dispatch.serial('agent/request-error', {
            retryPolicy: preparedCall?.retryPolicy,
        })
        if (action?.kind !== 'retry') break  // ← 非重试则退出
        continue
    }
    if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }  // ← token 耗尽，标记为 sticky
}
```

注意 `max-tokens is sticky`——一旦某步触达 token 上限，后续步骤都会被跳过。这是防止模型在 token 耗尽后产生截断输出的保护机制。

**Codex**：

> `Codex: codex-rs/core/src/session/turn.rs#L376`

```rust
// 状态机驱动的循环（简化）：
loop {
    let step_context = match next_step_context.take() {
        Some(step_context) => step_context,
        None => sess.capture_step_context(turn_context, &cancellation_token)
            .await?,  // ← 取消令牌检查点
    };

    match sampling_request_result {
        Ok(response) => {
            // ... 处理响应 ...
            let stop_outcome = run_turn_stop_hooks(  // ← 钩子可以阻止停止
                sess, &step_context, stop_hook_active,
            ).await;
            if stop_outcome.should_block {
                // 钩子说"还没完"，继续循环
                stop_hook_active = true;
                continue;
            }
            if stop_outcome.should_stop {
                break;  // ← 钩子说"可以停了"
            }
        }
        Err(err) if matches!(err.details(),
            CodexErrorDetails::TurnAborted) => {
            break  // ← 回合被中止
        }
    }
}
```

Codex 的终止逻辑最复杂。它有一个 `run_turn_stop_hooks` 机制，钩子可以阻止回合结束。这意味着插件可以在回合即将结束时注入额外的工作（比如还有个文件没保存）。

### 3.5 OpenCode 的 Effect 驱动循环

OpenCode 的 Agent 循环跟前三个都不一样。它不是用普通的 `while` 循环 + 回调，而是用 **Effect 的 Stream 和 Fiber** 构建的。

核心流程（`session.ts` → `prompt()` 方法）：

> `OpenCode: packages/session/src/session.ts`

```
prompt() → 
  Effect.gen(function*() {
    // 1. 构建消息（从 SQLite 加载历史 + 注入 instructions）
    // 2. 根据 agent 角色选择工具集
    // 3. 调用 AI SDK（streamText 或 generateText）
    // 4. 流式处理响应：text/delta → 写入 Session，tool-call → 执行
    // 5. 工具结果反馈，重复步骤 3-4
    // 6. 直到模型不再请求工具（或达到限制）
  })
```

关键区别在于 **错误处理和资源清理**。在 Effect 里，Fiber 的取消是结构化的——父 Fiber 取消时，所有子 Fiber（包括正在执行的工具调用）自动清理。你不需要像 Hermes 那样手动管理线程锁，也不需要像 DeepSeek 那样手动冻结事件。

**子 Agent 通过 `task` 工具创建**，跑在独立的 Fiber 里，有自己的 Session、自己的消息历史、自己的权限规则。`background=true` 时，子 Agent 异步执行，父 Agent 通过 Effect 的 `Deferred` 等待结果通知。

**Compaction（上下文压缩）** 用一个专门的 Agent 实现——不是简单的截断或辅助模型摘要，而是一个完整的 Agent 会话，有自己的 system prompt 告诉它"请总结以下对话"。这比 Hermes 的 Gemini Flash 摘要更灵活，但也更贵。

**Session 的 `cancel` 操作** 通过 Effect 的中断机制实现——不需要像 Codex 那样手动管理 `CancellationToken`。调用 `cancel` 时，Effect Runtime 自动中断正在执行的 Fiber，清理资源。

### 3.6 循环设计对比

| 维度 | Hermes | DeepSeek | Codex | OpenCode |
|------|--------|----------|-------|----------|
| 循环结构 | 函数式（run_conversation） | 两层（kick/turn/step） | 三层（Session/Turn/Thread） | Effect Fiber + Stream |
| 状态管理 | 可变状态 + 锁 | 不可变事件日志 | Mutex + Channel | SQLite + Effect Ref |
| 错误恢复 | TurnRetryState + 降级链 | 事件重放 | Channel 错误传播 | Effect 错误模型 + Fiber 取消 |
| 迭代控制 | IterationBudget | 回合/步骤边界 | AgentExecutionLimiter | subagent_depth 限制 |
| 重复检测 | repetition_guard | 事件去重 | 无显式机制 | 无显式机制 |
| 上下文压缩 | 辅助模型摘要 | 事件日志截断 | NewContextWindowHandler | 专用 Compaction Agent |
| 取消机制 | 线程中断 | Fiber 取消 | CancellationToken | Effect 中断 |


循环结构的差异，是对"智能体如何持续推理"的不同回答。人类的推理是跳跃式的——可以在不同抽象层次之间自由切换，可以暂停、回溯、换个角度。Agent 的循环是线性的：调用 LLM、执行工具、再调用 LLM。这种线性结构是当前 Agent 最根本的限制之一。

### 3.7 循环的代价：那些没有被提及的硬问题

上面讲了循环怎么工作，但真正让 Agent 开发者头疼的是**循环出了问题怎么办**。

Hermes 的重复检测是「连续多次产生相同的工具调用和输出」。但什么算「真正死循环」？如果 Agent 连续 3 次尝试用不同参数修复同一个文件，这算循环吗？如果 Agent 在等待外部服务响应时反复轮询，这算循环吗？误判会中断正常的迭代重试；漏判会烧穿 API 额度。[Hermes #60084](https://github.com/NousResearch/hermes-agent/issues/60084) 记录了漏判的真实案例：一个本地模型跑网关会话，反复 fetch 同一个被封锁的页面（每次参数略有不同），烧光了整个 IterationBudget，守卫全程没触发。**这个阈值的调优是一个持续的工程问题，不是一劳永逸的。**

**预算耗尽后的降级体验。** 四个项目对「Agent 跑多久该停」的回答完全不同：
- Hermes：显式迭代预算。`IterationBudget` 是一个线程安全的计数器，每次工具调用前 `consume()`，耗尽返回 `False`，Agent 立刻停止。停止后向用户展示原因——`budget_exhausted` 提示"Send `continue` to keep going"，`max_iterations_reached` 提示"raise `max_iterations`"。

> `Hermes: agent/iteration_budget.py#L37`

```python
def consume(self) -> bool:
    """Try to consume one iteration.  Returns True if allowed."""
    with self._lock:
        if self._used >= self.max_total:
            return False
        self._used += 1
        return True
```

- DeepSeek：没有迭代预算。这是四个项目中唯一信任模型自行停止的——Agent 循环跑，直到模型不再生成工具调用、用户主动中断、或 Agent 被 dispose。唯一的硬限制是子 Agent 的递归深度（`delegationDepth`），防止无限嵌套，但不限制单层内的迭代次数。

> `DeepSeek: packages/core/agent-loop/src/agent.ts#L210`

```typescript
private async kick(): Promise<void> {
  try {
    while (await this.turn()) {}   // 没有预算检查，靠模型自行停止
  } catch (_error) {
    // Reported failures and cancellation are contained at the driver boundary.
  } finally { ... }
}
```

> `DeepSeek: packages/subagent/subagent/src/child-agent.ts#L48`

```typescript
export function resolveChildDepth(parent: Agent, maxDepth: number | undefined): number {
  const childDepth = delegationDepthOf(parent) + 1
  if (maxDepth !== undefined && childDepth > maxDepth) {
    throw new SubagentDepthError(childDepth, maxDepth)  // maxDepth 默认 3
  }
  return childDepth
}
```

- Codex：Token 预算，不是迭代预算。`RolloutBudget` 按加权 Token 消耗计算——`output_tokens * sampling_weight + non_cached_input * prefill_weight`——耗尽后通过 `reminder` 机制通知模型"你快没额度了"，而不是直接切断。

> `Codex: codex-rs/core/src/rollout_budget.rs#L46`

```rust
pub(crate) fn record_usage(&self, usage: &TokenUsage) -> CodexResult<bool> {
    let units = usage.output_tokens.max(0) as f64 * state.config.sampling_token_weight
        + usage.non_cached_input() as f64 * state.config.prefill_token_weight;
    state.weighted_tokens_used += units;
    Ok(state.weighted_tokens_used >= state.config.limit_tokens as f64)
}
```

- OpenCode：显式步骤上限。达到 `maxSteps` 后，注入一段 `MAX_STEPS_PROMPT` 强制 LLM 停止工具调用，用纯文本总结已完成的工作和剩余任务。这是四个项目中降级体验最好的——Agent 不是突然沉默，而是被迫交出一份「结项报告」。

> `OpenCode: packages/core/src/session/runner/max-steps.ts#L1`

```typescript
export const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
...`
```

**四种策略反映了四种哲学：Hermes 用硬性计数器兜底，DeepSeek 信任模型自主决策，Codex 用经济模型（Token 消耗）约束行为，OpenCode 用 Prompt Engineering 强制优雅收尾。**

**子 Agent 失控的风险。** Hermes 的子 Agent 有独立的 IterationBudget（50 次），但如果子 Agent 陷入了非重复性的逻辑绕圈（不是简单的重复调用，而是在不同工具之间来回跳转），repetition_guard 检测不到，IterationBudget 也可能不够用。OpenCode 的 `subagent_depth` 限制了递归深度（默认 1），但同样无法防止子 Agent 在同一层级内「兜圈子」。**子 Agent 的可观测性和可控性是四个项目都没有很好解决的问题。**

---

## 四、工具系统：怎么让 LLM 操作计算机

工具系统是 Agent 的「手和脚」。它决定了 LLM 能做什么、怎么做、做得安不安全。

### 4.1 Hermes 的工具注册表

Hermes 的工具系统有一个核心设计：**AST 自发现**。

它有一个中央注册表，每个工具文件在模块级别通过 `registry.register()` 自注册，声明其 schema、处理函数、工具集成员和可用性检查。注册表使用 AST 检查（`_module_registers_tools`）来发现哪些文件注册了工具。

> `Hermes: tools/registry.py#L426`

```python
# tools/terminal_tool.py — 自注册示例
from tools.registry import registry

registry.register(
    name="run_terminal",
    description="Execute a shell command",
    schema={...},
    handler=handle_terminal,
    toolset="core",
    availability_check=lambda: True,
)
```

Hermes 有 **50+ 内置工具**，涵盖：Web 搜索、终端、文件操作、视觉、图像生成、视频生成、浏览器自动化、TTS、规划/记忆、会话搜索、代码执行、委托、定时任务、Home Assistant、看板、计算机使用等。

**终端工具有 7 种后端**：
- **Local** — 直接在宿主机执行
- **Docker** — 容器隔离
- **SSH** — 远程执行（Agent 代码本地，命令远程——API 密钥受保护）
- **Singularity** — HPC 容器运行时
- **Modal** — 无服务器沙箱
- **Daytona** — 云沙箱
- **Vercel** — Vercel 沙箱

每种后端提供不同的隔离级别，用户可以根据安全需求选择。工具执行支持并发模式（详见 4.4 节）。

### 4.2 DeepSeek 的工具运行时

DeepSeek Harness 的工具系统设计得非常精致。`ToolRuntime`（`ctx.tools`）是一个 Cordis 服务，提供 **4 阶段执行流水线**：

> `DeepSeek: packages/core/agent-loop/src/tool-calls.ts`

```
1. tools/pre-execute   — 执行前：允许/拒绝/询问
2. tools/execute       — 执行中：超时、重试、指标
3. 工具函数体           — 实际执行
4. tools/post-execute  — 执行后：接受/替换/丰富结果
```

每个阶段都是一个**可拦截的水龙头（waterfall）**——插件可以监听并修改数据流。

工具定义使用 schema DSL：

> `DeepSeek: packages/tools/src/tool.ts`

```typescript
// 定义一个工具
defineTool({
  name: 'bash',
  description: 'Execute a shell command',
  parameters: {
    command: { type: 'string', required: true },
    timeout: { type: 'number', default: 30000 },
  },
  output: {
    schema: { exitCode: 'number', stdout: 'string', stderr: 'string' },
    render(args, value) { return <TerminalCard .../>; },
  },
  execute(args, exec) { return exec.command(args.command); },
  presentCall(args) { return { card: 'terminal', title: args.command }; },
  presentResult(args, result) { return { card: 'terminal', ... }; },
  isConcurrencySafe(args) { return true; },
})
```

**`presentCall()` 和 `presentResult()`** 是一个很聪明的设计——工具声明自己在 UI 中的展示方式，返回卡片类型的渲染意图（`generic`、`terminal`、`diff`、`read`、`search`、`web`）。这样 UI 层不需要知道工具的具体实现，只需要根据展示意图选择合适的组件。

不过 Code Mode 是 DeepSeek Harness 的一个独特功能。当设置 `mode: 'code'` 时，所有工具被折叠成一个 `run_code` 工具，模型写一个程序来程序化地调用工具。这种方式对于需要复杂逻辑的工具调用序列特别有用。

### 4.3 Codex 的工具执行器

Codex 的工具系统基于 `ToolExecutor` Trait，这是最「Rust」的方式：

> `Codex: codex-rs/tools/src/tool_executor.rs`

```rust
pub trait ToolExecutor<Invocation>: Send + Sync {
    fn tool_name(&self) -> ToolName;
    fn spec(&self) -> ToolSpec;
    fn exposure(&self) -> ToolExposure;
    fn search_info(&self) -> Option<ToolSearchInfo>;
    fn handle(&self, invocation: Invocation) -> ToolExecutorFuture<'_>;
}
```

`ToolSpec` 是发送给模型的可序列化工具定义，有多种变体：
- `Function` — 标准函数调用工具
- `Namespace` — 分组工具命名空间
- `ToolSearch` — 发现工具
- `WebSearch` — 内置 Web 搜索
- `Freeform` — 自定义格式工具

Codex 的内置工具处理器包括：
- **`ShellCommandHandler`** — 执行 Shell 命令（主要工具）
- **`ApplyPatchHandler`** — 应用文件补丁
- **`McpHandler`** — 调用 MCP 服务器工具
- **`PlanHandler`** — 创建执行计划
- **`ViewImageHandler`** — 查看图像
- **`RequestUserInputHandler`** — 请求用户输入
- **`MultiAgents`** — 生成/消息/等待子 Agent
- **`NewContextWindowHandler`** — 开始新的上下文窗口
- **`DynamicToolHandler`** — 运行时注册的工具

**Shell 工具** 是 Codex 的主力。它：
1. 从模型的函数调用中解析 `ShellCommandToolCallParams`
2. 构建 `ExecParams`（命令、cwd、环境、超时）
3. 检查审批策略（自动批准、建议、需要用户批准）
4. 应用沙箱权限
5. 委托给 `ShellRuntime`
6. 流式回传 stdout/stderr 增量
7. 返回 `ExecToolCallOutput`（退出码、stdout、stderr）

### 4.4 工具并发调度：真实的锁/池/屏障实现

上面用文字描述了并发模型，现在贴出真实的调度代码——三种并发原语在多命令并行上的不同写法。

**Hermes：DaemonThreadPoolExecutor + 门控超时**：

> `Hermes: agent/tool_executor.py#L1455`

```python
# 固定 8 个 worker，图片生成降到 4
_MAX_TOOL_WORKERS = 8
_DEFAULT_IMAGE_PARALLEL_REQUESTS = 4

max_workers = _max_workers_for_tool_batch(runnable_calls)  # min(批次大小, 8)
from tools.daemon_pool import DaemonThreadPoolExecutor
executor = DaemonThreadPoolExecutor(max_workers=max_workers)  # ← Daemon 线程，不阻塞退出

for submit_index, (i, tc, name, args, scope_block) in enumerate(runnable_calls):
    f = executor.submit(
        propagate_context_to_thread(_run_tool),  # ← ContextVar 传播到工作线程
        i, tc, name, args, parsed_calls[i][3], scope_block, submit_index,
    )

# 门控超时防止楔死的 worker 饿死整个批次
_START_ORDER_GATE_TIMEOUT_S = 120.0    # 启动顺序门控
_AUTHORIZATION_GATE_LOCK_TIMEOUT_S = 360.0  # 授权门控
```

关键设计：`DaemonThreadPoolExecutor` 用 Daemon 线程。如果主进程退出，楔死的 worker 不会阻塞 interpreter exit。`propagate_context_to_thread` 把主线程的 `ContextVar`（如审批会话 key）传播到工作线程。

**DeepSeek Harness：有界滚动池 + 排他屏障**：

> `DeepSeek: packages/core/agent-loop/src/tool-calls.ts#L82-L246`

```typescript
// 工具调用分组：parallel 滚动池，exclusive 逐个屏障
let next = 0
while (next < planned.length) {
    const first = planned[next]
    const mode = ctx.tools.executionMode(first.exec).kind
    const group = mode === 'parallel'
        ? planned.slice(next)      // ← 所有后续 parallel 调用归入同一组
        : [first]                  // ← exclusive 调用独占一组
    const outcome = await runGroup(ctx, turn, step, group, mode, signal, acceptContext)
    next += outcome.consumed
    if (outcome.aborted) {
        for (const call of planned.slice(next))
            appendSkippedToolCall(session, turn, step, call.block)  // ← 中止时合成错误结果
        return { concluded }
    }
}

// runGroup 内部的滚动池（核心循环）
const inFlight = new Map<number, Promise<number>>()

const fillPool = async (): Promise<void> => {
    while (!aborted && nextToStart < group.length
           && inFlight.size < maxParallelToolCalls) {  // ← 有界池
        const nextCall = group[nextToStart]
        if (nextToStart > 0 && mode === 'parallel'
            && ctx.tools.executionMode(nextCall.exec).kind !== 'parallel')
            break  // ← 遇到 exclusive 调用立即形成屏障
        await startCall(nextToStart)
        nextToStart++
        await commitReady()  // ← 按模型顺序提交结果
    }
}

// 主循环：Promise.race 等待任意一个完成，然后补充新任务
await fillPool()
while (inFlight.size > 0) {
    const settledIndex = await Promise.race(inFlight.values())  // ← 谁先完成就先处理谁
    inFlight.delete(settledIndex)
    await commitReady()     // ← 按模型顺序提交（不是完成顺序）
    await fillPool()        // ← 补充新任务到池中
}
```

这是四个项目中最精致的调度器。`Promise.race` 实现了「完成一个补充一个」的滚动池；`commitReady()` 保证结果按模型顺序提交（不是完成顺序）；中途遇到 exclusive 调用会立即形成屏障。

**Codex：tokio::spawn + JoinSet**（Rust 异步调度）：

Codex 的工具调度在 Rust 的异步运行时中，核心是 `tokio::spawn` 把每个工具调用作为独立任务：

> `Codex: codex-rs/core/src/tools/execution.rs`

```rust
// 概念等价代码（实际实现更复杂）
let mut join_set = tokio::task::JoinSet::new();
for call in tool_calls {
    join_set.spawn(async move {
        tool_router.execute(call).await  // ← 每个工具独立异步任务
    });
}
while let Some(result) = join_set.join_next().await {
    // 按完成顺序处理结果
    session.record_tool_result(result?);
}
```

Rust 的 `JoinSet` 天然支持「完成一个处理一个」，不需要手动管理 Promise 池。但代价是每个 `tokio::spawn` 需要 `'static` 生命周期——工具调用的所有权被转移到新任务中，原任务不能再访问。

### 4.5 OpenCode 的 Effect Schema 工具系统

OpenCode 的工具系统用 **Effect Schema** 定义参数——不是 Zod，不是 JSON Schema，是 Effect 自带的类型系统。

> `OpenCode: packages/tool/src/tool.ts`

```typescript
// tool.ts — 工具定义
export interface Tool<Name extends string = string> {
  id: Name
  description: string
  parameters: Schema.Schema  // ← Effect Schema，不是 Zod
  jsonSchema: Record<string, unknown>  // ← 自动派生给 LLM
  execute: (input: any, ctx: ToolContext) => Effect.Effect<any>
}
```

关键设计：

1.**模型特定的工具选择**。GPT 模型（非 oss、非 gpt-4）获得 `apply_patch`（unified diff）而不是 `edit`+`write`（search-and-replace）。这是因为 GPT 模型生成 unified diff 的质量比 search-and-replace 高。其他三个项目都没有这种模型特定的工具切换。

> `OpenCode: packages/opencode/src/tool/registry.ts#L297`

```typescript
const usePatch =
  input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
if (tool.id === ApplyPatchTool.id) return usePatch
if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch
```

2.**权限集成**。每个工具调用都经过 Agent 的权限规则检查。Plan Agent 的 `edit: "*": "deny"` 是在规则层实现的，LLM 物理上无法调用被拒绝的工具——工具定义根本不会出现在 Plan Agent 的可用工具列表里。

> `OpenCode: packages/opencode/src/agent/agent.ts#L156`

```typescript
plan: {
  name: "plan",
  description: "Plan mode. Disallows all edit tools.",
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      edit: { "*": "deny" },  // 所有编辑工具对 Plan Agent 不可见
      [path.join(".opencode", "plans", "*.md")]: "allow",  // 只允许编辑计划文件
    }),
  ),
}
```

3.**插件工具**。在 `.opencode/tool(s)/*.{js,ts}` 里定义的文件会被动态加载。插件工具通过 `EffectBridge` 桥接 Effect（服务端）和 Promise（插件侧）。

> `OpenCode: packages/opencode/src/tool/registry.ts#L184`

```typescript
const dirs = yield* config.directories()
const matches = dirs.flatMap((dir) =>
  Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true }),
)
for (const match of matches) {
  const mod = yield* Effect.promise(() => import(pathToFileURL(match).href))
  for (const [id, def] of Object.entries(mod)) {
    if (!isPluginTool(def)) continue
    custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
  }
}
```

4.**工具输出自动截断**——超过阈值的工具输出被自动截断，避免一个巨大的文件读取结果撑爆上下文窗口。

### 4.6 工具并发模型对比

| 维度 | Hermes | DeepSeek | Codex | OpenCode |
|------|--------|----------|-------|----------|
| 并发模型 | ThreadPoolExecutor（8 worker） | 有界滚动池 + 排他屏障 | Channel + async | Effect Fiber + Semaphore |
| 工具数量 | 50+ | 按需加载 | 15+ 核心 | 15+ 核心 + 插件 |
| 注册方式 | AST 自发现 | defineTool() DSL | Trait 实现 | Effect Schema + registry |
| 执行流水线 | 直接调用 | 4 阶段水龙头 | ToolRouter 路由 | 权限检查 → 执行 → 截断 |
| UI 展示 | 无抽象 | presentCall/Result | 无抽象 | 无抽象 |
| 特殊功能 | 7 种终端后端 | Code Mode | ToolExposure 可见性 | 模型特定工具选择 |

工具系统决定了智能体的能力边界——它能看到什么、能改变什么。人类使用工具是创造性的（锤子不只是钉钉子的工具，也可以是撬棍、镇纸、自卫武器）；Agent 调用工具是机械的（terminal 只能执行命令，browser 只能点击元素）。**工具的刚性，是 Agent 和人类之间最直观的能力差距。**

---

## 五、LLM 集成层：怎么跟模型说话

LLM 集成层是 Agent 的"嘴巴和耳朵"。它决定了 Agent 怎么跟模型通信、怎么处理流式响应、怎么在多个 Provider 之间切换。

### 5.1 Hermes：万能适配器

Hermes 的 LLM 集成策略是**「OpenAI 兼容格式为底，Provider 适配器为面」**。所有 LLM 调用都通过 OpenAI 兼容的 API 格式进行，Provider 特定的适配器负责翻译。

**Anthropic 适配器**（`Hermes: agent/anthropic_adapter.py`）是最复杂的。它需要在 OpenAI 风格的消息和 Anthropic Messages API 之间做翻译：

```python
# agent/anthropic_adapter.py — 思维预算映射
THINKING_BUDGET = {
    'xhigh': 32000,
    'high': 16000,
    'medium': 8000,
    'low': 4000,
}
```

支持的认证方式包括 API 密钥、OAuth setup-token、Claude Code 凭据。SDK 懒导入（~220ms），只有实际使用 Anthropic 时才加载。

**其他适配器**：
- **Codex Runtime**（`Hermes: agent/codex_runtime.py`）— OpenAI Responses API 流式路径和 Codex App Server 子进程客户端
- **Gemini**（`Hermes: agent/gemini_native_adapter.py`）— 原生 Gemini API
- **Bedrock**（`Hermes: agent/bedrock_adapter.py`）— AWS Bedrock
- **Vertex**（`Hermes: agent/vertex_adapter.py`）— Google Vertex AI
- **Azure**（`Hermes: agent/azure_identity_adapter.py`）— Azure OpenAI

**降级和重试机制**：
- 多 Provider 降级链，耗尽后冷却
- 自适应速率限制退避 + 抖动
- 错误分类与 `FailoverReason` 枚举
- 每个 Provider 的请求超时和过期超时配置

> `Hermes: agent/error_classifier.py#L30`

```python
class FailoverReason(enum.Enum):
    """Why an API call failed — determines recovery strategy."""
    auth = "auth"                        # Transient auth (401/403) — refresh/rotate
    auth_permanent = "auth_permanent"    # Auth failed after refresh — abort
    billing = "billing"                  # 402 or credit exhaustion — rotate immediately
    rate_limit = "rate_limit"            # 429 — backoff then rotate
    upstream_rate_limit = "upstream_rate_limit"  # Aggregator 429 — fallback model
    overloaded = "overloaded"            # 503/529 — backoff
    server_error = "server_error"        # 500/502 — retry
    timeout = "timeout"                  # Connection/read timeout — rebuild + retry
    context_overflow = "context_overflow"  # Too large — compress, not failover
    content_policy_blocked = "content_policy_blocked"  # Safety filter — don't retry
    model_not_found = "model_not_found"  # 404 — fallback to different model
    thinking_signature = "thinking_signature"  # Anthropic thinking block sig invalid
    unknown = "unknown"                  # Catch-all — retry with backoff
    # ... 20+ 种细分错误类型
```

**提示缓存**（`Hermes: agent/prompt_caching.py`）为 Anthropic 的缓存控制构建缓存计划。系统提示在会话开始时构建一次，跨回合复用，保持上游前缀缓存热度。

### 5.2 DeepSeek：水龙头式 LLM 运行时

DeepSeek Harness 的 LLM 集成是一个 **Cordis 服务**（`ctx.llm`），核心设计是「适配器注册 + 水龙头拦截」。

> `DeepSeek: packages/llm/llm-deepseek/src/adapter.ts`

```typescript
// LlmAdapter 抽象类（简化）
abstract class LlmAdapter {
  abstract providerInfo(provider: string): ProviderInfo;
  abstract listModels(provider: string): Promise<ModelInfo[]>;
  abstract resolveModel(provider: string, model: string): Promise<ModelMeta>;
  abstract stream(options: StreamOptions): AsyncIterable<StreamChunk>;
}
```

**`stream()` 是唯一必须实现的方法**——其他都是可选的。这让适配器的实现成本极低。

**DeepSeek 适配器**（`DeepSeek: packages/llm/llm-deepseek/src/adapter.ts`）使用直接 `fetch` + SSE 调用 OpenAI 兼容的 chat-completions 端点。一个巧妙的设计：连接配置（base URL、API key、模型目录）**按请求从 thunk 解析**，所以配置变更立即生效，不需要重启。

默认模型：`deepseek-v4-flash` 和 `deepseek-v4-pro`，1M 上下文窗口，256K 最大 token。

**`llm/stream` 水龙头** 让插件可以拦截和修改 LLM 请求/响应流。比如：
- 重试策略插件可以捕获错误并重试
- 计量插件可以跟踪 token 使用
- 缓存插件可以缓存响应

### 5.3 Codex：Responses API + 本地模型

Codex 使用 **OpenAI Responses API**（不是 Chat Completions），这是一个重要的设计选择。

> `Codex: codex-rs/core/src/client.rs`

```rust
// codex-rs/core/src/client.rs — ModelClient 管理 API 连接
struct ModelClient {
    provider_config: ProviderConfig,
    auth: Auth,
    transport: TransportState,
}
```

Responses API 的特点：
- 工具作为 `ToolSpec` JSON 发送
- 响应以 SSE 事件流式传输：`response.created`、`response.output_item.done` 等
- 函数调用作为 `function_call` 输出项到达
- 结果作为 `function_call_output` 项发送回
- 支持通过 WebSocket 的 `response.create` 进行预热

**WebSocket 预热** 是 Codex 的一个独特功能。在用户还在打字时，就通过 WebSocket 预先建立连接，减少首次请求的延迟。

**本地模型支持** 是 Codex 的另一个亮点：
- **Ollama**（`Codex: codex-rs/ollama/src/lib.rs`）— 本地模型运行时，默认模型 `gpt-oss:20b`
- **LM Studio**（`Codex: codex-rs/lmstudio/src/lib.rs`）— 本地模型管理，默认模型 `openai/gpt-oss-20b`

两者的 `ensure_oss_ready()` 函数都会检查模型是否存在，不存在则自动下载和加载。

### 5.4 OpenCode：100+ Provider 的模型自由

OpenCode 的 LLM 集成层是四个项目中最「开放」的。它通过 `models.dev` 目录支持 **100+ 个 Provider**。

架构分三层：
1. **目录层**（`models.dev`）：社区维护的 Provider/模型数据库，启动时拉取
2. SDK 层：捆绑了 25+ 个 AI SDK 包（`@ai-sdk/anthropic`、`@ai-sdk/openai`、`@ai-sdk/google`、`@ai-sdk/amazon-bedrock`、`@ai-sdk/mistral`、`@ai-sdk/groq` 等）
3. **自定义加载器层**（`provider.ts:168-975`）：每个 Provider 有 `CustomLoader` 处理认证、SDK 初始化、模型选择

Provider 特定的逻辑相当复杂：
- **Amazon Bedrock**：跨区域推理 profile 前缀（us./eu./jp./apac./au.）、凭证链 + profile 支持
- **Azure**：资源名解析、基于部署的 URL、chat vs responses API 选择
- **Google Vertex**：ADC（Application Default Credentials）+ 多区域 endpoint
- **Snowflake Cortex**：自定义 fetch wrapper 修复 SSE 流中的空 role 字符串

**模型特定的工具选择** 也在这里处理——GPT 模型获得 `apply_patch`，其他模型获得 `edit`+`write`。这是四个项目中唯一根据模型能力动态切换工具集的。

### 5.5 Provider 抽象对比

| 维度 | Hermes | DeepSeek | Codex | OpenCode |
|------|--------|----------|-------|----------|
| 抽象方式 | 适配器类 | LlmAdapter 抽象类 | ModelProvider Trait | AI SDK + CustomLoader |
| Provider 数量 | 6+ | DeepSeek only | OpenAI only | **100+** |
| 默认格式 | OpenAI 兼容 | OpenAI 兼容 | Responses API | AI SDK 统一接口 |
| 本地模型 | 不支持 | 不支持 | Ollama + LM Studio | Ollama + 任意 OpenAI 兼容 |
| 流式处理 | SDK 流式 | fetch + SSE | SSE + WebSocket | AI SDK Stream |
| 重试机制 | 多 Provider 降级链 | llm-retry 插件 | 内置重试 | Effect 错误模型 |
| 缓存 | Anthropic 提示缓存 | 无 | 无 | 无 |

**工具系统设计对成本的影响有多大？** 一项消融实验（2026）给出了答案：

| Agent | 补丁任务成本 | 补丁成功率 |
|-------|------------|-----------|
| Codex CLI (o4-mini) | **$21** | 90% |
| Codex CLI (o3-high) | $45 | 90% |
| Claude Code | $82 | 87.5% |

**同样的任务，Codex o4-mini 的成本只有 Claude Code 的 1/4，但成功率更高。** 这不是模型能力的差距——是工具系统设计的差距。Codex 的 `ApplyPatchHandler` 专门优化了文件补丁操作，而 Claude Code 使用更通用的工具。专用工具 > 通用工具，至少在成本上是这样。

---

## 六、权限与沙箱系统：怎么保证安全

这是四个项目差异最大的部分。它们对「安全」的理解和实现方式完全不同。

### 6.1 Hermes：纵深防御

Hermes 的路径安全实现在 `tools/path_security.py`，核心逻辑出奇地简单：

> `Hermes: tools/path_security.py`

```python
def validate_within_dir(path: Path, root: Path) -> Optional[str]:
    """Ensure *path* resolves to a location within *root*.

    Returns an error message string if validation fails, or ``None`` if the
    path is safe.  Uses ``Path.resolve()`` to follow symlinks and normalize
    ``..`` components.
    """
    try:
        resolved = path.resolve()
        root_resolved = root.resolve()
        resolved.relative_to(root_resolved)
    except (ValueError, OSError) as exc:
        return f"Path escapes allowed directory: {exc}"
    return None

def has_traversal_component(path_str: str) -> bool:
    """Return True if *path_str* contains ``..`` traversal components."""
    parts = Path(path_str).parts
    return ".." in parts
```

该实现在路径规范化层面存在局限性。`validate_within_dir` 依赖 `Path.resolve()` 的行为。在 Python 3.12+ 中，`resolve()` 会跟随 symlink 并规范化路径。如果 symlink 指向 root 外部，`resolve()` 会解析到外部路径，然后 `relative_to()` 抛异常——这是正确的。但 `has_traversal_component` 仅做字面量 `..` 检查，未处理 URL 编码、Unicode 规范化等绕过方式，使其在对抗性输入下存在被绕过的风险。

Hermes 的安全策略是**「层层设防」**——所有检查都在代码层执行，LLM 无法绕过。

**1. 威胁检测**——共享的正则模式库，按攻击类别组织。系统提示构建时扫描上下文文件（AGENTS.md、.cursorrules、SOUL.md）是否有注入，模式匹配在代码层执行，不依赖 LLM 判断。

> `Hermes: tools/threat_patterns.py`

```python
# 模式按 scope 分三类：
# - "all"     — 所有场景（经典提示注入、数据外泄）
# - "context" — 上下文文件 + 记忆 + 工具结果（更宽泛）
# - "strict"  — 记忆写入 + 技能安装（严格检查）

# 每个模式是 (regex, pattern_id, scope) 元组
# 用 bounded filler 防止绕过：(?:\w+\s+){0,8}
```

**2. 路径安全**——代码级检查，`validate_within_dir()` 在工具执行前调用，用 `Path.resolve()` + `relative_to()` 阻止路径遍历。已在上文贴过代码。

**3. 自仓库保护**——代码级检查，拦截 Git 命令中的危险操作。不依赖 LLM 判断，直接解析 shell 命令检测是否包含 `checkout`、`reset --hard` 等。

> `Hermes: tools/self_repo_guard.py`

```python
_WORKTREE_MUTATIONS = frozenset({
    "checkout", "switch", "rebase", "merge", "pull",
    "restore", "clean", "cherry-pick", "revert", "bisect",
})
_RESET_WORKTREE_MODES = frozenset({"--hard", "--merge", "--keep"})
```

**4. URL 安全**——代码级检查，`is_safe_url()` 在 HTTP 请求发出**之前**调用。用 `socket.getaddrinfo()` 把域名解析成 IP，检查是否在私有地址范围。云元数据主机名（169.254.169.254）**始终**被阻止，即使全局禁用检查。

> `Hermes: tools/url_safety.py#L415`

```python
def is_safe_url(url: str) -> bool:
    """Resolves the hostname to an IP and checks against private ranges."""
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").strip().lower()
    # Block known internal hostnames — ALWAYS, even with toggle on
    if hostname in _BLOCKED_HOSTNAMES:
        return False
    # DNS resolve → check IP against private ranges
    addr_info = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    ...
```

**5. 敏感信息脱敏**——代码级脱敏，用正则匹配 API keys/tokens，在日志和工具输出发送给 LLM **之前**替换为 `***`。不依赖 LLM 自觉。

> `Hermes: agent/redact.py`

```python
_SENSITIVE_QUERY_PARAMS = frozenset({
    "access_token", "refresh_token", "id_token",
    "token", "api_key", "apikey", "client_secret", "password",
})
```

**6. 审批队列**——代码级拦截，危险命令在执行**之前**被正则匹配拦截。YOLO 模式在模块导入时冻结到 `_YOLO_MODE_FROZEN`，防止运行时被 prompt injection 篡改。`sudo -S` 无密码配置时直接阻止，防止 LLM 暴力猜密码。

> `Hermes: tools/approval.py#L577`

```python
_SUDO_STDIN_RE = re.compile(
    r'(?:^|[;&|`\n]|&&|\|\||\$\()\s*sudo\s+-S\b',
    re.IGNORECASE)

def _check_sudo_stdin_guard(command: str) -> tuple:
    """Detect sudo -S (stdin password) without configured SUDO_PASSWORD."""
    if "SUDO_PASSWORD" in os.environ:
        return (False, None)
    if _SUDO_STDIN_RE.search(command):
        return (True, "sudo password guessing via stdin (sudo -S)")
```

**7. 文件检查点**——透明基础设施，LLM 永远看不到。文件变更**之前**自动创建 shadow git 快照，支持回滚。受 `checkpoints` 配置标志控制。

> `Hermes: tools/checkpoint_manager.py`

```python
"""Checkpoint Manager — Transparent filesystem snapshots via a single shared
shadow git store.

This is NOT a tool — the LLM never sees it.  It's transparent infrastructure
controlled by the ``checkpoints`` config flag or ``--checkpoints`` CLI flag.
"""
```

### 6.2 DeepSeek：分层权限

DeepSeek Harness 的安全模型是**「沙箱模式 + 审批策略」**的组合。

**沙箱系统**（`DeepSeek: packages/sandbox/sandbox/src/index.ts`）提供三种模式：
- `read-only` — 只有必需的接收器如 `/dev/null`
- `workspace-write` — 工作区目录 + 临时区域可写
- `danger-full-access` — 无限制

后端实现在 `packages/sandbox/sandbox-local/src/profiles.ts` 中，三种后端的策略构建方式完全不同：

> `DeepSeek: packages/sandbox/sandbox-local/src/profiles.ts`

```typescript
// Bubblewrap — 容器级隔离
function bwrapProfileArgs(policy: SandboxPolicy): string[] {
    const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent']
    if (policy.mode === 'workspace-write') {
        args.push('--tmpfs', '/tmp')
        args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)  // ← 只挂载工作区为可写
    }
    return args
}

// Landlock — 内核级文件系统隔离
function landlockProfileArgs(policy: SandboxPolicy): string[] {
    const readWrite = ['/dev/null']  // ← 基础：只允许写 /dev/null
    if (policy.mode === 'workspace-write') {
        readWrite.push('/tmp', policy.workspaceRoot)  // ← 追加工作区和 /tmp
    }
    return landlockGrantArgs({ readOnly: ['/'], readWrite })  // ← 整个 / 只读
}

// macOS Seatbelt — SBPL 策略模板
function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
    const forms = [
        '(version 1)',
        '(allow default)',
        '(deny file-write*)',                                    // ← 默认禁止所有写入
        `(allow file-write* (literal "/dev/null"))`,             // ← 只允许写 /dev/null
    ]
    const roots = writableRoots(policy)
    if (roots.length > 0) {
        forms.push(`(allow file-write* ${
            roots.map(root => `(subpath "${root}")`).join(' ')   // ← 追加可写子路径
        })`)
    }
    return ['-p', forms.join(' ')]
}
```

**注意三种后端的安全粒度差异：** Bubblewrap 是容器级（挂载命名空间隔离），Landlock 是内核级（文件描述符过滤），Seatbelt 是进程级（系统调用过滤）。同一个 `workspace-write` 策略，三种后端的实际安全边界完全不同。

1.**升级系统**（`escalation.ts`）允许工具在运行时请求更宽的沙箱模式。模型在工具调用上设置 `sandbox_permissions` + `justification`；系统验证并通过审批服务路由。

2.**用户审批**（`DeepSeek: packages/interaction/user-approval/src/index.ts`）通过 `approval/request` 水龙头实现——组合的应答者决定允许/拒绝/取消。策略可以是 `ask`（委托给应答者）或 `never`（自动拒绝，用于 CI/无头模式）。

3.**权限预设**（`DeepSeek: packages/interaction/permission-presets/src/index.ts`）是面向用户的预设包：
- `workspace-write` — 沙箱：workspace-write，审批：ask
- `danger-full-access` — 沙箱：full-access，审批：never

### 6.3 Codex：沙箱优先

Codex 的安全设计是**「沙箱优先」**。所有 Shell 执行都通过平台特定的沙箱隔离。

> `Codex: codex-rs/sandboxing/src/lib.rs`

```rust
// codex-rs/sandboxing/src/lib.rs — 平台沙箱抽象
pub struct SandboxManager { ... }
```

Codex 的 macOS Seatbelt 策略定义在 `seatbelt_base_policy.sbpl` 中，这是一个 **deny-default** 的严格策略：

> `Codex: codex-rs/sandboxing/src/seatbelt_base_policy.sbpl`

```scheme
;; codex-rs/sandboxing/src/seatbelt_base_policy.sbpl（摘录）
(version 1)

; 从 Chrome 沙箱策略借鉴
; start with closed-by-default
(deny default)                          ; ← 默认拒绝一切

; 进程管理
(allow process-exec)                    ; ← 允许执行子进程
(allow process-fork)                    ; ← 允许 fork
(allow signal (target same-sandbox))    ; ← 只能信号同沙箱进程

; 文件写入：只允许 /dev/null
(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))      ; ← 严格到设备类型

; 系统信息：只读特定 sysctl
(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.memsize")
  ;; ... 只允许读取硬件信息
)
```

**注意 `(deny default)` — 默认拒绝一切，然后逐个允许。** 这与 DeepSeek 的 `(allow default) + (deny file-write*)` 完全相反——Codex 从「全部拒绝」开始，只开放必要的权限；DeepSeek 从「全部允许」开始，只限制写入。**安全哲学的根本分歧：白名单 vs 黑名单。**

Linux 端，Codex 的沙箱通过外部 helper 进程实现：

> `Codex: codex-rs/sandboxing/src/landlock.rs`

```rust
// codex-rs/sandboxing/src/landlock.rs — Linux 沙箱命令构建
fn create_linux_sandbox_command_args_for_permission_profile(
    command: Vec<String>,
    command_cwd: &Path,
    permission_profile: &PermissionProfile,
    sandbox_policy_cwd: &Path,
    use_legacy_landlock: bool,
    allow_network_for_proxy: bool,
) -> Vec<String> {
    let mut linux_cmd = vec![
        "--sandbox-policy-cwd", sandbox_policy_cwd,
        "--command-cwd", command_cwd,
        "--permission-profile", &permission_profile_json,  // ← 策略作为 JSON 传递
    ]
    if use_legacy_landlock && !allow_network_for_proxy {
        linux_cmd.push("--use-legacy-landlock")  // ← 旧内核降级
    }
    // ...
}
```

Codex 的 Linux 沙箱是 **Bubblewrap + Landlock + seccomp** 三重防护，通过独立的 `codex-linux-sandbox` helper 进程执行。策略以 JSON 传递给 helper，helper 负责构建沙箱环境。

1.**审批系统**（Codex: `codex-rs/core/src/tools/approvals.rs`）有四种模式：
- **`Never`** — 自动批准一切（全自动模式）
- **`UnlessAllowListed`** — 命令匹配白名单则自动批准，否则询问
- **`Always`** — 每个工具调用都询问（建议模式）
- **`OnFailure`** — 只在命令失败时询问

2.**执行策略**（`exec_policy`）定义命令白名单/黑名单。可以：
- 在 `config.toml` 中定义
- 从项目级 `.codex/` 目录加载
- 由 Guardian 审查者管理

**Guardian** 是一个 AI 审查者。它不是规则引擎，而是一个独立的 LLM 审查会话——接收工具调用的上下文，输出 JSON 格式的 allow/deny 判定：

> `Codex: codex-rs/core/src/guardian/review.rs#L192`

```rust
// 路由判断：什么时候走 Guardian？
fn routes_approval_policy_to_guardian(
    approval_policy: AskForApproval,
    approvals_reviewer: ApprovalsReviewer,
) -> bool {
    matches!(
        approval_policy,
        AskForApproval::OnRequest | AskForApproval::Granular(_)
    ) && approvals_reviewer == ApprovalsReviewer::AutoReview  // ← 配置为自动审查时
}
```

只有审批策略为 `OnRequest` 或 `Granular` 且审查者配置为 `AutoReview` 时，才走 Guardian。Guardian 的输出是一个严格的 JSON schema：

> `Codex: codex-rs/core/src/guardian/prompt.rs#L778`

```rust
// Guardian 的输出契约
serde_json::json!({
    "type": "object",
    "properties": {
        "risk_level": { "enum": ["low", "medium", "high", "critical"] },
        "user_authorization": { "enum": ["unknown", "low", "medium", "high"] },
        "outcome": { "enum": ["allow", "deny"] },     // ← 只有这两个选项
        "rationale": { "type": "string" }
    },
    "required": ["outcome"]
})
```

Guardian 有 90 秒超时，超时则 **fail closed**（拒绝执行）。连续拒绝有熔断机制：同一个 turn 内最多连续拒绝 3 次，避免 Guardian 陷入循环。

**`exec_policy`** 使用 Starlark 格式（Python 语法的子集）定义命令白名单：

> `Codex: codex-rs/execpolicy/src/parser.rs`

```
# .codex/exec_policy.star 示例
prefix_rule(
    pattern = ["git", "status"],       # 允许 git status
    decision = "allow",
)
prefix_rule(
    pattern = ["rm"],                   # rm 命令需要用户确认
    decision = "prompt",
)
network_rule(
    host = "api.github.com",           # 只允许访问 GitHub API
    protocol = "https",
    decision = "allow",
)
```

Guardian 的误判问题（信任递归、提示注入攻击面）在 9.4 节讨论。

### 6.4 安全模型对比

| 维度 | Hermes | DeepSeek | Codex | OpenCode |
|------|--------|----------|-------|----------|
| 核心策略 | 纵深防御 | 分层权限 | 沙箱优先 | 权限规则集 |
| 沙箱实现 | 7 种终端后端 | bubblewrap/Landlock/Seatbelt/ACL | Seatbelt/Landlock+bwrap/ACL | 无内置沙箱 |
| 审批机制 | 审批队列 | approval/request 水龙头 | 4 种审批模式 | Permission Deferred |
| 威胁检测 | 提示注入扫描 | 无显式机制 | Guardian AI 审查者 | 无显式机制 |
| 路径安全 | path_security | 沙箱文件策略 | 沙箱文件策略 | Agent 角色权限 |
| 自保护 | self_repo_guard | 无 | 无 | 无 |
| 权限继承 | 子 Agent 默认自动拒绝 | scope 继承 | 无 | **子 Agent 权限继承** |


沙箱的矛盾暴露了智能体存在的根本困境：我们要造一个有能力的系统，但又害怕它真的有能力。Codex 的沙箱是当前最务实的解法——先限制，再放开。但当 Agent 的能力继续增长，「先限制再放开」的策略还够用吗？这是所有 Agent 框架终将面对的问题。

### 6.5 安全的现实：沙箱不等于绝对安全

上面讲了四个项目各自的安全机制，但有几个现实问题需要正视。

**沙箱逃逸风险。** 无论哪种沙箱实现，都不是 100% 安全的：
- Landlock 是 Linux 内核特性，但它的安全边界依赖于内核版本。旧内核可能有已知的逃逸路径。
- Bubblewrap 依赖 user namespace，某些容器环境（如 Docker）默认禁用 user namespace。
- macOS Seatbelt 的沙箱策略文件语法复杂，写错一个规则就可能导致意外的权限开放。

**这不是说沙箱没用。而是说沙箱是「降低风险」而不是「消除风险」。** 开发者不应该因为有了沙箱就放松对 Agent 输出的审查。

**审批系统的误判问题。** Codex 的 Guardian AI 审查者用 AI 来审查 AI 的操作。但 AI 审查者本身也可能犯错：
- 它可能批准一个看起来无害但实际上危险的命令（比如 `rm -rf /tmp/important_data`）
- 它可能拒绝一个安全的命令（误报），导致 Agent 无法完成任务
- 它的判断依赖于上下文，但上下文可能被恶意构造（提示注入）

**Hermes 的提示注入检测也有类似问题。** `threat_patterns.py` 是基于模式匹配的。它能检测已知的注入模式，但对新型注入无能为力。而 LLM 本身是提示注入的最大攻击面，这部分的防御远未完善。

**沙箱与可用性根本矛盾。** 这是四个项目都面临的权衡：沙箱越严格，Agent 能做的事情越少。Codex 的强制沙箱意味着 Agent 不能随意安装依赖、访问系统工具、修改环境变量。在某些开发场景下（比如需要编译 C 代码、需要访问 GPU、需要读取系统文件），开发者不得不手动放宽沙箱策略。**安全和便利永远是跷跷板的两端。**

**量化数据：沙箱真的有用吗？** 一项研究（2026）直接对比了 Claude Code 和 Codex CLI 的安全表现：

| Agent | Patch 成功率 | Exploit 成功率 | 解读 |
|-------|------------|--------------|------|
| Claude Code | 87.5% | 57.5% | 防守强于进攻 |
| Codex CLI (o3-high) | 90% | 47.5% | 沙箱限制了攻击能力 |
| Codex CLI (o4-mini) | 90% | 32.5% | 更便宜的模型，更弱的攻击 |
| C-Agents（无沙箱） | 25-60% | 17.5-67.5% | 攻防均衡，但都不强 |

**结论：沙箱确实限制了 Agent 的攻击能力，同时保留了修复能力。** Codex 的 Patch 成功率高达 90%，但 Exploit 只有 32.5-47.5%。这意味着沙箱让 Agent 变成了一个「好的修理工，但不是好的黑客」。没有沙箱的 C-Agents 攻防更均衡，但整体能力更弱。安全不是免费的，但它确实有效。

---

## 七、状态管理与上下文压缩：怎么记住发生了什么

**本章从架构视角概述四个项目的状态管理设计。运行时代的价（内存增长、压缩成本、用户感知的延迟）在 2.7 节已经分析过，这里聚焦于「设计选择」而非「实际开销」。**

### 7.1 Hermes：SQLite 全文搜索

Hermes 的状态管理基于 **SQLite**（`hermes_state.py`），使用了几个高级特性：

1.**WAL 模式** 。允许多个并发读取器 + 一个写入器，这对于网关多平台场景很重要——Telegram、Discord、Slack 等平台可能同时访问同一个会话。

2.**FTS5 虚拟表**。 提供全文搜索能力。`hermes_state_search.py` 实现了 `SessionSearchMixin`，支持：
- 跨所有会话消息的全文搜索
- 三元组索引（trigram indexing）
- CJK（中日韩）字符支持

3.**上下文压缩器**（`Hermes: agent/context_compressor.py`）在接近模型 token 限制时自动压缩：
- 使用廉价辅助模型（默认 `google/gemini-3-flash-preview`）总结中间回合
- 保护头部（系统提示、前几轮）和尾部（最近上下文）
- 结构化摘要模板，跟踪已解决/待解决问题
- 迭代式摘要更新，跨多次压缩保留信息
- Token 预算尾部保护，而不是固定消息数
- LLM 总结前的工具输出裁剪（廉价预处理）

4.**轨迹压缩器**（`trajectory_compressor.py`）后处理完成的 Agent 轨迹用于训练数据：
- 保护首回合（系统、人类、首个助手、首个工具）
- 保护最后 N 个回合（最终操作）
- 只压缩中间回合
- 用单个摘要消息替换压缩区域

5.**上下文引擎插件系统**（`Hermes: agent/context_engine.py`）定义了抽象基类 `ContextEngine`，允许可插拔的上下文管理。内置的 `ContextCompressor` 是默认实现。第三方引擎（如 LCM）可以通过插件系统替换它。

### 7.2 DeepSeek：事件溯源的不可变日志

DeepSeek Harness 的状态管理是四个项目中最优雅的——**事件溯源**。

`SessionStore` 是一个只追加的事件日志。每个 `SessionEvent` 带有顺序 `seq` 号，所有事件都是深度冻结的（deeply frozen）。**不可变性是核心约束。**

关键设计：**LLM 消息历史是从日志派生的**，而不是直接存储的。`deriveMessages()` 从事件日志重建消息列表。

这意味着：
- 你可以在任意时间点重建历史状态
- 审计每个决策的完整上下文
- 实现精确的撤销和重放
- 持久化是插件的职责——插件订阅 `session/event` 并在 `session/flush` 时排空

事件类型包括：
- `turn/start`、`turn/end` — 回合边界
- `step/start`、`step/end` — 步骤边界
- `user/message`、`assistant/message` — 对话事件
- `tool/call`、`tool/result` — 工具事件
- `request/header`、`request/context` — LLM 配置事件
- `approval/asked`、`approval/decided` — 权限事件

### 7.3 Codex：Rollout 持久化

Codex 的状态管理围绕 **Rollout**（会话历史文件）展开。

`RolloutRecorder` 处理会话持久化。会话可以：
- **恢复**（resume） — 从断点继续
- **分叉**（fork） — 从某个时间点创建新分支
- **归档**（archive） — 标记为已完成
- **删除**（delete） — 永久删除

`conversation` 模块管理实时对话状态，包括消息历史、工具调用记录、上下文窗口管理。

`NewContextWindowHandler` 允许模型在需要时开始新的上下文窗口。当当前上下文变得太大或太混乱时，这是一个有用的重置机制。

`GetContextRemainingHandler` 让模型检查剩余的 token 预算，帮助它决定是否需要压缩或开始新窗口。

### 7.4 压缩策略对比

| 维度 | Hermes | DeepSeek | Codex | OpenCode |
|------|--------|----------|-------|----------|
| 存储后端 | SQLite + FTS5 | 事件日志（内存/插件持久化） | Rollout 文件 | SQLite（Drizzle ORM） |
| 不可变性 | 无（可变状态） | 深度冻结事件 | 无显式约束 | 无显式约束 |
| 压缩方式 | 辅助模型摘要 | 事件日志截断 | NewContextWindow | **专用 Compaction Agent** |
| 搜索能力 | FTS5 全文搜索 + CJK | 事件过滤 | 无显式搜索 | 无显式搜索 |
| 恢复能力 | 会话链（parent_session_id） | 事件重放 | Rollout resume/fork | Session fork |
| 训练数据 | 轨迹压缩器 | 无 | 无 | 无 |

### 7.5 上下文压缩的隐性代价

上下文压缩是 Agent 能处理长任务的关键机制，但它不是免费的午餐。

**Hermes 的辅助模型摘要有三个问题：**
1. **信息丢失**：廉价模型的摘要能力有限，可能遗漏关键细节。比如 Agent 在第 5 轮发现了一个 bug，在第 15 轮找到了根因——摘要可能只保留「发现并修复了 bug」，丢失根因分析。
2. 摘要错误误导 Agent：如果摘要产生了幻觉（比如把「文件 A 有 bug」总结成「文件 B 有 bug」），后续 Agent 会基于错误的摘要继续工作，越走越偏。
3. Token 成本：每次压缩都需要调用辅助模型。虽然用的是廉价模型，但在长会话中多次压缩的累计成本不可忽视。

**DeepSeek 的事件日志截断也有代价：** 截断后如何保证状态一致性？如果截断点恰好在一个工具调用和它的结果之间，deriveMessages() 会产生一个没有结果的工具调用。这对 LLM 来说是异常输入。

**Codex 的 NewContextWindow 是最粗暴的方案：** 直接开始新窗口意味着丢失所有历史上下文。Agent 必须从零开始理解当前状态，这在复杂任务中可能导致重复工作或方向偏离。

**四个项目都没有提供「压缩质量验证」机制。** 没有办法自动检测压缩是否丢失了关键信息。这是一个开放问题，目前只能靠人工审查。

上下文压缩是智能体应对有限认知资源的工程解法。人类的遗忘是自适应的——重要的记忆被强化，无关的细节被丢弃。Agent 的压缩是粗暴的——要么按 token 预算截断，要么让辅助模型做摘要。**当上下文窗口不再是瓶颈的那一天，压缩问题会消失；但「如何在有限资源下保持认知连贯」这个问题，会以新的形式回来。**

---

## 八、多 Agent 编排：怎么让多个 Agent 协作

### 8.1 Hermes：委托工具 + 看板

Hermes 的多 Agent 系统围绕 `delegate_tool`（`Hermes: tools/delegate_tool.py`）构建。

**委托工具** 生成子 `AIAgent` 实例：
- 新的对话（无父历史）
- 独立的 task_id（独立的终端会话、文件操作缓存）
- 父 Agent 的工具集减去被阻止的工具（`delegate_task`、`clarify`、`memory`、`send_message`、`cronjob`）
- 从委托目标 + 上下文生成的聚焦系统提示
- 单任务和批量（并行）模式

**子 Agent 生命周期**（`Hermes: agent/subagent_lifecycle.py`）提供公共的、插件安全的生命周期 API：

```python
@dataclass(frozen=True)
class SubagentLaunchRequest:
    goal: str
    context: str
    role: str
    model: str
    allowed_toolsets: list[str]
    blocked_tools: list[str]
    working_directory: str
    timeout: int
```

`SubagentState` 枚举：PENDING、STARTING、RUNNING、SUCCEEDED、FAILED、INTERRUPTED、CANCEL_REQUESTED、CANCELLED。

**看板工具**（`Hermes: tools/kanban_tools.py`）实现多 Agent 任务协调：`kanban_show`、`kanban_list`、`kanban_complete`、`kanban_block`、`kanban_request_review`、`kanban_create`、`kanban_link` 等。这是一种结构化的多 Agent 协作方式——Agent 通过看板共享任务状态。

### 8.2 DeepSeek：Agent 注册表 + 作用域

DeepSeek Harness 的多 Agent 系统基于 `AgentRegistry`，一个 Cordis 服务（`ctx.agents`）。

> `DeepSeek: packages/core/agent/src/index.ts#L256`

```typescript
export class AgentRegistry extends Service {
  private store = new Map<SessionId, AgentEntry>()       // 活跃 Agent 跟踪
  private factory: FactorySlot | undefined                // 工厂委托
  private readonly initiators = new AsyncLocalStorage<Agent | undefined>()  // Initiator 链

  withInitiator<T>(agent: Agent, operation: () => T): T {
    return this.runWithInitiator(agent, operation)  // 为异步链建立因果归属
  }

  withoutInitiator<T>(operation: () => T): T {
    return this.runWithInitiator(undefined, operation)  // 为共享基础设施清除归属
  }
}
```

**Initiator 链** 是一个巧妙的设计——`withInitiator(agent, op)` 用 `AsyncLocalStorage` 为异步链建立因果归属，`withoutInitiator(op)` 为共享基础设施清除归属。这意味着你可以在异步操作中追溯「是谁发起了这个操作」。

**作用域系统**提供基于身份的分层事件路由——事件**向上**流动（父监听器接收所有后代的事件），不向下流动（兄弟之间隔离）。

> `DeepSeek: packages/core/scope/src/index.ts#L39`

```typescript
// 父子关系：一个 WeakMap 链，事件沿链向上冒泡
const scopeParents = new WeakMap<ScopeKey, ScopeKey>()

export function bindScopeParent(key: ScopeKey, parent: ScopeKey): ScopeParentBinding {
  if (scopeParents.has(key)) {
    throw new Error('dsh-scope: scope key is already bound to a parent')
  }
  linkScopeParent(key, parent)
  return { rebind(next: ScopeKey): void { linkScopeParent(key, next) } }
}
```

这让一个组合可以观察其下所有 Agent 的行为，而兄弟 Agent 之间完全隔离。

### 8.3 Codex：AgentControl + Channel

Codex 的多 Agent 编排通过 `AgentControl`（Codex: `codex-rs/core/src/agent/control.rs`）实现。

```rust
// Agent 注册表
struct AgentRegistry {
    agents: HashMap<AgentId, AgentEntry>,
}

// Agent 间通信
enum InterAgentCommunication {
    Message { from: AgentId, to: AgentId, content: String },
    Broadcast { from: AgentId, content: String },
}
```

`AgentControl` 管理：
- **Agent 注册表** — 跟踪所有活跃 Agent
- **子 Agent 生成** — `SpawnAgentOptions` 配置生成参数
- **Agent 间通信** — `InterAgentCommunication` 消息路由
- **状态跟踪** — `watch::Receiver<AgentStatus>`
- **执行限制器** — `AgentExecutionLimiter` 防止资源耗尽
- **Rollout 预算** — 控制会话持久化成本

### 8.4 编排模式对比

| 维度 | Hermes | DeepSeek | Codex | OpenCode |
|------|--------|----------|-------|----------|
| 隔离模型 | 进程内新实例 | 作用域隔离 | Channel 通信 | **Session + 权限继承** |
| 通信方式 | 委托工具 + 看板 | 事件路由 | InterAgentCommunication | 合成消息注入 |
| 生命周期 | SubagentLifecycleService | AgentHandle + Fiber | AgentRegistry | Effect Fiber |
| 资源控制 | IterationBudget（50次） | 作用域限制 | AgentExecutionLimiter | subagent_depth 限制 |
| 协作模式 | 看板（结构化） | 事件（隐式） | 消息（直接） | 前台/后台任务 |
| 权限隔离 | 子 Agent 默认自动拒绝 | scope 继承 | 无 | **deny 规则继承 + 收紧** |

### 8.5 多 Agent 的现实代价

多 Agent 编排听起来很美好。把大任务拆成小任务，分发给子 Agent 并行执行。但现实远比架构图复杂。

1.**子 Agent 结果可靠性问题。** 父 Agent 把任务委托给子 Agent 后，它只能看到子 Agent 返回的摘要，看不到子 Agent 的完整推理过程。如果子 Agent 的摘要丢失了关键信息（或者更糟——产生了幻觉），父 Agent 会基于错误信息继续决策。**四个项目都没有提供子 Agent 结果的验证机制。**

2.**上下文隔离与信息共享的矛盾。** 子 Agent 有独立的上下文，这保证了隔离性，但也意味着它无法访问父 Agent 的完整知识。Hermes 的子 Agent 继承父 Agent 的工具集但不继承对话历史；DeepSeek 的作用域隔离让事件不向下流动；Codex 的 Channel 通信只传递消息不传递上下文；OpenCode 的子 Agent 有自己的 Session 和消息历史，通过 `parentID` 链接但不共享内容。**当子 Agent 需要父 Agent 的某些知识才能完成任务时，当前的隔离模型就成了障碍。**

3.**子 Agent 错误传播。** 子 Agent 失败后，父 Agent 怎么办？重试？换策略？报告用户？Hermes 的 SubagentState 有 FAILED 状态，但没有自动重试机制。DeepSeek 的 AgentHandle 有 dispose()，但错误处理依赖消费者实现。Codex 的 AgentExecutionLimiter 可以限制重试次数，但策略选择仍然需要上层逻辑。OpenCode 的后台子 Agent 失败后通过合成消息通知父 Agent，但重试逻辑仍然由父 Agent 的 LLM 决定。**错误恢复的策略选择，四个项目都留给了使用者，没有内置的最佳实践。**

---

## 九、Agent 的现实顽疾：四个项目怎么处理真正棘手的问题

前面的章节讲了「代码长什么样」，这一章讲「代码会出什么问题」。Agent 开发中有几个公认的顽疾，看看四个项目各自怎么应对。

### 9.1 LLM 输出格式崩坏

模型不输出合法的 tool call 格式，是 Agent 开发中最常见的问题之一。模型可能输出自由文本而不是 JSON、可能遗漏必需参数、可能输出不存在的工具名。

**Hermes 的处理：** `bounded_response.py` 尝试从模型输出中提取结构化数据，失败则回退为文本响应。但这种「尽力解析」的策略意味着你不知道模型到底想调用什么工具——是应该重试还是应该接受文本输出？

**DeepSeek 的处理：** 工具调用解析在 `tool-calls.ts` 中，解析失败会触发 `tools/pre-execute` 水龙头的错误事件。插件可以拦截这个错误并决定是重试、降级还是报错。**水龙头架构在这里体现了优势——错误处理是可插拔的。**

**Codex 的处理：** Responses API 对格式有严格要求，格式错误会导致 API 层面的错误返回。Codex 的 `ModelClientSession` 会捕获这些错误并通过 Channel 传播到 TUI。**严格的 API 规范减少了格式崩坏的概率，但代价是只能用支持 Responses API 的模型。**

> 坦白说，四个项目都没有很好的解决方案。这个问题的根本原因在模型端，Agent 框架只能做防御性编程。Hermes 的「尽力解析」最务实但最不可靠——你永远不知道下一次模型输出会是什么格式；DeepSeek 的「可插拔错误处理」最灵活但增加了复杂度——你需要自己写错误处理插件；Codex 的「严格 API」最可靠但限制了模型选择——你不能用不支持 Responses API 的模型；OpenCode 的 AI SDK 层有格式容错但同样无法处理严重的格式崩坏。这不是框架的问题，是整个行业的问题。Ugare & Chandra (2026) 的研究也指出，当前 Agent 在代码推理任务上的表现高度依赖模型的输出格式稳定性——格式崩坏不仅影响工具调用，还直接影响推理质量(Ugare & Chandra, 2026)。

### 9.2 Agent 振荡死循环

不是简单的重复调用，而是**逻辑绕圈**：Agent 尝试方案 A → 失败 → 尝试方案 B → 失败 → 回到方案 A → 失败 → 尝试方案 B → ……这种循环中，每次调用的参数可能不同，所以简单的重复检测发现不了。

**Hermes 的处理：** `repetition_guard.py` 检测相同的工具调用和输出。对于逻辑绕圈，它依赖 `IterationBudget` 作为最终兜底——预算耗尽就强制停止。**但 500 次迭代的预算可能在绕圈中被快速消耗，而用户只看到一个很长的「思考中...」。**

**DeepSeek 的处理：** 事件日志记录了每一步，理论上可以通过分析事件模式检测绕圈。但 `ReactLoopAgent` 没有内置这种检测。它只在 `turn/end` 事件中记录原因，不分析中间步骤的模式。

**Codex 的处理：** `AgentExecutionLimiter` 提供了硬限制，但同样没有模式检测。Codex 的 TUI 可以实时显示 Agent 的操作，用户可以手动中断——**把检测责任交给了人类。**

> 这是四个项目都没有很好解决的问题。逻辑绕圈检测需要语义级别的分析（「方案 A 和方案 B 本质上是同一个思路」），这超出了当前框架的能力。Hao et al. (2026) 的消融实验也验证了这一点：限制 Agent 的代码执行能力（`execute_code`）在某些任务上反而提升了成功率，因为 Agent 不再有机会陷入无意义的执行循环。实际工程中，最常见的做法是：设置合理的预算上限 + 让用户可以随时中断。

### 9.3 上下文压缩的信息丢失

前面在状态管理章节提到了压缩的代价，这里从「顽疾」角度再深入一下。

**核心矛盾：** 上下文窗口有限，但 Agent 任务可能需要记住很久以前的信息。压缩是必须的，但压缩一定会丢失信息。

**Hermes 的方案最「智能」但最不可控。** 用辅助模型做摘要，理论上可以保留语义级别的信息。但你怎么验证摘要的质量？你怎么确保关键细节没有被遗漏？**你不能。因为你已经把原文丢掉了。**

**DeepSeek 的方案最「可审计」但最不「智能」。** 事件日志保留了原始数据，截断只是丢弃旧事件。但截断后 deriveMessages() 重建的消息列表可能不完整。比如一个工具调用的结果被截断了，只剩下调用本身。

**Codex 的方案最「粗暴」但最「可预测」。** NewContextWindow 直接开始新窗口，用户明确知道历史被丢弃了。Agent 可以通过 GetContextRemainingHandler 检查剩余预算，提前规划。

> **没有完美方案。** 当前最好的实践是：保护头部（系统提示）+ 保护尾部（最近上下文）+ 压缩中间部分。但「中间部分」压缩到什么程度、用什么模型压缩、压缩后如何验证——这些都是开放问题。

### 9.4 沙箱安全与可用性的矛盾

这是安全章节的延伸，但值得单独讨论，因为这是**日常开发中最常遇到的问题**。

**场景：** 你让 Agent 帮你编译一个 C 项目。编译需要 `gcc`、`make`、系统头文件、网络下载依赖。在严格沙箱下，这些都可能被阻止。

**Hermes 的 7 种终端后端** 看起来选择很多，但选择本身就是一种负担。用户需要理解每种后端的安全边界，才能做出合理的选择。选错了要么不安全，要么不可用。

**DeepSeek 的三种模式**（read-only/workspace-write/full-access）更简洁，但粒度太粗。`full-access` 意味着完全不限制，`workspace-write` 又可能太严格。**缺少「自定义策略」的中间层。**

**Codex 的强制沙箱** 是最安全的，但也是最常被用户抱怨的。`AskForApproval` 的 `UnlessAllowListed` 模式需要用户维护白名单。这本身就是一种运维负担。而且白名单策略很难覆盖所有场景：同一个命令在不同上下文中可能安全也可能危险。

> **这个矛盾没有技术解决方案，只有工程权衡。** 四个项目选择了不同的权衡点：Hermes 给选择（7 种后端），DeepSeek 给简单（3 种模式），Codex 给安全（强制沙箱），OpenCode 给自由（无沙箱但权限隔离）。选哪个取决于你的安全需求和开发节奏。

### 9.5 MCP 集成的隐性问题

文章前面提到三个项目都支持 MCP，但 MCP 集成带来的问题很少被讨论。

1.**进程生命周期管理。** MCP 服务器是独立进程，通过 stdio 或 HTTP 与 Agent 通信。如果 MCP 服务器崩溃了怎么办？如果它卡住了怎么办？如果它占用了太多内存怎么办？

Hermes 的 MCP 客户端（`Hermes: tools/mcp_tool.py`）有自动重连机制（最多 5 次指数退避），但没有内存限制。一个失控的 MCP 服务器可以吃掉所有内存。

2.**安全风险。** MCP 服务器可以访问 Agent 的工具调用上下文。如果 MCP 服务器被恶意构造（或者被注入），它可以窃取敏感信息或篡改工具结果。Hermes 的环境变量过滤和凭据剥离是防御措施，但不完整。

3.**可靠性。** MCP 服务器的可用性直接影响 Agent 的可靠性。如果一个 MCP 服务器响应慢，整个 Agent 循环都会被拖慢。四个项目都没有对 MCP 调用设置严格的超时限制。

### 9.6 当网络抖了一秒：故障场景下的分化

一切顺利时，四个 Agent 的行为很像——调用 LLM、执行工具、返回结果。但**当外部依赖突然挂掉时，它们的分化开始了。** 这才是真正检验架构质量的时刻。

**场景一：主模型 API 突然超时。**

Hermes 的降级链会自动切换到下一个 Provider。听起来很美好，但有一个隐蔽的坑：**降级到弱模型可能导致工具调用格式崩坏。** 比如主模型是 Claude 4，降级到 Gemini Flash——Gemini 的 tool call 格式和 Claude 不完全兼容，可能导致解析失败。Hermes 的 `error_classifier.py` 会分类错误原因，但它无法预判「降级后的模型能不能正确调用工具」。**降级链的安全性取决于最弱的那个环节。**

DeepSeek Harness 的 `llm-retry` 插件会重试，但重试策略是固定的。如果 Provider 持续超时，它会一直重试直到超时耗尽。事件日志会记录 `llm/error` 事件，但不会自动切换到其他 Provider（DeepSeek Harness 的适配器是按 Provider 注册的，切换需要插件层面的逻辑）。

Codex 的 `ModelClientSession` 在 API 超时后通过 Channel 发送错误事件，TUI 显示错误信息。**它不会自动降级**——用户需要手动切换模型。这看起来不智能，但避免了 Hermes 那种「降级到弱模型导致连锁失败」的风险。

OpenCode 的 AI SDK 层有内置的重试机制（`@ai-sdk` 的 retry 逻辑），但同样不会自动切换 Provider。好消息是 OpenCode 支持 100+ Provider，用户可以手动切换到任何可用的模型。切换只需要改一行配置。坏消息是 Effect 的错误模型虽然类型安全，但错误信息对用户不友好——你看到的是一堆 Effect 的错误栈，不是「API 超时，请重试」。

**场景二：MCP 服务器突然断连。**

Hermes 的 MCP 客户端有自动重连（最多 5 次指数退避），但重连期间 Agent 循环会阻塞。如果 Agent 正在执行一个依赖 MCP 工具的多步任务，中间一步 MCP 断连，重连成功后 Agent 需要重新理解上下文继续执行——**但上下文可能已经被压缩过了。**

DeepSeek Harness 的不可变事件日志在 MCP 断连时会记录 `tool/error` 事件。但问题是：如果 MCP 服务器在返回结果的中途断连，事件日志中会有一个「工具调用已发出但没有结果」的事件。`deriveMessages()` 重建消息时会产生一个没有 result 的 tool call。这对 LLM 来说是异常输入，**可能导致模型困惑并产生错误的后续调用。**

Codex 的沙箱隔离在这里反而成了优势。MCP 服务器运行在沙箱外，它的崩溃不会影响沙箱内的 Agent 进程。但 MCP 工具调用失败后，Agent 需要决定是重试还是跳过——这个决策逻辑在 `ToolRouter` 中，但策略选择仍然依赖模型。

**场景三：沙箱内核不支持。**

Codex 的 Landlock 需要 Linux 5.13+。如果你在旧内核上运行，**不会崩溃**——`SandboxManager` 会检测内核版本，如果不支持 Landlock，会降级到 Bubblewrap。但如果 Bubblewrap 也不可用（比如容器环境禁用了 user namespace），Codex 会**拒绝执行 Shell 命令**而不是冒险在无沙箱环境下运行。这是最安全的做法，但也是最让用户沮丧的——「我只想运行一个简单的命令，为什么不行？」

Hermes 的 7 种终端后端看起来选择多，但**降级逻辑不够透明**。如果 Docker 不可用，它会降级到本地执行——用户可能根本没注意到自己从「容器隔离」降级到了「裸机执行」。**安全等级的静默降级比明确拒绝更危险。**

DeepSeek 的沙箱系统会在启动时检测可用的后端，如果 Landlock 不可用会回退到 bubblewrap，再不可用则回退到无沙箱模式。但 `escalation.ts` 的升级系统在无沙箱模式下仍然允许工具请求 `danger-full-access`——**这意味着在不支持沙箱的环境中，安全机制形同虚设。**

> **总结：当一切顺利时它们很像，但当网络抖了一秒时，Hermes 靠降级链硬撑（但可能降级到不兼容的模型），DeepSeek 靠事件日志记录（但可能产生不一致状态），Codex 靠拒绝执行（但可能让用户抓狂），OpenCode 靠手动切换 Provider（但需要用户自己判断换哪个）。没有完美方案，只有不同的「体面失败」方式。**

---

## 十、CLI/TUI 与用户界面：怎么跟人交互

### 10.1 Hermes：prompt_toolkit + 多平台网关

Hermes 的 CLI 是一个基于 `prompt_toolkit` 的丰富 TUI，核心在 `cli.py` 中实现。

**Mixin 架构** 是 Hermes CLI 的独特设计：
- `CLIAgentSetupMixin` — 初始化和设置
- `CLICommandsMixin` — 斜杠命令处理
- `CLIBillingMixin` — 计费显示

**布局** 使用 `prompt_toolkit` 的 `Application` + `HSplit` 布局，固定输入区域。支持：
- 多行编辑
- 斜杠命令自动补全
- 对话历史
- 流式工具输出 + 可爱的 spinner
- 固定输入区域布局

**多平台网关** 是 Hermes 最独特的功能——同一个 Agent 可以通过 8 个平台交互：
- Telegram
- Discord
- Slack
- WhatsApp
- Signal
- Email
- Microsoft Teams
- Google Chat

每个平台有自己的适配器，但共享同一个 `AIAgent` 实例和 SQLite 状态库。WAL 模式的 SQLite 确保并发安全。

### 10.2 DeepSeek：React Web UI + Cordis Loader

DeepSeek Harness 的客户端是一个 **React 应用**，通过 Cordis Loader 双阶段引导启动。

**两阶段引导**：
1. **模块系统** — `ClientModuleSystem` 管理插件包（静态 + 动态获取）
2. **启动清单** — `window.__DSH_BOOT__` 提供要加载的模块图
3. **预取层** — 立即层的包与 Loader 挂载并行获取
4. **稳定化** — 所有条目稳定且 Fiber 扫描后，UI 从加载页面切换到真实应用

**40+ UI 组件包**：
- `ui-conversation/` — 聊天界面
- `ui-trajectory/` — Agent 轨迹视图
- `ui-tool/` — 工具调用可视化
- `ui-settings/` — 设置面板
- `ui-sidebar/` — 侧边栏导航
- `ui-plan/` — 计划模式显示
- `ui-skill/` — 技能调用 UI
- `ui-layout/` — 布局系统
- `ui-theme/` — 主题
- `schema-form/` — 从 schema 动态渲染表单

**工具展示系统** 是 DeepSeek Harness UI 的亮点——工具通过 `presentCall()` 和 `presentResult()` 声明自己的展示方式，UI 根据卡片类型（`terminal`、`diff`、`read`、`search`、`web`）选择合适的组件渲染。

### 10.3 Codex：ratatui TUI

Codex 的 TUI 是用 **ratatui**（Rust TUI 框架，tui-rs 的继任者）+ **crossterm** 构建的纯 Rust 终端 UI。**不是 React/Ink**（那是旧 TypeScript 版本）。

`App` 结构体是顶层应用状态，管理：
- `ChatWidget` — 主聊天显示
- `BottomPane` — 输入区域、审批弹窗、选择器
- `FileSearchManager` — 文件搜索覆盖层
- `ModelCatalog` — 模型选择
- `KeyChordMatcher` — 键盘快捷键处理
- `RuntimeKeymap` — 动态键绑定
- `TranscriptReflowState` — 终端调整大小处理
- `BacktrackState` — 对话回溯

**快照测试** 是 Codex TUI 的一个工程亮点——使用 `insta` crate 对渲染输出进行快照测试。AGENTS.md 要求所有 UI 变更都必须有快照覆盖。这意味着你可以在不启动 UI 的情况下验证渲染是否正确。

**审批弹窗**（`approval_events.rs`）是 TUI 中的一个重要交互元素。当 Agent 尝试执行危险操作时，TUI 会弹出审批请求，用户可以选择批准、拒绝或修改命令。

### 10.4 UI 设计哲学对比

| 维度 | Hermes | DeepSeek | Codex | OpenCode |
|------|--------|----------|-------|----------|
| UI 框架 | prompt_toolkit | React + Cordis | ratatui + crossterm | @opentui + SolidJS |
| 语言 | Python | TypeScript | Rust | TypeScript |
| 界面类型 | 终端 + 8 平台网关 | Web + CLI | 纯终端 | 终端 + Server API |
| 组件化 | Mixin | 40+ 包 | Widget | SolidJS 组件 |
| 测试方式 | 无显式测试 | 无显式测试 | 快照测试（insta） | 无显式测试 |
| 工具展示 | 无抽象 | presentCall/Result | 无抽象 | 无抽象 |
| 独特功能 | 8 平台消息网关 | 工具展示卡片系统 | 快照测试覆盖 | **Plan/Build Tab 切换** |


UI 解决的是「怎么操作 Agent」的问题，但用户怎么定制 Agent 的行为——用什么模型、配什么工具、加什么插件——这些由配置与扩展系统决定。

---

## 十一、配置与扩展系统：怎么让它适应不同场景

### 11.1 Hermes：YAML 配置 + 技能系统

Hermes 的配置在 `~/.hermes/config.yaml`（YAML 格式），关键配置段：

> `Hermes: ~/.hermes/config.yaml`

```yaml
model:
  provider: openai
  default_model: gpt-4

agent:
  reasoning_effort: high
  reasoning_overrides:
    claude-4.6: xhigh
  max_iterations: 500

terminal:
  backend: docker  # local/docker/ssh/modal/daytona/vercel/singularity
  cwd: /workspace

compression:
  enabled: true
  threshold: 0.8
  summary_model: google/gemini-3-flash-preview

delegation:
  max_iterations: 50
  subagent_auto_approve: false

mcp_servers:
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
```

**技能系统** 是 Hermes 最独特的扩展机制——技能是 Markdown 格式的指令文档，放在 `skills/` 和 `optional-skills/` 目录中。它们：
- 通过 `agent/skill_utils.py` 发现（遍历技能目录，解析 frontmatter）
- 注入系统提示作为技能索引
- 通过 `/skill-name` 斜杠命令调用
- 自进化：Agent 可以在完成复杂任务后创建和编辑技能

这种「从经验中学习」的模式，是当前 Agent 框架中唯一真正实现了自我改进的案例（Karten et al., 2026）。其他三个项目的扩展机制都是静态的——插件写好了就不会自己变。

技能按类别组织：software-development、devops、research、creative、email 等。

MCP 集成 是另一个重要扩展点。Hermes 有 20+ 个预配置的 MCP 集成：Airtable、Asana、Atlassian、Datadog、Figma、Linear、Notion、Stripe、Supabase、Vercel 等。

### 11.2 DeepSeek：Profile 系统 + 插件组合

DeepSeek Harness 使用 **Profile 系统** 进行配置：

> `DeepSeek: packages/cli/src/profile.ts`

```bash
dsh --profile <name>    # 启动命名 Profile
dsh web                 # web Profile 的硬编码别名
dsh plugin --profile <name> add <pkg>  # 管理插件
dsh --dump-config       # 打印组合后的 Profile 树
```

Profile 是 `$DSH_HOME/profiles/` 下的目录，包含 `package.json` 和 `cordis.yml`。Bundle 是声明 `dsh.bundle.patch` 的包。插件管理将 `dsh.profile.bundles` 与已安装依赖对齐。

**启动序列**（`profile-boot.ts`）：
1. 加载分层 `.env` 文件（带 bootstrap-name 保护）
2. 解析配置路径（快照感知）
3. 加载 `~/.dsh` 中的用户补丁层
4. 驱动 Cordis Loader 对 `cordis.yml` 直到树稳定

**声明式组合** 是 DeepSeek Harness 的核心扩展方式。你通过 YAML 声明需要哪些插件，Cordis Loader 自动处理依赖解析和生命周期管理。

### 11.3 Codex：分层配置 + Feature Flag

Codex 的配置系统是**分层的**：

> `Codex: codex-rs/core/src/config.rs`

```
~/.codex/config.toml              # 基础配置
~/.codex/<name>.config.toml       # Profile 配置（通过 --profile）
.codex/                            # 项目级配置
云端配置                            # 远程管理的配置包
CLI 覆盖（-c key=value）           # 命令行覆盖
环境变量（CODEX_API_KEY 等）        # 环境变量
```

每层可以覆盖或约束低层的值。云端管理的配置可以强制执行策略。

**Feature Flag** 系统允许细粒度的功能控制。`features` 子命令管理功能标志。

**插件系统** 通过 `ExtensionRegistryBuilder` 注册扩展，扩展提供：
- 提示片段
- 工具定义
- 回合上下文贡献

MCP 服务器是一等扩展机制。

### 11.4 扩展性对比

| 维度 | Hermes | DeepSeek | Codex | OpenCode |
|------|--------|----------|-------|----------|
| 配置格式 | YAML | cordis.yml | TOML | JSONC |
| 扩展机制 | 技能（Markdown）+ MCP | 插件包 + Cordis | 扩展 + MCP + Feature Flag | .opencode/plugin + MCP |
| 自进化 | 技能自创建/编辑 | 无 | 无 | 无 |
| Profile | 无 | 多层 Profile 补丁 | 多层配置栈 | **8 层配置合并** |
| 云配置 | 无 | 无 | 远程配置包 | **.well-known/opencode** |
| Agent 定义 | 代码内 | 无 | 代码内 | **Markdown + frontmatter** |

### 11.5 二次开发体验：如果你要基于它们构建自己的 Agent

上面讲的是框架内部怎么工作，但如果你是一个**二次开发者**——想基于这些框架构建自己的 Agent 产品——体验会完全不同。

**基于 Hermes 开发：入门最容易，深入最痛苦。** 新增一个工具只需要写一个 Python 文件，在模块级别调用 `registry.register()`，非常简单。但如果你想修改核心循环（比如改变工具调度策略），你需要理解 3900 行的 `run_conversation`、60+ 个构造参数、以及 `_ra()` 懒导入的约定。Python 的动态类型意味着很多错误只有运行时才会暴露。

**基于 DeepSeek Harness 开发：学习曲线最陡，但扩展性最强。** 你需要先理解 Cordis 的概念——Context、Fiber、Service、Waterfall、Scope。这不是一个下午能搞定的事。但一旦理解了，你可以用非常优雅的方式扩展任何子系统：写一个插件，注册到 Cordis，一切自动工作。monorepo 的环境搭建也有门槛——pnpm workspace、100+ 个包的构建顺序、TypeScript 项目引用。

**基于 Codex 开发：最安全，但门槛最高。** Rust 本身的学习曲线就不说了。100+ 个 crate 的项目结构意味着你需要理解 crate 之间的依赖关系。Trait 扩展需要你同时更新所有实现者。但好处是：编译器会告诉你哪里错了，而不是运行时才发现。平台沙箱的调试尤其痛苦。你可能需要在三个操作系统上测试同一个功能。

**基于 OpenCode 开发：类型安全最好，但需要先学 Effect。** 新增一个工具需要定义 Effect Schema、注册到 registry、处理权限规则——步骤比 Hermes 多，但每一步都有编译时类型检查。插件系统（`.opencode/tool(s)/*.{js,ts}`）支持动态加载，不需要重启 Server。Bun 运行时的兼容性是主要风险——某些 npm 包在 Bun 上可能有意外行为。社区维护质量也是变量——核心维护者可能就几个人，PR review 周期不确定。

---

## 十二、与主流框架的定位对比：什么时候该用它们

本文聚焦的四个项目，与 LangGraph、CrewAI、MetaGPT 等框架的定位完全不同。前者提供完整的 Agent 产品，后者提供编排框架。这个区分需要更精确。

### LangGraph / CrewAI / MetaGPT 做了什么

LangGraph 是 LangChain 的 Agent 编排框架，核心是**有向图状态机**。你定义节点（函数）和边（条件跳转），LangGraph 负责执行和状态管理。CrewAI 提供了**角色扮演**的多 Agent 编排——你定义 Agent 的角色、目标、工具，CrewAI 让它们协作。MetaGPT 模拟了**软件公司的组织结构**——产品经理、架构师、工程师各司其职。

这些框架的共同特点是：**编排逻辑是用户定义的。** 你决定 Agent 的工作流、角色分工、工具选择。框架提供的是执行引擎和状态管理。

### Hermes / DeepSeek Harness / Codex / OpenCode 做了什么不同

这四个项目提供的是**完整的 Agent 产品**，不只是编排框架：
- 内置 50+ 工具（Hermes）或 15+ 工具（Codex/OpenCode），不需要用户自己写
- 内置沙箱安全系统（Codex/Hermes/DeepSeek），不需要用户自己实现
- 内置 CLI/TUI/Web UI，不需要用户自己做界面
- 内置上下文压缩、错误恢复、预算控制，不需要用户自己处理
- 内置 MCP 集成，可以连接外部服务
- 内置 100+ Provider 支持（OpenCode），不需要用户自己写适配器

**本质区别是：LangGraph 给你积木，让你自己搭房子；Hermes/Codex/OpenCode 给你一栋装修好的房子，你只需要调整家具布局。**

### 什么时候选哪个

| 场景 | 推荐 | 原因 |
|------|------|------|
| 快速原型验证 | LangGraph / CrewAI | 上手快，灵活，不需要理解复杂架构 |
| 业务自定义编排 | LangGraph | 有向图模型适合复杂业务流程 |
| 多 Agent 角色协作 | CrewAI / MetaGPT | 角色扮演模型更自然 |
| 生产级编码 Agent | Codex | 沙箱安全 + TUI + 快照测试 |
| 全平台消息 Agent | Hermes | 8 平台网关 + 自进化技能 |
| 企业级 Agent 框架 | DeepSeek Harness | 插件架构 + Web UI + 事件溯源 |
| 需要本地模型 | Codex / OpenCode | Ollama + LM Studio 支持 |
| 需要最强安全 | Codex | 沙箱优先 + Guardian AI 审查 |
| 不想被厂商锁定 | **OpenCode** | **100+ Provider，模型中立** |
| 需要 Plan/Build 分离 | **OpenCode** | **权限级 Agent 角色切换** |
| 团队有 Effect 经验 | **OpenCode** | **类型安全的依赖注入 + 结构化并发** |

**一个简单的判断标准：如果你需要「控制 Agent 的每一步」，用 LangGraph；如果你需要「Agent 自己搞定一切」，用 Hermes/Codex/Harness/OpenCode。** 但别忘了：**控制越多，责任越大；自主越多，风险越高。** 选框架不是选「最好的」，而是选「你的团队能驾驭的」。

---

## 十三、写在最后

读完这四个项目的代码，最大的感受不是「哪个框架最好」，而是「Agent 工程化还处于非常早期的阶段」。

第九章那些具体的工程顽疾——格式崩坏、振荡死循环、上下文丢失——最终都指向五个更根本的挑战：可观测性、可测试性、可预测性、成本控制、安全与自由的取舍。四套代码，四种方式，都在解决同一批问题。但没有一个真正解决了。五个问题，四个项目，零个答案。

这听起来像在批评，但其实是这个领域最让人兴奋的地方：**问题足够硬，空间足够大。** 谁能真正解决这些工程顽疾，谁就能在 Agent 时代占据先机。

现在的位置，是 Agent 的「拨号上网时代」——能用，但远没到好用的程度。五个未解决的问题——可观测性、可测试性、可预测性、成本控制、安全与自由——本质上是通向 AGI 的五个路标。工程化的早期阶段，恰恰是问题最清晰的时候。

但也正因为如此，这个领域才值得继续看下去。

### 延伸阅读

NousResearch. (2026). *Hermes Agent* [Computer software]. GitHub. https://github.com/NousResearch/hermes-agent

DeepSeek AI. (2026). *DeepSeek Harness* [Computer software]. GitHub. https://github.com/deepseek-ai/deepseek-harness

OpenAI. (2026). *Codex* [Computer software]. GitHub. https://github.com/openai/codex

anomalyco. (2026). *OpenCode* [Computer software]. GitHub. https://github.com/anomalyco/opencode

Shi, Y., Zhang, W., & Cui, T. (2026). A Programming Paradigm for Spatiotemporal Composability. *arXiv*. https://github.com/cordiverse/paper

Johnston, D., Holtz, D., Richmond, A. M., Ong, C., Tambe, P., & Chatterji, A. (2026). The Shift to Agentic AI: Evidence from Codex. *arXiv*. https://arxiv.org/abs/2606.26959

Hao, Y., et al. (2026). When Does Restricting a Coding Agent to execute_code Help? A Regime × Agent-Design Ablation. *arXiv*. https://arxiv.org/abs/2607.10569

Zhang, A. K., et al. (2025). BountyBench: Dollar Impact of AI Agent Attackers and Defenders on Real-World Cybersecurity Systems. *arXiv*. https://arxiv.org/abs/2505.15216

Karten, S., et al. (2026). Continual Harness: Online Adaptation for Self-Improving Foundation Agents. *arXiv*. https://arxiv.org/abs/2605.09998

Ugare, S., & Chandra, S. (2026). Agentic Code Reasoning. *arXiv*. https://arxiv.org/abs/2603.01896

DeepSeek AI. (2026). *Cordis Primer*. DeepSeek Harness. https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer
