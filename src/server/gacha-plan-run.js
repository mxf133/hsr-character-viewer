/**
 * 抽卡方案 v2 · 取数与组装（服务端）
 *
 * `gacha-plan.js` 是**纯计算**；这一份只负责「把某个关卡的投稿行取齐、补上中文名、
 * 接上视频」，然后交给 `buildPlanPool()` / `materializePlanRow()`。分成两个模块
 * 是因为前者要能被探针直接喂合成数据，而取数会碰文件系统。
 *
 * 口径（需求文档 §二 + 用户 2026-10-18 的决策）：
 *   * 只算**一个**关卡（用户在「关卡选择」里选的那个），不再是四个副本加权；
 *   * 逐版本取**最大值**（不是版本加权平均），版本权重乘进每一版的分；
 *   * Δgold = 0（账号已齐）照样进榜，性价比得分' = 1。
 *
 * ⚠️ **2026-10-20（v4.6.134）：全量 + 分页 + 全量可搜。**
 *    改之前这里 `maxRows` 默认 20、上限 200，搜索与分页都在浏览器里对那 20 条做 ——
 *    「搜得到」= 「它恰好在前 20 名」。现在两层缓存（关卡数据 / 整池）+ 服务端搜索，
 *    浏览器每次只收当前页的 20 条。缓存的淘汰与签名见 `plan-index.js` 与下面三个
 *    `*SignatureOf()`。
 *
 * ⚠️ 与「结论（角色总榜）」那条链的关系：两者读同一份 frontier 行、同一套
 *    `SCORING` 常量，但**不共享中间结果** —— 结论要跨四个副本加权，方案只看一个关卡。
 *    共用的是 `gacha-score.js` 里那几个纯函数，所以判据不会分叉。
 */

import { archiveEpoch, archiveFrontierAll, archiveIndex, loadI18n, zhName } from './archive.js';
import { envKindOf, scoreEnvRows } from './gacha-score.js';
import { buildPlanPool, materializePlanRow } from './gacha-plan.js';
import {
  createPlanCache, hashOf, planPageOf, searchPlanIndex,
} from './plan-index.js';
import { normalizeDrawWeights, normalizeHiddenCosts } from '../../public/scripts/advice.js';

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

// ------------------------------------------------------------------ 缓存签名
//
// 为什么需要签名：整池（10 万条投稿时几十 MB）不能每次请求重算，但也不能跨账号复用 ——
// 同一个关卡、同一个权重，换个账号 Δgold 全变。所以按「影响结果的输入」建键：
//
//   关卡层（`envSignatureOf`）：关卡 + 窗口 + 版本权重 + wc
//                               —— frontier 行与投稿得分只跟这几样有关，**与账号无关**，
//                               所以同一台机器上换个账号登录照样命中。
//   整池层（`planSignatureOf`）：上面那些 + 账号持有 + 隐金开关 + **强度权重 `ws`**
//                               —— 2026-10-20 起 `ws` 会乘进方案分的强度项，换权重
//                               整池名次就变；它不进关卡层（那边恒定 `ws: 1`）。
//
// ⚠️ 两个键都带 `archiveEpoch()`：数据集重新采集（`herta-sync`）后旧池必须失效，
//    否则界面会一直显示上一份档案的分。存档热替换不会重启进程，光靠 LRU 淘汰不够。

const pairsSignatureOf = (map) => [...map.entries()]
  .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  .map(([key, value]) => `${key}:${value ?? ''}`)
  .join(',');

/**
 * 账号持有情况的短签名。
 *
 * 哈希之外还留了三个**规模数字**（持有数 / 星魂条目数 / 光锥条目数）：32 位 FNV 碰撞
 * 概率在「同一台机器几十个账号」的量级下可以忽略，但真撞上就是「看到别人的 Δgold」——
 * 加规模数字后，撞车还要求三张表的条目数全等，成本几乎为零。
 */
export const accountSignatureOf = (account) => {
  const owned = [...(account?.owned || [])].sort();
  const eidolons = account?.eidolons instanceof Map ? account.eidolons : new Map();
  const cones = account?.cones instanceof Map ? account.cones : new Map();
  const body = `${owned.join(',')}|${pairsSignatureOf(eidolons)}|${pairsSignatureOf(cones)}`;
  return `a${owned.length}.${eidolons.size}.${cones.size}#${hashOf(body)}`;
};

export const envSignatureOf = ({ envKey, window, versionWeights, wc }) => {
  const list = Array.isArray(versionWeights) ? versionWeights.join(',') : '';
  return `v${archiveEpoch()}~${envKey}|${window}|${wc}|${hashOf(list)}`;
};

/**
 * 整池层签名：关卡层那份 + 账号持有 + 隐金开关 + **强度权重 `ws`**。
 *
 * ⚠️ `ws` 只能在这里带 —— 关卡层（`scoreEnvRows`）拿到的恒定是 `ws: 1`，所以它
 *    不进 `envKey`；但方案分里强度项要乘 `ws`（`planScoreAt()`），换个强度权重
 *    整池名次就全变了，键里不带它就会把上一组权重的池子发出去。
 */
export const planSignatureOf = ({ envKey, hiddenCosts, ws, account }) => {
  const hidden = normalizeHiddenCosts(hiddenCosts);
  return `${envKey}|ws=${ws ?? 1}|${hashOf(JSON.stringify(hidden))}|${accountSignatureOf(account)}`;
};

/**
 * 两个缓存实例（进程级）。
 *
 * ⚠️ 行数预算**分别**算（各 14 万行）：关卡层与整池层同时命中才是常态，
 *    合用一个预算会让「大池子来了」把两层一起挤掉。
 */
const FRONTIER_CACHE = createPlanCache();
const POOL_CACHE = createPlanCache();

/** 缓存里可能存着**进行中的 Promise**（并发请求同一个签名时只算一次）。 */
const cachedAsync = async (cache, key, rowCountOf, build) => {
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = Promise.resolve().then(build);
  // 先占位（行数记 0）：并发进来的第二个请求直接等同一个 Promise。
  cache.set(key, pending, 0);
  try {
    const value = await pending;
    cache.set(key, value, typeof rowCountOf === 'function' ? rowCountOf(value) : 0);
    return value;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
};

/** 测试 / 探针用：把两层缓存都清掉，保证「冷启动」是真的冷。 */
export const clearPlanCaches = () => {
  FRONTIER_CACHE.clear();
  POOL_CACHE.clear();
};

/** 缓存现状（探针打点 / 排查「为什么这次是冷的」）。 */
export const planCacheStats = () => ({
  frontier: { size: FRONTIER_CACHE.size, rows: FRONTIER_CACHE.rows },
  pool: { size: POOL_CACHE.size, rows: POOL_CACHE.rows },
});

/**
 * frontier 行 → `scoreEnvRows()` 要的形状。
 *
 * ⚠️ 四个字段名别改：`a` 成绩（行动值 / 轮次）、`c` 用金、`n` 投稿数、`m` 成员串。
 *    这几个是数据集的原生写法（见 `herta-build.mjs` 的产出），`gacha-score.js` 全程按它读。
 * ⚠️ v4.6.139 起 `target`（差一档）**也进方案池**。此前只取 `perfect`，但满分档的
 *    成绩恒为满分（轮次型 `a=0`、末日积分满 ⇒ `a=0`），实测 20913 条满分行的
 *    `a` 全是 0（见 `audit/algo-review` 的审计记录）—— 方案池里「队伍强度」恒 1.000、
 *    零区分度，moc 首页 20 行只有 2 个分值、榜首 13 支并列。差一档行带着真实成绩
 *    （忘却 a∈{1,2}、末日 a∈(0,300]），强度有梯度；它的分数自然靠后，不存在
 *    「没打满的队白得高分」（旧注释的顾虑在新公式下不成立：强度项按真实成绩打折）。
 *    同阵容同版本的 perfect/target 冲突由 `groupRosters()` 裁决：**档位优先**。
 * ⚠️ 成绩缺失（`a=null`）的行**排除**而不是按 0 分进池：强度 0 的「幽灵候选」
 *    会静默沉底，污染「来自 M 条投稿」的分母。旧过滤
 *    `Number.isFinite(Number(r.actionValue)) !== false` 恒为真（`Number(null)=0`
 *    是 finite），滤不住 null —— 已修。
 */
const rowOf = (r) => ({
  season: r.season,
  c: Number(r.cost) || 0,
  a: r.actionValue === null || r.actionValue === undefined ? null : Number(r.actionValue),
  // ⚠️ v4.6.134 起用**真实投稿数**（`archive.js` 新带出的 `submissions`），不再是写死的 1：
  //    「这一行被几个人投过」是状态行里「来自 M 条投稿」的唯一来源。
  n: Math.max(1, Number(r.submissions) || 1),
  m: (r.members || []).map((m) => `${m.char}|${m.eidolon}|${m.lc || '-'}|${m.superimp || 1}`),
  tier: r.tier,
  // 档位的**数字**形式（3=满分 2=差一档），与建库侧 `TIER_CODE` 同刻度。
  // `groupRosters()` 的同版本裁决和池行的 `tier` 字段都读它；缺失当满分（老夹具没这字段）。
  t: r.tier === 'target' ? 2 : 3,
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
 * 跑一次抽卡方案（全量索引 + 按页取）。
 *
 * 2026-10-20（用户第 1~3 条）：**不再截断**。改之前只回前 `maxRows`（默认 20、上限 200）
 * 行，搜索与分页在浏览器里对那 20 行做 —— 于是「搜得到」= 「它恰好在前 20 名」。
 * 现在：
 *   * 整池（折叠后的全部角色组合）在服务端算一次，按输入签名缓存（`plan-index.js`）；
 *   * `query` 在**全池**上筛（本队命中 ∪ 次选命中，多词 AND）；
 *   * `page` / `pageSize` 只决定回哪 20 条，补金明细也只给这 20 条算。
 *
 * @param {object} options
 * @param {string} options.envKey       `'aa|plight'` 这种；未知值退回默认关卡
 * @param {object} options.account      `{ owned: string[], eidolons: {}, cones: {} }`（HTTP 来的原样形状）
 * @param {object} options.drawWeights  `{ strength, cost }`，只认相对大小
 * @param {object} options.hiddenCosts  隐金五项
 * @param {string} options.query        搜索词（多关键词用空格 / 逗号 / 顿号分隔，AND）
 * @param {number} options.page         页码（1 起；越界夹回最后一页）
 * @param {number} options.pageSize     每页条数（默认 20，上限 200）
 * @param {number} options.maxRows      旧名字，等价于 `pageSize`（探针与老调用方还在用）
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

  const draw = normalizeDrawWeights(options.drawWeights);
  // 方案里的 wc 用**归一后的性价比系数**：用户把强度拉满（cost=0）时方案也不该再算性价比。
  const wc = Number.isFinite(draw.cost) ? draw.cost : 1;
  const envKey = envSignatureOf({ envKey: picked.key, window, versionWeights: options.versionWeights, wc });
  // ⚠️ 2026-10-20：ws 也进方案（用户确认两个旋钮地位对称）。它**不能**传给
  //    `scoreEnvRows()` —— 那里必须是 `ws: 1`，让 `strengthPart` 保持裸强度
  //    （`1 − 行动值/500`）；乘权重的动作只发生在 `buildPlanPool()` 的 `planScoreAt()` 里，
  //    两处都乘就等于把强度平方了一次。
  //    因此 ws **不进** `envKey`（关卡层那份 scored 与 ws 无关），只进 `planKey`。
  const ws = Number.isFinite(draw.strength) ? draw.strength : 1;

  // ---- ① 关卡数据：frontier 行 + 评分（只与关卡 / 版本权重 / wc 有关，**与账号无关**）----
  //
  // 为什么单独一层：翻页与搜索每次都要这份数据，而它与「你有没有这个角色」无关。
  // 10 万条投稿时 frontier 装配 + 评分实测约 200 ms —— 每敲一个键付一次是不可接受的。
  const env = await cachedAsync(FRONTIER_CACHE, envKey, (value) => value.poolRows, async () => {
    // ⚠️ 不传 `weights`：方案只看这一个关卡，「副本权重」这个概念在方案里不存在
    //    （它决定的是总榜里各副本怎么加权）。传了反而会让用户没选的副本变成 0 权重。
    const [f] = await archiveFrontierAll([{
      id: picked.key, mode: picked.mode, stage: picked.stage,
    }], {
      window,
      versionWeights: options.versionWeights,
    });
    if (!f?.ok) {
      return { ok: false, error: f?.error || '该关卡暂无投稿数据' };
    }

    // ⚠️ `seasonWeights` 是**该副本各自算的**（`archiveFrontier` 按窗口从新到旧套
    //    `VERSION_WEIGHTS` 或用户表现算）。不能拿别的关卡的权重顶替。
    const seasonWeights = f.seasonWeights || {};
    const versionWeightOf = (season) => {
      const w = seasonWeights[season];
      return Number.isFinite(Number(w)) ? Number(w) : 1;
    };

    const rows = (f.frontierRows || [])
      // ⚠️ v4.6.139：`target`（差一档）也进池（理由见 `rowOf` 上方的审计注释）；
      //   成绩缺失的行排除 —— 旧条件 `isFinite(Number(av)) !== false` 恒真、滤不住 null。
      .filter((r) => (r.tier === 'perfect' || r.tier === 'target')
        && r.actionValue !== null && r.actionValue !== undefined
        && Number.isFinite(Number(r.actionValue)))
      .map(rowOf)
      .filter((r) => r.m.length);

    const scored = scoreEnvRows(rows, {
      mode: picked.mode, stage: picked.stage, ws: 1, wc, versionWeightOf,
    }).scored;

    return {
      ok: true,
      seasons: f.seasons || [],
      seasonWeights,
      versionWeightOf,
      videos: videoIndexOf(f.frontierRows || []),
      scored,
      poolRows: scored.length,
      // 窗口内**真实投稿数**（Σ 每行的 `n`）：一行常被 2~3 个人投过，所以它 ≥ `poolRows`。
      submissions: rows.reduce((sum, row) => sum + (Number(row.n) || 1), 0),
    };
  });
  if (!env.ok) {
    return { ok: true, available: false, env: picked.key, hint: env.error };
  }

  const kind = envKindOf(picked.mode, picked.stage);

  // ---- ② 整池：聚合 / 排序 / 折叠（与账号、权重、隐金都有关）----
  const planKey = planSignatureOf({
    envKey,
    hiddenCosts: options.hiddenCosts,
    // ⚠️ ws 必须进整池键：方案分 = (ws × 强度 + wc × 性价比) × 版本权重，
    //    换个强度权重整池的名次就全变了。wc 已经通过 `envKey` 进来了（关卡层的
    //    `scoreEnvRows()` 收 wc），ws 不进关卡层，只能在这里单独带上。
    ws,
    account: accountOf(options.account),
  });
  const poolState = await cachedAsync(POOL_CACHE, planKey, (value) => value.lineups.length, async () => {
    const pool = buildPlanPool(env.scored, {
      // ⚠️ 必须过 `accountOf()`：它把 JSON 的数组/对象转成成本模型要的 Set / Map。
      //    直接透传 `options.account` 会让 `owned.has()` 永远 false（见上面那段注释）。
      account: accountOf(options.account),
      availability: index.availability || index.refs?.availability || {},
      hiddenCosts: options.hiddenCosts,
      ws,
      wc,
      videoOf: (rosterKey, season) => {
        // `rosterKey` 是整包键（`角色|E档|光锥|S档` 排序拼 ~），视频索引的键是角色名。
        // 这里把整包键还原成角色名集合再查 —— 两种键都从同一批成员派生，不会对不上。
        const chars = String(rosterKey).split('~')
          .map((pack) => String(pack).split('|')[0])
          .sort().join(' + ');
        const bySeason = env.videos.get(`${season}|${chars}`);
        if (bySeason) return bySeason;
        // 该版本没有就用**最新一版有视频的**兜底：用户点开要的是「这套阵容的投稿」，
        // 差一个版本仍然是同一套打法，比一个点不动的卡片有用。
        for (const s of Object.keys(env.seasonWeights).sort().reverse()) {
          const hit = env.videos.get(`${s}|${chars}`);
          if (hit) return hit;
        }
        return null;
      },
    });
    const i18n = await loadI18n();
    return {
      ...pool,
      // 搜索要中文名（用户会敲「流萤」而不是 `Firefly`）。名字只在这里解析一次，
      // `plan-index.js` 全程只用这个函数，不 import i18n、也不碰文件。
      nameOf: (kindOfName, name) => {
        if (!name) return null;
        return zhName(i18n, kindOfName === 'cone' ? 'lightCones' : 'characters', name) || null;
      },
    };
  });

  // ---- ③ 全量搜索 + 分页（都只动行号，不重算任何分数）----
  const found = searchPlanIndex(poolState, options.query);
  const page = planPageOf(found.ids, options.page, options.pageSize ?? options.maxRows);

  // ---- ④ 只物化当前页 ----
  const altOnlySet = new Set(found.altOnlyIds);
  const rows = page.ids.map((id) => {
    const row = materializePlanRow(poolState.lineups[id], poolState);
    // 名次 = **整池**里的名次（1 起）。搜索 / 翻页都只是视图，不许改写名次。
    row.rank = id + 1;
    // 「这条是靠次选命中的」标记：本队四个位置里没有关键词，是它下面的次选配队里有。
    row.altOnly = altOnlySet.has(id);
    return row;
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
    seasons: env.seasons,
    seasonWeights: env.seasonWeights,
    // 回显生效的抽卡权重（归一后）：界面左侧「强度 x / 性价比 y」那行印它，不自己再算。
    drawWeights: draw,
    wc,
    envs: planEnvList(),
    // ---- 分页 ----
    page: page.page,
    pageSize: page.pageSize,
    pages: page.pages,
    start: page.start,
    total: page.total,
    // 全池规模：`lineups` = 角色组合数（= 榜面能翻到的总条数），
    // `poolRows` = 该关卡窗口内的投稿记录数，`submissions` = 这些记录背后的真实投稿条数，
    // `pool` = 整包数（折叠前）。
    pool: poolState.pool.length,
    lineups: poolState.lineups.length,
    poolRows: poolState.poolRows,
    submissions: env.submissions,
    query: {
      text: String(options.query ?? ''),
      terms: found.terms,
      hits: found.ids.length,
      ownCount: found.ownCount,
      altOnly: found.altOnly,
      // 池子太大时**不建次选索引**（见 `plan-index.js` 的 `PLAN_ALT_INDEX_MAX_LINEUPS`）。
      // 界面据此说明「本次搜索只匹配本队」，而不是让人以为「次选里没有」。
      altSearch: found.altSearch,
    },
    // 还有没有下一页（旧字段名：探针按它判断「是不是被截断了」）。
    truncated: page.start + page.ids.length < page.total,
    rows: rows.map((row) => ({
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

