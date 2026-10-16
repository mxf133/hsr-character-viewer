// 扫描：哪些整包的强度分被「包络」抬起来（自己拿不到、全靠同角色低投入档兜底）。
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, eidolonTierOf, eidolonsOf, lightConeRanksOf,
  ownedCharacters, teamPoolUnits, VERSION_WINDOW,
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
const byChar = new Map();
for (const u of units) (byChar.get(u.name) || byChar.set(u.name, []).get(u.name)).push(u);
const rank = (u) => eidolonTierOf(u.eidolon) + ((u.lc && Number(availability.lightCones?.[u.lc]?.limited !== false)) ? u.superimp : 0);
let n = 0;
const rows = [];
for (const u of units) {
  const floor = Number(u.strengthFloor ?? 0);
  const own = Number(u.strengthTotal ?? 0);
  if (floor - own < 5) continue;
  const pe = (u.envs || []).find((e) => e.id === 'aa/plight');
  rows.push({ u, floor, own, av: pe?.avBest ?? null, es: Number(pe?.envStrength ?? 0) });
}
rows.sort((a, b) => (b.floor - b.own) - (a.floor - a.own));
console.log(`共 ${rows.length} 条整包的 strengthFloor 高于自身 strengthTotal 5 分以上（榜内 ${units.length} 条）`);
console.log('角色 档位    自身   兜底   绝境av  绝境强度  强度分');
for (const r of rows.slice(0, 25)) {
  console.log(`${cn(r.u.name).padEnd(8)} E${r.u.eidolon}${(r.u.lc?'S'+r.u.superimp:'   ')}`
    + ` ${r.own.toFixed(2).padStart(7)} ${r.floor.toFixed(2).padStart(7)}`
    + ` ${String(r.av ?? '—').padStart(7)} ${r.es.toFixed(1).padStart(9)} ${Number(r.u.strengthScore).toFixed(2).padStart(7)}`);
}
