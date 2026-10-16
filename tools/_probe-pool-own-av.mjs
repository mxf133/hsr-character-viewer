// 候选池里那 239 支队伍，**它们自己**的绝境行动值是多少（不是代表整包的证据行）。
// 用来判断：0 行动值队伍到底是不是「已经在池里、只是分数没用它们自己的成绩」。
import { buildConclusion, SCORING, eidolonTierOf, teamPoolUnits, VERSION_WINDOW } from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
const index = await archiveIndex();
const i18n = await loadI18n();
const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const all = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const cn = (n) => zhName(i18n, 'characters', n) || n;
const conclusion = buildConclusion(envs, {
  availability: index.refs?.availability || {},
  firstSeen: index.refs?.firstSeen || {},
  frontier: Object.fromEntries(all.map((f) => [f.env, f])),
});
const units = teamPoolUnits(conclusion);
const packKey = (c, e, lc, s) => `${c}|E${eidolonTierOf(e)}|${lc || '-'}|S${Math.max(1, Math.round(Number(s) || 1))}`;
const rosterKeyOf = (ms) => ms.map((m) => packKey(m.char, m.eidolon, m.lc, m.superimp)).sort().join('~');
// 池里的队伍（= 每个整包证据行的 roster）
const poolRosters = new Map();
for (const u of units) {
  const best = (u.envs || []).find((env) => (env.members || []).length) || null;
  if (!best) continue;
  const key = rosterKeyOf(best.members);
  if (!poolRosters.has(key)) poolRosters.set(key, { members: best.members, rep: u });
}
// 每个环境里「roster → 自己的最好 av」
const byEnv = new Map();
for (const f of all) {
  const m = new Map();
  for (const r of f.frontierRows || []) {
    const key = rosterKeyOf(r.members || []);
    if (!key) continue;
    const av = Number(r.actionValue);
    const cur = m.get(key);
    if (!Number.isFinite(av)) continue;
    if (!cur || av < cur.av) m.set(key, { av, cost: Number(r.cost) || 0, season: r.season, w: Number(r.w) || 0 });
  }
  byEnv.set(f.env, m);
}
const zero = [];
const rows = [];
for (const [key, info] of poolRosters) {
  const perEnv = {};
  let best = null;
  for (const [envId, m] of byEnv) {
    const hit = m.get(key);
    if (!hit) continue;
    perEnv[envId] = hit.av;
    if (!best || hit.av < best.av) best = { av: hit.av, env: envId, ...hit };
  }
  rows.push({ key, info, perEnv, best });
  if (perEnv['aa/plight'] === 0) zero.push({ key, info, perEnv });
}
console.log(`池里 ${poolRosters.size} 支队伍；其中**自己**在绝境打出 0 行动值的有 ${zero.length} 支`);
console.log('\n【自己在绝境 0 行动值的池内队伍】');
for (const z of zero.slice(0, 12)) {
  console.log(`  代表整包 ${cn(z.info.rep.name)}E${z.info.rep.eidolon}｜队伍 ${z.info.members.map((m) => cn(m.char) + 'E' + m.eidolon).join('/')}`);
  console.log(`      各关卡自己的 av: ${JSON.stringify(z.perEnv)}`);
}
const avs = rows.filter((r) => r.perEnv['aa/plight'] !== undefined).map((r) => r.perEnv['aa/plight']).sort((a, b) => a - b);
console.log(`\n池内队伍在绝境的 av 分布（有数据的 ${avs.length} 支）：min ${avs[0]} / p25 ${avs[Math.floor(avs.length * 0.25)]} / p50 ${avs[Math.floor(avs.length * 0.5)]} / max ${avs[avs.length - 1]}`);
console.log('最低的 8 支自己的绝境 av:', avs.slice(0, 8).join(', '));
