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
import { HIDDEN_COST_SETTINGS, coneCostOf } from '../../public/scripts/advice.js';
// 数据集顶层（含 `characters[角色].topLightCones`）。⚠️ 只用它的**内存**那份：
// `loadArchive()` 是 `archive.js` 里已有的带缓存读法，**不要**在这里再读一次 23 MB 的
// `archive.json`（那就是两份解析 + 两份内存）。
import { loadArchive } from './archive.js';
// 「数据集分不清的多形态角色 → 权威头像 id」那张表**只有一份**，见
// `character-icon-ids.js` 的注释。2026-10-14 起它同时也被 `archive.js` 的 i18n
// 加载期用上（图标选择器 / 角色编辑器 / 抽卡页的头像都靠那一次修正），
// 这里保留同样的调用是为了让**虚拟账号快照**自己也是对的（它可能拿着一个
// 还没经过 i18n 修正的裸图标表）。
import { CHARACTER_ID_OVERRIDES, iconWithId } from './character-icon-ids.js';

/** 开拓者（任意命途）：不算常驻池角色，也没有「专属光锥」这一说。 */
const isTrailblazerName = (name) => /trailblazer|\{nickname\}|开拓者/i.test(String(name || ''));

/**
 * 开拓者的十个头像（用户 2026-10-14 第 4 条：「头像随机为男/女开拓者的任意命途，且可以修改」）。
 *
 * 为什么恰好是 8001..8010：数据集 `i18n.charactersById` 里 8001–8010 **全部**是
 * `{ en: '{NICKNAME}', cn: '开拓者' }`，而 `availability.characters` 只有 5 个命途键
 * （`Trailblazer (Destruction|Preservation|Harmony|Remembrance|Elation)`）——
 * 也就是「**2 性别 × 5 命途** = 10 个头像」，命途用与 `characterPaths` 同口径的英文键。
 *
 * ⚠️ 性别与命途的归属是**实测核实过**的，不要再凭猜：
 *   ① StarRailRes 的 `index_min/en/characters.json` 有 `tag` 字段，实测
 *      8001=playerboy / 8002=playergirl / 8003=playerboy2 / 8004=playergirl2 /
 *      8005=playerboy3 / 8006=playergirl3 / 8007=playerboy4 / 8008=playergirl4 /
 *      8009=playerboy5 / 8010=playergirl5 —— 即**奇数 id = 男主（穹）、偶数 = 女主（星）**，
 *      同一命途的两个 id 相邻；
 *   ② 同一次响应的 `path` 字段给出命途：8001/8002=Warrior、8003/8004=Knight、
 *      8005/8006=Shaman、8007/8008=Memory、8009/8010=Elation；
 *   ③ 用 `icon/character/<id>.png` 逐个请求，10 个全 200（图标表里只登记了 8010 一个，
 *      其余靠 `/icons` 路由 302 到 CDN，见 `trailblazerIconOf`）。
 */
export const TRAILBLAZER_AVATARS = Object.freeze([
  { id: 8001, path: 'Warrior', gender: 'male' },
  { id: 8002, path: 'Warrior', gender: 'female' },
  { id: 8003, path: 'Knight', gender: 'male' },
  { id: 8004, path: 'Knight', gender: 'female' },
  { id: 8005, path: 'Shaman', gender: 'male' },
  { id: 8006, path: 'Shaman', gender: 'female' },
  { id: 8007, path: 'Memory', gender: 'male' },
  { id: 8008, path: 'Memory', gender: 'female' },
  { id: 8009, path: 'Elation', gender: 'male' },
  { id: 8010, path: 'Elation', gender: 'female' },
]);

/** 合法开拓者头像 id（收口用：不在里面的 id 一律丢弃、退回随机）。 */
const TRAILBLAZER_AVATAR_IDS = new Set(TRAILBLAZER_AVATARS.map((a) => a.id));
/** 开拓者「本体」在 i18n 里的键（`i18n.characters.Trailblazer` = 「开拓者」）。 */
const TRAILBLAZER_BASE_KEY = 'Trailblazer';

/**
 * 数据集**分不清**的多形态角色 → 权威头像 id（`{ 角色英文键: id }`）。
 *
 * ⚠️ 表本身搬到了 `character-icon-ids.js`（2026-10-14）：它以前只长在这个文件里，
 * 于是**只有虚拟账号快照**用上它 —— 图标选择器 / 角色编辑器 / 抽卡页一律把
 * `March 7th (Preservation)` 指到巡猎那张 1224.png（用户报的「三月七（存护）
 * 图标错了」）。现在 i18n 加载期会用它补出显式键，四处一次全对；
 * 这里仍然按同一张表做事，是为了不依赖「i18n 已经加载过」这个前提。
 * 完整依据（1001 = Knight 存护 / 1224 = Rogue 巡猎，两张图都 200）见那个文件。
 */
const characterIconIdOf = (key) => CHARACTER_ID_OVERRIDES[key] || null;

/** 随机抽一个开拓者头像 id。 */
const randomTrailblazerId = (rng = Math.random) => TRAILBLAZER_AVATARS[
  Math.min(TRAILBLAZER_AVATARS.length - 1, Math.floor(rng() * TRAILBLAZER_AVATARS.length))
].id;

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

/**
 * **真正的「专属光锥」表**：`{ 限定 5★ 角色英文键: 它的专属光锥英文键 }`。
 *
 * ⚠️ 为什么不能直接用 `refs.popularLightCones`（那是一张「**最常用**光锥」表）：
 * 它对辅助 / 4★ 角色给出的往往是**通用**光锥，于是**一把锥被多个角色共用** ——
 * 实测 93 个角色里有 10 把锥被 2~8 个角色共用（`Dance Dance Dance` ← 花火 / 缇宝 /
 * 阮•梅 / 停云 / 寒鸦 / 艾丝妲 / 刻律德菈 / 开拓者•同谐；`Resolution Shines As Pearls of
 * Sweat` ← 忘归人 / 桂乃芬 / 卢卡 / 佩拉 / 桑博；……）。用户 2026-10-14 第 1 条的报障
 * 就是它：「全角色平铺时缺了角色/光锥（**缇宝 / 花火缺少光锥**）」—— 平铺档用
 * `Object.fromEntries(all.map(c => signatureConeOf(c)))` 去重之后只剩 **72** 把锥，
 * 93 个角色里 **21 个没有光锥**。
 *
 * 算法（用的是数据集自己的装备数据，实测可用）：
 *   ① 底表 = `archive.json` 顶层的 `characters[角色].topLightCones[mode]`，形如
 *      `[{ name, count }, …]`，是**这个角色实际装备过**的光锥（按副本分）；
 *   ② 只让**限定 5★ 角色** × **限定 5★ 光锥**参与（各 58 个），把 `(count, 角色, 光锥)`
 *      按 count 降序**贪心**配对（一个角色最多一把、一把锥最多一个主人）——
 *      语义是「谁最常用哪把锥」做一次**互选**，实测 57/58 命中；
 *   ③ 没配到的角色由调用方退回 `popularLightCones`（见 `presetContext.signatureConeOf`）。
 *
 * 实测抽查（全部正确）：Sparkle→Earthly Escapade、Tribbie→If Time Were a Flower、
 * The Herta→Into the Unreachable Veil、Phainon→Thus Burns the Dawn、
 * Argenti→An Instant Before A Gaze、Cyrene→This Love, Forever、
 * Cerydra→Epoch Etched in Golden Blood、Ruan Mei→Past Self in Mirror、
 * Firefly→Whereabouts Should Dreams Rest、Hysilens→Why Does the Ocean Sing。
 *
 * ⚠️ 结果**只留在服务端内存**（按数据集 `generatedAt` 缓存），**不要**塞进
 * `/api/archive` 的载荷 —— 那张表是给浏览器的，体积敏感（见 `presetContextRefs`）。
 * ⚠️ 排序键里带上 `char` / `cone` 是为了**确定性**：count 相同时不能依赖 Map 的插入顺序。
 */
export const deriveSignatureCones = (archive, availability) => {
  const charInfo = availability?.characters || {};
  const coneInfo = availability?.lightCones || {};
  const topLightCones = archive?.characters || {};
  const limitedChars = Object.keys(charInfo).filter((k) => !isTrailblazerName(k)
    && Number(charInfo[k]?.rarity) === 5 && charInfo[k]?.limited === true);
  const limitedCones = new Set(Object.keys(coneInfo)
    .filter((k) => Number(coneInfo[k]?.rarity) === 5 && coneInfo[k]?.limited === true));
  const triples = [];
  for (const char of limitedChars) {
    const modes = topLightCones[char]?.topLightCones || {};
    const tally = new Map();
    for (const list of Object.values(modes)) {
      for (const entry of list || []) {
        const name = entry?.name;
        if (!name || !limitedCones.has(name)) continue;
        tally.set(name, (tally.get(name) || 0) + (Number(entry?.count) || 0));
      }
    }
    for (const [cone, count] of tally) triples.push({ count, char, cone });
  }
  triples.sort((a, b) => b.count - a.count
    || a.char.localeCompare(b.char) || a.cone.localeCompare(b.cone));
  const takenChar = new Set();
  const takenCone = new Set();
  const out = {};
  for (const t of triples) {
    if (takenChar.has(t.char) || takenCone.has(t.cone)) continue;
    takenChar.add(t.char); takenCone.add(t.cone);
    out[t.char] = t.cone;
  }
  return out;
};

/**
 * 显式修正表（`{ 角色英文键: 专属光锥英文键 }`）—— **贪心分配靠统计，个别老角色会被
 * 更热门的新角色抢走专属锥**，这里把人工能确认的那几对钉死。
 *
 * 为什么需要它（实测）：`Echoes of the Coffin`（棺的回响）**是罗刹（Luocha）的专属锥**，
 * 而灵砂（Lingsha）作为更晚、更热门的丰饶也大量带它 —— 于是「按 count 互选」把它判给了
 * 灵砂，罗刹反而落空。灵砂真正的专属锥是 `Scent Alone Stays True`（唯有香如故）。
 * 这两条都在 `deriveSignatureCones` **之前**生效（先把人和锥都占住），贪心再去配其余的人。
 *
 * ⚠️ 只写**能确认**的；宁可留空让贪心去猜，也不要凭印象往里加。新增时请连依据一起写。
 */
const LIMITED_SIGNATURE_OVERRIDES = Object.freeze({
  Luocha: 'Echoes of the Coffin',
  Lingsha: 'Scent Alone Stays True',
});

/** `deriveSignatureCones` 的带缓存入口（按数据集 `generatedAt` + 角色数失效）。 */
let signatureCache = { key: null, table: {} };
export const signatureCones = async (availability) => {
  const archive = await loadArchive();
  const key = `${archive?.generatedAt || ''}|${Object.keys(availability?.characters || {}).length}`;
  if (signatureCache.key === key) return signatureCache.table;
  const derived = deriveSignatureCones(archive, availability);
  // ⚠️ **常驻 7 个 5★ 也必须进这张表**（`STANDARD_SIGNATURE_CONES`）：它们不是限定角色，
  // 所以 `deriveSignatureCones` 覆盖不到，而它们的专武按命途推不出来（毁灭有两把常驻五星）。
  // 少这一步的表现是：界面上白露的「专属」会显示成 `popularLightCones` 给的那把
  // 「一场术后对话」（4★），而不是她真正的专武「时节不居」—— 实测就是这样。
  const table = { ...STANDARD_SIGNATURE_CONES, ...derived };
  // 人工修正最后覆盖（点名的锥与人都已经从贪心的候选里让出来了，见那张表的注释）。
  for (const [char, cone] of Object.entries(LIMITED_SIGNATURE_OVERRIDES)) {
    if (!availability?.lightCones?.[cone]) continue;
    table[char] = cone;
  }
  signatureCache = { key, table };
  return table;
};

/**
 * 给 `archiveIndex()` 的结果补上 `refs.signatureLightCones`（异步、带缓存），
 * 好让 `presetContextRefs()` 读到它。
 *
 * 为什么用「往 index 上挂一个 refs 字段」这种形状：`buildVirtualAccount` 是**同步**的
 * （调用点很多，改成 async 会一路扩散），所以昂贵的推导必须在调用它**之前**做完。
 * 三个调用点（建号路由 / 预设清单路由 / `tools/make-virtual-accounts.mjs`）都要用，
 * 漏掉任何一个的表现是**静默退化成「最常用光锥」**（也就是用户报的那个 bug）。
 */
export const withSignatureCones = async (index) => {
  const table = await signatureCones(index?.refs?.availability || {});
  return { ...index, refs: { ...(index?.refs || {}), signatureLightCones: table } };
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
 * ⚠️ **新增部分实际花掉的金额恒等于预算**：限定角色池 58 人 × (本体 7 金 + 专锥 1 金) = 464 金，
 * 远大于 200，所以循环不会提前没动作可做（`zero-cost` 那类账号才可能空转）。
 * 这一点有回归钉着（`e2e-test.mjs` 直接按金数口径加总）。
 *
 * @param {object} ctx `presetContext()` 的返回值
 * @param {number} budget **新增**的限定金预算（50 / 100 / 200，用户 2026-10-14 第 2 条）
 * @param {{chars:object, cones:object, charCones?:object}} [base] 起点名单（= 大隐金 MAX）
 * @param {() => number} [rng] 随机数源（测试可注入确定性序列）
 */
export const randomRosterOf = (ctx, budget, base = null, rng = rngOf(null)) => {
  /** 下一档：0→1→2→6，到顶返回 null（用户只允许停在这四档）。 */
  const nextTierOf = (tier) => {
    const i = EIDOLON_TIERS.indexOf(tier);
    return i < 0 || i === EIDOLON_TIERS.length - 1 ? null : EIDOLON_TIERS[i + 1];
  };
  const order = shuffled(ctx.limitedChars, rng);
  /**
   * 起点名单 = **大隐金 MAX**（用户 2026-10-14 第 2 条：「新建的随机低/中/高氪应当在
   * 大隐金MAX基础上，增加 50/100/200 个限定金」）。
   *
   * ⚠️ 基底里已经拥有的角色**不进预算**：`left` 只算这一次**新增**的部分，所以
   * 「大隐金 MAX（常驻全 6+5 + 大隐金 16 人 0+0）」不会把这 16 金算进 50/100/200。
   */
  const chars = new Map(Object.entries(base?.chars || {}));
  const cones = new Map(Object.entries(base?.cones || {}));
  const coneOwner = new Map(Object.entries(base?.charCones || {}));
  // 基底那把锥的主人：`dayinjinMaxRoster` 只给 `cones`（不记主人才不需要），所以按
  // 「专属锥恰好是这一把」在**基底名单内**现找一份（名单外的主人一律不认，理由见
  // `buildVirtualAccount` 的 `ownerNameOfCone`）。
  for (const cone of cones.keys()) {
    if (coneOwner.has(cone)) continue;
    const owner = Object.keys(base?.chars || {}).find((c) => ctx.signatureConeOf?.(c) === cone);
    if (owner) coneOwner.set(cone, owner);
  }
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
      // ⚠️ 判据是 `!cones.has(cone)`（**去重的持有集合**）而不是 `coneOwner`：
      // 基底那 7 把常驻专锥的叠影是 S5，靠 `coneOwner` 判的话「找不到主人」会被再抽一次，
      // 于是 `cones.set(cone, 1)` 把 S5 悄悄降成 S1。
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
    else { cones.set(hit.cone, 1); coneOwner.set(hit.cone, hit.char); }
  }
  return {
    chars: Object.fromEntries(chars),
    cones: Object.fromEntries(cones),
    // 逐角色装备（权威形状，见 `buildVirtualAccount`）：随机新增的那几把锥的主人就是
    // 抽到它的那个角色；基底那 7 把常驻专锥也算进来。
    charCones: Object.fromEntries(coneOwner),
    note: `随机账号：大隐金 MAX + ${budget} 限定金（按本仓库的金数口径记账）`,
  };
};

/**
 * **「大隐金 MAX」的名单** —— 它既是自己的预设，也是三个随机档的**基底**
 * （用户 2026-10-14 第 2 条：「新建的随机低/中/高氪应当在大隐金MAX基础上，
 * 增加 50/100/200 个限定金」）。
 *
 * 抽出来单独一个函数，是为了让「预设」与「随机档的起点」**共用同一份定义** ——
 * 抄两份的话，以后改一处忘另一处，随机号就不再是「大隐金 MAX 加上若干金」了
 * （而这种偏差没有任何断言会红）。
 */
const dayinjinMaxRoster = (ctx) => ({
  chars: {
    // 常驻：**全 6+5**（用户原话）—— E6 + 各自的常驻专锥 S5（光锥在下面）。
    ...Object.fromEntries(ctx.standardChars.map((c) => [c, 6])),
    // 大隐金（①赠送 + ③兑换）各自 **0+0**：E0 且**不带光锥**（用户明确「不包含他们的光锥」）。
    ...Object.fromEntries(DAYINJIN_CHARS.map((c) => [c, 0])),
  },
  cones: Object.fromEntries(ctx.standardChars
    .map((c) => ctx.signatureConeOf(c)).filter(Boolean).map((c) => [c, 5])),
});

/**
 * 预设清单。`spec(ctx)` 返回 `{ chars, cones, charCones?, equips?, trailblazer?, note }`：
 *   * `chars` = { 数据集英文键: 星魂档 }（0/1/2/6）
 *   * `cones` = { 数据集英文键: 叠影 }（1~5）——**去重的持有集合**，金数口径按它记账
 *   * `charCones` = { 角色英文键: 光锥英文键 } ——**逐角色装备**（权威，2026-10-14 第 1 条起）。
 *     平铺档靠它让**每个角色**都有光锥：4★ / 开拓者用的是**可重复**的免费同命途锥，
 *     「锥 → 单个主人」那种旧形状（`equips`）表达不了这件事。
 *   * `equips` = { 光锥英文键: 角色英文键 }（旧形状，自定义名单还在用）
 *   * `trailblazer` = { id } 开拓者头像 id
 * 写成函数是为了让「老玩家 / 专锥党 / 全图鉴」这些**按数据集现算**，数据集更新不会失效。
 */
export const VIRTUAL_PRESETS = [
  // 用户 2026-10-13 第 4 条：几种社区口径的「成本 / 氪金」账号形态。
  //
  // ⚠️ **2026-10-13 第二次修订**：用户看了一遍实际列表之后说「仅保留以下几种虚拟账号选项，
  //    别的删了（太杂乱）」，并点名了这 9 个。原来那 11 个（全新账号 / 单核起步 / 单推厨 /
  //    双核主C / 辅助优先 / 白厄队 / 中氪 / 重氪 / 专锥收集党 / 老玩家偏科 / 全图鉴）已删除 ——
  //    它们的共同毛病是**只演示一两个角色的组合**，与这 9 个「按成本形态分档」的口径重复，
  //    而且随时间会失真（点名某个角色 / 某支队伍，版本一换就不成立了）。
  //
  // 留下的 9 个都是**按成本/氪金量**定义的，不点名具体角色：
  //   * 「无成本账号」= 一分钱不抽，只有常驻池那 7 个 + 各自的常驻专锥；
  //   * 「无成本账号-大隐金MAX」= 常驻全 6+5，大隐金（①赠送 + ③兑换共 16 人）各 0+0；
  //   * 「平铺」四档 = 每个角色都抽到同一档（0+0 / 0+1 / 2+1 / 6+5），量的是「广度优先」；
  //   * 「随机低 / 中 / 高氪」= 一共投了 20 / 50 / 100 限定金，随机分布在角色上。
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
    hint: '常驻全 6+5，大隐金（赠送 + 兑换共 16 人）各拿 0+0、不含他们的光锥。也是三个随机档的起点。',
    spec: (ctx) => dayinjinMaxRoster(ctx),
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
      // ⚠️ 2026-10-14 第 1 条修掉了这里的一个真 bug：改前是
      //     `Object.fromEntries(all.map(c => ctx.signatureConeOf(c)))`
      //   而 `signatureConeOf` 当时退回的是「**最常用**光锥」—— 辅助角色常常**共用**
      //   一把通用锥（`Dance Dance Dance`、`决心如汗珠般闪耀` …），去重之后 93 个角色
      //   只剩 72 把锥，**21 个角色没有光锥**（用户点名：缇宝 / 花火）。
      //   现在两件事一起保证「每个角色都有光锥」：
      //     ① 专属锥表换成现算的（`deriveSignatureCones`，限定 5★ 一对一）；
      //     ② 4★ / 开拓者用**免费同命途锥**补，逐角色登记在 `charCones` 里
      //        （免费锥可以重复挂 —— 4★ 没有专属锥，不重复就漏人）。
      const chars = Object.fromEntries(all.map((c) => [c, tier]));
      const cones = {};
      const charCones = {};
      if (sup > 0) {
        const claimedCostly = new Set();
        const usedFree = new Set();
        for (const c of all) {
          // 开拓者的命途键不配锥：快照里它只有一行「本体」（见 `buildVirtualAccount`），
          // 配了也没有行可挂 —— 那 5 把锥会白占 `cones` 的计数。
          if (ctx.isTrailblazerKey?.(c)) continue;
          const cone = ctx.pickConeFor(c, claimedCostly, usedFree);
          if (!cone) continue;
          charCones[c] = cone;
          // `cones` 是**去重的持有集合**（金数口径按它记账）：限定锥在 `pickConeFor`
          // 里已经保证只配给一个人，所以这里直接按锥写叠影即可。
          cones[cone] = sup;
          ctx.claimCone(cone, claimedCostly, usedFree);
        }
      }
      return { chars, cones, charCones };
    },
  })),
  // 低 / 中 / 高氪：**大隐金 MAX 起点 + 新增 50 / 100 / 200 限定金**
  // （用户 2026-10-14 第 2 条：「新建的随机低/中/高氪应当在大隐金MAX基础上，
  // 增加50/100/200个限定金」）。每次生成都不同（`randomRosterOf` 用 `Math.random`）。
  ...[
    { id: 'random-low', title: '随机低氪（大隐金MAX + 50 限定金）', budget: 50 },
    { id: 'random-mid', title: '随机中氪（大隐金MAX + 100 限定金）', budget: 100 },
    { id: 'random-high', title: '随机高氪（大隐金MAX + 200 限定金）', budget: 200 },
  ].map(({ id, title, budget }) => ({
    id,
    title,
    hint: `每次都不一样：起点是「大隐金 MAX」（常驻全 6+5、大隐金 16 人 0+0），`
      + `在它之上**再随机花掉 ${budget} 限定金**；星魂只停在 E0/E1/E2/E6，`
      + '光锥只给已拥有角色的专属锥、且恒为 S1。',
    spec: (ctx) => randomRosterOf(ctx, budget, dayinjinMaxRoster(ctx)),
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
  coneIcons = {}, signatureLightCones = {},
}) => {
  const chars = Object.keys(availability?.characters || {});
  const cones = Object.keys(availability?.lightCones || {});
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
   * 优先级（用户 2026-10-13 第 3 条「同命途、**专属优先**」+ 2026-10-14 第 1 条修 bug）：
   *   ① `STANDARD_SIGNATURE_CONES` —— 7 个常驻 5★ 的写死专武对（按命途推不出来，见那张表）；
   *   ② `signatureLightCones` —— **真正**的专属锥表（限定 5★，见 `deriveSignatureCones`）。
   *      ⚠️ 缺了它就会退回 ③，也就是**用户报的那个 bug**（花火 / 缇宝 拿到
   *      `Dance Dance Dance`，于是平铺档 21 个角色没有光锥）。调用点漏了
   *      `withSignatureCones()` 就是这个症状，而且**不报错**。
   *   ③ `popularLightCones` —— 兜底：4★ / 开拓者本来就没有专属锥。
   *
   * ⚠️ **不要在这里另建一张「锥 → 全数据集主人」的反向表**（曾经建过，已删）：预设 /
   * 随机名单只有几十个角色，反向表里的主人**常常不在名单里**，于是查出来的名字在
   * `byName` 里不存在，挂锥就会掉进「随便找个空槽」的退路 —— 实测随机账号上偶发
   * 「罗宾的专锥挂到了霍霍身上」。主人一律**在名单内**现找（见 `buildVirtualAccount`）。
   */
  const signatureConeOf = (charKey) => STANDARD_SIGNATURE_CONES[charKey]
    || signatureLightCones?.[charKey]
    || popularLightCones?.[charKey] || null;

  /**
   * 没有专属光锥的角色（4★、开拓者等）能用的**免费同命途**光锥候选，按可用性排序。
   *
   * 为什么需要这张表（用户 2026-10-14 第 1 条）：平铺档要求「**每个角色都有光锥**」，
   * 而 4★ 本来就没有专属锥。四个筛选条件（都是成本 0，所以**不改金数口径**）：
   *   ① 图标表里有条目 —— 否则界面上是占位图（HANDOFF §4.2AB 记过
   *      「Dance Dance Dance 在本地图标表里没有条目」这条遗留）；
   *   ② `rarity >= 4` —— 3★（如希露瓦的「灵钥」）不体面，同一条遗留里也记了它；
   *   ③ 与角色**同命途**（用户第 3 条的硬约束）；
   *   ④ 排序：先看「被多少个角色的 popular 表点到」（越通用越靠前），再按名字保确定性。
   */
  const conePopularity = new Map();
  for (const cone of Object.values(popularLightCones || {})) {
    if (cone) conePopularity.set(cone, (conePopularity.get(cone) || 0) + 1);
  }
  const freeConesByPath = new Map();
  for (const key of cones) {
    const info = availability?.lightCones?.[key] || {};
    if (Number(coneCostOf?.(key, availability)) !== 0) continue;
    if (!coneIcons?.[key]) continue;
    if (Number(info.rarity) < 4) continue;
    const path = lightConePaths?.[key] || '';
    if (!freeConesByPath.has(path)) freeConesByPath.set(path, []);
    freeConesByPath.get(path).push(key);
  }
  for (const list of freeConesByPath.values()) {
    list.sort((a, b) => (conePopularity.get(b) || 0) - (conePopularity.get(a) || 0)
      || a.localeCompare(b));
  }
  /** 某个角色的免费同命途候选（它自己的 popular 那把排第一，如果它合格的话）。 */
  const freeConeCandidates = (charKey) => {
    const list = freeConesByPath.get(characterPaths?.[charKey] || '') || [];
    const own = popularLightCones?.[charKey];
    if (!own || !list.includes(own)) return list;
    return [own, ...list.filter((c) => c !== own)];
  };

  /**
   * 给一个角色挑光锥（**全角色平铺**用）：优先专属锥，其次免费同命途锥。
   *
   * `claimedCostly` = 已被别的角色占走的**成本 > 0** 的锥。⚠️ 那些**不能重复**：
   * `cones` 是**去重的持有集合**（金数口径按它记账），同一把限定锥配给两个人会让
   * 平铺把限定金数**算少**。免费锥（`usedFree`）**可以重复** —— 4★ 没有专属锥，
   * 不重复就无法让每个角色都有光锥；优先给没用过的，纯粹是让名单好看一点。
   */
  const pickConeFor = (charKey, claimedCostly, usedFree) => {
    const sig = signatureConeOf(charKey);
    if (sig && !(coneCostOf?.(sig, availability) > 0 && claimedCostly?.has(sig))) return sig;
    const list = freeConeCandidates(charKey);
    return list.find((c) => !usedFree?.has(c)) || list[0] || null;
  };
  /** `pickConeFor` 挑完之后的登记（省得每个调用点自己写两遍）。 */
  const claimCone = (cone, claimedCostly, usedFree) => {
    if (!cone) return;
    if (coneCostOf?.(cone, availability) > 0) claimedCostly?.add(cone);
    else usedFree?.add(cone);
  };

  // ⚠️ 2026-10-13（第二次修订）：`conesOfPath()` / `trailblazerChars` / `oldLimited` /
  //    `limitedCones` / `freeCones` 这五个字段**已删除** —— 它们原本只服务被用户删掉的那 11 个
  //    预设（「辅助优先」「专锥收集党」「老玩家偏科」之类），删完之后全仓再无消费者。
  //    自定义角色的那张同命途下拉框是**客户端**用下发的 `lightConePaths` 自己筛的
  //    （见 `public/scripts/virtual-roster.js` 的 `coneChoicesFor()`），所以 `conesOfPath` 也是多余的。
  return {
    limitedChars: chars.filter((k) => charCostOf(k, availability) > 0),
    freeChars: chars.filter((k) => charCostOf(k, availability) === 0),
    standardChars,
    signatureConeOf,
    // 「全角色平铺」要用它们保证**每个角色都有光锥**（用户 2026-10-14 第 1 条）：
    //   ① 优先专属锥；② 没有专属锥的（4★ / 开拓者）用免费同命途锥，允许重复。
    pickConeFor,
    claimCone,
    freeConeCandidates,
    // 开拓者的命途键：**平铺档不给他们配锥**（开拓者在快照里只有一行「本体」，
    // 见 `buildVirtualAccount`）。不排除的话那 5 把锥谁也挂不上，却会进 `cones`
    // （持有集合）与预设的计数，于是「名单里有 N 把锥」与快照上真正装着的不一致。
    isTrailblazerKey: isTrailblazerName,
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
 * 从 `/api/archive` 的 `index.refs` 里取出 `presetContext()` 要多带的那几张表。
 *
 * 为什么单独一个函数：三个调用点（建号路由 / 预设清单路由 / `tools/make-virtual-accounts.mjs`）
 * 都要同几张表，各抄一遍 `index?.refs?.xxx || {}` 迟早有一处漏掉 —— 而漏掉的表现是
 * **静默降级**（专属光锥全没了、平铺档位退化成纯角色），不会报错。
 *
 * ⚠️ `signatureLightCones` 不是 `archiveIndex()` 本来就有的字段：它要读 `archive.json`
 * 的顶层 `characters` 现算，所以调用点必须先过一遍 **`withSignatureCones(index)`**
 * （异步、带缓存）。忘了过的症状就是上面那条「静默降级」。
 * `coneIcons` 是给「免费同命途锥」挑候选用的（没有图标的那几把不选）。
 */
export const presetContextRefs = (index) => ({
  popularLightCones: index?.refs?.popularLightCones || {},
  lightConePaths: index?.refs?.lightConePaths || {},
  characterPaths: index?.refs?.characterPaths || {},
  coneIcons: index?.refs?.icons?.lightCones || {},
  signatureLightCones: index?.refs?.signatureLightCones || {},
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
    // ⚠️ 开拓者的**命途键**一律不收（用户 2026-10-14 第 4 条：开拓者「仅包含本体」）：
    // 快照里由 `buildVirtualAccount` 无条件补那一行，名单里再存 5 个命途键只会让
    // 编辑器与快照对不上。
    if (!key || !charInfo[key] || isTrailblazerName(key)) continue;
    chars[key] = nearestEidolonTier(tier);
  }
  const cones = {};
  for (const [key, sup] of Object.entries(input?.cones || {})) {
    if (!key || !coneInfo[key]) continue;
    cones[key] = Math.max(1, Math.min(5, Math.round(Number(sup) || 1)));
  }
  /**
   * 逐角色装备（**权威形状**，用户 2026-10-14 第 1 条起）。
   *
   * 三条收口（都是为了让「界面发什么」不等于「账号库里存什么」）：
   *   ① 角色与光锥都必须在名单里、且**同命途**（缺命途数据时只做前一条）；
   *   ② **成本 > 0 的光锥只能有一个主人** —— `cones` 是**去重的持有集合**，金数口径
   *      按它记账，同一把限定锥配给两个人会让平铺把限定金数**算少**；
   *   ③ 成本 0 的（4★ / 常驻 / 星芒商店）**允许重复**：4★ 本来就没有专属锥，
   *      不重复就无法满足用户「每个角色都有光锥」的要求。
   */
  const charCones = {};
  const costlyOwner = new Map();
  const attach = (charKey, coneKey) => {
    // ⚠️ **判据必须是 `charKey in chars`，不能写 `!chars[charKey]`**（2026-10-14 修的真 bug）：
    // E0 的星魂值是 **`0`**，也就是**假值** —— 而「刚添加一个角色」时的默认档位正是 E0。
    // 于是用「falsy 判空」的话，「加一个角色 + 给它配光锥」这个**最常见的操作**会把光锥
    // 主人静默丢掉（锥还在 `cones` 里、主人没了 → 快照按「找空槽」把锥挂到别人身上，
    // 界面上就是「改了光锥但没生效」）。这正是用户第 3 条报的「无法更改光锥」的根因之一。
    // 同类坑在本仓库出现过多次（`Number(null) === 0`、`weightOr` 的 `|| 1` 吃掉合法的 0）。
    if (!(charKey in chars) || !coneKey || !coneInfo[coneKey] || !cones[coneKey]) return;
    const conePath = conePaths[coneKey];
    const ownerPath = charPaths[charKey];
    if (conePath && ownerPath && conePath !== ownerPath) return;
    if (Number(coneCostOf(coneKey, availability)) > 0) {
      if (costlyOwner.has(coneKey)) return;
      costlyOwner.set(coneKey, charKey);
    }
    charCones[charKey] = coneKey;
  };
  for (const [charKey, coneKey] of Object.entries(input?.charCones || {})) {
    attach(charKey, coneKey);
  }
  // 旧的「光锥 → 主人」写法仍然收（自定义名单一直用它），折算进 `charCones`。
  for (const [coneKey, ownerKey] of Object.entries(input?.coneOwners || {})) {
    if (ownerKey in charCones) continue;
    attach(ownerKey, coneKey);
  }
  // 回写兼容字段：一把锥被多人装备时只记第一个（`charCones` 才是权威）。
  const coneOwners = {};
  for (const [charKey, coneKey] of Object.entries(charCones)) {
    if (!coneOwners[coneKey]) coneOwners[coneKey] = charKey;
  }
  // 开拓者头像：不在合法 id 表里的一律丢弃（返回 null → 由 `buildVirtualAccount` 随机）。
  const trailblazer = TRAILBLAZER_AVATAR_IDS.has(Number(input?.trailblazer?.id))
    ? { id: Number(input.trailblazer.id) } : null;
  return { chars, cones, coneOwners, charCones, trailblazer };
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
    // ⚠️ 逐角色装备（权威，2026-10-14 第 1 条起）：一把**成本 0** 的锥可以被多个角色装备，
    // 而 `equips` 那种「锥 → 单个主人」的形状表达不了这件事（平铺档就靠它）。
    charCones: { ...(roster?.charCones || {}) },
    trailblazer: roster?.trailblazer ? { ...roster.trailblazer } : null,
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
  /**
   * 图标：直接用数据集图标表里那串（`/icons/...?fallback=<cdn>`，`/icons` 路由会兜底 302）。
   *
   * ⚠️ **必须带「宽松键」回退**（2026-10-14 第 1 条修）：数据集图标表是按 **StarRailRes 的
   * 角色名**登记的，而 `availability.characters` 用的是 theherta 的名字 —— 两者对有多个
   * 形态的角色不一样，实测 **7 个角色拿不到图标与 id**：
   *   `March 7th (Hunt)` / `March 7th (Preservation)`（图标表里只有 `March 7th`）
   *   与 5 个 `Trailblazer (...)`（图标表里只有 `{NICKNAME}`）。
   * 客户端 `virtual-roster.js` 早就有 `baseFormKeyOf()` / `looseKeyOf()` 那套宽松匹配，
   * 服务端此前没有 —— 于是这 7 行在界面上是首字占位图，而 `id` 也照不出来
   * （`idFromIcon` 拿不到图标就无从抠数字）。这里把同一套口径搬过来（**复制**而不是
   * import：那是客户端模块的内部函数，不是导出契约）。
   */
  const looseKeyOf = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const baseFormKeyOf = (name) => (/^Trailblazer\b/i.test(String(name || ''))
    ? '{NICKNAME}' : String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim());
  const iconOf = (table, key) => {
    const pick = (raw) => {
      if (!raw) return null;
      if (/^https?:\/\//.test(raw)) return raw;
      if (String(raw).startsWith('/icons/')) return raw;
      return null;
    };
    const direct = pick(table?.[key]) || pick(table?.[baseFormKeyOf(key)]);
    if (direct) return direct;
    const wanted = looseKeyOf(key);
    const wantedBase = looseKeyOf(baseFormKeyOf(key));
    for (const [k, raw] of Object.entries(table || {})) {
      const folded = looseKeyOf(k);
      if (folded !== wanted && folded !== wantedBase) continue;
      const hit = pick(raw);
      if (hit) return hit;
    }
    return null;
  };
  /**
   * 开拓者头像的图标地址。
   *
   * 图标表里只有 `{NICKNAME}` → `.../character/8010.png?fallback=<cdn 8010>` 一条
   * （= 女主·欢愉），而合法头像有 10 个。这里按**同一个 CDN 模板**把文件名整体换掉
   * （`replace` 用 `g`：fallback 那一段里也有同一个文件名，只换第一处会让本地缺图时
   * 302 回**8010**，也就是永远显示女主·欢愉）。`/icons` 路由会把没镜像的请求 302 到 fallback。
   */
  const trailblazerIconOf = (id) => iconWithId(
    icons?.characters?.['{NICKNAME}'] || icons?.characters?.[TRAILBLAZER_BASE_KEY] || null, id,
  );

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
    chars: presetChars = {}, cones: presetCones = {}, equips: presetEquips = {},
    charCones: presetCharCones = {}, trailblazer: presetTrailblazer = null, note,
  } = preset.spec(ctx) || {};

  const rows = [];
  const byName = new Map();
  const push = (key, tier) => {
    const name = zhOfChar(key);
    const info = availability?.characters?.[key] || {};
    // ⚠️ 先看**人工修正表** `CHARACTER_ID_OVERRIDES`（三月七两个命途），再走
    // `charactersById` 精确查 / 从图标路径抠数字。数据集的 `charactersById` 把
    // 1001 与 1224 都写成「March 7th」，不修正的话两张卡的 `data-char-id` 会撞车。
    const overrideId = CHARACTER_ID_OVERRIDES[key] || null;
    const rawIcon = iconOf(icons.characters, key);
    const row = {
      // ⚠️ 这三个字段一个都不能少：id（卡片身份 / 抽卡页跳转）、rarity（星级与配色）、icon。
      id: overrideId || idByChar.get(key) || idByChar.get(name) || idFromIcon(rawIcon),
      name,
      level: 80,
      promotion: 6,
      rarity: Number(info.rarity) || 5,
      rank: Number(tier) || 0,
      actived_constellation_num: Number(tier) || 0,
      path: refs.characterPaths?.[key] || null,
      // 有修正 id 时，图标也要跟着换成**那个 id** 的文件（否则三月七（存护）会顶着
      // 三月七（巡猎）的头像）：图标表里只有 1224 一张，`iconWithId` 把它改写成 1001。
      icon: overrideId ? iconWithId(rawIcon, overrideId) : rawIcon,
      image: null,
      equip: null,
    };
    const prev = byName.get(name);
    if (prev) Object.assign(prev, row);
    else { rows.push(row); byName.set(name, row); }
  };
  // 免费角色全预置（真实账号都有；成本恒为 0，不影响分数，只影响「已有 / 缺」的显示）。
  // ⚠️ **开拓者的命途键一律跳过**：它按用户 2026-10-14 第 4 条只留一行，在下面单独 push。
  for (const key of ctx.freeChars) {
    if (isTrailblazerName(key)) continue;
    push(key, 6);
  }
  for (const [key, tier] of Object.entries(presetChars)) {
    if (isTrailblazerName(key)) continue;
    push(key, tier);
  }

  // ---- 开拓者：**只有一行**（用户 2026-10-14 第 4 条）-------------------------------
  //
  // 用户原话：「虚拟账号的开拓者的角色信息**仅包含开拓者本体**（视为所有开拓者的命途
  // 均拥有且满星魂），**头像随机为男/女开拓者的任意命途**，且可以修改」。
  //
  // 所以快照里只写**一行**：`name` = 「开拓者」（`i18n.characters.Trailblazer`）、
  // 星魂 = 6、`id` = 头像 id（8001..8010，见 `TRAILBLAZER_AVATARS`）。
  // 「全部命途都拥有」由**客户端**展开，服务端不再写 5 行：
  //   * `ownedCharacters()` 早就有「拥有任一命途 = 拥有全部命途」的规则；
  //   * `eidolonsOf()` 那一侧本轮补上了同一条（2026-10-14，见它的注释）——
  //     改前单行开拓者在 `eidolonsOf` 里**一个命途键都拿不到**，星魂会被当成 0。
  const trailblazerId = TRAILBLAZER_AVATAR_IDS.has(Number(presetTrailblazer?.id))
    ? Number(presetTrailblazer.id)
    : randomTrailblazerId();
  const trailblazerName = zhOfChar(TRAILBLAZER_BASE_KEY);
  const trailblazerRow = {
    id: trailblazerId,
    name: trailblazerName,
    level: 80,
    promotion: 6,
    rarity: 5,
    rank: 6,
    actived_constellation_num: 6,
    // 命途刻意留 `null`：本体不属于任何单一命途（「所有命途都有」）。
    path: null,
    icon: trailblazerIconOf(trailblazerId),
    image: null,
    equip: null,
  };
  rows.push(trailblazerRow);
  byName.set(trailblazerName, trailblazerRow);
  /**
   * 光锥的「空槽」回退链里**要排除开拓者那一行**：开拓者在快照里是**本体一行**
   * （用户第 4 条），给它挂一把锥既没有意义，也会让「名单里有几把锥」与快照对不上。
   * 在回退链里区分「是不是开拓者行」只能靠对象身份，所以这里记一个引用。
   */
  const isTrailblazerRow = (row) => row === trailblazerRow;

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
  const equipOf = (coneKey, sup) => {
    const info = availability?.lightCones?.[coneKey] || {};
    return {
      id: Number(info.id) || null,
      name: zhOfCone(coneKey),
      level: 80,
      rank: Math.max(1, Number(sup) || 1),
      rarity: Number(info.rarity) || 5,
      icon: iconOf(icons.lightCones, coneKey),
    };
  };
  /**
   * ① **逐角色装备**（权威，用户 2026-10-14 第 1 条起）：`charCones` = { 角色: 光锥 }。
   *
   * ⚠️ 这一条是「平铺档每个角色都有光锥」的落地点：同一把**成本 0** 的锥会被多个 4★
   * 角色装备（`Object.entries` 逐个挂，不会互相覆盖）；成本 > 0 的锥由 `pickConeFor`
   * 保证只配给一个人。
   */
  const handledCones = new Set();
  for (const [charKey, coneKey] of Object.entries(presetCharCones)) {
    if (!coneKey || !availability?.lightCones?.[coneKey]) continue;
    const row = byName.get(zhOfChar(charKey));
    if (!row) continue;
    row.equip = equipOf(coneKey, presetCones[coneKey]);
    handledCones.add(coneKey);
  }
  let ci = 0;
  for (const [key, sup] of Object.entries(presetCones)) {
    // ② 剩下的（没有逐角色登记的）走「先找主人、再找空槽」那条老路。
    if (handledCones.has(key)) continue;
    const ownerName = ownerNameOfCone(key);
    const ownerRow = ownerName ? byName.get(ownerName) : null;
    // 退回链（**每一步都优先找空槽**）：主人 → 名单里任一空槽 → 全名单任一空槽 →
    // 兜底按顺序。⚠️ 改前第三步直接写 `carriers[ci]`，它**可能已经挂着别的锥** ——
    // 那一格被覆盖，于是「72 把锥只装上 70 把」（实测平铺档位少 2 把）。
    const carrier = (ownerRow && !ownerRow.equip ? ownerRow : null)
      || carriers.find((r) => !r.equip)
      || rows.find((r) => !r.equip && !isTrailblazerRow(r))
      || carriers[ci] || rows[0];
    ci += 1;
    if (!carrier) continue;
    carrier.equip = equipOf(key, sup);
  }

  return {
    id: accountId,
    accountId,
    nickname: nickname || `虚拟·${preset.title}`,
    source: 'virtual',
    virtualPreset: preset.id,
    /**
     * 生成这个账号用的**名单原文**（键都是数据集英文键）。
     *
     * 为什么要存：界面的「编辑角色」面板下次打开时要**按它预填**。快照本身只有最终状态，
     * 反推不回用户当初选了什么 —— 例如用户把某个角色删掉了，快照里就没有任何痕迹。
     * 预设账号也照样记一份，于是「预设 → 微调」是一条自然的路（打开编辑器就能改）。
     *
     * 三个字段的分工（2026-10-14 第 1、4 条起）：
     *   * `chars` —— 角色 → 星魂档。⚠️ **不含开拓者**：它在编辑器里永远是已拥有、E6、
     *     不可移除，由 `trailblazer` 单独表达（写进来只会让界面多出一批假的命途行）。
     *   * `cones` —— 光锥 → 叠影（**去重的持有集合**，金数口径按它记账）。
     *   * `charCones` —— 角色 → 装备的光锥（**权威**；成本 0 的锥可以被多人装备）。
     *   * `coneOwners` —— 光锥 → 主人（旧形状，保留兼容；一把锥多人装备时只记第一个）。
     *   * `trailblazer` —— 开拓者头像 `{ id }`。
     */
    virtualRoster: {
      chars: Object.fromEntries(Object.entries(presetChars)
        .filter(([key]) => !isTrailblazerName(key))),
      cones: { ...presetCones },
      coneOwners: (() => {
        const out = {};
        for (const [cone, owner] of Object.entries(presetEquips || {})) out[cone] = owner;
        for (const [char, cone] of Object.entries(presetCharCones || {})) {
          if (!out[cone]) out[cone] = char;
        }
        return out;
      })(),
      charCones: { ...presetCharCones },
      trailblazer: { id: trailblazerId },
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
