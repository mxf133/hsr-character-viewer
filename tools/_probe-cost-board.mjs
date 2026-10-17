import { buildConclusion, VERSION_WINDOW } from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
const index = await archiveIndex();
const i18n = await loadI18n();
const cn = (n) => zhName(i18n, 'characters', n) || n;
const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const fa = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const c = buildConclusion(envs, { availability: index.refs?.availability || {},
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  frontier: Object.fromEntries(fa.map((f) => [f.env, f])) });
console.log('总榜', c.frontierUnits.length, '条');
for (const [i, u] of c.frontierUnits.slice(0, 12).entries()) {
  console.log(`${String(i+1).padStart(2)} 得分${Number(u.characterScore).toFixed(1).padStart(5)} 强度${Number(u.strengthScore).toFixed(1).padStart(5)} 性价比${Number(u.costScore).toFixed(1).padStart(5)} 泛用性${Number(u.versatilityScore).toFixed(1).padStart(5)}  ${cn(u.name)} E${u.eidolon}S${u.superimp} ${u.gold}金`);
}
console.log('--- E6 页前 6 ---');
for (const u of (c.frontierTiers?.[6] || []).slice(0, 6)) {
  console.log(`得分${Number(u.characterScore).toFixed(1).padStart(5)} 强度${Number(u.strengthScore).toFixed(1).padStart(5)} 性价比${Number(u.costScore).toFixed(1).padStart(5)}  ${cn(u.name)} E${u.eidolon}S${u.superimp} ${u.gold}金`);
}
