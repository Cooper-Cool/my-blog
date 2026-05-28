// Markdown 提取与索引辅助工具，供 build-search-index 与 search-runtime 共用。
// 保持为 pure JS (.mjs) 以便 Node 与 TS 都能直接 import。

const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const IMAGE_RE = /!\[[^\]]*]\([^)]*\)/g;
const LINK_RE = /\[([^\]]*)]\(([^)]+)\)/g;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?]]/g;
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;
const HEADING_RE = /^[ \t]*(#{1,6})\s+(.+?)\s*#*\s*$/gm;

const CN_RANGES = [
  [0x4e00, 0x9fff],
  [0x3400, 0x4dbf],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2b73f],
  [0x2b740, 0x2b81f],
  [0xf900, 0xfaff],
];

const STOP_WORDS = new Set([
  "的", "是", "在", "了", "和", "与", "或", "而", "但", "如果", "因为", "所以",
  "这", "那", "这个", "那个", "这些", "那些", "并", "可以", "把", "被", "将",
  "已", "就", "也", "很", "到", "上", "下", "中", "为",
]);

function isCJK(cp) {
  for (const [lo, hi] of CN_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

export function stripMarkdown(body) {
  let text = body;
  text = text.replace(FENCE_RE, " ");
  text = text.replace(INLINE_CODE_RE, " ");
  text = text.replace(IMAGE_RE, " ");
  text = text.replace(LINK_RE, (_m, label) => (label ? String(label) : " "));
  text = text.replace(WIKILINK_RE, (_m, target, alias) => String(alias || target || " "));
  text = text.replace(HTML_TAG_RE, " ");
  text = text.replace(/^\s{0,3}>+\s?/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/[*_~]+/g, "");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{2,}/g, "\n");
  return text.trim();
}

export function extractHeadings(rawMarkdown, plainText) {
  const headings = [];
  const plainLower = plainText.toLowerCase();
  let searchCursor = 0;

  // 屏蔽代码围栏内的伪标题
  const sanitized = rawMarkdown.replace(FENCE_RE, (match) => " ".repeat(match.length));

  HEADING_RE.lastIndex = 0;
  let match;
  while ((match = HEADING_RE.exec(sanitized)) !== null) {
    const level = match[1].length;
    const rawText = match[2].trim();
    if (!rawText) continue;

    const text = stripMarkdown(rawText) || rawText;
    if (!text) continue;
    if (headings.some((h) => h.text === text)) continue;

    const lower = text.toLowerCase();
    const found = plainLower.indexOf(lower, searchCursor);
    const position = found >= 0 ? found : plainText.length;
    if (found >= 0) {
      searchCursor = found + lower.length;
    }
    headings.push({ level, text, position, end_position: plainText.length });
  }

  headings.sort((a, b) => a.position - b.position);
  for (let i = 0; i < headings.length; i++) {
    const next = headings[i + 1];
    headings[i].end_position = next ? next.position : plainText.length;
  }
  return headings;
}

export function buildHeadingHierarchy(headings, articleId) {
  const result = new Map();
  const stack = [];
  const childrenMap = new Map();

  headings.forEach((h, idx) => {
    const id = `${articleId}:${idx}`;
    let parentId = null;
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop();
    }
    if (stack.length > 0) {
      parentId = stack[stack.length - 1].id;
      const arr = childrenMap.get(parentId) ?? [];
      arr.push(id);
      childrenMap.set(parentId, arr);
    }
    result.set(id, {
      id,
      level: h.level,
      text: h.text,
      start_position: h.position,
      end_position: h.end_position,
      parent_id: parentId,
      children_ids: [],
    });
    stack.push({ id, level: h.level });
  });

  for (const [parentId, children] of childrenMap) {
    const parent = result.get(parentId);
    if (!parent) continue;
    children.sort((a, b) => {
      const pa = result.get(a)?.start_position ?? 0;
      const pb = result.get(b)?.start_position ?? 0;
      return pa - pb;
    });
    parent.children_ids = children;
  }
  return result;
}

export function extractKeywords(text) {
  const keywords = new Set();
  const lower = text.toLowerCase();
  let currentWord = "";
  let cjkBuf = [];

  const flushCjk = () => {
    if (cjkBuf.length === 0) return;
    for (let len = 2; len <= Math.min(3, cjkBuf.length); len++) {
      for (let start = 0; start + len <= cjkBuf.length; start++) {
        keywords.add(cjkBuf.slice(start, start + len).join(""));
      }
    }
    cjkBuf = [];
  };

  const flushWord = () => {
    if (currentWord.length >= 2 && !/^\d+$/.test(currentWord)) {
      keywords.add(currentWord);
    }
    currentWord = "";
  };

  for (const ch of lower) {
    const cp = ch.codePointAt(0) ?? 0;
    const isAlnum = /[a-z0-9_\-]/.test(ch);
    const isCjkChar = isCJK(cp);
    if (isAlnum) {
      flushCjk();
      currentWord += ch;
    } else if (isCjkChar) {
      flushWord();
      cjkBuf.push(ch);
    } else {
      flushWord();
      flushCjk();
    }
  }
  flushWord();
  flushCjk();
  return keywords;
}

export function isStopWord(term) {
  return STOP_WORDS.has(term);
}
