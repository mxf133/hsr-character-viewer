// 手工探针（`_` 前缀，不进测试套件）：**绝境王棋关表现曲线的改动量级**（用户 2026-10-11
// 第四轮，工具 v4.6.78）。
//
// 用户原话：「绝境王棋关的表现权重需要更新，行动值小于 300，权重固定为 1.00；
// 行动值 300-500，权重在 1-0.6 之间逐渐变化」。
//
// 为什么需要它：这条改动只碰了一个副本的一条曲线，但它落在**权重最高的副本**上
// （总榜权重 ×10），所以「榜面动了多少、有没有顺手动到别的副本」必须用真实数据量出来。
// 跑一次约 5 秒。
//
//   node tools/_probe-perf-plight.mjs            # 曲线表 + 榜面对比 + 逐副本变化条数
//   node tools/_probe-perf-plight.mjs --rows 20
//
// ⚠️ **怎么量「改动前」**：`SCORING.frontierPerfLineByEnv` 就是这份改动的**唯一开关**
// （清空它 = 回到默认那套 0.85 / 0.50，也就是本次改动之前的口径）。探针把这张表临时
// 清空再跑一遍 `buildConclusion`，两边**同一份数据、同一段代码**，差异只可能来自这条
// 曲线 —— 比拿旧提交跑一遍再目测对比可靠。跑完把表还原。
import {
  buildConclusion, envWeightOf, perfAnchorsOf, perfFactorOf, perfLineWeightsOf,
  SCORING, VERSION_WINDOW,
} from '../src/core/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (name, dflt) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return dflt;
};
const ROWS = Math.max(1, Number(arg('rows', '15')) || 15);

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const { envs } = await conclusionEnvs(index);
const cn = (n) => zhName(i18n, 'characters', n) || zhName(i18n, 'lightCones', n) || n;
const TIER = { perfect: '满分', target: '达标' };

/** 取一次前沿（含 `observedPackScores`）+ 算一次榜 —— 两边必须**各取各的**，见下。 */
const build = async (frontierAll) => {
  const frontier = Object.fromEntries(frontierAll.map((f) => [f.env, f]));
  const result = buildConclusion(envs, {
    availability,
    firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
    account: { owned: new Set() },
    frontier,
    frontierWeights: Object.fromEntries(frontierAll.map((f) => [f.env, f.weight])),
  });
  return { frontier, result };
};

// ⚠️ **「改动前」必须连前沿一起重取**：`archiveFrontier` 在取前沿时就把
// `observedPackScores`（未进池投稿的质量估算）按**当时那条曲线**算好了。只把
// `frontierPerfLineByEnv` 清空、复用新曲线取的前沿，会让「改动前」那一列在**有未进池
// 证据**的条目上比旧版本高出几分（实测最大 21 分、名次不变）—— 那样量出来的差值里
// 混了「前沿取数时机」的差异，不是这条改动的效果。
const withOverride = SCORING.frontierPerfLineByEnv;
const now = await build(await archiveFrontierAll(envs, { window: VERSION_WINDOW }));
SCORING.frontierPerfLineByEnv = {};
const old = await build(await archiveFrontierAll(envs, { window: VERSION_WINDOW }));
SCORING.frontierPerfLineByEnv = withOverride;
const after = now.result;
const before = old.result;

// ---- A. 曲线：默认套 / 绝境旧口径 / 绝境新口径，逐点对照 ----
const plightLines = { perfect: 300, target: 500 };
const plightW = perfLineWeightsOf({ mode: 'aa', stage: 'plight' });
const defaultW = perfLineWeightsOf(null);
const AVS = [0, 37, 100, 150, 285, 299, 300, 350, 400, 450, 500, 600, 700, 775, 900];
console.log('=== 绝境王棋关的表现曲线（判据线：满分 300 / 达标 500，无及格线）===');
console.log(`  锚点（新）：${JSON.stringify(perfAnchorsOf(plightLines, true, plightW))}`);
console.log(`  锚点（默认）：${JSON.stringify(perfAnchorsOf(plightLines, true, defaultW))}`);
console.log(`  ${'行动值'.padStart(6)}  ${'改动前'.padStart(8)}  ${'改动后'.padStart(8)}  ${'差'.padStart(8)}`);
for (const av of AVS) {
  const before = perfFactorOf(av, plightLines, true, av < 300 ? 'perfect' : 'target', defaultW);
  const after = perfFactorOf(av, plightLines, true, av < 300 ? 'perfect' : 'target', plightW);
  console.log(`  ${String(av).padStart(6)}  ${before.toFixed(4).padStart(8)}  ${after.toFixed(4).padStart(8)}`
    + `  ${(after - before >= 0 ? '+' : '') + (after - before).toFixed(4)}`);
}
// 其它副本必须**一字未变**（这三条是本探针的一条硬判据，红了就是改错了范围）。
for (const [mode, stage, lines, lib] of [
  ['moc', '', { perfect: 0, target: 2, pass: 4 }, true],
  ['as', '', { perfect: 4000, target: 3700, pass: 3400 }, false],
  ['aa', '', { perfect: 0, target: 2, pass: 4 }, true],
]) {
  const w = perfLineWeightsOf({ mode, stage });
  const same = JSON.stringify(w) === JSON.stringify(defaultW)
    && [0, 1, 2, 3, 4, 5, 600].every((av) => perfFactorOf(av, lines, lib, 'perfect', w)
      === perfFactorOf(av, lines, lib, 'perfect'));
  console.log(`  ${mode}${stage ? `|${stage}` : ''} 与默认套逐点相同：${same ? '是' : '否 ⚠️'}`);
}

// ---- B. 榜面对比：清空开关 + 重取前沿跑一遍 = 改动前 ----
const keyOf = (u) => `${u.name}|E${u.eidolon}|${u.lc || '-'}|S${u.superimp}`;
const beforeRank = new Map(before.frontierUnits.map((u, i) => [keyOf(u), i + 1]));
console.log(`\n=== 总榜前 ${ROWS}（改动前 → 改动后；括号里是名次变化）===`);
for (const [i, u] of after.frontierUnits.slice(0, ROWS).entries()) {
  const b = before.frontierUnits.find((x) => keyOf(x) === keyOf(u));
  const was = b ? Math.round(b.total) : null;
  const wasRank = beforeRank.get(keyOf(u));
  const delta = wasRank ? (wasRank === i + 1 ? '不动' : `#${wasRank}→#${i + 1}`) : '新进榜';
  console.log(`  #${String(i + 1).padStart(3)} ${String(Math.round(u.total)).padStart(5)}`
    + `（前 ${String(was ?? '—').padStart(5)}）  ${cn(u.name)} E${u.eidolon}`
    + `${u.lc ? ` + ${cn(u.lc)}S${u.superimp}` : ''}  [${delta}]`);
}

// ---- C. 逐副本：有多少条整包的分真的变了（绝境应该全变，其余四个应该是 0）----
const perEnv = new Map();
for (const u of after.frontierUnits) {
  const b = before.frontierUnits.find((x) => keyOf(x) === keyOf(u));
  if (!b) continue;
  for (const e of u.envs) {
    const be = b.envs.find((x) => x.id === e.id);
    if (!be) continue;
    const cur = perEnv.get(e.id) || { n: 0, moved: 0, sumBefore: 0, sumAfter: 0 };
    cur.n += 1;
    if (Math.abs(e.score - be.score) > 1e-9) cur.moved += 1;
    cur.sumBefore += be.score;
    cur.sumAfter += e.score;
    perEnv.set(e.id, cur);
  }
}
console.log('\n=== 逐副本：榜面条目里分值真的变了的比例 ===');
for (const env of envs) {
  const s = perEnv.get(env.id);
  if (!s) continue;
  const avg = (v) => (s.n ? (v / s.n).toFixed(2) : '—');
  console.log(`  ${String(env.label || env.id).padEnd(22)} 权重 ×${String(envWeightOf(env.mode, env.stage, 'frontier')).padStart(2)}`
    + `  ${String(s.moved).padStart(2)}/${String(s.n).padStart(2)} 条变化`
    + `  平均分 ${avg(s.sumBefore)} → ${avg(s.sumAfter)}`);
}

// ---- D. 绝境前沿池：整池的表现分平均（与行数无关，看的是曲线整体抬升）----
// ⚠️ 副本 id 是 `aa/plight`（**斜杠**，`frontierMeta` 的另一种写法是竖线）——
// `perfLineWeightsOf()` 两种都要认，探针这里也照实写。
const plight = now.frontier['aa/plight'] || now.frontier['aa|plight'];
const plightEnv = envs.find((e) => e.mode === 'aa' && e.stage === 'plight') || null;
if (plight && plightEnv) {
  const lines = plightEnv.tierLines || plightLines;
  let n = 0; let sumBefore = 0; let sumAfter = 0; let floored = 0;
  for (const row of plight.frontierRows || []) {
    const tier = row.tier;
    n += 1;
    sumBefore += perfFactorOf(row.actionValue, lines, true, tier, defaultW);
    const a = perfFactorOf(row.actionValue, lines, true, tier, plightW);
    sumAfter += a;
    if (a <= 0.05 + 1e-9) floored += 1;
  }
  console.log(`\n=== 绝境前沿池（${n} 行）表现分 ===`);
  console.log(`  平均 ${(sumBefore / n).toFixed(4)} → ${(sumAfter / n).toFixed(4)}`
    + `（${(sumAfter / sumBefore * 100 - 100).toFixed(2)}%）；贴地板的 ${floored} 行`);
}
console.log('\n构成：', JSON.stringify(after.counts));
