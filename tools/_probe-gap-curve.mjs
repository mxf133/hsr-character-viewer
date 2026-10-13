// 探针：比较「差额接近度」那条曲线的几种写法对名次的影响。
//
// 用户 2026-10-12：「差额接近度给要补大量金的队伍的分太多，削减一点」。
// 现状（v4.6.92 起）：`gapPct = 100 × (1 − gap ÷ cap) ^ SCORING.teamPlanGapPower`，
// `cap` = 候选池差额的 p75（实测 14 金）、指数 1.5（用户 2026-10-12 第 9 条要的「削减」）。
//
// 这里把**四类**改法并排打出来（都用同一个候选池、同一批 ①/② 原始量，只换 ② 的算法）：
//   A. 现状：线性，cap = p75
//   B. 曲线：`(1 − gap/cap)^k`，k = 1.5 / 2（越贵扣得越狠，小差额几乎不动）
//   C. 降封顶：cap = p50 / p60（整条曲线往左压）
//   D. 折点：超过 cap 一半的部分按两倍斜率扣
//
//   node tools/_probe-gap-curve.mjs [--account=1] [--rows=8] [--hidden]
import { AccountStore } from '../src/server/store.js';
import {
  DEFAULT_HIDDEN_COSTS, SCORING, buildConclusion, eidolonsOf, lightConeRanksOf,
  normalizeDrawWeights, ownedCharacters, teamPlan, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ACC = Math.max(1, Number(arg('account', '1')) || 1);
const TOP = Math.max(1, Number(arg('rows', '8')) || 8);
const HIDDEN = process.argv.includes('--hidden') ? DEFAULT_HIDDEN_COSTS : null;

const index = await archiveIndex();
const i18n = await loadI18n();
const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const account = accounts[ACC - 1];
const role = (account?.roles || [])[0];
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
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const concl = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  ...(HIDDEN ? { hiddenCosts: HIDDEN } : {}),
});
const keep = SCORING.teamPlanMaxRows;
SCORING.teamPlanMaxRows = 100000;
let plan;
try {
  plan = teamPlan(concl, acct, { availability, drawWeights: normalizeDrawWeights({}) });
} finally {
  SCORING.teamPlanMaxRows = keep;
}
const draw = plan.drawWeights;
const gaps = plan.rows.map((r) => r.gap).sort((a, b) => a - b);
const pctOf = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
console.log(`账号 ${ACC}：${role.nickname}｜隐金=${HIDDEN ? '全勾' : '不减'}｜抽卡权重 ${draw.strength}:${draw.cost}`);
console.log(`候选池 ${plan.pool} 支｜差额：min ${gaps[0]} / p25 ${pctOf(gaps, 0.25)}`
  + ` / p50 ${pctOf(gaps, 0.5)} / p60 ${pctOf(gaps, 0.6)} / p75 ${pctOf(gaps, 0.75)}`
  + ` / p90 ${pctOf(gaps, 0.9)} / max ${gaps[gaps.length - 1]}（金）`);
console.log(`① 刻度（整包分）${plan.strengthLo.toFixed(1)} ~ ${plan.strengthHi.toFixed(1)}`
  + `｜现用 ② 封顶 = ${plan.gapMax} 金\n`);

/** ② 的几种写法：都返回 0~100。 */
const curves = {
  [`A 现状 生产曲线 ^${SCORING.teamPlanGapPower} p75`]: (gap) => {
    const cap = pctOf(gaps, 0.75);
    return 100 * Math.max(0, 1 - gap / cap) ** (Number(SCORING.teamPlanGapPower) || 1);
  },
  'A2 旧曲线 线性 p75': (gap) => {
    const cap = pctOf(gaps, 0.75);
    return 100 * Math.max(0, 1 - gap / cap);
  },
  'B 线性 p60': (gap) => 100 * Math.max(0, 1 - gap / pctOf(gaps, 0.6)),
  'B 线性 p50': (gap) => 100 * Math.max(0, 1 - gap / pctOf(gaps, 0.5)),
  'C ^1.5 p75': (gap) => {
    const cap = pctOf(gaps, 0.75);
    return 100 * Math.max(0, 1 - gap / cap) ** 1.5;
  },
  'C ^2 p75': (gap) => {
    const cap = pctOf(gaps, 0.75);
    return 100 * Math.max(0, 1 - gap / cap) ** 2;
  },
  'D 折点 p75（超半程双倍斜率）': (gap) => {
    const cap = pctOf(gaps, 0.75);
    const x = Math.max(0, 1 - gap / cap);
    return 100 * (x >= 0.5 ? x : x * x);
  },
};

console.log('各写法在几个典型差额上的取值（金 → 分）：');
const probeGaps = [1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 20];
console.log(`  ${'差额'.padStart(4)}  ${Object.keys(curves).map((k) => k.slice(0, 12).padStart(13)).join('')}`);
for (const g of probeGaps) {
  console.log(`  ${String(g).padStart(4)}  ${Object.values(curves)
    .map((fn) => fn(g).toFixed(1).padStart(13)).join('')}`);
}

console.log(`\n各写法下的前 ${TOP} 名（① 不动，只换 ②）：`);
for (const [label, fn] of Object.entries(curves)) {
  const ranked = plan.rows.map((r) => {
    const gp = fn(r.gap);
    return { r, gp, total: draw.strength * r.strengthPct + draw.cost * gp };
  }).sort((a, b) => b.total - a.total
    || b.r.strengthPct - a.r.strengthPct || a.r.gap - b.r.gap);
  console.log(`\n  ── ${label}`);
  for (const [i, x] of ranked.slice(0, TOP).entries()) {
    console.log(`    #${String(i + 1).padStart(2)} ${x.total.toFixed(1).padStart(5)}`
      + ` = ①${x.r.strengthPct.toFixed(1).padStart(5)} + ②${x.gp.toFixed(1).padStart(5)}`
      + `｜补 ${String(x.r.gap).padStart(2)} 金｜账面 ${String(x.r.gold).padStart(2)} 金`
      + `｜${x.r.members.map((m) => cn(m.char)).join('/')}`);
  }
}
