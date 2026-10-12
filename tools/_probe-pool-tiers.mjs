// 决定性实验：把候选池从「每个角色只留**最强**整包」换成「每个角色 × 每个星魂档各留一条」
// （= 现成的 `concl.frontierTiers`），看**便宜但稍弱的队伍**会不会冲上来。
//
// 用户 2026-10-11：「任何队伍都应该有机会参与竞争，哪怕这支队伍本身实力不强，
// 但可以依靠差额接近度拉分，结果很有可能名列前茅。」
//
// 两道闸门的区别：
//   * 本轮修掉的那道 —— 「先按队分初选前 N 支」，所有候选现在都会被算分；
//   * **还留着的那道** —— 候选池 = 每个角色只留**总分最高**的那一个整包。
//     于是「同一支队伍的低配档位」（便宜、强度略低）被自己的高配档位挤掉了。
//
//   node tools/_probe-pool-tiers.mjs
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, eidolonsOf, lightConeRanksOf, marginalCostOf, ownedCharacters,
  teamPlan, VERSION_WINDOW, SCORING,
} from '../src/core/advice.js';
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

/** 从一组整包里收敛出「队伍」（同 roster 留 total 最高那条）。 */
const teamsOf = (units) => {
  const by = new Map();
  for (const u of units) {
    const best = (u.envs || []).find((e) => (e.members || []).length);
    if (!best?.members?.length) continue;
    const key = rosterKeyOf(best.members);
    const total = Number(u.total) || 0;
    if (!by.has(key) || total > by.get(key).total) {
      by.set(key, { key, members: best.members, total, name: u.name });
    }
  }
  return [...by.values()];
};

/** 用「两个指标各半」给一批队伍打分（刻度按这批现算，与产品同口径）。 */
const scoreTeams = (teams, capPct = SCORING.teamPlanGapCapPct) => {
  const rows = [];
  for (const t of teams) {
    const gap = Math.max(0, Number(marginalCostOf(t.members, availability, acct).pulls) || 0);
    if (gap <= 0) continue; // 用户第 3 条：差额 0 金的队伍不进候选
    rows.push({ ...t, gap });
  }
  const lo = Math.min(...rows.map((r) => r.total));
  const hi = Math.max(...rows.map((r) => r.total));
  const gaps = rows.map((r) => r.gap).sort((a, b) => a - b);
  const cap = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * capPct))];
  for (const r of rows) {
    r.scorePct = hi - lo < 1e-9 ? 100 : 100 * (r.total - lo) / (hi - lo);
    r.gapPct = Math.max(0, Math.min(100, 100 * (1 - r.gap / cap)));
    r.total_score = 0.5 * r.scorePct + 0.5 * r.gapPct;
  }
  return { rows: rows.sort((a, b) => b.total_score - a.total_score), lo, hi, cap };
};

// ---- 现在的池（每个角色最强整包）--------------------------------------------
// ⚠️ `options.maxRows` 只能**往下**夹（`Math.min(SCORING.teamPlanMaxRows, …)`），
// 所以想枚举整个池必须先把这个常量抬起来 —— 否则只拿得到前 15 条，
// 「哪些队伍被池挤掉了」的计数会全错（这个坑本轮踩过一次）。
const keepRows = SCORING.teamPlanMaxRows;
SCORING.teamPlanMaxRows = 100000;
const plan = teamPlan(concl, acct, { availability });
SCORING.teamPlanMaxRows = keepRows;
const nowKeys = new Set(plan.rows.map((r) => r.key));

// ---- 「每角色 × 每档」的池 ---------------------------------------------------
const tierUnits = Object.values(concl.frontierTiers || {}).flat();
const tier = scoreTeams(teamsOf(tierUnits));
const inNow = (key) => nowKeys.has(key);

console.log(`账号 ${role.nickname}｜默认总榜权重｜隐金不减\n`);
console.log(`【现在的池】整包 ${concl.frontierUnits.length} 条 → 队伍 ${plan.pool} 支`
  + `（去重 ${plan.poolAll}）· ① 刻度 ${plan.scoreLo.toFixed(1)}~${plan.scoreHi.toFixed(1)}`
  + ` · ② 封顶 ${plan.gapMax} 金`);
console.log(`【每档各留一条】整包 ${tierUnits.length} 条 → 队伍 ${tier.rows.length} 支`
  + ` · ① 刻度 ${tier.lo.toFixed(1)}~${tier.hi.toFixed(1)} · ② 封顶 ${tier.cap} 金`);
const unlocked = tier.rows.filter((r) => !inNow(r.key));
console.log(`**因此新放进来（现在整个池都没有的）队伍：${unlocked.length} 支**`
  + `，其中补金 ≤ 2 的 ${unlocked.filter((r) => r.gap <= 2).length} 支`);

console.log('\n【每档池的前 15 名】★ = **现在整个池里都没有**的（被「每角色只留最强」挤掉）');
tier.rows.slice(0, 15).forEach((r, i) => {
  console.log(`  ${inNow(r.key) ? '  ' : '★ '}#${String(i + 1).padStart(2)} ${r.total_score.toFixed(1)}`
    + ` = ①${r.scorePct.toFixed(1).padStart(5)} + ②${r.gapPct.toFixed(1).padStart(5)}`
    + `｜补 ${String(r.gap).padStart(2)} 金｜${nameOf(r.members)}`);
});

console.log('\n【现在的池的前 15 名（对照）】');
plan.rows.slice(0, 15).forEach((r, i) => {
  console.log(`  #${String(i + 1).padStart(2)} ${r.total.toFixed(1)}`
    + ` = ①${r.scorePct.toFixed(1).padStart(5)} + ②${r.gapPct.toFixed(1).padStart(5)}`
    + `｜补 ${String(r.gap).padStart(2)} 金｜${nameOf(r.members)}`);
});

/** ① 低但排名靠前的队伍（用户说的「靠差额接近度拉分」）。 */
const cheapTop = (list, scoreOf) => list
  .map((r, i) => ({ r, rank: i + 1, s: scoreOf(r) }))
  .filter((x) => x.r.scorePct < 25)
  .slice(0, 6);
console.log('\n【「① 低于 25、但排名进前 30」的队伍】');
for (const [label, list, scoreOf] of [
  ['现在', plan.rows, (r) => r.total],
  ['每档', tier.rows, (r) => r.total_score],
]) {
  console.log(`  ${label}：`);
  for (const { r, rank, s } of cheapTop(list, scoreOf)) {
    if (rank > 30) continue;
    console.log(`    #${String(rank).padStart(2)} 总分 ${s.toFixed(1)}`
      + ` = ①${r.scorePct.toFixed(1)} + ②${r.gapPct.toFixed(1)}｜补 ${r.gap} 金｜${nameOf(r.members)}`);
  }
}
