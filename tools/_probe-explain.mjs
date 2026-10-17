// 一次性探针：把某一个整包在绝境王棋关的三个分项因子逐项打出来，
// 用来给「原始量怎么算」「跨版本发挥为什么能 > 1」配真实数字。
//
//   node tools/_probe-explain.mjs [角色中文名] [E档]
import {
  buildConclusion, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const wantCn = process.argv[2] || '缇宝';
const wantE = Number(process.argv[3] || 6);

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const cn = (n) => zhName(i18n, 'characters', n) || n;
const enOf = (c) => {
  for (const ch of index.refs?.characters || []) if (zhName(i18n, 'characters', ch.name) === c) return ch.name;
  return null;
};
const char = enOf(wantCn);
const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const conclusion = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});

// 绝境王棋关那一支环境
const env = envs.find((e) => e.mode === 'aa' && e.stage === 'plight') || null;
console.log(`目标：${wantCn} E${wantE}｜绝境王棋关判据线 ${JSON.stringify(env?.tierLines)}`
  + `｜lowerIsBetter=${env?.lowerIsBetter !== false}`);
console.log(`该副本 zeroAvGoldBySeason = ${JSON.stringify(env?.zeroAvGoldBySeason || null)}`);

const tierFlat = Object.values(conclusion.frontierTiers || {}).flat();
const rows = tierFlat.filter((u) => u.name === char && Number(u.eidolon) === wantE);
if (!rows.length) {
  console.log('没找到这个整包；候选：'
    + [...new Set(tierFlat.filter((u) => u.name === char).map((u) => `E${u.eidolon} ${u.lc}S${u.superimp}`))].join(' / '));
  process.exit(0);
}
const unit = rows[0];
console.log(`\n整包：${cn(unit.name)} E${unit.eidolon} · ${cn(unit.lc)} S${unit.superimp}｜账面 ${unit.gold} 金`);
console.log(`三个原始量：性价比 total=${unit.total}｜强度 strengthTotal=${unit.strengthTotal}`
  + `｜泛用性 versatilityPerTier=${unit.versatilityPerTier}（组内 raw=${unit.versatilityRaw}）`);

console.log('\n逐副本明细：');
let sw = 0; let sa = 0; let sc = 0; let sv = 0;
for (const e of unit.envs || []) {
  console.log(`  ${e.envLabel}｜权重 ${e.weight}｜行动值 ${e.avBest}｜强度 ${e.envStrength}`
    + `｜性价比 ${e.score}｜泛用性 ${e.envVersatility}｜最佳证据 ${e.strengthSeason} 版 ${e.strengthGold} 金`);
  sw += Number(e.weight) || 0;
  sa += (Number(e.weight) || 0) * (Number(e.envStrength) || 0);
  sc += (Number(e.weight) || 0) * (Number(e.score) || 0);
  sv += (Number(e.weight) || 0) * (Number(e.envVersatility) || 0);
}
console.log(`  全部副本权重和 = ${sw}`);
// ⚠️ 三个分项的合成方式**不一样**，别写错：
//   强度 / 泛用性 = Σ(权重 × 值) / Σ权重     （加权**平均**）
//   性价比      = Σ(权重 × 值)              （加权**和**，不除 —— 所以量纲是几百~上千）
console.log(`  复核：强度原始量 = ${(sa / sw).toFixed(4)}｜性价比原始量 = ${sc.toFixed(4)}（加权和，不除）`
  + `｜泛用性本档原始量 = ${(sv / sw).toFixed(4)}`);
