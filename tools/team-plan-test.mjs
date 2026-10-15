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
  DEFAULT_HIDDEN_COSTS, NO_HIDDEN_COSTS, SCORING, eidolonTierOf, eidolonsOf, lightConeRanksOf,
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
 *  ⚠️ 形状是 `sign(t) × |t|^k`，幅值截到 1（值域 [−100, 100]）——**不能**直接写
 *     `t ** k`：负数取小数次幂是 `NaN`（2026-10-15 接通负分时踩到的就是这个）。
 *  ⚠️ 2026-10-15 起 **0 以下不再截断**：正好到封顶值 = 0 分，超过转负分。
 *     改前那句注释写的是「先 clamp 再取幂」，那正是被用户否掉的做法。 */
const caret = (gap, cap, power) => {
  const t = 1 - gap / cap;
  return 100 * Math.max(-1, Math.min(1, Math.sign(t) * Math.abs(t) ** power));
};

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
  // ⚠️ 每条整包必须**同时**带 `total` 与 **`strengthScore`**（2026-10-15 起 ① 读后者）：
  //    * `total` = 老口径的整包分（含金数项）—— 现在只用来展示队分与做同分兜底排序；
  //    * `strengthScore` = **新口径的绝对强度分**（0~100，与角色总榜那一列同源），① 读它。
  //    ⚠️ 两者在夹具里**刻意反相关**（k-cone 的 total 最高、强度最低；k-body 的 total 居中、
  //       强度最高）：这样「① 又退回按 total 算」会当场红 —— 与 v4.6.97 那条
  //       「夹具不带 `versatilityRaw` ③ 就整列退化」同一个教训。
  frontierUnits: [
    { key: 'k-body', name: 'charY', eidolon: 0, lc: null, superimp: 1, total: 600,
      strengthScore: 90, envCount: 1,
      envs: [{ id: 'env2', value: 600, bestTeamGold: 3, members: TEAMS.bodyGap }] },
    { key: 'k-carrier', name: 'charX', eidolon: 1, lc: 'coneB', superimp: 1, total: 800,
      strengthScore: 45, envCount: 1,
      envs: [{ id: 'env1', value: 800, bestTeamGold: 4, members: TEAMS.carrier }] },
    { key: 'k-cone', name: 'charA', eidolon: 0, lc: 'coneA', superimp: 1, total: 1000,
      strengthScore: 30, envCount: 1,
      envs: [{ id: 'env1', value: 1000, bestTeamGold: 4, members: TEAMS.coneGap }] },
    { key: 'k-zero', name: 'charA', eidolon: 0, lc: null, superimp: 1, total: 200,
      strengthScore: 12, envCount: 1,
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

check('三个分量按**抽卡权重**合成，默认 1:1:1 = 三等分', () => {
  const plan = fixturePlan();
  const draw = plan.drawWeights;
  // ⚠️ 用户 2026-10-13 第 3 条（「泛用性权重也适用于补金推荐」）之前这里是 `0.5 / 0.5`
  //    （方案只吃强度与性价比、两项自己再归一）。现在三项一起归一 → 各 1/3。
  assert.deepEqual(draw, {
    strength: 1 / 3, cost: 1 / 3, versatility: 1 / 3,
  }, '默认抽卡权重应是 1:1:1 归一化后的三等分');
  for (const r of plan.rows) {
    // ⚠️ 第二项是 `gapPct`（用户 2026-10-12 第 6 条：性价比这一侧只有差额接近度）；
    //    第三项是 `versatilityPct`（用户 2026-10-13 第 3 条）。
    assert.ok(Math.abs(r.total - (draw.strength * r.strengthPct + draw.cost * r.gapPct
      + draw.versatility * r.versatilityPct)) < 1e-4,
    `${r.key}: ${r.total} ≠ ${draw.strength}×${r.strengthPct} + ${draw.cost}×${r.gapPct}`
      + ` + ${draw.versatility}×${r.versatilityPct}`);
  }
});

check('刻度的取样集合是**整个候选池**（不是写死的常数，也不是要展示的那几条）', () => {
  const plan = fixturePlan();
  // 候选池 = 3 支（差额 0 的那支被剔除）：队分 600 / 800 / 1000，强度分 90 / 45 / 30。
  //
  // ⚠️ ① 的刻度是**绝对 0 ~ 100**（2026-10-15 起，与角色总榜那一列同一把尺子）——
  //    **不再**是「池内整包分的最小 ~ 最大值」。历史：v4.6.87 换成纯强度、v4.6.90 把下限
  //    抬到池内 p75、v4.6.91 撤销回 `total` 的池内 min-max、2026-10-15 换成新口径的
  //    绝对强度分（那时池内第一会被顶成 100 分，正是用户报的那个观感）。
  // ⚠️ ② 的封顶值：它 = 候选池差额的 `SCORING.teamPlanGapCapPct` 分位，
  //    这条规则改过两次（p50 → p75，见 `SCORING` 的注释）。取法与实现逐字一致。
  const ceilIdx = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  assert.equal(plan.strengthLo, 0, '① 的下限是绝对刻度 0');
  assert.equal(plan.strengthHi, 100, '① 的上限是绝对刻度 100');
  const gaps = plan.rows.map((r) => r.gap).sort((a, b) => a - b);
  const expectCap = ceilIdx(gaps, SCORING.teamPlanGapCapPct);
  assert.equal(plan.gapMax, expectCap,
    `② 的封顶值应是候选池差额的 p${SCORING.teamPlanGapCapPct * 100} = ${expectCap} 金，实际 ${plan.gapMax}`);
  assert.equal(plan.gapCapPct, SCORING.teamPlanGapCapPct);
  assert.equal(plan.gapRealMax, 3, `展示批次的真实最大差额应是 3 金，实际 ${plan.gapRealMax}`);
  // ① 直接就是**该队成员里最高的那个 `strengthScore`**（不是队分折算出来的位置）。
  const rowOf = (plan2, char) => plan2.rows.find((r) => r.members.some((m) => m.char === char));
  // charY 那支（k-body：整包分 600、强度 90）拿最高分，charA 那支（k-cone：整包分 1000、
  // 强度 30）反而最低 —— 两者在夹具里**反相关**，所以这条断言能抓住任何「按 total 算」的回退。
  assert.equal(rowOf(plan, 'charY').strengthPct, 90, '① 应直接取该队的 strengthScore');
  assert.equal(rowOf(plan, 'charX').strengthPct, 45, '① 不看整包分（charX 的 total 更高、强度更低）');
  assert.equal(rowOf(plan, 'charA').strengthPct, 30, '① 不看整包分（charA 的 total 最高）');
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
    assert.equal(p.strengthLo, full.strengthLo, `⚠️ ${label}：① 的下限不能随展示条数变`);
    assert.equal(p.strengthHi, full.strengthHi, `⚠️ ${label}：① 的上限不能随展示条数变`);
    assert.equal(p.versatilityLo, full.versatilityLo, `⚠️ ${label}：③ 的下限不能随展示条数变`);
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
 *   * `k-strong`：绝对强度分 96（池内最高）→ 补金 3 金（你自己要补的多）；
 *   * `k-cheap` ：绝对强度分 20（池内最低）→ 补金 1 金（你自己要补的少）。
 *
 * ⚠️ 2026-10-15 起 ① 的原始值是 **`strengthScore`**（角色总榜那一列的绝对强度分，
 * 0~100），**不是** `total`（含金数项的整包分）。用户 2026-10-14 第 10 条把「强度」
 * 重定为「围绕行动值 + 投入单调」，并明确「省金是**性价比**那一项的事」——
 * 所以这里的 `total` 只用来展示队分，① 与它无关。
 * 历史：v4.6.87~v4.6.90 曾用「纯强度」+ 池内 p75 下限，v4.6.91~2026-10-14 用 `total`
 * 的池内 min-max（那时**池内第一必然拿 100 分**，用户 2026-10-15 报的正是这个）。
 */
const strengthFixture = {
  ...conclusionFixture,
  // ⚠️ `versatilityRaw` 必须给（用户 2026-10-13 第 3 条）：队级 ③ = 队内成员各自那个数
  //    按**成本占比**加权（2026-10-14 第 1 条改的口径，见下面那条专门的用例），
  //    而 `teamPlan()` 是从 `frontierUnits` 建「角色 + 星魂档 → 泛用性」那张表的 ——
  //    夹具里不带这个字段的话，两队都算成 0，③ 退化成「全池同分」（`span` 给 1），
  //    于是「泛用性权重起作用」这件事**在夹具上根本测不出来**。
  //    两个数刻意不同（40 / 10），让 ③ 真的分得开。
  // ⚠️ `strengthScore` 同样必须给（理由见上）：两个数刻意差得远（96 / 20）。
  // ⚠️ 整包自己的 `eidolon` / `lc` 必须与它在 `TEAMS.*` 里的**成员条目一致** ——
  //    ① 是按**成员的整包键**去查强度分的，对不上就查成 0（真实数据里天然一致：
  //    头条整包自己的配置就是它的成员之一；夹具得手写对齐）。
  frontierUnits: [
    { key: 'k-strong', name: 'charX', eidolon: 1, lc: 'coneB', superimp: 1,
      total: 900, strengthScore: 96, envCount: 1, versatilityRaw: 40,
      envs: [{ id: 'env1', value: 900, bestTeamGold: 9, members: TEAMS.carrier }] },
    { key: 'k-cheap', name: 'charY', eidolon: 0, lc: null, superimp: 1,
      total: 400, strengthScore: 20, envCount: 1, versatilityRaw: 10,
      envs: [{ id: 'env2', value: 400, bestTeamGold: 16, members: TEAMS.bodyGap }] },
  ],
};
const strengthPlan = (drawWeights) => teamPlan(strengthFixture, accountFixture,
  { availability, drawWeights });

check('⭐ ① = **绝对强度分**（0~100，不含金数项）：它直接取该队的 `strengthScore`', () => {
  const plan = strengthPlan();
  // ① 的刻度 = 绝对 0 ~ 100（与角色总榜那一列同一把尺子），**不是**池内 min-max。
  assert.equal(plan.strengthLo, 0, '① 的下限是绝对刻度 0');
  assert.equal(plan.strengthHi, 100, '① 的上限是绝对刻度 100');
  // ⚠️ 旧字段名不许复活：`scoreLo/scoreHi`（v4.6.87 把同一对数拆成两个名字）与
  //    `strengthFloorPct`（v4.6.90 的分位下限）都已删除。
  assert.equal(plan.scoreLo, undefined, 'scoreLo 已删除（① 现在根本没有「池内刻度」）');
  assert.equal(plan.scoreHi, undefined, 'scoreHi 已删除');
  assert.equal(plan.strengthFloorPct, undefined, 'strengthFloorPct 已删除（分位下限已撤销）');
  // ⚠️ 判定必须按**成员**找行，不能按 `key`：下发的 `key` 是 roster 键（成员整包键拼的），
  // 不是整包自己的 `k-*` 键。
  const rowOf = (plan2, char) => plan2.rows.find((r) => r.members.some((m) => m.char === char));
  const cheap = rowOf(plan, 'charX');
  const pricey = rowOf(plan, 'charY');
  // ① 就是**那个整包自己的强度分**（不是百分比位置、也不是队分折算）：
  // 夹具刻意让 `total` 与 `strengthScore` 反相关（900/96 与 400/20）。
  assert.equal(cheap.strengthPct, 96, '① 应等于该队的 strengthScore');
  assert.equal(pricey.strengthPct, 20, '① 与金数无关 —— 夹具里更贵的那支强度更低');
  // 队分（老口径的整包分）仍在行上，供界面展示与同分兜底排序用。
  assert.equal(Math.round(cheap.teamScore), 900);
  assert.equal(Math.round(pricey.teamScore), 400);
  // ⚠️ 行上**不许**再出现独立的 `strength` 字段（它与 `strengthPct` 是同一个数，
  //    v4.6.87~v4.6.90 那两个名字并存正是返工的来源）。
  assert.ok(plan.rows.every((r) => r.strength === undefined),
    '行上不许出现 strength（① 就是 strengthPct）');
});

check('⭐ 抽卡权重只认**相对大小**：3:1:1 与 0.6:0.2:0.2 得到同一个榜', () => {
  const a = strengthPlan({ strength: 3, cost: 1, versatility: 1 });
  const b = strengthPlan({ strength: 0.6, cost: 0.2, versatility: 0.2 });
  assert.deepEqual(a.drawWeights, { strength: 0.6, cost: 0.2, versatility: 0.2 },
    '回显生效权重（已归一化）');
  assert.deepEqual(a.rows.map((r) => r.key), b.rows.map((r) => r.key), '名次必须逐位一致');
  for (const [i, r] of a.rows.entries()) {
    assert.equal(r.total, b.rows[i].total, `${r.key}: 总分必须逐位一致`);
  }
  // ⚠️ **这条断言在 v4.6.97 反过来了**（用户 2026-10-13 第 3 条原话：
  //    「泛用性权重也适用于补金推荐」）。v4.6.95/96 时方案只吃强度/性价比、
  //    两项自己再归一，所以当时钉的是「调泛用性**不许**动方案」；
  //    现在三项一起归一，泛用性拉满 = 系数 `0 / 0 / 1`，名次只由 ③ 决定。
  const onlyVersatility = strengthPlan({ strength: 0, cost: 0, versatility: 1 });
  assert.deepEqual(onlyVersatility.drawWeights, { strength: 0, cost: 0, versatility: 1 },
    '泛用性拉满时三项系数应是 0 / 0 / 1');
  for (const r of onlyVersatility.rows) {
    assert.ok(Math.abs(r.total - r.versatilityPct) < 1e-4,
      `${r.key}: 总分应当只等于 ③（${r.total} vs ${r.versatilityPct}）`);
  }
  // ③ 真的分得开才说明它**在算**（夹具 charX 40 / charY 10 人）：
  // 队级 ③ 的原始量是「队内平均」，刻度是候选池的 min ~ max。
  assert.ok(onlyVersatility.versatilityHi > onlyVersatility.versatilityLo,
    `③ 的刻度不该退化：${onlyVersatility.versatilityLo} ~ ${onlyVersatility.versatilityHi}`);
  assert.equal(Math.round(onlyVersatility.rows[0].versatilityPct), 100,
    '泛用性拉满时该由「队内平均泛用性最高」的那支排第一');
});

check('⭐ 队级泛用性 = 成员各自泛用性按**成本占比**加权（用户 2026-10-14 第 1 条）', () => {
  // 用户原话：「整个队伍的泛用性根据不同角色的成本占整个队伍的成本的权重而定」。
  // 改前（v4.6.97）是**简单平均**（四个成员一人一份），现在按各自金数占比加权。
  const plan = strengthPlan({ strength: 0, cost: 0, versatility: 1 });
  const rowOf = (char) => plan.rows.find((r) => r.members.some((m) => m.char === char));
  const carrier = rowOf('charX');
  const bodyGap = rowOf('charY');
  // 夹具只有两个整包带 `versatilityRaw`（charX 40 / charY 10），其余成员查不到 → 按 0 参与。
  //   carrier = charX(E1 + coneB S1 = 1 本体 + 1 星魂 + 1 光锥 = 3 金) + charB(1 金) + freeC(0)
  //             → 总金 4 → (40×3 + 0×1 + 0×0) / 4 = **30**
  //   bodyGap = charY(E0 = 1 金) + charB(1 金) + freeC(0) → 总金 2 → (10×1 + 0 + 0) / 2 = **5**
  // ⚠️ 简单平均会给 13.33 / 3.33 —— 两组数都咬得住「退回简单平均」这个回归；
  //    而「分母用成员数而不是总金数」会给出 30 / 5 之外的值（40×3/3 = 40、10×1/2 = 5），
  //    所以 carrier 那个 30 同时钉住了分母。
  assert.ok(near(carrier.versatilityRaw, 30),
    `carrier 的成本加权泛用性应为 30，实际 ${carrier.versatilityRaw}`);
  assert.ok(near(bodyGap.versatilityRaw, 5),
    `bodyGap 的成本加权泛用性应为 5，实际 ${bodyGap.versatilityRaw}`);
});

check('⭐ 强度权重高 → 强度分高的在前；性价比权重高 → 补金少的在前；泛用性高 → 队内平均高的在前', () => {
  // 判定按**成员**（`key` 是 roster 键）：charX 那支 = 强度分 96、补 3 金、泛用性 40；
  // charY 那支 = 强度分 20、补 1 金、泛用性 10。
  const first = (plan) => (plan.rows[0].members.some((m) => m.char === 'charX') ? 'strong' : 'cheap');
  // ⚠️ **每一档都要把另外两项显式置 0**（用户 2026-10-13 第 3 条之后方案吃三项）：
  //    v4.6.95/96 时只写 `{ strength: 1, cost: 0 }` 就够了（方案只有两项），
  //    现在漏掉的第三项会按**默认值 1** 补齐，于是「只测 ①」这件事根本不成立。
  const byStrength = strengthPlan({ strength: 1, cost: 0, versatility: 0 });
  assert.equal(first(byStrength), 'strong',
    '强度权重拉满时该推强度分最高的那支（补 3 金）');
  const byCost = strengthPlan({ strength: 0, cost: 1, versatility: 0 });
  assert.equal(first(byCost), 'cheap', '性价比权重拉满时该推补金最少的那支');
  assert.ok(byCost.rows[0].gap < byStrength.rows[0].gap, '两支的差额确实是一大一小');
  // ③ 的独立检验（同一条规矩：另两项置 0）。
  const byVersatility = strengthPlan({ strength: 0, cost: 0, versatility: 1 });
  assert.equal(first(byVersatility), 'strong',
    '泛用性权重拉满时该推「队内平均泛用性」最高的那支（charX 40 vs charY 10）');
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
      strengthScore: 70, envCount: 1,
      envs: [{ id: 'env1', value: 500, bestTeamGold: 4,
        members: [member('charA', 1, 'coneA'), member('charB'), member('freeC')] }] },
    // Q：账面 3 金（charY + coneB + charB），补金同样 2 金（charY 本体 + coneB）
    { key: 'k-budget', name: 'charY', eidolon: 0, lc: 'coneB', superimp: 1, total: 500,
      strengthScore: 70, envCount: 1,
      envs: [{ id: 'env2', value: 500, bestTeamGold: 3,
        members: [member('charY', 0, 'coneB'), member('charB'), member('freeC')] }] },
  ];
  const plan = teamPlan({ ...conclusionFixture, frontierUnits: pairs }, accountFixture,
    { availability });
  assert.equal(plan.rows.length, 2, '两支都该进结果');
  assert.deepEqual(plan.rows.map((r) => r.gap), [2, 2],
    '两支的补金差额必须相同 —— 否则这条用例测的是差额');
  // 两队的 ①（绝对强度分）也一样（都是 70），所以总分只可能由**差额**那一侧决定。
  assert.deepEqual(plan.rows.map((r) => r.strengthPct), [70, 70]);
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

check('指标②是**分位封顶 + 曲线指数**：正好到封顶值 0 分、超过转负分，以下按 |1 − 差额÷封顶|^k 展开', () => {
  const plan = fixturePlan();
  const cap = plan.gapMax;
  // ⚠️ 这里验的是**规则**，不写死封顶值与指数 —— 三者都改过（封顶 p50 → p75 → p60；
  //    指数 1 → 1.5 → 1.8，用户 2026-10-12 第 9 条「差额接近度给要补大量金的队伍的分太多」；
  //    以及 2026-10-15 用户「可不可以让性价比过低的得分改为负数」→ **0 以下不再截断**）。
  // 规则：`sign(t) × |t|^k × 100`（t = 1 − 差额 ÷ 封顶），幅值截到 1 ⇒ 值域 [−100, 100]。
  const power = Math.max(1, Number(SCORING.teamPlanGapPower) || 1);
  for (const r of plan.rows) {
    const expect = caret(r.gap, cap, power);
    assert.ok(near(r.gapPct, expect),
      `${r.gap} 金 ÷ 封顶 ${cap} 金 的 ② 应是 ${expect.toFixed(1)}（^${power}），实际 ${r.gapPct}`);
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
  // ⚠️ 2026-10-15：这一段从「≥ 封顶 → 0 分」改成「**超过**封顶才转负分，正好等于封顶仍是 0」
  //    （用户要求「性价比过低的得分改为负数」—— 截断在 0 会让贵队之间全部打平）。
  for (const r of wide.rows.filter((x) => x.gap > wcap)) {
    assert.ok(r.gapPct < 0, `${r.gap} 金 > 封顶 ${wcap} 金 → 应当是负分（实际 ${r.gapPct}）`);
    assert.ok(r.gapPct >= -100, `${r.gap} 金的 ② 不应低于 −100（实际 ${r.gapPct}）`);
  }
  const atCap = wide.rows.filter((x) => x.gap === wcap);
  for (const r of atCap) {
    assert.ok(near(r.gapPct, 0), `${r.gap} 金 = 封顶 ${wcap} 金 → 应当正好 0 分（实际 ${r.gapPct}）`);
  }
  // ⚠️ 上一条循环只在「下发的 15 条里真的出现过超封顶的队伍」时才验到东西。为了不让它
  //    静默空跑，这里再钉**曲线本身**的三条性质（纯函数，与池内构成无关）：
  assert.ok(caret(wcap + 1, wcap, power) < 0, '超过封顶值应当算出负分');
  assert.ok(caret(wcap * 2, wcap, power) < caret(wcap + 1, wcap, power),
    '补得越多负得越多（单调下降）');
  assert.ok(caret(wcap * 5, wcap, power) >= -100, '② 的值域下限是 −100（幅值截到 1）');
  assert.ok(caret(0, wcap, power) === 100, '补金 0 金应当是满分 100（幅值上限同样是 1）');
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

check('队分与 ① 都跟着**同一个代表整包**走（不许借队内别的成员在别队打出的强度）', () => {
  const mixed = {
    ...conclusionFixture,
    frontierUnits: [
      // ⚠️ 两条**刻意反着给**：队分（`total`）低的那个成员 `strengthScore` 高得多。
      //    v4.6.103 一度让 ① 取「队内成员里最高的那个强度分」，于是这条会算出 88 ——
      //    那是**借**了「charA 在别的队伍里」的成绩（用户 2026-10-15 报的「老队伍强度过高」）。
      //    现在 ① 必须与队分同源：都取**代表整包**（`total` 最高的那一条 = charB）自己的分。
      { key: 'low', name: 'charA', eidolon: 0, lc: 'coneA', superimp: 1, total: 300,
        strengthScore: 88,
        envs: [{ id: 'env1', value: 300, members: TEAMS.coneGap }] },
      { key: 'high', name: 'charB', eidolon: 0, lc: null, superimp: 1, total: 900,
        strengthScore: 24,
        envs: [{ id: 'env1', value: 900, members: TEAMS.coneGap }] },
    ],
  };
  const plan = teamPlan(mixed, accountFixture, { availability });
  assert.equal(plan.poolAll, 1, '同一支队伍必须只留一条');
  assert.equal(plan.rows[0].teamScore, 900, '队分应取分最高的那个成员');
  assert.equal(plan.rows[0].strengthPct, 24,
    '① 必须取**代表整包自己**的强度分（不是队内最高的 88 —— 那是别的队伍打出来的）');
  // 反向钉一条：① 永远 ≤ 「队内成员里最高的那个强度分」（代表本身也是成员之一）。
  assert.ok(plan.rows[0].strengthPct <= 88, '① 不该超过队内最高成员的强度分');
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

check('/conclusion 回 payload: 9（三项来源 + 归一上下限那一版）', () => {
  assert.equal(live.status, 200);
  // ⚠️ 形状号的历史：v4.6.87 曾把它写成 8（每个整包多一个 `strength` = 纯强度），
  //    v4.6.91 按用户 2026-10-12 第 8 条撤销了那个字段、形状回到 7。
  //    用户 2026-10-13 第 1、2 条**重新要了强度这个分项**（换了名字：`strengthTotal` /
  //    `envStrength`），并新增角色得分与 `drawWeights` 回显 —— 所以又回到 **8**，
  //    而且那一次是真正生效的 8。
  //    **v9**（同一天，用户要「三项的完整得分来源」）= 顶层新增 `frontierExtents`
  //    （三个分项的榜内归一上下限）、逐 env 新增 `envStrengthBest`（强度来源表的
  //    「跨版本发挥」列的分母）。⚠️ 泛用性的队友名单**不在**这个载荷里（按需接口带），
  //    原因见 `src/server/conclusion.js` 的 `slimFrontierUnit` 那段注释。
  assert.equal(livePayload.payload, 9, `实际 payload=${livePayload.payload}`);
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

check('⭐ 真载荷：① = **代表整包自己**的 `strengthScore`（绝对刻度，与角色总榜同源）', () => {
  // ① 读**角色总榜那一列的绝对强度分**（用户 2026-10-14 第 10 条把「强度」重定为
  // 「围绕行动值 + 投入单调」，并明确「省金是**性价比**那一项的事」）。
  //
  // 它替换掉的两条旧口径，各自的症状都被用户报过：
  //   * `total`（含金数项）+ 池内 min-max ⇒ **池内最省金的那支必然拿 100 分**（2026-10-15 报）；
  //   * 「取队内成员里最高的 `strengthScore`」⇒ **借**某个 E6 成员在**别的队伍**里打出的成绩，
  //     老队伍因此普遍 98+（同一天报的第二条）。
  // 现在 ① 与队分同源：都取**代表整包**（`total` 最高的那一条）自己的分 —— 那条整包就是
  // 「承载这支队证据」的那一个。
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
  assert.ok(whole.rows.length > 50, `整池应当有几十支，实际 ${whole.rows.length}`);
  // ① 的刻度是**绝对 0 ~ 100**：池内第一不再被顶成 100 分。
  assert.equal(whole.strengthLo, 0, '① 的下限是绝对刻度 0');
  assert.equal(whole.strengthHi, 100, '① 的上限是绝对刻度 100');
  const packKey = (name, eidolon, lc, superimp) => `${name}|E${eidolonTierOf(eidolon)}|`
    + `${lc || '-'}|S${Math.max(1, Math.round(Number(superimp) || 1))}`;
  const strengthOf = new Map();
  for (const unit of teamPoolUnits(livePayload)) {
    const key = packKey(unit.name, unit.eidolon, unit.lc, unit.superimp);
    strengthOf.set(key, Math.max(strengthOf.get(key) ?? 0, Number(unit.strengthScore) || 0));
  }
  assert.ok(strengthOf.size > 0, '载荷里必须有 `strengthScore`（v9 起就有，① 靠它）');
  /**
   * 复算「代表整包」：与 `teamPlan()` 的 `byRoster` 同一条规则 —— 同一支队伍（成员整包键
   * 排序后拼接）里取 `total` 最高的那一条；① 就是它自己的 `strengthScore`。
   */
  const repOf = new Map();
  const rosterKeyOf = (members) => members
    .map((m) => packKey(m.char, m.eidolon, m.lc, m.superimp)).sort().join('~');
  for (const unit of teamPoolUnits(livePayload)) {
    const members = (unit.envs || []).find((e) => (e.members || []).length)?.members || [];
    if (!members.length) continue;
    const key = rosterKeyOf(members);
    const total = Number(unit.total) || 0;
    const prev = repOf.get(key);
    if (prev && !(total > prev.total)) continue;
    repOf.set(key, { total, strength: Number(unit.strengthScore) || 0 });
  }
  let borrowed = 0;
  for (const r of whole.rows.slice(0, 40)) {
    const rep = repOf.get(r.key);
    assert.ok(rep, `${r.key}: 应当能复算出代表整包`);
    assert.ok(Math.abs(Number(r.strengthPct) - rep.strength) < 1e-3,
      `${r.key}: ① ${r.strengthPct} 应等于代表整包自己的 strengthScore ${rep.strength}`);
    // 反向钉住「不借队内其他成员的强度」：① 必须 ≤ 队内最高成员的分，且**至少有一批**
    // 严格更低（那些就是「队里有个 E6 成员、但它是在别的队伍里打出的成绩」的队）。
    const memberMax = Math.max(0, ...r.members.map((m) => strengthOf
      .get(packKey(m.char, m.eidolon, m.lc, m.superimp)) ?? 0));
    assert.ok(Number(r.strengthPct) <= memberMax + 1e-3,
      `${r.key}: ① 不该超过队内最高成员的分（${r.strengthPct} vs ${memberMax}）`);
    if (Number(r.strengthPct) < memberMax - 5) borrowed += 1;
  }
  assert.ok(borrowed > 0, '真载荷上应当存在「借不到就明显更低」的队伍（否则这条反借用的断言空跑）');
  // 分辨率：换成绝对刻度之后池内必须真的分得开（不是清一色 90+，也不是全 0）。
  const pcts = whole.rows.map((r) => Number(r.strengthPct));
  assert.ok(Math.min(...pcts) < 50, `池内应当有 ① 明显偏低的队伍（实际最低 ${Math.min(...pcts)}）`);
  assert.ok(Math.max(...pcts) > 80, `池内应当有 ① 很高的队伍（实际最高 ${Math.max(...pcts)}）`);
  // ⚠️ 撤销得干净：**载荷的任何一层都不该再有 `strength`**
  //    （v4.6.87 顶层发过它、逐副本刻意没发；现在两层都不发）。
  const withStrength = livePayload.frontierUnits.filter((u) => 'strength' in u);
  assert.equal(withStrength.length, 0, '顶层整包不该再带 strength');
  const envWithStrength = livePayload.frontierUnits
    .flatMap((u) => u.envs || []).filter((e) => 'strength' in e);
  assert.equal(envWithStrength.length, 0, '逐副本明细也不该带 strength');
});

// ⚠️ 上限与 `tools/e2e-test.mjs` 的那条**必须同一个数**（那边是 660 KB，2026-10-14 上调：
//    用户把版本权重改成 3:2.5:2:1.5:1:0.5、窗口 3 → 6 版之后载荷 596 → 636 KB）。
//    改一处忘另一处就会出现「这个套件过、那个套件红」的假信号。
check('/conclusion 载荷仍在 660 KB 硬上限内（e2e 有同一断言）', () => {
  assert.ok(live.bytes > 0 && live.bytes < 660 * 1024, `实际 ${live.bytes} 字节`);
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
