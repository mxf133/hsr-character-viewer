// 探针：验证「Memory's Curtain Never Falls 不该计金」这一假设（用户第 8 条）。
// 把该光锥强制按非限定重算成本，看与站点 total_limited_5star_count 的一致率。
// 用法：node tools/_probe-superimp6.mjs
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'theherta', 'raw', 'submissions');
const avail = JSON.parse(await readFile(join(HERE, '..', 'theherta', 'unit-availability.json'), 'utf8'));
const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'));
const isLimChar = (n) => avail.characters?.[n]?.limited === true;
const FREE_EXTRA = new Set(["Memory's Curtain Never Falls"]);
const isLimCone = (n) => !FREE_EXTRA.has(n) && avail.lightCones?.[n]?.limited === true;

let runs = 0; let ok = 0;
const diffHist = new Map();
const coneAttrib = new Map();
for (const f of files) {
  let j;
  try { j = JSON.parse(await readFile(join(DIR, f), 'utf8')); } catch { continue; }
  for (const r of j.items || []) {
    runs += 1;
    let mine = 0;
    const counted = [];
    for (let i = 1; i <= 4; i += 1) {
      const ch = r[`p${i}_char`];
      if (typeof ch !== 'string' || !ch.trim()) continue;
      const e = Number(r[`p${i}_eidolon`]) || 0;
      const lc = r[`p${i}_lc`];
      const si = Number(r[`p${i}_superimp`]) || 0;
      if (isLimChar(ch)) mine += 1 + e;
      if (lc && isLimCone(lc)) { mine += 1 + Math.max(0, si - 1); counted.push(lc); }
    }
    const theirs = Number(r.total_limited_5star_count);
    const d = mine - theirs;
    diffHist.set(d, (diffHist.get(d) || 0) + 1);
    if (d === 0) ok += 1;
    else {
      // 归因：这一条多出来的金数记到出现过的限定光锥上
      for (const c of counted) coneAttrib.set(c, (coneAttrib.get(c) || 0) + 1);
    }
  }
}
console.log({ runs, ok, rate: (ok / runs).toFixed(4) });
console.log('差值分布', [...diffHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8));
console.log('剩余不匹配时出现的限定光锥 top:', [...coneAttrib.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
