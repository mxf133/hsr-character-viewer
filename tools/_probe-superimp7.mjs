// 探针：archive.json 的 teams[].sample.members 里，光锥有、叠影缺失的情况（用户第 8 条）。
// 用法：node tools/_probe-superimp7.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const a = JSON.parse(await readFile(join(HERE, '..', 'theherta', 'archive.json'), 'utf8'));
let n = 0; let coneNoSi = 0; let noConeSi = 0; const dist = new Map();
const samples = [];
for (const [mode, m] of Object.entries(a.modes || {})) {
  for (const [stage, sd] of Object.entries(m.stages || {})) {
    for (const [season, ss] of Object.entries(sd.seasons || {})) {
      for (const t of ss.teams || []) {
        for (const mem of t.sample?.members || []) {
          n += 1;
          const si = mem.superimp;
          dist.set(si === undefined ? 'undefined' : si, (dist.get(si === undefined ? 'undefined' : si) || 0) + 1);
          if (mem.lc && (si === undefined || si === null || Number(si) < 1)) {
            coneNoSi += 1;
            if (samples.length < 6) samples.push({ mode, season, char: mem.char, lc: mem.lc, si });
          }
          if (!mem.lc && Number(si) > 1) noConeSi += 1;
        }
      }
    }
  }
}
console.log('teams sample 成员数', n);
console.log('叠影取值分布', [...dist.entries()].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
console.log({ coneNoSi, noConeSi });
console.log('样例', samples);
