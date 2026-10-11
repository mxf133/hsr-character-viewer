// Zero-dependency static file server for ./public.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serve a file from `root`. Returns true when the request was handled.
 * Path traversal is rejected by resolving and re-checking the prefix.
 *
 * `cacheControl` 让调用方按资源类型决定缓存策略：默认 `no-cache`（开发时要及时看到
 * 改动），图标那种**不可变资源**传长缓存 —— 否则每次开面板都要重新问一遍
 * 「这张图变了吗」，本地化省下的时间又还回去了。
 */
export const serveStatic = async (req, res, root, urlPath, { cacheControl = 'no-cache' } = {}) => {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const safeRel = normalize(rel).replace(/^([/\\])+/, '');
  const full = resolve(join(root, safeRel));
  const rootResolved = resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return true;
  }

  let info;
  try {
    info = await stat(full);
  } catch {
    return false;
  }
  if (info.isDirectory()) return false;

  const type = MIME[extname(full).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': info.size,
    'Cache-Control': cacheControl,
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise((done) => {
    const stream = createReadStream(full);
    stream.on('error', () => { res.destroy(); done(); });
    stream.on('end', done);
    stream.pipe(res);
  });
  return true;
};
