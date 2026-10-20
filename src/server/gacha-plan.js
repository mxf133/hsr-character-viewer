/**
 * 抽卡推荐 v2 · 抽卡方案（服务端纯函数）
 *
 * 这一份是 §二「抽卡方案」的**唯一实现**。输入是 `scoreEnvRows()` 打过分的行，
 * 输出是排好序、带补金明细的方案行；不碰 IO，浏览器端不再自己抄一遍。
 *
 * 公式（用户 2026-10-20 的口径，取代 2026-10-18 那版的 `baseline / Δgold`）：
 *
 *   补金推荐分(某版本) = ( 强度得分 + 性价比权重 × ( 1 − Δgold / 10 ) ) × 版本权重
 *   Δgold = 账号与这套配队的**差额金数**（还要补几金）；Δgold = 0 → 那一项取 1
 *   补金推荐分        = max{ 补金推荐分(某版本) }           ← 决策：**取最高值**，不是加权平均
 *
 * ⚠️ 四个容易「顺手改错」的地方，改之前先看这里：
 *
 *   1. 性价比项是 **1 − Δgold/10**（线性扣分，**Δgold > 10 会转负**，没有封底）。
 *      换掉旧口径 `baseline / Δgold` 的原因：旧式夹在 (0,1] 里，补 26 金与补 3 金
 *      只差 0.4 分，「补得越多越不划算」几乎看不出来（用户 2026-10-20 的原话）。
 *      详见 `planCostPartOf()` 上的表。
 *   2. 这里的 Δgold 是**「你还要补几金」**，而 §一投稿得分用的是**队伍自己的金数 `c`**
 *      —— 两个数在一张卡上都会印（账面 N 金 / 补金 M 金），别弄混。
 *   3. 跨版本**取最大值**而不是像 §一那样做版本加权平均（用户决策）。版本权重仍然乘进每一版的
 *      `补金推荐分(某版本)`，所以它照样起作用：最近一期权重 6，会把当期成绩顶上来。
 *      同一套阵容因此只占一行，但 `seasons[]` 里**列出所有版本的成绩**供 UI 展开。
 *   4. **Δgold = 0（阵容已齐）照样进列表**，性价比项 = 1。它不会霸榜 —— 名次仍然由强度项
 *      继续拉开。
 *
 * 成本模型（谁要金、几金、隐金怎么减）不在这里，复用 `public/scripts/advice.js` 里那套
 * 已验证的纯函数 —— 仓库的既有约定就是这样（`src/server/app.js` 已经在 import 它们），
 * 抄第二遍只会让两处成本口径分叉。
 */

import { finiteOf, memberOf, packKeyOf } from './gacha-score.js';
import {
  marginalCostOf,
  hiddenReductionOf,
  normalizeHiddenCosts,
  unitPullsOf,
  datasetGoldOf,
} from '../../public/scripts/advice.js';

// ------------------------------------------------------------------ 阵容签名

/**
 * 一套阵容的签名 = 四个**整包键**排序后拼接。
 *
 * ⚠️ 用户 2026-10-18 明确要求「需要整包完全一致」才合并 —— 所以这里用 `packKeyOf`
 * （角色|星魂档|光锥|叠影），差一个叠影就是另一套阵容，不合并。
 * 排序是为了让「同一套阵容、位置顺序不同」落到同一个键（`frontier.m` 的顺序由
 * 上游 `teams[i].slots` 决定，不保证跨投稿一致）。
 */
export const rosterKeyOf = (members) => [...members].map(packKeyOf).sort().join('~');

/**
 * 一套阵容的**折叠键** = 四名角色的名字排序后拼接（不看星魂 / 光锥 / 叠影）。
 *
 * ⚠️ 这个键**不参与聚合与算分**，只在交付阶段把「同一套四人、配装不同」的行并成一栏
 * （用户 2026-10-18 决策：按角色组合折叠）。整包键 `rosterKeyOf` 仍是聚合身份 ——
 * 换一件光锥就是另一条成绩，分数照算，只是折叠后在界面上共用一栏。
 * ⚠️ 排序原因同 `rosterKeyOf`：位置顺序不参与阵容身份。
 */
export const lineupKeyOf = (members) => [...members].map((m) => m.char).sort().join('~');

// ------------------------------------------------------------------ 性价比项（方案专用）

/**
 * 性价比项的**刻度**：补多少金把这一项扣到 0。
 *
 * 用户 2026-10-20 给的公式是 `1 − 差额金数 / 10`，所以刻度就是 10。
 * 抽成常量是因为它会和 `SCORING` 里那批一起被调（`1 − gap/10` 的 10 一旦改成 8 或 12，
 * 整张榜的陡缓就变了）；写成字面量会散落到注释、测试和界面文案三处。
 */
export const PLAN_GAP_SCALE = 10;

/**
 * 方案的性价比分量 = `1 − Δgold / 10`。
 *
 * **2026-10-20 换的口径**（用户原话：「抽卡方案的性价比得分有问题，是补金数越多性价比
 * 越低，因此算法为 补金推荐分 =（强度得分 + 性价比权重 ×（1 − 账号和此配队的差额金数 / 10））
 * × 投稿的版本权重」）：
 *
 * | Δgold（还要补几金） | 这一项 |
 * | --- | --- |
 * | 0（已齐） | **1** |
 * | 5 | 0.5 |
 * | 10 | **0** |
 * | 26 | **−1.6** |
 * | 40 | −3 |
 *
 * ⚠️ **Δgold > 10 会转负，这是刻意的、没有封底**：
 *   * 旧口径 `baseline / Δgold` 是**夹在 (0, 1]** 的（补 26 金仍有 0.31 分），
 *     于是「补 26 金」和「补 3 金」只差 0.4 分 —— 用户说的「补金数越多性价比越低」
 *     在旧口径里几乎看不出来，这才是他要换公式的原因；
 *   * 新口径是**线性扣分**，补到 10 金就把性价比这一项扣光，再多就是负贡献。
 *     排序上表现为「补金多的队一路沉底」，与「这队要补的东西太多、不划算」一致。
 *   * 一整套四人要补 20+ 金的情况在绝境很常见（实测榜首 `gap = 26`），所以负分
 *     不是极端个例 —— 卡片上会如实印出负数，别在界面层偷偷夹到 0（那会把
 *     「补 11 金」和「补 40 金」又拉成同一个数，回到老问题）。
 *
 * ⚠️ `baseline`（该版本最低金）**不再参与这一项**，但字段仍在下发 ——
 * 详情窗口要用它解释「这一版的金数基准是多少」，只是不再进公式。
 */
export const planCostPartOf = (gapGold) => {
  const gap = finiteOf(gapGold);
  // 算不出差额（null）或已经齐了：两项都按「最高性价比」处理。
  if (gap === null || gap <= 0) return 1;
  return 1 - gap / PLAN_GAP_SCALE;
};

// ------------------------------------------------------------------ 按阵容聚合

/**
 * 把同一关卡多版本的打分行聚合成阵容。每个阵容在**每个版本**只留最高分那条。
 *
 * @returns `Map<rosterKey, { key, members, bySeason: Map<season, scoredRow> }>`
 */
// ⚠️ 这两个缓存是**跨候选共享**的关键。实测 10 万行投稿里成员字串只有 645 种去重值
// （90%+ 重复），而每个阵容都要给它 4 个成员各算一次 `memberOf` + `packKeyOf` ——
// 不缓存的话光这一趟就是 40 万次字符串切分，占了整体耗时的四分之一。
// 缓存放在模块级没有问题：键是数据集里的成员字串，规模有限且不会无限增长。
const memberCache = new Map();
const packKeyCache = new Map();
const cachedMemberOf = (text) => {
  let hit = memberCache.get(text);
  if (!hit) memberCache.set(text, (hit = memberOf(text)));
  return hit;
};
const cachedPackKeyOf = (text) => {
  let hit = packKeyCache.get(text);
  if (hit === undefined) packKeyCache.set(text, (hit = packKeyOf(text)));
  return hit;
};

export const groupRosters = (scored) => {
  const groups = new Map();
  for (const row of scored) {
    const raw = row.m || [];
    if (!raw.length) continue;
    const members = raw.map((text) => (typeof text === 'string' ? cachedMemberOf(text) : text));
    const packKeys = raw.map((text) => (
      typeof text === 'string' ? cachedPackKeyOf(text) : packKeyOf(text)
    ));
    // ⚠️ 排序后再拼：位置顺序不参与阵容身份，上游给的 `m` 顺序跨投稿不保证一致。
    const key = [...packKeys].sort().join('~');
    let entry = groups.get(key);
    // packKeys 跟着走：下游算 Δgold 时要按它缓存，别再算一遍 `packKeyOf`。
    if (!entry) groups.set(key, (entry = { key, members, packKeys, bySeason: new Map() }));
    const prev = entry.bySeason.get(row.season);
    // 同版本取最高分那条代表这一版的成绩。
    if (!prev || (row.score ?? 0) > (prev.score ?? 0)) entry.bySeason.set(row.season, row);
  }
  return groups;
};

/**
 * 展开某套阵容的补金清单（`marginalCostOf` 的 items 拼接版）。
 *
 * 与「直接 `marginalCostOf(entry.members, …)`」完全等价 —— 那个函数内部没有跨成员状态，
 * 逐成员独立累加。延迟到交付时算，只是为了不给全池每人建一个数组。
 */
const gapItemsOf = (entry, costOfMember) => {
  const items = [];
  entry.members.forEach((m, i) => items.push(...costOfMember(m, entry.packKeys[i]).items));
  return items;
};

/** 某个版本的补金推荐分。**只返回数字**，不建中间对象 —— 这一趟要对几千个候选跑。 */
const planScoreAt = (row, wc, gap) => (
  ((row.strengthPart ?? 0) + wc * planCostPartOf(gap)) * (row.versionWeight ?? 1)
);

/**
 * 逐版本**取最大值**（用户决策），并列时取**更新**的那一版。
 *
 * 为什么并列还要挑：不挑的话结果取决于 Map 的插入顺序，同一份输入换个读取顺序
 * 就换一行；而 Map 的插入顺序由上游给了哪些行决定，那是**数据顺序**不是语义。
 */
const bestSeasonOf = (entry, wc, gap) => {
  let best = null;
  for (const [season, row] of entry.bySeason) {
    const planScore = planScoreAt(row, wc, gap);
    if (!best || planScore > best.planScore
      || (planScore === best.planScore
        && String(season).localeCompare(String(best.season), undefined, { numeric: true }) > 0)) {
      best = { season, row, planScore };
    }
  }
  return best;
};

/**
 * 方案行的逐版本成绩清单 —— **只在交付时**调用（前面的排序用 `bestSeasonOf` 就够了）。
 *
 * 「列出所有成绩」= 每个有投稿的版本都给一条，**含 `score` 之外的原始量**
 * （成绩 `a`、用金 `cost`、该版基准 `baseline`、版本权重、投稿数 `n`）——
 * UI 展开那一版时要能解释「这个分是怎么来的」。
 */
const seasonsDetailOf = (entry, wc, gap) => [...entry.bySeason]
  .map(([season, row]) => ({
    season,
    // 成绩：行动值型是行动值、轮次型是轮次，语义由调用方按 `envKindOf` 决定。
    score: row.a,
    postScore: row.score ?? 0,          // §一那条链上的投稿得分（未乘版本权重），供对照
    strengthPart: row.strengthPart ?? 0,
    costPart: planCostPartOf(gap),
    versionWeight: row.versionWeight ?? 1,
    planScore: planScoreAt(row, wc, gap),
    cost: row.c,
    baseline: row.baseline,
    submissions: Math.max(1, finiteOf(row.n) ?? 1),
    tier: row.t ?? 0,
  }))
  .sort((a, b) => (b.planScore - a.planScore)
    || String(b.season).localeCompare(String(a.season), undefined, { numeric: true }));

// ------------------------------------------------------------------ 补金明细（fill）

/**
 * fill 贪心拓扑排序 —— 沿用旧算法（原 `advice.js:3580-3604`），只换了输入源。
 *
 * 排序键 `perPull = value / pullsExpected`：**每抽收益**，不是每金收益。
 * 光锥 67 抽、角色/星魂 94 抽（见 `PULLS_PER`），所以同样的 value 之下光锥更容易
 * 排在前面 —— 这正是对的，光锥便宜就该先拿。
 *
 * ⚠️ 唯一的硬约束：**光锥只能排在它的载体角色（本体）那一笔之后**。
 * 没有这条，输出会出现「先抽 Robin 专武、再抽 Robin」的顺序，看着就荒唐。
 */
export const fillOf = (row, ctx) => {
  const { availability = {}, charScoreOf = () => 0 } = ctx;
  const items = (row.gapItems || []).map((item) => {
    const owner = item.carrier || item.name;
    const value = charScoreOf(owner) || charScoreOf(item.name) || row.score || 0;
    // ⚠️ 金数必须 round 后再换算（详见 `unitPullsOf` 上方那段注释）：
    // `item.pulls` 是内部临时数（char 缺本体时是「星魂数+1」），不能直接用。
    const gold = Math.max(1, Math.round(Number(item.pulls) || 1));
    const pullsExpected = unitPullsOf(item.kind, gold, availability);
    const idx = item.kind === 'cone'
      ? row.members.findIndex((m) => m.lc === item.name)
      : row.members.findIndex((m) => m.char === item.name);
    const cut = idx < 0 ? 0
      : (item.kind === 'cone' ? ctx.cuts?.byIndexCone?.[idx] : ctx.cuts?.byIndexChar?.[idx]) || 0;
    return {
      kind: item.kind,          // 'char'（缺本体）| 'eidolon' | 'cone'
      name: item.name,
      pulls: gold,
      pullsExpected,
      from: item.from ?? null,
      target: item.target ?? null,
      carrier: item.carrier || null,
      certain: item.certainty !== false,
      value,
      // 隐金减免后的成本；0 = 白送（界面据此过滤，见旧 `advice-view.js:4581`）
      cost: Math.max(0, gold - cut),
      perPull: value / Math.max(1, pullsExpected),
    };
  });

  const remaining = [...items];
  const fill = [];
  while (remaining.length) {
    let pick = -1;
    let pickScore = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const it = remaining[i];
      if (it.kind === 'cone' && it.carrier
        && !ctx.isOwned?.(it.carrier)
        // 载体那一笔还排在后面 → 这一笔被阻塞
        && remaining.some((x) => x.kind === 'char' && x.name === it.carrier)) continue;
      if (it.perPull > pickScore) { pick = i; pickScore = it.perPull; }
    }
    // 理论不可达（所有光锥都被自己的载体阻塞 ⇒ 成环）时的兜底。
    if (pick < 0) pick = 0;
    fill.push(remaining.splice(pick, 1)[0]);
  }
  return fill;
};

// ------------------------------------------------------------------ 过渡档位（mid）

/**
 * 把 fill 切成前半段（≤ Δgold/2），剩下的成员退回账号现状 —— 「先补到一半也能玩」。
 *
 * 准入 `fill.length >= 2` 且**必须真的留得下后半段**，否则返回 null（所谓过渡就没意义了）。
 */
export const midOf = (row, ctx) => {
  const { account } = ctx;
  const fill = row.fill || [];
  if (fill.length < 2) return null;
  const eidolons = account.eidolons instanceof Map ? account.eidolons : new Map();
  const cones = account.cones instanceof Map ? account.cones : new Map();

  const half = (row.gap || 0) / 2;
  let acc = 0;
  let k = 0;
  while (k < fill.length - 1 && acc + fill[k].pulls <= half) { acc += fill[k].pulls; k += 1; }
  if (k === 0) { acc = fill[0].pulls; k = 1; }
  const rest = (row.gap || 0) - acc;
  if (k >= fill.length || !(acc > 0) || !(rest > 0)) return null;

  const pendingRest = fill.slice(k);
  const charPending = new Set(pendingRest.filter((it) => it.kind !== 'cone').map((it) => it.name));
  const conePending = new Set(pendingRest.filter((it) => it.kind === 'cone').map((it) => it.name));

  return {
    items: k,
    gold: acc,
    rest,
    members: row.members.map((m) => {
      const ownedNow = charPending.has(m.char) ? false : eidolons.has(m.char);
      return {
        char: m.char,
        eidolon: ownedNow ? (eidolons.get(m.char) ?? 0) : null,
        lc: conePending.has(m.lc) ? null : (m.lc ?? null),
        superimp: m.lc && !conePending.has(m.lc) ? (cones.get(m.lc) ?? 0) : null,
        pending: Boolean(charPending.has(m.char) || (m.lc && conePending.has(m.lc))),
      };
    }),
  };
};

// ------------------------------------------------------------------ 次选配队（alternatives）

/**
 * 共享成员 ≥2 的邻队，取前 N 条。
 *
 * ⚠️ 候选范围是**全池**而不是已下发的前 20 条 —— 否则次选永远是「榜里的另一行」，
 * 真正相近的那些队根本进不来。加速靠倒排索引 `byMember`（见 `buildPlan` 里那段注释）。
 */
/**
 * 每个成员最多往回看多少条。
 *
 * ⚠️ 这不是「随便截断」：`byMember` 是在 `pool.sort()` **之后**建的，所以每个桶天然是
 * **按方案分降序**的，取前缀 = 取「和这个成员有关、分数最高的一批」。
 * 前缀之外的那些（排在几万名）即使用来当次选也没有意义。
 *
 * 不设的话实测会炸：10 万套阵容时，榜首四位成员的桶合计 20333 条候选，
 * 每条都要进一次去重 Set —— 单次 14 ms × 20 条下发 = 280 ms，是整个模块最大的热点
 * （profile 里排在 GC 之前）。设 400 之后这段降到 1 ms 量级，而真实数据集（候选 ~1500 套、
 * 桶平均几十条）**完全不触发**，结果逐条不变。
 */
const ALTERNATIVE_SCAN_CAP = 400;

export const alternativesOf = (row, ranked, rankOf, byMember, limit = 3,
  scanCap = ALTERNATIVE_SCAN_CAP) => {
  const mine = new Set(row.members.map((m) => m.char));
  const seen = new Set();
  const pool = [];
  for (const char of mine) {
    const bucket = byMember.get(char) || [];
    const n = Math.min(bucket.length, scanCap);
    for (let i = 0; i < n; i += 1) {
      const other = bucket[i];
      if (other.key === row.key || seen.has(other.key)) continue;
      seen.add(other.key);
      pool.push(other);
    }
  }
  const out = [];
  for (const o of pool) {
    const shared = o.members.filter((m) => mine.has(m.char)).length;
    if (shared < 2) continue;
    out.push({ o, shared });
  }
  out.sort((a, b) => b.shared - a.shared
    || Math.abs((a.o.score ?? 0) - (row.score ?? 0)) - Math.abs((b.o.score ?? 0) - (row.score ?? 0))
    || (rankOf.get(a.o) ?? 0) - (rankOf.get(b.o) ?? 0));
  return out.slice(0, limit).map(({ o, shared }) => ({
    key: o.key,
    score: Number((o.score ?? 0).toFixed(4)),
    gap: o.gap,
    shared,
    strengthPct: Number((o.strengthPart ?? 0).toFixed(4)),
    gold: o.gold,
    video: o.video ?? null,
    members: o.members.map((m) => ({ char: m.char, eidolon: m.eidolon, lc: m.lc, superimp: m.superimp })),
  }));
};

// ------------------------------------------------------------------ 总入口

/**
 * 算抽卡方案。
 *
 * @param scored `scoreEnvRows()` 的 `scored` 数组（同一关卡、多版本）
 * @param options.account       `{ owned:Set, eidolons:Map, cones:Map }`
 * @param options.availability  服务端下发的 `{characters, lightCones}`
 * @param options.hiddenCosts   隐金五项开关（未经 normalize 也行）
 * @param options.wc            性价比权重
 * @param options.maxRows       下发条数
 * @param options.maxAlternatives
 * @param options.videoOf       `(rosterKey, season) => url|null`。可选；`frontier` 行里没有
 *                              视频字段（它在 sibling 的 `teams[].sample` 上），所以要由
 *                              调用方补进来 —— 不给就一律 null，不影响其余字段。
 */
export const buildPlan = (scored, options = {}) => {
  const {
    account = {},
    availability = {},
    hiddenCosts = null,
    wc = 1,
    maxRows = 20,
    maxAlternatives = 3,
    videoOf = null,
  } = options;

  const owned = account.owned instanceof Set ? account.owned : new Set();
  const hidden = normalizeHiddenCosts(hiddenCosts);
  const isOwned = (name) => owned.has(name);

  // ---- 第一趟：按阵容聚合，算 Δgold 与逐版本成绩 --------------------------
  // ⚠️ **按整包缓存** —— `marginalCostOf` 对成员是**可加的**（它内部没有跨成员状态：
  // 逐成员累 `pulls`、push `items`），所以「整队算一遍」与「每个成员算一遍再拼起来」
  // 完全等价。而同一个整包会在上百套阵容里反复出现，不缓存的话 10 万条要跑 2.6 秒
  // （实测 1251 行 / 33 ms 线性外推），缓存后实测快一个量级。
  const costCache = new Map();
  const goldCache = new Map();
  const costOfMember = (m, packKey) => {
    let hit = costCache.get(packKey);
    if (!hit) costCache.set(packKey, (hit = marginalCostOf([m], availability, account)));
    return hit;
  };
  const goldOfMember = (m, packKey) => {
    let hit = goldCache.get(packKey);
    if (hit === undefined) goldCache.set(packKey, (hit = datasetGoldOf(m, availability)));
    return hit;
  };

  const groups = groupRosters(scored);
  const pool = [];
  for (const entry of groups.values()) {
    let gap = 0;
    // ⚠️ 这里**只加 gap，不建 gapItems 数组**：10 万条投稿有近 10 万套阵容，
    // 而 `gapItems` 只有下发那几十条的 `fill` 用得上。给全池各建一个数组（+ 把每个成员的
    // items 摊进去）会白扔掉上百毫秒。真要用时看 `gapItemsOf`。
    for (let i = 0; i < entry.members.length; i += 1) {
      gap += costOfMember(entry.members[i], entry.packKeys[i]).pulls;
    }
    let gold = 0;
    for (let i = 0; i < entry.members.length; i += 1) {
      gold += goldOfMember(entry.members[i], entry.packKeys[i]);
    }
    const best = bestSeasonOf(entry, wc, gap);

    pool.push({
      key: entry.key,
      lineup: lineupKeyOf(entry.members),
      members: entry.members,
      entry,
      // ★ 方案分 = 逐版本取最大值（用户 2026-10-18 决策）
      score: best ? best.planScore : 0,
      bestSeason: best ? best.season : null,
      strengthPart: best ? best.row.strengthPart ?? 0 : 0,
      costPart: best ? planCostPartOf(gap) : 0,
      gap,
      gold,
      video: videoOf ? (videoOf(entry.key, best?.season) ?? null) : null,
    });
  }

  // ---- 第二趟：排列 ------------------------------------------------------
  // 同分先看「要补的更少」、再看「队伍账面更省」，最后用 key 兜住顺序的稳定性。
  pool.sort((a, b) => (b.score - a.score)
    || (a.gap - b.gap)
    || (a.gold - b.gold)
    || a.key.localeCompare(b.key));

  // fill 的排序键要用角色的**全局最好分**：多个方案共用同一个角色时，它的补金优先级
  // 才不会被「它在某一行里值多少」绑住。全池扫一遍（O(4n)），比每行都回头全池搜便宜得多。
  const charBest = new Map();
  for (const p of pool) {
    for (const m of p.members) {
      const prev = charBest.get(m.char);
      if (prev === undefined || p.score > prev) charBest.set(m.char, p.score);
    }
  }
  const charScoreOf = (name) => charBest.get(name) ?? 0;

  const rankOf = new Map();
  const byMember = new Map();
  pool.forEach((p, i) => {
    rankOf.set(p, i);
    for (const m of p.members) {
      const bucket = byMember.get(m.char);
      if (bucket) bucket.push(p); else byMember.set(m.char, [p]);
    }
  });

  // ---- 第三趟：按角色组合折叠，再决定下发哪些 ------------------------------
  //
  // ⚠️ **折叠发生在「下发条数」之前**，否则 `maxRows=20` 会被同阵容的各种配装吃光：
  // 实测绝境关前三名全是「砂金•戏浪 / 知更鸟•晴歌 / 不死途 / 缇宝」四个角色，
  // 只差光锥叠影（6.551 / 6.533 / 6.524）。用户 2026-10-18 决策：按角色组合折叠。
  //
  // 折叠规则：同一 `lineup` 只留**排最前**（= 分最高）那条当代表，其余收进 `variants`
  // （按原顺序，即分数降序）。`pool` 本身不动 —— 次选配队要从全池找邻队，
  // 折叠掉的那些配装仍是合法邻队。
  const foldByLineup = () => {
    const seen = new Map();          // lineup → 代表行（pool 里的对象）
    const reps = [];
    for (const p of pool) {
      const hit = seen.get(p.lineup);
      if (hit) { hit.variants.push(p); continue; }
      seen.set(p.lineup, p);
      p.variants = [];
      reps.push(p);
    }
    return reps;
  };
  const lineups = foldByLineup();

  // ---- 第四趟：给要下发的行补隐金 / fill / mid / alternatives ----------------
  //
  // ⚠️ 隐金与逐版本明细都**只对下发的这几十条算**。这是全模块最大的一处性能设计：
  // 实测 1649 行投稿挤出 1442 套候选，而 `hiddenReductionOf` 跑全池要 8.6 ms、
  // 跑 20 条只要 0.28 ms —— 它压根不参与排序（既不进 `score` 也不进任何 tie-break），
  // 所以提前给全池算是纯浪费。判断「要不要提前算」只有一条标准：会不会改变下发的内容。
  const delivered = lineups.slice(0, Math.max(1, maxRows));
  for (const row of delivered) {
    row.cuts = hiddenReductionOf(row.members, availability, hidden, 'dataset');
    row.hiddenCut = row.cuts.team ?? 0;
    row.displayGold = Math.max(1, row.gold - row.hiddenCut);
    row.seasons = seasonsDetailOf(row.entry, wc, row.gap);
    row.gapItems = gapItemsOf(row.entry, costOfMember);
    row.fill = fillOf(row, { availability, cuts: row.cuts, charScoreOf, isOwned });
    row.pullsExpected = row.fill.reduce((n, it) => n + (it.pullsExpected || 0), 0);
    row.mid = midOf(row, { account });
    row.alternatives = alternativesOf(row, pool, rankOf, byMember, maxAlternatives);
    // 折叠进来的其它配装：**只带界面能用的字段**（成员整包 + 分数 + 补金），
    // 不跑 fill / mid / cuts —— 用户点开变体时要的是「换个光锥能省几金」，
    // 给每个变体都算一遍补金明细会把这几十行的成本翻几倍，而没人看。
    row.variants = (row.variants || []).map((v) => ({
      key: v.key,
      score: v.score,
      bestSeason: v.bestSeason,
      strengthPart: v.strengthPart,
      costPart: v.costPart,
      gap: v.gap,
      gold: v.gold,
      video: v.video,
      members: v.members.map((m) => ({
        char: m.char,
        eidolon: m.eidolon,
        lc: m.lc ?? null,
        superimp: m.superimp ?? 0,
        owned: isOwned(m.char),
      })),
    }));
  }

  return {
    rows: delivered.map((row) => ({
      key: row.key,
      members: row.members.map((m) => ({
        char: m.char,
        eidolon: m.eidolon,
        lc: m.lc ?? null,
        superimp: m.superimp ?? 0,
        owned: isOwned(m.char),
      })),
      score: Number(row.score.toFixed(4)),
      bestSeason: row.bestSeason,
      strengthPart: Number(row.strengthPart.toFixed(4)),
      costPart: Number(row.costPart.toFixed(4)),
      seasons: row.seasons.map((s) => ({
        ...s,
        planScore: Number(s.planScore.toFixed(4)),
        costPart: Number(s.costPart.toFixed(4)),
        strengthPart: Number(s.strengthPart.toFixed(4)),
      })),
      gap: row.gap,
      pullsExpected: row.pullsExpected,
      gold: row.gold,
      displayGold: row.displayGold,
      hiddenCut: row.hiddenCut,
      fill: row.fill,
      mid: row.mid,
      alternatives: row.alternatives,
      variants: row.variants,
      // 折叠键：前端用它做「一栏一行」的身份（与 `key` 不同，`key` 是整包身份）
      lineup: row.lineup,
      video: row.video,
    })),
    pool: pool.length,
    lineups: lineups.length,
    poolRows: scored.length,
    maxRows,
    truncated: lineups.length > delivered.length,
  };
};
