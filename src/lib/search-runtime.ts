// 浏览器端检索运行时。等价于 wasm/search/src/lib.rs 的功能，
// 与 React 组件 Search.tsx 通过相同的 SearchRequest / SearchResult JSON 契约对接。

export type SuggestionType = "completion" | "correction";

interface HeadingIndexEntry {
  id: string;
  level: number;
  text: string;
  start_position: number;
  end_position: number;
  parent_id: string | null;
  children_ids: string[];
}

interface ArticleMetadata {
  id: string;
  title: string;
  summary: string;
  date: string;
  tags: string[];
  url: string;
  content: string;
  page_type: string;
}

interface ArticleSearchIndex {
  articles: ArticleMetadata[];
  title_term_index: Record<string, number[]>;
  heading_index: Record<string, HeadingIndexEntry>;
  heading_term_index: Record<string, string[]>;
  common_terms: Record<string, number>;
  content_term_index: Record<string, number[]>;
}

interface SearchRequest {
  query: string;
  search_type?: string;
  page?: number;
  page_size?: number;
}

interface SearchSuggestion {
  text: string;
  suggestion_type: SuggestionType;
  matched_text: string;
  suggestion_text: string;
}

interface HeadingNode {
  id: string;
  text: string;
  level: number;
  content: string | null;
  matched_terms: string[] | null;
  children: HeadingNode[];
}

interface SearchResultItem {
  id: string;
  title: string;
  summary: string;
  url: string;
  score: number;
  heading_tree: HeadingNode | null;
  page_type: string;
}

interface SearchResult {
  items: SearchResultItem[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  time_ms: number;
  query: string;
  suggestions: SearchSuggestion[];
}

let INDEX: ArticleSearchIndex | null = null;

export async function loadIndex(url: string): Promise<void> {
  const resp = await fetch(url, { cache: "no-cache" });
  if (!resp.ok) {
    throw new Error(`获取搜索索引失败: ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as ArticleSearchIndex;
  INDEX = data;
}

export function search(req: SearchRequest): SearchResult {
  const start = performance.now();
  const result = req.search_type === "autocomplete"
    ? performAutocomplete(req)
    : performSearch(req);
  result.time_ms = Math.round(performance.now() - start);
  return result;
}

export const suggest = search;

function requireIndex(): ArticleSearchIndex {
  if (!INDEX) throw new Error("索引未初始化");
  return INDEX;
}

function emptyResult(req: SearchRequest, query: string): SearchResult {
  return {
    items: [],
    total: 0,
    page: req.page ?? 1,
    page_size: req.page_size ?? 10,
    total_pages: 0,
    time_ms: 0,
    query,
    suggestions: [],
  };
}

function performAutocomplete(req: SearchRequest): SearchResult {
  const query = req.query.toLowerCase().trim();
  if (!query) return emptyResult(req, query);
  const index = requireIndex();
  const suggestions = getSuggestions(index, query);
  return {
    items: [],
    total: suggestions.length,
    page: 1,
    page_size: suggestions.length,
    total_pages: 1,
    time_ms: 0,
    query,
    suggestions,
  };
}

function performSearch(req: SearchRequest): SearchResult {
  const query = req.query.toLowerCase().trim();
  if (!query) return emptyResult(req, query);
  const index = requireIndex();
  const page = req.page ?? 1;
  const pageSize = req.page_size ?? 10;

  const matched = findMatchedArticles(index, query);

  const items: SearchResultItem[] = [];
  for (const [articleIdx, score] of matched) {
    const article = index.articles[articleIdx];
    if (!article) continue;
    const headingTree = buildHeadingTreeWithMatches(article, articleIdx, query, index);
    items.push({
      id: article.id,
      title: highlightTitle(article.title, query),
      summary: article.summary,
      url: article.url,
      score,
      heading_tree: headingTree,
      page_type: article.page_type,
    });
  }

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const startIdx = (page - 1) * pageSize;
  const endIdx = Math.min(startIdx + pageSize, total);
  const paged = startIdx < total ? items.slice(startIdx, endIdx) : [];

  return {
    items: paged,
    total,
    page,
    page_size: pageSize,
    total_pages: total === 0 ? 0 : totalPages,
    time_ms: 0,
    query,
    suggestions: getSuggestions(index, query),
  };
}

function findMatchedArticles(index: ArticleSearchIndex, query: string): Array<[number, number]> {
  const seen = new Set<number>();
  const out: Array<[number, number]> = [];

  // 1. 标题以查询开头
  index.articles.forEach((article, id) => {
    const title = article.title.toLowerCase();
    if (title.startsWith(query) && title !== query) {
      out.push([id, 115]);
      seen.add(id);
    }
  });
  // 2. 标题包含查询
  index.articles.forEach((article, id) => {
    if (seen.has(id)) return;
    if (article.title.toLowerCase().includes(query)) {
      out.push([id, 99]);
      seen.add(id);
    }
  });
  // 3. 标题完全匹配
  index.articles.forEach((article, id) => {
    if (seen.has(id)) return;
    if (article.title.toLowerCase() === query) {
      out.push([id, 90]);
      seen.add(id);
    }
  });
  // 4. title_term_index
  const titleHits = index.title_term_index[query];
  if (titleHits) {
    for (const id of titleHits) {
      if (seen.has(id)) continue;
      out.push([id, 85]);
      seen.add(id);
    }
  }
  // 5. heading_term_index
  const headingHits = index.heading_term_index[query];
  if (headingHits) {
    for (const hid of headingHits) {
      const colon = hid.indexOf(":");
      if (colon < 0) continue;
      const articleId = Number(hid.slice(0, colon));
      if (Number.isNaN(articleId) || seen.has(articleId) || articleId >= index.articles.length) continue;
      out.push([articleId, 80]);
      seen.add(articleId);
    }
  }
  // 6. content_term_index
  const contentHits = index.content_term_index[query];
  if (contentHits) {
    for (const id of contentHits) {
      if (seen.has(id) || id >= index.articles.length) continue;
      out.push([id, 75]);
      seen.add(id);
    }
  }
  // 7. 宽松匹配兜底
  if (out.length === 0) {
    index.articles.forEach((article, id) => {
      if (article.content.toLowerCase().includes(query)) {
        out.push([id, 50]);
      }
    });
  }

  out.sort((a, b) => b[1] - a[1]);
  return out;
}

function highlightTitle(title: string, query: string): string {
  if (!title || !query) return title;
  const lower = title.toLowerCase();
  const q = query.toLowerCase();
  const positions: Array<[number, number]> = [];
  let from = 0;
  while (from < lower.length) {
    const idx = lower.indexOf(q, from);
    if (idx < 0) break;
    positions.push([idx, idx + q.length]);
    from = idx + q.length;
  }
  if (positions.length === 0) return title;
  let out = "";
  let last = 0;
  for (const [s, e] of positions) {
    if (s > last) out += title.slice(last, s);
    out += "<mark>" + title.slice(s, e) + "</mark>";
    last = e;
  }
  if (last < title.length) out += title.slice(last);
  return out;
}

function findMatchesInParagraph(
  article: ArticleMetadata,
  heading: HeadingIndexEntry,
  query: string,
): { highlighted: string; matched: string[] } | null {
  const contentStart = Math.min(
    heading.start_position + heading.text.length + heading.level + 1,
    article.content.length,
  );
  const contentEnd = Math.min(heading.end_position, article.content.length);
  if (contentStart >= contentEnd) return null;

  const slice = article.content.slice(contentStart, contentEnd);
  if (!slice.trim()) return null;

  const lower = slice.toLowerCase();
  const q = query.toLowerCase();
  const positions: Array<[number, number]> = [];
  let from = 0;
  while (from < lower.length) {
    const idx = lower.indexOf(q, from);
    if (idx < 0) break;
    positions.push([idx, idx + q.length]);
    from = idx + q.length;
  }
  if (positions.length === 0) return null;

  return {
    highlighted: formatMatchedContent(slice, positions),
    matched: [query],
  };
}

function formatMatchedContent(content: string, positions: Array<[number, number]>): string {
  if (positions.length === 0 || !content) return content;

  if (content.length > 300) {
    const [firstStart, firstEnd] = positions[0];
    const ctxStart = Math.max(0, firstStart - 150);
    const ctxEnd = Math.min(content.length, firstEnd + 150);
    const context = content.slice(ctxStart, ctxEnd);
    const visible = positions
      .filter(([s, e]) => s >= ctxStart && e <= ctxEnd)
      .map(([s, e]) => [s - ctxStart, e - ctxStart] as [number, number]);

    let out = "";
    let last = 0;
    for (const [s, e] of visible) {
      if (s > last) out += context.slice(last, s);
      out += "<mark>" + context.slice(s, e) + "</mark>";
      last = e;
    }
    if (last < context.length) out += context.slice(last);
    if (ctxStart > 0) out = "..." + out;
    if (ctxEnd < content.length) out += "...";
    return out;
  }

  let out = "";
  let last = 0;
  for (const [s, e] of positions) {
    if (s > last) out += content.slice(last, s);
    out += "<mark>" + content.slice(s, e) + "</mark>";
    last = e;
  }
  if (last < content.length) out += content.slice(last);
  return out;
}

function buildHeadingTreeWithMatches(
  article: ArticleMetadata,
  articleIdx: number,
  query: string,
  index: ArticleSearchIndex,
): HeadingNode | null {
  if (!query || !article.content) return null;

  const prefix = `${articleIdx}:`;
  const headingMap = new Map<string, HeadingIndexEntry>();
  for (const [id, entry] of Object.entries(index.heading_index)) {
    if (id.startsWith(prefix)) headingMap.set(id, entry);
  }

  if (headingMap.size === 0) {
    // 没有标题结构 — 把整篇正文当作单一根节点
    const rootHeading: HeadingIndexEntry = {
      id: `${articleIdx}:root`,
      level: 0,
      text: article.title,
      start_position: 0,
      end_position: article.content.length,
      parent_id: null,
      children_ids: [],
    };
    const match = findMatchesInParagraph(article, rootHeading, query);
    if (!match) return null;
    return {
      id: rootHeading.id,
      text: rootHeading.text,
      level: 0,
      content: match.highlighted,
      matched_terms: match.matched,
      children: [],
    };
  }

  const roots = [...headingMap.values()]
    .filter((h) => !h.parent_id)
    .sort((a, b) => a.start_position - b.start_position);
  if (roots.length === 0) return null;

  // 根节点之前（首个根标题之前）的内容
  const rootHeading: HeadingIndexEntry = {
    id: `${articleIdx}:root`,
    level: 0,
    text: article.title,
    start_position: 0,
    end_position: article.content.length,
    parent_id: null,
    children_ids: roots.map((h) => h.id),
  };
  const rootMatch = findMatchesInParagraph(article, rootHeading, query);

  const matchesById = new Map<string, { highlighted: string; matched: string[] }>();
  for (const [id, entry] of headingMap) {
    const m = findMatchesInParagraph(article, entry, query);
    if (m) matchesById.set(id, m);
  }

  const buildNode = (entry: HeadingIndexEntry): HeadingNode => {
    const m = matchesById.get(entry.id) ?? null;
    const node: HeadingNode = {
      id: entry.id,
      text: entry.text,
      level: entry.level,
      content: m?.highlighted ?? null,
      matched_terms: m?.matched ?? null,
      children: [],
    };
    for (const childId of entry.children_ids) {
      const child = headingMap.get(childId);
      if (child) node.children.push(buildNode(child));
    }
    node.children.sort((a, b) => (a.level - b.level) || a.text.localeCompare(b.text));
    return node;
  };

  const root: HeadingNode = {
    id: rootHeading.id,
    text: rootHeading.text,
    level: 0,
    content: rootMatch?.highlighted ?? null,
    matched_terms: rootMatch?.matched ?? null,
    children: rootHeading.children_ids
      .map((id) => headingMap.get(id))
      .filter((e): e is HeadingIndexEntry => Boolean(e))
      .map(buildNode),
  };
  root.children.sort((a, b) => (a.level - b.level) || a.text.localeCompare(b.text));
  return root;
}

function getSuggestions(index: ArticleSearchIndex, queryRaw: string): SearchSuggestion[] {
  const query = queryRaw.trim().toLowerCase();
  if (!query) {
    return Object.entries(index.common_terms)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([term]) => ({
        text: term,
        suggestion_type: "completion" as const,
        matched_text: "",
        suggestion_text: term,
      }));
  }

  type Candidate = {
    text: string;
    score: number;
    suggestion_type: SuggestionType;
    frequency: number;
  };
  const candidates: Candidate[] = [];

  // 1. 标题前缀 / 包含
  for (const article of index.articles) {
    const titleLower = article.title.toLowerCase();
    if (titleLower === query) continue;
    if (titleLower.startsWith(query)) {
      candidates.push({ text: article.title, score: 100, suggestion_type: "completion", frequency: 100 });
    } else if (titleLower.includes(query)) {
      candidates.push({ text: article.title, score: 90, suggestion_type: "correction", frequency: 90 });
    }
  }

  // 2. common_terms 前缀 / 包含
  for (const [term, freq] of Object.entries(index.common_terms)) {
    const lower = term.toLowerCase();
    if (lower === query) continue;
    if (lower.startsWith(query)) {
      candidates.push({ text: term, score: 95, suggestion_type: "completion", frequency: freq });
    } else if (lower.includes(query)) {
      candidates.push({ text: term, score: 85, suggestion_type: "correction", frequency: freq });
    }
  }

  // 3. Levenshtein
  if (candidates.length < 5) {
    const maxDist = Math.min([...query].length, 3);
    const seenText = new Set(candidates.map((c) => c.text.toLowerCase()));
    for (const [term, freq] of Object.entries(index.common_terms)) {
      const lower = term.toLowerCase();
      if (lower === query || seenText.has(lower)) continue;
      const d = levenshtein(query, lower);
      if (d <= maxDist) {
        candidates.push({
          text: term,
          score: 80 - d * 5,
          suggestion_type: "correction",
          frequency: freq,
        });
      }
    }
  }

  candidates.sort((a, b) => (b.score - a.score) || (b.frequency - a.frequency));
  return candidates.slice(0, 10).map((c) => {
    const lower = c.text.toLowerCase();
    if (c.suggestion_type === "completion" && lower.startsWith(query)) {
      return {
        text: c.text,
        suggestion_type: c.suggestion_type,
        matched_text: c.text.slice(0, query.length),
        suggestion_text: c.text.slice(query.length),
      };
    }
    return {
      text: c.text,
      suggestion_type: c.suggestion_type,
      matched_text: query,
      suggestion_text: c.text,
    };
  });
}

function levenshtein(a: string, b: string): number {
  const aChars = [...a];
  const bChars = [...b];
  const m = aChars.length;
  const n = bChars.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = aChars[i - 1] === bChars[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
