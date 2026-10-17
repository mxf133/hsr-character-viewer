// 探针：三个分项被加权之前的「离散度」是不是一致？
//
//   node tools/_probe-cost-scale.mjs
//
// 背景：`角色得分 = ws × 强度 + wc × 性价比 + wv × 泛用性`，界面写的是默认
// 1 : 1 : 0.5（→ 0.4 / 0.4 / 0.2）。但三个分项的**换算路径完全不同**：
//   * 强度   —— 绝对刻度，原始量本来就是 0~100，`a = 1`；
//   * 性价比 —— 榜内 min-max，`a = 100 / (hi − lo)`，跨度大就小得可怜；
//   * 泛用性 —— 榜内 min-max（分两组）。
// min-max 是仿射变换，**不改变该分项内部的排序**，但会把它的「有效影响力」
// 缩放成 `a` 倍 —— 于是名义权重与实际贡献不是一回事。本探针把这件事量出来。
import {
  buildConclusion, VERSION_WINDOW, SCORING,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const index = await archiveIndex();
const i18n = await loadI18n();
const cn = (n) => zhName(i18n, 'characters', n) || n;
const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const fa = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const c = buildConclusion(envs, {
  availability: index.refs?.availability || {},
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  frontier: Object.fromEntries(fa.map((f) => [f.env, f])),
});

const all = [];
const seen = new Set();
for (const u of [...(c.frontierUnits || []), ...Object.values(c.frontierTiers || {}).flat()]) {
  const k = `${u.name}|${u.eidolon}|${u.lc}|${u.superimp}`;
  if (seen.has(k)) continue;
  seen.add(k); all.push(u);
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
};
const rank = (arr) => {
  const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(arr.length);
  for (let i = 0; i < idx.length; i += 1) r[idx[i][1]] = i;
  return r;
};
const pearson = (a, b) => {
  const ma = mean(a); const mb = mean(b);
  let sa = 0; let sb = 0; let sab = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - ma; const db = b[i] - mb;
    sa += da * da; sb += db * db; sab += da * db;
  }
  return sa && sb ? sab / Math.sqrt(sa * sb) : NaN;
};
const spearman = (a, b) => pearson(rank(a), rank(b));

const ext = c.frontierExtents || {};
console.log(`整包 ${all.length} 条`);
console.log(`刻度：强度=${JSON.stringify(ext.strength)}  性价比=${JSON.stringify(ext.cost)}`);
console.log('');

// ---- ① 三个分项的离散度 ----
const S = all.map((u) => num(u.strengthScore));
const C = all.map((u) => num(u.costScore));
const V = all.map((u) => num(u.versatilityScore));
console.log('=== ① 分项得分（0~100）的离散度 ===');
for (const [label, arr] of [['强度', S], ['性价比', C], ['泛用性', V]]) {
  console.log(`  ${label.padEnd(4)} 均值=${mean(arr).toFixed(1).padStart(6)} 标准差=${std(arr).toFixed(2).padStart(6)}`
    + `  p10=${pct(arr, 0.1).toFixed(1).padStart(6)} p50=${pct(arr, 0.5).toFixed(1).padStart(6)}`
    + ` p90=${pct(arr, 0.9).toFixed(1).padStart(6)}`);
}

// ---- ② 名义权重 vs 有效贡献 ----
const W = { strength: 0.4, cost: 0.4, versatility: 0.2 };
const contrib = [['强度', W.strength * std(S)], ['性价比', W.cost * std(C)], ['泛用性', W.versatility * std(V)]];
const totalContrib = contrib.reduce((n, [, v]) => n + v, 0);
console.log('');
console.log('=== ② 名义权重 0.4 / 0.4 / 0.2 下，各分项对角色得分的**实际**影响力 ===');
for (const [label, v] of contrib) {
  console.log(`  ${label.padEnd(4)} w×σ = ${v.toFixed(2).padStart(6)}  → 占方差的 ${(v / totalContrib * 100).toFixed(1)}%`);
}

// ---- ③ 单项权重敏感性：把性价比权重归零，榜会怎么变 ----
const scoreWith = (wc) => all.map((u) => W.strength * num(u.strengthScore)
  + wc * num(u.costScore) + W.versatility * num(u.versatilityScore));
const base = scoreWith(W.cost);
const noCost = scoreWith(0);
const doubleCost = scoreWith(W.cost * 2);
console.log('');
console.log('=== ③ 性价比权重的敏感性 ===');
console.log(`  wc=0.4 vs wc=0    Spearman=${spearman(base, noCost).toFixed(4)}  Pearson=${pearson(base, noCost).toFixed(4)}`);
console.log(`  wc=0.4 vs wc=0.8  Spearman=${spearman(base, doubleCost).toFixed(4)}`);
const topN = (arr, n) => all.map((u, i) => ({ u, s: arr[i] })).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.u.name);
const t20a = new Set(topN(base, 20)); const t20b = new Set(topN(noCost, 20));
console.log(`  前 20 名重叠（wc=0.4 vs wc=0）：${[...t20a].filter((n) => t20b.has(n)).length} / 20`);

// ---- ④ 性价比原始量的尾巴：跨度被谁撑开 ----
const raw = all.map((u) => num(u.total)).sort((a, b) => a - b);
console.log('');
console.log('=== ④ 性价比原始量 total 的尾巴 ===');
console.log(`  min=${raw[0].toFixed(2)} p50=${pct(raw, 0.5).toFixed(1)} p90=${pct(raw, 0.9).toFixed(1)}`
  + ` p99=${pct(raw, 0.99).toFixed(1)} max=${raw[raw.length - 1].toFixed(1)}`);
const top1 = raw[raw.length - 1];
console.log(`  跨度 = ${(top1 / Math.max(0.01, raw[0])).toFixed(0)} 倍；`
  + `top1 占满量程的 ${((top1 - raw[0]) / (top1 - raw[0]) * 100).toFixed(0)}%`);
console.log('  top10 分别把「100 分」的锚点抬到多高（去掉它之后的 hi）：');
for (let k = 0; k < 10; k += 1) {
  const hi = raw[raw.length - 1 - k];
  const lo = raw[0];
  const a = 100 / (hi - lo);
  console.log(`    去掉最大 ${k} 个 → hi=${hi.toFixed(1).padStart(7)}  a=${a.toFixed(3)}`
    + `  → wc=0.4 的有效系数 ${(W.cost * a).toFixed(3)}（强度 a=1 → ${W.strength.toFixed(3)}）`);
}

// ---- ⑤ log 压缩之后会怎样 ----
console.log('');
console.log('=== ⑤ 若改用 log(1+x) 再 min-max ===');
const logRaw = raw.map((x) => Math.log1p(x));
const llo = logRaw[0]; const lhi = logRaw[logRaw.length - 1];
const Clog = all.map((u) => 100 * (Math.log1p(num(u.total)) - llo) / (lhi - llo));
console.log(`  σ(原 min-max)=${std(C).toFixed(2)}  σ(log 后再 min-max)=${std(Clog).toFixed(2)}`
  + `  σ(强度)=${std(S).toFixed(2)}`);
console.log(`  log 版与强度原始量的 Spearman=${spearman(Clog, S).toFixed(3)}（原版 ${spearman(C, S).toFixed(3)}）`);

// ---- ⑥ 顶部到底是谁：性价比榜前 10 与角色总榜前 10 ----
console.log('');
console.log('=== ⑥ 性价比原始量前 10 ===');
for (const u of [...all].sort((a, b) => num(b.total) - num(a.total)).slice(0, 10)) {
  const envsOf = (u.envs || []).map((e) => `${e.id}:${num(e.value).toFixed(0)}`).join(' ');
  console.log(`  ${num(u.total).toFixed(1).padStart(7)}  ${cn(u.name).padEnd(12)} E${u.eidolon}S${u.superimp}`
    + ` ${num(u.rawGold)}金 系数${num(u.ownGoldFactor).toFixed(2)}  [${envsOf}]`);
}
console.log('');
console.log('=== ⑦ 性价比原始量后 10 ===');
for (const u of [...all].sort((a, b) => num(a.total) - num(b.total)).slice(0, 10)) {
  const envsOf = (u.envs || []).map((e) => `${e.id}:${num(e.value).toFixed(1)}`).join(' ');
  console.log(`  ${num(u.total).toFixed(2).padStart(7)}  ${cn(u.name).padEnd(12)} E${u.eidolon}S${u.superimp}`
    + ` ${num(u.rawGold)}金 系数${num(u.ownGoldFactor).toFixed(2)}  [${envsOf}]`);
}
console.log('');
console.log(`SCORING.ownGoldFactorPower = ${SCORING.ownGoldFactorPower}`);
