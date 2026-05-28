// 浏览器端检索/筛选 Worker。
// 之前的实现加载 Rust 编译的 WASM 模块；现在直接调用纯 TS 运行时。
// 对外消息协议保持与 wasmWorkerClient.ts / Search.tsx / ArticleFilter.tsx 完全一致。

import {
  loadIndex as loadSearchIndex,
  search as runSearch,
  suggest as runSuggest,
} from "./search-runtime";
import {
  loadIndex as loadFilterIndex,
  filter as runFilter,
  getAllTags as runGetAllTags,
} from "./filter-runtime";

type SearchRequest = {
  query: string;
  search_type: string;
  page_size: number;
  page: number;
};

type FilterRequest = {
  tags?: string[];
  sort?: string;
  page?: number;
  limit?: number;
  date?: string;
};

type WorkerRequest =
  | { id: number; type: "initSearch"; payload: { indexUrl: string } }
  | { id: number; type: "initFilter"; payload: { indexUrl: string } }
  | { id: number; type: "search"; payload: { request: SearchRequest } }
  | { id: number; type: "suggest"; payload: { request: SearchRequest } }
  | { id: number; type: "filter"; payload: { request: FilterRequest } }
  | { id: number; type: "getTags" };

type WorkerResponse =
  | { id: number; type: "result"; payload: unknown }
  | { id: number; type: "error"; error: { message: string } };

let searchReady = false;
let filterReady = false;
let searchInitPromise: Promise<void> | null = null;
let filterInitPromise: Promise<void> | null = null;

const respond = (id: number, payload: unknown) => {
  const message: WorkerResponse = { id, type: "result", payload };
  self.postMessage(message);
};

const respondError = (id: number, error: unknown) => {
  const message: WorkerResponse = {
    id,
    type: "error",
    error: {
      message: error instanceof Error ? error.message : String(error),
    },
  };
  self.postMessage(message);
};

const ensureSearchReady = async (indexUrl?: string) => {
  if (searchReady) return;
  if (!indexUrl) throw new Error("搜索索引未初始化");
  if (!searchInitPromise) {
    searchInitPromise = loadSearchIndex(indexUrl).then(() => {
      searchReady = true;
    });
  }
  await searchInitPromise;
};

const ensureFilterReady = async (indexUrl?: string) => {
  if (filterReady) return;
  if (!indexUrl) throw new Error("筛选索引未初始化");
  if (!filterInitPromise) {
    filterInitPromise = loadFilterIndex(indexUrl).then(() => {
      filterReady = true;
    });
  }
  await filterInitPromise;
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, type, payload } = event.data;

  try {
    switch (type) {
      case "initSearch": {
        await ensureSearchReady(payload.indexUrl);
        respond(id, { ready: true });
        return;
      }
      case "initFilter": {
        await ensureFilterReady(payload.indexUrl);
        respond(id, { ready: true });
        return;
      }
      case "search": {
        await ensureSearchReady();
        respond(id, runSearch(payload.request));
        return;
      }
      case "suggest": {
        await ensureSearchReady();
        respond(id, runSuggest(payload.request));
        return;
      }
      case "filter": {
        await ensureFilterReady();
        respond(id, runFilter(payload.request));
        return;
      }
      case "getTags": {
        await ensureFilterReady();
        respond(id, runGetAllTags());
        return;
      }
      default: {
        respondError(id, `未知消息类型: ${String(type)}`);
      }
    }
  } catch (error) {
    respondError(id, error);
  }
};
