// 抽卡方案的**耗时探针**：量 `teamPlan()` 在真实数据集上、不同展示上限下各花多少毫秒。
//
// 为什么要它：2026-10-18 用户要求「配队从 15 条改为尽可能多 + 分页」，于是 `delivered`
// 从 15 条涨到整个候选池（实测 ~245 支）。`teamPlan()` 在**浏览器里**跑，所以每多一条
// 都会变成主线程上的真实开销 —— 改口径前先用它量一遍，别凭感觉。
//
//   node tools/_probe-team-plan-perf.mjs [--rounds=5] [--json]
//
// 量三段：
//   ① `teamPlan()` 整体（含候选池装配、评分、补金顺序、下行投影）；
//   ② 只含 15 条 vs 全池 —— 差值就是「多出来的那 230 条的投影成本」（含 alternatives）；
//   ③ 单条 `alternatives` 的开销（它现在是每行都对整个池做一次 filter + sort）。
import { performance } from 'node:perf_hooks';
import {
  SCORING, VERSION_WINDOW, buildConclusion, normalizeDrawWeights, teamPlan,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ROUNDS = Math.max(1, Number(arg('rounds', '5')) || 5);
const JSON_OUT = process.argv.includes('--json');

const index = await archiveIndex();
await loadI18n();
const availability = index.refs?.availability || {};
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const conclusion = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  hiddenCosts: undefined,
});

// 一个「半图鉴」账号：池子大小接近真实用户（全新账号池最大）。
const account = { owned: new Set(), eidolons: new Map(), cones: new Map() };
const weights = normalizeDrawWeights({});

const timeOnce = (rows) => {
  const keep = SCORING.teamPlanMaxRows;
  SCORING.teamPlanMaxRows = rows;
  try {
    const t0 = performance.now();
    const plan = teamPlan(conclusion, account, { availability, drawWeights: weights });
    return { ms: performance.now() - t0, plan };
  } finally {
    SCORING.teamPlanMaxRows = keep;
  }
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const sample = (rows) => {
  const runs = [];
  let last = null;
  for (let i = 0; i < ROUNDS; i += 1) {
    const r = timeOnce(rows);
    runs.push(r.ms);
    last = r.plan;
  }
  return { rows: last.rows.length, pool: last.pool, ms: median(runs), runs, plan: last };
};

const base = sample(1);
const fifteen = sample(15);
const full = sample(1e6);

// ③ alternatives 的开销：把每行的 alternatives 手工重算一遍（与 advice.js 同构）。
const ranked = full.plan.rows;
const t0 = performance.now();
for (const row of ranked) {
  const mine = new Set(row.members.map((m) => m.char));
  ranked
    .filter((o) => o.key !== row.key)
    .map((o) => ({
      o,
      shared: o.members.filter((m) => mine.has(m.char)).length,
      diff: Math.abs(Number(o.total) - Number(row.total)),
    }))
    .filter((x) => x.shared >= 2)
    .sort((a, b) => b.shared - a.shared || a.diff - b.diff)
    .slice(0, 3);
}
const altMs = performance.now() - t0;

const out = {
  pool: full.pool,
  poolAll: full.plan.poolAll,
  rowsDelivered: full.rows,
  ms: { one: base.ms, fifteen: fifteen.ms, full: full.ms, alternativesLoop: altMs },
  perRowUs: ((full.ms - fifteen.ms) / Math.max(1, full.rows - 15)) * 1000,
};

// ④ `--check`：逐条对拍「成员倒排索引」与**旧的**全池扫描（`advice.js` 2026-10-18 改过）。
//
// 旧的判据是「对全池 filter → map → filter → sort(shared, diff)」，稳定性由
// `Array.prototype.sort` 对 `ranked` 的次序保证。这里用**下发的 rows** 当池子重算一遍
// （`rows` 的 `total` 已四舍五入到 4 位，只在「分差恰好相等」的极端并列上可能与旧实现
// 差一位，所以对拍结果按「前 3 条的 key 序列」比，并把差异逐条打出来）。
if (process.argv.includes('--check')) {
  const pool = full.plan.rows;
  let mismatch = 0;
  let compared = 0;
  let withAlts = 0;
  for (const row of pool) {
    const mine = new Set(row.members.map((m) => m.char));
    const old = pool
      .filter((o) => o.key !== row.key)
      .map((o) => ({
        o,
        shared: o.members.filter((m) => mine.has(m.char)).length,
        diff: Math.abs(Number(o.total) - Number(row.total)),
      }))
      .filter((x) => x.shared >= 2)
      .sort((a, b) => b.shared - a.shared || a.diff - b.diff)
      .slice(0, 3)
      .map((x) => x.o.key);
    const now = (row.alternatives || []).map((x) => x.key);
    if (old.length || now.length) withAlts += 1;
    compared += 1;
    if (old.join('|') !== now.join('|')) {
      mismatch += 1;
      if (mismatch <= 5) {
        console.log(`  ✗ ${row.key}\n      旧：${old.join(' / ')}\n      新：${now.join(' / ')}`);
      }
    }
  }
  out.check = { compared, withAlts, mismatch };
  console.log(`④ 次选配队对拍：${compared} 条（有次选的 ${withAlts} 条）`
    + `，与旧算法不一致 ${mismatch} 条`);
}

// ④ `--peek`：把**整池下发**之后的分页结果打几行出来（第 1 页首尾、跨页处、末页）
// —— 用户要「尽可能多的配队 + 每页 20」，所以「第 20 → 21 条之间有没有断层」和
// 「尾部那些补 30 金的队伍是不是负分」都得能直接看到。
if (process.argv.includes('--peek')) {
  const rows = full.plan.rows;
  const at = (i) => {
    const r = rows[i];
    if (!r) return `#${i + 1} —（没有这一条）`;
    return `#${i + 1} 总分 ${Number(r.total).toFixed(1)}｜① ${Number(r.strengthPct).toFixed(1)}`
      + `｜② ${Number(r.gapPct).toFixed(1)}｜补 ${r.gap} 金｜次选 ${r.alternatives.length} 支`;
  };
  console.log(`\n④ 整池 ${rows.length} 条 → 每页 20 → ${Math.ceil(rows.length / 20)} 页`);
  for (const i of [0, 1, 19, 20, rows.length - 2, rows.length - 1]) console.log(`   ${at(i)}`);
  const neg = rows.filter((r) => Number(r.gapPct) < 0).length;
  const negTotal = rows.filter((r) => Number(r.total) < 0).length;
  console.log(`   ② 为负的 ${neg} 条、总分为负的 ${negTotal} 条`
    + `（负分意味着「超过封顶值」，2026-10-15 起不再截断 —— 它们排在最后几页）`);
  out.peek = { rows: rows.length, pages: Math.ceil(rows.length / 20), negative: neg, negativeTotal: negTotal };
}

if (JSON_OUT) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`候选池 ${out.pool} 支（去重后 ${out.poolAll}）｜下发 ${out.rowsDelivered} 条`);
  console.log(`teamPlan() 中位耗时（${ROUNDS} 轮取中位）：`);
  console.log(`  上限 1 条    ${out.ms.one.toFixed(1)} ms`);
  console.log(`  上限 15 条   ${out.ms.fifteen.toFixed(1)} ms`);
  console.log(`  上限全池     ${out.ms.full.toFixed(1)} ms`);
  console.log(`  → 多出的 ${out.rowsDelivered - 15} 条摊 ~${out.perRowUs.toFixed(0)} µs/条`
    + `（含 mid / alternatives 投影）`);
  console.log(`  ③ 单独重算全部 alternatives：${out.ms.alternativesLoop.toFixed(1)} ms`);
}
