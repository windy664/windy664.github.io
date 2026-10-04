# 风吟的博客

个人技术博客，使用 Astro 生成静态页面，部署在 GitHub Pages。文章保留在 `source/_posts/`。旧文章的网址和文件名保持原样；新文章使用自动生成的固定编号，中文标题与网址编号互不影响。

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

## 新建与发表

新文章无需起英文文件名。运行：

```sh
npm run post:new -- "中文文章标题" --category 工程化 --tags "Minecraft,Velocity"
```

命令会在 `source/_posts/` 生成 `p-xxxxxxxxxxxx.md` 草稿。标题放在文件内的 `title` 字段，文件编号只用于稳定网址。`--category` 可省略，默认“思考”；`--tags` 可省略。用编辑器打开命令输出的路径，修改正文与元数据。草稿不会出现在网站、搜索、RSS 或站点地图中。

完成后运行：

```sh
npm run post:publish -- "中文文章标题"
npm run check
npm run build
git add source/_posts
git commit -m "post: publish article"
git push origin master
```

`post:publish` 会取消草稿标记，并把发布时间设为当前北京时间。推送 `master` 后 GitHub Actions 自动构建和部署；线上能否访问以 Actions 的部署结果为准。不要在文章尚未写完时手动删除 `draft: true`。

## 查找与修改

```sh
npm run post:list                    # 列出标题、状态、路径
npm run post:list -- "Velocity"      # 按中文标题或文件编号查找
```

打开查到的 Markdown 文件直接修改中文标题、正文、分类或标签，然后运行 `npm run check && npm run build`，提交并推送。**已发表文章不要改文件名或 `date`**，否则原网址会变化。需要记录修改时间时，可以在正文注明；发表日期保持原值。让 Codex 代写或代改时，直接给中文标题或文章链接即可。

Frontmatter 示例：

```yaml
---
title: 一篇文章的标题
date: 2026-10-04 23:00:00
draft: true
categories: [工程化]
tags: [Minecraft, Velocity]
description: 可选的简短摘要
---
```

- 分类沿用现有的 `AI 应用`、`工程化`、`架构`、`思考`、`踩坑`、`后端基础`、`技术分享`，每篇选一个。
- 标签优先复用已有术语。每篇保留 2–4 个真正有检索价值的标签；一次性细节写在标题或正文里。
- 首页按发布时间排序，专题页 `src/pages/topics/index.astro` 是人工整理的阅读路线；写完一组文章后记得更新。
- 文章摘要取正文开头到 `<!-- more -->` 之间的内容。这个标记可选。

这次从 Hexo 迁移保留了 35 篇文章、分类及标签页、旧文章网址，并为旧归档分页提供跳转。旧站的版本仍在 Git 历史中。
