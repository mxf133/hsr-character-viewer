/**
 * 抽卡推荐 v2 · 评分内核的**纯函数**（浏览器端与服务端共用同一份）。
 *
 * 为什么这份代码放在 `public/scripts/` 而不是 `src/server/`：
 *   * **角色总榜**的打分在浏览器端算（`public/scripts/advice.js` 的 `frontierBoard`）；
 *   * **抽卡方案**的打分在服务端算（`src/server/gacha-score.js`）。
 * 两边必须用**同一套公式** —— 这个仓库已经吃过「两套跨版本聚合各写一遍、必然分叉」的亏
 * （v4.6.139 审计的「真问题三」）。所以把「判据类型 / 强度分 / 性价比分 / 基准最低金」
 * 这四个纯函数挪到这里，服务端 `gacha-score.js` 反过来 import 并 re-export，
 * 旧的导入路径（`tools/gacha-score-test.mjs` 等）一行都不用改。
 *
 * ⚠️ 这里**只放不碰 IO、不读数据集的纯函数**。带 `scoreEnvRows()` / `aggregatePacks()`
 *    那种「整批行打分 + 聚合」的逻辑留在 `src/server/gacha-score.js`。
 */

/** 行动值型关卡：绝境王棋关与末日幻影。其余一律轮次型（见 `frontier.a` 的写法）。 */
const AV_ENVS = new Set(['aa|plight', 'as|']);

/**
 * 数据集用全名（`Memory of Chaos`）、界面用短码（`moc`），两边都得认。
 *
 * ⚠️ 必须与 `src/server/archive.js` 的 `MODE_LABELS` 保持一致——但它那份是
 * `{短码: 全名}`，这里反过来用。本模块刻意不 import 有 IO 的 archive.js，
 * 一致性由 `tools/gacha-score-test.mjs` 里那组「两种写法结果相同」的用例钉住。
 */
const MODE_ALIASES = Object.freeze({
  moc: 'moc', pf: 'pf', as: 'as', aa: 'aa',
  'memory of chaos': 'moc',
  'pure fiction': 'pf',
  'apocalyptic shadow': 'as',
  'anomaly arbitration': 'aa',
});

export const shortModeOf = (mode) => {
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

/**
 * 某版本该关卡的**基准最低金**（设计文档 §3.2）。
 *
 *   行动值型 → 打到 <500 行动值的最便宜那队是多少金
 *   轮次型   → 打到 0T 的最便宜那队是多少金
 *
 * ⚠️ **必须剔除 0 金队**（`c > 0` 那个判断）。放开 tier 过滤后混进了 19 行全四星队
 * （`Clara + 开拓者(记忆) + 停云 + 加拉赫` 之类），它们的 `c` 是 0。
 * 若不过滤，`baseline` 会被拉到 0 ⇒ 所有队伍的性价比得分一起变成 0 or Infinity。
 * 实测唯一受影响的四处：末日幻影 4.4 的 baseline 由 1 变 0。
 *
 * `costOf` / `avOf` 让调用方用自己的行形状（服务端是 `{c,a}`、总榜链是
 * `{cost,actionValue}`），避免每次调用都先 map 一份新数组。
 *
 * @returns {number} 找到返回最小金数；一个达标行都没有返回 0（调用方把它当「无基准」）
 */
export const baselineOf = (
  rows, kind, costOf = (row) => row?.c, avOf = (row) => row?.a,
) => {
  let min = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const cost = finiteOf(costOf(row));
    if (!(cost > 0)) continue;
    const av = finiteOf(avOf(row));
    if (av === null) continue;
    const reached = kind === 'av' ? av < AV_CAP : av === ZERO_ROUND;
    if (reached && cost < min) min = cost;
  }
  return Number.isFinite(min) ? min : 0;
};

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
