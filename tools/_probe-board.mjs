// ⚠️ 口径变更：本探针写于旧口径（①=总榜分含金数项归一化）；v4.6.87 起 ① 换成**纯强度**
// （`rows[].strengthPct`，原始值 `rows[].strength`），这里已经跟着改。
//
// 打印当前算法下的**前 N 名**（含补金顺序）—— 给 README / 文档抄录用，避免手抄出错。
//
//   node tools/_probe-board.mjs [--account=1] [--rows=10] [--hidden] [--w=aaPl=10,aa=0.1]
import { AccountStore } from '../src/server/store.js';
import {
  DEFAULT_HIDDEN_COSTS, SCORING, buildConclusion, eidolonsOf, lightConeRanksOf,
  setHiddenCosts, teamPlan, ownedCharacters, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : d;
};
const flag = (n) => process.argv.includes(`--${n}`);
const ACC = Math.max(1, Number(arg('account', '1')) || 1);
const ROWS = Math.max(1, Math.min(40, Number(arg('rows', '10')) || 10));

const weights = {};
for (const pair of String(arg('w', '')).split(',').filter(Boolean)) {
  const i = pair.lastIndexOf('=');
  if (i > 0) weights[pair.slice(0, i)] = Number(pair.slice(i + 1));
}
if (Object.keys(weights).length) {
  SCORING.frontierWeightOverride = { key: JSON.stringify(weights), value: weights };
}
const hidden = flag('hidden') ? DEFAULT_HIDDEN_COSTS : null;
if (flag('hidden')) setHiddenCosts(DEFAULT_HIDDEN_COSTS);

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

const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const concl = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  ...(hidden ? { hiddenCosts: hidden } : {}),
});
const keep = SCORING.teamPlanMaxRows;
SCORING.teamPlanMaxRows = ROWS;
const plan = teamPlan(concl, acct, { availability });
SCORING.teamPlanMaxRows = keep;

console.log(`账号 ${ACC} ${role.nickname}｜隐金=${hidden ? '全勾' : '不减'}`
  + `${Object.keys(weights).length ? '｜自定义权重' : '｜默认权重'}`);
console.log(`候选池 ${plan.pool} 支（去重 ${plan.poolAll}）· ① 刻度 ${plan.strengthLo.toFixed(1)}~${plan.strengthHi.toFixed(1)}`
  + ` · ② 封顶 ${plan.gapMax} 金（p${Math.round(plan.gapCapPct * 100)}）`
  + ` · ② 归 0 的 ${plan.rows.filter((r) => r.gapPct === 0).length}/${plan.rows.length}\n`);
plan.rows.forEach((r, i) => {
  console.log(`| ${i + 1} | ${r.total.toFixed(1)} | ${r.strengthPct.toFixed(1)} | ${r.gapPct.toFixed(1)}`
    + ` | ${r.gap} 金 | ${r.members.map((m) => cn(m.char)).join('/')} |`);
  console.log(`   补金顺序：${r.fill.map((it) => `${cn(it.name)}·${it.target || ''}（${it.pulls}金）`).join(' → ') || '（无）'}`);
});
