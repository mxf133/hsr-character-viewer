// 探针（2026-10-16）：查「强度 100 的队伍，绝境行动值却没到 0」的成因。
//
//   node tools/_probe-strength100-detail.mjs --account=1 [--rows=8] [--char=绯英]
//
// 逐条打印：代表整包（total 最高的那条成员整包）、它的 strengthFloor / strengthTotal、
// 五个副本的 { 权重, avBest, 证据版本, envStrength, envStrengthBest, isPerfect }，
// 以及**给它兜底的那些同角色低投入整包**（包络的两个来源）。
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
const ROWS = Math.max(1, Number(arg('rows', '8')) || 8);
const ACC = Math.max(1, Number(arg('account', '1')) || 1);
const ONLY = arg('char', null);

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
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});

const packKey = (name, eidolon, lc, superimp) => `${name}|E${eidolonTierOf(eidolon)}`
  + `|${lc || '-'}|S${Math.max(1, Math.round(Number(superimp) || 1))}`;
const units = teamPoolUnits(conclusion);
const byKey = new Map();
const byChar = new Map();
for (const unit of units) {
  byKey.set(packKey(unit.name, unit.eidolon, unit.lc, unit.superimp), unit);
  (byChar.get(unit.name) || byChar.set(unit.name, []).get(unit.name)).push(unit);
}

const showUnit = (u, title) => {
  console.log(`${title} ${u.name} E${u.eidolon} ${u.lc || '（无光锥）'}S${u.superimp}`
    + `｜strengthScore ${Number(u.strengthScore).toFixed(2)}`
    + `｜strengthFloor ${Number(u.strengthFloor ?? NaN).toFixed(2)}`
    + `｜strengthTotal ${Number(u.strengthTotal).toFixed(2)}`
    + `｜total ${Number(u.total).toFixed(2)}｜gold ${u.gold}`);
  for (const e of u.envs || []) {
    console.log(`      · ${String(e.envLabel || e.id).padEnd(16)} w=${e.weight}`
      + ` av=${e.avBest ?? '—'} 版本=${e.strengthSeason ?? '—'}`
      + ` envStrength=${Number(e.envStrength).toFixed(2)}`
      + ` best=${Number(e.envStrengthBest).toFixed(2)}`
      + ` 满分档=${e.isPerfect ? 'Y' : 'N'} 满分线=${e.perfectLine ?? '—'}`);
  }
};

const keepRows = SCORING.teamPlanMaxRows;
SCORING.teamPlanMaxRows = 100000;
let plan;
try {
  plan = teamPlan(conclusion, acct, { availability, drawWeights: normalizeDrawWeights({}) });
} finally {
  SCORING.teamPlanMaxRows = keepRows;
}

const rows = [...plan.rows].sort((a, b) => b.strengthPct - a.strengthPct);
console.log(`账号 ${ACC}：${role.nickname}｜池 ${plan.pool} 支`);
console.log('');

const wanted = ONLY ? rows.filter((r) => r.members.some((m) => cn(m.char) === ONLY)) : rows.slice(0, ROWS);
for (const [i, row] of wanted.slice(0, ROWS).entries()) {
  const members = row.members.map((m) => `${cn(m.char)}E${m.eidolon}`
    + (m.lc ? `/${cn(m.lc)}S${m.superimp}` : '')).join(' + ');
  console.log(`#${i + 1} 强度 ${Number(row.strengthPct).toFixed(2)}｜gap ${Number(row.gapPct).toFixed(2)}`
    + `｜泛用性 ${Number(row.versatilityPct).toFixed(2)}｜队分 ${Number(row.teamScore).toFixed(2)}`);
  console.log(`     ${members}`);
  // 代表整包：与 teamPlan 同一条规则（total 最高的那条成员整包）。
  let rep = null;
  for (const m of row.members) {
    const u = byKey.get(packKey(m.char, m.eidolon, m.lc, m.superimp));
    if (u && (!rep || Number(u.total) > Number(rep.total))) rep = u;
  }
  if (rep) {
    // 复刻 teamPlan 的 byRoster 分组，看 ① 到底取自哪一条整包。
    const rosterKeyOf = (ms) => ms
      .map((m) => packKey(m.char, m.eidolon, m.lc, m.superimp)).sort().join('~');
    const claimants = [];
    for (const u of units) {
      const best = (u.envs || []).find((env) => (env.members || []).length) || null;
      const ms = best?.members || [];
      if (!ms.length) continue;
      if (rosterKeyOf(ms) !== row.key) continue;
      claimants.push(u);
    }
    console.log('    同一 roster 的整包（total / strengthScore）：');
    for (const u of claimants.sort((a, b) => Number(b.total) - Number(a.total))) {
      console.log(`      - ${u.name} E${u.eidolon} ${u.lc || '-'}S${u.superimp}`
        + ` total=${Number(u.total).toFixed(2)} strength=${Number(u.strengthScore).toFixed(2)}`);
    }
    for (const u of claimants) {
      showUnit(u, '    ⚑ 实际代表整包:');
      const peers = (byChar.get(u.name) || []).filter((o) => o !== u
        && eidolonTierOf(o.eidolon) <= eidolonTierOf(u.eidolon));
      console.log(`      （同角色共 ${(byChar.get(u.name) || []).length} 条整包，其中投入 ≤ 本条的 ${peers.length} 条）`);
    }
    showUnit(rep, '    代表整包:');
    const mates = (byChar.get(rep.name) || []).filter((o) => o !== rep
      && eidolonTierOf(o.eidolon) <= eidolonTierOf(rep.eidolon));
    const best = [...mates].sort((a, b) => Number(b.strengthTotal) - Number(a.strengthTotal))[0];
    if (best) showUnit(best, '    兜底来源（同角色最高骨干）:');
    // 全队五个成员的强度分，看是不是「借」来的
    const allM = row.members.map((m) => {
      const u = byKey.get(packKey(m.char, m.eidolon, m.lc, m.superimp));
      return `${cn(m.char)}E${m.eidolon}=${u ? Number(u.strengthScore).toFixed(1) : 'MISS'}`
        + `(t=${u ? Number(u.total).toFixed(1) : '-'})`;
    });
    console.log(`    成员强度分: ${allM.join('  ')}`);
  }
  console.log('');
}
