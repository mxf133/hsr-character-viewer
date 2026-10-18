/**
 * 抽卡推荐 v2 · 投稿评分（服务端纯函数）
 *
 * 这一份是 §一「投稿得分」与「角色整包得分」的**唯一实现**，刻意不碰 IO：
 * 输入是一排 frontier 行（`{season, c, a, t, n, m}`），输出是带分的行 + 整包分。
 * 谁要算都走这里，浏览器端不再自己抄一遍公式。
 *
 * 公式（逐字按需求文档，见 `docs/抽卡推荐重构设计.md` §3）：
 *
 *   行动值型（绝境 / 末日幻影）
 *     强度得分 = 强度权重 × (1 − 行动值 / 500)
 *     性价比得分 = 该版本 <500 行动值的最低金 / 此配队使用金
 *   轮次型（混沌 / 虚构 / 异相仲裁骑士关）
 *     强度得分 = 强度权重 / (轮次 + 1)
 *     性价比得分 = 该版本 0T 的最低金 / 此配队使用金
 *   投稿得分 = 强度得分 + 性价比权重 × 性价比得分
 *
 * ⚠️ 强度项已经乘过 `ws`，投稿得分里**只**给成本项乘 `wc`。这是需求文档的写法，
 *    不要「顺手对称化」把它改成 `ws × 强度 + wc × 成本` —— 那是另一套模型。
 *
 * ⚠️ 两处必须防御的特殊值（0 金队与无基准），见 `baselineOf` 与 `costPartOf` 的注释。
 */

// ------------------------------------------------------------------ 判据类型

/**
 * 哪些关卡是**行动值型**。其余一律轮次型。
 *
 * 这不是拍脑袋定的：`tools/herta-build.mjs:414-419` 已经把 action_value 按模式
 * 算过一遍——末日是 `4000 − 积分`、绝境取真实 action_value、**其余模式根本没填，
 * 回落到 metric（轮次）**。所以 `frontier.a` 本身就「行动值型给行动值、轮次型给轮次」，
 * 这里只需记录哪些关卡要按行动值判。
 */
const AV_ENVS = new Set(['aa|plight', 'as|']);

/**
 * mode 短码归一化：数据集用全名（`Memory of Chaos`），界面用短码（`moc`），两边都得认。
 *
 * ⚠️ 必须与 `src/server/archive.js` 的 `MODE_LABELS` 保持一致——但它那份是
 * `{短码: 全名}`，这里反过来用。既然本模块刻意不 import 有 IO 的 archive.js，
 * 一致性由 `tools/gacha-score-test.mjs` 里那组「两种写法结果相同」的用例钉住。
 */
const MODE_ALIASES = Object.freeze({
  moc: 'moc', pf: 'pf', as: 'as', aa: 'aa',
  'memory of chaos': 'moc',
  'pure fiction': 'pf',
  'apocalyptic shadow': 'as',
  'anomaly arbitration': 'aa',
});
const shortModeOf = (mode) => {
  const raw = String(mode ?? '').trim().toLowerCase();
  return MODE_ALIASES[raw] || raw;
};

export const envKindOf = (mode, stage = '') => (
  AV_ENVS.has(`${shortModeOf(mode)}|${stage || ''}`) ? 'av' : 'round'
);

/**
 * 把可能是 null / undefined / '' 的字段安全地转成数字，**缺失返回 null**。
 *
 * ⚠️ **不能直接 `Number(value)`** —— `Number(null) === 0`、`Number('') === 0`，
 * 会把「这一条投稿压根没填行动值」读成「行动值就是 0」，于是它被当成 0T：
 * 既混进 `baseline`（把最低金拉低），也混进 0T 的上场率统计。
 * 这个坑 `herta-build.mjs:409-416` 已经踩过一次并写了警告，这里是同一条数据链的下游。
 */
export const finiteOf = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** 行动值型的「及格线」：≥500 视为没打到那条线，强度项归 0。 */
export const AV_CAP = 500;

/** 轮次型的「0T」= 0 轮。达标-only 的 baseline 用它当门槛。 */
const ZERO_ROUND = 0;

// ------------------------------------------------------------------ 星魂档

/** 参与比较的四个星魂档（与旧版一致）。 */
export const EIDOLON_TIERS = Object.freeze([0, 1, 2, 6]);

/** 真实星魂级数 → 比较用的档。E3~E5 归到 E2（它们不构成独立的推荐目标）。 */
export const eidolonTierOf = (level) => {
  const n = Number(level);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 6) return 6;
  if (n >= 2) return 2;
  return 1;
};

// ------------------------------------------------------------------ 成员与整包

/**
 * `frontier.m[]` 的写法是 `"字符名|星魂|光锥|叠影"`。
 * 拆出一个结构化对象；`superimp` 缺省按 0（没装 = 没叠影，不是叠影 1）。
 */
export const memberOf = (text) => {
  const [char, eidolon, lc, superimp] = String(text || '').split('|');
  return {
    char: char || '',
    eidolon: Number.isFinite(Number(eidolon)) ? Number(eidolon) : 0,
    lc: lc || null,
    superimp: Number.isFinite(Number(superimp)) ? Number(superimp) : 0,
  };
};

/**
 * 「角色整包」= 角色 + 星魂档 + 光锥 + 叠影，**四样一起**才算一个可比较单位。
 *
 * 星魂要过 `eidolonTierOf` 归并：否则同为 E3 与 E4 的投稿会被当成两个不同整包，
 * 各自只有零星投稿，整包得分被人为稀释。
 */
export const packKeyOf = (member) => {
  const m = typeof member === 'string' ? memberOf(member) : member;
  return `${m.char}|E${eidolonTierOf(m.eidolon)}|${m.lc || '-'}|S${m.superimp}`;
};

/** 从整包键反解出结构（渲染要展示 E 几 / S 几）。 */
export const packOf = (key) => {
  const [char, eidolon, lc, superimp] = String(key).split('|');
  return {
    char,
    eidolon: Number(String(eidolon).replace(/^E/, '')) || 0,
    lc: lc === '-' ? null : lc,
    superimp: Number(String(superimp).replace(/^S/, '')) || 0,
  };
};

// ------------------------------------------------------------------ 基准最低金

/**
 * 某版本该关卡的**基准最低金**（§3.2）。
 *
 *   行动值型 → 打到 <500 行动值的最便宜那队是多少金
 *   轮次型   → 打到 0T 的最便宜那队是多少金
 *
 * ⚠️ **必须剔除 0 金队**（`c > 0` 那个判断）。放开 tier 过滤后混进了 19 行全四星队
 * （`Clara + 开拓者(记忆) + 停云 + 加拉赫` 之类），它们的 `c` 是 0。
 * 若不过滤，`baseline` 会被拉到 0 ⇒ 所有队伍的性价比得分一起变成 0 or Infinity。
 * 实测唯一受影响的四处：末日幻影 4.4 的 baseline 由 1 变 0。
 *
 * @returns {number} 找到返回最小金数；一个达标行都没有返回 0（调用方把它当「无基准」）
 */
export const baselineOf = (rows, kind) => {
  let min = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const cost = finiteOf(row.c);
    if (!(cost > 0)) continue;
    const av = finiteOf(row.a);
    if (av === null) continue;
    const reached = kind === 'av' ? av < AV_CAP : av === ZERO_ROUND;
    if (reached && cost < min) min = cost;
  }
  return Number.isFinite(min) ? min : 0;
};

// ------------------------------------------------------------------ 两个分量

/**
 * 强度分量（已乘 `ws`）。
 *
 * `a` 缺失（例如某些投稿没填成绩）→ 0，而不是取一个「看起来合理」的中位数。
 * 行动值型在 `a ≥ 500` 时被 `max(0, …)` 夹住：放开 tier 之后确有慢速投稿进来，
 * 负分会让排序失去意义。
 */
export const strengthPartOf = (av, kind, ws = 1) => {
  const a = finiteOf(av);
  if (a === null) return 0;
  if (kind === 'av') return ws * Math.max(0, 1 - a / AV_CAP);
  return ws / (Math.max(0, a) + 1);
};

/**
 * 性价比分量 = baseline / 此配队使用金，∈ (0, 1]。
 *
 * ⚠️ 两个特殊值：
 *   * `cost = 0`（0 金队）→ **给 1（满分）**。它比 baseline 还便宜，本来就是最省的一档，
 *     而 `baseline / 0` 是 Infinity，会让这些队霸榜。
 *   * `baseline = 0`（该版本一个达标投稿都没有）→ **给 0**。取不到基准就不要假装能算。
 */
export const costPartOf = (cost, baseline) => {
  const c = finiteOf(cost);
  if (!(c > 0)) return 1;
  const base = finiteOf(baseline);
  if (!(base > 0)) return 0;
  return Math.min(1, base / c);
};

/** 一条投稿的得分。 */
export const scoreRow = (row, ctx) => {
  const { kind, baseline, ws = 1, wc = 1 } = ctx;
  const strengthPart = strengthPartOf(row.a, kind, ws);
  const costPart = costPartOf(row.c, baseline);
  return { strengthPart, costPart, score: strengthPart + wc * costPart };
};

// ------------------------------------------------------------------ 逐版本打分

/**
 * baseline 是**逐版本**的（「投稿所在版本、且用户选择的模式的最低金」），
 * 所以打分前先按 season 分组。
 */
export const groupBySeason = (rows) => {
  const groups = new Map();
  for (const row of rows) {
    const key = row.season;
    let bucket = groups.get(key);
    if (!bucket) groups.set(key, (bucket = []));
    bucket.push(row);
  }
  return groups;
};

/**
 * 给一整个（关卡 × 版本窗口）的投稿打分，并带上版本权重。
 *
 * @param rows  `[{season, c, a, t, n, m, …}]`，同一关卡多版本混在一起
 * @param ctx   `{mode, stage, ws, wc, versionWeightOf(season)}`
 * @returns     排好 new→old 的 `{rows, baselines, seasons, rowsBySeason}`
 */
export const scoreEnvRows = (rows, ctx) => {
  const { mode, stage, ws = 1, wc = 1, versionWeightOf = () => 1 } = ctx;
  const kind = envKindOf(mode, stage);
  const groups = groupBySeason(rows);
  const baselines = new Map();
  const scored = [];

  for (const [season, list] of groups) {
    const baseline = baselineOf(list, kind);
    baselines.set(season, baseline);
    const weight = versionWeightOf(season) ?? 1;
    for (const row of list) {
      scored.push({
        ...row,
        season,
        kind,
        baseline,
        versionWeight: weight,
        ...scoreRow(row, { kind, baseline, ws, wc }),
      });
    }
  }
  return { kind, scored, baselines, seasons: [...groups.keys()] };
};

// ------------------------------------------------------------------ 角色整包得分

/**
 * §3.5 角色整包得分。
 *
 *   整包某版本得分 = 该版本投稿得分的**最高分** × 版本权重
 *   整包得分       = 所有版本投稿得分之和 / 版本权重之和
 *
 * **分母规则**（需求文档原话，两条缺一不可）：
 *   * 整包**未上线**（登场版本晚于该版本）→ 分子分母都**不计**
 *   * 整包**已上线但无投稿** → 分子记 **0**，分母**计入**
 *
 * 第二条是防止「只在最新一期露过脸的角色」白蹭高分：缺的分是 0，不是「不存在」。
 *
 * @param scored    `scoreEnvRows()` 的输出里的 scored 数组
 * @param ctx.seasons         窗口内的全部版本（new→old 或任意，但要全）
 * @param ctx.versionWeightOf (season) => number
 * @param ctx.debutSeasonOf    (packKey) => season | null；null = 查不到登场版本，视为一直在线
 * @param ctx.versionCmp       (a, b) => -1|0|1，版本先后
 */
export const aggregatePacks = (scored, ctx) => {
  const {
    seasons = [],
    versionWeightOf = () => 1,
    debutSeasonOf = () => null,
    versionCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }),
  } = ctx;

  // 第一趟：每个整包在**每个版本**上只留最高分。
  const bestByPackSeason = new Map();
  const packMembers = new Map();
  for (const row of scored) {
    for (const text of row.m || []) {
      const key = packKeyOf(text);
      if (!packMembers.has(key)) packMembers.set(key, memberOf(text));
      let bucket = bestByPackSeason.get(key);
      if (!bucket) bestByPackSeason.set(key, (bucket = new Map()));
      const prev = bucket.get(row.season);
      const score = row.score ?? 0;
      if (prev === undefined || score > prev.score) bucket.set(row.season, { score, row });
    }
  }

  // 第二趟：跨版本加权。
  const packs = [];
  for (const [key, bySeason] of bestByPackSeason) {
    const debut = debutSeasonOf(key);
    let weighted = 0;
    let weightSum = 0;
    const missing = [];
    for (const season of seasons) {
      // 未上线 ⇒ 这一版既不加分子也不加分母。
      if (debut && versionCmp(season, debut) < 0) continue;
      const weight = versionWeightOf(season) ?? 1;
      if (!(weight > 0)) continue;
      weightSum += weight;
      const hit = bySeason.get(season);
      if (hit) weighted += hit.score * weight;
      else missing.push(season);
    }
    packs.push({
      key,
      ...packOf(key),
      score: weightSum > 0 ? weighted / weightSum : 0,
      weightSum,
      // 哪些在线版本没有投稿（分子记 0）。UI 上用来解释「为什么分低」。
      missingSeasons: missing,
      seasons: bySeason.size,
    });
  }
  return packs.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
};

// ------------------------------------------------------------------ 上场率分层

/**
 * §5.1 四类口径，**按关卡类型分两套判据**。
 *
 * 行动值型：`通关 / <300 行动值 / 300~500 行动值 / 0T`
 * 轮次型  ：`通关 / 0T / 1T / 2T 及以上`
 *
 * @returns `[{key, label, match(row, kind)}]`
 */
const isAv = (row) => finiteOf(row?.a);

export const USAGE_BANDS_OF = {
  av: [
    { key: 'clear', label: '通关', match: () => true },
    { key: 'lt300', label: '小于 300 行动值', match: (r) => { const a = isAv(r); return a !== null && a < 300; } },
    { key: 'av300', label: '300 ~ 500 行动值', match: (r) => { const a = isAv(r); return a !== null && a >= 300 && a < AV_CAP; } },
    { key: 'zero', label: '0 行动值', match: (r) => isAv(r) === 0 },
  ],
  round: [
    { key: 'clear', label: '通关', match: () => true },
    { key: 'zero', label: '0T', match: (r) => isAv(r) === 0 },
    { key: 'r1', label: '1T', match: (r) => isAv(r) === 1 },
    { key: 'r2', label: '2T 及以上', match: (r) => { const a = isAv(r); return a !== null && a >= 2; } },
  ],
};

/**
 * 某一档里面的角色人次。
 *
 * ⚠️ **按 `row.n`（真实投稿数）累加，不是按行数**。同一套阵容常被拆出十几种配装变体，
 * 按行数计出来的是「配装变体数」而不是「多少人在玩」—— 实测 27901 行 vs 30627 条投稿。
 *
 * @returns `Map<charName, submissions>` 降序排列的数组
 */
export const usageByBand = (rows, band) => {
  const counts = new Map();
  for (const row of rows) {
    if (!band.match(row)) continue;
    // 缺省按 1 条记（老数据集没有 n 字段时不至于把这些投稿整个丢掉）；
    // ⚠️ `null` 必须一并兜住 —— Number(null) === 0 会让该行凭空消失。
    const submits = Math.max(1, finiteOf(row.n) ?? 1);
    // 同一行里同一角色只数一次（开拓者的多个形态是不同的 char 名，故不受影响）。
    for (const text of new Set(row.m || [])) {
      const char = memberOf(text).char;
      counts.set(char, (counts.get(char) || 0) + submits);
    }
  }
  // share 的分母是**全部角色人次之和**（不是投稿数）：一支队伍有 4 个位置，
  // 一圈下来 4 个角色各得一次，所以 Σcount ≈ 4 × Σn。用 Σn 当分母会得到
  // Σshare ≈ 4，饼图就讲不通了。
  let total = 0;
  for (const count of counts.values()) total += count;
  return [...counts.entries()]
    .map(([char, count]) => ({ char, count, share: total > 0 ? count / total : 0 }))
    .sort((a, b) => b.count - a.count || a.char.localeCompare(b.char));
};
