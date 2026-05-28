// 构建期检索/筛选索引生成器。
// 替代 wasm/article-indexer/src/main.rs：直接扫描 src/content/**/*.md 源码，
// 不再依赖 Rust 工具链或构建后的 HTML 输出。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  stripMarkdown,
  extractHeadings,
  buildHeadingHierarchy,
  extractKeywords,
  isStopWord,
} from "../lib/markdown-extract.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const contentDir = path.resolve(rootDir, "src/content");

const EXCLUDED_DIRS = new Set([".git", ".obsidian", ".trash", "node_modules"]);

function walkMarkdown(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    if (entry.isSymbolicLink()) {
      // 跟随符号链接（docker-compose 把知识库挂到 src/content/Obsidian）
      try {
        const real = fs.realpathSync(path.join(dir, entry.name));
        const stat = fs.statSync(real);
        if (stat.isDirectory()) {
          out.push(...walkMarkdown(real, base));
        } else if (/\.(md|mdx)$/i.test(entry.name)) {
          out.push({ abs: real, rel: path.relative(base, path.join(dir, entry.name)) });
        }
      } catch {
        // ignore broken symlink
      }
      continue;
    }
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(...walkMarkdown(path.join(dir, entry.name), base));
    } else if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
      out.push({ abs: path.join(dir, entry.name), rel: path.relative(base, path.join(dir, entry.name)) });
    }
  }
  return out;
}

// 极简 YAML frontmatter 解析，只覆盖本项目使用的几种形式
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    const rest = kv[2].trim();
    if (rest === "") {
      // 后续以 `  - item` 形式列出的多行数组
      const arr = [];
      i++;
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
        arr.push(stripQuotes(lines[i].replace(/^\s+-\s+/, "").trim()));
        i++;
      }
      data[key] = arr;
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim();
      data[key] = inner === "" ? [] : inner.split(",").map((s) => stripQuotes(s.trim()));
    } else if (rest === "true" || rest === "false") {
      data[key] = rest === "true";
    } else {
      data[key] = stripQuotes(rest);
    }
    i++;
  }
  return { data, body: m[2] };
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// 与 src/lib/article-links.ts 的 getSpecialPath / getCanonicalArticleUrl 保持一致
function getSpecialPath(originalPath) {
  const parts = originalPath.split("/");
  const fileName = parts[parts.length - 1];
  const dirName = parts.length > 1 ? parts[parts.length - 2] : "";
  if (dirName && fileName.toLowerCase() === dirName.toLowerCase()) {
    const newFileName = fileName.startsWith("_") ? fileName : `_${fileName}`;
    return [...parts.slice(0, -1), newFileName].join("/");
  }
  return originalPath;
}

function getCanonicalArticleUrl(articleId) {
  return `/articles/${encodeURI(getSpecialPath(articleId))}`;
}

function deriveArticleId(relPath) {
  return relPath.replace(/\\/g, "/").replace(/\.(md|mdx)$/i, "");
}

function makeSummary(plainText) {
  if (!plainText) return "";
  const head = [...plainText].slice(0, 200).join("");
  return head + (plainText.length > head.length ? "..." : "");
}

function parseDate(value) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

export async function generateSearchAndFilterIndexes(outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });

  const files = walkMarkdown(contentDir);
  const articles = [];

  for (const { abs, rel } of files) {
    let raw;
    try {
      raw = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const { data, body } = parseFrontmatter(raw);
    if (data.draft === true) continue;

    const title = (data.title ?? "").toString().trim();
    if (!title) continue;

    const articleId = deriveArticleId(rel);
    const plainText = stripMarkdown(body);
    if (plainText.length < 30) continue;

    const headings = extractHeadings(body, plainText);
    const tags = Array.isArray(data.tags)
      ? data.tags.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim())
      : [];

    articles.push({
      id: articleId,
      title,
      summary: typeof data.summary === "string" && data.summary
        ? data.summary
        : makeSummary(plainText),
      date: parseDate(data.date),
      tags,
      url: getCanonicalArticleUrl(articleId),
      content: plainText,
      page_type: "article",
      headings,
    });
  }

  // ===== filter_index =====
  const filterArticles = articles.map(({ id, title, summary, date, tags, url }) => ({
    id, title, summary, date, tags, url,
  }));
  const tagIndex = {};
  filterArticles.forEach((article, idx) => {
    for (const tag of article.tags) {
      (tagIndex[tag] ??= []).push(idx);
    }
  });
  const filterIndex = { articles: filterArticles, tag_index: tagIndex };

  // ===== search_index =====
  const titleTermIndex = {};
  const headingIndex = {};
  const headingTermIndex = {};
  const contentTermIndex = {};
  const termFrequency = new Map();

  articles.forEach((article, articleId) => {
    // 标题关键词
    const titleKeywords = extractKeywords(article.title);
    for (const kw of titleKeywords) {
      if (kw.length >= 2 && !isStopWord(kw)) {
        (titleTermIndex[kw] ??= []).push(articleId);
        termFrequency.set(kw, (termFrequency.get(kw) ?? 0) + 3);
      }
    }
    // 标题的整词（按空白切分）也加入索引
    for (const w of article.title.toLowerCase().split(/\s+/)) {
      const cleaned = w.replace(/[^\p{L}\p{N}_-]/gu, "");
      if (cleaned.length >= 2 && !isStopWord(cleaned)) {
        (titleTermIndex[cleaned] ??= []).push(articleId);
      }
    }

    // 标题结构
    const hier = buildHeadingHierarchy(article.headings, articleId);
    for (const [hid, entry] of hier) {
      headingIndex[hid] = entry;
      for (const kw of extractKeywords(entry.text)) {
        (headingTermIndex[kw] ??= []).push(hid);
      }
    }

    // 内容关键词
    const contentTermFreq = new Map();
    for (const kw of extractKeywords(article.content)) {
      if (kw.length < 2 || isStopWord(kw)) continue;
      contentTermFreq.set(kw, (contentTermFreq.get(kw) ?? 0) + 1);
      (contentTermIndex[kw] ??= []).push(articleId);
    }
    for (const [kw, freq] of contentTermFreq) {
      if (freq >= 2) {
        termFrequency.set(kw, (termFrequency.get(kw) ?? 0) + 1);
      }
    }
  });

  // 去重数组化
  const dedupArrayValues = (obj) => {
    for (const k of Object.keys(obj)) {
      obj[k] = [...new Set(obj[k])];
    }
  };
  dedupArrayValues(titleTermIndex);
  dedupArrayValues(headingTermIndex);
  dedupArrayValues(contentTermIndex);

  // 取前 500 个高频词
  const commonTerms = {};
  [...termFrequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 500)
    .forEach(([term, freq]) => {
      commonTerms[term] = freq;
    });

  const searchIndex = {
    title_term_index: titleTermIndex,
    articles: articles.map((a) => ({
      id: a.id,
      title: a.title,
      summary: a.summary,
      date: a.date,
      tags: a.tags,
      url: a.url,
      content: a.content,
      page_type: a.page_type,
      headings: a.headings,
    })),
    heading_index: headingIndex,
    heading_term_index: headingTermIndex,
    common_terms: commonTerms,
    content_term_index: contentTermIndex,
  };

  const searchPath = path.join(outputDir, "search_index.json");
  const filterPath = path.join(outputDir, "filter_index.json");
  fs.writeFileSync(searchPath, JSON.stringify(searchIndex));
  fs.writeFileSync(filterPath, JSON.stringify(filterIndex));

  return {
    articleCount: articles.length,
    searchPath,
    filterPath,
    searchBytes: fs.statSync(searchPath).size,
    filterBytes: fs.statSync(filterPath).size,
  };
}
