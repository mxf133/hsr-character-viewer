// 探针（一次性，只读）：回答「为什么 4.2 的权重分被压低了」。
//
// 三块：
//   ① 每个副本的窗口里，4.2 距最新版本几个版本 → 权重多少（对照 2:2:2:1:1:1:1）。
//   ② 按最佳证据版本给榜上每条分组，看「锚在旧版本」的整包版本因子被压到多少。
//   ③ 反事实：把服务端下发的 seasonWeights 里 4.2 由 1 改成 2，**走生产同一份
//      buildConclusion** 重算一遍，看总分与名次怎么变。
//
// ⚠️ 反事实不改任何源码：只是把 `options.frontier` 里那份 `seasonWeights` 换掉
//    （客户端优先读服务端发来的这张表，见 advice.js 的 seasonWeightOfRow）。
//
// 用法：node tools/_probe-42-weight.mjs [--rows=20]
import { archiveIndex, archiveFrontierAll, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
import {
  buildConclusion, VERSION_WINDOW, VERSION_WEIGHTS, frontierFactorsOf,
} from '../public/scripts/advice.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TOP = Math.max(1, Number(arg('rows', 20)) || 20);

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const firstSeen = index.refs?.firstSeen || { characters: {}, lightCones: {} };
const cn = (n) => zhName(i18n, 'characters', n) || n;
const coneCn = (n) => (n ? (zhName(i18n, 'lightCones', n) || n) : '—');

const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });

const run = (frontierArrs) => buildConclusion(envs, {
  availability, firstSeen,
  account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
  frontier: Object.fromEntries(frontierArrs.map((f) => [f.env, f])),
  frontierWeights: Object.fromEntries(frontierArrs.map((f) => [f.env, f.weight])),
});

const base = run(frontierAll);
// 反事实：4.2 的权重 1 → 2（只动下发的那张表，不动源码里的 VERSION_WEIGHTS）
const bumped = run(frontierAll.map((f) => ({
  ...f,
  seasonWeights: (f.seasonWeights?.['4.2'] === 1)
    ? { ...f.seasonWeights, '4.2': 2 } : f.seasonWeights,
})));

console.log(`源码里的权重表 VERSION_WEIGHTS = [${VERSION_WEIGHTS.join(', ')}]`
  + `  （下标 0 = 该副本最新版本；第 8 个版本起 0 = 不进窗口）\n`);

console.log('=== ① 各副本窗口里 4.2 的位置与权重（服务端下发的 seasonWeights）');
console.log('    副本                 窗口(新→旧)                          4.2 下标  4.2 权重  窗口总权重');
for (const f of frontierAll) {
  const w = f.seasonWeights || {};
  // 下标 = 「距该副本最新版本几个版本」，用 seasons（升序）反转得到，**不要**按权重值排序
  const desc = [...(f.seasons || [])].reverse();
  const idx42 = desc.indexOf('4.2');
  const sum = Object.values(w).reduce((n, x) => n + (Number(x) || 0), 0);
  console.log(`    ${String(f.env).padEnd(20)}${('[' + desc.join(', ') + ']').padEnd(44)}`
    + `${String(idx42).padStart(7)}${String(w['4.2'] ?? '—').padStart(10)}${String(sum).padStart(11)}`);
}

console.log(`\n=== ② 按「最佳证据版本」分组，看版本因子（= 总分 ÷ 最佳证据版的分，恒 ≤ 1）`);
const unitsOf = (r) => r.frontierUnits || [];
const bestEnvOf = (u) => (u.envs || []).reduce((a, e) => (!a || (Number(e.value) || 0) > (Number(a.value) || 0) ? e : a), null);
const metaOf = (r, id) => (r.frontierEnvs || []).find((m) => m.id === id);
const bySeason = new Map();
for (const u of unitsOf(base)) {
  const e = bestEnvOf(u);
  const s = e?.evidenceSeason || '—';
  if (!bySeason.has(s)) bySeason.set(s, []);
  const f = frontierFactorsOf(e, metaOf(base, e?.id));
  bySeason.get(s).push({ u, sf: f.seasonFactor ?? 1, total: Number(u.total) || 0 });
}
for (const s of [...bySeason.keys()].sort()) {
  const list = bySeason.get(s);
  const avg = list.reduce((n, x) => n + x.sf, 0) / list.length;
  console.log(`    证据版本 ${String(s).padEnd(5)} ${String(list.length).padStart(3)} 条`
    + `  版本因子 平均 ×${avg.toFixed(3)}  最低 ×${Math.min(...list.map((x) => x.sf)).toFixed(3)}`);
}

// 反事实对照
const unitKey = (u) => `${u.name}|${u.eidolon}|${u.lc || '-'}|S${u.superimp}`;
const bTotal = new Map(unitsOf(base).map((u) => [unitKey(u), Number(u.total) || 0]));
const bumpTotal = new Map(unitsOf(bumped).map((u) => [unitKey(u), Number(u.total) || 0]));
const rank = (r) => new Map([...unitsOf(r)].sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0))
  .map((u, i) => [unitKey(u), i + 1]));
const rankBase = rank(base);
const rankBump = rank(bumped);

console.log(`\n=== ③ 反事实：4.2 权重 1 → 2（其余不变）后，总分与名次的变化（前 ${TOP} 条）`);
console.log('    #   整包                                 最佳证据  版本因子   本分    4.2=2后   名次');
let moved = 0;
let maxAbs = 0;
for (const u of unitsOf(base)) {
  const k = unitKey(u);
  const a = bTotal.get(k) || 0;
  const b = bumpTotal.get(k) ?? a;
  const d = Math.round(b) - Math.round(a);
  const rk = rankBase.get(k);
  const rk2 = rankBump.get(k);
  if (d !== 0) moved += 1;
  maxAbs = Math.max(maxAbs, Math.abs(d));
  const e = bestEnvOf(u);
  const f = frontierFactorsOf(e, metaOf(base, e?.id));
  const label = `${cn(u.name)} E${u.eidolon}${u.lc ? ` + ${coneCn(u.lc)}S${u.superimp}` : ''}`;
  if (rk > TOP) continue;
  console.log(`    ${String(rk).padStart(3)} ${label.padEnd(36)}`
    + `${String(e?.evidenceSeason ?? '—').padStart(6)}`
    + `${(f.seasonFactor ?? 1).toFixed(3).padStart(8)}`
    + `${String(Math.round(a)).padStart(8)}${String(Math.round(b)).padStart(10)}`
    + `   ${rk === rk2 ? '=' : `#${rk} → #${rk2}`}${d ? `  (${d > 0 ? '+' : ''}${d})` : ''}`);
}
console.log(`\n    全榜 ${unitsOf(base).length} 条中，分数会变的 ${moved} 条；单条最大变化 ${maxAbs} 分`);
