// 探针：把「强度得分」那条归一化刻度的**分布**打出来，回答
// 「为什么很多队伍的强度得分直接接近 100」。
//
// `teamPlan()` 只回前 N 条，所以这里把 `SCORING.teamPlanMaxRows` 临时抬高（⚠️
// `Math.min(SCORING.teamPlanMaxRows, options.maxRows)` —— 常量是**上限**，不抬高拿不到全池），
// 拿到整个候选池的强度，再逐种「下限锚点」模拟一遍归一化结果。
//
//   node tools/_probe-strength-scale.mjs [--account=1] [--top=15]
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, teamPlan, normalizeDrawWeights, ownedCharacters, eidolonsOf,
  lightConeRanksOf, SCORING,
} from '../public/scripts/advice.js';
import { archiveIndex, archiveFrontierAll, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ACC = Math.max(1, Number(arg('account', '1')) || 1);
const TOP = Math.max(1, Number(arg('top', '15')) || 15);

const index = await archiveIndex();
const i18n = await loadI18n();
const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const account = accounts[ACC - 1];
const role = (account?.roles || [])[0];
if (!role) { console.log(`账号 ${ACC} 没有角色`); process.exit(1); }
const snap = await store.getSnapshot(account.id, role.uid);
const zhToEn = {};
for (const c of index.refs?.characters || []) if (c.nameCn && c.name) zhToEn[c.nameCn] = c.name;
const coneZhToEn = {};
for (const c of index.refs?.lightCones || []) if (c.nameCn && c.name) coneZhToEn[c.nameCn] = c.name;
const allNames = (index.refs?.characters || []).map((c) => c.name);
const acct = {
  owned: ownedCharacters(snap, zhToEn, allNames),
  eidolons: eidolonsOf(snap, zhToEn),
  cones: lightConeRanksOf(snap, coneZhToEn),
};
const availability = index.refs?.availability || {};
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: 3 });
const conclusion = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});
const cn = (n) => zhName(i18n, 'characters', n) || n;

// ⚠️ 抬高上限才能拿到全池（只影响展示条数，不影响任何刻度 —— 这一点本身就是被测试钉住的口径）。
const keep = SCORING.teamPlanMaxRows;
SCORING.teamPlanMaxRows = 100000;
let plan;
try {
  plan = teamPlan(conclusion, acct, {
    availability, maxRows: 100000, drawWeights: normalizeDrawWeights({}),
  });
} finally {
  SCORING.teamPlanMaxRows = keep;
}

const rows = plan.rows;
const strengths = rows.map((r) => r.strength).sort((a, b) => a - b);
const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
const fmt = (v, d = 1) => Number(v).toFixed(d);
const lo = pct(strengths, 0);
const hi = strengths[strengths.length - 1];

console.log(`账号 ${ACC}：${role.nickname}｜候选池 ${plan.pool} 支（全部拿到 = ${rows.length} 条）`);
console.log(`当前刻度：强度 ${fmt(lo)} ~ ${fmt(hi)}（**池内最小 ~ 最大**）\n`);
console.log('强度分布：');
for (const p of [0, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]) {
  console.log(`  p${String(Math.round(p * 100)).padStart(2)} = ${fmt(pct(strengths, p))}`);
}
console.log(`  max = ${fmt(hi)}`);
const buckets = [[0, 500], [500, 800], [800, 1000], [1000, 1100], [1100, 1200],
  [1200, 1300], [1300, 1350], [1350, 1400], [1400, 1e9]];
console.log('\n强度分桶（池内支数）：');
for (const [a, b] of buckets) {
  const n = strengths.filter((s) => s >= a && s < b).length;
  console.log(`  ${String(a).padStart(4)}~${b === 1e9 ? '∞' : b} : ${String(n).padStart(4)} 支`
    + `  ${'#'.repeat(Math.round(n / strengths.length * 60))}`);
}
const near = strengths.filter((s) => 100 * (s - lo) / (hi - lo) >= 95).length;
const near90 = strengths.filter((s) => 100 * (s - lo) / (hi - lo) >= 90).length;
console.log(`\n当前刻度下：强度得分 ≥ 95 的有 **${near}/${strengths.length} 支**`
  + `（≥ 90 的 ${near90} 支）`);

console.log(`\n前 ${TOP} 名（现在下发的就是这批）：`);
console.log('  #  强度      强度得分   差额得分（性价比）  账面/补金');
for (const [i, r] of rows.slice(0, TOP).entries()) {
  console.log(`  ${String(i + 1).padStart(2)}  ${fmt(r.strength).padStart(8)}`
    + `  ${fmt(r.strengthPct, 1).padStart(7)}`
    + `  ${fmt(r.gapPct, 1).padStart(14)}`
    + `     ${String(r.gold).padStart(3)}/${r.gap}`);
}

// ---- 换几种「下限锚点」看前 N 名的强度得分会摊开成什么样 -------------------------
console.log('\n如果下限换成池内分位数（上限仍取 max）：');
console.log('  锚点        下限值      前 15 名的强度得分');
for (const p of [0, 0.1, 0.25, 0.5, 0.75]) {
  const base = pct(strengths, p);
  const scores = rows.slice(0, TOP).map((r) => 100 * Math.max(0, (r.strength - base) / (hi - base)));
  const spread = Math.max(...scores) - Math.min(...scores);
  console.log(`  p${String(Math.round(p * 100)).padStart(2)}  ${fmt(base).padStart(10)}`
    + `   ${scores.map((s) => fmt(s, 0).padStart(4)).join(' ')}`
    + `   跨度 ${fmt(spread, 1)}`);
}
console.log('\n（跨度越大 = 强度这一栏越能拉开名次；上限恒为池内最大）');

// ---- 「强度和成本息息相关」到底有多相关（用户 2026-10-12 的追问）------------------
//
// 注意要分**两段**看：整池里弱队确实等于便宜队（相关性强），但**头部**（能上榜的那批）
// 未必 —— 数据集里「最便宜的满分」和「最贵的满分」拿的是同一个表现分，金数不进强度。
const pearson = (xs, ys) => {
  const n = xs.length;
  if (n < 3) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx; const dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : NaN;
};
const corr = (subset, label) => {
  const st = subset.map((r) => r.strength);
  const gd = subset.map((r) => r.gold);
  const gp = subset.map((r) => r.gap);
  console.log(`  ${label.padEnd(26)} n=${String(subset.length).padStart(4)}`
    + `  r(强度, 账面金数) = ${fmt(pearson(st, gd), 2).padStart(6)}`
    + `  r(强度, 补金差额) = ${fmt(pearson(st, gp), 2).padStart(6)}`
    + `  r(账面金数, 补金差额) = ${fmt(pearson(gd, gp), 2).padStart(6)}`);
};
console.log('\n「强度和成本息息相关」实测（皮尔逊相关系数）：');
corr(rows, '整池');
corr(rows.filter((r) => r.strength >= 1200), '强度 ≥ 1200');
corr(rows.filter((r) => r.strength >= 1300), '强度 ≥ 1300');
corr(rows.slice(0, 20), '按总分前 20');
corr(rows.filter((r) => r.gold >= 9 && r.gold <= 16), '账面 9~16 金');

// 头部按账面金数分档，看强度是不是「越贵越强」
console.log('\n头部按账面金数分档（池内**强度 ≥ 1200** 的那批）：');
const band = rows.filter((r) => r.strength >= 1200);
const byGold = new Map();
for (const r of band) {
  if (!byGold.has(r.gold)) byGold.set(r.gold, []);
  byGold.get(r.gold).push(r.strength);
}
for (const g of [...byGold.keys()].sort((a, b) => a - b)) {
  const arr = byGold.get(g).sort((a, b) => b - a);
  console.log(`  ${String(g).padStart(2)} 金：${String(arr.length).padStart(2)} 支`
    + `  强度 ${fmt(arr[0], 0)}（最高）~ ${fmt(arr[arr.length - 1], 0)}（最低）`
    + `  中位 ${fmt(arr[Math.floor(arr.length / 2)], 0)}`);
}


// ---- 关键问题：换锚点之后，**强度旋钮真的有用了吗** ------------------------------
// 现状：前几名强度都是 99.x，把它从 1:1 拧到 3:1 或 1:3 前两名都不动 —— 因为旋钮乘的是
// 一个「大家都接近 100」的分。这里对每种锚点各算一遍 3:1 / 1:1 / 1:3 的前 5 名。
console.log('\n强度旋钮在各锚点下的效果（前 5 名会不会换人）：');
for (const p of [0, 0.5, 0.75]) {
  const base = pct(strengths, p);
  const spOf = new Map(rows.map((r) => [r.key,
    100 * Math.max(0, Math.min(1, (r.strength - base) / (hi - base)))]));
  console.log(`\n  ── 锚点 ${p === 0 ? 'min（现状）' : `p${Math.round(p * 100)}`}（下限 ${fmt(base, 0)}）`);
  for (const [ws, wc] of [[3, 1], [1, 1], [1, 3]]) {
    const ranked = rows.map((r) => ({ r, sp: spOf.get(r.key) }))
      .map((x) => ({ ...x, total: (ws * x.sp + wc * x.r.gapPct) / (ws + wc) }))
      .sort((a, b) => b.total - a.total);
    console.log(`    强度 ${ws} : 性价比 ${wc} ⇒ `
      + ranked.slice(0, 5).map((x) => `${cn(x.r.members[0].char)}队(${fmt(x.total, 1)})`).join(' > '));
  }
}


// ---- 换锚点之后**名次会怎么变**（差额那一侧不动，只重算强度得分与总分）---------------
console.log('\n按新锚点重排名次（强度得分 × 0.5 + 差额得分 × 0.5，差额得分沿用现口径）：');
for (const p of [0, 0.25, 0.5, 0.75]) {
  const base = pct(strengths, p);
  const ranked = rows.map((r) => ({
    r,
    sp: 100 * Math.max(0, Math.min(1, (r.strength - base) / (hi - base))),
  })).map((x) => ({ ...x, total: 0.5 * x.sp + 0.5 * x.r.gapPct }))
    .sort((a, b) => b.total - a.total);
  const tag = p === 0 ? 'p 0（现状）' : `p${String(Math.round(p * 100)).padStart(2)}      `;
  console.log(`\n  ── 锚点 ${tag}（下限 ${fmt(base, 0)}）`);
  for (const [i, x] of ranked.slice(0, 8).entries()) {
    const names = x.r.members.map((m) => cn(m.char)).join('/');
    console.log(`    #${String(i + 1).padStart(2)} ${fmt(x.total, 1).padStart(5)}`
      + ` = 强度 ${fmt(x.sp, 1).padStart(5)} / 差额 ${fmt(x.r.gapPct, 1).padStart(4)}`
      + `  ${String(x.r.gold).padStart(2)}金/${x.r.gap}  ${names}`);
  }
}
