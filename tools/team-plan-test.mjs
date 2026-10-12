// 队伍口径「抽卡方案」的回归套件（用户 2026-10-11 第 10 轮）。
//
// 与 `herta-test.mjs` 的分工：那边钉**整条评分链**（总榜 / 旧清单 / 隐金…），
// 这里只钉**新方案这一层**，而且分成两面：
//
//   A. 合成夹具（不碰数据集）：候选池去重、两个指标、归一化上下限、剔除 0 金、
//      补金顺序（每抽收益 + 载体约束）、三月七两命途。
//   B. 真数据 + 真服务（`createApp` 注入假 store，不经 DPAPI）：
//      `/conclusion` 的 `payload: 8` 与 `availability` / `frontierTiers` / `strength` 存在性 +
//      界面上那份 `teamPlan` 在真载荷上跑通、且差额与「服务端口径」一致。
//
//   node tools/team-plan-test.mjs
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.js';
import {
  DEFAULT_HIDDEN_COSTS, NO_HIDDEN_COSTS, SCORING, eidolonsOf, lightConeRanksOf,
  normalizeDrawWeights, ownedCharacters, setHiddenCosts, teamPlan, teamPoolUnits, unitPullsOf,
} from '../public/scripts/advice.js';

let passed = 0;
const fails = [];
const check = (label, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    fails.push(`${label} —— ${err.message}`);
    console.log(`  ✗ ${label}\n      ${err.message}`);
  }
};
const section = (title) => console.log(`\n=== ${title} ===`);
/** `teamPlan` 会把两个分项四舍五入到 4 位小数，所以按线性公式复算时要留容差。 */
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-3;

// ---------------------------------------------------------------- A. 合成夹具
//
// 成本口径（见 advice.js 的 charCostOf / coneCostOf）：
//   `charA/charB/charX` 是限定 5★（本体 1 金）；`freeC` 是 4★ 常驻（0 金）；
//   `coneA/coneB` 是限定光锥（1 金）；`freeCone` 是 4★（0 金）。
//   ⚠️ `Luocha` 要用**真实英文键**：隐金设置的名单（`EXCHANGE_CHARS` 等）里写的是键名，
//      自造名匹配不上，减免就永远是 0（隐金那条回归需要它带得动减免）。
const availability = {
  characters: {
    charA: { rarity: 5, limited: true },
    charB: { rarity: 5, limited: true },
    charX: { rarity: 5, limited: true },
    charY: { rarity: 5, limited: true },
    freeC: { rarity: 4, limited: false },
    Luocha: { rarity: 5, limited: true },
  },
  lightCones: {
    coneA: { rarity: 5, limited: true },
    coneB: { rarity: 5, limited: true },
    freeCone: { rarity: 4, limited: false },
  },
};
const member = (char, eidolon = 0, lc = null, superimp = 1) => ({ char, eidolon, lc, superimp });
// ⚠️ 每支队伍的 roster 必须**真的不同**（`packRosterKeyOf` 会按成员去重）：
// 否则两支「看起来不同的队伍」在方案里会被合并成一支。
const TEAMS = {
  // 全部已有 + 不装光锥 → 差额 0（必须被剔除）
  zero: [member('charA'), member('charB'), member('freeC')],
  // 缺一把限定光锥 → 差额 1 金；那笔的每抽收益 = 1000/67
  coneGap: [member('charA', 0, 'coneA'), member('charB'), member('freeC')],
  // 缺一个本体 → 差额 1 金；每抽收益 = 600/94（低于光锥那笔 → 排在光锥之后）
  bodyGap: [member('charY'), member('charB'), member('freeC')],
  // 缺本体（要补到 E1，共 2 金 = 188 抽）+ 同时缺它自己的限定光锥（1 金 = 67 抽）
  // → 光锥的**每抽收益更高**，纯按每抽收益会把它排前面；**载体约束**必须让本体先来。
  //   （两个 `from` 都是 0，因为 `marginalCostOf` 把 -1 夹成了 0，所以判据只能用 kind。）
  carrier: [member('charX', 1, 'coneB'), member('charB'), member('freeC')],
};
const conclusionFixture = {
  frontierEnvs: [
    { id: 'env1', label: '测试副本', weight: 1 },
    { id: 'env2', label: '测试副本二', weight: 1 },
  ],
  frontierUnits: [
    { key: 'k-body', name: 'charY', eidolon: 0, lc: null, superimp: 1, total: 600, envCount: 1,
      envs: [{ id: 'env2', value: 600, bestTeamGold: 3, members: TEAMS.bodyGap }] },
    { key: 'k-carrier', name: 'charX', eidolon: 0, lc: 'coneB', superimp: 1, total: 800, envCount: 1,
      envs: [{ id: 'env1', value: 800, bestTeamGold: 4, members: TEAMS.carrier }] },
    { key: 'k-cone', name: 'charA', eidolon: 0, lc: 'coneA', superimp: 1, total: 1000, envCount: 1,
      envs: [{ id: 'env1', value: 1000, bestTeamGold: 4, members: TEAMS.coneGap }] },
    { key: 'k-zero', name: 'charA', eidolon: 0, lc: null, superimp: 1, total: 200, envCount: 1,
      envs: [{ id: 'env1', value: 200, bestTeamGold: 3, members: TEAMS.zero }] },
  ],
};
// 账号：charA（E0）+ charB（E0）+ freeC（E0）已有；光锥一把都没有。
const accountFixture = {
  owned: new Set(['charA', 'charB', 'freeC']),
  eidolons: new Map(),
  cones: new Map(),
};
const fixturePlan = (options = {}) => teamPlan(conclusionFixture, accountFixture,
  { availability, ...options });

section('A. 队伍方案（合成夹具）');

check('候选池 = 总榜按队伍去重，且**补金 0 的队伍被剔除**', () => {
  const plan = fixturePlan();
  assert.equal(plan.poolAll, 4, `去重后应有 4 支队伍，实际 ${plan.poolAll}`);
  assert.equal(plan.pool, 3, `剔除「差额 0」后应剩 3 支，实际 ${plan.pool}`);
  assert.ok(plan.rows.every((r) => r.gap > 0), '下发结果里不该有差额 0 的队伍');
});

check('⭐ 候选池取自**逐档榜**（每角色 × 每星魂档），不是总榜 —— 低配档位不能被挤掉', () => {
  // 用户 2026-10-11：「任何队伍都应该有机会参与竞争，哪怕这支队伍本身实力不强，
  // 但可以依靠差额接近度拉分，结果很有可能名列前茅。」
  //
  // 总榜是「每个角色只留总分最高的那一个整包」，于是同一支队伍的**低配档位**会被它
  // 自己的高配档位挤掉 —— 池里只剩最贵的那一版。逐档榜（每角色 × E0/E1/E2/E6 各一条）
  // 才把它留下。实测本机账号 1：池 78 → 245 支，前 15 名里 8 支是总榜池拿不到的。
  assert.equal(teamPoolUnits(conclusionFixture).length, conclusionFixture.frontierUnits.length,
    '没有 frontierTiers 时应**退回总榜**（旧服务端 / 合成夹具 / 探针直接喂 frontierUnits）');
  assert.equal(teamPoolUnits({ ...conclusionFixture, frontierTiers: {} }).length,
    conclusionFixture.frontierUnits.length, 'frontierTiers 是空对象时也应退回总榜');
  assert.equal(teamPoolUnits({ ...conclusionFixture, frontierTiers: { 0: [] } }).length,
    conclusionFixture.frontierUnits.length, 'frontierTiers 里全是空数组时也应退回总榜');
  assert.equal(teamPoolUnits({}).length, 0, '什么都没有时回空池，不抛异常');

  // 逐档榜里多一条「同一批成员、但档位更低（更便宜）」的整包 —— 它必须进池。
  const cheapTier = {
    key: 'k-lowtier', name: 'charA', eidolon: 0, lc: 'coneA', superimp: 1, total: 500, envCount: 1,
    envs: [{ id: 'env1', value: 500, bestTeamGold: 2,
      members: [member('charA', 0, 'coneA'), member('charB'), member('freeC')] }],
  };
  const withTiers = { ...conclusionFixture, frontierTiers: { 0: [cheapTier] } };
  // ⚠️ 池来源是**并集**（逐档榜 + 总榜），不是「二选一」。理由见 `teamPoolUnits` 的注释：
  // `byTier` 按 `eidolon` **精确相等**过滤，而档位表只有 0/1/2/6 —— 星魂落在 E3/E4/E5 的
  // 整包**结构上**进不了逐档榜（实测当前数据集里没有这种角色，所以并集现在不多带队伍，
  // 它是挡这个结构缺口的保险）。
  assert.deepEqual(teamPoolUnits(withTiers), [cheapTier, ...conclusionFixture.frontierUnits],
    '有 frontierTiers 时应回「逐档榜 ∪ 总榜」（逐档榜在前）');
  const plan = teamPlan(withTiers, accountFixture, { availability });
  assert.ok(plan.rows.length > 0, '逐档榜的队伍应参与打分');
  assert.ok(plan.poolAll >= plan.pool,
    `池规模口径自洽：去重前 ${plan.poolAll} 应 ≥ 剔除补金 0 后的 ${plan.pool}`);
});

check('两个指标按**抽卡权重**合成，默认 1:1 = 旧的等权', () => {
  const plan = fixturePlan();
  const draw = plan.drawWeights;
  assert.deepEqual(draw, { strength: 0.5, cost: 0.5 }, '默认抽卡权重应是 1:1 归一化后的等权');
  for (const r of plan.rows) {
    assert.ok(Math.abs(r.total - (draw.strength * r.strengthPct + draw.cost * r.costPct)) < 1e-4,
      `${r.key}: ${r.total} ≠ ${draw.strength}×${r.strengthPct} + ${draw.cost}×${r.costPct}`);
  }
});

check('刻度的取样集合是**整个候选池**（不是写死的常数，也不是要展示的那几条）', () => {
  const plan = fixturePlan();
  // 候选池 = 3 支（差额 0 的那支被剔除）：队分 600 / 800 / 1000，差额 {1, 1, 3}
  // → ① 的刻度 600~1000。
  //
  // ⚠️ ② 的封顶值**不要写死数字**：它 = 候选池差额的 `SCORING.teamPlanGapCapPct` 分位，
  // 这条规则本身改过两次（p50 → p75，见 `SCORING` 的注释）。这里按**规则**复算：
  // 排好序取第 ⌊n×p⌋ 个（与 `teamPlan` 里的取法逐字一致）。
  assert.equal(Math.round(plan.strengthLo), 600);
  assert.equal(Math.round(plan.strengthHi), 1000);
  const gaps = plan.rows.map((r) => r.gap).sort((a, b) => a - b);
  const expectCap = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * SCORING.teamPlanGapCapPct))];
  assert.equal(plan.gapMax, expectCap,
    `② 的封顶值应是候选池差额的 p${SCORING.teamPlanGapCapPct * 100} = ${expectCap} 金，实际 ${plan.gapMax}`);
  assert.equal(plan.gapCapPct, SCORING.teamPlanGapCapPct);
  assert.equal(plan.gapRealMax, 3, `展示批次的真实最大差额应是 3 金，实际 ${plan.gapRealMax}`);
  // 分最高的那支拿 ①=100（⚠️ 按**强度**排，不是按总榜分 —— ① 在 v4.6.87 换了口径）
  const top = [...plan.rows].sort((a, b) => b.strength - a.strength)[0];
  assert.equal(Math.round(top.strengthPct), 100, '强度最高的那支应拿满分');
});

check('⭐ 展示条数（maxRows）**不参与任何计算**：改条数不改分数、不改名次', () => {
  // 这一条钉的是第七轮修的 bug：封顶值与 ① 的刻度一度取自「要展示的那批」，
  // 于是用户第 5 条「只显示前 15」一落地，② 的封顶值就从 12 金缩到 9 金、
  // 最高分从 74.6 掉到 55.6。现在两者都取自全池，条数必须完全无副作用。
  const full = fixturePlan();
  const one = fixturePlan({ maxRows: 1 });
  const two = fixturePlan({ maxRows: 2 });

  assert.equal(one.rows.length, 1, 'maxRows=1 应只回 1 条');
  assert.equal(two.rows.length, 2, 'maxRows=2 应只回 2 条');
  // 三个刻度必须与全量时逐位相同
  for (const [label, p] of [['maxRows=1', one], ['maxRows=2', two]]) {
    assert.equal(p.gapMax, full.gapMax, `⚠️ ${label}：② 的封顶值不能随展示条数变`);
    assert.equal(p.scoreLo, full.scoreLo, `⚠️ ${label}：① 的下限不能随展示条数变`);
    assert.equal(p.scoreHi, full.scoreHi, `⚠️ ${label}：① 的上限不能随展示条数变`);
    assert.equal(p.pool, full.pool, `⚠️ ${label}：候选池规模不能随展示条数变`);
  }
  // 同一条队伍在三种条数下的两个分项与总分必须逐位一致
  const byKey = new Map(full.rows.map((r) => [r.key, r]));
  for (const p of [one, two]) {
    for (const r of p.rows) {
      const o = byKey.get(r.key);
      assert.ok(o, `${r.key} 应该也在全量结果里`);
      assert.equal(r.total, o.total, `${r.key}：总分不能随展示条数变`);
      assert.equal(r.strengthPct, o.strengthPct, `${r.key}：① 不能随展示条数变`);
      assert.equal(r.gapPct, o.gapPct, `${r.key}：② 不能随展示条数变`);
    }
  }
  // 展示的必须是**总分最高**的那几条（截断只按总分，不按队分）
  const bestFirst = [...full.rows].sort((a, b) => b.total - a.total).map((r) => r.key);
  assert.deepEqual(one.rows.map((r) => r.key), bestFirst.slice(0, 1), 'maxRows=1 应回总分最高的那条');
  assert.deepEqual(two.rows.map((r) => r.key), bestFirst.slice(0, 2), 'maxRows=2 应回总分前两条');
});

section('A1. 抽卡权重（强度 / 性价比，用户 2026-10-12 第 3、4 条）');

/**
 * 两支**故意反着来**的队伍，用来证明 ① 吃的是 `strength` 而不是 `total`：
 *
 *   * `k-strong`：纯强度 900（池内最高），但总榜整包分只有 400（池内最低）→ 补金 3 金；
 *   * `k-cheap` ：纯强度 300（池内最低），总榜整包分 1000（池内最高）→ 补金 1 金。
 *
 * 若哪天有人把 ① 改回「队伍在角色总榜上的分」，第三条断言（强度档排第一）会当场红。
 */
const strengthFixture = {
  ...conclusionFixture,
  frontierUnits: [
    { key: 'k-strong', name: 'charX', eidolon: 0, lc: 'coneB', superimp: 1,
      total: 400, strength: 900, envCount: 1,
      envs: [{ id: 'env1', value: 400, bestTeamGold: 4, members: TEAMS.carrier }] },
    { key: 'k-cheap', name: 'charY', eidolon: 0, lc: null, superimp: 1,
      total: 1000, strength: 300, envCount: 1,
      envs: [{ id: 'env2', value: 1000, bestTeamGold: 3, members: TEAMS.bodyGap }] },
  ],
};
const strengthPlan = (drawWeights) => teamPlan(strengthFixture, accountFixture,
  { availability, drawWeights });

check('⭐ ① 取**纯强度**，不是「队伍在角色总榜上的分」（两个刻度各自独立）', () => {
  const plan = strengthPlan();
  // 两个刻度必须分开：强度刻度来自 `strength`，总榜分刻度来自 `total`。
  assert.equal(Math.round(plan.strengthLo), 300, '强度刻度下限应是 300');
  assert.equal(Math.round(plan.strengthHi), 900, '强度刻度上限应是 900');
  assert.equal(Math.round(plan.scoreLo), 400, '总榜分刻度下限应是 400');
  assert.equal(Math.round(plan.scoreHi), 1000, '总榜分刻度上限应是 1000');
  // ⚠️ 判定必须按**成员**找行，不能按 `key`：下发的 `key` 是 roster 键（成员整包键拼的），
  // 不是整包自己的 `k-*` 键。
  const rowOf = (plan2, char) => plan2.rows.find((r) => r.members.some((m) => m.char === char));
  const strong = rowOf(plan, 'charX');
  const cheap = rowOf(plan, 'charY');
  // 总榜分最低的那支，强度却是满分 —— 这正是「高金、低行动值的队伍在强度轴上排得上」。
  assert.equal(Math.round(strong.strengthPct), 100);
  assert.equal(Math.round(strong.teamScore), 400, '队分仍如实下发（只作参考，不参与总分）');
  assert.equal(Math.round(cheap.strengthPct), 0);
  assert.equal(Math.round(cheap.teamScore), 1000);
});

check('⭐ 抽卡权重只认**相对大小**：3:1 与 0.75:0.25 得到同一个榜', () => {
  const a = strengthPlan({ strength: 3, cost: 1 });
  const b = strengthPlan({ strength: 0.75, cost: 0.25 });
  assert.deepEqual(a.drawWeights, { strength: 0.75, cost: 0.25 }, '回显生效权重（已归一化）');
  assert.deepEqual(a.rows.map((r) => r.key), b.rows.map((r) => r.key), '名次必须逐位一致');
  for (const [i, r] of a.rows.entries()) {
    assert.equal(r.total, b.rows[i].total, `${r.key}: 总分必须逐位一致`);
  }
});

check('⭐ 强度权重高 → 强队在前；性价比权重高 → 补金少的在前', () => {
  // 判定按**成员**（`key` 是 roster 键）：charX 那支 = 补 3 金的强队，charY 那支 = 补 1 金的弱队。
  const first = (plan) => (plan.rows[0].members.some((m) => m.char === 'charX') ? 'strong' : 'cheap');
  // 强度档：只有强度算数 → 纯强度 900 的那支（补 3 金）第一。
  const byStrength = strengthPlan({ strength: 1, cost: 0 });
  assert.equal(first(byStrength), 'strong',
    '强度权重拉满时该推纯强度最高的那支（补 3 金）');
  // 性价比档：只有差额接近度算数 → 补 1 金的那支第一。
  const byCost = strengthPlan({ strength: 0, cost: 1 });
  assert.equal(first(byCost), 'cheap', '性价比权重拉满时该推补金最少的那支');
  assert.ok(byCost.rows[0].gap < byStrength.rows[0].gap, '两支的差额确实是一大一小');
});

check('抽卡权重的边界：两侧都清空 / 非法值 → 退回默认等权，不出现整列 0 分', () => {
  assert.deepEqual(normalizeDrawWeights({ strength: 0, cost: 0 }), { strength: 0.5, cost: 0.5 });
  assert.deepEqual(normalizeDrawWeights({ strength: '', cost: '' }), { strength: 0.5, cost: 0.5 },
    '空串 = 用户清空了输入框 → 按 0 算，两侧都是 0 时退回默认等权');
  assert.deepEqual(normalizeDrawWeights({ strength: -1, cost: 'abc' }), { strength: 0.5, cost: 0.5 },
    '非法值忽略、退回默认');
  assert.deepEqual(normalizeDrawWeights({ strength: 2, cost: null }), { strength: 2 / 3, cost: 1 / 3 },
    '只给一个键时另一个按默认值补齐');
  assert.deepEqual(normalizeDrawWeights({ strength: 1, cost: 0 }), { strength: 1, cost: 0 },
    '单边为 0 是**合法**的：用户可以把某一侧彻底关掉');
  assert.deepEqual(normalizeDrawWeights(undefined), { strength: 0.5, cost: 0.5 },
    '不给参数时用默认值（默认 1:1 → 等权）');
});

check('⭐ 补金差额相同时，**账面金数更少**的队伍排前面（用户 2026-10-12 第 5 条）', () => {
  // 这就是用户报的那个缺陷的合成版：实测他点名那支（账面 16 金）与第 2 名（11 金）的
  // **补金差额完全相同（都是 4 金）**，所以「差额接近度」一分不差；而强度得分刻意不含
  // 金数项 —— 于是「这支队总共要几金」在排序里权重为 0，16 金那支反而靠纯强度赢了 1.2 分。
  // 修法：性价比得分里除了差额接近度，还要有**压金度**（= 1 − 账面金数 ÷ 池内 p75）。
  const pairs = [
    // P：账面 4 金（charA E1 + coneA + charB），补金 2 金（charA E0→E1 + coneA）
    { key: 'k-pricey', name: 'charA', eidolon: 1, lc: 'coneA', superimp: 1, total: 400, strength: 500,
      envCount: 1,
      envs: [{ id: 'env1', value: 400, bestTeamGold: 4,
        members: [member('charA', 1, 'coneA'), member('charB'), member('freeC')] }] },
    // Q：账面 3 金（charY + coneB + charB），补金同样 2 金（charY 本体 + coneB）
    { key: 'k-budget', name: 'charY', eidolon: 0, lc: 'coneB', superimp: 1, total: 300, strength: 500,
      envCount: 1,
      envs: [{ id: 'env2', value: 300, bestTeamGold: 3,
        members: [member('charY', 0, 'coneB'), member('charB'), member('freeC')] }] },
  ];
  const plan = teamPlan({ ...conclusionFixture, frontierUnits: pairs }, accountFixture,
    { availability });
  assert.equal(plan.rows.length, 2, '两支都该进结果');
  assert.deepEqual(plan.rows.map((r) => r.gap), [2, 2],
    '两支的补金差额必须相同 —— 否则这条用例测的是差额而不是压金度');
  // 纯强度也一样（都是 500 → 都拿 100 分），所以胜负只能由性价比里的压金度决定。
  assert.deepEqual(plan.rows.map((r) => Math.round(r.strengthPct)), [100, 100]);
  assert.deepEqual(plan.rows.map((r) => r.gold), [3, 4],
    `账面更少的那支应排前面（实际 #1 账面 ${plan.rows[0].gold} 金 / #2 账面 ${plan.rows[1].gold} 金）`);
  assert.ok(plan.rows[0].goldPct > plan.rows[1].goldPct, '压金度必须真的拉开了差距');
  // 反证：把压金度从性价比里拿掉（costMix = 1 = 只看差额接近度）就分不出高下。
  const keepMix = SCORING.teamPlanCostMix;
  SCORING.teamPlanCostMix = 1;
  try {
    const blind = teamPlan({ ...conclusionFixture, frontierUnits: pairs }, accountFixture,
      { availability });
    assert.ok(Math.abs(blind.rows[0].total - blind.rows[1].total) < 1e-9,
      '只看差额接近度时两队应当同分（这正是本轮修的缺陷）');
  } finally {
    SCORING.teamPlanCostMix = keepMix;
  }
});

check('指标②是**分位封顶**：达到/超过封顶值一律 0 分，以下线性展开', () => {
  const plan = fixturePlan();
  const cap = plan.gapMax;
  // ⚠️ 这里验的是**规则**，不写死封顶值 —— 分位本身改过两次（p50 → p75）。
  // 规则：≥ 封顶 → 0 分；以下 → `100 × (1 − 差额 ÷ 封顶)`。
  for (const r of plan.rows) {
    const expect = Math.max(0, Math.min(100, 100 * (1 - r.gap / cap)));
    assert.ok(near(r.gapPct, expect),
      `${r.gap} 金 ÷ 封顶 ${cap} 金 的 ② 应是 ${expect}，实际 ${r.gapPct}`);
  }
  // 封顶值必须真的落在池内（否则「封顶」两个字没有意义）
  assert.ok(plan.rows.some((r) => r.gap >= cap), `池内应有队伍补金 ≥ 封顶值 ${cap}`);
  // 换一批：让池内出现「差额 1 金」的队伍，就能看到「以下线性」那一段的正分
  const wide = teamPlan({
    ...conclusionFixture,
    frontierUnits: conclusionFixture.frontierUnits.map((u) => (u.name === 'charY'
      ? { ...u, envs: [{ ...u.envs[0], members: [member('charY', 6), member('charB'), member('freeC')] }] }
      : u)),
  }, accountFixture, { availability });
  const wcap = wide.gapMax;
  const byGap = (g) => wide.rows.find((r) => r.gap === g);
  assert.ok(byGap(1), `应有补 1 金的队伍（实际 ${wide.rows.map((r) => r.gap)}）`);
  assert.equal(Math.round(byGap(1).gapPct), Math.round(100 * (1 - 1 / wcap)),
    `1 金 ÷ 封顶 ${wcap} 金 的 ② 应落在封顶值以内、按线性拿分`);  assert.ok(byGap(1).gapPct > 0, '1 金应拿正分（否则「以下线性」这段没被验到）');
  for (const r of wide.rows.filter((x) => x.gap >= wcap)) {
    assert.equal(r.gapPct, 0, `${r.gap} 金 ≥ 封顶 ${wcap} 金 → 0 分`);
  }
});

check('⭐ 隐金减免的两处来源必须同源：账面取**载荷里的** hiddenCosts，不是模块级状态', () => {
  // 这一条钉的是 2026-10-11 第七轮修的一个真不一致：队伍卡片上「账面 N 金（含隐金减免
  // M 金）」用的减免传的是 `undefined`（→ 模块级 `activeHiddenCostsState`），而补金顺序里
  // **逐笔 cost** 传的是 `conclusion?.hiddenCosts`（→ HTTP 载荷里的那份）。浏览器实测：
  // 载荷带着 5 项全勾（界面就是这么发的），但模块级状态在**页面重新加载后没有被初始化**
  // （界面只在用户勾选时才 `setHiddenCosts`）→ 某张卡不写减免，而它的补金项却因为逐笔
  // cost=0 被整批过滤掉，补金顺序成了空的。
  //
  // `Luocha` 在「角色兑换」名单里（角色及其星魂视为 0 金），所以它带得动减免。
  const withUnits = {
    ...conclusionFixture,
    frontierUnits: [
      ...conclusionFixture.frontierUnits,
      { key: 'k-cut', name: 'Luocha', eidolon: 0, lc: 'coneA', superimp: 1, total: 700, envCount: 1,
        envs: [{ id: 'env1', value: 700, bestTeamGold: 3,
          members: [member('Luocha', 0, 'coneA'), member('charB'), member('freeC')] }] },
    ],
  };
  const find = (plan) => {
    const row = plan.rows.find((r) => r.members.some((m) => m.char === 'Luocha'));
    assert.ok(row, '带 Luocha 的那支队伍应该在结果里');
    return row;
  };
  const run = (hidden) => find(teamPlan({ ...withUnits, ...(hidden ? { hiddenCosts: hidden } : {}) },
    accountFixture, { availability }));

  const prev = setHiddenCosts(DEFAULT_HIDDEN_COSTS); // 先把模块级状态设成「全勾」
  try {
    const off = run(NO_HIDDEN_COSTS);
    assert.equal(off.hiddenCut, 0, '载荷说「一项都不减」时，账面不能按模块级状态减');
    const on = run(DEFAULT_HIDDEN_COSTS);
    assert.ok(on.hiddenCut > 0, `载荷说「全勾」时账面必须减，实际 ${on.hiddenCut}`);
    // 反方向：模块级状态全关、载荷全勾 → 仍要减（证明用的是载荷）
    setHiddenCosts(NO_HIDDEN_COSTS);
    assert.equal(run(DEFAULT_HIDDEN_COSTS).hiddenCut, on.hiddenCut,
      '同源：结果只由载荷决定，与模块级状态无关');
    assert.equal(run(NO_HIDDEN_COSTS).hiddenCut, 0, '载荷全关时仍必须是 0');
    // 载荷**不带**该字段时退回模块级状态（工具/探针直接调 buildConclusion 的历史行为）
    assert.equal(run(null).hiddenCut, 0, '载荷没有 hiddenCosts 时应退回模块级状态（此刻全关）');
    setHiddenCosts(DEFAULT_HIDDEN_COSTS);
    assert.equal(run(null).hiddenCut, on.hiddenCut, '退回模块级状态时要跟着它走');
  } finally {
    setHiddenCosts(prev);
  }
});

check('补金顺序：同 kind 按性价比、跨 kind 按**每抽收益**（光锥 67 抽 < 星魂 94 抽）', () => {
  const plan = fixturePlan();
  const cone = plan.rows.find((r) => r.gap === 1 && r.fill.length === 1 && r.fill[0].kind === 'cone');
  assert.ok(cone, '应有一支「只缺一把光锥」的队伍');
  assert.equal(cone.fill[0].pulls, 1);
  assert.equal(cone.fill[0].pullsExpected, unitPullsOf('cone', 1));
  assert.equal(cone.fill[0].perPull, cone.fill[0].value / unitPullsOf('cone', 1));
  // 每笔之和 = 队伍差额
  for (const r of plan.rows) {
    assert.equal(r.fill.reduce((n, it) => n + it.pulls, 0), r.gap,
      `${r.key}: 补金顺序之和 ≠ 差额`);
  }
});

check('载体约束：缺本体时，**本体排在它自己的光锥之前**（哪怕光锥每抽更划算）', () => {
  const plan = teamPlan(conclusionFixture, accountFixture, { availability, maxRows: 100 });
  // carrier 队：本体要 E0→E1（2 金 = 188 抽）vs 限定光锥（1 金 = 67 抽）。
  // 每抽收益 = 分/抽，所以 800/67 > 800/188 —— 纯按每抽收益会把光锥排前面。
  const row = plan.rows.find((r) => r.members.some((m) => m.char === 'charX'));
  assert.ok(row, 'carrier 队应该在结果里');
  assert.deepEqual(row.fill.map((it) => it.kind), ['char', 'cone'],
    `应先是本体、再是光锥（实际 ${JSON.stringify(row.fill.map((i) => i.kind))}）`);
  assert.deepEqual(row.fill.map((it) => it.pulls), [2, 1], '本体 2 金、光锥 1 金');
  assert.ok(row.fill[1].perPull > row.fill[0].perPull,
    '这个用例要的正是「光锥每抽更划算、但被载体约束压后」');
});

check('下发行数受 SCORING.teamPlanMaxRows 约束，且带 truncated 标记', () => {
  const plan = teamPlan(conclusionFixture, accountFixture, { availability, maxRows: 2 });
  assert.equal(plan.rows.length, 2);
  assert.equal(plan.truncated, true);
  assert.ok(plan.pool >= plan.rows.length);
});

check('队伍分取「同一支队伍里分最高的那个成员」（成员分数不同时不能取第一个）', () => {  const mixed = {
    ...conclusionFixture,
    frontierUnits: [
      { key: 'low', name: 'charA', eidolon: 0, lc: 'coneA', superimp: 1, total: 300,
        envs: [{ id: 'env1', value: 300, members: TEAMS.coneGap }] },
      { key: 'high', name: 'charB', eidolon: 0, lc: null, superimp: 1, total: 900,
        envs: [{ id: 'env1', value: 900, members: TEAMS.coneGap }] },
    ],
  };
  const plan = teamPlan(mixed, accountFixture, { availability });
  assert.equal(plan.poolAll, 1, '同一支队伍必须只留一条');
  assert.equal(plan.rows[0].teamScore, 900, '应取分最高的那个成员');
});

check('没有可补金的队伍时：rows 为空（界面据此给说明），不抛异常', () => {
  const plan = teamPlan(conclusionFixture, {
    owned: new Set(['charA', 'charB', 'charX', 'charY', 'freeC']),
    eidolons: new Map([['charX', 1]]),
    cones: new Map([['coneA', 1], ['coneB', 1]]),
  }, { availability });
  assert.equal(plan.rows.length, 0);
  assert.equal(plan.pool, 0);
});

section('A2. 三月七两命途（用户第 4 条：与开拓者同口径）');

check('ownedCharacters / eidolonsOf：命中一个命途 = 两个命途都算已拥有', () => {
  // 米游社只报中文名「三月七」（满星魂 E6），数据集却是两个英文键。
  // ⚠️ 这里刻意只给**一个**中文映射（生产里 `refs.characters` 就只有一个 `三月七`），
  // 另一个命途必须靠名字兜底同步过去 —— 这正是 `putRank` 的第二条路径。
  const snapshot = { characters: [{ id: 1001, name: '三月七', rank: 6 }] };
  const zhToEn = { 三月七: 'March 7th (Hunt)' };
  const allNames = ['March 7th (Hunt)', 'March 7th (Preservation)', 'Trailblazer (Harmony)'];
  const owned = ownedCharacters(snapshot, zhToEn, allNames);
  assert.ok(owned.has('March 7th (Hunt)'), '原本能命中的那个必须还在');
  assert.ok(owned.has('March 7th (Preservation)'), '另一个命途必须也算已拥有（本轮修的）');
  const eidolons = eidolonsOf(snapshot, zhToEn, allNames);
  assert.equal(eidolons.get('March 7th (Hunt)'), 6);
  assert.equal(eidolons.get('March 7th (Preservation)'), 6,
    '星魂等级必须同步到另一个命途，否则会被算成 E0→E6 的 6 金缺口');
});

check('只有别的角色时不会被误判为「拥有三月七」', () => {
  const snapshot = { characters: [{ id: 1002, name: '希儿', rank: 0 }] };
  const owned = ownedCharacters(snapshot, { 希儿: 'Seele' }, ['March 7th (Hunt)', 'March 7th (Preservation)']);
  assert.ok(!owned.has('March 7th (Hunt)'));
  assert.ok(!owned.has('March 7th (Preservation)'));
});

// ---------------------------------------------------------------- B. 真数据 + 真服务
//
// 用 `createApp({ store })` 起一个**真 HTTP 服务**，store 用假的（不碰 DPAPI，
// 所以这个套件在任何环境下都能跑 —— 与 e2e 那个「必须能读凭证」的套件不同）。
const fakeStore = {
  load: async () => {},
  listAccounts: async () => [],
  getAccount: async () => null,
  getSnapshot: async () => null,
  getBattleRecords: async () => null,
  setBattleRecords: async () => {},
};

const startTestServer = async () => {
  // ⚠️ `createApp()` 返回的是 `{ server, store, csrfToken }`，**不是**请求处理函数：
  // 把整个对象当 listener 交给 `createServer()` 会让每个请求都挂着不响应。
  const { server } = createApp({ store: fakeStore });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
};

section('B. 真数据 + 真服务（/conclusion 的 availability 与队伍方案）');

const { server, port } = await startTestServer();
const post = async (path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // 5 个副本要聚合成完整阵容表，实测几秒；给足余量（默认 undici 只有 10 秒）。
    signal: AbortSignal.timeout(180_000),
  });
  return { status: res.status, data: await res.json(), bytes: Number(res.headers.get('content-length')) || 0 };
};

const live = await post('/api/archive/conclusion', {
  window: 6,
  account: { owned: [], eidolons: {}, cones: {} },
  frontierWeights: { 'aa|plight': 10, 'aa|': 1, 'as|': 1, 'moc|': 1, 'pf|': 1 },
});
const livePayload = live.data;

check('⭐ 真载荷上：逐档榜的池**包含**总榜的池（两条口径不打架）', () => {
  // 这一条钉的是 v4.6.83 换池来源的**正确性前提**：逐档榜是「每角色 × 每星魂档各收敛一条」，
  // 而 `eidolonTierOf` 把任意档位折进 0/1/2/6 四个桶，所以「某角色总榜最佳那条」必然就是
  // 它所在桶里的最佳 —— 逐档榜因此**天然包含**总榜。若哪天档位映射或收敛逻辑改了、
  // 这个包含关系破掉，界面上会**凭空少掉推荐**，这条断言会当场抓出来。
  const emptyAccount = { owned: new Set(), eidolons: new Map(), cones: new Map() };
  // ⚠️ `options.maxRows` 只能**往下**夹（`Math.min(SCORING.teamPlanMaxRows, …)`），
  // 所以要枚举**整个池**必须先把这个常量抬起来 —— 否则两边都只回前 15 条，
  // 「哪些队伍没进池」的比对就是拿两批 top-15 互比（这个坑在探针里也踩过一次）。
  const keepRows = SCORING.teamPlanMaxRows;
  SCORING.teamPlanMaxRows = 100000;
  let tiersPool; let unitsPool;
  try {
    tiersPool = teamPlan(livePayload, emptyAccount, { availability: livePayload.availability });
    unitsPool = teamPlan({ ...livePayload, frontierTiers: undefined }, emptyAccount,
      { availability: livePayload.availability });
  } finally {
    SCORING.teamPlanMaxRows = keepRows;
  }
  assert.ok(unitsPool.pool >= 50, `总榜池应有几十支，实际 ${unitsPool.pool}`);
  assert.ok(tiersPool.pool >= unitsPool.pool,
    `逐档榜池（${tiersPool.pool}）不应少于总榜池（${unitsPool.pool}）`);
  // 总榜池里**每一支队伍**都要能在逐档榜池里找到（按 roster 键比）
  const tierKeys = new Set(tiersPool.rows.map((r) => r.key));
  const missing = unitsPool.rows.filter((r) => !tierKeys.has(r.key));
  assert.equal(missing.length, 0,
    `总榜有 ${missing.length} 支队伍没进逐档榜池：${missing.slice(0, 3).map((r) => r.key).join(' / ')}`);
  void SCORING;
});

check('/conclusion 回 payload: 8（availability + frontierTiers + strength 那一版）', () => {
  assert.equal(live.status, 200);
  assert.equal(livePayload.payload, 8, `实际 payload=${livePayload.payload}`);
});

check('/conclusion 带 availability（星级 / 常驻标记），界面靠它算差额', () => {
  const av = livePayload.availability;
  assert.ok(av && typeof av === 'object', '缺 availability');
  assert.ok(Object.keys(av.characters || {}).length > 50,
    `角色成本表太小：${Object.keys(av.characters || {}).length}`);
  assert.ok(Object.keys(av.lightCones || {}).length > 50,
    `光锥成本表太小：${Object.keys(av.lightCones || {}).length}`);
  // 必须是**原样全名**：压缩成基础名会让 Dan Heng 与它的两个形态互相覆盖
  assert.ok(av.characters['March 7th (Hunt)'], '应带 March 7th (Hunt)');
  assert.ok(av.characters['March 7th (Preservation)'], '应带 March 7th (Preservation)');
  // 常驻角色必须显式给 limited: false（4★ 免费这件事全靠它）；
  // 限定角色**刻意省略** limited（压缩），读取侧按「不是 false 就是限定」兜底。
  const free4 = Object.entries(av.characters).find(([, info]) => info.rarity === 4);
  assert.ok(free4 && free4[1].limited === false, '4★ 应显式标 limited: false');
  const limited5 = Object.entries(av.characters).find(([, info]) => info.rarity === 5);
  assert.ok(limited5 && limited5[1].limited === undefined, '限定角色应省略 limited（省字节）');
});

check('真载荷能跑通 teamPlan（空账号 → 每支队伍的差额都 > 0）', () => {
  const plan = teamPlan(livePayload, {
    owned: new Set(), eidolons: new Map(), cones: new Map(),
  }, { availability: livePayload.availability });
  assert.ok(plan.rows.length > 0, '空账号下应该有可补的队伍');
  assert.ok(plan.rows.every((r) => r.gap > 0), '差额 0 的队伍必须被剔除');
  assert.ok(plan.rows.every((r) => r.total >= 0 && r.total <= 100), '总分必须落在 0~100');
  for (let i = 1; i < plan.rows.length; i += 1) {
    assert.ok(plan.rows[i - 1].total >= plan.rows[i].total - 1e-9, '总分必须降序');
  }
  for (const r of plan.rows) {
    assert.equal(r.fill.reduce((n, it) => n + it.pulls, 0), r.gap, `${r.key}: 补金之和 ≠ 差额`);
    assert.ok(r.members.length >= 2, `${r.key}: 队伍成员太少`);
  }
});

check('真载荷上补金顺序单调（每抽收益降序，被载体约束插队的除外）', () => {
  const plan = teamPlan(livePayload, {
    owned: new Set(), eidolons: new Map(), cones: new Map(),
  }, { availability: livePayload.availability });
  for (const r of plan.rows) {
    for (let i = 1; i < r.fill.length; i += 1) {
      const prev = r.fill[i - 1];
      const cur = r.fill[i];
      if (prev.perPull >= cur.perPull - 1e-9) continue;
      // 允许的唯一例外：这一笔是光锥、而它的载体本体还没到手（那一笔排在后面）
      const blocked = cur.kind === 'cone' && cur.carrier
        && r.fill.slice(0, i).some((x) => x.kind === 'char' && x.name === cur.carrier);
      assert.ok(blocked, `${r.key}: 第 ${i + 1} 笔（${cur.name}）乱序且不是载体约束`);
    }
  }
});

check('界面现算的差额 = 服务端口径（同一份 availability、同一批持有状态）', () => {
  // 服务端的 `units`（旧清单）用的是同一条 `marginalCostOf`；这里改成直接对
  // 「队伍成员 + 空账号」复算一遍，验证界面与服务端读到的是同一张成本表：
  //   空账号下，每位成员的代价 = 本体 1 金 + 从 E0 数起的星魂级数 +（限定光锥 1 金）。
  //   ⚠️ 两条都容易写错：
  //     ① 本体那 1 金**不能漏** —— `marginalCostOf` 的 `need` 在「本体也要抽」时是
  //        `星魂数 + 1`（4★/常驻角色才整块免掉，`charCostOf === 0`）；
  //     ② `limited` 为 true 时**服务端刻意省略该字段**（压缩），所以判据必须是
  //        「`limited !== false`」而不是「`=== true`」—— 与 `charCostOf` 的兜底一致。
  const plan = teamPlan(livePayload, {
    owned: new Set(), eidolons: new Map(), cones: new Map(),
  }, { availability: livePayload.availability });
  const av = livePayload.availability;
  const isLimited = (info) => Boolean(info) && info.limited !== false;
  for (const [i, r] of plan.rows.slice(0, 8).entries()) {
    let expect = 0;
    for (const m of r.members) {
      if (isLimited(av.characters[m.char])) expect += 1 + Math.max(0, Number(m.eidolon) || 0);
      if (m.lc && isLimited(av.lightCones[m.lc])) expect += 1;
    }
    assert.equal(r.gap, expect, `#${i + 1} ${r.key}（${r.members.map((m) => m.char).join('/')}）`
      + `：界面算 ${r.gap}，按成本表应为 ${expect}`);
  }
});

check('⭐ 真载荷带 `strength`（纯强度），且它 ≥ 总榜整包分', () => {
  // 用户 2026-10-12 第 3、4 条：抽卡方案的「强度得分」靠服务端下发的 `strength`。
  // 它是 `Σ 副本权重 × (100 × 表现)`，**不乘金数项**；而 `total` 乘了金数项
  // （封顶 ×1，只有「隐金后 0 金通关」那一档是 ×1.2）—— 空账号没有隐金，
  // 所以池内 `strength ≥ total` 必然成立（0 金通关那几支进不了榜，见 buildConclusionInner）。
  const plan = teamPlan(livePayload, {
    owned: new Set(), eidolons: new Map(), cones: new Map(),
  }, { availability: livePayload.availability, maxRows: 100000 });
  const missing = plan.rows.filter((r) => !Number.isFinite(Number(r.strength)));
  assert.equal(missing.length, 0, `有 ${missing.length} 条缺 strength`);
  const inverted = plan.rows.filter((r) => r.strength < r.teamScore - 1e-6);
  assert.equal(inverted.length, 0,
    `纯强度不该低于总榜分：${inverted.slice(0, 3).map((r) => `${r.key}(${r.strength} < ${r.teamScore})`).join(' / ')}`);
  // ⚠️ 端点必须**在整池**上量：`options.maxRows` 只能往下夹（`SCORING.teamPlanMaxRows`），
  // 上面那句 `maxRows: 100000` 拿到的仍是前 15 条 —— 这正是 §6 里记过的那个坑。
  const keepRows = SCORING.teamPlanMaxRows;
  SCORING.teamPlanMaxRows = 100000;
  let whole;
  try {
    whole = teamPlan(livePayload, {
      owned: new Set(), eidolons: new Map(), cones: new Map(),
    }, { availability: livePayload.availability });
  } finally {
    SCORING.teamPlanMaxRows = keepRows;
  }
  const byStrength = [...whole.rows].sort((a, b) => b.strength - a.strength);
  assert.equal(Math.round(byStrength[0].strengthPct), 100, '纯强度最高的那支应拿 100');
  assert.equal(Math.round(byStrength[byStrength.length - 1].strengthPct), 0, '纯强度最低的那支应拿 0');
  // ⚠️ **逐副本的 `strength` 刻意不下发**（`slimFrontierUnit` 只发顶层那一个数）：
  // 抽卡方案要的就是「这一整包的纯强度是多少」，逐条再带一遍会让载荷白涨
  // （1 个数字 × 每条 5 个副本 × 266 条）。这里只钉「顶层那个数真的在」。
  const unit = livePayload.frontierUnits.find((u) => Number(u.strength) > 0);
  assert.ok(unit, '真载荷里应当有带 strength 的整包');
  assert.ok(Number(unit.strength) >= Number(unit.total),
    `${unit.key}: 纯强度 ${unit.strength} 不该低于总榜分 ${unit.total}`);
  assert.ok(!('strength' in (unit.envs?.[0] || {})),
    '逐副本明细里不该重复带 strength（省载荷，见 slimFrontierUnit 的注释）');
});

check('/conclusion 载荷仍在 600 KB 硬上限内（e2e 有同一断言）', () => {
  assert.ok(live.bytes > 0 && live.bytes < 600 * 1024, `实际 ${live.bytes} 字节`);
});

check('账面金数与「最佳证据 N 金」是同一个尺子（数据集口径，不是目标档）', () => {
  // ⚠️ 这一条是实测踩出来的：用 `packGoldOf`（本体 + **目标档** + 光锥本体）时
  // 砂金•戏浪那支队印「账面 11 金」而下面写「最佳证据：… 14 金」（E3 被折成 E2，
  // 且光锥叠影没算）。现在 `teamPlan` 用 `datasetGoldOf`（本体 + **真实**星魂级数 +
  // 光锥本体 × 叠影），与数据集那条 `c` 同口径。
  const plan = teamPlan(livePayload, {
    owned: new Set(), eidolons: new Map(), cones: new Map(),
  }, { availability: livePayload.availability });
  const av = livePayload.availability;
  const isLimited = (info) => Boolean(info) && info.limited !== false;
  for (const [i, r] of plan.rows.slice(0, 10).entries()) {
    let expect = 0;
    for (const m of r.members) {
      if (isLimited(av.characters[m.char])) expect += 1 + Math.max(0, Number(m.eidolon) || 0);
      if (m.lc && isLimited(av.lightCones[m.lc])) {
        expect += Math.max(1, Number(m.superimp) || 1);
      }
    }
    assert.equal(r.gold, expect, `#${i + 1} ${r.key}：账面 ${r.gold}，按数据集口径应为 ${expect}`);
    assert.ok(r.displayGold <= r.gold, `#${i + 1}：隐金后不能比账面高`);
    // 「补金差额」与「账面金数」是两条链（差额 = 补到目标档要几金；账面 = 这一支配装的
    // 实际花费），所以只断言显然关系，不强行相等。
    assert.ok(r.gap <= r.gold, `#${i + 1}：补金差额 ${r.gap} 不该超过账面 ${r.gold}`);
  }
});

check('⭐⭐ 真载荷：把「这支队总共要几金」纳入性价比之后，前几名换成更压金的队伍', () => {
  // 用户 2026-10-12 第 5 条的原话：「目前我的账号的抽卡方案，优先推荐的队伍是
  // 遐蝶E2S1、风堇E2、昔涟E2S1、长夜月E2，这个队伍已经过时了，已被更能压成本的队伍
  // 取代」。实测那支在真数据集上是 **16 金**（4.6 要 20 金才满分），而 4.6 最便宜的满分
  // 只要 9 金。这一条钉「修完之后它不再排第 1」。
  //
  // ⚠️ 判定用**成员名单**（`key` 是 roster 键，读不出人话）：那支队四个成员是
  // 遐蝶 / 昔涟 / 长夜月 / 风堇，且账面 16 金、补金 4 金。
  const plan = teamPlan(livePayload, {
    owned: new Set(), eidolons: new Map(), cones: new Map(),
  }, { availability: livePayload.availability });
  const isThatTeam = (r) => {
    const chars = r.members.map((m) => m.char);
    return chars.length === 4
      && ['Castorice', 'Cyrene', 'Evernight', 'Hyacine'].every((n) => chars.includes(n));
  };
  const hit = plan.rows.findIndex(isThatTeam);
  if (hit < 0) {
    // 空账号下它的补金差额与账号 1 不同，可能压根不进前 15 —— 那不是失败，
    // 但要让读者知道这条用例这次没验到东西。
    console.log('      · 真载荷（空账号）前 15 里没有「遐蝶/昔涟/长夜月/风堇」那支，本条只验了不变量');
  } else {
    assert.ok(hit > 0,
      `那支 16 金的队伍不该再排第 1（实际第 ${hit + 1} 名）`);
  }
  // 不论它在不在，前几名都必须真的比它更压金或更强 —— 用「前 3 名的账面金数」钉住趋势：
  // 修之前 #1 = 16 金；修之后 #1 应当是明显更便宜的队伍。
  assert.ok(plan.rows[0].gold <= 13,
    `第 1 名的账面金数应当明显低于那支 16 金（实际 ${plan.rows[0].gold} 金）`);
  assert.ok(plan.rows.every((r) => Number.isFinite(r.goldPct) && Number.isFinite(r.costPct)),
    '每一行都要带压金度与性价比得分');
});

// ---- 用户 2026-10-11 的两条新要求（数据层）------------------------------------
// ⑦ 过渡档位：把补金顺序切成前半/后半，前半那一段就是「成本完全下位的中间档位」——
//    要买的项是子集、总金数 < 本方案，而且它是补金顺序的**前缀**（顺序天然先到它）。
check('⑦ 过渡档位：中间档位是严格下位（金数更少、成员状态不高于目标档）', () => {
  const plan = teamPlan(livePayload, {
    owned: new Set(), eidolons: new Map(), cones: new Map(),
  }, { availability: livePayload.availability });
  const withMid = plan.rows.filter((r) => r.mid);
  assert.ok(withMid.length > 0, '真载荷上应当至少有一支队伍需要补多笔（否则这条判据空跑）');
  for (const r of withMid) {
    assert.ok(r.mid.items >= 1 && r.mid.items < r.fill.length,
      `${r.key}：过渡档位取前 ${r.mid.items} 笔 / 共 ${r.fill.length} 笔`);
    assert.equal(r.mid.gold + r.mid.rest, r.gap,
      `${r.key}：前半 ${r.mid.gold} + 后半 ${r.mid.rest} 应当等于差额 ${r.gap}`);
    assert.ok(r.mid.gold > 0 && r.mid.rest > 0, `${r.key}：两半都必须 > 0（否则不是过渡档位）`);
    // 完全下位：中间档位里每位成员的星魂/叠影都不超过目标档。
    for (const m of r.mid.members) {
      const target = r.members.find((x) => x.char === m.char);
      assert.ok(target, `${r.key}：过渡档位里出现了不在目标队伍里的成员 ${m.char}`);
      if (m.eidolon !== null) {
        assert.ok(m.eidolon <= target.eidolon,
          `${r.key} ${m.char}：过渡档位 E${m.eidolon} 高于目标 E${target.eidolon}`);
      }
      if (target.lc && target.lc === m.lc) {
        assert.ok((m.superimp || 0) <= (target.superimp || 0),
          `${r.key} ${m.lc}：过渡档位 S${m.superimp} 高于目标 S${target.superimp}`);
      }
    }
  }
});

// ⑧ 次选配队：至多 3 支、每支与本队共享 ≥2 名成员（「类似」的判据），且不含自己。
check('⑧ 次选配队：至多 3 支、共享 ≥2 名成员、不含本队', () => {
  const plan = teamPlan(livePayload, {
    owned: new Set(), eidolons: new Map(), cones: new Map(),
  }, { availability: livePayload.availability });
  for (const r of plan.rows) {
    const mine = new Set(r.members.map((m) => m.char));
    for (const alt of r.alternatives) {
      assert.ok(alt.key !== r.key, `${r.key}：次选里出现了自己`);
      assert.ok(alt.shared >= 2, `${r.key}：次选 ${alt.key} 只共享 ${alt.shared} 名成员`);
      assert.ok(alt.members.filter((m) => mine.has(m.char)).length >= 2,
        `${r.key}：次选 ${alt.key} 的实际共享成员数不足 2`);
    }
    assert.ok(r.alternatives.length <= 3, `${r.key}：次选最多 3 支，实际 ${r.alternatives.length}`);
  }
});

await new Promise((resolve) => server.close(resolve));

// ---------------------------------------------------------------- 结果
console.log(`\n${'='.repeat(60)}`);
if (fails.length) {
  console.log(`team-plan-test：${passed} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`team-plan-test：${passed} 项全部通过`);
