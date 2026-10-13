// 队伍口径「抽卡方案」的回归套件（用户 2026-10-11 第 10 轮）。
//
// 与 `herta-test.mjs` 的分工：那边钉**整条评分链**（总榜 / 旧清单 / 隐金…），
// 这里只钉**新方案这一层**，而且分成两面：
//
//   A. 合成夹具（不碰数据集）：候选池去重、两个指标、归一化上下限、剔除 0 金、
//      补金顺序（每抽收益 + 载体约束）、三月七两命途。
//   B. 真数据 + 真服务（`createApp` 注入假 store，不经 DPAPI）：
//      `/conclusion` 的 `payload: 7` 与 `availability` / `frontierTiers` 存在性 +
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
/** 「差额接近度」那条曲线的期望值（与 `teamPlan()` 里的写法逐字一致，只用于复算）。
 *  ⚠️ 先 `clamp` 再取幂：负数取小数次幂是 `NaN`（生产代码也是先 clampUnit 再 `** power`）。 */
const caret = (gap, cap, power) => 100
  * Math.max(0, Math.min(1, 1 - gap / cap)) ** power;

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
    // ⚠️ 第二项是 `gapPct`（用户 2026-10-12 第 6 条：性价比这一侧只有差额接近度）。
    assert.ok(Math.abs(r.total - (draw.strength * r.strengthPct + draw.cost * r.gapPct)) < 1e-4,
      `${r.key}: ${r.total} ≠ ${draw.strength}×${r.strengthPct} + ${draw.cost}×${r.gapPct}`);
  }
});

check('刻度的取样集合是**整个候选池**（不是写死的常数，也不是要展示的那几条）', () => {
  const plan = fixturePlan();
  // 候选池 = 3 支（差额 0 的那支被剔除）：队分 600 / 800 / 1000。
  //
  // ⚠️ ① 的刻度就是**角色总榜整包分**（`total`）的池内最小 ~ 最大值（用户 2026-10-12 第 8 条：
  //    「同样是绝境 0T，9 金队要比 16 金队强得多」）。v4.6.87 曾换成不含金数项的「纯强度」、
  //    v4.6.90 又把下限抬到池内 p75，**两条都已在 v4.6.91 撤销** —— 所以这里又可以不写死
  //    分位、直接按 min/max 复算。
  // ⚠️ ② 的封顶值：它 = 候选池差额的 `SCORING.teamPlanGapCapPct` 分位，
  //    这条规则改过两次（p50 → p75，见 `SCORING` 的注释）。取法与实现逐字一致。
  const ceilIdx = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  // ⚠️ 行上的 `total` 是**补金推荐分**（总分），① 的原始值是 `teamScore`（整包分）。
  const totals = plan.rows.map((r) => r.teamScore).sort((a, b) => a - b);
  assert.equal(plan.strengthLo, totals[0], '① 的下限应是候选池整包分的最小值');
  assert.equal(plan.strengthHi, totals[totals.length - 1], '① 的上限应是候选池整包分的最大值');
  const gaps = plan.rows.map((r) => r.gap).sort((a, b) => a - b);
  const expectCap = ceilIdx(gaps, SCORING.teamPlanGapCapPct);
  assert.equal(plan.gapMax, expectCap,
    `② 的封顶值应是候选池差额的 p${SCORING.teamPlanGapCapPct * 100} = ${expectCap} 金，实际 ${plan.gapMax}`);
  assert.equal(plan.gapCapPct, SCORING.teamPlanGapCapPct);
  assert.equal(plan.gapRealMax, 3, `展示批次的真实最大差额应是 3 金，实际 ${plan.gapRealMax}`);
  // 整包分最高的那支拿 ①=100。
  const top = [...plan.rows].sort((a, b) => b.teamScore - a.teamScore)[0];
  assert.equal(Math.round(top.strengthPct), 100, '整包分最高的那支应拿满分');
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

section('A1. 抽卡权重（强度 / 性价比，用户 2026-10-12 第 3、4、8 条）');

/**
 * 两支**故意反着来**的队伍，用来证明两条轴各管一头：
 *
 *   * `k-strong`：角色总榜整包分 900（池内最高）→ 补金 3 金（你自己要补的多）；
 *   * `k-cheap` ：角色总榜整包分 400（池内最低）→ 补金 1 金（你自己要补的少）。
 *
 * ⚠️ ① 的原始值就是 `total`（**含金数项**，用户 2026-10-12 第 8 条原话：「就抽卡方案提供的
 * 强度而言，同样是绝境 0T，9 金队要比 16 金队强得多，唯有通过此才能区分哪个队伍值得被
 * 用户补金」）。v4.6.87~v4.6.90 这里曾经放一个独立的 `strength`（纯强度）——已撤销，
 * 所以夹具里也不再有那个字段；**下面的断言会钉住「行上没有 strength、① 就是 total」**。
 */
const strengthFixture = {
  ...conclusionFixture,
  frontierUnits: [
    { key: 'k-strong', name: 'charX', eidolon: 0, lc: 'coneB', superimp: 1,
      total: 900, envCount: 1,
      envs: [{ id: 'env1', value: 900, bestTeamGold: 9, members: TEAMS.carrier }] },
    { key: 'k-cheap', name: 'charY', eidolon: 0, lc: null, superimp: 1,
      total: 400, envCount: 1,
      envs: [{ id: 'env2', value: 400, bestTeamGold: 16, members: TEAMS.bodyGap }] },
  ],
};
const strengthPlan = (drawWeights) => teamPlan(strengthFixture, accountFixture,
  { availability, drawWeights });

check('⭐ ① = **角色总榜整包分**（含金数项）：同为 0T，金数更少的那支分更高', () => {
  const plan = strengthPlan();
  // ① 的刻度 = 候选池整包分的最小 / 最大值（v4.6.91 起：不再是纯强度的池内分位）。
  assert.equal(plan.strengthLo, 400, '① 的下限应是池内整包分最低的那支');
  assert.equal(plan.strengthHi, 900, '① 的上限应是池内整包分最高的那支');
  // ⚠️ 旧字段名不许复活：`scoreLo/scoreHi`（v4.6.87 把同一对数拆成两个名字）与
  //    `strengthFloorPct`（v4.6.90 的分位下限）都已删除。
  assert.equal(plan.scoreLo, undefined, 'scoreLo 已删除（它与 strengthLo 是同一对数）');
  assert.equal(plan.scoreHi, undefined, 'scoreHi 已删除');
  assert.equal(plan.strengthFloorPct, undefined, 'strengthFloorPct 已删除（分位下限已撤销）');
  // ⚠️ 判定必须按**成员**找行，不能按 `key`：下发的 `key` 是 roster 键（成员整包键拼的），
  // 不是整包自己的 `k-*` 键。
  const rowOf = (plan2, char) => plan2.rows.find((r) => r.members.some((m) => m.char === char));
  const cheap = rowOf(plan, 'charX');
  const pricey = rowOf(plan, 'charY');
  // 数据集里更便宜（整包分 900）的那支拿 100，更贵的那支拿 0 —— 「9 金 ≫ 16 金」在界面上
  // 就是这一格的差别。
  assert.equal(Math.round(cheap.strengthPct), 100);
  assert.equal(Math.round(pricey.strengthPct), 0);
  // ① 的原始值就是队分本身（`teamScore`），且**行上不再有独立的 `strength`**。
  assert.equal(Math.round(cheap.teamScore), 900);
  assert.equal(Math.round(pricey.teamScore), 400);
  assert.ok(plan.rows.every((r) => r.strength === undefined),
    '行上不许再出现 strength（纯强度那套已撤销）');
});

check('⭐ 抽卡权重只认**相对大小**：3:1 与 0.75:0.25 得到同一个榜', () => {
  const a = strengthPlan({ strength: 3, cost: 1 });
  const b = strengthPlan({ strength: 0.75, cost: 0.25 });
  assert.deepEqual(a.drawWeights, { strength: 0.75, cost: 0.25 }, '回显生效权重（已归一化）');
  assert.deepEqual(a.rows.map((r) => r.key), b.rows.map((r) => r.key), '名次必须逐位一致');
  for (const [i, r] of a.rows.entries()) {
    assert.equal(r.total, b.rows[i].total, `${r.key}: 总分必须逐位一致`);
  }
  // ⚠️ 用户 2026-10-13 第 1、2 条加了第三个旋钮（泛用性），但它**只作用于角色总榜**：
  // 抽卡方案按 `strength : cost` 在自己内部两两归一，所以调泛用性**不许**动方案。
  const withVersatility = strengthPlan({ strength: 3, cost: 1, versatility: 9 });
  assert.deepEqual(withVersatility.drawWeights, { strength: 0.75, cost: 0.25 },
    '抽卡方案只吃强度/性价比两项，泛用性旋钮不许改它回显的系数');
  assert.deepEqual(withVersatility.rows.map((r) => r.key), a.rows.map((r) => r.key),
    '泛用性旋钮不许改抽卡方案的名次');
});

check('⭐ 强度权重高 → 整包分高的在前；性价比权重高 → 补金少的在前', () => {
  // 判定按**成员**（`key` 是 roster 键）：charX 那支 = 整包分 900、补 3 金；charY 那支 =
  // 整包分 400、补 1 金。
  const first = (plan) => (plan.rows[0].members.some((m) => m.char === 'charX') ? 'strong' : 'cheap');
  // 强度档：只有 ① 算数 → 整包分 900 的那支（补 3 金）第一。
  const byStrength = strengthPlan({ strength: 1, cost: 0 });
  assert.equal(first(byStrength), 'strong',
    '强度权重拉满时该推整包分最高的那支（补 3 金）');
  // 性价比档：只有差额接近度算数 → 补 1 金的那支第一。
  const byCost = strengthPlan({ strength: 0, cost: 1 });
  assert.equal(first(byCost), 'cheap', '性价比权重拉满时该推补金最少的那支');
  assert.ok(byCost.rows[0].gap < byStrength.rows[0].gap, '两支的差额确实是一大一小');
});

check('抽卡权重的边界：全部清空 / 非法值 → 退回默认等权，不出现整列 0 分', () => {
  // ⚠️ 2026-10-13 第 1 条加了第三个旋钮（泛用性）之后，「清空」必须**三个键一起**才算
  // 「我没有偏好」；只清两个、第三个留着默认 1 时，第三项就是 100% —— 那是真实的偏好。
  const even = { strength: 1 / 3, cost: 1 / 3, versatility: 1 / 3 };
  assert.deepEqual(normalizeDrawWeights({ strength: 0, cost: 0, versatility: 0 }), even);
  assert.deepEqual(normalizeDrawWeights({ strength: '', cost: '', versatility: '' }), even,
    '空串 = 用户清空了输入框 → 按 0 算，三个都是 0 时退回默认等分');
  assert.deepEqual(normalizeDrawWeights({ strength: -1, cost: 'abc', versatility: NaN }), even,
    '非法值忽略、退回默认');
  assert.deepEqual(normalizeDrawWeights({ strength: 2, cost: null }),
    { strength: 0.5, cost: 0.25, versatility: 0.25 },
    '只给一个键时另两个按默认值补齐');
  assert.deepEqual(normalizeDrawWeights({ strength: 1, cost: 0 }),
    { strength: 0.5, cost: 0, versatility: 0.5 },
    '单边为 0 是**合法**的：用户可以把某一侧彻底关掉');
  assert.deepEqual(normalizeDrawWeights({ strength: 0, cost: 0 }),
    { strength: 0, cost: 0, versatility: 1 },
    '只清空强度/性价比 = 全押泛用性（第三个框还开着，那不是「没有偏好」）');
  assert.deepEqual(normalizeDrawWeights(undefined), even,
    '不给参数时用默认值（默认 1:1:1 → 等分）');
});

check('⭐ 性价比只有**差额接近度**一个刻度：差额与整包分都相同时同分（用户 2026-10-12 第 6 条）', () => {
  // 用户原话：「性价比得分、差额接近分、压金度，三者是不是过于重叠了，我只想保留差额接近度
  // 的得分」。所以：**账面金数不进分数**，也不再有「性价比得分」这个中间量。
  //
  // 这条用例是原来那条「差额相同时更压金的排前面」（v4.6.87）的**反向钉法**：
  // 同差额 + 同整包分的两支，现在必须**同分**，名次只由确定性兜底键（rosterKey）决定。
  // 一旦有人把第二个金数刻度（「压金度」那类）加回来，这两支就会分出高下 —— 立刻红。
  // ⚠️ 夹具两支的整包分必须**相同**（`total` 一样）且账面金数不同（4 vs 3），
  //    否则测的就不是「账面金数不进分数」了。
  const pairs = [
    // P：账面 4 金（charA E1 + coneA + charB），补金 2 金（charA E0→E1 + coneA）
    { key: 'k-pricey', name: 'charA', eidolon: 1, lc: 'coneA', superimp: 1, total: 500,
      envCount: 1,
      envs: [{ id: 'env1', value: 500, bestTeamGold: 4,
        members: [member('charA', 1, 'coneA'), member('charB'), member('freeC')] }] },
    // Q：账面 3 金（charY + coneB + charB），补金同样 2 金（charY 本体 + coneB）
    { key: 'k-budget', name: 'charY', eidolon: 0, lc: 'coneB', superimp: 1, total: 500,
      envCount: 1,
      envs: [{ id: 'env2', value: 500, bestTeamGold: 3,
        members: [member('charY', 0, 'coneB'), member('charB'), member('freeC')] }] },
  ];
  const plan = teamPlan({ ...conclusionFixture, frontierUnits: pairs }, accountFixture,
    { availability });
  assert.equal(plan.rows.length, 2, '两支都该进结果');
  assert.deepEqual(plan.rows.map((r) => r.gap), [2, 2],
    '两支的补金差额必须相同 —— 否则这条用例测的是差额');
  // 整包分也一样（都是 500 → 都拿 100 分），所以总分只可能由**差额**那一侧决定。
  assert.deepEqual(plan.rows.map((r) => Math.round(r.strengthPct)), [100, 100]);
  // 账面金数确实不同（4 vs 3）—— 它**不再**影响名次，这正是本条要钉的点。
  assert.deepEqual(plan.rows.map((r) => r.gold).sort((a, b) => a - b), [3, 4],
    '夹具的两支账面金数必须不同，否则这条用例空跑');
  assert.ok(Math.abs(plan.rows[0].total - plan.rows[1].total) < 1e-9,
    `只看差额接近度时两队应当同分（实际 ${plan.rows[0].total} vs ${plan.rows[1].total}）`);
  assert.deepEqual(plan.rows.map((r) => r.gapPct), [plan.rows[0].gapPct, plan.rows[0].gapPct],
    '两队的差额接近度也应当相同');
  // 同分之后名次仍必须可复现（两支的 rosterKey 不同，靠它兜底）。
  const again = teamPlan({ ...conclusionFixture, frontierUnits: pairs }, accountFixture,
    { availability });
  assert.deepEqual(again.rows.map((r) => r.key), plan.rows.map((r) => r.key),
    '同分时的名次必须可复现');
});

check('指标②是**分位封顶 + 曲线指数**：达到/超过封顶值一律 0 分，以下按 (1 − 差额÷封顶)^k 展开', () => {
  const plan = fixturePlan();
  const cap = plan.gapMax;
  // ⚠️ 这里验的是**规则**，不写死封顶值与指数 —— 两者都改过（封顶 p50 → p75；
  //    指数 1 → 1.5，用户 2026-10-12 第 9 条「差额接近度给要补大量金的队伍的分太多」）。
  // 规则：≥ 封顶 → 0 分；以下 → `100 × (1 − 差额 ÷ 封顶) ^ SCORING.teamPlanGapPower`。
  const power = Math.max(1, Number(SCORING.teamPlanGapPower) || 1);
  for (const r of plan.rows) {
    const expect = Math.max(0, Math.min(100, 100 * (1 - r.gap / cap) ** power));
    assert.ok(near(r.gapPct, expect),
      `${r.gap} 金 ÷ 封顶 ${cap} 金 的 ② 应是 ${expect}（^${power}），实际 ${r.gapPct}`);
  }
  // ⚠️ 指数必须**真的在压尾部**：这是用户第 9 条要的东西。线性（^1）时 8 金能拿 42.9 分，
  //    ^1.5 只有 28.1 —— 如果哪天有人把指数改回 1，这条断言会红给他看。
  assert.ok(power > 1, `曲线指数应当 > 1（实际 ${power}）`);
  // ⚠️ 用**名义封顶 14 金**验曲线形状：夹具那 3 支的差额只有 1/1/3 金，套在它们身上
  //    8 金、10 金那几档全都落在封顶之外（一律 0 分），验不出尾部被压。
  const NOMINAL_CAP = 14;
  const tail = caret(8, NOMINAL_CAP, power);
  const linear = caret(8, NOMINAL_CAP, 1);
  assert.ok(tail < linear - 5,
    `补 8 金的 ② 应当明显低于线性（^${power} = ${tail.toFixed(1)} vs 线性 ${linear.toFixed(1)}）`);
  // 小差额几乎不受影响（否则这一档会把「补 1~2 金」的队伍一起罚掉）
  assert.ok(caret(2, NOMINAL_CAP, power) > caret(2, NOMINAL_CAP, 1) - 8,
    '补 2 金的 ② 不该被指数砍掉太多');
  // 封顶值必须真的落在池内（否则「封顶」两个字没有意义）
  assert.ok(plan.rows.some((r) => r.gap >= cap), `池内应有队伍补金 ≥ 封顶值 ${cap}`);
  // 换一批：让池内出现「差额 1 金」的队伍，就能看到「以下」那一段的正分
  const wide = teamPlan({
    ...conclusionFixture,
    frontierUnits: conclusionFixture.frontierUnits.map((u) => (u.name === 'charY'
      ? { ...u, envs: [{ ...u.envs[0], members: [member('charY', 6), member('charB'), member('freeC')] }] }
      : u)),
  }, accountFixture, { availability });
  const wcap = wide.gapMax;
  const byGap = (g) => wide.rows.find((r) => r.gap === g);
  assert.ok(byGap(1), `应有补 1 金的队伍（实际 ${wide.rows.map((r) => r.gap)}）`);
  assert.equal(Math.round(byGap(1).gapPct), Math.round(caret(1, wcap, power)),
    `1 金 ÷ 封顶 ${wcap} 金 的 ② 应落在封顶值以内、按 ^${power} 拿分`);
  assert.ok(byGap(1).gapPct > 0, '1 金应拿正分（否则「以下」这段没被验到）');
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

check('/conclusion 回 payload: 8（三个分项 + 角色得分 + drawWeights 那一版）', () => {
  assert.equal(live.status, 200);
  // ⚠️ 形状号的历史：v4.6.87 曾把它写成 8（每个整包多一个 `strength` = 纯强度），
  //    v4.6.91 按用户 2026-10-12 第 8 条撤销了那个字段、形状回到 7。
  //    用户 2026-10-13 第 1、2 条**重新要了强度这个分项**（换了名字：`strengthTotal` /
  //    `envStrength`），并新增角色得分与 `drawWeights` 回显 —— 所以这里又回到 **8**，
  //    而且这一次是真正生效的 8。改它之前先看 `conclusion.js` 里那段形状号注释。
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

check('⭐ 真载荷：① 就是整包分（含金数项），同为 0T 时金数更少的队分更高', () => {
  // 用户 2026-10-12 第 8 条原话：「就抽卡方案提供的强度而言，同样是绝境 0T，9 金队要比
  // 16 金队强得多，唯有通过此才能区分哪个队伍值得被用户补金」。所以：
  //   * ① 的原始值 = 整包的 `total`（含 `min(1, 该版本最便宜金数 ÷ 本队金数)`），
  //     载荷里**不再**单发一个不含金数项的 `strength`（v4.6.91 撤销，见 changelog）；
  //   * 下面那条数据事实钉住「9 金 ≫ 16 金」确实成立（不是靠文案说的）。
  const account = { owned: new Set(), eidolons: new Map(), cones: new Map() };
  // ⚠️ 端点必须**在整池**上量：`options.maxRows` 只能往下夹（`SCORING.teamPlanMaxRows`）。
  const keepRows = SCORING.teamPlanMaxRows;
  SCORING.teamPlanMaxRows = 100000;
  let whole;
  try {
    whole = teamPlan(livePayload, account, { availability: livePayload.availability });
  } finally {
    SCORING.teamPlanMaxRows = keepRows;
  }
  const byScore = [...whole.rows].sort((a, b) => b.teamScore - a.teamScore);
  assert.ok(byScore.length > 50, `整池应当有几十支，实际 ${byScore.length}`);
  assert.equal(Math.round(byScore[0].strengthPct), 100, '整包分最高的那支应拿 100');
  assert.equal(Math.round(byScore[byScore.length - 1].strengthPct), 0, '整包分最低的那支应拿 0');
  // ① 的原始值与队分是同一个数（界面那一列印的就是它）。
  for (const r of byScore.slice(0, 20)) {
    assert.ok(Math.abs(Number(r.strengthPct) - 100 * (r.teamScore - whole.strengthLo)
      / (whole.strengthHi - whole.strengthLo)) < 0.51,
      `${r.key}: ① 应当是整包分在池内的位置`);
  }
  // 数据事实：同为满分档，9 金那批的最高分远高于 16 金那批（用户点名的那个对比）。
  const bestByGold = (g) => Math.max(0, ...whole.rows.filter((r) => r.gold === g).map((r) => r.teamScore));
  const best9 = bestByGold(9);
  const best16 = bestByGold(16);
  if (best9 > 0 && best16 > 0) {
    assert.ok(best9 > best16 * 1.2,
      `同为绝境 0T：9 金那支（${best9.toFixed(0)}）应当明显强于 16 金那支（${best16.toFixed(0)}）`);
  } else {
    console.log(`      · 池内没有 9 金 / 16 金的整包（9=${best9} / 16=${best16}），本条只验了不变量`);
  }
  // ⚠️ 撤销得干净：**载荷的任何一层都不该再有 `strength`**
  //    （v4.6.87 顶层发过它、逐副本刻意没发；现在两层都不发）。
  const withStrength = livePayload.frontierUnits.filter((u) => 'strength' in u);
  assert.equal(withStrength.length, 0, '顶层整包不该再带 strength');
  const envWithStrength = livePayload.frontierUnits
    .flatMap((u) => u.envs || []).filter((e) => 'strength' in e);
  assert.equal(envWithStrength.length, 0, '逐副本明细也不该带 strength');
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

check('⭐⭐ 真载荷：那支 16 金的队伍不再排第 1', () => {
  // 用户 2026-10-12 第 5 条的原话：「目前我的账号的抽卡方案，优先推荐的队伍是
  // 遐蝶E2S1、风堇E2、昔涟E2S1、长夜月E2，这个队伍已经过时了，已被更能压成本的队伍
  // 取代」。实测那支在真数据集上是 **16 金**（4.6 要 20 金才满分），而 4.6 最便宜的满分
  // 只要 9 金。这一条钉「它不再排第 1」。
  //
  // 它被压下去的原因有三层，**都在 ① 那一侧**（用户第 8 条之后 ① = 含金数项的整包分）：
  //   ① 金数项直接惩罚它（同为 0T，16 金的金数项约 0.53，11 金那支约 0.63）；
  //   ② 版本窗口 7 → 3 砍掉它 32.1% 的旧版本分；
  //   ③ 它的补金差额与第 1 名相同（都是 4 金），② 那一侧帮不上忙。
  // 实测（账号 1，默认权重）它落在 **#3**：补金推荐分 66.4 = 强度 61.4 + 差额 71.4。
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
  // ⚠️ 用户 2026-10-12 第 6 条：性价比那一侧**只有**差额接近度，中间量已删除。
  //    这里把「不再有第二个金数刻度」钉住 —— 加回来就是用户否掉的「三者重叠」。
  assert.ok(plan.rows.every((r) => Number.isFinite(r.gapPct)
    && r.costPct === undefined && r.goldPct === undefined),
    '每一行带 gapPct，且不再下发 costPct / goldPct');
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
