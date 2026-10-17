// 探针：两组归一之后，组内相对分的**分布形状**是否持平。
// 背景：用户 2026-10-17 第 1 条「E6 仅与 E6 比、E0/1/2 与 E0/1/2 比，避免不同量级」。
// 分组本身已经做了（两把尺子），min-max 归一只保证**同一百分位 → 同分**；
// 如果两组原始量的形状差得远（例如 E6 那边绝大多数贴在尺子下端、只有一个离群值
// 把上界撑高），组内相对分的**均值/中位数**仍会差一个量级，于是「E6 成员越多、
// ③ 越低」会以另一种形式回来。这个探针就是量这件事。
//
//   node tools/_probe-vers-shape.mjs
import {
  buildConclusion, eidolonTierOf, teamPoolUnits, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const cn = (n) => zhName(i18n, 'characters', n) || n;
const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const conclusion = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});
const units = teamPoolUnits(conclusion);

const stat = (list, key) => {
  const v = list.map((x) => x[key]).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
  return {
    n: v.length, min: v[0], p25: q(0.25), median: q(0.5), p75: q(0.75),
    max: v[v.length - 1], mean: v.reduce((a, b) => a + b, 0) / v.length,
  };
};
const normStat = (list, key, lo, hi) => {
  const span = hi - lo;
  if (!(span > 1e-9)) return null;
  const s = list.map((x) => (x[key] - lo) / span).sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return {
    mean: (s.reduce((a, b) => a + b, 0) / s.length) * 100,
    median: q(0.5) * 100, p25: q(0.25) * 100, p75: q(0.75) * 100,
  };
};
const shape = (list, key, lo, hi) => {
  const bins = new Array(10).fill(0);
  for (const x of list) {
    const i = Math.min(9, Math.max(0, Math.floor((x[key] - lo) / (hi - lo) * 10)));
    bins[i] += 1;
  }
  return bins;
};

// ---- 1. 榜上单位：按「角色|E档」去重后，两组的分布 ---------------------------------
const byKey = new Map();
for (const u of units) {
  const tier = eidolonTierOf(u.eidolon);
  const k = `${u.name}|${tier}`;
  if (!byKey.has(k)) byKey.set(k, { name: u.name, tier, raw: Number(u.versatilityRaw) || 0 });
}
const all = [...byKey.values()];
for (const key of ['low', 'e6']) {
  const list = all.filter((r) => (key === 'e6' ? r.tier === 6 : r.tier !== 6));
  const st = stat(list, 'raw');
  if (!st) { console.log(`${key}: 空`); continue; }
  const nm = normStat(list, 'raw', st.min, st.max);
  console.log(`\n== 榜上单位 · ${key === 'e6' ? 'E6 组' : 'E0/E1/E2 组'}：${st.n} 条 ==`);
  console.log(`  原始量 min=${st.min.toFixed(2)} p25=${st.p25.toFixed(2)} 中位=${st.median.toFixed(2)}`
    + ` p75=${st.p75.toFixed(2)} max=${st.max.toFixed(2)} 均值=${st.mean.toFixed(2)}`);
  console.log(`  组内相对分(0-100) 均值=${nm.mean.toFixed(1)} 中位=${nm.median.toFixed(1)}`
    + ` p25=${nm.p25.toFixed(1)} p75=${nm.p75.toFixed(1)}`);
  console.log('  形状 ' + shape(list, 'raw', st.min, st.max)
    .map((n, i) => `${i * 10}-${(i + 1) * 10}%:${n}`).join(' '));
}

// ---- 2. 候选池成员位：队级 ③ 的真实输入 -------------------------------------------
const poolRows = [];
for (const u of units) {
  for (const m of (u.members || u.versatilityMembers || [])) {
    poolRows.push({ char: m.char || m.name, eidolon: Number(m.eidolon) || 0 });
  }
}
const memberSeen = new Set();
const members = [];
for (const m of poolRows) {
  const tier = m.eidolon === 6 ? 6 : (m.eidolon <= 2 ? m.eidolon : 2);
  const k = `${m.char}|${tier}`;
  if (memberSeen.has(k)) continue;
  memberSeen.add(k);
  const hit = byKey.get(k);
  if (hit) members.push({ char: m.char, tier, raw: hit.raw });
}
console.log(`\n== 候选池成员位：${members.length} 个（去重后按 角色|E档） ==`);
for (const key of ['low', 'e6']) {
  const list = members.filter((r) => (key === 'e6' ? r.tier === 6 : r.tier !== 6));
  const st = stat(list, 'raw');
  if (!st) { console.log(`  ${key}: 空`); continue; }
  const nm = normStat(list, 'raw', st.min, st.max);
  console.log(`  ${key === 'e6' ? 'E6  ' : '低档'} ${String(st.n).padStart(3)} 位：`
    + `原始量均值 ${st.mean.toFixed(2)}（中位 ${st.median.toFixed(2)}，max ${st.max.toFixed(2)}）`
    + ` → 组内相对分均值 ${nm.mean.toFixed(1)}（中位 ${nm.median.toFixed(1)}）`);
}
const lowM = stat(members.filter((r) => r.tier !== 6), 'raw');
const e6M = stat(members.filter((r) => r.tier === 6), 'raw');
if (lowM && e6M) {
  const ln = normStat(members.filter((r) => r.tier !== 6), 'raw', lowM.min, lowM.max);
  const hn = normStat(members.filter((r) => r.tier === 6), 'raw', e6M.min, e6M.max);
  console.log(`  → 归一后差距：均值 ${(ln.mean - hn.mean).toFixed(1)} 分｜中位 ${(ln.median - hn.median).toFixed(1)} 分`
    + '（≈0 才算两组真的持平）');
}

// ---- 3. 队级 ③ 与 E6 占比 ---------------------------------------------------------
const plan = conclusion.teamPlan;
const rows = (plan?.plans || plan || []).map((p) => ({
  label: (p.members || []).map((m) => cn(m.char)).join('/'),
  vPct: Number(p.versatilityPct) || 0,
  e6: (p.members || []).filter((m) => eidolonTierOf(m.eidolon) === 6).length,
  n: (p.members || []).length,
}));
if (rows.length) {
  const mean = (a) => (a.length ? a.reduce((n, v) => n + v, 0) / a.length : NaN);
  const hi = rows.filter((r) => r.n && r.e6 / r.n >= 0.5);
  const lo = rows.filter((r) => r.n && r.e6 / r.n <= 0.25);
  console.log(`\n== 队级 ③（候选池 ${rows.length} 支） ==`);
  console.log(`  E6 成员占一半以上 ${hi.length} 支：③ 均值 ${mean(hi.map((r) => r.vPct)).toFixed(2)}`);
  console.log(`  E6 成员不超过 1/4 ${lo.length} 支：③ 均值 ${mean(lo.map((r) => r.vPct)).toFixed(2)}`);
}
