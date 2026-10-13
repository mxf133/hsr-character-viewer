// 虚拟账号：**预设 + 快照构造**（用户 2026-10-12：「在账号与角色界面新建一个选择，方便用户
// 新建虚拟账号，提供一些选项，这些账号有非常不同的角色池，类似真正的玩家们各种各样的偏好」）。
//
// 为什么放在服务端：界面上的「新建虚拟账号」要落进账号库（`AccountStore`），而账号库里的
// 账号必须带**米游社快照形状**的数据；把这份定义放这里，`tools/make-virtual-accounts.mjs`
// 也直接复用同一份 —— 两处各写一遍迟早会长歪（图标/星级就是这么歪过一次的）。
//
// ⚠️ 三条硬约束（都是实测踩出来的）：
//   ① 角色 / 光锥的 `icon` 必须是 **`/icons/...` 同源路径**或 CDN 地址：数据集图标表里存的就是
//      `/icons/icon/character/<id>.png?fallback=<cdn>`，本地没有该文件时 `/icons` 路由会 **302**
//      到 fallback（见 app.js 那条路由）。⚠️ 前端 `characterCard()` 原来只认 `^https?://`，
//      于是虚拟账号的图标全变成首字占位 —— **那条判断要一起放宽**（同源 `/icons` 也要认）。
//   ② `rarity` 必须给：卡片靠它上色/画星（缺了就默认 4★，看起来「星级显示有误」）。
//   ③ `id` 是**角色 id**（数字）：卡片 `data-char-id` 与抽卡页「点角色 chip 滚过去」都靠它。
//
// 角色名用**中文**（米游社快照就是中文），英文键只用于查数据集（星级 / 图标 / 命途 / id）。
import { existsSync } from 'node:fs';
// 「大隐金」两组名单（赠送 / 兑换）**只有一份**：就是隐金设置那张表里的 `units`。
// 用户 2026-10-13 第 4 条要的「大隐金各自拿 0+0」= 那两组里的角色；再抄一份名单迟早
// 会和隐金设置长歪（改一处忘另一处，界面上勾了隐金、虚拟账号里却没有这些人）。
import { HIDDEN_COST_SETTINGS } from '../../public/scripts/advice.js';

/** 开拓者（任意命途）：不算常驻池角色，也没有「专属光锥」这一说。 */
const isTrailblazerName = (name) => /trailblazer|\{nickname\}|开拓者/i.test(String(name || ''));

/** 隐金设置里某一组（`gift` / `exchange` …）点名的单位清单。 */
const hiddenGroupUnits = (id) => {
  for (const group of HIDDEN_COST_SETTINGS) {
    for (const row of group.rows) if (row.id === id) return [...(row.units || [])];
  }
  return [];
};

/**
 * 「大隐金」= 用户 2026-10-13 选定的**①赠送 + ③兑换**两组角色（社区那个「大隐金」梗的
 * 极致版：不用抽就能拿的 5★ 全算 0 金）。
 *
 * ⚠️ 名单从隐金设置那张表现取，不在这里抄（见文件头那条注释）。脚手架/测试里跑不到
 * 数据集时它是空数组，预设自然退化成「只有常驻」，不会抛异常。
 */
const DAYINJIN_CHARS = [...new Set([...hiddenGroupUnits('gift'), ...hiddenGroupUnits('exchange')])];

/** 星魂档的合法停靠点（用户 2026-10-13 第 4 条：E0/E1/E2/E6）。 */
const EIDOLON_TIERS = [0, 1, 2, 6];

/**
 * **常驻 5★ 的专属光锥**（用户 2026-10-13 第 4 条选的「各常驻角色自己的常驻专属光锥」）。
 *
 * ⚠️ **不能拿 `refs.popularLightCones` 顶替**（实测踩过）：那张表是「最常用光锥」，
 * 对常驻角色经常不是本人的专武 —— 实测 姬子 → 谐乐静默之后、白露 → 一场术后对话
 * （4★）、瓦尔特 → 决心如汗珠般闪耀（4★）、克拉拉 → 记一位星神的陨落（星芒商店）。
 * 用户要的是**专武**，所以这 7 对写在这里（与 `tools/herta-availability.mjs` 里人工维护的
 * `standardLightCones` 同一批数据，只是那边没有「谁配谁」）。
 *
 * 为什么不能按命途推：毁灭有**两把**常驻五星（克拉拉的「无可取代的东西」与星芒商店的
 * 「记一位星神的陨落」），按命途匹配会分不出哪把是专武。
 */
const STANDARD_SIGNATURE_CONES = Object.freeze({
  Himeko: 'Night on the Milky Way',
  Welt: 'In the Name of the World',
  Bronya: 'But the Battle Isn\'t Over',
  Gepard: 'Moment of Victory',
  Clara: 'Something Irreplaceable',
  Bailu: 'Time Waits for No One',
  Yanqing: 'Sleep Like the Dead',
});

/** 星魂档 → 它值几金（本体另算）：E0 = 0、E1 = 1、E2 = 2、E6 = 6。 */
const eidolonGoldOfTier = (tier) => {
  const t = Number(tier) || 0;
  return t >= 6 ? 6 : (t >= 2 ? 2 : (t >= 1 ? 1 : 0));
};

/** 随机数源（可选注入，测试用确定性序列；默认 `Math.random`）。 */
const rngOf = (rng) => (typeof rng === 'function' ? rng : Math.random);

/** Fisher–Yates 洗牌（不改入参）。 */
const shuffled = (list, rng) => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/**
 * 「随机低 / 中 / 高氪」账号的名单生成（用户 2026-10-13 第 4 条）。
 *
 * 记账口径**就是本仓库一直用的金数口径**（用户逐字确认过的那条）：
 *   1 金 = 1 个本体 / 1 级星魂 / 1 把光锥本体，所以
 *     E0 = 1 金、E1 = 2 金、E2 = 3 金、E6 = 7 金；光锥恒定 S1 = 1 金；E2S1 = 4 金。
 *   星魂的**停靠点只有 E0/E1/E2/E6**；光锥只给**已拥有的限定角色**的**专属锥**，恒 S1。
 *
 * 随机策略：反复从三类动作里随机挑一个**负担得起**的做，直到预算花完（或没有可做的动作）：
 *   * `body`    给一个还没拥有的限定角色抽本体（1 金）；
 *   * `eidolon` 把某个已拥有角色推到**下一档**（0→1 与 1→2 各 1 金，2→6 是 4 金）；
 *   * `cone`    给一个已拥有、还没配对专属锥的角色配它的专属锥（1 金）。
 * 权重是「本体 3 : 星魂 2 : 光锥 1」—— 先把角色池铺开、再加深、最后补锥，这样 20/50/100 金
 * 出来的号看起来像真的玩家，而不是「全砸在一个角色上」。
 *
 * ⚠️ **实际花掉的金额恒等于预算**：限定角色池 58 人 × (本体 7 金 + 专锥 1 金) = 464 金，
 * 远大于 100，所以循环不会提前没动作可做（`zero-cost` 那类账号才可能空转）。
 * 这一点有回归钉着（`e2e-test.mjs` 直接按金数口径加总）。
 *
 * @param {object} ctx `presetContext()` 的返回值
 * @param {number} budget 限定金预算（20 / 50 / 100）
 * @param {() => number} [rng] 随机数源（测试可注入确定性序列）
 */
const randomRosterOf = (ctx, budget, rng = rngOf(null)) => {
  /** 下一档：0→1→2→6，到顶返回 null（用户只允许停在这四档）。 */
  const nextTierOf = (tier) => {
    const i = EIDOLON_TIERS.indexOf(tier);
    return i < 0 || i === EIDOLON_TIERS.length - 1 ? null : EIDOLON_TIERS[i + 1];
  };
  const order = shuffled(ctx.limitedChars, rng);
  const chars = new Map();
  const cones = new Map();
  let left = Math.max(0, Math.round(Number(budget) || 0));
  while (left > 0) {
    const actions = [];
    // 只把**洗牌后的第一个**未拥有角色当候选：一次只铺一个新角色，
    // 让「加深 / 补锥」有同样的机会被抽到（否则本体永远压过一切，角色池会先铺满）。
    const fresh = order.find((c) => !chars.has(c));
    if (fresh && left >= 1) actions.push({ weight: 3, cost: 1, kind: 'body', char: fresh });
    for (const [char, tier] of chars) {
      const next = nextTierOf(tier);
      if (next !== null) {
        const cost = eidolonGoldOfTier(next) - eidolonGoldOfTier(tier);
        if (cost <= left) actions.push({ weight: 2, cost, kind: 'eidolon', char, tier: next });
      }
      const cone = ctx.signatureConeOf(char);
      // ⚠️ **只把「要花金」的专属锥当动作**（`coneCostOf(cone) > 0`）：有些角色的专属锥
      // 是常驻 / 4★（成本 0）—— 把那种当动作会扣掉 1 金预算却一分金都没加上，于是
      // 生成出来的号**比预算少 1~4 金**（实测 100 金的号只有 96~98）。用户的口径是
      // 「光锥均为已拥有的限定角色的专属光锥」，所以这里只认限定锥。
      if (cone && ctx.coneCostOf?.(cone, ctx.availability) > 0 && !cones.has(cone) && left >= 1) {
        actions.push({ weight: 1, cost: 1, kind: 'cone', cone });
      }
    }
    if (!actions.length) break;
    const totalWeight = actions.reduce((n, a) => n + a.weight, 0);
    let roll = rng() * totalWeight;
    let hit = actions[actions.length - 1];
    for (const action of actions) {
      roll -= action.weight;
      if (roll <= 0) { hit = action; break; }
    }
    left -= hit.cost;
    if (hit.kind === 'body') chars.set(hit.char, 0);
    else if (hit.kind === 'eidolon') chars.set(hit.char, hit.tier);
    else cones.set(hit.cone, 1);
  }
  return {
    chars: Object.fromEntries(chars),
    cones: Object.fromEntries(cones),
    note: `随机账号：${budget} 限定金（按本仓库的金数口径记账）`,
  };
};

/**
 * 预设清单。`spec(ctx)` 返回 `{ chars, cones, note }`：
 *   * `chars` = { 数据集英文键: 星魂档 }（0/1/2/6）
 *   * `cones` = { 数据集英文键: 叠影 }（1~5）
 * 写成函数是为了让「老玩家 / 专锥党 / 全图鉴」这些**按数据集现算**，数据集更新不会失效。
 */
export const VIRTUAL_PRESETS = [
  {
    id: 'newbie',
    title: '全新账号（0 限定）',
    hint: '只有免费角色（4★ / 常驻 / 开拓者）。看「从零开始该抽什么」。',
    spec: () => ({ chars: {}, cones: {} }),
  },
  {
    id: 'single-core',
    title: '单核起步（一个限定本体）',
    hint: '只抽到一个限定本体（E0），没有星魂也没有专锥。',
    spec: () => ({ chars: { Castorice: 0 }, cones: {} }),
  },
  {
    id: 'one-true',
    title: '单推厨（一个角色拉到满配）',
    hint: '资源全砸一个角色：E6 + 专锥 S5，其他一概没有。',
    spec: () => ({ chars: { Castorice: 6 }, cones: { 'Make Farewells More Beautiful': 5 } }),
  },
  {
    id: 'dps-duo',
    title: '双核主C（两把专锥）',
    hint: '两个主C各带专锥，辅助全靠免费角色。',
    spec: () => ({
      chars: { Castorice: 0, Phainon: 0 },
      cones: { 'Make Farewells More Beautiful': 1, 'Thus Burns the Dawn': 1 },
    }),
  },
  {
    id: 'support-first',
    title: '辅助优先（同谐 / 虚无党）',
    hint: '先把辅助抽齐（含星魂），主C 还没影。',
    spec: () => ({
      chars: { Cyrene: 2, Cerydra: 1, Sparkle: 2, Sunday: 0 },
      cones: { 'This Love, Forever': 1 },
    }),
  },
  {
    id: 'bai-e',
    title: '白厄队（昔涟 + 刻律德菈 + 花火）',
    hint: '白厄 E2S1 + 昔涟 E2S1 + 花火 E2，刻律德菈停在 E0：只差那一金。',
    spec: () => ({
      chars: { Phainon: 2, Cyrene: 2, Cerydra: 0, Sparkle: 2 },
      cones: { 'Thus Burns the Dawn': 1, 'This Love, Forever': 1 },
    }),
  },
  {
    id: 'dolphin',
    title: '中氪（核心队 E2 + 两把专锥）',
    hint: '主力队成型一半，专锥只有核心那两把。',
    spec: () => ({
      chars: { Castorice: 2, Hyacine: 2, Cyrene: 0, Evernight: 0 },
      cones: { 'Make Farewells More Beautiful': 1, 'To Evernight\'s Stars': 1 },
    }),
  },
  {
    id: 'whale',
    title: '重氪（多个满配主力）',
    hint: '好几支队伍的核心都 E2/E6，专锥也齐。差额很小，看方案改推什么。',
    spec: () => ({
      chars: { Castorice: 6, Cyrene: 2, Hyacine: 2, Evernight: 2, Phainon: 2 },
      cones: {
        'Make Farewells More Beautiful': 1, 'This Love, Forever': 1, 'Thus Burns the Dawn': 1,
      },
    }),
  },
  {
    id: 'cone-collector',
    title: '专锥收集党（角色都 E0）',
    hint: '抽了一堆专锥（S5），角色本体都没升星魂 —— 典型的「歪锥」玩家。',
    spec: (ctx) => ({
      chars: Object.fromEntries(ctx.limitedChars.slice(0, 6).map((c) => [c, 0])),
      cones: Object.fromEntries(ctx.limitedCones.slice(0, 8).map((c) => [c, 5])),
    }),
  },
  {
    id: 'old-guard',
    title: '老玩家偏科（旧角色多、新角色少）',
    hint: '早于 4.0 登场的限定都抽了（E0），近版本的新角色一概没有。',
    spec: (ctx) => ({
      chars: Object.fromEntries(ctx.oldLimited.map((c) => [c, 0])),
      cones: {},
    }),
  },
  {
    id: 'full',
    title: '全图鉴（限定全 E6 + 专锥全 S5）',
    hint: '理论上没有队伍需要补金 —— 方案应当是空的（用来验证「不硬推」）。',
    spec: (ctx) => ({
      chars: Object.fromEntries(ctx.limitedChars.map((c) => [c, 6])),
      cones: Object.fromEntries(ctx.limitedCones.map((c) => [c, 5])),
    }),
  },

  // ---- 用户 2026-10-13 第 4 条：几种社区口径的「成本 / 氪金」账号形态 ----------------
  //
  // 这一批的共同点：**要与社区的说法对得上**（用户原话「具体含义可以到社区查找」）。
  // 压金圈（NGA / B 站）常见的几种账号形态：
  //   * 「无成本账号」= 一分钱不抽，只有常驻池歪出来的 + 免费角色；
  //   * 「大隐金 MAX」= 把「不用抽就有」的 5★ 全算 0 金（①赠送 + ③兑换那两批），
  //     常驻则按真实的满星魂满叠影算 —— 就是「4 金 1T、一问实际 9 金」那个梗的账号形态；
  //   * 「平铺」= 每个角色都抽到同一档（0+0 / 0+1 / 2+1 / 6+5），量的是「广度优先」；
  //   * 「低 / 中 / 高氪」= 一共投了 20 / 50 / 100 限定金，随机分布在角色上。
  {
    id: 'zero-cost',
    title: '无成本账号（常驻 0+1，无限定角色）',
    hint: '一分钱不抽：常驻池那 7 个 E0 + 各自的常驻专锥 S1，没有任何限定角色。',
    spec: (ctx) => ({
      // ⚠️ 常驻要显式写 **E0**：`buildVirtualAccount` 会把 `ctx.freeChars` 默认按 E6 预置
      // （「免费角色真实账号都有」），不覆盖的话这里会变成 6+1，与「常驻0+1」对不上。
      chars: Object.fromEntries(ctx.standardChars.map((c) => [c, 0])),
      cones: Object.fromEntries(ctx.standardChars
        .map((c) => ctx.signatureConeOf(c)).filter(Boolean).map((c) => [c, 1])),
    }),
  },
  {
    id: 'dayinjin-max',
    title: '大隐金 MAX（无成本账号的极致版）',
    hint: '常驻全 6+5，大隐金（赠送 + 兑换共 16 人）各拿 0+0、不含他们的光锥。',
    spec: (ctx) => ({
      chars: {
        // 常驻：**全 6+5**（用户原话）—— E6 + 各自的常驻专锥 S5（光锥在下面）。
        ...Object.fromEntries(ctx.standardChars.map((c) => [c, 6])),
        // 大隐金（①赠送 + ③兑换）各自 **0+0**：E0 且**不带光锥**（用户明确「不包含他们的光锥」）。
        ...Object.fromEntries(DAYINJIN_CHARS.map((c) => [c, 0])),
      },
      cones: Object.fromEntries(ctx.standardChars
        .map((c) => ctx.signatureConeOf(c)).filter(Boolean).map((c) => [c, 5])),
    }),
  },
  // 平铺四档：**全部角色**（含限定 5★）都抽到同一档；+1 / +5 的光锥都是各自的专属光锥。
  ...[
    { id: 'flat-0-0', title: '全角色平铺 0+0', tier: 0, sup: 0,
      hint: '每个角色都只有本体，一把专锥都没有。' },
    { id: 'flat-0-1', title: '全角色平铺 0+1', tier: 0, sup: 1,
      hint: '每个角色 E0 + 各自的专属光锥 S1。' },
    { id: 'flat-2-1', title: '全角色平铺 2+1', tier: 2, sup: 1,
      hint: '每个角色 E2 + 各自的专属光锥 S1。' },
    { id: 'flat-6-5', title: '全角色平铺 6+5', tier: 6, sup: 5,
      hint: '每个角色 E6 + 各自的专属光锥 S5（理论满配，用来验证「不硬推」）。' },
  ].map(({ id, title, tier, sup, hint }) => ({
    id,
    title,
    hint,
    spec: (ctx) => {
      // ⚠️ 「全部角色」= 限定 + 免费（免费里含 4★ 与开拓者）：平铺问的是「每个角色都抽到
      // 这一档」，把 4★ 排除在外会让「全角色」名不副实（界面上那些角色会显示「未拥有」）。
      // 4★ / 开拓者的本体与星魂本来就不计金，所以它们在不在某个档位上都不改成本口径。
      const all = [...ctx.limitedChars, ...ctx.freeChars];
      const cones = sup > 0
        ? Object.fromEntries(all.map((c) => ctx.signatureConeOf(c))
          .filter(Boolean).map((c) => [c, sup]))
        : {};
      return { chars: Object.fromEntries(all.map((c) => [c, tier])), cones };
    },
  })),
  // 低 / 中 / 高氪：20 / 50 / 100 **限定金**，每次生成都不同（`randomRosterOf` 用 `Math.random`）。
  ...[
    { id: 'random-low', title: '随机低氪（20 限定金）', budget: 20 },
    { id: 'random-mid', title: '随机中氪（50 限定金）', budget: 50 },
    { id: 'random-high', title: '随机高氪（100 限定金）', budget: 100 },
  ].map(({ id, title, budget }) => ({
    id,
    title,
    hint: `每次都不一样：随机花掉 ${budget} 限定金，星魂只停在 E0/E1/E2/E6，`
      + '光锥只给已拥有角色的专属锥、且恒为 S1。',
    spec: (ctx) => randomRosterOf(ctx, budget),
  })),
];

export const presetById = (id) => VIRTUAL_PRESETS.find((p) => p.id === id) || null;

/**
 * 预设要用到的数据集上下文（与 `advice.js` 的 `charCostOf` / `coneCostOf` 同口径：成本 0 = 免费）。
 *
 * ⚠️ 用户 2026-10-13 第 4 条新增的四个「平铺 / 无成本 / 大隐金」预设还要两样东西，
 * 它们都在 `/api/archive` 的 `refs` 里（`popularLightCones` 已有、`lightConePaths` 本轮
 * 才下发），所以这里多收两个可选参数 —— 老调用方（探针 / 测试夹具）不传时退化成空表：
 *   * `popularLightCones` = `{ 角色英文键: 专属光锥英文键 }`（93/93，实测命途 100% 一致）；
 *   * `lightConePaths`     = `{ 光锥英文键: 命途键 }`（自定义角色时筛「同命途光锥」用）。
 */
export const presetContext = ({
  availability, firstSeen, charCostOf, coneCostOf,
  popularLightCones = {}, lightConePaths = {}, characterPaths = {},
}) => {
  const chars = Object.keys(availability?.characters || {});
  const cones = Object.keys(availability?.lightCones || {});
  const oldLimited = chars.filter((k) => {
    if (!(charCostOf(k, availability) > 0)) return false;
    const v = String(firstSeen?.[k] ?? '');
    const major = Number(v.split('.')[0]);
    return Number.isFinite(major) && major < 4;
  });
  /**
   * **常驻 5★**（星轨通票能歪出来的那 7 个）：资料表里 `rarity === 5 && limited === false`
   * 且**不是开拓者**（开拓者由主线赠送，没有「常驻池」这一说，也没有专属光锥）。
   *
   * ⚠️ 与 `advice.js` 的 `STANDARD_CHARS`（隐金第 ⑤ 组「后续加入的常驻角色」）**不是一回事**：
   * 那 6 个（希儿 / 云璃 / 银枝 / 银狼 / 符玄 / 刃）在资料表里是 `limited: true`，只有勾上
   * 「隐金」才变成 0 成本。这里要的是「常驻池里真能歪出来的」，所以按资料表的标记筛。
   */
  const standardChars = chars.filter((k) => !isTrailblazerName(k)
    && Number(availability?.characters?.[k]?.rarity) === 5
    && availability?.characters?.[k]?.limited === false);
  /**
   * 某个角色的**专属光锥**。
   *
   * ⚠️ 常驻 5★ 走 `STANDARD_SIGNATURE_CONES`（写死的专武对），其余走
   * `popularLightCones`（数据集里那份「最常用光锥」，对限定角色基本就等于专武 —— 实测
   * 93/93 命途合法，`VIRTUAL_PRESETS` 从一开始用的就是它）。两者都查不到时给 null，
   * 调用方按「不配光锥」处理。
   *
   * ⚠️ **不要在这里另建一张「锥 → 全数据集主人」的反向表**（曾经建过，已删）：预设 /
   * 随机名单只有几十个角色，反向表里的主人**常常不在名单里**，于是查出来的名字在
   * `byName` 里不存在，挂锥就会掉进「随便找个空槽」的退路 —— 实测随机账号上偶发
   * 「罗宾的专锥挂到了霍霍身上」。主人一律**在名单内**现找（见 `buildVirtualAccount`）。
   */
  const signatureConeOf = (charKey) => STANDARD_SIGNATURE_CONES[charKey]
    || popularLightCones?.[charKey] || null;
  /** 全部与某角色**同命途**的光锥（自定义角色时那张下拉框用）。 */
  const conesOfPath = (pathKey) => cones.filter((c) => lightConePaths?.[c] === pathKey);
  /** 开拓者的各命途变体（自定义角色时不允许逐个添加，见下面的注释）。 */
  const trailblazerChars = chars.filter((k) => isTrailblazerName(k));
  return {
    limitedChars: chars.filter((k) => charCostOf(k, availability) > 0),
    limitedCones: cones.filter((k) => coneCostOf(k, availability) > 0),
    freeChars: chars.filter((k) => charCostOf(k, availability) === 0),
    freeCones: cones.filter((k) => coneCostOf(k, availability) === 0),
    oldLimited,
    standardChars,
    signatureConeOf,
    conesOfPath,
    trailblazerChars,
    popularLightCones: { ...popularLightCones },
    lightConePaths: { ...lightConePaths },
    // 角色命途：自定义名单要校验「光锥与主人**同命途**」，这需要角色那一侧的表。
    characterPaths: { ...(characterPaths || {}) },
    // ⚠️ 成本函数与资料表也放进 ctx：随机账号的生成要在**生成时**就按本仓库的金数口径
    // 记账（`randomRosterOf` 要用 `coneCostOf` 判断「这把专属锥要不要算 1 金」）。
    // 不放进来的话调用方得再传一遍，而「忘了传」的表现是静默少花几金。
    coneCostOf,
    availability,
  };
};

/**
 * 从 `/api/archive` 的 `index.refs` 里取出 `presetContext()` 要多带的两张表。
 *
 * 为什么单独一个函数：三个调用点（建号路由 / 预设清单路由 / `tools/make-virtual-accounts.mjs`）
 * 都要同两张表，各抄一遍 `index?.refs?.xxx || {}` 迟早有一处漏掉 —— 而漏掉的表现是
 * **静默降级**（专属光锥全没了、平铺档位退化成纯角色），不会报错。
 */
export const presetContextRefs = (index) => ({
  popularLightCones: index?.refs?.popularLightCones || {},
  lightConePaths: index?.refs?.lightConePaths || {},
  characterPaths: index?.refs?.characterPaths || {},
});

/**
 * 把界面发来的**自定义角色名单**收成安全形状（用户 2026-10-13 第 3 条）。
 *
 * 收口四件事，都是为了让「界面发什么」不会变成「账号库里存什么」：
 *   ① 角色 / 光锥的键**必须真的在数据集里**（拼错一个键就是一张破图 + 一条永不生效的
 *      持有记录，而且不报错）；
 *   ② 星魂**吸附到最近的合法档位**（用户只允许 E0/E1/E2/E6；界面理论上只发这四个，
 *      但接口不能假设调用方是本站界面 —— E3/E4/E5 归到 E2，与总榜的 `eidolonTierOf` 同口径）；
 *   ③ 叠影夹到 1~5；
 *   ④ `coneOwners`（光锥 → 挂在谁身上）的**主人必须在名单里、且命途与该光锥一致** ——
 *      用户第 3 条的硬约束是「选择该角色**同命途**光锥」，接口这一层也要挡一道：
 *      界面被绕过时，一把同谐光锥不该出现在毁灭角色的身上。
 *
 * @param {{chars?:object, cones?:object, coneOwners?:object}} input
 *   `{ 角色英文键: 星魂档 }` / `{ 光锥英文键: 叠影 }` / `{ 光锥英文键: 角色英文键 }`
 * @param {{availability?:object, characterPaths?:object, lightConePaths?:object}} refs
 *   数据集 `index.refs`（`lightConePaths` = 光锥命途，`characterPaths` = 角色命途）
 */
export const normalizeRoster = (input, refs = {}) => {
  const availability = refs.availability || {};
  const charPaths = refs.characterPaths || {};
  const conePaths = refs.lightConePaths || {};
  const charInfo = availability.characters || {};
  const coneInfo = availability.lightCones || {};
  const chars = {};
  for (const [key, tier] of Object.entries(input?.chars || {})) {
    if (!key || !charInfo[key]) continue;
    chars[key] = nearestEidolonTier(tier);
  }
  const cones = {};
  for (const [key, sup] of Object.entries(input?.cones || {})) {
    if (!key || !coneInfo[key]) continue;
    cones[key] = Math.max(1, Math.min(5, Math.round(Number(sup) || 1)));
  }
  // 主人：必须在名单里、且与这把光锥**同命途**（缺命途数据时只做「在名单里」这一层）。
  const coneOwners = {};
  for (const [coneKey, ownerKey] of Object.entries(input?.coneOwners || {})) {
    if (!cones[coneKey] || !chars[ownerKey] || !coneInfo[coneKey]) continue;
    const conePath = conePaths[coneKey];
    const ownerPath = charPaths[ownerKey];
    if (conePath && ownerPath && conePath !== ownerPath) continue;
    coneOwners[coneKey] = ownerKey;
  }
  return { chars, cones, coneOwners };
};

/** 星魂档吸附到最近的合法档位（E0/E1/E2/E6）——与总榜的 `eidolonTierOf` 同一口径。 */
const nearestEidolonTier = (value) => {
  const n = Math.max(0, Math.min(6, Math.round(Number(value) || 0)));
  if (n >= 6) return 6;
  if (n >= 2) return 2;
  if (n >= 1) return 1;
  return 0;
};

/**
 * 把一份**用户自定义的名单**包成一个预设，好让 `buildVirtualAccount` 直接复用
 * （快照构造只有一份实现 —— 图标 / 星级 / id 那一堆坑都在那里踩平了）。
 *
 * `id` 固定 `custom`：它只用于快照上的 `virtualPreset` 标记与昵称兜底，不参与查表。
 */
export const customRosterPreset = (roster, nickname) => ({
  id: 'custom',
  title: '自定义',
  hint: '用户自己加的角色与配置。',
  spec: () => ({
    chars: { ...(roster?.chars || {}) },
    cones: { ...(roster?.cones || {}) },
    // 光锥挂给谁：用户在编辑器里是**逐个角色**配锥的，所以「这把锥属于谁」必须显式带过来
    // （服务端只按「专属锥的主人」推，推不出「用户把某把同命途非专属锥给了谁」）。
    equips: { ...(roster?.coneOwners || {}) },
    note: nickname || '自定义虚拟账号',
  }),
});

/**
 * 把一个预设变成**账号库里的 account 对象**（含米游社快照形状）。
 *
 * @param {{preset:object, index:object, i18n:object, availability:object,
 *          charCostOf:Function, coneCostOf:Function, uid:string, nickname?:string,
 *          accountId?:string, nowIso?:string}} options
 */
export const buildVirtualAccount = (options) => {
  const {
    preset, index, i18n, availability, charCostOf, coneCostOf,
    uid, nickname, accountId, nowIso = new Date().toISOString(),
  } = options;
  const refs = index?.refs || {};
  const icons = refs.icons || {};
  const zhOfChar = (key) => i18n?.characters?.[key] || key;
  const zhOfCone = (key) => i18n?.lightCones?.[key] || key;
  // 角色 id：`charactersById` 是 id → {en, cn}，反过来查；查不到就从图标路径里抠数字。
  const idByChar = new Map();
  for (const [id, v] of Object.entries(i18n?.charactersById || {})) {
    if (v?.en) idByChar.set(v.en, Number(id) || null);
    if (v?.cn) idByChar.set(v.cn, Number(id) || null);
  }
  const idFromIcon = (raw) => {
    const m = /\/(\d+)\.png/.exec(String(raw || ''));
    return m ? Number(m[1]) : null;
  };
  /** 图标：直接用数据集图标表里那串（`/icons/...?fallback=<cdn>`，`/icons` 路由会兜底 302）。 */
  const iconOf = (table, key) => {
    const raw = table?.[key];
    if (!raw) return null;
    if (/^https?:\/\//.test(raw)) return raw;
    if (String(raw).startsWith('/icons/')) return raw;
    return null;
  };

  const ctx = presetContext({
    availability,
    firstSeen: refs.firstSeen?.characters,
    charCostOf,
    coneCostOf,
    // 专属光锥（`popularLightCones`）与光锥命途（`lightConePaths`）：
    // 2026-10-13 第 3、4 条起新预设要用它们（平铺要各自专属锥、自定义角色要筛命途）。
    ...presetContextRefs(index),
  });
  const {
    chars: presetChars = {}, cones: presetCones = {}, equips: presetEquips = {}, note,
  } = preset.spec(ctx) || {};

  const rows = [];
  const byName = new Map();
  const push = (key, tier) => {
    const name = zhOfChar(key);
    const info = availability?.characters?.[key] || {};
    const icon = iconOf(icons.characters, key);
    const row = {
      // ⚠️ 这三个字段一个都不能少：id（卡片身份 / 抽卡页跳转）、rarity（星级与配色）、icon。
      id: idByChar.get(key) || idByChar.get(name) || idFromIcon(icon),
      name,
      level: 80,
      promotion: 6,
      rarity: Number(info.rarity) || 5,
      rank: Number(tier) || 0,
      actived_constellation_num: Number(tier) || 0,
      path: refs.characterPaths?.[key] || null,
      icon,
      image: null,
      equip: null,
    };
    const prev = byName.get(name);
    if (prev) Object.assign(prev, row);
    else { rows.push(row); byName.set(name, row); }
  };
  // 免费角色全预置（真实账号都有；成本恒为 0，不影响分数，只影响「已有 / 缺」的显示）。
  for (const key of ctx.freeChars) push(key, 6);
  for (const [key, tier] of Object.entries(presetChars)) push(key, tier);

  // 光锥挂在**它自己的角色**身上（米游社只返回**装备中**的光锥；挂给谁不影响算分，
  // 但会**影响界面**）。
  //
  // ⚠️ 用户 2026-10-13 第 3 条明确「设置光锥时选择该角色**同命途**光锥，**专属光锥优先**」，
  // 这条规则对预设同样成立。改前这里按**下标**挂（`carriers[ci]`），于是 2026-10-13 第 4 条
  // 那批预设里，罗宾的专锥会挂到彦卿身上、平铺档位的光锥顺序全乱：成本口径看不出问题
  // （光锥只按它自己算金），但「常驻全 6+5」那一页上每一把锥都配错了人。
  //
  // 现在：**先挂到它的主人** —— 显式指定的优先（自定义名单），否则在**这份名单内**
  // 现找「专属锥恰好是这一把」的角色；主人在名单外 / 已经挂了别的锥时，再退回按顺序
  // 找空槽（同一把锥只存在一份，而米游社快照本来就没有「重复光锥」这种形状）。
  const ownerNameOfCone = (coneKey) => {
    // ① 用户在编辑器里**显式指定**的主人（`equips`，键是光锥、值是角色）优先。
    //    这是自定义名单唯一的准确来源：用户把某把**同命途非专属**锥给了谁，服务端推不出来
    //    （按专属推会把它挂到那把锥的专属主人身上 —— 也就是别人）。
    const explicit = presetEquips?.[coneKey];
    if (explicit) {
      const zh = zhOfChar(explicit);
      if (byName.has(zh)) return zh;
    }
    // ② 没有显式指定（预设那条路）→ 在**这份名单内**找一个「专属锥恰好是这一把」的角色。
    //
    //    ⚠️ 这一步**必须限定在名单内**，不能拿一张「锥 → 全数据集主人」的反向表去查：
    //    预设 / 随机名单只有几十个角色，那张表里的主人**常常不在名单里** —— 查出来的
    //    名字在 `byName` 里不存在，于是掉进退路「随便找个空槽」，把别人的专锥挂到他头上
    //    （实测随机账号上偶发：罗宾的专锥挂到了霍霍身上）。名单内找不到主人时如实返回
    //    null，让那把锥去空槽（而不是硬塞给一个不相干的角色）。
    for (const key of Object.keys(presetChars)) {
      if (ctx.signatureConeOf?.(key) === coneKey) {
        const zh = zhOfChar(key);
        if (byName.has(zh)) return zh;
      }
    }
    return null;
  };
  const carriers = rows.filter((r) => Object.keys(presetChars)
    .map((k) => zhOfChar(k)).includes(r.name));
  let ci = 0;
  for (const [key, sup] of Object.entries(presetCones)) {
    const info = availability?.lightCones?.[key] || {};
    const rank = Math.max(1, Number(sup) || 1);
    const ownerName = ownerNameOfCone(key);
    const ownerRow = ownerName ? byName.get(ownerName) : null;
    // 退回链（**每一步都优先找空槽**）：主人 → 名单里任一空槽 → 全名单任一空槽 →
    // 兜底按顺序。⚠️ 改前第三步直接写 `carriers[ci]`，它**可能已经挂着别的锥** ——
    // 那一格被覆盖，于是「72 把锥只装上 70 把」（实测平铺档位少 2 把）。
    const carrier = (ownerRow && !ownerRow.equip ? ownerRow : null)
      || carriers.find((r) => !r.equip)
      || rows.find((r) => !r.equip)
      || carriers[ci] || rows[0];
    ci += 1;
    if (!carrier) continue;
    carrier.equip = {
      id: Number(info.id) || null,
      name: zhOfCone(key),
      level: 80,
      rank,
      rarity: Number(info.rarity) || 5,
      icon: iconOf(icons.lightCones, key),
    };
  }

  return {
    id: accountId,
    accountId,
    nickname: nickname || `虚拟·${preset.title}`,
    source: 'virtual',
    virtualPreset: preset.id,
    /**
     * 生成这个账号用的**名单原文**（`{ chars, cones }`，都是数据集英文键）。
     *
     * 为什么要存：界面的「编辑角色」面板下次打开时要**按它预填**。快照本身只有最终状态，
     * 反推不回用户当初选了什么 —— 例如用户把某个角色删掉了，快照里就没有任何痕迹。
     * 预设账号也照样记一份，于是「预设 → 微调」是一条自然的路（打开编辑器就能改）。
     */
    virtualRoster: {
      chars: { ...presetChars },
      cones: { ...presetCones },
      // 只在**显式指定**过主人时才写（预设那条路是空的）：编辑器读它来还原
      // 「这把非专属锥当初配给了谁」。空对象与缺字段等价，界面按 `|| {}` 处理。
      coneOwners: { ...presetEquips },
    },
    createdAt: nowIso,
    lastLoginAt: null,
    rolesUpdatedAt: nowIso,
    roles: [{
      uid: String(uid), nickname: nickname || `虚拟·${preset.title}`, level: 70,
      region: 'prod_gf_cn', regionName: '国服', gameBiz: 'hkrpg_cn', game: 'hsr',
    }],
    snapshots: {
      [String(uid)]: {
        uid: String(uid), game: 'hsr', source: 'virtual', virtualPreset: preset.id,
        characters: rows,
        // 角色面板要用的立绘 / 详情这里没有（虚拟账号没有真数据），留空即可。
        details: [],
        basicInfo: { nickname: nickname || `虚拟·${preset.title}`, level: 70 },
        note: note || preset.hint,
      },
    },
  };
};

/** 预留一个没被占用的 uid（纯数字！快照路由是 /roles/(\d+)/snapshot）。 */
export const nextVirtualUid = (taken = []) => {
  const used = new Set(taken.map((u) => String(u)));
  for (let i = 1; i <= 9999; i += 1) {
    const uid = String(900000 + i);
    if (!used.has(uid)) return uid;
  }
  return String(Date.now());
};

/** 本地是否真的拉了图标镜像（拉了就用同源路径，没拉就走 fallback 302）。 */
export const iconsMirrored = (dir) => Boolean(dir) && existsSync(dir);
