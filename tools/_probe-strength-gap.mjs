/**
 * 探针：只考虑强度时，前排被「90 分天花板 / 缺副本按 0 / 版本权重」各压掉多少。
 * 只读、不改口径。
 *   node tools/_probe-strength-gap.mjs [--rows=10]
 */
import {
  buildConclusion, SCORING, VERSION_WINDOW, envWeightOf,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const ROWS = Math.max(1, Number(arg('rows', '10')) || 10);

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const cn = (n) => zhName(i18n, 'characters', n) || n;

const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const fa = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const conclusion = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  frontier: Object.fromEntries(fa.map((f) => [f.env, f])),
  drawWeights: { strength: 1, cost: 0, versatility: 0 },
});

const units = conclusion.frontierUnits || [];
const allEnv = [...new Set(fa.map((f) => f.env))];
const envW = (id) => {
  const [mode, stage] = String(id).split('/');
  return Number(envWeightOf(mode, stage || '', 'frontier')) || 0;
};
const totalW = allEnv.reduce((n, id) => n + envW(id), 0);

for (const u of units.slice(0, 3)) {
  console.log(`\n=== ${cn(u.name)} E${u.eidolon}${u.lc ? 'S' + u.superimp : ''}｜强度 ${Number(u.strengthScore).toFixed(2)}`
    + `（raw ${Number(u.strengthTotal).toFixed(2)}）｜性价比 ${Number(u.costScore).toFixed(1)} ===`);
  for (const e of u.envs) {
    console.log(`  ${String(e.envLabel || e.id).padEnd(16)} 权重${String(e.weight).padStart(2)}`
      + ` 行动值 ${String(e.avBest ?? '—').padStart(5)}`
      + ` 本关强度 ${Number(e.envStrength).toFixed(1).padStart(5)}`
      + ` 版本 ${String(e.strengthSeason ?? '—').padStart(5)}`
      + ` 缺证据版本 dropped=${e.droppedSeasons ?? 0} 继承=${e.inheritedSeasons ?? 0}`
      + ` 未登场=${e.absentSeasons ?? 0}`
      + ` 满分线 ${e.perfectLine ?? '—'}`);
  }
}

// 反事实：把分母换成「有数据的副本」
const adj = (u) => {
  const covered = (u.envs || []).reduce((n, e) => n + envW(e.id), 0);
  return covered > 0 ? Number(u.strengthTotal) * totalW / covered : 0;
};
const rawTop = [...units].sort((a, b) => Number(b.strengthTotal) - Number(a.strengthTotal)).slice(0, ROWS);
console.log(`\n按「原始 strengthTotal（不夹 90）」重排的前 ${ROWS}：`);
for (const [i, u] of rawTop.entries()) {
  console.log(`#${String(i + 1).padStart(2)} ${cn(u.name).padEnd(10)} E${u.eidolon}`
    + ` raw ${Number(u.strengthTotal).toFixed(2).padStart(6)}`
    + ` 榜面 ${Number(u.strengthScore).toFixed(2).padStart(6)}`
    + ` 有数据副本 ${new Set((u.envs || []).map((e) => e.id)).size}/5`
    + ` 覆盖率修正 ${adj(u).toFixed(2).padStart(6)}`);
}

const capLoss = units.filter((u) => Number(u.strengthTotal) - Number(u.strengthScore) > 0.01);
console.log(`\n被 90 天花板夹掉分的条数：${capLoss.length} / ${units.length}`);
console.log(`其中夹掉 >3 分：${capLoss.filter((u) => Number(u.strengthTotal) - Number(u.strengthScore) > 3).length}`);
console.log('被夹最多的 5 条：', capLoss
  .sort((a, b) => (b.strengthTotal - b.strengthScore) - (a.strengthTotal - a.strengthScore))
  .slice(0, 5)
  .map((u) => `${cn(u.name)} ${Number(u.strengthTotal).toFixed(1)}→${Number(u.strengthScore).toFixed(1)}`)
  .join('；'));
const only4 = units.filter((u) => new Set((u.envs || []).map((e) => e.id)).size < 5);
console.log(`\n副本覆盖 < 5 的条数：${only4.length} / ${units.length}`
  + `（它们的 raw 中位 ${only4.map((u) => u.strengthTotal).sort((a, b) => a - b)[Math.floor((only4.length - 1) / 2)]?.toFixed(2) ?? '—'}）`);
console.log(`若把分母改成「有数据的副本」，这 ${only4.length} 条的中位从 `
  + `${(() => { const v = only4.map((u) => Number(u.strengthTotal)).sort((a, b) => a - b); return v[Math.floor((v.length - 1) / 2)]?.toFixed(2); })()}`
  + ` → ${(() => { const v = only4.map(adj).sort((a, b) => a - b); return v[Math.floor((v.length - 1) / 2)]?.toFixed(2); })()}`);
console.log('SCORING.strengthSecondBandCap =', SCORING.strengthSecondBandCap);
