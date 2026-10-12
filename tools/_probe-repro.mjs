// ⚠️ 口径变更：本探针写于旧口径（①=总榜分含金数项归一化）；v4.6.87 起 ① 换成**纯强度**
// （`rows[].strengthPct`，原始值 `rows[].strength`），这里已经跟着改。
//
// 复现截图 + 扫「补金推荐分为什么只有 50 多」。
//
// 两件事：
//   A. 复现：用**截图那套总榜权重** + **界面默认的隐金设置（五组全勾）**，看是否得到
//      总榜 81 / 候选 80 / #1 银狼队 55.6 = ①100.0 + ②11.1。
//   B. 扫描：把「展示条数」与「② 的封顶分位」这两件事各扫一遍，看总分水位怎么变。
//
//   node tools/_probe-repro.mjs
import { AccountStore } from '../src/server/store.js';
import {
  SCORING, DEFAULT_HIDDEN_COSTS, buildConclusion, eidolonsOf, lightConeRanksOf,
  teamPlan, ownedCharacters, VERSION_WINDOW,
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
const cn = (n) => zhName(i18n, 'characters', n) || n;
const nameOf = (r) => r.members.map((m) => cn(m.char)).join('/');

/** 截图那套权重（把非绝境压到 0.1）。 */
const SHOT_WEIGHTS = {
  'aa|plight': 10, 'aa|': 0.1, 'as|': 0.1, 'moc|': 0.1, 'pf|': 0.1,
};

const build = async ({ weights = null, hidden = null, window: win = VERSION_WINDOW }) => {
  const frontierAll = await archiveFrontierAll(envs, { window: win, ...(weights ? { weights } : {}) });
  return buildConclusion(envs, {
    availability,
    firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
    account: acct,
    frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
    ...(hidden ? { hiddenCosts: hidden } : {}),
  });
};

const show = (label, concl, opts = {}) => {
  const plan = teamPlan(concl, acct, { availability, ...opts });
  const strengths = plan.rows.map((r) => r.strengthPct);
  console.log(`\n${'─'.repeat(100)}\n${label}`);
  console.log(`  总榜 ${concl.frontierUnits.length} 条 · 候选池 ${plan.pool} 支（去重 ${plan.poolAll}）`
    + ` · 展示 ${plan.rows.length} 条 · ②封顶 ${plan.gapMax} 金（真实最大 ${plan.gapRealMax}）`);
  console.log(`  ① 刻度（纯强度）：${plan.strengthLo.toFixed(0)}~${plan.strengthHi.toFixed(0)}`
    + `　→ ① 落在 ${Math.min(...strengths).toFixed(1)} ~ ${Math.max(...strengths).toFixed(1)}`
    + `　（总榜分刻度 ${plan.scoreLo.toFixed(0)}~${plan.scoreHi.toFixed(0)}，仅展示）`);
  console.log(`  ② 落在 ${Math.min(...plan.rows.map((r) => r.gapPct)).toFixed(1)}`
    + ` ~ ${Math.max(...plan.rows.map((r) => r.gapPct)).toFixed(1)}`
    + `　② 归 0 的 ${plan.rows.filter((r) => r.gapPct === 0).length}/${plan.rows.length} 支`);
  plan.rows.slice(0, 8).forEach((r, i) => {
    console.log(`  #${String(i + 1).padStart(2)} ${r.total.toFixed(1).padStart(5)}`
      + ` = ①${r.strengthPct.toFixed(1).padStart(5)} + ②${r.gapPct.toFixed(1).padStart(5)}`
      + `｜补 ${String(r.gap).padStart(2)} 金｜${nameOf(r)}`);
  });
  return plan;
};

console.log(`账号：${role.nickname}`);

// ---- A. 复现截图 -------------------------------------------------------------
const base = await build({ weights: null });
show('【基准】默认权重 + 不减隐金（= 我之前所有探针的口径）', base);
const shot = await build({ weights: SHOT_WEIGHTS });
show('【A1】截图权重 + 不减隐金', shot);
const shotHidden = await build({ weights: SHOT_WEIGHTS, hidden: DEFAULT_HIDDEN_COSTS });
show('【A2】截图权重 + **隐金全勾**（= 你浏览器里那套）', shotHidden);

// ---- B. 扫水位 ---------------------------------------------------------------
const keepRows = SCORING.teamPlanMaxRows;
const keepCap = SCORING.teamPlanGapCapPct;

console.log(`\n\n${'='.repeat(100)}\nB. 扫「展示条数 × ② 的封顶分位」（都在【A2】那套权重/隐金下）\n${'='.repeat(100)}`);
console.log(`${'条数'.padEnd(6)}${'②封顶'.padEnd(8)}${'#1 补金推荐分'.padEnd(14)}${'②归0'.padEnd(8)}`
  + `${'②上界'.padEnd(8)}前 3 名（分 = ① + ②）`);

for (const rows of [15, 40, 60]) {
  for (const cap of [0.5, 0.75, 1]) {
    SCORING.teamPlanMaxRows = rows;
    SCORING.teamPlanGapCapPct = cap;
    const plan = teamPlan(shotHidden, acct, { availability });
    const top = plan.rows.slice(0, 3).map((r) => `${r.total.toFixed(1)}(${r.strengthPct.toFixed(0)}+${r.gapPct.toFixed(0)})`);
    const zero = plan.rows.filter((r) => r.gapPct === 0).length;
    const capLabel = cap === 1 ? 'max' : `p${cap * 100}`;
    console.log(`${String(rows).padEnd(6)}${capLabel.padEnd(8)}`
      + `${plan.rows[0].total.toFixed(1).padEnd(14)}`
      + `${`${zero}/${plan.rows.length}`.padEnd(8)}`
      + `${plan.gapMax.toFixed(0).padEnd(8)}${top.join('  ')}`);
  }
}
SCORING.teamPlanMaxRows = keepRows;
SCORING.teamPlanGapCapPct = keepCap;

console.log(`\n⚠️ 注意「②上界」这一列：它能到多少，直接决定总分水位。`
  + `差额 0 金的队伍根本不进候选（用户要求），所以 ② 永远拿不到 100。`);
