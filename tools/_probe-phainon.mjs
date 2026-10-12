// 追一支特定队伍：**白厄 / 刻律德菈 / 昔涟 / 花火**（第一版抽卡方案里的 #2，
// 「性价比低但差额接近度高」那一支）。看它在**当前算法**下排第几、两个分项各是多少。
//
// 同时把「只换刻度基准、不换候选池」的对照也打出来，用来分离两个原因：
//   A. 候选池变了（v4.6.78 的「前沿池 = 全部成绩」）→ 这支队伍在不在池里、队分多少
//   B. 刻度基准变了（v4.6.83 的「按候选池而不是展示批次」）→ 同一支队伍的两个分项
//
//   node tools/_probe-phainon.mjs [--hidden]
import { AccountStore } from '../src/server/store.js';
import {
  DEFAULT_HIDDEN_COSTS, SCORING, buildConclusion, eidolonsOf, lightConeRanksOf,
  teamPlan, ownedCharacters, VERSION_WINDOW,
} from '../src/core/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const HIDDEN = process.argv.includes('--hidden') ? DEFAULT_HIDDEN_COSTS : null;
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
const cn = (n) => zhName(i18n, 'characters', n) || n;
const nameOf = (r) => r.members.map((m) => cn(m.char)).join('/');

const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const concl = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  ...(HIDDEN ? { hiddenCosts: HIDDEN } : {}),
});

const keep = SCORING.teamPlanMaxRows;
SCORING.teamPlanMaxRows = 100000; // 先拿全池，才看得到「不在前 15」的队伍
const planAll = teamPlan(concl, acct, { availability });
SCORING.teamPlanMaxRows = keep;

console.log(`账号 ${role.nickname}｜隐金=${HIDDEN ? '全勾' : '不减'}｜默认总榜权重`);
console.log(`总榜 ${concl.frontierUnits.length} 条 · 候选池 ${planAll.pool} 支`
  + ` · ① 刻度 ${planAll.scoreLo.toFixed(1)}~${planAll.scoreHi.toFixed(1)}`
  + ` · ② 封顶 ${planAll.gapMax} 金（p${Math.round(SCORING.teamPlanGapCapPct * 100)}）`);

/** 找含 Phainon（白厄）的队伍。 */
const hits = planAll.rows.filter((r) => r.members.some((m) => m.char === 'Phainon'));
console.log(`\n候选池里含【白厄】的队伍：${hits.length} 支`);
for (const [i, r] of planAll.rows.entries()) {
  if (!r.members.some((m) => m.char === 'Phainon')) continue;
  console.log(`  全池第 ${i + 1} 名｜总分 ${r.total.toFixed(1)} = ①${r.scorePct.toFixed(1)}`
    + ` + ②${r.gapPct.toFixed(1)}｜补 ${r.gap} 金｜${nameOf(r)}`);
  console.log(`      成员档位：${r.members.map((m) => `${cn(m.char)}[${m.owned ? '有' : '缺'}]E${m.eidolon ?? 0}`
    + `${m.lc ? `+${cn(m.lc)}S${m.superimp ?? 1}` : ''}`).join(' / ')}`);
  console.log(`      补金顺序：${r.fill.map((it) => `${cn(it.name)}·${it.target || ''}(${it.pulls}金)`).join(' → ') || '（无）'}`);
}

/** 修前刻度（取自展示批次）下，同一批队伍的排名 —— 只为分离「刻度」这一个变量。 */
const legacyTop = (show) => {
  SCORING.teamPlanMaxRows = 100000;
  const all1 = teamPlan(concl, acct, { availability }).rows;
  SCORING.teamPlanMaxRows = keep;
  const byRaw = [...all1].sort((x, y) => y.teamScore - x.teamScore
    || x.gap - y.gap || String(x.key).localeCompare(String(y.key)));
  const picked = byRaw.slice(0, show);
  const lo = Math.min(...picked.map((r) => r.teamScore));
  const hi = Math.max(...picked.map((r) => r.teamScore));
  const sortedGaps = picked.map((r) => r.gap).sort((x, y) => x - y);
  const cap = sortedGaps[Math.min(sortedGaps.length - 1, Math.floor(sortedGaps.length * 0.5))];
  return picked.map((r) => {
    const s = hi - lo < 1e-9 ? 100 : 100 * (r.teamScore - lo) / (hi - lo);
    const g = Math.max(0, Math.min(100, 100 * (1 - r.gap / cap)));
    return { ...r, ls: s, lg: g, lt: 0.5 * s + 0.5 * g, cap };
  }).sort((x, y) => y.lt - x.lt);
};
SCORING.teamPlanMaxRows = 15;
const legacy = legacyTop(15);
SCORING.teamPlanMaxRows = keep;
console.log(`\n【只换刻度基准的对照】修前（展示批次 p50 = ${legacy[0].cap} 金）前 15 名：`);
legacy.slice(0, 15).forEach((r, i) => {
  const mark = r.members.some((m) => m.char === 'Phainon') ? '  ← 含白厄' : '';
  console.log(`  #${String(i + 1).padStart(2)} ${r.lt.toFixed(1)} = ①${r.ls.toFixed(1)} + ②${r.lg.toFixed(1)}`
    + `｜补 ${String(r.gap).padStart(2)} 金｜${nameOf(r)}${mark}`);
});

/** 同一个「补 1 金」的白厄队在两种刻度下的两个分项 —— 直接摆出来。 */
console.log('\n【同一支「补 1 金」白厄队的两个刻度对照】');
for (const r of hits.filter((x) => x.gap <= 1)) {
  const ls = legacy.find((x) => x.key === r.key);
  console.log(`  ${nameOf(r)}（补 ${r.gap} 金）`);
  console.log(`    修后刻度（全池 p50 = ${planAll.gapMax} 金）：总分 ${r.total.toFixed(1)}`
    + ` = ①${r.scorePct.toFixed(1)} + ②${r.gapPct.toFixed(1)}`);
  console.log(`    修前刻度（展示批次 p50 = ${legacy[0].cap} 金）：`
    + (ls ? `总分 ${ls.lt.toFixed(1)} = ①${ls.ls.toFixed(1)} + ②${ls.lg.toFixed(1)}`
      : '（它不在「按队分初选的前 15 支」里 —— 连算分的机会都没有）'));
}

/**
 * 量化「两阶段初选」这道闸门的影响。
 *
 * 修前的流程是「**先按队分**初选前 N 支 → 截断 → 再按总分排」。于是队分低的队伍
 * 根本进不了那 N 支，**哪怕它的总分比入选者还高** —— 这一支就是这么被挡掉的。
 */
const newTop = planAll.rows.slice(0, 15);
const gate = new Set(legacy.map((r) => r.key));
const blocked = newTop.filter((r) => !gate.has(r.key));
console.log(`\n【闸门影响】修后按总分排的前 15 名里，有 ${blocked.length} 支`
  + `在修前那套「按队分初选前 15 支」里**进不来**（所以从来没被算过总分）：`);
for (const r of blocked) {
  console.log(`  · 修后 #${planAll.rows.indexOf(r) + 1} 总分 ${r.total.toFixed(1)}`
    + ` = ①${r.scorePct.toFixed(1)} + ②${r.gapPct.toFixed(1)}｜补 ${r.gap} 金｜${nameOf(r)}`);
}
const legacyWorstTotal = Math.min(...legacy.map((r) => r.lt));
console.log(`  （对照：修前那 15 支里，总分最低的一支只有 ${legacyWorstTotal.toFixed(1)}）`);
