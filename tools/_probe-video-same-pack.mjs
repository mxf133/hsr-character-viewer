// 回归探针（2026-10-22 晚）：「另 N 条来源 · 同一套配装」必须真的同配装。
//
// 用户报的 bug：卡片是 遐蝶E2(让告别，再美一些S1) / 长夜月E2(花儿不会忘记S2) /
// 风堇E2(敌手枕的下一页S5) / 昔涟E2(愿望光永续天空S1)，折叠块里列的 7 条来源却混着
// 同阵容**其它配装**（E0 / 别的光锥）的投稿。根因与修复见
// `tools/herta-add-team-videos.mjs` 头部注释（`teams[].videosByPack` 整包分桶）。
//
// 验证方式：跑一次方案（绝境·王棋，搜「遐蝶」），对每一行的 `video` 与 `videoSources`
// 逐条用 **raw 投稿** 反查它的四个位置配装，断言整包键与本行完全一致。
// 用法：node tools/_probe-video-same-pack.mjs
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPlan } from '../src/server/gacha-plan-run.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RAW = join(ROOT, 'theherta', 'raw', 'submissions');

// 与 `gacha-score.js` 的 `eidolonTierOf` / `packKeyOf` 同源（E3~E5 归 E2）。
const tierOf = (n) => {
  const n2 = Number(n);
  if (!Number.isFinite(n2) || n2 <= 0) return 0;
  if (n2 >= 6) return 6;
  if (n2 >= 2) return 2;
  return 1;
};
const packKeyOf = (members) => members
  .map((m) => `${m.char}|E${tierOf(m.eidolon)}|${m.lc || '-'}|S${m.superimp}`)
  .sort().join('~');

// raw 投稿：`视频地址 → 这条投稿自己的整包键`（同地址多条投稿键应一致，取首见）。
const packByUrl = new Map();
let rawFiles = 0;
for (const f of await readdir(RAW)) {
  if (!f.endsWith('.json')) continue;
  rawFiles += 1;
  let payload;
  try { payload = JSON.parse(await readFile(join(RAW, f), 'utf8')); } catch { continue; }
  for (const run of payload?.items || []) {
    const url = typeof run.video_url === 'string' ? run.video_url.trim() : '';
    if (!/^https?:\/\//i.test(url) || packByUrl.has(url)) continue;
    const members = [];
    for (let i = 1; i <= 4; i += 1) {
      const char = run[`p${i}_char`];
      if (typeof char !== 'string' || !char.trim()) continue;
      members.push({
        char: char.trim(),
        eidolon: Math.max(0, Number(run[`p${i}_eidolon`]) || 0),
        lc: typeof run[`p${i}_lc`] === 'string' && run[`p${i}_lc`].trim()
          ? run[`p${i}_lc`].trim() : null,
        superimp: run[`p${i}_superimp`] === undefined || run[`p${i}_superimp`] === null || run[`p${i}_superimp`] === ''
          ? 5 : Math.max(0, Math.min(5, Math.round(Number(run[`p${i}_superimp`])))),
      });
    }
    if (members.length === 4) packByUrl.set(url, packKeyOf(members));
  }
}
console.log(`raw 索引：${rawFiles} 个文件，${packByUrl.size} 条带视频的投稿`);

const res = await runPlan({
  envKey: 'aa|plight',
  account: { owned: [], eidolons: {}, cones: {} },
  drawWeights: { strength: 1, cost: 1 },
  query: '遐蝶',
  pageSize: 200,
});

let checked = 0;
let mismatched = 0;
let unknownUrl = 0;
for (const row of res.rows || []) {
  const rowPack = (row.members || [])
    .map((m) => `${m.char}|E${tierOf(m.eidolon)}|${m.lc || '-'}|S${m.superimp}`)
    .sort().join('~');
  const sources = [row.video, ...(row.videoSources || []).map((s) => s?.url)]
    .filter((u) => typeof u === 'string' && u);
  for (const url of sources) {
    checked += 1;
    const srcPack = packByUrl.get(url);
    if (srcPack === undefined) { unknownUrl += 1; continue; }
    if (srcPack !== rowPack) {
      mismatched += 1;
      if (mismatched <= 5) {
        console.log(`✗ #${row.rank} ${rowPack}\n    来源 ${url.slice(0, 60)} 的配装是 ${srcPack}`);
      }
    }
  }
}
console.log(`核对 ${checked} 条来源（raw 认不出的 ${unknownUrl} 条）：配装不一致 ${mismatched} 条`);
if (mismatched > 0) process.exit(1);
console.log('✓ 所有来源视频的配装都与所在行的整包一致');
