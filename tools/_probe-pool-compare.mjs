// B（每档 245 支）与 C（全量 1869 支）的**并排比较**，顺带把 A（现状 78 支）当基准。
//
// 同一套两个指标、同一套刻度规则；三池只在「池」上不同，所以：
//   ⚠️ ① 刻度与 ② 封顶都不同 ⇒ **总分不能跨池比**，能比的是**各自池内的名次**。
//
//   node tools/_probe-pool-compare.mjs --account=1
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, eidolonsOf, lightConeRanksOf, marginalCostOf, ownedCharacters,
  SCORING, teamPlan, VERSION_WINDOW,
} from '../src/core/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ACC = Math.max(1, Number(arg('account', '1')) || 1);

const index = await archiveIndex();
const i18n = await loadI18n();
const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const account = accounts[ACC - 1];
const role = (account.roles || [])[0];
const snap = await store.getSnapshot(account.id, role.uid);
const zh = {}; const all = [];
for (const c of index.refs?.characters || []) {
  if (c.nameCn && c.name) zh[c.nameCn] = c.name;
  if (c.nameCn) all.push(c.nameCn);
}
const cz = {};
for (const c of index.refs?.lightCones || []) if (c.nameCn && c.name) cz[c.nameCn] = c.name;
const acct = {
  owned: ownedCharacters(snap, zh, all),
  eidolons: eidolonsOf(snap, zh),
  cones: lightConeRanksOf(snap, cz),
};
const availability = index.refs?.availability || {};
const { envs } = await conclusionEnvs(index);
const cn = (n) => zhName(i18n, 'characters', n) || zhName(i18n, 'lightCones', n) || n;
const nameOf = (ms) => ms.map((m) => cn(m.char)).join('/');

const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const concl = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});

const rosterKeyOf = (members) => members
  .map((m) => `${m.char}|E${Math.max(0, Math.min(6, Math.round(Number(m.eidolon) || 0)))}|`
    + `${m.lc || '-'}|S${Math.max(1, Math.round(Number(m.superimp) || 1))}`)
  .sort().join('~');

const teamsOf = (units) => {
  const by = new Map();
  for (const u of units) {
    const best = (u.envs || []).find((e) => (e.members || []).length);
    if (!best?.members?.length) continue;
    const key = rosterKeyOf(best.members);
    const total = Number(u.total) || 0;
    if (!by.has(key) || total > by.get(key).total) by.set(key, { key, members: best.members, total });
  }
  return [...by.values()];
};

const scoreTeams = (teams) => {
  const rows = [];
  let zeroGap = 0;
  for (const t of teams) {
    const gap = Math.max(0, Number(marginalCostOf(t.members, availability, acct).pulls) || 0);
    if (gap <= 0) { zeroGap += 1; continue; }
    rows.push({ ...t, gap });
  }
  if (!rows.length) return { rows: [], lo: 0, hi: 0, cap: 0, zeroGap };
  const lo = Math.min(...rows.map((r) => r.total));
  const hi = Math.max(...rows.map((r) => r.total));
  const gaps = rows.map((r) => r.gap).sort((a, b) => a - b);
  const cap = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * SCORING.teamPlanGapCapPct))];
  for (const r of rows) {
    r.scorePct = hi - lo < 1e-9 ? 100 : 100 * (r.total - lo) / (hi - lo);
    r.gapPct = Math.max(0, Math.min(100, 100 * (1 - r.gap / cap)));
    r.total_score = 0.5 * r.scorePct + 0.5 * r.gapPct;
  }
  return { rows: rows.sort((a, b) => b.total_score - a.total_score), lo, hi, cap, zeroGap };
};

const keepRows = SCORING.teamPlanMaxRows;
SCORING.teamPlanMaxRows = 100000;
const nowPlan = teamPlan(concl, acct, { availability });
SCORING.teamPlanMaxRows = keepRows;

const POOLS = [
  ['A 现在（每角色最强整包）', teamsOf(concl.frontierUnits),
    { rows: nowPlan.rows.map((r) => ({ ...r, total_score: r.total })),
      lo: nowPlan.scoreLo, hi: nowPlan.scoreHi, cap: nowPlan.gapMax, zeroGap: null }],
  ['B 每档（每角色 × 每星魂档）', teamsOf(Object.values(concl.frontierTiers || {}).flat()), null],
  ['C 全量（收敛前全部整包）', teamsOf(Object.values(concl.frontierPacksByChar || {}).flat()), null],
];

console.log(`${'='.repeat(100)}`);
console.log(`账号 ${ACC} ${role.nickname}｜默认总榜权重｜隐金不减｜全部候选都会算分`);
console.log(`${'='.repeat(100)}`);
const built = POOLS.map(([label, teams, preset]) => ({ label, ...(preset || scoreTeams(teams)) }));
for (const b of built) {
  const zero = b.rows.filter((x) => x.gapPct === 0).length;
  console.log(`${b.label.padEnd(30)} 队伍 ${String(b.rows.length).padStart(4)} 支`
    + `｜① 刻度 ${b.lo.toFixed(1)}~${b.hi.toFixed(1)}`
    + `｜② 封顶 ${String(b.cap).padStart(2)} 金`
    + `｜② 归 0 的 ${String(zero).padStart(4)} 支（${(zero / b.rows.length * 100).toFixed(0)}%）`);
}

const rankOf = (b, key) => {
  const i = b.rows.findIndex((r) => r.key === key);
  return i < 0 ? null : i + 1;
};
const pad = (v) => (v === null ? '  —' : `#${String(v).padStart(3)}`);

// ---- B 与 C 的前 15（并排）---------------------------------------------------
console.log(`\n${'='.repeat(100)}\nB（每档 ${built[1].rows.length} 支）与 C（全量 ${built[2].rows.length} 支）完整前 15\n${'='.repeat(100)}`);
console.log(`${'B 每档'.padEnd(52)}│ ${'C 全量'}`);
for (let i = 0; i < 15; i += 1) {
  const b = built[1].rows[i]; const c = built[2].rows[i];
  const cell = (r) => (r ? `#${String(i + 1).padStart(2)} ${r.total_score.toFixed(1).padStart(5)}`
    + ` = ①${r.scorePct.toFixed(0).padStart(3)} + ②${r.gapPct.toFixed(0).padStart(3)}`
    + `｜补${String(r.gap).padStart(2)}金｜${nameOf(r.members).slice(0, 17)}` : '（无）');
  console.log(`${cell(b).padEnd(52)}│ ${cell(c)}`);
}

// ---- C 的前 15 在三个池里各排第几 --------------------------------------------
console.log(`\n${'='.repeat(100)}\nC 的前 15 名，在 A / B / C 里各排第几（看「池一放宽，谁上来、谁下去」）\n${'='.repeat(100)}`);
console.log(`${'队伍'.padEnd(30)}${'补金'.padEnd(6)}${'A'.padEnd(7)}${'B'.padEnd(7)}${'C'.padEnd(7)}C 里的总分`);
for (const r of built[2].rows.slice(0, 15)) {
  console.log(`${nameOf(r.members).slice(0, 28).padEnd(30)}${String(r.gap).padStart(3)} 金  `
    + `${pad(rankOf(built[0], r.key)).padEnd(7)}${pad(rankOf(built[1], r.key)).padEnd(7)}`
    + `${pad(rankOf(built[2], r.key)).padEnd(7)}${r.total_score.toFixed(1)}`);
}

// ---- A 的前 15 在 C 里掉到哪 -------------------------------------------------
console.log(`\nA（现状）的前 8 名，在 C 里掉到第几：`);
for (const r of built[0].rows.slice(0, 8)) {
  const rk = rankOf(built[2], r.key);
  console.log(`  A #${String(built[0].rows.indexOf(r) + 1).padStart(2)} → C ${pad(rk)}`
    + `｜补 ${r.gap} 金｜${nameOf(r.members)}`);
}
