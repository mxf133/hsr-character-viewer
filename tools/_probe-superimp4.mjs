// 探针：核对黑塔网原始投稿的「限定 5★ 计数」与我们从 p*_superimp 还原的成本，
// 并检查抓取是否漏页（items.length vs count）。
// 用法：node tools/_probe-superimp4.mjs
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'theherta', 'raw', 'submissions');
const avail = JSON.parse(await readFile(join(HERE, '..', 'theherta', 'unit-availability.json'), 'utf8'));
const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'));

const isLimChar = (n) => avail.characters?.[n]?.limited === true;
const isLimCone = (n) => avail.lightCones?.[n]?.limited === true;

let pageMismatch = [];
let runs = 0; let match = 0; let mismatch = 0;
const diffHist = new Map();
const mismatchSamples = [];
for (const f of files) {
  let j;
  try { j = JSON.parse(await readFile(join(DIR, f), 'utf8')); } catch { continue; }
  const items = j.items || [];
  if (j.count !== undefined && j.count !== items.length) pageMismatch.push(`${f}: count=${j.count} items=${items.length}`);
  for (const r of items) {
    runs += 1;
    let mine = 0;
    for (let i = 1; i <= 4; i += 1) {
      const c = r[`p${i}_char`];
      if (typeof c !== 'string' || !c.trim()) continue;
      const e = Number(r[`p${i}_eidolon`]) || 0;
      const lc = r[`p${i}_lc`];
      const si = Number(r[`p${i}_superimp`]) || 0;
      if (isLimChar(c)) mine += 1 + e;
      if (lc && isLimCone(lc)) mine += 1 + Math.max(0, si - 1);
    }
    const theirs = Number(r.total_limited_5star_count);
    const d = mine - theirs;
    diffHist.set(d, (diffHist.get(d) || 0) + 1);
    if (d === 0) match += 1;
    else {
      mismatch += 1;
      if (mismatchSamples.length < 10) {
        mismatchSamples.push({
          f, id: r.id, mine, theirs, d,
          m: [1, 2, 3, 4].map((i) => [r[`p${i}_char`], r[`p${i}_eidolon`], r[`p${i}_lc`], r[`p${i}_superimp`]]).filter((x) => x[0]),
        });
      }
    }
  }
}
console.log('页数校验失败文件数', pageMismatch.length, pageMismatch.slice(0, 5));
console.log({ runs, match, mismatch });
console.log('差值分布（我们的成本 - 站点计数）', [...diffHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
console.log(JSON.stringify(mismatchSamples, null, 1));
