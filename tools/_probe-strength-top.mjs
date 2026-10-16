// 列出强度分 ≥ 95 的整包，看它们的绝境行动值。
import { buildConclusion, eidolonTierOf, teamPoolUnits, VERSION_WINDOW } from '../public/scripts/advice.js';
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
const top = units.filter((u) => Number(u.strengthScore) >= 95)
  .sort((a, b) => Number(b.strengthScore) - Number(a.strengthScore));
console.log(`榜内 ${units.length} 条，强度 ≥95 有 ${top.length} 条（≥99.5 有 ${units.filter((u) => Number(u.strengthScore) >= 99.5).length} 条）`);
console.log('角色       档位     强度    自身    兜底   绝境av 绝境强度  满分线');
for (const u of top) {
  const pe = (u.envs || []).find((e) => e.id === 'aa/plight');
  console.log(`${cn(u.name).padEnd(10)} E${u.eidolon}${(u.lc ? 'S' + u.superimp : '  ')}`
    + ` ${Number(u.strengthScore).toFixed(2).padStart(7)} ${Number(u.strengthTotal).toFixed(2).padStart(7)}`
    + ` ${Number(u.strengthFloor ?? 0).toFixed(2).padStart(7)}`
    + ` ${String(pe?.avBest ?? '—').padStart(6)} ${Number(pe?.envStrength ?? 0).toFixed(1).padStart(8)}`
    + ` ${String(pe?.perfectLine ?? '—').padStart(6)}`);
}
