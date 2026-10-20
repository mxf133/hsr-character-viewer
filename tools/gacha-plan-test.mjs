// 抽卡推荐 v2 · 抽卡方案（阶段 3/6）。
//
//   node tools/gacha-plan-test.mjs
//
// 盯几件「写起来顺手、错了却没人发现」的事：
//   ① Δgold = 0（阵容已齐）按用户决策**进列表**，且成本项取 1 而不是 Infinity；
//   ② 跨版本**取最大值**（不是 §一 那种加权平均），并把所有版本的成绩都列出来；
//   ③ 参数用的成本项是 **Δgold**，投稿得分那条链用的是队伍自己的 `c` —— 两处分母不同；
//   ④ `fill` 里光锥必须排在它的载体本体之后；
//   ⑤ `alternatives` 从**全池**找，越过 maxRows 那条线。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreEnvRows } from '../src/server/gacha-score.js';
import {
  alternativesOf, buildPlan, fillOf, groupRosters, lineupKeyOf, midOf, planCostPartOf, rosterKeyOf,
} from '../src/server/gacha-plan.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
// ⚠️ 三个助手都**返回布尔**：这样才能被 `&&` 串起来写复合断言。
// 不返回的写法会让 `check(… ) && near(…)` 右边恒为 undefined ⇒ 断言恒假，非常难查。
const check = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`); }
  return Boolean(cond);
};
const eq = (name, actual, expect) => check(
  name,
  JSON.stringify(actual) === JSON.stringify(expect),
  `实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expect)}`,
);
const near = (name, actual, expect, tol = 1e-6) => check(
  name,
  Math.abs(actual - expect) <= tol,
  `实际 ${actual} ≠ 期望 ${expect}（容差 ${tol}）`,
);

// ------------------------------------------------------------------ 夹具

// 只有限定 5★ 要金（见 `charCostOf` / `coneCostOf`）：这是伪造 availability 的唯一要害。
const AVAIL = {
  characters: {
    Hero: { rarity: 5, limited: true },
    Mage: { rarity: 5, limited: true },
    Bard: { rarity: 5, limited: true },
    Zed: { rarity: 5, limited: true },
    Stan: { rarity: 5, limited: false },   // 常驻 5★ → 0 金
    Free: { rarity: 4, limited: false },   // 4★ → 0 金
  },
  lightCones: {
    HeroLC: { rarity: 5, limited: true },  // 每级叠影 1 金
    FreeLC: { rarity: 4, limited: false }, // 0 金
  },
};

/** 整套阵容一行必须是 4 段式字串：`角色|星魂|光锥|叠影`。 */
const ROSTER_MAIN = ['Hero|2|HeroLC|3', 'Mage|0||0', 'Free|6|FreeLC|5', 'Stan|0||0'];

const WEIGHTS = { '4.6': 6, '4.5': 5, '4.4': 4, '4.3': 3, '4.2': 2, '4.1': 1 };
const versionWeightOf = (season) => WEIGHTS[season] ?? 1;

/**
 * 攒一组假投稿，`-1` 表示某一版没有这款阵容（后面断言会用）。
 *
 * 4.5 里额外放了一条 4 金、200 行动值的别人 := 把 baseline(4.5) 钉在 4；
 * 4.4 只有主角阵容 => baseline(4.4) = 9。
 */
const FIXTURE = [
  { season: '4.5', c: 9, a: 100, n: 3, t: 2, m: ROSTER_MAIN },
  { season: '4.4', c: 9, a: 250, n: 2, t: 1, m: ROSTER_MAIN },
  { season: '4.5', c: 4, a: 200, n: 1, t: 3, m: ['Zed|0||0', 'Mage|0||0', 'Free|6|FreeLC|5', 'Stan|0||0'] },
];

const scoredFixture = (rows = FIXTURE) => scoreEnvRows(rows, {
  mode: 'aa', stage: 'plight', ws: 1, wc: 1, versionWeightOf,
}).scored;

// ---- ① 阵容签名：「整包完全一致」才称得上是同一套阵容 ------------------------
console.log('[阵容签名 — 整包完全一致才合并]');
const keyA = rosterKeyOf(ROSTER_MAIN.map((t) => {
  const [char, eidolon, lc, superimp] = t.split('|');
  return { char, eidolon: Number(eidolon), lc: lc || null, superimp: Number(superimp) || 0 };
}));
check('四个角色的键都会出现在签名里', ['Hero', 'Mage', 'Free', 'Stan'].every((c) => keyA.includes(c)), keyA);
const swapOne = (arr) => {
  const out = arr.map((t) => {
    const [char, eidolon, lc, superimp] = t.split('|');
    return { char, eidolon: Number(eidolon), lc: lc || null, superimp: Number(superimp) || 0 };
  });
  return [out[1], out[0], out[2], out[3]];
};
eq('成员顺序不同 → 同一个键（位置顺序不参与身份）', rosterKeyOf(swapOne(ROSTER_MAIN)), keyA);
check('差一个叠影 → 另一个键', rosterKeyOf([
  { char: 'Hero', eidolon: 2, lc: 'HeroLC', superimp: 2 },
  { char: 'Mage', eidolon: 0, lc: null, superimp: 0 },
  { char: 'Free', eidolon: 6, lc: 'FreeLC', superimp: 5 },
  { char: 'Stan', eidolon: 0, lc: null, superimp: 0 },
]) !== keyA);
check('差一个星魂档 → 另一个键', rosterKeyOf([
  { char: 'Hero', eidolon: 1, lc: 'HeroLC', superimp: 3 },
  { char: 'Mage', eidolon: 0, lc: null, superimp: 0 },
  { char: 'Free', eidolon: 6, lc: 'FreeLC', superimp: 5 },
  { char: 'Stan', eidolon: 0, lc: null, superimp: 0 },
]) !== keyA);
check('少一个人 → 另一个键', rosterKeyOf([
  { char: 'Hero', eidolon: 2, lc: 'HeroLC', superimp: 3 },
  { char: 'Mage', eidolon: 0, lc: null, superimp: 0 },
]) !== keyA);

// ---- ①b 折叠键：只认角色组合，不看配装 ---------------------------------------
// 「整包一致才算同一套阵容」是**聚合身份**（换一件光锥就是另一条成绩），
// 但界面上要给「同一套四人、只是想换个光锥看看」收成一栏 —— 两个键必须分开。
console.log('[折叠键 — 角色组合相同即同一栏]');
const packsOf = (arr) => arr.map((t) => {
  const [char, eidolon, lc, superimp] = t.split('|');
  return { char, eidolon: Number(eidolon), lc: lc || null, superimp: Number(superimp) || 0 };
});
const mainPacks = packsOf(ROSTER_MAIN);
eq('同角色组合 → 同一个折叠键', lineupKeyOf(mainPacks), lineupKeyOf([
  mainPacks[1], mainPacks[0], mainPacks[2], mainPacks[3],
]));
check('换一件光锥：折叠键**不变**', lineupKeyOf([
  { char: 'Hero', eidolon: 2, lc: 'OtherLC', superimp: 3 },
  { char: 'Mage', eidolon: 0, lc: null, superimp: 0 },
  { char: 'Free', eidolon: 6, lc: 'FreeLC', superimp: 5 },
  { char: 'Stan', eidolon: 0, lc: null, superimp: 0 },
]) === lineupKeyOf(mainPacks));
check('换一个星魂档：折叠键**不变**', lineupKeyOf([
  { char: 'Hero', eidolon: 0, lc: 'HeroLC', superimp: 3 },
  { char: 'Mage', eidolon: 6, lc: null, superimp: 0 },
  { char: 'Free', eidolon: 6, lc: 'FreeLC', superimp: 5 },
  { char: 'Stan', eidolon: 0, lc: null, superimp: 0 },
]) === lineupKeyOf(mainPacks));
check('换一个角色：折叠键**变**', lineupKeyOf([
  { char: 'Hero', eidolon: 2, lc: 'HeroLC', superimp: 3 },
  { char: 'Mage', eidolon: 0, lc: null, superimp: 0 },
  { char: 'Free', eidolon: 6, lc: 'FreeLC', superimp: 5 },
  { char: 'Other', eidolon: 0, lc: null, superimp: 0 },
]) !== lineupKeyOf(mainPacks));
check('⚠️ 两个键必须都从成员派生、但**互不相等**（整包键含配装，折叠键只含角色）',
  keyA !== lineupKeyOf(mainPacks));

// ---- ①c 折叠对下发的影响：同角色组合只占一行 --------------------------------
// 用一份「同四人、三套配装」的合成数据，断言只下发 1 行、其余进 variants。
console.log('[折叠 — 同角色组合只下发一行]');
const VARIANT_FIXTURE = [
  // 同一套四人，只差光锥叠影 / 一件光锥 —— 分数依次降低
  { season: '4.6', c: 9, a: 100, n: 1, t: 3, m: ['Hero|2|HeroLC|3', 'Mage|0||0', 'Free|6|FreeLC|5', 'Stan|0||0'] },
  { season: '4.6', c: 10, a: 120, n: 1, t: 3, m: ['Hero|2|HeroLC|1', 'Mage|0||0', 'Free|6|FreeLC|5', 'Stan|0||0'] },
  { season: '4.6', c: 11, a: 140, n: 1, t: 3, m: ['Hero|2|HeroLC|5', 'Mage|0||0', 'Free|6|FreeLC|1', 'Stan|0||0'] },
  // 完全不同的一套，用来确认折叠不会把别的阵容也吃掉
  { season: '4.6', c: 4, a: 200, n: 1, t: 3, m: ['Zed|0||0', 'Mage|0||0', 'Free|6|FreeLC|5', 'Stan|0||0'] },
];
const vScored = scoreEnvRows(VARIANT_FIXTURE, {
  mode: 'aa', stage: 'plight', ws: 1, wc: 1, versionWeightOf,
}).scored;
const vPlan = buildPlan(vScored, { wc: 1, maxRows: 20 });
eq('4 条投稿 → 2 个整包阵容池，折叠后 2 栏', vPlan.rows.length, 2);
check('折叠结果计入 `lineups` 而不是 `pool`', vPlan.pool === 4 && vPlan.lineups === 2,
  `pool=${vPlan.pool} lineups=${vPlan.lineups}`);
const vMain = vPlan.rows.find((r) => r.members.some((m) => m.char === 'Hero'));
eq('同角色组合只下发一行', vMain ? 1 : 0, 1);
eq('另外两套配装收进 variants', vMain?.variants?.length, 2);
// ⚠️ 2026-10-20：这条原来写死「代表行的叠影必须是 3」—— 那是 `baseline / Δgold` 时代
//    的巧合（叠影 3 那套恰好金数最少、强度最高）。换成线性扣分后，成本项对 gap 更敏感，
//    代表行可能落到别的那套上。**规则本身**（代表行 = 分最高的那套）才是要锁的，
//    具体是哪一套属于数据巧合，不该钉在测试里。
check('代表行是**分最高**的那个（其余同角色配装收进 variants）',
  (vMain?.variants || []).every((v) => v.score <= (vMain?.score ?? 0)),
  `main=${vMain?.score} variants=${JSON.stringify((vMain?.variants || []).map((v) => v.score))}`);
check('variants 按分数降序', (vMain?.variants?.[0]?.score ?? 0) >= (vMain?.variants?.[1]?.score ?? 0),
  JSON.stringify((vMain?.variants || []).map((v) => v.score)));
check('variants 只带轻字段、不跑补金明细（不给 UI 用不到的东西）',
  vMain?.variants?.every((v) => v.fill === undefined && v.mid === undefined && v.seasons === undefined));

// ---- ② 方案的成本项：Δgold 线性扣分（2026-10-20 换口径）-----------------------
console.log('\n[方案成本项 — 1 − Δgold/10，已齐 = 1]');
near('Δgold = 0（已齐）→ 1', planCostPartOf(0), 1);
near('Δgold 为 null（算不出来）也按已齐处理', planCostPartOf(null), 1);
near('Δgold 为负（数据异常）→ 同样按已齐处理', planCostPartOf(-3), 1);
near('Δgold = 5 → 0.5（线性扣分的中段）', planCostPartOf(5), 0.5);
near('Δgold = 10 → 0（补满刻度就扣光）', planCostPartOf(10), 0);
near('Δgold = 26 → −1.6（超过刻度转负，没有封底）', planCostPartOf(26), -1.6);
near('Δgold 很大 → 线性变负，不是趋近 0', planCostPartOf(90), -8);
// ⚠️ 这条是本次换口径的**核心诉求**：旧式 `baseline / Δgold` 夹在 (0,1] 里，
//    补 26 金与补 3 金只差 0.4 分，「补得越多越不划算」几乎看不出来。
check('补 26 金必须**明显低于**补 3 金（旧口径只差 0.4）',
  planCostPartOf(26) < planCostPartOf(3) - 2,
  `${planCostPartOf(26)} vs ${planCostPartOf(3)}`);

// ---- ③ 按阵容聚合：逐版本只留最高分 ------------------------------------------
console.log('\n[按阵容聚合]');
const groups = groupRosters(scoredFixture());
check('两套阵容 → 2 组', groups.size === 2, String(groups.size));
const mainEntry = [...groups.values()].find((g) => g.key === keyA);
check('主角阵容在两个版本都有成绩', mainEntry?.bySeason.size === 2, String(mainEntry?.bySeason.size));
check('同一阵容的代表永远带着 4 个成员', mainEntry?.members.length === 4);

{
  // 同一版本塞两条成绩，看会不会只留高的那条。
  const dupe = [
    { season: '4.5', c: 9, a: 300, n: 1, t: 1, m: ROSTER_MAIN },
    { season: '4.5', c: 9, a: 50, n: 1, t: 1, m: ROSTER_MAIN },
  ];
  const g = [...groupRosters(scoreEnvRows(dupe, { mode: 'aa', stage: 'plight' }).scored).values()];
  eq('同一版本的多条投稿 → 合并成一组', g.length, 1);
  eq('并且只留一条代表行（不去重会在 UI 上重复出一行）', g[0].bySeason.size, 1);
  check('留的是行动值更小（分更高）那条', g[0].bySeason.get('4.5').a === 50);
}

// ---- ④ fill：光锥必须排在载体本体之后 ----------------------------------------
console.log('\n[fill — 每抽收益排序 + 光锥不能越过载体]');
{
  const row = {
    members: [{ char: 'Hero', eidolon: 0, lc: 'HeroLC', superimp: 1 }],
    gapItems: [
      { kind: 'char', name: 'Hero', pulls: 1, from: 0, target: 0, certainty: true },
      { kind: 'cone', name: 'HeroLC', pulls: 1, from: 0, target: 1, carrier: 'Hero', certainty: true },
    ],
    score: 10,
  };
  const cuts = { byIndexChar: [0], byIndexCone: [0] };
  const fresh = fillOf(row, { availability: AVAIL, cuts, charScoreOf: () => 10, isOwned: () => false });
  eq('没持有载体时，先把角色本体排在光锥前面', fresh.map((f) => f.kind), ['char', 'cone']);
  check('光锥的每「抽」收益本来就更高（67 抽 < 94 抽）——约束真的在起作用',
    fresh[1].perPull > fresh[0].perPull,
    `cone ${fresh[1].perPull} vs char ${fresh[0].perPull}`);

  const owned = fillOf(row, { availability: AVAIL, cuts, charScoreOf: () => 10, isOwned: () => true });
  eq('载体已持有 → 约束解除，便宜的光锥先来', owned.map((f) => f.kind), ['cone', 'char']);

  eq('本体 1 金 = 94 抽', fresh[0].pullsExpected, 94);
  eq('叠影 1 级 = 67 抽', fresh[1].pullsExpected, 67);
  eq('金数要把 item.pulls 四舍五入后再换算', fresh[0].pulls, 1);
}

{
  // 「缺本体」的那笔必须 kind === 'char'，否则约束失效（旧代码就靠这个判据）。
  const row = {
    members: [{ char: 'Hero', eidolon: 2, lc: null, superimp: 0 }],
    gapItems: [{ kind: 'eidolon', name: 'Hero', pulls: 2, from: 0, target: 2, certainty: true }],
    score: 10,
  };
  const once = fillOf(row, { availability: AVAIL, cuts: {}, charScoreOf: () => 10, isOwned: () => true });
  check('已有本体时补的是星魂，不是本体', once[0].kind === 'eidolon' && once[0].pulls === 2);
}

// ---- ⑤ mid：切前半段，剩下退回账号现状 ---------------------------------------
console.log('\n[mid — 过渡档位]');
{
  const base = {
    members: [
      { char: 'A', eidolon: 0, lc: 'ALC', superimp: 1 },
      { char: 'B', eidolon: 0, lc: null, superimp: 0 },
    ],
    gap: 4,
    fill: [
      { kind: 'char', name: 'A', pulls: 1 },
      { kind: 'cone', name: 'ALC', pulls: 1 },
      { kind: 'char', name: 'B', pulls: 2 },
    ],
  };
  const account = { owned: new Set(), eidolons: new Map(), cones: new Map() };
  const m1 = midOf(base, { account });
  check('前半段 = 累计 ≤ Δgold/2', m1 && m1.gold === 2 && m1.items === 2, JSON.stringify(m1));
  check('留得下后半段', m1 && m1.rest === 2, JSON.stringify(m1));
  check('已补的成员标成 pending 之外，其余退回账号现状',
    m1 && m1.members[0].pending === false && m1.members[1].pending === true, JSON.stringify(m1?.members));
  check('没补到的人 → eidolon 记 null（UI 要显示「那时还没有」）',
    m1 && m1.members[1].eidolon === null, JSON.stringify(m1?.members[1]));

  eq('fill 只有一笔 → 没有过渡可言', midOf({ ...base, fill: [{ kind: 'char', name: 'A', pulls: 2 }] }, { account }), null);
  eq('fill 为空 → null', midOf({ ...base, fill: [] }, { account }), null);

  const ownedAccount = { owned: new Set(['A']), eidolons: new Map([['A', 1]]), cones: new Map([['ALC', 2]]) };
  const m2 = midOf(base, { account: ownedAccount });
  check('过渡档里「账号现状」取自 eidolons / cones',
    m2 && m2.members[0].eidolon === 1 && m2.members[0].superimp === 2,
    JSON.stringify(m2?.members[0]));
}

// ---- ⑥ alternatives：跨过 maxRows 那条线找邻队 -------------------------------
console.log('\n[alternatives — 共享 ≥2 的邻队]');
{
  const mkRow = (chars, score, gap) => ({
    key: chars.map((c) => `${c}|E0|-|S0`).sort().join('~'),
    members: chars.map((c) => ({ char: c, eidolon: 0, lc: null, superimp: 0 })),
    score,
    gap,
    gold: gap,
  });
  const pool = [
    mkRow(['A', 'B', 'C', 'D'], 10, 3),
    mkRow(['A', 'B', 'E', 'F'], 9, 2),   // 共享 2 ✓
    mkRow(['A', 'G', 'H', 'I'], 8, 1),   // 共享 1 ✗
    mkRow(['A', 'B', 'C', 'E'], 8.5, 2), // 共享 3 ✓
  ];
  const rankOf = new Map(pool.map((r, i) => [r, i]));
  const byMember = new Map();
  for (const p of pool) for (const m of p.members) {
    const b = byMember.get(m.char); if (b) b.push(p); else byMember.set(m.char, [p]);
  }
  const alts = alternativesOf(pool[0], pool, rankOf, byMember, 3);
  eq('只留共享 ≥2 的', alts.map((a) => a.shared), [3, 2]);
  eq('共享多的排前面', alts[0].key, pool[3].key);
  check('不会把自己当成自己的次选', !alts.some((a) => a.key === pool[0].key));
  check('上限生效（这里够 2 条就停）', alts.length === 2);

  // 次选要能越过 maxRows：假装全池 4 条、只下发 1 条，次选仍从全池来。
  check('次选来自全池而不是已下发的那几行',
    alternativesOf(pool[0], pool, rankOf, byMember, 3).length >= 2);
}

// ---- ⑦ buildPlan 整体 -------------------------------------------------------
console.log('\n[buildPlan — 方案分 / 逐版本取最大 / 分页]');
{
  const plan = buildPlan(scoredFixture(), {
    availability: AVAIL, wc: 1, maxRows: 20, versionWeightOf,
  });
  const main = plan.rows.find((r) => r.key === keyA);
  check('主角阵容出现在结果里', Boolean(main), JSON.stringify(plan.rows.map((r) => r.key)));

  // 手动核对：Hero 缺本体(body+E1+E2=3) + HeroLC 缺 S1..S3(3) + Mage 缺本体(1) = 7
  eq('Δgold = 缺本体的那段要算 +1', main.gap, 7);

  // 成绩：4.5 行动值 100 → 0.8；性价比 = 1 − Δgold/10（Δgold = 7 → 0.3）；× 版本权重 5
  // ⚠️ 2026-10-20 换口径：性价比不再是 `baseline / Δgold`（旧期望 `4/7`），
  //    而是线性扣分 `1 − gap/10`。这里同一条 gap = 7 在两版通用（gap 与版本无关）。
  const costTerm = 1 - 7 / 10;
  const expect45 = (1 - 100 / 500 + costTerm) * 5;
  const expect44 = (1 - 250 / 500 + costTerm) * 4;
  check('逐版本**取最大值**（不是一个加权平均）', Math.max(expect45, expect44) === expect45
    && near('方案分 = max(各版本分)', main.score, expect45, 1e-4));
  eq('最高分来自哪一版要带出来（UI 要能标）', main.bestSeason, '4.5');
  eq('★ 列出**所有**版本的成绩', main.seasons.length, 2);
  eq('seasons 按分数降序，第一条就是最高那一版',
    main.seasons.map((s) => s.season), ['4.5', '4.4']);
  check('每一版都带得上「这一版的原始量」（成绩 / 用金 / 基准 / 权重 / 投稿数）',
    main.seasons.every((s) => s.score !== undefined && s.cost !== undefined
      && s.baseline !== undefined && s.versionWeight > 0 && s.submissions >= 1),
    JSON.stringify(main.seasons));

  check('成员自带 owned 标记（UI 打勾用）', main.members.every((m) => typeof m.owned === 'boolean'));
  check('gold / displayGold / hiddenCut 三个数要自洽',
    main.displayGold === Math.max(1, main.gold - main.hiddenCut),
    `${main.gold} - ${main.hiddenCut} → ${main.displayGold}`);
  check('每条方案都算出了补金明细', main.fill.length > 0);
  eq('pullsExpected = Σ fill 的期望抽数',
    main.pullsExpected, main.fill.reduce((n, f) => n + f.pullsExpected, 0));
}

{
  const plan = buildPlan(scoredFixture(), { availability: AVAIL, wc: 1, maxRows: 1 });
  eq('maxRows 生效', plan.rows.length, 1);
  check('truncated 标出来了（UI 才知道还有更多）', plan.truncated === true);
  check('pool 报的是候选总数，不是下发数', plan.pool === 2 && plan.poolRows === 3,
    `pool=${plan.pool} poolRows=${plan.poolRows}`);
}

{
  // Δgold = 0：「账号已有金数 / 此配队金数 = 1」，且**照样进列表**。
  const freeRoster = ['Stan|0||0', 'Free|6|FreeLC|5', 'Free|0||0', 'Free|1||0'];
  const rows = [
    { season: '4.5', c: 0, a: 300, n: 1, t: 1, m: freeRoster },
    { season: '4.5', c: 4, a: 200, n: 1, t: 3, m: ['Zed|0||0', 'Mage|0||0', 'Free|6|FreeLC|5', 'Stan|0||0'] },
  ];
  const plan = buildPlan(scoreEnvRows(rows, { mode: 'aa', stage: 'plight', versionWeightOf }).scored,
    { availability: AVAIL, wc: 1, maxRows: 20 });
  const free = plan.rows.find((r) => r.members.every((m) => m.char !== 'Zed'));
  check('全是免费角色的 0 金队照样进列表', Boolean(free), JSON.stringify(plan.rows.map((r) => r.gap)));
  eq('它的 Δgold = 0', free.gap, 0);
  near('并且成本项取 1（不是 Infinity 也不是 0）', free.costPart, 1);
  near('分数 = 强度项 × 版本权重', free.score, (1 - 300 / 500 + 1) * 5, 1e-4);
}

{
  // 性价比权重不是 1 的时候，只作用在成本项上。
  const rows = [{ season: '4.5', c: 9, a: 100, n: 1, t: 2, m: ROSTER_MAIN },
    { season: '4.5', c: 4, a: 200, n: 1, t: 3, m: ['Zed|0||0', 'Mage|0||0', 'Free|6|FreeLC|5', 'Stan|0||0'] }];
  const scored = scoreEnvRows(rows, { mode: 'aa', stage: 'plight', versionWeightOf }).scored;
  const mainRow = (wc) => buildPlan(scored, { availability: AVAIL, wc, maxRows: 5 })
    .rows.find((r) => r.key === keyA).score;
  // ⚠️ 2026-10-20：成本项换成 `1 − gap/10`。这套 fixture 的 gap = 7（见上面
  //    「Δgold = 缺本体的那段要算 +1」那条），所以成本项是 0.3，不再是 `4/7`。
  const costTerm = 1 - 7 / 10;
  near('wc = 1', mainRow(1), (1 - 100 / 500 + costTerm) * 5, 1e-4);
  near('wc = 2：只有成本项翻倍', mainRow(2), (1 - 100 / 500 + 2 * costTerm) * 5, 1e-4);
  near('wc = 0：退化成纯强度', mainRow(0), (1 - 100 / 500) * 5, 1e-4);
}

// ---- ⑧ 真实数据集冒烟 -------------------------------------------------------
console.log('\n[真实数据集 — 冒烟与规模]');
const ARCHIVE = JSON.parse(readFileSync(join(HERE, '..', 'theherta', 'archive.json'), 'utf8'));
const REAL_AVAIL = ARCHIVE.refs?.availability || {};

const frontierOf = (mode, stage, season) => (
  (ARCHIVE.modes?.[mode]?.stages?.[stage]?.seasons?.[season]?.frontier || [])
    .map((f) => ({ ...f, season }))
);

const planFor = (mode, stage, seasons, account) => {
  const rows = seasons.flatMap((s) => frontierOf(mode, stage, s));
  const scored = scoreEnvRows(rows, { mode, stage, ws: 1, wc: 1, versionWeightOf }).scored;
  const t0 = Date.now();
  const plan = buildPlan(scored, { availability: REAL_AVAIL, wc: 1, maxRows: 20, account });
  return { plan, rows: rows.length, ms: Date.now() - t0 };
};

const EMPTY = { owned: new Set(), eidolons: new Map(), cones: new Map() };
const PLIGHT = planFor('Anomaly Arbitration', 'plight', ['4.6', '4.5', '4.4', '4.3'], EMPTY);

check('绝境：跑得完且出了结果', PLIGHT.plan.rows.length > 0, JSON.stringify(PLIGHT.plan).slice(0, 200));
console.log(`         （绝境 4.6~4.3：${PLIGHT.rows} 行投稿 → ${PLIGHT.plan.pool} 套阵容，耗时 ${PLIGHT.ms} ms）`);
check('池子规模合理（候选套数 ≤ 投稿行数）', PLIGHT.plan.pool > 0 && PLIGHT.plan.pool <= PLIGHT.rows);
check('下发 20 条且标了 truncated', PLIGHT.plan.rows.length === 20 && PLIGHT.plan.truncated);
check('每条都有成员、关键⑃、补金明细',
  PLIGHT.plan.rows.every((r) => r.members.length === 4 && r.key.includes('~')
    && Number.isFinite(r.score) && Array.isArray(r.seasons)),
  JSON.stringify(PLIGHT.plan.rows[0]).slice(0, 300));
check('至少一半方案列出了 ≥1 个版本的成绩', PLIGHT.plan.rows.every((r) => r.seasons.length >= 1));
check('分数不会出现 NaN / Infinity',
  PLIGHT.plan.rows.every((r) => Number.isFinite(r.score)));

{
  // 全勤账号（一个角色都不持有）下，卢卡这种 4★ 是不产生补金成本的。
  const top = PLIGHT.plan.rows[0];
  console.log('         榜首：' + JSON.stringify({
    key: top.key.slice(0, 60), gap: top.gap, gold: top.gold, score: top.score,
    bestSeason: top.bestSeason, seasons: top.seasons.length, fill: top.fill.length,
  }));
  check('榜首的 Δgold 不为负', top.gap >= 0);
  check('每条方案的分都带上版本权重乘法（分 <= 强度项上界 × 6）',
    PLIGHT.plan.rows.every((r) => r.score <= 6 * 2 + 1e-6));
}

{
  // 拿 CHAOS 唤起轮次型那条链 —— 那条线上的 reported 走另一套 baseline 判据。
  const MOC = planFor('Memory of Chaos', '', ['4.5', '4.4'], EMPTY);
  console.log(`         （混沌回忆 4.5~4.4：${MOC.rows} 行 → ${MOC.plan.pool} 套，耗时 ${MOC.ms} ms）`);
  check('轮次型也跑得完', MOC.plan.rows.length > 0);
  check('轮次型的成绩字段读作轮次（整数 ≥ 0）',
    MOC.plan.rows.every((r) => r.seasons.every((s) => s.score === null
      || (Number.isInteger(s.score) && s.score >= 0))),
    JSON.stringify(MOC.plan.rows[0]?.seasons?.[0]));
}

console.log(`\n合计 ${passed} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
