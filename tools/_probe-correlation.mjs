// ⚠️ 口径变更：① 在 v4.6.87~v4.6.90 一度是**纯强度**（不含金数项）；v4.6.91 回到
// **总榜分含金数项**归一化（`rows[].strengthPct` 是池内位置，原始值 `rows[].teamScore`）。
//
// 核验：①（总榜分含金数项）与 ②（差额接近度）是不是**负相关** —— 如果是，那 0.5×① + 0.5×②
// （等权 = 默认抽卡权重 1:1）的水位就天然被压在中间，跟「算法坏了」无关。
//
//   node tools/_probe-correlation.mjs
import { AccountStore } from '../src/server/store.js';
import {
  DEFAULT_HIDDEN_COSTS, buildConclusion, eidolonsOf, lightConeRanksOf, teamPlan,
  ownedCharacters, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const index = await archiveIndex();
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
const SHOT_WEIGHTS = { 'aa|plight': 10, 'aa|': 0.1, 'as|': 0.1, 'moc|': 0.1, 'pf|': 0.1 };
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW, weights: SHOT_WEIGHTS });
const concl = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  hiddenCosts: DEFAULT_HIDDEN_COSTS,
});
const plan = teamPlan(concl, acct, { availability });
const rows = plan.rows;

const mean = (xs) => xs.reduce((n, v) => n + v, 0) / xs.length;
const xs = rows.map((r) => r.strengthPct); const ys = rows.map((r) => r.gapPct);
const mx = mean(xs); const my = mean(ys);
const cov = mean(rows.map((r) => (r.strengthPct - mx) * (r.gapPct - my)));
const sdx = Math.sqrt(mean(rows.map((r) => (r.strengthPct - mx) ** 2)));
const sdy = Math.sqrt(mean(rows.map((r) => (r.gapPct - my) ** 2)));
console.log(`账号 ${role.nickname}（截图那套权重 + 隐金全勾）`);
console.log(`展示 ${rows.length} 条 · ① 均值 ${mx.toFixed(1)} · ② 均值 ${my.toFixed(1)}`);
console.log(`**Pearson r(①, ②) = ${(cov / (sdx * sdy)).toFixed(3)}**`);
console.log('（接近 −1 = 越强的队越贵；接近 0 = 两个指标互不相关）\n');

const strong = rows.filter((r) => r.strengthPct >= 80);
const cheap = rows.filter((r) => r.gapPct >= 60);
console.log(`① ≥ 80 的 ${strong.length} 支：② 分别是 ${strong.map((r) => r.gapPct.toFixed(0)).join(', ')}`
  + `（均值 ${strong.length ? mean(strong.map((r) => r.gapPct)).toFixed(1) : '-'}）`);
console.log(`② ≥ 60 的 ${cheap.length} 支：① 分别是 ${cheap.map((r) => r.strengthPct.toFixed(0)).join(', ')}`
  + `（均值 ${cheap.length ? mean(cheap.map((r) => r.strengthPct)).toFixed(1) : '-'}）`);

const maxGapPct = Math.max(...ys);
console.log(`\n② 的实际最大值 = ${maxGapPct.toFixed(1)}（因为差额 0 金的队伍被剔除，`
  + `② = (1 − 1 ÷ ${plan.gapMax}) × 100 = ${(100 * (1 - 1 / plan.gapMax)).toFixed(1)} 是它的理论上界）`);
// 0.5/0.5 = 默认抽卡权重（1:1）；权重换成别的比例时这里要跟着换。
console.log(`所以「补金推荐分」的**理论上界** = 0.5 × 100 + 0.5 × ${(100 * (1 - 1 / plan.gapMax)).toFixed(1)}`
  + ` = ${(50 + 50 * (1 - 1 / plan.gapMax)).toFixed(1)}`);
const best = rows.reduce((a, b) => (b.total > a.total ? b : a));
console.log(`本批实际最高 = ${best.total.toFixed(1)}（①${best.strengthPct.toFixed(1)} + ②${best.gapPct.toFixed(1)}）`);
console.log(`\n如果两个指标真的能同时满分（①=100 且 ②=88.9），总分才是 94.4 —— `
  + `但那要求「最强的那支队正好也是最便宜的队」，本项目的数据里不存在这种队伍。`);
