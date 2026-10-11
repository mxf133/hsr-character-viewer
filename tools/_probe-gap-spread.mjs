// 探针：为什么「差额接近度」拉不开差距 —— 打出补金差额的分布，以及四种归一化下的取值与总分跨度。
//
//   node tools/_probe-gap-spread.mjs --account=1
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, eidolonsOf, lightConeRanksOf, teamPlan, ownedCharacters, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (name, dflt) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return dflt;
};
const ACC = Math.max(1, Number(arg('account', '1')) || 1);

const index = await archiveIndex();
const i18n = await loadI18n();
const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const account = accounts[ACC - 1];
const role = (account?.roles || [])[0];
const snap = await store.getSnapshot(account.id, role.uid);
const zhToEn = {}; const allNames = [];
for (const c of index.refs?.characters || []) {
  if (c.nameCn && c.name) zhToEn[c.nameCn] = c.name;
  if (c.nameCn) allNames.push(c.nameCn);
}
const coneZhToEn = {};
for (const c of index.refs?.lightCones || []) if (c.nameCn && c.name) coneZhToEn[c.nameCn] = c.name;
const acct = {
  owned: ownedCharacters(snap, zhToEn, allNames),
  eidolons: eidolonsOf(snap, zhToEn),
  cones: lightConeRanksOf(snap, coneZhToEn),
};
const availability = index.refs?.availability || {};
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const conclusion = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});
const plan = teamPlan(conclusion, acct, { availability });
const rows = plan.rows;
const gaps = rows.map((r) => r.gap).sort((a, b) => a - b);

console.log(`账号 ${ACC}（${role.nickname}）`);
console.log(`候选池 ${plan.pool} 支（下发 ${rows.length} 支，truncated=${plan.truncated}）`
  + ` · **池内最大差额 ${plan.gapMax} 金**`);
console.log(`性价比原始分 ${plan.scoreLo.toFixed(1)} ~ ${plan.scoreHi.toFixed(1)}`);

// ⚠️ 关键：`gapMax` 取的是**整个候选池**的最大值（含被截断掉的那些冷门队伍），
// 而下发的只有前 40 支 —— 少数几支「要补几十金」的冷门队会把刻度的上端撑得极远。
{
  const allGaps = [];
  for (const pool of [plan.pool]) void pool;
  // 重新算一遍**全池**的差额（teamPlan 只下发前 N 行，所以这里用 maxRows=10000 拿全量）
  const full = teamPlan(conclusion, acct, { availability, maxRows: 10000 });
  for (const r of full.rows) allGaps.push(r.gap);
  allGaps.sort((a, b) => a - b);
  const q = (p) => allGaps[Math.min(allGaps.length - 1, Math.floor(allGaps.length * p))];
  console.log(`\n【全池 ${allGaps.length} 支的差额分位】`
    + ` min ${allGaps[0]} / p25 ${q(0.25)} / 中位 ${q(0.5)} / p75 ${q(0.75)} / p90 ${q(0.9)} / max ${allGaps[allGaps.length - 1]} 金`);
  console.log(`下发前 ${rows.length} 支的差额范围：${gaps[0]} ~ ${gaps[gaps.length - 1]} 金`
    + `（**只占全池刻度 ${(gaps[gaps.length - 1] / plan.gapMax * 100).toFixed(0)}%**）`);
}

// ---- 差额分布 ----------------------------------------------------------------
const hist = new Map();
for (const g of rows.map((r) => r.gap)) hist.set(g, (hist.get(g) || 0) + 1);
const maxCount = Math.max(...hist.values());
console.log('\n【补金差额分布】');
for (const [g, n] of [...hist].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${String(g).padStart(2)} 金 │ ${'█'.repeat(Math.max(1, Math.round(n / maxCount * 36)))} ${n} 支`);
}
const cum = (g) => gaps.filter((x) => x <= g).length;
console.log('\n【累计占比】');
for (const g of [1, 2, 3, 5, 8, 12]) {
  if (g > plan.gapMax) continue;
  console.log(`  ≤ ${String(g).padStart(2)} 金：${String(cum(g)).padStart(2)} / ${gaps.length}`
    + ` = ${(cum(g) / gaps.length * 100).toFixed(1)}%`);
}

// ---- 五种归一化 --------------------------------------------------------------
const MAX = plan.gapMax;
const normLin = (g) => 100 * (1 - g / MAX);                              // 现状
const normSqrt = (g) => 100 * (1 - Math.sqrt(g / MAX));
const normLog = (g) => (MAX <= 0 ? 100
  : 100 * (1 - Math.log1p(g) / Math.log1p(MAX)));
/** 秩（百分位）：均匀铺满 0~100，与分布形状无关（零维护）。 */
const rankOf = (g) => {
  const better = gaps.filter((x) => x < g).length;
  const same = gaps.filter((x) => x === g).length;
  return (better + (same - 1) / 2) / Math.max(1, gaps.length - 1);
};
const normRank = (g) => 100 * (1 - rankOf(g));
/** 修后的口径：刻度取自**下发批次**（= `plan.gapMax`），与 `teamPlan` 内部一致。 */
const newPct = (g) => 100 * Math.max(0, Math.min(1, 1 - g / MAX));
/** 档位制：把差额按「每 3 金一档」分箱，档内同分 —— 与界面「几金」的读法一致。 */
const BIN = 3;
const binCount = Math.ceil(MAX / BIN);
const normBin = (g) => 100 * (1 - Math.min(binCount - 1, Math.floor((g - 1) / BIN)) / Math.max(1, binCount - 1));

console.log('\n【同一笔差额在五种归一化下的「差额接近度」】');
console.log('  差额 │ 现状线性 │ 开方  │ 对数  │ 秩(百分位) │ 3金档位 │ 该差额的支数');
for (const g of [...new Set(rows.map((r) => r.gap))].sort((a, b) => a - b)) {
  console.log(`  ${String(g).padStart(3)} 金 │ ${normLin(g).toFixed(1).padStart(8)} │`
    + ` ${normSqrt(g).toFixed(1).padStart(5)} │ ${normLog(g).toFixed(1).padStart(5)} │`
    + ` ${normRank(g).toFixed(1).padStart(9)} │ ${normBin(g).toFixed(1).padStart(6)} │ ${String(hist.get(g)).padStart(2)} 支`);
}

// ---- 总分跨度 ----------------------------------------------------------------
const sPctOf = (r) => 100 * (r.teamScore - plan.scoreLo) / (plan.scoreHi - plan.scoreLo);
const scoreWith = (fn) => rows.map((r) => ({ r, total: 0.5 * sPctOf(r) + 0.5 * fn(r.gap) }));
const spread = (list) => {
  const xs = list.map((x) => x.total).sort((a, b) => a - b);
  const mean = xs.reduce((n, v) => n + v, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((n, v) => n + (v - mean) ** 2, 0) / xs.length);
  return { min: xs[0], max: xs[xs.length - 1], sd, range: xs[xs.length - 1] - xs[0] };
};
console.log('\n【总分离散程度】');
for (const [label, fn] of [['现状线性', normLin], ['开方', normSqrt], ['对数', normLog],
  ['秩(百分位)', normRank], ['3金档位', normBin]]) {
  const s = spread(scoreWith(fn));
  console.log(`  ${label.padEnd(11)} 总分 ${s.min.toFixed(1)} ~ ${s.max.toFixed(1)}`
    + `（跨度 ${s.range.toFixed(1)}，标准差 ${s.sd.toFixed(1)}）`);
}

// ---- 修前 / 修后对照 ---------------------------------------------------------
// 修前：刻度取自**全池**（含永远不会下发的极端队伍）。
// 修后：刻度取自**真正下发的那批**（teamPlan 现在的做法）。
const full = teamPlan(conclusion, acct, { availability, maxRows: 100000 });
const poolGaps = full.rows.map((r) => r.gap);
const OLD_MAX = Math.max(...poolGaps);          // 修前的 gapMax（全池最大）
const NEW_MAX = plan.gapMax;                     // 修后的 gapMax（下发批次最大）
const oldPct = (g) => 100 * Math.max(0, Math.min(1, 1 - g / OLD_MAX));
console.log(`\n【刻度对照】修前 gapMax = 全池最大 = ${OLD_MAX} 金`
  + `　→　修后 gapMax = 下发批次最大 = **${NEW_MAX} 金**`);
console.log(`  同一笔 1 金的差额：「差额接近度」${oldPct(1).toFixed(1)} → ${newPct(1).toFixed(1)}`);
console.log(`  同一笔 ${NEW_MAX} 金的差额：${oldPct(NEW_MAX).toFixed(1)} → ${newPct(NEW_MAX).toFixed(1)}`
  + `（修前它拿不到 0 分，因为刻度被 ${OLD_MAX} 金撑着）`);

const perMetric = (fn) => {
  const xs = rows.map((r) => fn(r.gap)).sort((a, b) => a - b);
  const mean = xs.reduce((n, v) => n + v, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((n, v) => n + (v - mean) ** 2, 0) / xs.length);
  return { min: xs[0], max: xs[xs.length - 1], sd, range: xs[xs.length - 1] - xs[0] };
};
console.log('\n【指标②这一个数自己的离散程度】');
for (const [label, fn] of [['修前（全池刻度）', oldPct], ['修后（下发批次刻度）', newPct],
  ['参考：秩(百分位)', normRank]]) {
  const s = perMetric(fn);
  console.log(`  ${label.padEnd(18)} ② ${s.min.toFixed(1)} ~ ${s.max.toFixed(1)}`
    + `（跨度 ${s.range.toFixed(1)}，标准差 ${s.sd.toFixed(1)}）`);
}

// ---- 候选方案：中位/分位封顶 + 开方（分辨率先给小差额）----------------------
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const pctile = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const P50 = median(rows.map((r) => r.gap));
const P75 = pctile(rows.map((r) => r.gap), 0.75);
/** 封顶值 C：差额 ≤ C 照常算，> C 归 0（C 取 Infinity 就是现状）。 */
const capped = (C) => (g) => 100 * Math.max(0, Math.min(1, 1 - g / C));
/** 封顶 + 开方：把分辨率优先给小差额那一头。 */
const cappedSqrt = (C) => (g) => 100 * Math.max(0, 1 - Math.sqrt(Math.min(g, C) / C));

// ---- 前 10 名的总分跨度（用户最在意的那一段）--------------------------------
const topSpan = (fn) => {
  const list = [...scoreWith(fn)].sort((a, b) => b.total - a.total).slice(0, 10);
  return { hi: list[0].total, lo: list[9].total, span: list[0].total - list[9].total };
};
console.log('\n【前 10 名的总分跨度】（越大越「拉得开」；② 的分位：'
  + `p50=${P50} 金 p75=${P75} 金 max=${MAX} 金）`);
const CANDIDATES = [
  ['现状：线性 / max', normLin],
  ['线性 / p75 封顶', capped(P75)],
  ['线性 / p50 封顶', capped(P50)],
  ['开方 / max', normSqrt],
  ['开方 / p75 封顶', cappedSqrt(P75)],
  ['开方 / p50 封顶', cappedSqrt(P50)],
  ['秩(百分位)', normRank],
  ['秩 50% + 线性 50%', (g) => 0.5 * normRank(g) + 0.5 * normLin(g)],
];
for (const [label, fn] of CANDIDATES) {
  const s = topSpan(fn);
  const full = spread(scoreWith(fn));
  console.log(`  ${label.padEnd(18)} 前10：${s.hi.toFixed(1)} ~ ${s.lo.toFixed(1)}`
    + `（跨度 ${s.span.toFixed(1)}）　全池 StdDev ${full.sd.toFixed(1)}`);
}

// ---- 修后实际下发的分项 ------------------------------------------------------
console.log('\n【修后前 10 名的两个分项】');
for (const [i, r] of rows.slice(0, 10).entries()) {
  console.log(`  #${String(i + 1).padStart(2)} 总分 ${r.total.toFixed(1).padStart(5)}`
    + `　① ${r.scorePct.toFixed(1).padStart(5)}　② ${r.gapPct.toFixed(1).padStart(5)}`
    + `（${String(r.gap).padStart(2)} 金）　`
    + r.members.map((m) => zhName(i18n, 'characters', m.char) || m.char).join('/'));
}

// ---- 名次变化（前 12）--------------------------------------------------------
const top = (fn) => [...scoreWith(fn)].sort((a, b) => b.total - a.total).slice(0, 12);
const cnOf = (r) => r.r.members.map((m) => zhName(i18n, 'characters', m.char) || m.char).join('/');
console.log('\n【前 12 名：修后（总分排序，实际下发） vs 修前（全池刻度）】');
const a1 = rows.slice(0, 12).map((r) => ({ r, total: r.total }));
const b1 = top(oldPct);
console.log('  修后                                  │ 修前');
for (let i = 0; i < 12; i += 1) {
  const L = a1[i]; const R = b1[i];
  console.log(`  #${String(i + 1).padStart(2)} ${(L?.total ?? 0).toFixed(1).padStart(5)} ${String(L?.r.gap).padStart(2)}金 ${cnOf(L).slice(0, 20).padEnd(21)} │`
    + ` #${String(i + 1).padStart(2)} ${R.total.toFixed(1).padStart(5)} ${String(R.r.gap).padStart(2)}金 ${cnOf(R).slice(0, 20)}`);
}
