import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSearchAndFilterIndexes } from './build-search-index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');
const buildDir = path.resolve(rootDir, 'dist');
const indexDir = path.join(buildDir, 'index');
const legacyIndexDir = path.join(buildDir, 'client', 'index');

/**
 * Astro 集成：构建期生成检索/筛选索引，并在 dev 模式下经中间件提供 /index/* 静态文件。
 * @returns {import('astro').AstroIntegration}
 */
export function articleIndexerIntegration() {
  return {
    name: 'article-indexer-integration',
    hooks: {
      'astro:server:setup': async ({ server }) => {
        // dev 启动时立即生成一次索引到 dist/index/，让搜索框开箱即用
        try {
          const result = await generateSearchAndFilterIndexes(indexDir);
          console.log(
            `[indexer] dev 索引已就绪: ${result.articleCount} 篇文章 / ` +
            `search ${formatBytes(result.searchBytes)} / filter ${formatBytes(result.filterBytes)}`
          );
        } catch (err) {
          console.warn('[indexer] dev 索引生成失败:', err?.message ?? err);
        }

        // 中间件：把 /index/* 透给磁盘上的 JSON
        server.middlewares.use((req, res, next) => {
          if (!req.url || !req.url.startsWith('/index/') || req.method !== 'GET') {
            next();
            return;
          }
          const requestedFile = req.url.slice('/index/'.length).split('?')[0];
          const candidatePaths = [
            path.join(indexDir, requestedFile),
            path.join(legacyIndexDir, requestedFile),
          ];
          const existing = candidatePaths.find((p) => {
            try { return fs.statSync(p).isFile(); } catch { return false; }
          });
          if (!existing) {
            res.statusCode = 404;
            res.end('索引文件未找到');
            return;
          }
          const stat = fs.statSync(existing);
          const contentType = existing.endsWith('.json')
            ? 'application/json'
            : 'application/octet-stream';
          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Length', stat.size);
          fs.createReadStream(existing).pipe(res);
        });
      },

      'astro:build:done': async ({ dir }) => {
        // 解析客户端输出目录（Astro adapter 可能输出到 dist/client/）
        let buildDirPath = dir instanceof URL ? dir.pathname : String(dir);
        if (process.platform === 'win32' && buildDirPath.startsWith('/') && /^\/[A-Z]:/i.test(buildDirPath)) {
          buildDirPath = buildDirPath.substring(1);
        }
        let clientDirPath = buildDirPath;
        if (!buildDirPath.endsWith(path.sep + 'client') && fs.existsSync(path.join(buildDirPath, 'client'))) {
          clientDirPath = path.join(buildDirPath, 'client');
        }
        const outputDir = path.join(clientDirPath, 'index');

        console.log('[indexer] 构建完成，生成检索/筛选索引...');
        try {
          const result = await generateSearchAndFilterIndexes(outputDir);
          console.log(
            `[indexer] 已写入 ${outputDir}: ${result.articleCount} 篇文章 / ` +
            `search ${formatBytes(result.searchBytes)} / filter ${formatBytes(result.filterBytes)}`
          );
        } catch (err) {
          console.error('[indexer] 索引生成失败:', err);
          throw err;
        }
      },
    },
  };
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

// 保留旧的 named export 以兼容潜在调用方
export { generateSearchAndFilterIndexes as generateArticleIndex };
