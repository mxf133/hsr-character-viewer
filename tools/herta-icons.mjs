// 把黑塔网数据集用到的图标/立绘**镜像到本地**（一次性，之后完全离线可用）。
//
// 用户 2026-10-10 的原话：「这些图标是会完全重新到网上读取吗？能不能下载到本地，
// 方便以后读取，这样不容易出现渲染问题」。
//
// ⚠️ **先说清一件事，别把两个问题混在一起**（这一条是本脚本存在的理由说明）：
//   * 「破图」不是网络造成的。实测配装块 112 张图里那 15 张**压根没有 src** ——
//     是 `i18n.icons` 里查不到那个键（形态变体 `March 7th (Hunt)`、开拓者 `Trailblazer (…)`、
//     标点/译名差异 `To Say Goodbye` vs `Make Farewells More Beautiful`）。那是**数据问题**，
//     已由 `src/server/conclusion.js` 的 `resolveIcon()` 四级兜底修掉（实测 112/112）。
//   * 本脚本解决的是**另一件事**：这工具是**本机离线**用的，配装块一次要 238 张图
//     （≈15 MB）从境外 CDN 拉，首屏要等；断网/代理抽风就整片空白。本地化后不依赖网络。
//
// 为什么**不进 git**：`theherta/` 其余内容是入库的，但图标是**可再生的派生资源**
// （跑一次本脚本就有），70 MB 二进制塞进历史只是给所有人增加 clone 体积。所以
// `theherta/icons/` 进 `.gitignore`，由本脚本负责重建。
//
// 用法：
//   node tools/herta-icons.mjs                 # 全量（头像 + 光锥 + 立绘）
//   node tools/herta-icons.mjs --only=icons    # 只要头像与光锥图标（约 15 MB）
//   node tools/herta-icons.mjs --force         # 已存在也重下（CDN 换了图时用）
//   node tools/herta-icons.mjs --dry           # 只报计划与体积，不下载
//
// 断点续传：**已存在且大小一致就跳过**，所以中断后重跑不会白费。
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadI18n } from '../src/server/archive.js';
// 命途 / 属性图标的文件名清单与界面共用一份（`game-icons.js` 没有 DOM 顶层依赖，可直接 import）。
import { ELEMENT_ICON_FILES, PATH_ICON_FILES } from '../public/scripts/game-icons.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = resolve(HERE, '..', 'theherta', 'icons');

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);
const ONLY = arg('only', 'all');
const FORCE = has('force');
const DRY = has('dry');
const CONCURRENCY = Number(arg('concurrency', '8'));

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const pad = (s, n) => String(s).padStart(n);

/** 单张下载，带重试；返回字节数，失败抛错。 */
const download = async (url, dest, tries = 4) => {
  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('空响应');
      await writeFile(dest, buf);
      return buf.length;
    } catch (err) {
      lastErr = err;
      // 本机走本地代理，会间歇性502/超时；退避后重试。
      if (attempt < tries) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr || new Error('未知错误');
};

const i18n = await loadI18n();
const base = i18n?.icons?.base;
if (!base) {
  console.error('图标表里没有 icons.base —— 先跑 node tools/herta-i18n.mjs 生成 theherta/i18n-zh.json');
  process.exit(1);
}

// 收集要镜像的条目：`{ 相对路径（去掉 CDN 主机名） → 完整 URL }`
const groups = [];
if (ONLY === 'all' || ONLY === 'icons') {
  groups.push({ label: '头像 icon/character', table: i18n.icons.characters });
  groups.push({ label: '光锥图标 icon/light_cones', table: i18n.icons.lightCones });
  // 命途 / 属性图标（2026-10-18 起角色卡上要画）：这两组**不在 `i18n.icons` 表里**
  // （那张表是按角色 / 光锥名登记的），清单从界面用的同一份映射导出 —— 9 + 7 张，
  // 一共几十 KB。漏了它们时 `/icons` 会 302 到 CDN（能看，但断网就空）。
  groups.push({ label: '命途 icon/path', files: PATH_ICON_FILES.map((n) => `icon/path/${n}.png`) });
  groups.push({ label: '属性 icon/element', files: ELEMENT_ICON_FILES.map((n) => `icon/element/${n}.png`) });
}
if (ONLY === 'all' || ONLY === 'previews') {
  groups.push({ label: '立绘 preview/character', table: i18n.icons.previews?.characters });
  groups.push({ label: '卡面 preview/light_cones', table: i18n.icons.previews?.lightCones });
}

const items = [];
for (const g of groups) {
  for (const [key, url] of Object.entries(g.table || {})) {
    if (!url || typeof url !== 'string' || !url.startsWith(base)) continue;
    items.push({ group: g.label, key, url, rel: url.slice(base.length + 1) });
  }
  for (const rel of g.files || []) {
    items.push({ group: g.label, key: rel, url: `${base}/${rel}`, rel });
  }
}
if (!items.length) {
  console.error('没有可镜像的条目');
  process.exit(1);
}

// 按相对路径去重（不同表里可能有同一条）
const unique = new Map();
for (const it of items) if (!unique.has(it.rel)) unique.set(it.rel, it);
const list = [...unique.values()];

console.log(`图标本地化 · ${list.length} 个文件`);
const byGroup = new Map();
for (const it of list) byGroup.set(it.group, (byGroup.get(it.group) || 0) + 1);
for (const [label, n] of byGroup) console.log(`  ${label.padEnd(26)} ${n} 张`);
console.log(`  目标目录：${OUT_ROOT}`);
console.log(`  模式：${DRY ? '只报计划（--dry）' : FORCE ? '全部重下（--force）' : '跳过已存在的'}`
  + `${ONLY !== 'all' ? `  仅 ${ONLY}` : ''}`);
console.log('');

if (DRY) {
  // 只报体积，不下载：先 HEAD 拿 content-length（部分 CDN 对 HEAD 不友好，失败就略过）。
  let total = 0;
  let unknown = 0;
  for (const it of list) {
    try {
      const r = await fetch(it.url, { method: 'HEAD' });
      if (r.ok) total += Number(r.headers.get('content-length') || 0);
      else unknown += 1;
    } catch { unknown += 1; }
  }
  console.log(`预计体积：${mb(total)}（另有 ${unknown} 个拿不到 HEAD，按实际下载为准）`);
  process.exit(0);
}

await mkdir(OUT_ROOT, { recursive: true });
let done = 0;
let skipped = 0;
let bytes = 0;
const failures = [];
const t0 = Date.now();

/** 已有且大小 >0 就跳过（断点续传）。--force 时强制重下。 */
const alreadyThere = async (dest) => {
  if (FORCE) return false;
  try {
    const s = await stat(dest);
    return s.isFile() && s.size > 0;
  } catch { return false; }
};

for (let i = 0; i < list.length; i += CONCURRENCY) {
  const batch = list.slice(i, i + CONCURRENCY);
  await Promise.all(batch.map(async (it) => {
    const dest = join(OUT_ROOT, it.rel);
    if (await alreadyThere(dest)) {
      skipped += 1;
      return;
    }
    await mkdir(dirname(dest), { recursive: true });
    try {
      bytes += await download(it.url, dest);
      done += 1;
    } catch (err) {
      failures.push({ rel: it.rel, message: err.message });
    }
  }));
  const pct = ((i + batch.length) / list.length * 100).toFixed(0);
  process.stdout.write(`\r  ${pad(`${pct}%`, 5)}  新增 ${pad(done, 4)}  跳过 ${pad(skipped, 4)}`
    + `  ${mb(bytes).padStart(9)}   `);
}
process.stdout.write('\n\n');

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`完成：新增 ${done} 张（${mb(bytes)}），跳过 ${skipped} 张，用时 ${secs}s`);
if (failures.length) {
  console.log(`⚠️ 失败 ${failures.length} 张（重跑本脚本即可续传）：`);
  for (const f of failures.slice(0, 10)) console.log(`   ${f.rel} — ${f.message}`);
  if (failures.length > 10) console.log(`   …还有 ${failures.length - 10} 个`);
  process.exitCode = 1;
}

// 落一份清单：服务端靠它判断某个键**本地有没有**（没有就回落到 CDN）。
// 这样即使只下了 `--only=icons`，立绘仍能从 CDN 正常取，不会因为清单里没有就 404。
const files = [];
const walk = async (dir, prefix = '') => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
    else files.push(rel);
  }
};
await walk(OUT_ROOT);
files.sort();
await writeFile(join(OUT_ROOT, 'manifest.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), source: base, files }, null, 2)}\n`,
  'utf8');
console.log(`清单：theherta/icons/manifest.json（${files.length} 个文件）`);
console.log('提示：图标**不入 git**（可再生资源），换机器后重跑一次本脚本即可。');