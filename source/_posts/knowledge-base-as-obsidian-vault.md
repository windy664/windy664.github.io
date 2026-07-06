---
title: 让知识库长在磁盘上——把 Agent 的 RAG 存储做成一个 Obsidian vault
date: 2026-07-06 20:10:00
tags: [RAG, Agent, Vue3, Obsidian, 架构]
categories: [AI 应用]
---

上一篇 [没有 embedding 也能做 RAG](/2026/06/13/rag-without-embedding-and-not-security/) 讲的是「检索」怎么实现。这篇往前挪一步，聊一个更早、也更容易被忽略的决定：知识到底**存成什么**。大多数人一上来就是「建张表」或者「灌进向量库」，我最后选了个反直觉的答案——知识库就是磁盘上一个 Markdown 文件夹，一个能直接用 Obsidian 打开的 vault。然后我在浏览器里把 Obsidian 的双链、反链、关系图又复刻了一遍。

<!-- more -->

## 为什么不是数据库

我的用户是服务器管理员，不是工程师。他们要维护的知识是「本服规则」「商品说明」「常见问答」这种会经常改的东西。如果我把它存进 SQLite 或某个向量库文件，那么：

- 服主想改一条规则，得通过我的 UI，或者我得给他做一套增删改查；
- 想批量看/搜，得依赖我的实现；
- 出了问题想 `grep` 一下、想 `git` 记录变更历史，全都做不到。

于是我把存储定成了这样：`<dataDir>/knowledge/` 下，**每个 `.md` 文件 = 一条知识，子目录 = 分类**。这不是一个「导出成 Markdown 的功能」，而是**存储本身就是文件夹**。它带来的直接好处：

- 服主可以用 Obsidian「打开文件夹作为库」直接编辑，双向同步，零学习成本；
- 可以 `git` 版本化、可以 `grep`、可以拖进任何编辑器；
- **AI 和人读的是同一份**——Agent 改完一条，人立刻能在 Obsidian 里看到；人改完一条，Agent 下一次检索立刻拿到。

递归加载时，`folder` 取自文件相对 vault 根的父目录，`id` 取去掉扩展名的相对路径：

```kotlin
val rel = dir.relativize(file).toString().replace('\\', '/')
val id = rel.removeSuffix(".md")                       // 如 规则/pvp规则
val folder = id.substringBeforeLast('/', "")           // 如 规则/pvp
```

用相对路径当 id 有个好处：不同子目录下的同名文件不会撞 id，移动/改名也有稳定锚点。

## 两层：你的知识 vs 别人的事实

很快出现第二个问题。有些内容不该落进服主的 vault——比如插件自己的使用手册、CMI 这类官方文档。它们是「别人的事实」，该随插件版本更新，不该被服主误改，也不该混进他「自己的知识」里。

所以我分了两层：

| 层 | 是什么 | 落磁盘吗 | 能编辑吗 |
|---|---|---|---|
| 可写 vault | 你服务器的知识（规则/FAQ/商品） | 是 | 是 |
| 只读参考库 | 别人的事实（手册/CMI），打进 jar | **否** | 否 |

关键在于：**只读层只并进检索索引，不落 vault、不进可编辑目录树**。Agent 检索时两层一起搜、无感；但列表、编辑、目录树只认 vault：

```kotlin
// 统一检索索引 = 可写 vault + 只读参考库（Agent 一次搜全）
store = KeywordKnowledgeStore(entries + reference.entries)
// 但 metadata() 只回 vault（可编辑那部分）
```

这行 `entries + reference.entries` 是整个分层的枢纽：检索面是并集，编辑面是子集。

## 在浏览器里复刻 Obsidian

存储是 vault 了，前端就顺理成章要长得像 Obsidian。三件套我都用 Vue3 搬了过来。

**双链 `[[..]]`**：给 marked 注册一个扩展，把 `[[目标]]` 渲染成可点的链接。解析靠一张名称索引——注意这张索引取的是 **vault ∪ 参考库的并集**，否则内置手册里 `[[如何使用知识库]]` 指向另一篇内置文档就断链了。

**反向链接**：这块我没有下发全文。列表接口在返回元数据时就把每条正文里的 `[[双链]]` 预解析成目标 id 数组 `links`，前端算反链只需一个 filter：

```ts
const backlinks = computed(() =>
  list.value.filter((e) => e.id !== cur.id && e.links.includes(cur.id)),
)
```

关系图、双链渲染、反链，全都吃这份 `links`，不用为了画图把几百条正文全拉下来。

**递归目录树**：磁盘上的 folder 是 `活动/2026` 这种斜杠路径，前端把它 split 成真·文件夹树，折叠状态存 `localStorage`。搜索时强制全展开，否则尊重用户折叠。

## 补上最后一块：只读层「可见但不可编辑」

分层的设计里有个洞我最近才补上。前端列表接口 `/api/kb` 一直只回 vault 的元数据——这意味着只读参考库对 **Agent 可见、对前端完全隐形**。用户问「怎么前端没显示我们的内置知识库」，我才发现前端压根没有承载它的地方。

补法是给它一个专门的只读出口，前端加一棵独立的、隐藏了编辑/删除按钮的「📚 内置知识库」树：

```kotlin
// /api/kb/reference：回参考库 packs + 条目元数据（不含正文）
// 正文点开仍走 /api/kb/entry —— 它本就 fallback 到 reference.get(id)
```

```ts
// 前端：选中条目属于只读库时，隐藏编辑/删除，显示「内置·只读」标
const refIds = computed(() => new Set(refEntries.value.map((e) => e.id)))
const selectedReadonly = computed(() => !!selected.value && refIds.value.has(selected.value.id))
```

这才让「两层」在 UI 上真正落地：一棵可编辑的 vault 树，一棵只读的内置树，泾渭分明。

## 两个顺带的数据流决定

- **列表只回元数据，正文懒加载**。一个大库几百条，列表接口只回 `{id,title,folder,tags,links}`，点开某条才拉正文。省流，也抗大库。
- **URL 是选中项的唯一真相**。选中一条就是 `router.push('/kb/<id>')`，真正取正文放在 route 监听里做。好处是刷新、书签、分享链接都能直达某一条。

## 写在最后

知识库最容易被做成一个黑盒——数据在库里，只有你的代码能进去。但知识这东西的两个受众（人要编辑、机器要检索）本可以共享一份真相。把它做成磁盘上的 vault，人拿 Obsidian 编辑、机器拿索引检索、AI 沉淀新知识，全在同一堆 `.md` 上发生。存储选对了，上层的双链、反链、关系图都只是「把文件夹画出来」而已。

热词让你以为知识库=向量库。退一步，它其实可以只是个文件夹。
