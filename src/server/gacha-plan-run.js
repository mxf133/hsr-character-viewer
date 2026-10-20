/**
 * 抽卡方案 v2 · 取数与组装（服务端）
 *
 * `gacha-plan.js` 是**纯计算**；这一份只负责「把某个关卡的投稿行取齐、补上中文名、
 * 接上视频」，然后交给 `buildPlan()`。分成两个模块是因为前者要能被探针直接喂合成数据，
 * 而取数会碰文件系统。
 *
 * 口径（需求文档 §二 + 用户 2026-10-18 的决策）：
 *   * 只算**一个**关卡（用户在「关卡选择」里选的那个），不再是四个副本加权；
 *   * 逐版本取**最大值**（不是版本加权平均），版本权重乘进每一版的分；
 *   * Δgold = 0（账号已齐）照样进榜，性价比得分' = 1。
 *
 * ⚠️ 与「结论（角色总榜）」那条链的关系：两者读同一份 frontier 行、同一套
 *    `SCORING` 常量，但**不共享中间结果** —— 结论要跨四个副本加权，方案只看一个关卡。
 *    共用的是 `gacha-score.js` 里那几个纯函数，所以判据不会分叉。
 */

import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from './archive.js';
import { envKindOf, scoreEnvRows } from './gacha-score.js';
import { buildPlan } from './gacha-plan.js';
import { normalizeDrawWeights } from '../../public/scripts/advice.js';

/** 可选的关卡清单（前端「关卡选择」下拉框用；顺序 = 游戏解锁顺序）。 */
const PLAN_ENVS = [
  { key: 'moc|', mode: 'moc', stage: '', label: '混沌回忆' },
  { key: 'pf|', mode: 'pf', stage: '', label: '虚构叙事' },
  { key: 'as|', mode: 'as', stage: '', label: '末日幻影' },
  { key: 'aa|', mode: 'aa', stage: '', label: '异相仲裁 · 王棋和骑士关' },
  { key: 'aa|plight', mode: 'aa', stage: 'plight', label: '异相仲裁 · 绝境王棋关' },
];

/** 默认关卡：异相仲裁 · 绝境（需求文档原话「默认选择绝境」）。 */
export const DEFAULT_PLAN_ENV = 'aa|plight';

export const planEnvList = () => PLAN_ENVS.map((env) => ({ ...env }));

const envOf = (key) => PLAN_ENVS.find((env) => env.key === key)
  || PLAN_ENVS.find((env) => env.key === DEFAULT_PLAN_ENV);

// ------------------------------------------------------------------ 账号持有情况归一
//
// ⚠️ **这里必须转一次类型**（2026-10-20 修的 bug：抽卡方案里「我自己的角色从来没参与
// 计算」，所有成员都印成「缺」、Δgold 恒等于整队金数）：
//
//   前端 `accountPayload()` 发的是 JSON —— `owned` 是**数组**、`eidolons` / `cones` 是
//   **普通对象**；而下游两处都用 `instanceof` 判类型后直接 `.has()` / `.get()`：
//     * `advice.js` 的 `marginalCostOf()`  —— 算 Δgold（要补几金）与补金顺序；
//     * `gacha-plan.js` 的 `buildPlan()`  —— 印每个位置的「已有 / 缺」徽章。
//   所以 JSON 一进来 `owned instanceof Set` 就是 false，函数退回一个**空** Set：
//   明明有 E6 阿格莱雅，界面也只会说「缺」。类型不匹配不抛错，只会安静地算错。
//
// 三种形状都要认（HTTP 数组 / 服务端内部 Set / 老存档的对象表），因为 `runPlan()` 既被
// 路由调用（JSON），也会被 `tools/` 下的探针直接喂内存里的 Set（合成夹具）。
const asNameSet = (value) => {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.filter(Boolean));
  // `{ 名字: true }` 这种「持有表」：只收值为真的键
  if (value && typeof value === 'object') {
    return new Set(Object.keys(value).filter((key) => value[key]));
  }
  return new Set();
};

const asNameMap = (value) => {
  if (value instanceof Map) return value;
  if (value && typeof value === 'object') return new Map(Object.entries(value));
  return new Map();
};

/** 把 HTTP 来的 `{ owned: [], eidolons: {}, cones: {} }` 归一成成本模型要的 Set / Map。 */
export const accountOf = (raw) => ({
  owned: asNameSet(raw?.owned),
  eidolons: asNameMap(raw?.eidolons),
  cones: asNameMap(raw?.cones),
});

/**
 * frontier 行 → `scoreEnvRows()` 要的形状。
 *
 * ⚠️ 四个字段名别改：`a` 成绩（行动值 / 轮次）、`c` 用金、`n` 投稿数、`m` 成员串。
 *    这几个是数据集的原生写法（见 `herta-build.mjs` 的产出），`gacha-score.js` 全程按它读。
 * ⚠️ `tier === 'perfect'` 才算投稿：建库侧把 `target`（差一档）也写进 frontier，
 *    但「差一档」不是成绩 —— 拿它进方案会让「没打满的队」白得高分。
 *    需求文档 §一 的判据就是「通关 / 0T / <500 行动值」，不含差一档。
 */
const rowOf = (r) => ({
  season: r.season,
  c: Number(r.cost) || 0,
  a: r.actionValue === null || r.actionValue === undefined ? null : Number(r.actionValue),
  n: 1,
  m: (r.members || []).map((m) => `${m.char}|${m.eidolon}|${m.lc || '-'}|${m.superimp || 1}`),
  tier: r.tier,
  video: r.video || null,
});

/**
 * 视频索引：`版本|角色名排序拼 + ` → 视频地址。
 *
 * ⚠️ **阵容键只用角色名**（不含星魂 / 光锥 / 叠影），与 `archive.js` 的
 *    `sampleVideoByRosterSeason` 逐字同口径 —— 那里的键就是 `teams[].roster`
 *    （角色名数组）。用整包键会一条也匹配不上（星魂档是同一个角色的不同写法，
 *    而 `roster` 里只有名字）。
 * ⚠️ 同一个键可能有多条（同阵容不同配装），取**第一条非空**即可：它们指向的都是
 *    「这套阵容的某条投稿」，界面文案写「来源视频」而不是「这条成绩的视频」。
 */
const videoIndexOf = (frontierRows) => {
  const map = new Map();
  for (const r of frontierRows) {
    if (!r.video) continue;
    const roster = (r.members || []).map((m) => m.char).sort().join(' + ');
    if (!roster) continue;
    const key = `${r.season}|${roster}`;
    if (!map.has(key)) map.set(key, r.video);
  }
  return map;
};

/**
 * 跑一次抽卡方案。
 *
 * @param {object} options
 * @param {string} options.envKey       `'aa|plight'` 这种；未知值退回默认关卡
 * @param {object} options.account      `{ owned: string[], eidolons: {}, cones: {} }`（HTTP 来的原样形状）
 * @param {object} options.drawWeights  `{ strength, cost }`，只认相对大小
 * @param {object} options.hiddenCosts  隐金五项
 * @param {number} options.maxRows      下发条数（默认 20，与界面「每页 20」一致）
 * @param {object} options.versionWeights 版本权重原值数组
 */
export const runPlan = async (options = {}) => {
  const index = await archiveIndex();
  if (!index?.modes?.length) {
    return {
      ok: true,
      available: false,
      hint: '尚未采集资料。请在项目目录运行：node tools/herta-fetch.mjs && node tools/herta-build.mjs',
    };
  }

  const picked = envOf(options.envKey);
  const window = Math.max(1, Math.min(
    Number(options.window) || (Array.isArray(options.versionWeights)
      ? options.versionWeights.length : 6),
    12,
  ));

  // ⚠️ 不传 `weights`：方案只看这一个关卡，「副本权重」这个概念在方案里不存在
  //    （它决定的是总榜里各副本怎么加权）。传了反而会让用户没选的副本变成 0 权重。
  const [f] = await archiveFrontierAll([{
    id: picked.key, mode: picked.mode, stage: picked.stage,
  }], {
    window,
    versionWeights: options.versionWeights,
  });
  if (!f?.ok) {
    return { ok: true, available: false, env: picked.key, hint: f?.error || '该关卡暂无投稿数据' };
  }

  const kind = envKindOf(picked.mode, picked.stage);
  // ⚠️ `seasonWeights` 是**该副本各自算的**（`archiveFrontier` 按窗口从新到旧套
  //    `VERSION_WEIGHTS` 或用户表现算）。不能拿别的关卡的权重顶替。
  const seasonWeights = f.seasonWeights || {};
  const versionWeightOf = (season) => {
    const w = seasonWeights[season];
    return Number.isFinite(Number(w)) ? Number(w) : 1;
  };

  const rows = (f.frontierRows || [])
    .filter((r) => r.tier === 'perfect' && Number.isFinite(Number(r.actionValue)) !== false)
    .map(rowOf)
    .filter((r) => r.m.length);

  const draw = normalizeDrawWeights(options.drawWeights);
  // 方案里的 wc 用**归一后的性价比系数**：用户把强度拉满（cost=0）时方案也不该再算性价比。
  const wc = Number.isFinite(draw.cost) ? draw.cost : 1;

  const scored = scoreEnvRows(rows, {
    mode: picked.mode, stage: picked.stage, ws: 1, wc, versionWeightOf,
  }).scored;

  const videos = videoIndexOf(f.frontierRows || []);
  const plan = buildPlan(scored, {
    // ⚠️ 必须过 `accountOf()`：它把 JSON 的数组/对象转成成本模型要的 Set / Map。
    //    直接透传 `options.account` 会让 `owned.has()` 永远 false（见上面那段注释）。
    account: accountOf(options.account),
    availability: index.availability || index.refs?.availability || {},
    hiddenCosts: options.hiddenCosts,
    wc,
    maxRows: Math.max(1, Math.min(Number(options.maxRows) || 20, 200)),
    videoOf: (rosterKey, season) => {
      // `rosterKey` 是整包键（`角色|E档|光锥|S档` 排序拼 ~），视频索引的键是角色名。
      // 这里把整包键还原成角色名集合再查 —— 两种键都从同一批成员派生，不会对不上。
      const chars = String(rosterKey).split('~')
        .map((pack) => String(pack).split('|')[0])
        .sort().join(' + ');
      const bySeason = videos.get(`${season}|${chars}`);
      if (bySeason) return bySeason;
      // 该版本没有就用**最新一版有视频的**兜底：用户点开要的是「这套阵容的投稿」，
      // 差一个版本仍然是同一套打法，比一个点不动的卡片有用。
      for (const s of Object.keys(seasonWeights).sort().reverse()) {
        const hit = videos.get(`${s}|${chars}`);
        if (hit) return hit;
      }
      return null;
    },
  });

  const i18n = await loadI18n();
  const zh = (name) => (name ? (zhName(i18n, 'characters', name) || null) : null);
  const zhCone = (name) => (name ? (zhName(i18n, 'lightCones', name) || null) : null);

  // 成员 / 变体成员共用同一套补名逻辑（`lcCn` 走 `lightCones` 表，`charCn` 走 `characters`）。
  const withCn = (m) => ({ ...m, charCn: zh(m.char), lcCn: zhCone(m.lc) });

  return {
    ok: true,
    available: true,
    env: picked.key,
    envLabel: picked.label,
    mode: picked.mode,
    stage: picked.stage,
    kind,
    window,
    seasons: f.seasons || [],
    seasonWeights,
    // 回显生效的抽卡权重（归一后）：界面左侧「强度 x / 性价比 y」那行印它，不自己再算。
    drawWeights: draw,
    wc,
    envs: planEnvList(),
    ...plan,
    rows: plan.rows.map((row) => ({
      ...row,
      members: row.members.map(withCn),
      // ⚠️ 光锥名和角色名分属两张表（`lightCones` / `characters`），只查一张会 miss。
      //    `it.name` 是数据集里的英文键（如 `The Finale of a Lie`），得按 `kind` 分流。
      fill: (row.fill || []).map((it) => ({
        ...it,
        nameCn: it.kind === 'cone' ? zhCone(it.name) : zh(it.name),
        kindCn: it.kind === 'cone' ? '光锥' : '角色',
      })),
      // 折叠进本行的其它配装（同一套四人、光锥/叠影不同）—— 界面「其它配装」那一栏用。
      variants: (row.variants || []).map((v) => ({ ...v, members: (v.members || []).map(withCn) })),
      alternatives: (row.alternatives || []).map((alt) => ({
        ...alt,
        members: (alt.members || []).map(withCn),
      })),
    })),
  };
};
