// 浏览器端文章筛选运行时。等价于 wasm/article-filter/src/lib.rs。
// ArticleFilter.tsx 通过 wasmWorkerClient.filterArticles / getAllTags 调用。

interface FilterArticle {
  id: string;
  title: string;
  summary: string;
  date: string; // ISO datetime
  tags: string[];
  url: string;
}

interface FilterIndex {
  articles: FilterArticle[];
  tag_index: Record<string, number[]>;
}

interface FilterParams {
  tags?: string[];
  sort?: string;
  page?: number;
  limit?: number;
  date?: string;
}

interface FilterResult {
  articles: FilterArticle[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

let INDEX: FilterIndex | null = null;

export async function loadIndex(url: string): Promise<void> {
  const resp = await fetch(url, { cache: "no-cache" });
  if (!resp.ok) {
    throw new Error(`获取筛选索引失败: ${resp.status} ${resp.statusText}`);
  }
  INDEX = (await resp.json()) as FilterIndex;
}

export function getAllTags(): string[] {
  if (!INDEX) throw new Error("索引未初始化");
  return Object.keys(INDEX.tag_index);
}

export function filter(params: FilterParams): FilterResult {
  if (!INDEX) throw new Error("索引未初始化");
  const index = INDEX;

  let candidateIds = new Set<number>(index.articles.map((_, i) => i));

  if (params.tags && params.tags.length > 0) {
    const tagCandidates = new Set<number>();
    for (const tag of params.tags) {
      const ids = index.tag_index[tag];
      if (!ids) continue;
      for (const id of ids) tagCandidates.add(id);
    }
    candidateIds = new Set([...candidateIds].filter((id) => tagCandidates.has(id)));
  }

  if (params.date && params.date !== "all") {
    const [startStr = "", endStr = ""] = params.date.split(",");
    const start = startStr ? new Date(`${startStr}T00:00:00Z`).getTime() : null;
    const end = endStr ? new Date(`${endStr}T23:59:59Z`).getTime() : null;
    candidateIds = new Set(
      [...candidateIds].filter((id) => {
        const article = index.articles[id];
        if (!article) return false;
        const ts = new Date(article.date).getTime();
        if (Number.isNaN(ts)) return false;
        if (start !== null && ts < start) return false;
        if (end !== null && ts > end) return false;
        return true;
      }),
    );
  }

  const filtered = [...candidateIds]
    .map((id) => index.articles[id])
    .filter((a): a is FilterArticle => Boolean(a));

  switch (params.sort) {
    case "oldest":
      filtered.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      break;
    case "title_asc":
      filtered.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case "title_desc":
      filtered.sort((a, b) => b.title.localeCompare(a.title));
      break;
    default:
      filtered.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  const limit = Math.max(1, params.limit ?? 12);
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.max(1, params.page ?? 1), totalPages);
  const start = (page - 1) * limit;
  const paged = filtered.slice(start, Math.min(start + limit, total));

  return {
    articles: paged,
    total,
    page,
    limit,
    total_pages: totalPages,
  };
}
