/**
 * 探针：**抽卡权重 = 强度 1 / 性价比 0 / 泛用性 0** 时，角色总榜前排的强度为什么不高。
 *
 * 只读、不改任何口径。逐条打印前排整包的：
 *   ① 强度分（= 排序键，权重只有强度时 characterScore 就等于它）
 *   ② strengthTotal（逐关卡两档 + 关卡权重加权平均，分母 = 全部 5 个副本的权重和 9）
 *   ③ 它有几个副本有数据、缺了哪几个（缺副本按 0 进分母）
 *   ④ 把分母换成「有数据的副本」的反事实（覆盖率修正后的上限）
 *
 * 用法：node tools/_probe-strength-front.mjs [--rows=20] [--weights=1,0,0]
 */
import {
  buildConclusion, SCORING, VERSION_WINDOW, normalizeDrawWeights, envWeightOf,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ROWS = Math.max(1, Number(arg('rows', '20')) || 20);
const [ws, wc, wv] = String(arg('weights', '1,0,0')).split(',').map(Number);

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
  drawWeights: { strength: ws, cost: wc, versatility: wv },
});

const units = conclusion.frontierUnits || [];
const allEnv = [...new Set(frontierAll.map((f) => f.env))];
const envW = (id) => {
  const [mode, stage] = String(id).split('/');
  return Number(envWeightOf(mode, stage || '', 'frontier')) || 0;
};
const totalW = allEnv.reduce((n, id) => n + envW(id), 0);
const w = normalizeDrawWeights({ strength: ws, cost: wc, versatility: wv });

console.log(`权重 ${ws}:${wc}:${wv} → ${w.strength.toFixed(3)} / ${w.cost.toFixed(3)} / ${w.versatility.toFixed(3)}`
  + `｜榜 ${units.length} 条｜副本权重和 ${totalW}（${allEnv.map((id) => `${id}=${envW(id)}`).join(' ')}）`);
console.log('名次 角色        档位    角色分   强度   性价比  泛用性  副本数  strengthTotal  覆盖率修正   缺的副本');
for (const [i, u] of units.slice(0, ROWS).entries()) {
  const have = new Set((u.envs || []).map((e) => e.id));
  const covered = [...have].reduce((n, id) => n + envW(id), 0);
  const adj = covered > 0 ? Number(u.strengthTotal) * totalW / covered : 0;
  const missing = allEnv.filter((id) => !have.has(id)).join(',') || '—';
  console.log(`#${String(i + 1).padStart(2)} ${cn(u.name).padEnd(10)} E${u.eidolon}${u.lc ? 'S' + u.superimp : '  '}`
    + ` ${Number(u.characterScore).toFixed(1).padStart(7)}`
    + ` ${Number(u.strengthScore).toFixed(1).padStart(6)}`
    + ` ${Number(u.costScore).toFixed(1).padStart(7)}`
    + ` ${Number(u.versatilityScore).toFixed(1).padStart(7)}`
    + ` ${String(have.size).padStart(5)}`
    + ` ${Number(u.strengthTotal).toFixed(2).padStart(13)}`
    + ` ${adj.toFixed(2).padStart(11)}   ${missing}`);
}

// 分布：前排到底被什么卡住
const dist = (fn) => {
  const v = units.map(fn).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
  return `p50 ${q(0.5).toFixed(1)} / p90 ${q(0.9).toFixed(1)} / max ${q(1).toFixed(1)}`;
};
console.log('\n强度分分布：', dist((u) => Number(u.strengthScore)));
console.log('strengthTotal 分布：', dist((u) => Number(u.strengthTotal)));
console.log(`强度 = 100 的条数：${units.filter((u) => Number(u.strengthScore) >= 99.99).length}`);
console.log(`强度 ≥ 90 的条数：${units.filter((u) => Number(u.strengthScore) >= 90).length}`);
const byCoverage = new Map();
for (const u of units) {
  const n = new Set((u.envs || []).map((e) => e.id)).size;
  (byCoverage.get(n) || byCoverage.set(n, []).get(n)).push(Number(u.strengthTotal));
}
console.log('\n按「有数据的副本数」分组的 strengthTotal 中位：');
for (const n of [...byCoverage.keys()].sort((a, b) => a - b)) {
  const v = byCoverage.get(n).sort((a, b) => a - b);
  console.log(`  ${n} 个副本：${String(v.length).padStart(3)} 条，中位 ${v[Math.floor((v.length - 1) / 2)].toFixed(2)}`);
}
console.log('\nSCORING 关键常量：', JSON.stringify({
  strengthSecondBandCap: SCORING.strengthSecondBandCap,
  strengthLineWeights: SCORING.strengthLineWeights,
  drawWeight: SCORING.drawWeight,
  versionWeights: (await import('../public/scripts/advice.js')).VERSION_WEIGHTS,
}));
