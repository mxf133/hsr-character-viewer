// 探针：archive.json 的前沿记录里，光锥有、叠影缺失/为 0 的情况（用户第 8 条）。
// 用法：node tools/_probe-superimp3.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const a = JSON.parse(await readFile(join(HERE, '..', 'theherta', 'archive.json'), 'utf8'));
console.log('顶层键:', Object.keys(a).join(', '));
let n = 0; let coneButNoSi = 0; let noConeWithSi = 0; const dist = new Map();
const bad = [];
const seasons = a.modes?.['Memory of Chaos']?.stages || {};
for (const [mode, m] of Object.entries(a.modes || {})) {
  for (const [stage, sd] of Object.entries(m.stages || {})) {
    for (const [season, ss] of Object.entries(sd.seasons || {})) {
      for (const f of ss.frontier || []) {
        for (const packed of f.m || []) {
          n += 1;
          const [char, eido, lc, si] = String(packed).split('|');
          dist.set(si === undefined ? 'undefined' : si, (dist.get(si === undefined ? 'undefined' : si) || 0) + 1);
          if (lc && (si === undefined || si === '' || Number(si) === 0)) {
            coneButNoSi += 1;
            if (bad.length < 8) bad.push({ mode, stage, season, packed });
          }
          if (!lc && si && Number(si) > 0) noConeWithSi += 1;
        }
      }
    }
  }
}
console.log('frontier 成员数', n);
console.log('叠影取值分布', [...dist.entries()]);
console.log({ coneButNoSi, noConeWithSi });
console.log('样例', bad);
console.log('mode 列表', Object.keys(a.modes || {}));
console.log('MoC stages', Object.keys(seasons));
const mocStages = a.modes?.['Memory of Chaos']?.stages || {};
for (const [st, sd] of Object.entries(mocStages)) {
  console.log('  stage', JSON.stringify(st), 'seasons', Object.keys(sd.seasons || {}).join(','));
}
