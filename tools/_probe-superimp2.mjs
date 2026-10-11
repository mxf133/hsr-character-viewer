// 探针：叠影字段的取值分布与语义（用户第 8 条：叠影缺失是不是读取缺陷）。
// 用法：node tools/_probe-superimp2.mjs
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'theherta', 'raw', 'submissions');
const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'));

const dist = new Map();
let siZeroWithCone = 0;
let siZeroNoCone = 0;
const zeroCones = new Map();
const si1Cones = new Map();
// 同一 run 内：有没有「有的位置有叠影、有的位置是 0」的混合情况？
let mixedRuns = 0;
let zeroRuns = 0;
let runsWithZero = 0;
const allKeys = new Set();
for (const f of files) {
  let j;
  try { j = JSON.parse(await readFile(join(DIR, f), 'utf8')); } catch { continue; }
  for (const r of j.items || []) {
    Object.keys(r).forEach((k) => allKeys.add(k));
    let hasZero = false;
    let hasNonZero = false;
    for (let i = 1; i <= 4; i += 1) {
      const c = r[`p${i}_char`];
      if (typeof c !== 'string' || !c.trim()) continue;
      const v = Number(r[`p${i}_superimp`]);
      const lc = r[`p${i}_lc`];
      dist.set(v, (dist.get(v) || 0) + 1);
      if (v === 0) {
        hasZero = true;
        if (lc) { siZeroWithCone += 1; zeroCones.set(lc, (zeroCones.get(lc) || 0) + 1); } else siZeroNoCone += 1;
      } else {
        hasNonZero = true;
        if (v === 1 && lc) si1Cones.set(lc, (si1Cones.get(lc) || 0) + 1);
      }
    }
    if (hasZero) { runsWithZero += 1; if (hasNonZero) mixedRuns += 1; else zeroRuns += 1; }
  }
}
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
console.log('superimp 取值分布:', [...dist.entries()].sort((a, b) => a[0] - b[0]));
console.log({ siZeroWithCone, siZeroNoCone, runsWithZero, mixedRuns, zeroRuns });
console.log('叠影=0 时的光锥 top:', top(zeroCones, 12));
console.log('叠影=1 时的光锥 top:', top(si1Cones, 12));
console.log('run 字段名:', [...allKeys].sort().join(', '));
