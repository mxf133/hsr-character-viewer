// 验「隐金减免的两处来源必须同源」——这是 2026-10-11 第七轮修的那个不一致。
//
// 背景：队伍卡片上「账面 N 金（含隐金减免 M 金）」用的减免，与补金顺序里**逐笔 cost**
// 用的减免，必须是**同一套设置**。改前前者传 `undefined`（→ 模块级状态
// `activeHiddenCostsState`）、后者传 `conclusion?.hiddenCosts`（→ HTTP 载荷里的那份）。
// 浏览器里载荷带着 5 项全勾，而模块级状态在**页面重新加载后没被初始化**（界面只在用户
// 勾选时才 `setHiddenCosts`），于是两者不一致：某张卡不写减免，但它的补金项被整批过滤成空。
//
// ⚠️ `buildConclusion` **不回填** `hiddenCosts`（传进去之后 `concl.hiddenCosts` 仍是
// `undefined`），而真实浏览器拿到的是 **HTTP 载荷**、里面是有这个字段的。所以这里显式
// 把它挂回去，模拟浏览器的那份对象。
//
//   node tools/_probe-zero-fill.mjs
import { AccountStore } from '../src/server/store.js';
import {
  DEFAULT_HIDDEN_COSTS, buildConclusion, eidolonsOf, lightConeRanksOf, hiddenReductionOf,
  setHiddenCosts, teamPlan, ownedCharacters, VERSION_WINDOW,
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
const nameOf = (r) => r.members.map((m) => cn(m.char)).join('/');

const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const build = () => buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  hiddenCosts: DEFAULT_HIDDEN_COSTS,
});

console.log(`账号 ${role.nickname}\n`);

/** 两种「模块级状态」下各跑一遍 —— 浏览器里它可能是**没初始化过**的默认值。 */
for (const [label, moduleState] of [
  ['模块级状态 = 未初始化（浏览器重新加载后的真实情形）', null],
  ['模块级状态 = 全勾（用户在窗口里勾过之后）', DEFAULT_HIDDEN_COSTS],
]) {
  setHiddenCosts(moduleState);
  const concl = build();
  // 模拟 HTTP 载荷：把 hiddenCosts 挂回去（`buildConclusion` 不回填这个字段）。
  concl.hiddenCosts = DEFAULT_HIDDEN_COSTS;
  const plan = teamPlan(concl, acct, { availability, maxRows: 100000 });

  let mismatch = 0;
  let emptyList = 0;
  for (const r of plan.rows) {
    const cut = hiddenReductionOf(r.members, availability, concl.hiddenCosts, 'dataset').team;
    if (Number(r.hiddenCut) !== Number(cut)) {
      mismatch += 1;
      if (mismatch <= 3) {
        console.log(`  ✗ ${nameOf(r)}：row.hiddenCut = ${r.hiddenCut}，按载荷复算 = ${cut}`);
      }
    }
    const shown = r.fill.filter((it) => Number(it.cost ?? it.pulls) > 0).length;
    if (shown === 0) emptyList += 1;
  }
  console.log(`${label}`);
  console.log(`  候选池 ${plan.pool} 支｜账面减免与载荷复算**不一致**的：${mismatch} 支`
    + `　${mismatch === 0 ? '✓ 同源' : '✗ 不同源（这就是那个 bug）'}`);
  console.log(`  补金顺序会被过滤成空的队伍：${emptyList} 支`
    + `（这几支的账面**会**写「含隐金减免 N 金」，所以不是渲染丢了）`);
  for (const r of plan.rows.filter((x) => x.fill.every((it) => Number(it.cost ?? it.pulls) <= 0))) {
    console.log(`    · ${nameOf(r)}｜账面 ${r.displayGold} 金（减 ${r.hiddenCut}）｜补金 ${r.gap} 金`
      + `｜逐笔 ${r.fill.map((it) => `${cn(it.name)} 原价${it.pulls}→cost${it.cost}`).join('、')}`);
  }
  console.log('');
}

// ⚠️ 顺带记录一个**设计层面**的现象（不是 bug，是用户第 6 条要的效果）：
// 上表里那支队「补金 2 金」但一条都列不出来 —— 因为那两笔（Archer E1 / 银狼 E1）
// 各自被自己成员的减免盖满（减 2 / 减 3 > 原价 1），逐笔 cost 归 0 就被隐藏了。
// 而「补金 N 金」来自 `marginalCostOf`，**不看隐金减免**，所以两个数会并存。
console.log('（备注：补金 N 金 来自 marginalCostOf，不看隐金减免；逐笔 cost 看减免。'
  + '所以「补金 2 金 + 空列表」是用户第 6 条要的效果，不是渲染丢了。）');
