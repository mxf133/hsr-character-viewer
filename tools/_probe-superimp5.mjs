// 探针：定位「我们的成本 - 站点计数」差值的来源光锥/角色（用户第 8 条）。
// 用法：node tools/_probe-superimp5.mjs
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'theherta', 'raw', 'submissions');
const avail = JSON.parse(await readFile(join(HERE, '..', 'theherta', 'unit-availability.json'), 'utf8'));
const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'));
const isLimChar = (n) => avail.characters?.[n]?.limited === true;
const isLimCone = (n) => avail.lightCones?.[n]?.limited === true;

const culpritCone = new Map();
const culpritChar = new Map();
let variantA = 0; // 含叠影
let variantB = 0; // 不含叠影（限定光锥只算 1）
let variantC = 0; // 限定光锥完全不算
let runs = 0;
for (const f of files) {
  let j;
  try { j = JSON.parse(await readFile(join(DIR, f), 'utf8')); } catch { continue; }
  for (const r of j.items || []) {
    runs += 1;
    let a = 0; let b = 0; let c = 0;
    for (let i = 1; i <= 4; i += 1) {
      const ch = r[`p${i}_char`];
      if (typeof ch !== 'string' || !ch.trim()) continue;
      const e = Number(r[`p${i}_eidolon`]) || 0;
      const lc = r[`p${i}_lc`];
      const si = Number(r[`p${i}_superimp`]) || 0;
      if (isLimChar(ch)) { a += 1 + e; b += 1 + e; c += 1 + e; }
      if (lc && isLimCone(lc)) {
        a += 1 + Math.max(0, si - 1);
        b += 1;
        if (si >= 5) culpritCone.set(lc, (culpritCone.get(lc) || 0) + 1);
      }
    }
    const theirs = Number(r.total_limited_5star_count);
    if (a === theirs) variantA += 1;
    if (b === theirs) variantB += 1;
    if (c === theirs) variantC += 1;
  }
}
console.log({ runs, variantA, variantB, variantC });
console.log('SI5 的限定光锥 top:', [...culpritCone.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15));
console.log('角色数', Object.keys(avail.characters || {}).length);
