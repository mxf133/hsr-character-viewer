// 探针：抽卡方案里**高强度**的行，它们的来源（avSource）、绝境行动值、金数。
//   node tools/_probe-plan-strength-rows.mjs [--account=2] [--min=90] [--rows=40]
import { AccountStore } from '../src/server/store.js';
import {
  SCORING, buildConclusion, eidolonsOf, lightConeRanksOf, normalizeDrawWeights,
  ownedCharacters, teamPlan, VERSION_WINDOW,
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
const ACC = Math.max(1, Number(arg('account', '2')) || 2);
const MIN = Number(arg('min', '90')) || 90;
const ROWS = Math.max(1, Number(arg('rows', '40')) || 40);

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
const keep = SCORING.teamPlanMaxRows;
SCORING.teamPlanMaxRows = 100000;
let plan;
try {
  plan = teamPlan(conclusion, acct, { availability, drawWeights: { strength: 1, cost: 0, versatility: 0 } });
} finally { SCORING.teamPlanMaxRows = keep; }

const rows = [...plan.rows].sort((a, b) => b.strengthPct - a.strengthPct);
const hi = rows.filter((r) => Number(r.strengthPct) >= MIN);
console.log(`账号 ${ACC}：${role.nickname}｜池 ${plan.pool}（其中前沿池 ${plan.poolAv ?? '—'}）`
  + `｜强度 ≥ ${MIN} 的 ${hi.length} 条`);
console.log('强度   前沿池 最佳证据(副本/行动值/版本)          账面 补金  成员');
for (const r of hi.slice(0, ROWS)) {
  const b = r.best || {};
  console.log(`${Number(r.strengthPct).toFixed(2).padStart(6)} ${(r.avSource ? ' Y  ' : '  - ')}`
    + ` ${String(`${b.id ?? '—'}/${b.actionValue ?? '—'}/${b.evidenceSeason ?? '—'}`).padEnd(30)}`
    + ` ${String(r.gold).padStart(4)} ${String(r.gap).padStart(4)}  `
    + r.members.map((m) => `${cn(m.char)}E${m.eidolon}`).join('+'));
}
const bySource = new Map();
for (const r of hi) bySource.set(Boolean(r.avSource), (bySource.get(Boolean(r.avSource)) || 0) + 1);
console.log(`\n≥${MIN} 的构成：前沿池 ${bySource.get(true) || 0} 条、证据池 ${bySource.get(false) || 0} 条`);
