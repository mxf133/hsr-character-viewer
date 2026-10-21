// 抽卡方案「全量 + 分页 + 全量可搜」的**性能探针**（2026-10-20，v4.6.134）。
//
//   node tools/_probe-plan-page-perf.mjs [--n=100000] [--json]
//
// 为什么要它：用户第 3 条是「保证性能，确保能存放至少 10 万条投稿」。这句话只有拆成
// 下面几段才能验：
//
//   ① **冷启动**：`runPlan()` 第一次（读档案 + 装 frontier + 评分 + 建池）。
//      10 万条投稿时这一段是秒级 —— 只付一次，之后靠两层缓存。
//   ② **命中缓存后的翻页**：`page=2/14` —— 用户最常见的动作，必须 < 100 ms。
//   ③ **命中缓存后的搜索**：全池词元倒排 + AND。同一个词翻第 2 页用 `lastQuery`，不重算。
//   ④ **次选索引的建造成本**：真实数据集随第一次搜索付一次；超过 4000 行时**不建**
//      （`PLAN_ALT_INDEX_MAX_LINEUPS`），否则这一趟就是秒级。
//   ⑤ **单页物化**：只给 20 行算补金明细 / 次选 —— 这是「按页取」换来的最大一笔省。
//
// ⚠️ 合成压测的 PRNG 必须用 `Math.imul` 的 mulberry32：裸 LCG（`seed * 1103515245`）
//    会超 2^53 丢精度、退化成循环序列 —— 之前踩过，10 万行只造出 2417 种阵容，等于没压。
//    这一段与 `tools/_probe-plan-perf.mjs` 同源，别改两处。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreEnvRows } from '../src/server/gacha-score.js';
import { buildPlanPool, materializePlanRow } from '../src/server/gacha-plan.js';
import {
  PLAN_ALT_INDEX_MAX_LINEUPS, altTokensOf, planPageOf, searchPlanIndex, tokenIndexOf,
} from '../src/server/plan-index.js';
import { clearPlanCaches, planCacheStats, runPlan } from '../src/server/gacha-plan-run.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const COUNT = Math.max(1, Number(arg('n', '100000')) || 100000);
const JSON_OUT = process.argv.includes('--json');

const ms = (from) => Number(process.hrtime.bigint() - from) / 1e6;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** 跑 `rounds` 次取中位（第一次算热身，不计入）。 */
const timeIt = (fn, rounds = 3) => {
  const runs = [];
  for (let i = 0; i < rounds + 1; i += 1) {
    const t0 = process.hrtime.bigint();
    fn();
    if (i > 0) runs.push(ms(t0));
  }
  return median(runs);
};

// ------------------------------------------------------------------ ① 真实数据：端到端
const real = {};
{
  clearPlanCaches();
  let t0 = process.hrtime.bigint();
  const cold = await runPlan({ envKey: 'aa|plight', account: { owned: [] } });
  real.coldMs = ms(t0);
  real.lineups = cold.lineups;
  real.poolRows = cold.poolRows;
  real.submissions = cold.submissions;
  real.pages = cold.pages;

  t0 = process.hrtime.bigint();
  const page = await runPlan({ envKey: 'aa|plight', account: { owned: [] }, page: 2 });
  real.pageMs = ms(t0);
  real.pageRows = page.rows.length;

  // 冷搜索：第一次搜索要建词元倒排 + 次选索引。
  t0 = process.hrtime.bigint();
  const first = await runPlan({ envKey: 'aa|plight', account: { owned: [] }, query: '砂金' });
  real.firstSearchMs = ms(t0);
  real.hits = first.query.hits;
  real.altOnly = first.query.altOnly;

  // 热搜索：换一个词（仍要过倒排，但不重建索引）。
  t0 = process.hrtime.bigint();
  const second = await runPlan({ envKey: 'aa|plight', account: { owned: [] }, query: '知更鸟' });
  real.warmSearchMs = ms(t0);
  real.warmHits = second.query.hits;

  // 同词翻页：`lastQuery` 直接复用。
  t0 = process.hrtime.bigint();
  await runPlan({ envKey: 'aa|plight', account: { owned: [] }, query: '知更鸟', page: 2 });
  real.searchPageMs = ms(t0);
  real.cache = planCacheStats();
}

// ------------------------------------------------------------------ ② 合成 10 万条：拆段
const ARCHIVE = JSON.parse(readFileSync(join(HERE, '..', 'theherta', 'archive.json'), 'utf8'));
const AV = ARCHIVE.refs?.availability || {};
const SEASONS = ['4.6', '4.5', '4.4', '4.3', '4.2', '4.1'];

const realRows = SEASONS.flatMap((s) => (
  (ARCHIVE.modes?.['Anomaly Arbitration']?.stages?.plight?.seasons?.[s]?.frontier || [])
    .map((f) => ({ ...f, season: s }))
));

let seed = 0x9e3779b9;
const rnd = () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let z = Math.imul(seed ^ (seed >>> 15), 1 | seed);
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
  t: 2,
  m: pick4(),
}));

const big = {};
{
  const rows = synthetic(COUNT);
  big.rows = rows.length;

  let t0 = process.hrtime.bigint();
  const scored = scoreEnvRows(rows, { mode: 'aa', stage: 'plight', ws: 1, wc: 1 }).scored;
  big.scoreMs = ms(t0);

  t0 = process.hrtime.bigint();
  const pool = buildPlanPool(scored, { availability: AV, wc: 1 });
  big.poolMs = ms(t0);
  big.lineups = pool.lineups.length;
  big.packs = pool.pool.length;

  // 2026-10-21：搜索层吃条目表（entries）。合成数据全是满分档（t: 2），
  // 所以 entries 就是把池子里的每一行包一层 state。
  const asIndex = (pl) => ({
    entries: pl.lineups.map((row) => ({ row, state: pl })),
    nameOf: () => null,
  });
  const index = asIndex(pool);

  // 词元倒排（第一次搜索付一次）
  big.tokenMs = timeIt(() => {
    index.tokenIndex = null;
    tokenIndexOf(index, 'own');
  }, 2);
  big.tokens = index.tokenIndex.tokens.length;

  // 次选索引：超过上限就不建，这里两种规模各量一次
  const altStart = process.hrtime.bigint();
  const altBuilt = altTokensOf(index);
  big.altMs = ms(altStart);
  big.altBuilt = Boolean(altBuilt);
  big.altLimit = PLAN_ALT_INDEX_MAX_LINEUPS;

  // 搜索：命中数最多 / 最少各一次
  // 挑一个出现最多的词元，模拟「搜热门角色」
  const busiest = index.tokenIndex.tokens
    .map((token) => [token, index.tokenIndex.map.get(token).length])
    .sort((a, b) => b[1] - a[1])[0];
  big.busiestToken = busiest?.[0];
  big.busiestRows = busiest?.[1] ?? 0;

  t0 = process.hrtime.bigint();
  const hot = searchPlanIndex(index, busiest?.[0] ?? 'x');
  big.searchHotMs = ms(t0);
  big.searchHotHits = hot.ids.length;

  t0 = process.hrtime.bigint();
  const coldWord = searchPlanIndex(index, '不存在的角色');
  big.searchMissMs = ms(t0);
  big.searchMissHits = coldWord.ids.length;

  // 同词翻页（复用 lastQuery）
  t0 = process.hrtime.bigint();
  searchPlanIndex(index, busiest?.[0] ?? 'x');
  big.searchRepeatMs = ms(t0);

  // 分页 + 单页物化（这是「按页取」真正省下来的那一笔）
  const ids = hot.ids.length ? hot.ids : index.lineups.map((_, i) => i);
  const page = planPageOf(ids, 1, 20);
  const account = { owned: new Set(), eidolons: new Map(), cones: new Map() };
  t0 = process.hrtime.bigint();
  const pageRows = page.ids.map((id) => {
    const { row, state } = index.entries[id];
    return materializePlanRow(row, state);
  });
  big.pageMs = ms(t0);
  big.pageRows = pageRows.length;
  big.pagePages = page.pages;
}

const out = { real, synthetic: big };
if (JSON_OUT) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('① 真实数据（异相仲裁 · 绝境，窗口 6 版）');
  console.log(`   整池 ${real.lineups} 个角色组合 · ${real.poolRows} 条投稿记录 · ${real.submissions} 条投稿 · ${real.pages} 页`);
  console.log(`   冷启动（读档 + 评分 + 建池）        ${real.coldMs.toFixed(1)} ms`);
  console.log(`   命中缓存后翻到第 2 页（${real.pageRows} 行）      ${real.pageMs.toFixed(1)} ms`);
  console.log(`   第一次搜索（含建次选索引）           ${real.firstSearchMs.toFixed(1)} ms（命中 ${real.hits} 支，其中次选 ${real.altOnly} 支）`);
  console.log(`   换一个词搜（索引已建好）             ${real.warmSearchMs.toFixed(1)} ms（命中 ${real.warmHits} 支）`);
  console.log(`   同一个词翻第 2 页（复用命中缓存）     ${real.searchPageMs.toFixed(1)} ms`);
  console.log(`   缓存：${JSON.stringify(real.cache)}`);

  console.log(`\n② 合成 ${COUNT} 条（每条一套新阵容 = 最坏情况）`);
  console.log(`   投稿 ${big.rows} 条 → ${big.packs} 套整包 → ${big.lineups} 个角色组合`);
  console.log(`   scoreEnvRows                        ${big.scoreMs.toFixed(0)} ms`);
  console.log(`   buildPlanPool（建池 / 排序 / 折叠）   ${big.poolMs.toFixed(0)} ms`);
  console.log(`   词元倒排（${big.tokens} 个不同词元）          ${big.tokenMs.toFixed(0)} ms`);
  console.log(`   次选索引                            ${big.altBuilt ? `${big.altMs.toFixed(0)} ms` : '跳过（超过上限 ' + big.altLimit + ' 行）'}`);
  console.log(`   搜索最热词元「${big.busiestToken}」（${big.busiestRows} 行）  ${big.searchHotMs.toFixed(1)} ms（命中 ${big.searchHotHits} 支）`);
  console.log(`   搜索查无此词                        ${big.searchMissMs.toFixed(1)} ms`);
  console.log(`   同一个词再搜一次（复用）              ${big.searchRepeatMs.toFixed(1)} ms`);
  console.log(`   单页物化 ${big.pageRows} 行（共 ${big.pagePages} 页）        ${big.pageMs.toFixed(1)} ms`);
}
