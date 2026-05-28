# 个人静态博客系统

**GitHub**：[Cooper-Cool/my-blog](https://github.com/Cooper-Cool/my-blog)

**使用教程**：[点击查看](src/content/echoes博客使用说明.md)

**在线演示**：[blog.Cooper.com](https://blog.Cooper.com/)


## Docker 常用命令

### 首次/更新镜像后启动

```bash
docker compose up --build
```

### 后台启动

```bash
docker compose up -d --build
```

### 看日志

```bash
docker compose logs -f
```

### 停止并删除容器（保留卷）

```bash
docker compose down
```

### 停止并删除容器 + 卷（会清掉容器里的 node_modules）

```bash
docker compose down -v
```

### 进入容器

```bash
docker compose exec blog-dev sh
```

### 仅重启服务（不重建镜像）

```bash
docker compose restart blog-dev
```

### 查看镜像体积（重建前后对比，验证瘦身效果）

```bash
docker images my-blog-dev
```

## 博客与知识库更新流程

### 1. 在 Obsidian 里正常写笔记

笔记位置：`/Users/cooper/Documents/知识库`

### 2. 写完推送到知识库

```bash
cd /Users/cooper/Documents/知识库
git add .
git commit -m "更新笔记"
git push origin main
```

### 3. 更新博客中的子模块

```bash
cd /Users/cooper/Documents/GitHub/my-blog
git submodule update --remote src/content/Obsidian
git add .
git commit -m "更新知识库子模块"
git push origin master
```

## 检索 / 筛选实现（v0.2.0 起）

检索与筛选全部用纯 TypeScript 实现，构建期生成 JSON 索引、运行期在浏览器 Web Worker 中查询。无 Rust 工具链、无 WASM。

### 数据流

```text
src/content/**/*.{md,mdx}
        │
        ▼  (astro:build:done 或 dev 启动时)
src/plugins/build-search-index.mjs
        │  扫描源文件 → 解析 frontmatter → 提取标题/正文/关键词
        ▼
dist/(client/)index/search_index.json   ← 完整检索索引
dist/(client/)index/filter_index.json   ← 标签/日期筛选索引
        │
        ▼  (浏览器 fetch)
src/lib/wasm-worker.ts (Web Worker)
        │  调用 ↓
src/lib/search-runtime.ts   ← 查询、评分、高亮、补全、纠错
src/lib/filter-runtime.ts   ← 标签 / 日期 / 排序 / 分页
        │
        ▼  (postMessage)
src/components/Search.tsx / ArticleFilter.tsx  ← UI 渲染
```

### 关键文件

| 路径 | 作用 |
| --- | --- |
| `src/plugins/build-search-index.mjs` | 构建期索引生成器 |
| `src/lib/markdown-extract.mjs` | Markdown 剥离纯文本、标题提取、中英文混合分词（构建期共用） |
| `src/lib/search-runtime.ts` | 浏览器端检索逻辑 |
| `src/lib/filter-runtime.ts` | 浏览器端筛选逻辑 |
| `src/lib/wasm-worker.ts` | Web Worker 入口（文件名保留以减少 diff，内部已无 WASM） |
| `src/lib/wasmWorkerClient.ts` | 主线程 → Worker 客户端，封装消息收发 |
| `src/plugins/build-article-index.js` | Astro 集成入口：dev 启动 & build 完成各调一次索引生成 |

### 检索功能（与旧 Rust 版完全一致）

- **7 层评分**：标题前缀 115 / 标题包含 99 / 标题完全匹配 90 / title_term_index 85 / heading_term_index 80 / content_term_index 75 / 内容宽松兜底 50
- **标题树结果**：每条结果展示命中所在的小节层级，命中文本带 `<mark>` 高亮
- **±150 字符上下文窗口**：长正文只截取命中前后片段，首尾补 `...`
- **内联补全建议**：标题前缀匹配 / 常用词前缀，Tab 接受
- **拼写纠正**：Levenshtein 编辑距离 ≤ 3，琥珀色下划线提示
- **中英文混合分词**：中文 2-3 字 n-gram，英文按非字母数字切词

### 筛选功能

- 标签多选（OR 语义）
- 日期范围（`startDate,endDate` 或 `all`）
- 排序：newest / oldest / title_asc / title_desc
- 分页（默认 12 条/页）

### 索引尺寸（参考）

164 篇 / ~8.5MB markdown 源码 → `search_index.json` 约 1-3MB（gzip 后 300-800KB），`filter_index.json` < 50KB。

### 加新文章后

`src/content/**/*.md` 的变化会在下一次 `pnpm run dev`（或 `pnpm run build`）启动时被自动索引，不需要手动重建。dev 模式当前不监听文件变化重新索引，重启 dev server 即可刷新。
