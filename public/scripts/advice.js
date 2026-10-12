// 抽卡推荐算法：把 theherta.com 的通关投稿变成「该抽什么、该补哪一命」的建议。
//
// 和三件事有关，每一件都来自数据而不是拍脑袋的系数：
//
//   强度    先看成绩（达到该副本最好一档的比例），同一个成绩里**用到的限定越少越强**，
//           再比平均成绩。投稿数**不是**强度——投稿多只说明玩这套的人多；它只保留成
//           一个温和的可信度折扣，在强度接近时偏向被反复验证过的解法（一次孤例仍然
//           进榜，只是排后面）。
//   成本    单位是**金**（界面上也一律写「金」）：限定角色本体 1 金 + 星魂每级 1 金，
//           限定光锥本体 1 金 + 叠影每级 1 金。4★ 的星魂是抽卡副产物，不算成本。
//           （代码里的 `pulls` 就是金数，只是历史命名没改。）
//   补强    从「你现在凑得出的最强阵容」出发，算每个缺口单位能带来多少提升。
//
// 主榜按成本档分组（先分档、档内比强度），因为「同样的成绩，谁更便宜」才是
// 抽卡决策真正要看的东西。
//
// 成绩在界面上一律写成游戏内实际的量：轮次制是 0T / ≤2T / ≤4T，末日幻影是
// 积分 4000 / ≥3700 / ≥3400，绝境王棋关是行动值 <300 / <500（见 tierLabelsOf）。
import { charactersOf } from './format.js';

/** 模式顺序，按游戏解锁顺序。 */
export const MODE_ORDER = ['moc', 'pf', 'as', 'aa'];

/** 证据档：投稿数只影响措辞与同分排序，不影响能不能进榜。 */
export const EVIDENCE_LABEL = {
  lone: '孤例',
  thin: '参考',
  ok: '可靠',
  solid: '扎实',
};

export const EVIDENCE_HINT = {
  lone: '只有 1 条投稿，可能是运气局',
  thin: '2-4 条投稿',
  ok: '5-9 条投稿',
  solid: '10 条以上投稿',
};

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * 把中文快照名登记成数据集能匹配的形式。
 *
 * 米游社返回中文（知更鸟•晴歌），数据集是英文（Robin • Summeretto），所以
 * 必须用 API 提供的中英对照表把两种写法都登记进去，否则每个角色都会被判成
 * 「你没有」。开拓者额外展开：游戏只报「开拓者」，数据集按命途分形态。
 */
const addAllForms = (set, name, zhToEn) => {
  if (typeof name !== 'string' || !name.trim()) return;
  const trimmed = name.trim();
  set.add(trimmed);
  const en = zhToEn?.[trimmed];
  if (en) set.add(en);
};

/**
 * 开拓者：**换命途不换人**（用户 2026-10 要求「开拓者及其不同命途的变体，
 * 应当视为已拥有」）。
 *
 * 游戏里开拓者只是一个角色，玩家切命途就是同一张卡换套装；而数据集（黑塔网
 * 投稿）按命途分开记，是 5 个独立的英文键：
 *
 *   毁灭 Trailblazer (Destruction) / 存护 (Preservation) / 同谐 (Harmony) /
 *   记忆 (Remembrance) / 欢愉 (Elation)
 *
 * 米游社只报**当前那一个形态**（本机实测 id 8007 = 开拓者•记忆，名字就是
 * 「开拓者」，里世界也可能给 `{NICKNAME}` 占位符）。不把「拥有一个 = 拥有全部」
 * 补上的话，实测有三处会错：
 *
 *   * 总榜的「只看我没有的」会把另外 4 个用不了的形态一并列出来；
 *   * 「环境统计 · 上场率」里 5 个形态都没有「已有」徽标；
 *   * 最要紧的是配队可达性折扣（`reachFactor`）：含开拓者的作业被当成
 *     「你这个位置是空的」，收益被白打 0.25 折。
 *
 * 而开拓者是**免费**角色（见 `charCostOf`：任意命途都是 0 金），没有任何理由
 * 把它算成缺口。判定用两个来源，缺一不可：
 *   * 名字（`开拓者` / `{NICKNAME}` / `Trailblazer`）—— 米游社返回的写法；
 *   * 头像 id 8001~8010 —— 数据集 `i18n-zh.json` 的 `charactersById` 里这十个
 *     id 全部是 `{NICKNAME}`，玩家自己改了名字时只能靠 id 认出来。
 */
const TRAILBLAZER_NAME = /trailblazer|开拓者|\{nickname\}/i;
const isTrailblazerId = (id) => /^80(0[1-9]|10)$/.test(String(id ?? ''));

/**
 * 三月七：与开拓者**完全同一条口径**（用户 2026-10-11 第 4 条：「仅有三月七·巡猎和
 * 三月七·存护 情况和开拓者类似，均为默认玩家已拥有满星魂」）。
 *
 * 数据集把它拆成两个键（`March 7th (Hunt)` / `March 7th (Preservation)`），而米游社
 * 只报一个「三月七」—— 于是 `zhToEn`（一张中文名 → 一个英文键的表）只能命中其中一个，
 * 另一个永远显示「缺」。实测症状：`三月七（巡猎）[缺·白拿]` 出现在队伍方案里。
 *
 * 它与开拓者一样是**同一个角色换命途**，且是 4★ 常驻（`charCostOf` = 0，星魂本来就不
 * 计金），所以「拥有一个命途 = 拥有全部命途」既符合游戏事实，也不会多算任何成本。
 * 名字里出现「三月七」或 `March 7th` 即算命中（玩家改名也认不出来 —— 这与开拓者
 * 靠头像 id 8001~8010 兜底不同，三月七没有 id 白名单，是已知的近似）。
 */
const MARCH_7TH_NAME = /march\s*7th|三月七/i;

/**
 * 一个「同角色多命途」的别名组：命中任一个 → 把组内**全部**写法（中文 + 数据集英文键）
 * 都登记进集合。开拓者与三月七共用这段逻辑，避免两处各写一遍（早晚漏改一边）。
 */
const addPathGroupForms = (set, allNames, zhToEn, test) => {
  // ⚠️ 判据只看 `set`：它里面已经有中英两种写法（`addAllForms` 登记的），所以
  // 「玩家有三月七（中文）」这件事一定看得见；不要再单独扫一遍 allNames，那样反而
  // 会把「数据集里有这个键」误当成「玩家拥有」。
  const hit = [...set].some((name) => test(String(name)));
  if (!hit) return;
  for (const name of allNames) {
    if (!test(String(name))) continue;
    set.add(name);
    const en = zhToEn?.[name];
    if (en) set.add(en);
  }
};

/** 玩家拥有的角色，中文与英文键都登记。 */
export const ownedCharacters = (snapshot, zhToEn = null, allNames = null) => {
  const set = new Set();
  let hasTrailblazer = false;
  for (const raw of charactersOf(snapshot)) {
    addAllForms(set, raw?.name, zhToEn);
    if (TRAILBLAZER_NAME.test(String(raw?.name || '')) || isTrailblazerId(raw?.id)) {
      hasTrailblazer = true;
    }
  }
  if (allNames) {
    for (const name of allNames) {
      const base = String(name).split(/[•·]/)[0];
      if (base && base !== name && set.has(name)) set.add(base);
    }
    // 开拓者：拥有任一命途 = 拥有全部命途。中英两种写法都要登记 ——
    // 界面发给服务端的 `owned` 只保留**数据集英文键**（见 advice-view.js 的
    // accountPayload），只加中文名的话这一步会被过滤掉，等于没做。
    if (hasTrailblazer || set.has('开拓者')) {
      for (const name of allNames) {
        if (!TRAILBLAZER_NAME.test(String(name))) continue;
        set.add(name);
        const en = zhToEn?.[name];
        if (en) set.add(en);
      }
    }
    // 三月七：同一段逻辑（见 MARCH_7TH_NAME 的注释）。
    addPathGroupForms(set, allNames, zhToEn, (name) => MARCH_7TH_NAME.test(name));
  }
  return set;
};

/**
 * 玩家拥有的光锥。
 *
 * 只有当前装备在角色身上的光锥可见，所以这是下界：没装备的看起来就没有。
 * 建议里只用**正向**匹配（「你已经有」），绝不断言「你一定没有」。
 */
export const ownedLightCones = (snapshot, zhToEn = null) => {
  const set = new Set();
  for (const raw of charactersOf(snapshot)) addAllForms(set, raw?.equip?.name, zhToEn);
  return set;
};

/**
 * 注：这里曾经有过 `equippedConesOf` / `teamCostOf`，用来给战斗记录里每一队算「金」。
 * 用户要求去掉统计金数，理由值得记下来：**限定 / 常驻的划分会随版本更新变化**
 * （`unit-availability.json` 每次更新数据集都会重新生成），把绝对金数印在战绩旁边
 * 容易误导，而战绩本身与成本无关。推荐榜那边的「用到的限定越少越强」是**相对**排序，
 * 不依赖绝对金数，所以不受这个理由影响。
 */

/**
 * 把一个等级写进「名字 → 等级」表，并把它**传播到同角色别名组的全部写法**上。
 *
 * 为什么需要传播（用户 2026-10-11 第 4 条）：三月七被数据集拆成
 * `March 7th (Hunt)` / `March 7th (Preservation)` 两个键，而米游社的
 * `zhToEn['三月七']` 只指向其中一个。只登记那一个的话，另一个命途在
 * `marginalCostOf` 里查不到星魂等级 → 会把「已经有了的满星魂」算成 E0→E6 的 6 金缺口。
 *
 * 两条路径，缺一不可：
 *   ① 从 `zhToEn` 反查：同一个中文名指向的**全部**英文键（中文名一致时最准）；
 *   ② 从 `allNames`（= 数据集的全部角色键）按名字匹配：实测 `refs.characters` 里
 *      三月七的两个键**各自只有一条中文映射**，所以 ① 只能救到一半，真正兜住的是 ②。
 *      ⚠️ 只登记 `allNames` 里给出的键，**不要**额外 add 基础名（`March 7th`）——
 *      那个键不在数据集里，加进去只会让快照多出一堆匹配不上的项。
 */
const putRank = (map, keys, rank, zhToEn, aliasTest, allNames) => {
  const all = new Set(keys.filter(Boolean));
  if (aliasTest) {
    const aliases = [];
    for (const name of [...all, ...(allNames || [])]) {
      if (aliasTest(String(name)) && !aliases.includes(String(name))) aliases.push(String(name));
    }
    if (aliases.length) {
      for (const [zh, en] of Object.entries(zhToEn || {})) {
        if (aliases.includes(String(en)) && !aliases.includes(String(zh))) aliases.push(String(zh));
      }
      // ⚠️ 先收集完再写入：边遍历边改 `all` 是没问题的（aliases 是独立数组），
      // 但把 `set` 的时机与收集混在一起会让「哪些键真的被登记了」难以断言。
      for (const name of aliases) all.add(name);
    }
  }
  for (const key of all) {
    const prev = map.get(key);
    if (prev === undefined || rank > prev) map.set(key, rank);
  }
};

/** 每个角色的星魂等级（中英键都存；三月七各命途同步，见 `putRank`）。 */
export const eidolonsOf = (snapshot, zhToEn = null, allNames = null) => {
  const map = new Map();
  for (const raw of charactersOf(snapshot)) {
    const name = raw?.name;
    if (typeof name !== 'string' || !name.trim()) continue;
    const trimmed = name.trim();
    const rank = Number(raw.rank ?? raw.actived_constellation_num ?? 0);
    const keys = [trimmed];
    if (zhToEn?.[trimmed]) keys.push(zhToEn[trimmed]);
    putRank(map, keys, rank, zhToEn, (key) => MARCH_7TH_NAME.test(key), allNames);
  }
  return map;
};

/**
 * 玩家已装备光锥的**叠影等级**（中英键都存，取见过的最高叠影）。
 *
 * 为什么要等级而不是一个名字集合：作业里常常要求「舞！舞！舞！SI5」，
 * 只有名字的话只能算出「有没有」，算不出「还差几次叠影」。
 *
 * 注意这是**下界**：米游社只返回当前装备在角色身上的光锥，放在背包里没装的
 * 看不到。所以只能用于「我确实有」的正向判断，不能反过来断言「你没有」。
 */
export const lightConeRanksOf = (snapshot, zhToEn = null) => {
  const map = new Map();
  for (const raw of charactersOf(snapshot)) {
    const cone = raw?.equip;
    const name = cone?.name;
    if (typeof name !== 'string' || !name.trim()) continue;
    const trimmed = name.trim();
    const rank = Number(cone?.rank ?? cone?.rank_level ?? 1) || 1;
    const keys = [trimmed];
    if (zhToEn?.[trimmed]) keys.push(zhToEn[trimmed]);
    for (const key of keys) {
      const prev = map.get(key);
      if (prev === undefined || rank > prev) map.set(key, rank);
    }
  }
  return map;
};

/** 这套阵容里玩家已有几个位置。 */
const ownedCountOf = (roster, owned) => roster.filter((n) => owned.has(n)).length;

/** 阵容里玩家缺的角色名（英文键）。 */
const missingOf = (roster, owned) => roster.filter((n) => !owned.has(n));

/**
 * 开拓者（任意命途）都算免费：主线直接送，一次都不会抽。
 * 名字可能是 `Trailblazer (X)`（数据集里的写法）、`开拓者`（米游社）或 `{NICKNAME}`。
 */
const isTrailblazer = (name) => /trailblazer|\{nickname\}|开拓者/i.test(String(name || ''));

/**
 * 星级：只在**真的有值**时返回数字。`Number(null) === 0` 且 `Number.isFinite(0)`
 * 为真，所以绝不能直接 `Number(info.rarity)` 比大小——那会把「星级未知」当成 4★ 免费。
 */
const rarityOf = (info) => {
  const raw = info?.rarity;
  if (raw === null || raw === undefined || raw === '') return null;
  const rarity = Number(raw);
  return Number.isFinite(rarity) ? rarity : null;
};

/**
 * 一个角色要几金。规则（用户明确指定，2026-10）：
 *
 *   限定 5★ → 1 金（星魂每级另算 1 金）；**其余一律 0 金**：
 *     * 4★ 及以下——抽限定时顺带满命，不算成本；
 *     * 常驻 5★——姬子 / 布洛妮娅 / 杰帕德 / 克拉拉 / 白露 / 彦卿 / 瓦尔特；
 *     * 开拓者——任意命途，主线赠送。
 *
 * 资料表缺项时按「要金」算（宁可高估，也不给「免费」的假象），但上面三条是**硬规则**，
 * 不依赖资料表是否收录：新角色 4★ 或新开拓者命途出来时不会被误算成 1 金。
 */
export const charCostOf = (name, availability) => {
  if (isTrailblazer(name)) return 0;
  const info = availability?.characters?.[name];
  if (!info) return 1;
  const rarity = rarityOf(info);
  if (rarity !== null && rarity <= 4) return 0;
  return info.limited === false ? 0 : 1;
};

/**
 * 一个光锥要几金。规则（用户明确指定）：**只有活动跃迁光锥算成本，其他都不算**——
 * 4★ 及以下、常驻池 5★、星芒商店换的 5★ 都不算（后两者在资料表里标成
 * `limited: false`，名单在 `tools/herta-availability.mjs` 里人工维护）。
 * 资料表缺项时按 1 金算：新 5★ 光锥绝大多数是活动跃迁的，默认「要金」更安全。
 */
export const coneCostOf = (name, availability) => {
  const info = availability?.lightCones?.[name];
  if (!info) return 1;
  const rarity = rarityOf(info);
  if (rarity !== null && rarity <= 4) return 0;
  return info.limited === false ? 0 : 1;
};

/**
 * 把阵容缺的角色折成**金数**（界面上写「金」，代码里沿用 `pulls` 这个历史命名）。
 *
 * 口径见 `charCostOf`：只有限定 5★ 才算金；4★、常驻 5★、开拓者都是 0 金。
 */
export const pullCostOf = (names, availability) => {
  let pulls = 0;
  const items = [];
  for (const name of names) {
    const cost = charCostOf(name, availability);
    pulls += cost;
    const info = availability?.characters?.[name];
    items.push({
      name,
      kind: 'char',
      pulls: cost,
      limited: info && typeof info.limited === 'boolean' ? info.limited : null,
      certainty: Boolean(info),
    });
  }
  return { pulls, items };
};

/**
 * 从现有配队出发的补强方案。
 *
 * `stats` 是 /api/archive/stats 的返回，`owned` 是玩家角色键集合。
 * `budget` 是还能再抽几发（null / undefined = 不限）。
 *
 * 返回：
 *   now      当前最强可凑阵容（可能为 null，说明凑不出完整四件）
 *   upgrades 缺口补强，按「提升 / 抽数」排序
 *   bands    成本档内玩家可抄的阵容（already = 你直接就能凑出来）
 */
export const recommendPlan = (stats, options = {}) => {
  const owned = options.owned instanceof Set ? options.owned : new Set();
  const availability = stats?.refs?.availability || {};
  const budget = Number.isFinite(options.budget) ? Number(options.budget) : null;
  const bands = Array.isArray(stats?.bands) ? stats.bands : [];
  const all = bands.flatMap((b) => (b.teams || []).map((t) => ({ ...t, band: b.id, bandLabel: b.label })));
  if (!all.length) return { now: null, upgrades: [], bands: [], owned: owned.size, budget };

  // ---- 当前水平：直接能凑出来的阵容里，平均行动值最低、满分率最高的那套
  const feasible = all.filter((t) => ownedCountOf(t.roster, owned) === t.roster.length);
  const byAv = (a, b) => ((a.avgAv ?? Infinity) - (b.avgAv ?? Infinity))
    || (b.perfect - a.perfect) || (b.trust - a.trust);
  const now = feasible.length ? [...feasible].sort(byAv)[0] : null;
  const nowAv = now?.avgAv ?? null;
  const nowPerfect = now?.perfect ?? 0;

  // ---- 补强候选：缺 1 个或 2 个单位的阵容
  const candidates = all.filter((t) => {
    const missing = missingOf(t.roster, owned);
    return missing.length > 0 && missing.length <= 2;
  });

  const upgrades = [];
  const seen = new Set();
  for (const team of candidates) {
    const missing = missingOf(team.roster, owned);
    const { pulls, items } = pullCostOf(missing, availability);
    if (budget !== null && pulls > budget) continue;
    // 只保留「比现在更强」的：平均行动值更低，或行动值相同但满分率更高。
    const gainAv = nowAv !== null && team.avgAv !== null ? nowAv - team.avgAv : null;
    const gainPerfect = team.perfect - nowPerfect;
    const better = now === null
      || (gainAv !== null && gainAv > 0.001)
      || (gainAv === null && gainPerfect > 0.001);
    if (!better) continue;
    const key = `${team.rosterKey}|${missing.join('+')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    upgrades.push({
      rosterKey: team.rosterKey,
      roster: team.roster,
      rosterCn: team.rosterCn,
      missing,
      missingCn: missing.map((n) => team.rosterCn?.[team.roster.indexOf(n)] || n),
      items,
      pulls,
      // 抽数 0 的补强（缺的是常驻/4★）单独标出来：不用抽，攒着就有
      free: pulls === 0,
      perfect: team.perfect,
      gainPerfect,
      avgAv: team.avgAv,
      gainAv,
      bestAv: team.bestAv,
      cost: team.cost,
      count: team.count,
      seasonCount: team.seasonCount,
      seasons: team.seasons,
      evidence: team.evidence,
      keyEidolon: team.keyEidolon,
      keyEidolonShare: team.keyEidolonShare,
      eidoDist: team.eidoDist,
      volatility: team.volatility,
      band: team.band,
      bandLabel: team.bandLabel,
      sample: team.sample,
      // 性价比：行动值每抽省下多少。免费补强直接给最高优先。
      efficiency: pulls === 0 ? Number.POSITIVE_INFINITY
        : (gainAv !== null ? gainAv / pulls : gainPerfect / pulls),
    });
  }

  upgrades.sort((a, b) => b.efficiency - a.efficiency
    || (a.pulls - b.pulls)
    || (b.gainPerfect - a.gainPerfect)
    || (a.avgAv ?? Infinity) - (b.avgAv ?? Infinity));

  return {
    now,
    upgrades,
    bands: bands.map((band) => ({
      ...band,
      teams: (band.teams || []).map((t) => {
        const have = ownedCountOf(t.roster, owned);
        const missing = missingOf(t.roster, owned);
        const { pulls } = pullCostOf(missing, availability);
        return {
          ...t,
          ownedCount: have,
          ownedTotal: t.roster.length,
          missing,
          missingCn: missing.map((n) => t.rosterCn?.[t.roster.indexOf(n)] || n),
          needPulls: pulls,
          // 直接能抄 / 补 1 个就能抄
          already: have === t.roster.length,
          reachable: missing.length === 1,
        };
      }),
    })),
    owned: owned.size,
    budget,
  };
};

/**
 * 关键星魂：这套阵容里投稿用得最多的那个星魂档，以及要达到它需要多少抽。
 *
 * 「都算」是用户的明确要求——成本里按作业实际用的星魂数计价，同时把关键星魂
 * 标出来，这样既知道要花多少钱，也知道钱花在哪个角色上。
 */
export const keyEidolonOf = (team, availability) => {
  if (!team || !Number.isFinite(team.keyEidolon)) return null;
  const dist = Array.isArray(team.eidoDist) ? team.eidoDist : null;
  if (!dist) return null;
  const total = dist.reduce((a, b) => a + b, 0) || 1;
  // 找出最吃星魂的那个角色：按 eidoDist 无法拆到角色，所以用 sample 的配装，
  // 取其中星魂数最高的成员作为「关键星魂」的载体。
  const members = team.sample?.members || [];
  const top = members.reduce((best, m) => (!best || (m.eidolon || 0) > (best.eidolon || 0) ? m : best),
    null);
  const eidolon = team.keyEidolon;
  const pulls = eidolon; // 从 E0 补到 En 需要 n 抽
  return {
    eidolon,
    share: team.keyEidolonShare ?? 0,
    distribution: dist.map((n) => Number((n / total).toFixed(3))),
    carrier: top ? { name: top.char, nameCn: top.charCn, eidolon: top.eidolon } : null,
    pulls,
    limited: top ? availability?.characters?.[top.char]?.limited === true : null,
  };
};

/** 行动值/轮次的显示：整数就不带小数，小数保留 2 位。 */
export const formatAv = (v) => {
  if (!Number.isFinite(v)) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
};

/** 比例显示成百分比。 */
export const formatRate = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—');

// ---------------------------------------------------------------- 成绩的写法
//
// 界面上**不用**「及格 / 达标 / 满分」这类模糊说法，一律写游戏内实际的那个量：
//
//   轮次制（混沌回忆 / 虚构叙事 / 异相仲裁骑士关与普通王棋关）  0T / ≤2T / ≤4T
//   末日幻影                                                  积分 4000 / ≥3700 / ≥3400
//   异相仲裁 · 绝境王棋关                                      行动值 <300 / <500
//
// T = 轮次（0T 就是 0 轮通关）。这样用户看到的数字能直接和游戏内结算界面对照，
// 而不是先在心里把「满分」翻译成「0 轮」。

/** 数据集里的 `avgAv` 方向统一（越小越好）：末日幻影的积分是 4000 − avgAv。 */
export const avUnitOf = (mode, stage) => {
  if (stage === 'plight') return '行动值';
  if (mode === 'as') return '积分';
  return 'T';
};

/**
 * 一个成绩值怎么写：`0T` / `积分 4000` / `行动值 289`。
 * `raw` 是该副本自己的量纲（轮次制的 metric 就是轮次，末日幻影是积分，
 * 绝境王棋关传行动值）。积分取整：游戏内结算显示的就是整数分，而平均值算出来
 * 会带小数（3940.45），保留小数反而像是假精度。
 */
export const metricValueText = (mode, stage, raw) => {
  if (mode === 'as') return `积分 ${formatAv(Math.round(raw))}`;
  if (stage === 'plight') return `行动值 ${formatAv(raw)}`;
  return `${formatAv(raw)}T`;
};

/**
 * 阵容卡上的主指标：`平均 0T` / `平均积分 3940` / `平均行动值 289`。
 * 入参是 `avgAv`（末日幻影已换算成 4000 − 积分）。
 */
export const metricTextOf = (mode, stage, avgAv) => {
  if (mode === 'as') return `平均积分 ${formatAv(Math.round(4000 - avgAv))}`;
  if (stage === 'plight') return `平均行动值 ${formatAv(avgAv)}`;
  return `平均 ${formatAv(avgAv)}T`;
};

/**
 * **实测成绩**的短写法（用户 2026-10-11 第二轮：「表现直接写具体成绩更好，例如行动值
 * 直接写 285 就行」）。
 *
 * 与 `metricValueText()` 的区别只有一个：**不带单位前缀**。用在浮层「表现」列 ——
 * 那一列上方已有脚注说明量纲、且同一行里还会写档位，再重复一遍「行动值」三个字
 * 既占宽又没信息量。
 *
 * ⚠️ **末日幻影必须把内部的反向值翻回来**（`av = 4000 − 积分`）。实测踩过：
 * 直接印内部 `av` 会把「积分 3852」显示成 `148` —— 读者会以为那是行动值，
 * 而且它恰好落在「越接近 0 越强」的直觉里，错得非常隐蔽。
 *
 * @param {string} mode 短码（`moc` / `pf` / `as` / `aa`）
 * @param {string} stage 关卡（`plight` 等）
 * @param {number|null} av 数据集内部值（统一「越小越好」方向）
 */
export const metricShortText = (mode, stage, av) => {
  if (!Number.isFinite(av)) return '—';
  if (mode === 'as') return formatAv(Math.round(4000 - av));
  if (stage === 'plight') return formatAv(av);
  return `${formatAv(av)}T`;
};

/** 补强的收益怎么写。入参是 `gain`：正数 = 变强（末日幻影 = 积分变高，其余 = 数字变小）。 */
export const metricDeltaText = (mode, stage, gain) => {
  if (!Number.isFinite(gain)) return '';
  const size = formatAv(Math.abs(gain));
  if (mode === 'as') return `积分 ${gain >= 0 ? '+' : '−'}${size}`;
  // 轮次与行动值都是越小越好，所以收益为正时写成减法。
  if (stage === 'plight') return `行动值 ${gain >= 0 ? '−' : '+'}${size}`;
  return `${gain >= 0 ? '−' : '+'}${size}T`;
};

// ============================================================ 跨模式综合结论
//
// 用户的要求：给一份**跨越所有副本**的结论——这个账号该抽哪些角色 / 星魂 /
// 光锥最划算，并且要考虑「这个角色的配队和我已有的角色差多远」：某个角色再强，
// 如果同一套配队里的其它限定我没有，那就不太值得抽。
//
// 做法（三步，每一步都来自数据，没有拍脑袋的系数）：
//
//   1. 每个副本/关卡各自算一遍「照抄这套作业，我还得抽几发」——不只算我想抽的
//      那一个单位，而是把这套作业里**我缺的每一个限定单位**都算进去：角色本体、
//      星魂每一级、限定光锥本体与每一次叠影。这就是「配队差距」的量化。
//
//   2. 每个副本/关卡各有一条基线：**一发都不用抽**就能照抄的作业里，能稳定打到
//      的最好一档。提升 = 候选作业的档位 − 基线档位。档位就是该副本自己的判据
//      （0T / ≤2T / ≤4T、积分 4000 / ≥3700 / ≥3400、行动值 <300 / <500），
//      换算成同一把尺子后四个模式可以相加。
//
//   3. 性价比 = 提升 ÷ 这套作业的总造价。所以「角色很强但配队还要补两个限定」
//      的造价被摊薄，性价比自然掉下去——这正是「根据成本差距考虑抽取建议」。
//      同一个副本里一个单位只记它最好的一套作业（取最大值，不去重复加分），
//      跨副本再相加：能同时改善多个副本的单位排在前面。

/** 定档 → 分数。四个模式/关卡共用一套刻度，跨模式可相加。 */
export const TIER_SCORE = { perfect: 2, target: 1, pass: 0.5, below: 0 };

/**
 * 档位的**游戏内实际表述**，界面上一律用这一套。
 *
 * 为什么不用「及格 / 达标 / 满分」：那三个词要先在心里翻译一次才知道到底要打多少
 * 轮、多少分，而玩家的判据本来就是「能不能 0T」这种具体数字。所以直接把判据线
 * 写出来，看到的就是游戏内结算界面上那个量。
 *
 * 返回四个档位的短标签（没有第三档时，`pass` 就是「没到第二档」的写法）：
 *   轮次制   `0T` / `≤2T` / `≤4T` / `>4T`
 *   末日幻影 `积分 4000` / `积分 ≥3700` / `积分 ≥3400` / `积分 <3400`
 *   绝境     `行动值 <300` / `行动值 <500` / `行动值 ≥500`
 */
export const tierLabelsOf = (mode, stage, tierLines) => {
  const lines = tierLines || {};
  if (stage === 'plight') {
    const two = Number.isFinite(lines.target) ? lines.target : lines.perfect;
    return {
      perfect: `行动值 <${formatAv(lines.perfect)}`,
      target: `行动值 <${formatAv(two)}`,
      pass: `行动值 ≥${formatAv(two)}`,
      below: `行动值 ≥${formatAv(two)}`,
    };
  }
  if (mode === 'as') {
    return {
      perfect: `积分 ${formatAv(lines.perfect)}`,
      target: `积分 ≥${formatAv(lines.target)}`,
      pass: `积分 ≥${formatAv(lines.pass)}`,
      below: `积分 <${formatAv(lines.pass)}`,
    };
  }
  return {
    perfect: `${formatAv(lines.perfect)}T`,
    target: `≤${formatAv(lines.target)}T`,
    pass: `≤${formatAv(lines.pass)}T`,
    below: `>${formatAv(lines.pass)}T`,
  };
};

/**
 * 「≤2T → 0T」/「积分 ≥3400 → ≥3700」：两边共有的前缀合并，避免重复写一遍整段。
 * 比较符（< > ≤ ≥）算进数字那一段——否则「行动值 <500 → <300」会被并成
 * 「行动值 <500 → 300」，把第二个比较符吃掉，读起来完全变味。
 */
export const tierMoveText = (from, to) => {
  const cut = (s) => {
    const m = String(s ?? '').match(/^([^0-9]*?)([0-9].*)$/);
    if (!m) return [String(s ?? ''), ''];
    let head = m[1];
    let num = m[2];
    const tail = head.match(/[<≤>≥]\s*$/);
    if (tail) {
      num = head.slice(head.length - tail[0].length) + num;
      head = head.slice(0, head.length - tail[0].length);
    }
    return [head, num];
  };
  const [fromHead, fromNum] = cut(from);
  const [toHead, toNum] = cut(to);
  if (fromNum && toNum && fromHead === toHead) return `${fromHead}${fromNum} → ${toNum}`;
  return `${from ?? '—'} → ${to ?? '—'}`;
};

/**
 * 判据线缺失时的**兜底**写法（正常路径永远走 `tierTextOf()`，见下）。
 * 刻意只描述「第几档」而不写数字 —— 编一个 `0T` 出来比留空更糟。
 */
export const TIER_PLACEHOLDER = {
  perfect: '最好一档',
  target: '次好一档',
  pass: '第三档',
  below: '未到判据线',
};

/**
 * 每个档位要靠哪一条判据线才写得出来。
 *
 * ⚠️ **不能只看 `tierLines` 在不在**：`tierLabelsOf()` 对缺失的线会拿 `formatAv(undefined)`
 * 拼出 `—T` / `积分 ≥—` 这种看着像真数字的字符串（实测踩过：元数据少了 tierLines 时
 * 界面显示 `—T` 而不是兜底文案）。所以这里逐个档位标出**依赖的那条线**，先验它是有限数。
 * 绝境只有两条线（`pass` 落到 `target`、`target` 落到 `perfect`，与 `tierLabelsOf` 一致）。
 */
const TIER_LINE_KEY = {
  perfect: 'perfect',
  target: 'target',
  pass: 'pass',
  below: 'pass',
};

/**
 * 档位在界面上的写法：**直接给游戏内那个量**（`0T` / `积分 ≥3700` / `行动值 <500`）。
 *
 * 用户 2026-10-10 明确要求：网页上不许再出现「满分 / 达标」这种要先在心里翻译一次的
 * 说法，要写出**具体的行动值**。原来界面上到处是 `满分` / `达标` / `达标成本`，
 * 读者得先知道「满分 = 0T 或行动值 <300」才能判断这个数字值不值。现在一律走这里，
 * 把内部档位键（`perfect` / `target` / `pass` / `below`）翻成该副本判据线的实际写法。
 *
 * ⚠️ **判据线（`tierLines`）必须由调用方给全**：它只存在数据集里（建库侧按模式写死
 * 的三条线，见 `tools/herta-build.mjs` 的 `TIER_LINES`），编不出来。所以 `frontierEnvs`
 * 与 `/api/archive/packs` 的副本元数据都要一起下发 `mode` / `stage` / `tierLines`；
 * 缺了就退回 `TIER_PLACEHOLDER` 的**中性写法**（说清是第几档，绝不编造具体数字）。
 */
export const tierTextOf = (meta, tier) => {
  if (!TIER_PLACEHOLDER[tier]) return '—';
  const lines = meta?.tierLines || {};
  const needed = TIER_LINE_KEY[tier];
  // 绝境只有两条线：`target` 缺了就用 `perfect`，`pass` / `below` 缺了就用 `target`
  // （与 `tierLabelsOf()` 里的 `two` 完全同一套回退，不要各写一份）。
  const line = Number.isFinite(lines?.[needed])
    ? lines[needed]
    : (Number.isFinite(lines?.perfect) ? lines.perfect
      : (Number.isFinite(lines?.target) ? lines.target : null));
  if (line === null) return TIER_PLACEHOLDER[tier];
  const labels = tierLabelsOf(meta?.mode, meta?.stage, lines);
  return labels?.[tier] || TIER_PLACEHOLDER[tier];
};

/** 分数 → 档位名（内部键，界面上不直接显示）。 */
export const scoreTier = (score) => {
  if (score >= 2) return 'perfect';
  if (score >= 1) return 'target';
  if (score >= 0.5) return 'pass';
  return 'below';
};

export const tierScoreOf = (tier) => TIER_SCORE[tier] ?? 0;

/**
 * 同一档内的细分：达到这一档之后，行动值/轮次还省下多少。
 *
 * 为什么需要它：档位刻度太粗。这个账号在混沌回忆、虚构叙事、异相仲裁（骑士关）
 * 里都有「0 抽就能照抄、多数投稿满分」的阵容，只用档位的话增益恒为 0，结论会
 * 变成「四个副本都不用抽」——但同样满分，消耗 0 回合和消耗 0 回合之间没有差别，
 * 而末日幻影 3916 分和 4000 分之间差别很大。用户的原话是「消耗的行动值少/轮次少
 * 才是真的强」，所以档内还要看这一项。
 *
 * 权重 AV_WEIGHT = 0.4 < 1：跨一档（达标 → 满分）一定比任何档内优化更重要，
 * 这是刻意的取舍，不是拟合出来的数。
 *
 * 判据线从数据里读（tierLines），并且统一换算到「行动值」这个方向：
 * avgAv 在数据集里**永远越小越好**（末日幻影的积分在建库时已经换算成
 * 4000 − 积分），而 tierLines 里的末日幻影线是积分线，所以要翻转。
 */
export const AV_WEIGHT = 0.4;

/**
 * 评分模型参数（全部集中在这里，按效果调这几个数就够）。
 * 设计说明见 docs/评分模型设计.md。
 */
export const SCORING = {
  // q = perf^α × pars × trust
  perfAlpha: 2,          // 高分队伍的区分度
  parsimonyLambda: 1,    // 每多带 1 个非关键限定，权重 1/(1+λ)
  // 参考集自适应截断：累计 q 到 80%，下限/上限兜底
  refCoverage: 0.8,
  refMin: 10,
  refMax: 100,
  // ⚠️ `reachBeta`（可达性指数 β=1.5）已于 2026-10-11 删除（缺陷 6：死代码清理）：
  // 文档 §③ 早已注明它被「修正 A」废弃，全仓零引用 —— 留着只会让人以为可达性还在乘。
  // 可达性折扣现在由 `reachFloor`（见下）承担，`reach` 只作为展示字段。
  // 候选作业最多要补几金。修正A 的原话是「缺 1~3 个单位的都算候选……整套补的方案
  // 也要能进候选」，但绝境王棋关那类副本**最便宜**的一套也要补 4 金，
  // 于是权重最高的副本整档被挡在门外（实测：含知更鸟 E2 的 44 套里 0 套 ≤3 金）。
  // 放宽到 6 之后，贵方案会被分母（期望抽数）自然压低，不会挤掉「补 1 个就能用」。
  candidateMaxPulls: 10,
  // 副本权重：异相仲裁最关键（用户第 5 条），虚构最低（用户第 2 条）
  //
  // 2026-10 第三次调整（用户直接给定的五档，取代此前所有推导值）：
  //
  //     异相仲裁 · 绝境 10 / 异相仲裁 1 / 末日幻影 1 / 混沌回忆 1 / 虚构叙事 1
  //
  // 口径也比之前更直白：**只有「绝境王棋关」是关键副本，其余四个一视同仁**。
  // 所以不要再按 1.875 / 1.75 / 1 / 0.8 / 0.5 那种「拉开间距」的写法去改——
  // 用户要的是「绝境占绝对主导，其它四个平等」，界面上的两组输入框默认就是这组数
  // （`ENV_WEIGHT_ROWS` + `envWeightDefaults()`），用户随时可以自己改。
  //
  // 这张表只是**默认值**：界面给了两套独立的覆盖（总榜 / 方案，见 WEIGHT_SCOPES），
  // 两边都不动的时候都读这里，所以「默认口径」永远只有一份。
  envWeight: {
    'Anomaly Arbitration|plight': 10,
    'Anomaly Arbitration|': 1,
    'Apocalyptic Shadow|': 1,
    'Memory of Chaos|': 1,
    'Pure Fiction|': 1,
  },
  envWeightDefault: 1,
  /**
   * 达标率提升的放大倍数（见 `eidolonStepValue` 的 ⓪ 分支）。
   *
   * 达标率之差是个小量：实测同一阵容里 E0→E1 的达标率提升中位数在 8%~15%
   * （ΣΔhit/配对数的实测值：刻律德菈 15.2%、Tribbie 8.1%、花火 E2→E3 反而是 −6.1%）。
   * 乘 3 之后这些档位之间才拉得开差距；上限由外层的 `Math.min(1, ·)` 兜住，
   * 所以不会把某一个档位顶到超出「满分提升」的量级。
   */
  stabilityGain: 3,
  /**
   * 配队可达性折扣的下限（见单位归因处的 `reachFactor`）。
   *
   * 一个成员都没有时把贡献乘 0.25；全都拥有时不打折。取 0.25 而不是 0：
   * 「从零起一套」仍然要能进榜（修正 A 的原意），只是不该压过「补 1 个就能用」。
   */
  reachFloor: 0.25,
  /**
   * 副本证据稀疏时的兜底折扣（见 `eidolonStepValue` 的 `fallbackFromOtherEnvs`）。
   *
   * 权重最高的副本往往投稿最少（实测绝境王棋 342 套阵容 vs 骑士关 1170 套），
   * 于是最关键的副本最容易「量不出来」而记 0——遐蝶 E0→E2 就是这么被压下去的。
   * 用其它副本的同一提升打个折顶上，并在浮层里标注是推断值。
   */
  sparseEnvDiscount: 0.5,
  /** 兜底要求的其它副本最少个数（太少就不值得推断）。 */
  sparseEnvMinOthers: 2,
  /**
   * 「和主流强阵的差距」口径里，一条路最多允许差几金（见 `gapUnits`）。
   *
   * 差得太多就不是「补齐现有阵容」，而是「从零起一套」——那种方案不该和
   * 「再补 1 金就能照抄主流」并列。取 8：实测用户账号上主流强阵的缺口多在 1~6 金。
   */
  gapMaxPulls: 8,
  /** 每个副本保留几个「主流强阵」目标（按档位与造价排完序取前几个）。 */
  gapTargetsPerEnv: 40,
  /**
   * 抽卡方案最多取几套作业（`packages`）。
   *
   * 取的时候是**按副本轮转**的（见 `packages` 的注释），所以这个数要够大，
   * 每个副本才能拿到多套；太小会让方案很快就没得排。
   */
  packageLimit: 60,
  /**
   * 差距榜里「造价」的折减强度（见 `gapUnits` 的 `costFactor`）。
   *
   * `costFactor = 1 + gapCostScale × (金数 − 1)`：0.08 → 1 金不打折、
   * 2 金 ×1.08、8 金 ×1.56。**刻意很弱**：金是 1~8 的小整数，当作硬分母会让
   * 「便宜但没用」的档位压过「贵一点但关键」的档位（实测花火 E2→E3 1 金、
   * 前沿边际仅 0.014，却排到遐蝶 E0→E2 2 金、边际 0.102 的前面）。
   * 强度差是量级差（7 倍），造价差只是倍数（2 倍），所以折减必须弱。
   */
  gapCostScale: 0.08,
  /** 达标率画像拿到满权重所需的每档投稿数（样本折扣的分母）。 */
  stabilityFullRuns: 8,
  /**
   * 「结构最优」在星魂出分里的混合权重（0~1）。
   *
   * `gradeGain` 把两个量混起来：副本全局平均（这一档对人群平均多出多少分）
   * 与结构最优（在**某一套**阵容里它是关键金，最好那套能多出多少分）。
   * 取 0.5 是让两者等权：既要「普遍有用」，也要「在某些阵容里是决定性的一道门槛」——
   * 后者正是用户说「对改善出分和压金 0T 相当重要」的语义。
   */
  bestGainWeight: 0.5,
  /**
   * 单个副本的档位价值上限（保险丝，不是调参旋钮）。
   *
   * `tierUpRatio ≤ 1`，达标率因子在实测量级（Δ≤0.3）下不超过 1.9，
   * 所以正常取值远低于 3。设这个上限只为拦住极小样本的极端值。
   */
  maxStepValue: 3,
  /**
   * 旧版前沿比例配置，保留以兼容外部调用；总榜现在使用成本/行动值帕累托前沿，
   * 不再截取固定比例，也不因投稿数量改变权重。
   */
  frontierPct: 0.25,
  /**
   * 绝境前沿的队伍质量权重：压金是主指标，行动值负责区分同成本队伍。
   * 这两个值只用于队伍筛选，不会把投稿条数混进分数。
   */
  frontierCostWeight: 0.65,
  frontierActionWeight: 0.35,
  // ⚠️ `frontierHighscoreFloor` 已于 2026-10-11 删除（缺陷 6：死代码清理）：全仓零引用，
  // 是「前沿取高分那批」旧口径的残留（v14 起改成服务端成本截断后就不用了）。
  /**
   * 档位权重：满分档（0T / 满行动值线）与达标档。
   *
   * ⚠️ 用户 2026-10-11 缺陷 3 起，这一项**不再单独相乘** —— 它被合并进
   * `perfFactorOf()` 的连续曲线（满分线处 = 1.00、达标线处 = 0.50，与这张表在线上
   * 完全一致，只是线之间从阶梯变成连续）。保留它有两个用途：
   *   ① 判据线取不到时的**兜底**（老数据集 / 夹具）；
   *   ② `frontierFactorsOf().tierFactor` 兼容字段。
   */
  frontierTierWeight: { perfect: 1, target: 0.5 },
  /**
   * ⚠️ `frontierAvShare`（`0.5 + 0.5 × 分位归一化名次`）在**总榜算分里已不再使用**
   * （用户 2026-10-11 缺陷 3：档位与行动值合并，归一化改以**游戏判据线**为标尺）。
   *
   * 保留它是因为**抽卡方案**那条链（`avTermOf` / `scoreOf`）仍在用它 —— 那里量的是
   * 「同一档内还省下多少」，与总榜的表现分是两回事，不要一起改。
   * `frontierFactorsOf().avFactor` 同样保留为兼容字段。
   */
  frontierAvShare: 0.5,
  /**
   * 表现分的**地板**（用户 2026-10-11 缺陷 3）。
   *
   * `perfFactorOf()` 以判据线为标尺做连续曲线，理论上可以衰减到 0。但有两个场景需要地板：
   *
   *   ① **判据线与成绩量纲不匹配**（老数据集 / 测试夹具没给该副本的 `tierLines`，
   *      退回别的副本的线）—— 此时所有配置都会落到线外，曲线一律给 0 → **整期榜面
   *      直接空掉**。旧口径（分位归一化）永远给 0.5~1，不会有这个问题。
   *   ② **极端环境**：某一期怪物特别强，所有队伍都在及格线外。给 0 等于宣称
   *      「这一期没有任何配置有价值」，而它们之间的相对高低仍是有信息的。
   *
   * 取 0.05：正常数据（至少有一条配置落在判据线内）**完全不受影响** —— 它只在
   * 「整期都不达标」时才起作用，且量级足够小（5%），不会盖过任何线内的配置。
   */
  frontierPerfFloor: 0.05,
  /**
   * **表现曲线在三条判据线上的取值**（用户 2026-10-11 第二轮：「要有更精细的表现权重
   * 变化梯度」）。
   *
   * 上一版把 `av ≤ 满分线` 整段写成**平的 1.00** —— 于是绝境里行动值 37 和 299 拿同一个
   * 分（实测 frontier 池里 perfect 档的 av 跨 [37, 299]），档内**完全没有区分度**。
   * 这一版把曲线改成**全程严格递减**：以 `av = 0`（理论最好成绩）为顶点 1.00，
   * 依次经过三条判据线，中间线性过渡：
   *
   * ```
   *   av = 0（0T / 行动值 0 / 积分 4000） → 1.00
   *   满分线                              → frontierPerfPerfectLine（0.85）
   *   达标线                              → frontierPerfTargetLine （0.50）
   *   及格线                              → frontierPerfPassLine   （0.25）
   *   及格线以外                          → 线性衰减到 frontierPerfFloor（0.05）
   * ```
   *
   * 设计取舍：
   *   * **达标线仍取 0.50** —— 与旧的 `frontierTierWeight`（满分 ×1 / 达标 ×0.5）在
   *     这一点上完全一致，「跨过达标线」这个游戏内最有意义的分界没有被改动。
   *   * **满分线取 0.85 而不是 1.00** —— 这是为了给满分档留出**档内梯度**。代价是
   *     「满分」不再等于满值，但它换来的是「同样满分，谁用得更少谁更强」能被看见
   *     （用户原话：「消耗的行动值少/轮次少才是真的强」）。跨档落差（0.85→0.50 = 0.35）
   *     仍远大于档内落差（1.00→0.85 = 0.15），所以「跨一档比任何档内优化更重要」
   *     这条原设计意图保住了。
   *     ⚠️ **绝境王棋关自 v4.6.78 起不用这三个默认值**（用户 2026-10-11 第四轮点名）：
   *     它的满分线以内固定 1.00、达标线取 0.60 —— 见下面的 `frontierPerfLineByEnv`。
   *   * **满分线本身就是理论最好时**（混沌回忆 / 虚构叙事 / 末日幻影的满分线 = 0T 或
   *     积分 4000，即 av 空间的 0）→ 那一段退化，曲线直接从 1.00 接到达标线，
   *     不硬凑一个满分锚点（`perfAnchorsOf` 会跳过它）。
   */
  frontierPerfPerfectLine: 0.85,
  frontierPerfTargetLine: 0.5,
  frontierPerfPassLine: 0.25,
  /**
   * **按副本覆盖**上面三条判据线的取值（用户 2026-10-11 第四轮，工具 v4.6.78）。
   *
   * 用户原话（本轮需求，只点名了绝境王棋关）：
   *   「绝境王棋关的表现权重需要更新，行动值小于 300，权重固定为 1.00；
   *     行动值 300-500，权重在 1-0.6 之间逐渐变化」
   *
   * 落在曲线上就是（绝境的判据线是满分 300 / 达标 500，没有及格线）：
   *
   * ```
   *   av < 300        → 1.00（**平的**：满分线以内不再有 1.00→0.85 的档内缓降）
   *   300 ≤ av ≤ 500  → 1.00 线性降到 0.60
   *   av > 500        → 按最后一段的斜率继续衰减到地板 frontierPerfFloor（实测 av=775 触底）
   * ```
   *
   * ⚠️ **为什么是「按副本覆盖」而不是直接改上面三个常量**：那三个数是**所有副本共用**的
   * 默认值，动一下会连带改掉混沌回忆 / 虚构叙事 / 末日幻影 / 骑士关的曲线 —— 它们的
   * 满分线与绝境不是一回事（那三个的满分线就是 0T / 积分 4000，v26 的「0.85 换档内梯度」
   * 那条取舍是为它们定的）。用户这一轮点名的只有绝境，所以只覆盖绝境；以后要给别的副本
   * 另一套（例如 `docs/评分模型设计.md` v28 提过的末日幻影单独 perfect 线），往这张表里
   * 加一行即可，不必碰算分代码。
   *
   * 键与 `SCORING.envWeight` **同一形状**（`${站点全名}|${关卡}`），短码由
   * `perfLineWeightsOf()` 归一 —— 一份表、一处归一，别在别处再写第二份。
   * 值可以只写要覆盖的那几档（缺的档继续用上面的默认值）。
   */
  frontierPerfLineByEnv: {
    'Anomaly Arbitration|plight': { perfect: 1, target: 0.6 },
  },
  /**
   * 整包口径的分数尺度（0~100 体系里的 100）。
   *
   * 一个整包在一个副本里的分 = `frontierPackScale × 表现 × 金数项`（见 `frontierCostTermOf`），
   * 上限 100（该副本最便宜的达标配置）。乘 100 是为了与抽卡方案同量级：界面统一用
   * `scorePercent()` 显示，两个榜的数字才能并排比较（旧的 `frontierUnitScale` 是前身）。
   *
   * ⚠️ 2026-10-11 第 3 条起**上限变成 1.2 × 100 = 120**：0 金通关拿 `frontierZeroGoldBonus`
   * （1.2），所以「最高刚好是 100」这句话只在「非 0 金」的队伍上成立（金数项封顶 ×1）。
   */
  frontierPackScale: 100,
  /**
   * 金数项的**封顶**与 **0 金通关奖励**（用户 2026-10-11 第 3 条，原话：
   * 「倍数封顶 1.00，使用 0 金通关额外获得 1.2 的倍率（对所有关卡生效）」）。
   *
   * ```
   *   金数项 = 0 金通关（隐金后有效队伍金数 = 0） → frontierZeroGoldBonus = 1.2
   *           = 其它                              → min(frontierCostCap = 1, 分母 ÷ 本队金数)
   * ```
   *
   * 用户对两处口径都做了明确澄清：**0 金 = 隐金后的有效队伍金数**（不是原始金数，
   * 也不是整包自己的金数），**1.2 是「倍率」**（替换，不是 1.00 + 1.2 = 2.2）。
   *
   * 为什么必须封顶：封顶前实测有 **227 / 4230（5.4%）** 的行金数项 > 1
   * （末日幻影一家 171/640 = 26.7%，最高 ×7.00）—— 分母取的是「该版本 **perfect 档**
   * 最便宜」而分子是这一条配置自己的金数（档位不限），target 档更便宜时就跨档相除了；
   * 界面上那行脚注写着「越接近 ×1 越强」，与 `7÷1` 直接矛盾。详见 docs v28 / v29。
   *
   * 为什么 0 金要单独给一个固定倍率：分母为 0 会算出 Infinity，而 0 金队本身是**极端**
   * （一分钱都不用抽），给一个略高于封顶的固定倍率正是用户要的。
   * ⚠️ 0 金**不进分母**（见 `minCostBySeason` 的注释）：否则「该版本最便宜 = 0」会把
   * 同版本**所有**队伍的金数项一起打成 0。
   */
  frontierCostCap: 1,
  frontierZeroGoldBonus: 1.2,
  /**
   * 抽卡方案（`budgetPlan`）最多列多少个单位。
   *
   * 方案是**按性价比排序的补强清单**：每个单位各占一条，成本累计到预算为止。
   * 旧版按「作业」给方案，而一个副本只有一份收益，于是最多只能排出 4~5 步
   * ——用户看到的「只显示少量角色」就是这条造成的。改成清单之后长度由预算与
   * 单位数决定，这里只做一个上限兜底（避免「不限」时铺出上百行）。
   */
  budgetPlanMaxSteps: 24,
  /**
   * 队伍抽卡方案（`teamPlan`）最多列多少支队伍。
   *
   * 候选池本身**不在这里定**（用户 2026-10-11 第 1 条：由程序自主决定，不能写死）：
   * 它是「性价比**逐档榜**按队伍去重」的结果，随数据与账号自动变
   * （本机实测：账号 1 是 78 → **245** 支，见 `teamPoolUnits` 的注释）。
   * 这里只是**下发上限**，防止载荷被铺开；实测全量也只 ~35 KB。
   * ⚠️ 用户 2026-10-11 第 5 条：「仅显示前 15 的补金建议」⇒ 40 改成 **15**。
   */
  teamPlanMaxRows: 15,
  /**
   * 队伍抽卡方案「差额接近度」的**封顶分位**（用户 2026-10-11 第八轮给定：p75）。
   *
   * 两次换挡的历史（别改回去，两次都是用户实测后拍的）：
   *   * **max → p50**（第六轮）：用户报「差额接近度拉不开差距」，实测前 10 名的总分跨度
   *     只有 12.2 分。用 max 时上界被「补 48 金的冷门队」撑开，所有人都挤在低分区，
   *     所以压到中位数：补到中位数以上一律 0 分。
   *   * **p50 → p75**（第八轮）：候选池从 78 支放宽到 245 支之后，**中位数自己变小了**
   *     （账号 1：11 金 → 9 金），② 的分辨率随之被压死 —— 同一支补 4 金的队伍 ② 从
   *     63.6 掉到 20.0，中段的强队集体下沉（实测 A 池 #3 → B 池 #10）。p75（14 金）把
   *     上界放回一个「强队也够得着」的位置：强队回到前排，便宜队仍能进 #7 / #10。
   *
   * ⚠️ 这条规则天生是**相对**的：封顶值 = 池内差额的分位数，池子越大中位数越小。
   * 所以「改候选池」必然牵动 ② —— 两者要一起看（`_probe-cap-rules.mjs` 就是为此写的：
   * 它把 B 池 × 七种封顶规则的前 10 名并排打出来）。
   *
   * ⚠️ 分位数的**取样集合**必须是**整个候选池**，不是「要展示的那几条」——
   * 否则「展示条数」会变成分数的隐藏输入（第七轮修的，详见 `teamPlan` 的注释）。
   */
  teamPlanGapCapPct: 0.75,
  /**
   * 「强度得分」**下限的分位**（候选池里纯强度的 p75）—— 用户 2026-10-12 第 7 条追问
   * 「为什么现在有很多队伍的强度得分直接达到接近 100」。
   *
   * 取 0.75 是为了与 ② 的 `teamPlanGapCapPct` **对称**：那一侧是「差额达到池内 p75 就 0 分」，
   * 这一侧是「强度低于池内 p75 就没分」，两边同一个分位、读数时不用记两个数。
   * 实测（账号 1）：下限从池内最小（16.7）抬到 p75（891）之后，前 15 名的强度得分跨度
   * 从 **26 分** 拉到 **71 分**。
   *
   * ⚠️ 这一条**只影响抽卡方案的强度得分**，不动角色总榜（总榜显示的是原始分，没有归一化）。
   * ⚠️ 它**不是**把成本带进强度那一档：池内 `r(纯强度, 账面金数) = 0.24`、头部（≥1300）
   * 是 **−0.65**（越便宜反而越强 —— 金数不进强度，9 金的满分与 24 金的满分拿同一个表现分）。
   * 所以抬下限让「便宜还能满分」的队伍更占优，与用户「已被更能压成本的队伍取代」同向。
   */
  teamPlanStrengthFloorPct: 0.75,
  /**
   * **抽卡权重**（用户 2026-10-12 第 3 条）：`{ strength, cost }` 两个数的**相对大小**，
   * 决定抽卡方案「补金推荐分」里两个分项各占多少。
   *
   * ```
   *   补金推荐分 = 强度得分 × ws + 差额接近度 × wc      （ws + wc 归一化成 1）
   * ```
   *
   * 旋钮手感（用户原话 + 2026-10-12 第 6 条之后实测的口径）：
   *   * **强度** 越高 → 越倾向于推荐**高金、低行动值**的队伍；
   *   * **性价比** 越高 → 越倾向于推荐**你还要补得越少**的队伍
   *     （这一档的刻度就是「差额接近度 = 1 − 补金 ÷ 候选池封顶值」）。
   *
   * ⚠️ 用户 2026-10-12 第 3 条的原话是「性价比权重越高则倾向于推荐**尽量压金通关**的队伍」，
   * 但第 6 条他明确只要「差额接近度」这一个刻度（「三者过于重叠」），而差额接近度量的是
   * **你还要补几金**，不是「这支队总共几金」—— 两者在多数队伍上同向，但对「你已经拥有大半」
   * 的高金队伍会分叉（16 金那支只要补 4 金）。所以这一档现在**不保证**压金：
   * 想让「总共几金」也进公式，就得重新引入第二个金数刻度，而那正是用户否掉的方案。
   *
   * ⚠️ 为让上面那句话成立，**强度得分在 v4.6.87 换了口径**：它是**纯强度**
   * （`frontierPackScale × 表现`，只含档位/行动值与版本加权，**不再乘金数项**）。
   * 旧的 ① 是「队伍在总榜上的分」—— 那个分里乘了 `minCost / 本队金数`，所以它其实
   * 是性价比：实测用户的 16 金那支（行动值 286）只有 81 分，而 9 金那支拿了满分，
   * 「强度拉高 → 更推高金队伍」根本不成立。纯强度见 `packStrengthOf()`。
   *
   * ⚠️ **性价比那一侧只有「差额接近度」一个刻度**（用户 2026-10-12 第 6 条原话：
   * 「性价比得分、差额接近分、压金度，三者是不是过于重叠了，我只想保留差额接近度的得分」）。
   * v4.6.87 曾把它做成「差额接近度 与 压金度 各半」（`teamPlanCostMix`，为了修第 5 条），
   * v4.6.89 按用户要求**删掉压金度**：两者量的都是「这支队贵不贵」（一个量你还要补几金、
   * 一个量它总共几金，实测高度同向），并列成两个分项确实重叠，而用户只需要前者。
   * 所以现在：**性价比得分 == 差额接近度**，界面上不再出现「性价比得分」这个中间量
   * （它是 100% 的同一个数，再写一层只会让人以为还有别的成分）。
   * 「账面金数」仍逐行显示（卡片上「账面 N 金」），只是**不进分数**。
   *
   * 默认 `1 : 1`（等权）—— 与 v4.6.78~v4.6.86 写死的 `0.5 × ① + 0.5 × ②` 同权，
   * 所以不动输入框时名次的手感是连续的，不会因为这次改造突然换榜。
   */
  drawWeight: { strength: 1, cost: 1 },
};

/** 性价比的显示值：内部比值 × 100，四舍五入到整数（总榜与抽卡方案共用）。
 *
 * 两个榜的内部量纲都是「百分点 ÷ 期望抽数」（前沿榜的占比在 `frontierUnits`
 * 里已经换算成百分点），所以这里乘同一个倍数，数字之间可以直接比大小。 */
export const scorePercent = (value) => Math.round((Number(value) || 0) * 100);

/**
 * 权重口径：**两套输入各自独立**（用户 2026-10 要求「性价比总榜和抽卡方案的
 * 权重应相互独立」；那个榜在 2026-10-12 第 1 条已改名为**角色总榜**）。
 *
 *   plan      抽卡方案 / 和主流强阵的差距 / 星魂榜 —— 都看「你的账号」
 *   frontier  角色总榜 —— 纯黑塔网投稿口径（界面上的**关卡权重**那一类）
 *
 * 为什么必须拆开：这两个榜回答的是**不同的问题**（「数据里谁强」vs「我该补谁」），
 * 原来只有一张表，于是在总榜上调完自己的副本倾向，抽卡方案跟着一起变，
 * 反之亦然 —— 用户想「只看绝境的性价比」时，方案也被迫只看绝境。
 *
 * ⚠️ 界面从 2026-10-11 第 10 轮起**只画 `frontier` 这一套**（「去掉方案权重那一行」），
 * 所以 `plan` 这一侧现在只有旧接口调用方还在用。抽卡方案的另一类旋钮
 * （**抽卡权重** 强度/性价比）与这张表无关，见 `SCORING.drawWeight`。
 *
 * 默认值仍然**共用同一张表**（`SCORING.envWeight`），所以不动输入框时两个榜的
 * 默认口径完全一致；界面上的「恢复默认」也回到同一组数。
 */
export const WEIGHT_SCOPES = ['plan', 'frontier'];

/** 权重表的默认值（界面用它填十个输入框，两个口径共用一组默认数）。 */
export const ENV_WEIGHT_ROWS = [
  { mode: 'aa', stage: 'plight', label: '异相仲裁 · 绝境' },
  { mode: 'aa', stage: '', label: '异相仲裁' },
  { mode: 'as', stage: '', label: '末日幻影' },
  { mode: 'moc', stage: '', label: '混沌回忆' },
  { mode: 'pf', stage: '', label: '虚构叙事' },
];

/** 默认权重表（界面「恢复默认」用；`envWeightOf` 在不带覆盖时给出同一组数）。 */
export const envWeightDefaults = () => Object.fromEntries(
  ENV_WEIGHT_ROWS.map((row) => [`${row.mode}|${row.stage}`, envWeightOf(row.mode, row.stage)]),
);

/**
 * **抽卡权重**的两个旋钮（用户 2026-10-12 第 2、3 条）——`SCORING.drawWeight` 是默认值，
 * 界面的输入框按这张表渲染（与 `ENV_WEIGHT_ROWS` 同一套路：旋钮清单只有一份）。
 *
 * ⚠️ 它与**关卡权重**（`ENV_WEIGHT_ROWS`，5 个副本）没有关系，两者合起来才是界面上
 * 那个「权重」区块的两大类：关卡权重决定「哪些副本算数」，抽卡权重决定「抽卡方案里
 * 强度与性价比各占多少」。
 */
export const DRAW_WEIGHT_ROWS = [
  { key: 'strength', label: '强度' },
  { key: 'cost', label: '性价比' },
];

/** 抽卡权重的默认值（界面「恢复默认」用）。 */
export const drawWeightDefaults = () => ({
  strength: finiteOrNull(SCORING.drawWeight?.strength) ?? 1,
  cost: finiteOrNull(SCORING.drawWeight?.cost) ?? 1,
});

/**
 * 归一化抽卡权重：只认**有限非负数**，并把两个数**归一到和为 1**。
 *
 * 为什么归一：这两个数只有**相对大小**有意义（与副本权重同一条约定），所以
 * 「强度 3 / 性价比 1」与「强度 0.75 / 性价比 0.25」必须是同一个榜 —— 归一之后
 * 补金推荐分仍在 0~100 体系里，界面上那句「= 强度得分 × 0.75 + 差额接近度 × 0.25」
 * 才写得下去、也才能像旧版那样把两个系数直接印出来。
 *
 * 边界（都有回归用例）：
 *   * 只给一个键 / 另一个是 `null` → 缺的那个按**默认值**补齐（界面永远两个一起发，
 *     这条兜的是探针与旧调用方）；
 *   * 空串 = 用户清空了输入框 → 按 0 算（与 `weightInputOf` 同一条约定）；
 *   * 非法值（负数 / NaN）→ 忽略，退回默认；
 *   * 两个都是 0 → **退回默认等权**，而不是让整列分数塌成 0。用户把两个框都清空
 *     显然不是「什么都别推荐」——那是「我没有偏好」。
 */
export const normalizeDrawWeights = (input) => {
  const defaults = drawWeightDefaults();
  const pick = (key, fallback) => {
    const raw = input?.[key];
    if (raw === null || raw === undefined) return fallback;
    const raw2 = String(raw).trim();
    const n = raw2 === '' ? 0 : Number(raw2);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  let strength = pick('strength', defaults.strength);
  let cost = pick('cost', defaults.cost);
  if (!(strength + cost > 0)) {
    strength = defaults.strength;
    cost = defaults.cost;
  }
  const sum = strength + cost;
  // `sum > 0` 在默认值本身也是 0 的极端配置下才不成立；那时如实给等权，不出现除零。
  if (!(sum > 0)) return { strength: 0.5, cost: 0.5 };
  return { strength: strength / sum, cost: cost / sum };
};

/**
 * 站点全名 ↔ 短码。`SCORING.envWeight` 按站点全名写（读起来就是「哪个副本」），
 * 但结论里 `env.mode` 是短码（`pf` / `aa`），两种写法都得认。
 *
 * 这里曾经只认全名，于是 5 个副本**全部**退回 `envWeightDefault = 1`——
 * §④ 的权重（异相仲裁抬到 1.5、虚构叙事压到 0.5）一条都没生效，
 * 用户点名过的「虚构叙事把光锥抬得虚高」也就一直压不住。所以下面按别名查。
 */
const MODE_ALIASES = {
  moc: 'Memory of Chaos',
  pf: 'Pure Fiction',
  as: 'Apocalyptic Shadow',
  aa: 'Anomaly Arbitration',
};

/**
 * 用户自定义的副本权重覆盖（用户 2026-10 要求：让用户决定五种副本的权重，
 * 以便按自己的倾向调排序）。**每个口径一份**，互不影响。
 *
 * 由 `buildConclusion(envs, { weights, frontierWeights })` 写入、`envWeightOf`
 * 按 scope 读取。为什么用一个模块级变量而不是层层传参：`envWeightOf` 被评分
 * 路径上的很多地方调用（单位归因、差距打分、前沿强度），把 weights 一路透传会
 * 污染每一个签名。覆盖只在一次 `buildConclusion` 调用期间有效，调用方负责恢复
 * （见 `setEnvWeights`）。
 *
 * 键用 `${全名或短码}|${stage}`，与 `SCORING.envWeight` 同一形状，
 * 值必须是有限**非负数**（0 = 不把这个副本算进来），非法值直接忽略、不改变默认。
 */
const envWeightOverrides = { plan: null, frontier: null };

/** 口径名归一：认不出来的一律当 plan（旧的调用点都没传 scope）。 */
const weightScopeOf = (scope) => (WEIGHT_SCOPES.includes(scope) ? scope : 'plan');

/**
 * 归一化界面上的副本权重输入。
 *
 * 用户把输入框清空时，浏览器给出的值是空串。以前界面直接跳过空串，
 * 于是这个副本悄悄退回默认权重；这和用户把它关掉（输入 0）的意图相反。
 * 空白现在明确表示 0，非法的非空值仍然忽略并交给调用方保留原来的默认口径。
 */
export const weightInputOf = (value) => {
  // null / undefined 表示调用方没有给这个键，不是用户清空了输入框；继续忽略它们，
  // 免得缺失字段被误当成「关闭副本」。浏览器输入框给出的空值才是空字符串。
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * 设置某个口径的覆盖表（传 null / 空对象 = 恢复默认）。返回该口径的上一份，
 * 便于调用方还原。
 */
export const setEnvWeights = (weights, scope = 'plan') => {
  const key = weightScopeOf(scope);
  const prev = envWeightOverrides[key];
  if (!weights || typeof weights !== 'object') { envWeightOverrides[key] = null; return prev; }
  const clean = {};
  for (const [k, v] of Object.entries(weights)) {
    // 直接调用方沿用原来的 Number 归一化（其中空串本身就是 0）；界面输入则在
    // `readWeights()` 里先经过 `weightInputOf()`，这样「清空」的意图写得更明确。
    const n = Number(v);
    // 允许 0（把这个副本从排序里去掉），但不接受负数 / NaN。
    if (Number.isFinite(n) && n >= 0) clean[k] = n;
  }
  envWeightOverrides[key] = Object.keys(clean).length ? clean : null;
  return prev;
};

/**
 * 副本权重：短码与站点全名都认，都查不到才退回默认值；用户覆盖优先。
 *
 * `scope` 决定读哪一套覆盖（见 `WEIGHT_SCOPES`）：总榜那条链上必须显式传
 * `'frontier'`，其余一律用默认的 `'plan'`。
 *
 * 覆盖里允许 0（用户把某个副本拖到 0 = 这个副本不参与排序），所以判据是 `>= 0`
 * 而不是 `> 0` —— 否则「把虚构叙事调成 0」会被静默退回默认值 0.5。
 */
export const envWeightOf = (mode, stage = '', scope = 'plan') => {
  const raw = String(mode || '');
  const full = MODE_ALIASES[raw] || raw;
  const override = envWeightOverrides[weightScopeOf(scope)];
  if (override) {
    const hit = override[`${full}|${stage}`]
      ?? override[`${raw}|${stage}`];
    if (Number.isFinite(hit) && hit >= 0) return hit;
  }
  return SCORING.envWeight[`${full}|${stage}`]
    ?? SCORING.envWeight[`${raw}|${stage}`]
    ?? SCORING.envWeightDefault;
};

/**
 * 某个副本的**判据线权重**（`{ perfect, target, pass }`）—— 表现曲线的三个锚点取值。
 *
 * 与 `envWeightOf` 同一套路：默认取 `SCORING.frontierPerfPerfectLine` 那三个常量，
 * 副本在 `SCORING.frontierPerfLineByEnv` 里有单独一套时用它（当前只有绝境王棋关：
 * 满分线以内固定 1.00、达标线 0.60，见那张表的注释）。**短码与站点全名都认**
 * （结论里 `env.mode` 是 `aa` 这种短码，`SCORING` 里按全名写）。
 *
 * 为什么要一个函数而不是各处直接读常量：算分（`buildConclusionInner`）、服务端
 * 观测集（`archive.js` 的 `observedPackScores`）、界面拆因子（`frontierFactorsOf`）、
 * 界面脚注（`advice-view.js` 的 `perfCurveText`）四处都要用**同一份**权重 ——
 * 抄一份到别处就会分叉，而分叉的症状是「榜上的分与浮层里的算式对不上」。
 *
 * 入参可以是：`{ id }` / `{ mode, stage }` 形状的副本或元数据对象、`'aa|plight'` /
 * `'aa/plight'` 这样的键、或 `null`（= 用默认那份）。
 */
export const perfLineWeightsOf = (env) => {
  const base = {
    perfect: Number(SCORING.frontierPerfPerfectLine),
    target: Number(SCORING.frontierPerfTargetLine),
    pass: Number(SCORING.frontierPerfPassLine),
  };
  const table = SCORING.frontierPerfLineByEnv || {};
  const raw = String((typeof env === 'string' ? env : (env?.id ?? env?.mode)) || '');
  if (!raw) return base;
  // `id` 已经带了关卡（`aa|plight` / `aa/plight`）；只给 `mode` 时补 `env.stage`。
  const [mode, idStage] = /[|/]/.test(raw) ? raw.split(/[|/]/) : [raw, String(env?.stage || '')];
  const candidates = [`${MODE_ALIASES[mode] || mode}|${idStage}`];
  if (candidates[0] !== `${mode}|${idStage}`) candidates.push(`${mode}|${idStage}`);
  for (const key of candidates) {
    const hit = table[key];
    if (!hit) continue;
    for (const [k, v] of Object.entries(hit)) {
      if (k in base && Number.isFinite(Number(v))) base[k] = Number(v);
    }
    break;
  }
  return base;
};

/**
 * 取一个判据线权重：**调用方给的覆盖 → `SCORING` 的默认值 → 硬兜底**。
 * 三级都要过 `Number.isFinite`，否则 `undefined` 会被 `Number()` 变成 `NaN` 混进锚点表。
 */
const lineWeightOf = (weights, key, fallback, hardDefault) => {
  for (const value of [weights?.[key], fallback]) {
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return hardDefault;
};

/**
 * **版本权重表**（用户 2026-10 第 7 条的原话 + 2026-10-12 第 5 条的收窗）：
 *
 *   「近 1-3 版本等权重，近 4-7 版本等权重，权重比例为 2:2:2:1:1:1:1，
 *     黑塔网投稿的版本更新后仍然能确保程序更新权重」
 *
 * ⚠️ **2026-10-12 第 5 条把这扇窗从 7 个版本收到 3 个**：原话是「把角色总榜的版本
 * 窗口收到 3 版」。原因是实测出来的 —— 用户点名那支（遐蝶E2S1/风堇E2/昔涟E2S1/长夜月E2）
 * 的分数有 **32.1% 来自权重 1 的那四个旧版本**（它的最佳证据甚至停在 4.1），
 * 而它那四个人一起上场在 **4.6 根本没有投稿**（最新满分证据是 4.5）；收窗之后它的纯强度
 * 1390.8 → 1378.5、总分 85.7 → 85.1，直接让出第 1。
 * 「近 4-7 版本各 1 分」那一档因此从表里消失（`VERSION_WEIGHTS` 变回三档等权 2:2:2）。
 *
 * 台阶：最新 3 个版本各 2 分，**第 4 个版本起 0 分**（0 = 不进窗口，不是「权重很小」）。
 * 窗口因此就是 3 个版本（`VERSION_WINDOW`）。
 *
 * ⚠️ **按下标查表，不按版本号写死**：黑塔网每加一个新版本，整套权重必须整体前移
 * 一档 —— 用户第 7 条后半句要的就是这件事自动发生。下标 = 「距该副本最新版本几个
 * 版本」，由数据现算，所以 4.7 上线之后 4.6 / 4.5 / 4.4 自动进入窗口。
 *
 * 历史：这里以前是 `2 ** (-idx / 3)` 的指数半衰期（连续衰减、永不归零，由
 * `options.halfLife` 调）。用户给了明确的三档台阶之后它就不再是调参旋钮了，
 * 留着只会让代码里的「2:2:2」对不上，所以换成查表。
 *
 * 放在这个文件（而不是 `src/server/archive.js`）：本文件是浏览器与服务端**共用**
 * 的那一份，总榜在客户端按版本加权时读的就是这张表，服务端只是 import 它。
 */
export const VERSION_WEIGHTS = [2, 2, 2];

/** 版本窗口 = 权重表的长度（3 个版本）。 */
export const VERSION_WINDOW = VERSION_WEIGHTS.length;

/** 距最新版本第 `index` 个（0 = 最新）的版本权重；超出表长给 0（不进窗口）。 */
export const versionWeightOf = (index) => VERSION_WEIGHTS[index] ?? 0;

/** 把 tierLines 换算成行动值空间的三条线。 */
export const avLinesOf = (tierLines, lowerIsBetter = true) => {
  const conv = (v) => (Number.isFinite(v) ? (lowerIsBetter ? v : 4000 - v) : undefined);
  return {
    perfect: conv(tierLines?.perfect),
    target: conv(tierLines?.target),
    pass: conv(tierLines?.pass),
  };
};

/** 档内行动值分 ∈ [0,1]：贴着该档判据线 = 1，远离 = 0。 */
export const avTermOf = (avgAv, tier, avLines) => {
  if (!Number.isFinite(avgAv)) return 0;
  const line = avLines?.[tier];
  if (!Number.isFinite(line)) return 0;         // 这一档没有判据线（绝境的及格档）
  // 满分线就是 0 行动值时（轮次制、末日幻影 4000 分），除法会炸，
  // 退化成「是否达到 0」加一个单调衰减。
  if (line <= 0) return avgAv <= 0 ? 1 : 1 / (1 + avgAv);
  return Math.max(0, Math.min(1, 1 - avgAv / line));
};

/** 综合分 = 档位分 + 档内行动值分（跨模式可比、可相加）。 */
export const scoreOf = (tier, avgAv, avLines, avWeight = AV_WEIGHT) =>
  tierScoreOf(tier) + avWeight * avTermOf(avgAv, tier, avLines);

/**
 * 表现曲线的**锚点表**：`[av, 因子]` 数组，按 av 升序，全程严格递减。
 *
 * 用户 2026-10-11 第二轮：「要有更精细的表现权重变化梯度」。上一版 `av ≤ 满分线`
 * 整段是平的 1.00，绝境里 37 和 299 同分 —— 档内零区分度。这里改成以 `av = 0`
 * 为顶点，依次穿过三条判据线，每两个锚点之间线性插值：
 *
 *   0 → 1.00 → 满分线 → 达标线 → 及格线 →（继续线性衰减到地板）
 *
 * 边界处理：
 *   * **满分线 = 0**（轮次制 `0T`、末日幻影积分 4000、异相仲裁骑士关）：此时
 *     「满分线」与「顶点」重合，跳过它（否则会出现两个 av=0 的锚点，曲线不自洽）。
 *   * **没有及格线**（绝境只有两档）：以「达标线 − 满分线」为跨度继续衰减。
 *   * **线不全 / 乱序**（老数据集、夹具）：退回单锚点 `[0, 1]` + 阶梯兜底。
 *   * **满分线的取值等于 1.00**（绝境自 v4.6.78 起）：顶点到满分线那一段因此是**平的**
 *     —— 这是用户明确要的形状（「行动值小于 300，权重固定为 1.00」），不是漏了梯度。
 *     所以曲线只保证**单调不增**，不再承诺全程严格递减。
 *
 * `weights` 是**按副本**的判据线取值（`perfLineWeightsOf(env)`）：不传就用 `SCORING`
 * 里的三个默认常量。传了就必须由调用方保证与算分同源，否则浮层算式会对不上榜面。
 *
 * 返回的锚点里第一条永远是 `[0, 1]`（理论最好成绩 = 1.00），所以曲线**上界恒为 1.00**
 * —— `frontierPackScale = 100` 的量纲不变。
 */
export const perfAnchorsOf = (tierLines, lowerIsBetter = true, weights = null) => {
  const lines = avLinesOf(tierLines, lowerIsBetter);
  const p = lines.perfect;
  const t = lines.target;
  const s = lines.pass;
  const wPerfect = lineWeightOf(weights, 'perfect', SCORING.frontierPerfPerfectLine, 0.85);
  const wTarget = lineWeightOf(weights, 'target', SCORING.frontierPerfTargetLine, 0.5);
  const wPass = lineWeightOf(weights, 'pass', SCORING.frontierPerfPassLine, 0.25);
  // 线不全 / 达标线不比满分线差 → 只有顶点（调用方会退回阶梯兜底）。
  if (!Number.isFinite(p) || !Number.isFinite(t) || !(t > p)) return [[0, 1]];
  const anchors = [[0, 1]];
  // 满分线：只有它**严格大于 0** 时才是一个独立锚点（=0 时与顶点重合）。
  if (p > 0) anchors.push([p, wPerfect]);
  anchors.push([t, wTarget]);
  if (Number.isFinite(s) && s > t) anchors.push([s, wPass]);
  return anchors;
};

/**
 * **表现分**（用户 2026-10-11 缺陷 3 修，第二轮加梯度）：把「档位」与「行动值」
 * 合并成**一条连续曲线**。
 *
 * 为什么必须合并：**档位本身就是由行动值推出来的**（`tierOf` 拿成绩与判据线比较），
 * 所以 `档位权重 × 行动值项` 是**同一个维度被乘了两次**。实测后果有两个：
 *
 *   ① 两因子高度相关，乘积相当于把差距**平方**：异相仲裁里 perfect 档的 actionValue
 *      全是 0、target 档全是 1~2，`档位 × 行动值` 在两条几乎不重叠的窄区间上各取一段，
 *      于是「0T 与 2T 的差别」被算了两次。
 *   ② **跨判据线时出现阶梯跳变**：实测绝境在满分线（行动值 300）两侧，因子从 0.876
 *      跳到 0.437（2.00×），而成绩只差几个行动值 —— 阶梯跳变正是「同一维度计两次」
 *      的直接症状（跳变幅度恰好 = 档位权重之比 1 ÷ 0.5）。
 *
 * 合并方式：**以游戏内判据线为标尺**，做一条**单调不增**的分段线性曲线
 * （判据线经 `avLinesOf` 换算到「行动值」方向，末日幻影的积分线会自动翻转）。
 * 锚点表见 `perfAnchorsOf()`：`0 → 1.00 → 满分线 → 达标线 → 及格线 → 地板`。
 * 判据线以内是否真的有梯度由**该副本的判据线取值**决定：默认（0.85）有梯度，
 * 绝境自 v4.6.78 起满分线以内固定 1.00（用户点名：行动值 <300 固定 1.00、
 * 300~500 由 1.00 渐变到 0.60）—— 见 `SCORING.frontierPerfLineByEnv`。
 *
 * 三条性质保证它**不改变既有语义**：
 *   ① **达标线处默认仍是 0.50**（与旧的 `frontierTierWeight` 完全一致）—— 「跨过达标线」
 *      这个游戏内最有意义的分界没被动过；只有被单独覆盖的副本（绝境 0.60）例外。
 *   ② **单调不增且上界仍是 1.00** → `frontierPackScale = 100` 的量纲不变。
 *   ③ **每个副本用自己的判据线** → 跨副本可比（轮次 / 积分 / 行动值各自归一），
 *      也不再依赖「该副本前沿池的 5%~95% 分位」这个**样本相关**的尺子
 *      （旧口径下混沌回忆人人 0T → 分位区间退化 → 行动值项恒为 1，完全失去区分力）。
 *
 * 判据线取不到（老数据集 / 夹具没给 `tierLines`）或行动值缺失时，退回旧的**阶梯权重**
 * （`SCORING.frontierTierWeight`）—— 粗粒度兜底，至少不会把成绩算成 0。
 *
 * @param {number|null} avgAv 该配置的成绩（已在数据集里统一为「行动值」方向：越小越好）
 * @param {{perfect?:number, target?:number, pass?:number}|null} tierLines 游戏内判据线
 * @param {boolean} lowerIsBetter 方向（末日幻影为 false，`avLinesOf` 会翻转）
 * @param {string|null} tier 内部档位键（仅用于兜底）
 * @param {{perfect?:number, target?:number, pass?:number}|null} weights 该副本的判据线
 *   取值覆盖（`perfLineWeightsOf(env)`）；不传 = 用 `SCORING` 的默认三个常量
 */
export const perfFactorOf = (avgAv, tierLines, lowerIsBetter = true, tier = null, weights = null) => {
  const av = Number(avgAv);
  const floor = Number(SCORING.frontierPerfFloor) || 0;
  const fallback = Math.max(floor, Number(SCORING.frontierTierWeight[tier]) || 0);
  // 行动值缺失 → 退回阶梯权重（粗粒度但不会算成 0）。
  if (!Number.isFinite(av)) return fallback;
  const anchors = perfAnchorsOf(tierLines, lowerIsBetter, weights);
  // 线不全（只有顶点）→ 同样退回阶梯兜底，不要拿一条假曲线算。
  if (anchors.length < 2) return fallback;
  // 顶点以内（理论最好成绩）：封顶 1.00。
  if (av <= anchors[0][0]) return anchors[0][1];
  // 逐段线性插值（锚点按 av 升序，单调不增；相邻两点同值时该段就是平的）。
  for (let i = 1; i < anchors.length; i += 1) {
    const [x0, y0] = anchors[i - 1];
    const [x1, y1] = anchors[i];
    if (av <= x1) {
      if (!(x1 > x0)) return y1;
      return y0 + (y1 - y0) * (av - x0) / (x1 - x0);
    }
  }
  // 最后一个锚点之外：按「最后一段的斜率」继续衰减到地板。
  // ⚠️ 斜率是 `(yn - yp) / (xn - xp)`，而曲线递减 → `yn < yp`，所以外推要写成
  // `yn - 斜率 × (av - xn)` 展开后的 `yn + (yn - yp) × …`（两个负号相消）。
  // 曾写成 `yn - (yn - yp) × …`，结果线外**反向上升**（实测 av=800 → 1.025）。
  const [xn, yn] = anchors[anchors.length - 1];
  const [xp, yp] = anchors[anchors.length - 2];
  const span = xn - xp;
  if (!(span > 0)) return Math.max(floor, yn);
  return Math.max(floor, yn + (yn - yp) * (av - xn) / span);
};

/**
 * 这套阵容**多数投稿**落在哪一档（并列时取更好的那档）。
 *
 * 用「多数」而不是「最好」：一条运气局的满分不能代表这套作业的稳定水平，
 * 而少数派的分数又会低估它。档位是用户自己给的判据，比任何自定义评分都硬。
 */
export const majorityTierOf = (tierCounts) => {
  if (!tierCounts) return null;
  const order = ['perfect', 'target', 'pass', 'below'];
  let best = null;
  let bestN = 0;
  for (const key of order) {
    const n = Number(tierCounts[key]) || 0;
    // 顺序是「好→差」，用严格大于，所以并列时保留更靠前（更好）的那档。
    if (n > bestN) { bestN = n; best = key; }
  }
  return bestN > 0 ? best : null;
};

/** 权重取值：0 是有效值（这个副本不参与排序），只有缺失/非法才退回 1。
 *
 * 为什么要专门一个 helper：`Number(x) || 1` 会把合法的 0 悄悄变成 1，
 * 于是「把虚构叙事调成 0」看起来生效了（输入框留着 0），算出来却还是按 0.5 排。
 * 实测踩过一次：总榜的 `weight` 字段就是被这个写法吃掉的。 */
const weightOr = (value, fallback = 1) => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** 一个「缺口单位」在结论里的唯一键。 */
export const unitKeyOf = (item) => {
  if (!item) return null;
  if (item.kind === 'cone') return `cone:${item.name}`;
  if (item.kind === 'eidolon') return `eido:${item.name}`;
  return `char:${item.name}`;
};

/**
 * 一套作业对「我」的边际造价。
 *
 * `members` 来自数据集里这套阵容**成绩最好那条投稿**的实际配装
 * （char / eidolon / lc / superimp），所以算出来的是「照抄这套作业要花几发」，
 * 不是「这套阵容平均花了多少」。
 *
 * account = { owned:Set<角色英文键>, eidolons:Map<角色,星魂>, cones:Map<光锥,叠影> }
 *
 * 口径与 herta-build.mjs 的成本模型一致：限定角色本体 1 金 + 星魂每级 1 金，
 * 限定光锥本体 1 金 + 叠影每级 1 金；4★ 与常驻 5★ 不计（抽限定时会顺带满命）。
 */
export const marginalCostOf = (members, availability, account = {}) => {
  const owned = account.owned instanceof Set ? account.owned : new Set();
  const eidolons = account.eidolons instanceof Map ? account.eidolons : new Map();
  const cones = account.cones instanceof Map ? account.cones : new Map();
  const items = [];
  let pulls = 0;
  for (const m of members || []) {
    // 成本口径见 charCostOf / coneCostOf：4★、常驻 5★、开拓者都免费。
    const charFree = charCostOf(m.char, availability) === 0;
    const charInfo = availability?.characters?.[m.char];
    const charKnown = Boolean(charInfo);
    // 星级/限定标记缺失时按「要抽」算——宁可高估，也不给「免费」的假象
    // （与 pullCostOf 同一政策）。
    const charLimited = !charFree;
    if (charLimited) {
      // mine = -1 表示还没有这个角色：本体也要 1 抽，所以 need = 星魂数 + 1。
      const rawMine = owned.has(m.char) ? (eidolons.get(m.char) ?? 0) : -1;
      // 账号快照可能仍记录 E3~E5，但推荐口径只有 E0/E1/E2/E6；
      // 账号已有 E5、阵容要求 E6 时应显示 E2 → E6，并按 4 金计算。
      const mine = rawMine < 0 ? -1 : eidolonTierOf(rawMine);
      const target = eidolonTierOf(m.eidolon);
      const need = Math.max(0, target - mine);
      if (need > 0) {
        pulls += need;
        items.push({
          kind: mine < 0 ? 'char' : 'eidolon',
          name: m.char,
          pulls: need,
          from: Math.max(0, mine),
          target,
          certainty: Boolean(charKnown),
        });
      }
    }
    if (m.lc) {
      const coneFree = coneCostOf(m.lc, availability) === 0;
      const coneInfo = availability?.lightCones?.[m.lc];
      const coneKnown = Boolean(coneInfo);
      const coneLimited = !coneFree;
      if (coneLimited) {
        const have = cones.get(m.lc) ?? 0;
        const target = Math.max(1, Math.round(Number(m.superimp) || 1));
        const need = Math.max(0, target - have);
        if (need > 0) {
          pulls += need;
          items.push({
            kind: 'cone',
            name: m.lc,
            pulls: need,
            from: have,
            target,
            carrier: m.char,
            certainty: Boolean(coneKnown && cones.has(m.lc)),
            // 米游社只看得到当前装备的光锥，没看到不等于没有。
            uncertain: !cones.has(m.lc),
          });
        }
      }
    }
  }
  return { pulls, items };
};

/**
 * 「击败比例」：你的成绩在该期投稿分布里的位置（0~1，越大越好）。
 *
 * 为什么不直接用「跨了几档」当分数：低难副本里人人满分（实测混沌回忆的中位数就是
 * 0 回合），跨档分会把「从 ≤2T 到 0T」和「绝境从 500 行动值到 300 以内」记成同一个
 * 分值，难度差异被抹平——用户的原话是「3 深渊难度太低、水分太多，异相仲裁没被体现」。
 * 用人群分布当尺子，两边的真实差距会自己显出来。
 *
 * 分位数只有 7 个点（p05/p10/p25/p50/p75/p90/p95），所以分辨率是 1/7 ≈ 14%，
 * 单调、够用，且不会因为极端离群值抖。
 */
export const percentileOf = (value, dist, lowerIsBetter = true) => {
  const v = Number(value);
  if (!dist?.values?.length || !Number.isFinite(v)) return null;
  const values = dist.values.map((p) => Number(p)).filter((p) => Number.isFinite(p));
  if (values.length < 3) return null;
  // values 是从「最好」到「最差」排的（分位数沿好→差方向取），所以：
  // 比你这个值更差的分位点有多少个，就说明你击败了大概多少人。
  const worse = values.filter((p) => (lowerIsBetter ? p > v : p < v)).length;
  return Math.max(0, Math.min(1, (worse / values.length)));
};

/**
 * 评分只承认游戏里真正有决策意义的星魂档位。
 *
 * 投稿里仍可能出现 E3~E5，但这些档位在抽卡建议中不单独开行：它们归入
 * E2 桶，最终只比较 E0 / E1 / E2 / E6 四个目标档。这样 E2 -> E6 的成本
 * 会按 4 金计算，而不是把 E6 错当成只补 1 金。
 */
export const EIDOLON_TIERS = Object.freeze([0, 1, 2, 6]);

export const eidolonTierOf = (level) => {
  const n = Math.max(0, Math.min(6, Math.round(Number(level) || 0)));
  let tier = 0;
  for (const candidate of EIDOLON_TIERS) {
    if (candidate > n) break;
    tier = candidate;
  }
  return tier;
};

export const eidolonGoldOf = (from, target) => Math.max(0,
  eidolonTierOf(target) - eidolonTierOf(from));

/**
 * 绝境前沿的队伍质量：每个已聚合阵容只算一次，不使用投稿条数。
 *
 * 绝境同时看「压金」和「行动值」：两项都越低越好。用同一批唯一阵容的
 * 5%~95% 区间归一化，避免一个极端值把另一项压扁；若行动值缺失，则只用
 * 成本。返回值只用于排序和选前沿，不是面向用户的绝对分数。
 *
 * ⚠️ **已弃用（2026-10-11，缺陷 6 审计）**：生产链路（`src/` 与 `public/` 的其余部分）
 * **零引用** —— 只在 `tools/herta-test.mjs` 里被调用。它是 v8/v9「成本/行动值帕累托」
 * 那一代的口径。文档 v14 起服务端改成「按合并后的成本分布取最便宜 25%」，
 * **v4.6.78 起又改成「池 = 全部达标成绩」**（那一步截断连同估算机器一起删了），
 * 这条路径就没接回生产。保留导出只为不破坏公开 API 与既有测试；**不要再往这里加口径**。
 */
export const frontierTeamScore = (rows, options = {}) => {
  const list = Array.isArray(rows) ? rows : [];
  const finite = (key) => list
    .filter((r) => r?.[key] !== null && r?.[key] !== undefined && r?.[key] !== '')
    .map((r) => Number(r[key]))
    .filter((n) => Number.isFinite(n));
  const quantile = (values, p) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const at = (sorted.length - 1) * p;
    const lo = Math.floor(at); const hi = Math.ceil(at);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
  };
  const boundsOf = (values) => values.length
    ? [quantile(values, 0.05), quantile(values, 0.95)] : null;
  const inverse = (value, bounds) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || !bounds) return null;
    const [lo, hi] = bounds;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo + 1e-9) return 1;
    return clamp01((hi - n) / (hi - lo));
  };
  const costs = finite('teamCost');
  const actions = finite('actionValue');
  const costBounds = boundsOf(costs);
  const actionBounds = boundsOf(actions);
  const costWeight = Number.isFinite(Number(options.costWeight))
    ? Math.max(0, Number(options.costWeight)) : SCORING.frontierCostWeight;
  const actionWeight = Number.isFinite(Number(options.actionWeight))
    ? Math.max(0, Number(options.actionWeight)) : SCORING.frontierActionWeight;
  const actionAvailable = actions.length >= 2 && actionWeight > 0;
  return list.map((row) => {
    const costScore = inverse(row.teamCost, costBounds) ?? 0;
    const measuredAction = actionAvailable ? inverse(row.actionValue, actionBounds) : null;
    const rowActionWeight = measuredAction === null ? 0 : actionWeight;
    const totalWeight = costWeight + rowActionWeight;
    const actionScore = measuredAction ?? 0;
    const score = totalWeight > 0
      ? (costScore * costWeight + actionScore * rowActionWeight) / totalWeight
      : 0;
    return { row, score: Number(score.toFixed(6)), costScore, actionScore };
  });
};

/**
 * 成本/行动值帕累托前沿。
 *
 * 一条配置只有在不存在另一条配置同时满足「不更贵」和「不耗更多行动值」
 * 且至少一项更好时才会被淘汰。双方行动值都缺失时只在成本维度比较；一方缺失时
 * 不做支配判定，未知行动值不会被假装成 0 或最差值。这样一个只有少量投稿、但成本或行动值更好的配置
 * 可以进入前沿；每条去重配置随后只计一次，投稿数不参与权重。
 *
 * ⚠️ **已弃用（2026-10-11，缺陷 6 审计）**：生产链路零引用，只在 `tools/herta-test.mjs`
 * 被调用（见 `frontierTeamScore` 的注释）。服务端现在的「前沿」是**按成本截断**
 * （`archive.js` 的 `frontierPct`），不是帕累托支配判定。保留导出只为不破坏公开 API。
 */
export const paretoFrontier = (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  const finite = (value) => value === null || value === undefined || value === ''
    ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const dominates = (a, b) => {
    const aCost = finite(a?.teamCost);
    const bCost = finite(b?.teamCost);
    if (aCost === null || bCost === null || aCost > bCost + 1e-9) return false;
    const aAction = finite(a?.actionValue);
    const bAction = finite(b?.actionValue);
    // 只有双方行动值都缺失时才只比较成本；一方缺失就无法可靠比较。
    if ((aAction === null) !== (bAction === null)) return false;
    if (aAction !== null && bAction !== null && aAction > bAction + 1e-9) return false;
    const costStrict = aCost < bCost - 1e-9;
    const actionStrict = bAction === null
      ? false
      : (aAction !== null && aAction < bAction - 1e-9);
    return costStrict || actionStrict;
  };
  return list.filter((row, index) => !list.some((candidate, candidateIndex) => (
    candidateIndex !== index && dominates(candidate, row)
  )));
};

/**
 * 为所有唯一配置计算帕累托层级。第一层是不被支配的配置；每增加一层，
 * 权重减半。这样全局极值仍最重要，但被支配的高档队伍不会被硬截断。
 *
 * ⚠️ **已弃用（2026-10-11，缺陷 6 审计）**：生产链路零引用，只在 `tools/herta-test.mjs`
 * 被调用（见 `frontierTeamScore` 的注释）。文档 v9/v14 描述的「帕累托分层加权」
 * **从未在生产链路生效** —— 读文档时不要把这一节当成现行规格。
 */
export const paretoLayers = (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  const finite = (value) => value === null || value === undefined || value === ''
    ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const ranks = list.map(() => 0);
  const known = [];
  const unknown = [];
  list.forEach((row, index) => (finite(row?.actionValue) === null ? unknown : known).push(index));
  const assign = (indices, hasAction) => {
    indices.sort((a, b) => (finite(list[a]?.teamCost) ?? Infinity)
      - (finite(list[b]?.teamCost) ?? Infinity)
      || (hasAction
        ? (finite(list[a]?.actionValue) ?? Infinity) - (finite(list[b]?.actionValue) ?? Infinity)
        : 0));
    for (let i = 0; i < indices.length; i++) {
      const currentIndex = indices[i];
      const current = list[currentIndex];
      const currentCost = finite(current?.teamCost);
      const currentAction = finite(current?.actionValue);
      let rank = 0;
      for (let j = 0; j < i; j++) {
        const otherIndex = indices[j];
        const other = list[otherIndex];
        const otherCost = finite(other?.teamCost);
        const otherAction = finite(other?.actionValue);
        if (currentCost === null || otherCost === null
          || otherCost > currentCost + 1e-9) continue;
        if (hasAction && (otherAction === null || currentAction === null
          || otherAction > currentAction + 1e-9)) continue;
        const strict = otherCost < currentCost - 1e-9
          || (hasAction && otherAction < currentAction - 1e-9);
        if (strict) rank = Math.max(rank, ranks[otherIndex] + 1);
      }
      ranks[currentIndex] = rank;
    }
  };
  assign(known, true);
  assign(unknown, false);
  return list.map((row, index) => ({
    row,
    rank: ranks[index],
    weight: 1 / (ranks[index] + 1),
  }));
};

/** 跨副本聚合时统一量纲：没有分布时把旧的档位分（0~2）放大到同一把尺子（0~100）。 */
export const GAIN_SCALE_WITHOUT_DIST = 50;

/**
 * 单位提升的**满分**（那把 0~100 的尺子）。
 *
 * 星魂的分子 = 「它自己这一档量出来的边际收益（0~1）」× 这个满分，
 * 这样它和角色 / 光锥的强度分（0~100）才在同一个量纲上，能直接比。
 */
export const UNIT_GAIN_SCALE = 100;

/**
 * 星魂「期望档位提升」（每副本 0~1 分）的换算系数。
 *
 * `gradeGain` 给的是 0~1 的档位提升比例（跨满一整档记 1），乘上 `UNIT_GAIN_SCALE`
 * 就落在与角色 / 光锥相同的 0~100 那把尺子上，所以这里**不再额外放大**。
 *
 * 早先这里写过 50（沿用上一个口径「达标率」的单位），而那个口径的值域是 0~1 的
 * 比例、`eidoPerf` 那一路的 `marginal` 才需要放大——两个口径叠在一起把星魂的分子
 * 放大了 ~50 倍，实测星魂条目一度占到 +8983、把角色本体（+205）整个挤出榜面。
 * 换口径时**必须重新校准**这个系数。
 */
export const EIDOLON_STEP_SCALE = 1;

/**
 * 活动跃迁的**期望抽数**（用户给的实测口径）：
 * 限定角色 94 抽（本体与每级星魂同一卡池、期望相同），活动跃迁光锥 67 抽。
 * 成本口径仍是「金」，但排序与性价比按**期望抽数**加权——补一把光锥比补一个角色便宜，
 * 不按价格加权会把两者当成同价比较。
 */
export const PULLS_PER = { char: 94, cone: 67 };

/**
 * 一套阵容的期望抽数。
 *
 * `members` 是数据集里那套作业的配装明细（`{char, eidolon, lc, superimp}`），
 * 星魂先归一到 E0 / E1 / E2 / E6，再按同一套口径拆两类：限定角色
 * （本体 + 星魂目标档位）× 94，
 * 活动跃迁光锥（本体 + 叠影每级）× 67；4★ / 常驻 / 开拓者 / 星芒商店光锥都是 0。
 */
export const teamPullsOf = (members, availability) => {
  let pulls = 0;
  for (const m of members || []) {
    if (charCostOf(m.char, availability) > 0) {
      pulls += (1 + eidolonTierOf(m.eidolon)) * PULLS_PER.char;
    }
    if (m.lc && coneCostOf(m.lc, availability) > 0) {
      pulls += Math.max(1, Math.round(Number(m.superimp) || 1)) * PULLS_PER.cone;
    }
  }
  return pulls;
};

/**
 * 某个单位的期望抽数（界面显示「≈ N 抽」用）。
 */
export const unitPullsOf = (kind, count, availability = null) => {
  const n = Math.max(1, Math.round(Number(count) || 1));
  return n * (kind === 'cone' ? PULLS_PER.cone : PULLS_PER.char);
};

/**
 * 一个缺口单位的期望抽数 →「几金」。
 *
 * ⚠️ **不要拿 `item.pulls` 当金数**。那个字段是 `marginalCostOf` 内部的临时数：
 *   * `char`    → 它记的是 `need`，而 `need` 在「本体也要抽」时是 `星魂数 + 1`
 *   * `eidolon` → 只有要补的星魂级数
 *   * `cone`    → 只有要补的叠影级数（本体那 1 金没在里面）
 * 所以爻光**本体**（3 金 = 本体 + E0→E2 两级）会被显示成 **1 金** ——
 * 用户实测发现的正是这个（「需要 282 抽怎么算错成 1 个金」）。
 *
 * 金数与期望抽数必须同源：`unitPullsOf(kind, 金数) = 抽数`，所以从抽数反推金数，
 * 两处永远一致（换口径时也不会再分叉）。
 */
export const goldOfPulls = (kind, pulls) => Math.max(1,
  Math.round((Number(pulls) || 0) / (kind === 'cone' ? PULLS_PER.cone : PULLS_PER.char)));

/**
 * 这个副本用哪把尺子。
 *
 * 成本尺子（「含这个角色的达标队伍最低成本有多低」）适用于**判据是轮次/满分**的副本：
 * 混沌回忆、虚构叙事、末日幻影，以及**异相仲裁的骑士关**——骑士关的判据同样是
 * 0T / ≤2T / ≤4T（`metric` 就是轮次），和混沌回忆是一把尺子。
 *
 * 击败比例尺子留给**绝境王棋关**：它判的是行动值（<300 / <500）、成绩分布最宽
 * （p05=33 / p50=273 / p95=495），那是唯一能真正分出高下的地方。
 *
 * 为什么骑士关必须挪过来（2026-10 实测）：它在建库侧 `perf = -(action_value ?? metric)`，
 * 而骑士关的 `action_value` 是空的、`metric` 恒为 0 → **每条作业的 perf 都是 0**，
 * 星魂配对在骑士关完全量不出来；同时「击败比例」这一侧又恒不超过自己的 0 抽基线
 * （基线按成绩分选出，而成绩分里含行动值，于是基线天然就是分布最高点）。
 * 两头一夹，权重 1.4 的骑士关实测候选 0 条、对榜单贡献 0。判据既然是轮次，
 * 就该用轮次那把尺子：它的 `eidoPerf` 里 tier / cost 都是齐的，量得出来。
 *
 * 注意：数据集里 `mode` 是站点标签（`Memory of Chaos`），但测试与部分接口用 slug
 * （`moc`），两种写法都要认——早先只写 slug，结果线上一个副本都没走到成本口径。
 */
const EASY_MODES = new Set([
  'moc', 'Memory of Chaos',
  'pf', 'Pure Fiction',
  'as', 'Apocalyptic Shadow',
]);
export const isEasyMode = (mode, stage = '') => {
  const m = String(mode || '');
  // 异相仲裁按关卡分：骑士关/普通王棋关走成本尺子，绝境走击败比例。
  if (m === 'aa' || m === 'Anomaly Arbitration') return String(stage || '') !== 'plight';
  return EASY_MODES.has(m);
};

/** 一组数的中位数（空数组返回 null）。 */
const medianOf = (list) => {
  const values = (list || []).map(Number).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
};

/**
 * 第二节的「抽卡方案」：按**你的角色池**排出的一份补强清单。
 *
 * 为什么从「按作业一步步补」改成「清单」（2026-10 用户报的 bug 就是这个）：
 *
 *   旧版按**作业**给方案，而且**一个副本只挑一套**（避免同一副本重复计钱）。
 *   可是「一个副本的收益」在数据里只有一份 —— 照抄哪一套都只是那一次提升，所以
 *   方案最多排出 4~5 步（5 个副本/关卡）、每步 1~3 个单位，实测整页只出现 **5 个
 *   角色**，用户看到的正是「只显示少量角色」。更糟的是被 `usedUnit` 过滤之后还会
 *   出现「补上 0 个单位就能照抄这套作业」这种空步骤。
 *
 * 现在：**每个单位各占一条**，按它自己的性价比（`unit.total`，服务端已排好序）
 * 从高到低排，花费累计到预算为止。这样
 *
 *   * 预算越大 → 清单越长（不再是「一个副本一步」的硬上限）；
 *   * 每一条都独立可读：补谁、补到什么档、几金、性价比、帮到哪些副本、照抄哪套作业；
 *   * 不再有「总提升」这种把同一份收益重复累加出来的假数字 —— 一个副本的收益
 *     只能算一次，界面改写成「覆盖 N 个副本 / 关卡」。
 *
 * @param {any} conclusion  /api/archive/conclusion 的返回
 * @param {number|null} budget  还能再投几金（null = 不限）
 */
export const budgetPlan = (conclusion, budget = null) => {
  const limit = Number.isFinite(budget) && budget !== null ? Math.max(0, budget) : null;
  const units = Array.isArray(conclusion?.units) ? conclusion.units : [];
  // 每个副本「你现在在哪一档」：界面用它把一条补强写成「≤2T → 0T」这种游戏内的量。
  const baselineTier = new Map((conclusion?.envs || [])
    .map((env) => [env.id, env.baseline?.tier || null]));
  const picks = [];
  const covered = new Map();      // envId -> 这个副本上最好的一项收益（只作展示）
  let spend = 0;
  for (const unit of units) {
    if (picks.length >= SCORING.budgetPlanMaxSteps) break;
    const pulls = Math.max(1, Math.round(Number(unit.pulls) || 1));
    // 买不起就跳过，**不是**中断：后面可能有更便宜、同样值得补的单位。
    if (limit !== null && spend + pulls > limit) continue;
    spend += pulls;
    for (const env of unit.envs || []) {
      const gain = Math.max(0, Number(env.gain) || 0);
      if (gain > (covered.get(env.id)?.gain || 0)) {
        covered.set(env.id, { id: env.id, envLabel: env.envLabel, gain });
      }
    }
    // 用户要的是「补哪个角色合适」，不是「补哪个单位」——光锥归到它的载体角色上。
    picks.push({
      key: unit.key,
      name: unit.name,
      kind: unit.kind,
      pulls,
      pullsExpected: unitPullsOf(unit.kind, pulls),
      // 这一条自己的性价比（与总榜同一个字段，界面不再重算）
      value: Number(Number(unit.total) || 0),
      total: Number(Number(unit.total) || 0),
      envs: (unit.envs || []).map((env) => ({
        id: env.id,
        envLabel: env.envLabel,
        gain: Number((Number(env.gain) || 0).toFixed(4)),
        // 这个副本对总分的贡献（已经乘过权重与可达性折扣）：
        // 界面的性价比浮层要把它逐行列出来，加总正好等于徽标上的数。
        value: Number((Number(env.value) || 0).toFixed(4)),
        // 这一条用的是**方案口径**的副本权重（个人链内部叫 `envWeight`）。
        // 必须显式搬过来：`planTip` 的「权重」列读的是 `env.weight`，不搬就恒显示「×—」
        // （实测漏了很久 —— 投影层与这里都把它丢掉了）。
        weight: env.weight ?? env.envWeight ?? null,
        // 每个副本的「为什么」：好打的副本写达标成本，难打的写击败比例，
        // 好打副本里成本尺子退化时写档位变化（≤2T → 0T）。
        // 界面直接用这几个字段，不再自己算（负数节省就是从界面重算里漏出来的）。
        easy: Boolean(env.easy),
        costBefore: env.costBefore ?? null,
        costAfter: env.costAfter ?? null,
        pctBefore: env.pctBefore ?? null,
        pctAfter: env.pctAfter ?? null,
        // 这一档的档位，以及**你现在的基线档位**：两者不同就是「跨档提升」。
        tier: env.tier ?? null,
        tierFrom: baselineTier.get(env.id) ?? null,
        // 星魂/光锥这一档自己的「期望出分」提升（0~1，每个副本夹到 1）：
        // 好打副本里成本尺子常常退化（人人满分），此时真正动了的就是它。
        eidolonStep: env.eidolonStep ?? null,
        inferred: Boolean(env.inferred),
        evidence: env.evidence || null,
        count: env.count ?? null,
        season: env.season ?? null,
      })),
      character: unit.kind === 'cone' ? (unit.best?.carrier || null) : unit.name,
      characterCn: unit.kind === 'cone' ? (unit.best?.carrierCn || null) : unit.name,
      // 补齐之后可以照抄的那套强势配队（这就是「配队差距」，只作展示）
      rosterCn: unit.best?.rosterCn || null,
      companionsCn: (unit.best?.companions || []).map((c) => c.nameCn || c.name),
      count: unit.best?.count ?? null,
      evidence: unit.best?.evidence || null,
      nameCn: unit.nameCn || null,
      icon: unit.icon || null,
      from: unit.best?.from ?? unit.from,
      target: unit.best?.target ?? unit.target,
    });
  }
  const byEnv = [...covered.values()]
    .map((row) => ({ ...row, gain: Number(row.gain.toFixed(4)) }))
    .sort((a, b) => b.gain - a.gain);
  return {
    budget: limit,
    mode: 'list',
    picks,
    totalPulls: spend,
    remaining: limit === null ? null : Math.max(0, limit - spend),
    /** 这份清单覆盖到的副本（每个副本只算它最好的一项，不是把收益重复相加）。 */
    byEnv,
    coveredCount: byEnv.length,
    // 兼容旧字段：`totalGain` = 各副本最好一项之和，只用于展示「覆盖了哪些副本」。
    totalGain: Number(byEnv.reduce((n, row) => n + row.gain, 0).toFixed(4)),
    exhausted: limit !== null && spend >= limit,
  };
};

/**
 * 队伍抽卡方案的**候选池来源**（用户 2026-10-11 第八轮放宽）。
 *
 * 取「性价比**逐档榜**」的全部条目，**并上**「角色总榜」——
 * 两者都是「每个角色收敛成一条」，区别只在收敛时按不按星魂档分组：
 *
 *   * `frontierUnits`（总榜）    —— 每个角色只留**总分最高**的那一个整包（任意档位）；
 *   * `frontierTiers`（逐档榜）  —— 每个角色在 **E0/E1/E2/E6** 各留一条
 *     （各自档位内分最高）。
 *
 * ⚠️ **并集是保险，不是当前的必要条件**（别把这条读反）：
 * `byTier` 的过滤是 `unit.eidolon !== tier`（**精确相等**，`EIDOLON_TIERS = [0,1,2,6]`），
 * 所以**结构上**「星魂落在 E3/E4/E5 的整包」进不了逐档榜 —— 只要某个角色的最佳整包恰好
 * 在 E3/E4/E5，它就只在总榜里。**实测当前数据集没有这种角色**（总榜 84 条的 key 全都在
 * 逐档榜里，并集与「只取逐档榜」都是 245 支），所以并集现在一个队伍都没多带。
 * 但它挡的是一个**真实存在的结构缺口**，成本又只是多扫 84 条，所以留着；
 * `team-plan-test.mjs` 的 B 段有一条不变量专门钉这件事（「总榜池里每一支队伍都要能在
 * 逐档榜池里找到」），哪天缺口被踩中会当场红。
 * ⚠️ 另：我一度以为这里实测「差 7 支队伍」，那是**我自己测试里的 `maxRows` bug** 造成的
 * 假象（`options.maxRows` 只能往下夹，两边都只拿到前 15 条，于是拿两批 top-15 互比）。
 * 教训见 HANDOFF §6。
 *
 * 为什么放宽到「每角色 × 每档」（用户原话：「任何队伍都应该有机会参与竞争，哪怕这支队伍
 * 本身实力不强，但可以依靠差额接近度拉分，结果很有可能名列前茅」）：
 *
 * 用总榜当池，**同一支队伍的低配档位会被它自己的高配档位挤掉** —— 池里只剩下最贵的那一版。
 * 而「便宜、强度略低」正是 ② 能补回来的那一类。实测（账号 1，默认权重）：
 *
 *   * 池规模 78 → **245** 支；
 *   * 用户最初关注的那支 `白厄/昔涟/刻律德菈/花火`（补 1~2 金）在总榜池里**根本不存在**
 *     （只剩它的补 6 金高配版），换池后直接进到前排（实测 #10）；
 *   * 前 15 名里有 **8 支**是总榜池拿不到的。
 *
 * ⚠️ **为什么不干脆放「全部整包」**（`frontierPacksByChar`，实测 2453 条 / 2179 支）：
 *   1. 那批里绝大多数是**一次性投稿**（随意的光锥/档位组合），它们的 ① 趋近 0，会把榜
 *      变成「谁刚好差 1 金」的噪音 —— 实测在账号 2 上前 15 名有 12 支是「补 1 金 +
 *      ① 个位数」，榜首那支 ① 只有 20；
 *   2. 体积 **888 KB**（只发 roster + 成员），直接超 `e2e-test.mjs` 的「结论载荷 < 600 KB」
 *      硬断言（当前实测 520 KB，余量 80 KB）。
 *   「每角色 × 每档」恰好是那一档：**保留了「只有实测通关记录才会进池」这个强度门槛**，
 *   只是不再把同一角色的低配档位丢掉。
 *
 * ⚠️ 逐档榜**本来就在结论载荷里**（总榜页的星魂档筛选 chips 要用它），而且实测 266 条
 * **全部**带着队友名单（`envs[].members`）—— 所以这次放宽是**客户端单方面**的，
 * 载荷一个字节都没涨。这条是选它而不是「全部整包」的第三个理由。
 *
 * 回退：`frontierTiers` 不存在时（旧服务端 / 合成夹具 / 探针直接喂 `{frontierUnits}`）
 * 自动退回总榜，行为与第七轮完全一致。
 */
export const teamPoolUnits = (conclusion) => {
  const tiers = conclusion?.frontierTiers;
  const tierFlat = tiers && typeof tiers === 'object' ? Object.values(tiers).flat() : [];
  const units = Array.isArray(conclusion?.frontierUnits) ? conclusion.frontierUnits : [];
  if (!tierFlat.length) return units;
  // 并集按整包键去重（两个来源会有大量同一条：某角色在 E2 档的最佳就是它的总榜最佳）。
  // 不去重也不影响结果（`teamPlan` 会按 roster 去重），只是白算一遍。
  const seen = new Set();
  const out = [];
  for (const u of [...tierFlat, ...units]) {
    const id = u?.key ?? `${u?.name}|${u?.eidolon}|${u?.lc}|${u?.superimp}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(u);
  }
  return out;
};

/**
 * 第二节的「抽卡方案」——**队伍口径**（用户 2026-10-11 第 10 轮，取代逐个单位的 `budgetPlan`）。
 *
 * 用户原话：「重构抽卡方案，仍然是抽卡性价比排序，根据用户已有角色，列出提升最大收益的
 * 方案……有两个指标可作为排序依据，两个指标的得分权重各占一半，得出总分：
 * ① 该队伍性价比得分高；② 该队伍和用户持有的角色的成本差额接近（不考虑用户多出来的成本，
 * 只考虑用户少的成本），差额越小则得分越高。」
 *
 * ---------------------------------------------------------------------------
 * 候选池 = **性价比逐档榜 ∪ 总榜，按队伍去重**
 *
 * 每一档（E0/E1/E2/E6）里各角色最强的那一个整包，**再加上**每个角色的总最佳整包
 * （它可能落在 E3/E4/E5，那些档位不在逐档榜里），合起来按队伍（成员的整包键排序后拼成
 * 的 roster 键）去重。这样「同一支队伍的低配档位」不会被它的高配档位挤掉 ——
 * 完整理由、并集的必要性（差 7 支）与实测数字见 `teamPoolUnits()` 的注释。
 * 本机实测：并集去重后 245 支队伍（放宽前：总榜 84 条 → 78 支）。
 *
 * ⚠️ **候选池刻意不写死数量**（用户第 1 条「应当由程序自主决定，以后更新版本、更新数据
 * 不用额外维护」）：档位表、条数、队伍数都随数据集与版本自动变，这里一个常数都不掺。
 *
 * ---------------------------------------------------------------------------
 * 两个指标与归一化（用户第 2 条：上下限也由程序现算，不写死）
 *
 *   ① **强度得分** = 该队伍的**纯强度**（`Σ_副本 副本权重 × packStrengthOf(表现)`，
 *      **不乘金数项**，见 `packStrengthOf()`）。
 *      归一：`(分 − 最低) ÷ (最高 − 最低) × 100`，刻度取自**整个候选池**。
 *      ⚠️ 口径在 v4.6.87 换过（用户 2026-10-12 第 3、4 条）：以前 ① 是「队伍在角色总榜
 *      上的分」，而那个分里乘了 `本版本最便宜金数 ÷ 本队金数` —— 它其实是性价比，实测
 *      16 金、行动值 286 的那支只有 81 分，9 金那支却 100 分，于是「强度权重拉高 →
 *      更推荐高金低行动值的队伍」根本不成立。换掉之后那句话才为真。
 *   ② **性价比得分 = 差额接近度**（用户 2026-10-12 第 6 条：只要这一个刻度）。
 *      差额接近度 = `(1 − 补金差额 ÷ 封顶值) × 100`，夹在 0~100。
 *      封顶值 = **候选池里补金差额的 p75**（`SCORING.teamPlanGapCapPct = 0.75`）——
 *      达到或超过它就 0 分。用户 2026-10-11 第六轮在四条曲线里选了「p50 封顶」，
 *      第八轮把候选池放宽（78 → 245 支）之后 p50 自己变小、把强队压死，改到 **p75**
 *      （两次换挡的实测数字都在 `SCORING.teamPlanGapCapPct` 的注释里）。
 *      ⚠️ 差额 = 0 的队伍**不进候选**（用户第 3 条：没有抽卡必要，不值得显示），
 *      所以 ② 的理论上界是 `(1 − 1 ÷ 封顶值) × 100`，永远拿不到 100。
 *      ⚠️ v4.6.87 这里还乘过第二个金数刻度（压金度，账面金数），v4.6.89 已按用户要求
 *      删除：它与差额接近度量的都是「这支队贵不贵」，并列两个分项属于重复计分。
 *      「账面 N 金」仍在卡片上逐行显示，只是不进分数。
 *   总分 = **强度得分 × ws + 差额接近度 × wc**，权重由用户在界面上定
 *      （`SCORING.drawWeight`，默认 1:1 = 旧版的等权系数）。
 *
 * ⚠️ **两个刻度（强度、差额）都取自整个候选池，与「展示几条」完全无关**
 * （2026-10-11 第七轮定稿）。
 *
 * 这一条改过三次，别改回去：
 *   1. 最初：刻度取全池的 **max(差额)**。候选池里有「要补几十金」的冷门队伍
 *      （实测账号 1 全池 max 48 金），刻度被它们撑开 → 前 10 名的总分跨度只有 **12.2**，
 *      用户报「差额接近度拉不开差距」。
 *   2. 第五、六轮：刻度改成取**下发批次**的 p50。离群值问题治好了，但把「展示条数」
 *      变成了分数的隐藏输入 —— 用户第 5 条要求「只显示前 15」之后，封顶值从 12 金
 *      缩到 9 金，「补 8 金」由 33 分掉到 11 分，最高分只剩 **55.6**，用户报
 *      「怎么只有 50 多分」。
 *   3. 第七轮（现在）：刻度取**全池**的 **p50**。离群值免疫（median 不动），
 *      而且条数从 15 调到 40 或 60，分数与名次一字不变（实测三条不变量全过）。
 *
 * 由此**排序键就是总分**（同分依次比队分 → 补金更少 → 队伍键），截断到 `maxRows`
 * 只是展示层的事 —— 第五~六轮那套「先按原始量纲初选、再按总分重排」的两阶段写法
 * 已经删掉，它当时存在的唯一理由就是「刻度依赖截断结果」。
 *
 * ⚠️ 换账号 / 换数据集时这三个数全部现算，所以**不需要任何维护**；代价是两账号之间的
 * 总分不可直接比较（口径使然，界面会写清）。
 *
 * ---------------------------------------------------------------------------
 * 补金顺序（用户 2026-10-11 追加问的第 2 个问题，选了「每抽收益 + 载体约束」）
 *
 * 用户问的是「决定补金顺序，有考虑光锥比角色/星魂便宜这件事吗」——`PULLS_PER` 里
 * 限定角色 **94 抽/金**、活动光锥 **67 抽/金**（便宜 29%），所以：
 *
 *   排序键 = 该笔补金的性价比得分 ÷ 它的期望抽数（`unitPullsOf`）
 *
 *   * 同为星魂、或同为光锥时，这个尺子与「按性价比得分」完全等价（同一个系数约掉）；
 *     **只有跨 kind 比较时才分叉** —— 实测 53 支队伍里 **28 支（53%）的顺序不同**。
 *   * 载体约束：**光锥必须排在它自己的载体角色之后**。纯按每抽收益排会出现
 *     「先买光锥、但角色本体还没抽到、没人能装」的顺序，那是荒唐的。
 *     实测本机两个账号的补金项里**一笔「缺角色本体」都没有**（总榜上榜角色的本体基本
 *     都已拥有），所以这条约束当前不触发 —— 它是**廉价保险**，换账号/换数据后不会出错。
 *
 * ---------------------------------------------------------------------------
 * @param {any} conclusion  `/api/archive/conclusion` 的返回（或 `buildConclusion` 的结果）
 * @param {object} account   账号持有：`{ owned:Set, eidolons:Map, cones:Map }`
 * @param {object} options   `availability` 成本口径表；`maxRows` 下发上限；
 *                           `drawWeights` 抽卡权重（`{ strength, cost }`，只认相对大小，
 *                           缺省 = `SCORING.drawWeight`）
 */
export const teamPlan = (conclusion, account = {}, options = {}) => {
  const availability = options.availability || {};
  const owned = account?.owned instanceof Set ? account.owned : new Set();
  // 账号现状（「过渡档位」要写「这一位现在是什么状态」）——与 `marginalCostOf` 同一读法。
  const eidolons = account?.eidolons instanceof Map ? account.eidolons : new Map();
  const cones = account?.cones instanceof Map ? account.cones : new Map();
  const units = teamPoolUnits(conclusion);
  // 抽卡权重（用户 2026-10-12 第 3、4 条）：只认**相对大小**，归一到和为 1。
  const draw = normalizeDrawWeights(options.drawWeights);
  /**
   * 一个整包的**纯强度**（用户 2026-10-12 第 3 条）：载荷里带 `strength` 就用它。
   *
   * 缺 `strength` 时退回 `total`（= 改造前的 ① 口径），这是**刻意的兼容**：合成夹具、
   * 旧服务端载荷、以及历史探针都只有 `total`，硬要 0 会让整列强度得分塌成 0 分。
   * 只在这里兜一次 —— 别把这个兜底抄到别处去，那会让「载荷没带 strength」这件事
   * 彻底查不出来（`slimFrontierUnit` 因此把缺值原样发成 `null`，而不是 0）。
   */
  const strengthOfUnit = (unit) => {
    const raw = unit?.strength;
    if (raw === null || raw === undefined) return Number(unit?.total) || 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : (Number(unit?.total) || 0);
  };
  const envMeta = new Map((conclusion?.frontierEnvs || []).map((env) => [env.id, env]));

  /** 一支队伍的身份：成员的整包键（排序后拼接）——同一支队伍只留一条。 */
  const rosterKeyOf = (members) => members
    .map((m) => `${m.char}|E${eidolonTierOf(m.eidolon)}|${m.lc || '-'}|`
      + `S${Math.max(1, Math.round(Number(m.superimp) || 1))}`)
    .sort().join('~');

  /**
   * 逐条整包 → 队伍。同一支队伍取**分最高**的那个整包当它的队伍分。
   *
   * 为什么不是「取第一个」：整包的 total 只统计**它自己有过证据的副本**，
   * 所以同一支队伍里不同成员的 total 可能不同（分最低的那个通常缺几个副本的证据）。
   * 队伍分取最高的那一个，才等于「这支队伍里最强成员在总榜上的位置」。
   */
  const byRoster = new Map();
  for (const unit of units) {
    // ⚠️ 队友名单只有**头条证据**那一支（见 `projectConclusion` 的 slimFrontierUnit）：
    // 其余副本的 `members` 是空数组。这里固定读 `envs[0]`（= 分最高的那个副本）。
    const best = (unit.envs || []).find((env) => (env.members || []).length) || null;
    const members = best?.members || [];
    if (!members.length) continue;
    const rosterKey = rosterKeyOf(members);
    const strength = strengthOfUnit(unit);
    const total = Number(unit.total) || 0;
    const prev = byRoster.get(rosterKey);
    // ⚠️ 同一支队伍取哪个整包当代表：**先比强度、再比总榜分**（用户 2026-10-12 第 4 条）。
    // 抽卡方案的 ① 换成了纯强度，而总榜分里含金数项 —— 只按总榜分挑代表，会把同一支队
    // 里「更贵、压金项更低」的那个整包选成代表，强度分反而被压下去。
    if (prev && !(strength > prev.strength
      || (strength === prev.strength && total > prev.total))) continue;
    byRoster.set(rosterKey, { rosterKey, members, total, strength, best, unit });
  }

  const candidates = [];
  for (const team of byRoster.values()) {
    const cost = marginalCostOf(team.members, availability, account);
    // 用户第 3 条：补金 0 的队伍直接剔除（「无抽卡的必要，不值得显示」）。
    if (!(cost.pulls > 0)) continue;
    /**
     * 账面金数 = 这支配装**自己**要花几金。
     *
     * ⚠️ 必须按**数据集那条 `c` 的口径**算：本体 + **真实**星魂级数（E3 就是 3）+ 光锥本体
     * × 叠影。用 `packGoldOf`（本体 + **目标档** 0/1/2/6 + 光锥本体）会得到另一个数 ——
     * 实测砂金•戏浪那支「最佳证据 14 金」的队伍按目标档只有 11 金（E3 被折成 E2）。
     * 而这一行下面紧接着就写「最佳证据：… 14 金」，两个数必须一致，否则读者会以为算错了。
     */
    const gold = team.members.reduce((n, m) => n + datasetGoldOf(m, availability), 0);
    // 隐金减免：只用于**展示**（「这些单位不用抽，账面扣掉 N 金」），不参与差额。
    //
    // ⚠️ 隐金设置的来源必须与**逐笔 cost**（下面那个 `cuts`）一致，两处都传
    // `conclusion?.hiddenCosts`。2026-10-11 第七轮修：改前这里传的是 `undefined`，
    // 于是它走**模块级状态** `activeHiddenCostsState`，而逐笔那边走的是**载荷里的**
    // `hiddenCosts`。浏览器里两者会不一致 —— 载荷带着 5 项全勾（界面就是这么发的），
    // 但模块级状态在**页面重新加载后没有被初始化**（界面只在用户勾选时才 `setHiddenCosts`）。
    // 症状实测：某张卡「账面 7 金｜补金 2 金」不写减免，而它的两笔补金项却因为逐笔
    // `cost = 0` 被界面**整批过滤掉**，于是补金顺序是空的 —— 看起来像渲染丢了。
    // 传 `conclusion?.hiddenCosts` 之后两边同源；该字段不存在时（工具/探针直接调
    // `buildConclusion`）`hiddenReductionOf` 仍会退回模块级状态，行为不变。
    const hiddenCut = hiddenReductionOf(team.members, availability,
      conclusion?.hiddenCosts, 'dataset').team;
    candidates.push({
      ...team,
      gap: Math.max(0, Number(cost.pulls) || 0),
      gapItems: cost.items || [],
      gold,
      displayGold: Math.max(1, gold - hiddenCut),
      hiddenCut,
    });
  }

  // ---- 两个指标的刻度：按**整个候选池**现算 -----------------------------------
  //
  // ⚠️ 刻度取自「整个候选池」，**不是**「要下发的那批」（2026-10-11 第七轮修，用户报
  // 「怎么只有 50 多分」）。第五、六两轮我把它取自下发批次，于是「展示几条」会反过来
  // 改分数水位：实测展示 15 条时 ② 的封顶值只有 **9 金**（展示 40 条时是 12 金），
  // 「补 8 金」因此从 33 分掉到 **11 分**，最高分只剩 55.6。
  // 用户第 10 轮的原始要求是「再根据队伍总分排序结果，将结果显示在抽卡方案界面」——
  // 展示条数是**纯展示**，不该参与刻度。改成全池之后，条数从 15 调到 40 或 60，
  // 分数水位与名次都不动。
  //
  // ⚠️ 但**必须用分位数，不能用 max**：候选池里存在「要补几十金」的冷门队伍
  // （实测本机账号 1：全池 max 48 金、p50 12 金）。用 max 会被这些离群值撑开刻度 ——
  // 那正是第五轮修掉的那个 bug（40 支里 20 支挤进 14.6 分的区间）。中位数对离群值免疫。
  //
  // 历史（别再改回去）：
  //   * 第五轮之前：刻度取全池 **max** → 被离群值撑开，前排挤在一起；
  //   * 第五、六轮：刻度取**下发批次**的 p50 → 治好了离群值，但把「展示条数」变成了
  //     分数的隐藏输入：用户第 5 条要求「只显示前 15」之后，5 分位刻度随之缩到 9 金，
  //     最高分从 74.6 掉到 55.6；
  //   * 第七轮（现在）：刻度取**全池**的 p50 → 两个毛病都没有。
  const scoreLo = candidates.length ? Math.min(...candidates.map((t) => t.total)) : 0;
  const scoreHi = candidates.length ? Math.max(...candidates.map((t) => t.total)) : 0;
  /**
   * ① **强度得分**的刻度：候选池里**纯强度**的 `teamPlanStrengthFloorPct` 分位 ~ 最大值
   * （用户 2026-10-12 第 3 条 + 第 7 条追问「为什么现在有很多队伍的强度得分直接达到接近 100」）。
   *
   * ⚠️ 用户 2026-10-12 第 3 条那版的下限是**池内最小值**，实测那个值是 **16.7**
   * （池里最弱的一支是「1 金血分队」），而争冠队伍都在 **1330~1397** —— 只占全量程的
   * **4.8%**，于是任何有竞争力的队伍算出来必然落在 **95~100**（池内 220 支里 14 支 ≥95）。
   * 更根本的一半原因在「表现」那条曲线：绝境（权重 ×10）在 **行动值 < 300 时固定 1.00**
   * （用户 2026-10-11 点名定的），前 10 张卡里有 8 支的绝境行动值都在 286~298 —— 它们在
   * **权重最大的副本上拿的是同一个表现分**，raw 强度只差 1.3%。
   *
   * 所以下限改成**分位数**（与 ② 的 p75 封顶对称：一边是「超过就 0 分」，一边是「低于就没分」）：
   * 实测（账号 1，池内 p75 = 891）前 15 名的强度得分跨度从 **26 分** 拉开到 **71 分**。
   * ⚠️ 实测另一个事实（别误会这条改动的性质）：抬下限**不是**把成本偷偷带进强度那一档 ——
   * 池内 `r(纯强度, 账面金数) = 0.24`、而**头部（强度 ≥ 1300）是 −0.65**（越便宜反而越强，
   * 因为金数不进强度，9 金的满分与 24 金的满分拿同一个表现分）。所以这条改动让
   * 「便宜还能满分」的队伍更占优，方向与用户「已被更能压成本的队伍取代」的诉求一致。
   */
  const strengthLo = (() => {
    if (!candidates.length) return 0;
    const sorted = candidates.map((t) => t.strength).sort((a, b) => a - b);
    const p = Math.max(0, Math.min(1, Number(SCORING.teamPlanStrengthFloorPct) || 0.75));
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  })();
  const strengthHi = candidates.length ? Math.max(...candidates.map((t) => t.strength)) : 0;
  /**
   * ② 的**封顶值**：候选池里补金差额的 `SCORING.teamPlanGapCapPct` 分位（现在是 p75）。
   *
   * 差额 0 金的队伍**不进候选**（用户第 3 条：没有抽卡必要，不值得显示），
   * 所以 ② 的理论上界 = `(1 − 1 ÷ 封顶值) × 100`，永远拿不到 100。
   */
  const gapCap = (() => {
    if (!candidates.length) return 0;
    const sorted = candidates.map((t) => t.gap).sort((a, b) => a - b);
    const p = Math.max(0, Math.min(1, Number(SCORING.teamPlanGapCapPct) || 0.75));
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  })();
  /** ② 的刻度上界（用于展示与断言）：封顶值取不到时退回最大值，不出现除零。 */
  const gapMax = gapCap > 0 ? gapCap
    : (candidates.length ? Math.max(...candidates.map((t) => t.gap)) : 0);
  const span = (v, lo, hi) => (hi - lo < 1e-9 ? 1 : (v - lo) / (hi - lo));
  // ⚠️ 不要叫 `clamp01`：模块顶上已经有一个同名的（那一个在模块作用域里），
  // 这里遮蔽它会让人以为改的是同一个函数。
  const clampUnit = (v) => Math.max(0, Math.min(1, v));

  for (const t of candidates) {
    // ① **强度得分** = 纯强度在候选池里的位置（0~100）—— 用户 2026-10-12 第 3、4 条：
    // 它不含金数项，所以「强度权重拉高 → 高金、低行动值的队伍排上来」才成立。
    //
    // ⚠️ 这里**不能**直接用 `span()`：它在 `hi − lo < 1e-9` 时返回 1（「全池同分 → 人人满分」），
    // 而换成**分位下限**之后多了一种退化 —— 小池子里 p75 恰好等于最大值（2 支的夹具就是），
    // 这时只有达到上限的那一支算满分，其余必须记 0；否则又会变成「大家都接近 100」。
    const strengthSpan = strengthHi - strengthLo;
    t.strengthPct = Number((strengthSpan > 1e-9
      ? 100 * clampUnit((t.strength - strengthLo) / strengthSpan)
      : (t.strength >= strengthHi - 1e-9 ? 100 : 0)).toFixed(4));
    // ② **性价比得分 == 差额接近度**（用户 2026-10-12 第 6 条：只要这一个刻度）。
    // 「差额接近度」= 1 − 差额 ÷ 封顶值：差额 0 金 = 100 分，达到/超过封顶值 = 0 分。
    // ⚠️ v4.6.87 这里还与「压金度」按 `teamPlanCostMix` 合成过 —— 已按用户要求删除，
    //    所以**不要再引入第二个金数刻度**：他与「你还要补几金」高度同向，属于重复计分。
    //    「这支队总共几金」仍逐行显示（`gold` / 卡片上的「账面 N 金」），只是不进分数。
    t.gapPct = Number((100 * clampUnit(1 - span(t.gap, 0, gapMax))).toFixed(4));
    // 总分 = 强度得分 × ws + 性价比得分（差额接近度）× wc（用户 2026-10-12 第 3、4、6 条）。
    t.total_score = Number((draw.strength * t.strengthPct + draw.cost * t.gapPct).toFixed(4));
  }

  // ---- 排序与截断 ------------------------------------------------------------
  //
  // 用户第 10 轮原话：「再根据队伍总分排序结果，将结果显示在抽卡方案界面」——
  // 所以排序键就是**总分**（同分依次比强度得分 → 差额接近度 → 补金更少 → 队伍键，
  // 保证确定性），截断到 `maxRows` 只是展示层的事，**不参与任何计算**。
  // 两阶段（先按原始量纲初选、再按总分重排）在第七轮被删掉了：它当初存在的唯一理由
  // 是「刻度依赖截断结果」，而那个依赖本身就是要修掉的毛病。
  const maxRows = Math.max(1, Math.min(
    SCORING.teamPlanMaxRows,
    Number(options.maxRows) || SCORING.teamPlanMaxRows,
  ));
  const ranked = [...candidates].sort((a, b) => b.total_score - a.total_score
    || b.strengthPct - a.strengthPct
    || b.gapPct - a.gapPct
    || a.gap - b.gap
    || String(a.rosterKey).localeCompare(String(b.rosterKey)));
  const delivered = ranked.slice(0, maxRows);

  // ---- 补金顺序：每抽收益降序 + 「光锥跟在载体之后」的载体约束 ----------------
  const charScoreOf = (name) => units
    .filter((u) => u.name === name)
    .reduce((best, u) => Math.max(best, Number(u.total) || 0), 0);

  for (const t of candidates) {
    // 隐金设置下**每一笔实际要花的金**。
    //
    // 用户 2026-10-11 第 6 条：「当开启隐金设置时，不显示**不添加成本**的补金建议」——
    // 界面需要一个逐笔的判据，所以这里按 `hiddenReductionOf()` 的逐成员减免
    // （`byIndexChar` / `byIndexCone`）把它算出来，随 `fill` 一起下发。
    // ⚠️ 口径必须与队伍差额（`t.gap`）同源：差额 = Σ 每一笔的 `cost`，否则会出现
    // 「合计 3 金、但列出来的每一笔加起来是 5 金」。
    const cuts = hiddenReductionOf(t.members, availability,
      conclusion?.hiddenCosts, 'dataset');
    const items = (t.gapItems || []).map((item) => {
      const owner = item.carrier || item.name;
      // 这一笔自己的性价比 = 它所属成员在总榜上的分（与队伍分同源）。
      const value = charScoreOf(owner) || charScoreOf(item.name) || t.total;
      const pullsExpected = unitPullsOf(item.kind, item.pulls);
      const gold = Math.max(1, Math.round(Number(item.pulls) || 1));
      // 该笔属于哪个成员：角色那笔按角色名找、光锥那笔按载体身上的光锥找。
      const idx = item.kind === 'cone'
        ? t.members.findIndex((m) => m.lc === item.name)
        : t.members.findIndex((m) => m.char === item.name);
      const cut = item.kind === 'cone'
        ? (cuts.byIndexCone?.[idx] || 0)
        : (cuts.byIndexChar?.[idx] || 0);
      return {
        kind: item.kind,
        name: item.name,
        pulls: gold,
        pullsExpected,
        from: item.from ?? null,
        target: item.target ?? null,
        carrier: item.carrier || null,
        certain: item.certainty !== false,
        value,
        // 这一笔实际要花的金（隐金减免之后）。0 = 「不添加成本」，界面会把它藏起来。
        cost: Math.max(0, gold - cut),
        // 排序键：每 **抽** 收益（不是每金收益）—— 这一项才让 67 抽/金的光锥
        // 与 94 抽/金的星魂在同一个尺子上比。
        perPull: value / Math.max(1, pullsExpected),
      };
    });
    // 贪心拓扑：每轮取「未被载体阻塞、且每抽收益最高」的那一笔。
    const remaining = [...items];
    const fill = [];
    while (remaining.length) {
      let pick = -1;
      let pickScore = -Infinity;
      for (const [i, it] of remaining.entries()) {
        // 载体约束：这把光锥的载体**本体都还没到手**（那一笔还排在后面）就先别买它 ——
        // 否则会出现「先买一把没人能装的光锥」。
        //
        // ⚠️ 判据必须用 `x.kind === 'char'`，**不能**用 `x.from < 0`：`marginalCostOf`
        // 把 `from` 写成了 `Math.max(0, mine)`（`mine = -1` 会被夹成 0），所以「缺本体」
        // 这件事只体现在 `kind` 上。实测按 `from < 0` 写时这条约束**永远不成立**，
        // 砂金•戏浪那支队会把「未见→S1」的光锥排在「本体」前面。
        const blocked = it.kind === 'cone' && it.carrier
          && !owned.has(it.carrier)
          && remaining.some((x) => x.kind === 'char' && x.name === it.carrier);
        if (blocked) continue;
        if (it.perPull > pickScore) { pick = i; pickScore = it.perPull; }
      }
      // 理论上不会走到这里（被阻塞项的前置本体自己一定不被阻塞）；真出现就取下一位。
      if (pick < 0) pick = 0;
      fill.push(remaining.splice(pick, 1)[0]);
    }
    t.fill = fill;
    t.pullsExpected = fill.reduce((n, it) => n + it.pullsExpected, 0);
  }

  // ---- 下发 ------------------------------------------------------------------
  const rows = delivered.map((t) => ({
    key: t.rosterKey,
    // 队伍成员（整包三要素）：界面按它画 4 个位置，并标出「已有 / 缺」。
    members: t.members.map((m) => ({
      char: m.char, eidolon: eidolonTierOf(m.eidolon), lc: m.lc || null, superimp: m.superimp,
      owned: owned.has(m.char),
      // 这一位自己的性价比（= 队伍分；同队成员共享头条证据，所以数值相同）。
      value: charScoreOf(m.char) || t.total,
    })),
    // 两个分项与总分（0~100 体系）。
    total: t.total_score,
    teamScore: t.total,
    // ① 强度得分（**纯强度**归一化，用户 2026-10-12 第 3 条）与它的原始值。
    strengthPct: t.strengthPct,
    strength: t.strength,
    // ② 性价比得分（用户 2026-10-12 第 6 条）＝ **就是差额接近度**，只有这一个刻度。
    // v4.6.87 还下发过 `costPct`（差额与压金各半）与 `goldPct`，按用户要求已删除 ——
    // 界面直接读 `gapPct` 印「差额接近度」。⚠️ 不要为了「兼容」再加回 `costPct` 别名：
    // 两个名字指同一个数，正是用户这次说「三者过于重叠」的来历。
    gapPct: t.gapPct,
    // 补金
    gap: t.gap,
    pullsExpected: t.pullsExpected,
    // 账面金数（数据集口径，见 `datasetGoldOf`）与隐金后印的那个数。
    gold: t.gold,
    displayGold: t.displayGold ?? t.gold,
    // 最佳证据那支队**自己**的金数（与 `gold` 同口径，但那条证据的星魂可能不是目标档）。
    teamGold: t.best?.bestTeamGold ?? null,
    hiddenCut: t.hiddenCut,
    fill: t.fill,
    // 最佳证据（界面写「异相仲裁 · 绝境王棋关 14 金 · 299 行动值」）
    bestEnv: t.best ? {
      id: t.best.id,
      label: envMeta.get(t.best.id)?.label || t.best.id,
      weight: envMeta.get(t.best.id)?.weight ?? null,
      value: t.best.value,
      bestTeamGold: t.best.bestTeamGold ?? null,
      tier: t.best.tier ?? null,
      actionValue: t.best.actionValue ?? null,
      season: t.best.evidenceSeason ?? null,
      seasonMinCost: t.best.seasonMinCost ?? null,
    } : null,
    envCount: t.unit?.envCount ?? null,
    /**
     * **过渡档位**（用户 2026-10-11 第 7 条）：「当一个队伍需同时补金多个角色时，需要提供
     * 一个成本**完全下位**的中间档位的队伍，用来过渡，方便更平滑地补金，补金的顺序要能够
     * 先到达此配队」。
     *
     * 做法：把补金顺序切成**前半**与**后半**两段（前半的累积金数不超过总差额的一半，
     * 至少 1 笔、至多少 1 笔）——「先补完前半」得到的就是那个中间档位：它要买的每一项
     * 都是本方案要买的项的子集，所以**每一项成本都不高于本方案**（＝完全下位），
     * 而补金顺序天然先到它（前缀）。
     *
     * 每位成员在中间档位里的状态：还没补的那一项退回**账号现状**（角色没买 → 未拥有；
     * 星魂没补 → 现在是几命；光锥没补 → 现在几叠影）。界面据此写出中间档位的四个人。
     */
    mid: (() => {
      const fill = t.fill || [];
      if (fill.length < 2) return null;
      const half = t.gap / 2;
      let acc = 0;
      let k = 0;
      while (k < fill.length - 1 && acc + fill[k].pulls <= half) {
        acc += fill[k].pulls;
        k += 1;
      }
      if (k === 0) { acc = fill[0].pulls; k = 1; }
      if (k >= fill.length || !(acc > 0) || !(t.gap - acc > 0)) return null;
      const bought = fill.slice(0, k);
      const boughtKey = new Set(bought.map((it) => `${it.kind}|${it.name}`));
      return {
        items: k,
        gold: acc,
        rest: t.gap - acc,
        members: t.members.map((m) => {
          const charPending = fill.some((it) => it.kind !== 'cone' && it.name === m.char
            && !boughtKey.has(`${it.kind}|${it.name}`));
          const conePending = Boolean(m.lc) && fill.some((it) => it.kind === 'cone' && it.name === m.lc
            && !boughtKey.has(`cone|${m.lc}`));
          return {
            char: m.char,
            // 中间档位里的状态（没补的那一项退回账号现状；`null` = 那时还没有）。
            eidolon: charPending
              ? (owned.has(m.char) ? eidolonTierOf(eidolons.get(m.char) ?? 0) : null)
              : eidolonTierOf(m.eidolon),
            superimp: conePending ? (cones.get(m.lc) || null) : Math.max(1, Number(m.superimp) || 1),
            lc: m.lc || null,
            // 这一位在中间档位里是否还差东西（界面据此标「过渡时仍是缺的」）。
            pending: charPending || conePending,
          };
        }),
      };
    })(),
    /**
     * **次选配队**（用户 2026-10-11 第 8 条：「点击补金推荐分按钮可以查看补金推荐分的来源，
     * 以及**其他类似的次选的配队（至多 3 个）**」）。
     *
     * 「类似」的判据取**共享成员数**（≥2 人才算类似，1 人的「同角色不同队」不算），
     * 同分优先、再按总分降序；最多 3 支。刻意不用「分数接近」当判据：那样列出来的
     * 常常是完全无关的另一支队（分数只是刻度内的相对位置）。
     */
    alternatives: (() => {
      const mine = new Set(t.members.map((m) => m.char));
      return delivered
        .filter((o) => o.rosterKey !== t.rosterKey)
        .map((o) => ({
          o,
          shared: o.members.filter((m) => mine.has(m.char)).length,
          diff: Math.abs(Number(o.total_score) - Number(t.total_score)),
        }))
        .filter((x) => x.shared >= 2)
        .sort((a, b) => b.shared - a.shared || a.diff - b.diff)
        .slice(0, 3)
        .map((x) => ({
          key: x.o.rosterKey,
          total: Number(x.o.total_score.toFixed(1)),
          gap: x.o.gap,
          shared: x.shared,
          members: x.o.members.map((m) => ({
            char: m.char,
            eidolon: eidolonTierOf(m.eidolon),
            lc: m.lc || null,
            superimp: Math.max(1, Number(m.superimp) || 1),
          })),
        }));
    })(),
  }));

  return {
    mode: 'team',
    rows,
    // ⚠️ 一定要分清这两组数（第五~七轮反复踩过）：
    //   * `pool` / `poolAll` = **候选池**规模（决定「有没有得选」）；
    //   * `scoreLo` / `scoreHi` / `gapMax` = **候选池**的刻度（决定「分数怎么摊开」），
    //     `gapMax` 是**分位封顶值**（默认中位数），不是最大值。
    //   两组的取样集合都是全池，所以**与 `rows.length` 无关** —— 改 `teamPlanMaxRows`
    //   只会改展示条数，分数与名次一字不变。
    pool: candidates.length,
    poolAll: byRoster.size,
    // ① 的刻度（纯强度，用户 2026-10-12 第 3 条）：下限是**池内分位**（第 7 条），上限是最大值。
    // `strengthFloorPct` 一并回显 —— 界面那行刻度要写清「p75 ~ 最高」，否则读者会以为
    // 下限是池内最弱的队（那正是让所有强队都算成 95+ 的原因）。
    strengthLo: Number(strengthLo.toFixed(4)),
    strengthHi: Number(strengthHi.toFixed(4)),
    strengthFloorPct: Math.max(0, Math.min(1, Number(SCORING.teamPlanStrengthFloorPct) || 0.75)),
    // 总榜分的刻度：**只用于浮层解释「队分 N」**，不参与总分（总分只吃上面那两个刻度）。
    scoreLo: Number(scoreLo.toFixed(4)),
    scoreHi: Number(scoreHi.toFixed(4)),
    /** 生效的抽卡权重（已归一化，和为 1）—— 界面照它印那两个系数。 */
    drawWeights: { ...draw },
    /** ② 的刻度封顶值（候选池差额的 p75）：界面写「差额达到 N 金即 0 分」。 */
    gapMax,
    gapMin: delivered.length ? Math.min(...delivered.map((t) => t.gap)) : 0,
    /** ② 的封顶分位（界面脚注要写「差额达到 N 金即 0 分」）。 */
    gapCapPct: Number(SCORING.teamPlanGapCapPct) || 0.5,
    /**
     * **要下发的这几条里**差额的真实最大值。
     *
     * ⚠️ 这个 ≠ `gapMax`：`gapMax` 是**全池**的分位封顶值，这个是**展示批次**的极值。
     * 界面用它们说明「这批里有 N 支落在封顶之外、补金最多的是 M 金」。
     */
    gapRealMax: delivered.length ? Math.max(...delivered.map((t) => t.gap)) : 0,
    truncated: ranked.length > rows.length,
  };
};

/**
 * 根据当前账号已经拥有的单位，逐步计算抽卡方案的边际收益。
 *
 * 与 `budgetPlan` 的区别：`budgetPlan` 按静态总分截断；这里每选中一个单位，
 * 都会从后续候选的副本收益中扣掉已经覆盖的部分，避免同一副本被重复计分。
 * `units` 的 `envs[].gain` 是 buildConclusion 已按账号计算好的收益，因而这个
 * 函数不重新解释评分模型，只负责方案层的边际选择。
 *
 * @param {any} conclusion buildConclusion 的返回
 * @param {object} options
 * @param {number|null} options.budget 金数上限；null 表示不限
 * @param {'efficiency'|'strength'|'shortfall'} options.objective 选择目标
 * @param {number} options.maxSteps 最大步骤数
 * @returns {{mode:string, objective:string, picks:Array, totalGain:number,
 *   totalPulls:number, remaining:number|null, byEnv:Array}}
 */
export const marginalPlan = (conclusion, options = {}) => {
  const units = Array.isArray(conclusion?.units) ? conclusion.units : [];
  const rawBudget = options.budget;
  const budget = Number.isFinite(rawBudget) && rawBudget !== null
    ? Math.max(0, Math.floor(rawBudget)) : null;
  const objective = ['efficiency', 'strength', 'shortfall'].includes(options.objective)
    ? options.objective : 'efficiency';
  const maxSteps = Math.max(1, Math.min(
    SCORING.budgetPlanMaxSteps,
    Number(options.maxSteps) || SCORING.budgetPlanMaxSteps,
  ));
  const baseline = new Map((conclusion?.envs || []).map((env) => [
    env?.id,
    Number(env?.baseline?.score) || 0,
  ]));
  const selected = new Set();
  const covered = new Map();
  const picks = [];
  let spend = 0;

  const gainOf = (unit, env) => {
    const gain = Number(env?.gain);
    if (!Number.isFinite(gain) || gain <= 0) return 0;
    const already = Number(covered.get(env.id) || 0);
    // 采用“购买该单位后的最佳收益 - 当前最佳收益”，而不是把各单位收益相加。
    const weight = Number.isFinite(Number(env?.weight ?? env?.envWeight))
      ? Number(env.weight ?? env.envWeight) : 1;
    return Math.max(0, gain * weight - already);
  };
  const scoreOf = (unit, gains, pulls) => {
    const gain = [...gains.values()].reduce((sum, value) => sum + value, 0);
    if (objective === 'strength') return gain;
    if (objective === 'shortfall') {
      // 对仍低于该副本已有基线的环境加权，优先补短板。
      return [...gains.entries()].reduce((sum, [id, value]) => {
        const room = Math.max(0, 1 - (baseline.get(id) || 0));
        return sum + value * (1 + room);
      }, 0) / Math.max(1, pulls);
    }
    return gain / Math.max(1, pulls);
  };

  while (picks.length < maxSteps) {
    let best = null;
    for (const unit of units) {
      if (!unit || selected.has(unit.key)) continue;
      const pulls = Math.max(1, Number(unit.pulls) || 1);
      if (budget !== null && spend + pulls > budget) continue;
      const gains = new Map();
      for (const env of unit.envs || []) {
        const gain = gainOf(unit, env);
        if (gain > 0) gains.set(env.id, gain);
      }
      const gain = [...gains.values()].reduce((sum, value) => sum + value, 0);
      if (!(gain > 0)) continue;
      const score = scoreOf(unit, gains, pulls);
      if (!best || score > best.score
        || (score === best.score && gain > best.gain)
        || (score === best.score && gain === best.gain && pulls < best.pulls)) {
        best = { unit, pulls, gains, gain, score };
      }
    }
    if (!best) break;
    const { unit, pulls, gains, gain, score } = best;
    selected.add(unit.key);
    spend += pulls;
    for (const env of unit.envs || []) {
      const value = Number(env?.gain);
      const weight = Number.isFinite(Number(env?.weight ?? env?.envWeight))
        ? Number(env.weight ?? env.envWeight) : 1;
      const weighted = Number.isFinite(value) ? value * weight : 0;
      if (weighted > (covered.get(env.id) || 0)) {
        covered.set(env.id, weighted);
      }
    }
    picks.push({
      key: unit.key,
      name: unit.name,
      kind: unit.kind,
      pulls,
      value: Number(score.toFixed(4)),
      marginalGain: Number(gain.toFixed(4)),
      envs: [...gains.entries()].map(([id, marginalGain]) => {
        const source = (unit.envs || []).find((env) => env.id === id) || {};
        return {
          ...source,
          id,
          // 方案页的详情窗口必须展示这一步真正新增的贡献；保留原始字段时，
          // 它会把已经被前序单位覆盖的收益再次显示出来。
          gain: Number(marginalGain.toFixed(4)),
          value: Number((marginalGain / Math.max(1, pulls)).toFixed(4)),
          marginalGain: Number(marginalGain.toFixed(4)),
        };
      }).sort((a, b) => b.marginalGain - a.marginalGain),
      nameCn: unit.nameCn || null,
      icon: unit.icon || null,
      best: unit.best || null,
    });
  }
  const byEnv = [...covered.entries()]
    .map(([id, gain]) => ({ id, gain: Number(gain.toFixed(4)) }))
    .sort((a, b) => b.gain - a.gain);
  return {
    mode: 'marginal',
    objective,
    budget,
    picks,
    totalPulls: spend,
    remaining: budget === null ? null : Math.max(0, budget - spend),
    byEnv,
    coveredCount: byEnv.length,
    totalGain: Number(byEnv.reduce((sum, row) => sum + row.gain, 0).toFixed(4)),
    exhausted: budget !== null && spend >= budget,
  };
};

/** `Number(null) === 0`：数据里的 null 是「没有这项证据」，不能当成 0 参与打分。 */
const finiteOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** 分位数（线性插值）。空数组返回 null。 */
const quantileOf = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
};

/**
 * 版本号比较（`cmpVersion('4.2', '4.6') < 0`）。
 *
 * ⚠️ **不要用字典序**：版本号迟早出现 `4.10`，字典序会把它排在 `4.2` 前面。
 * 按 `主.次` 拆成数字逐段比。总榜用它判断「某个版本是不是早于这个整包登场」
 * （用户第 6 条的放大只针对**旧版本**）。
 */
const cmpVersion = (a, b) => {
  const pa = String(a ?? '').split('.').map((n) => Number(n) || 0);
  const pb = String(b ?? '').split('.').map((n) => Number(n) || 0);
  return (pa[0] || 0) - (pb[0] || 0) || (pa[1] || 0) - (pb[1] || 0);
};

/**
 * 整包键：角色 + 星魂目标档 + 光锥 + 叠影。
 *
 * 总榜的**单位**就是这个键（用户 2026-10 口径：不再把角色 / 星魂 / 光锥拆成三行）。
 * 星魂先过 `eidolonTierOf` 收成 0/1/2/6 四个目标档，与数据集里的档位口径一致。
 */
const packKeyOf = (member) => `${member.char}|E${eidolonTierOf(member.eidolon)}|`
  + `${member.lc || '-'}|S${Math.max(1, Math.round(Number(member.superimp) || 1))}`;

/** 一条配置里的整包清单（含赛季），用于统计「这个整包出现在多少条独立配置里」。 */
const packRosterKeyOf = (members) => members
  .map((m) => packKeyOf(m)).sort().join('~');

/**
 * 整包**自己的**金数 = 本体 + 从 E0 数起的全部星魂级数 + 光锥（限定才计金）。
 *
 * ⚠️ 这里用 `eidolonGoldOf(0, eid)`，不是 `eidolonGoldOf(2, 6)`：后者是
 * 「E2 之后再投 4 金」的**增量**口径（旧总榜的星魂行用的就是它），而整包要的是
 * 从 E0 数起的总量（E6 = 6 金），否则 E6 整包会少算 2 金。
 *
 * 本体 0 金（4★ / 常驻 / 开拓者）时**星魂也不计金** —— 旧总榜的星魂行只在「本体要
 * 花金」时才会生成（见 `charCostOf` 的用法），整包必须沿用同一条成本口径，否则
 * 开拓者 E6 会被算成 6 金、直接霸占榜首（实测踩过）。此时整包只在挂了限定光锥时
 * 才有金，照常进榜：那把光锥确实要抽；整包金数为 0 才不进榜。
 *
 * ⚠️ **这个函数永远是「原始」金数**（不含隐金减免）。隐金减免在
 * `hiddenReductionOf()` 里另算，两条用途分开：
 *   * **进榜判据**（`buildConclusionInner` 里 `gold <= 0 → continue`）用**原始**值 ——
 *     用户 2026-10-11 明确要求「减到 0 也仍然留在榜上」（否则兑换 / 常驻那两组一勾选
 *     就整批从榜上消失，等于看不见效果）；
 *   * **榜上印的 `N 金`** 用「原始 − 该整包被归到的减免」。
 * 导出它是为了让探针与回归测试能拿同一个口径复算（此前是模块私有，探针只能自己抄一份）。
 */
export const packGoldOf = (member, availability) => {
  const cone = member.lc ? coneCostOf(member.lc, availability) : 0;
  const body = charCostOf(member.char, availability);
  if (body <= 0) return cone;
  return body + eidolonGoldOf(0, member.eidolon) + cone;
};

/** 一条配置的整队金数 = 各成员整包金数之和（与服务端 `frontierRows[].cost` 同一口径）。 */
const rosterGoldOf = (members, availability) => members
  .reduce((sum, m) => sum + packGoldOf(m, availability), 0);

/**
 * **数据集那条 `c`** 的口径下，一个成员要几金：本体 + **真实**星魂级数 + 光锥本体 × 叠影。
 *
 * ⚠️ 与 `packGoldOf` **不是同一个数**，两者差在「E3 算 3 金还是 2 金」「S2 算 1 金还是 2 金」
 * 上（实测 44 行不同，见 `tools/_probe-yinjin-cost-formula.mjs`）：
 *   * `packGoldOf`  → 本体 + **目标档**（0/1/2/6）+ 光锥本体；**榜上印的 `N 金`** 是它
 *     （用 `hiddenReductionOf(..., 'tiered')` 减）；
 *   * `datasetGoldOf`（本函数）→ 本体 + **真实**星魂级数 + 光锥本体 × 叠影；**队伍金数**
 *     与数据集那条 `c` 是它（用 `hiddenReductionOf(..., 'dataset')` 减）。
 *
 * 为什么要它：队伍抽卡方案那一行下面紧接着写「最佳证据：… 14 金」，那个 14 是**队伍**的
 * 账面金数（数据集口径）；用 `packGoldOf` 会印出 11（E3 被折成 E2），两个数对不上。
 */
const datasetGoldOf = (member, availability) => {
  const body = charCostOf(member.char, availability);
  const cone = member.lc ? coneCostOf(member.lc, availability) : 0;
  // 本体 0 金（4★ / 常驻 / 开拓者）时星魂也不计金 —— 与 `packGoldOf` 同一条硬规则。
  const eidolon = body > 0 ? Math.max(0, Math.round(Number(member.eidolon) || 0)) : 0;
  const superimp = member.lc ? Math.max(1, Math.round(Number(member.superimp) || 1)) : 0;
  return body + eidolon + cone * superimp;
};

// ---------------------------------------------------------------- 隐金设置（用户 2026-10-11）
//
// 「隐金」= 把这些**不用抽就有**的角色 / 光锥的成本从总榜里去掉。用户原话是按五组给的，
// 每组一个复选框（界面默认**全勾**），勾上以后：
//
//   ① 直接受赠角色              → 该角色少 1 金（最低 0）
//   ② 累计抽卡赠送光锥          → 该光锥少 1 金（最低 0）
//   ③ 角色兑换（罗刹…知更鸟）    → 该角色**及其星魂**视为 0 金
//   ④ 光锥兑换（于夜色中…）      → 该光锥**及其叠影**视为 0 金
//   ⑤ 后续加入的常驻角色        → 该角色**及其星魂**视为 0 金
//
// ⚠️ 为什么①不是「每个点名角色各减 1」而要写成三种规则：用户给的「特殊情况」原话是
//    * 单独的 Archer 减少 2 成本；
//    * Archer + 吉尔伽美什 各自减少 1 成本（合计 2）；
//    * 景元/卡芙卡/丹恒•饮月/镜流/花火/黄泉/砂金 **组队时一共减少 1 成本**；
//    * 光锥同理（单独的理想燃烧的地狱 -2；与所见即我同队则各自 -1）。
// 这读起来就是「一期赠送 + 二期自选一个」的领取上限：Archer 两期都能领（-2），而七人组
// 是**自选其一**（所以一队里出现几个也只减 1）。规则按用户口径逐条实现，不自行推广。
//
// ⚠️ **作用面是「队伍金数」**（用户 2026-10-11 明确选择）：总榜的分母是「该配置的队伍
// 金数」（见 `buildConclusionInner` 的 `seasonMinCost / row.cost`），所以减金会真的改变
// 名次 —— 只改显示不改分数那版被用户否掉了。逐版本最便宜金数（分子）与整包自身金数
// （榜上那行印的 `N 金`）都跟着一起减，否则会出现「分子按原价、分母按隐金后」的错配。
//
// ⚠️ **两套金数口径**（实测数据逼出来的，别合并）：
//   * `dataset`：数据集那条 `c` 的算法 = 本体 + **真实**星魂级数 + 光锥本体 × 叠影。
//     实测 4230/4230 条前沿行完全一致（`tools/_probe-yinjin-cost-formula.mjs`）。
//     队伍金数用它 —— 它是「该配置金数」这个分母本身。
//   * `tiered`  ：`packGoldOf` 的算法 = 本体 + 星魂**目标档**（0/1/2/6）+ 光锥本体
//     （叠影不进这个数）。整包自身金数（榜上印的那个数）用它。
//   两套差在「E3 算 3 金还是 2 金」「S2 算 1 金还是 2 金」上，实测 44 条行不一样。
//   把某个人「视为 0 成本」时必须按**它所在的那个数**去减，否则会留下 1 金的残渣。

/** ① 直接受赠角色：单独赠送的（一队里出现就是 -1）。 */
const GIFT_CHARS_SOLO = ['Dr. Ratio', 'Dan Heng • Permansor Terrae'];
/** ① 直接受赠角色：**自选其一**的那一组（一队里出现几个都只减 1，见上面的注释）。 */
const GIFT_CHARS_PICK_ONE = ['Jing Yuan', 'Kafka', 'Dan Heng • Imbibitor Lunae', 'Jingliu',
  'Sparkle', 'Acheron', 'Aventurine'];
/** ① 直接受赠角色：成对规则的那两个（单独 Archer -2；同队各自 -1）。 */
const GIFT_CHAR_PAIR = ['Archer', 'Gilgamesh'];
/** ② 累计抽卡赠送光锥：成对规则（单独的理想燃烧的地狱 -2；同队各自 -1）。 */
const GIFT_CONE_PAIR = ['The Hell Where Ideals Burn', 'I Am As You Behold'];
/** ③ 角色兑换：角色**及其星魂**视为 0 成本。 */
const EXCHANGE_CHARS = ['Luocha', 'Ruan Mei', 'Topaz & Numby', 'Huohuo', 'Robin'];
/** ④ 光锥兑换：光锥**及其叠影**视为 0 成本。 */
const EXCHANGE_CONES = ['In the Night', 'Echoes of the Coffin', 'The Unreachable Side',
  'She Already Shut Her Eyes', 'Past Self in Mirror', 'Worrisome, Blissful', 'Incessant Rain',
  'Night of Fright', 'An Instant Before A Gaze', 'Flowing Nightglow', 'Dance at Sunset'];
/** ⑤ 后续加入的常驻角色：角色**及其星魂**视为 0 成本。 */
const STANDARD_CHARS = ['Seele', 'Yunli', 'Argenti', 'Silver Wolf', 'Fu Xuan', 'Blade'];

/** 五个开关的 id（与界面上的五个复选框一一对应）。 */
export const HIDDEN_COST_IDS = Object.freeze(['gift', 'giftCone', 'exchange', 'exchangeCone', 'standard']);

/**
 * 界面上那五组复选框的**唯一一份定义**（分组标题 / 复选框文案 / 效果说明 / 图标下面列谁）。
 *
 * 为什么放在这里而不是界面里：`herta-test.mjs` 要在**不依赖 DOM** 的前提下校验
 * 「名单里的键在数据集里都存在」（名单写错一个键，界面上就是一张破图 + 一条永不生效的
 * 规则，而且不会报错）。界面只负责画。
 *
 * `effect` 只有用户给的那半句「效果」；`note`（可选）是**界面上要显示的备注**，
 * 目前只有①那两条有 —— 它们带「成对 / 自选」的例外规则，不写出来读者看不懂
 * 为什么 Archer 被减了 2、为什么七个人凑一队也只减 1。
 *
 * ⚠️ 备注的来历值得记一笔：用户 2026-10-11 第一版要求「括号内的内容不显示在界面上」
 * （所以当时把「特殊情况」只实现进口径、不画），**同一轮追加要求「你要加个备注，
 * 提示用户特殊情况」** —— 于是它变成界面上可见的一条备注。两句话不矛盾：
 * 仍然是「括号里的说明性文字不显示」，但**规则性的例外必须以备注形式告知用户**。
 * 改 `hiddenReductionOf()` 的规则时，这两条 `note` 要一起改（它们描述的是同一件事）。
 */
export const HIDDEN_COST_SETTINGS = Object.freeze([
  {
    group: '直接受赠角色/累计抽卡赠送光锥',
    rows: [
      {
        id: 'gift',
        label: '隐藏直接受赠角色的成本',
        effect: '以上角色减少 1 成本，最低 0 成本',
        // 备注（用户 2026-10-11 追加要求：「你要加个备注，提示用户特殊情况」）：
        // 这一条与下一条有**成对 / 自选**规则，光看「减少 1 成本」会看不懂为什么 Archer
        // 被减了 2、为什么七个人凑一队也只减 1。上一轮用户说过「括号内的内容不显示在界面
        // 上」，本轮明确要求把特殊情况**提示出来**，所以这里改成一条界面上可见的备注
        // （与 `hiddenReductionOf()` 的实现逐条对应，改规则时这句也要改）。
        note: '备注：单独 Archer 减 2；Archer 与吉尔伽美什同队时各自减 1；'
          + '景元 / 卡芙卡 / 丹恒•饮月 / 镜流 / 花火 / 黄泉 / 砂金 组队时一共只减 1。',
        kind: 'char',
        // 顺序照用户给的写法：真理医生、Archer（第一期）、丹恒•腾荒、自选那一组、吉尔伽美什。
        units: ['Dr. Ratio', 'Archer', 'Dan Heng • Permansor Terrae',
          ...GIFT_CHARS_PICK_ONE, 'Gilgamesh'],
      },
      {
        id: 'giftCone',
        label: '隐藏累计抽卡赠送光锥的成本',
        effect: '以上光锥减少 1 成本，最低 0 成本',
        note: '备注：单独的理想燃烧的地狱减 2；与所见即我同队时各自减 1。',
        kind: 'cone',
        units: [...GIFT_CONE_PAIR],
      },
    ],
  },
  {
    group: '角色兑换/光锥兑换',
    rows: [
      {
        id: 'exchange',
        label: '隐藏角色兑换的成本',
        effect: '以上角色及其星魂视为 0 成本',
        kind: 'char',
        units: [...EXCHANGE_CHARS],
      },
      {
        id: 'exchangeCone',
        label: '隐藏光锥兑换的成本',
        effect: '以上光锥及其叠影视为 0 成本',
        kind: 'cone',
        units: [...EXCHANGE_CONES],
      },
    ],
  },
  {
    group: '常驻角色',
    rows: [
      {
        id: 'standard',
        label: '隐藏后续加入的常驻角色的成本',
        effect: '以上角色及其星魂视为 0 成本',
        kind: 'char',
        units: [...STANDARD_CHARS],
      },
    ],
  },
]);

/**
 * 隐金设置的**默认值：五项全开**（用户 2026-10-11：「以下复选框默认已点击」）。
 *
 * ⚠️ 这里是**界面**的默认值，不是 API 的默认值：`buildConclusion` 不传 `hiddenCosts`
 * 时按「一项都不减」算（见 `normalizeHiddenCosts`）。理由有两个：
 *   * 工具侧（探针 / 回归测试 / `herta-test` 的真实数据用例）历史口径不变，
 *     口径改动不会悄悄改掉 82 项既有断言的期望值；
 *   * 「默认全开」是用户对**界面**的要求，界面一定会把五个布尔显式发过来
 *     （localStorage 没有存档时用这份默认值），所以用户看到的仍是「默认已勾选」。
 */
export const DEFAULT_HIDDEN_COSTS = Object.freeze({
  gift: true, giftCone: true, exchange: true, exchangeCone: true, standard: true,
});

/** 全部关掉的隐金设置（API / 工具侧的默认口径）。 */
export const NO_HIDDEN_COSTS = Object.freeze({
  gift: false, giftCone: false, exchange: false, exchangeCone: false, standard: false,
});

/**
 * 把任意输入收成五个布尔。**只认这五个键**，缺的按 false —— 这样
 * `undefined` / `null` / 旧客户端不带这个字段时都是「一项都不减」，
 * 而界面传什么就完全按传的算（它自己会用 `DEFAULT_HIDDEN_COSTS` 补默认值）。
 */
export const normalizeHiddenCosts = (raw) => {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const id of HIDDEN_COST_IDS) out[id] = src[id] === true;
  return out;
};

/**
 * 当前生效的隐金设置（模块级，与副本权重同一个套路：`buildConclusion` 进来时设、
 * 退出时还原）。为什么不一路当参数传：成本函数（`packGoldOf` / `frontierPackRowsOf`）
 * 在七八个地方被调用，把设置穿进每一个签名只会让「谁忘了传」变成一个静默的口径分叉。
 */
let activeHiddenCostsState = normalizeHiddenCosts(null);

/** 设当前隐金设置，返回**上一次**的那份（调用方负责还原）。 */
export const setHiddenCosts = (value) => {
  const prev = activeHiddenCostsState;
  activeHiddenCostsState = normalizeHiddenCosts(value);
  return prev;
};

/** 读当前隐金设置（拷贝，调用方改不动内部状态）。 */
export const activeHiddenCosts = () => ({ ...activeHiddenCostsState });

/**
 * 一个成员的金拆成几份 —— 两套口径共用这一份拆分，避免两处各推一遍。
 *
 * `eidolonReal` 与 `eidolonTier` 的差别见上面「两套金数口径」：数据集那条 `c` 记的是
 * **真实级数**（E3 = 3 金），而整包键 / `packGoldOf` 记的是**目标档**（E3 → E2 = 2 金）。
 */
const memberGoldParts = (member, availability) => {
  const body = charCostOf(member?.char, availability);
  const eidolon = Math.max(0, Math.min(6, Math.round(Number(member?.eidolon) || 0)));
  return {
    body,
    // 本体 0 金（4★ / 常驻 / 开拓者）时星魂也不计金 —— 与 `packGoldOf` 同一条硬规则。
    eidolonReal: body > 0 ? eidolon : 0,
    eidolonTier: body > 0 ? eidolonGoldOf(0, member?.eidolon) : 0,
    cone: member?.lc ? coneCostOf(member.lc, availability) : 0,
    superimp: Math.max(1, Math.round(Number(member?.superimp) || 1)),
  };
};

/**
 * 一条配置（一支队伍）在隐金设置下被减掉多少金。
 *
 * @param {Array<{char:string,eidolon?:number,lc?:string|null,superimp?:number}>} members
 * @param {object} availability 数据集 `refs.availability`
 * @param {object|null} [settings] 五个开关；不传 = 用当前生效的那份
 * @param {'dataset'|'tiered'} [convention] 见上面「两套金数口径」
 * @returns {{ team:number, byIndex:number[], byKey:Map<string,number> }}
 *   `team`    整队一共减几金（从队伍金数里减）
 *   `byIndex` 每个成员被归到几金（数据集口径 / 整包口径由 `convention` 决定）
 *   `byKey`   整包键 → 该整包**自己**的展示金数要减几金（用于榜上那行印的 `N 金`）
 */
export const hiddenReductionOf = (members, availability, settings, convention = 'dataset') => {
  const list = Array.isArray(members) ? members : [];
  const on = settings === undefined ? activeHiddenCostsState : normalizeHiddenCosts(settings);
  /**
   * 两个累加器分开记：**角色那一份**与**光锥那一份**。
   *
   * ⚠️ 为什么不能合成一个「这个成员减几金」（实测踩过）：用户的口径是
   *「以上**角色**减少 1 成本，最低 0 成本」/「以上**光锥**减少 1 成本，最低 0 成本」——
   * 上限各自管各自。合成一个累加器时，一把 S1 的赠送光锥（规则 -2）会把夹逼上限
   * 算成「角色本体 + 光锥」的 2 金，于是**多减掉角色本体的 1 金**（实测：一个
   * 「Solid + 理想燃烧的地狱 S1」的成员被减 2 金，而它只该减 1）。
   */
  const charCut = list.map(() => 0);
  const coneCut = list.map(() => 0);
  const partsOf = (m) => memberGoldParts(m, availability);
  /** 角色那一份的金（本体 + 星魂）——两种口径差在星魂取「真实级数」还是「目标档」。 */
  const charGoldOf = (p) => (convention === 'tiered' ? p.body + p.eidolonTier : p.body + p.eidolonReal);
  /** 光锥那一份的金（数据集口径是「本体 × 叠影」，整包展示口径里叠影不进这个数）。 */
  const coneGoldOf = (p) => (convention === 'tiered' ? p.cone : p.cone * p.superimp);
  const addCharAt = (index, amount) => {
    if (index >= 0 && amount > 0) charCut[index] += amount;
  };
  const addConeAt = (index, amount) => {
    if (index >= 0 && amount > 0) coneCut[index] += amount;
  };
  const firstIndexOfChar = (name) => list.findIndex((m) => m?.char === name);
  const firstIndexOfCone = (name) => list.findIndex((m) => m?.lc === name);

  // ---- ③⑤ 兑换 / 常驻：该角色自己那份（本体 + 星魂）直接归零 ----
  if (on.exchange || on.standard) {
    list.forEach((m, i) => {
      const zeroChar = (on.exchange && EXCHANGE_CHARS.includes(m?.char))
        || (on.standard && STANDARD_CHARS.includes(m?.char));
      if (!zeroChar) return;
      addCharAt(i, charGoldOf(partsOf(m)));
    });
  }
  // ---- ④ 光锥兑换：该光锥自己那份（「及其叠影」）直接归零 ----
  if (on.exchangeCone) {
    list.forEach((m, i) => {
      if (!m?.lc || !EXCHANGE_CONES.includes(m.lc)) return;
      addConeAt(i, coneGoldOf(partsOf(m)));
    });
  }
  // ---- ① 直接受赠角色 ----
  if (on.gift) {
    for (const name of GIFT_CHARS_SOLO) addCharAt(firstIndexOfChar(name), 1);
    // 自选其一那一组：一队里出现几个都只减 1，记在第一个命中的成员身上
    // （用户原话「组队时一共减少 1 成本」）。
    addCharAt(list.findIndex((m) => GIFT_CHARS_PICK_ONE.includes(m?.char)), 1);
    const [pairA, pairB] = GIFT_CHAR_PAIR;
    const ia = firstIndexOfChar(pairA);
    const ib = firstIndexOfChar(pairB);
    if (ia >= 0 && ib >= 0) { addCharAt(ia, 1); addCharAt(ib, 1); } else if (ia >= 0) addCharAt(ia, 2);
    else addCharAt(ib, 1);
  }
  // ---- ② 累计抽卡赠送光锥 ----
  if (on.giftCone) {
    const [pairA, pairB] = GIFT_CONE_PAIR;
    const ia = firstIndexOfCone(pairA);
    const ib = firstIndexOfCone(pairB);
    if (ia >= 0 && ib >= 0) { addConeAt(ia, 1); addConeAt(ib, 1); } else if (ia >= 0) addConeAt(ia, 2);
    else addConeAt(ib, 1);
  }

  // 逐人分两份夹逼 —— 用户口径里的「最低 0 成本」就是这条：角色那一份不会被光锥的减免
  // 吃掉、光锥那一份也不会倒贴给角色（Archer 单独 -2 时，1 金的 E0 Archer 只能减到 0）。
  //
  // ⚠️ 两份**分开返回**（`byIndexChar` / `byIndexCone`）是用户 2026-10-11 追问
  // 「Archer 在 E0、或他的光锥在 S1 时整队被减 2」之后加的：只有把角色那一份与光锥那一份
  // 拆开，才能**穷举验证**「E0 的角色最多减 1、S1 的赠送光锥最多减 1」
  // （见 `tools/_probe-yinjin-archer.mjs` 的三条不变量）。合成一个数就只能「看起来没超」。
  const byIndexChar = list.map((m, i) => Math.min(charCut[i], charGoldOf(partsOf(m))));
  const byIndexCone = list.map((m, i) => Math.min(coneCut[i], coneGoldOf(partsOf(m))));
  const byIndex = byIndexChar.map((v, i) => v + byIndexCone[i]);
  const byKey = new Map();
  list.forEach((m, i) => {
    if (!(byIndex[i] > 0)) return;
    const key = packKeyOf(m);
    byKey.set(key, (byKey.get(key) || 0) + byIndex[i]);
  });
  return {
    team: byIndex.reduce((n, v) => n + v, 0), byIndex, byIndexChar, byIndexCone, byKey,
  };
};

/**
 * 把一个副本的前沿配置整理成「整包打分」要用的统一形状。
 *
 * 优先用服务端筛好的逐配置记录（`frontierRows`：达标/满分档 + 成本前沿，带角色、
 * 星魂、光锥与叠影）；测试夹具与旧调用方没有它时，退回按档位过滤的聚合阵容。
 * 两边都归一到 `{ cost（整数金）, tier, actionValue, season, members }`。
 *
 * ⚠️ 回退路径的金数**按成员重算**（`rosterGoldOf`），不能直接读 `team.cost`：
 * 聚合阵容里那个字段可能是 0 / 缺失（旧实现也是自己用 `teamPullsOf` 折算的），
 * 照抄会让整张榜因为「成本 0」被整体丢掉（实测踩过）。
 *
 * ⚠️ 隐金（用户 2026-10-11）在这里生效：队伍金数 = **原始金数 − 该队的隐金减免**，
 * 用 `max(1, …)` 兜底（整队都免费时仍然要有一个分母，见下面的注释）。原始金数留在
 * `storedCost` 上：进榜判据看的仍是它（「0 金配置没有可比性」这条旧规则不变）。
 */
const frontierPackRowsOf = (env, frontierEntry, aggRows, availability) => {
  const normalizeMember = (m) => ({
    char: m.char,
    eidolon: eidolonTierOf(m.eidolon),
    lc: m.lc || null,
    superimp: Math.max(1, Math.round(Number(m.superimp) || 1)),
  });
  const selected = frontierEntry?.frontierRows;
  const source = Array.isArray(selected) && selected.length
    ? selected
    : (Array.isArray(env.frontierRows) ? env.frontierRows : null);
  /**
   * 把「原始金数」换成「隐金后仍然可算的金数」。
   *
   * 用户 2026-10-11 第 3 条（原话「使用 0 金通关额外获得 1.2 的倍率」，并澄清
   * 「0 金 = **隐金后**的有效队伍金数」）之后，这个函数**允许算出 0**：一队四个位置
   * 全被隐金时它就是 0 金队，拿 `SCORING.frontierZeroGoldBonus`。
   *
   * ⚠️ 但 0 金**不能进分母**：金数项的分母是「该版本最便宜的金数」（全版本共享），
   * 它一旦变成 0，同版本**所有**队伍的金数项都会被算成 0（实测这就是老注释担心的那件事）。
   * 所以两个「取最小」的地方各自用 `Math.max(1, row.cost)` 记账（见 `minCostBySeason`
   * 的注释），而**本条配置自己的 0** 由 `frontierCostTermOf()` 单独走 1.2 那一支 ——
   * 既不会除零，也不会把别人打成 0。
   *
   * 改之前这里的下限是 1（`Math.max(1, stored - cut)`）：那时「0 金」在管道里根本不可达，
   * 因为 1.2 这条规则还不存在。现在下限交给金数项去处理，语义更清楚。
   */
  const adjustedCost = (stored, cut) => (stored > 0 ? Math.max(0, stored - cut) : 0);
  const raw = source
    ? source.map((row) => {
      const members = (row.members || []).map(normalizeMember).filter((m) => m.char);
      const stored = Math.max(0, Math.round(Number(row.cost) || 0));
      // 数据集那条 `c` 的口径（本体 + 真实星魂 + 光锥本体×叠影）—— 实测 4230/4230 一致，
      // 所以「原始 − 减免」是精确的，不需要按成员重算（重算反而会把真实星魂级数抹成目标档）。
      const cut = hiddenReductionOf(members, availability, undefined, 'dataset').team;
      return {
        cost: adjustedCost(stored, cut),
        storedCost: stored,
        hiddenCut: cut,
        tier: row.tier === 'target' ? 'target' : 'perfect',
        // 绝境的 `0` 是有效成绩（0 行动值通关），只有空值 / 非数值才是缺失。
        actionValue: finiteOrNull(row.actionValue),
        season: row.newestSeason || row.season || env.season || null,
        members,
      };
    })
    : (aggRows || [])
      .filter((r) => r.tier === 'perfect' || r.tier === 'target')
      .map((r) => {
        const members = (r.team?.sample?.members || []).map(normalizeMember).filter((m) => m.char);
        const stored = rosterGoldOf(members, availability);
        // 回退路径的金数本来就是按成员重算的（整包口径），所以减免也走 tiered 口径。
        const cut = hiddenReductionOf(members, availability, undefined, 'tiered').team;
        return {
          cost: adjustedCost(stored, cut),
          storedCost: stored,
          hiddenCut: cut,
          tier: r.tier,
          actionValue: finiteOrNull(r.actionValue),
          season: r.team?.newestSeason || env.season || null,
          members,
        };
      });
  // 0 金配置没有「达成目标要花几金」的可比性（整包金数也必然全为 0），直接排除。
  // ⚠️ 判据是 **`storedCost`（原始金数）**：隐金把一支队减到 1 金不会把它从榜上抹掉，
  // 而数据集里本来就是 0 金的行照旧不参与（它没有成本可比性这件事与隐金无关）。
  return raw.filter((row) => row.storedCost > 0 && row.members.length);
};

/**
 * **纯强度**：`frontierPackScale × 表现`，**刻意不乘金数项**（用户 2026-10-12 第 3 条）。
 *
 * 为什么必须从「榜上的分」里拆出来：整包分 = `表现 × 金数项`，所以它其实是**性价比** ——
 * 实测用户账号 1 那支 9 金的拿了 100 分，而 16 金、行动值 286 的那支只有 81 分。
 * 抽卡方案那个「强度」旋钮要的是另一件事：「强度权重越高 → 越倾向于推荐**高金、低行动值**
 * 的队伍」，只有把金数项摘掉，强度得分才真的只随档位/行动值与版本加权走。
 *
 * ⚠️ 它与 `score` 共用同一个 `perf`（`perfFactorOf()` 的输出），**不要再算一遍表现分**：
 * 分叉的症状是「界面上的强度得分与浮层里的算式对不上」（`herta-test.mjs` 有回归钉住）。
 * 版本加权那一层与 `score` 完全同源（同一个 `wSum`、同样「已登场缺证据算 0 分」）。
 */
export const packStrengthOf = (perf) => Number(SCORING.frontierPackScale) * (Number(perf) || 0);

/**
 * **金数项的唯一计算处**（用户 2026-10-11 第 3 条）。
 *
 * ```
 *   cost === 0（隐金后一分钱都不用抽） → frontierZeroGoldBonus（1.2）
 *   其它                               → min(frontierCostCap（1）, 分母 ÷ 本队金数)
 *   缺这项证据（分母或本队金数取不到）   → null（界面显示「—」，算分按 ×1）
 * ```
 *
 * 为什么要单独一个函数：这条链有**两个**调用点 —— `buildConclusionInner` 的算分
 * （榜上那个数）与 `frontierFactorsOf` 的拆因子（窗口里那张表）。以前两边各写一遍
 * `minCost / cost`，这次加「封顶 + 0 金 1.2」两条规则时任何一边漏改，界面上
 * 「因子乘回去 ≠ 榜上的分」（`herta-test.mjs` 有回归钉住这条恒等式）。
 *
 * `cost` 传 `null` / 负数 = **没有这项证据**；传 `0` = **有效金数为 0**（两者含义不同，
 * 不能都当 0 处理 —— 这是本仓库 `Number(null) === 0` 那个老坑的同一类，见 HANDOFF §4.4）。
 *
 * @param {number|null} seasonMinCost 该版本的金数项分母（perfect 档最便宜，缺则全档最小）
 * @param {number|null} cost 这支队伍**隐金后**的有效金数（0 = 0 金通关）
 */
export const frontierCostTermOf = (seasonMinCost, cost) => {
  const c = finiteOrNull(cost);
  // 0 金通关：用户 2026-10-11 明确「倍率设置为 1.2，**不是**再加 1.2」。
  if (c === 0) return Number(SCORING.frontierZeroGoldBonus);
  const min = finiteOrNull(seasonMinCost);
  if (c === null || !(c > 0) || min === null || !(min > 0)) return null;
  // 封顶：分母可能来自**另一档**（perfect 档最便宜），而本队可能落在 target 档且更便宜，
  // 相除就会 > 1（实测最多 ×7.00）。用户口径「倍数封顶 1.00」把这一头关掉。
  return Math.min(Number(SCORING.frontierCostCap), min / c);
};

/**
 * 「贡献值来源」：把**一个副本的贡献**拆成它乘起来的那几个因子（2026-10 用户要求）。
 *
 * 榜上的一个数字（例如「性价比 +660」）是一串乘法，光给结果读者没法判断「它凭什么
 * 这么高」——是档位满、行动值低，还是这一期最便宜的达标配置恰好就是它？这里把每个
 * 因子单独算出来交给界面：
 *
 *   贡献 = 副本权重 × [ 100 × 档位 × 行动值项 × (最便宜金数 ÷ 本队金数) ] × 版本项
 *           └ 前两项见调用方        └────────── base ──────────┘   └ 加权平均 ┘
 *
 * ⚠️ **必须与 `buildConclusionInner` 里的算分保持同一口径**（那里一行是
 * `SCORING.frontierPackScale * tierWeight * avTerm * (minCost / row.cost)`）：
 * 所以这里读的是**同一批常量**（`SCORING`）与**算分时用的那对分位边界**
 * （`meta.avLo` / `meta.avHi`，由 `frontierMeta` 下发），不是 `minAction` / `maxAction`。
 * 「版本项」是**余数**：该副本的实测分 ÷ 上面几项，它含 2:2:2:1:1:1:1 的版本加权与
 * 「缺证据版本算 0 分」的那部分 —— 拆不出来单独一项，但乘回去必须还原榜上的分
 * （`tools/herta-test.mjs` 有回归用例钉住这条恒等式）。
 * ⚠️ v4.6.78 起它含的就只有「版本加权 + 算 0 分的版本」（放大与估算都已删除），
 * 所以它**恒 ≤ 1** —— 见 `docs/评分模型设计.md` v29。
 *
 * 入参允许两种形状：内部链路的条目（带 `score`）与界面收到的载荷（只有 `value`，
 * `score = value ÷ 副本权重`）。
 *
 * @param {{id?:string, value?:number, score?:number, weight?:number, tier?:string,
 *          actionValue?:number|null, bestTeamGold?:number|null}} env
 * @param {{weight?:number, minCost?:number|null, avLo?:number|null, avHi?:number|null,
 *          lowerIsBetter?:boolean}|null} meta 该副本的元数据（`frontierEnvs` 里那条）
 */
export const frontierFactorsOf = (env, meta) => {
  const weightValue = Number(meta?.weight ?? env?.weight);
  const weight = Number.isFinite(weightValue) ? weightValue : 0;
  const scoreValue = Number(env?.score);
  // 界面载荷里没有 `score`（逐条下发它要多花几十 KB，而 `value ÷ weight` 是一回事）。
  const score = Number.isFinite(scoreValue)
    ? scoreValue
    : (weight > 0 ? (Number(env?.value) || 0) / weight : 0);
  // ---- 表现分：档位与行动值**合并**（用户 2026-10-11 缺陷 3 修）----------------
  //
  // 以前这里是 `tierFactor` 与 `avFactor` **两个**因子相乘，界面也分两列展示。合并后
  // 只剩**一个** `perfFactor`，由 `perfFactorOf()` 以游戏判据线为标尺现算
  // （与算分共用同一个函数，不会再分叉）。线上取值与旧档位权重一致
  // （满分线 1.00 / 达标线 0.50），所以「档位」那一列仍能显示游戏内量纲，
  // 只是它不再是独立乘数。
  //
  // ⚠️ **判据线取值必须按副本取**（`perfLineWeightsOf`，用户 2026-10-11 第四轮）：
  // 绝境的满分线以内是平的 1.00、达标线 0.60，与默认那套（0.85 / 0.50）不同。
  // 这里漏传就会让浮层拆出来的算式与榜上的分对不上 —— `herta-test.mjs` 有回归钉住。
  const perfFactor = perfFactorOf(env?.actionValue, meta?.tierLines,
    meta?.lowerIsBetter !== false, env?.tier, perfLineWeightsOf(meta || env));
  // 兼容旧字段：`tierFactor` / `avFactor` 仍返回（供旧调用方与浮层链），
  // 但它们**不再相乘** —— 乘起来会得到 2 倍的结果。`base` 用合并后的 `perfFactor`。
  const tierFactor = Number(SCORING.frontierTierWeight[env?.tier]) || 0;
  const av = finiteOrNull(env?.actionValue);
  const avLo = finiteOrNull(meta?.avLo);
  const avHi = finiteOrNull(meta?.avHi);
  const lowerIsBetter = meta?.lowerIsBetter !== false;
  const usable = av !== null && avLo !== null && avHi !== null && avHi > avLo + 1e-9;
  const avScore = usable
    ? clamp01(lowerIsBetter ? (avHi - av) / (avHi - avLo) : (av - avLo) / (avHi - avLo))
    : null;
  const avFactor = avScore === null
    ? 1 : SCORING.frontierAvShare + (1 - SCORING.frontierAvShare) * avScore;
  // 金数：**该版本的**最便宜配置（即达到「最好一档」的最便宜那支）÷ 这支队伍的金数
  // （`Number(null) === 0`，要挡掉）。
  // ⚠️ 基准必须与算分一致（用户 2026-10-10 第 5 轮）：算分用的是「**本版本**最便宜」，
  // 所以优先读逐条下发的 `env.seasonMinCost`；只有老载荷没有它时才退回副本级的
  // `meta.minCost`（那是全窗口的最小值 —— 用它会把「环境难压金」的版本算成「队伍不够省」，
  // 实测 24 个组合里 18 个吃亏，详见 `buildConclusionInner` 里 minCostBySeason 的注释）。
  const minCost = finiteOrNull(env?.seasonMinCost) ?? finiteOrNull(meta?.minCost);
  const cost = finiteOrNull(env?.bestTeamGold);
  // ⚠️ 走**同一个** `frontierCostTermOf()`（用户 2026-10-11 第 3 条：封顶 ×1、
  // 0 金通关 ×1.2）：以前这里是裸的 `minCost / cost`，与算分那条链各写一遍。
  const costFactor = frontierCostTermOf(minCost, cost);
  const base = SCORING.frontierPackScale * perfFactor * (costFactor ?? 1);
  // 版本项 = 实测分 ÷ 上面几项（含版本加权与「缺证据版本算 0 分」）。`base` 为 0
  // （档位未知 / 数据缺失）时没有可解释的余数，如实给 null，界面显示「—」。
  const seasonFactor = base > 0 ? score / base : null;
  return {
    weight,
    score,
    value: weight * score,
    tier: env?.tier ?? null,
    tierFactor,
    // 合并后的**唯一表现分**（用户 2026-10-11 缺陷 3）：界面链子里只写它一项。
    perfFactor,
    // 档位的**游戏内写法**（`0T` / `积分 ≥3700` / `行动值 <300`）：用户 2026-10-10
    // 点名「把『满分』『达标』改为具体的行动值」。放在这里现算是因为它依赖判据线
    // （`meta.tierLines`，只随副本元数据下发），界面自己拼不出来。
    tierText: tierTextOf(meta, env?.tier),
    av,
    avLo,
    avHi,
    avScore,
    avFactor,
    minCost,
    cost,
    costFactor,
    base,
    seasonFactor,
    // 界面要写「完整算式」（用户 2026-10：「贡献应当写出真实的计算过程」）时要用到它 ——
    // 这是链子里的那枚 `×100`（`SCORING.frontierPackScale`），从界面其余字段**反推不出来**，
    // 只能跟别的因子一起下发。
    packScale: SCORING.frontierPackScale,
  };
};

/**
 * 跨模式综合结论。
 *
 * envs = /api/archive/conclusion 返回的每个副本/关卡（含完整阵容表）。
 * 返回：
 *   envs          每个副本的基线与候选（界面上「你现在在哪一档」）
 *   frontierUnits 角色总榜：**纯数据集口径**，与角色池无关（界面上的「角色总榜」）
 *   units         个人口径的单位榜：按「这个单位在你身上值多少」排序（界面上「抽卡方案」）
 *   gapUnits      和主流强阵的差距榜；eidolonUnits 星魂全局榜；packages 作业榜
 */
export const buildConclusion = (envs, options = {}) => {
  // 用户自定义的副本权重：**两个口径各一套**，在整个计算期间生效，函数退出前恢复。
  // 放在最外层（而不是只在某一块里）是因为权重被评分路径上的多处调用
  // （单位归因、差距打分、前沿强度），每个口径内部必须全程一致。
  //
  //   options.weights          方案口径（抽卡方案 / 差距榜 / 星魂榜）
  //   options.frontierWeights  总榜口径（角色总榜）
  //
  // ⚠️ **刻意不做「只给一个就两边都用」的兜底**：那正是用户要拆掉的东西 ——
  // 一条隐式耦合会让「我只改了关卡权重，方案怎么也跟着变了」在下一次改动里复活。
  // 两个都要调就两个都传（服务端与工具都是这么做的）。
  const prevPlan = setEnvWeights(options.weights, 'plan');
  const prevFrontier = setEnvWeights(options.frontierWeights, 'frontier');
  // 「隐金设置」（用户 2026-10-11）：与副本权重同一个套路 —— 全程生效、退出还原。
  // ⚠️ 不传 = **一项都不减**（见 `DEFAULT_HIDDEN_COSTS` 的注释）：界面一定会显式发五个
  // 布尔（它自己的默认值是「全勾」），而工具 / 回归测试的历史口径因此保持不变。
  const prevHidden = setHiddenCosts(options.hiddenCosts);
  try {
    return buildConclusionInner(envs, options);
  } finally {
    setEnvWeights(prevPlan, 'plan');
    setEnvWeights(prevFrontier, 'frontier');
    setHiddenCosts(prevHidden);
  }
};

const buildConclusionInner = (envs, options = {}) => {
  const availability = options.availability || {};
  const account = options.account || {};
  // 诊断钩子：传一个数组进来，每条星魂条目命中的分支与取值会推进去（工具/探针用）。
  const trace = Array.isArray(options.trace) ? options.trace : null;
  const perEnvCandidates = Math.max(1, Number(options.perEnvCandidates) || 6);
  const avWeight = Number.isFinite(options.avWeight) ? Number(options.avWeight) : AV_WEIGHT;

  const envResults = [];
  const units = new Map();
  const allCandidates = [];
  /**
   * 前沿的**整包**累计：`envId -> Map(整包键 -> 该副本的最佳证据)`。
   *
   * 服务端 `archiveFrontier` 已完成「达标/满分档」筛选（v4.6.78 起**不再**按成本截断），
   * 并把**完整配装**（角色 / 星魂 / 光锥 / 叠影）传回来，所以总榜直接用这批行算整包证据；
   * 测试夹具或旧调用方没有它时退回聚合阵容（见 `frontierPackRowsOf`）。
   */
  const frontierPacks = new Map();
  const frontierMeta = new Map();
  // 服务端已把「达标档 + 完整配装」的前沿行传回来。总榜只在这批行上算，避免从全部
  // 历史投稿里挑出一条偶然极端配置；纯客户端夹具 / 旧调用没有该字段时，继续使用
  // env.frontierRows 兼容回退。
  const frontier = options.frontier || {};

  for (const env of envs || []) {
    const id = env.id || `${env.mode}${env.stage ? `/${env.stage}` : ''}`;
    const avLines = avLinesOf(env.tierLines, env.lowerIsBetter !== false);
    const lowerIsBetter = env.lowerIsBetter !== false;
    // 该副本的判据线取值（用户 2026-10-11 第四轮）：绝境单独一套（满分线以内 1.00、
    // 达标线 0.60）。**在这里算一次**、整段算分共用 —— 逐条调用点各算一次迟早会漏。
    const perfWeights = perfLineWeightsOf(env);
    // 成绩分布（每期投稿的分位数，建库时算好）：把「提升」换算成「击败比例」。
    const dist = env.dist || null;
    const pctOf = (value) => percentileOf(value, dist, lowerIsBetter);
    const rows = [];
    for (const team of env.teams || []) {
      const members = team.sample?.members || [];
      // 没有配装明细的阵容算不出边际成本，只能跳过（而不是假装免费）。
      if (!members.length) continue;
      const tier = majorityTierOf(team.tierCounts);
      if (!tier) continue;
      rows.push({
        team,
        tier,
        score: scoreOf(tier, team.avgAv, avLines, avWeight),
        // 绝境王棋关这类副本的成绩记在 `bestAv` 里，`avgAv` 可能是 null——
        // 只认 avgAv 会让基线算不出「击败比例」，于是整条链退回旧的档位分。
        pct: pctOf(team.avgAv ?? team.bestAv),
        cost: marginalCostOf(members, availability, account),
        // 这套作业的**总成本（金）**：判断「压金 0T」用的是它，不是「你还差几个」。
        teamCost: Math.max(0, Number(team.cost) || 0),
        // 聚合阵容可以提供行动值缺失时的兼容回退；正式总榜优先使用逐配置记录。
        actionValue: Number.isFinite(Number(team.bestAv)) && Number(team.bestAv) > 0
          ? Number(team.bestAv) : null,
      });
    }

    // ---- 前沿的「整包」证据（用户 2026-10 口径；v15 定单位，v16 加版本维度）--------
    //
    // 总榜的单位是**整包** = 角色本体 + 星魂目标档 + 光锥（含叠影），绑成一条：
    // 不再拆成「角色本体 / 星魂档 / 光锥」三行，也不算「某个星魂自己的造价」。
    //
    //   sScore(整包, 副本, 版本) = 100 × 档位权重 × 行动值项 × (该副本最便宜金数 ÷ 该配置金数)
    //   envScore(整包, 副本)     = Σ_版本 W(版本) × sScore ÷ Σ_版本 W(版本)
    //   total(整包)              = Σ_副本  副本权重 × envScore
    //
    // **分母为什么是「该配置的队伍金数」而不是「整包自己的金数」**：用户的口径是
    // 「根据达成 0T 的金数更少决定性价比」，举例 银狼 E2S1 > 砂金·戏浪 E6S0 >
    // 砂金·戏浪 E6S1 —— 这三条的依据是**各自队伍**的 7 / 9 / 10 金。若把整包自身
    // 金数当分母，1 金的 E0 整包会把榜首全部占满（实测：1 金整包并列 100.00、
    // 银狼 E2S1 掉到 25.00），与用户给的三条排序直接矛盾。
    //
    // **「× 该副本最便宜金数 ÷ 该配置金数」不是可选的美化**：不归一化就把绝对金数
    // 跨副本相加，混沌回忆里存在 1 金 0T 队（100 分），会把绝境 7 金队（14 分）压
    // 下去，用户定的「绝境 10、其余 1」整张权重表随之失效。
    //
    // 0 金整包（4★ / 常驻 / 开拓者，且没有限定光锥）不进榜：它们是抽限定时的副产物，
    // 既不能单独抽，也不该和「要花金」的整包排在同一个性价比榜上。
    {
      const packRows = frontierPackRowsOf(env, frontier[id], rows, availability);
      if (packRows.length) {
        // ⚠️ `Math.max(1, …)`：0 金行按 1 金记账（理由见 `minCostBySeason` 的注释）。
        // 这个数是**全窗口**最小值，既当 `denomCostOf()` 的最后兜底，又下发给界面当
        // `frontierEnvs[].minCost`（`frontierFactorsOf` 在拿不到 `seasonMinCost` 时用它）
        // —— 让它变成 0 会把界面上那些兜底的金数项一起打成 0。
        const minCost = Math.max(1, Math.min(...packRows.map((r) => r.cost)));
        const avValues = packRows.map((r) => r.actionValue).filter((v) => v !== null);
        const avLo = quantileOf(avValues, 0.05);
        const avHi = quantileOf(avValues, 0.95);
        // 行动值只有落在有效区间内才参与打分；缺失时**不乘**这一项（乘 0.5 等于把
        // 「没测到」当成「测得很差」），并在证据里标出来，界面据此写「行动值缺失」。
        const avUsable = avLo !== null && avHi !== null && avHi > avLo + 1e-9;
        const lowerIsBetter = env.lowerIsBetter !== false;

        // ---- 版本维度（用户 2026-10 第 6、7 条）------------------------------
        //
        // v15 的整包取值是「它出现过的所有配置里的最高分」—— 那让**只有一两个版本
        // 数据的新角色**和**横跨七个版本的老角色**在同一条尺子上比，而且新角色还
        // 会被旧版本更低的金数水位压住。v16 把版本显式做成一个维度：
        //
        //   W(s)    版本权重 2:2:2:1:1:1:1（第 7 条：近 1-3 版本 2 分、近 4-7
        //           版本 1 分）。**优先读服务端发来的 `seasonWeights`**
        //           （archive.js 用同一张 `VERSION_WEIGHTS` 现算）；本地夹具没有
        //           它时按同一个「距最新版本几个版本」的下标口径回退。
        //           权重 0 = 不进窗口（第 8 个版本起）。
        //   sScore  该版本的实测分（池 = 窗口内全部达标/满分行，见第二趟注释）。
        //           这个整包在该版本**没有证据**时分两种：早于登场 → **不参与平均**；
        //           已登场 → **算 0 分**。
        //           ⚠️ v4.6.47~v4.6.56 这里曾是「按场地水平等比例放大」
        //           （amp = clamp(水平比, 1, creepAmpMax)），v4.6.60 废除 —— 实测它会让
        //           推算分反超实测分（榜首真珠实测只占 15.4%）。
        //           v4.6.7x 还插过第三态「有人用但没进最便宜 25% 前沿 → 按质量梯度估算」，
        //           v4.6.78 随池改成全部成绩一起删除。
        //
        // 服务端发的 `seasons` 是窗口内**全部**版本（升序），所以「缺证据的版本」
        // 是明确可知的；夹具没有它时退化成「只用有证据的版本」。
        const seasonOrder = [...(frontier[id]?.seasons || [])].reverse(); // 新 → 旧
        const observedSeasons = [...new Set(packRows.map((r) => r.season).filter(Boolean))];
        const windowSeasons = seasonOrder.length
          ? [...seasonOrder, ...observedSeasons.filter((s) => !seasonOrder.includes(s))]
          : observedSeasons;
        const seasonWeightOfRow = (s) => {
          const fromServer = frontier[id]?.seasonWeights?.[s];
          if (Number.isFinite(Number(fromServer))) return Number(fromServer);
          const idx = seasonOrder.indexOf(String(s));
          return idx >= 0 ? versionWeightOf(idx) : 1;
        };
        /**
         * 整包累计：`整包键 -> { …, bySeason: Map(版本 -> 该版本最好的一条证据) }`。
         *
         * 分两趟填：第一趟逐条配置算分、按「整包 × 版本」留最好的一条；第二趟才知道
         * 这个整包在**窗口内每个版本**有没有证据（缺的那种还要按登场版本区分「不参与」
         * 与「算 0 分」），再按版本加权求和。
         *
         * （`levelOf` / 场地水平中位数随「放大推算」一起废除，见第二趟注释。）
         */
        const perPack = new Map();
        /** 这条配置里用了几个**限定光锥**（第 10 条的次级判据：金数相同时它多者强）。 */
        const limitedConesOf = (members) => members
          .filter((m) => m.lc && coneCostOf(m.lc, availability) > 0).length;

        /**
         * **各版本自己的最便宜金数**（用户 2026-10-10 第 5 轮：金数项必须按版本归一）。
         *
         * ⚠️ 这里以前用 `minCost`（整个窗口取最小值，见上面的注释）当**所有版本**的分母。
         * 实测那会把「环境本身就难压金」的版本当成「队伍不够省」来罚，而且罚得恰好是
         * 权重最高的当前版本：
         *
         *   绝境各版本最便宜：4.0→10 / 4.1→11 / 4.2→7 / 4.3→10 / 4.4→7 / 4.5→9 / 4.6→8
         *   全局 minCost = 7（来自 4.2 与 4.4）→ 拿它当分母时，4.1 的「本期最省队」
         *   只能拿 7÷11 = 0.636，4.6 的（8 金）只能拿 0.875，而 4.2/4.4 的拿满 1.000。
         *   24 个「副本×版本」组合里 **18 个吃亏**，且吃亏的几乎都是权重 2 分的那几档。
         *
         * 用户口径要的是「同一把尺子量队伍」：**在同一个版本内部**，谁花的金少谁强。
         * 各版本之间压金难度不同（那是**环境**差异，不是队伍的优劣），所以分母也应当
         * 按版本各取各的 —— `该版本最便宜 ÷ 本队金数`，再按版本权重加权汇总。
         *
         * 跨副本的「绝对金数不可比」问题不受影响：归一化仍在**副本内**做（各副本的
         * 金数水位本来就差很多，混沌 1 金 vs 绝境 7 金），所以「绝境 10、其余 1」那张
         * 副本权重表照旧成立。
         */
        const minCostBySeason = new Map();
        /**
         * **「最好一档」的最便宜金数**（用户 2026-10-11 缺陷 2 修）：金数项的分母。
         *
         * 文档（v22 与 `frontierFactorsOf`）写的口径一直是「达到**最好一档**的最便宜
         * 那支」，但这里此前**不分档位**、直接取该版本所有行的最小 —— 于是 target 档
         * （达标）比 perfect 档更便宜时，会把 perfect 档队伍的金数项系统性压低：
         *
         *   实测 异相仲裁·绝境 6/7 个版本被拉低（4.6 的 perfect 最便宜 9 金、target 8 金
         *   → 分母被写成 8），24 个「副本×版本」组合里 18 个吃亏，吃亏的几乎都是
         *   权重 2 分的那几档。混沌回忆 0/7、虚构叙事 0/7（那两处 target 档极少且不更便宜）。
         *
         * 修法：分母改取**该版本 perfect 档的最小金数**；该版本没有 perfect 档时
         * （例如末日幻影 4.0~4.2 全是 target）才退回该版本全档最小。
         * `minCostBySeason`（全档最小）保留，只用于展示与兜底 —— 界面上
         * `frontierEnvs[].minCostBySeason` 与 `herta-test` 的断言都读它。
         *
         * ⚠️ **2026-10-11 第 3 条起，0 金行按 `Math.max(1, row.cost)` 记账**
         * （`billable`）：隐金把一支队减到 0 金之后，若让 0 参与取最小，该版本的分母
         * 就变成 0 → 同版本**所有**队伍的金数项一起变 0（实测踩点见 `adjustedCost` 的注释）。
         * 0 金那一档不再靠分母占便宜，而是靠 `frontierCostTermOf()` 的固定 1.2 倍率。
         */
        const minCostBySeasonBest = new Map();
        for (const row of packRows) {
          const s = row.season || '';
          const billable = Math.max(1, row.cost);
          const cur = minCostBySeason.get(s);
          if (cur === undefined || billable < cur) minCostBySeason.set(s, billable);
          if (row.tier === 'perfect') {
            const best = minCostBySeasonBest.get(s);
            if (best === undefined || billable < best) minCostBySeasonBest.set(s, billable);
          }
        }
        /** 该版本的金数项分母：最好一档（perfect）最便宜，缺 perfect 档时退回全档最小。 */
        const denomCostOf = (season) => minCostBySeasonBest.get(season)
          ?? minCostBySeason.get(season) ?? minCost;

        // ---- 第一趟：逐条配置算分，按「整包 × 版本」留下该版本最好的一条
        for (const row of packRows) {
          // 表现分：**档位与行动值合并成一条连续曲线**（用户 2026-10-11 缺陷 3 修）。
          // 以前是 `tierWeight × avTerm` —— 同一维度乘两次（档位本就由行动值推出），
          // 跨判据线时会跳变 2.0~2.3 倍。现在以游戏判据线为唯一标尺：
          // 满分线 = 1.00、达标线 = 0.50（与旧档位权重在线上完全一致），线之间连续。
          const perf = perfFactorOf(row.actionValue, env.tierLines, lowerIsBetter, row.tier, perfWeights);
          if (!(perf > 0)) continue;
          // 金数项的分母 = **本版本最好一档（perfect）**的最便宜金数（用户 2026-10-11
          // 缺陷 2 修：以前不分档位取该版本全档最小，target 档更便宜时会把 perfect 档
          // 系统性压低 —— 实测绝境 6/7 个版本被拉低）。取不到时退回该版本全档最小、
          // 再退回全局，保底不为 0。
          const seasonMinCost = denomCostOf(row.season || '');
          // 金数项走**唯一**那个函数（用户 2026-10-11 第 3 条）：封顶 ×1、0 金通关 ×1.2。
          // ⚠️ 不要在这里写回裸的 `seasonMinCost / row.cost` —— 那会绕过封顶，
          // 而且与 `frontierFactorsOf()` 分叉（界面上的因子就乘不回榜上这个分了）。
          const costFactor = frontierCostTermOf(seasonMinCost, row.cost);
          const score = SCORING.frontierPackScale * perf * (costFactor ?? 1);
          // 同一条配置里的成员共享这份证据 —— 这是「只看队伍整体强度」的直接推论，
          // 所以同一支队伍的成员必然同分。
          const rosterKey = packRosterKeyOf(row.members);
          const limitedCones = limitedConesOf(row.members);
          const hit = {
            score,
            // **纯强度**（用户 2026-10-12 第 3 条）：同一份 `perf`，只是不乘金数项。
            // 抽卡方案的「强度得分」读它 —— 总榜自己仍按 `score` 排（口径没动）。
            strength: packStrengthOf(perf),
            tier: row.tier,
            actionValue: row.actionValue,
            // 兼容旧字段名：界面与浮层拆因子时读它（现在 = 合并后的表现分）。
            avScore: perf,
            perf,
            cost: row.cost,
            // 这条证据所在版本的「最便宜金数」—— 算分时它就是这个版本的金数项分母，
            // 界面要把贡献拆成「来源」就得拿到同一个数（见 `frontierFactorsOf`）。
            seasonMinCost,
            season: row.season,
            limitedCones,
            rosterKey,
            members: row.members.map((m) => ({
              char: m.char, eidolon: m.eidolon, lc: m.lc || null, superimp: m.superimp,
            })),
          };
          for (const m of row.members) {
            const gold = packGoldOf(m, availability);
            // 进榜判据用**原始**金数（用户 2026-10-11）：隐金把某个整包减到 0 金时它
            // **仍然留在榜上**，否则「角色兑换 / 常驻角色」那两组一勾选就整批消失，
            // 用户根本看不到效果（而那正是他要的：这些单位现在是 0 成本）。
            if (gold <= 0) continue;
            const key = packKeyOf(m);
            let pack = perPack.get(key);
            if (!pack) {
              pack = {
                key,
                char: m.char,
                eidolon: m.eidolon,
                lc: m.lc || null,
                superimp: m.superimp,
                // `gold` 是**原始**整包金数：进榜判据与「隐金后印多少」都由它推出来。
                gold,
                bySeason: new Map(),
                // 证据广度只用于展示（「出现在 N 条达标配置」），不参与排序。
                configs: new Set(),
                seasons: new Set(),
              };
              perPack.set(key, pack);
            }
            pack.configs.add(rosterKey);
            if (row.season) pack.seasons.add(String(row.season));
            const season = row.season || '';
            const cur = pack.bySeason.get(season);
            // 同一个版本里取分最高的那条；**分完全相同时取限定光锥更多的那条**
            // —— 用户第 10 条：两个队伍金数完全相同时，用更多限定光锥的更强。
            if (!cur || hit.score > cur.score
              || (hit.score === cur.score && hit.limitedCones > cur.limitedCones)) {
              pack.bySeason.set(season, hit);
            }
          }
        }

        // ---- 第二趟：按版本加权求和（缺证据的版本分两种，见下）
        //
        // ⚠️ 这一段的历史很长，动手前先读完，**别再走回头路**：
        //
        //   v4.6.46~v4.6.56「按场地水平等比例放大」：缺证据的版本按场地水平放大到 2 倍。
        //     实测它会**反超实测分**（榜首真珠唯一实测的那版只占 140/910 = 15.4%），
        //     于是「版本因子」余数 > 1 —— v4.6.60 整套废除。
        //   v4.6.60 定为两态：早于登场 → **不参与平均**；已登场 → **算 0 分**。
        //   v4.6.7x（「缺陷 1 修」）又插进第三态：「已登场、有人用、但没挤进最便宜 25%
        //     前沿」→ 按最佳投稿质量**梯度估算**。v4.6.78 把池改成**全部成绩**之后这一态
        //     不复存在（有成绩就一定在池里），估算随之删除 —— 它与分母不同源，正是
        //     「跨版本发挥 > 1」的根因（实测绯英 E6+邂逅S5 在绝境 ×1.50）。
        //
        // 现在（v4.6.78）只有两种「缺」：
        //   有证据                → 实测分（池 = 窗口内全部达标/满分行）
        //   缺证据 且 **早于登场** → 不参与平均（不进分子也不进分母）——「无从判断」
        //   缺证据 且 **已登场**   → **算 0 分**（权重进分母、分子不加）——「明确的差」
        //
        // ⚠️ **「已登场」那一态曾实现成「权重不进分母」**（把那一版从平均里整个去掉），
        // 理由是「只知道没有观测，不知道它实际多强」。用户 2026-10-10 明确否掉：
        //「**应该算0分，没排名说明完全无人使用**」—— 没有任何成绩不是「未知」，而是
        //「明确的差」：一个整包在它已经存在的版本里没有任何人用，说明它在那版确实不受
        // 认可；把明确的差当成不知道，会让「只在某一版能用」的整包凭空拿到接近满分的成绩。
        //
        // 连带影响：`score / base` 这个「版本因子」余数恒 ≤ 1（分子被压小、分母不变），
        // 它重新变回一个**折扣**，且天然表达「观测到的版本里，有多少被无人使用拖低了」。
        // `droppedSeasons` 仍要下发：界面靠它说明「N 个版本已登场却没有任何成绩（算 0 分）」，
        // 否则读者会以为那一版的分数是别的原因低。
        const firstSeen = options.firstSeen || {};
        // ⚠️ **必须用「本副本」的版本号去比本副本的窗口**（2026-10-10 修）。
        //
        // 黑塔网四个副本**各用一套版本号**（实测当前进度：异相仲裁 4.6 / 混沌回忆 4.5 /
        // 末日幻影 4.6 / 虚构叙事 4.5），同一期真实日期在不同副本里编号不同。以前只存
        // 一份跨副本取最小值的全局 `firstSeen`，拿它去比每个副本的窗口，判定就会错位。
        //
        // 实测真珠：她最早投稿是 2026-09-28，那期在异相仲裁是 **4.6**、在混沌回忆是
        // **4.5**，全局值记成 4.5。拿 4.5 去比异相仲裁的窗口 `[4.0…4.5,4.6]` 时，
        // 4.5 被判成「已登场却无人使用 → 算 0 分」，而那一期真实日期是 2026-08-26
        // （比真珠首次出现早一个月）→ 版本因子被压到 ×0.50（用户 2026-10-10 问到的那个）。
        //
        // 取值优先级：本副本（`byMode[全名]`）→ 全局兜底（老数据集 / 测试夹具没有 byMode）。
        // ⚠️ 键要用**数据集里的模式全名**，所以短码（`aa`）必须先过 `MODE_ALIASES`
        // 翻成 `Anomaly Arbitration` —— `env.mode` 给的是短码，直接拿去查会全部落空，
        // 静默退回全局值（那正是这次要修的 bug，实测踩过）。
        const fullMode = MODE_ALIASES[String(env.mode || '')] || String(env.mode || '');
        const seenFor = firstSeen.byMode?.[fullMode] || firstSeen;
        const firstSeenOf = (pack) => {
          const charBorn = seenFor.characters?.[pack.char] || null;
          const coneBorn = pack.lc ? (seenFor.lightCones?.[pack.lc] || null) : null;
          const known = [charBorn, coneBorn].filter(Boolean);
          if (known.length) {
            // 整包 = 角色 + 光锥，取**较晚**登场的那个：早于它的版本里它不可能存在。
            return known.reduce((a, b) => (cmpVersion(a, b) >= 0 ? a : b));
          }
          // 没有登场数据（本地夹具 / 老数据集）→ 退回「它在窗口里最早的证据版本」。
          // 这是保守的近似：至少不会把**更新的**版本也当成「还没登场」。
          const observed = [...pack.bySeason.keys()].filter(Boolean);
          return observed.length
            ? observed.reduce((a, b) => (cmpVersion(a, b) < 0 ? a : b)) : null;
        };

        const packs = new Map();
        for (const [key, pack] of perPack) {
          let best = null;
          for (const hit of pack.bySeason.values()) {
            // 最好那一条 = 这一行的「最佳证据」；同分同样用限定光锥多者（第 10 条）。
            if (!best || hit.score > best.score
              || (hit.score === best.score && hit.limitedCones > best.limitedCones)) best = hit;
          }
          if (!best) continue;
          const born = firstSeenOf(pack);
          let wSum = 0;
          let acc = 0;
          /**
           * 与 `acc` 同一条版本加权的**纯强度**累计（用户 2026-10-12 第 3 条）。
           *
           * 刻意与 `acc` 并排放在这里，而不是事后再算一遍：版本加权、「早于登场不参与
           * 平均」「已登场却没有任何成绩算 0 分」这三条规则对两者**必须完全一致**，
           * 分开写迟早会分叉（那就是「强度得分与总榜分对不上」）。
           */
          let strAcc = 0;
          /** 早于登场的版本数（不参与平均，见下）。 */
          let absentSeasons = 0;
          // 用户 2026-10-10：已登场却缺证据的版本**算 0 分**（权重进分母，分子不加）。
          let droppedSeasons = 0;
          for (const s of windowSeasons) {
            const w = weightOr(seasonWeightOfRow(s), 1);
            if (!(w > 0)) continue;
            const observed = pack.bySeason.get(s);
            if (observed) {
              wSum += w;
              acc += w * observed.score;
              strAcc += w * observed.strength;
              continue;
            }
            // 缺证据只有**两种**「缺」，它们不是同一种（v4.6.78 起）：
            //   ① 那一版整包**还不存在**（早于登场）→ 不参与平均（既不奖也不罚）
            //   ② 那一版它已在、但**没有任何成绩** → 算 0 分（明确的差）
            //   ③ 权重为 0（用户把该版本关掉）→ 已在上面 `continue` 掉
            //
            // ⚠️ 这里曾经有**第三种**：「已登场、有人用、但没挤进最便宜 25% 前沿」，
            // 它走「按最佳投稿质量梯度估算」。v4.6.78 把池改成**全部成绩**之后这种
            // 「缺」不复存在（有成绩就一定在池里），估算分支随之删除。删它的**真正理由**
            // 是它与分母不同源：估算值取自未截断的全部行，而分母（`best`）只从池内挑，
            // 于是「跨版本发挥」能算出 > 1（实测绯英 E6+邂逅S5 在绝境 ×1.50）。
            const older = born !== null && cmpVersion(s, born) < 0;
            if (older) {
              // ---- ① 早于登场：**不参与平均** ----
              //
              // 用户 2026-10-10（第二轮）确认的口径。历史脉络值得完整留着，这里返工过两次：
              //
              //   v4.6.46：对所有缺证据版本都放大，且没有登场概念 → 锚在旧版本的整包对
              //            **更新的**版本也吃放大，分数被抬 1.7 倍。
              //   v4.6.47：只对「早于登场」的版本放大（第 6 条），但放大仍**进分母**。
              //   现在   ：早于登场 → 整个不参与。因为实测发现「放大」会**反超实测分**：
              //            榜首真珠 E2 唯一实测的那版只贡献 140/910 = **15.4%**，其余
              //            全是它 4.5 才登场、却在 4.0~4.4（当时不存在）按 ×2 推出来的分，
              //            于是「版本因子」余数 > 1（实测 ×1.30）。
              //
              // 为什么不放大也不罚：用户第 6 条的本意是「不罚新角色」，而**不参与 ≠ 罚**。
              // 一个整包在它还没登场的版本里根本没有可评的东西 —— 给它加分（放大）是
              // 编造，给它 0 分是冤枉，唯一诚实的做法是**从平均里去掉**。
              // 这与 ②「已登场但没有任何成绩 → 算 0 分」正好互补：② 是**明确的差**
              // （数据说了话），① 是**无从判断**（数据还没轮到它）。
              absentSeasons += 1;
              continue;
            }
            // ---- ② 已登场、但这一版**没有任何成绩**：算 0 分 ----
            //
            // 用户 2026-10-10 原话：「应该算0分，没排名说明完全无人使用」。
            // ⚠️ 这里也曾实现成「权重不进分母」（当成"没有观测"处理），那是错的：
            // 「没有任何成绩」不是**未知**，而是**明确的差** —— 一个整包在它已经存在
            // 的版本里没有任何人用，说明它在那个版本确实不受认可。把明确的差当成
            // 不知道，会让「只在某一版能用」的整包凭空拿到接近满分的成绩。
            //
            // ⚠️ v4.6.78 起判据就是 `pack.bySeason`（池 = 全部成绩，两者等价），
            // 所以「有人用但没进池」这个中间态**不存在**了 —— 不需要再拿一份「未截断
            // 观测集」去防误杀（那套 `observedPacks` / `observedPackScores` 已删）。
            //
            // 所以 `wSum += w`（那一版仍占权重）而 `acc` 不加 —— 分母照算、分子为零。
            droppedSeasons += 1;
            wSum += w;
            continue;
          }
          // 权重为 0 的版本不进分母（用户可以把某个版本权重调成 0 = 不进窗口）。
          // 若整包在**所有有效权重**的版本上都没观测 → wSum 为 0 → 不进榜。
          // （注意：`windowSeasons` 会把「有观测但不在窗口里」的版本并进来，所以每个
          //  存在的整包至少有一版观测；`wSum === 0` 只可能出现在权重全为 0 的情形。）
          if (!(wSum > 0)) continue;
          // ---- 隐金后**榜上印的那个金数**（用户 2026-10-11）------------------------
          //
          // 榜上每行印的 `N 金` 是**整包自己**的金数（角色本体 + 星魂 + 光锥），用户要求
          // 它跟着隐金一起减少 —— 否则「隐金」只改了分数，界面上完全看不出发生过什么。
          // 它**不参与排序**（排序只看 `score`），所以这里改了不影响名次的定义。
          //
          // 归属按**最佳证据那一支队伍**算：同一个整包在不同队伍里归属可能不同
          // （Archer 单独 -2、与吉尔伽美什同队 -1；自选组那 1 金记在第一个命中的成员上），
          // 而榜上展示的「最佳证据」就是这一行，两处必须是同一支队伍的账。
          const ownCut = hiddenReductionOf(best.members, availability, undefined, 'tiered')
            .byKey.get(key) || 0;
          packs.set(key, {
            ...pack,
            gold: Math.max(0, pack.gold - ownCut),
            // 原始金数留着：探针与回归测试要能区分「本来就是 0 金」与「被隐金减到 0 金」。
            rawGold: pack.gold,
            hiddenCut: ownCut,
            score: acc / wSum,
            // **纯强度**（不含金数项，用户 2026-10-12 第 3 条）：抽卡方案「强度得分」的来源。
            // 与 `score` 同一条版本加权，所以 `strength ≥ score` 只在金数项 ≤ 1 时成立
            // （0 金通关那一档的 1.2 是唯一会让它反过来的情形），回归用例钉的是这条。
            strength: strAcc / wSum,
            // `absentSeasons` = 早于登场、**不参与平均**的版本数（不奖不罚）。
            absentSeasons,
            // `droppedSeasons` = 已登场却**没有任何成绩**、算 0 分的版本数（明确地差）。
            // ⚠️ 它与 `absentSeasons` 含义**相反**，界面必须分开说 —— 合起来报会让读者
            // 以为它们同类。（v4.6.78 删掉了第三个字段 `unrankedSeasons`：池 = 全部成绩
            // 之后「有人用但没进池」不存在。）
            droppedSeasons,
            bornSeason: born,
            evidence: {
              cost: best.cost,
              tier: best.tier,
              actionValue: best.actionValue,
              avScore: best.avScore,
              season: best.season,
              // 最佳证据**所在版本**的最便宜金数 —— 金数项的分母（用户 2026-10-10
              // 第 5 轮）。⚠️ 必须在这里带上：`frontierFactorsOf` 靠它复现金数项，
              // 漏了会退回 `meta.minCost`（全窗口最小值）→ 浮层与榜上的分对不上。
              seasonMinCost: best.seasonMinCost ?? null,
              limitedCones: best.limitedCones,
              members: best.members,
              bornSeason: born,
            },
          });
        }
        const live = new Map([...packs].filter(([, pack]) => pack.evidence && pack.score > 0));
        if (live.size) {
          frontierPacks.set(id, live);
          frontierMeta.set(id, {
            envLabel: env.label || id,
            mode: env.mode,
            stage: env.stage || '',
            // 判据线（`0T` / `积分 4000` / `行动值 <300` 那三条）：界面要把档位写成
            // **游戏内实际的量**（用户 2026-10-10：「把『满分』『达标』改为具体的行动值」），
            // 而这三条线只存在数据里，编不出来 —— 必须随副本元数据一起发给界面。
            // 见 `tierTextOf()` 与 `frontierEnvs` 的下发处。
            tierLines: env.tierLines || null,
            // ⚠️ 口径必须显式写 `'frontier'`：总榜只吃界面上「关卡权重」那一行，
            // 抽卡方案那边调权重不该动它（用户 2026-10 要求两套权重相互独立）。
            // 服务端已经按请求的 frontierWeights 计算了环境权重；没有服务端前沿表
            // 的本地夹具才回退到本地默认/覆盖值。
            weight: Number.isFinite(Number(frontier[id]?.weight))
              ? Number(frontier[id].weight)
              : envWeightOf(env.mode, env.stage || '', 'frontier'),
            pool: packRows.length,
            // `minCost`（全窗口最小值）**不再用于算分**，只作为展示/兜底：
            // 算分与浮层金数项都用逐条的 `seasonMinCost`（用户 2026-10-10 第 5 轮）。
            minCost,
            // 逐版本的最便宜金数：界面若想解释「为什么这一版的金数项是 0.875」用得着，
            // 也方便排查（`seasonMinCost` 取不到时它就是兜底来源）。
            minCostBySeason: Object.fromEntries(minCostBySeason),
            maxCost: Math.max(...packRows.map((r) => r.cost)),
            minAction: avValues.length ? Math.min(...avValues) : null,
            maxAction: avValues.length ? Math.max(...avValues) : null,
            // 行动值项的**区间边界**（5%~95% 分位）与方向：界面要把一条贡献拆成
            // 「来源」（权重 × 档位 × 行动值 × 金数 × 版本）就必须按**算分时用的
            // 那两个数**复现 `avTerm`。`minAction` / `maxAction` 是最值，不是这里
            // 的边界，拿它们算会和榜上的分对不上。
            avLo: avUsable ? avLo : null,
            avHi: avUsable ? avHi : null,
            lowerIsBetter,
            // 版本维度（第 6、7 条）：窗口内的版本数，以及每个版本的权重。
            // 界面据此写「按 7 个版本加权」，不必自己再抄一遍权重表。
            versionWindow: VERSION_WINDOW,
            seasons: [...windowSeasons],
            seasonWeights: Object.fromEntries(windowSeasons.map((s) => [s, seasonWeightOfRow(s)])),
          });
        }
      }
    }

    // 基线：0 抽就能照抄的作业里能稳定打到的最高分。
    const free = rows.filter((r) => r.cost.pulls === 0);    const baseScore = free.length ? Math.max(...free.map((r) => r.score)) : 0;
    const baseRow = free
      .filter((r) => r.score === baseScore)
      .sort((a, b) => (a.team.avgAv ?? Number.POSITIVE_INFINITY)
        - (b.team.avgAv ?? Number.POSITIVE_INFINITY))[0] || null;
    // 你现在的击败比例（0~1）。基线不到顶时它才有提升空间。
    const basePct = baseRow ? pctOf(baseRow.team.avgAv ?? baseRow.team.bestAv) : null;

    // ---- 三个「好打」的副本走**达标成本**口径（用户明确指定，2026-10）
    //
    // 原话的意思：末日幻影 / 混沌回忆 / 虚构叙事不算难，达标（满分 / 0T）本身不难，
    // 所以「击败比例」在这里恒等于 0（实测混沌回忆中位数就是 0 回合），看不出价值。
    // 真正有信息量的是「含这个角色的达标队伍，最低要多少成本」——比别的角色更低，
    // 就说明这个角色强（能把队伍成本压下来），而不是看它被投稿了多少次。
    //
    // 成本用**期望抽数**算：限定角色 94 抽 / 活动跃迁光锥 67 抽（见 PULLS_PER）。
    const easy = isEasyMode(env.mode, env.stage);
    // ---- 投稿质量分 q = perf^α × pars × trust（用户口径，2026-10）
    //
    // 用户的要求：**先用算法挑出值得参考和学习的投稿**（尤其异相仲裁），得分高的队伍里
    // 角色/星魂/光锥权重高；带了**非关键金**的队伍自然失去权重。
    //
    //   perf  成绩在人群分布里的位置（越低越好的模式取 1−击败比例）——不是档位分。
    //         异相仲裁成绩分布最宽（实测绝境 p05=33 / p50=273 / p95=495），所以同一把
    //         尺子下它的高分队伍会自然浮上来。
    //   pars  1/(1+λ·额外限定数)：额外限定数 = 本队限定单位数 − 本期最好成绩里出现过的最低
    //         限定数。多带一个非关键金 → 权重砍半（λ=1）。
    //   trust 样本量可信度（数据集已有）。
    const minCost = rows.length ? Math.min(...rows.map((r) => r.teamCost)) : 0;
    const qualityOf = (r) => {
      const perf = r.pct === null ? 0.5 : Math.max(0, Math.min(1, r.pct));
      const extra = Math.max(0, r.teamCost - minCost);
      const pars = 1 / (1 + SCORING.parsimonyLambda * extra);
      // 投稿条数只进入 evidence 文案；不能因为同一阵容投稿多就把它的成绩
      // 乘高，也不能把只有少量投稿但行动值更低的高质量阵容压下去。
      return Math.pow(perf, SCORING.perfAlpha) * pars;
    };
    for (const r of rows) r.q = qualityOf(r);

    /** 档位好坏排序（用于判断「升这一档有没有把档位推上去」）。 */
    const tierRankOf = (t) => ({ perfect: 3, target: 2, pass: 1 }[t] ?? 0);

    /**
     * 星魂档的**配对证据汇总**（本副本**全部**阵容，不只参考集）。
     *
     * 修正B 的口径就是「同一 roster 在 from 与 target 两个档位下的成绩差」。
     * 关键点：按 (角色, from, target) 汇总**整个副本**的证据，而不是只看候选行
     * 恰好落在的那一套阵容——候选行用哪套阵容是搜索的结果，不该反过来决定
     * 一个档位值不值。花火 E2→E3 两次爬回榜上都是这个耦合造成的：
     * 先是被跨阵容退路（③）放行，后是候选行刚好落在一套没有 E2 对照的阵容上，
     * 于是「量不出来」被当成「中性」满额放行。
     *
     * 汇总只统计**档位变好**的配对（`tierUp`）：一次都没把档位推上去，
     * 这一档就只是多花 1 金 → 贡献 0。这正是「结构档 vs 数值档」的可算版本。
     */
    const eidoAgg = new Map();   // `${角色}|${from}|${to}` → { n, tierUp, upCosts, upDeltas }
    for (const r of rows) {
      const eido = r.team.eidoPerf;
      if (!eido) continue;
      for (const [char, levels] of Object.entries(eido)) {
        const entries = Object.entries(levels || {})
          .map(([lv, v]) => [Number(lv), v])
          .filter(([lv]) => Number.isFinite(lv));
        if (entries.length < 2) continue;
        const perfs = entries.map(([, v]) => Number(v?.perf)).filter(Number.isFinite);
        const maxPerf = perfs.length ? Math.max(...perfs) : null;
        for (const [from, a] of entries) {
          for (const [to, b] of entries) {
            if (to <= from) continue;
            const key = `${char}|${from}|${to}`;
            if (!eidoAgg.has(key)) {
              eidoAgg.set(key, { n: 0, tierUp: 0, upCosts: [], upDeltas: [] });
            }
            const agg = eidoAgg.get(key);
            agg.n += 1;
            // 档位没变好（或反而变差）→ 这一档没有换来更好的成绩，不计入提升
            if (tierRankOf(b?.tier) <= tierRankOf(a?.tier)) continue;
            agg.tierUp += 1;
            if (Number.isFinite(Number(b?.cost))) agg.upCosts.push(Number(b.cost));
            const room = maxPerf === null ? null : maxPerf - Number(a?.perf);
            if (Number.isFinite(room) && room > 1e-6) {
              agg.upDeltas.push(Math.max(0, Math.min(1,
                (Number(b?.perf) - Number(a?.perf)) / room)));
            }
          }
        }
      }
    }

    // 参考集：按 q 降序取到**累计 80%**（自适应，用户选的），下限 10 套、上限 100 套。
    const ranked = [...rows].sort((a, b) => b.q - a.q);
    const qTotal = ranked.reduce((n, r) => n + r.q, 0);
    const refRows = [];
    let acc = 0;
    for (const r of ranked) {
      if (refRows.length >= SCORING.refMax) break;
      refRows.push(r);
      acc += r.q;
      if (refRows.length >= SCORING.refMin && qTotal > 0 && acc >= qTotal * SCORING.refCoverage) break;
    }
    const refSet = new Set(refRows);

    // ---- 「压金 0T」：用户口径（2026-10）
    //
    // 性价比的关键不是「这个单位被投稿了多少次」，而是**某个角色在它的配队里打出了
    // 很亮眼的压金 0T 成绩**——满分队伍里成本最低的那几套。所以这里对每个在满分队伍里
    // 出现过的单位，记「含它的最低成本」，再跟**常见成本（中位数，用户指定）**比：
    // 比常见解法便宜越多 → 这个单位越强。
    //
    // 参考成本取中位数而不是最贵的那套：取最贵会让所有单位都显得很便宜，榜单失真。
    const perfectRows = refRows.filter((r) => r.tier === 'perfect');
    const usualCost = medianOf(perfectRows.map((r) => r.teamCost));
    const cheapestWith = new Map();
    /** 光锥 → 装备它的角色（用来判断「抽了有没有人能用」）。 */
    const carrierOf = new Map();
    for (const r of perfectRows) {
      const cost = r.teamCost;
      for (const m of r.team.sample?.members || []) {
        for (const name of [m.char, m.lc].filter(Boolean)) {
          const cur = cheapestWith.get(name);
          if (cur === undefined || cost < cur) cheapestWith.set(name, cost);
        }
        if (m.lc && m.char) {
          if (!carrierOf.has(m.lc)) carrierOf.set(m.lc, new Set());
          carrierOf.get(m.lc).add(m.char);
        }
      }
    }
    /**
     * 强度分（0~100）：含它的最低达标成本比常见成本便宜多少。
     *
     * **只给角色与光锥用**。星魂不用这个：它量的是「含这个角色的作业压到多低」，
     * 而角色本体的成本优势 E0 就享受到了，拿它当星魂的分子等于让星魂借角色的名气
     * （修正④，见下面 `ownGainOf`）。
     */
    const strengthOf = (name) => {
      if (!Number.isFinite(usualCost) || usualCost <= 0) return 0;
      const cost = cheapestWith.get(name);
      if (!Number.isFinite(cost)) return 0;
      return Number((Math.max(0, (usualCost - cost) / usualCost) * 100).toFixed(3));
    };
    // 用户的第一条：**不考虑已有角色单独抽光锥是没法用的**。所以光锥只有在
    // 「装备它的角色你至少有一个」时才留在建议里；否则抽了也没人装。
    const ownedChars = account.owned instanceof Set ? account.owned : new Set(Object.keys(account.owned || {}));
    const coneUsable = (name) => {
      const carriers = carrierOf.get(name);
      if (!carriers || !carriers.size) return true; // 数据里看不到载体就不拦
      return [...carriers].some((c) => ownedChars.has(c));
    };

    // 候选**只从参考集里来**（修正缺陷②：以前参考集与候选集并行跑两套过滤，交集会是空的，
    // 权重白算）。参考集 = q 高的那批「值得参考和学习的投稿」。
    // 缺 ≤3 个单位（不再是 ≤2）：用户口径「缺体系有可能是直接抽整个体系也能有很大提升」，
    // 整套补的方案也要能进候选，跟「补 1 个就能用」在同一把尺子上竞争。
    // ---- 星魂档的**边际收益**（修正 B + 用户 2026-10 追问后的修正 ①③）
    //
    // 用户原话：「花火 E3 提升非常小，你要用合适的算法解决，而不是粗暴的加一条直接的限制」，
    // 紧接着又指出「知更鸟 E1→E2、刻律德菈 E1 这么强力的提升被你排在靠后」。
    //
    // 第一版的错误（已修）：拿 `r.pct`（击败比例）当「表现」。但三个好打副本里人人满分，
    // `pct` 恒为 0 → 边际 (0−0)/1 = 0 → **所有好打副本的星魂条目被乘成 0 整条消失**，
    // 刻律德菈 E1 就是这么被误杀的（知更鸟 E1→E2 只因在绝境里可量才活下来）。
    //
    // 现在每个副本用**驱动该副本价值的那把尺子**量成绩：
    //   * 好打副本：看**成绩档位**（score / maxScore）——升星魂能把你从 ≤2T 推到 0T，
    //     边际就高；只是数值小台阶、档位不变（E2→E3）→ 边际 ≈ 0。
    //     注意**不能**用成本当尺子：星的档位越高队伍成本越高，那样升星魂永远显得更差。
    //   * 难打副本：看击败比例（真实人群差异）。
    const maxScore = rows.length ? Math.max(...rows.map((r) => r.score)) : 0;
    const perfOf = (r) => {
      if (easy) return maxScore > 0 ? Math.max(0, Math.min(1, r.score / maxScore)) : null;
      return Number.isFinite(r.pct) ? r.pct : null;
    };
    // 修正②：**同阵容内比较**（like-for-like）。
    //
    // 旧版把「角色|档位 → 该档位能达到的最好成绩」跨阵容聚合，比出来的是**阵容差异**
    // 而不是星魂差异 —— 于是花火 E2→E3 拿到一个来路不明的正值、又爬回榜上。
    //
    // 现在只在**同一套阵容**（rosterKey 相同、只有成员星魂档不同）的作业之间量边际：
    // 成绩差就归因于星魂。同一阵容找不到「低档位」的对照时 → 视为「量不出来」，
    // 交给 eidolonMarginal 返回中性 1（不奖不罚），不再拿别的阵容凑数。
    // 建库侧按阵容分层存下来的「角色 → {星魂档: 最好成绩}」（越大越好）。
    // 这是修正②唯一能真正咬到的数据：聚合后的每套阵容只有一条代表记录，
    // 所以「同一阵容在不同星魂档的成绩」必须在建库时记下（见 tools/herta-build.mjs）。
    const rosterEido = new Map();
    for (const r of refRows) {
      if (r.team.eidoPerf) rosterEido.set(r.team.rosterKey || '', r.team.eidoPerf);
    }
    // 修正②：**同阵容内比较**（like-for-like）。
    //
    // 旧版把「角色|档位 → 该档位能达到的最好成绩」跨阵容聚合，比出来的是**阵容差异**
    // 而不是星魂差异 —— 于是花火 E2→E3 拿到一个来路不明的正值、又爬回榜上。
    //
    // 现在只在**同一套阵容**（rosterKey 相同、只有成员星魂档不同）的作业之间量边际：
    // 成绩差就归因于星魂。同一阵容找不到「低档位」的对照时 → 视为「量不出来」，
    // 交给下面的退路（③），不再让「量不出来」被当成「中性」满额放行。
    const eidolonPerf = new Map();   // `${rosterKey}|${char}` → Map(档位 → 该阵容该档的最好表现)
    const eidolonBest = new Map();   // `${char}|${档位}` → 该档位在所有阵容里的最好表现（退路）
    for (const r of refRows) {
      const perf = perfOf(r);
      if (perf === null) continue;
      const rosterKey = r.team.rosterKey || '';
      for (const m of r.team.sample?.members || []) {
        const level = Math.round(Number(m.eidolon) || 0);
        const prev = eidolonBest.get(`${m.char}|${level}`);
        if (prev === undefined || perf > prev) eidolonBest.set(`${m.char}|${level}`, perf);
        const rosterKeyOfChar = `${rosterKey}|${m.char}`;
        if (!eidolonPerf.has(rosterKeyOfChar)) eidolonPerf.set(rosterKeyOfChar, new Map());
        const perRoster = eidolonPerf.get(rosterKeyOfChar);
        const cur = perRoster.get(level);
        if (cur === undefined || perf > cur) perRoster.set(level, perf);
      }
    }
    /**
     * 升一档**多出多少分**：档位分布的期望值提升（0~1 分制，每个副本最多记 1）。
     *
     * 用户 2026-10 的关键指正：「这两个角色的星魂对改善出分和压金 0T 都相当重要，
     * 尤其是用现有阵容挑战异相仲裁 / 绝境王棋」——所以分子要能量出**关键金带来的
     * 出分**，而不是只判「常见档位有没有翻过去」。
     *
     * 为什么换成这个口径（取代原来的「目标档达标率 − 起始档达标率」）：
     *
     *   1. 达标率是**以常见档位为基准的二值化**量。低难副本里人人满分，基准就是满分，
     *      升档抬高的那部分**落在基准之上**，二值化之后被整个丢掉。
     *      实测：知更鸟 E1→E2 的达标率差是 95%→95% = 0，而档位分布的期望值其实在动。
     *   2. 期望档位等级是**连续的**，且直接就是「分」：达到满分的比例涨了多少，
     *      期望值就涨多少。这正是「多出分」的字面含义。
     *   3. 它对**地板与天花板一视同仁**：把原本打不满的那些投稿抬到满分（保底更强）
     *      和让已经满分的人更快，都体现在同一个数上。
     *
     * 每个副本最多记 1 分（`min(1, ·)`）：不改这个上限的话，各个副本的档位分布
     * 离散程度不同（实测虚构叙事的原始 Δ 能到 +2.5，异相仲裁只有 +0.23），
     * 「哪个副本人人满分」会盖过「哪个副本重要」。夹到 1 分之后，**副本权重**
     * 才真正决定优先级——这也是用户要求「继续提高异相仲裁和王棋的权重」的前提。
     *
     * @param {Map<string, Map<number, {n:number, tiers:number[]}>>} agg 副本级档位分布累计
     * @param {string} name 角色名
     * @param {number} from 起始星魂档
     * @param {number} target 目标星魂档
     * @returns {number|null} 0~1 的期望档位提升；样本不足时 null（退回旧口径）
     */
    const gradeGain = (agg, name, from, target) => {
      const levels = agg.get(name);
      const a = levels?.get(from);
      const b = levels?.get(target);
      if (!a || !b) return null;
      const na = Number(a.n) || 0;
      const nb = Number(b.n) || 0;
      if (na < 1 || nb < 1) return null;
      const meanGrade = (entry) => {
        const tiers = Array.isArray(entry?.tiers) ? entry.tiers : null;
        if (!tiers) return null;
        const total = tiers.reduce((x, w) => x + (Number(w) || 0), 0);
        if (!total) return null;
        // tiers = [below, pass, target, perfect]，索引就是等级分。
        return tiers.reduce((x, w, r) => x + (Number(w) || 0) * r, 0) / total;
      };
      const ga = meanGrade(a);
      const gb = meanGrade(b);
      if (ga === null || gb === null) return null;
      // 样本折扣：按较少的那一档打折，样本够 `stabilityFullRuns` 条才拿满权重。
      // 用折扣而不是硬门槛，是因为画像本来就稀疏，硬门槛会让星魂条目大面积退回旧口径。
      const k = Math.min(1, Math.min(na, nb) / SCORING.stabilityFullRuns);
      // ---- 全局平均：这一档在**整个副本的人群里**平均多出多少分。
      const meanDelta = gb - ga;
      // ---- 结构最优：在**某一套阵容**里它是关键金（跨过档位线），最好的那套能多出多少分。
      //
      // 两个都要，因为「关键金」是后者的语义：用户说的「这两个角色的星魂对改善出分
      // 和压金 0T 都相当重要」指的正是「在**我这套**阵容里它是那道门槛」。
      // 只看全局平均会被大量「升不升都一样」的阵容稀释掉（实测知更鸟 E1→E2 的
      // 全局平均只有 +0.01，而结构最优在别的阵容上能到 +0.5 以上）；
      // 只看结构最优又会给「少数几套运气好的阵容」过高权重。
      // 所以按 `bestGainWeight` 混合，两者都是「每副本 0~1 分」的同一量纲。
      let best = null;
      for (const r of rows) {
        const st = r.team.eidoStats;
        if (!st) continue;
        const la = st[name]?.[from];
        const lb = st[name]?.[target];
        if (!la || !lb) continue;
        const xa = meanGrade(la);
        const xb = meanGrade(lb);
        if (xa === null || xb === null) continue;
        const d = xb - xa;
        if (best === null || d > best) best = d;
      }
      const w = SCORING.bestGainWeight;
      const blended = best === null
        ? meanDelta
        : (1 - w) * meanDelta + w * Math.max(0, best);
      if (!Number.isFinite(blended)) return null;
      return Math.max(0, Math.min(1, blended)) * k;
    };

    // 副本级档位分布累计：`${char} -> Map(档位 -> { n, tiers })`。
    // 数据来自该副本里所有阵容的 `eidoStats`（建库侧第二趟半算好的）。
    //
    // 按**副本**（而不是候选行那一套阵容）聚合，与 `eidoAgg` 同一条理由：
    // 候选行落在哪套阵容是搜索的结果，不该反过来决定一个档位的价值。
    const eidoGrade = new Map();
    for (const r of rows) {
      const stats = r.team.eidoStats;
      if (!stats) continue;
      for (const [char, levels] of Object.entries(stats)) {
        if (!eidoGrade.has(char)) eidoGrade.set(char, new Map());
        const mine = eidoGrade.get(char);
        for (const [level, entry] of Object.entries(levels || {})) {
          const lv = Number(level);
          if (!Number.isFinite(lv)) continue;
          const cur = mine.get(lv) || { n: 0, tiers: [0, 0, 0, 0] };
          cur.n += Number(entry?.n) || 0;
          const src = Array.isArray(entry?.tiers) ? entry.tiers : [];
          for (let i = 0; i < 4; i += 1) cur.tiers[i] += Number(src[i]) || 0;
          mine.set(lv, cur);
        }
      }
    }

    /**
     * 升到目标档值不值得（0~1）。
     *
     * 用户的关键指正（2026-10）：**升一档星魂就是多花 1 金，好打副本里它不可能
     * 把队伍的金数压下来**。所以星魂/光锥的贡献必须用它自己量，而且两件事都要看：
     *
     *   好打副本（比压金）：升档 = 固定多花 1 金。
     *     * 档位没变 → 只是更贵 → 贡献 **0**（花火 E2→E3 就是这种）
     *     * 档位变了，而且这套阵容的成本仍低于常见成本 → 才给正贡献
     *   难打副本（比击败比例）：同一阵容下两个档位的真实成绩差。
     *     * 量出没差异 → 0；样本不足 → 中性（交给下面的退路）
     *
     * 旧版把「好打副本里尺子退化」当成中性 1 放行，于是星魂条目直接继承了**角色**
     * 的压金强度（那个强度来自 E0/E1 的便宜队伍），花火 E3 就是这样排到第 8 的。
     */
    const eidolonStepValue = (name, from, target, rosterKey, tierFrom, tierTo) => {      const fromLevel = Math.round(Number(from) || 0);
      const targetLevel = Math.round(Number(target) || 0);
      // 诊断用（options.trace）：把每条星魂条目命中的分支与取值交出去。
      const note = (branch, value, extra = '') => {
        if (trace) {
          trace.push({
            env: id, name, from: fromLevel, to: targetLevel, branch, value, extra, rosterKey,
          });
        }
        return value;
      };
      // ⓪ 先用**整个副本**的配对统计（样本最多，也不受候选行落在哪套阵容影响）。
      const agg = eidoAgg.get(`${name}|${fromLevel}|${targetLevel}`);
      if (agg && agg.n > 0) {
        if (easy) {
          // 好打副本：**关键金能多出多少分**——升这一档把档位分布的期望值抬了多少。
          //
          // 用户 2026-10 的指正正是冲这一点来的：「这两个角色的星魂对改善出分和
          // 压金 0T 都相当重要，尤其是用现有阵容挑战异相仲裁 / 绝境王棋」。
          // 异相仲裁/绝境的判据是行动值（<300 满分），而实测那个区间的人群成绩
          // 集中在 370~390——升一档**跨过那条线**就是「多出分」，期望档位等级
          // 会如实反映它，而这个副本的权重也最高（1.75）。
          //
          // 这里**刻意不看** `agg.tierUp`：那个「常见档位有没有翻过去」的二值判据
          // 会把满分**之上**的提升整个丢掉（低难副本里常见档位就是满分），
          // 实测知更鸟 E1→E2 的达标率差是 95%→95% = 0，而期望档位其实在动。
          // 「期望出分」对地板与天花板一视同仁，而且字面就是分。
          const grade = gradeGain(eidoGrade, name, fromLevel, targetLevel);
          if (grade === null || grade <= 0) {
            // 没有档位画像（该角色这两档在该副本的投稿不足）→ 退回旧的跨档口径：
            // 跨了档给比例分，没跨档就是 0（旧行为）。两种口径都缺 → 中性 1。
            if (agg.tierUp) {
              return note('0-好打/无画像→退跨档比例', agg.tierUp / agg.n,
                `配对 ${agg.n} 组 / 档位提升 ${agg.tierUp} 组`);
            }
            if (agg.tierUp === 0) return note('0-无档位提升', 0, `配对 ${agg.n} 组`);
            return note('0-好打/无证据→中性', 1, `配对 ${agg.n} 组`);
          }
          return note('0-好打/期望出分', grade,
            `配对 ${agg.n} 组 / 档位提升 ${agg.tierUp} 组 / 期望档位 +${grade.toFixed(3)} 分`);
        }
        // 难打副本：升档带来的成绩提升（只统计把档位推上去的那些配对）
        const delta = medianOf(agg.upDeltas);
        // ⚠️ `upDeltas` 空**不等于**「没有证据」，而是**证据说没有提升**：
        // 上面只把「档位真的往上走了一档」的配对推进来（`tierUp`），所以列表为空
        // 有两种情形，两种都该算 0：
        //   * `tierUp === 0`：这个副本里同一套阵容升这一档一次都没把档位推上去
        //     （花火 E2→E3 就是这种）；
        //   * `tierUp > 0` 但那些配对本来就在天花板上（`room ≤ 0`）→ 成绩差为 0。
        // 早先这里返回**中性 1**，于是难打副本里的星魂条目直接继承**整套作业**的
        // 击败比例提升（实测花火 E2→E3 在绝境拿到 +57 点，排进方案前几名），
        // 这正好是用户点名过的「花火 E3 提升非常小」那个问题在难打副本里的残留。
        // 好打副本那一支早就把「没跨档」判成 0 了，两边现在一致。
        if (!Number.isFinite(delta)) {
          return note('0-难打/无档位提升', 0, `配对 ${agg.n} 组 / 档位提升 ${agg.tierUp} 组`);
        }
        return note('0-难打/成绩', Math.max(0, Math.min(1, delta)),
          `配对 ${agg.n} 组/档位提升 ${agg.tierUp}`);
      }
      const layered = rosterEido.get(rosterKey || '')?.[name];
      const fEntry = layered?.[fromLevel];
      const tEntry = layered?.[targetLevel];
      const tierRank = tierRankOf;
      if (fEntry && tEntry) {
        if (easy) {
          // 升档有没有换来更好的档位？
          const rankFrom = tierRank(tierFrom ?? fEntry.tier);
          const rankTo = tierRank(tierTo ?? tEntry.tier);
          if (rankTo <= rankFrom) return 0;          // 档位没变 → 纯变贵 → 0
          // 档位变好了：再看成本是不是还压得住（相对常见成本）
          if (!Number.isFinite(usualCost) || usualCost <= 0) return 1;
          return Math.max(0, Math.min(1, (usualCost - tEntry.cost) / usualCost));
        }
        // 难打副本：同一阵容下成绩真的提升了多少
        const max = Math.max(...Object.values(layered)
          .map((v) => Number(v?.perf)).filter(Number.isFinite));
        const fv = Number(fEntry.perf);
        const tv = Number(tEntry.perf);
        if (!Number.isFinite(fv) || !Number.isFinite(tv)) return 1;
        // 「升这一档没有提升空间」和好打副本的「档位没变」是同一条规则：算出 0。
        // `room = max − fv` 是当前档位到这套阵容天花板的距离；等于 0 说明现在这一档
        // 就已经是这套阵容的最好成绩，再往上买不会更好。
        const room = max - fv;
        if (room <= 1e-6) return 0;
        return Math.max(0, Math.min(1, (tv - fv) / room));
      }
      // ② 同阵容配对（用客户端自己按 perfOf 聚合的档位表）
      const perRoster = eidolonPerf.get(`${rosterKey || ''}|${name}`);
      if (perRoster) {
        const f = perRoster.get(fromLevel);
        const t = perRoster.get(targetLevel);
        if (Number.isFinite(f) && Number.isFinite(t)) {
          const room = 1 - f;
          if (room <= 1e-6) return 0;   // 已经摸到天花板 → 升上去不会更好
          return Math.max(0, Math.min(1, (t - f) / room));
        }
      }
      // ③ 退路：跨阵容的档位最好表现
      const fCross = eidolonBest.get(`${name}|${fromLevel}`);
      const tCross = eidolonBest.get(`${name}|${targetLevel}`);
      if (Number.isFinite(fCross) && Number.isFinite(tCross)) {
        const room = 1 - fCross;
        if (room <= 1e-6) return 0;     // 当前档位已到尺子顶端 → 升上去不会更好
        return Math.max(0, Math.min(1, (tCross - fCross) / room));
      }
      // 连退路都没有（整个副本里看不到这个角色的这一档）→ 中性，不奖不罚
      return 1;
    };

    /**
     * 光锥这一档值不值得（0~1）：同样只看**它自己**。
     * 好打副本里光锥本体/叠影也是固定多花 1 金，所以判据与星魂一致——
     * 档位没变就是纯变贵（0）；档位变了才看成本还压不压得住。
     */
    const coneStepValue = (name, r) => {
      if (!easy) return 1;   // 难打副本的光锥贡献由击败比例那条线管
      const members = r.team.sample?.members || [];
      const carrier = members.find((m) => m.lc === name)?.char || null;
      if (!carrier) return 1;
      const layered = rosterEido.get(r.team.rosterKey || '')?.[carrier];
      if (!layered) return 1;
      // 该阵容里载体角色的档位是否到顶（0T 档）—— 没到顶说明光锥没把它顶上去
      const tiers = Object.values(layered).map((v) => v?.tier).filter(Boolean);
      if (!tiers.includes('perfect')) return 0;
      if (!Number.isFinite(usualCost) || usualCost <= 0) return 1;
      const cost = Math.max(...Object.values(layered)
        .map((v) => Number(v?.cost)).filter(Number.isFinite), 0);
      return Math.max(0, Math.min(1, (usualCost - cost) / usualCost));
    };

    const candidateRows = refRows.filter((r) => r.cost.pulls > 0
      && r.cost.pulls <= SCORING.candidateMaxPulls);

    const candidates = candidateRows
      .map((r) => {
        // 难打副本（异相仲裁骑士关 / 绝境）继续用「击败比例」：那里的人群差距是真的。
        const pctGain = !easy && basePct !== null && r.pct !== null
          ? Number(((r.pct - basePct) * 100).toFixed(3)) : null;
        // 用户的第一条：不考虑已有角色，单独抽一把光锥是没法用的 → 载体一个都没有的光锥
        // 不进建议（这条同样适用于难打副本，所以不过滤在 easy 分支里）。
        const allItems = r.cost.items || [];
        const items = allItems.filter((item) => item.kind !== 'cone' || coneUsable(item.name));
        if (!items.length) return { gain: 0 };
        // 成绩信号（档位分放大到百分制）：成本信号缺失时的退路。
        const scoreGain = Number(((r.score - baseScore) * GAIN_SCALE_WITHOUT_DIST).toFixed(3));
        // **同一副本只用一把尺子**：能不能用成本信号，由整个副本决定，不能逐个单位挑。
        // 早先按单位回退成绩分，结果同一个副本里「成本分 33」和「成绩分 120」混在一起，
        // 弱角色反而排到强角色前面（实测 Star 0.3546 < Mate 1.2766）。
        // 成本信号可用 = 有常见成本、且含各单位的成本确实分得出高低。
        const distinctCosts = new Set(cheapestWith.values()).size;
        const useCost = easy && Number.isFinite(usualCost) && usualCost > 0 && distinctCosts > 1;
        // 难打副本的尺子是「击败比例」；好打副本成本信号退化时退回「档位分」。
        // 这套作业的提升 = 里面最值钱的那个单位（缺一整套时收益会重叠，不能相加）。
        const rowFallback = easy ? scoreGain : (pctGain !== null ? pctGain : scoreGain);
        /**
         * 一个缺口单位**自己**的贡献（0~100 同一把尺子）——修正④的核心。
         *
         * 分子必须是**这个单位自己**量出来的东西，不能拿「角色本体的压金强度」顶替：
         *   * 角色：含它的最低达标成本比常见成本便宜多少（成本信号退化时退回本副本的尺子）
         *   * 光锥：同样按**光锥名**取证，再乘它自己那一档的判据
         *   * 星魂：**它自己这一档**量出来的边际收益（同一套阵容配对）× 本副本的满分。
         *     成本信号可用时，这个边际本来就是「相对常见成本省下的比例」（0~1），
         *     乘满分后落在同一把 0~100 的尺子上；成本尺子退化时（如虚构叙事常见成本
         *     就是 0）退回本副本的尺子，免得同一个副本里两种量纲混着比。
         *     旧版拿 `strengthOf(角色名)` 当分子，等于「角色本体强 = 这一档星魂值」，
         *     花火 E3 当年就是这么跟着角色一起爬进榜的。
         */
        const ownGainOf = (item) => {
          if (item.kind === 'eidolon') {
            const marginal = eidolonStepValue(item.name, item.from, item.target,
              r.team.rosterKey, item.tierFrom, item.tierTo);
            // 星魂的分子是「期望档位提升」（每个副本 0~1 分，见 gradeGain），
            // 所以乘 `UNIT_GAIN_SCALE × EIDOLON_STEP_SCALE` 换算到与角色 / 光锥
            // 同一个 0~100 的尺子上。`EIDOLON_STEP_SCALE` 是把「0~1 的档位提升」
            // 摊到「档位分 0~2」的等效放大量：跨满一档（1.0）≈ 档位分抬 1 分，
            // 而档位分 1 分在 `GAIN_SCALE_WITHOUT_DIST` 里值 50 分。
            return (useCost ? UNIT_GAIN_SCALE : rowFallback)
              * (EIDOLON_STEP_SCALE * marginal);
          }
          const base = useCost ? strengthOf(item.name) : rowFallback;
          return base * (item.kind === 'cone' ? coneStepValue(item.name, r) : 1);
        };
        const itemGains = {};
        for (const item of items) itemGains[item.name] = ownGainOf(item);
        const strengthGain = items.length
          ? Math.max(...items.map((item) => itemGains[item.name])) : 0;
        const gain = easy ? (useCost ? strengthGain : scoreGain) : rowFallback;
        const pullsExpected = items.reduce(
          (n, item) => n + unitPullsOf(item.kind, item.pulls), 0,
        ) || unitPullsOf('char', r.cost.pulls);
        // 每个缺口单位**自己**的期望抽数：限定角色本体（含要补到的星魂）× 94、
        // 活动跃迁光锥（含要补的叠影）× 67。归因到单位时按名字取。
        //
        // ⚠️ 这里**不能**算一个「跨全队的最大值」当所有单位的分母。早先就是那么写的
        // （`items.reduce((n, it) => Math.max(n, unitPullsOf(...)))`），于是同一个分母
        // 被队里所有单位共用 —— 而且是**最贵那个队友**的价格。实测：
        // 知更鸟 E1→E2 自己只要 94 抽（1 金 × 94），同队的砂金•戏浪要 282 抽，
        // 于是它的分母被算成 282，贡献被除以 3 倍，排名从应有的头部掉到第 25。
        // 分母必须是「买这一个单位要几抽」，见下面归因处的注释。
        const unitPullsExpected = Object.fromEntries(
          items.map((item) => [item.name, unitPullsOf(item.kind, item.pulls)]),
        );
        // 副本权重：异相仲裁最关键、虚构叙事最低（SCORING.envWeight，用户指定方向）
        const envWeight = envWeightOf(env.mode, env.stage || '');
        // 可达性：这套参考队伍里你已经拥有多少成员（0~1）。缺得越多，越不算性价比。
        const members = r.team.sample?.members || [];
        const reach = members.length
          ? members.filter((m) => ownedChars.has(m.char)).length / members.length
          : 1;
        const trust = Number.isFinite(r.team.trust) ? r.team.trust : 1;
        return {
          env: id,
          envLabel: env.label || id,
          mode: env.mode,
          stage: env.stage || '',
          season: env.season || null,
          easy,
          rosterKey: r.team.rosterKey,
          roster: r.team.roster,
          rosterCn: r.team.rosterCn,
          count: r.team.count,
          evidence: r.team.evidence,
          trust,
          // 副本权重：单位榜按 `value` 跨副本相加时要用（见 units 归因处）。
          envWeight,
          // 这一套作业照抄下来要几抽、每个缺口单位各几抽 —— 单位榜的**分母**来源，
          // 界面上的「性价比构成」浮层要用它解释钱花在哪。
          teamPulls: pullsExpected,
          unitPulls: Object.fromEntries(items.map((it) => [it.name, unitPullsOf(it.kind, it.pulls)])),
          cost: r.team.cost,
          avgAv: r.team.avgAv,
          tier: r.tier,
          score: Number(r.score.toFixed(4)),
          perfect: r.team.perfect,
          gain,
          itemGains,
          // 好打副本：这套达标作业的成本 vs 常见成本（都用**金**，界面不显示抽数）
          costBefore: easy ? Math.round(usualCost) : null,
          costAfter: easy ? Math.round(r.teamCost) : null,
          // 难打副本：击败比例
          pctBefore: basePct === null ? null : Number((basePct * 100).toFixed(1)),
          pctAfter: r.pct === null ? null : Number((r.pct * 100).toFixed(1)),
          gainPct: pctGain,
          pulls: r.cost.pulls,
          pullsExpected,
          // 每个缺口单位各自的期望抽数（归因到单位时按名字取，见单位榜的注释）。
          unitPullsExpected,
          items,
          q: Number(r.q.toFixed(6)),
          inRefSet: refSet.has(r),
          // 按副本权重加权后的提升：组合枚举时要跨副本相加，必须带上权重
          weightedGain: Number((gain * envWeight).toFixed(4)),
          // 性价比 = (提升 ÷ 期望抽数) × 可信度 × **副本权重**。
          //
          // 这里**故意不再乘可达性折价**（修正 A，用户 2026-10）：「缺体系有可能是直接抽
          // 整个体系也能有很大提升，每个版本的关卡环境不同，所以也值得考虑」——所以
          // 缺得多的方案不降价，而是让「补 1 个就能用」与「整套一起补」在同一个
          // 「提升 ÷ 成本」上竞争（候选已放宽到缺 ≤3 个单位）。
          value: Number((
            (gain / Math.max(1, pullsExpected))
            * trust
            * envWeight
          ).toFixed(4)),
          // 仅作展示参考：这套参考队伍里你已拥有多少成员（不再是评分项）
          reach: Number(reach.toFixed(3)),
          sample: r.team.sample || null,
        };
      })
      // 提升算下来是 0 的候选直接丢掉（好打副本例外：那里的强度分可以低到 0，
      // 但仍要留在榜上靠后排，否则「同队还要补限定」的差异就看不见了）。
      .filter((cand) => cand.gain > 0 || cand.easy)
      .sort((a, b) => b.value - a.value
        || (a.pulls - b.pulls)
        || (b.gain - a.gain));

    envResults.push({
      id,
      mode: env.mode,
      stage: env.stage || '',
      label: env.label || id,
      season: env.season || null,
      totalRuns: env.totalRuns ?? null,
      recentSeasons: env.recentSeasons || [],
      reliable: env.reliable !== false,
      tierLines: env.tierLines || null,
      baseline: {
        score: Number(baseScore.toFixed(4)),
        tier: scoreTier(baseScore),
        rosterKey: baseRow?.team.rosterKey || null,
        roster: baseRow?.team.roster || null,
        rosterCn: baseRow?.team.rosterCn || null,
        avgAv: baseRow?.team.avgAv ?? null,
        tierOfTeam: baseRow?.tier || null,
      },
      candidateCount: candidates.length,
      candidates: candidates.slice(0, perEnvCandidates),
    });

    allCandidates.push(...candidates);

    // ---- 归因到单位：同一副本内一个单位只记它最好的一套（取最大值）
    for (const cand of candidates) {
      for (const item of cand.items) {
        const key = unitKeyOf(item);
        if (!key) continue;
        if (!units.has(key)) {
          units.set(key, {
            key,
            kind: item.kind,
            name: item.name,
            pulls: item.pulls,
            from: item.from,
            target: item.target,
            uncertain: Boolean(item.uncertain),
            byEnv: new Map(),
            total: 0,
          });
        }
        const unit = units.get(key);
        // 好打副本里每个缺的单位有自己的强度分（含它自己的最低达标成本），
        // 所以这里优先用 itemGains[name]，不能拿整套作业的分顶替。
        const itemGain = cand.itemGains?.[item.name];
        const unitGain = Number.isFinite(itemGain) ? itemGain : cand.gain;
        // 分母必须是**这个单位自己**的期望抽数，不能是整套作业的、也不能是队友的。
        //
        // 这是「角色总榜」能正确排序的前提：榜上排的是**单位之间**的比值，
        // 只有每个单位都用自己作分母，这个比值才可比、才有传递性。
        // 用别的量当分母有三个后果（前两个实测过）：
        //   1. 同伴的抽数被摊到每个单位头上 → 「补 1 个就能用」的单位被
        //      「整套一起补」的作业拖累，排序不再反映各单位自己的价值；
        //   2. 同一个分母被多个单位共用 → 它们算出**完全相同**的性价比，
        //      名次变成随机。实测真实数据上 Sparkle / Sparxie / Silver Wolf
        //      曾共享同一个数（同一套 282 抽的作业），Silver Wolf 自己的值只有
        //      它的 1/4；
        //   3. **取全队最大值**（第二版实际写成的样子）更糟：等于用**最贵那个队友**
        //      的价格当所有人的分母。实测知更鸟 E1→E2 自己只要 94 抽，同队的
        //      砂金•戏浪要 282 抽，于是它的贡献被除以 3，排名掉到第 25。
        //
        // 「配队差距」这条口径没有丢：它留在展示字段里（`unit.pullsExpected`
        // 仍是整套作业的抽数、`unit.best.companions` 列出还要一起补的同伴），
        // 只是不再参与排序。见 tools/herta-test.mjs 的「配队差距会摊薄性价比」。
        const ownPulls = Math.max(1,
          Number(cand.unitPullsExpected?.[item.name])
          || unitPullsOf(item.kind, item.pulls)
          || Number(cand.pullsExpected) || 1);
        // 配队可达性：这套作业里你已经拥有多少成员（0~1）。
        //
        // 修正 A 当年把 `m^β` 整个删掉，理由是「缺体系也可能是直接抽整个体系」。
        // 代价是现在**完全不看**这件事，于是「你几乎整队都没有」的作业也能霸榜：
        // 实测用户账号上排名第 1 的 不死途 在绝境王棋里，队里 4 个位置他只拥有 1 个
        // （Gallagher），却拿到 +357 —— 比「4 个位置拥有 3 个」的花火（+190）还高。
        // 用户的原话：「不死徒及其配队的队友我几乎没有抽取，为何会有如此高的性价比？」
        //
        // 所以把它请回来，但**用温和的线性折扣**（不是原来的 `m^1.5` 乘子）：
        //   全拥有（m=1）→ 1.00；一个都没有（m=0）→ 0.25。
        // 保留 0.25 的下限而不是打到 0，是为了不回到「补 1 个就能用 vs 从零起一套」
        // 那种一刀切；从零起一套仍然进榜，只是排在有基础的方案后面。
        const reachFactor = SCORING.reachFloor
          + (1 - SCORING.reachFloor) * (Number.isFinite(cand.reach) ? cand.reach : 1);
        const unitValue = (unitGain / ownPulls)
          * (Number.isFinite(cand.trust) ? cand.trust : 1)
          * (Number.isFinite(cand.envWeight) ? cand.envWeight : 1)
          * reachFactor;
        const candValue = Number(unitValue.toFixed(4));
        // 一个单位可能在多套作业里出现（带不同星魂档），取性价比最高的那套；
        // 同分时取造价低的。
        const prev = unit.byEnv.get(id);
        if (!prev || candValue > prev.value
          || (candValue === prev.value && cand.pulls < prev.pulls)) {
          unit.byEnv.set(id, {
            value: candValue,
            gain: unitGain,
            pulls: cand.pulls,
            tier: cand.tier,
            ownPulls: item.pulls,
            from: item.from,
            target: item.target,
            uncertain: Boolean(item.uncertain),
            rosterKey: cand.rosterKey,
            roster: cand.roster,
            rosterCn: cand.rosterCn,
            count: cand.count,
            evidence: cand.evidence,
            season: cand.season,
            envLabel: cand.envLabel,
            // 这条口径是「达标成本」还是「击败比例」——界面据此写不同的推荐语
            easy: Boolean(cand.easy),
            costBefore: cand.costBefore,
            costAfter: cand.costAfter,
            pctBefore: cand.pctBefore,
            pctAfter: cand.pctAfter,
            pullsExpected: cand.pullsExpected,
            // 分母（单位自己的期望抽数）与它的来源。界面的「性价比构成」浮层要把
            // 这一步摊开给用户看，所以必须把**算完的值**也带出去，而不是让界面重算
            // （重算就会和排序用的口径分叉）。
            ownPullsExpected: ownPulls,
            teamPulls: cand.teamPulls,
            unitPulls: cand.unitPulls,
            envWeight: cand.envWeight,
            trust: cand.trust,
            // 星魂这一步的「期望出分」比例（0~1，每个副本夹到 1）——
            // 浮层要把它与 `UNIT_GAIN_SCALE` 分开显示，用户才看得懂分子是怎么来的。
            eidolonStep: item.kind === 'eidolon' && cand.gain > 0
              ? Number((unitGain / UNIT_GAIN_SCALE).toFixed(4))
              : null,
            // 同伴：这套作业里除本单位之外还要补的限定单位——用户要看的
            // 「配队差距」就显示在这里。
            companions: cand.items
              .filter((x) => unitKeyOf(x) !== key)
              .map((x) => ({ ...x })),
          });
        }
      }
    }
  }

  // ---- 单位榜：跨副本相加。能同时改善多个副本的单位排前面。
  // ---- 组合枚举（修正 A 完整版，用户 2026-10）
  //
  // 用户口径：价值 = **Σ提升 ÷ Σ成本**，而且成本只能算一次。
  //
  // 为什么必须枚举「组合」而不是逐副本相加：同一套要补的单位可能同时解锁好几个副本，
  // 逐副本相加会把成本重复计入（同一个单位在 5 个副本里被收 5 次钱），于是「一次投入、
  // 多副本受益」的方案被系统性低估。
  //
  // 做法：
  //   1. 把候选作业按「要补的单位组合」归并（同一组合键）；
  //   2. 每个组合：Σ提升 = 各副本里该组合能达到的最好提升（带副本权重）之和；
  //      Σ成本 = 组合里各单位算一次；
  //   3. value = Σ提升 ÷ Σ成本；
  //   4. 单位的价值 = 「含它的组合」里的最大值（它可以只补 1 个进小方案，
  //      也可以跟着整套大方案一起进，哪条路单位金提升大就走哪条）。
  const comboOf = new Map();
  for (const cand of allCandidates) {
    const key = (cand.items || []).map(unitKeyOf).filter(Boolean).sort().join('|');
    if (!key) continue;
    let combo = comboOf.get(key);
    if (!combo) {
      combo = { key, items: cand.items || [], byEnv: new Map(), count: 0, pulls: 0 };
      comboOf.set(key, combo);
    }
    const prev = combo.byEnv.get(cand.env);
    // 「提升」为负的作业不算提升：一个单位可能在一个副本里有自己的正贡献、
    // 在另一个副本里跟着一套比基线还差的作业（好打副本的档位分可以低于基线），
    // 直接相加会把这个单位的性价比拖成负数——界面上不允许出现负的「性价比」。
    const contribution = Math.max(0, cand.weightedGain);
    if (contribution > 0 && (prev === undefined || contribution > prev)) {
      combo.byEnv.set(cand.env, contribution);
    }
    combo.count += cand.count || 0;
    combo.pulls = Math.max(combo.pulls, cand.pulls || 0);
  }
  const combos = [...comboOf.values()].map((combo) => {
    const gain = [...combo.byEnv.values()].reduce((n, g) => n + g, 0);
    // 成本算一次：组合里每个单位的期望抽数（角色 94 / 光锥 67）
    const cost = Math.max(1, combo.items.reduce(
      (n, item) => n + unitPullsOf(item.kind, item.pulls), 0,
    ));
    return {
      key: combo.key,
      items: combo.items,
      envs: [...combo.byEnv.keys()],
      gain: Number(gain.toFixed(4)),
      cost,
      count: combo.count,
      pulls: combo.pulls,
      value: Number((gain / cost).toFixed(4)),
    };
  });
  const comboByUnit = new Map();
  for (const combo of combos) {
    for (const item of combo.items) {
      const key = unitKeyOf(item);
      const cur = comboByUnit.get(key);
      if (!cur || combo.value > cur.value) comboByUnit.set(key, combo);
    }
  }

  // ---- 副本证据稀疏时的兜底（用户 2026-10 要求「给稀疏副本做兜底」）
  //
  // 背景：权重最高的副本往往投稿最少。实测绝境王棋只有 342 套阵容，而骑士关有 1170 套；
  // 于是最关键的副本最容易「该角色的这两档一个配对都没有」而记 0。
  // 遐蝶 E0→E2 就是这样被压下去的：它在绝境王棋的 6 套阵容**全部只出现 E2/E3/E6**，
  // 一条 E0 都没有 → 量不出 E0→E2；而它在末日幻影/虚构叙事上的提升很扎实
  //（中位数 0.76 / 1.00），却因为权重只有 1.0/0.5 而撑不起总分。
  //
  // 做法：某个副本对该单位**完全没有正证据**时，用它在**其它副本**的同一提升打
  // `sparseEnvDiscount` 折顶上，并标 `inferred`。界面据此提示这是推断值。
  //
  // 为什么不会重蹈「花火 E3 靠跨副本凑数爬榜」的覆辙：
  //   * 只在**该副本为 0** 时才启用——真正在该副本量出来的证据永远优先；
  //   * 打 5 折，推断值不可能压过任何一条实测证据；
  //   * 要求至少 `sparseEnvMinOthers` 个其它副本都有正证据，避免用孤例推断。
  //
  // 注意这是在 `units`/`envResults` 都建好之后做的**后处理**：每副本贡献本来就是
  // 在各副本内独立算完再相加的，所以这里改 `byEnv` 的值与排序口径一致，
  // 不会和别处的计算分叉。
  for (const unit of units.values()) {
    const known = [...unit.byEnv.entries()].filter(([, v]) => v.value > 0);
    if (!known.length) continue;
    const meanGain = known.reduce((n, [, v]) => n + (Number(v.gain) || 0), 0) / known.length;
    for (const envResult of envResults) {
      const id = envResult.id;
      // 该副本已经有正证据 → 实测永远优先，不动它。
      //
      // 注意这里用 `(get(id)?.value ?? 0) > 0` 而不是 `!has(id)`：
      // `byEnv` 只在该单位于这个副本**至少出现过一次**时才会有条目，所以
      // 「从没出现在这个副本的候选里」是 `has === false`、而「出现过但算出来是 0」
      // 是 `has === true && value === 0`。两种都属于「这个副本没有正证据」，
      // 都要走兜底——早先只判了后者，于是遐蝶在末日幻影/虚构叙事上（它压根没
      // 在那两个副本进过候选）永远得不到推断值。
      if ((unit.byEnv.get(id)?.value ?? 0) > 0) continue;
      // 需要别的副本有正证据才能推断。门槛是 `max(1, sparseEnvMinOthers - 1)`：
      // 「至少 2 个」是为了避免用孤例推断，但像遐蝶 E0→E2 这种**只在 1 个副本里
      // 量出来过**的单位，如果要求 2 个就永远拿不到兜底——而它恰恰是最需要兜底的
      // （证据最少 = 越容易被稀疏副本压下去）。所以门槛随「已知副本数」放宽：
      // 已知 1 个时允许推断，已知 ≥2 个时按原门槛。
      const need = Math.max(1, Math.min(known.length, SCORING.sparseEnvMinOthers - 1));
      if (known.length < need) continue;
      const envWeight = envWeightOf(envResult.mode, envResult.stage || '');
      const shownEnv = known[0][1];
      const ownPulls = Math.max(1, Number(shownEnv.ownPullsExpected) || 1);
      const gain = meanGain * SCORING.sparseEnvDiscount;
      const value = Number(((gain / ownPulls) * envWeight * SCORING.reachFloor).toFixed(4));
      if (value <= 0) continue;
      unit.byEnv.set(id, {
        ...shownEnv,
        value,
        gain,
        // ⚠️ `envWeight` 必须放在展开之后！`shownEnv` 是**已知那个副本**的条目，
        // 它自带一个 envWeight；展开在后面的字段会把它覆盖成被借用副本的权重，
        // 于是浮层里会显示「末日幻影 × 1.75」这种对不上的组合（实测踩过）。
        // `value` 一直是对的（它用的是上面那个局部 envWeight），错的只是展示字段。
        envWeight,
        // 这一条不是在这个副本里量出来的 —— 界面必须说清楚
        inferred: true,
        inferredFrom: known.length,
        roster: null, rosterCn: null, rosterKey: null,
        envLabel: envResult.label || id,
        season: envResult.season,
        tier: null, costBefore: null, costAfter: null, pctBefore: null, pctAfter: null,
        companions: [],
      });
    }
  }

  // ===================================================================
  // 角色总榜（**纯黑塔网数据口径**，完全不看你的角色池）
  //   ⚠️ 名字是用户 2026-10-12 第 1 条改的（原「性价比总榜」）；**口径一字未动**：
  //      排序仍按下面这个乘了金数项的 `total`（即它仍然是「性价比」意义上的榜）。
  //      抽卡方案的「强度得分」另走 `strength`（纯强度，不含金数项）。
  // ===================================================================
  //
  // 用户 2026-10 的要求：「性价比总榜不用单独分析角色/星魂/光锥，也不考虑某个星魂
  // 的造价，而是把整个角色打包比较，比较的内容仅考虑队伍的整体强度」。
  //
  // 所以单位是**整包**（角色 + 星魂目标档 + 光锥叠影绑成一条），分值来自它参与过的
  // 最好那条**队伍**证据：
  //
  //   total(整包) = Σ_env  w(env) × score(整包, env)
  //   score(整包, env) = max over 含它的配置 r 的 [ 100 × 档位权重 × 行动值项
  //                                             × (该副本最便宜金数 ÷ r 的金数) ]
  //
  //   * 整包**自己的金数不进公式**，只用于展示与「0 金不进榜」的判断（见 A 段注释）。
  //   * 权重只看用户在界面上定下的**关卡权重**（`'frontier'` 口径），与「抽卡方案」
  //     那一行互不影响（用户 2026-10 要求），换账号结果完全一致。
  //   * 并列**保持**（用户 2026-10 明确要求）：同一支队伍的成员必然同分，不再用
  //     「整包自身金数」之类的二级键把它们拆开。同分的条目按最佳证据聚在一起，
  //     界面据此标注「与上行并列：同属 X 赛季 N 金 0T 配置」。
  //
  // 历史包袱：`docs/评分模型设计.md` 的「修正 A」否决过「打包口径」，理由是整包的
  // 功劳会被记到每个成员头上（实测有单位被抬高 4 倍）。那条结论针对的是**抽卡方案**
  // （「我该补谁」）；总榜回答的是「数据里谁强」，两个榜分工不同，所以本口径成立。
  // 谁要把它改回节点口径，先读 docs 的 v15 一节。
  //
  // 返回 `{ board, byChar, byTier }` 而不是直接返回榜，三份各有各的消费者：
  //   * **board**  —— 「全部」那一页：每角色一条（总分最高的整包）。
  //   * **byChar** —— 收敛前按角色分组的完整名单（角色面板展示「全部配装」）。
  //   * **byTier** —— 「E0 / E1 / E2 / E6」四个筛选页：**每个档位各自收敛一条**。
  // 理由分别见下面 `byChar` 与 `byTier` 那两段。
  const frontierBoard = (() => {
    const acc = new Map();
    for (const [envId, bucket] of frontierPacks) {
      const meta = frontierMeta.get(envId) || {};
      const weight = weightOr(meta.weight);
      for (const [key, pack] of bucket) {
        let unit = acc.get(key);
        if (!unit) {
          unit = { ...pack, envs: [] };
          acc.set(key, unit);
        }
        const evidence = pack.evidence || {};
        unit.envs.push({
          id: envId,
          envLabel: meta.envLabel || envId,
          mode: meta.mode || null,
          stage: meta.stage || '',
          weight,
          // 这一条整包在该副本里的分，以及它乘上副本权重后对总分的贡献。
          score: Number(pack.score.toFixed(4)),
          value: Number((pack.score * weight).toFixed(4)),
          // **纯强度**的同一份贡献（用户 2026-10-12 第 3 条）：抽卡方案的强度分读它。
          // 乘同一个副本权重，所以顶层 `Σ strength` 与抽卡方案的强度分是同一个量纲。
          strength: Number((pack.strength * weight).toFixed(4)),
          // 最佳证据那条**队伍**配置：界面写「7 金 · 满分 · 行动值 295 · 4.2 版本」。
          bestTeamGold: evidence.cost ?? null,
          // **最佳证据所在版本**的最便宜金数 —— 金数项的分母就是它（用户 2026-10-10
          // 第 5 轮：金数项按版本归一，不拿全窗口最小值当所有版本的分母）。
          // 界面拆「贡献来源」时必须用它，否则算出来的因子与榜上的分对不上。
          seasonMinCost: evidence.seasonMinCost ?? null,
          tier: evidence.tier ?? null,
          actionValue: evidence.actionValue ?? null,
          avScore: evidence.avScore ?? null,
          evidenceSeason: evidence.season ?? null,
          // 最佳证据那支队伍用了几个限定光锥（用户第 10 条的次级判据）。
          limitedCones: evidence.limitedCones ?? null,
          // 该整包所在的队伍（英文数据集键 + 星魂，界面自己用 i18n 解析中文）
          members: evidence.members || [],
          // 证据广度：只展示，不参与排序。
          configCount: pack.configs?.size ?? null,
          seasonCount: pack.seasons?.size ?? null,
          // 用户 2026-10-10（第二轮）：**早于登场**、不参与平均的版本数（不奖不罚）。
          // 界面写「N 个版本整包还没登场，不计入」。
          absentSeasons: pack.absentSeasons ?? 0,
          // 用户 2026-10-10（第一轮）：已登场却**没有任何成绩**、算 0 分的版本数。
          // ⚠️ 它与 `absentSeasons` 含义**相反**（一个是「还没轮到它」、这个才是
          // 「明确的差」），界面必须分开报。（v4.6.78 删掉 `unrankedSeasons`。）
          droppedSeasons: pack.droppedSeasons ?? 0,
          // 这个整包最早可能存在的版本（角色与光锥里较晚登场的那个）。界面据此解释
          // 「为什么这几个旧版本不参与平均」。
          bornSeason: evidence.bornSeason ?? null,
          pool: meta.pool ?? null,
          minCost: meta.minCost ?? null,
          maxCost: meta.maxCost ?? null,
        });
      }
    }
    const all = [];
    for (const unit of acc.values()) {
      unit.envs.sort((a, b) => b.value - a.value || b.score - a.score);
      const total = unit.envs.reduce((n, e) => n + e.value, 0);
      if (!(total > 0)) continue;
      const best = unit.envs[0];
      all.push({
        key: unit.key,
        // 整包不再是「角色 / 星魂 / 光锥」三选一，但保留 kind 字段的旧消费者兼容：
        // 界面与接口都按 `kind === 'pack'` 处理。
        kind: 'pack',
        name: unit.char,
        // 整包的两个附加维度：界面写成「银狼LV.999 E2 · 欢迎来到银河城S1」。
        eidolon: unit.eidolon,
        lc: unit.lc || null,
        superimp: unit.superimp,
        // 整包自己的金数（展示用；**不进公式、不参与排序**）。
        // `gold` 已经是**隐金后**的值（用户 2026-10-11），`rawGold` 是原始值 ——
        // 探针与回归测试靠这两个字段区分「本来就是 0 金」与「被隐金减到 0 金」。
        // ⚠️ `rawGold` / `hiddenCut` **不下发**给浏览器（`projectConclusion` 不投影它们）：
        // 榜面只需要印 `gold`，多带两个数字乘 62 条只是白占载荷。
        gold: unit.gold,
        rawGold: unit.rawGold ?? unit.gold,
        hiddenCut: unit.hiddenCut ?? 0,
        pulls: unit.gold,
        total: Number(total.toFixed(4)),
        /**
         * **纯强度**（用户 2026-10-12 第 3 条）：Σ_副本 副本权重 × `packStrengthOf(表现)`。
         *
         * 与 `total` 的唯一区别就是**不乘金数项**，所以：
         *   * `total` 仍是总榜的排名依据（口径没动，「角色总榜」照旧按性价比排）；
         *   * `strength` 只服务**抽卡方案的强度得分** —— 它是「强度」旋钮要的那把尺子
         *     （高金、低行动值的队伍在这里才排得上去）。
         * 两者共用同一批 `perf`、同一份版本加权，见 `packStrengthOf()` 的注释。
         */
        strength: Number(unit.envs.reduce((n, e) => n + (e.strength || 0), 0).toFixed(4)),
        envCount: unit.envs.length,
        envs: unit.envs,
        basis: 'team-gold-frontier-pack',
        // 并列分组：最佳证据那条配置的身份。界面靠它把并列的整包标成一组。
        tieKey: `${best.id}|${best.evidenceSeason ?? ''}|${best.bestTeamGold}|${best.tier}`,
        bestTeamGold: best.bestTeamGold,
        bestTier: best.tier,
        bestActionValue: best.actionValue,
        // 用户第 10 条：队伍金数完全相同时，用更多限定光锥的那支更强。
        limitedCones: best.limitedCones ?? 0,
        // 用户 2026-10-10（第二轮）：全部副本里「早于登场、不参与平均」的版本数（展示用）。
        absentSeasons: unit.envs.reduce((n, e) => n + (e.absentSeasons || 0), 0),
        // 用户 2026-10-10（第一轮）：全部副本里「已登场却没有任何成绩、算 0 分」的版本数。
        droppedSeasons: unit.envs.reduce((n, e) => n + (e.droppedSeasons || 0), 0),
      });
    }
    /**
     * 总榜排序（用户 2026-10 第 1、10 条）：
     *
     *   1. 总分降序。
     *   2. **两支队伍金数完全相同时，限定光锥更多的那支更强**（第 10 条）。
     *      金数不同时**不用**这一条 —— 那种情况下「金更少的更强」已经由总分里的
     *      `该副本最便宜金数 ÷ 该配置金数` 表达过了，再加一条只会互相打架。
     *   3. 同分的按最佳证据聚在一起（界面据此标「并列」），最后用名字等保证确定性。
     */
    const rankFrontier = (a, b) => b.total - a.total
      || (a.bestTeamGold === b.bestTeamGold ? b.limitedCones - a.limitedCones : 0)
      || String(a.tieKey).localeCompare(String(b.tieKey))
      || String(a.name).localeCompare(String(b.name))
      || a.eidolon - b.eidolon
      || String(a.lc || '').localeCompare(String(b.lc || ''))
      || a.superimp - b.superimp;
    const sorted = all.sort(rankFrontier);
    // ⚠️ **收敛前的完整名单**（按角色分组）要留着给角色面板用 —— 用户 2026-10 要求
    // 「在每个角色的详细界面显示所有的配装的最佳证据的队伍，并分别给出性价比评分」。
    // 总榜按第 1 条每角色只留一条，但面板要展示那一个角色的**全部**配装
    // （E0/E2/E6 × 各光锥 × 叠影；实测收敛前 1097 条 / 67 个角色，单个角色最多 59 条），
    // 所以这里额外导一份。
    //
    // 为什么不给它随 `frontierUnits` 一起下发：实测收敛前 1097 条 / 67 个角色，
    // 而整份结论载荷已经是 0.67 MB —— 全量带上会让面板变成几百 KB 的无用数据。
    // 面板走**按需接口** `/api/archive/packs?char=…`，一个角色一次几十 KB。
    //
    // 形状：`{ [角色英文键]: [整包…] }`，每条与 `frontierUnits` 的元素同构
    // （同一个 `buildPackUnit` 造出来的），界面因此不用认第二套形状。
    const byChar = {};
    for (const unit of sorted) {
      (byChar[unit.name] ||= []).push(unit);
    }
    // ---- 用户2026-10 第 1 条：**每个角色在榜上只出场一次，仅取最大的一项** ----
    //
    // 整包口径下同一个角色会按「星魂档 × 光锥 × 叠影」裂成很多条（E0/E2/E6 × 各种
    // 光锥），于是一个强势角色能把榜单前几十名全占掉，别的角色一个都看不到 —— 用户
    // 的原话就是「避免单一角色霸榜」。这里按角色名收敛成一条：取排序最靠前（= 总分
    // 最高）的那个整包。
    //
    // 丢掉的只是**名次**，不是数据：被收敛掉的整包同样参与了它所在副本的证据计算，
    // 只是不再单独占一行。要看某个角色的其他档位，用界面上「星魂档」筛选器，
    // 或直接打开那个角色的面板（它列的是全部配装）。
    const seenChar = new Set();
    const board = sorted.filter((unit) => {
      if (seenChar.has(unit.name)) return false;
      seenChar.add(unit.name);
      return true;
    });
    // ---- 用户 2026-10-11：星魂档筛选页要**看得到每个档位自己的角色** ----
    //
    // 缺陷原话：「性价比总榜-全部榜单目前做的比较不错，但拆分到 E0/1/2/6，则只能看到
    // 存在最佳成绩的角色，而看不到非最佳成绩的每个角色」。
    //
    // 根因就是上面那条收敛只做了一次：`board` 里每个角色只留总分最高的那一个整包，
    // 于是筛选器再按 `eidolon` 过滤时，剩下的必然是「最佳成绩恰好是这一档」的角色。
    // 实测 51 个有 E0 整包的角色里，**33 个**在 E0 页里根本看不到（真珠 E0 911 分、
    // 遐蝶 E0 637 分……它们的最佳成绩都在 E2/E1，于是连名次带行一起消失）。
    //
    // 但筛选器问的是另一件事：**「这个角色抽到 E0/E1/E2/E6 各值多少分」** ——
    // 那是「档位内的比较」，与「它的最佳成绩落在哪一档」无关。所以每个档位各自收敛
    // 一次，四条链互不干扰：E0 页只和 E0 的整包比，E6 页只和 E6 的整包比。
    //
    // `sorted` 已经是名次序（与 `board` 同一条 `rankFrontier`），所以这里**只过滤
    // 不去重排序**：按序扫一遍，每个角色第一次出现（= 该档位里分最高的那个整包）留下。
    // 刻意不另写一套排序 —— 两处排序迟早会漂移。
    const byTier = new Map();
    for (const tier of EIDOLON_TIERS) {
      const seenTier = new Set();
      byTier.set(tier, sorted.filter((unit) => {
        if ((Number(unit.eidolon) || 0) !== tier) return false;
        if (seenTier.has(unit.name)) return false;
        seenTier.add(unit.name);
        return true;
      }));
    }
    return { board, byChar, byTier };
  })();

  const frontierUnits = frontierBoard.board;
  // 「全部」之外的四个星魂档视图：`{ 0: [整包…], 1: […], 2: […], 6: […] }`，
  // 每条与 `frontierUnits` 的元素**同构**（同一个对象，界面因此不用认第二套形状）。
  // ⚠️ 档位以 `EIDOLON_TIERS` 为准（E3~E5 归入 E2 桶），不要在这里写死 [0,1,2,6]。
  const frontierTiers = frontierBoard.byTier;

  // 压金出分前沿强度：`{ [envId]: { characters, eidolons, raw, rawEidolons, weight } }`。
  // 由服务端 `archiveFrontierAll` 提供（建库侧每个版本的 `frontier` 汇总而来）。
  // 差距榜（`gapUnits`）与星魂全局榜（`eidolonUnits`）都用它。

  const unitList = [...units.values()].map((unit) => {
    // `envsOf` 只用于**展示**「它帮到哪些副本」，以及那个"个人口径"的分值。
    const envsOf = [...unit.byEnv.entries()]
      .map(([id, entry]) => ({ id, ...entry }))
      .filter((e) => e.value > 0);
    // 含它的最好一套打包作业：**只作展示**（「这套还能一起补谁」）。
    const combo = comboByUnit.get(unit.key) || null;
    const best = [...envsOf].sort((a, b) => b.value - a.value
      || a.pulls - b.pulls)[0] || null;
    // ---- 榜单总分：**个人口径**（依赖角色池）----
    //
    // `total` = Σ(该单位自己的贡献 ÷ 自己的期望抽数 × 副本权重)，那个「贡献」来自
    // `cheapestWith` / `strengthOf` —— 是「含它的队伍比你常见成本便宜多少」，
    // **取决于你有没有那些队友**。所以它是"对你来说值多少"，换个人就变。
    //
    // 「它强不强」是另一个问题，由**纯数据集口径**的 `frontierUnits` 回答
    // （前沿加权占比 ÷ 期望抽数），那个榜完全不看角色池。两个榜分工明确：
    //   * `frontierUnits` → 界面上的「角色总榜」（黑塔网数据口径）
    //   * `units`         → 界面上的「抽卡方案」（按你的角色池 + 预算排的补强清单）
    // 这里**不能**拿前沿占比当 `total`：那会让「抽卡方案」按一个与你的账号无关的
    // 顺序开药方（而且 2026-10 一度这么做，把下面六条回归测试全打红了）。
    const personalTotal = Number(envsOf.reduce((n, e) => n + e.value, 0).toFixed(4));
    return {
      key: unit.key,
      kind: unit.kind,
      name: unit.name,
      // 单位自己要几抽、补到什么档位：**以性价比最好的那套作业为准**。
      // 不同作业对同一个角色的星魂要求可能不同（E0 与 E4），如果这里的抽数取
      // 第一次见到的、目标取最好的，界面就会出现「按 E4 显示抽数、按 E0 显示
      // 目标」这种自相矛盾的行。
      pulls: best ? best.ownPulls : unit.pulls,
      // 期望抽数（界面显示「≈ N 抽」，也是性价比的分母）
      pullsExpected: best ? best.pullsExpected : null,
      from: best ? best.from : unit.from,
      target: best ? best.target : unit.target,
      uncertain: best ? best.uncertain : unit.uncertain,
      /** **排序用的总分**：个人口径，Σ_env w(env)×V(u,env)。 */
      total: personalTotal,
      personalTotal,
      //
      // 各副本自己性价比之和（去掉 0 的那些），也就是 `total` 的来源。
      // 表头性价比 = 单位自己的贡献 ÷ 单位自己的期望抽数，再跨副本相加：
      //
      //   V(u) = Σ_env  w(env) × V(u, env)      （docs/评分模型设计.md §修正 A）
      //
      // **不能**用组合口径（`combo.value`）：那是「含它的最好一套**打包**作业」的
      // Σ提升 ÷ Σ成本，不是这个单位的性价比。拿它当排名键会把整包的功劳记到包里
      // 每一个单位头上——同一个包里的单位分到**完全不同**的名次应该是各自的贡献
      // 决定的。实测真实数据上曾出现 3 个单位共享 0.4433、其中一个自己的值只有
      // 0.1015（被抬高 4 倍）。
      // 副本权重已经乘在 `unit.byEnv[].value` 里（见上面 `candValue`），
      // 所以这里只求和、不再加权——重复乘会变成权重的平方。
      perEnvTotal: personalTotal,
      combo: combo ? {
        envs: combo.envs, gain: combo.gain, cost: combo.cost, count: combo.count,
        pulls: combo.pulls, units: combo.items.map((i) => i.name),
      } : null,
      // 进了 `total` 的副本个数。不用 `combo.envs.length`：那是**打包作业**跨的副本数，
      // 含它在这个单位身上贡献为 0 的副本，会和表头的性价比对不上。
      envCount: envsOf.length,
      // 这个单位出现过的副本总数（含贡献为 0 的）：浮层要用它说明「有几个副本没计入」。
      allEnvCount: unit.byEnv.size,
      envs: envsOf.sort((a, b) => b.value - a.value),
      best,
    };
  })
    // 一个副本都没留下的单位（每一处的贡献都是 0）不进榜：个人口径下
    // 「它没帮你在这个副本里少花金」就等于「不值得为你补它」。
    .filter((unit) => unit.total > 0)
    .sort((a, b) => b.total - a.total
    || b.envCount - a.envCount
    || a.pulls - b.pulls
    || String(a.name).localeCompare(String(b.name)));

  // ===================================================================
  // 「我的阵容 vs 主流强阵」的差距（用户 2026-10 要求换问题）
  // ===================================================================
  //
  // 为什么换：原来的口径量的是「升某一档的**边际收益**」，它要求**同一套阵容里
  // 两个星魂档都有投稿**才能配对。实测黑塔网的绝境王棋数据是**两极**的
  //（遐蝶：E2 有 331 条、E6 有 293 条，而 E0 只有 4 条、E1 一条都没有），
  // 于是「同阵容 E0 vs E2」在绝境里只有 **1 套**阵容能配上 —— 关键副本上永远量不出来。
  //
  // 但站点上真正有用的信息不是那个差值，而是：**主流强阵长什么样、和我差几金**。
  // 所以改成直接量这个差距，三个要点：
  //
  //   1. 数据源用**该副本版本窗口里的全部阵容**（`env.teams`），**不是** `candidates`。
  //      `candidates` 只从「可靠版本」里取，而权重最高的绝境王棋 4.5/4.6 恰好不达标
  //      → 用户最关心的目标阵容**整条进不了候选**（实测：绝境里含遐蝶 E2 的阵容
  //      要补 4~5 金、档位 perfect，却一条都没进候选）。差距口径不需要配对证据，
  //      所以没有理由受那道门限制。
  //   2. 「差几金」用建库侧同款的边际造价（`marginalCostOf`）现算：差的就是
  //      照抄这套强阵还缺的角色本体 / 星魂档 / 光锥叠影。它天然含星魂档
  //     （作业要 E2 而你 E0 → 差 2 金），**不需要任何配对**。
  //   3. 只保留「够得着」（差 ≤ `gapMaxPulls`）且「真能到该副本最好档」的目标，
  //      按 `档位分 × 成绩质量 ÷ 总造价` 打分，记到它缺的每个单位头上。
  //
  // 全是**加法**，不再有「跨副本借数」的推断——上一版的 `inferred` 兜底会把同一个
  // gain 换个权重算五遍，既抬高总分又让浮层看起来像五份独立证据。
  const gapTargets = [];
  const gapByUnit = new Map();
  // 「够得着的强阵」允许差几金：**由用户决定**（界面上的「可及预算」输入框）。
  // 默认 5：绝境前沿的成本带在 9~18 金，差 5 金以内算"够得着"；调大就会把
  // 「从零起一套」也算进来（成本高的目标会被 costFactor 折减，所以不会顶掉前排）。
  const gapMaxPulls = Math.max(1, Math.min(30, Number(options.gapMaxPulls) || SCORING.gapMaxPulls));
  /**
   * 某副本里，某个缺口单位的「前沿强度」（= 该单位在**窗口内全部达标投稿**里的占比）。
   *
   * ⚠️ **v4.6.78 起这份占比的口径变了**：以前它是「在最便宜 25% 前沿池里的占比」，
   * 现在池 = 全部成绩，所以它是「出场率」。差距榜因此从「照着压金前沿打还差几金」
   * 变成「照着一线阵容打还差几金」—— 实测榜首价值 152.9 → 117.3、中位 3.77 → 2.95。
   * 若日后想让差距榜回到压金口径，得**单独**再算一份 25% 占比，不要再动这一份。
   *
   * **必须用该单位自己的前沿占比**，不能再乘「角色在前沿的占比」：
   * 乘了就会让弱档位沾强角色的光——实测花火整体在前沿占 25%，于是它的
   * E3（在前沿只占 2%）被算成 25% × 2% = 0.5%，再除以 1 金的便宜造价，
   * 排得比遐蝶 E2 还高。而用户明确说「花火 E3 几乎无提升」。
   *
   * 所以：
   *   * 角色 → 它在池里的占比
   *   * 星魂档 → **该档位自己**在池里的占比（角色内部归一后不再乘角色占比）
   *   * 光锥 → 该光锥在池里的占比
   */
  const frontierStrengthOf = (envId, item) => {
    const f = frontier[envId];
    if (!f || !f.ok) return 0;
    const chars = f.characters || {};
    const eido = f.eidolons || {};
    if (item.kind === 'eidolon') {
      // ⚠️ **不要再乘这个角色在前沿的占比**。乘了就是「角色有多强 × 这一档多常见」，
      // 于是角色一强，它的每个档位（包括完全没用的 E3）都会跟着涨。实测：
      // 花火整体在前沿占 25%，于是 E3（E2→E3 边际只有 0.014）被抬到跟
      // 遐蝶 E2（边际 0.102，量级差 7 倍）一个水平，甚至更高 —— 而用户明确说
      // 「花火 E3 几乎无提升、遐蝶 E2 非常重要」。
      //
      // 正确口径：**边际档位占比**。升这一档换来多少「前沿出场」，
      // 只用这一档自己的数，与角色整体强弱无关。
      const to = Number(eido[`${item.name}|${item.target ?? 0}`]) || 0;
      const from = Number(eido[`${item.name}|${item.from ?? 0}`]) || 0;
      const delta = to - from;
      return delta > 0 ? delta : 0;
    }
    // 角色本体 / 光锥：它自己在前沿的占比。
    return Number(chars[item.name]) || 0;
  };
  // `buildConclusion(null, {})` / 空数组都必须不崩（老回归测试钉住了这条）。
  for (const env of Array.isArray(envs) ? envs : []) {
    const envWeight = envWeightOf(env.mode, env.stage || '');
    const scored = [];
    for (const t of env.teams || []) {
      // 阵容的档位 = 该阵容投稿数最多的那一档（聚合层已经把它拆成 tierCounts 计数，
      // 判据与 `archiveStats` 的定档一致；不要去找不存在的 `t.tier`）。
      const counts = t.tierCounts || {};
      let tier = 'below';
      let tierN = -1;
      for (const [name, n] of Object.entries(counts)) {
        if ((Number(n) || 0) > tierN) { tierN = Number(n) || 0; tier = name; }
      }
      const tierScore = tierScoreOf(tier);
      // 够不着最好档的目标不值得推荐（「差 25 金换个 target」这种）
      if (tierScore < TIER_SCORE.perfect) continue;
      const sample = t.sample;
      if (!sample) continue;
      const mc = marginalCostOf(sample.members || [], availability, account);
      if (!mc.pulls || mc.pulls > gapMaxPulls) continue;
      if (!mc.items.length) continue;
      // 用阵容最佳成绩在人群里的分位，而不是聚合字段 `quality`（它含投稿数可信度）。
      // 投稿数只保留给 evidence 文案，不进入这个价值分。
      const bestPct = percentileOf(t.bestAv ?? t.avgAv, env.dist, env.lowerIsBetter !== false);
      const qual = bestPct === null ? 1 : Math.max(0, Math.min(1, bestPct));
      // 前沿强度：这套阵容里缺的单位在**前沿池**（v4.6.78 起 = 全部达标投稿）上有多强
      // （取最强的那个缺口）。没有前沿数据（老数据集 / 测试夹具）时退回 0，
      // 排序会自然退化成旧口径。
      let frontierBest = 0;
      for (const it of mc.items) frontierBest = Math.max(frontierBest, frontierStrengthOf(env.id, it));
      // 目标价值：**前沿强度为主键**（用户口径：「压金出分榜单里经常出现的
      // 角色十分强力」），成绩质量作可信度折扣，造价只做**温和**的性价比折减。
      //
      // 为什么造价不能用「除以金数」：金是 1~8 的小整数，直接作分母会让
      // 「便宜但几乎没提升」的档位压过「贵一点但关键」的档位 —— 实测花火
      // E2→E3（1 金，前沿边际只有 0.014）就是这样排到了遐蝶 E0→E2（2 金，
      // 边际 0.102）前面，而用户明确说「花火 E3 几乎无提升、遐蝶 E2 非常重要」。
      // 改用 `1 + costScale × (金数 − 1)`：1 金不打折、8 金约打 0.44 折，
      // 造价仍然是分母，但压不过强度的量级差（0.014 vs 0.102，差 7 倍）。
      const costFactor = 1 + SCORING.gapCostScale * (Math.max(1, mc.pulls) - 1);
      // 有前沿数据但缺口恰好没上前沿时留一点底，免得整段排序在 0 上纠缠；
      // 完全没有前沿数据（老数据集 / 测试夹具）时退化成旧的「档位 × 质量」口径。
      const strength = frontierBest > 0 ? frontierBest : 0.02;
      scored.push({
        env: env.id,
        envLabel: env.label || env.id,
        mode: env.mode,
        stage: env.stage || '',
        envWeight,
        roster: t.roster,
        rosterCn: t.rosterCn,
        rosterKey: t.rosterKey,
        tier,
        tierScore,
        quality: Number(qual.toFixed(3)),
        frontier: Number(frontierBest.toFixed(4)),
        pulls: mc.pulls,
        items: mc.items.map((it) => ({ ...it })),
        itemCount: mc.items.length,
        count: t.count,
        evidence: t.evidence,
        season: sample.season ?? null,
        gapScore: Number((
          strength * (tierScore / TIER_SCORE.perfect) * qual / costFactor * 100
        ).toFixed(3)),
      });
    }
    // 目标越强越优先；同档先给便宜的
    scored.sort((a, b) => b.tierScore - a.tierScore
      || a.pulls - b.pulls
      || b.quality - a.quality);
    const targets = scored.slice(0, SCORING.gapTargetsPerEnv);
    gapTargets.push(...targets);
    for (const t of targets) {
      for (const it of t.items) {
        const key = unitKeyOf(it);
        if (!key) continue;
        if (!gapByUnit.has(key)) {
          gapByUnit.set(key, {
            key, kind: it.kind, name: it.name,
            // 界面显示的「金」与下面 `ownPulls`（抽）同源，见 `goldOfPulls` 的注释。
            pulls: goldOfPulls(it.kind, unitPullsOf(it.kind, it.pulls)),
            from: it.from, target: it.target, uncertain: Boolean(it.uncertain),
            byEnv: new Map(),
          });
        }
        const u = gapByUnit.get(key);
        const prev = u.byEnv.get(t.env);
        if (!prev || t.gapScore > prev.gapScore) {
          u.byEnv.set(t.env, {
            gapScore: t.gapScore,
            value: Number((t.gapScore * t.envWeight).toFixed(4)),
            envLabel: t.envLabel,
            roster: t.roster, rosterCn: t.rosterCn, rosterKey: t.rosterKey,
            tier: t.tier, tierScore: t.tierScore, quality: t.quality,
            pulls: t.pulls,
            itemCount: t.itemCount,
            ownPulls: unitPullsOf(it.kind, it.pulls),
            companions: t.items.filter((x) => unitKeyOf(x) !== key).map((x) => ({ ...x })),
            count: t.count, evidence: t.evidence, season: t.season,
            inferred: false,
          });
        }
      }
    }
  }
  const gapUnits = [...gapByUnit.values()].map((u) => {
    const envsOf = [...u.byEnv.entries()].map(([id, e]) => ({ id, ...e }))
      .sort((a, b) => b.value - a.value);
    const total = envsOf.reduce((n, e) => n + e.value, 0);
    const best = envsOf[0] || null;
    const targets = envsOf.map((e) => ({
      env: e.id, envLabel: e.envLabel, roster: e.roster, rosterCn: e.rosterCn,
      tier: e.tier, tierScore: e.tierScore, quality: e.quality, pulls: e.pulls,
      itemCount: e.itemCount, companions: e.companions, count: e.count,
      season: e.season, value: e.value,
    }));
    return {
      key: u.key, kind: u.kind, name: u.name,
      // 兼容界面既有字段
      total: Number(total.toFixed(4)),
      gap: Number(total.toFixed(4)),
      // 「这一档要几金」（单位自己）与「这条路一共差几金」。
      //
      // `pulls` 必须从 **`best`**（排序用的那个环境）的 `ownPulls` 反推，不能沿用
      // 建 `gapByUnit` 时第一次见到的那个值：同一个单位在不同副本里要求的档位不同
      // （虚构叙事要求 E0 → 1 金；绝境要求 E2 → 3 金），先到先得会把爻光这种
      // 显示成 1 金。金数与抽数同源（见 `goldOfPulls`），所以两处不会再分叉。
      pulls: best ? goldOfPulls(u.kind, best.ownPulls) : u.pulls,
      ownPulls: best ? best.ownPulls : null,
      from: u.from, target: u.target, uncertain: u.uncertain,
      envCount: envsOf.length,
      allEnvCount: envsOf.length,
      // 「要照抄的强阵」+「一共差几金」——界面直接可读
      gapTarget: best ? {
        roster: best.roster, rosterCn: best.rosterCn, tier: best.tier,
        pulls: best.pulls, itemCount: best.itemCount, envLabel: best.envLabel,
      } : null,
      targets,
      companions: best ? best.companions : [],
      envs: envsOf,
    };
  }).sort((a, b) =>
    // 主键：**目标阵容在前沿池里有多强**（`total` = Σ 各副本 gapScore × 副本权重）。
    // 这是用户 2026-10 的口径：「绝境王棋压金出分榜单里经常出现的角色十分强力」——
    // 所以排序看的是「证明过的强度」，不是「差几金」。
    // ⚠️ v4.6.78 起池 = 全部达标投稿（不再是压金前沿），这份「证明过的强度」也随之
    // 从「能在少金下出分」变成「出场率」；要恢复压金口径需单独算一份 25% 占比。
    b.total - a.total
    // 同强度时先给便宜的（同样能到前沿，补 1 金优于补 7 金）
    || (a.pulls ?? 99) - (b.pulls ?? 99)
    || String(a.name).localeCompare(String(b.name)));

  // ===================================================================
  // 星魂的**全局榜**：按「该档位在同阵容里能把成本压到多低」排序。
  // ===================================================================
  //
  // 为什么不能沿用「前沿占比」或「前沿边际」给星魂档排序（都实测过）：
  //   * 前沿占比：「这一档在便宜队里出现多少」被**持有率**污染 —— 高命玩家更多，
  //     于是永远偏高。实测花火 E3（用户明确说几乎无提升）占比 0.018，
  //     而千冶•刃 E2（绝境前沿第一梯队的档位）只有 0.349 却被算成负边际。
  //   * 前沿边际：算出来是「占比差」，被持有率一压，千冶•刃 E2、爻光 E2 全被误杀。
  //
  // 唯一**同阵容配对**、不受持有率影响的量是 `eidoPerf[char][level].cost`：
  // 「同一套阵容里，该角色处于该档位时这支队伍花了几金」。于是：
  //
  //   minCost(char, level) = 该档位在所有满分阵容里出现过的**最低队伍成本**
  //
  // 这个量的含义正好是用户要的「关键金」：**用了这一档，最便宜能压到几金**。
  // 用户举的两个例子在数据里就是这个形态：
  //   姬子•启行 E2 = 绝境 10 金（E3 要 11 金、E0 无记录）
  //   砂金•戏浪 E6 = 绝境 10 金（E2 = 11 金）
  //
  // 它还天然免疫「多次投稿」：只取最小值，重复投稿不加分（用户的第 2 条要求）。
  const eidoCost = new Map();   // `${char}|${level}` -> { cost, envId }
  const eidoCount = new Map();  // 同上 -> 出现过的阵容数
  const eidoWeighted = new Map(); // 同上 -> Σ(副本权重 ÷ 该副本最低成本) ← 受用户权重影响
  if (Array.isArray(envs)) {
    for (const env of envs) {
      // 副本权重直接乘在这一项上（0 = 这个副本不参与星魂榜）。
      //
      // 这里原来读的是服务端前沿表里的 `weight`，而那份表**可能压根没传**
      // （浏览器/测试夹具只调 buildConclusion 时 `frontier` 是空的）→ 整条星魂榜
      // 静默按 1 算，异相仲裁·绝境的 10 倍权重白丢。现在直接问 `envWeightOf`
      // （方案口径），有没有前沿数据都一致。
      const w = weightOr(envWeightOf(env.mode, env.stage || '', 'plan'));
      // 该副本内的成本下限（用来把成本折成"相对便宜多少"，跨副本可比）
      let envMin = Infinity;
      for (const t of env.teams || []) {
        for (const levels of Object.values(t.eidoPerf || {})) {
          for (const v of Object.values(levels || {})) {
            const c = Number(v?.cost);
            if (Number.isFinite(c) && c > 0 && c < envMin) envMin = c;
          }
        }
      }
      if (!Number.isFinite(envMin)) continue;
      for (const t of env.teams || []) {
        // 只收满分档：别的档位记的是「打不满的队」，成本低不算本事。
        const counts = {
          perfect: Number(t.perfect) || 0, target: Number(t.target) || 0,
          pass: Number(t.pass) || 0, below: Number(t.below) || 0,
        };
        let tier = 'below'; let bestN = -1;
        for (const [name, v] of Object.entries(counts)) if (v > bestN) { bestN = v; tier = name; }
        if (tier !== 'perfect') continue;
        for (const [char, levels] of Object.entries(t.eidoPerf || {})) {
          for (const [lv, v] of Object.entries(levels || {})) {
            const level = Number(lv);
            // 旧星魂榜也只保留四个实际目标档；E3~E5 的投稿归到 E2 桶，
            // 但不能拿 E3/E4/E5 的总成本冒充 E2 证据。
            if (eidolonTierOf(level) !== level) continue;
            const c = Number(v?.cost);
            if (!Number.isFinite(c) || c <= 0) continue;
            const k = `${char}|${level}`;
            const prev = eidoCost.get(k);
            if (!prev || c < prev.cost) eidoCost.set(k, { cost: c, envId: env.id });
            eidoCount.set(k, (eidoCount.get(k) || 0) + 1);
            // 加权分：这个档位在**该副本**里能把成本压到 envMin 的多少倍，乘副本权重。
            // 用户调副本权重会直接改变这一项 —— 这就是「星魂榜也能设置权重」。
            eidoWeighted.set(k, (eidoWeighted.get(k) || 0) + w * (envMin / c));
          }
        }
      }
    }
  }
  // 每个角色的「成本地板」= 它所有档位里最低的那个成本
  const floorOf = new Map();
  for (const [k, v] of eidoCost) {
    const char = k.split('|')[0];
    const p = floorOf.get(char);
    if (p === undefined || v.cost < p) floorOf.set(char, v.cost);
  }
  const eidolonUnits = [...eidoCost.entries()]
    .map(([k, v]) => {
      const [char, lvStr] = k.split('|');
      const level = Number(lvStr);
      const floor = floorOf.get(char);
      const tierIndex = EIDOLON_TIERS.indexOf(level);
      const from = tierIndex > 0 ? EIDOLON_TIERS[tierIndex - 1] : 0;
      // 只推荐**非本体**档位（E0 是本体，属于角色榜的事）
      if (level <= 0) return null;
      // 只保留**限定角色**：4★ 与常驻 5★ 的星魂不算成本（抽限定时顺带就满了），
      // 它们的「最低打满成本」低只是因为本体免费，不代表这一档有价值。
      // 实测不加这条时榜单会被「开拓者•记忆 E5→E6 / 停云 E5→E6」这类占满。
      if (availability?.characters?.[char]?.limited !== true) return null;
      // 这个档位值不值：它是否就是该角色的成本地板（= 最便宜的打法要求这一档），
      // 以及它比该角色的地板贵几金（越接近地板 = 这一档越是"能压金"的那一档）。
      const gapToFloor = v.cost - floor;
      return {
        key: `eido:${char}:${level}`, kind: 'eidolon', name: char,
        from, target: level,
        // 界面：这一档要求几金（就是该阵容的队伍成本），以及离地板差几金
        pulls: eidolonGoldOf(from, level),
        ownPulls: unitPullsOf('eidolon', eidolonGoldOf(from, level)),
        minCost: v.cost, floorCost: floor, gapToFloor,
        isFloor: gapToFloor === 0,
        sampleCount: eidoCount.get(k) || 0,
        envId: v.envId,
        // 排序分：**受用户副本权重影响**的加权「压金能力」。
        // 每一项是「该档位在该副本里把成本压到该副本下限的倍数 × 副本权重」，
        // 所以把绝境权重调高，绝境里能压金的档位就会升上来。
        score: Number((eidoWeighted.get(k) || 0).toFixed(4)),
      };
    })
    .filter(Boolean)
    // 主键：加权压金能力（用户权重直接生效）；再按"离地板多近 × 样本量"
    .sort((a, b) => b.score - a.score
      || Number(b.isFloor) - Number(a.isFloor)
      || a.minCost - b.minCost
      || String(a.name).localeCompare(String(b.name)));

  return {
    envs: envResults,
    units: unitList,
    // 角色总榜：**纯黑塔网数据口径**（不依赖角色池，只看副本权重）
    frontierUnits,
    // 逐星魂档的角色总榜（用户 2026-10-11 报的缺陷）：`{ 0: […], 1: […], 2: […], 6: […] }`，
    // 每档各自按角色收敛成一条（与 `frontierUnits` 同一条排序，只是先按档位筛过）。
    //
    // 为什么必须单独一份、不能靠界面拿 `frontierUnits` 过滤：那份每角色只有一条，
    // 一过滤就只剩「最佳成绩落在这一档」的角色（实测 E0 页因此少掉 33/51 个角色）。
    // 为什么不做成 `frontierPacksByChar` 那种全量：全量 960 条 / 1.7 MB，而四档收敛后
    // 只有 156 条（实测 +约 250 KB，见 `tools/_probe-tier-board.mjs`）—— 仍然是每角色
    // 每档一条，不重复占行。
    frontierTiers: Object.fromEntries(frontierTiers),
    // **收敛前**每个角色的全部整包（按角色英文键分组，各角色内按性价比降序）。
    //
    // ⚠️ 不进 `projectConclusion` 的载荷（那里只发收敛后的 `frontierUnits`）：
    // 实测收敛前 1097 条 / 67 个角色，全量下发会让结论载荷多几百 KB，而总榜一个
    // 字节都用不上。角色面板走按需接口 `/api/archive/packs?char=…`（服务端从这份
    // 数据里按角色取），一次一个角色、几十 KB。
    frontierPacksByChar: frontierBoard.byChar,
    // 总榜每个副本的**元数据**（标签 / 权重 / 该副本最便宜金数）。
    //
    // 单独发一份而不是塞进每个整包：整包有 1000+ 条，而副本只有 5 个 —— 逐条重复
    // 这些常量会让结论载荷从 597 KB 涨到 1.1 MB（实测）。界面按 `id` 查这张表。
    frontierEnvs: [...frontierMeta.entries()].map(([id, meta]) => ({
      id,
      label: meta.envLabel || id,
      mode: meta.mode || null,
      stage: meta.stage || '',
      weight: weightOr(meta.weight),
      pool: meta.pool ?? null,
      // 判据线（`0T` / `积分 4000` / `行动值 <300`）：界面用它把内部档位键翻成
      // **游戏内实际的量**（用户 2026-10-10：「把『满分』『达标』改为具体的行动值」）。
      // ⚠️ **必须下发** —— 这三条线只存在数据集里（`herta-build.mjs` 的 `TIER_LINES`），
      // 界面编不出来；缺了就退回「最好一档 / 次好一档」这种没有信息量的兜底写法。
      tierLines: meta.tierLines || null,
      // ⚠️ 这两个字段必须**真的下发**：`frontierFactorsOf` 用它复现金数项，缺了它就会
      // 退回 `minCost`（全窗口最小值）—— 那正是用户 2026-10-10 第 5 轮要修的口径，
      // 表现为「浮层里的金数项与榜上的分对不上」（实测踩过：meta 少一层映射，
      // `minCostBySeason` 静默丢掉，用例报 `undefined`）。
      minCost: meta.minCost ?? null,
      minCostBySeason: meta.minCostBySeason || {},
      maxCost: meta.maxCost ?? null,
      minAction: meta.minAction ?? null,
      maxAction: meta.maxAction ?? null,
      // 行动值项的区间边界与方向（界面拆「贡献值来源」时要用，见 frontierFactorsOf）
      avLo: meta.avLo ?? null,
      avHi: meta.avHi ?? null,
      lowerIsBetter: meta.lowerIsBetter !== false,
      // 版本维度（用户第 7 条）：窗口内的版本列表与每个版本的权重。界面据此写
      // 「按 N 个版本加权」，不必自己再抄一遍 2:2:2:1:1:1:1 那张表。
      versionWindow: meta.versionWindow ?? VERSION_WINDOW,
      seasons: meta.seasons || [],
      seasonWeights: meta.seasonWeights || {},
    })),
    // 「和主流强阵的差距」榜（用户 2026-10 换的口径）：回答「照着主流打，我还差几金」
    gapUnits,
    gapTargets,
    // 星魂的**全局榜**：按「该档位同阵容内能把成本压到多低」排序。
    // 同阵容配对（`eidoPerf[char][level].cost`），所以不受持有率污染；
    // 只取最小值，所以重复投稿不加分。
    eidolonUnits,
    // `packages`：**作业榜**（每个副本挑一套「照抄这套就好」的阵容）。
    //
    // ⚠️ 它现在**不再是抽卡方案的数据源**（2026-10 起 `budgetPlan` 直接用
    // `units` 排清单，见那里的注释）；保留它是因为它是公开 API 的一部分
    // （README 有文档、e2e 有断言），界面上暂时没有位置。
    //
    // 取样必须**按副本均衡轮转**，不能全局取前 24 个：早先全局排序时强势副本
    // （异相仲裁）把名额全占了 —— 实测 24 套里 20 套来自 `aa`、4 套来自 `moc`，
    // `pf`/`as`/`绝境` 一套都没有。按 `envWeight × value` 排序后每个副本先各拿一套
    // 再拿第二套，每个副本就都有代表。
    packages: (() => {
      const byEnv = new Map();
      for (const c of allCandidates) {
        if (!byEnv.has(c.env)) byEnv.set(c.env, []);
        byEnv.get(c.env).push(c);
      }
      const rank = (a, b) => (b.value * weightOr(b.envWeight)) - (a.value * weightOr(a.envWeight))
        || a.pulls - b.pulls;
      for (const list of byEnv.values()) list.sort(rank);
      const queues = [...byEnv.values()];
      const out = [];
      for (let round = 0; out.length < SCORING.packageLimit; round += 1) {
        let added = 0;
        for (const q of queues) {
          const next = q[round];
          if (!next) continue;
          out.push(next);
          added += 1;
          if (out.length >= SCORING.packageLimit) break;
        }
        // 所有队列都空了就停，否则会死循环
        if (!added) break;
      }
      return out;
    })(),
    counts: {
      envs: envResults.length,
      units: unitList.length,
      // 纯数据集口径总榜的条数与构成（界面表头要写整包条数 / 覆盖多少角色与光锥）
      frontierUnits: frontierUnits.length,
      frontierPacks: frontierUnits.length,
      frontierChars: new Set(frontierUnits.map((u) => u.name)).size,
      frontierCones: new Set(frontierUnits.filter((u) => u.lc).map((u) => u.lc)).size,
      gapUnits: gapUnits.length,
      packages: allCandidates.length,
      // 按种类分开，界面要分「角色 / 星魂 / 光锥」三段
      chars: unitList.filter((u) => u.kind === 'char').length,
      eidolons: unitList.filter((u) => u.kind === 'eidolon').length,
      cones: unitList.filter((u) => u.kind === 'cone').length,
    },
  };
};
