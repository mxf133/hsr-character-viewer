// 探针：24xxx 修正之后**剩余**不一致的样本长什么样（用户第 8 条收尾）。
// 用法：node tools/_probe-superimp9.mjs
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'theherta', 'raw', 'submissions');
const avail = JSON.parse(await readFile(join(HERE, '..', 'theherta', 'unit-availability.json'), 'utf8'));
const table = JSON.parse(await readFile(join(HERE, '..', '.snapref', 'starrailres-en-lightcones.json'), 'utf8'));
const idOf = new Map(Object.entries(table).map(([id, v]) => [v.name, id]));
const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'));

// 结构判据：id 以 24 开头的 5★ 光锥都不是限定跃迁（免费 / 商店 / 活动）
const isFree24 = (n) => String(idOf.get(n) || '').startsWith('24');
const isLimChar = (n) => avail.characters?.[n]?.limited === true;
const isLimCone = (n) => !isFree24(n) && avail.lightCones?.[n]?.limited === true;

const posSamples = [];
const hist = new Map();
// 负差：光锥整条缺失的条数
let noConeRuns = 0;
let noConeNeg = 0;
for (const f of files) {
  let j;
  try { j = JSON.parse(await readFile(join(DIR, f), 'utf8')); } catch { continue; }
  for (const r of j.items || []) {
    let mine = 0;
    let cones = 0;
    for (let i = 1; i <= 4; i += 1) {
      const ch = r[`p${i}_char`];
      if (typeof ch !== 'string' || !ch.trim()) continue;
      const e = Number(r[`p${i}_eidolon`]) || 0;
      const lc = r[`p${i}_lc`];
      const si = Number(r[`p${i}_superimp`]) || 0;
      if (isLimChar(ch)) mine += 1 + e;
      if (lc && isLimCone(lc)) { mine += 1 + Math.max(0, si - 1); cones += 1; }
    }
    const theirs = Number(r.total_limited_5star_count);
    const d = mine - theirs;
    hist.set(d, (hist.get(d) || 0) + 1);
    const lcCount = [1, 2, 3, 4].filter((i) => r[`p${i}_lc`]).length;
    if (lcCount === 0) { noConeRuns += 1; if (d < 0) noConeNeg += 1; }
    if (d > 0 && posSamples.length < 8) {
      posSamples.push({
        f, id: r.id, mine, theirs, d, lcCount,
        m: [1, 2, 3, 4].map((i) => [r[`p${i}_char`], r[`p${i}_eidolon`], r[`p${i}_lc`], idOf.get(r[`p${i}_lc`]) || null, r[`p${i}_superimp`]]).filter((x) => x[0]),
      });
    }
  }
}
console.log('差值分布', [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
console.log({ noConeRuns, noConeNeg });
console.log('正差样例:', JSON.stringify(posSamples, null, 1));
