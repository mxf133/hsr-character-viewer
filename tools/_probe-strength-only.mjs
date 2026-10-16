// 探针：**只考虑强度**（抽卡权重 = 强度 1 / 其余 0）时，抽卡方案的前排是谁，
// 以及它们的绝境行动值 / 金数。用于核对「29金0行动值 > 48金0行动值 > 非0行动值」。
//   node tools/_probe-strength-only.mjs [--account=1] [--rows=12]
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, SCORING, eidolonTierOf, eidolonsOf, lightConeRanksOf, normalizeDrawWeights,
  ownedCharacters, teamPlan, teamPoolUnits, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (name, dflt) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return dflt;
};
const ROWS = Math.max(1, Number(arg('rows', '12')) || 12);
const ACC = Math.max(1, Number(arg('account', '1')) || 1);

const index = await archiveIndex();
const i18n = await loadI18n();
const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const account = accounts[ACC - 1];
const role = (account?.roles || [])[0];
const snapshot = await store.getSnapshot(account.id, role.uid);
const zhToEn = {}; const allNames = [];
for (const c of index.refs?.characters || []) {
  if (c.nameCn && c.name) zhToEn[c.nameCn] = c.name;
  if (c.nameCn) allNames.push(c.nameCn);
}
const coneZhToEn = {};
for (const c of index.refs?.lightCones || []) if (c.nameCn && c.name) coneZhToEn[c.nameCn] = c.name;
const acct = {
  owned: ownedCharacters(snapshot, zhToEn, allNames),
  eidolons: eidolonsOf(snapshot, zhToEn),
  cones: lightConeRanksOf(snapshot, coneZhToEn),
};
const availability = index.refs?.availability || {};
const cn = (n) => zhName(i18n, 'characters', n) || zhName(i18n, 'lightCones', n) || n;
const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const conclusion = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || {},
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});
const keep = SCORING.teamPlanMaxRows; SCORING.teamPlanMaxRows = 100000;
let plan; let planAll;
try {
  plan = teamPlan(conclusion, acct, { availability, drawWeights: { strength: 1, cost: 0, versatility: 0 } });
  planAll = teamPlan(conclusion, acct, { availability, drawWeights: normalizeDrawWeights({}) });
} finally { SCORING.teamPlanMaxRows = keep; }
const byKey = new Map();
for (const u of teamPoolUnits(conclusion)) {
  byKey.set(`${u.name}|E${eidolonTierOf(u.eidolon)}|${u.lc || '-'}|S${Math.max(1, Math.round(Number(u.superimp) || 1))}`, u);
}
const packKey = (c, e, lc, s) => `${c}|E${eidolonTierOf(e)}|${lc || '-'}|S${Math.max(1, Math.round(Number(s) || 1))}`;
const repOf = (row) => {
  let rep = null;
  for (const m of row.members) {
    const u = byKey.get(packKey(m.char, m.eidolon, m.lc, m.superimp));
    if (u && (!rep || Number(u.total) > Number(rep.total))) rep = u;
  }
  return rep;
};
console.log(`账号 ${ACC}：${role.nickname}｜池 ${plan.pool} 支（强度权重 1 / 其余 0）`);
console.log('名次  强度分  补金  账面  代表整包          绝境(证据av / 该关强度)     其余关卡 av');
for (const [i, row] of [...plan.rows].sort((a, b) => b.strengthPct - a.strengthPct).slice(0, ROWS).entries()) {
  const rep = repOf(row);
  const pe = (rep?.envs || []).find((e) => e.id === 'aa/plight');
  const others = (rep?.envs || []).filter((e) => e.id !== 'aa/plight')
    .map((e) => `${e.envLabel || e.id}:${e.actionValue}`).join(' ');
  console.log(`#${String(i + 1).padStart(2)}  ${Number(row.strengthPct).toFixed(2).padStart(6)}`
    + `  ${String(row.gap).padStart(4)}  ${String(row.gold).padStart(4)}`
    + `  ${(rep ? `${cn(rep.name)}E${rep.eidolon}${rep.lc ? 'S' + rep.superimp : ''}` : '—').padEnd(18)}`
    + ` ${pe ? `${pe.actionValue} / ${Number(pe.envStrength).toFixed(1)}` : '（无绝境）'}`.padEnd(12)
    + `  ${others}`);
}
console.log('\n（对照）默认三等权的前 5：');
for (const [i, row] of planAll.rows.slice(0, 5).entries()) {
  console.log(`#${i + 1} 补金推荐分 ${Number(row.total).toFixed(1)}｜强度 ${Number(row.strengthPct).toFixed(1)}`
    + `｜补金 ${row.gap}｜账面 ${row.gold}`);
}
