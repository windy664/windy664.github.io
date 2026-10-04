# 风吟的博客

个人技术博客，使用 Astro 生成静态页面，部署在 GitHub Pages。文章保留在 `source/_posts/`，旧文章网址保持 `年/月/日/文件名/` 格式。

## 本地运行

需要 Node.js 22.12+ 和 npm 9.6.5+。

```sh
npm ci
npm run dev
npm run check
npm run build
npm run preview
```

`npm run build` 会生成静态页面、Pagefind 搜索索引，并检查站内链接及旧网址。推送到 `master` 后，GitHub Actions 会运行相同的检查并部署。

## 写文章

在 `source/_posts/` 新建 Markdown，文件名建议使用稳定的英文短语。文件名会成为网址的一部分；发表后不要改名。Frontmatter 示例：

```yaml
---
title: 一篇文章的标题
date: 2026-10-04 23:00:00
categories: [工程化]
tags: [Minecraft, Velocity]
description: 可选的简短摘要
---
```

- 分类沿用现有的 `AI 应用`、`工程化`、`架构`、`思考`、`踩坑`、`后端基础`、`技术分享`，优先选一个。
- 标签优先复用已有术语。每篇保留 2–4 个真正有检索价值的标签；一次性细节写在标题或正文里。
- 首页按发布时间排序，专题页 `src/pages/topics/index.astro` 是人工整理的阅读路线；写完一组文章后记得更新。
- 文章摘要取正文开头到 `<!-- more -->` 之间的内容。这个标记可选。

这次从 Hexo 迁移保留了 35 篇文章、分类及标签页、旧文章网址，并为旧归档分页提供跳转。旧站的版本仍在 Git 历史中。
