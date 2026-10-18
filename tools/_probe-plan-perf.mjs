// 抽卡方案的性能探针（一次性，但**留着有用**：升级 Node 或改数据结构后再跑一遍对比）。
//
//   node tools/_probe-plan-perf.mjs [--n=100000]
//
// 为什么要 scaffold 出 10 万条：**真实数据只有 1649 行**（绝境全版本），线性外推是骗自己 ——
// 真实数据里同一套阵容会被大量投稿重复，而合成的最坏情况是「每条投稿都是一套新阵容」，
// 两者走的是完全不同的代码路径（缓存命中率天差地别）。两个数都要看。
//
// ⚠️ PRNG 必须用 `Math.imul` 的 mulberry32：写 `seed * 1103515245` 会因为超过
// 2^53 丢精度而退化成循环序列 —— 第一次写这个探针时就踩了，10 万行只生成了 2417 种阵容，
// 于是「压测」其实什么都没压。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreEnvRows } from '../src/server/gacha-score.js';
import { buildPlan } from '../src/server/gacha-plan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const COUNT = Number(process.argv.find((a) => a.startsWith('--n='))?.slice(4)) || 100000;

const ARCHIVE = JSON.parse(readFileSync(join(HERE, '..', 'theherta', 'archive.json'), 'utf8'));
const AV = ARCHIVE.refs?.availability || {};
const SEASONS = ['4.6', '4.5', '4.4', '4.3', '4.2', '4.1'];

const realRows = SEASONS.flatMap((s) => (
  (ARCHIVE.modes?.['Anomaly Arbitration']?.stages?.plight?.seasons?.[s]?.frontier || [])
    .map((f) => ({ ...f, season: s }))
));

let s0 = 0x9e3779b9;
const rnd = () => {
  s0 |= 0; s0 = (s0 + 0x6D2B79F5) | 0;
  let z = Math.imul(s0 ^ (s0 >>> 15), 1 | s0);
  z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
  return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
};

const memberPool = [...new Set(realRows.flatMap((r) => r.m))];
const pick4 = () => {
  const out = new Set();
  while (out.size < 4) out.add(memberPool[Math.floor(rnd() * memberPool.length)]);
  return [...out];
};

const synthetic = (n) => Array.from({ length: n }, () => ({
  season: SEASONS[Math.floor(rnd() * SEASONS.length)],
  c: 1 + Math.floor(rnd() * 14),
  a: Math.floor(rnd() * 500),
  n: 1 + Math.floor(rnd() * 9),
  t: Math.floor(rnd() * 4),
  m: pick4(),
}));

const run = (label, rows) => {
  const unique = new Set(rows.map((r) => [...r.m].sort().join('~'))).size;
  let t = process.hrtime.bigint();
  const scored = scoreEnvRows(rows, { mode: 'aa', stage: 'plight' }).scored;
  const tScore = Number(process.hrtime.bigint() - t) / 1e6;
  let best = Infinity;
  for (let k = 0; k < 3; k += 1) {
    t = process.hrtime.bigint();
    buildPlan(scored, { availability: AV, maxRows: 20 });
    best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
  }
  console.log(`${label}
   投稿 ${rows.length} 行 → 去重阵容 ${unique} 套
   scoreEnvRows ${tScore.toFixed(0)} ms | buildPlan 最快一轮 ${best.toFixed(0)} ms`);
};

console.log('members 池大小：' + memberPool.length + '（去重后，决定缓存命中率）');
run('[真实数据 · 绝境全版本]', realRows);
run(`[合成 ${COUNT} 条 · 缓存最坏情况]`, synthetic(COUNT));
