// 探针：强度为什么没人到 100 —— 逐副本 envStrength 上限 + 整包 top N 的分解。
//
//   node tools/_probe-strength-ceiling.mjs
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

console.log(`整包 ${all.length} 条\n`);
console.log('各副本 envStrength 的最大值（跨全部整包）：');
const byEnv = new Map();
for (const u of all) {
  for (const e of (u.envs || [])) {
    const v = Number(e.envStrength) || 0;
    const cur = byEnv.get(e.envLabel);
    if (!cur || cur.v < v) byEnv.set(e.envLabel, { v, u, e });
  }
}
for (const [label, { v, u, e }] of byEnv) {
  console.log(`  ${label}：${v.toFixed(2)}｜${cn(u.name)} E${u.eidolon} · ${u.lc || '无锥'}S${u.superimp}`
    + `｜行动值 ${e.avBest}｜${e.strengthGold ?? '?'} 金｜权重 ${e.weight}`);
}

console.log('\n整包强度得分 top 8（含逐副本拆解）：');
const top = [...all].sort((a, b) => (Number(b.strengthScore) || 0) - (Number(a.strengthScore) || 0)).slice(0, 8);
for (const u of top) {
  console.log(`  ${cn(u.name)} E${u.eidolon} · ${u.lc || '无锥'}S${u.superimp}`
    + `｜得分 ${(Number(u.strengthScore) || 0).toFixed(1)}｜原始量 ${(Number(u.strengthTotal) || 0).toFixed(2)}`);
  console.log('    ' + u.envs.map((e) => `${e.envLabel.slice(0, 8)} ${(Number(e.envStrength) || 0).toFixed(1)}`).join(' / '));
}

// 逐副本里「有 0 行动值」的整包，看看它们的 envStrength 是 100 还是被折算
console.log('\n行动值 = 0 的 env 条目（顶格档）样本：');
const zeroItems = [];
for (const u of all) {
  for (const e of (u.envs || [])) {
    if (Number(e.avBest) === 0) zeroItems.push({ u, e });
  }
}
console.log(`  共 ${zeroItems.length} 条；envStrength 分布：`
  + `最高 ${Math.max(...zeroItems.map((x) => Number(x.e.envStrength) || 0)).toFixed(2)}`
  + `｜最低 ${Math.min(...zeroItems.map((x) => Number(x.e.envStrength) || 0)).toFixed(2)}`);
const full = zeroItems.filter((x) => Number(x.e.envStrength) >= 99.99);
console.log(`  其中 envStrength ≈ 100 的 ${full.length} 条`);
for (const { u, e } of zeroItems.slice(0, 6)) {
  console.log(`    ${e.envLabel.slice(0, 10)}｜${cn(u.name)} E${u.eidolon}｜行动值 0｜${e.strengthGold} 金`
    + `｜envStrength ${(Number(e.envStrength) || 0).toFixed(2)}`);
}
