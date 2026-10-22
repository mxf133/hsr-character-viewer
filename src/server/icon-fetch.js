/**
 * 本地图片镜像（2026-10-22）
 *
 * 用户原话：「**已获取的所有图片保留在本地默认永不删除，可点击按钮重新更新并获取图片**」。
 * 这份模块就是那条需求的服务端实现，四个职责：
 *
 *   1. `iconPlanOf()`   —— 列出**应该**在本地有哪些图（角色头像 / 光锥 / 命途 / 属性 /
 *                          立绘 / 卡面），来源表仍是 `theherta/i18n-zh.json` 的 `icons`
 *                          ＋ `public/scripts/game-icons.js` 导出的两份文件名清单。
 *   2. `mirrorIcons()`  —— 把**缺失**的下载到 `theherta/icons/`，已有且非空的**跳过**。
 *                          ⚠️ 任何情况下都**不删除**已有文件 —— 用户明确要「永不删除」；
 *                          CDN 换了图想覆盖，走 `force`（而不是先删再下）。
 *   3. `fetchIconToDisk()` —— 服务端 `/icons/*` 未命中时的**现抓**：抓到就落盘再发，
 *                          于是「看过一次的图」从此都在本地（原来是 302 出去，浏览器缓存
 *                          与本机无关，下次还是走网络）。
 *   4. `mirrorBossIcons()` —— 首领头像。**游戏素材库里没有敌人图标**（`Mar-7th/StarRailRes`
 *                          只有角色 / 光锥 / 命途 / 属性），所以改用 BWiki 的敌人页首图：
 *                          实测「步离战首•呼雷」的页面第一章图就是 `26px-步离战首•呼雷.png`，
 *                          去掉缩略图后缀即可拿到原图。产物落在 `theherta/boss-data/`
 *                          （已在 .gitignore 里，属于「可再生的本地资源」）。
 *
 * ⚠️ 为什么这些逻辑不放在 `tools/herta-icons.mjs` 里：界面上的「更新图片」按钮需要
 *    **同一条实现**（`POST /api/icons/refresh` 就在进程内跑）。抄第二遍的下场是
 *    「脚本能下全、按钮只下一半」，而两边都叫「更新图片」。
 *    `tools/herta-icons.mjs` 现在只是这份模块的 CLI 外壳。
 */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ELEMENT_ICON_FILES, PATH_ICON_FILES } from '../../public/scripts/game-icons.js';
import { loadI18n } from './archive.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ICONS_ROOT = resolve(HERE, '../../theherta/icons');
export const BOSS_ROOT = resolve(HERE, '../../theherta/boss-data');
export const BOSS_ICONS_ROOT = join(BOSS_ROOT, 'icons');
const BOSS_MAP_FILE = join(BOSS_ROOT, 'boss-icons.json');

/** 图片下载的重试次数（本机走代理时偶发 502 / 超时）。 */
const DOWNLOAD_TRIES = 4;
const DEFAULT_CONCURRENCY = 8;

/**
 * 把图标表里的地址还原成**能真正下载**的 CDN 地址。
 *
 * `loadI18n()` 会把图标改写成「本地优先」的路由 `/icons/<rel>?fallback=<原 CDN>`
 * （见 `archive.js` 的 `localizeIconUrls`）—— 界面用是对的，但这里要**下载**，
 * 直接 fetch 那个路由只会拿到自己（或者 302）。所以取 `fallback` 参数。
 */
export const downloadUrlOf = (raw) => {
  if (!raw || typeof raw !== 'string') return null;
  if (raw.startsWith('/icons/')) {
    try {
      const url = new URL(raw, 'http://local.invalid');
      const fallback = url.searchParams.get('fallback');
      if (fallback) return fallback;
    } catch { /* 落到下面的原样返回 */ }
  }
  return raw;
};

/**
 * 要在本地有哪些图。
 *
 * @param {'all'|'icons'|'previews'|'bosses'} only
 * @returns {Promise<{base:string, items:{group:string, rel:string, url:string}[]}>}
 */
/**
 * 图标表里的 **CDN 根地址**。
 *
 * ⚠️ `loadI18n()` 会把 `icons.base` 改写成 `/icons`、把每条地址改写成
 *    `/icons/<rel>?fallback=<CDN>`（那是**给浏览器**的口径）。这里要下载，所以得还原：
 *    base 已经是 https 就直接用；不是的话，从任意一条地址的 `fallback` 里砍掉它的
 *    `/icon/...` 尾巴。踩过的坑：直接用 `i18n.icons.base` 当根，会把文件写到
 *    `theherta/icons//cdn.jsdelivr.net/gh/...` 这种垃圾路径下（而且「下载成功」）。
 */
const cdnBaseOf = (i18n) => {
  const raw = String(i18n?.icons?.base || '');
  if (/^https:\/\//.test(raw)) return raw.replace(/\/+$/, '');
  const sample = Object.values(i18n?.icons?.characters || {})[0]
    || Object.values(i18n?.icons?.lightCones || {})[0];
  const hit = String(downloadUrlOf(sample) || '').match(/^(https:\/\/.+?)\/icon\//);
  return hit ? hit[1] : '';
};

export const iconPlanOf = async (only = 'all') => {
  const i18n = await loadI18n();
  const base = cdnBaseOf(i18n);
  if (!base) throw new Error('图标表里没有可用的 icons.base —— 先跑 node tools/herta-i18n.mjs');

  const groups = [];
  if (only === 'all' || only === 'icons') {
    groups.push({ label: '头像 icon/character', table: i18n.icons.characters });
    groups.push({ label: '光锥图标 icon/light_cones', table: i18n.icons.lightCones });
    // 命途 / 属性不在 `i18n.icons` 表里（那张是按角色 / 光锥名登记的）。
    groups.push({ label: '命途 icon/path', files: PATH_ICON_FILES.map((n) => `icon/path/${n}.png`) });
    groups.push({ label: '属性 icon/element', files: ELEMENT_ICON_FILES.map((n) => `icon/element/${n}.png`) });
  }
  if (only === 'all' || only === 'previews') {
    groups.push({ label: '立绘 preview/character', table: i18n.icons.previews?.characters });
    groups.push({ label: '卡面 preview/light_cones', table: i18n.icons.previews?.lightCones });
  }

  const items = [];
  for (const group of groups) {
    for (const [key, raw] of Object.entries(group.table || {})) {
      const url = downloadUrlOf(raw);
      if (!url || !/^https:\/\//.test(url)) continue;
      items.push({ group: group.label, key, rel: url.slice(base.length + 1), url });
    }
    for (const rel of group.files || []) {
      items.push({ group: group.label, key: rel, rel, url: `${base}/${rel}` });
    }
  }
  // 按相对路径去重（不同表里可能登记同一条）
  const unique = new Map();
  for (const item of items) if (!unique.has(item.rel)) unique.set(item.rel, item);
  return { base, items: [...unique.values()] };
};

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** 单张下载（带重试）。返回字节数，失败抛错。 */
export const downloadBytes = async (url, tries = DOWNLOAD_TRIES) => {
  let lastError = null;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('空响应');
      return buf;
    } catch (error) {
      lastError = error;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastError || new Error('未知错误');
};

/**
 * 写文件 → **原子替换**（既不会写出半张图，也兼容 UNC 共享盘上「不能原地覆写」的限制）。
 *
 * `.tmp` 已在 .gitignore 里；`rename` 覆盖已存在文件在 UNC 上会 EPERM，所以还要一条
 * 「先把旧文件改名让位」的退路。
 */
export const writeFileAtomic = async (dest, data) => {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  await writeFile(tmp, data);
  try {
    await rename(tmp, dest);
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES' && error?.code !== 'EEXIST') throw error;
    // ⚠️ 让位的名字必须**唯一**：`${dest}.old` 在第二次替换时已经存在，
    //    `rename` 覆盖已存在文件在 UNC 上照样 EPERM（第一次能过、第二次静默失败）。
    const aside = `${dest}.old-${Date.now()}`;
    await rename(dest, aside).catch(() => {});
    await rename(tmp, dest);
    await unlink(aside).catch(() => {});
  }
};

/** 本地已经有这张图了吗（存在且非空）。 */
const alreadyThere = async (dest, force) => {
  if (force) return false;
  try {
    const info = await stat(dest);
    return info.isFile() && info.size > 0;
  } catch { return false; }
};

/** 递归列出目录下的文件（相对路径，正斜杠）。 */
const listFiles = async (dir, prefix = '') => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch { return []; }
  const out = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await listFiles(join(dir, entry.name), rel));
    else if (!entry.name.endsWith('.tmp') && !entry.name.endsWith('.old')) out.push(rel);
  }
  return out;
};

/** 落一份清单：服务端与界面靠它判断「本地有没有」，也方便排查。 */
export const writeManifest = async (root = ICONS_ROOT, base = '') => {
  const files = (await listFiles(root)).sort();
  await writeFileAtomic(join(root, 'manifest.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), source: base || null, files }, null, 2)}\n`);
  return files.length;
};

/**
 * 镜像图标：**只补缺失的，从不删除**。
 *
 * @param {object} [options]
 * @param {'all'|'icons'|'previews'} [options.only]
 * @param {boolean} [options.force] 已存在的也重下（CDN 换图时用）
 * @param {number} [options.concurrency]
 * @param {(progress:{done:number,skipped:number,total:number})=>void} [options.onProgress]
 */
export const mirrorIcons = async (options = {}) => {
  const {
    only = 'all', force = false, concurrency = DEFAULT_CONCURRENCY, onProgress = null,
  } = options;
  const { base, items } = await iconPlanOf(only);
  let done = 0;
  let skipped = 0;
  let bytes = 0;
  const failures = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.all(batch.map(async (item) => {
      const dest = join(ICONS_ROOT, item.rel);
      if (await alreadyThere(dest, force)) { skipped += 1; return; }
      try {
        const buf = await downloadBytes(item.url);
        await writeFileAtomic(dest, buf);
        bytes += buf.length;
        done += 1;
      } catch (error) {
        failures.push({ rel: item.rel, message: error.message });
      }
    }));
    if (onProgress) onProgress({ done, skipped, total: items.length });
  }
  const files = await writeManifest(ICONS_ROOT, base);
  return { total: items.length, added: done, skipped, failed: failures.length, failures, bytes, files };
};

// ------------------------------------------------------------------ 首领头像

const WIKI_API = 'https://wiki.biligame.com/sr/api.php';
/**
 * BWiki 的检索接口限流很凶：两次之间只隔 1.2 秒时实测 50 个首领里有 22 个直接
 * 被挡（HTTP 567 / 返回 HTML）。2.6 秒是实测能连续跑完一轮的间隔。
 */
const WIKI_INTERVAL_MS = 2600;
/** 被限流后的退避（毫秒）：第 1 次失败等 20s 再试，第 2 次等 45s。 */
const WIKI_BACKOFF_MS = [20000, 45000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wikiJson = async (params) => {
  const url = `${WIKI_API}?format=json&${new URLSearchParams(params)}`;
  let lastError = null;
  for (let attempt = 0; attempt <= WIKI_BACKOFF_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(WIKI_BACKOFF_MS[attempt - 1]);
    try {
      const buf = await downloadBytes(url, 2);
      return JSON.parse(buf.toString('utf8'));
    } catch (error) {
      // 被限流时 BWiki 会返回 HTML（或 567）而不是 JSON —— 退避后重试一次。
      lastError = error;
    }
  }
  throw new Error(`BWiki 请求失败：${lastError?.message || '被限流'}`);
};

/** 归一：去掉标点 / 空白 / 大小写，只为「这个名字是不是同一个」这件事。 */
const norm = (text) => String(text ?? '')
  .replace(/[\s\u00a0•·・,，、:：;；()（）[\]【】+\-—_/]/g, '')
  .toLowerCase();

/**
 * 首领名 → 可检索的**中文名**。
 *
 * 来源优先级：`i18n.bosses`（`tools/data/hsr-bosses-zh.mjs` 生成，官方简中）→
 * `i18n.characters`（不少首领本身就是可玩角色：卡芙卡 / 飞霄 / 砂金 / 布洛妮娅）→ 原名。
 * 「X (Plight)」/「X: Plight」/「X（绝境）」这类变体先剥掉后缀再查，图标与基础名共用。
 */
const zhNameOf = (i18n, name) => {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  const stripped = raw
    .replace(/\s*\((?:Plight|K\d+)\)\s*$/i, '')
    .replace(/\s*:\s*(?:Plight|K\d+)\s*$/i, '')
    .replace(/（绝境）$/, '')
    .trim();
  const nameOf = (candidate) => i18n?.bosses?.[candidate]
    || i18n?.characters?.[candidate]
    || null;
  // `zh` = 展示用的（含「（绝境）」），`base` = **检索 / 落盘**用的基础名。
  // 两者分开的原因：BWiki 没有「始作画者（绝境）」这一页，绝境是同一个敌人换数值。
  return {
    zh: nameOf(raw) || stripped || raw,
    base: nameOf(stripped) || stripped || raw,
  };
};

/**
 * 缩略图地址 → **想要宽度的缩略图**（`.../thumb/f/f2/HASH.png/26px-名字.png` → `.../120px-名字.png`）。
 *
 * ⚠️ 2026-10-22 踩过：第一版取的是**原图**（把 `/thumb/.../26px-` 整段砍掉），实测 47 张
 * 加起来 **26 MB** —— 而界面上它是 18px 的圆头像（`2x` 也就 36px）。BWiki 的缩略图服务
 * 支持任意宽度，所以直接把它从 `26px` 改成 120px，单张降到十几 KB。
 */
const thumbOf = (src, width = 120) => {
  const url = src.startsWith('//') ? `https:${src}` : src;
  if (!/\/thumb\//.test(url)) return url;
  return url.replace(/\/\d+px-/, `/${width}px-`);
};

/** 页面 HTML 里第一张「文件名就是这个首领」的图 —— 实测就是敌人页的首图 / 图标。 */
const bossImageOf = (html, zhName) => {
  const want = norm(zhName);
  if (!want) return null;
  for (const match of html.matchAll(/<img[^>]+?src="([^"]+)"/g)) {
    const src = match[1].replace(/&amp;/g, '&');
    const file = decodeURIComponent(src.split('/').pop() || '');
    const bare = norm(file.replace(/^\d+px-/, '').replace(/\.(png|jpe?g|webp)$/i, ''));
    if (!bare) continue;
    if (bare === want || bare.includes(want) || want.includes(bare)) return thumbOf(src);
  }
  return null;
};

/** 名字里带 `A + B`（合体首领）时拆成几段分别试。 */
const partsOfBoss = (name) => String(name || '').split(/\s*\+\s*/).filter(Boolean);

/**
 * 首领头像的**抓取计划**：`[{ name, zh, key }]`。
 *
 * `key` 是落盘用的稳定文件名（= 基础名 slug），所以「Zandar」与「Zandar: Plight」
 * 共用同一张图 —— 绝境是同一个敌人，不该存两份。
 */
export const bossPlanOf = async () => {
  const i18n = await loadI18n();
  const archive = JSON.parse(await readFile(join(HERE, '../../theherta/archive.json'), 'utf8'));
  const names = new Set();
  for (const list of Object.values(archive?.bosses || {})) {
    for (const name of list || []) if (name) names.add(String(name));
  }
  return [...names].sort().map((name) => {
    const resolved = zhNameOf(i18n, name) || { zh: name, base: name };
    const slugBase = String(resolved.base || name).replace(/\s+/g, '');
    // 文件名：中文名能当文件名（NTFS / SMB 都支持）就直接用，否则退到短哈希。
    // ⚠️ slug 只由**基础名**派生 —— 「Zandar」与「Zandar: Plight」是同一个敌人，共用一张图。
    const key = /^[^\\/:*?"<>|]+$/.test(slugBase)
      ? slugBase : `b${createHash('sha1').update(slugBase).digest('hex').slice(0, 10)}`;
    return { name, zh: resolved.zh, base: resolved.base, key: key.toLowerCase() };
  });
};

const readBossMap = async () => {
  try {
    return JSON.parse(await readFile(BOSS_MAP_FILE, 'utf8'));
  } catch {
    return { generatedAt: null, icons: {} };
  }
};

/**
 * 抓首领头像。**只补缺失的，从不删除**（与图标同一政策）。
 *
 * 返回 `{ total, added, skipped, failed, failures, icons }`；`icons` 是
 * `{ 首领名: { zh, page, file } }`，`file` 相对 `theherta/boss-data/`。
 */
export const mirrorBossIcons = async (options = {}) => {
  const { force = false, onProgress = null } = options;
  const plan = await bossPlanOf();
  const map = await readBossMap();
  map.icons = map.icons || {};
  const failures = [];
  let added = 0;
  let skipped = 0;
  let first = true;

  for (const entry of plan) {
    const rel = `icons/${entry.key}.png`;
    const dest = join(BOSS_ROOT, rel);
    const known = map.icons[entry.name];
    // 目标文件已经在本地 → 直接登记，不请求（绝境变体与基础名共用同一张图，
    // 所以排序靠后的那个变体必然走这一支）。
    if (!force && await alreadyThere(dest, false)) {
      map.icons[entry.name] = { zh: entry.zh, page: known?.page ?? null, file: rel };
      skipped += 1;
      if (onProgress) onProgress({ done: added, skipped, total: plan.length });
      continue;
    }
    if (!first) await sleep(WIKI_INTERVAL_MS);
    first = false;
    try {
      let page = null;
      let url = null;
      for (const part of partsOfBoss(entry.base)) {
        const search = await wikiJson({
          action: 'query', list: 'search', srlimit: '6', srsearch: part,
        });
        const hits = search?.query?.search || [];
        const want = norm(part);
        // 候选排序：标题包含名字的优先，其次名字包含标题的，最后退到原顺序。
        // ⚠️ **每一条都要试**（最多 3 条）：检索给的第一条不一定是敌人页（可能是活动 /
        //    剧情 / 敌人一览），而「找不到图」并不等于「这个敌人没有图」。实测「亚婆离」
        //    就是被第一条无关页挡住的。
        const ordered = [
          ...hits.filter((hit) => norm(hit.title).includes(want)),
          ...hits.filter((hit) => !norm(hit.title).includes(want) && want.includes(norm(hit.title))),
          ...hits.filter((hit) => !norm(hit.title).includes(want) && !want.includes(norm(hit.title))),
        ].slice(0, 3);
        for (const hit of ordered) {
          if (!hit?.title) continue;
          const parsed = await wikiJson({
            action: 'parse', page: hit.title, prop: 'text', redirects: '1',
          });
          const html = parsed?.parse?.text?.['*'] || '';
          const found = bossImageOf(html, hit.title) || bossImageOf(html, part);
          if (found) { page = hit.title; url = found; break; }
          await sleep(WIKI_INTERVAL_MS);
        }
        if (url) break;
      }
      if (!url) throw new Error('页面上找不到以该首领命名的图');
      const buf = await downloadBytes(url);
      await writeFileAtomic(dest, buf);
      map.icons[entry.name] = { zh: entry.zh, page, file: rel };
      added += 1;
    } catch (error) {
        failures.push({ name: entry.name, zh: entry.zh, page: null, message: error.message });
    }
    if (onProgress) onProgress({ done: added, skipped, total: plan.length });
  }

  map.generatedAt = new Date().toISOString();
  await writeFileAtomic(BOSS_MAP_FILE, `${JSON.stringify(map, null, 2)}\n`);
  return {
    total: plan.length, added, skipped, failed: failures.length, failures, icons: map.icons,
  };
};

/**
 * 首领名 → 本地图标路由（`/boss-icons/xxx.png`）；没有素材给 `null`。
 *
 * ⚠️ 缓存住：抽卡方案**每次请求**都要用这张表（每张卡的「最佳版本」旁边要印首领），
 *    而它是个几十条的 JSON —— 每次都读盘纯属浪费。表只在「更新图片」之后才会变，
 *    那条路径会调 `invalidateBossIconCache()`。
 */
let bossIconCache = null;

/** 让首领头像表失效（`/api/icons/refresh` 跑完之后调）。 */
export const invalidateBossIconCache = () => { bossIconCache = null; };

export const bossIconMap = async () => {
  if (bossIconCache) return bossIconCache;
  const map = await readBossMap();
  const out = new Map();
  for (const [name, entry] of Object.entries(map.icons || {})) {
    if (name.startsWith('#') || !entry?.file) continue;
    out.set(name, `/boss-icons/${entry.file.replace(/^icons\//, '')}`);
  }
  bossIconCache = out;
  return out;
};

// ------------------------------------------------------------------ 现抓（路由用）

/**
 * 服务端 `/icons/<rel>` 未命中时**现抓一张并落盘**。
 *
 * 原来这里直接 302 回 CDN —— 于是「看过一次」的图仍然只存在浏览器的缓存里，
 * 换台设备 / 断网就没了。现在抓到就写进 `theherta/icons/`，从此是本机资源。
 * ⚠️ 只接受 `cdn.jsdelivr.net` 的地址（调用方已经从 `?fallback=` 里校验过一次，
 *    这里再校验一次：这个函数会把内容写到磁盘）。
 */
export const fetchIconToDisk = async (rel, url) => {
  if (!/^https:\/\/cdn\.jsdelivr\.net\//.test(String(url || ''))) return null;
  const clean = String(rel || '').replace(/^\/+/, '');
  if (!clean || clean.includes('..')) return null;
  const buf = await downloadBytes(url, 2);
  await writeFileAtomic(join(ICONS_ROOT, clean), buf);
  return buf;
};

/** 一次完整的「更新图片」：图标 + 首领头像。两个都会失败时也如实返回各自的统计。 */
export const refreshAllImages = async (options = {}) => {
  const icons = await mirrorIcons({ ...options, only: 'all' });
  let bosses = null;
  let bossError = null;
  try {
    bosses = await mirrorBossIcons({ force: options.force });
  } catch (error) {
    bossError = error.message;
  }
  return { icons, bosses, bossError, at: new Date().toISOString() };
};

/** 一行摘要（CLI 与接口共用文案，免得两边说法不一样）。 */
export const summaryOfRefresh = (result) => {
  const parts = [];
  if (result?.icons) {
    parts.push(`图标新增 ${result.icons.added} 张（跳过 ${result.icons.skipped}，失败 ${result.icons.failed}，${mb(result.icons.bytes)}）`);
  }
  if (result?.bosses) {
    parts.push(`首领头像新增 ${result.bosses.added} 张（跳过 ${result.bosses.skipped}，失败 ${result.bosses.failed}）`);
  }
  if (result?.bossError) parts.push(`首领头像抓取失败：${result.bossError}`);
  return parts.join('；');
};
