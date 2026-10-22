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

import {
  archiveEpoch, archiveFrontierAll, archiveIndex, loadI18n, localizeBosses, zhName,
} from './archive.js';
import { bossIconMap } from './icon-fetch.js';
import { envKindOf, packKeyOf, scoreEnvRows } from './gacha-score.js';
import { buildPlanPool, materializePlanRow } from './gacha-plan.js';
import {
  createPlanCache, hashOf, mergePlanEntries, planPageOf, searchPlanIndex,
} from './plan-index.js';
import { normalizeDrawWeights, normalizeHiddenCosts, sortVideosOf } from '../../public/scripts/advice.js';

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

/**
 * GET 参数里的「不使用」清单：`exclude=角色A,角色B|光锥A,光锥B`（`|` 左边角色、右边光锥）。
 *
 * 只给手工排查 / 探针用；界面走 POST 的 JSON（不用为中文名做 URL 编码转换）。
 */
/**
 * ⚠️ **必须 export**：路由（`app.js`）的 GET 分支要用它。
 *
 * 2026-10-22 这里踩过一次大的：函数留成了模块私有，而 `app.js` 直接 `parseExcludeParam(...)` ——
 * 只要请求里**没有** `exclude` 字段（旧客户端、浏览器缓存里的旧 JS、curl、探针）就会
 * `ReferenceError`，被路由的 catch 吞掉后返回「尚未采集资料」，整个抽卡方案页变成一句话。
 */
export const parseExcludeParam = (raw) => {
  if (!raw || typeof raw !== 'string') return undefined;
  const [chars, cones] = raw.split('|');
  const split = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { characters: split(chars), lightCones: split(cones) };
};

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

// ------------------------------------------------------------------ 「不使用」清单
//
// 2026-10-22（用户）：
//   「让抽卡方案可以设置角色 / 光锥不使用（至多 4 个角色 / 光锥）…… 可以在所有的投稿队伍
//    右侧点击『排除此配队』自动设置。这个功能是为了让用户能够在已有 1 队的情况下找出
//    合适自己的 2 队。」
// 澄清口径（用户原话）：「角色剔除 + 光锥持有量 -1，相当于已经将这些角色、光锥占用」。
//
//   * **角色** → 含它的配队**整条不出现**（`buildPlanPool` 的 `excludeChars`）；
//   * **光锥** → 把账号里这把锥的**叠影层数减 1**（S1 → 0 = 视为没有，S5 → S4）。
//     于是「用了我那把唯一的光锥」的配队会多出补金，而配队本身仍然列出 ——
//     这正是「占用」的语义：锥还在，但这一队用不上了。

/** 「你现在就能打的队」摘要里最多列几支（用户 2026-10-22：「用户已有配队也需要显示在抽卡方案」）。 */
export const OWNED_TEAMS_MAX = 4;

/** 每一类最多能排除几个（用户：「至多 4 个角色 / 光锥」，角色与光锥各 4）。 */
export const MAX_EXCLUDE_PER_KIND = 4;

const asNameList = (value, limit = MAX_EXCLUDE_PER_KIND) => {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
};

/** 归一「不使用」清单：去空、去重、上限 4 + 4。 */
export const normalizeExclude = (raw) => ({
  characters: asNameList(raw?.characters),
  lightCones: asNameList(raw?.lightCones),
});

/**
 * 把「不使用」应用成一份**账号视图**：被排除的光锥叠影 -1（见上面那段口径）。
 *
 * ⚠️ 只动 `cones`，不动 `owned` / `eidolons`：角色那条走的是「整队剔除」，
 *    不是「按没抽到算钱」—— 两者在界面上是完全不同的两件事。
 */
export const accountWithExclusions = (account, exclude) => {
  const cones = new Map(account?.cones instanceof Map ? account.cones : []);
  for (const name of exclude?.lightCones || []) {
    if (!cones.has(name)) continue;
    const left = Math.max(0, (Number(cones.get(name)) || 0) - 1);
    cones.set(name, left);
  }
  return { ...account, cones };
};

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
export const planSignatureOf = ({ envKey, hiddenCosts, ws, account, exclude }) => {
  const hidden = normalizeHiddenCosts(hiddenCosts);
  // ⚠️ 「不使用」的角色**必须**进键：它直接把整队从池子里剔掉，键里不带就会把
  //    上一份（没排除的）池子发出去 —— 那就是「点了排除，界面纹丝不动」。
  //    光锥不用单独带：`accountWithExclusions()` 已经把叠影 -1 写进 `account` 了。
  const chars = (exclude?.characters || []).slice().sort().join(',');
  return `${envKey}|ws=${ws ?? 1}|${hashOf(JSON.stringify(hidden))}|${accountSignatureOf(account)}|x=${chars}`;
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
  const buckets = new Map();
  const seen = new Map();
  // 同一个阵容 + 版本可能既有满分投稿也有差一档投稿、都带视频。先扫满分，再扫其余
  // —— 满分那条排在前面就永远轮不到低档位顶替它；低档位只做「满分没有时的兜底」
  // （这也是 minTier 放开到 0 之后视频列反而变多的唯一来源）。
  const rows = [...frontierRows].sort(
    (a, b) => (a.tier === 'perfect' ? 0 : 1) - (b.tier === 'perfect' ? 0 : 1),
  );
  for (const r of rows) {
    const members = r.members || [];
    if (!members.length) continue;
    // ⚠️ **键是「整包」不是「角色名集合」**（2026-10-22，用户：「另外的来源需要显示完全相同的
    //    配装，但投稿不同」）：原来按四个角色名做键，同角色不同配装（E2S1 / E6S5）的投稿会混进
    //    同一个桶，卡片上就可能挂着一条**别的配装**的投稿。现在键里带星魂档 / 光锥 / 叠影，
    //    桶内每一条都必然是同一套配装。
    const key = `${r.season}|${members.map((m) => packKeyOf(m)).sort().join('~')}`;
    if (!buckets.has(key)) { buckets.set(key, []); seen.set(key, new Set()); }
    const bucket = buckets.get(key);
    const known = seen.get(key);
    // ⚠️ 2026-10-22：一行现在可能带 `videos[]`（该阵容**全部**来源）。旧档案没有这个
    //    字段，退回单条 `video` —— 两种档案都能读出东西，不会「重建前后差一批视频」。
    const list = Array.isArray(r.videos) && r.videos.length ? r.videos : (r.video ? [{ url: r.video }] : []);
    for (const video of list) {
      const url = typeof video === 'string' ? video : video?.url;
      if (!url || known.has(url)) continue;
      known.add(url);
      bucket.push(typeof video === 'string' ? { url: video } : video);
    }
  }
  // 排序口径见 `advice.js` 的 `videoRankOf`：**B 站优先** → 成绩好 → 新 → url 兜底。
  const map = new Map();
  for (const [key, list] of buckets) {
    const sorted = sortVideosOf(list);
    // `sources` 只留界面要印的字段（url / 作者 / 日期 / 成绩），不把整条投稿带下去。
    if (sorted.length) {
      map.set(key, {
        url: sorted[0].url,
        sources: sorted.slice(0, 8).map((v) => ({
          url: v.url, author: v.author ?? null, date: v.date ?? null, av: v.av ?? null,
        })),
      });
    }
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
    //
    // ⚠️ v4.6.136：`minTier: 0` —— **四个档位全要**（perfect / target / pass / below）。
    //    改之前默认 `minTier: 2`，差一档和通关的投稿在建池前就被丢掉了，于是用户搜
    //    某个只在「差一档」队伍里出现过的角色，一条都搜不到（他报的「会错过投稿」）。
    //    现在非满分行进**另一个池**，排在满分之后（见下面 ②）。
    const [f] = await archiveFrontierAll([{
      id: picked.key, mode: picked.mode, stage: picked.stage,
    }], {
      window,
      versionWeights: options.versionWeights,
      minTier: 0,
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

    // ⚠️ v4.6.139（算法审计修复，用户拍板）：`target`（差一档）**纳入榜面排序**，
    //    不再像 v4.6.138 那样丢进「只做召回」的非满分池。审计发现满分档判据本身
    //    就是成绩归零（轮次 ≤0 / 积分 ≥4000 ⇒ `a=0`），20913 条满分行的 `a` 全为 0，
    //    只取 perfect 时榜面「队伍强度」恒 1.000、零区分度；差一档行带真实成绩，
    //    纳入后有梯度。同阵容同版本的 perfect/target 冲突由 `groupRosters()` 档位优先裁决。
    //    ⚠️ 成绩缺失（`a=null`）的行**排除**：旧式 `isFinite(Number(av)) !== false`
    //    恒真（`Number(null)=0` 是 finite），滤不住 null，会放「幽灵候选」进来污染分母。
    //    四个档位仍**全部**进池（`minTier: 0`），pass/below 照旧只做召回、排后面。
    const usable = (f.frontierRows || [])
      .filter((r) => r.actionValue !== null && r.actionValue !== undefined
        && Number.isFinite(Number(r.actionValue)))
      .map(rowOf)
      .filter((r) => r.m.length);

    // 榜面池：满分 + 差一档（v4.6.139 起 target 参与强度排序，档位优先裁决见 groupRosters）。
    // 召回池：通关 + 未达标（只做召回，排在榜面之后，规则见 mergePlanEntries）。
    const boardRows = usable.filter((r) => r.tier === 'perfect' || r.tier === 'target');
    const otherRows = usable.filter((r) => r.tier !== 'perfect' && r.tier !== 'target');

    const board = scoreEnvRows(boardRows, {
      mode: picked.mode, stage: picked.stage, ws: 1, wc, versionWeightOf,
    });
    const extra = otherRows.length
      ? scoreEnvRows(otherRows, {
        mode: picked.mode, stage: picked.stage, ws: 1, wc, versionWeightOf,
      })
      : { scored: [], baselines: new Map() };

    // 性价比那一栏的「该版最低金」统一用**榜面池（满分 + 差一档）**的基准：召回池
    // （通关 / 未达标）行的 `seasonsDetailOf` 里那列「该版最低 N 金」要是另一把尺子，
    // 同一个弹窗里两行会没法比。
    // （注：v4.6.135 起性价比是 `1 − 补金/10` 的线性扣分，`baseline` 已不进分数，
    //   这里纯粹是为了弹窗里那个数说的是同一件事。）
    const extraScored = extra.scored.map((row) => {
      const base = board.baselines.get(row.season);
      return Number.isFinite(base) && base > 0 ? { ...row, baseline: base } : row;
    });

    // 各档位的**真实投稿数**（Σn）：状态行那句「来自 M 条投稿」按全档位算，
    // 并把满分那部分单独报出来，用户才能看出「1356 条满分 / 另有 629 条差一档」。
    // ⚠️ 这里只统计**投稿条数**；「池子里有几支」由 `mergePlanEntries()` 按角色组合数。
    const tierSubmissions = { perfect: 0, target: 0, pass: 0, below: 0 };
    for (const r of f.frontierRows || []) {
      const tier = r.tier in tierSubmissions ? r.tier : 'below';
      tierSubmissions[tier] += Math.max(1, Number(r.submissions) || 1);
    }

    return {
      ok: true,
      seasons: f.seasons || [],
      seasonWeights,
      versionWeightOf,
      videos: videoIndexOf(f.frontierRows || []),
      scored: board.scored,
      extraScored,
      poolRows: board.scored.length + extraScored.length,
      // 窗口内**真实投稿数**（Σ 每行的 `n`）：一行常被 2~3 个人投过，所以它 ≥ `poolRows`。
      submissions: boardRows.concat(otherRows).reduce((sum, row) => sum + (Number(row.n) || 1), 0),
      perfectSubmissions: boardRows.filter((r) => r.tier === 'perfect')
        .reduce((sum, row) => sum + (Number(row.n) || 1), 0),
      tierSubmissions,
    };
  });
  if (!env.ok) {
    return { ok: true, available: false, env: picked.key, hint: env.error };
  }

  const kind = envKindOf(picked.mode, picked.stage);

  // ---- ② 整池：聚合 / 排序 / 折叠（与账号、权重、隐金都有关）----
  // 「不使用」清单在**建池前**就应用：角色靠剔除整队生效、光锥靠改账号叠影生效，
  // 两者都改变池子本身，所以既进 `planKey` 又进 `buildOptions`（只进一处就会拿到旧池）。
  const exclude = normalizeExclude(options.exclude);
  const excludedChars = new Set(exclude.characters);
  const account = accountWithExclusions(accountOf(options.account), exclude);
  const planKey = planSignatureOf({
    envKey,
    hiddenCosts: options.hiddenCosts,
    // ⚠️ ws 必须进整池键：方案分 = (ws × 强度 + wc × 性价比) × 版本权重，
    //    换个强度权重整池的名次就全变了。wc 已经通过 `envKey` 进来了（关卡层的
    //    `scoreEnvRows()` 收 wc），ws 不进关卡层，只能在这里单独带上。
    ws,
    account,
    exclude,
  });
  const poolState = await cachedAsync(POOL_CACHE, planKey, (value) => value.rowCount, async () => {
    const buildOptions = {
      // ⚠️ 必须过 `accountOf()`：它把 JSON 的数组/对象转成成本模型要的 Set / Map。
      //    直接透传 `options.account` 会让 `owned.has()` 永远 false（见上面那段注释）。
      // 这里用的是**已经减过叠影的**那一份（`accountWithExclusions`），与签名同源。
      account,
      excludeChars: excludedChars,
      availability: index.availability || index.refs?.availability || {},
      hiddenCosts: options.hiddenCosts,
      ws,
      wc,
      // 回 `{ url, sources }`：`url` 是首选（B 站优先），`sources` 是这套**整包**的全部来源。
      // ⚠️ 键与 `videoIndexOf()` 同源：`season|整包键`（`角色|E档|光锥|S档` 排序拼 `~`）。
      //    2026-10-22 之前这里按「四个角色名」查，同角色不同配装的投稿会串门 —— 卡片上印的是
      //    E6S5，点开的却可能是 E2S1 那条投稿。用户这轮明确要求「另外的来源要显示完全相同的
      //    配装，但投稿不同」，所以键必须带上星魂档 / 光锥 / 叠影。
      videoOf: (rosterKey, season) => {
        const bySeason = env.videos.get(`${season}|${rosterKey}`);
        if (bySeason) return bySeason;
        // 该版本没有就用**最新一版有视频的**兜底：用户点开要的是「这套配装的投稿」，
        // 差一个版本仍然是同一套打法，比一个点不动的卡片有用。
        for (const s of Object.keys(env.seasonWeights).sort().reverse()) {
          const hit = env.videos.get(`${s}|${rosterKey}`);
          if (hit) return hit;
        }
        return null;
      },
    };

    // ① 满分池：榜面口径（与改之前**逐字节一致**）。
    const board = buildPlanPool(env.scored, buildOptions);
    // ② 非满分池：只用来**召回**（差一档 / 通关 / 未达标），排在满分之后。
    const extra = env.extraScored.length ? buildPlanPool(env.extraScored, buildOptions) : null;
    // ③ 合成条目表：满分在前、非满分按档位分组（规则全在 `mergePlanEntries()` 里）
    const merged = mergePlanEntries(board, extra);

    const i18n = await loadI18n();
    // 搜索要中文名（用户会敲「流萤」而不是 `Firefly`）。名字只在这里解析一次，
    // `plan-index.js` 全程只用这个函数，不 import i18n、也不碰文件。
    const nameOf = (kindOfName, name) => {
      if (!name) return null;
      return zhName(i18n, kindOfName === 'cone' ? 'lightCones' : 'characters', name) || null;
    };
    // 搜索索引**必须常驻这份缓存对象**：词元倒排与 lastQuery 命中缓存都挂在索引对象
    // 上。2026-10-21 第一版在每次请求里现场包一个 `{ entries, nameOf }` —— 对象每次
    // 都是新的，倒排每次重建，搜索从 3 ms 涨回 40 ms（真实数据实测）。索引的形状见
    // `plan-index.js`：它只读 `entries` / `nameOf`，缓存字段（tokenIndex / lastQuery）
    // 也写在它自己身上，随整池一起被 LRU 淘汰。
    const searchIndex = { entries: merged.entries, nameOf };
    return {
      board,
      extra,
      merged,
      searchIndex,
      rowCount: merged.entries.length,
      nameOf,
    };
  });

  // ---- ③ 全量搜索 + 分页（都只动行号，不重算任何分数）----
  // ⚠️ 索引按 `entries`（满分在前、非满分在后）建，名次 = 下标 + 1 ——
  //    所以「第 1~N 名」永远是满分队伍的次序，与非满分那一批无关。
  const found = searchPlanIndex(poolState.searchIndex, options.query);
  const page = planPageOf(found.ids, options.page, options.pageSize ?? options.maxRows);

  // ---- ④ 只物化当前页 ----
  const altOnlySet = new Set(found.altOnlyIds);
  const rows = page.ids.map((id) => {
    const entry = poolState.merged.entries[id];
    const row = materializePlanRow(entry.row, entry.state);
    // 名次 = **整池**里的名次（1 起）。搜索 / 翻页都只是视图，不许改写名次。
    row.rank = id + 1;
    // 「这条是靠次选命中的」标记：本队四个位置里没有关键词，是它下面的次选配队里有。
    row.altOnly = altOnlySet.has(id);
    return row;
  });

  const { tierCounts, boardCount } = poolState.merged;

  // ---- 「你现在就能打的队」（2026-10-22，用户：「用户已有配队也需要显示在抽卡方案」）----
  //
  // 「已有」= **补 0 金**（四个位置的星魂 / 光锥你都齐了），也就是这支队伍你现在就能直接打。
  // 这些队在榜里本来就有，但它们按分数排、常常落在好几页之后；用户要的是「一眼看到我手上
  // 已经有什么」。所以单独摘一份：**按分数取前 N 支**，随每页一起下发。
  //
  // ⚠️ 只取「合并后条目表」里的行（`merged.entries`），与榜面同源 —— 不另算一遍，否则
  //    「已有的队」和榜里的同一支队会出现两个分数。
  // ⚠️ 数量上限 `OWNED_TEAMS_MAX`：这一块是「摘要」，不是第二个榜；全量靠翻页 / 搜索。
  const ownedTeams = [];
  let ownedCount = 0;
  for (const entry of poolState.merged.entries) {
    const row = entry.row;
    if ((row.gap ?? 0) > 0) continue;
    ownedCount += 1;
    if (ownedTeams.length >= OWNED_TEAMS_MAX) continue;
    ownedTeams.push({
      key: row.key,
      lineup: row.lineup,
      score: Number((row.score ?? 0).toFixed(4)),
      bestSeason: row.bestSeason,
      bestScore: row.bestScore ?? null,
      tier: row.tier || 'perfect',
      gold: row.gold,
      members: row.members,
      video: row.video ?? null,
    });
  }

  const i18n = await loadI18n();
  const zh = (name) => (name ? (zhName(i18n, 'characters', name) || null) : null);
  const zhCone = (name) => (name ? (zhName(i18n, 'lightCones', name) || null) : null);

  // ---- 首领（2026-10-22，用户：「在最佳版本 x.x 右侧显示敌方 boss 的图标和名称」）----
  //
  // 名单来自档案的 `bosses['<模式英文名>||<版本>']`（经 `archiveIndex()` 重排成
  // `bossesByMode[slug][版本]`）。**图标是本地资源**：游戏素材库（StarRailRes）里没有敌
  // 人图标，所以由 `mirrorBossIcons()` 从 BWiki 敌人页首图抓一次落在 `theherta/boss-data/`；
  // 没抓到的那几个 `icon` 为 null，界面只印名字（不拿别的图冒充）。
  //
  // ⚠️ 按 stage 过滤：异相仲裁同一版本的骑士关 / 绝境王棋关共用一份名单，绝境那条名字
  //    带 `(Plight)` 后缀。绝境卡片印绝境首领，骑士关卡片印骑士关那几只 —— 混着印就是假话。
  const bossIcons = await bossIconMap();
  const bossNamesBySeason = index.bossesByMode?.[picked.mode] || {};
  const bosses = {};
  for (const [season, names] of Object.entries(bossNamesBySeason)) {
    const kept = (names || []).filter((name) => (picked.stage === 'plight'
      ? /plight/i.test(name)
      : !/plight/i.test(name)));
    if (!kept.length) continue;
    bosses[season] = localizeBosses(i18n, kept)
      .map((boss) => ({ ...boss, icon: bossIcons.get(boss.name) || null }));
  }

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
    // 回显生效的「不使用」清单（归一后）：界面上的 chips 印这一份，不自己再算一遍。
    exclude,
    // `{ 版本: [{name, nameCn, icon}] }`：卡片「最佳版本 4.4」右边那枚首领用。
    bosses,
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
    // 「你现在就能打的队」：`ownedTeams` 只给前 N 支（按分数），`ownedCount` 是全池里
    // 补 0 金的总数（摘要行的「共 N 支」用它）。
    ownedTeams: ownedTeams.map((team) => ({
      ...team,
      members: team.members.map(withCn),
    })),
    ownedCount,
    // 全池规模：`lineups` = **能翻到的总条数**（满分 + 非满分），
    // `boardLineups` = 其中满分那部分（= 榜面名次的上界），
    // `poolRows` = 该关卡窗口内的投稿记录数，`submissions` = 这些记录背后的真实投稿条数
    // （`perfectSubmissions` 是其中满分档的），`pool` = 整包数（折叠前）。
    pool: poolState.board.pool.length + (poolState.extra?.pool.length || 0),
    lineups: poolState.merged.entries.length,
    boardLineups: boardCount,
    poolRows: env.poolRows,
    submissions: env.submissions,
    perfectSubmissions: env.perfectSubmissions,
    // 各档位：`tierCounts` 是**池子里**的行数（可翻到），`tierSubmissions` 是投稿条数。
    tierCounts,
    tierSubmissions: env.tierSubmissions,
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

