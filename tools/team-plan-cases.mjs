// 抽卡方案的**可行性测试台**：造一批虚拟账号（用真实数据集算分），跑方案，并逐条验证
// 「按方案给的补金顺序补下去，真的能落到它推荐的那支队伍上」。
//
// 为什么用虚拟账号：抽卡方案吃两样东西 ——
//   ① 强度那一档来自**数据集**（黑塔网上真实玩家投稿的队伍与成绩，`unit.total`）；
//   ② 差额那一档来自**你自己的账号**（拥有了哪些角色 / 星魂 / 光锥）。
// 所以只要有真实的数据集，就能造出任意账号来测 ② 与整条链路；这也是唯一能覆盖
// 「新手 / 单核 / 差一笔 / 全图鉴」这些极端账号的办法（真人账号只有一份）。
//
// 每个案例都跑同一组不变量（见 `CHECKS`）：
//   * 差额 = Σ 补金顺序每一笔的金数（口径同源）；
//   * **把补金顺序应用上去 → 再算一次差额必须是 0**（这是「方案可行」的定义）；
//   * 光锥不许排在它载体的本体之前（贪心拓扑的载体约束）；
//   * 差额 0 的队伍不许进池；每一个推荐都必须是「你确实缺东西」的队伍；
//   * ① / ② 在 0~100 内，总分 = ①×ws + ②×wc（默认等权）；
//   * 名次 = 全池按总分降序的前 N 条（截断只是展示层）。
// 另有一组**往返案例**：故意只留下某支队伍的第 k 笔缺口，看方案是不是就让你补那一笔。
//
//   node tools/team-plan-cases.mjs [--hidden] [--rows=5] [--markdown=docs/xxx.md]
import fs from 'node:fs';
import {
  DEFAULT_HIDDEN_COSTS, NO_HIDDEN_COSTS, SCORING, buildConclusion, charCostOf, coneCostOf,
  eidolonTierOf, marginalCostOf, normalizeDrawWeights, teamPlan, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const HIDDEN = process.argv.includes('--hidden');
const ROWS = Math.max(1, Number(arg('rows', '5')) || 5);
const MD_PATH = arg('markdown', '');
const MD_ROWS = Math.max(1, Number(arg('md-rows', String(Math.max(3, Math.min(6, Number(arg('rows', '5')) || 5))))) || 3);
const REAL_ACC = Number(arg('account', '0')) || 0;
const WEIGHTS = normalizeDrawWeights({});

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const conclusion = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  hiddenCosts: HIDDEN ? DEFAULT_HIDDEN_COSTS : NO_HIDDEN_COSTS,
});
const cn = (k) => zhName(i18n, 'characters', k) || k;
const cnCone = (k) => (k ? (zhName(i18n, 'lightCones', k) || k) : '—');
const teamText = (members) => members.map((m) => `${cn(m.char)}E${m.eidolon}`
  + `${m.lc ? `+${cnCone(m.lc)}S${m.superimp}` : ''}`).join(' / ');
const teamBrief = (members) => members.map((m) => cn(m.char)).join('/');
const ITEM_TEXT = (it) => (it.kind === 'cone'
  ? `${cn(it.carrier || it.name)}·${cnCone(it.name)} ${Number(it.from) >= 1 ? `S${it.from}→S${it.target}` : `未见→S${it.target}`}`
  : `${cn(it.name)} ${Number(it.from) < 0 || Number(it.target) === 0 ? '本体' : `E${it.from}→E${it.target}`}`);

// ---- 虚拟账号的构造 ---------------------------------------------------------
//
// 账号状态只需要三个东西（`marginalCostOf` 就看这三个）：
//   owned: Set<角色键>、eidolons: Map<角色键, 星魂>、cones: Map<光锥键, 叠影>。
// 「免费」的角色（4★ / 常驻 5★ / 开拓者）成本恒为 0，不影响分数，但真实账号一定有它们，
// 所以每个虚拟账号都**预置全部免费角色**（E6）与**免费光锥**（S5）—— 这样界面上的
// 「已有」标记与「先买光锥还是先买本体」的载体约束才与现实一致。
const FREE_CHARS = Object.keys(availability.characters || {})
  .filter((k) => charCostOf(k, availability) === 0);
const FREE_CONES = Object.keys(availability.lightCones || {})
  .filter((k) => coneCostOf(k, availability) === 0);
const LIMITED_CHARS = Object.keys(availability.characters || {})
  .filter((k) => charCostOf(k, availability) > 0);
const LIMITED_CONES = Object.keys(availability.lightCones || {})
  .filter((k) => coneCostOf(k, availability) > 0);

/** 中文名 / 英文键都认。 */
const keyOf = (s) => (availability.characters?.[s] ? s
  : (Object.entries(i18n.characters || {}).find(([, zh]) => zh === s)?.[0] || s));
const coneKeyOf = (s) => (availability.lightCones?.[s] ? s
  : (Object.entries(i18n.lightCones || {}).find(([, zh]) => zh === s)?.[0] || s));

/** 造账号：`chars` = { 角色: 星魂档 }，`cones` = { 光锥: 叠影 }。 */
const makeAccount = (chars = {}, cones = {}) => {
  const owned = new Set(FREE_CHARS);
  const eidolons = new Map(FREE_CHARS.map((c) => [c, 6]));
  const map = new Map(FREE_CONES.map((c) => [c, 5]));
  for (const [name, tier] of Object.entries(chars)) {
    const key = keyOf(name);
    owned.add(key);
    eidolons.set(key, eidolonTierOf(tier));
  }
  for (const [name, sup] of Object.entries(cones)) {
    const key = coneKeyOf(name);
    map.set(key, Math.max(1, Number(sup) || 1));
  }
  return { owned, eidolons, cones: map };
};
const cloneAccount = (a) => ({
  owned: new Set(a.owned), eidolons: new Map(a.eidolons), cones: new Map(a.cones),
});

/** 把「补金顺序」整套应用到一个账号上（模拟用户照着买）。 */
const applyFill = (account, fill) => {
  const next = cloneAccount(account);
  for (const it of fill) {
    if (it.kind === 'cone') next.cones.set(it.name, Math.max(1, Number(it.target) || 1));
    else {
      next.owned.add(it.name);
      next.eidolons.set(it.name, eidolonTierOf(it.target));
    }
  }
  return next;
};

const runPlanWith = (concl, account, weights = WEIGHTS) => {
  const keep = SCORING.teamPlanMaxRows;
  SCORING.teamPlanMaxRows = Number(arg('pool', '100000')) || 100000;
  try {
    return teamPlan(concl, account, { availability, drawWeights: weights });
  } finally {
    SCORING.teamPlanMaxRows = keep;
  }
};
const runPlan = (account) => runPlanWith(conclusion, account);

// ---- 不变量自检 -------------------------------------------------------------
const CHECKS = [];
const check = (label, fn) => {
  let ok = true;
  let detail = '';
  try {
    const r = fn();
    if (r === false) ok = false;
    else if (typeof r === 'string') { ok = false; detail = r; }
  } catch (e) {
    ok = false;
    detail = e.message;
  }
  CHECKS.push({ label, ok, detail });
  return ok;
};

/** 对一次方案运行做全套不变量检查（返回该次运行的结论摘要）。 */
const audit = (title, account, plan) => {
  const before = CHECKS.length;
  check('① / ② 都在 0~100，且总分 = ①×ws + ②×wc（默认等权）', () => {
    for (const r of plan.rows) {
      if (!(r.strengthPct >= 0 && r.strengthPct <= 100)) return `${r.key}: ①=${r.strengthPct}`;
      if (!(r.gapPct >= 0 && r.gapPct <= 100)) return `${r.key}: ②=${r.gapPct}`;
      const want = WEIGHTS.strength * r.strengthPct + WEIGHTS.cost * r.gapPct;
      if (Math.abs(want - r.total) > 0.051) return `${r.key}: ${r.total} ≠ ${want}`;
    }
    return true;
  });
  check('每一条推荐的差额都 > 0（差额 0 的队伍按设计不进池）', () => {
    const zero = plan.rows.filter((r) => !(r.gap > 0));
    return zero.length ? `有 ${zero.length} 条差额 0` : true;
  });
  check('差额 = Σ 补金顺序每一笔的金数（口径同源）', () => {
    for (const r of plan.rows) {
      const sum = r.fill.reduce((n, it) => n + (Number(it.pulls) || 0), 0);
      if (sum !== r.gap) return `${r.key}: 差额 ${r.gap} ≠ Σ 补金 ${sum}`;
    }
    return true;
  });
  check('⭐ 把补金顺序整套应用上去 → 再算一次差额必须是 0（方案可行的定义）', () => {
    for (const r of plan.rows) {
      const after = applyFill(account, r.fill);
      const left = marginalCostOf(r.members, availability, after);
      if (left.pulls !== 0) {
        return `${r.key}: 补完后还差 ${left.pulls} 金（${left.items.map(ITEM_TEXT).join('、')}）`;
      }
    }
    return true;
  });
  check('⭐ 补完之后所有**限定**成员都真的达标（角色已拥有 + 星魂 ≥ 目标档 + 光锥叠影 ≥ 目标）', () => {
    for (const r of plan.rows) {
      const after = applyFill(account, r.fill);
      for (const m of r.members) {
        // ⚠️ 只对**限定**成员下硬结论：4★ / 常驻 5★ / 开拓者的成本按设计恒为 0，
        //    它们永远不会出现在补金顺序里（所以「补 N 金到达这支队伍」这句话对它们不成立）。
        //    免费单位自己的缺口单独收集成提示（见下面那段 caveats），不算失败。
        if (charCostOf(m.char, availability) === 0) continue;
        if (!after.owned.has(m.char)) return `${r.key}: 补完仍缺角色 ${cn(m.char)}`;
        const tier = eidolonTierOf(after.eidolons.get(m.char) ?? 0);
        if (tier < eidolonTierOf(m.eidolon)) {
          return `${r.key}: ${cn(m.char)} 只有 E${tier}，目标 E${eidolonTierOf(m.eidolon)}`;
        }
        if (m.lc && coneCostOf(m.lc, availability) > 0) {
          const have = after.cones.get(m.lc) ?? 0;
          if (have < Math.max(1, Number(m.superimp) || 1)) {
            return `${r.key}: ${cnCone(m.lc)} 只有 S${have}，目标 S${m.superimp}`;
          }
        }
      }
    }
    return true;
  });
  // 免费单位（4★ / 常驻 / 开拓者）的缺口：不是失败，但要**显形** —— 用户看到
  // 「补 4 金到达这支队伍」时，若这支队还要求一个 E6 常驻，那句话其实是不完整的。
  const caveats = [];
  for (const r of plan.rows) {
    const after = applyFill(account, r.fill);
    for (const m of r.members) {
      if (charCostOf(m.char, availability) > 0) continue;
      const tier = eidolonTierOf(after.eidolons.get(m.char) ?? 0);
      const want = eidolonTierOf(m.eidolon);
      if (!after.owned.has(m.char)) {
        caveats.push({ key: r.key, text: `${cn(m.char)} 本体（免费单位，不在补金顺序里）` });
      } else if (tier < want) {
        caveats.push({
          key: r.key,
          text: `${cn(m.char)} E${tier}→E${want}（免费单位，不在补金顺序里）`,
        });
      }
    }
  }
  check('光锥不许排在它载体的**本体**之前（载体约束）', () => {
    for (const r of plan.rows) {
      const seen = new Set(account.owned);
      for (const it of r.fill) {
        if (it.kind === 'cone' && it.carrier && !seen.has(it.carrier)) {
          return `${r.key}: ${ITEM_TEXT(it)} 排在载体 ${cn(it.carrier)} 本体之前`;
        }
        if (it.kind === 'char') seen.add(it.name);
      }
    }
    return true;
  });
  check('名次 = 全池按总分降序的前 N 条（截断只是展示层）', () => {
    const sorted = [...plan.rows].sort((a, b) => b.total - a.total
      || b.strengthPct - a.strengthPct || b.gapPct - a.gapPct
      || a.gap - b.gap || String(a.key).localeCompare(String(b.key)));
    const lhs = plan.rows.map((r) => r.key).join('|');
    const rhs = sorted.map((r) => r.key).join('|');
    return lhs === rhs ? true : '返回顺序与排序键不一致';
  });
  const failed = CHECKS.slice(before).filter((c) => !c.ok);
  return { title, pool: plan.pool, poolAll: plan.poolAll, rows: plan.rows, failed, caveats };
};

// ---- 案例矩阵 ---------------------------------------------------------------
const CASES = [];
const addCase = (id, title, spec, note, extra = {}) => CASES.push({ id, title, spec, note, ...extra });

/** 队伍身份：按成员 + 目标档 + 光锥拼（与 `teamPlan` 的 rosterKey 同构）。 */
const rosterIdOf = (members) => members
  .map((m) => `${m.char}|E${eidolonTierOf(m.eidolon)}|${m.lc || '-'}|`
    + `S${Math.max(1, Math.round(Number(m.superimp) || 1))}`)
  .sort().join('~');

// A. 全新账号：一件限定都没有 —— 方案该指向「最便宜的满分队」。
addCase('A', '全新账号（0 限定）', makeAccount(), '只有免费角色（4★ / 常驻 / 开拓者）。用来验证「从零开始该抽什么」。');

// B. 单核：只拥有数据集里 #1 那支队伍的第一个成员（E0）。
const emptyPlan = runPlan(makeAccount());
const topRows = emptyPlan.rows.slice(0, 3);
{
  const core = topRows[0].members[0];
  addCase('B', `单核起步（只有 ${cn(core.char)} E0）`,
    makeAccount({ [core.char]: 0 }),
    `#1 队伍的第一个成员，只有本体。用来验证「有一个核心之后方案往哪推」。`);
}

// C/D/E. 往返案例：拥有某支队伍的全部配置，**只留下第 k 笔缺口**。
topRows.forEach((row, i) => {
  [0, Math.min(1, row.fill.length - 1)].forEach((k) => {
    if (!row.fill[k]) return;
    if (i > 0 && k > 0) return; // 控制案例数量：每个案例只挑几组
    const dropped = row.fill[k];
    const account = (() => {
      const base = makeAccount();
      for (const m of row.members) {
        if (charCostOf(m.char, availability) > 0) {
          base.owned.add(m.char); base.eidolons.set(m.char, eidolonTierOf(m.eidolon));
        }
        if (m.lc && coneCostOf(m.lc, availability) > 0) {
          base.cones.set(m.lc, Math.max(1, Number(m.superimp) || 1));
        }
      }
      // 把第 k 笔「退回去」—— 模拟「你已经投了大半，就差这一笔」。
      if (dropped.kind === 'cone') base.cones.set(dropped.name, Number(dropped.from) || 0);
      else if (dropped.kind === 'eidolon') base.eidolons.set(dropped.name, Number(dropped.from) || 0);
      else { base.owned.delete(dropped.name); base.eidolons.delete(dropped.name); }
      return base;
    })();
    addCase(`R${CASES.length}`, `只差一笔：${teamBrief(row.members)}`,
      account,
      `故意只留下「${ITEM_TEXT(dropped)}」这一笔缺口（${dropped.pulls} 金），看方案是不是就让你补它。`
      + `（该队账面 ${row.gold} 金、原始差额 ${row.gap} 金）`,
      // 往返断言：方案里那一支的差额必须恰好等于被留下的这一笔，且补金顺序就是这一笔。
      { roundTrip: { members: row.members, expectPulls: dropped.pulls, expectItem: dropped } });
  });
});

// F. 全图鉴：所有限定角色 E6 + 所有限定光锥 S5 → 所有队伍差额 0 → 候选池应为空。
addCase('F', '全图鉴（限定全 E6 + 全 S5）',
  makeAccount(Object.fromEntries(LIMITED_CHARS.map((c) => [c, 6])),
    Object.fromEntries(LIMITED_CONES.map((c) => [c, 5]))),
  '理论上没有可推荐的队伍（差额 0 全被剔除），用来验证「无事可做时不该硬推」。');

// G. 偏科：老角色（早于 4.0 首次登场）全有 E0，新角色全无。
{
  const firstSeen = index.refs?.firstSeen?.characters || {};
  const isOld = (k) => {
    const v = String(firstSeen[k] ?? '');
    const major = Number(String(v).split('.')[0]);
    return v && Number.isFinite(major) && major < 4;
  };
  const oldLimited = LIMITED_CHARS.filter(isOld);
  addCase('G', `偏科老玩家（${oldLimited.length} 个旧限定都只有 E0）`,
    makeAccount(Object.fromEntries(oldLimited.map((c) => [c, 0]))),
    '拥有大量旧角色但都停在 E0，且没有新版本角色。用来验证方案会不会被旧证据拖住。');
}

// H. 用户上一问的场景：白厄 E2S1 + 昔涟 E2 + 刻律德菈 E0（缺 1 金）。
{
  const chars = { Phainon: 2, Cyrene: 2, Cerydra: 0, Sparkle: 2 };
  // ⚠️ 光锥要写**英文数据集键**：「黎明恰如此燃烧」= Thus Burns the Dawn（白厄专锥）、
  //    「爱如此刻永恒」= This Love, Forever（昔涟专锥）。别与遐蝶的
  //    「让告别，更美一些」= Make Farewells More Beautiful 搞混 —— 写错会让这个案例的
  //    缺口从 1 金变成 2 金，验的就不是用户问的那个场景了（这个错犯过一次）。
  const cones = { 'Thus Burns the Dawn': 1, 'This Love, Forever': 1 };
  const focusChars = ['Phainon', 'Cyrene', 'Cerydra'];
  addCase('H', '特定缺口（白厄 E2S1 + 昔涟 E2 + 刻律德菈 E0 + 花火 E2）',
    makeAccount(chars, cones),
    '复现用户 2026-10-12 那一问：这套四人组只差刻律德菈 E0→E1（1 金），'
    + '看它进不进前 15、补金顺序第一条是不是它。',
    { focus: focusChars });
}

// Z. 可选：本机真实账号（`--account=N`）—— 用米游社抓下来的快照跑同一套检查。
if (REAL_ACC > 0) {
  const { AccountStore } = await import('../src/server/store.js');
  const { ownedCharacters, eidolonsOf, lightConeRanksOf } = await import('../public/scripts/advice.js');
  const store = new AccountStore();
  await store.load();
  const account = (await store.listAccounts())[REAL_ACC - 1];
  const role = (account?.roles || [])[0];
  if (role) {
    const snap = await store.getSnapshot(account.id, role.uid);
    const zh = {}; const all = [];
    for (const c of index.refs?.characters || []) {
      if (c.nameCn && c.name) zh[c.nameCn] = c.name;
      if (c.nameCn) all.push(c.nameCn);
    }
    const czz = {};
    for (const c of index.refs?.lightCones || []) if (c.nameCn && c.name) czz[c.nameCn] = c.name;
    addCase('Z', `真实账号：${role.nickname || role.uid}（本机第 ${REAL_ACC} 个）`,
      {
        owned: ownedCharacters(snap, zh, all),
        eidolons: eidolonsOf(snap, zh),
        cones: lightConeRanksOf(snap, czz),
      },
      '这一条不用虚拟数据：直接读本机已登录账号的快照（米游社返回的角色 / 星魂 / 光锥）。');
  } else {
    console.log(`⚠️ --account=${REAL_ACC} 没找到对应账号，跳过真实账号案例`);
  }
}

// ---- 跑 ---------------------------------------------------------------------
const results = [];
for (const c of CASES) {
  const plan = runPlan(c.spec);
  const summary = audit(c.title, c.spec, plan);
  // 往返断言（只有「只差一笔」那些案例有）：方案里那一支的差额必须**恰好**是被留下的
  // 那一笔，且它的补金顺序就是那一笔 —— 这就是「方案可行」最直接的证据。
  if (c.roundTrip) {
    const want = rosterIdOf(c.roundTrip.members);
    const row = plan.rows.find((r) => rosterIdOf(r.members) === want);
    check(`⭐ 往返：方案指向那支队伍、差额恰好 ${c.roundTrip.expectPulls} 金、补金顺序就是那一笔`, () => {
      if (!row) return `方案里没有这支队伍（它没进前 ${plan.rows.length} 条）`;
      if (row.gap !== c.roundTrip.expectPulls) {
        return `差额 ${row.gap} ≠ 被留下的 ${c.roundTrip.expectPulls} 金`;
      }
      if (row.fill.length !== 1) {
        return `补金顺序有 ${row.fill.length} 笔（应当只有被留下的那一笔）：`
          + row.fill.map(ITEM_TEXT).join('、');
      }
      const it = row.fill[0];
      const want2 = c.roundTrip.expectItem;
      if (it.kind !== want2.kind || it.name !== want2.name
        || Number(it.target) !== Number(want2.target)) {
        return `补金顺序第 1 笔是「${ITEM_TEXT(it)}」，被留下的却是「${ITEM_TEXT(want2)}」`;
      }
      return true;
    });
    summary.roundTripRow = row || null;
    summary.roundTripRank = row ? plan.rows.indexOf(row) + 1 : 0;
  }
  if (c.focus) {
    const want = new Set(c.focus);
    const row = plan.rows.find((r) => c.focus.every((k) => r.members.some((m) => m.char === k))
      && r.members.length === (want.size + (r.members.some((m) => !want.has(m.char)) ? 1 : 0)));
    summary.focusRow = row || plan.rows.find((r) => c.focus.every((k) => r.members.some((m) => m.char === k))) || null;
    summary.focusRank = summary.focusRow ? plan.rows.indexOf(summary.focusRow) + 1 : 0;
  }
  results.push({ ...c, summary });
}

// 额外：全图鉴那一例外，候选池必须是 0（单列一条检查）
const fullCase = results.find((r) => r.id === 'F');
if (fullCase) {
  check('全图鉴：候选池 = 0（所有队伍差额 0 都被剔除），方案不该硬推',
    () => (fullCase.summary.pool === 0 ? true : `候选池 ${fullCase.summary.pool} 支`));
}

// ---- 输出 -------------------------------------------------------------------
const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const fmtRow = (r, i) => `| ${i + 1} | ${r.total.toFixed(1)} | ${r.strengthPct.toFixed(1)} | ${r.gapPct.toFixed(1)} `
  + `| ${r.gap} | ${r.gold} | ${teamBrief(r.members)} |`;

say(`# 抽卡方案 · 虚拟账号可行性实测`);
say();
say(`工具版本 **v${(await import('../src/version.js')).PROGRAM_VERSION}**｜数据集：`
  + `${conclusion.frontierUnits?.length ?? 0} 条角色总榜整包｜隐金设置：`
  + `${HIDDEN ? '**五项全勾**（界面默认）' : '不勾'}`);
say();
say(`抽卡权重：强度 ${(WEIGHTS.strength * 100).toFixed(0)}% / 性价比 ${(WEIGHTS.cost * 100).toFixed(0)}%`
  + `｜② 曲线指数 ${(Number(SCORING.teamPlanGapPower) || 1)}｜展示上限 ${MD_ROWS} 条（本报告用全池算分）`);
say();
say(`**为什么要造虚拟账号**：抽卡方案的两档分别来自两个源头 —— ① 强度来自**数据集**里的`
  + `真实玩家投稿（黑塔网），② 差额来自**你自己的账号**（拥有哪些角色 / 星魂 / 光锥）。`
  + `所以只要有真实数据集，就能造出任意账号来测整条链路。这份报告里的账号全是虚拟的，`
  + `但**强度那一档用的完全是真实数据**。`);
say();
say(`**怎么读这张表**：`);
say();
say(`- 「① 强度」= 该队伍在角色总榜上的整包分（含金数项）在**本账号候选池**里的位置 ——`
  + `同为绝境 0T 时，金数越少这一档越高；`);
say(`- 「② 差额接近度」= \`(1 − 要补金数 ÷ 本池 p75)^1.5 × 100\` —— 只跟你**缺什么**有关；`);
say(`- 「补金」= 你要补几金，「账面」= 这支配置**总共**几金（不进分数，只作参考）；`);
say(`- ⚠️ 两个刻度都是**按本账号的候选池现算**的，所以**不同账号之间的分数不可直接比较**`
  + `（本报告里那个 ② 封顶值就随账号变：全新账号 19 金、老账号 14 金）。`);
say();
say(`**自己要复算 / 换设置**：`);
say();
say('```bash');
say(`node tools/team-plan-cases.mjs --rows=6                      # 隐金默认按界面（五项全勾）`);
say(`node tools/team-plan-cases.mjs --rows=6 --markdown=out.md    # 顺便写一份报告`);
say(`node tools/team-plan-cases.mjs --account=1                   # 追加一条：本机第 1 个真实账号`);
say('```');
say();

results.forEach((r) => {
  const { summary } = r;
  say(`## ${r.id}. ${r.title}`);
  say();
  say(r.note);
  say();
  // ⚠️ 只数**数据集英文键**：真实账号的 `owned` 里中英两种写法都有，直接按成本过滤会数出
  //    「102 / 58」这种超过上限的数（102 > 58 个限定角色）。
  const ownedLim = LIMITED_CHARS.filter((k) => r.spec.owned.has(k)).length;
  const ownedCone = LIMITED_CONES.filter((k) => r.spec.cones.has(k)).length;
  say(`- 账号：限定角色 **${ownedLim}/${LIMITED_CHARS.length}** 个、限定光锥 **${ownedCone}/${LIMITED_CONES.length}** 把`
    + `（免费角色与免费光锥全预置）`);
  say(`- 候选池：**${summary.pool} 支**（逐档榜 ∪ 总榜去重后 ${summary.poolAll} 支，去掉差额 0 的）`);
  if (!summary.rows.length) {
    say(`- 方案：**空的** —— 没有一支队伍还需要你补金（正是全图鉴该有的结果）`);
  } else {
    say();
    say(`| # | 补金推荐分 | ① 强度 | ② 差额接近度 | 补金 | 账面 | 队伍 |`);
    say(`| --- | --- | --- | --- | --- | --- | --- |`);
    summary.rows.slice(0, MD_ROWS).forEach((row, i) => say(fmtRow(row, i)));
    say();
    const top = summary.rows[0];
    say(`**#1 的补金顺序**（照着买就落到「${teamBrief(top.members)}」）：`);
    say();
    top.fill.forEach((it, i) => {
      say(`${i + 1}. ${ITEM_TEXT(it)} —— ${it.pulls} 金（约 ${it.pullsExpected} 抽）`
        + `${it.certain === false ? '（该光锥可能已在背包里，米游社只返回当前装备的）' : ''}`);
    });
    say();
  }
  // 往返案例：把「被留下的那一笔」和方案给出的那一笔并排写出来。
  if (r.roundTrip) {
    const row = summary.roundTripRow;
    say(`**往返验证**（这一条是本报告的核心）：账号里故意只缺「${ITEM_TEXT(r.roundTrip.expectItem)}」，`
      + `方案给出的答案：`);
    say();
    if (!row) say(`- ❌ 这支队伍没进方案前 ${MD_ROWS} 条（差额 ${r.roundTrip.expectPulls} 金）`);
    else {
      say(`- 名次 **#${summary.roundTripRank}**｜差额 **${row.gap} 金**（被留下的正是 ${r.roundTrip.expectPulls} 金）`);
      say(`- 补金顺序：${
        row.fill.map((it) => `${ITEM_TEXT(it)}（${it.pulls} 金）`).join(' → ')}`);
      const it = row.fill[0];
      const ok = row.gap === r.roundTrip.expectPulls && row.fill.length === 1
        && it && it.kind === r.roundTrip.expectItem.kind
        && it.name === r.roundTrip.expectItem.name
        && Number(it.target) === Number(r.roundTrip.expectItem.target);
      say(`- 结论：${ok ? '✅ 与缺口**逐字一致**' : '❌ 与缺口不一致（详见自检）'}`);
    }
    say();
  }
  // 指定关注的那支队伍（例如用户上一问的场景），即使它不在前 N 名里。
  if (r.focus) {
    const row = summary.focusRow;
    say(`**关注的那支队伍**（${r.focus.map(cn).join('/')}）：`);
    say();
    if (!row) say(`- ❌ 不在候选池里（该配置在数据集里可能没有成员收敛成同一支队伍）`);
    else {
      say(`- 名次 **#${summary.focusRank} / ${summary.pool}**`
        + `${summary.focusRank <= 15 ? '（**在前 15 内，界面上看得到**）' : '（前 15 之外，界面上看不到）'}`);
      say(`- 补金推荐分 **${row.total.toFixed(1)}** = ① ${row.strengthPct.toFixed(1)}`
        + ` + ② ${row.gapPct.toFixed(1)}｜账面 ${row.gold} 金｜**要补 ${row.gap} 金**`);
      say(`- 成员：${teamText(row.members)}`);
      say(`- 补金顺序：${row.fill.length
        ? row.fill.map((it) => `${ITEM_TEXT(it)}（${it.pulls} 金）`).join(' → ') : '（无）'}`);
    }
    say();
  }
  const bad = summary.failed;
  if (!bad.length) say(`✅ 不变量自检 **全部通过**`);
  else {
    say(`❌ 不变量自检失败 ${bad.length} 条：`);
    for (const b of bad) say(`  - ${b.label}${b.detail ? `：${b.detail}` : ''}`);
  }
  // 免费单位（4★ / 常驻）的缺口：显形但不算失败 —— 「补 N 金到达这支队伍」这句话
  // 对**限定**单位成立，对免费单位的星魂档不成立（它们按设计不计成本）。
  const cav = [...new Map(summary.caveats.map((c2) => [c2.text, c2])).values()];
  if (cav.length) {
    say();
    say(`⚠️ **免费单位提示**（${cav.length} 种：4★ / 常驻 / 开拓者按设计成本为 0、不进补金顺序，`
      + `所以「补 N 金到达这支队伍」对它们不成立）：`);
    for (const c2 of cav.slice(0, 6)) say(`  - ${c2.text}`);
    if (cav.length > 6) say(`  - ……另有 ${cav.length - 6} 种`);
  }
  say();
});

// 汇总表
say(`## 汇总`);
say();
say(`| 案例 | 账号（限定角色 / 光锥） | 候选池 | #1 补金推荐分 | #1 要补几金 | 自检 |`);
say(`| --- | --- | --- | --- | --- | --- |`);
results.forEach((r) => {
  // ⚠️ 只数**数据集英文键**：真实账号的 `owned` 里中英两种写法都有，直接按成本过滤会数出
  //    「102 / 58」这种超过上限的数（102 > 58 个限定角色）。
  const ownedLim = LIMITED_CHARS.filter((k) => r.spec.owned.has(k)).length;
  const ownedCone = LIMITED_CONES.filter((k) => r.spec.cones.has(k)).length;
  const top = r.summary.rows[0];
  say(`| ${r.id}. ${r.title.split('（')[0]} | ${ownedLim} / ${ownedCone} | ${r.summary.pool} | `
    + `${top ? top.total.toFixed(1) : '—'} | ${top ? `${top.gap} 金` : '—'} | `
    + `${r.summary.failed.length ? `❌ ${r.summary.failed.length}` : '✅'}`
    + `${r.summary.caveats.length ? ` ⚠️${[...new Set(r.summary.caveats.map((c2) => c2.text))].length}` : ''} |`);
});
say();

// ---- 附加对照：隐金开关 与 抽卡权重旋钮 ------------------------------------
//
// 这两块都不改算法，只是把「同一个虚拟账号在不同设置下方案怎么变」摆出来 ——
// 用户调旋钮 / 切隐金时最关心的就是这两件事。
const probeCases = results.filter((r) => ['A', 'H'].includes(r.id));
const buildWith = (hiddenCosts) => buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  hiddenCosts,
});
if (probeCases.length) {
  const conclOff = HIDDEN ? buildWith(NO_HIDDEN_COSTS) : conclusion;
  const conclOn = HIDDEN ? conclusion : buildWith(DEFAULT_HIDDEN_COSTS);
  say(`## 附加对照一：隐金设置开关（同一个账号）`);
  say();
  say(`「隐金设置」影响的是**数据集那一侧**（队伍账面金数 → ① 的金数项），`
    + `**不改你自己要补的金**（② 只看你缺什么）。实测同一批虚拟账号：`);
  say();
  say(`| 账号 | 隐金 | 候选池 | ① 刻度 | ② 封顶 | #1 | #1 账面 / 补金 |`);
  say(`| --- | --- | --- | --- | --- | --- | --- |`);
  for (const c of probeCases) {
    for (const [label, concl] of [['不勾', conclOff], ['五项全勾', conclOn]]) {
      const plan = runPlanWith(concl, c.spec);
      const top = plan.rows[0];
      say(`| ${c.id} | ${label} | ${plan.pool} | ${plan.strengthLo.toFixed(0)}~${plan.strengthHi.toFixed(0)} `
        + `| ${plan.gapMax} 金 | ${top ? `${top.total.toFixed(1)}（${teamBrief(top.members)}）` : '—'} `
        + `| ${top ? `${top.gold} / ${top.gap} 金` : '—'} |`);
    }
  }
  say();
  say(`可见隐金把**账面金数**压下去（赠送 / 常驻 / 可兑换的单位不用抽），`
    + `而「补金」那一列在多数队伍上不变 —— 那正是设计意图（② 不该被隐金设置改变）。`);
  say();

  say(`## 附加对照二：抽卡权重旋钮（同一个账号，只改权重）`);
  say();
  say(`权重只认**相对大小**。实测账号 ${probeCases[0].id}（${probeCases[0].title}）：`);
  say();
  say(`| 强度 : 性价比 | #1 | #2 | #3 | 倾向 |`);
  say(`| --- | --- | --- | --- | --- |`);
  for (const [s, cst, label] of [[1, 1, '1 : 1（默认）'], [3, 1, '3 : 1'], [1, 3, '1 : 3']]) {
    const plan = runPlanWith(conclOn, probeCases[0].spec,
      normalizeDrawWeights({ strength: s, cost: cst }));
    const cells = plan.rows.slice(0, 3).map((r) => `${r.total.toFixed(1)} ${teamBrief(r.members)}`
      + `（补 ${r.gap} 金）`);
    const trend = s > cst ? '偏强度 → 推 ① 高的（同为 0T 时金数少的）'
      : (cst > s ? '偏性价比 → 推补金少的' : '等权');
    say(`| ${label} | ${cells[0] || '—'} | ${cells[1] || '—'} | ${cells[2] || '—'} | ${trend} |`);
  }
  say();
}
const allFailed = CHECKS.filter((c) => !c.ok);
say(`**全部不变量检查：${CHECKS.length - allFailed.length}/${CHECKS.length} 通过**`
  + `${allFailed.length ? `；失败：${allFailed.map((f) => f.label).join('、')}` : ' ✅'}`);
say();
say(`每一项都验证了同一件事：**方案给出的补金顺序，照着买下去真的能落到它推荐的那支队伍**`
  + `（把顺序整套应用到一个账号副本上，再算一次差额必须归零，且每个成员的星魂 / 光锥叠影都达标）。`);
say();
say(`复算：\`node tools/team-plan-cases.mjs${HIDDEN ? ' --hidden' : ''} --rows=${ROWS}\``);

if (MD_PATH) {
  fs.writeFileSync(MD_PATH, lines.join('\n') + '\n');
  console.log(`\n（报告已写入 ${MD_PATH}）`);
}
if (allFailed.length) process.exitCode = 1;
