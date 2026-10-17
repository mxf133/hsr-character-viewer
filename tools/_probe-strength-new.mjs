/**
 * 强度改口径之后的效果盘点（用户 2026-10-17 晚：「强度只看行动值 + 高成本继承低成本」）。
 *
 * 要回答三件事：
 *   ① 低难副本是不是**普遍拿满分**了（每关 100 的占比）
 *   ② 继承到底覆盖了多少「已登场却没证据」的版本
 *   ③ E6 与其它档的相对位置变了多少（改前 E6 中位 18.3 / 四档最高）
 *
 * 用法：node tools/_probe-strength-new.mjs
 */
import {
  buildConclusion, eidolonTierOf, envWeightOf, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const index = await archiveIndex();
const i18n = await loadI18n();
const cn = (n) => zhName(i18n, 'characters', n) || n;
const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const fa = await archiveFrontierAll(envs, { window: VERSION_WINDOW });

const out = buildConclusion(envs, {
  availability: index.refs?.availability || {},
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  frontier: Object.fromEntries(fa.map((f) => [f.env, f])),
});

const seen = new Set();
const all = [];
for (const list of Object.values(out.frontierTiers || {})) {
  for (const u of list) {
    const k = `${u.name}|${u.eidolon}|${u.lc}|${u.superimp}`;
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(u);
  }
}
const tier = (u) => eidolonTierOf(u.eidolon);
const band = (u) => (tier(u) === 6 ? 'E6' : `E${tier(u)}`);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const q = (a, p) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
};
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');

console.log(`榜上整包 ${all.length} 条｜副本 ${envs.length} 个`);

// ---- ① 每关拿满分的比例 -----------------------------------------------------
console.log('\n=== ① 每一关的强度分布（0 行动值 → 100）===');
console.log('副本            权重 |   E0 满分率 |   E2 满分率 |   E6 满分率 | 全体中位');
for (const env of envs) {
  const w = Number(envWeightOf(env.mode, env.stage)) || 0;
  const cells = [];
  const allS = [];
  for (const b of ['E0', 'E2', 'E6']) {
    const list = all.filter((u) => band(u) === b)
      .map((u) => (u.envs || []).find((e) => e.id === env.id))
      .filter(Boolean)
      .map((e) => Number(e.envStrength) || 0);
    allS.push(...list);
    cells.push(list.length ? `${(list.filter((x) => Math.abs(x - 100) < 1e-6).length / list.length * 100).toFixed(0)}%（${list.length}）` : '—');
  }
  console.log(`${String(env.id).padEnd(16)}${String(w).padStart(2)} | ${cells.map((c) => c.padStart(10)).join(' | ')}`
    + ` | ${f1(q(allS, 0.5))}`);
}

// ---- ② 继承 ---------------------------------------------------------------
console.log('\n=== ② 继承（已登场却缺证据 → 借同角色更便宜整包的最高分）===');
let covUnits = 0;
let covSeasons = 0;
let droppedSeasons = 0;
for (const u of all) {
  const inh = Number(u.inheritedSeasons) || 0;
  if (inh > 0) covUnits += 1;
  covSeasons += inh;
  droppedSeasons += Number(u.droppedSeasons) || 0;
}
console.log(`  有继承的整包 ${covUnits} / ${all.length}（${(covUnits / all.length * 100).toFixed(0)}%）`
  + `｜继承的「整包×副本×版本」共 ${covSeasons} 个`);
console.log(`  仍算 0 分的「已登场却无证据」共 ${droppedSeasons} 个`);
console.log('  按档：');
for (const b of ['E0', 'E1', 'E2', 'E6']) {
  const list = all.filter((u) => band(u) === b);
  const withInh = list.filter((u) => (Number(u.inheritedSeasons) || 0) > 0);
  console.log(`    ${b}: ${String(withInh.length).padStart(3)} / ${String(list.length).padStart(3)} 条有继承`
    + `｜继承段合计 ${list.reduce((n, u) => n + (Number(u.inheritedSeasons) || 0), 0)}`
    + `｜仍算 0 的段 ${list.reduce((n, u) => n + (Number(u.droppedSeasons) || 0), 0)}`);
}

// ---- ③ 各档的强度分布 -----------------------------------------------------
console.log('\n=== ③ 各档强度（改前：E0 14.2 / E1 14.6 / E2 20.1 / E6 20.9）===');
console.log('档位 | 条数 | 均值 | 中位 | p75 | max | =100 的条数 | <10 分占比');
for (const b of ['E0', 'E1', 'E2', 'E6']) {
  const list = all.filter((u) => band(u) === b);
  if (!list.length) continue;
  const s = list.map((u) => Number(u.strengthScore) || 0);
  console.log(`${b.padEnd(4)} | ${String(list.length).padStart(4)} | ${f1(mean(s)).padStart(4)}`
    + ` | ${f1(q(s, 0.5)).padStart(4)} | ${f1(q(s, 0.75)).padStart(4)} | ${f1(q(s, 1)).padStart(5)}`
    + ` | ${String(s.filter((x) => x >= 99.99).length).padStart(10)}`
    + ` | ${(s.filter((x) => x < 10).length / s.length * 100).toFixed(0)}%`);
}

// ---- ④ top 12 -------------------------------------------------------------
console.log('\n=== ④ 强度 top 12 ===');
[...all].sort((a, b) => (Number(b.strengthScore) || 0) - (Number(a.strengthScore) || 0)).slice(0, 12)
  .forEach((u, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${band(u).padEnd(3)} ${cn(u.name).padEnd(14)}`
      + ` E${u.eidolon}S${u.superimp} 强度 ${f1(Number(u.strengthScore))}`
      + `（${(u.envs || []).filter((e) => e.weight > 0).map((e) => f1(Number(e.envStrength))).join(' / ')}）`);
  });

// ---- ⑤ 同角色 E0 vs E6 的变化 ---------------------------------------------
console.log('\n=== ⑤ 同角色 E0 与 E6（两者都在榜上）===');
const byChar = new Map();
for (const u of all) {
  if (!byChar.has(u.name)) byChar.set(u.name, []);
  byChar.get(u.name).push(u);
}
const pairs = [];
for (const [name, list] of byChar) {
  const e0 = list.filter((u) => tier(u) === 0);
  const e6 = list.filter((u) => tier(u) === 6);
  if (!e0.length || !e6.length) continue;
  const a = Math.max(...e0.map((u) => Number(u.strengthScore) || 0));
  const b = Math.max(...e6.map((u) => Number(u.strengthScore) || 0));
  pairs.push({ name, a, b, d: b - a });
}
pairs.sort((x, y) => x.d - y.d);
console.log(`  可比 ${pairs.length} 个｜E6 更低 ${pairs.filter((p) => p.d < -0.05).length}`
  + `｜持平 ${pairs.filter((p) => Math.abs(p.d) <= 0.05).length}`
  + `｜E6 更高 ${pairs.filter((p) => p.d > 0.05).length}`);
for (const p of pairs.slice(0, 4)) {
  console.log(`    ${cn(p.name).padEnd(12)} E0 ${f1(p.a)} → E6 ${f1(p.b)}（${p.d.toFixed(1)}）`);
}
