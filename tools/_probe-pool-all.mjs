// ⚠️ 口径变更：① 在 v4.6.87~v4.6.90 一度是**纯强度**（不含金数项）；v4.6.91 回到
// **总榜分含金数项**归一化（`rows[].strengthPct` 是池内位置，原始值 `rows[].teamScore`）。
//
// 三池对照：**全放进来**到底长什么样。
//
// 用户 2026-10-11：「全放进来试试，让我看看结果。」
//
// 三个候选池（同一套两个指标、同一套刻度规则，只在「池」上不同）：
//   ① 现在   —— `conclusion.frontierUnits`     （每角色只留**总分最高**的那一个整包）
//   ② 每档   —— `conclusion.frontierTiers`     （每角色 × 每个星魂档各留一条）
//   ③ 全量   —— `conclusion.frontierPacksByChar`（**收敛前**每个角色的全部整包）
//
// ⚠️ 三者的 ① 刻度与 ② 封顶都不同，所以**总分不能跨池比**；能比的是各自池内的名次。
//
//   node tools/_probe-pool-all.mjs
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, eidolonsOf, lightConeRanksOf, marginalCostOf, ownedCharacters,
  SCORING, teamPlan, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const index = await archiveIndex();
const i18n = await loadI18n();
const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const account = accounts[0];
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

/** 整包列表 → 队伍（同 roster 留 total 最高那条）。 */
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

/** 两个指标各半（刻度按这批现算，与产品同口径）。 */
const scoreTeams = (teams) => {
  const rows = [];
  let zeroGap = 0;
  for (const t of teams) {
    const gap = Math.max(0, Number(marginalCostOf(t.members, availability, acct).pulls) || 0);
    if (gap <= 0) { zeroGap += 1; continue; } // 用户第 3 条
    rows.push({ ...t, gap });
  }
  const lo = Math.min(...rows.map((r) => r.total));
  const hi = Math.max(...rows.map((r) => r.total));
  const gaps = rows.map((r) => r.gap).sort((a, b) => a - b);
  const cap = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * SCORING.teamPlanGapCapPct))];
  for (const r of rows) {
    r.strengthPct = hi - lo < 1e-9 ? 100 : 100 * (r.total - lo) / (hi - lo);
    // ⚠️ 曲线指数跟着生产走（见 `SCORING.teamPlanGapPower`）：线性复算会与界面名次对不上。
r.gapPct = 100 * Math.max(0, Math.min(1, 1 - r.gap / cap)) ** (Number(SCORING.teamPlanGapPower) || 1);
    // 等权 0.5/0.5 = 默认抽卡权重（1:1）；这里刻意不读 `plan.drawWeights`。
    r.total_score = 0.5 * r.strengthPct + 0.5 * r.gapPct;
  }
  return { rows: rows.sort((a, b) => b.total_score - a.total_score), lo, hi, cap, zeroGap };
};

const keepRows = SCORING.teamPlanMaxRows;
SCORING.teamPlanMaxRows = 100000;
const nowPlan = teamPlan(concl, acct, { availability });
SCORING.teamPlanMaxRows = keepRows;
const nowKeys = new Set(nowPlan.rows.map((r) => r.key));

const tierUnits = Object.values(concl.frontierTiers || {}).flat();
const allPacks = Object.values(concl.frontierPacksByChar || {}).flat();

const POOLS = [
  ['① 现在（每角色最强整包）', teamsOf(concl.frontierUnits),
    { rows: nowPlan.rows.map((r) => ({ ...r, total_score: r.total, strengthPct: r.strengthPct, gapPct: r.gapPct })),
      lo: nowPlan.strengthLo, hi: nowPlan.strengthHi, cap: nowPlan.gapMax, zeroGap: null }],
  ['② 每档（每角色 × 每星魂档）', teamsOf(tierUnits), null],
  ['③ 全量（收敛前全部整包）', teamsOf(allPacks), null],
];

console.log(`账号 ${role.nickname}｜默认总榜权重｜隐金不减`);
console.log(`整包条数：现在 ${concl.frontierUnits.length} / 每档 ${tierUnits.length} / 全量 ${allPacks.length}\n`);

const results = [];
for (const [label, teams, preset] of POOLS) {
  const r = preset || scoreTeams(teams);
  results.push({ label, r, teams });
  console.log(`${label}`);
  console.log(`  队伍 ${r.rows.length} 支（去重前 ${teams.length}）`
    + `｜① 刻度 ${r.lo.toFixed(1)}~${r.hi.toFixed(1)}`
    + `｜② 封顶 ${r.cap} 金`
    + `${r.zeroGap === null ? '' : `｜补金 0 被剔除 ${r.zeroGap} 支`}`
    + `｜② 归 0 的 ${r.rows.filter((x) => x.gapPct === 0).length} 支`);
}

// ---- 三池的前 15 -------------------------------------------------------------
for (const { label, r } of results) {
  console.log(`\n${'='.repeat(96)}\n${label} —— 前 15 名\n${'='.repeat(96)}`);
  r.rows.slice(0, 15).forEach((x, i) => {
    const seen = nowKeys.has(x.key) ? '  ' : '★ ';
    console.log(`  ${seen}#${String(i + 1).padStart(2)} ${x.total_score.toFixed(1)}`
      + ` = ①${x.strengthPct.toFixed(1).padStart(5)} + ②${x.gapPct.toFixed(1).padStart(5)}`
      + `｜补 ${String(x.gap).padStart(2)} 金｜${nameOf(x.members)}`);
  });
  console.log('  （★ = 现在的池里没有这一条）');
}

// ---- 「低①高②」那类在各池的最好名次 -----------------------------------------
console.log(`\n${'='.repeat(96)}\n「① 低于 25」的队伍在各池的最好名次（用户关心的那一类）\n${'='.repeat(96)}`);
for (const { label, r } of results) {
  const hits = r.rows.map((x, i) => ({ x, rank: i + 1 })).filter((y) => y.x.strengthPct < 25).slice(0, 5);
  console.log(`\n${label}：`);
  for (const { x, rank } of hits) {
    console.log(`  #${String(rank).padStart(3)} ${x.total_score.toFixed(1)}`
      + ` = ①${x.strengthPct.toFixed(1).padStart(5)} + ②${x.gapPct.toFixed(1).padStart(5)}`
      + `｜补 ${String(x.gap).padStart(2)} 金｜${nameOf(x.members)}`);
  }
}

// ---- 体积量级（如果真要把池下发到界面）--------------------------------------
console.log(`\n${'='.repeat(96)}\n一句提醒：池越大，「前 15 名」的门槛越高\n${'='.repeat(96)}`);
for (const { label, r } of results) {
  const t15 = r.rows[14]?.total_score ?? 0;
  console.log(`  ${label}：第 15 名的总分 ${t15.toFixed(1)}`
    + `（池内 ${r.rows.length} 支，进前 15 的比例 1/${Math.round(r.rows.length / 15)}）`);
}
