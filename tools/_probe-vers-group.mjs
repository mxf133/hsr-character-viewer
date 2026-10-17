// 探针：泛用性两组归一（2026-10-17 第 1 条）在真实数据上的量级差，
// 以及它传导到**队级泛用性**（补金推荐 ③）之后的实际影响。
//
//   node tools/_probe-vers-group.mjs
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

// ---- 1. 两组各自的原始量分布 ---------------------------------------------------
const byName = new Map();   // 角色 → { low, e6 }
for (const u of units) {
  const tier = eidolonTierOf(u.eidolon);
  const g = tier === 6 ? 'e6' : 'low';
  let e = byName.get(u.name);
  if (!e) { e = {}; byName.set(u.name, e); }
  if (e[g] === undefined) e[g] = Number(u.versatilityRaw) || 0;
}
const lows = [...byName.values()].map((e) => e.low).filter((v) => Number.isFinite(v));
const e6s = [...byName.values()].map((e) => e.e6).filter((v) => Number.isFinite(v));
const stat = (a) => (a.length
  ? `n=${a.length} min=${Math.min(...a).toFixed(2)} 中位=${a.slice().sort((x, y) => x - y)[a.length >> 1].toFixed(2)} max=${Math.max(...a).toFixed(2)}`
  : '（无）');
console.log(`低档组（E0/E1/E2 平均）：${stat(lows)}`);
console.log(`E6 组（自己那份）      ：${stat(e6s)}`);
const both = [...byName.entries()].filter(([, e]) => e.low !== undefined && e.e6 !== undefined);
console.log(`两组都有的角色 ${both.length} 个`);
const ratio = both.map(([n, e]) => ({ n, r: e.e6 / Math.max(0.01, e.low) }))
  .sort((a, b) => b.r - a.r);
console.log(`  E6/低档 比值：中位 ${ratio[ratio.length >> 1]?.r.toFixed(2)}`
  + `｜最大 ${ratio[0]?.n} ${ratio[0]?.r.toFixed(2)}｜最小 ${ratio[ratio.length - 1]?.n} ${ratio[ratio.length - 1]?.r.toFixed(2)}`);

// ---- 2. 榜上那一列的组间观感 ---------------------------------------------------
const scored = units.map((u) => ({
  name: cn(u.name), tier: eidolonTierOf(u.eidolon),
  raw: Number(u.versatilityRaw) || 0, score: Number(u.versatilityScore) || 0,
}));
const avgScoreOf = (tiers) => {
  const rows = scored.filter((r) => tiers.includes(r.tier));
  const uniq = new Map();
  for (const r of rows) if (!uniq.has(r.name) || uniq.get(r.name).score < r.score) uniq.set(r.name, r.score);
  const a = [...uniq.values()];
  return a.length ? a.reduce((n, v) => n + v, 0) / a.length : NaN;
};
console.log(`泛用性得分均值：低档组 ${avgScoreOf([0, 1, 2]).toFixed(2)}｜E6 组 ${avgScoreOf([6]).toFixed(2)}`
  + `｜全部 ${avgScoreOf([0, 1, 2, 6]).toFixed(2)}`);

// 2b. 名单长度与原始量的关系（原始量是「按版本/关卡加权的队友数」）
console.log('\n原始量 top 12（低档组）：');
[...byName.entries()].filter(([, e]) => e.low !== undefined)
  .sort((a, b) => b[1].low - a[1].low).slice(0, 12)
  .forEach(([n, e]) => console.log(`  ${cn(n).padEnd(10)} low=${e.low.toFixed(2)} e6=${(e.e6 ?? NaN).toFixed(2)}`));
console.log('\n原始量 top 12（E6 组）：');
[...byName.entries()].filter(([, e]) => e.e6 !== undefined)
  .sort((a, b) => b[1].e6 - a[1].e6).slice(0, 12)
  .forEach(([n, e]) => console.log(`  ${cn(n).padEnd(10)} e6=${e.e6.toFixed(2)} low=${(e.low ?? NaN).toFixed(2)}`));

// ---- 3. 队级泛用性：E6 成员占比与 ③ 得分 ---------------------------------------
const plan = conclusion.teamPlan;
const rows = (plan?.plans || plan || []).map((p) => ({
  name: p.name || p.label || '', gold: p.gold,
  vRaw: Number(p.versatilityRaw) || 0, vPct: Number(p.versatilityPct) || 0,
  tiers: (p.members || []).map((m) => eidolonTierOf(m.eidolon)),
  strength: Number(p.strengthPct) || 0, gap: Number(p.gapPct) || 0,
}));
if (rows.length) {
  const e6Share = rows.map((r) => r.tiers.filter((t) => t === 6).length / Math.max(1, r.tiers.length));
  const lo = rows.map((r) => r.vRaw);
  console.log(`补金推荐 ${rows.length} 支：队级泛用性原始量 min=${Math.min(...lo).toFixed(2)} max=${Math.max(...lo).toFixed(2)}`);
  const high = rows.filter((_, i) => e6Share[i] >= 0.5);
  const low = rows.filter((_, i) => e6Share[i] <= 0.25);
  const mean = (a, k) => (a.length ? a.reduce((n, v) => n + v[k], 0) / a.length : NaN);
  console.log(`  E6 成员占一半以上 ${high.length} 支：③ 均值 ${mean(high, 'vPct').toFixed(2)}`);
  console.log(`  E6 成员不超过 1/4 ${low.length} 支：③ 均值 ${mean(low, 'vPct').toFixed(2)}`);
}
