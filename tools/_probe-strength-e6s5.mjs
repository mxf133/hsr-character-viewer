// 探针：E6S5 的强度得分为什么偏低 —— 按「星魂档 × 叠影档 × 覆盖副本数」拆开看。
//
//   node tools/_probe-strength-e6s5.mjs
import {
  buildConclusion, VERSION_WINDOW,
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
const units = [];
for (const l of Object.values(c.frontierTiers || {})) units.push(...l);
const seen = new Set(); const all = [];
for (const u of units) {
  const k = `${u.name}|${u.eidolon}|${u.lc}|${u.superimp}`;
  if (seen.has(k)) continue;
  seen.add(k); all.push(u);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const band = (u) => {
  const e = Number(u.eidolon) || 0;
  const s = Number(u.superimp) || 1;
  return `${e === 6 ? 'E6' : e >= 3 ? 'E3-5' : `E${e}`}S${s >= 5 ? 5 : s}`;
};

console.log(`整包 ${all.length} 条｜强度得分最高 ${Math.max(...all.map((u) => Number(u.strengthScore) || 0)).toFixed(1)}`);
console.log('\n按「星魂档·叠影档」分组（只看样本 ≥3 的）：');
const groups = new Map();
for (const u of all) {
  const k = band(u);
  const list = groups.get(k) || [];
  list.push(u);
  groups.set(k, list);
}
const rows = [...groups.entries()]
  .filter(([, l]) => l.length >= 3)
  .map(([k, l]) => ({
    k, n: l.length,
    str: mean(l.map((u) => Number(u.strengthScore) || 0)),
    envCount: mean(l.map((u) => (u.envs || []).length)),
    gold: mean(l.map((u) => Number(u.gold) || 0)),
  }))
  .sort((a, b) => b.str - a.str);
console.log('档位    | 条数 | 平均强度 | 平均覆盖副本数 | 平均整包金');
for (const r of rows) {
  console.log(`${r.k.padEnd(7)} | ${String(r.n).padStart(4)} | ${r.str.toFixed(1).padStart(8)}`
    + ` | ${r.envCount.toFixed(2).padStart(14)} | ${r.gold.toFixed(1).padStart(10)}`);
}

console.log('\n按「覆盖副本数」分组：');
const byCover = new Map();
for (const u of all) {
  const n = (u.envs || []).length;
  const list = byCover.get(n) || [];
  list.push(u);
  byCover.set(n, list);
}
for (const n of [...byCover.keys()].sort()) {
  const l = byCover.get(n);
  console.log(`  ${n} 个副本：${String(l.length).padStart(4)} 条｜平均强度 ${mean(l.map((u) => Number(u.strengthScore) || 0)).toFixed(1).padStart(5)}`
    + `｜平均原始量 ${mean(l.map((u) => Number(u.strengthTotal) || 0)).toFixed(1).padStart(5)}`);
}

// E6S5 的明细
const e6s5 = all.filter((u) => Number(u.eidolon) === 6 && Number(u.superimp) >= 5);
console.log(`\nE6S5 整包 ${e6s5.length} 条，按强度得分排序 top 8：`);
for (const u of [...e6s5].sort((a, b) => (Number(b.strengthScore) || 0) - (Number(a.strengthScore) || 0)).slice(0, 8)) {
  console.log(`  ${cn(u.name).padEnd(12)} ${(u.lc || '无锥').slice(0, 20).padEnd(20)}`
    + `｜得分 ${(Number(u.strengthScore) || 0).toFixed(1).padStart(5)}｜覆盖 ${u.envs.length} 副本`
    + `｜逐副本 ${u.envs.map((e) => `${e.envLabel.slice(0, 4)}:${(Number(e.envStrength) || 0).toFixed(0)}`).join(' ')}`);
}
