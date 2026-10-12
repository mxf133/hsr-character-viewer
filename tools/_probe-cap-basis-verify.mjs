// 验证第七轮修：**展示条数不再影响分数水位**。
//
// 关键不变量：同一条队伍在「展示 15 条」与「展示 40 条」下的 ①/②/总分**必须逐位相同**。
// 修前不成立（封顶值取自展示批次，15 条时封顶 9 金、40 条时 12 金）。
//
//   node tools/_probe-cap-basis-verify.mjs [--w=截图那套权重]
import { AccountStore } from '../src/server/store.js';
import {
  SCORING, DEFAULT_HIDDEN_COSTS, buildConclusion, eidolonsOf, lightConeRanksOf,
  teamPlan, ownedCharacters, VERSION_WINDOW,
} from '../src/core/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const raw = (process.argv.find((a) => a.startsWith('--w=')) || '').slice(4);
const MODE_FLAGS = {
  aaPl: ['aa', 'plight'], aa: ['aa', ''], as: ['as', ''], moc: ['moc', ''], pf: ['pf', ''],
};
const WEIGHTS = (() => {
  if (!raw) return null;
  const out = {};
  for (const part of raw.split(',')) {
    const [flag, value] = part.split('=');
    const pair = MODE_FLAGS[flag];
    if (!pair) throw new Error(`未知旗标 ${flag}`);
    out[`${pair[0]}|${pair[1]}`] = Number(value);
  }
  return out;
})();
const HIDDEN = (process.argv.includes('--hidden')) ? DEFAULT_HIDDEN_COSTS : null;

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

const frontierAll = await archiveFrontierAll(envs, {
  window: VERSION_WINDOW, ...(WEIGHTS ? { weights: WEIGHTS } : {}),
});
const concl = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  ...(HIDDEN ? { hiddenCosts: HIDDEN } : {}),
});
console.log(`账号 ${role.nickname}　权重=${WEIGHTS ? '截图那套' : '默认'}　隐金=${HIDDEN ? '全勾' : '不减'}`);

const keepRows = SCORING.teamPlanMaxRows;
const keepCap = SCORING.teamPlanGapCapPct;

const runWith = (rows) => {
  SCORING.teamPlanMaxRows = rows;
  return teamPlan(concl, acct, { availability });
};

/** 1) 封顶值只由全池决定 —— 与展示条数无关。 */
const caps = [15, 40, 100000].map((n) => runWith(n).gapMax);
console.log(`\n【不变量 1】② 的封顶值：展示 15 / 40 / 全池 → ${caps.join(' / ')} 金`);
console.log(`  ${new Set(caps).size === 1 ? '✓ 完全一致（封顶只由候选池决定）'
  : '✗ 不一致 —— 修法没生效'}`);

/** 2) 同一条队伍在不同展示条数下的分数逐位相同。 */
const a = runWith(15); const b = runWith(40);
const byKey = new Map(b.rows.map((r) => [r.key, r]));
let same = 0; const diff = [];
for (const r of a.rows) {
  const o = byKey.get(r.key);
  if (!o) { diff.push(`${nameOf(r)}: 只在 15 条里`); continue; }
  if (r.total === o.total && r.scorePct === o.scorePct && r.gapPct === o.gapPct) same += 1;
  else diff.push(`${nameOf(r)}: 15条 ${r.total} vs 40条 ${o.total}`);
}
console.log(`\n【不变量 2】15 条里的 ${a.rows.length} 支，在 40 条里分数逐位相同的：${same}`);
console.log(`  ${diff.length === 0 ? '✓ 全部一致（展示条数不影响分数）' : `✗ ${diff.join('；')}`}`);

/** 3) 名次也一致（前 15 名是 40 条榜的前 15 名）。 */
const orderA = a.rows.map((r) => r.key);
const orderB = b.rows.slice(0, 15).map((r) => r.key);
console.log(`\n【不变量 3】前 15 名的顺序一致：${orderA.join() === orderB.join() ? '✓' : '✗'}`);

/** 4) 展示。 */
SCORING.teamPlanMaxRows = 15;
const plan = runWith(15);

/** 5) **修前复算**：把刻度按「展示批次」算（= v4.6.78~v4.6.80 的行为），看会得到什么。
 *
 * 为什么要有这一段：修完之后 `_probe-repro.mjs` 就**复现不出**那个 55.6 了（因为它已经好了）。
 * 文档里那张「修前 / 修后」对照表要有可复算的来源，所以这里把旧算法原样重跑一遍 ——
 * 旧流程是「先按原始量纲初选 → 截断 → 按这批算刻度 → 再按总分重排」。
 */
const legacyPlan = (show) => {
  SCORING.teamPlanMaxRows = 100000;
  const all = teamPlan(concl, acct, { availability }).rows;
  SCORING.teamPlanMaxRows = show;
  const byRaw = [...all].sort((x, y) => y.teamScore - x.teamScore
    || x.gap - y.gap || String(x.key).localeCompare(String(y.key)));
  const picked = byRaw.slice(0, show);
  const lo = Math.min(...picked.map((r) => r.teamScore));
  const hi = Math.max(...picked.map((r) => r.teamScore));
  const sorted = picked.map((r) => r.gap).sort((x, y) => x - y);
  const cap = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5))];
  const scored = picked.map((r) => {
    const legacyScore = hi - lo < 1e-9 ? 100 : 100 * (r.teamScore - lo) / (hi - lo);
    const legacyGap = Math.max(0, Math.min(100, 100 * (1 - r.gap / cap)));
    return { ...r, legacyScore, legacyGap, legacyTotal: 0.5 * legacyScore + 0.5 * legacyGap };
  }).sort((x, y) => y.legacyTotal - x.legacyTotal);
  return { cap, scored };
};

const legacy = legacyPlan(15);
console.log('\n【修前复算】（刻度取自展示批次，v4.6.78~v4.6.80 的行为）');
console.log(`  ② 封顶 ${legacy.cap} 金 · ② 归 0 的 `
  + `${legacy.scored.filter((r) => r.legacyGap === 0).length}/${legacy.scored.length}`);
legacy.scored.slice(0, 5).forEach((r, i) => {
  console.log(`  #${String(i + 1).padStart(2)} ${r.legacyTotal.toFixed(1).padStart(5)}`
    + ` = ①${r.legacyScore.toFixed(1).padStart(5)} + ②${r.legacyGap.toFixed(1).padStart(5)}`
    + `｜补 ${String(r.gap).padStart(2)} 金｜${nameOf(r)}`);
});
{
  const first = legacy.scored[0];
  const now = plan.rows.find((r) => r.key === first.key);
  console.log(`  → 修前第 1 名那支队伍，修后是 `
    + `${now ? `${now.total.toFixed(1)}（①${now.scorePct.toFixed(1)} + ②${now.gapPct.toFixed(1)}）` : '（不在前 15）'}`);
}

console.log(`\n候选池 ${plan.pool} 支（去重 ${plan.poolAll}）· ① 刻度 ${plan.scoreLo.toFixed(1)}~${plan.scoreHi.toFixed(1)}`
  + ` · ② 封顶 ${plan.gapMax} 金（p${Math.round(plan.gapCapPct * 100)}）`
  + ` · ② 归 0 的 ${plan.rows.filter((r) => r.gapPct === 0).length}/${plan.rows.length}`);
plan.rows.slice(0, 10).forEach((r, i) => {
  console.log(`  #${String(i + 1).padStart(2)} ${r.total.toFixed(1).padStart(5)}`
    + ` = ①${r.scorePct.toFixed(1).padStart(5)} + ②${r.gapPct.toFixed(1).padStart(5)}`
    + `｜补 ${String(r.gap).padStart(2)} 金｜${nameOf(r)}`);
});

SCORING.teamPlanMaxRows = keepRows;
SCORING.teamPlanGapCapPct = keepCap;
