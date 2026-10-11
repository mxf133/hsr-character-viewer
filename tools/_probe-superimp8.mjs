// 探针：把「我们的成本 < 站点 total_limited_5star_count」的负差样本挖出来（用户第 8 条）。
// 负差 = 我们数少了限定 5★，说明还有一类单位被漏掉或算错。
// 用法：node tools/_probe-superimp8.mjs
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'theherta', 'raw', 'submissions');
const avail = JSON.parse(await readFile(join(HERE, '..', 'theherta', 'unit-availability.json'), 'utf8'));
const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'));
// 修正后的口径：24xxx 一律不算限定（结构判据）
const FREE24 = new Set([
  'On the Fall of an Aeon', 'Cruising in the Stellar Sea', 'Texture of Memories',
  'Solitary Healing', 'Eternal Calculus', "Memory's Curtain Never Falls",
  'Elation Brimming With Blessings',
]);
const isLimChar = (n) => avail.characters?.[n]?.limited === true;
const isLimCone = (n) => !FREE24.has(n) && avail.lightCones?.[n]?.limited === true;

const neg = [];
const hist = new Map();
const unknownChars = new Map();
const unknownCones = new Map();
let runs = 0;
for (const f of files) {
  let j;
  try { j = JSON.parse(await readFile(join(DIR, f), 'utf8')); } catch { continue; }
  for (const r of j.items || []) {
    runs += 1;
    let mine = 0;
    for (let i = 1; i <= 4; i += 1) {
      const ch = r[`p${i}_char`];
      if (typeof ch !== 'string' || !ch.trim()) continue;
      const e = Number(r[`p${i}_eidolon`]) || 0;
      const lc = r[`p${i}_lc`];
      const si = Number(r[`p${i}_superimp`]) || 0;
      if (!avail.characters?.[ch]) unknownChars.set(ch, (unknownChars.get(ch) || 0) + 1);
      if (lc && !avail.lightCones?.[lc]) unknownCones.set(lc, (unknownCones.get(lc) || 0) + 1);
      if (isLimChar(ch)) mine += 1 + e;
      if (lc && isLimCone(lc)) mine += 1 + Math.max(0, si - 1);
    }
    const theirs = Number(r.total_limited_5star_count);
    const d = mine - theirs;
    hist.set(d, (hist.get(d) || 0) + 1);
    if (d < 0 && neg.length < 12) {
      neg.push({
        f, id: r.id, mine, theirs, d, sub: r.subcategory, group: r.group_kind,
        dual: r.dual_index, side: r.side_index, sides: r.side_count,
        std: r.total_standard_5star_count,
        m: [1, 2, 3, 4].map((i) => [r[`p${i}_char`], r[`p${i}_eidolon`], r[`p${i}_lc`], r[`p${i}_superimp`]]).filter((x) => x[0]),
      });
    }
  }
}
console.log({ runs });
console.log('差值分布', [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
console.log('availability 里没有的角色:', [...unknownChars.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
console.log('availability 里没有的光锥:', [...unknownCones.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
console.log(JSON.stringify(neg, null, 1));
