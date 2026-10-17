// 抽卡推荐界面：把离线数据集渲染成两张清单。
//
// 页面结构（用户 2026-10 定稿，2026-10-11 第 10 轮改「抽卡方案」为队伍口径，
//           2026-10-12 第 1、2 条把「性价比总榜」改名「角色总榜」、「总榜权重」改名「权重」）：
//   ① 战斗记录（米游社官方数据）
//   ② 综合结论 · 该抽什么
//        · 角色总榜（**纯黑塔网投稿口径**，完全不看你的角色池）
//        · 权重（**三大类**：关卡权重 5 个副本 + 抽卡权重 强度/性价比/泛用性
//          + 版本权重 6 个槽位 —— 用户 2026-10-16 第 3 条加了第三类，
//          三组各自占一行）
//        · 抽卡方案（**队伍口径**：按你的角色池算「照抄哪支队最划算」+ 补金顺序）
//   ③ 环境统计 · 上场率（按当前选中的副本 / 版本）
//
// ⚠️ **副本权重只剩一套**（用户 2026-10-11 第 10 轮：「去掉方案权重那一行」）：
// 角色总榜与抽卡方案的「强度得分」都吃它。原先那套「方案权重」只服务旧 `budgetPlan` /
// 差距榜 / 星魂榜，那三者都已不在界面上。副本权重因此收敛成单 scope
// （`WEIGHT_SCOPE = 'frontier'`）。
//
// ⚠️ **抽卡权重（强度 / 性价比 / 泛用性）是第二类权重**（用户 2026-10-12 第 2、3、4 条 +
// 2026-10-13 第 1、2 条）：
//   * **强度 / 性价比** —— 既进角色总榜的两个分项，也进浏览器里 `teamPlan()` 的加权
//     （方案里这两项再两两归一，所以泛用性旋钮不动方案）；
//   * **泛用性** —— 只进角色总榜的第三个分项。
//
// ⚠️ 因此它**从 v4.6.95 起必须进服务端请求**（v4.6.94 那版刻意不进，因为它当时只服务
// 抽卡方案）：角色得分 = 三个分项按它加权，而总榜「每角色只留一条」的**收敛**发生在
// 服务端的 `buildConclusion` 里 —— 只在浏览器里加权会让收敛选错代表整包。
// 所以改它要重算结论（与关卡权重、隐金设置同一条路），见输入框的接线。
//
// ⚠️ **版本权重（当前版本 / 前1个版本 …）是第三类权重**（用户 2026-10-16 第 3 条；
// 槽位名 2026-10-16 第 2 条改过：原「最新版 / −1 版 …」不再使用；2026-10-17 起档位可增删）：
// 每个副本窗口里「从当前版本往回 N 个版本」各占多少（默认 6 版 `6:5:4:3:2:1`，
// 用「加一版 / 删一版」把窗口改成 1~12 档）。
//   * 它决定服务端现算的 `seasonWeights`，客户端再拿那一份做跨版本加权 ——
//     所以同样**必须进服务端请求**（与抽卡权重同一条路，漏传就是「界面静默显示旧结果」）；
//   * 槽位**按下标**、不绑定版本号：黑塔网加一版就整体前移，所以界面只能写
//     「当前版本 / 前1个版本 / …」；而「当前版本」是**逐副本**的（4.5 在混沌与异相仲裁里不是同一期）；
//   * 它**不做「和归一到 1」**（`normalizeVersionWeights` 明确不做），界面印的是原值比例。
//
// 2026-10 删掉的两节：「你的补强路径」与「推荐阵容 · 按金数分档」——前者被
// 「抽卡方案」完全覆盖，后者的信息在「性价比总榜 + 环境统计」里已经给全。
import {
  EVIDENCE_LABEL, MODE_ORDER, ENV_WEIGHT_ROWS, envWeightDefaults,
  // 抽卡权重（用户 2026-10-12 第 2、3 条）：旋钮清单与默认值都只有 advice.js 那一份。
  DRAW_WEIGHT_ROWS, drawWeightDefaults, normalizeDrawWeights,
  // 版本权重（用户 2026-10-16 第 3 条）：**第三类**权重 —— 每个副本窗口里「从最新往前
  // N 个版本」各占多少（默认 6 版；用户 2026-10-17 起界面上能「加一版 / 删一版」）。
  // 旋钮清单（`versionWeightRows()`）、默认表与读数规则同样只有
  // `advice.js` 那一份（服务端 `archive.js` 读的也是它，两边必须同源）。
  versionWeightRows, versionWeightDefaultAt, VERSION_WEIGHT_MAX,
  versionWeightDefaults, versionWeightValues, normalizeVersionWeights,
  formatRate, frontierFactorsOf, avLinesOf, metricShortText, metricValueText, ownedCharacters,
  ownedLightCones, perfAnchorsOf, perfLineWeightsOf, scorePercent,
  eidolonsOf, lightConeRanksOf, TIER_PLACEHOLDER, tierLabelsOf, tierMoveText, tierTextOf,
  // ⚠️ `eidolonTierOf`：泛用性的**归一区间是按星魂档分组**的（用户 2026-10-14 第 1 条），
  //    详情窗口要按整包自己的档去取 `frontierExtents.versatility.byTier`，与算分同一把尺子。
  // ⚠️ `coneCostOf`：强度详情窗口的「叠影档」要判**这把光锥要不要金**（v4.6.113）——
  //    免费 / 4★ 锥的叠影不算投入，与算分的 `coneRankOf()` 同一把尺子（抄一份早晚分叉）。
  eidolonTierOf, coneCostOf,
  // 强度两档的天花板常量（`strengthSecondBandCap`）：详情窗口要把这条规则写出来
  // （v4.6.113），必须读 `advice.js` 那一份，不许在这里另抄一个 90。
  SCORING,
  weightInputOf, teamPlan,
  // 隐金设置（用户 2026-10-11）：五组的名单 / 文案 / 默认值都只有 advice.js 那一份，
  // 这里只负责按它画界面，绝不抄第二份名单。
  HIDDEN_COST_IDS, HIDDEN_COST_SETTINGS, DEFAULT_HIDDEN_COSTS,
} from './advice.js';
// 搜索 / 分页的纯逻辑（用户 2026-10-18）：抽成独立模块的唯一理由是**能被 Node 直接测**
// —— 它们不碰 DOM、不碰评分，而「284 条是不是 15 页、最后一页几条、页码怎么夹」这类
// 算术不该为了测它去起一次真浏览器（本机沙箱也起不来服务，见 docs/CDP布局套件.md §2.1）。
import {
  clampPage, matchesQuery, pageSliceOf, pageWindowOf, queryOf, queryTermsOf, searchTextOf,
  withRealRank,
} from './advice-paging.js';
import { renderRecordSection, wireRecordPanel } from './battle-record.js';
import { accessHeaders, readAccessToken } from './access.js';
// 性价比详情的大窗口外壳（用户 2026-10-10 第二轮：「需要单独开一个较大的窗口避免部分
// 内容被网页遮挡」）。本文件只管**建内容**，窗口只管**搬与关** —— 口径不受影响。
import { closeTipWindow, isTipWindowOpen, openTipWindow } from './advice-tip-window.js';
// 「隐金设置」那个详情窗口的外壳（用户 2026-10-11）。同样是「外壳归它、内容归本文件」。
import { openGoldSettings } from './advice-gold-modal.js';

const $ = (id) => document.getElementById(id);

const el = {
  layoutAdvice: $('layoutAdvice'),
  mode: $('adviceMode'),
  season: $('adviceSeason'),
  /** 抽卡方案的状态行（挂在标题行里）。 */
  teamPlanMeta: $('adviceTeamPlanMeta'),
  reload: $('adviceReload'),
  update: $('adviceUpdate'),
  /** 数据状态那一块里的三格（用户 2026-10-11：三份缓存的记录收在一起）。 */
  empty: $('adviceEmpty'),
  loading: $('adviceLoading'),
  body: $('adviceBody'),
  brief: $('adviceBrief'),
  snapshotFreshness: $('adviceSnapshotFreshness'),
  record: $('adviceRecord'),
  recordFreshness: $('recordFreshness'),
  datasetFreshness: $('adviceDatasetFreshness'),
  recordMeta: $('recordMeta'),
  recordNote: $('recordNote'),
  recordRefresh: $('recordRefresh'),
  conclusion: $('adviceConclusion'),
  conclusionMeta: $('adviceConclusionMeta'),
  conclusionUnits: $('adviceConclusionUnits'),
  unitNote: $('adviceUnitNote'),
  unitFilter: $('adviceUnitFilter'),
  unitMeta: $('adviceUnitMeta'),
  /** 角色总榜的搜索框（用户 2026-10-18：按角色 / 光锥名称搜）。 */
  unitSearch: $('adviceUnitSearch'),
  /** 权重区块：关卡权重那一行（只影响角色总榜与抽卡方案的强度侧）。 */
  frontierWeightRow: $('adviceFrontierWeightRow'),
  frontierWeightsMeta: $('adviceFrontierWeightsMeta'),
  frontierWeightsReset: $('adviceFrontierWeightsReset'),
  /** 抽卡权重那一行（强度 / 性价比 / 泛用性；用户 2026-10-12 第 2、3 条 + 2026-10-13 第 1 条）。 */
  drawWeightRow: $('adviceDrawWeightRow'),
  drawWeightsMeta: $('adviceDrawWeightsMeta'),
  /** 版本权重那一行（默认 6 个版本槽位；用户 2026-10-16 第 3 条 + 2026-10-17 可增删）。 */
  versionWeightRow: $('adviceVersionWeightRow'),
  versionWeightsMeta: $('adviceVersionWeightsMeta'),
  /** 版本权重槽位的两个按钮（用户 2026-10-17：加一版 / 删掉最后一版）。 */
  versionWeightAdd: $('adviceVersionWeightAdd'),
  versionWeightRemove: $('adviceVersionWeightRemove'),
  versionWeightCount: $('adviceVersionWeightCount'),
  /** 隐金设置（权重块下方的按钮 + 它旁边的状态行）。 */
  hiddenCostsOpen: $('adviceHiddenCostsOpen'),
  hiddenCostsMeta: $('adviceHiddenCostsMeta'),
  /** 抽卡方案（队伍口径）：说明块 + 列表。 */
  teamPlanNote: $('adviceTeamPlanNote'),
  teamPlanBody: $('adviceTeamPlanBody'),
  /** 抽卡方案的搜索框与两个翻页条（用户 2026-10-18：配队改为尽量多 + 每页 20）。 */
  teamPlanSearch: $('adviceTeamPlanSearch'),
  teamPlanPager: $('adviceTeamPlanPager'),
  teamPlanPagerBottom: $('adviceTeamPlanPagerBottom'),
  chars: $('adviceChars'),
  charMeta: $('adviceCharMeta'),
  charNote: $('adviceCharNote'),
};

/**
 * 权重输入的本地存档键。
 *
 * ⚠️ 2026-10-11 起**副本权重只有一套**（用户第 10 轮「去掉方案权重那一行」）：
 * 角色总榜与抽卡方案的强度侧都吃这一套。所以这里只认 `frontier` 这一个 key；
 * `.plan` 那份不再被读写（旧存档留在 localStorage 里不清理，万一以后要回滚还能读到）。
 *
 * 旧版只有一个 `hsr.advice.weights`。迁移：`frontier` 读不到时把旧键的值当它的初值
 * —— 用户之前调过的那组数不会因为这次改造丢掉。
 */
const WEIGHT_SCOPE = 'frontier';
/**
 * 存档仍然读写这两个 key（`.plan` 只保留旧数据、不再使用）——用一张表而不是写死一个
 * 字符串，是为了 `loadWeights` / `saveWeights` 与 `conclusionKey()` 三处同源。
 */
const WEIGHT_SCOPES = ['plan', 'frontier'];
const WEIGHTS_KEY = { plan: 'hsr.advice.weights.plan', frontier: 'hsr.advice.weights.frontier' };
const LEGACY_WEIGHTS_KEY = 'hsr.advice.weights';
/**
 * **抽卡权重**（强度 / 性价比）的本地存档键（用户 2026-10-12 第 2、3 条）。
 *
 * 为什么与副本权重分开存：它是**另一类**权重（不参与服务端算分），而且用户很可能
 * 只想调这一个旋钮而不动五个副本权重。与隐金设置一样属于长期偏好，必须跨会话保留。
 * ⚠️ 它**不进 `conclusionKey()`** —— 服务端载荷与它无关，改它只重画抽卡方案那一块。
 */
const DRAW_WEIGHTS_KEY = 'hsr.advice.drawWeights';
/**
 * **版本权重**（每个副本窗口里当前版本往回 6 个版本各占多少）的本地存档键
 * （用户 2026-10-16 第 3 条）。
 *
 * ⚠️ 与抽卡权重一样是**长期偏好**，必须跨会话保留；但形状是**长度 6 的数组**
 * （下标 0 = 当前版本），不是对象 —— 读回时一律过 `versionWeightValues()`（缺槽位 /
 * 非法值按默认补、空串 = 0），所以老存档、短数组、多给的值都退化成安全形状。
 */
const VERSION_WEIGHTS_KEY = 'hsr.advice.versionWeights';
/**
 * 隐金设置的本地存档键（用户 2026-10-11）。
 *
 * 与权重一样存 localStorage：这是一个**长期偏好**（「这些角色我有，别再算它们的钱」），
 * 每次打开页面都要重新勾一遍是不能接受的。存档形状就是那五个布尔。
 */
const HIDDEN_COSTS_KEY = 'hsr.advice.hiddenCosts';
/** 权重改动后延迟多久重算：用户在输入框里连着敲数字，不必每一下都打一次服务端。 */
const WEIGHTS_DEBOUNCE = 450;
/**
 * 搜索框的防抖（用户 2026-10-18 的两个搜索框）。
 *
 * 比权重那个 450 ms 短得多：搜索是**纯前端过滤**（不请求服务端、不重算分数），
 * 代价只有一次 `filter + 重画`（总榜 81 行 / 方案 20 张卡，都在几毫秒内），
 * 而 450 ms 的延迟会让人觉得「输入框没反应」。120 ms 足够避开连续按键。
 */
const SEARCH_DEBOUNCE = 120;

/** 单位类型的中文名（**抽卡方案**那一节按 kind 分段时用）。 */
const KIND_LABEL = { char: '角色', eidolon: '星魂', cone: '光锥' };

const state = {
  index: null,
  stats: null,
  mode: null,
  stage: '',
  season: null,
  loading: false,
  snapshot: null,
  owned: new Set(),
  ownedLightCones: new Set(),
  eidolons: new Map(),
  /** 已装备光锥的叠影等级：算「还差几次叠影」要用。 */
  coneRanks: new Map(),
  /** 用户自己定的副本权重（`${副本}|${关卡}` → 数值；`.plan` 那份只剩旧存档）。
   *  空对象 = 用默认值。见 advice.js 的 `WEIGHT_SCOPES`。 */
  weights: { plan: {}, frontier: {} },
  /**
   * **抽卡权重**（用户 2026-10-12 第 2、3 条）：`{ strength, cost }` 两个**原始**输入值。
   *
   * ⚠️ 存的是用户敲进来的原值（例如 `3` 与 `1`），**不是**归一化后的比例 —— 归一化
   * 由 `advice.js` 的 `normalizeDrawWeights()` 独占负责（界面若自己算一遍，早晚会
   * 与算分那条链分叉：比如「两个都清空」到底算等权还是算 0）。
   */
  drawWeights: { ...drawWeightDefaults() },
  /**
   * **版本权重**（用户 2026-10-16 第 3 条）：长度 6 的**数组**，下标 0 = 该副本最新版。
   *
   * ⚠️ 存的是用户敲进去的**原值**（默认 `[3, 2.5, 2, 1.5, 1, 0.5]`），不做「和归一到 1」
   * —— 它只有相对大小有意义，而界面上要印原值（与 `normalizeVersionWeights` 同一条
   * 约定：整体乘个常数不改变任何结果）。
   * ⚠️ 槽位**不绑定具体版本号**：黑塔网加一版之后整张表前移（下标 0 从 4.6 变成 4.7），
   * 所以界面只能写「当前版本 / 前1个版本 / …」。
   */
  versionWeights: versionWeightDefaults(),
  /** 权重输入的防抖计时器。 */
  weightsTimer: null,
  /** 抽卡权重的防抖计时器（与副本权重分开：改一个不该取消另一个的重算）。 */
  drawWeightsTimer: null,
  /** 版本权重的防抖计时器（同上：三类旋钮各一个，改一个不该取消另一个的重算）。 */
  versionWeightsTimer: null,
  /**
   * 隐金设置（用户 2026-10-11）：五个布尔，`{ gift, giftCone, exchange, exchangeCone, standard }`。
   *
   * ⚠️ **界面默认是全勾**（用户：「以下复选框默认已点击」），而**接口默认是一项都不减**
   * （见 advice.js 的 `DEFAULT_HIDDEN_COSTS`）—— 所以界面每次都会把五个布尔显式发过去，
   * 不会因为「少发一个字段」而让榜面退回原价。
   */
  hiddenCosts: { ...DEFAULT_HIDDEN_COSTS },
  /** 隐金改动的防抖计时器（与权重那个分开：两个互不相关，共用一个会互相取消）。 */
  hiddenCostsTimer: null,
  /**
   * 角色总榜的**筛选**状态：只看某一星魂档的整包 / 只看自己还没有的。
   *
   * ⚠️ 2026-10-11 第 10 轮（`feat/team-plan`）一度把这个筛选器连同节点一起撤掉，
   * 同一版的另一支 `dsh/fix-eidolon-tier-filter` 恰好把它修好了（每档各自收敛一条）——
   * **收尾人裁决：保留并修好筛选器**，所以这两个字段与 `renderUnitFilters()` 都回来了。
   * 详见 HANDOFF §4.2E。总榜的单位是「角色 + 星魂档 + 光锥」整包，所以筛选维度是星魂档，
   * 不再是旧的「角色 / 星魂 / 光锥」三选一（那只对旧的节点口径有意义）。
   */
  unitEidolon: 'all',
  onlyMissing: false,
  /**
   * **两个搜索框的词**（用户 2026-10-18：「为角色总榜和抽卡方案添加 2 个搜索框，能够根据
   * 角色或光锥名称进行搜索」）。
   *
   * ⚠️ 只存在内存里、**不进 localStorage**：搜索是一次性的动作（「我把那个角色放哪了」），
   *    与三类权重 / 隐金那种长期偏好不同；下次打开页面还留着上次的词，会让榜面莫名其妙
   *    缺一大半。空串 = 不过滤。
   * ⚠️ 存的是**用户敲的原串**（含大小写 / 空格），归一化只在比较时做（`queryOf()`），
   *    因为输入框要原样回显、状态行也要原样印出来。
   */
  unitQuery: '',
  teamPlanQuery: '',
  /** 两个搜索框的防抖计时器（互不相关，共用会互相取消）。 */
  unitQueryTimer: null,
  teamPlanQueryTimer: null,
  /**
   * 跨模式综合结论（服务端算好的）。
   */
  conclusion: null,
  conclusionKey: null,
  conclusionError: '',
  /**
   * **抽卡方案的分页状态**（用户 2026-10-18：「提供尽可能多的配队，为此可以进行分页显示，
   * 每页显示 20 个配队」）。
   *
   * `teamPlanPage` 是**过滤之后**那一段的页码（1 起）。搜索词一变就回到第 1 页 ——
   * 否则「搜索一个只在第 3 页才出现的角色」会先落到一个空页上。
   */
  teamPlanPage: 1,
  /**
   * **抽卡方案的计算结果缓存**。
   *
   * `teamPlan()` 在**浏览器里**跑（服务端不下发队伍方案），全池 284 支实测约 22 ms ——
   * 翻一次页 / 敲一个字都重算一遍会明显卡手。所以按「输入签名」缓存一份：
   * 只有结论对象换了、账号持有变了、或三类权重里的抽卡权重变了才重算。
   *
   * ⚠️ 签名**必须**含 `conclusion` 的对象身份：换账号 / 改关卡权重 / 改版本权重都会
   *    让服务端重算出一份**新的** `conclusion`（旧对象被丢弃），靠身份就能识别；
   *    只比 `counts` 之类的字段会在「同账号改权重」时漏掉。
   * ⚠️ 也含 `owned` / `eidolons` / `coneRanks` 的**规模**：同一份结论下换一个「角色数
   *    相同」的虚拟账号，池里的队伍不变但差额全变（`marginalCostOf` 吃这三份）。
   *    规模相同、内容不同的极端情形由上面的 `conclusion` 身份兜住 —— 换账号必然重取结论。
   */
  teamPlanCache: null,
  /**
   * 三个分项的归一上下限，**当结论还没加载过时**由 `/api/archive/packs` 随包带回
   * （角色面板那条路：用户可能直接在「角色信息」页点开一张卡）。
   * 有结论时优先用 `conclusion.frontierExtents` —— 见 `frontierExtentsNow()`。
   */
  packsFrontierExtents: null,
  /** 第一节：米游社战斗记录（原始抓取 + 敌方信息）。 */
  records: null,
  recordsFreshness: null,
  recordsError: '',
  recordsLoading: false,
  /** 被服务端限流后还要等多少秒才能再点刷新（0 = 不限流）。倒计时由 `armThrottle` 维护。 */
  recordsThrottled: 0,
  throttleTimer: null,
  onNeedSnapshot: null,
  onNeedSnapshotResponse: null,
  /** 取当前账号/角色与 CSRF（战斗记录要按 UID 去服务端读）。 */
  onNeedRole: null,
  /** 点战斗记录里的角色 chip：在本页弹出角色面板（不再跳分页）。 */
  onOpenCharacter: null,
  /** 同步黑塔网数据的进度（SSE）。 */
  updating: false,
};

const apiGet = async (path) => {
  const res = await fetch(path, { headers: accessHeaders() });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.ok) {
    const message = res.status === 401
      ? (readAccessToken()
        ? '访问令牌无效。请检查地址中的 #token=… 后重新加载。'
        : '此服务需要访问令牌，请使用 #token=你的令牌 追加到地址后重新加载。')
      : (payload?.error || `请求失败（HTTP ${res.status}）`);
    throw new Error(message);
  }
  return payload;
};

/**
 * 极简行内富文本：把 `**重点**` 渲染成 `<strong>`，**其余一律按纯文本**。
 *
 * 为什么需要它（2026-10-15，用户这一轮要「更美观、小字更好懂」时发现的）：
 * 界面文案里有**四十多处**是按 Markdown 习惯写的（例：
 * `'……但**最小 / 最大取本星魂档自己那一把尺子**）'`），而 `text()` 用的是
 * `textContent` —— 于是那些 `**` **原样印在屏幕上**。CDP 截图确认过，「角色得分 = …」
 * 那一行实际渲染成 `但**最小 / 最大取本星魂档自己那一把尺子**）`。
 * 既难看，又正好把这批「小字说明」的可读性拉低 —— 而它们恰恰是用户说的
 * 「方便用户了解程序的功能」的那部分文字。
 *
 * ⚠️ **从不拼 HTML 字符串**：命中的片段用 `createElement('strong')` + `textContent`
 * 建出来、其余进文本节点，所以角色名 / 关卡名这类**数据侧**字符串即使带 `<` `>` `**`
 * 也只会被当普通文字（不存在注入面）。
 * ⚠️ `textContent` 读出来 = 去掉那几对星号。探针里的逐字断言（`NOTE_EXACT` 等）
 * 本来就没有星号，所以不受影响 —— 反过来，若哪天某条断言**依赖**星号，那说明
 * 它钉错了东西。
 */
const inlineRichText = (raw) => {
  const s = String(raw);
  const parts = s.split('**');
  const frag = document.createDocumentFragment();
  // 没有成对的 `**`（length === 1），或者星号落单（偶数长度）→ 整段按纯文本，
  // **一个字都不改**：宁可把星号原样留着，也不要把用户看得见的文字吃掉。
  if (parts.length < 3 || parts.length % 2 === 0) {
    frag.appendChild(document.createTextNode(s));
    return frag;
  }
  // 拆分后**奇数下标**就是被星号包住的那几段。
  parts.forEach((piece, i) => {
    if (!piece) return;
    if (i % 2 === 1) {
      const strong = document.createElement('strong');
      strong.textContent = piece;
      frag.appendChild(strong);
    } else {
      frag.appendChild(document.createTextNode(piece));
    }
  });
  return frag;
};

const text = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) {
    const raw = String(content);
    // 快路径：绝大多数文案没有 `**`，走 `textContent`（与改前逐字节相同）。
    if (raw.includes('**')) node.appendChild(inlineRichText(raw));
    else node.textContent = raw;
  }
  return node;
};

const showEmpty = (message, hint = '') => {
  el.empty.innerHTML = '';
  el.empty.appendChild(text('div', 'warn-lead', message));
  if (hint) {
    const p = text('p', 'muted small');
    p.style.marginTop = '8px';
    p.textContent = hint;
    el.empty.appendChild(p);
  }
  el.empty.hidden = false;
  el.body.hidden = true;
  el.loading.hidden = true;
};

/**
 * 数据集英文名 → 官方中文；缺翻译时退回英文。
 *
 * ⚠️ 这里**自己查** archive index，而不是只认传进来的 `cnName`：总榜的单位
 * （`frontierUnits`）一路没有 `nameCn` 字段，只靠 cnName 会让整张榜显示
 * 「Yao Guang」「When She Decided to See」这种英文键（方案那节有 nameCn，
 * 所以以前只有总榜是这样）。index 本来就为持有情况匹配加载过，查表是零成本。
 */
let nameMapsCache = null;
const nameMaps = () => {
  if (nameMapsCache && nameMapsCache.index === state.index) return nameMapsCache;
  const chars = new Map();
  const cones = new Map();
  for (const c of state.index?.refs?.characters || []) {
    if (c.name && c.nameCn) chars.set(c.name, c.nameCn);
  }
  for (const c of state.index?.refs?.lightCones || []) {
    if (c.name && c.nameCn) cones.set(c.name, c.nameCn);
  }
  nameMapsCache = { index: state.index, chars, cones };
  return nameMapsCache;
};

const cn = (name, cnName) => cnName || nameMaps().chars.get(name) || name || '';

/** 光锥的英文键 → 中文名（总榜的整包标签要用）。 */
const cnCone = (name) => (name ? nameMaps().cones.get(name) || name : '');

const characterName = (row) => cn(row?.name, row?.nameCn);

// ---------------------------------------------------------------- 图标（总榜行 / 浮层配队）
//
// 用户 2026-10 要求：角色总榜每一行要有「角色头像 + 光锥图标」两张图，浮层里的
// 配队也要带图。图片地址来自 `/api/archive` 的 `refs.icons`（服务端
// `src/server/archive.js` 暴露），**不在这里拼 CDN URL** —— 图标表里没有的键就是
// 真的没有，拼出来的地址只会 404。
//
// 三个子表：`characters`（头像 icon/character/*.png，实测 256×256）、
// `lightCones`（光锥图标 icon/light_cone/*.png，实测 128×128）、`previews`（立绘 /
// 光锥大图，本页不用 —— 立绘太大会把总榜行撑高）。
//
// ⚠️ **缺图是常态，不是异常**。实测（本地当前数据集，2026-10）：
//   * 角色：数据集 93 个键，`icons.characters` 只有 88 个 —— 缺的正好是 7 个「形态
//     变体」：`March 7th (Hunt)` / `March 7th (Preservation)` /
//     `Trailblazer (Destruction|Elation|Harmony|Preservation|Remembrance)`；
//     图标表登记的是基础名（`March 7th`）与 `{NICKNAME}`。
//   * 光锥：数据集 141 个键，只差 1 个 —— `Dance Dance Dance`（图标表里写作
//     `Dance! Dance! Dance!`，标点不同）。
// 所以解析走四级兜底：原名 → 形态基础名 → 去标点小写归一化 → 归一化后的基础名。
// 用真实结论数据核过一遍：总榜 69 个角色键 / 135 个光锥键、队友 39 个角色键 /
// 67 个光锥键**全部**能解析到图（一个都不缺）；兜底不是为了「也许以后有用」，
// 而是这三类差异现在就在数据里。

/** 去标点 + 小写：让 `Dance Dance Dance` 与 `Dance! Dance! Dance!` 归到同一个键。 */
const looseKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * 形态变体的基础名：`March 7th (Hunt)` → `March 7th`。
 *
 * 开拓者**单独处理**、不是简单「去掉括号」：图标表里根本没有 `Trailblazer` 这个键，
 * 玩家角色的头像登记在 `{NICKNAME}`（id 8010）下面。
 */
const baseFormKey = (name) => {
  const raw = String(name || '');
  if (/^Trailblazer\b/i.test(raw)) return '{NICKNAME}';
  return raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
};

/** 图标表的两种索引（精确 / 归一化），跟着 index 缓存一次。 */
let iconMapsCache = null;
const iconMaps = () => {
  if (iconMapsCache && iconMapsCache.index === state.index) return iconMapsCache;
  const build = (table) => {
    const exact = new Map();
    const loose = new Map();
    for (const [key, url] of Object.entries(table || {})) {
      if (!url) continue;
      if (!exact.has(key)) exact.set(key, url);
      const folded = looseKey(key);
      if (folded && !loose.has(folded)) loose.set(folded, url);
    }
    return { exact, loose };
  };
  const icons = state.index?.refs?.icons || {};
  iconMapsCache = {
    index: state.index,
    char: build(icons.characters),
    cone: build(icons.lightCones),
  };
  return iconMapsCache;
};

/** 角色 / 光锥的英文键 → 图标地址；**查不到返回 null**（调用方不许自己拼 URL）。 */
const iconUrlOf = (kind, name) => {
  if (!name) return null;
  const map = iconMaps()[kind === 'cone' ? 'cone' : 'char'];
  return map.exact.get(name)
    || map.exact.get(baseFormKey(name))
    || map.loose.get(looseKey(name))
    || map.loose.get(looseKey(baseFormKey(name)))
    || null;
};

/**
 * 固定尺寸的图标 `<img>`：**尺寸一律由 CSS 写死**（`width` / `height` + `object-fit`），
 * 绝不让图片自己决定占多大。
 *
 * 为什么必须固定（handoff §6.1 第 3、4 条）：
 *   * 这些图在 CDN 上，是**异步**加载的。尺寸不固定的话，80 行总榜会边加载边重排；
 *   * 详情窗口里同理：窗口正文是**固定尺寸**的（`advice-tip-window.css`），图片后到
 *     一步把某一行撑高，正文的滚动长度就在用户眼前跳一下。尺寸写死之后，插进去多大
 *     就是多大 —— 所以这里**故意不做** `img.onload → 重新排版` 的补救，那等于承认
 *     尺寸会变，而且每行各挂一个 onload 反而更容易在点开瞬间抖动。
 *
 * 图挂了（CDN 丢请求 / 防盗链 / 没网）**不摘节点**，只加 `is-missing` 让 CSS 把破图藏掉：
 * 摘节点会改变布局（行高会跳），留一个同样大小的空位最稳，也不会出现碎图。
 * 一个地址都解析不到时返回 null，调用方不追加节点（缺图是优雅降级，不是画个空框）。
 *
 * `loading` 默认 `'lazy'`：总榜最多 80 行 × 2 张图，全量 eager 会一次打 100 多个 CDN
 * 请求（实测头像 256×256 约 120KB、光锥 128×128 约 30KB），而且实测**并发一多
 * jsdelivr 会丢请求**（同一批 798 张里有 3 张失败，单独 fetch 同一个地址却是 200）。
 * 窗口里那几张（每次最多 8 张）反过来用 `'eager'`：它们是**点开那一刻**才插进 DOM 的，
 * 懒加载会让用户先看到一片空位。
 */
const iconImg = (url, className, alt = '', loading = 'lazy') => {
  if (!url) return null;
  const img = document.createElement('img');
  img.className = className;
  img.alt = alt;
  img.loading = loading;
  img.decoding = 'async';
  img.addEventListener('error', () => img.classList.add('is-missing'), { once: true });
  img.src = url;
  return img;
};

/** 总榜行的角色头像；图标表里没有这个键时留一个同尺寸空位（行左边才不会参差不齐）。 */
const unitAvatar = (name) => {
  const img = iconImg(iconUrlOf('char', name), 'advice-unit-avatar', cn(name));
  return img || text('span', 'advice-unit-avatar is-empty');
};

// ------------------------------------------------------------------ controls

/**
 * 副本/关卡选择。**异相仲裁的两个关卡各占一条**：它把三种难度混在同一版本里
 * （骑士关与普通王棋关看轮次，绝境王棋关看行动值，判据完全不同），其余副本只有
 * 一档。
 *
 * 为什么合成一个选择器、而不是另做一个「关卡」下拉框：那个控件只有异相仲裁用得上。
 * 收起来会让控件行从两行变一行，整排控件上下跳 131px（1920px 下实测，正是以前修过
 * 的那个 bug）；一直留着又纯属冗余——它的内容本来就是这个副本的名字。合成一个之后
 * 控件行宽度恒定，两个问题一起没了。
 *
 * 选项 value 一律是 `副本|关卡`（单档副本的关卡是空串），和服务端
 * `/api/archive/stats?mode=&stage=` 的两个参数一一对应。
 */
const modeValueOf = (mode, stage) => `${mode}|${stage || ''}`;

const parseModeValue = (value) => {
  const [mode, stage] = String(value || '').split('|');
  return { mode: mode || null, stage: stage || '' };
};

const renderModeOptions = () => {
  el.mode.innerHTML = '';
  const modes = [...(state.index.modes || [])].sort(
    (a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode),
  );
  for (const mode of modes) {
    for (const stage of mode.stages || []) {
      const option = document.createElement('option');
      option.value = modeValueOf(mode.mode, stage.stage);
      // 有独立关卡名的（异相仲裁）拼上关卡名；单档副本沿用「中文（英文）」的写法。
      option.textContent = stage.labelCn
        ? `${mode.labelCn} · ${stage.labelCn}`
        : `${mode.labelCn}（${mode.label}）`;
      el.mode.appendChild(option);
    }
  }
  const options = [...el.mode.options];
  const wanted = modeValueOf(state.mode, state.stage);
  const picked = options.find((o) => o.value === wanted) || options[0];
  if (picked) el.mode.value = picked.value;
  ({ mode: state.mode, stage: state.stage } = parseModeValue(el.mode.value));
};

const renderSeasonOptions = () => {
  const mode = (state.index.modes || []).find((m) => m.mode === state.mode);
  const stage = (mode?.stages || []).find((s) => s.stage === state.stage);
  const seasons = [...(stage?.seasons || mode?.seasons || [])].reverse();
  const latestForMode = seasons[0] || null;
  el.season.innerHTML = '';
  for (const season of seasons) {
    const option = document.createElement('option');
    option.value = season;
    option.textContent = season === latestForMode ? `${season} 版本（最新）` : `${season} 版本`;
    el.season.appendChild(option);
  }
  if (!seasons.includes(state.season)) state.season = latestForMode;
  if (state.season) el.season.value = state.season;
};

// ------------------------------------------------------------------ rendering

/**
 * 一组标签共有的「词前缀」（只合并到空格，比较符不并进来）：
 * `积分 4000 / 积分 ≥3700` → `积分 4000 / ≥3700`，但 `行动值 <300 / <500` 里的
 * `<` 必须留着，否则会读成「<300 或 500」。
 */
const sharedWordPrefix = (list) => {
  let prefix = list[0] ?? '';
  for (const item of list.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < item.length && prefix[i] === item[i]) i += 1;
    prefix = prefix.slice(0, i);
  }
  const cut = prefix.lastIndexOf(' ');
  return cut >= 0 ? prefix.slice(0, cut + 1) : '';
};

/** 判据线：直接把游戏内实际的量列出来（0T / ≤2T / ≤4T、积分 4000 / ≥3700 / ≥3400）。 */
const tierLineText = (stats) => {
  const labels = tierLabelsOf(stats.mode, stats.stage, stats.tierLines);
  if (!labels?.perfect) return '';
  const parts = [labels.perfect, labels.target];
  if (stats.stage !== 'plight') parts.push(labels.pass);
  const prefix = sharedWordPrefix(parts);
  const body = parts.map((p) => p.slice(prefix.length)).join(' / ');
  return `判据：${prefix}${body}`;
};

// ------------------------------------------------------- 第一节：战斗记录

const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

const booleanValue = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return null;
  if (/^(true|yes|1|stale|expired|failed|error|partial)$/i.test(value.trim())) return true;
  if (/^(false|no|0|fresh|ok|current)$/i.test(value.trim())) return false;
  return null;
};

const dateValue = (value) => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 100000000000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return dateValue(numeric);
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

const ageValue = (value, numericUnit = 'seconds') => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return numericUnit === 'seconds' ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim().toLowerCase();
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numericUnit === 'seconds' ? numeric * 1000 : numeric;
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  return amount * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]]);
};

const freshnessStatus = (value) => {
  if (typeof value === 'boolean') return value ? 'fresh' : 'stale';
  if (typeof value === 'string') {
    const raw = value.trim().toLowerCase();
    if (/^(fresh|ok|current|success|available|新鲜)$/.test(raw)) return 'fresh';
    if (/^(stale|expired|old|过期|旧)$/.test(raw)) return 'stale';
    if (/^(partial|部分)$/.test(raw)) return 'partial';
    if (/^(failed|error|missing|unavailable|失败|缺失)$/.test(raw)) return 'failed';
  }
  if (value && typeof value === 'object') {
    if (booleanValue(value.failed) === true || booleanValue(value.error) === true) return 'failed';
    if (booleanValue(value.stale) === true || booleanValue(value.expired) === true) return 'stale';
    if (booleanValue(value.partial) === true) return 'partial';
    const nested = firstDefined(value.status, value.state, value.freshness);
    if (nested !== undefined) return freshnessStatus(nested);
    if (booleanValue(value.ok) === false || booleanValue(value.available) === false) return 'failed';
    if (booleanValue(value.ok) === true || booleanValue(value.available) === true || value.fetchedAt) return 'fresh';
  }
  return 'unknown';
};

const sectionLabel = (key) => ({
  brief: '高难汇总', challenge: '混沌回忆', story: '虚构叙事', boss: '末日幻影',
  peak: '异相仲裁', moc: '混沌回忆', pf: '虚构叙事', as: '末日幻影', aa: '异相仲裁',
}[key] || String(key || '').replace(/([a-z])([A-Z])/g, '$1 $2'));

const sectionEntries = (raw) => {
  if (Array.isArray(raw)) {
    return raw.map((value, index) => [
      String(firstDefined(value?.key, value?.id, value?.section, value?.name, `section-${index + 1}`)),
      value,
    ]);
  }
  return raw && typeof raw === 'object' ? Object.entries(raw) : [];
};

const normalizeFreshness = (resource, envelope = {}, kind = '战斗记录') => {
  const data = resource && typeof resource === 'object' ? resource : {};
  const response = envelope && typeof envelope === 'object' ? envelope : {};
  const metadata = firstDefined(data.cacheMeta, data.metadata, response.cacheMeta, response.metadata, response.cache) || {};
  const fetchedAt = dateValue(firstDefined(
    data.fetchedAt, metadata.fetchedAt, response.fetchedAt,
    data.lastSuccessfulFetchAt, metadata.lastSuccessfulFetchAt,
  ));
  const lastSuccessfulFetchAt = dateValue(firstDefined(
    data.lastSuccessfulFetchAt, metadata.lastSuccessfulFetchAt,
    data.previousFetchedAt, fetchedAt,
  ));
  const expiresAt = dateValue(firstDefined(data.expiresAt, metadata.expiresAt, response.expiresAt));
  const explicitAge = firstDefined(
    data.cacheAgeMs, metadata.cacheAgeMs, response.cacheAgeMs,
    data.cacheAgeSeconds, metadata.cacheAgeSeconds, response.cacheAgeSeconds,
    data.cacheAge, metadata.cacheAge, response.cacheAge,
  );
  const explicitAgeIsSeconds = data.cacheAgeMs === undefined
    && metadata.cacheAgeMs === undefined
    && response.cacheAgeMs === undefined;
  const cacheAgeMs = ageValue(explicitAge, explicitAgeIsSeconds ? 'seconds' : 'milliseconds')
    ?? (fetchedAt ? Math.max(0, Date.now() - fetchedAt.getTime()) : null);
  const stale = booleanValue(firstDefined(data.stale, metadata.stale, response.stale)) === true;
  const cachedValue = firstDefined(response.cached, data.cached, metadata.cached);
  const sourceKnown = cachedValue !== undefined || firstDefined(response.degraded, data.degraded, metadata.degraded) !== undefined;
  const cached = booleanValue(cachedValue) === true;
  const degraded = booleanValue(firstDefined(response.degraded, data.degraded, metadata.degraded)) === true;
  const errors = [data.errors, response.errors, data.warnings, response.warnings]
    .flatMap((items) => Array.isArray(items) ? items : [])
    .map((entry) => typeof entry === 'string'
      ? { section: '', message: entry }
      : {
        section: firstDefined(entry?.section, entry?.endpoint, entry?.key) || '',
        message: firstDefined(entry?.message, entry?.error, entry?.reason) || '',
      })
    .filter((entry) => entry.section || entry.message);
  const sectionRaw = firstDefined(
    data.sectionFreshness, data.sections, data.sectionStatus, data.freshness?.sections,
    metadata.sectionFreshness, metadata.sections,
  );
  const sections = sectionEntries(sectionRaw).map(([key, value]) => {
    const detail = value && typeof value === 'object' ? value : {};
    return {
      key,
      label: firstDefined(detail.label, detail.title, sectionLabel(key)),
      status: freshnessStatus(value),
      reason: firstDefined(detail.staleReason, detail.reason, detail.error, detail.message) || '',
    };
  });
  const explicitPartial = booleanValue(firstDefined(data.partial, metadata.partial, response.partial)) === true;
  const partial = explicitPartial || errors.length > 0
    || sections.some((section) => ['partial', 'failed'].includes(section.status));
  const expired = stale || Boolean(expiresAt && Date.now() >= expiresAt.getTime());
  const staleReason = firstDefined(
    data.staleReason, metadata.staleReason, response.staleReason, response.error,
    sections.find((section) => section.reason)?.reason,
  ) || '';
  const contractGaps = [];
  if (!fetchedAt) contractGaps.push('fetchedAt');
  if (firstDefined(data.expiresAt, metadata.expiresAt, response.expiresAt) === undefined) contractGaps.push('expiresAt');
  if (booleanValue(firstDefined(data.stale, metadata.stale, response.stale)) === null) contractGaps.push('stale');
  if (booleanValue(firstDefined(data.partial, metadata.partial, response.partial)) === null) contractGaps.push('partial');
  if (cachedValue === undefined) contractGaps.push('cached');
  if (!sections.length) contractGaps.push('sectionFreshness');
  return {
    kind, fetchedAt, lastSuccessfulFetchAt, expiresAt, cacheAgeMs,
    stale, expired, cached, degraded, partial, staleReason, errors, sections, contractGaps,
    status: expired ? 'expired' : partial ? 'partial' : cached ? 'cached' : sourceKnown ? 'fresh' : 'unknown',
  };
};

const freshnessAgeText = (ageMs) => {
  if (!Number.isFinite(ageMs) || ageMs < 0) return '';
  const minutes = Math.round(ageMs / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
};

const freshnessStatusText = (freshness) => {
  // 状态词允许被调用方覆盖：黑塔网那份数据是本机 theherta/ 里的聚合数据集，
  // 不是账号接口的缓存，所以那一格自带 `statusText`（见 `datasetFreshness()`）。
  if (freshness.statusText) return freshness.statusText;
  if (freshness.expired) return '过期/旧数据';
  if (freshness.partial) return '部分更新';
  // 角色快照 / 战斗记录虽然由应用服务端读写，但本项目是本机服务，数据实际
  // 保存在本机 data/accounts.json。旧文案「服务端缓存」只说明数据来自服务端
  // 抓取链路，容易被理解成远程服务器上的缓存；把存储位置和来源一起写出来。
  if (freshness.cached) return '本机缓存 · 米游社数据';
  if (freshness.status === 'unknown') return '\u6765\u6e90\u672a\u58f0\u660e';
  return '本次同步';
};

/**
 * 黑塔网数据集的那一格。
 *
 * 它也是「本机的一份数据」，所以进同一块状态栏；但它没有抓取/缓存的概念 ——
 * `generatedAt` 是**聚合脚本产出这份索引的时刻**（「重读本地数据」读的还是它，
 * 「同步黑塔网数据」跑完才会往前跳），所以状态词与时间标签都与另外两份不同。
 */
const datasetFreshness = () => {
  const iso = state.index?.generatedAt;
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    kind: 'dataset',
    fetchedAt: date,
    cacheAgeMs: Math.max(0, Date.now() - date.getTime()),
    statusText: '本机数据集 · 黑塔网聚合',
    timeLabel: '生成于',
    status: 'fresh',
  };
};

/**
 * 「数据状态」三格的**唯一一份定义**（用户 2026-10-11 第 3 条）。
 *
 * 用户原话：「将角色快照、战斗记录、黑塔网数据三者的缓存记录整合在一起，共同放置于
 * 抽卡推荐下方，保持界面美观」。改前这三件事散在三处 —— 角色快照的时间在正文最上面
 * 一行（`#adviceSnapshotFreshness`）、战斗记录的时间在①那一节里（`#recordFreshness`）、
 * 黑塔网数据的生成时间在标题栏右侧（`#adviceDataUpdated`）。同一个问题（「我手上这份
 * 数据是什么时候的」）要在三个地方各看一次，写法还不一样。现在三格并排、字段一致。
 *
 * 三格都在 `#adviceDataStatus` 里（那个块就在「抽卡推荐」标题正下方），每格只是一个
 * `.data-freshness`；这一份表决定「哪一格画什么、没数据时说什么」。
 */
const dataStatusCells = () => [
  {
    container: el.snapshotFreshness,
    label: '角色快照',
    // 快照跟着「当前账号/角色」走：没登录、或还没抓过时要说清去哪儿抓。
    freshness: state.snapshot
      ? normalizeFreshness(state.snapshot, state.snapshotResponse || {}, '角色快照')
      : null,
    empty: '还没有读到角色快照。',
    hint: '回「角色信息」页扫码登录并读取战绩，这里就会记下它的抓取时间。',
  },
  {
    container: el.recordFreshness,
    label: '战斗记录',
    freshness: state.recordsFreshness,
    empty: state.recordsLoading ? '正在读取…' : '还没有读到战斗记录。',
    hint: '点①那一节的「刷新米游社战绩」可以抓一份最新的。',
  },
  {
    container: el.datasetFreshness,
    label: '黑塔网数据',
    freshness: datasetFreshness(),
    empty: '还没有读到黑塔网数据集。',
    hint: '点右上「重读本地数据」读本机那份，或「同步黑塔网数据」联网增量更新。',
  },
];

/**
 * 画一格。**空态也走这里** —— 内容整块重画，否则换角色 / 退出登录之后
 * 上一份数据的时间会留在界面上（那正是这次要治的「三处各写各的」的后果）。
 */
const renderDataStatusCell = ({ container, label, freshness, empty, hint }) => {
  if (!container) return;
  container.innerHTML = '';
  if (!freshness) {
    container.className = 'data-freshness is-empty';
    const lead = text('div', 'freshness-lead', `${label}：`);
    lead.appendChild(text('span', 'freshness-status', '还没有数据'));
    container.appendChild(lead);
    if (empty) container.appendChild(text('div', 'freshness-details', empty));
    if (hint) container.appendChild(text('div', 'freshness-hint', hint));
    return;
  }
  const statusClass = freshness.expired
    ? 'expired'
    : freshness.partial
      ? 'partial'
      : freshness.cached
        ? 'cached'
        : freshness.status === 'unknown' ? 'unknown' : 'fresh';
  container.className = `data-freshness is-${statusClass}`;
  const lead = text('div', 'freshness-lead', `${label}：`);
  lead.appendChild(text('span', 'freshness-status', freshnessStatusText(freshness)));
  if (freshness.cacheAgeMs != null) lead.appendChild(document.createTextNode(` · 已存在 ${freshnessAgeText(freshness.cacheAgeMs)}`));
  container.appendChild(lead);
  const details = [];
  // 时间标签逐格不同：快照 / 战斗记录是「最后抓取」，黑塔网数据是「生成于」
  // （它是聚合产物的时刻，不是从哪儿抓来的），见 `datasetFreshness()`。
  const timeLabel = freshness.timeLabel || '最后抓取';
  if (freshness.fetchedAt) {
    details.push(`${timeLabel}：${freshness.fetchedAt.toLocaleString('zh-CN', { hour12: false })}`);
  } else {
    details.push(`${timeLabel}：服务端未返回时间`);
  }
  if (freshness.cacheAgeMs != null) details.push(`${freshnessAgeText(freshness.cacheAgeMs)}前`);
  // 「有效至 / 已于…过期」这行只在**真的过了新鲜窗口**时才留。
  // 它是「自动重抓」时代的产物：那时数据会自己变新，所以要告诉用户还剩多久。
  // 改成读本地之后数据只在手动刷新时变新，「有效至」没有任何可操作含义，
  // 只会让新鲜数据也挂着一句关于过期的说明 —— 用户 2026-10「不超过 7 天不用提示过期」。
  if (freshness.expired) {
    details.push(freshness.expiresAt
      ? `已于 ${freshness.expiresAt.toLocaleString('zh-CN', { hour12: false })} 过期`
      : '服务端未声明过期时间');
  }
  container.appendChild(text('div', 'freshness-details', details.join(' · ')));
  const reasons = [];
  if (freshness.staleReason) reasons.push(freshness.staleReason);
  for (const entry of (freshness.errors || []).slice(0, 5)) reasons.push(entry.section ? `${entry.section}：${entry.message}` : entry.message);
  if (reasons.length) container.appendChild(text('div', 'freshness-reason', `原因：${reasons.join('；')}`));
  // ⚠️ 「分区：index·新鲜 basicInfo·新鲜 …」那一行**已按用户要求整行去掉**
  // （2026-10：「不要写分区是否新鲜」）。它一次列出七八个分区、各带一个状态词，
  // 但这个信息用户用不上：数据是整份一起抓的，某个分区「不新鲜」不会让他多做什么 ——
  // 想更新只有一个动作，就是点「刷新米游社战绩」。
  // `sections` 仍然在 `normalizeFreshness` 里算，因为它还参与 `partial` 判定
  // （有分区抓失败时那条提示是有用的，见上面的 `freshness-reason`）。
  if (freshness.contractGaps?.length) {
    container.appendChild(text('div', 'freshness-contract-gap', `接口未提供：${freshness.contractGaps.join('、')}。当前按整体状态兼容解析。`));
  }
};

/**
 * 重画三格。幂等 —— 所以 `render()` 与 `renderRecord()` 都可以放心调（战斗记录是
 * 异步到货的，它到货时要把自己那一格的时间刷出来，而快照 / 数据集那两格顺手重画
 * 一次没有任何副作用）。
 */
const renderDataStatus = () => {
  for (const cell of dataStatusCells()) renderDataStatusCell(cell);
};

/** 「3 分钟前」这类相对时刻的写法删掉了（用户 2026-10-11 整合数据状态那一轮）：
 *  三份数据的时间统一画在「数据状态」三格里，用的是 `freshnessAgeText()` 的
 *  「已存在 1 天 / 最后抓取 2026/10/10 00:32:52 · 1 天前」这一套，
 *  原来的 `agoText()`（「1 天前」单说）就没有读者了。别再把它加回来。 */

/**
 * 服务端限流后，按它给的剩余秒数把「刷新米游社战绩」按钮禁用掉。
 *
 * 用户 2026-10：「过多的请求会导致数据爬取出错」。服务端已经挡了（回 200 +
 * `throttled`），这里是第二道 —— 连点的动作在按钮上就发生不了，比点完才报错更早。
 * `seconds <= 0` 表示没被限流，立刻恢复可用。
 */
const armThrottle = (seconds) => {
  clearTimeout(state.throttleTimer);
  state.recordsThrottled = Math.max(0, Number(seconds) || 0);
  if (state.recordsThrottled <= 0) return;
  state.throttleTimer = setTimeout(() => {
    state.recordsThrottled = 0;
    renderRecord();
  }, state.recordsThrottled * 1000);
};

/**
 * 读第一节的数据。
 *
 * GET 读本机已保存的数据（**不会**自动联网 —— 用户 2026-10 明确要求，
 * 打开页面/切分页不该触发任何米游社请求）；只有本地一份都没有时服务端才会抓一次。
 * `refresh` 时 POST 强制重抓（要 CSRF，且受服务端最小间隔限流）。
 */
const loadRecords = async ({ refresh = false } = {}) => {
  const role = state.onNeedRole ? state.onNeedRole() : null;
  if (!role?.accountId || !role?.uid) {
    state.records = null;
    state.recordsFreshness = null;
    state.recordsError = '还没登录。先在「角色信息」页扫码登录并读取一次战绩。';
    renderRecord();
    return;
  }
  if (state.recordsLoading) return;
  // 限流倒计时里直接不发请求：连点是最常见的触发风控的动作。
  if (refresh && state.recordsThrottled > 0) {
    state.recordsError = `刚刚已请求过米游社，请 ${state.recordsThrottled} 秒后再点刷新。`;
    renderRecord();
    return;
  }
  state.recordsLoading = true;
  renderRecord();
  try {
    const url = `/api/accounts/${role.accountId}/roles/${role.uid}/records${refresh ? '?refresh=1' : ''}`;
    const res = await fetch(url, {
      method: refresh ? 'POST' : 'GET',
      headers: accessHeaders(refresh
        ? { 'Content-Type': 'application/json', 'x-hsr-csrf': role.csrfToken || '' }
        : {}),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      const message = res.status === 401
        ? (readAccessToken()
          ? '访问令牌无效。请检查地址中的 #token=… 后重新加载。'
          : '此服务需要访问令牌，请使用 #token=你的令牌 追加到地址后重新加载。')
        : (data?.error || `HTTP ${res.status}`);
      throw new Error(message);
    }
    if (data.challengeRequired) {
      state.records = data.records || state.records;
      state.recordsFreshness = normalizeFreshness(state.records, data, '战斗记录');
      state.recordsError = '米游社要求先过一次验证码（1034）。到「角色信息」页点一次刷新数据、完成验证，再回来刷新。';
    } else if (data.virtual) {
      // 虚拟账号（用户 2026-10-12）：没有 cookie、也不该去请求米游社，战绩这一节天然为空。
      // 明说一句，别让读者以为「读取失败了」。
      state.records = data.records || null;
      state.recordsUid = role.uid;
      state.recordsFreshness = normalizeFreshness(state.records, data, '战斗记录');
      state.recordsError = '';
      state.recordsVirtual = true;
    } else {
      state.records = data.records || null;
      state.recordsUid = role.uid;
      state.recordsVirtual = false;
      state.recordsFreshness = normalizeFreshness(state.records, data, '战斗记录');
      state.recordsError = data.degraded
        ? `这次读取被米游社拒绝（${data.error || data.retcode}），显示的是上一次的记录。`
        : data.throttled
          // 服务端限流：连点「刷新米游社战绩」时挡下来了。说清楚是请求太密，
          // 不是数据坏了，并给出还要等多久（用户 2026-10：请求过多会导致数据爬取出错）。
          ? `${data.message || '刚刚才请求过米游社。'}请 ${Math.ceil((data.retryAfterMs || 0) / 1000)} 秒后再点刷新。`
          : '';
      // ⚠️ 这里以前还记 `state.recordsRefetch`（'cached' / '' ）给「这一节读的是
      // 上次抓取后保存在本机的数据…」那句话用。2026-10-11 整合数据状态那一块时
      // 那句话并进了顶部「数据状态」的标题行，读者就没了 —— 所以这几个字段
      // （`recordsRefetch` / `recordsMeta`）连同赋值一起删掉，别当死代码留着。
      // 被限流时按服务端给的剩余秒数禁用刷新按钮，倒计时结束后自动恢复。
      // 连点是触发风控最常见的动作（用户 2026-10），按钮层面先拦一道。
      armThrottle(data.throttled ? Math.ceil((data.retryAfterMs || 0) / 1000) : 0);
    }
  } catch (err) {
    state.recordsError = `读取战斗记录失败：${err.message}`;
  } finally {
    state.recordsLoading = false;
  }
  renderRecord();
};

/**
 * 战斗记录里点角色名 → 在**本页**弹出面板。
 *
 * 面板要用角色快照里的那个对象（属性 / 光锥 / 遗器都在里面），所以这里按 id、再按
 * 中文名、最后按「•」前的基础名去找——记录里只有数字 id，开拓者的各形态与皮肤
 * 写法要靠后两级兜底。
 */
const resolveCharacter = (member) => {
  const characters = state.snapshot?.characters || state.snapshot?.avatars || [];
  if (!characters.length || !member) return null;
  const keyOf = (c) => String(c.id ?? c.avatar_id ?? c.avatarId ?? '');
  const nameOf = (c) => c.name || '';
  const base = (value) => String(value || '').split(/[•·]/)[0].trim();
  return characters.find((c) => keyOf(c) && keyOf(c) === String(member.id))
    || characters.find((c) => nameOf(c) && nameOf(c) === member.nameCn)
    || characters.find((c) => nameOf(c) && base(nameOf(c)) === base(member.nameCn))
    || null;
};

const renderRecord = () => {
  if (!el.record) return;
  const records = state.records;
  renderRecordSection(el.record, records, {
    snapshot: state.snapshot,
    freshness: state.recordsFreshness,
    // 队伍里的角色可点：在本页弹出它的面板（内容与角色信息页同一份实现）
    onOpenCharacter: state.onOpenCharacter,
    onResolveCharacter: resolveCharacter,
  });

  // 战斗记录那一格的「本机缓存 · 米游社数据 · 已存在 1 天 / 最后抓取 …」现在画在**顶部那块
  // 「数据状态」里**（用户 2026-10-11：三份缓存的记录收在一起）。这里调它一次是因为
  // 记录是异步到货的 —— 到货时要把那一格的时间刷出来。`renderDataStatus()` 幂等，
  // 顺手重画快照 / 数据集那两格没有任何副作用。
  renderDataStatus();

  // ⚠️ 这里**不再**写「读取于 1 天前（绝对时刻）」：它与上面那一格是同一件事，
  // 留着就是同一份时间在页面上出现两次（本次整合要治的就是这个）。
  // `#recordMeta` 现在只承载**瞬态 / 异常**信息：正在读取、部分端点失败。
  const meta = [];
  if (state.recordsLoading) meta.push('正在读取…');
  if (state.recordsVirtual) meta.push('虚拟账号：角色数据由本机构造，没有米游社战绩');
  if (state.recordsFreshness?.partial) {
    meta.push(`部分端点失败：${(state.recordsFreshness.errors || []).map((e) => e.endpoint || e.section).filter(Boolean).join('、') || '详见上方数据状态'}`);
  }
  if (el.recordMeta) {
    el.recordMeta.textContent = meta.join(' ');
    // 空的时候整个收起来：`.record-head-actions` 是 flex + gap，留着空 span 会多出一段间距。
    el.recordMeta.hidden = meta.length === 0;
  }
  if (el.recordNote) {
    const parts = [
      '米游社官方战绩接口的原始记录：四个高难副本各自一个按钮，只列最后一关（混沌回忆第 12 层 / 虚构叙事其四 / 末日幻影难度04 / 异相仲裁本赛程）的每一间——敌方、四人队伍（带头像与星魂）、通关时刻、该关回合数（末日幻影是每间积分）与祝福。',
      '敌方名字有两个来源：末日幻影与异相仲裁是米游社官方给的（带图标）；混沌回忆与虚构叙事米游社不给敌方字段，用的是黑塔网投稿里登记的首领名——那是玩家填的社区叫法，可能与游戏内称号不同（鼠标悬停有说明）。',
      '米游社不提供逐回合的战斗过程，这一节不会假装有。点角色名可在本页直接看它的面板（属性 / 光锥 / 遗器）。',
    ];
    if (state.recordsError) parts.unshift(`⚠ ${state.recordsError}`);
    if (state.recordsFreshness?.expired) parts.push(`这份数据可能过期：${state.recordsFreshness.staleReason || '当前展示的是较早缓存'}`);
    // 「这一节读的是上次抓取后保存在本机的数据：打开页面、切换分页都不会重新请求
    // 米游社…」那句**已删**（用户 2026-10-11 的整合）：同一句话现在写在上方
    // 「数据状态」的标题行里（对三份数据一起生效），留在这里就是第二次说同一件事。
    // 「打开页面不联网」这条规矩本身没变（§4.4 / v4.6.52），只是不再重复三遍。
    el.recordNote.textContent = parts.join(' ');
  }
  if (el.recordRefresh) {
    el.recordRefresh.disabled = state.recordsLoading || state.recordsThrottled > 0;
    el.recordRefresh.textContent = state.recordsLoading
      ? '读取中…'
      : state.recordsThrottled > 0
        ? `请稍候 ${state.recordsThrottled}s…`
        : '刷新米游社战绩';
    // 限流窗口内直接禁用按钮：点了也只会拿到 429（用户 2026-10：过多的请求会
    // 导致数据爬取出错）。禁用比「点了才报错」更早一步拦住连点。
    el.recordRefresh.title = state.recordsThrottled
      ? `刚刚已请求过米游社，请 ${state.recordsThrottled} 秒后再点`
      : '强制重新抓取米游社战绩（会消耗一次请求，短时间内重复点会被限流）';
  }
};

// ------------------------------------------------------- 跨模式综合结论（渲染）

/**
 * 账号状态 → 请求体。只保留**数据集英文键**：中文键是给人看的，
 * 服务端认的是数据集里的名字，混着发过去只会让「你有这个角色」判错。
 */
/**
 * 发给服务端的账号持有情况（`/api/archive/conclusion` 的 `account`）。
 *
 * ⚠️ **不做 refs 过滤了**（2026-10-11 第 10 轮修）：以前这里用
 * `state.index.refs.characters` / `refs.lightCones` 把「数据集里没见过的键」滤掉，
 * 而 `refs` 只登记**进过压金前沿**的单位（实测角色 93 / 光锥 141），于是同一个账号
 * 在界面上是「已有」、在服务端却是「没有」—— 实测同一份快照过滤前 56 把光锥、
 * 过滤后只剩 28 把，十几把已有的光锥被算成「未见→S1」，补金差额被系统性高估。
 *
 * 现在原样发出（`marginalCostOf` 自己会按成本口径判断，未知键也只会被忽略），
 * 服务端与界面的「已拥有」集合因此**完全同源**。
 */
const accountPayload = () => ({
  owned: [...state.owned],
  eidolons: Object.fromEntries(state.eidolons),
  cones: Object.fromEntries(state.coneRanks),
});

/** 某个口径权重覆盖的签名（进 `conclusionKey`，用于判断要不要重算）。 */
const weightSignature = (scope) => Object.entries(state.weights?.[scope] || {}).sort()
  .map(([k, v]) => `${k}=${v}`).join(',');

/**
 * 结论只在「持有情况、**任一口径的副本权重**、**隐金设置**或数据集变了」时才需要重算：
 * 服务端要聚合 5 个副本的完整阵容表，没必要每次切下拉框都跑一遍。
 *
 * 权重与隐金都必须进这个键：它们各自改变一块排序，漏掉任何一个，用户调完之后都会
 * 因为「键没变」而拿不到新结果（而且还会把在途的旧结果当最新一次收下）。
 * ⚠️ 只放**总榜那一套**（用户 2026-10-11 第 10 轮起界面上只剩这一套，请求也只发它）：
 * 把 `.plan` 那份也塞进来会让「改一个已经没人用的存档」白白触发一次重算。
 */
const conclusionKey = () => {
  const p = accountPayload();
  return [
    state.index?.generatedAt || '',
    p.owned.slice().sort().join(','),
    Object.entries(p.eidolons).sort().map(([k, v]) => `${k}:${v}`).join(','),
    Object.entries(p.cones).sort().map(([k, v]) => `${k}:${v}`).join(','),
    weightSignature(WEIGHT_SCOPE),
    `hidden[${hiddenCostsSignature()}]`,
    // 抽卡权重（用户 2026-10-13 第 2 条起它进服务端请求，所以必须进这个键）。
    `draw[${drawWeightsSignature()}]`,
    // 版本权重（用户 2026-10-16 第 3 条）：它决定每个副本的 `seasonWeights`，而那是
    // 服务端现算、客户端做跨版本加权的输入 —— 漏进这个键就是「改了旋钮、界面静默显示
    // 旧结果」（v4.6.93 那类 bug）。
    `ver[${versionWeightsSignature()}]`,
  ].join('|');
};

// ------------------------------------ 权重三大类（关卡 / 抽卡 / 版本，三组各占一行）

/**
 * **关卡权重**那一类的标题、网格与说明节点（`scope` 恒为 `frontier`，见 WEIGHT_SCOPE）。
 *
 * 2026-10-12 第 2 条起它叫「关卡权重」（原来叫「总榜权重」）：它不再只影响角色总榜 ——
 * 抽卡方案的「强度得分」也走同一条 `frontier` 口径的链。
 */
const WEIGHT_UI = {
  label: '关卡权重',
  grid: () => el.frontierWeightRow,
  meta: () => el.frontierWeightsMeta,
};

/** 当前某个口径生效的权重覆盖表：`{ 'aa|plight': 10, ... }`；空对象 = 用默认值。 */
const activeWeights = (scope) => ({ ...(state.weights[scope] || {}) });

/** 权重写法：整数不补小数，其余最多三位（默认口径里有 1.875 这种数）。 */
const formatWeight = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
};

/** 读某个口径的五个输入框 → `state.weights[scope]`（空串按 0，非法值不写）。 */
const readWeights = (grid) => {
  const out = {};
  if (!grid) return out;
  for (const input of grid.querySelectorAll('input.advice-weight')) {
    const key = `${input.dataset.mode}|${input.dataset.stage || ''}`;
    const n = weightInputOf(input.value);
    if (n !== null) out[key] = n;
  }
  return out;
};

/** 从 localStorage 恢复权重（界面上只剩 `frontier` 一套，见 WEIGHT_SCOPE 的注释）。 */
const loadWeights = () => {
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_WEIGHTS_KEY) || 'null'); } catch { legacy = null; }
  const out = { plan: {}, frontier: {} };
  for (const scope of WEIGHT_SCOPES) {
    let parsed = null;
    try { parsed = JSON.parse(localStorage.getItem(WEIGHTS_KEY[scope]) || 'null'); } catch { parsed = null; }
    const value = parsed && typeof parsed === 'object' ? parsed : legacy;
    out[scope] = value && typeof value === 'object' ? value : {};
  }
  return out;
};

const saveWeights = () => {
  for (const scope of WEIGHT_SCOPES) {
    try {
      localStorage.setItem(WEIGHTS_KEY[scope], JSON.stringify(state.weights[scope] || {}));
    } catch {
      // 隐私模式 / 配额满：记不住就记不住，不影响本次会话
    }
  }
};

/**
 * 「当前口径」一行：只列**被改过**的副本（没改过就说「用默认口径」）。
 *
 * 为什么不再把五档全列一遍：输入框里已经是那五个数，再抄一遍等于把一行字写两遍，
 * 而且改过一个副本之后，真正需要看见的是「改了哪个、原值是多少」。
 */
const renderWeightsMeta = (scope) => {
  const meta = WEIGHT_UI.meta();
  if (!meta) return;
  const defaults = envWeightDefaults();
  const current = state.weights[scope] || {};
  const changed = ENV_WEIGHT_ROWS.filter((row) => {
    const key = `${row.mode}|${row.stage}`;
    const value = current[key];
    if (value === undefined) return false;
    return Number(value) !== Number(defaults[key] ?? 1);
  });
  meta.textContent = changed.length
    ? `已改：${changed.map((row) => {
      const key = `${row.mode}|${row.stage}`;
      return `${row.label} ×${formatWeight(defaults[key] ?? 1)} → ×${formatWeight(current[key])}`;
    }).join(' · ')}`
    : '未改动（用默认口径）';
};

/** 画某个口径的五个权重输入框（值 = 用户存档优先，否则默认口径）。 */
const renderWeightRow = (scope) => {
  const grid = WEIGHT_UI.grid();
  if (!grid) return;
  const defaults = envWeightDefaults();
  const current = state.weights[scope] || {};
  grid.innerHTML = '';
  for (const row of ENV_WEIGHT_ROWS) {
    const key = `${row.mode}|${row.stage}`;
    const label = document.createElement('label');
    label.className = 'field field-inline advice-weight-field';
    label.appendChild(text('span', '', row.label));
    const input = document.createElement('input');
    input.className = 'advice-weight';
    input.type = 'number';
    input.min = '0';
    input.max = '99';
    input.step = '0.25';
    input.inputMode = 'decimal';
    input.dataset.mode = row.mode;
    input.dataset.stage = row.stage;
    input.dataset.scope = scope;
    input.value = String(current[key] ?? defaults[key] ?? 1);
    // 说明已在权重区块的提示文字中展示，避免原生 title 在输入框悬浮时遮挡邻近内容。
    input.setAttribute('aria-label', `${row.label}（${WEIGHT_UI.label}）`);
    label.appendChild(input);
    grid.appendChild(label);
  }
  renderWeightsMeta(scope);
};

/**
 * 画权重输入框（初始与「恢复默认」之后各调一次）。
 *
 * ⚠️ 2026-10-11 起**副本权重只有一套**（用户第 10 轮「去掉方案权重那一行」）：角色总榜
 * 与抽卡方案的强度侧都吃这一套。参数 `scope` 保留是为了不改调用点，值恒为 `'frontier'`。
 * 抽卡权重是**另一类**（`renderDrawWeightRow`），它与副本权重一起被「恢复默认」清掉；
 * 版本权重是**第三类**（`renderVersionWeightRow`，用户 2026-10-16 第 3 条），同进同出。
 */
const renderWeightRows = (scope = 'frontier') => {
  renderWeightRow(scope);
  renderDrawWeightRow();
  renderVersionWeightRow();
};

// ------------------------------------------------- 抽卡权重（强度 / 性价比）

/**
 * 抽卡权重的**比例写法**：归一化之后印成 `0.5` / `0.75` 这种系数（界面那句
 * 「= 队伍强度 … × ws + 队伍性价比 … × wc + 队伍泛用性 … × wv」要把它直接写出来；
 * 角色总榜那边同一句写的是「角色强度 / 角色性价比 / 角色泛用性」—— 2026-10-17 改名）。
 *
 * ⚠️ 归一化**只**由 `advice.js` 的 `normalizeDrawWeights()` 负责 —— 这里只是显示。
 */
const formatShare = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
};

/** 读抽卡权重的两个输入框 → `state.drawWeights`（原值，不在这里归一化）。 */
const readDrawWeights = (grid) => {
  const out = { ...drawWeightDefaults() };
  if (!grid) return out;
  for (const input of grid.querySelectorAll('input.advice-draw-weight')) {
    const key = input.dataset.key;
    if (!key) continue;
    // 空串 = 用户清空了输入框 → 0（与副本权重同一条约定，见 weightInputOf）。
    const n = weightInputOf(input.value);
    if (n !== null) out[key] = n;
  }
  return out;
};

/** 从 localStorage 恢复抽卡权重（没有存档就用默认值 1:1 = 旧的等权）。 */
const loadDrawWeights = () => {
  let parsed = null;
  try { parsed = JSON.parse(localStorage.getItem(DRAW_WEIGHTS_KEY) || 'null'); } catch { parsed = null; }
  const stored = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  const defaults = drawWeightDefaults();
  const out = { ...defaults };
  for (const row of DRAW_WEIGHT_ROWS) {
    const value = stored?.[row.key];
    // ⚠️ 只认**有限非负数**：非法值忽略（保留默认），与 `normalizeDrawWeights` 同一判据。
    if (value === undefined || value === null) continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) out[row.key] = n;
  }
  return out;
};

const saveDrawWeights = () => {
  try {
    localStorage.setItem(DRAW_WEIGHTS_KEY, JSON.stringify(state.drawWeights || {}));
  } catch {
    // 隐私模式 / 配额满：记不住就记不住，不影响本次会话（与 saveWeights 同一条理由）。
  }
};

/**
 * 抽卡权重旁边那行状态：印**归一化后的比例**（用户只有相对大小可调，所以真正生效的是
 * 百分比，光看输入框里的原值看不出「谁占多少」）。
 *
 * ⚠️ 2026-10-13 第 1 条加了第三个旋钮（泛用性）之后，这里按 `DRAW_WEIGHT_ROWS`
 * **逐个印**（不再手抄 strength/cost 两个键）—— 加旋钮时这里不会再漏一个。
 *
 * ⚠️ 三个百分比说的是**两个榜共用**的口径（用户 2026-10-13 第 3 条之后口径统一了）：
 * 角色总榜的角色得分与抽卡方案的补金推荐分都按这三个系数加权，所以末尾那句写的是
 * 「都按这三个系数加权」。
 *
 * 历史（别再改回去）：v4.6.95/96 时抽卡方案只吃强度/性价比两项（它内部再两两归一），
 * 那时这里印的是「；抽卡方案只用强度/性价比。」—— 用户第 3 条把泛用性也接进补金推荐分
 * 之后那句话就是**错的**（它会让用户以为调泛用性不动方案名次）。
 */
const renderDrawWeightsMeta = () => {
  const meta = el.drawWeightsMeta;
  if (!meta) return;
  const draw = normalizeDrawWeights(state.drawWeights || {});
  const defaults = normalizeDrawWeights(drawWeightDefaults());
  const changed = DRAW_WEIGHT_ROWS.some((row) => Math.abs(draw[row.key] - defaults[row.key]) > 1e-9);
  const parts = DRAW_WEIGHT_ROWS
    .map((row) => `${row.label} ${(draw[row.key] * 100).toFixed(0)}%`)
    .join(' · ');
  meta.textContent = `角色总榜：${parts}`
    // ⚠️ 不改口径、只改文案（v4.6.114 起）：默认值改过两次（`1:1:1` → `1:1:0.5` →
    //    2026-10-18 的 `4:5:1`），所以这里**不写死任何比例**，只印归一化后的百分比 +
    //    「（默认）」—— 写「默认三等分」那种词等于在界面上说假话。
    + (changed ? '' : '（默认）')
    // ⚠️ 三个系数**两个榜都吃**（用户 2026-10-13 第 3 条「泛用性权重也适用于补金推荐」）：
    //    角色总榜的角色得分、抽卡方案的补金推荐分，用的是同一个 `normalizeDrawWeights`。
    + '；角色得分与补金推荐分都按这三个系数加权。';
};

/**
 * 画抽卡权重的**三个**输入框（用户 2026-10-12 第 2 条 + 2026-10-13 第 1 条：
 * 权重分三类，这是第二类）。
 *
 * 旋钮清单来自 `advice.js` 的 `DRAW_WEIGHT_ROWS`（**只有那一份**），所以再加旋钮
 * 依然只改那一张表。输入框的值是**用户敲的原值**，比例由 `renderDrawWeightsMeta()` 印。
 */
const renderDrawWeightRow = () => {
  const grid = el.drawWeightRow;
  if (!grid) return;
  const defaults = drawWeightDefaults();
  const current = state.drawWeights || {};
  grid.innerHTML = '';
  for (const row of DRAW_WEIGHT_ROWS) {
    const label = document.createElement('label');
    label.className = 'field field-inline advice-weight-field';
    label.appendChild(text('span', '', row.label));
    const input = document.createElement('input');
    input.className = 'advice-draw-weight';
    input.type = 'number';
    input.min = '0';
    input.max = '99';
    input.step = '0.25';
    input.inputMode = 'decimal';
    input.dataset.key = row.key;
    input.value = String(current[row.key] ?? defaults[row.key] ?? 1);
    input.setAttribute('aria-label', `${row.label}（抽卡权重）`);
    label.appendChild(input);
    grid.appendChild(label);
  }
  renderDrawWeightsMeta();
};

// ------------------------------------- 版本权重（当前版本 / 前1个版本 … 前N个版本，可增删档位）

/**
 * 读版本权重的**当前档位**输入框 → 数组（原值，不归一化）。
 *
 * ⚠️ 档位数是**动态的**（用户 2026-10-17 起能点「加一版 / 删一版」）：数组长度 = 网格里
 * 输入框的个数，每个输入框的 `dataset.key` 就是它的下标。所以这里**不再**按
 * `VERSION_WEIGHT_ROWS`（那份恒 6 档）去对 —— 拿 6 档去读 8 个框会把多出来的两档丢掉。
 *
 * ⚠️ 边界规则与 `weightInputOf` / `versionWeightValues` **同一套**：空串 = 0
 * （用户把某一版清空 = 那一版不进窗口）、非法值忽略并保留默认。默认值直接取
 * `advice.js` 的 `versionWeightDefaults(档位数)`（与另外两组同一个形状），界面**不抄第二份表**。
 *
 * 返回数组而不是对象：`state.versionWeights` 与请求体、服务端的
 * `normalizeVersionWeights()` 都是数组形状（下标即槽位）。
 */
const readVersionWeights = (grid) => {
  if (!grid) return versionWeightDefaults();
  const inputs = [...grid.querySelectorAll('input.advice-version-weight')];
  const out = versionWeightDefaults(Math.max(1, inputs.length));
  for (const input of inputs) {
    const index = Number(input.dataset.key);
    if (!Number.isInteger(index) || index < 0 || index >= out.length) continue;
    // 空串 = 用户清空了输入框 → 0（与 `weightInputOf` 同一条约定）。
    const n = weightInputOf(input.value);
    if (n !== null) out[index] = n;
  }
  return out;
};

/**
 * 从 localStorage 恢复版本权重（没有存档 / 字段不合法 → 默认表）。
 *
 * ⚠️ 存档形状是数组，但**老存档可能是别的形状**（对象 `{'0':3}`、只有 3 个槽位的短
 * 数组、甚至一个数字）—— 一律交给 `versionWeightValues()` 判：它两种形状都收、缺的按
 * 默认补、非法的忽略，**档位数跟着存档长度走**（用户 2026-10-17 起档位可增删，短数组
 * 就是「他自己删到 3 档」）。所以这里不做任何自己的校验，避免与算分那一份分叉。
 */
const loadVersionWeights = () => {
  let parsed = null;
  try { parsed = JSON.parse(localStorage.getItem(VERSION_WEIGHTS_KEY) || 'null'); } catch { parsed = null; }
  if (parsed === null || parsed === undefined) return versionWeightDefaults();
  return versionWeightValues(parsed);
};

const saveVersionWeights = () => {
  try {
    localStorage.setItem(VERSION_WEIGHTS_KEY, JSON.stringify(state.versionWeights || []));
  } catch {
    // 隐私模式 / 配额满：记不住就记不住，不影响本次会话（与 saveWeights 同一条理由）。
  }
};

/**
 * 版本权重那行状态：印**实际生效的值**（用户只有相对大小可调，所以光看输入框里的原值
 * 看不出「谁占多少」——这里印的是过了 `normalizeVersionWeights()` 之后的生效值）。
 *
 * ⚠️ 与另外两组不同，这里不印百分比而印 `当前版本 3 : 前1个版本 2.5 : …` 这种**比值串**
 * —— 因为它**不做归一到 1**（`normalizeVersionWeights` 明确不做），百分比会误导用户
 * 以为总和是 100。标签逐槽位印（来自 `versionWeightRows(档位数)`，不抄第二份），
 * 这样「哪一版是 0」一眼可见。
 *
 * ⚠️ 档位数要**印出来**（用户 2026-10-17 加了加删档位的按钮）：只看比值串数不出「现在是
 * 6 版还是 8 版」，而窗口长度直接决定哪些版本参与加权。
 *
 * ⚠️ 措辞必须点明「**每个副本算各自的**」：`4.5` 在混沌与异相仲裁里不是同一期，
 * 所以「当前版本」是逐副本的（槽位按下标、不绑定版本号）。
 */
const renderVersionWeightsMeta = () => {
  const meta = el.versionWeightsMeta;
  if (!meta) return;
  const value = normalizeVersionWeights(state.versionWeights || []);
  const defaults = versionWeightDefaults(value.length);
  const changed = value.some((v, i) => Math.abs(v - (defaults[i] ?? 0)) > 1e-9);
  // 逐个槽位印「标签 原值」（与另外两组同一个形状：**印生效的那个数**，不让用户拿输入框
  // 里的原值自己脑补）。旋钮清单来自 `versionWeightRows(档位数)`，所以标签也**不抄第二份**。
  const parts = versionWeightRows(value.length)
    .map((row) => `${row.label} ${formatWeight(value[row.index])}`)
    .join(' : ');
  meta.textContent = `每个副本各自算（${value.length} 版）：${parts}`
    + (changed ? '' : '（默认）')
    + '；某版设 0 = 那一版不进窗口。改它会重算总榜。';
};

/**
 * 加删档位按钮的状态：`N 版` 标签 + 两个按钮的 `disabled` / `title`。
 *
 * ⚠️ 上限用 `VERSION_WEIGHT_MAX`（advice.js 唯一那份，12）：再多本地数据集里也没有对应
 * 的版本，给权重也拿不到成绩；下限 1：整条链至少要有一档。
 */
const renderVersionWeightButtons = (count) => {
  const add = el.versionWeightAdd;
  const remove = el.versionWeightRemove;
  if (add) {
    add.disabled = count >= VERSION_WEIGHT_MAX;
    add.title = count >= VERSION_WEIGHT_MAX
      ? `最多 ${VERSION_WEIGHT_MAX} 版`
      : '窗口里再加一版（默认权重沿用最后一档 0.5）';
  }
  if (remove) {
    remove.disabled = count <= 1;
    remove.title = count <= 1 ? '至少保留一版' : '删掉最后一版（最旧的那一档）';
  }
  const label = el.versionWeightCount;
  if (label) label.textContent = `${count} 版`;
};

/**
 * 画版本权重的输入框（默认 6 个，用户 2026-10-17 起可增删到 1~12 个）。
 *
 * 旋钮清单来自 `advice.js` 的 `versionWeightRows(档位数)`（**只有那一份**）—— 它同时被
 * 服务端 `archive.js` 读，所以标签与槽位在这里绝不会与生效的那张表分叉。输入框的值是
 * 用户敲的原值（不做归一），比例由 `renderVersionWeightsMeta()` 印。
 */
const renderVersionWeightRow = () => {
  const grid = el.versionWeightRow;
  if (!grid) return;
  // ⚠️ 用 `versionWeightValues()`（原值、保留 0）而不是 `normalizeVersionWeights()`：
  //    后者在「全 0」时会退回默认表，那会把用户刚清空的框又填回去。
  const current = versionWeightValues(state.versionWeights || []);
  const count = current.length;
  const defaults = versionWeightDefaults(count);
  grid.innerHTML = '';
  for (const row of versionWeightRows(count)) {
    const label = document.createElement('label');
    label.className = 'field field-inline advice-weight-field';
    label.appendChild(text('span', '', row.label));
    const input = document.createElement('input');
    input.className = 'advice-version-weight';
    input.type = 'number';
    input.min = '0';
    input.max = '99';
    input.step = '0.25';
    input.inputMode = 'decimal';
    input.dataset.key = row.key;
    input.value = String(current[row.index] ?? defaults[row.index] ?? 0);
    // ⚠️ 标题写清「**当前版本**往回数第 N 个」：槽位是按下标的，「当前版本」逐副本不同
    // （4.5 在混沌与异相仲裁里不是同一期），写死版本号第二天就会说假话。
    input.setAttribute('aria-label', `${row.label}（版本权重）`);
    input.title = `距**该副本**当前版本${row.index === 0 ? '' : `往回 ${row.index} 个版本`}`
      + '（每个副本各有一套版本号）';
    label.appendChild(input);
    grid.appendChild(label);
  }
  renderVersionWeightButtons(count);
  renderVersionWeightsMeta();
};

/**
 * 版本权重的签名（进 `conclusionKey`、角色面板的缓存键与请求）。
 *
 * ⚠️ 它**必须进 `conclusionKey`**：`normalizeVersionWeights` 虽然不做归一到 1，但它
 * 决定每个副本的 `seasonWeights`（服务端现算），而总榜/详情窗口的跨版本加权都吃它 ——
 * 漏进这个键就是「改了旋钮、界面静默显示旧结果」那类 bug（v4.6.93 踩过）。
 *
 * 用**生效后**的值（`normalizeVersionWeights`）签名：全 0 与默认表是同一份生效结果，
 * 不该触发两次重算。
 */
const versionWeightsSignature = () => normalizeVersionWeights(state.versionWeights || [])
  .map((v) => Number(v).toFixed(4)).join(',');

// ------------------------------------------------- 隐金设置（总榜权重下方那个按钮）
//
// 用户 2026-10-11 原话：「我现在需要在性价比总榜添加一个按钮，用于额外设置，将其放置于
// 总榜权重下方……点击后弹出详情界面，角色和光锥都需要有图标，详情页要美观可用，
// 界面信息不出界，以下复选框默认已点击」。
//
// 口径（哪些单位、减几金、怎么合并）**全部**在 `advice.js` 的
// `HIDDEN_COST_SETTINGS` + `hiddenReductionOf()` 里，界面只是把那张表画出来 ——
// 名单要抄第二份的话，改一处漏一处就是「界面上有这个人、算分时不认」。
// 本文件负责的四件事：读/存存档、画状态行、画详情窗口、改动后触发重算。

/**
 * 读隐金存档。**没有任何存档时 = 五项全勾**（用户要求的默认值）。
 *
 * ⚠️ 存档里**缺某个键**时也按默认值（勾上）补 —— 用户换个版本、多一组开关时，
 * 老存档不该让新开关莫名其妙地是关的；而显式存成 `false` 的必须尊重。
 */
const loadHiddenCosts = () => {
  let parsed = null;
  try { parsed = JSON.parse(localStorage.getItem(HIDDEN_COSTS_KEY) || 'null'); } catch { parsed = null; }
  const stored = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  const out = {};
  for (const id of HIDDEN_COST_IDS) {
    out[id] = stored && stored[id] !== undefined
      ? stored[id] === true
      : DEFAULT_HIDDEN_COSTS[id] === true;
  }
  return out;
};

const saveHiddenCosts = () => {
  try {
    localStorage.setItem(HIDDEN_COSTS_KEY, JSON.stringify(state.hiddenCosts || {}));
  } catch {
    // 隐私模式 / 配额满：记不住就记不住，不影响本次会话（与 `saveWeights` 同一条理由）。
  }
};

/** 隐金设置的签名（进缓存键 / 结论键）：`gift:1,giftCone:1,…`。 */
const hiddenCostsSignature = () => HIDDEN_COST_IDS
  .map((id) => `${id}:${state.hiddenCosts?.[id] === true ? 1 : 0}`).join(',');

/**
 * 抽卡权重的签名（进 `conclusionKey`、角色面板的缓存键与请求）。
 *
 * ⚠️ 用户 2026-10-13 第 2 条起它**必须进服务端请求**：角色得分 = 三个分项按它加权，
 * 而总榜「每角色只留一条」的收敛在服务端 —— 所以它和关卡权重、隐金设置一样是结论
 * 口径的输入。漏进 `conclusionKey` 会立刻复现 v4.6.93 那类「改了旋钮、界面静默显示
 * 旧结果」的 bug（键没变 → 在途的旧结果被当成最新一次收下）。
 *
 * 用**归一化后**的值签名：`3 : 1 : 1` 与 `0.6 : 0.2 : 0.2` 是同一个榜，
 * 不该触发两次重算（与 `normalizeDrawWeights` 的「只认相对大小」同一条约定）。
 */
const drawWeightsSignature = () => {
  const draw = normalizeDrawWeights(state.drawWeights || {});
  return DRAW_WEIGHT_ROWS.map((row) => `${row.key}=${Number(draw[row.key]).toFixed(4)}`).join(',');
};

/** 有没有任何一项是勾上的（决定请求里要不要带这个字段 —— 接口默认是一项都不减）。 */
const anyHiddenCostOn = () => HIDDEN_COST_IDS.some((id) => state.hiddenCosts?.[id] === true);

/** 详情窗口里那五组复选框中，当前被**关掉**的（状态行用）。 */
const hiddenCostRowsOff = () => HIDDEN_COST_SETTINGS
  .flatMap((group) => group.rows)
  .filter((row) => state.hiddenCosts?.[row.id] !== true);

/**
 * 按钮旁边那行状态（用户要能一眼看出「现在隐金是开着的」）。
 *
 * 为什么不留空：这个开关的效果是「名次变了」，而名次变化本身看不出原因 ——
 * 关掉几项之后如果没有任何提示，用户会以为功能坏了（本项目在权重那行踩过同样的坑，
 * 所以那行也是「只列被改过的」）。
 */
const renderHiddenCostsMeta = () => {
  const meta = el.hiddenCostsMeta;
  if (!meta) return;
  const rows = HIDDEN_COST_SETTINGS.flatMap((group) => group.rows);
  const off = hiddenCostRowsOff();
  meta.textContent = off.length === 0
    ? `已隐金 ${rows.length} 项（这些单位按 0 成本参与总榜）`
    : `已隐金 ${rows.length - off.length}/${rows.length} 项 · 关掉：`
      + off.map((row) => row.label.replace(/^隐藏/, '')).join('、');
};

/**
 * 详情窗口的正文：三组（加粗分组标题）→ 每组 1~2 个复选框 → 单位图标清单 → 效果说明。
 *
 * ⚠️ 「特殊情况」那一半**刻意不画**（用户 2026-10-11：「括号内的内容不显示在界面上」）：
 * Archer 单独 -2、自选组合计 -1 这些是口径，由 `hiddenReductionOf()` 实现，
 * 不摆在界面上。
 *
 * 图标走 `iconUrlOf()` 的**四级兜底**（原名 → 形态基础名 → 去标点归一化 → 归一化基础名），
 * 缺图时留一个同尺寸空位（`is-missing`）而不是摘节点：摘掉会让这一行的高度跟着图片加载
 * 结果跳（见 `iconImg()` 的注释）。
 */
const buildHiddenCostsBody = (body) => {
  body.appendChild(text('p', 'muted small advice-gold-intro',
    '勾上的单位按「不用抽就有」算：总榜会把它的成本去掉，队伍金数变小、名次上升。'
    + '改动立即生效并存到本机。'));

  for (const group of HIDDEN_COST_SETTINGS) {
    const box = text('div', 'advice-gold-group');
    // 分组标题加粗（用户指定：「直接受赠角色/累计抽卡赠送光锥 需加粗」等）。
    box.appendChild(text('div', 'advice-gold-group-title', group.group));
    for (const row of group.rows) {
      const item = text('div', 'advice-gold-row');

      const head = document.createElement('label');
      head.className = 'advice-gold-row-head';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'advice-gold-check';
      input.dataset.hiddenCost = row.id;
      input.checked = state.hiddenCosts?.[row.id] === true;
      input.addEventListener('change', () => setHiddenCost(row.id, input.checked));
      head.appendChild(input);
      head.appendChild(text('span', 'advice-gold-row-label', row.label));
      item.appendChild(head);

      const units = text('div', 'advice-gold-units');
      units.appendChild(text('span', 'advice-gold-units-lead',
        row.kind === 'char' ? '角色：' : '光锥：'));
      for (const name of row.units) {
        const label = row.kind === 'char' ? cn(name) : cnCone(name);
        // `is-cone` 只影响图标圆角（光锥用方角）：两种图标的原始尺寸不同
        // （角色 256×256、光锥 128×128），统一按 CSS 写死的 26px 显示。
        const chip = text('span', row.kind === 'cone' ? 'advice-gold-unit is-cone' : 'advice-gold-unit');
        // 英文键放在 `title` 里：中文映射偶尔会与游戏内的写法差一个标点
        // （实测「阮•梅」「托帕&账账」），排查「到底是哪个键」时用得上。
        chip.title = name;
        const img = iconImg(iconUrlOf(row.kind, name), 'advice-gold-icon', label, 'eager');
        chip.appendChild(img || text('span', 'advice-gold-icon is-missing'));
        chip.appendChild(text('span', 'advice-gold-unit-name', label));
        units.appendChild(chip);
      }
      item.appendChild(units);

      // 「效果：勾选后…」——用户给的是「效果：点击后以上角色减少 1 成本，最低 0 成本」，
      // 复选框写「勾选后」比「点击后」准确（点一下是切换，不总是生效）。
      item.appendChild(text('div', 'advice-gold-effect', `效果：勾选后${row.effect}`));
      // 备注（可选）：**规则性的例外**要告知用户，否则看不懂「为什么 Archer 被减了 2」
      // 或「为什么七个人凑一队也只减 1」。用户 2026-10-11 追加要求：「你要加个备注，
      // 提示用户特殊情况」。文字与名单同在 `advice.js`（口径改了它也得改），
      // 这里只负责画成一行有标记的提示。
      if (row.note) item.appendChild(text('div', 'advice-gold-note', row.note));
      box.appendChild(item);
    }
    body.appendChild(box);
  }
};

/**
 * 勾 / 取消勾一项：存盘 → 更新状态行 → 防抖后请服务端按新设置重算总榜。
 *
 * 为什么不做「确定 / 取消」两个按钮：用户要的是「点击后弹出详情界面」，没说要有提交步骤；
 * 而总榜是一条异步链（服务端算 5 个副本的整包），勾完立刻重算 + 状态行即时反馈，
 * 比「先攒着、点确定才算」更符合「设置开关」的直觉（总榜权重那一行也是即时生效的）。
 */
const setHiddenCost = (id, checked) => {
  if (!HIDDEN_COST_IDS.includes(id)) return;
  state.hiddenCosts = { ...(state.hiddenCosts || {}), [id]: checked === true };
  saveHiddenCosts();
  renderHiddenCostsMeta();
  scheduleHiddenCostsRecompute();
};

/** 隐金改动后的重算（防抖：连点五个复选框只打一次服务端）。 */
const scheduleHiddenCostsRecompute = () => {
  clearTimeout(state.hiddenCostsTimer);
  el.hiddenCostsMeta?.classList.add('is-pending');
  state.hiddenCostsTimer = setTimeout(async () => {
    // ⚠️ 详情窗口里「该角色的全部配队」是按「总榜权重 + 隐金设置」缓存的，
    // 隐金一变那份缓存就过期了（v4.6.69 修的就是这一类「缓存键漏字段」的 bug）。
    packsCache.clear();
    if (state.index) await loadConclusion();
    el.hiddenCostsMeta?.classList.remove('is-pending');
  }, WEIGHTS_DEBOUNCE);
};

/** 「恢复默认」= 五项重新全勾（数据默认值），窗口那边重画前会调它。 */
const resetHiddenCosts = () => {
  state.hiddenCosts = { ...DEFAULT_HIDDEN_COSTS };
  saveHiddenCosts();
  renderHiddenCostsMeta();
  scheduleHiddenCostsRecompute();
};

// ------------------------------------------------- ② 角色总榜（纯黑塔网数据口径）

/**
 * 「补什么 · 几金」的写法（总榜与抽卡方案共用）。
 *
 * 类型由旁边的徽标（角色 / 星魂 / 光锥）交代，所以这里只写**动作**，不重复说
 * 「星魂 E1 → E2」这种带着类型名的长句（实测那样会和徽标连成「星魂星魂 E1 → E2」）。
 *
 * 另一个关键区别是**你已经有它没有**：用户反馈「我号上已有镜中故我，为何还推荐」
 * —— 那个条目其实是「再抽 1 张把叠影从 1 提到 2」，所以有 `from >= 1` 时只写
 * 「叠影 SI1 → SI2」，不写「光锥本体」。
 */
const unitCostNode = (unit) => {
  const gold = Math.max(1, Math.round(Number(unit.pulls) || 1));
  const from = Number(unit.from);
  const target = Number(unit.target);
  let what;
  if (unit.kind === 'cone') {
    what = Number.isFinite(from) && from >= 1
      ? `叠影 SI${from} → SI${Number.isFinite(target) ? target : from + 1}`
      : '本体';
  } else if (unit.kind === 'eidolon') {
    what = `E${Number.isFinite(from) ? from : 0} → E${Number.isFinite(target) ? target : '?'}`;
  } else {
    what = Number.isFinite(target) && target > 0 ? `本体 + 星魂到 E${target}` : '本体';
  }
  const box = text('span', 'advice-unit-cost');
  box.appendChild(text('span', '', `${what} · `));
  box.appendChild(goldText(gold));
  return box;
};

/**
 * 整包（总榜单位）的「角色 + 光锥」那一格：`+ 菇菇嘎嘎历险记 S5 · 3 金`。
 *
 * 用户 2026-10-10 第 3 条原话：「角色+光锥介绍简化，例如真珠E2+ 菇菇嘎嘎历险记 S5 · 3金，
 * 文本不用重复，3金要用白色加粗」。改前这一格是
 *   `E2 + 本体 + 菇菇嘎嘎历险记 S5 · 3 金`
 * 两处重复：星魂档 **E2 出现两次**（行里 `.advice-unit-kind` 已经有一个「E2」），
 * 「本体」也是废话（整包一定含本体）。现在这一格只说**光锥那一截**，星魂档归行里那个
 * 「E2」徽标、角色名归前面的 `<strong>`，花费里的数字走 `goldText()`（白色加粗）。
 */
const packCostNode = (unit) => {
  const box = text('span', 'advice-unit-cost');
  if (unit.lc) {
    // 用户 2026-10-10 第三轮：「光锥图标还是移动到左边好看，但要保证光锥位于加号右侧、
    // 名称左侧，且名称必须带有叠影层数（S1-S5）」。所以这一格现在是
    //     + [图标] 菇菇嘎嘎历险记 S5 · 3 金
    // 演进：第一轮图标是 head 的直接子节点（夹在「E2」与这一段之间）；第二轮移到名称
    // **右边**（`+ 菇菇嘎嘎历险记 S5 [图标] · 3 金`）；本轮按用户要求移回**加号与名称之间**。
    //
    // ⚠️ 「+」必须**单独成段**：图标要插在它和名字中间，所以它不能再并进光锥名里。
    //    它的值写成 `'+ '`（带一个尾空格）是为了让 `textContent` 仍是
    //    「+ 名字 S5 · 3 金」—— CDP 那条花费形状断言 `/^(\+ .+ · )?\d+ 金$/` 认这个空格。
    //    视觉上那个空格**不会**被折叠掉：CSS 给这一格 `white-space: pre`（见 app.css）。
    box.appendChild(text('span', 'advice-unit-plus', '+ '));
    // ⚠️ class 仍叫 `advice-unit-cone`：`tools/check-advice-layout.mjs` 按这个 class
    //    数图标、并断言**每一行都有**它（`noCone`），改名会让那条断言假失败。
    const coneIcon = iconImg(iconUrlOf('cone', unit.lc), 'advice-unit-cone', cnCone(unit.lc));
    if (coneIcon) box.appendChild(coneIcon);
    // ⚠️ 叠影层数**始终写出**（S1 也写）—— 用户点名「名称必须带有叠影层数（S1-S5）」。
    //    改前是 `Number(unit.superimp) > 1 ? ` S${si}` : ''`，于是实测榜面 67 条里
    //    有 29 条（S1）根本看不到层数。
    const superimp = Math.max(1, Math.round(Number(unit.superimp) || 1));
    box.appendChild(text('span', 'advice-unit-cone-text', `${cnCone(unit.lc)} S${superimp}`));
    // 用户 2026-10-10 第 8 轮：「**s1 和 8 金应该隔开一点点**」。
    // 改前分隔符是个**无 class 的 span**，值 ` · ` 两侧的空格被 HTML 折叠掉，
    // 实测 `S5` 右缘到 `3 金` 左缘只有 **2.9px**（就剩「·」那一个字符的宽度）。
    // 现在给它类名 + `white-space: pre`（见 app.css），两侧空格真的占位。
    // ⚠️ 分隔符本身必须留在 textContent 里（`.advice-gold` 仍是独立一段、
    //    ` · ` 仍是它的前一个兄弟）：CDP 的花费形状断言是 `/^(\+ .+ · )?\d+ 金$/`。
    box.appendChild(text('span', 'advice-unit-sep', ' · '));
  }
  box.appendChild(goldText(Math.max(0, Math.round(Number(unit.gold) || 0))));
  return box;
};

/**
 * 这个整包我有没有（**只作展示**：总榜的口径与角色池无关，不会因为你有就把它删掉）。
 *
 * 光锥只能看到「当前装备在角色身上」的那些，所以「没有」不等于真没有 —— 未知、
 * 以及星魂 / 叠影差几档都如实写出来，让用户自己判断。
 */
const ownedStateOf = (unit) => {
  if (!state.owned.size) return null;
  if (!state.owned.has(unit.name)) return 'none';
  const needEidolon = Number(unit.eidolon) || 0;
  if ((state.eidolons.get(unit.name) ?? 0) < needEidolon) return 'gap';
  if (!unit.lc) return 'have';
  // 光锥没在快照里 = 未知（不是「没有」）；叠影差几档也算差一档。
  if (!state.ownedLightCones.has(unit.lc)) return 'none';
  return (state.coneRanks.get(unit.lc) ?? 0) >= (Number(unit.superimp) || 1) ? 'have' : 'gap';
};

/** 副本元数据（标签 / 权重 / 最便宜金数）由服务端单独发一份，按 id 查。 */
const frontierEnvMeta = (id) => (state.conclusion?.frontierEnvs || [])
  .find((env) => env.id === id) || null;

/**
 * 一个整包在某副本里的**最佳证据**：那支队伍的档位、金数与行动值。
 *
 * 总榜的分子分母都只来自队伍，所以这一行就是「为什么它排在这里」的全部解释。
 */
const envChip = (env, { withWeight = false } = {}) => {
  const meta = frontierEnvMeta(env.id);
  const chip = text('span', 'advice-unit-env');
  chip.appendChild(text('span', 'advice-unit-env-name', meta?.label || env.id));
  const gold = Number(env.bestTeamGold);
  if (Number.isFinite(gold)) chip.appendChild(text('b', '', ` ${gold} 金`));
  if (withWeight && Number.isFinite(Number(meta?.weight))) {
    chip.appendChild(text('span', 'muted small', ` ×${formatWeight(meta.weight)}`));
  }
  const bits = [];
  if (Number.isFinite(Number(meta?.weight))) bits.push(`权重 ×${formatWeight(meta.weight)}`);
  bits.push(`最佳配置 ${tierLabelOf(meta, env.tier)}`
    + `${Number.isFinite(gold) ? ` · ${gold} 金` : ''}`
    + `${Number.isFinite(Number(env.actionValue)) ? ` · 行动值 ${env.actionValue}` : ' · 行动值缺失'}`
    // 用户 2026-10 要求④：界面上把「赛季」改成「版本」（游戏里的叫法就是版本）。
    // ⚠️ 只改**用户可见文案**：字段名 `evidenceSeason`、变量 `season` / `seasonSort`
    // 一律不动（服务端与 advice.js 都按这些键读）。
    + `${env.evidenceSeason ? `（${env.evidenceSeason} 版本）` : ''}`);
  if (Number.isFinite(Number(meta?.minCost))) {
    // 口径就是「该副本前沿里最便宜的那支队伍」（含最好一档与次好一档），所以只说
    // 「最便宜配置」不说哪一个档 —— 写死档位会与实际取最小值的那批对不上。
    bits.push(`该副本最便宜的配置 ${meta.minCost} 金`);
  }
  if (Number.isFinite(Number(env.configCount))) {
    bits.push(`这个整包出现在 ${env.configCount} 条独立配置里（不参与排序）`);
  }
  chip.title = bits.join(' · ');
  return chip;
};

/**
 * 档位在界面上怎么写：**游戏内实际的量**（`0T` / `积分 ≥3700` / `行动值 <300`）。
 *
 * 用户 2026-10-10 明确要求：「把网页上显示的『满分』『达标』改为具体的行动值」——
 * 原来的「满分 / 达标 / 及格」要先在心里翻译一次才知道到底要打多少轮、多少行动值，
 * 而玩家的判据本来就是「能不能 0T / 行动值够不够低」这种具体数字。
 *
 * 判据线只存在数据集里（建库侧按模式写死，见 `herta-build.mjs` 的 `TIER_LINES`），
 * 所以走副本元数据拿 `mode` / `stage` / `tierLines`；元数据里没有时退回
 * `advice.js` 的 `TIER_PLACEHOLDER`（「最好一档」这种中性说法，不编数字）。
 *
 * ⚠️ 一律走这个函数，**不要**在任何地方再写 `满分` / `达标` —— `herta-test.mjs`
 * 有一条禁词断言（`0T / 积分 / 行动值，不用及格-达标-满分这类词`）钉着这件事。
 */
const tierLabelOf = (meta, tier) => tierTextOf(meta, tier);

/**
 * 「表现」列的主值（用户 2026-10-11 第二轮：「表现直接写具体成绩更好，例如行动值直接
 * 写 285 就行」）。
 *
 * 合并的理由与算法见 `advice.js` 的 `perfFactorOf()`。这一列现在**只写实测成绩**：
 *   * `285`   —— 绝境（行动值）
 *   * `0T`    —— 轮次制（混沌 / 虚构 / 骑士关）
 *   * `3852`  —— 末日幻影（积分；⚠️ 内部存的是 `4000 − 积分`，`metricShortText` 翻回来）
 *
 * 改前写成「档位写法 · 行动值」（`行动值 <300 · 285`），用户反馈太啰嗦：档位那半截
 * 在**同一行**的贡献链里已经由系数体现，而单位「行动值」三个字上方脚注已说明。
 * 量纲由 `metricShortText()` 按副本自动带（轮次带 `T`，其余裸数字）。
 *
 * 没有成绩时退回档位写法（`0T` / `积分 ≥3700`）；档位也取不到才给 `—`，不编数字。
 */
const perfLabelOf = (meta, env, f) => {
  const av = f?.av;
  if (Number.isFinite(av)) return metricShortText(meta?.mode, meta?.stage, av);
  return tierLabelOf(meta, env?.tier) || '—';
};

/**
 * 「表现」那条脚注里的**曲线说明**（用户 2026-10-11 第二轮要「更精细的梯度」）。
 *
 * 按该副本实际有的锚点写，不写没生效的那一段：
 *   * 满分线 = 0（混沌 / 虚构 / 末日幻影）→ `0T 得 1.00 → ≤2T 得 0.50 → ≤4T 得 0.25`
 *   * 绝境（满分线 > 0，无及格线）        → `行动值 0 得 1.00 → <300 得 1.00 → <500 得 0.60`
 *     （用户 2026-10-11 第四轮起：满分线以内固定 1.00，300~500 由 1.00 渐变到 0.60）
 *
 * ⚠️ **档位名必须按锚点的 av 值反查**，不能用「第 i 个锚点 = 第 i 个档位」——
 * `perfAnchorsOf()` 会**跳过与顶点重合的满分线**（满分线 = 0 的副本），
 * 于是锚点下标与档位名整体错位：实测混沌回忆会写成 `0T 得 1.00 → 0T 得 0.50`。
 * 这里拿每个锚点的 av 与三条线比对来定名，跳过哪一段都不会错。
 *
 * ⚠️ 取值来自 `advice.js` 的 `SCORING`（默认三个常量）或该副本在
 * `SCORING.frontierPerfLineByEnv` 里的覆盖（`perfLineWeightsOf()`），**不要在这里
 * 写死数字** —— 调曲线时界面会跟着走，抄一份就会说谎。
 */
const perfCurveText = (meta) => {
  const anchors = perfAnchorsOf(meta?.tierLines, meta?.lowerIsBetter !== false,
    perfLineWeightsOf(meta));
  if (anchors.length < 2) return '系数由该副本的判据线决定';
  const lines = avLinesOf(meta?.tierLines, meta?.lowerIsBetter !== false);
  // 锚点 av → 档位名：与三条线比对（浮点容差内算命中），对不上就是顶点。
  const tierAt = (av) => {
    if (Number.isFinite(lines.perfect) && Math.abs(av - lines.perfect) < 1e-9) return 'perfect';
    if (Number.isFinite(lines.target) && Math.abs(av - lines.target) < 1e-9) return 'target';
    if (Number.isFinite(lines.pass) && Math.abs(av - lines.pass) < 1e-9) return 'pass';
    return null;
  };
  const parts = [];
  for (const [av, value] of anchors) {
    const tier = tierAt(av);
    // 顶点那一档：写**该副本的成绩零值**（`0T` / `行动值 0` / `积分 4000`）。
    // ⚠️ 末日幻影的 av=0 对应积分 4000，`metricValueText` 会翻回来，正好是游戏内写法。
    // ⚠️ 绝境用 `metricValueText`（带「行动值」前缀）而不是 `metricShortText`（裸数字）：
    //    脚注是**脱离表格**独立读的，裸 `0` 没有量纲（表里那一列有表头与同行档位兜着，
    //    脚注没有）。实测就这么写出过 `0 得 1.00`，读起来不知道在说什么。
    const label = tier ? tierLabelOf(meta, tier) : metricValueText(meta?.mode, meta?.stage, av);
    // ⚠️ **脚注总长有 60 字硬上限**（`check-advice-layout.mjs` 的 `notesShortOk`）。
    // 只写「档位 → 系数」对，省掉「得」字与顶点那一段 —— 顶点是 1.00 的常识，
    // 而三条线各自的系数才是读者真正要查的表。实测从 73 字压到 ~40 字。
    parts.push(`${label} ${value.toFixed(2)}`);
  }
  return parts.join(' → ');
};

/** 角色总榜里一次最多渲染几行（其余靠表头提示，避免一屏铺上千行）。 */
const UNIT_ROWS_MAX = 80;

/**
 * **抽卡方案每页显示多少支队伍**（用户 2026-10-18：「每页显示 20 个配队」）。
 *
 * ⚠️ 它是**展示层**的常量，与 `SCORING.teamPlanMaxRows`（下发上限）是两件事：
 *    后者决定 `teamPlan()` 回多少条（现在是全池，兜底 500），这个决定一次画几张卡。
 *    一页 20 张卡按结构数是**几百个 DOM 节点**（每卡 4 个位置 + 3 条分项条 + 补金顺序
 *    + 过渡行），全池 284 张就是**近万个节点** —— 那一下重建是肉眼可见的卡顿，
 *    而 20 张这一档在正常机器上感觉不到。⚠️ 这里**不写具体毫秒数**：本机起不了浏览器
 *    （`bin/serve.mjs` 的 DPAPI 要 spawn 系统命令行进程，沙箱拦下），没有实测数据就不编。
 */
const TEAM_PLAN_PAGE_SIZE = 20;

/**
 * 总榜每个单位（= 角色 + 星魂档 + 光锥整包）的可搜索文本。
 *
 * ⚠️ 名字的**来源**在这里拼（`cn` / `cnCone` 是本文件唯一的中文名入口），
 *    归一化与匹配规则在 `advice-paging.js`（那份能被 Node 直接测）。
 * ⚠️ 按**对象**缓存（`WeakMap`）：每次敲字都要过一遍全榜，`frontierUnit` 对象在一次
 *    结论里是稳定的复用对象，所以每个单位只拼一次字符串。不用在数据对象上加字段 ——
 *    那会污染服务端下发的载荷（并且会被 `JSON.stringify` 带回去）。
 */
const unitSearchCache = new WeakMap();
const unitSearchText = (unit) => {
  if (!unit || typeof unit !== 'object') return '';
  let cached = unitSearchCache.get(unit);
  if (cached === undefined) {
    cached = searchTextOf([unit.name, cn(unit.name), unit.lc, cnCone(unit.lc)]);
    unitSearchCache.set(unit, cached);
  }
  return cached;
};

/** 星魂档在界面上的写法：`0 → E0`、`2 → E2`（内部档位就是数字）。 */
const tierNameOf = (tier) => `E${Math.max(0, Math.round(Number(tier) || 0))}`;

/**
 * 服务端下发的**星魂档清单**（升序数字）。
 *
 * 有 `frontierTiers`（v6 载荷）就以它为准 —— 那才是「这一档真的有条目」的权威来源；
 * 旧服务端没有它时退回「从 `frontierUnits` 里现收」，界面因此不会白屏。
 */
const tierKeysOf = (conclusion) => {
  const tiers = conclusion?.frontierTiers;
  if (tiers && typeof tiers === 'object') {
    const keys = Object.keys(tiers).map(Number).filter(Number.isFinite);
    if (keys.length) return keys.sort((a, b) => a - b);
  }
  return [...new Set((conclusion?.frontierUnits || []).map((u) => Number(u.eidolon) || 0))]
    .sort((a, b) => a - b);
};

/**
 * 当前星魂档筛选下**要展示的那一份榜单**。
 *
 * ⚠️ **不能**拿「全部」那份（`frontierUnits`）自己按 `eidolon` 过滤 —— 它每角色只有
 * 一条（总分最高的那个整包），一过滤就只剩「最佳成绩恰好落在这一档」的角色。
 * 用户 2026-10-11 报的正是这个：「全部榜单比较不错，但拆分到 E0/1/2/6，则只能看到存在
 * 最佳成绩的角色，而看不到非最佳成绩的每个角色」。实测 51 个有 E0 整包的角色里，
 * **33 个**在 E0 页里根本看不到（真珠 E0 911 分 / 遐蝶 E0 637 分……它们的最佳成绩在 E2）。
 *
 * 所以服务端另发一份 `frontierTiers`：**每个档位各自按角色收敛一条**，切档时用它。
 * 判定「这一档值多少分」本来就该只和同档的整包比，与它在别的档位拿多少分无关。
 *
 * 兜底：旧服务端（跑着没重启的进程）没有 `frontierTiers` 时退回旧行为 ——
 * 宁可少几行，也不要整页空白。`tools/_probe-tier-board.mjs` 会把这个区别打出来。
 */
const unitListOf = (conclusion, tier) => {
  const all = conclusion?.frontierUnits || [];
  if (tier === 'all') return all;
  const rows = conclusion?.frontierTiers?.[String(tier)];
  if (Array.isArray(rows)) return rows;
  // ⚠️ 折档与 `advice.js` 的 `byTier` 用**同一个** `eidolonTierOf`（E3~E5 进 E2 桶）：
  //    两处判据不一致时，E3~E5 的整包会在「新服务端」与「旧服务端」两种形态下
  //    一个出现、一个消失。
  return all.filter((u) => eidolonTierOf(u.eidolon) === Number(tier));
};

/**
 * 总榜的筛选器：**星魂档** + 「只看我没有的」。计数按**收到的整份榜单**算，不是按渲染出的行。
 *
 * 旧版按「角色 / 星魂 / 光锥」筛，那只对已废弃的节点口径有意义：现在单位一律是
 * 「角色 + 星魂档 + 光锥」整包，一个整包不可能只属于三类中的一类。换成按星魂档筛
 * （E0 / E1 / E2 / E6）—— 玩家本来就是按「这个角色要抽到几命」在想问题的。
 *
 * ⚠️ 计数必须走 `unitListOf`（逐档收敛的那一份），不能用 `frontierUnits.filter`：
 * 后者只会数出「最佳成绩在这一档」的角色个数，于是 E0 显示 18 而实际有 51 个角色。
 */
const renderUnitFilters = () => {
  if (!el.unitFilter) return;
  el.unitFilter.innerHTML = '';
  const conclusion = state.conclusion;
  const list = conclusion?.frontierUnits || [];
  const count = (tier) => (tier === 'all' ? list.length : unitListOf(conclusion, tier).length);
  for (const [value, label] of [['all', '全部'],
    ...tierKeysOf(conclusion).map((t) => [t, tierNameOf(t)])]) {
    const chip = text('button',
      `advice-filter${state.unitEidolon === value ? ' is-active' : ''}`,
      `${label} ${count(value)}`);
    chip.type = 'button';
    chip.title = value === 'all' ? '不按星魂档筛选：每个角色只占一行（它分数最高的那个整包）'
      : `只看每个角色「抽到 ${label}」时最强的那个整包（${count(value)} 个角色）。`
        + '这一档只和同档的整包比，与它在别的档位拿多少分无关 —— '
        + '所以最佳成绩不在这一档的角色，也能在这里看到它这一档的分数。';
    chip.addEventListener('click', () => {
      state.unitEidolon = value;
      renderUnits();
      renderUnitFilters();
    });
    el.unitFilter.appendChild(chip);
  }
  // 「只看我还没有的」：总榜本身不看角色池，这个开关只是帮你把已有的折叠掉。
  // ⚠️ 它的计数跟着**当前星魂档**走（切到 E6 时「我还没有的」自然更少），
  // 否则会出现「筛后 3 条 / 徽标写 44」这种自相矛盾的读数。
  if (state.owned.size) {
    const missing = unitListOf(conclusion, state.unitEidolon)
      .filter((u) => ownedStateOf(u) !== 'have').length;
    const chip = text('button',
      `advice-filter${state.onlyMissing ? ' is-active' : ''}`, `只看我没有的 ${missing}`);
    chip.type = 'button';
    chip.title = '光锥只能看到当前装备在角色身上的那些，所以「没有」不一定真没有';
    chip.addEventListener('click', () => {
      state.onlyMissing = !state.onlyMissing;
      renderUnits();
      renderUnitFilters();
    });
    el.unitFilter.appendChild(chip);
  }
};

/**
 * 性价比得分徽标 + 点开的详情（用户要求：**移到左边**、靠近其它文字，并且点一下就能
 * 看到这个数字是怎么来的）。
 *
 * ⚠️ **两个榜的显示量纲不同了**（v15 起）：
 *   * 总榜（`packScoreText`）：100 × 档位 × 行动值 × (最便宜金数 ÷ 本配置金数)，
 *     每副本上限 100，乘副本权重后相加 → 数字是「分数」量纲（几百到上千）。
 *   * 抽卡方案（`scorePercent`）：百分点 ÷ 期望抽数 ×100 → 数字是同一栏里的另一套量纲。
 * 所以徽标必须由调用方传格式化函数，不能默认共用 `scorePercent`（旧口径下两者同源）。
 *
 * 显隐是**点击**（2026-10-10 用户要求，从 `:hover` 改过来），而且点开的是
 * `advice-tip-window.js` 那个**居中的大窗口**（同一天第二轮要求：内容太多、小浮层会
 * 被网页遮挡）：窗口里装着「该角色的全部配队」，那一节在窗口内自己滚，指针当然要能
 * 留在里面 —— hover 一挪开就收，根本滚不了。
 * `tabindex=0` + `role="button"` 让键盘 Enter / 空格也能开；`aria-expanded` 随
 * `.is-open` 同步，读屏软件才知道这个按钮控制着窗口。
 */
const valueBadge = (value, tip, format = scorePercent, label = '角色得分') => {
  const wrap = text('span', 'advice-value-wrap');
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'button');
  wrap.setAttribute('aria-expanded', 'false');
  wrap.setAttribute('aria-haspopup', 'true');
  wrap.title = '点击查看这个分数怎么来的';
  // ⚠️ 用户 2026-10-13 第 2 条把这个指标从「性价比得分」改名「**角色得分**」：
  // 它不再是「含金数项的总分」一个量，而是强度 / 性价比 / 泛用性三个分项按抽卡权重
  // 加权的结果（口径见 `advice.js` 的 `frontierBoard` 与 `SCORING.drawWeight`）。
  // 榜名仍是「角色总榜」（用户 2026-10-12 第 1 条改的，没动）。
  wrap.appendChild(text('span', 'advice-unit-value', `${label} +${format(value)}`));
  if (tip) wrap.appendChild(tip);
  return wrap;
};

/** 总榜（整包口径）的显示值：分数量纲，四舍五入到整数。 */
const packScoreText = (value) => Math.round(Number(value) || 0);

/**
 * **懒构建的详情浮层**（2026-10-14 性能修复，用户报「网页非常的卡」）。
 *
 * ⚠️ 为什么必须懒构建 —— 实测数据（`tools/_perf2.mjs`，改前）：
 *   * 总榜 **92 行**，每一行都在**渲染时**就把整套详情建进 DOM（三个分项表 + 强度/性价比
 *     来源表 + 逐关卡表 + 每关一个队伍槽 + 头像与光锥图）；
 *   * 结果 DOM 共 **26,561** 个节点，其中 **21,339 个（80%）** 都在这 92 个浮层里，
 *     803 张图里有 **400 张**也在里面；
 *   * 代价是**滚动只有 16 帧 / 3 秒（平均帧 194 ms、p95 392 ms ≈ 5 FPS）** —— 就是卡的原因。
 *   而同一时刻**只会打开一个**浮层，剩下 91 个纯属白造（用户点开率≈0）。
 *
 * 所以渲染时只放一个**空占位**（揣一个构建函数），第一次点开才真正建内容
 * （见 `wireValueTips()` 的 `openTip()`：先 `__lazyBuild()` 替换掉占位，再走原有的
 * 「补明细 → 填队伍卡片 → 开窗口」那条链）。
 *
 * 为什么是「占位元素 + 构建函数」而不是「点开时现找 unit 再建」：`.advice-value-tip` 是
 * `advice-tip-window.js` 的**内容契约**（它按 `parentNode` / `nextSibling` 把内容搬进窗口、
 * 关闭时再搬回来）。占位换实现能保证「内容元素的父节点始终是那个徽标」这条不变量不变，
 * 窗口那侧**一行都不用改**。
 *
 * `hints.teamSlots` 只给**探针**用（`check-advice-layout.mjs` 原来靠「tip 里有几个
 * `.advice-plan-team-slot`」挑出关卡最多的那一行；懒构建之后那些槽在点开前不存在，
 * 于是改成读占位上这个计数）。界面本身不读它。
 */
const lazyTip = (build, hints = {}) => {
  const tip = text('span', 'advice-value-tip');
  tip.__lazyBuild = build;
  tip.dataset.teamSlots = String(Math.max(0, Number(hints.teamSlots) || 0));
  return tip;
};

/** 一个 unit/方案行在浮层里会有几个队伍槽（= 关卡数，用来给探针排序）。 */
const teamSlotHint = (unit) => Math.max(0, Number(unit?.envCount) || 0, (unit?.envs || []).length);


/**
 * 总榜一个整包的**角色得分**（用户 2026-10-13 第 1、2 条）。
 *
 * 服务端算好下发（`unit.characterScore`，0~100）。⚠️ 退回 `unit.total` 是给
 * **合成夹具 / 老服务端**的兜底：它们手搓 `frontierUnits`，没有三个分项。
 * 那时显示的是老的「性价比原始分」（几百的量纲）—— 这是刻意的：宁可显示一个能对上
 * 老口径的数，也不要显示 `undefined` 或 `0`。
 */
const unitRoleScore = (unit) => Number(unit?.characterScore ?? unit?.total) || 0;

/**
 * 「N 金」：数字用**白色加粗**（用户 2026-10-10 第 3 条：「3金要用白色加粗」）。
 *
 * 为什么做成节点而不是拼字符串：排名行的那段花费是 `.advice-unit-cost` 一个 span 的
 * 文本，只给数字上色就必须把它拆成 `<b>`。三处花费（总榜行 / 方案行 / 配队清单里的
 * 「整包 N 金」）统一走这里，别处再 `textContent` 拼一遍就会出现「有的数字白、有的灰」。
 */
const goldText = (gold) => {
  const box = text('span', 'advice-gold');
  box.appendChild(text('b', 'advice-gold-num', String(Math.max(0, Math.round(Number(gold) || 0)))));
  box.appendChild(text('span', '', ' 金'));
  return box;
};

/**
 * 因子的显示（`×0.94`）：两位小数就够读，且整列对齐。
 *
 * `Number(null) === 0`，缺数据时不能印成 `×0.00`（那看起来像「这一项没有贡献」），
 * 所以非有限值一律给 `—`。
 */
const factorText = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? (Math.round(n * 100) / 100).toFixed(2) : '—';
};

/**
 * 「值 + 系数」格：`满分` 上一行、`（1.00）` 下一行。
 *
 * 排版理由（2026-10 用户要求「优化排版」）：改前写成 `满分 （1.00）` 单行，六个因子列
 * 各自被这半截括号撑到 ~90px，七列加起来比「贡献」那列还宽，整张表被迫顶到浮层上限、
 * 第一列的副本名被挤成落单的一个「关」字。上下两行之后每列只按**主值**定宽
 * （`满分`/`226`/`7÷10` 都不宽），括号里的系数退成小号弱化字 —— 乘法链因此第一次有了
 * 足够的横向空间，不用再靠加宽浮层来买。
 *
 * `sub` 省略时只上排一行（权重 / 版本两列本来就没有原始量）。
 */
const tipFactor = (main, sub) => {
  const box = text('span', 'tip-stack');
  box.appendChild(text('span', 'tip-main', main));
  if (sub) box.appendChild(text('span', 'tip-sub', sub));
  return box;
};

/**
 * 关卡名：**副本与关卡分两行**（「异相仲裁」/「绝境王棋关」），可选的第三行是**版本小字**。
 *
 * 改前是一整串交给浏览器断行，而中文可以在任意两字之间断开 —— 表格一挤就成了
 * 「异相仲裁·绝境王棋」加落单的一个「关」。这里按 `·` 拆成两段、各自 `nowrap`，
 * 断行位置就是设计好的那一个；副本名用弱化小字，关卡名（真正要认的那半截）给足对比。
 *
 * ## 用户 2026-10-11 第 2 条：「备注关卡的版本号」
 *
 * `season` 的唯一合法来源是 `env.evidenceSeason` —— `advice.js` 的 `frontierPacks()` 把它
 * 写成 `evidence.season`（「最佳证据所在版本」），`src/server/conclusion.js` 的
 * `slimFrontierUnit()` 原样下发。它就是这一行的分**从哪一版的数据里取的**，
 * 也是「跨版本发挥」那一列的**分母**那一次成绩（`seasonFactor = 加权平均 ÷ 最新版那次`，
 * 2026-10-15 起「最佳证据」取版本最新的那次 —— 与强度来源表同一口径），
 * 所以它与表里其余因子是同一个坐标系里的数。
 *
 * ⚠️ 另外两个看着「像版本」的字段**都不能拿来顶替**：
 *   * 左边的**版本权重表**（`seasonWeights`，2:2:2:1:1:1:1）是全榜共用的一串权重，
 *     对每一条都一样 —— 写进这一列等于给所有关卡印同一个数字；
 *   * `env.bornSeason` 是「这个整包**最早可能**存在的版本」（角色与光锥里较晚登场的那个），
 *     它回答的是「为什么旧版本不参与平均」，与最佳证据出自哪一版毫无关系。
 * 两者都会写成一个与这一行无关的数字，属于编造。取不到 `season` 时**不写**这一行。
 * （2026-10-11 第 10 轮起只有角色总榜还在用它 —— 抽卡方案改成队伍口径，那个窗口撤了。）
 */
const tipEnvLabel = (label, season) => {
  // `envLabel` 在数据里是 `异相仲裁 · 绝境王棋关`（分隔符两侧各有一个空格），拆完两段
  // 各自 `trim()`：不 trim 的话第一段带着尾空格进 DOM，空格虽然在视觉上会被折叠掉，
  // 但 `textContent` 里会留下 `异相仲裁 ` 这种脏值（CDP 判据拿第一列的文本与别处比对时
  // 会被它绊到）。
  const parts = String(label ?? '').split('·').map((part) => part.trim());
  const box = text('span', 'tip-label');
  // ⚠️ 用户 2026-10-11 第 6 条「关卡、权重、表现等文字需要**等高**」：副本名与关卡名
  //    并到**同一行**（`.tip-label-title`，中间那个 `·` 由 `.tip-label-dot` 画出来）。
  //    改前这里是竖排三行（副本 / 关卡 / 版本），而别的列在 `vertical-align: middle` 的
  //    格里居中 —— 于是「绝境王棋关」比同行的「×10 / 299 / 9/9」高十几像素，
  //    一行信息读不成一条线。两段仍**都在**（只是不再换行），
  //    「异相仲裁下两个关卡会混起来」这个原来的理由不受影响。
  const title = text('span', 'tip-label-title');
  if (parts.length > 1) {
    title.appendChild(text('span', 'tip-label-env', parts.slice(0, -1).join('·')));
    title.appendChild(text('span', 'tip-label-dot', '·'));
    title.appendChild(text('span', 'tip-label-stage', parts[parts.length - 1]));
  } else {
    title.appendChild(text('span', 'tip-label-stage', label));
  }
  box.appendChild(title);
  // 文案与「该角色的全部配队」那一行的 `.advice-packs-env-season` **逐字一致**
  // （`${env.evidenceSeason} 版本`）：同一个数在两处写法不同会被当成两个口径。
  if (season) box.appendChild(text('span', 'tip-label-season', `${season} 版本`));
  return box;
};

/**
 * 「贡献」格：乘法链 + 结果。链是**说明**（弱化、可折行），结果是**答案**（金色加粗、
 * 永不折行）。改前两者同一颜色同一行，长链把结果挤在链尾、视线要先横穿一整条乘法
 * 才看得到那个数。
 */
const tipChain = (chain, result) => {
  const box = text('span', 'tip-chain');
  box.appendChild(text('span', 'tip-chain-ops', chain.join(' × ')));
  box.appendChild(text('span', 'tip-chain-eq', `= ${result}`));
  return box;
};

/**
 * 浮层里的那张小表：列标题 + 每行若干格（+ 可选的合计行）。
 *
 * 单元格可以是字符串，也可以是上面那几个 `tip*()` 造出来的节点（`Node` 直接收下）。
 */
const tipTable = (headers, rows, foot, extraClass) => {
  const cell = (value, idx, len) => {
    const td = text('td', idx === 0 ? '' : (idx === len - 1 ? 'is-val' : 'is-num'));
    if (value instanceof Node) td.appendChild(value);
    else if (value !== undefined && value !== null) td.textContent = String(value);
    return td;
  };
  const table = document.createElement('table');
  // ⚠️ `extraClass`（用户 2026-10-13）：角色得分的浮层里现在有**两张**表（三个分项那张 +
  // 逐关卡来源那张）。`check-advice-layout.mjs` 的探针按 class 选表，不区分就会量到上面
  // 那张 —— 所有「表头/列数/因子」的断言会在**不报错**的情况下全部量错对象。
  // 主表（逐关卡来源）因此带 `is-source`，探针按它选。
  table.className = extraClass ? `advice-value-tip-table ${extraClass}` : 'advice-value-tip-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of headers) hr.appendChild(text('th', '', h));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    row.forEach((value, idx) => tr.appendChild(cell(value, idx, row.length)));
    tbody.appendChild(tr);
  }
  // 合计行：表里各副本的「贡献」加起来 = 徽标上的数。整包口径下这条恒等式不是显然的
  // （每个副本的分先按版本加权、再乘副本权重），写出来读者才不用自己加。
  if (foot) {
    const tr = document.createElement('tr');
    tr.className = 'is-total';
    foot.forEach((value, idx) => tr.appendChild(cell(value, idx, foot.length)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
};

/**
 * 详情窗口的内容：总分那一行 +（缩进的）拆解块。
 *
 * ## 结构（2026-10-11 第 5 条起，**队伍图标在表格里**）
 * `head`（性价比得分）→ `.advice-value-tip-sub` 缩进块（等式 → **贡献值来源表**
 * （第一列＝关卡名 + 版本小字 + **那一关卡的队伍卡片**）→ 全部配队 → 脚注）。
 *
 * ⚠️ **表上方那一整块「最佳证据的队伍」已经删掉**（用户 2026-10-11 第 5 条原话：
 * 「我希望角色的图标都放进表格内，节约空间也更高效」）。改前它在表上方逐关卡画
 * 「关卡名 · 档位 · N 金 · 行动值 · N 版本 · 贡献 +N」+ 一张卡片行 —— 与表格里的
 * 关卡名 / 表现 / 金数 / 版本 / 贡献**几乎逐字重复**，一个 5 关卡的条目光这一块就占
 * ~660px（窗口总高才 900px），真要看数字反而要往下滚。现在**每个关卡的信息只出现一次**
 * （就是表格那一行），图标挂在同一行的第一格里。
 *   * 因此 `tipBox` 不再收 `topExtra`（那个参数就是为它加的，`planTip()` 已在
 *     「抽卡方案改队伍口径」那一轮删除，全仓只剩这一个调用点）；
 *   * 「关卡与关卡之间的线」也不再需要单独画：**表格自己的行线**就是那条线
 *     （`td { border-bottom: 1px solid rgba(255,255,255,.05) }`）；
 *   * 第 5 条「从属」左细线（`.advice-value-tip-sub`）保留 —— 那是另一件事。
 */
const tipBox = ({ head, eq, headers, rows, foot, pre, extra, notes, tableClass, headExtra }) => {
  const tip = text('span', 'advice-value-tip');
  // ⚠️ `headExtra`（2026-10-15）：把「查看分数来源」那个折叠按钮摆到标题**同一行**、
  //    紧跟「补金推荐分 +N.1」之后（用户要求「放在补金推荐分右侧」）。有它时把标题包进一个
  //    行容器 `.advice-value-tip-headrow`（flex）—— 不包的话 `.advice-value-tip-head` 是
  //    `display: block`，按钮会被挤到**下一行**，正是用户要改掉的形态。
  //    ⚠️ 只有传了 `headExtra` 才建这一层：角色总榜那个窗口（`frontierTip`）不传，
  //       它的 DOM 与样式一字不变（没必要时不引入新层级）。
  //    ⚠️ 按钮**不能**直接塞进 `.advice-value-tip-head`：那个节点是写标题栏的文字来源
  //       （`wireValueTips()` 的 openTip 用它的 `textContent` 当窗口标题），里面多一个
  //       「查看分数来源▾」会让标题栏印出那段按钮文字。
  if (headExtra) {
    const headRow = text('span', 'advice-value-tip-headrow');
    headRow.appendChild(text('span', 'advice-value-tip-head', head));
    headRow.appendChild(headExtra);
    tip.appendChild(headRow);
  } else {
    tip.appendChild(text('span', 'advice-value-tip-head', head));
  }
  const sub = text('span', 'advice-value-tip-sub');
  if (eq) sub.appendChild(text('span', 'advice-value-tip-eq', eq));
  // ⚠️ `pre`（用户 2026-10-13）：插在等式与主表**之间**。三个分项那张表必须在这里 ——
  // 主表（关卡 × 权重 × 表现 × 金数 × 跨版本发挥 × 贡献）现在只是「**性价比**分项」
  // 的原始来源，读者得先看到总分怎么由三个分项合成，再往下看其中一项的明细。
  // 放进 `extra` 会跑到主表**后面**，读起来像先有明细后有结论。
  for (const node of pre || []) if (node) sub.appendChild(node);
  if (headers?.length && rows?.length) sub.appendChild(tipTable(headers, rows, foot, tableClass));
  for (const node of extra || []) if (node) sub.appendChild(node);
  if (notes?.length) {
    // 脚注收进一个容器（2026-10 用户要求「优化排版」）：改前六条各自是浮层的直接子节点、
    // 一眼过去是一堵灰字墙；现在整块收进 `.advice-value-tip-notes`，CSS 里排成两栏。
    // ⚠️ 每条仍然是独立的 `.advice-value-tip-note`：`check-advice-layout.mjs` 按这个
    // class 数条数、量每条字数，不能合并成一段。
    const box = text('span', 'advice-value-tip-notes');
    for (const line of notes) box.appendChild(text('span', 'advice-value-tip-note', line));
    sub.appendChild(box);
  }
  tip.appendChild(sub);
  return tip;
};

/* ---- 2026-10-10 第二轮：小浮层 → 大窗口 ---------------------------------------
   这里原本有两个函数：`fixedContainingBlock()`（找出会被当成 fixed 包含块的祖先，
   因为 `.panel` 有 `backdrop-filter`）与 `placeTip()`（把贴徽标的小浮层用 fixed +
   现算视口坐标摆到徽标下方，顺便躲开限高容器的裁剪）。

   用户这一轮的要求是「性价比详情页目前的组件过多，需要单独开一个较大的窗口避免部分
   内容被网页遮挡」—— 内容不再贴在徽标旁边，而是搬进一个**居中的大窗口**
   （`advice-tip-window.js` + `advice-tip-window.css`，宽 1180px、内部自己滚）。
   于是「摆坐标」这件事整个不存在了，两个函数一并删掉：留着就是死代码，而且它们的存在
   会让下一个人以为「浮层还是会飘」。

   ⚠️ 它们当年踩的坑仍在 HANDOFF §6.1 第 3、4 条（`backdrop-filter` 创建 fixed 包含块、
   限高容器裁掉 absolute 浮层）—— 现在的答案是「**不摆**」而不是「摆得更准」。 */

/**
 * 收起一行的详情：把徽标那层 `.is-open` 摘掉。
 *
 * 与 v4.6.59 的差别：那时这里还要清浮层自己的 `.is-placed` 与行内 `left/top`
 * （坐标是 `placeTip()` 现算的）。现在内容由**大窗口**承载、坐标归窗口，所以这里
 * 只管**徽标自己的状态**；内容的「还回来」由 `advice-tip-window.js` 的 `close()`
 * 负责（顺序：先回调 `onClose` → 再把内容节点移回原位）。
 */
const hideTip = (wrap) => {
  if (!wrap) return;
  wrap.classList.remove('is-open');
  // 与 `.is-open` 保持一致，否则读屏软件读到的还是「已展开」。
  wrap.setAttribute?.('aria-expanded', 'false');
};

/** 给一个容器接上「**点击**性价比得分徽标 → 开**性价比详情大窗口**」（事件委托，
 *  两个榜各调一次）。
 *
 * ## 用户 2026-10-10 的两轮要求（都在这一个函数里落地）
 *   * 第一轮：「当前性价比界面无法滚动，会自动关掉，改为点击性价比 +xxx，弹出的窗口
 *     不自动隐藏」→ 显隐从 CSS 的 `:hover` / `:focus-within` 改成**点击**，并删掉
 *     `scroll` 收起监听（页面滚动不再收）。
 *   * 第二轮：「性价比详情页目前的组件过多，需要单独开一个较大的窗口避免部分内容被
 *     网页遮挡」→ 内容不再贴在徽标旁边（620px 小浮层），而是搬进**居中的大窗口**
 *     （`advice-tip-window.js`，宽 1180px、内容自己滚、背景 / 关闭按钮 / ESC 三条路关闭）。
 *
 * ## 状态分工（一个人管一件事，别互相抢）
 *   * `.is-open`：**徽标自己**的状态（CSS 用它把徽标描成 cyan）—— 这里加/去；
 *   * 窗口的开与关：整个归 `advice-tip-window.js`（含把所有关闭路径收敛到一个 `close()`）；
 *   * 内容节点 `.advice-value-tip`：**内容归本文件建**，窗口只负责搬进去、关掉时还回来。
 *
 * ⚠️ 为什么「点别处就收」那一段现在要对「窗口已经开着」短路：窗口是满屏遮罩 + 居中卡片，
 * 点背景、点关闭按钮都会走窗口自己的 `close()`，而它会回调 `onClose → hideTip()`。
 * 这里再抢着收一次，就会把两套状态拆开（窗口还开着、徽标已经不亮了）；而且内容节点
 * 此刻正在窗口里，`closest('.advice-value-wrap')` 之类的判断也不再成立。
 *
 * ⚠️ 本函数里唯一一个**挂在 `document` 上、且全局只接一次**的监听器是下面那个
 * 「就地折叠块」的委托 —— 理由（两个方向都实测踩过）见它的注释。
 *
 * ⚠️ 那个监听器的「只接一次」用的是**模块级**的 `detailToggleWired`，**不是**上面这个
 * `container.dataset.tipsWired`：后者只管「这个容器接过没有」，而折叠块的委托挂在
 * `document` 上、整个页面只需要一份 —— 拿容器级守卫去挡会挂上两份，一次点击被处理
 * 两遍（实测：`aria-expanded` 被写成 `true` 又立刻写回 `false`，等于没点）。
 */
let detailToggleWired = false;

const wireValueTips = (container) => {
  if (!container || container.dataset.tipsWired === '1') return;
  container.dataset.tipsWired = '1';
  /**
   * 逐档榜（E0/E1/E2/E6）的载荷只带**最好的那一个关卡**的明细，为的是压住
   * `/conclusion` 的 600 KB 硬上限；点开详情时这里按需把那个整包的**全部关卡**取回来。
   *
   * 用户 2026-10-11 原话：「修复 E1/E2/E6 的性价比详情页仅显示一种关卡的 bug」。
   *
   * 取数走的是**同一个** `/api/archive/packs?char=`（「该角色的全部配队」也用它的缓存），
   * 所以点开一个窗口最多只多发一次请求；`unit.key` 在两个接口里是同一个整包键，
   * 按它精确命中。
   * 取不到 / 没命中就**保持现状**（宁可少列几个关卡，也不要空窗或报错）。
   */
  const enrichTipDetail = async (tip) => {
    const unit = tip?.__unit;
    if (!unit) return;
    // 三件事都靠**同一个** `/api/archive/packs?char=` 的载荷（有缓存，一个窗口最多多发一次）：
    //   ① 逐档榜那四页只带**最好那一关**的明细 → 补齐全部关卡；
    //   ② 泛用性的**来源名单**与三个分项的**归一上下限**只在这个接口上（不在 `/conclusion`，
    //      理由见 `src/server/conclusion.js` 里 `slimFrontierUnit` 那段「为什么不上榜」）；
    //   ③ **来源视频**（用户 2026-10-14 第 6 条）：`/conclusion` 只给逐档榜的头条那一支带它
    //      （600 KB 硬上限，见 `slimFrontierUnit` 的 env 投影），总榜那条路要在这里补回来。
    /**
     * ⚠️ **「明细齐不齐」不再只看条数**（2026-10-17，v4.6.120）。
     *
     * `/conclusion` 那份载荷的队友名单 `members` **只给头条那一支**了（其余 4 关省下来
     * 的 87.8 KB 是用来把载荷压回 660 KB 护栏内的，见 `src/server/conclusion.js` 的
     * `slimFrontierUnit`）。
     * 而**总榜**那 81 条的 `envs` 条数本来就是齐的（5 关全给），只看条数的话
     * `needEnvs` 恒为 false、整份替换那支走不到 —— 详情窗口就只剩头条那一支队伍。
     * 所以再加一条：**缺 `members` 也要去按需取**。
     *
     * 取不到时不会空窗：详情窗口照旧走「名次靠后：未展开队友名单」那条兜底文案。
     */
    const envsHere = unit.envs || [];
    const needEnvs = Number(unit.envCount) > envsHere.length
      || envsHere.some((env) => !Array.isArray(env.members));
    const needVersatility = !Array.isArray(unit.versatilityMembers);
    const needVideo = envsHere.some((env) => !env.video);
    if (!needEnvs && !needVersatility && !needVideo) return;
    const hit = await fetchPacks(unit.name);
    // ⚠️ **取过就记一笔**（`frontierTip` 的「未展开队友名单」脚注要看它）：
    //    `/conclusion` 2026-10-17 起只给头条那一支带 `members`，未补齐的窗口里
    //    其余关卡一律「没有队友」，不记这一笔的话那条脚注会在**补齐之前**先闪一下错话。
    unit.__packsTried = true;
    if (!hit) return;
    let learned = false;
    if (hit.frontierExtents) {
      // 面板这条路可能没加载过结论 —— 记下来，`scoreBreakdownTable()` 会读它。
      state.packsFrontierExtents = hit.frontierExtents;
      learned = true;
    }
    if (needVersatility) {
      // ⚠️ **按档取名单**（用户 2026-10-14 第 1 条）：`versatilityByTier` 是这个角色的
      //    四份名单（按星魂目标档索引），窗口要用**这个整包自己那一档**那份。
      //    取不到该档时才退回老字段 `versatilityMembers`（老服务端 / 只有一个档的载荷）。
      if (hit.versatilityByTier) unit.versatilityByTier = hit.versatilityByTier;
      const mine = hit.versatilityByTier?.[String(eidolonTierOf(unit.eidolon))];
      if (Array.isArray(mine?.members)) {
        // 挂回整包对象上：`frontierTip()` 是从 `unit` 渲染的（与上面补 `envs` 同一条路）。
        unit.versatilityMembers = mine.members;
        learned = true;
      } else if (Array.isArray(hit.versatilityMembers)) {
        unit.versatilityMembers = hit.versatilityMembers;
        learned = true;
      }
    }
    const match = (needEnvs || needVideo)
      ? (hit.packs || []).find((p) => p.key === unit.key) || null
      : null;
    // ⚠️ 替换判据同样是「**更多** **或** 更全」：总榜那 81 条两边条数相等（都是 5 关），
    //    但 `/conclusion` 那份没有 `members`，而按需这份有（`slimCharacterPack` 给的名
    //    单还多带 `nameCn` / `icon` / `lcCn` / `lcIcon` —— 队伍卡片要的就是它们）。
    //    只比条数的话，条数相等的一律不会被换上来。
    if (needEnvs && match?.envs?.length
      && (match.envs.length > envsHere.length
        || match.envs.some((env) => Array.isArray(env.members)))) {
      // ⚠️ 这一支是**整份替换**：换进来的每一行本来就带着 `video`，所以不必再合并。
      unit.envs = match.envs;
      learned = true;
    } else if (needVideo && Array.isArray(match?.envs)) {
      /**
       * **来源视频的合并**（不是替换）。
       *
       * 总榜那条路上 `unit.envs` 已经是完整的（`envCount` 与实际条数相等），所以
       * `needEnvs` 为 false、整份替换那支不会走 —— 但它一个 `video` 都没有
       * （`/conclusion` 只给逐档榜带）。而**一个窗口最多 5 行**、一行一支队，只能逐行补。
       *
       * ⚠️ 命中判据必须用 **`id` + `evidenceSeason` 两把**：同一个副本在窗口里会出现多次
       *    （不同版本各一行），只按 `id` 匹配会把 4.5 的投稿视频贴到 4.6 那一行上 ——
       *    那正是界面最容易被指认成「数据错了」的地方。
       */
      for (const env of unit.envs || []) {
        if (env.video) continue;
        const src = match.envs.find((e) => e.id === env.id
          && e.evidenceSeason === env.evidenceSeason);
        if (src?.video) { env.video = src.video; learned = true; }
      }
    }
    // 只有真学到东西才重画（`learned === false` 时重画是白费，而且会让窗口闪一下）。
    if (learned) tip.replaceWith(frontierTip(unit));
  };
  const openTip = async (wrap) => {
    // 同一时刻只开一个：点第二行时第一行必须收掉（窗口也只有一个）。
    for (const other of container.querySelectorAll('.advice-value-wrap.is-open')) {
      if (other !== wrap) hideTip(other);
    }
    let tip = wrap.querySelector('.advice-value-tip');
    if (!tip) return;
    // ⚠️ **懒构建**（见 `lazyTip()`）：行渲染时这里只有一个空占位，第一次点开才真正建内容。
    // 必须在 `enrichTipDetail()` **之前**替换 —— 那个函数是拿 `tip.__unit` 干活的，
    // 而 `__unit` 是 `frontierTip(unit)` 建内容时挂上去的。
    if (typeof tip.__lazyBuild === 'function') {
      const built = tip.__lazyBuild();
      tip.replaceWith(built);
      tip = built;
    }
    // ⚠️ 补明细必须在**开窗之前**：窗口正文是固定尺寸、内容在里面滚，
    // 先开窗再换内容会让用户看到「一个关卡 → 五个关卡」跳一下。
    if (tip.__unit) {
      try { await enrichTipDetail(tip); } catch (err) {
        // ⚠️ **不要把这个异常悄悄吞掉**（2026-10-15 改）：这一段是「开窗前的按需补齐」
        //    （补全部关卡 / 补泛用性来源名单 / 补来源视频），它一抛，`enrichTipDetail()`
        //    末尾那次 `tip.replaceWith(frontierTip(unit))` 就整个不执行 ——
        //    界面上只表现为「有几个区块是空的」，看不出是这一步失败的。
        //    实测就是这么藏了一个 `ReferenceError: num is not defined`（见
        //    `versatilitySourceBlock()` 里那段注释）：窗口少列 4 个关卡、没有泛用性来源、
        //    队伍没有视频图标，而控制台**一片安静**。宁可打一行日志也不要静默降级。
        console.error('[advice] 补明细失败，窗口只显示已缓存的那部分：', err);
      }
      tip = wrap.querySelector('.advice-value-tip');
      if (!tip) return;
    }
    wrap.classList.add('is-open');
    wrap.setAttribute('aria-expanded', 'true');
    // 配队卡片按需构建（见 `teamSlot()`）：必须在**开窗口之前**建好 —— 窗口正文是固定的
    // 尺寸、内容在里面滚，先开窗再插卡片会让用户先看到一个空洞。
    // 用户 2026-10-11 第 5 条：队伍图标现在长在**表格第一格**里，一个窗口最多 5 个槽
    // （每个关卡一个），所以这里对**所有**空槽逐个填充。
    // 顺序遍历 + 每个 slot 自己的 `dataset.filled` 幂等守卫（`fillTeamCards` 里），
    // 重复点开同一个窗口不会把卡片插第二遍。
    for (const slot of tip.querySelectorAll('.advice-plan-team-slot')) fillTeamCards(slot);
    // 「该角色的全部配队」是**异步**的（要另发一次请求），填进来时窗口已经开着，
    // 内容直接长在窗口正文里 —— 不需要（也不能）再算坐标，见 `fillPackList()`。
    fillPackList(tip.querySelector('.advice-packs-slot'));
    openTipWindow(tip, {
      // 标题写总分那一行（「性价比得分 +293」），用户一眼知道这个窗口是谁的详情。
      title: tip.querySelector('.advice-value-tip-head')?.textContent || '角色得分详情',
      onClose: () => hideTip(wrap),
    });
  };
  /** 点已经开着的那个 = 收起来（点第二次关掉，符合用户对「点击」的预期）。 */
  const toggleTip = (wrap) => {
    // 关掉整个窗口（它自己会回调 `onClose` 摘掉 `.is-open`）。
    if (wrap.classList.contains('is-open')) closeTipWindow();
    else openTip(wrap);
  };
  const onClick = (event) => {
    // 窗口开着时，关闭**只**归窗口管（点背景 / 关闭按钮 / ESC）—— 见上面那段注释。
    if (isTipWindowOpen()) return;
    const wrap = event.target?.closest?.('.advice-value-wrap');
    if (wrap && container.contains(wrap)) {
      toggleTip(wrap);
      return;
    }
    // 其它任何地方 → 收起当前开着的那个（徽标状态而已，内容本来就不在页面上飘着）。
    const open = container.querySelector('.advice-value-wrap.is-open');
    if (open) hideTip(open);
  };
  // ⚠️ 绑在 **document** 上，不是 `container` 上：用户可能点页头 / 侧栏 / 别的分区，
  // 那些都在容器外面，绑容器上就收不起来（徽标会一直亮着）。
  document.addEventListener('click', onClick);
  // ESC 由窗口自己处理（窗口开着时这里短路，别抢）；这一条只管「窗口没开、但徽标亮着」
  // 这种残留状态（比如键盘聚焦后点了别处）。
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || isTipWindowOpen()) return;
    const open = container.querySelector('.advice-value-wrap.is-open');
    if (open) hideTip(open);
  });
  // 键盘：外面那层是 tabindex=0 的 span，Enter / 空格等价于点击（`role="button"` 已加上）。
  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    const wrap = event.target?.closest?.('.advice-value-wrap');
    if (!wrap || !container.contains(wrap)) return;
    event.preventDefault();   // 空格默认会滚页面
    toggleTip(wrap);
  });
  // ⚠️ **刻意不监听 `scroll`**：v4.6.59 之前这里会把全部浮层收掉，而那正是用户报的
  // 「窗口会自动关掉」。现在内容在固定的大窗口里（背后页面还锁了滚动），更不需要收。
  /**
   * 详情里的**就地折叠块**（用户 2026-10-13 第 8 条）。
   *
   * ## 为什么委托挂 `document` 上，而不是 `container` 上（本轮实测踩过）
   *
   * 这是本函数里**唯一**一个不能挂 `container` 的监听器，理由是结构性的：
   * 内容节点 `.advice-value-tip` 会被 `advice-tip-window.js` 的 `openTipWindow()`
   * **整体搬进**那个满屏窗口（`.advice-tip-body`）——`document.body > .modal > …`，
   * 而 `container` 是总榜列表 / 抽卡方案正文。窗口一开，这些按钮就**不再是 `container`
   * 的后代**了，`container` 上的监听器永远收不到它们的点击。
   *
   * 而用户**只会在窗口里点这些按钮**（窗口是满屏遮罩 + 锁定背后滚动），于是：
   * 按钮 hover 有反应、指针是手型、点下去什么都不发生，**且不报任何错**。
   * 本轮实测两次静默无效（先写 `container.contains()`、再改成 `document.contains()`），
   * 直到把探针挂到祖先链上打印 `getEventListeners()` 才看清
   * 「容器根本不是 `.modal` 的祖先」。
   *
   * ## 为什么必须**只接一次**（同一个坑的另一半，本轮同样实测踩过）
   *
   * `wireValueTips()` 会被调用**两次**（总榜 `#adviceConclusionUnits` 与抽卡方案
   * `#adviceTeamPlanBody`，各有各的 `dataset.tipsWired` 守卫）。若把这个监听器写在
   * 「每个容器各接一份」的地方，挂到 `document` 之后**点一次按钮两个监听器都会收到**
   * —— 而且没有哪一条判据能干净地分清「这个按钮归谁」（窗口里同一时刻只有一个
   * `.advice-value-tip`，`container.contains(tip)` 对两个监听器都是 false），
   * 于是两个监听器各翻一次状态：`aria-expanded` 被写成 `true` 又立刻写回 `false`，
   * **一次点击等于没点**（实测 `setAttribute` 的调用序列就是 `true` → `false`）。
   * 所以这里由一个**模块级**布尔量 `detailToggleWired` 保证全局只接一次 ——
   * 全局本来就只需要一个监听器（它处理的是页面上所有 `.advice-detail-toggle`），
   * 而它挂在 `document` 上、与「哪个容器是主人」这件事无关。
   *
   * 旧节点（切档 / 改权重把内容 `replaceWith` 换下来）的点击必须**无害地作废**：
   * 那种节点的 `isConnected` 为 false，`closest()` 仍能命中它，所以要显式判掉。
   *
   * `click` 由浏览器替我们做键鼠归一：真实鼠标、触摸、以及键盘在 `<button>` 上的
   * Enter/空格，都会派发一个 `click` —— 所以**不需要再写一份 keydown**。
   * （⚠️ 这一段与上面那条 `keydown` 互不影响：那条只认 `.advice-value-wrap`，
   *  折叠块是它的兄弟节点，不在徽标里。）
   *
   * ⚠️ **内容怎么找：走 `detailOf()`，不再直接 `parentElement.querySelector`**
   *   （2026-10-15）。用户要求「查看来源按钮与其它文字**同一行**」之后，分项表那三个
   *   按钮搬进了**分项行的第一格**，而它控制的内容仍在**下面那一行**里 —— 两者不再是
   *   父子关系（`parentElement.querySelector('.advice-detail')` 恒为 `null`，实测表现为
   *   「`aria-expanded` 变了、内容永远不出现」）。`detailOf()` 优先按按钮自己的
   *   `aria-controls` id 去找，找不到才退回旧写法；两处判断用的是**同一份**依据。
   */
  if (!detailToggleWired) {
    detailToggleWired = true;
    document.addEventListener('click', (event) => {
      const toggle = event.target?.closest?.('.advice-detail-toggle');
      if (!toggle || !toggle.isConnected) return;
      const detail = detailOf(toggle);
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (detail) detail.hidden = open;
      // ⚠️ **不做「同时只开一个」**：这是同一个数字内部的三项拆解，用户往往要对着
      //「强度来源」与「性价比来源」两张表互相验算 —— 强制互斥会把这件事变成三次点击。
      // （徽标那一层的「同一时刻只开一个窗口」是另一回事：那是窗口，不是展开项。）
    });
  }
};

/**
 * 某个角色的**全部压金配队**（用户 2026-10-10：「需要在每个角色的详细界面显示所有的
 * 配装的最佳证据的队伍，并分别给出性价比评分」—— 注意是在**性价比详情窗口**里看，
 * 不是角色面板；同一天第 6 条又把界面上这一节的标题改成「配队」）。
 *
 * 总榜按用户第 1 条**每角色只留一条**（怕强势角色霸榜），所以窗口里默认只能看到榜上那一条。
 * 这一节把**收敛前的全部配队**补上：同一个角色的 E0/E2/E6 × 各光锥 × 叠影，
 * 每条给出自己的性价比得分与它在各副本的最佳证据队伍。
 *
 * **按需取**（`GET /api/archive/packs?char=`）而不是随结论载荷一起下发：
 * 实测完整版 1.1 MB、紧凑版 544 KB，而 `/conclusion` 已经 0.67 MB 且 `e2e-test.mjs`
 * 有 600 KB 硬上限。全量带上等于为「点开才看」的东西把每次加载翻倍。
 * 一个角色一次实测 30 条 ≈ 85 KB，够快。
 *
 * 结果按角色缓存：同一个角色反复点开不该每次都让服务端重算一遍逐版本加权（单次 ~1s）。
 * 失败的**不缓存** —— 否则网络抖一下就再也刷不出来了。
 */
const packsCache = new Map();
const fetchPacks = async (charKey) => {
  const key = String(charKey || '').trim();
  if (!key) return null;
  // ⚠️ **缓存键必须含总榜权重**（用户 2026-10-11 报的 bug）：面板给的是「性价比得分」，
  // 必须与总榜徽标同口径。此前请求没带权重、缓存键也没有它，于是用户改了「总榜权重」
  // 后面板仍显示按**默认权重**算出来的旧分数（实测浮层 +399 / 面板 +725）。
  // 权重一变，缓存键就变 → 重新取一次；否则同一个角色会一直吃旧权重的那份结果。
  // **隐金设置同理**（同一天新增）：它也是总榜口径的输入，漏进缓存键会立刻复现同一个 bug。
  //
  // ⚠️ **抽卡权重也必须进**（用户 2026-10-13 第 2 条）：面板给的是**角色得分**，
  // 而它是「三个分项按抽卡权重加权的**榜内归一分**」—— 归一用的极值取自整张表，
  // 权重不同，同一个整包的面板分就会与徽标分不一致。
  //
  // ⚠️ **版本权重同理**（用户 2026-10-16 第 3 条）：面板里的「跨版本发挥」那一列
  // 按 `seasonWeights` 算，而它是服务端拿版本权重现算的 —— 漏进缓存键时用户改了版本
  // 权重、总榜重算了，点开角色详情却仍是旧权重那一份分（与上面两类完全同一个症状）。
  const weights = activeWeights('frontier');
  const wSig = Object.entries(weights).sort().map(([k, v]) => `${k}=${v}`).join(',');
  const hSig = hiddenCostsSignature();
  const dSig = drawWeightsSignature();
  const vSig = versionWeightsSignature();
  const cacheKey = `${key}|${wSig}|${hSig}|${dSig}|${vSig}`;
  const hit = packsCache.get(cacheKey);
  if (hit) return hit;
  try {
    const params = new URLSearchParams({ char: key });
    // 只有用户真的改过权重时才带上（空表 = 用默认口径，带上也没意义）。
    if (wSig) params.set('frontierWeights', JSON.stringify(weights));
    // 隐金设置：**只要有一项勾着就必须带**（接口默认是「一项都不减」），
    // 不带的话面板会按原价算，与榜上的分对不上。
    if (anyHiddenCostOn()) params.set('hiddenCosts', JSON.stringify(state.hiddenCosts));
    // 抽卡权重：接口默认 = 默认表（`4 : 5 : 1`），界面这把也**总是带**（它一定有值），
    // 免得用户调过之后面板仍按默认权重算（这类「权重没带过去」的 bug 修过两次）。
    params.set('drawWeights', JSON.stringify(normalizeDrawWeights(state.drawWeights || {})));
    // 版本权重（用户 2026-10-16 第 3 条）：接口默认 = 默认表，界面这把**总是带**
    // （它一定有值）—— 同上一条的理由，这类「权重没带过去」的 bug 已经修过两次。
    // ⚠️ 形状是**数组**（`normalizeVersionWeights` 返回长度 6 的数组），别发成对象。
    // ⚠️ **服务端 `/api/archive/packs` 那条路目前还不解析这个查询参数**（只有
    //    `/api/archive/conclusion` 吃它，见 `src/server/app.js`）。所以面板里的
    //    「跨版本发挥」仍按默认表算 —— 界面这条线已经发到位，缺的是路由那三行
    //    （解析 `versionWeights` → 透传 `archiveCharacterPacks` → `archiveFrontierAll`）。
    //    在那之前**缓存键仍然必须带它**：否则用户改完版本权重、点开角色详情，
    //    看到的是上一个权重的缓存，连「服务端没吃」这个事实都看不出来。
    params.set('versionWeights', JSON.stringify(normalizeVersionWeights(state.versionWeights || [])));
    const res = await fetch(`/api/archive/packs?${params.toString()}`,
      { headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => null);
    if (!data || data.ok !== true) return null;
    const value = {
      found: data.found !== false,
      packs: data.packs || [],
      envs: data.envs || [],
      // 泛用性的来源名单（用户 2026-10-13）：**只有这条按需接口下发它**（见
      // `src/server/conclusion.js` 里「为什么不上 /conclusion」那段注释）——
      // 所以详情窗口要渲染「泛用性来源」就必须走这个请求，
      // 与「全部配队」「逐档榜补明细」共用同一份缓存，不会多发请求。
      versatilityMembers: Array.isArray(data.versatilityMembers) ? data.versatilityMembers : null,
      // ⚠️ **2026-10-14 起名单按星魂档分份**（用户第 1 条）：`{ '0': {raw, members}, … }`。
      //    界面必须按**当前整包自己的档**取 —— `versatilityMembers`（老字段）只有
      //    `hit[0]` 那一档的，拿它给 E6 的窗口渲染会列出 E0 的队友。
      versatilityByTier: data.versatilityByTier && typeof data.versatilityByTier === 'object'
        ? data.versatilityByTier : null,
      // 三个分项的归一上下限：面板这条路上界面可能**根本没加载过结论**
      // （用户直接在「角色信息」页点开），所以它随包一起来。
      frontierExtents: data.frontierExtents || null,
    };
    packsCache.set(cacheKey, value);
    return value;
  } catch {
    return null;
  }
};

/** 「该角色的全部配队」那一节的**空槽**（内容等第一次点开才取回来建）。 */
const packsSlot = (charKey) => {
  if (!charKey) return null;
  const slot = text('span', 'advice-packs-slot');
  slot.__charKey = charKey;
  return slot;
};

/**
 * 把空槽填成「（角色头像）xx 的全部配队」清单。
 *
 * ⚠️ **异步**：内容要等服务端返回（实测 ~1s），所以窗口已经开着、内容回来时直接长进
 * 窗口正文里 —— v4.6.59 那次还要「补完再 `placeTip()` 重新量一次坐标」，现在内容在
 * 固定尺寸的大窗口里自己滚，**没有坐标可算**（`placeTip()` 已删，见上面的注释块）。
 *
 * ⚠️ **标题是「配队」不是「配装」**（用户 2026-10-10 第 6 条）：这一节列的其实是
 * 「角色 + 星魂档 + 光锥」这一**整包**（也就是一套配队），用户按他的读法叫它配队，
 * 界面上就跟着叫配队；内部字段仍叫 `pack` / `packs`（服务端载荷的键名不动）。
 *
 * ⚠️ **标题 2026-10-16 第 3 条改过**：由「该角色的全部配队」改成
 * **「（角色头像）xx 的全部配队」**（`xx` = 角色中文名）—— 用户要一眼看出**这是谁**的
 * 配队，不必回去看窗口标题。头像走 `iconUrlOf('char', …)` 与总榜同一套四级兜底；
 * 拿不到图时 `iconImg` 返回的节点会退化成 `.is-missing`（**保留占位尺寸**，见 CSS），
 * 所以这里**不能**因为拿不到图就少 append 一个节点 —— 否则标题会在异步图片到位时抖一下。
 */
const fillPackList = async (slot) => {
  if (!slot || slot.dataset.filled === '1') return;
  slot.dataset.filled = '1';
  const caption = text('span', 'advice-packs-caption');
  // 头像：`iconImg` 在**一个地址都解析不到**时返回 `null`（那是优雅降级，不是画空框）——
  // 所以这里必须自己兜一个同尺寸占位（与 `unitAvatar` 同一套写法），否则标题会在
  // 缺图标表时整块消失；拿得到地址、但图挂了的情况下 `iconImg` 已挂 `is-missing`。
  caption.appendChild(iconImg(iconUrlOf('char', slot.__charKey), 'advice-packs-avatar',
    cn(slot.__charKey), 'eager') || text('span', 'advice-packs-avatar is-empty'));
  caption.appendChild(text('span', 'advice-packs-caption-text',
    `${cn(slot.__charKey)} 的全部配队`));
  slot.appendChild(caption);
  const box = text('span', 'advice-packs-list');
  slot.appendChild(box);
  box.appendChild(text('span', 'advice-packs-loading', '正在读取…'));

  const hit = await fetchPacks(slot.__charKey);
  if (!hit) {
    box.innerHTML = '';
    box.appendChild(text('span', 'advice-packs-loading', '（读不到这个角色的配队列表）'));
    return;
  }
  box.innerHTML = '';
  // 排序按**角色得分**从高到低（用户 2026-10-10 第 6 条定的「按分降序」，2026-10-13
  // 第 2 条把这个指标改名为角色得分）。服务端 `byChar` 已按 `rankFrontier` 排过一遍，
  // 这里再排一次是**故意的**：客户端按自己收到的那份数据排，界面上那句
  // 「按角色得分从高到低」才不会因为哪天服务端的排序口径变了而变成假话。
  const list = [...(hit.packs || [])].sort((a, b) => unitRoleScore(b) - unitRoleScore(a));
  if (!list.length) {
    box.appendChild(text('span', 'advice-packs-loading', '（这个角色没有压金配队记录）'));
    return;
  }
  box.appendChild(text('span', 'advice-packs-count',
    `${list.length} 个配队 · 按角色得分从高到低`));
  // 副本元数据（判据线在里面）：这一节要把档位写成游戏内实际的量
  // （`0T` / `行动值 <300`），而判据线只随元数据下发 —— 见 `tierTextOf()`。
  const metaById = new Map((hit.envs || []).map((env) => [env.id, env]));
  // 只列前若干条：实测一个角色最多 59 个配队、208 张队友卡片，全铺开还是要滚很久。
  const CAP = 8;
  for (const pack of list.slice(0, CAP)) {
    box.appendChild(packRow(pack, metaById));
  }
  if (list.length > CAP) {
    box.appendChild(text('span', 'advice-packs-more',
      `另有 ${list.length - CAP} 个配队未列出（该角色共 ${list.length} 个）`));
  }
};

/** 逐关卡那一行的**字段部分**：档位 → `N 金` → `行动值 N` → `N 版本` → `贡献 +N`。
 *
 * 用户 2026-10-11 第 2 条曾要求「最佳证据的队伍」那一块也**逐关卡**给出「情况 + 贡献」，
 * 与「该角色的全部配队」（`packRow()`）那本来就是同一行，所以字段顺序与判空收敛到这一个
 * 函数里（各写一份的话，下面这类条件迟早只剩一处跟着改）：
 *   * `evidenceSeason` 与 `bestTeamGold` / `actionValue` 一样可能为 `null`
 *     （`Number(null) === 0`，直接拼会印出「0 金」，见 HANDOFF §4.4）；
 *   * 版本号只在**有**的时候写（不能编一个默认值顶上）。
 *
 * ⚠️ 现在**只剩一个调用点**：`packRow()`（「该角色的全部配队」里那一行）。
 * 用户 2026-10-11 第 5 条之后，「最佳证据的队伍」那一块连同它的
 * `.advice-team-env*` 说明行一起删了（图标搬进了表格第一格），所以 `cls` 目前只有
 * `advice-packs-env` 一个取值 —— 参数保留是因为这段逻辑本来就与类名前缀无关，
 * 将来再出现第二个消费方时不必重写；但**别**因为「只有一处用」就把它内联回 `packRow()`，
 * `tools/_probe-tier-text.mjs` 按 `.advice-packs-env-tier` 取数。
 */
const envFactsInto = (line, env, meta, cls) => {
  line.appendChild(text('span', `${cls}-tier`, tierTextOf(meta, env.tier)));
  if (Number.isFinite(Number(env.bestTeamGold))) {
    line.appendChild(text('span', `${cls}-gold`, `${env.bestTeamGold} 金`));
  }
  if (Number.isFinite(Number(env.actionValue))) {
    line.appendChild(text('span', `${cls}-av`, `行动值 ${env.actionValue}`));
  }
  if (env.evidenceSeason) {
    line.appendChild(text('span', `${cls}-season`, `${env.evidenceSeason} 版本`));
  }
  line.appendChild(text('span', `${cls}-value`, `贡献 +${packScoreText(env.value)}`));
  return line;
};

/** 全部配队清单里的一行：一个整包的性价比得分 + 它的最佳证据队伍。
 *
 * `metaById` 是 `/api/archive/packs` 随包发回来的副本元数据（`id → {tierLines, …}`）：
 * 档位要写成游戏内实际的量（`0T` / `行动值 <300`）就只能从这里拿判据线。
 * ⚠️ **不能**拿总榜那份 `frontierEnvs` 顶替 —— 面板是单个角色的按需请求，可能先于
 * 总榜加载完（总榜还在算的时候用户就点了徽标），那时 `frontierEnvMeta()` 会返回 null。
 */
const packRow = (pack, metaById) => {
  const row = text('span', 'advice-packs-item');
  const head = text('span', 'advice-packs-item-head');
  head.appendChild(text('span', 'advice-packs-eidolon', `E${Number(pack.eidolon) || 0}`));
  const cone = iconImg(iconUrlOf('cone', pack.lc), 'advice-packs-cone',
    cnCone(pack.lc), 'eager');
  if (cone) head.appendChild(cone);
  head.appendChild(text('span', 'advice-packs-cone-name', cnCone(pack.lc) || '无光锥'));
  // 用户 2026-10-10 第三轮：「名称必须带有叠影层数（S1-S5）」—— S1 也写出来，
  // 与总榜行（`packCostNode`）保持同一口径。改前是 `> 1 ? 'Sx' : ''`，S1 看不到层数。
  head.appendChild(text('span', 'advice-packs-superimp',
    `S${Math.max(1, Math.round(Number(pack.superimp) || 1))}`));
  // 「**成本** N 金」里的数字也走 `goldText()`（白色加粗）—— 与总榜行、方案行的花费
  // 同一套。⚠️ 标签 2026-10-16 第 3 条由「整包 N 金」改成「成本 N 金」：这一节里
  // 「成本」= 这一套配队**自己**要花几金（与方案卡片的「账面 N 金 / 补金 N 金」是两个数）。
  const gold = text('span', 'advice-packs-gold');
  gold.appendChild(text('span', '', '成本 '));
  gold.appendChild(goldText(Number(pack.gold) || 0));
  head.appendChild(gold);
  head.appendChild(text('span', 'advice-packs-score', `角色得分 +${packScoreText(unitRoleScore(pack))}`));
  row.appendChild(head);
  // 逐副本：这一条在哪些副本有分、最佳证据是哪支队伍。
  for (const env of pack.envs || []) {
    const line = text('span', 'advice-packs-env');
    line.appendChild(text('span', 'advice-packs-env-name', env.envLabel || env.id));
    envFactsInto(line, env, metaById?.get(env.id) || null, 'advice-packs-env');
    row.appendChild(line);
    // 队伍：头像 + 名字 + 星魂档 + 光锥（缩略，与上面那张大卡片同一套信息，少占地方）。
    if (env.members?.length) {
      const team = text('span', 'advice-packs-team');
      for (const m of env.members) {
        const card = text('span', 'advice-packs-team-card');
        const avatar = iconImg(iconUrlOf('char', m.char), 'advice-packs-team-avatar',
          cn(m.char), 'eager');
        if (avatar) card.appendChild(avatar);
        const info = text('span', 'advice-packs-team-info');
        info.appendChild(text('span', 'advice-packs-team-name', cn(m.char)));
        const tags = text('span', 'advice-packs-team-tags');
        tags.appendChild(text('span', 'advice-packs-team-tag', `E${Number(m.eidolon) || 0}`));
        if (m.lc) {
          const c = iconImg(iconUrlOf('cone', m.lc), 'advice-packs-team-cone', cnCone(m.lc), 'eager');
          if (c) tags.appendChild(c);
          tags.appendChild(text('span', 'advice-packs-team-tag', `S${Number(m.superimp) || 1}`));
        }
        info.appendChild(tags);
        card.appendChild(info);
        team.appendChild(card);
      }
      // **来源视频**（用户 2026-10-14 第 6 条）：「该角色的全部配队」里每一行也是一支队，
      // 所以图标要跟到底（用户原话是「界面上**每个**显示的队伍都要有一个图标」）。
      // ⚠️ 这一节的队伍走的是 `/api/archive/packs` 那份载荷（`slimCharacterPack` 逐关卡
      //    全给 `video`），与浮层主表那条路同源。取不到地址时不画。
      const video = videoLink(env.video);
      if (video) team.appendChild(video);
      row.appendChild(team);
    }
  }
  return row;
};

/**
 * 配队展示的「空槽」：窗口里**表格第一格**里那一关卡的队伍占位，**卡片等第一次点开才建**。
 *
 * ## 用户 2026-10-11 第 5 条（原话）
 * 「我希望角色的图标都放进表格内，节约空间也更高效」。
 *
 * 改前这一块在**表的上方**、逐关卡画「说明行 + 卡片行」，与表格里的
 * 关卡名 / 表现 / 金数 / 版本 / 贡献几乎逐字重复一遍（一个 5 关卡的条目光这一块就占
 * ~660px，而窗口总高才 900px）。现在卡片挂在**那一关卡表格行的第一格**里
 * （见 `frontierTip()` 的 `labelCell`），关卡信息只出现一次。
 * ⚠️ 因此 `check-advice-layout.mjs` 的次序断言也从「sub 里 team 在 table 之前」
 *    改成了「**每个表体行的第一格**里都有槽、槽里都有卡片」。
 *
 * 用户 2026-10 要求：窗口里要有**完整配队**且带图片。更早的实现只是 `notes` 里一行
 * 纯文字（`银狼LV.999 E2 + 欢迎来到银河城S1 + 爻光 E1 + …`）—— 谁是主 C、谁带的
 * 是哪把光锥，一眼看不出来，也认不出头像。
 *
 * ⚠️ **为什么只放空槽、不在这里就把卡片建出来**（实测数据）：
 * 总榜最多渲染 80 行，每行的详情带 4 名队友 × 2 张图 = 640 个 `img`；一次性全建出来时
 * 页面上有 **798 个 img 节点**，jsdelivr 直接开始丢请求 —— 实测同一批里有 3 张加载失败
 * （`character/1009.png`、`light_cone/21004.png`、`light_cone/24006.png`），而单独
 * `fetch` 同一个地址全是 200。而且那 640 张图平时是 `display:none` 的，白占内存。
 * 现在只在点开（`wireValueTips` 的 `openTip`）时建**当前这一个**窗口的卡片，
 * 页面上最多 160 个 `img`（80 行 × 头像 + 光锥图标）。**逐关卡多块之后这条约束只更强**
 * （一槽最多 4 张头像 + 4 张光锥，一个窗口最多 5 个关卡），所以卡片一律留在
 * `fillTeamCards()` 里建，`teamSlot()` 只许挂数据。
 *
 * ⚠️ 类名是 **`.advice-plan-team-slot`**（`feat/team-plan` 那一轮把占位槽从
 * `.advice-team-slot` 改成了这个名字，与「队伍方案」那一节同名）——两处各用各的上下文，
 * 选择器都要限定作用域（浮层里就用 `.advice-value-tip` 打头）。
 */
const teamSlot = (members, video = null) => {
  if (!members?.length) return null;
  const slot = text('span', 'advice-plan-team-slot');
  // 队友名单先挂在节点上（不必为此引入 Map：这个节点本来就是这一份数据的宿主）。
  slot.__members = members.slice(0, 4);
  // 来源视频（用户 2026-10-14 第 6 条）：与队友名单同源（同一个 env 的 `video`）。
  slot.__video = video || null;
  return slot;
};

/**
 * **来源视频**（用户 2026-10-14 第 6 条）：「界面上每个显示的队伍都要有一个图标，点击在
 * 新界面打开对应的 b 站/油管页面，类似黑塔网（不需要内嵌播放器）」。
 *
 * 两件事分得很清：
 *   * **平台判定** —— 只认 b 站与油管（数据里实测还有 tiktok / douyin 的少量投稿，
 *     它们不是用户点名的那两家，统一落到中性的 `video` 档，图标照样点得开）；
 *   * **平台名** —— 只用于 `title` / `aria-label`，**不写进可见文字**：图标旁边再挂一行
 *     「bilibili」会把队伍卡片挤宽，而悬停提示里说清楚就够了。
 *
 * ⚠️ 伪串（`douyin:<id>` / `tiktok:<id>`）不会走到这里 —— 服务端与 `advice.js` 的
 *    `videoUrlOf()` 已经统一挡掉了。这里仍然对 `new URL()` 失败做兜底：拿到坏地址时
 *    **不画图标**，绝不留一个点了没反应的东西。
 */
const VIDEO_PLATFORM_LABEL = { bilibili: 'bilibili', youtube: 'YouTube', video: '第三方视频站' };

/** 视频地址 → 平台键（`bilibili` / `youtube` / `video`）；地址非法时返回 null。 */
const videoPlatformOf = (url) => {
  let host = '';
  try {
    host = new URL(String(url)).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  if (!host) return null;
  if (host === 'b23.tv' || host === 'bilibili.com' || host.endsWith('.bilibili.com')) return 'bilibili';
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube';
  return 'video';
};

/**
 * 一个「来源视频」外链图标。`url` 取不到 / 非法时返回 `null`（调用方据此不画）。
 *
 * 用真 `<a target="_blank" rel="noopener noreferrer">` 而不是 `window.open()`：
 * 浏览器按用户点的是链接来处理（中键新标签页、右键复制地址、状态栏显示目标地址），
 * 而 `window.open()` 会被弹窗拦截器当成脚本开窗。
 *
 * 2026-10-15（用户原话：「b 站的视频按钮改为**小电视**，更美观」）：改前所有平台都是
 * 同一个 `▶` 三角，认不出点开的是哪个站。现在按平台给图形：
 *   * **bilibili** → 小电视（圆角机身 + 两根天线 + 两只「眼睛」）；
 *   * **youtube** → 圆角机身里一个实心播放三角；
 *   * 第三档（tiktok / douyin 等）保持原来的 `▶` —— 那两家的地址已被 `videoUrlOf()`
 *     当伪串挡掉，实际几乎不会落到这一档。
 *
 * ⚠️ **一律「描边 + 空心」而不是「实心块 + 同色圆点」**：图标只有 13px，实心块里的
 *    同色圆点在屏幕上是**看不见**的，整个图标会退化成一块纯色方块（上一版就是这样）。
 *    颜色**只由 CSS 的 `color` 给**（`.is-bilibili` 官方粉 / `.is-youtube` 官方红），
 *    SVG 里一个硬编码色值都没有 —— 换主题时不必改图形。
 *
 * `aria-hidden="true"`：外链自己已经有 `aria-label`（「来源视频 · bilibili（在新标签页
 * 打开）」），图形再报一次只会让读屏软件念重复的两遍。
 */
const VIDEO_ICON_SVG = {
  bilibili: '<svg viewBox="0 0 16 16" class="advice-team-video-icon" aria-hidden="true"'
    + ' fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"'
    + ' stroke-linejoin="round">'
    // 机身：圆角矩形。天线两根从机身顶边往**外上方**张开（b 站官方记号就是这个形状）。
    + '<rect x="1.9" y="4.7" width="12.2" height="8.3" rx="2.1"/>'
    + '<path d="M6.1 4.5 4.2 1.9"/><path d="M9.9 4.5 11.8 1.9"/>'
    // 两只「眼睛」：两条短竖线。
    + '<path d="M6.2 7.4v2"/><path d="M9.8 7.4v2"/>'
    + '</svg>',
  youtube: '<svg viewBox="0 0 16 16" class="advice-team-video-icon" aria-hidden="true"'
    + ' fill="none" stroke="currentColor" stroke-width="1.35">'
    + '<rect x="1.9" y="3.6" width="12.2" height="8.8" rx="2.6"/>'
    + '<path d="M6.7 6.2 10.2 8l-3.5 1.8z" fill="currentColor" stroke="none"/>'
    + '</svg>',
};

const videoLink = (url) => {
  const platform = videoPlatformOf(url);
  if (!platform) return null;
  const a = document.createElement('a');
  a.className = `advice-team-video is-${platform}`;
  a.href = String(url);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  const title = `来源视频 · ${VIDEO_PLATFORM_LABEL[platform]}（在新标签页打开）`;
  a.title = title;
  a.setAttribute('aria-label', title);

  const icon = VIDEO_ICON_SVG[platform];
  // ⚠️ 走 `innerHTML` 时浏览器会把 `<svg>` 放进 **SVG 命名空间**（HTML 解析器对
  //    `svg` 这个标签名有特例），所以不必自己写 createElementNS —— 纯静态字符串，
  //    没有任何用户数据进来，不存在注入面。
  if (icon) a.innerHTML = icon;
  else a.appendChild(text('span', 'advice-team-video-glyph', '▶'));

  return a;
};

/**
 * 把空槽填成配队卡片：每人一张小卡片 —— 角色头像 + 中文名 + `E{n}` + 光锥图标 + `S{n}`。
 *
 * `lc` 为 null 的成员（数据里没记光锥）**整块不显示**光锥那半 —— 画一个空框会让人
 * 以为「这个人的光锥是空的」，而数据里那只是「没有这项证据」。
 *
 * ⚠️ 这里**不画任何标题**：早先那句区块标题 `最佳证据的队伍`（`.advice-team-caption`）
 * 随「图标搬进表格」一起删掉了（用户 2026-10-11 第 5 条）—— 卡片现在紧跟在关卡名下面，
 * 它属于哪一行一目了然，再写一个标题只是占地方。这个函数只负责**卡片行**本身。
 *
 * 必须在**开窗口之前**调用（见 `wireValueTips` 的 `openTip`）：图片尺寸由 CSS 写死，
 * 所以插入完卡片的这一刻内容就是最终大小 —— 先开窗再插卡片的话，用户会先看到一个
 * 只有标题的空窗口。
 */
const fillTeamCards = (slot) => {
  if (!slot || slot.dataset.filled === '1') return;
  slot.dataset.filled = '1';
  if (!slot.__members?.length) return;
  const row = text('div', 'advice-team');
  for (const member of slot.__members || []) {
    const card = text('div', 'advice-team-card');
    // 窗口里的图用 eager（每次最多 8 张）：它们是点开那一刻才插进 DOM 的，
    // 懒加载会让用户先看到一片空位。
    const avatar = iconImg(iconUrlOf('char', member.char), 'advice-team-avatar',
      cn(member.char), 'eager');
    if (avatar) card.appendChild(avatar);
    const info = text('div', 'advice-team-info');
    info.appendChild(text('span', 'advice-team-name', cn(member.char)));
    const tags = text('div', 'advice-team-tags');
    tags.appendChild(text('span', 'advice-team-tag', `E${Number(member.eidolon) || 0}`));
    if (member.lc) {
      const cone = iconImg(iconUrlOf('cone', member.lc), 'advice-plan-team-cone',
        cnCone(member.lc), 'eager');
      if (cone) tags.appendChild(cone);
      tags.appendChild(text('span', 'advice-team-tag', `S${Number(member.superimp) || 1}`));
    }
    info.appendChild(tags);
    card.appendChild(info);
    row.appendChild(card);
  }
  slot.appendChild(row);
  // **来源视频**（用户 2026-10-14 第 6 条）：这支队的 b 站 / 油管投稿入口。
  // 摆在队伍那一行的**末尾**（不是每位成员各挂一个）—— 投稿是**整支队**一条，
  // 挂到某个人头上会被读成「这个人的视频」。取不到地址时 `videoLink()` 返回 null，不画。
  const video = videoLink(slot.__video);
  if (video) slot.appendChild(video);
};

/**
 * 「角色得分是怎么加出来的」——三个分项那张表（用户 2026-10-13 第 1、2 条）。
 *
 * 榜面那个数（`unit.characterScore`）是三个分项按**抽卡权重**加权的结果，而三个分项的
 * **原始量纲完全不同**（强度/性价比是 0~100 的分数，泛用性是一个「不同队友数」），
 * 所以加权前先在榜内 min-max 归一到 0~100。只给一个总分，读者看不出「它凭什么排这里」，
 * 这张表把三个分项、各自的原始量、归一后的得分与权重逐行摆出来。
 *
 * 列的含义：
 *   * **原始量** —— 强度是累计表现分（不含金数项）、性价比是原来的 `total`、
 *     泛用性是这个角色能通关的队伍里出现过的**不同队友个数**；
 *   * **得分** —— 上面那个原始量在榜内归一到 0~100 之后的值；
 *   * **权重 / 贡献** —— 抽卡权重（归一化后）与「权重 × 得分」，三个贡献相加 = 角色得分。
 *
 * ⚠️ 权重取**服务端回显的那一份**（`state.conclusion.drawWeights`），不是界面上的
 * `state.drawWeights`：前者是**实际生效**的归一化权重，后者可能刚拖动完还在防抖里，
 * 那一刻两者的比例会短暂不一致（用后者会让表里的权重乘不出上面的总分）。
 * ⚠️ 三个原始量都取不到时（合成夹具 / 老服务端）整张表返回 null —— 宁可不画，
 * 也不画一张全是 `NaN` 的表。
 */
/**
 * 三个分项的**归一上下限**（用户 2026-10-13：「给出强度、性价比、泛用性的完整得分来源」）。
 *
 * 它决定那张「分项 / 原始量 / 得分 / 权重 / 贡献」表里能不能写出
 * `得分 = 100 ×（原始量 − 最小）/（最大 − 最小）` —— 没有它就验算不了那 100 分。
 * ⚠️ 除法一律写**斜杠**：`check-advice-layout.mjs` 有一条**全窗口**判据禁止出现 `÷`
 *（用户 2026-10-11 原话「金数的符号改为斜杠，表示除以」）—— 它对整个浮层生效，
 * 不只看金数那一列，写 `÷` 会把那条判据判红（本轮实测踩过）。
 *
 * ⚠️ **两条路各有来源**（这是它唯一的复杂点）：
 *   * 总榜 / 逐档榜那条：`/conclusion` 载荷的顶层 `frontierExtents`；
 *   * 角色面板那条：界面**可能根本没加载过结论**（用户直接在「角色信息」页点开一张卡），
 *     所以 `fetchPacks` 随包带一份，由 `enrichTipDetail()` 记进 `state.packsFrontierExtents`。
 * ⚠️ 两份是同一个对象（服务端同一处算的），不会分叉。
 */
const frontierExtentsNow = () => state.conclusion?.frontierExtents
  || state.packsFrontierExtents || null;

/**
 * 成本口径要的 `availability`（「限定 / 常驻」「稀有度」那张表）。
 *
 * ⚠️ 2026-10-17 第 2 条之后它**在强度详情窗口里已经没有调用点**了 —— 那一格原本判
 * 「叠影档要不要金」（`coneCostOf()`），而叠影档属于已删除的投入项。留着它只为
 * 成本口径那边（`renderTeamPlan` 传给 `teamPlan()` 的同一份）不重复写一遍取法，
 * 不要为了「消灭未使用」把它删掉之后又在别处抄一份。
 */
const availabilityNow = () => state.conclusion?.availability || {};

/**
 * 由一个「查看来源」按钮找到**它控制的那一块**。
 *
 * 2026-10-15 新增。用户要求按钮与分项名**同一行**，于是分项表里的三个按钮搬进了
 * 分项行的第一格，而它控制的内容仍在**下一行**（`colspan="5"` 那一行）——
 * 两者不在同一棵子树里，`parentElement.querySelector('.advice-detail')` 恒为 `null`。
 *
 * 所以判断依据只有一个：按钮自己的 **`aria-controls`**（那本来就是「我控制谁」的
 * 无障碍契约，读屏软件也读它）。只有老结构 / 临时节点没有那个属性时才退回「同一个容器
 * 里找 `.advice-detail`」的旧写法。
 *
 * ⚠️ `advice-view.js` 的委托监听器与 `tools/check-advice-layout.mjs` 的探针必须用
 *    **同一套**找法：探针用 `parentElement` 而代码用 `aria-controls` 时，会出现
 *    「探针说折叠正常、用户点不动」这种最难查的分叉。
 */
const detailOf = (toggle) => {
  const id = toggle?.getAttribute?.('aria-controls');
  const byId = id ? document.getElementById(id) : null;
  if (byId) return byId;
  return toggle?.parentElement?.querySelector?.('.advice-detail') || null;
};

/**
 * **来源折叠块**的接线（用户 2026-10-13 第 8 条：「强度/性价比/泛用性三个得分项目，都可以
 * 点击后显示来源，节省界面的空间……补金推荐分的详情页也需要类似的显示效果」）。
 *
 * ## 为什么是这个形状
 *   * 一个 **`<button>`** 而不是「给那行 `tr` 挂 `onclick`」：按钮天生可 Tab、可回车/空格、
 *     自带 `disabled` 语义，而 `<tr>` 不是可聚焦元素（要自己补 `tabindex` + 假 `role`）。
 *     这与本文件里 `.advice-value-wrap` 那个徽标的做法一致（`role="button"` + 键盘处理），
 *     但徽标是 `<span>` 只因为它是**行内文字**里的一段；这里的开关是一个独立的控件，
 *     用真按钮更省事、也更难写错。
 *   * 显隐用 **`hidden` 属性**（不是某个 `.is-open` 类）：与三个大窗口的开关同一套写法
 *     （`advice-tip-window.js` / `advice-gold-modal.js` 都是 `el.hidden = true/false`），
 *     而且它同时是「不显示」与「不进可访问树」——只写 CSS 的话读屏软件仍然会念出折叠的内容。
 *     CSS 那边只需补一条 `[hidden]` 压过容器上的 `display`（见 `advice-tip-window.css` 的注释）。
 *   * `aria-expanded` / `aria-controls` **一一对应**：读屏软件靠这两个属性知道
 *     「这个按钮控制着哪一块、现在是开还是关」。id 由调用方给（每个窗口一整套，
 *     同一个窗口里可能同时存在多个折叠块 —— 比如抽卡方案里每一张卡都有自己的一个）。
 *
 * @param {object} options
 * @param {string} options.id 这一块的唯一 id（按钮与内容用 `${id}-toggle` / `${id}-detail`）。
 * @param {string} options.label 按钮文字。
 * @param {Node} options.node 展开后显示的内容。
 * @param {string} [options.extraClass] 给**按钮**补的类（按来源分色/微调用；见 .css）。
 * @returns {HTMLElement} 外层容器（`.advice-detail-box`）。
 */
const tipScoreDetails = ({ id, label, node, extraClass }) => {
  const box = text('span', 'advice-detail-box');
  const toggle = text('button',
    `advice-detail-toggle${extraClass ? ` ${extraClass}` : ''}`);
  // ⚠️ `type="button"`：不写的话按钮在 `<form>` 里的默认类型是 `submit`
  //（本页现在没有 form，但这类「客户端自己建的控件」迟早会被搬进别处）。
  toggle.type = 'button';
  toggle.id = `${id}-toggle`;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', `${id}-detail`);
  toggle.appendChild(text('span', 'advice-detail-caret', '▾'));
  toggle.appendChild(text('span', '', label));
  const detail = text('div', 'advice-detail');
  detail.id = `${id}-detail`;
  // 默认**全部收起**（用户第 8 条的第一句就是「节省界面的空间」）—— `hidden` 就是那个初值，
  // 不靠 CSS 的初始态：这样「折叠」这件事在 DOM 上就是真的，探针 / 读屏软件都读得到。
  detail.hidden = true;
  detail.appendChild(node);
  box.appendChild(toggle);
  box.appendChild(detail);
  return box;
};

/**
 * **内联版**「查看来源」按钮（用户 2026-10-15：「这些查看来源需要与其他文本位于同一行
 * （带有『查看来源』的按钮），以节省界面空间」）。
 *
 * 与 `tipScoreDetails()` 的区别只有**按钮住在哪里**：
 *   * `tipScoreDetails()` —— 按钮和内容同在一个 `.advice-detail-box` 里，按钮自己独占
 *     一行（「补金推荐分」那个窗口用它）。
 *   * 本函数 —— 按钮**返回给调用方**，由调用方塞进分项行的第一格（与分项名同一行）；
 *     内容仍由 `tipInlineDetailRow()` 挂到**下一行**（`colspan` 撑满整表，否则那张
 *     五六列的来源表会被第一列的宽度挤成一团）。
 *
 * 两者共用同一个委托监听器与 `detailOf()` 的找法，所以交互、键盘可达性、
 * `aria-expanded` / `aria-controls` 语义完全一致 —— 探针也只认这一套。
 *
 * @param {object} options
 * @param {string} options.id 这一块的唯一 id（按钮 `${id}-toggle` / 内容 `${id}-detail`）。
 * @param {string} options.title `title` 与 `aria-label`（三项都叫「查看来源」时，
 *   读屏软件与悬停提示得说清是哪一项 —— 光看那四个字分不出强度还是泛用性）。
 * @param {string} [options.extraClass] 给按钮补的类（按分项分色，见 .css）。
 * @param {string} [options.label] 按钮文字，默认「查看来源」。
 *   2026-10-15 起「补金推荐分」那张卡的按钮摆在标题行、旁边就是「补金推荐分 +N.1」，
 *   写「查看来源」会含糊（看哪个来源？），所以那一处传「查看分数来源」。
 * @returns {HTMLButtonElement}
 */
const tipInlineToggle = ({ id, title, extraClass, label = '查看来源' }) => {
  const btn = text('button',
    `advice-detail-toggle is-inline${extraClass ? ` ${extraClass}` : ''}`);
  // ⚠️ `type="button"`：不写的话按钮在 `<form>` 里的默认类型是 `submit`（同 `tipScoreDetails`）。
  btn.type = 'button';
  btn.id = `${id}-toggle`;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', `${id}-detail`);
  // 文字在前、插入符在后 —— 用 `▾` 一个字符而不是图标字体（项目无依赖）。
  // 朝向由 CSS 按 `[aria-expanded]` 旋转，这里不存第二份状态。
  btn.appendChild(text('span', 'advice-detail-inline-label', label));
  btn.appendChild(text('span', 'advice-detail-caret', '▾'));
  return btn;
};

/**
 * 内联版折叠块的**内容行**：`<tr class="advice-detail-row"><td colspan="N">…</td></tr>`。
 *
 * ⚠️ 默认 **`hidden`**（用户第 8 条的第一句就是「节省界面的空间」），且**内容必须包在
 *    `.advice-detail-box > .advice-detail` 里**：`.advice-detail` 是那个被开关的元素
 *    （`aria-controls` 指的就是它），而 `.advice-detail-box` 是它的外层容器 ——
 *    `check-advice-layout.mjs` 与 `.css` 都按这个结构认（少一层就会「探针说没折叠块、
 *    CSS 的 padding 落空」）。
 */
const tipInlineDetailRow = ({ id, node, colSpan }) => {
  const row = document.createElement('tr');
  row.className = 'advice-detail-row';
  const cell = document.createElement('td');
  cell.colSpan = colSpan;
  const box = text('span', 'advice-detail-box');
  const detail = text('div', 'advice-detail');
  detail.id = `${id}-detail`;
  detail.hidden = true;
  detail.appendChild(node);
  box.appendChild(detail);
  cell.appendChild(box);
  row.appendChild(cell);
  return row;
};

/**
 * 内联版折叠块的**普通块外壳**（不是表格）：`<span class="advice-detail-box">
 * <div class="advice-detail" hidden>…</div></span>`。
 *
 * 与 `tipInlineDetailRow()` 是**同一套折叠机制**的两副外壳，区别只有外壳形状：
 *   * `tipInlineDetailRow()` —— 造 `<tr class="advice-detail-row">`，专供「住在表格里」
 *     的分项按钮（内容要 `colspan` 撑满整表，否则会被第一列挤成一团）。
 *   * 本函数 —— 造一个普通块，专供**不在表格里**的按钮：补金推荐分那张卡的标题行、
 *     以及过渡档位 / 次选配队这几处（它们本身就是 `<div>` 排版，没有 `<tr>` 可用）。
 *
 * ⚠️ 两者产生的内容块结构**逐字相同**（`.advice-detail-box > .advice-detail[hidden]`，
 *    id = `${id}-detail`）：委托监听器、`detailOf()`、`.css` 的 `[hidden]` 压 display、
 *    以及 `check-advice-layout.mjs` 的探针都按同一个结构认 —— 少一层就会「探针说没折叠块、
 *    CSS 的内边距落空」。默认 **`hidden`**（用户第 8 条：「节省界面的空间」）。
 */
const tipInlineDetailBlock = ({ id, node }) => {
  const box = text('span', 'advice-detail-box');
  const detail = text('div', 'advice-detail');
  detail.id = `${id}-detail`;
  detail.hidden = true;
  detail.appendChild(node);
  box.appendChild(detail);
  return box;
};

const scoreBreakdownTable = (unit) => {
  const w = normalizeDrawWeights(state.conclusion?.drawWeights ?? state.drawWeights ?? {});
  if (!Number.isFinite(Number(unit.strengthScore))
    || !Number.isFinite(Number(unit.costScore))
    || !Number.isFinite(Number(unit.versatilityScore))) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const pct = (v) => `${(num(v) * 100).toFixed(0)}%`;
  const one = (v) => num(v).toFixed(1);
  /**
   * 折叠块 id 里的**作用域**（用户 2026-10-13 第 8 条）。
   *
   * ⚠️ 必须有它：`aria-controls` 指的 id 在整份文档里必须唯一，而这张表**同时存在多个实例**
   * ——总榜一个窗口、抽卡方案里每一张卡一个窗口，它们的窗口甚至可能先后打开过、
   * 内容节点都还挂在各自的徽标里（关窗只是把它搬回去，**不删**）。那时若 id 只按
   * 分项名生成（`adviceScoreDetail-strength`），后建的那一份就会与先前那份重名，
   * `aria-controls` 于是指到别人身上、读屏软件念错块。
   * 角色名在同一个窗口里是唯一的，所以用它做作用域；老载荷没有 `name` 时退回下标 `unit`。
   */
  const idScope = String(unit?.name || 'unit').replace(/[^\w-]/g, '-');
  /** 三个分项各自那一套 id（按钮 `${id}-toggle` / 内容 `${id}-detail`）。 */
  const detailIdOf = (key) => `adviceScoreDetail-${idScope}-${key}`;
  /**
   * 三个分项的**榜内归一上下限**（用户 2026-10-13：「需要给出强度、性价比、泛用性的
   * **完整得分来源**」）。
   *
   * ⚠️ 没有它，这张表就是**验算不了**的：`强度 96.2`（0~100 的分数）对 `得分 100`
   * 看起来还像回事，可 `性价比 1098.2` 对 `得分 96.2` 就完全对不上了 —— 因为中间还有
   * 一次**榜内 min-max 归一**没写出来。把区间补在「原始量」那一格的下一行之后，
   * 三个分项都能自己按 `100 × (原始量 − 最小) ÷ (最大 − 最小)` 验算。
   * 载荷没带 `extents` 时（老服务端 / 合成夹具）这一行只是不显示，其余照旧。
   */
  const extents = frontierExtentsNow();
  /**
   * 取一个分项的归一上下限。
   *
   * ⚠️ **泛用性要按整包自己的星魂档取**（用户 2026-10-14 第 1 条「不同星魂需要各自比较
   *    泛用性」）：算分用的是 `versatility.byTier[档]`，界面这里也必须取同一把尺子，
   *    否则窗口里写出来的 `得分 = 100 × (原始量 − 最小) / (最大 − 最小)` 与榜上的分对不上。
   *    取不到该档（老载荷 / 合成夹具）才退回整榜那一份。
   */
  const extentOf = (key, unit) => {
    let e = extents?.[key];
    if (key === 'versatility') {
      e = e?.byTier?.[String(eidolonTierOf(unit?.eidolon))] ?? e;
    }
    if (!e || !Number.isFinite(Number(e.lo)) || !Number.isFinite(Number(e.hi))) return null;
    return e;
  };
  /** 泛用性的原始量 2026-10-15 起是「加权队友数」（小数），另两个是 0~100 的分数（一位小数）。 */
  const rawText = (v, integer) => (integer ? num(v).toFixed(0) : num(v).toFixed(1));
  /**
   * 性价比那一格与标题句里的**刻度变换**（2026-10-17 第二轮加：`SCORING.costScorePower`）。
   *
   * 原始量跨 1623 倍，线性 min-max 会把 57.5% 的整包压到 10 分以下，所以算分时先开平方
   * 再归一（见 `advice.js` 里那个常量的注释）。**文案必须跟着 `power` 现算**：
   * 写死「开平方」的话，哪天把指数调回 1，这一句就变成假话，而读者会照着它验算。
   *
   * `power` 缺省（老服务端 / 合成夹具）当作 1 = 线性，与算分那边的兜底同一条。
   */
  const costPower = (() => {
    const p = Number(extents?.cost?.power);
    return Number.isFinite(p) && p > 0 ? p : 1;
  })();
  const costScaleText = () => {
    if (Math.abs(costPower - 1) <= 1e-9) return '';
    if (Math.abs(costPower - 0.5) <= 1e-9) return '原始量开平方后，';
    return `原始量取 ${costPower.toFixed(2)} 次方后，`;
  };
  const costValueText = () => {
    if (Math.abs(costPower - 1) <= 1e-9) return '原始量';
    if (Math.abs(costPower - 0.5) <= 1e-9) return '√原始量';
    return `原始量^${costPower.toFixed(2)}`;
  };
  /**
   * 三个分项各自的**来源块**（用户 2026-10-13 第 8 条）。
   *
   * ⚠️ 三个块都是**先建好、再决定要不要挂**：`strengthSourceBlock()` 与
   * `versatilitySourceBlock()` 在没有数据时返回 `null`（老载荷 / 名次靠后拿不到泛用性名单），
   * 而 `versatilityMembers` 在**点开窗口那一步**才由 `enrichTipDetail()` 补回来
   * （见那个函数的注释）—— 所以这里绝不能拿「现在有没有数据」当永久判据。
   * 拿不到的项**只是没有折叠块**（不给一个点了没反应的按钮），其余两项照旧可点。
   */
  // ⚠️ 2026-10-17（用户第 2 条：「角色总榜的强度/性价比/泛用性更名为角色强度/角色性价比/
  //    角色泛用性」）：这三个名字在**本窗口**里必须带「角色」前缀 —— 补金推荐那一侧
  //    已经改成「队伍强度 / 队伍性价比 / 队伍泛用性」，两个榜的分项**同名又会让人以为
  //    是同一个数**（它们确实是同一把尺子，但取的是不同的对象：整包 vs 一支队）。
  //    `title` 只进按钮的 `title` / `aria-label`（`查看角色强度来源`），跟着一起改。
  const partSources = [
    { key: 'strength', label: '角色强度', title: '角色强度来源', block: strengthSourceBlock(unit) },
    { key: 'cost', label: '角色性价比', title: '角色性价比来源', block: costSourceBlock(unit) },
    { key: 'versatility', label: '角色泛用性', title: '角色泛用性来源',
      block: versatilitySourceBlock(unit) },
  ];
  // 主表（下面那张 `.is-source`）由 `frontierTip()` 用 `tipBox.tableClass` 打上；
  // 三个分项行与它们各自的来源块只在这里、也只建一次 —— 各分项之间不再有第二份抄写。
  const rows = [];
  const details = [];
  for (const [name, why, raw, score, weight, key, integer] of [
    // ⚠️ 强度的 `why` 是**新口径**（2026-10-14 定；2026-10-16 把「哪一次成绩」改成
    //    「这一关最佳证据那一支队自己的行动值」，见 `advice.js` 的 `avBest` 注释）：
    //    不再是「打出来的成绩」这种含糊说法，而是「各关卡取该队自己的行动值 →
    //    按关卡权重加权平均」。这一格会被探针按文本判等（`check-advice-layout.mjs` 的
    //    `splitHeaders` / `tipFactor`），改它要同步那边。
    // ⚠️ 三个分项名带「角色」前缀（用户 2026-10-17 第 2 条）—— 与补金推荐那三行
    //    （「队伍强度 / 队伍性价比 / 队伍泛用性」）分开。`check-advice-layout.mjs` 的
    //    `SPLIT_LABELS` 逐字钉着这三个名字，改这里要同步改那边。
    ['角色强度', '各关卡取该队自己的行动值 → 按关卡权重加权平均', unit.strengthTotal, unit.strengthScore,
      w.strength, 'strength', false],
    ['角色性价比', '同成绩下金数越少越高', unit.total, unit.costScore, w.cost, 'cost', false],
    // ⚠️ 2026-10-16 第 3 条之后这个「为什么」必须写成**角色级的一个数**：
    //    「只看 E0/E1/E2、取平均、固定给所有档位」—— 改前写的是「本星魂档」（2026-10-14
    //    的「不同星魂各自比较」已被第 3 条推翻）。
    // ⚠️ 原始量仍是**双重加权**的（关卡权重 × 版本权重，缺投稿版本计 0），不再是整数并集
    //    —— 那份并集名单在「泛用性来源」折叠块里（`versatilityMembers`）。
    ['角色泛用性', 'E0/E1/E2 平均（限定的不同队友数，按关卡与版本权重加权，只算有投稿的副本）',
      unit.versatilityRaw, unit.versatilityScore, w.versatility, 'versatility', false],
  ]) {
    const e = extentOf(key, unit);
    // ⚠️ 强度是**绝对刻度**（0~100 就是原始量本身），没有榜内归一那一步 —— 对它写
    //    「（榜内 0 ~ 100）」既没用又会让人以为还有一次归一（用户 2026-10-14 的新口径）。
    const isAbsolute = key === 'strength';
    const source = partSources.find((p) => p.key === key);
    const row = [
      // ⚠️ 第一格仍然是 `tipFactor()` 造出来的 `.tip-stack`（两个 span），
      //    外面多包一层 `.advice-factor-cell` 只是为了把「查看来源」按钮摆到**同一行**的
      //    最右边（`justify-content: space-between`）。探针按 `.tip-main` 取分项名
      //    （见 `check-advice-layout.mjs` 的 `splitRowLabels`）—— 写死 `textContent`
      //    判等会连按钮上的「查看来源」一起读进去，改这里要同步那边。
      (() => {
        const cell = text('span', 'advice-factor-cell');
        cell.appendChild(tipFactor(name, why));
        // 有来源才给按钮：数据缺的那一项既没有块、也没有按钮（按钮点了没反应是最坏的一种）。
        if (source?.block) {
          cell.appendChild(tipInlineToggle({
            id: detailIdOf(key),
            title: `查看${source.title}`,
            extraClass: `is-${key}`,
          }));
        }
        return cell;
      })(),
      // 原始量那一格带出归一区间（见上面 `extents` 的注释）；强度那行写绝对刻度。
      // ⚠️ 泛用性的端点 2026-10-17 起是**组内 p5 / p95**（`versatilityExtentOf`），
      //    所以它不能写「榜内」—— 那三个字在这里是「全榜最小 / 最大」的意思，
      //    而这两个数已经不是极值了（照旧写会让读者验算出 >100 的分）。
      tipFactor(rawText(raw, integer),
        isAbsolute ? '（绝对刻度 0~100）'
          : (e
            ? (key === 'versatility'
              ? `（组内 5%~95% 分位 ${rawText(e.lo, integer)} ~ ${rawText(e.hi, integer)}）`
              : `（${key === 'cost' ? costScaleText() : ''}榜内 ${rawText(e.lo, integer)} ~ ${rawText(e.hi, integer)}）`)
            : '')),
      one(score),
      pct(weight),
      one(num(weight) * num(score)),
    ];
    rows.push(row);
    // ⚠️ 这里只记**这一行本身**与它的折叠块，**不记下标**：`tipTable()` 会在这些数据行
    //    之间插进 `is-total`，而下面的插入循环又是从后往前插的 —— 用下标回查
    //    （`body.children[row]`）一旦遇上「`<tr>` 里被塞了嵌套表格」这类结构，层级会整个
    //    错位（实测：三张来源表全被插进上一张来源表所在的那一行里，分项表因此长成
    //    21 行、外壳列名变成 16 个）。持有节点引用就与插入顺序无关。
    if (source?.block) details.push({ row, key, id: detailIdOf(key), block: source.block });
  }
  const box = text('span', 'advice-score-split');
  box.appendChild(text('span', 'advice-score-split-title',
    // ⚠️ 三个分项名带「角色」前缀（用户 2026-10-17 第 2 条）：与上面三行的分项名、
    //    与补金推荐那三行（「队伍×」）都要能一眼分开。
    '角色得分 = 角色强度 × 权重 + 角色性价比 × 权重 + 角色泛用性 × 权重'
    // ⚠️ 强度**不再榜内归一**（用户 2026-10-14 的口径）：它本来就是 0~100 的绝对刻度。
    //    这里必须分开说，否则读者会拿 min-max 那条式子去验算强度，永远对不上。
    + '（角色强度 = 绝对刻度 0~100；角色性价比：得分 = 100 ×（' + costValueText()
    + ' − 榜内最小）/（榜内最大 − 榜内最小）；'
    + '角色泛用性同式，但尺子取**所在组**（E6 组 / 低档组）的 5%~95% 分位，超出按 0 / 100 夹逼）'));
  const table = tipTable(
    ['分项', '原始量', '得分', '权重', '贡献'],
    rows,
    // 合计行写**整数 + 加号**：加号让这个数与徽标 / 头行那个数**逐字相同**
    // （同一个 `packScoreText`），而且与下面那张表（`frontierTip` 的 foot 也写成 `+N`）
    // 同一种写法 —— 两处不一致的话 `check-advice-layout.mjs` 的 `splitOk` 就得写特例
    // （实测踩过：表里是 `96`、头行是 `+96`，判等直接红）。分项那一列仍留一位小数。
    ['角色得分', '', '', '', `+${packScoreText(unitRoleScore(unit))}`],
    // ⚠️ 打上自己的 class（用户 2026-10-13 第 8 条）：这张表现在与**它自己那份来源表**
    // （性价比逐关卡表）同处一棵子树里，而探针（`check-advice-layout.mjs`）原来靠
    // `.advice-score-split .advice-value-tip-table` 选它 —— 那个选择器会先撞上
    // 「性价比来源」那个 `.advice-score-split`（它是折叠块里的**第一个**同名前缀块），
    // 于是「三个分项表的列名 / 4 行 / 合计 = 标题上的数」那三条**静默量到别的表**上。
    // 所以这张表必须有自己的标记，探针按 `.is-score-scale` 认它。
    'is-score-scale',
  );
  /**
   * 把三个来源块**插到各自那个分项行的下一行**（用户 2026-10-13 第 8 条，原话是
   * 「点击后在**该项下方**就地展开」）。
   *
   * 2026-10-15（本轮）：按钮从「独占一行」改成「住在分项行第一格里、与分项名同一行」，
   * 所以这里**只**负责内容行 —— 按钮已经由上面那一格建好了，事件由模块级的委托监听器管，
   * 这里不再逐个 `addEventListener`。
   * ⚠️ 上一版在这里给每个按钮又绑了一次 `click`：委托监听器**也会**收到同一次点击，
   *    于是同一次点击把状态翻两次（`aria-expanded` 写成 `true` 又立刻写回 `false`），
   *    实测表现为「按钮点了没反应」。**只留委托那一份。**
   *
   * ⚠️ 内容行**也是** `tbody tr`，所以探针数行数时必须排掉 `.advice-detail-row`
   *    （见 `check-advice-layout.mjs` 的 `dataTrs`，**改这里要同步改它**）。
   *
   * ⚠️ 插入用 **`tr.after(detailRow)` 且从后往前**（`details` 是 `[…].reverse()`）：
   *    从前往后插的话，插进第一名后面的那一行会让**后面几个分项行整体下移**，
   *    于是按先前记下的位置再插就落到了别人的行里。用节点引用 + 倒序插入与位置无关。
   */
  for (const { row, id, block } of [...details].reverse()) {
    const tr = table.querySelectorAll('tbody tr')[rows.indexOf(row)] || null;
    if (!tr) continue;
    // ⚠️ 5 列 = 上面那张表的列数；写成别的数会让折叠行自己撑宽表格。
    tr.after(tipInlineDetailRow({ id, node: block, colSpan: 5 }));
  }
  box.appendChild(table);
  return box;
};

/**
 * 「**强度**」这一项的完整来源（用户 2026-10-13 要求三项都给来源；2026-10-14 换了口径）。
 *
 * 用户 2026-10-14 的原话：「强度分应当围绕**行动值**决定，此角色参与的队伍，行动值越低则
 * 强度分越高，**仅取最少行动值**，若达成 **0 行动值通关**，则**成本越低越强**」，
 * 以及「按照已有的用户设置的关卡权重，**各自贡献**」。落地成这张表：
 *
 * ```
 *   某副本强度 = av == 0 → 100                                             ← 顶格档
 *                av > 0  → 95 × 判据线曲线(av)                              ← 第二档
 *   强度原始量 = Σ(关卡权重 × 某副本强度) / Σ(**全部**副本的关卡权重)   ← 缺副本按 0
 *   强度得分   = 原始量夹到 90 以下（除非本档自己在每一关都打出顶格档）
 * ```
 *
 * ⚠️ **2026-10-17 晚：金数彻底退出强度**（用户：「强度得分应仅考虑强度（不考虑别的，
 *    因此低难副本普遍能拿满分）」）。改前顶格档是 `100 × 该期最省金 ÷ 本队金数`、
 *    第二档封顶是 `min(90, 100 × 该期最省金 ÷ 该期最贵金)` —— 两处都在按成本折分，
 *    18 金的 E6 队在「1 金就能 0 行动值」的混沌 / 虚构里只能拿个位数。现在强度只回答
 *    「打得多快」，成本只影响**性价比**那张表。
 * ⚠️ **2026-10-17 第 2 条整条重做过**（用户：「角色/队伍强度与成本**改为无相关性**，
 *    不需要遵守高造价必然等于高强度」）。改前最后还有两步 ——
 *    「同角色低档位救高档位」的单调兜底，与一个 5 分的投入加成（顶格档按压金度、
 *    其余按投入档位）—— 两步**都删了**：星魂档与叠影档就是成本，留着它们等于把
 *    「高造价必然等于高强度」又请回来。实测删之前真珠 E0/E1/E2/E6 四档强度分
 *    **全部等于 73.33**（= E0 自己的分），强度列读不出任何档位差异。
 * ⚠️ **2026-10-17 晚新增「继承」**：已登场却缺证据的版本，若同角色有**成本更低且
 *    那一期有成绩**的整包，就取它们的**最高分**（见 `advice.js` 的
 *    `cheaperPoolBySeason`）。依据是用户那句「人们一般不会上传低难度关卡用超高成本
 *    通关的记录」—— 继承来的分会在下面单独写一句，别让读者以为它有自己的投稿。
 * ⚠️ 金数与行动值都取**卡片上「最佳证据」那一队**（`observed` 行）：用户 2026-10-16
 *    报过「卡片写着绝境 26 金 · 457 行动值、强度却是 100」，所以强度必须与那个数同源。
 *
 * ⚠️ 分母是**全部**副本的权重和：缺副本按 0 计。改前那版除以「有数据的副本」，实测奖励
 * 了数据少的整包（绝境覆盖率 36/77 → 1/77），见 `advice.js` 里 `strengthTotal` 那段注释。
 * ⚠️ **抽卡方案**里那条 `avSource`（行动值前沿池）的分母**故意不同**：它只对「比本队打过的
 * 任何一关都更轻」的缺关卡免罚（v4.6.112），所以同一支队在两个榜上的强度分**不保证相等**
 * —— 方案那张表的刻度文案里写明了这件事。
 *
 * ⚠️ 这张表**不再有**「跨版本发挥」列：新口径**不跨版本平均**（用户要的是「仅取最少
 * 行动值」那一次成绩）。该列仍然保留在**性价比**那张表里 —— 那边确实按版本加权。
 */
const strengthSourceBlock = (unit) => {
  const envs = unit.envs || [];
  if (!envs.length) return null;
  const rows = envs.map((env) => {
    const meta = frontierEnvMeta(env.id);
    // ⚠️ `weight` 优先读 env 上的（按需载荷带），退回顶层 `frontierEnvs[].weight`
    //    （总榜载荷为了守住 600 KB 硬上限**不发** env.weight，见服务端 `slimFrontierUnit`
    //    里那段注释 —— 改前界面那一列因此恒印 `×0`，是个一直没人发现的历史 bug）。
    const weight = Number(env.weight ?? meta?.weight) || 0;
    const strength = Number(env.envStrength);
    // ⚠️ 2026-10-18：强度来源表读**强度那一档自己的行动值**（`strengthAv`），
    //    不是卡片那一行的 `avBest`。两者可能不是同一支队伍 —— 卡片按含金数项挑
    //    （最划算），强度按打得最快挑；老载荷没有 `strengthAv` 时退回 `avBest`。
    const av = Number(env.strengthAv ?? env.avBest);
    // ⚠️ `env.strengthGold` **不再读**：强度已与金数无关（用户 2026-10-17 晚），
    //    这一列不再印「（N 金）」，留着变量只会让人以为它还在参与算分。
    // 「是否达到满分线」优先读载荷给的（按需载荷带）；总榜载荷没带时按 `av ≤ 满分线`
    // 现算一次 —— 判据线与 `avLinesOf` 同源，都在顶层 `frontierEnvs[].tierLines` 里。
    const lines = meta?.tierLines || null;
    const perfectLine = Number(env.perfectLine
      ?? (lines ? avLinesOf(lines, meta?.lowerIsBetter !== false).perfect : Number.NaN));
    const isPerfect = env.isPerfect === true
      || (Number.isFinite(av) && Number.isFinite(perfectLine) && av <= perfectLine + 1e-9);
    // ⚠️ 2026-10-18：整关继承来的分（这一档在这一副本**一条自己的投稿都没有**）——
    //    行动值那格写「继承」，不印出借那个整包的行动值（否则会读成「这是它自己打出来的」）。
    const inheritedEnv = env.inheritedEnv === true;
    const avText = inheritedEnv
      ? '继承'
      : (Number.isFinite(av)
        ? `行动值 ${Number.isInteger(av) ? av : av.toFixed(1)}`
        : '—');
    // 「0 行动值通关」那一段。
    // ⚠️ 2026-10-17 晚起**不再印金数**：强度已经与成本无关（用户「强度得分应仅考虑
    //    强度」），还写「（26 金）」会让读者以为这一格是按金数折过的 —— 改前确实折，
    //    现在不折。金数在**性价比**那张表里看。
    // ⚠️ 措辞不能用「满分/达标/及格」——`herta-test.mjs` 有一条全源码判据盯着这类自造词
    //    （用户 2026-10-10：「把『满分』『达标』改为具体的行动值」）。所以这里说「判据线」。
    // ⚠️ 2026-10-15（用户报「老队伍的强度得分过高」后）：这一列的行动值改成取**最近版本**
    //    的那一次成绩，所以**必须把版本写出来** —— 否则读者会以为它还是「窗口内最快的那次」，
    //    拿两三版前的旧 0 行动值来对账。版本缺失（老载荷）时不写，不编。
    const avNote = [
      inheritedEnv ? '同角色更低成本配装的分' : '',
      inheritedEnv ? '' : (Number.isFinite(av) && av === 0
        ? '0 行动值通关'
        : (isPerfect ? '已达判据线' : '')),
      env.strengthSeason ? `${env.strengthSeason} 版本` : '',
    ].filter(Boolean).join(' · ');
    return [
      tipEnvLabel(meta?.label || env.envLabel || env.id, env.evidenceSeason),
      Number.isFinite(av) ? tipFactor(avText, avNote) : '—',
      Number.isFinite(strength)
        ? tipFactor(`${strength.toFixed(1)}`, isPerfect && av > 0 ? '已达判据线' : '')
        : '—',
      `×${formatWeight(weight)}`,
      tipChain([`${Number.isFinite(strength) ? strength.toFixed(1) : '—'}`, `×${formatWeight(weight)}`],
        `+${packScoreText(env.envStrengthValue)}`),
    ];
  });
  const box = text('span', 'advice-score-split');
  box.appendChild(text('span', 'advice-score-split-title',
    '角色强度来源：逐关卡取**这一关最佳证据那一支队**最近的行动值（同一支队里取最快的一次），'
    + '再按你设的关卡权重各自贡献'));
  box.appendChild(tipTable(
    // ⚠️ 2026-10-17：第 4 列原名「权重」，与**三分项表**里那一列同名不同义 ——
    //    那边是**抽卡权重**（印成百分比），这边是**关卡权重**（印成 ×N）。同一个窗口里
    //    两把尺子共用一个表头，读者只能靠脚注兜底，所以这里显式叫「关卡权重」。
    ['关卡', '行动值（这支队自己）', '本副本强度', '关卡权重', '贡献'],
    rows,
    // 合计 = `strengthTotal`（三个分项表里「强度」那一行的**原始量**），不是角色得分。
    // 单副本时它就是那一列本身，不必再写一行（与性价比表同一条约定）。
    // ⚠️ 2026-10-17：合计行改成 `+N`（`packScoreText`），与**本表「贡献」列**以及性价比
    //    来源表的合计行同一种写法。改前这里是一位小数且不带加号（`91.6`），而它自己那一列
    //    是 `+28` 这样的整数 —— 同一列两种格式，读者想逐行加总对账时根本对不上。
    envs.length > 1
      ? ['本档自身合计', '', '', '', `+${packScoreText(unit.strengthTotal)}`] : null,
    // ⚠️ 打上自己的 class：浮层里现在有**三张**表（三个分项 / 强度来源 / 性价比来源），
    //    `check-advice-layout.mjs` 的探针按 class 选表 —— 不给这张加标记，
    //    它就只能按下标猜，而「按下标取」在这类探针里是假红的常客。
    'is-strength-source',
  ));
  // 继承来的分（用户 2026-10-17 晚）要在下面两处脚注里用到，先取出来。
  const inheritedSeasons = Number(unit.inheritedSeasons) || 0;
  box.appendChild(text('div', 'muted small advice-source-note',
    (inheritedSeasons > 0
      ? '上表每一格是**这一关的版本加权强度**（某一版没有本档自己的成绩时，'
        + '按同角色更便宜的整包补，见下）；'
      : '上表**每一格都是这一档自己那支队的成绩**（行动值 → 该副本强度，'
        + '再按关卡权重加权平均；')
    + '行动值下面那行小字就是它的版本）。'
    // ⚠️ 2026-10-18 起这里**恒等**：单调包络（2026-10-17 删）与整维 90 天花板
    //    （2026-10-18 删，用户报「前排普遍不够强」）都不在了，榜上那个强度分就是上表
    //    的合计；逐关卡的第二档上限 95 仍在上表每一格里体现。
    + '榜上那个强度分就是上表的合计（逐关卡的第二档上限 95 已在表内体现）。'));
  /**
   * ⚠️ 2026-10-18：**整维天花板已删除**，这里不再写「本档被 90 压下来」那条小字。
   *    逐关卡的第二档上限仍然有效（表里每一格都体现），但整包分不再夹第二刀 ——
   *    用户报的「前排角色普遍不够强」就是那一刀造成的（一整排并列 90.0）。
   *    因此 `strengthFloor` 与 `strengthTotal` 恒等，这条分支永远不会成立；
   *    留着 `floor` 的读取只会误导后来的读者，一并删掉。
   */
  /**
   * 顶格档说明（用户 2026-10-17 第 2 条；2026-10-17 晚金数退出强度后简化）。
   *
   * 现在顶格档**只由行动值决定**：每一关都打出 0 行动值 → 每关 100 → 合计 100。
   * 改前还要求「且都取到那一期的最省金」，那条随「强度只看行动值」删除了。
   */
  if (Number(unit.strengthTotal) >= 99.99) {
    box.appendChild(text('div', 'muted small advice-source-note',
      '顶格档：本档在**每一个有数据的关卡**都打出了 0 行动值，所以每关都是 100、'
      + '合计就是 100 —— 其余任何情况都必须低于 100。'));
  }
  /**
   * 继承说明（用户 2026-10-17 晚）。
   *
   * 高成本整包在低难副本上往往**一条投稿都没有**（用户原话：「人们一般不会上传低难度
   * 关卡用超高成本通关的记录」）。这些版本现在从「同角色更便宜且有成绩」的整包继承
   * 最高分，所以这一档的分可能**大于**它自己的投稿数能解释的量 —— 必须写出来，
   * 否则读者对着来源表逐行找，会发现有几版根本没有对应的成绩。
   */
  const inherited = inheritedSeasons;
  if (inherited > 0) {
    box.appendChild(text('div', 'muted small advice-source-note',
      `其中 ${inherited} 个「已登场但没有本档自己的成绩」的版本，分是从**同角色更便宜的`
      + '整包**继承来的（取它们那一期的最高分；这一列对金数不作惩罚）。'));
  }
  return box;
};

/**
 * 「**泛用性**」这一项的完整来源（用户 2026-10-13 第 3 条 + 2026-10-14 第 1 条
 * + 2026-10-17 第 1 条）。
 *
 * 这一项的原始量不是分数而是一个**集合的大小**，所以它的「来源」就是把那个集合**列出来**：
 * 这个角色在**能通关**队伍里出现过的**不同队友**（不含「不用抽就有」的那些）。再补一句
 * 归一换算，读者就能从名单一路验算到榜上那个 0~100 的分。
 *
 * ⚠️ **口径 2026-10-17 第 1 条起分成两组**（用户原话：「E6 角色应当仅与 E6 做比较，
 *    E0/1/2 与 E0/1/2 之间做比较（避免不同量级之间的比较）」）：
 *    * **E6 档** → 名单是 **E6 自己那一份**（E6 配装见过的队友），刻度取 E6 组那把；
 *    * **E0/E1/E2 档** → 名单是**三档队友的并集**（与算分用的低档组原始量同源），
 *      刻度取低档组那把。
 *    所以标题必须按档换说法 —— 写死「E0/E1/E2 并集」会让 E6 的窗口印出一份与得分
 *    对不上的名单（实测踩过：E6 窗口里列着 E0 的队友，读者拿它验算当场对不上）。
 *    （2026-10-14~15 按档各一份；2026-10-16 全局一份；两条都已被第 1 条推翻。）
 * ⚠️ 名单只对**前 `FRONTIER_DETAIL_ROWS` 条**下发（`slimFrontierUnit` 里那一段）：
 * 排后面的条目这里拿不到名单，**如实返回 null**（那一格不画），不要伪造一行「—」。
 * ⚠️ 开拓者各命途在数据集里是**不同的英文键**，原样列出来会看到 5 个开拓者 ——
 * 脚注必须说明「算同一个人」，否则读者会以为榜单数错了。
 */
const versatilitySourceBlock = (unit) => {
  const tier = eidolonTierOf(unit.eidolon);
  const isE6 = tier === 6;
  // ⚠️ 按档各取一份（2026-10-17 第 1 条：E6 一份、E0/E1/E2 一份）。
  //    `enrichTipDetail` 会把结果写进 `unit.versatilityMembers`，这里仍按档取一次只为兼容
  //    老载荷（那时只有一份）；取不到时退回 `unit.versatilityMembers`。
  const mine = unit.versatilityByTier?.[String(tier)];
  const members = Array.isArray(mine?.members) ? mine.members : unit.versatilityMembers;
  if (!Array.isArray(members) || !members.length) return null;
  // ⚠️ **验算公式必须用整包自己的原始量**（`unit.versatilityRaw`）。
  // 名单与原始量是两个量纲，标题分开说。
  const whole = frontierExtentsNow()?.versatility;
  // `byTier[6]` = E6 组那把；`byTier[0..2]` = 低档组那把（与 `lo`/`hi` 同值）。
  const e = whole?.byTier?.[String(tier)] ?? whole;
  const groupLabel = isE6 ? 'E6 自己的队友' : 'E0/E1/E2 三档队友的并集';
  const box = text('span', 'advice-score-split');
  box.appendChild(text('span', 'advice-score-split-title',
    `角色泛用性来源：这个角色在**能通关**的队伍里搭配过的不同队友（${groupLabel} ${members.length} 个）`));
  // 名单做成**一个个 span**（不是一整串文本）：① 分隔符不会与名字里的「•」混在一起；
  // ② CDP 探针可以按元素数数，不必去猜分隔符（实测角色名里确实有「•」这种点）。
  const list = text('div', 'advice-vtip-members');
  members.forEach((key, i) => {
    if (i) list.appendChild(text('span', 'advice-vtip-sep', '·'));
    list.appendChild(text('span', 'advice-vtip-member', cn(key)));
  });
  box.appendChild(list);
  box.appendChild(text('div', 'muted small advice-source-note',
    Number.isFinite(Number(e?.lo)) && Number.isFinite(Number(e?.hi))
      // ⚠️ 除法符号写**斜杠**、不写 `÷`：用户 2026-10-11 的原话是「金数的符号改为斜杠，
      //    表示除以」，而 `check-advice-layout.mjs` 有一条**全窗口**断言禁止出现 `÷`
      //    （改前写 `÷` 实测把那条判据判红了 —— 它对全窗口生效，不分哪一格）。
      // ⚠️ 验算用的是**这个整包自己**的加权原始量（见上面的注释），不是档里最大的那个。
      // ⚠️ **这里不能用 `num()`**（2026-10-15 修的线上级 bug）：`num()` 只是
      //    `scoreBreakdownTable()` **内部的局部函数**，本函数是模块级函数、取不到它 ——
      //    于是这一行抛 `ReferenceError: num is not defined`。而调用它的那条链
      //    （`enrichTipDetail()` → `tip.replaceWith(frontierTip(unit))`）外面套着
      //    `catch {}`，异常被吞掉，**整次重建被放弃**：界面上只看到「泛用性来源没有」
      //    「来源视频没有」「逐档榜只有一个关卡」这三件看似无关的事，
      //    而真正的原因（这一行抛异常）在任何地方都不会被印出来。改用与相邻两行同一套
      //    `Number()` 写法，并给那个 `catch` 加上日志（见 `openTip` 里那一处）。
      ? `得分 = 100 ×（${(Number(unit.versatilityRaw) || 0).toFixed(1)} − ${Number(e.lo).toFixed(1)}）`
        + `/（${Number(e.hi).toFixed(1)} − ${Number(e.lo).toFixed(1)}）`
        + ` = ${(Number(unit.versatilityScore) || 0).toFixed(1)}`
        // ⚠️ 不能说「榜内最小 ~ 最大」：2026-10-17 起端点是**组内 p5 / p95**
        //    （`versatilityExtentOf`），超出区间的原始量被夹到 0 / 100。
        //    照旧写「最小 ~ 最大」会让读者拿最高分角色验算出 >100，以为算错了。
        + '（组内 5%~95% 分位，超出按 0 / 100 夹逼）'
      : '（本次载荷没带榜内区间，所以只能看上面的原始量。）'));
  box.appendChild(text('div', 'muted small advice-source-note',
    '开拓者的各命途算**同一个人**（否则一个开拓者会被数成 5 个不同队友）；'
    + '**不用抽就有**的角色（4★ 之外的常驻 5★ / 开拓者 / 大隐金）不算队友 —— '
    + '谁都能配的组合量不出「百搭」；'
    + (isE6
      ? 'E6 只与 E6 比较，所以这里列的是 **E6 自己**见过的队友。'
      : 'E0/E1/E2 只与 E0/E1/E2 比较，所以这里列的是**三档的并集**。')));
  return box;
};

/**
 * 「**性价比**」这一项的逐关卡来源表（用户 2026-10-13 第 8 条：它现在长在三个分项表的
 * 「性价比」那一行**下面**的就地折叠块里，见 `scoreBreakdownTable()`）。
 *
 * 口径与 `frontierTip()` 里那张主表**逐字同一套**（同一个 `frontierFactorsOf()`、
 * 同一个 `perfLabelOf()`、同一个 `tipChain()`）—— 所以这里**只有一份公式**，
 * 界面上不会出现「折叠块里一个数、主表里另一个数」。
 * 两处唯一的差别是**位置**：主表在窗口正文里、折叠块在这一行下方。
 *
 * ⚠️ `unit.envs` 为空时返回 `null`：`frontierTip()` 的主表也靠它渲染，
 * 这一份**不引入新的数据依赖**（不会出现「主表有行、来源块没有」）。
 */
const costSourceBlock = (unit) => {
  const envs = unit?.envs || [];
  if (!envs.length) return null;
  const rows = envs.map((env) => {
    const meta = frontierEnvMeta(env.id);
    const f = frontierFactorsOf(env, meta);
    // 用户 2026-10 要求：**贡献要写出真实的计算过程**，不再是光秃秃一个结果数。
    // 改前读者拿左边可见的因子直接相乘，只能得到 1/100 的数 —— 链子里那枚 `×100`
    // （`f.packScale`，也就是 `SCORING.frontierPackScale`）是隐形的。这里按**同一口径**
    // 把整条链连出来：
    //   权重 × 100 × 表现 × 金数 × 跨版本发挥 = 贡献
    //
    // ⚠️ 用户 2026-10-11 缺陷 3：**「档位」与「行动值」已合并成一项「表现」**
    // （`f.perfFactor`）—— 它们本是同一维度（档位由行动值推出），乘两次会把差距平方、
    // 并在判据线处跳变 2 倍。所以链子里**只写一项**，界面表里那两列合并成一列。
    const chain = [formatWeight(f.weight)];
    if (Number.isFinite(f.packScale)) chain.push(formatWeight(f.packScale));
    if (Number.isFinite(f.perfFactor)) chain.push(factorText(f.perfFactor));
    if (f.costFactor !== null) chain.push(factorText(f.costFactor));
    if (Number.isFinite(f.seasonFactor)) chain.push(factorText(f.seasonFactor));
    const contribution = `+${packScoreText(env.value ?? f.value)}`;
    // ---- 第一格：关卡名 + 版本小字 + **这一关卡的队伍图标**（用户 2026-10-11 第 5 条）----
    // 「角色的图标都放进表格内，节约空间也更高效」：改前图标在表**上方**那一整块里，
    // 与表格中的关卡名/表现/金数/版本/贡献逐字重复一遍；现在信息只出现一次。
    // ⚠️ 卡片仍然**等点开窗口时才建**（`teamSlot()` 只挂数据、`fillTeamCards()` 建：
    // 一次性建出来会到 798 个 img，jsdelivr 实测丢请求 —— 见 `teamSlot()` 的注释）。
    // ⚠️ 第一列的主值仍是**两级写法 + 版本小字**：`tipEnvLabel()` 按 `·` 拆行、
    // `env.evidenceSeason` 写版本（来源与「不能拿什么顶替」见 `tipEnvLabel()` 的注释）。
    const labelCell = text('span', 'tip-label-cell');
    // ⚠️ 关卡名走**三级兜底** `meta.label → env.envLabel → env.id`，与 v4.6.77 给
    // 「最佳证据的队伍」那块加的是同一条链：`frontierEnvMeta()` 查的是顶层
    // `frontierEnvs[].label`，一旦那份数据没到（或改口径时被省掉），只读它就会退回
    // `env.id`，窗口里立刻印出 `aa/plight` / `as` / `moc` —— 用户 2026-10-11 截图报的
    // 「这些英语简称我没要求添加」就是这么来的。v4.6.79 把卡片搬进表格时，那条兜底
    // 跟着被删的函数一起没了（实测：只读 meta 时关卡名就是英文 id），所以这里补回来。
    // `tools/check-advice-layout.mjs` 的 `stageNameCnOk` 仍然盯着「必须含汉字」。
    labelCell.appendChild(tipEnvLabel(
      meta?.label || env.envLabel || env.id, env.evidenceSeason,
    ));
    // 来源视频（用户 2026-10-14 第 6 条）随 `env` 一起交给队伍槽（见 `teamSlot()`）。
    const teamSlotNode = teamSlot(env.members, env.video);
    if (teamSlotNode) labelCell.appendChild(teamSlotNode);
    return [
      labelCell,
      // 权重 / 版本两列**保留** `×`：它们只有系数、没有原始量，乘号不连接任何东西，
      // 而且它正是「这是一枚乘数」的提示，与抽卡方案浮层的权重列写法保持一致。
      `×${formatWeight(f.weight)}`,
      // 2026-10-11：档位与行动值合并成**一列「表现」** —— 主值写游戏内量纲
      // （`0T` / `行动值 285`），副值写合并后的系数。原始量仍保留在浮层里，
      // 因为它回答「凭什么给这个系数」。
      tipFactor(perfLabelOf(meta, env, f), `（${factorText(f.perfFactor)}）`),
      // 金数那一列（用户 2026-10-11 第 2、3 条）：
      //   · 除号从 `÷` 改成**斜杠 `/`**（用户原话「金数的符号改为斜杠，表示除以」）；
      //   · **0 金通关**（隐金后有效队伍金数 = 0）不写 `分母/0`（那是无意义的），
      //     改成写「0 金」+ 那一枚固定倍率 —— 它就是 `frontierZeroGoldBonus`（×1.2）；
      //   · **被封顶**时补一个「封顶」字样：主值是原始两个金数（`7/1`）、副值是被封顶后的
      //     倍数（`1.00`），不标一下读者会以为「7 除以 1 怎么会是 1.00」（实测末日幻影 4.3
      //     就是这一格）。标了之后这一列每一格都能自圆其说。
      f.costFactor === null
        ? tipFactor('—')
        : (Number(f.cost) === 0
          ? tipFactor('0 金', `（×${factorText(f.costFactor)}）`)
          : tipFactor(
            `${f.minCost}/${f.cost}`,
            Number(f.minCost) > Number(f.cost)
              ? `（${factorText(f.costFactor)} 封顶）`
              : `（${factorText(f.costFactor)}）`,
          )),
      f.seasonFactor === null ? '—' : `×${factorText(f.seasonFactor)}`,
      tipChain(chain, contribution),
    ];
  });
  const box = text('span', 'advice-score-split');
  // ⚠️ 2026-10-17（配装口径，用户「走 A + D」）：`unit.total` 里多乘了一个
  //    **整包自身金数系数**（`ownGoldFactor` = 该角色最便宜整包金数 ÷ 本整包金数 的 0.5 次方），
  //    它不在下面那张逐关卡表里（它是**整包级**的常数，不是某一关的因子）。
  //    所以必须印在标题行：否则「Σ逐关卡贡献」比「合计」小一截，读者会以为算错了
  //    （`docs/功能要求.md` §7 第 4 条「数字必须可验算」）。
  //    系数 = 1（这个整包就是该角色最便宜的那套）时不印，避免满屏「×1.00」。
  const ownFactor = Number(unit.ownGoldFactor ?? 1);
  const ownRef = Number(unit.ownGoldRef);
  // ⚠️ 分母必须是**隐金前**的金数：系数算的是 `(ownGoldRef ÷ rawGold)^q`，而 `gold`
  //    是隐金后的。2026-10-17 第二轮修 —— 改前这里写的是 `unit.gold`，一开隐金就
  //    「1 ÷ 0」「1 ÷ 1 = 1.000 但系数 0.577」（开满隐金实测 67/261 条对不上）。
  //    旧服务端没有 `ownGold` 时退回 `gold`（会重新不一致，但不至于印出 undefined）。
  const ownGold = Number(unit.ownGold ?? unit.gold) || 0;
  const ownPart = (Number.isFinite(ownFactor) && Math.abs(ownFactor - 1) > 1e-4)
    ? ` × 整包系数 ${factorText(ownFactor)}`
      + (Number.isFinite(ownRef) ? `（最便宜 ${ownRef} 金 ÷ 本整包 ${ownGold} 金）` : '')
    : '';
  box.appendChild(text('span', 'advice-score-split-title',
    '角色性价比来源：逐关卡「权重 × 100 × 表现 ×（该副本最便宜金数 / 这支队金数）× 跨版本发挥」'
    + ownPart));
  box.appendChild(tipTable(
    // 用户 2026-10-11 第 2 条：表头第一列原名「副本/关卡」，与下面第一列实际写的
    // 内容（两级写法 + 版本小字 + 队伍图标）已经不一致了，用户点名改成**「关卡」**。
    // ⚠️ 2026-10-17：第 2 列原名「权重」，与三分项表里的**抽卡权重**同名不同义
    //    （那边印百分比、这边印 ×N），改叫「关卡权重」。与强度来源表同一处理。
    ['关卡', '关卡权重', '表现', '金数', '跨版本发挥', '贡献'],
    rows,
    // 合计只在多副本时给：一个副本时它就是那一列本身，再写一行纯属重复。
    // ⚠️ 标签写「性价比合计」而不是「合计」：这个窗口里上面那张表的合计是**角色得分**，
    // 这张只是其中一个分项（写「合计」读者会拿它去对徽标上的数）。
    envs.length > 1
      ? ['性价比合计', '', '', '', '', `+${packScoreText(unit.total)}`] : null,
    // 主表打 `is-source`：浮层里现在有两张表，探针（`check-advice-layout.mjs`）靠这个
    // class 认准「逐关卡来源」这张，不会量到上面那张三个分项的表。
    // 主表打 `is-source`：浮层里有**三张**表了（三个分项 / 强度来源 / 性价比来源），
    // 探针（`check-advice-layout.mjs`）按这个 class 认准「性价比逐关卡来源」那一张
    // —— 它的合计 = `unit.total`，探针就是这么断言的。强度那张**不带** `is-source`
    // （它的合计是 `strengthTotal`，两者不是一个数）。
    'is-source',
  ));
  return box;
};

/**
 * 总榜行（整包口径）的浮层：**先把「这个数字怎么来的」拆成来源，再说和谁打出来的**。
 *
 * 用户 2026-10 的两条要求：
 *   ① **列出贡献值来源** —— 表里逐**关卡**给出 权重 / 表现 / 金数 / 跨版本发挥 **四个因子**
 *      （「档位」与「行动值」已于 v4.6.72 合并成一列「表现」，见 `perfFactorOf()`；
 *      兼容字段 `tierFactor` / `avFactor` 仍在 `frontierFactorsOf()` 的返回值里，但**不再
 *      相乘**），它们乘起来正好是「贡献」那一列（多关卡时还有一行合计 = 徽标上的数）；
 *   ② **更简略的文字描述** —— 改前下方是 7 段两~三行的解释，现在压成 6~8 条单行脚注
 *      （每条 ≤60 字，`tools/check-advice-layout.mjs` 有断言钉住）。
 *
 * ⚠️ 因子由 `advice.js` 的 `frontierFactorsOf()` 现算（与算分共用同一批常量、
 * 同一对行动值分位边界），这里**不要**自己再写一遍公式：榜上一旦换口径，
 * 只有那边会跟着变，界面抄一份就会悄悄说谎。
 *
 * ⚠️ **用户 2026-10-13 第 2 条起，这个窗口是两层**：
 *   * 最上面那张表 = **角色得分**（三个分项按抽卡权重加权）——`scoreBreakdownTable()`；
 *   * 下面那张表 = **性价比分项**的原始来源（逐关卡的乘法链，合计 = `unit.total`）。
 *   所以脚注里那句「贡献加起来 = 徽标上的数」必须改成「= 性价比分项」，
 *   否则读者加出来的数与上面的角色得分对不上，会以为算错了。
 */
const frontierTip = (unit) => {
  // ⚠️ 三个分项的**来源**（强度表 / 性价比逐关卡表 / 泛用性名单）**不再直接铺在窗口里**
  // （用户 2026-10-13 第 8 条：「三个得分项目都可以点击后显示来源，节省界面的空间」）：
  // 它们各自被 `scoreBreakdownTable()` 收进所在分项行下方的就地折叠块（默认全部收起）。
  // 所以这个函数现在只负责「总分 + 等式 + 脚注」这一层，行数据整个交给 `costSourceBlock()`。
  const bestEnv = unit.envs[0];
  const bestMeta = bestEnv ? frontierEnvMeta(bestEnv.id) : null;
  // 实测证据数（副本 × 有观测的版本数）：用户 2026-10-11 缺陷 5 —— 新老角色的尺子不同
  // （新角色按单版最大值、老角色按 7 版平均），必须让读者看到「这个分数有多少证据撑着」。
  const evidenceUnits = (unit.envs || [])
    .reduce((n, e) => n + (Number(e.seasonCount) || 0), 0);
  /**
   * 版本权重那一行的**比例文本**（`6:5:4:3:2:1`）：从下发的 `seasonWeights` 现算。
   *
   * ⚠️ **不许写死**：用户 2026-10-18 把表改成 `6:5:4:3:2:1`（窗口 6，= 旧表 ×2），而它上一轮
   * 还是 `2:2:2`（窗口 3）—— 这张表一改，脚注就会与榜上的分对不上。
   * 兜底值（`seasonWeights` 缺失时）也跟着当前表走，别再留 `2:2:2` 那种过期常量。
   * 对象键序 = 新 → 旧（见 `buildConclusionInner` 的 `windowSeasons`），所以直接取 values。
   */
  const versionRatioText = (() => {
    const values = Object.values(bestMeta?.seasonWeights || {}).map((v) => Number(v));
    const usable = values.filter((v) => Number.isFinite(v) && v > 0);
    return usable.length ? usable.join(':') : '6:5:4:3:2:1';
  })();
  // 脚注一律**单行**（用户要求「更简略」）：一条只说一件事，能省的定语全省。
  // ⚠️ 每条 ≤60 字有 CDP 断言钉着（`check-advice-layout.mjs` 的 notesShortOk）。
  const notes = [
    // ⚠️ 2026-10-17 第二轮改：这条原来写的是「整包自身 N 金**不进公式**」——v4.6.118
    //    加了整包系数之后那句话就成了假话（整包自己的金数正是系数的分母）。
    //    现在如实写「折成系数」，与标题行那句「× 整包系数 N」对齐。
    //    数字用 `ownGold`（隐金前）：标题行那个除法用的就是它，两处必须同一个数。
    // ⚠️ 除法一律写**斜杠**：`check-advice-layout.mjs` 有全窗口判据禁止出现 `÷`
    //    （用户 2026-10-11「金数的符号改为斜杠」）。这一格在 v4.6.118 写成了「÷」，
    //    一直红到 2026-10-18 第一次真跑 CDP 套件才抓出来。
    `整包 = 角色 + 星魂档 + 光锥（含叠影）；整包自身 ${Math.max(0, Math.round(Number(unit.ownGold ?? unit.gold) || 0))} 金按「该角色最便宜 / 本整包」折成系数。`,
    // ⚠️ 用户 2026-10-11 第二轮：**表现列现在只写实测成绩**（`285` / `0T` / `3852`），
    // 量纲由副本决定，所以脚注要把「列里那个数是什么」和「系数怎么来的」一起说清。
    // 曲线默认全程单调不增（v4.6.72 起满分线以内也有梯度）：
    //   0 得 1.00 → 满分线 0.85 → 达标线 0.50 → 及格线 0.25 → 线外衰减到 0.05。
    // ⚠️ v4.6.78 起**绝境单独一套**（用户第四轮）：满分线以内固定 1.00、达标线 0.60
    // —— 上面那串默认值不再适用于它，`perfCurveText` 按副本现算，别在这里写死。
    // 满分线 = 0 的副本（混沌 / 虚构 / 末日幻影）没有满分锚点，直接从 1.00 接达标线。
    // ⚠️ 这条脚注有 **60 字硬上限**（`notesShortOk`），所以曲线说明只列「档位 系数」对。
    `表现：列里是实测成绩，系数按 ${perfCurveText(bestMeta)}。`,
    // 不写「本期 N 金」：多副本时每个副本各有一个最便宜金数，写在脚注里只会和表里的
    // `1÷2`、`7÷9` 打架（实测悬停「千冶•刃」时脚注说 7 金、第二行却是 1÷2）。
    // 「该版本」三个字不能省：分母是**那一版自己**的最便宜金数（v4.6.63 起）。
    // ⚠️ 用户 2026-10-11 第 3 条改了两件事，这条脚注必须同时说清（它有 **60 字硬上限**，
    // `check-advice-layout.mjs` 的 `notesShortOk` 钉着，所以只能压到最短）：
    //   · 除号改写成**斜杠**（用户第 2 条：「金数的符号改为斜杠，表示除以」）；
    //   · 金数项**封顶 ×1**，0 金通关拿固定 **×1.2**（用户第 3 条原话：「倍数封顶 1.00，
    //     使用 0 金通关额外获得 1.2 的倍率（对所有关卡生效）」）。
    //     封顶之前这一列能出现 `7/1 = 7.00`（末日幻影 4.3），与「越接近 ×1 越强」自相矛盾。
    '金数 = 该版本最便宜的配置 / 这支队伍，封顶 ×1；0 金通关 ×1.2。',
    // 用户 2026-10-10 第 6 轮：那一栏原名「版本」太抽象（会被当成左边的版本权重）。
    // ⚠️ **2026-10-15 起口径变了**（用户：「最佳证据会受到跨版本发挥的削减，因此还是
    // 新版本新配队更强」）：「最好的那一版」从「跨版本原始分最高的那次」改成「**版本
    // 最新**的那一次成绩」（与强度来源表同一口径）。所以这一列不再恒 ≤ 1：
    //   * `< 1` = 缺投稿的版本被按 0 分摊薄（典型：新角色只有一两版有成绩）；
    //   * `> 1` = 旧版本的成绩仍在把加权平均往上抬（典型：老常客，当前版本金数水位高）。
    //   `1.00` 表示这一版的成绩就是各版本的加权平均水平。
    // ⚠️ v4.6.78 删掉了后半句「非前沿投稿按质量梯度估算」：前沿池改成**全部成绩**之后，
    // 「有成绩但没进池」这种版本不存在了（估算机器整台删除）。这条脚注有 ≤60 字上限，
    // 改动必须同步 `tools/check-advice-layout.mjs` 的 `NOTE_EXACT`。
    // ⚠️ 除号写成 `/`：`check-advice-layout.mjs` 有一条「浮层正文里不许出现 ÷」的判据
    //    （`feat/level-icons-cost-cap` 那一轮加的）。
    '跨版本发挥 = 各版本加权平均 / 最新版那次成绩；小于 1 被摊薄，大于 1 是旧版抬分。',
    // 用户 2026-10-10 第 8 条给了整句：「最近 7 个版本按 2:2:2:1:1:1:1 加权，未上线版本
    // 不参与加权」。⚠️ 版数一律**跟着数据走**（版数取 `versionWindow`、比例取
    // `versionRatioText`，兜底 6 版 = 当前 `VERSION_WEIGHTS` 的长度）—— 只有「未上线
    // 版本不参与加权」这句是固定的口径，其余照用户原话。
    `最近 ${bestMeta?.versionWindow || 6} 个版本按 ${versionRatioText} 加权，未上线版本不参与加权。`,
    // ⚠️ 用户 2026-10-11 缺陷 5：**新老角色的尺子不同**必须让读者看得见。
    // 「早于登场 → 不参与平均」让新角色只按**它唯一那一版**算（近似单点最大值），
    // 而老角色是多版加权平均（被没上榜的版本拖低）。两者混在一张榜上时，
    // 「观测 1 版」的条目天然偏高（实测观测 1 版的 max=80，观测 7 版的 p50≈30）。
    //
    // 按用户口径**不改算法**（「不罚新角色」是第 6 条的明确要求，向均值收缩会与之冲突），
    // 而是把证据基础摆出来，让读者自己判断这个分数的可信度。
    `实测证据 ${evidenceUnits} 个（副本×版本）；证据越少，分数波动越大。`,
    '同队成员必然同分（分子分母都只来自队伍）；投稿条数不累加；与你的角色池无关。',
    // ⚠️ 用户 2026-10-13 第 1、2 条之后，这个窗口里有**两类**权重同时在起作用，
    // 所以这句必须说清分工（改前只说「这里的权重是关卡权重那一类」）。
    '关卡权重决定哪些副本算数；抽卡权重决定三个分项怎么加权。',
    // 泛用性的口径（用户 2026-10-13 第 1 条 + **2026-10-14 第 1 条改口径**）。
    // ⚠️ 它现在是**按星魂档**算的：同一个角色的 E0 包与 E6 包拿到的是两个不同的数，
    //    而且各自在**本档**的区间里归一到 0~100（用户原话：「不同星魂需要各自比较泛用性」）。
    '泛用性 = **本档星魂**在能通关的队伍里出现过的不同队友数（各星魂档各自排名）。',
  ];
  // 「最佳证据的队伍」那一块**已删除**（用户 2026-10-11 第 5 条「图标都放进表格内」）：
  // 队伍卡片现在长在表格第一格里（见 `costSourceBlock()` 的 `labelCell`），关卡信息因此
  // 只出现一次。
  // `packsSlot()` 是**同一批要求的另一半**（2026-10-10，用户澄清是「性价比面板」）：
  // 总榜每角色只留一条，所以默认看不到这个角色的其他整包；这一节按需补上**全部**配队，
  // 每条带自己的性价比得分与最佳证据队伍。
  // ⚠️ 用户 2026-10-13 第 8 条之后这里只剩 `packsSlot`：**三个分项的来源块都搬进了
  // `scoreBreakdownTable()` 的就地折叠块**（原来泛用性名单排在这张表后面、强度表排在它
  // 前面）。「全部配队」是另一个话题（还有哪些配装）、不是分数的来源，所以留在窗外这一层。
  const extra = [packsSlot(unit.name)];
  // 名次靠后的条目为了载荷**不逐关卡展开队友**（`slimFrontierUnit()` 只给头条证据那一支）。
  // ⚠️ 触发条件是「**所有**关卡都没有 members」，不是「第一个关卡没有」：
  //    改前那样写时，只要有一个关卡带着队伍、另一个没带，脚注就会说「未展开队友名单」
  //    —— 而旁边明明画着队伍卡片，脚注在说谎。
  // ⚠️ `unit.__packsTried` 那一条是 2026-10-17 加的：`/conclusion` 的 `members` 只给
  //    头条那一支之后，未补齐的窗口里的其余关卡**一律**满足下面的条件，不看这一笔
  //    就会在按需取回名单**之前**先闪一句「未展开队友名单」，再在补齐后把它撤掉
  //    —— 读者看到的是窗口抖了一下。
  if (unit.__packsTried && unit.envs.length && unit.envs.every((env) => !env.members?.length)) {
    notes.push('（名次靠后：未展开队友名单。）');
  }
  const tip = tipBox({
    // ⚠️ 用户 2026-10-13 第 2 条：这个数从「性价比得分」改名「**角色得分**」。
    head: `角色得分 +${packScoreText(unitRoleScore(unit))}`,
    // 用户 2026-10-10 第 6 轮：原来这里叫「版本」，与左边的版本权重表撞名、看不出在算什么。
    // 改叫「跨版本发挥」。⚠️ 2026-10-15 起「最好的那一版」= **版本最新**的那次成绩
    // （与强度来源表同一口径），所以这一列可 `< 1`（缺投稿摊薄）也可 `> 1`（旧版抬分）。
    // ⚠️ 这条等式描述的是**「性价比」那一项的来源表**（现在收在它那一行的折叠块里），
    // 不是上面的角色得分 —— 所以开头写明「性价比分项」。
    eq: '性价比分项 = 副本权重 × 100 × 表现 ×（该副本最便宜金数 / 这支队金数）× 跨版本发挥',
    // ⚠️ 用户 2026-10-13 第 8 条之后这个窗口里**只剩上面那一张**（三个分项）表：
    // 强度表 / 性价比逐关卡表 / 泛用性名单三块都收进了它下面各分项行里的就地折叠块
    // （`scoreBreakdownTable()` 的 `tipScoreDetails`，**默认全部收起**）。窗口正文因此
    // 短了一大截 —— 这正是用户要的「节省界面的空间」。
    //
    // 历史（别再改回去）：改前这里是 `pre: [scoreBreakdownTable, strengthSourceBlock, 标题]`
    // + 一张 `is-source` 主表 + `extra: [versatilitySourceBlock, packsSlot]`，
    // 四张表/块一次全铺开，5 个关卡的条目在 1000px 高的窗口里要滚三屏。
    // 探针（`check-advice-layout.mjs`）原来按 `.advice-value-tip-table.is-source` /
    // `.is-strength-source` 从窗口正文里选表，现在必须**先点开对应折叠块**再选 ——
    // 见那个文件里 2026-10-13 第 8 条那一段。
    pre: [scoreBreakdownTable(unit)],
    extra,
    notes,
  });
  // ⚠️ 逐档榜（E0/E1/E2/E6 那四页）的载荷只带**最好的那一个关卡**的明细（压 600 KB 硬上限，
  // 见 `src/server/conclusion.js` 的 `slimFrontierUnit(unit, i, 1)`）—— 用户 2026-10-11 报的
  // 「E1/E2/E6 的详情页只显示一种关卡」就是它。点开时按需把整份明细取回来（`enrichTipDetail`），
  // 所以这里把整包对象挂在节点上，界面不必再猜它属于谁。
  tip.__unit = unit;
  return tip;
};

// 用户 2026-10-11 第 10 轮：抽卡方案改成**队伍口径**，原来那个「按边际收益排序的单位
// 清单」连同它的详情窗口一起撤掉 —— `planTip()`（逐副本列「权重 / 收益 / 贡献」）与
// `renderBudgetAnswer()`（清单本体）都在这一轮删除。
//
// 为什么连详情窗口一起删而不是留着复用：那个窗口解释的是「这一个**单位**值多少」，
// 而新方案的单位是**队伍**，要解释的是「这支队伍凭什么排这里」（两个分项）与
// 「这 N 金按什么顺序花」（补金顺序）—— 两套说法没有可复用的部分，
// 留着只会让人以为旧口径还在算。旧实现见 git 历史（v4.6.77 及以前）。

// ------------------------------------------------- ② 抽卡方案（队伍口径：照抄哪支队 + 补金顺序）

/** 某个档位里一位成员的写法：`砂金 E2 · 光锥 S1`；没拥有就是 `风堇 未拥有`。 */
const memberStateText = (m) => {
  const name = cn(m.char);
  if (m.eidolon === null || m.eidolon === undefined) return `${name} 未拥有`;
  const cone = m.lc ? ` · ${cnCone(m.lc)} S${Math.max(1, Number(m.superimp) || 1)}` : '';
  return `${name} E${Number(m.eidolon) || 0}${cone}`;
};

/** 「过渡档位」里那四个人（用户 2026-10-11 第 7 条）。 */
const midStateText = (mid) => (mid?.members || []).map(memberStateText).join(' · ');

/** 详情窗口里的小型队伍图：让分数来源能一眼对应到真实角色。 */
const planTipTeam = (members, className = '') => {
  const row = text('div', `advice-plan-tip-team${className ? ` ${className}` : ''}`);
  for (const member of members || []) {
    const card = text('div', 'advice-plan-tip-member');
    const avatar = iconImg(iconUrlOf('char', member.char), 'advice-plan-tip-avatar',
      cn(member.char), 'eager');
    if (avatar) card.appendChild(avatar);
    const info = text('div', 'advice-plan-tip-member-info');
    info.appendChild(text('strong', 'advice-plan-tip-member-name', cn(member.char)));
    const tags = text('span', 'advice-plan-tip-member-tags',
      `E${Number(member.eidolon) || 0}`);
    if (member.lc) {
      const cone = iconImg(iconUrlOf('cone', member.lc), 'advice-plan-tip-cone',
        cnCone(member.lc), 'eager');
      if (cone) tags.appendChild(cone);
      tags.appendChild(text('span', '', `S${Math.max(1, Number(member.superimp) || 1)}`));
    }
    info.appendChild(tags);
    if (member.pending !== undefined) {
      info.appendChild(text('span', `advice-plan-tip-member-state${member.pending ? ' is-pending' : ''}`,
        member.pending ? '过渡时待补' : '过渡已到位'));
    }
    card.appendChild(info);
    row.appendChild(card);
  }
  return row;
};

/**
 * 「补金推荐分」的详情（用户 2026-10-11 第 8 条原话：「点击补金推荐分按钮可以查看
 * 补金推荐分的来源，以及**其他类似的次选的配队**（至多 3 个）」）。
 *
 * 内容 = **两个刻度与折算**（强度得分、性价比 —— 这就是「分数的来源」）
 * + 过渡档位 + 次选配队。
 * 度量口径全部来自 `plan`（`teamPlan()` 的返回值），界面不重算任何一个数。
 *
 * ⚠️ 用户 2026-10-12 第 6 条（「性价比得分、差额接近分、压金度，三者是不是过于重叠了，
 * 我只想保留性价比的得分」）之后，这里**只剩两行**：中间那层「性价比得分」已删除
 * （它曾 = 性价比 与 压金度 各半）。别再把它加回来 —— 同一个数套两个名字正是
 * 用户说的「重叠」。
 */
const teamPlanTip = (row, plan) => {
  const num = (v) => Number(v || 0).toFixed(1);
  // ② 那条曲线的指数（用户 2026-10-12 第 9 条）：由 `teamPlan()` 回显，界面不自己再算一遍。
  // ⚠️ 这一句必须在**本函数**里取 —— 它不能借 `renderTeamPlan()` 里那个同名局部变量。
  const gapPower = Math.max(1, Number(plan.gapPower) || 1);
  // 生效的抽卡权重（已归一化）：由 `teamPlan()` 回显，界面不自己再算一遍。
  const draw = plan.drawWeights || normalizeDrawWeights({});
  const ws = formatShare(draw.strength);
  const wc = formatShare(draw.cost);
  // 泛用性的系数（用户 2026-10-13 第 3 条「泛用性权重也适用于补金推荐」）。
  const wv = formatShare(draw.versatility);
  /**
   * 队级泛用性 / 它的池内刻度：2026-10-14 起这个数是**按成本占比加权的平均**
   * （不再是简单平均），所以照样要一位小数（它可能是 12.5 而不是整数人数）。
   */
  const vers = (v) => Number(v || 0).toFixed(1);
  /**
   * 这张卡在方案里的序号（**只用来给折叠块的 id 去重**）。
   *
   * ⚠️ 必须去重：`advice-detail-toggle` 的 `aria-controls` 指向的 id 在整份文档里
   * 唯一才有效，而抽卡方案一次渲染最多 15 张卡、每张卡都有自己的「分数来源」折叠块。
   * 找不到时退回空串 —— id 里少一段只是退化，不会让 `aria-controls` 指错人。
   */
  const cardNo = Math.max(0, (plan?.rows || []).indexOf(row));
  /**
   * 「分数来源」那张刻度表：**分项 / 本队取值 / 刻度 / 折算**。
   *
   * ⚠️ 抽成函数供**本方案**与每支**次选配队**共用：次选配队的「补金推荐分怎么来的」与本方案
   *    是**同一把尺子、同一套公式**，只是取值不同 —— 抄第二份必然会分叉。
   * ⚠️ `r` 上必须有 `strengthPct / gapPct / versatilityPct / versatilityRaw / gap / gold`
   *    这几个**由 `teamPlan()` 下发**的字段（次选配队那几项见 `advice.js` 的 `alternatives`
   *    映射，2026-10-15 补齐）；界面不自己算任何一个数，缺字段就是缺，不补默认值。
   * ⚠️ `extraClass` 让每张表带自己的 class：探针按 `.is-score-scale` 认**本方案**那一张，
   *    次选配队那几张用 `.is-alt-scale` —— 不区分的话探针会量到第一张、行数与合计判据漂移。
   */
  const planScaleTable = (r, extraClass) => tipTable(
    ['分项', '本队取值', '刻度', '折算'],
    [
      // ⚠️ 2026-10-15 起「本队取值」是**角色总榜那一列的强度分**（绝对 0~100）——
      // 与总榜同一把尺子：围绕行动值 + 投入单调（E6S5 > E6S1 > E2S1 > E0S0），
      // **不含金数项**（省金是 ② 的事，用户 2026-10-14 第 10 条）。
      // 所以刻度那一格写死「0 ~ 100（绝对刻度）」：这一档**不做池内归一**，
      // 换账号 / 换展示条数都不变 —— 旧口径（含金数项的整包分按池内 min-max）见
      // `teamPlan()` 里那段历史注释。
      // ⚠️ `r.avSource`（用户 2026-10-16 第 2 条的「行动值前沿」池）那一行的取值
      //    不是角色总榜的强度分，而是**本队自己**各关行动值的加权 —— 分开写，
      //    否则读者会拿总榜那一列的数字来对，对不上还以为是算错了。
      //    ⚠️ 刻度那一格必须写出**「跳过的更重关卡按 0 计」**（v4.6.112）：少了它，
      //    读者会以为「只在轻关卡 0 行动值」也能拿高分（实测那正是用户报的 bug）。
      r.avSource
        ? ['队伍强度', `本队行动值强度 ${num(r.strengthPct)}`,
          '0 ~ 100（本队各关行动值，0 行动值 = 100；跳过的更重关卡按 0 计）',
          `${num(r.strengthPct)} × ${ws}`]
        : ['队伍强度', `强度分 ${num(r.strengthPct)}`,
          '0 ~ 100（绝对刻度）',
          `${num(r.strengthPct)} × ${ws}`],
      // ② 只有这一个刻度（用户 2026-10-12 第 6 条）。「账面 N 金」放在「本队取值」里当
      // 参考信息，**不进公式** —— 它已经不参与任何折算（想让它参与就是 v4.6.87 那个
      // 被用户否掉的「压金度」）。
      // ⚠️ 刻度那一格必须写出**曲线指数**（用户 2026-10-12 第 9 条「削减一点」）：
      //    否则读者按线性去算会与右边的折算对不上（补 10 金时 28.6 → 15.3）。
      ['队伍性价比', `补金 ${r.gap} 金｜账面 ${r.gold} 金`,
        // ⚠️ 分位必须**现取** `plan.gapCapPct`（2026-10-15 修）：这里原来写死「池内 p75」，
        //    而常量早就被调到 p60 了 —— 界面于是在说假话。值域也写出来（可负）。
        `(1 − 补金 ÷ ${plan.gapMax} 金)^${gapPower}`
        + `（池内 p${Math.round((Number(plan.gapCapPct) || 0.6) * 100)} 分位封顶；`
        + '正好到封顶值 = 0 分，**超过就转负分**，最低 −100）',
        `${num(r.gapPct)} × ${wc}`],
      // ③ 泛用性（用户 2026-10-13 第 3 条；**2026-10-16 第 3、5 条改了每人那个数**）：
      // 队内成员**各自**的**全局泛用性**（= 该角色 E0/E1/E2 的平均值，不含常驻 / 大隐金）
      // 按**成本占比**加权，再按候选池归一。刻度是「个队友」，所以写清楚单位 ——
      // 否则读者会把它当成一个百分比。
      ['队伍泛用性', `成本加权 ${vers(r.versatilityRaw)} 个队友`,
        `${vers(plan.versatilityLo)} ~ ${vers(plan.versatilityHi)} 个（池内现算）`,
        `${num(r.versatilityPct)} × ${wv}`],
    ],
    null,
    extraClass,
  );
  /**
   * 「过渡档位」的**来源**（用户 2026-10-15 第 6 条：过渡档位也要能查看它自己的来源）。
   *
   * ⚠️ 过渡档位**不是另一套评分**：`advice.js` 的 `teamPlan()` 在它身上只下发「切分结果」
   *    （`items` / `gold` / `rest` / 四个人的过渡状态），**没有分项分数**。所以这里**只摆它
   *    真实有的数** —— 凭空给它编一个分数就是假口径，会在界面上印出一个不存在的刻度。
   *   * 覆盖的那几笔取自 `row.fill` 的前 `mid.items` 项：`mid` 就是按这个顺序切出来的
   *     （`advice.js` 里 `mid` 由 `t.fill` 现算，`row.fill` 是同一份）。
   *   * `gold + rest` 恒等于本方案总补金 `row.gap` —— 这是切分规则的自洽性，写出来读者能自查。
   */
  const midSourceNode = () => {
    const mid = row.mid;
    const fill = row.fill || [];
    const head = fill.slice(0, mid.items);
    // ⚠️ 用 `fillItemName` / `fillItemText`（与卡片上「补金顺序」同一套写法）—— 同一个
    //    笔在两处写法必须一致，否则读者会以为说a的是两件事。
    const boughtText = head.map((it) => `${fillItemName(it)} ${fillItemText(it)}`
      + `（${Math.max(0, Math.round(Number(it.pulls) || 0))} 金）`).join('、') || '—';
    const box = text('span', 'advice-plan-tip-scale');
    // ⚠️ 只有两列、且**金数放最后一列**：`tipTable()` 会把最后一列打成 `is-val`（金色加粗），
    //    那是给「值」准备的 —— 把一大串「含哪几笔」放在最后会变成一整片金色粗字，很难看。
    box.appendChild(tipTable(
      ['阶段', '金数'],
      [
        [`本方案（补齐后，共 ${fill.length} 笔）`, `${row.gap} 金`],
        [`过渡档位（先补前 ${mid.items} 笔）`, `${mid.gold} 金`],
        ['再补到本方案（后半）', `${mid.rest} 金`],
      ],
      null,
      'is-mid-scale',
    ));
    box.appendChild(text('span', 'advice-value-tip-note',
      `过渡档位要先补的这几笔：${boughtText}`));
    box.appendChild(text('span', 'advice-value-tip-note',
      '⚠️ 过渡档位是**补金顺序上的一个中间档位、不是另一套评分**：它按补金顺序把本方案的'
      + '总差额一切两半（前半累计金数不超过总差额的一半，至少 1 笔、至多少 1 笔），'
      + '所以要买的每一项都是本方案的子集 —— **成本完全下位**，补金顺序也天然先到它。'));
    box.appendChild(text('span', 'advice-value-tip-note',
      `前半 ${mid.gold} 金 + 后半 ${mid.rest} 金 = 本方案 ${row.gap} 金；`
      + '四个人的过渡状态见上面那行（待补的那一项退回你账号的现状，所以可能仍标「缺」）。'));
    return box;
  };
  /**
   * 「次选配队」一支的**来源**（用户 2026-10-15 第 6 条）。
   *
   * ⚠️ 它与本方案是**同一把尺子**：`alt.total` 同样是
   *    `队伍强度 × ws + 队伍性价比 × wc + 队伍泛用性 × wv`（2026-10-17 改名，
   *    旧名「强度得分 / 性价比 / 泛用性」作废），所以来源直接复用 `planScaleTable()`，
   *    再把「凭什么算次选」（与本队共享几名成员）写出来。
   * ⚠️ 三个分项（`strengthPct` / `gapPct` / `versatilityPct` / `versatilityRaw` / `gold`）
   *    是 **2026-10-15 在 `advice.js` 的 `alternatives` 映射里补下发的** —— 界面不重算。
   */
  const altSourceNode = (alt) => {
    const box = text('span', 'advice-plan-tip-scale');
    box.appendChild(text('span', 'advice-value-tip-note',
      `这支与**本队共享 ${alt.shared} 名成员**`
      + '（「类似」的判据就是共享 ≥ 2 人，最多列 3 支）；'
      + `补金推荐分 ${Number(alt.total).toFixed(1)} = 下面三个分项按抽卡权重加权：`));
    box.appendChild(planScaleTable(alt, 'is-alt-scale'));
    return box;
  };
  const extra = [];
  if (row.mid) {
    // 用户 2026-10-15 第 6 条：过渡档位也要能看**它自己的**来源 —— 按钮与标题同一行
    // （同一个 `tipInlineToggle()`），内容收在紧跟其后的折叠块里、默认 hidden。
    const midId = `advicePlanMid-${cardNo}`;
    const box = text('div', 'advice-plan-tip-block');
    const title = text('strong', 'advice-plan-tip-title',
      `过渡档位：先补前 ${row.mid.items} 笔（${row.mid.gold} 金）`);
    title.appendChild(tipInlineToggle({ id: midId, title: '查看过渡档位的来源' }));
    // 用户 2026-10-16：过渡档位也要有视频按钮 —— 它画的正是本方案这一支队的投稿
    // （`mid.video` 与卡片上「最佳证据」同一条，见 `advice.js` 的下发处）。
    // 放在「查看来源」右边，与次选配队、总榜行的图标同一行风格。
    const midVideo = videoLink(row.mid.video);
    if (midVideo) title.appendChild(midVideo);
    box.appendChild(title);
    box.appendChild(tipInlineDetailBlock({ id: midId, node: midSourceNode() }));
    box.appendChild(text('div', 'muted small', midStateText(row.mid)));
    box.appendChild(planTipTeam(row.mid.members, 'is-transition'));
    box.appendChild(text('div', 'muted small', `再补 ${row.mid.rest} 金 → 本方案`));
    extra.push(box);
  }
  if (row.alternatives?.length) {
    const box = text('div', 'advice-plan-tip-block');
    box.appendChild(text('strong', 'advice-plan-tip-title',
      `次选配队（与本队共享 ${row.alternatives[0].shared} 名成员，最多 3 支）`));
    row.alternatives.forEach((alt, j) => {
      // 用户 2026-10-15 第 6 条：每支次选配队也要能看各自的来源。id 里带序号 —— 一次最多
      // 3 支，`cardNo` 保证 15 张卡之间不重名，`j` 保证同一张卡内的三支不重名。
      const altId = `advicePlanAlt-${cardNo}-${j}`;
      const item = text('div', 'advice-plan-tip-alt');
      const copy = text('div', 'advice-plan-tip-alt-copy',
        `补金推荐分 ${Number(alt.total).toFixed(1)}｜补金 ${alt.gap} 金`);
      copy.appendChild(tipInlineToggle({ id: altId, title: `查看第 ${j + 1} 支次选配队的来源` }));
      // 用户 2026-10-16：每支次选配队也要有视频按钮 —— 它自己也是一支候选队，
      // 点开的是**这支**队伍的最佳证据投稿（`alt.video`，与主方案那条互不相干）。
      const altVideo = videoLink(alt.video);
      if (altVideo) copy.appendChild(altVideo);
      item.appendChild(copy);
      item.appendChild(tipInlineDetailBlock({ id: altId, node: altSourceNode(alt) }));
      item.appendChild(planTipTeam(alt.members));
      box.appendChild(item);
    });
    extra.push(box);
  }
  // ⚠️ 用户 2026-10-15 第 6 条：这张刻度表由 `planScaleTable()` 统一产出（本方案与每支
  // 次选配队共用同一套列与口径，见上面那个函数）。它仍然收在**默认收起**的折叠块里，
  // 只是那个折叠块的**按钮已经搬到标题行**（`tipBox` 的 `headExtra`）—— 与角色总榜那三个
  // 分项的做法一致（同一个 `tipInlineToggle()`），两个窗口的交互仍是同一套。
  //
  // 「那两块来源」是哪些：这张表就是**分数的组成**（三个分项各自的取值、池内刻度、折算），
  // 而下面那两段说明专门讲**它每一项的原始出处**（强度得分 `N1`、泛用性 `N2`），
  // 它们也一并收进来 —— 收起来时窗口只剩「摘要 + 等式 + 过渡档位 + 次选配队 + 那几条
  // 与来源无关的脚注」，正是用户要的「节省界面的空间」。
  const scoreTable = planScaleTable(row, 'is-score-scale');
  // 与来源无关的脚注（留在窗口里）：刻度口径、候选池、以及「性价比 = 性价比」那句。
  // ⚠️ 顺序与改前**完全一致**：折叠块只搬走属于「来源」的两段，其余原位保留 ——
  //    这样「窗口里先看结论、要看来源再点开」的读法不变。
  const scoreNotes = [
    // ⚠️ 2026-10-15 起 ① 就是**角色总榜那一列的强度分**（用户 2026-10-14 第 10 条重定的口径）：
    //    围绕行动值，绝对刻度 0~100。**不含金数项** —— 「省金」是 ② 的事。
    //    ⚠️ 2026-10-17 晚（用户：「强度得分应仅考虑强度」）起**金数彻底退出强度**：
    //    改前还有两步 —— 「同角色低档位向上兜底」与「最后 5 分按投入档位给」—— 两步都删了
    //    （留着它们等于把「高造价必然等于高强度」又请回来），所以这里**不再写那两步**；
    //    「投入越高越高（E6S5 > E6S1）」这条不变式也随之不再是这一项的判据。
    //    ⚠️ `avSource`（行动值前沿池）那条的取值**不是**角色总榜那一列，而是本队自己
    //    各关行动值加权（分母对「比本队打过的任何一关都更重」的缺关卡才计 0），分开写。
    (row.avSource
      ? '队伍强度 = **本队自己的行动值**（绝对 0~100）：逐关卡取这支队**这一关自己的行动值**'
        + '（同一关里取最快的一次），按「0 行动值 = 100、其余按判据线曲线」折算成该副本强度，'
        + '再按你设的关卡权重加权；跳过的**更重**关卡按 0 计进分母 —— '
        + '所以**行动值越低越高**，**与金数、与你有多少钱无关**。'
      : '队伍强度 = **角色总榜那一列的强度分**（绝对 0~100，与总榜同一把尺子）：'
        + '逐关卡取**这一关最佳证据那一支队自己的行动值**（同一支队里取最快的一次，'
        + '旧版本的成绩不再压过新版本），按「0 行动值 = 100、其余按判据线曲线」折算成该副本强度，'
        + '再按你设的关卡权重加权（缺副本按 0 计）—— 所以**行动值越低越高**，'
        + '**与金数、与你有多少钱无关**。')
    + `三个系数来自「抽卡权重」（强度 ${(draw.strength * 100).toFixed(0)}% / `
    + `性价比 ${(draw.cost * 100).toFixed(0)}% / 泛用性 ${(draw.versatility * 100).toFixed(0)}%），`
    + '改它不用重算数据集。',
    // ⚠️ 2026-10-13 起 ② 就只有一个刻度：**差额接近度**（用户 2026-10-12 第 6 条去掉了
    //    「压金度」「性价比得分」两个别名，只剩这一个）。它的原始量是「补金差额」，链路是：
    //      补金差额 gap = 把账号补到这支队伍、每个成员缺的「本体 / 星魂档 / 光锥叠影」按金数累加
    //                      （4★ / 常驻 5★ / 开拓者免费）；
    //      封顶值 = 候选池里所有队伍差额的 p60 分位（`gapMax`）；
    //      差额接近度 = sign(t) × |t|^1.5 × 100，t = 1 − gap ÷ 封顶值
    //    （指数 1.5 让贵队尾部掉得更快；正好到封顶值 = 0 分，超过转**负分**，下限 −100）。
    '队伍性价比 = **差额接近度**，原始量是**你还要补几金**（`补金 ${row.gap} 金`）：'
    + '把账号补到这支队伍的配置，每个成员缺的「本体 / 星魂档 / 光锥叠影」按金数累加'
    + '（4★ / 常驻 5★ / 开拓者免费）；'
    + `再套曲线 \`(1 − 补金 ÷ ${plan.gapMax} 金)^${gapPower}\``
    + `（封顶值 = 候选池差额的 p${Math.round((Number(plan.gapCapPct) || 0.6) * 100)} 分位），`
    + '正好到封顶值 = 0 分、超过转负分（最低 −100）—— 所以**补得越少越接近 100**；'
    + '「这支队总共几金」（账面金数）只写在卡片上，**不进分数**。',
    // ⚠️ 用户 2026-10-13 第 3 条：泛用性**也**进补金推荐分。
    //    2026-10-14 第 1 条定了队级合成（按各成员金数占比加权）；
    //    2026-10-16 第 3、5 条改了**每人那个数**：只看 E0/E1/E2 的平均值、固定为角色的
    //    全局泛用性，且「不用抽就有」的角色（常驻 / 大隐金）不算。
    '队伍泛用性 = 队内成员**各自**泛用性按**成本占比**加权（每人那个数 = 这个角色的**全局泛用性**'
    + '＝它在 E0/E1/E2 能通关的队伍里搭配过的**限定**不同队友数、按关卡与版本权重加权；'
    + '开拓者各命途算一个人；权重 = 这个人的金数 ÷ 全队金数），'
    + '再按候选池归一 —— 所以「队里花金最多的那位越百搭，这支队越好抄、越好换人」。',
  ];
  const tip = tipBox({
    head: `补金推荐分 +${num(row.total)}`,
    // ⚠️ 用户 2026-10-15 第 6 条：「查看分数来源」按钮搬到**补金推荐分右侧**（与标题同一行、
    // 紧跟其后，视觉上属于标题行）。用的是**内联版**按钮（`tipInlineToggle()`），而不是原来的
    // `tipScoreDetails()`（那个把按钮与内容包在一个盒子里、按钮独占一行）；内容仍收在下面
    // `pre` 里那个**默认收起（`hidden`）**的折叠块中（`tipBox` 的 `headExtra` 负责把按钮摆进标题行）。
    headExtra: tipInlineToggle({
      id: `advicePlanScore-${cardNo}`,
      title: '查看补金推荐分的分数来源',
      extraClass: 'is-plan',
      // 旁边就是「补金推荐分 +N.1」，写「查看来源」会含糊（看哪个来源？）——
      // 所以这一处用更明确的「查看分数来源」（见 `tipInlineToggle()` 的 label 参数）。
      label: '查看分数来源',
    }),
    // ⚠️ 第二项写成**性价比**（不是「性价比得分」）：v4.6.89 起它俩就是同一个数，
    // 印两个名字会让读者以为还有别的成分（用户第 6 条要的就是去掉这一层）。
    // ⚠️ 2026-10-17 第 4 条：三项统一成「队伍强度 / 队伍性价比 / 队伍泛用性」
    //    （第一项原来叫「强度得分」，「得分」二字本轮按用户口径去掉）。
    //    与卡片上那条等式、以及 `planScaleTable()` 那三行**逐字一致**。
    eq: `= 队伍强度 ${num(row.strengthPct)} × ${ws} + 队伍性价比 ${num(row.gapPct)} × ${wc}`
      + ` + 队伍泛用性 ${num(row.versatilityPct)} × ${wv}`,
    // ⚠️ 表头 / 行 / 脚注都在**折叠块里**（见上面 `scoreTable`）——这里不再直接传
    // `headers` / `rows` / `notes`：`tipBox` 只在 `headers && rows` 时才建表，
    // 不传就等于「窗口正文里没有这张表」。
    // ⚠️ 按钮已搬到标题行（`headExtra`），所以这里只放**内容块**（`tipInlineDetailBlock()`）——
    // 它在 `pre` 里的位置与改前 `tipScoreDetails()` 那个盒子一模一样（等式与主表之间）。
    pre: [tipInlineDetailBlock({
      id: `advicePlanScore-${cardNo}`,
      node: (() => {
        const box = text('span', 'advice-plan-tip-scale');
        box.appendChild(scoreTable);
        for (const line of scoreNotes) {
          // ⚠️ 仍然是独立的 `.advice-value-tip-note`（探针按这个 class 数条数 / 量字数），
          //    只是搬进了折叠块 —— 所以 `notesShortOk` 那类判据的**取数范围**要跟着改成
          //    「整个窗口」而不是「.advice-value-tip-notes 里」（见 check-advice-layout.mjs）。
          box.appendChild(text('span', 'advice-value-tip-note', line));
        }
        return box;
      })(),
    })],
    extra,
    notes: [
      // ⚠️ 2026-10-15：① 是**绝对刻度**（与角色总榜那一列同一个数），换账号也不变；
      // ②③ 仍取**整个候选池**（v4.6.81 修的就是「刻度取自要下发的那批」那个 bug ——
      // 那会让「展示条数」变成分数的隐藏输入）。
      '队伍强度是**绝对刻度**（0~100，与角色总榜那一列同一个数，换账号 / 换数据都不变）；'
      + '队伍性价比与队伍泛用性的刻度按**候选池**现算（不是按下面这几条），这两个换账号后不可直接比较。',
      // ⚠️ 用户 2026-10-12 第 6 条：性价比这一侧**只有**性价比。
      // ⚠️ 2026-10-15：0 以下不再截断，所以这里要写出**负分**这一段（见 `gapSample` 上方注释）。
      `队伍性价比（1 − 补金 ÷ ${plan.gapMax} 金，正好到封顶值 = 0 分、超过转负分）：`
      + '它量的是**你还要补几金**'
      + '（与上面那一档不同：那一档量的是这支队**打得多好**，与你有多少钱无关）；'
      + '「这支队总共要几金」（账面金数）只写在每张卡的明面上，**不进分数**。',
      // ⚠️ 候选池在 v4.6.83 从「角色总榜」放宽到「逐档榜 ∪ 总榜」
      // （每角色 × 每星魂档各留一条，再加每角色的总最佳），所以这里不能再说「总榜 N 支」
      // —— 两个数已经不是同一个集合了。
      `候选池 ${plan.pool} 支（逐档榜 ∪ 总榜 ∪ 行动值前沿去重后 ${plan.poolAll} 支，`
      + '再去掉「补金 0」的；逐档榜 = 每个角色在每个星魂档各收敛一条，'
      + '所以同一支队伍的**低配档位**也在池内；'
      + `行动值前沿 = 各副本行动值最好的几支队，共 ${plan.poolAv ?? 0} 支 —— 那类「0 行动值」的满配队`
      + '进不了证据池，专门为它开这条路）,'

      + `按总分降序取前 ${plan.rows.length} 支展示；改展示条数不会改分数。`,
    ],
  });
  return tip;
};

/** 一笔补金的中文写法：`E0→E2` / `本体` / `S1→S5` / `未见→S1`。 */
/**
 * 一笔补金**买到什么**（用户 2026-10-11 第 3 条 + 本轮修正）。
 *
 * 规则只有一条：**这一笔里包含本体时写「本体」（必要时再缀上目标档），纯粹往上补档时写
 * 真实的「现在 → 目标」**——
 *
 *   * 角色没拥有（`kind === 'char'`，这一笔连本体一起买）→ `本体`（目标 E0）/ `本体+E2`
 *     （目标 E2：本体 + 两颗星魂）；
 *   * 角色已拥有（`kind === 'eidolon'`，只补星魂）→ **`E1→E2`**；
 *   * 光锥没见过（`from < 1`）→ `本体`（目标 S1）/ `本体+S2`；
 *   * 光锥已有叠影（`from ≥ 1`）→ **`S1→S2`**。
 *
 * ⚠️ **用户 2026-10-11 报的 bug**：「遐蝶 本体+E2 2 金 这个描述有误，我已有遐蝶，应改为
 * E1-E2」——上一版只看 `target` 不看拥有情况，于是**已拥有**的角色也被写成「本体+E2」
 * （在成本上没错：这一笔确实是 1 颗星魂，但读起来像是要从零抽本体）。
 * 所以判据必须取 `kind`（`'char'` = 连本体买、`'eidolon'` = 只补星魂）与光锥的 `from`，
 * **不能**只看 `target`。`from` 为 0 表示米游社没看到这把光锥（它只统计当前装备）。
 */
const fillItemText = (item) => {
  if (item.kind === 'cone') {
    const target = Math.max(1, Math.round(Number(item.target) || 1));
    const from = Math.max(0, Math.round(Number(item.from) || 0));
    if (from < 1) return target <= 1 ? '本体' : `本体+S${target}`;
    return `S${from}→S${target}`;
  }
  const target = Math.max(0, Math.round(Number(item.target) || 0));
  // `kind === 'char'` 才是「连本体一起买」（`from` 被 `marginalCostOf` 夹成 0，不能当判据）。
  if (item.kind === 'char') return target <= 0 ? '本体' : `本体+E${target}`;
  const from = Math.max(0, Math.round(Number(item.from) || 0));
  return `E${from}→E${target}`;
};

/** 一笔补金的名字（光锥用光锥名，角色/星魂用角色名）。 */
const fillItemName = (item) => (item.kind === 'cone'
  ? cnCone(item.name)
  : cn(item.name));

/** 把算法结果翻译成用户能直接执行的一句话。 */
const planRecommendation = (row) => {
  const ownedCount = row.members.filter((member) => member.owned).length;
  const visible = row.fill.filter((item) => Number(item.cost ?? item.pulls) > 0);
  const first = visible[0];
  if (!first) {
    return {
      title: '这支队伍已经很接近成型',
      body: '隐金设置已覆盖当前缺口，暂时不用为这支队伍额外投入。',
      icon: null,
    };
  }
  const firstName = fillItemName(first);
  const firstStep = fillItemText(first);
  const route = row.mid
    ? `建议先走过渡档位，补 ${row.mid.gold} 金后再观察是否继续补满。`
    : visible.length > 1
      ? `建议先补「${firstName} ${firstStep}」，再按顺序完成后续缺口。`
      : `建议先补「${firstName} ${firstStep}」，这一步就是最短成型路径。`;
  return {
    title: `你已有 ${ownedCount}/4 位核心角色 · 还差 ${row.gap} 金成型`,
    body: route,
    icon: iconUrlOf(first.kind === 'cone' ? 'cone' : 'char', first.name),
  };
};

// ------------------------------------------------- 抽卡方案：缓存 / 搜索 / 分页

/**
 * 抽卡方案的**输入签名**（决定要不要重算 `teamPlan()`）。
 *
 * 只有这几样东西会改变方案：结论对象本身（换账号 / 改关卡权重 / 改版本权重 / 改隐金
 * 都会让服务端重新发一份）、账号的三份持有规模、以及**抽卡权重**（它直接在浏览器里
 * 参与加权，不发服务端）。其余状态（翻页、搜索词、滚动位置）一律不该触发重算。
 *
 * ⚠️ 权重取 `Number(...) || 0`：输入框被清空时 `state.drawWeights` 里是空串，
 *    `advice.js` 的 `normalizeDrawWeights()` 会把它当默认值 —— 这里只要保证「同样的
 *    输入得到同样的签名」，不必与归一化口径一致。
 */
const teamPlanInputsKey = () => JSON.stringify([
  state.owned.size,
  state.eidolons.size,
  state.coneRanks.size,
  Number(state.drawWeights?.strength) || 0,
  Number(state.drawWeights?.cost) || 0,
  Number(state.drawWeights?.versatility) || 0,
]);

/**
 * 一支队伍的可搜索文本：四个成员的**角色名 + 光锥名**（中文名与英文键都进）。
 *
 * 用户 2026-10-18 的原话是「能够根据角色或光锥名称进行搜索」，所以光锥也必须能搜 ——
 * 「我想找用某某专锥的那支队」是真实需求。搜索**只看成员**，不看「最佳证据的副本名」：
 * 那是筛选条件不是队伍身份。
 */
const teamPlanRowText = (row) => searchTextOf((row.members || []).flatMap(
  (m) => [m.char, cn(m.char), m.lc, cnCone(m.lc)],
));

/**
 * 取抽卡方案（**带缓存**）。
 *
 * `teamPlan()` 在浏览器里跑：全池 284 支实测 22 ms（见 `tools/_probe-team-plan-perf.mjs`）。
 * 翻一页、敲一个字都重算一遍的话，第二次点「下一页」就开始卡手 —— 而这两件事跟分数
 * **一点关系都没有**（截断与过滤都只是展示层）。所以按签名缓存一份，命中时连
 * 搜索用的 haystack 也一起复用（那一份是 284 × 8 个字符串，没必要每次重拼）。
 */
const planWithCache = (conclusion) => {
  const key = teamPlanInputsKey();
  const cached = state.teamPlanCache;
  if (cached && cached.conclusion === conclusion && cached.key === key) return cached;
  const plan = teamPlan(conclusion, {
    owned: state.owned,
    eidolons: state.eidolons,
    cones: state.coneRanks,
  }, {
    availability: conclusion.availability || {},
    // 抽卡权重（用户 2026-10-12 第 3、4 条）：界面发**用户敲的原值**，归一化在
    // `advice.js` 的 `normalizeDrawWeights()` 里做一次（两边各算一遍就会分叉）。
    drawWeights: state.drawWeights,
  });
  const haystacks = new Map(plan.rows.map((row) => [row, teamPlanRowText(row)]));
  state.teamPlanCache = { conclusion, key, plan, haystacks };
  return state.teamPlanCache;
};

/**
 * 画翻页条（用户 2026-10-18：「每页显示 20 个配队」）。
 *
 * 上下各一条（`#adviceTeamPlanPager` / `#adviceTeamPlanPagerBottom`）：一页 20 张卡已经
 * 要滚很远，看完最后一张还得滚回顶部才能翻页是很差的手感。两条**同一份实现**，只是
 * 挂在不同位置 —— 不做第二套逻辑，否则「上面能点到第 7 页、下面不能」这种事早晚出现。
 *
 * 只有一页时整条**隐藏**（`hidden`），免得一块没有信息量的按钮占着版面。
 */
const renderTeamPlanPager = (total, pages) => {
  const show = pages > 1;
  for (const host of [el.teamPlanPager, el.teamPlanPagerBottom]) {
    if (!host) continue;
    host.innerHTML = '';
    host.hidden = !show;
    if (!show) continue;
    const page = clampPage(state.teamPlanPage, pages);
    const go = (target) => {
      const next = clampPage(target, pages);
      if (next === state.teamPlanPage) return;
      state.teamPlanPage = next;
      // 只重画这一块：`teamPlan()` 走缓存（翻页不是计算动作）。
      renderTeamPlan(state.conclusion);
      // 翻页后回到列表顶部 —— 否则人还停在上一页的末尾，看到的是新一页的后半截。
      if (el.teamPlanPager) el.teamPlanPager.scrollIntoView({ block: 'start', inline: 'nearest' });
    };
    const button = (label, target, { active = false, disabled = false, title = '' } = {}) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = `advice-page-btn${active ? ' is-active' : ''}`;
      node.textContent = label;
      if (title) node.title = title;
      if (disabled) node.disabled = true;
      else node.addEventListener('click', () => go(target));
      if (active) node.setAttribute('aria-current', 'page');
      return node;
    };
    host.appendChild(button('«', 1, { disabled: page === 1, title: '第一页' }));
    host.appendChild(button('‹', page - 1, { disabled: page === 1, title: '上一页' }));
    for (const p of pageWindowOf(page, pages)) {
      if (p === '…') host.appendChild(text('span', 'advice-page-gap', '…'));
      else host.appendChild(button(String(p), p, { active: p === page, title: `第 ${p} 页` }));
    }
    host.appendChild(button('›', page + 1, { disabled: page === pages, title: '下一页' }));
    host.appendChild(button('»', pages, { disabled: page === pages, title: '最后一页' }));
    host.appendChild(text('span', 'advice-page-count',
      `第 ${page}/${pages} 页 · 共 ${total} 支`));
  }
};

/**
 * ② 抽卡方案（**队伍口径**，2026-10-11 用户第 10 轮）。
 *
 * 口径全部在 `advice.js` 的 `teamPlan()` 里（候选池、两个指标、归一化上下限、补金顺序），
 * 界面**不重算**任何一个数 —— 这里只负责画：
 *
 *   #名次  补金推荐分 xx.x = 队伍强度 xx.x × ws + 队伍性价比 xx.x × wc + 队伍泛用性 xx.x × wv
 *   队伍 4 个位置（角色 E档 + 光锥 S档，带图标，标出「已有 / 缺」）
 *   账面 N 金｜补金 M 金｜最佳证据：<副本> <金> 金 · <行动值> 行动值
 *   补金顺序（有序列表）：1. 名字 目标状态（N 金）
 *
 * ⚠️ 用户 2026-10-11 的抽卡方案改动：**不显示抽数**、补金顺序里不写「性价比」、
 * 一行只留「名字 + 目标状态 + 几金」；「总分 / 性价比」两个词改成
 * **「补金推荐分 / 强度得分」**；条数上限 40 → **15**。
 * ⚠️ 2026-10-12 第 3、4、6 条之后：两个系数 `ws / wc` 来自界面上的**抽卡权重**，
 * 第二项就写它本来的名字**性价比** —— 中间那层「性价比得分」在 v4.6.89 删掉了
 * （它只等于性价比 与 压金度 的合成），等式结构与文案位置都没变。
 * ⚠️ **2026-10-17（用户第 4 条）三项改名**：「强度得分 / 性价比 / 泛用性」→
 * **「队伍强度 / 队伍性价比 / 队伍泛用性」**（三项统一加前缀、去掉「得分」二字），
 * 与角色总榜那边的「角色强度 / 角色性价比 / 角色泛用性」区分开 —— 两个榜共用同一组
 * 权重旋钮，但**分项名**必须各叫各的。⚠️ 抽卡权重那三个**输入框**不改名（用户确认）。
 * ⚠️ **2026-10-18**：列表从「最多 15 条」改成**整池 + 每页 20 支**（用户：「提供尽可能多的
 * 配队，为此可以进行分页显示配队，每页显示 20 个配队」），并加了按角色 / 光锥名的搜索框。
 * 三件展示层的事各归各：`planWithCache()` 管**算一次**、`pageSliceOf()` 管**切哪一段**、
 * `renderTeamPlanPager()` 管**画翻页条**。卡片构建只跑「当前这一页」的 20 条。
 */
const renderTeamPlan = (conclusion) => {
  if (!el.teamPlanBody) return;
  el.teamPlanBody.innerHTML = '';
  // 「补金推荐分」徽标点开看详情（用户 2026-10-11 第 8 条）：与总榜那两个榜共用同一套
  // 大窗口接线（`wireValueTips` 内部有 `dataset.tipsWired` 幂等守卫，重画多少次只接一次）。
  wireValueTips(el.teamPlanBody);
  const meta = () => el.teamPlanMeta;
  const setMeta = (value) => { if (meta()) meta().textContent = value; };

  if (!state.owned.size) {
    setMeta('');
    renderTeamPlanPager(0, 0);
    el.teamPlanBody.appendChild(text('p', 'muted small',
      '先在「角色信息」页扫码登录并读取一次战绩：这一节要按你的角色池算'
      + '「哪支队伍最值得照抄、还差几金」。上面的角色总榜不需要登录。'));
    return;
  }
  if (!conclusion) {
    setMeta('');
    renderTeamPlanPager(0, 0);
    el.teamPlanBody.appendChild(text('p', 'muted small',
      state.conclusionError ? `读取失败：${state.conclusionError}` : '正在计算…'));
    return;
  }

  // ⚠️ 账号持有情况必须与界面上那一份**同源**：`state.owned` / `state.eidolons` /
  // `state.coneRanks` 就是 `accountPayload()` 发给服务端的三份，所以这里的差额与
  // 服务端算出来的边际成本完全一致（同一批已拥有状态）。
  //
  // 是否叠加「三月七 = 两命途互通」的别名，由 `advice.js` 决定（它在 `ownedCharacters`
  // 里做），界面不复制那条规则 —— 复制一份早晚会分叉。
  //
  // ⚠️ 2026-10-18 起 `teamPlan()` 的结果走**缓存**（`planWithCache()`）：翻页与搜索
  // 只重画这一页的 20 张卡，不重算全池（全池 22 ms 是 `_probe-team-plan-perf.mjs` 实测的；
  // 重建 20 张卡的耗时本机测不了 —— 没有浏览器，见 `docs/CDP布局套件.md` §2.1）。
  const { plan, haystacks } = planWithCache(conclusion);
  // 生效的权重由 `plan` 回显（已归一化）——界面照它印那**三个**系数，不自己再算一遍。
  const draw = plan.drawWeights || normalizeDrawWeights(state.drawWeights || {});
  const ws = formatShare(draw.strength);
  const wc = formatShare(draw.cost);
  // ③ 泛用性（用户 2026-10-13 第 3 条）：它现在也进补金推荐分，卡片的等式要印出来。
  const wv = formatShare(draw.versatility);

  // ---- 搜索 + 分页（用户 2026-10-18）-----------------------------------------
  //
  // 搜索只筛**这一批要展示的队伍**（不重算分数）：命中的队伍仍按补金推荐分排，
  // 名次沿用它在完整列表里的序号 —— 「我搜出来的这一支是第 12 名」要有意义。
  const query = queryOf(state.teamPlanQuery);
  // ⚠️ 2026-10-18：多关键词**同时包含**（AND）。`matchesQuery` 内部把整串拆成若干词
  //    逐个判，所以这里传整串即可；用 `terms.length` 判空是为了让「只敲了分隔符」
  //    （例如 `  ,  `）被当成「没搜索」而不是白跑一次 filter。
  const terms = queryTermsOf(state.teamPlanQuery);
  const matched = terms.length
    ? plan.rows.filter((row) => matchesQuery(haystacks.get(row), terms))
    : plan.rows;
  // 页码越界（搜索把结果缩短了 / 换账号后池子变小）时夹回最后一页 —— 否则会停在空页上。
  // 这段算术在 `advice-paging.js`（`pageSliceOf` 一份实现，Node 直接测）。
  const { rows: pageRows, start, page, pages } = pageSliceOf(
    matched, state.teamPlanPage, TEAM_PLAN_PAGE_SIZE,
  );
  state.teamPlanPage = page;
  // ⚠️ 2026-10-18（用户：「搜索到的结果应当显示其真实的排名，而不是重新开始算」）：
  //    卡片上的名次必须是**完整候选池**里的名次，不是「筛选后第几条」。
  //    改前用的是 `start + i + 1` —— 搜索后那是从 1 重排的，于是搜出来的卡片印着
  //    `#1 / #2 / …`，读起来就是「它在榜上排第 1」，那是假话。
  //    `start + i + 1` 本身没错（没搜索时它就等于真名次），所以保留给状态行的「第几条」。
  const pageRanked = withRealRank(plan.rows, pageRows);

  // ⚠️ 状态行在多词时要把「**同时包含**」说出来（用户 2026-10-18）：只印
  //    「搜索「A B」命中 24 支」的话，读者分不清是「名字里有 AB」还是「A 和 B 都要有」。
  const hit = terms.length
    ? ` · 搜索「${terms.join(' + ')}」${terms.length > 1 ? '（同时包含）' : ''}`
      + `命中 ${matched.length} 支`
    : '';
  const range = matched.length
    ? ` · 第 ${start + 1}–${start + pageRows.length} 条 / 共 ${matched.length} 条`
    : '';
  setMeta(plan.rows.length
    ? `候选 ${plan.pool} 支队伍（逐档榜 ∪ 总榜 ∪ 行动值前沿 ${plan.poolAll} 支里去掉「补金 0」的）`
      + `${hit}${range}${pages > 1 ? ` · 第 ${page}/${pages} 页` : ''}`
    : '没有需要补金的队伍');

  renderTeamPlanPager(matched.length, pages);

  if (!matched.length) {
    el.teamPlanBody.appendChild(text('p', 'muted small', query
      ? (terms.length > 1
        ? `没有队伍**同时**包含「${terms.join(' + ')}」这些角色或光锥`
          + `（多个关键词用空格分隔，结果要全都出现在同一支队伍里）。`
        : `没有队伍包含「${state.teamPlanQuery.trim()}」这个角色或光锥。`)
        + '（搜索只在这批候选队伍里找 —— 想换人或换队，看上面的角色总榜。）'
      : '当前角色池下，角色总榜的候选池里没有「还需要补金」的队伍（能上榜的队伍你已经凑齐）。'));
    return;
  }

  pageRows.forEach((row, i) => {
    const card = text('div', 'advice-plan-team');
    const head = text('div', 'advice-plan-team-head');
    // 名次 = **完整候选池**里的真实名次（2026-10-18 用户要求）。搜索 / 翻页都只是视图，
    // 它们不许改写名次 —— 没搜索时它等于 `start + i + 1`，搜索后那才是对的。
    head.appendChild(text('span', 'advice-unit-rank', `#${pageRanked[i].rank || start + i + 1}`));
    // 用户 2026-10-11（抽卡方案第 2 条）：「改为：补金推荐分 + 75.7 = 强度得分 68.0 × 0.5
    // + 性价比 83.3 × 0.5，注意空格不要离得太远」——所以徽标的标签改成「补金推荐分」、
    // 后面那句用普通空格（改前是 `　+　` 全角空格，实测两处各多出 ~8px）。
    // ⚠️ 2026-10-12 第 3、4、6 条之后第二项叫**性价比**（它本来就是那句原话里的名字）：
    // v4.6.87 一度改成合成的「性价比得分」，v4.6.89 按用户要求收回成单一刻度 ——
    // 所以这里印的是 `gapPct`，不是中间量。
    // ⚠️ 同样**懒构建**（`lazyTip()`）：改前一张卡就建一套详情，15 张卡 = 15 套；
    //    现在每页 20 张（v4.6.122 分页），懒构建更要紧 —— 20 套详情窗口一次全建进 DOM
    //    是白白多出的几万个节点。
    // `teamSlots` 这里给 0 —— 那个计数只服务总榜那条探针的选择逻辑（见 `lazyTip()` 的注释）。
    head.appendChild(valueBadge(row.total, lazyTip(() => teamPlanTip(row, plan)),
      (v) => Number(v || 0).toFixed(1), '补金推荐分'));
    // ⚠️ 三个分项名带「队伍」前缀（用户 2026-10-17 第 4 条：「补金推荐的强度/性价比/泛用性
    //    更名为队伍强度/队伍性价比/队伍泛用性」）—— 与角色总榜那三行（「角色强度 /
    //    角色性价比 / 角色泛用性」）分开：它们量的是**同一把尺子的不同对象**
    //    （这一支队 vs 承载证据的那个整包）。
    //    ⚠️ 原来第一项叫「强度得分」，「得分」二字在本轮按用户口径**去掉**（三项形式统一）。
    head.appendChild(text('span', 'advice-plan-team-eq',
      `= 队伍强度 ${Number(row.strengthPct).toFixed(1)} × ${ws}`
      + ` + 队伍性价比 ${Number(row.gapPct).toFixed(1)} × ${wc}`
      + ` + 队伍泛用性 ${Number(row.versatilityPct).toFixed(1)} × ${wv}`));
    card.appendChild(head);

    // ---- 队伍四个位置 --------------------------------------------------------
    const slots = text('div', 'advice-plan-team-slots');
    for (const m of row.members) {
      const slot = text('div', `advice-plan-team-slot${m.owned ? ' is-owned' : ' is-missing'}`);
      const icon = iconUrlOf('char', m.char);
      if (icon) slot.appendChild(iconImg(icon, 'advice-plan-team-icon'));
      const label = text('div', 'advice-plan-team-label');
      // 「已有 / 缺」徽标：2026-10-17 起与**总榜行**、**环境统计**同一套样式
      // （`.advice-own-badge`）。改前同一个意思有三套写法 —— 那两处是绿 pill，
      // 方案卡这里是自己的 `.advice-plan-team-own`（青 / 红 pill），并排在
      // 屏上就成了「三种已有」。
      // 位置也从「整张槽的最右边」挪到**角色名后面**，与另两处对齐。
      // ⚠️ 名字与徽标必须单独包一层 flex 行：`.advice-plan-team-label` 是 grid，
      //    直接 append 会让徽标独占一行（变成「名字 / 徽标 / 星魂 / 光锥」四行）。
      const nameRow = text('div', 'advice-plan-team-name');
      nameRow.appendChild(text('strong', 'advice-plan-team-char', cn(m.char)));
      nameRow.appendChild(text('span', `advice-own-badge${m.owned ? '' : ' is-gap'}`,
        m.owned ? '已有' : '缺'));
      label.appendChild(nameRow);
      label.appendChild(text('span', 'advice-plan-team-eidolon', `E${Number(m.eidolon) || 0}`));
      if (m.lc) {
        const cone = text('span', 'advice-plan-team-cone');
        const coneIcon = iconUrlOf('cone', m.lc);
        if (coneIcon) cone.appendChild(iconImg(coneIcon, 'advice-plan-team-cone-icon'));
        cone.appendChild(text('span', 'advice-unit-cone-text',
          `${cnCone(m.lc)} S${Number(m.superimp) || 1}`));
        label.appendChild(cone);
      }
      slot.appendChild(label);
      slots.appendChild(slot);
    }
    card.appendChild(slots);

    // ---- 金数与最佳证据 ------------------------------------------------------
    const facts = text('div', 'advice-plan-team-facts');
    // 账面金数按**数据集口径**算（本体 + 真实星魂级数 + 光锥本体×叠影），与下面那句
    // 「最佳证据：… N 金」同一个尺子 —— 否则 E3 被折成 E2 时两个数会对不上。
    // ⚠️ 2026-10-17：数字改走 `goldText()`（白色加粗）。改前是纯字符串拼，于是同一张卡里
    //    「账面 / 补金」是一身金色平体、而下面每笔补金又是白加粗 —— `goldText()` 的注释
    //    早就点名「别处再拼一遍就会出现有的数字白、有的灰」，这里正是被警告的那处。
    const goldLine = text('span', 'advice-plan-team-gold');
    goldLine.appendChild(text('span', '', '账面 '));
    goldLine.appendChild(goldText(row.displayGold ?? row.gold));
    if (row.hiddenCut > 0) {
      goldLine.appendChild(text('span', '', `（含隐金减免 ${row.hiddenCut} 金）`));
    }
    goldLine.appendChild(text('span', '', '｜补金 '));
    goldLine.appendChild(goldText(row.gap));
    facts.appendChild(goldLine);
    if (row.bestEnv) {
      const b = row.bestEnv;
      // ⚠️ 2026-10-17 三处对齐总榜行那一句（`renderUnits()` 里的 `.advice-unit-best`）：
      //    ① 语序从「285 行动值」改成「**行动值** 285」—— 两块并排时同一指标两种写法；
      //    ② 补上**档位**（`tierLabelOf`）—— 总榜那行有、这里原先没有；
      //    ③ 金数走 `goldText()`（与同一张卡的 facts 行一致），且**取不到时不画** ——
      //       改前写 `${b.bestTeamGold ?? '—'} 金`，缺数据会印出「— 金」（破折号吊个单位）。
      const best = text('span', 'advice-plan-team-best muted small');
      best.appendChild(text('span', '', `最佳证据：${b.label}`));
      const tierText = tierLabelOf(frontierEnvMeta(b.id), b.tier);
      if (tierText) best.appendChild(text('span', '', ` · ${tierText}`));
      if (Number.isFinite(Number(b.bestTeamGold))) {
        best.appendChild(text('span', '', ' '));
        best.appendChild(goldText(b.bestTeamGold));
      }
      if (Number.isFinite(Number(b.actionValue))) {
        const av = Number(b.actionValue);
        best.appendChild(text('span', '',
          ` · 行动值 ${Number.isInteger(av) ? av : av.toFixed(1)}`));
      }
      if (b.season) best.appendChild(text('span', '', ` · ${b.season} 版本`));
      facts.appendChild(best);
      // **来源视频**（用户 2026-10-14 第 6 条）：这张卡就是一支队，所以图标紧跟在
      // 「最佳证据」那半句后面 —— 它标的正是那支队伍的证据投稿。取不到地址时不画。
      // ⚠️ 这一份来自 `frontierTiers`（方案的候选池就是它）—— 服务端只在那份载荷上带了
      //    `video`，见 `src/server/conclusion.js` 的 `slimFrontierUnit`。
      const video = videoLink(b.video);
      if (video) facts.appendChild(video);
    }
    card.appendChild(facts);

    // 把分数转成用户可以执行的下一步：先告诉他已有多少，再告诉他第一笔该补什么。
    const recommendation = planRecommendation(row);
    const advice = text('div', 'advice-plan-team-recommendation');
    if (recommendation.icon) {
      const icon = iconImg(recommendation.icon, 'advice-plan-team-recommendation-icon',
        '下一步推荐', 'lazy');
      if (icon) advice.appendChild(icon);
    }
    const adviceCopy = text('div', 'advice-plan-team-recommendation-copy');
    adviceCopy.appendChild(text('strong', 'advice-plan-team-recommendation-title',
      recommendation.title));
    adviceCopy.appendChild(text('span', 'advice-plan-team-recommendation-body',
      recommendation.body));
    advice.appendChild(adviceCopy);
    card.appendChild(advice);

    const meters = text('div', 'advice-plan-team-meters');
    for (const [label, value, tone] of [
      // ① = 角色总榜那一列的强度分（绝对 0~100，2026-10-14 第 10 条口径），条宽与徽标同源。
      // 三项名带「队伍」前缀（用户 2026-10-17 第 4 条），与卡片等式、分数来源表三行**逐字一致**。
      ['队伍强度', row.strengthPct, 'strength'],
      // ② 就是徽标里那一项本身（用户第 6 条：只要性价比），条宽同一套数 ——
      // 否则「条比徽标长」会让人以为界面算错了。
      ['队伍性价比', row.gapPct, 'gap'],
      // ③ 泛用性（用户 2026-10-15）：队内成员按成本占比加权的泛用性得分。
      ['队伍泛用性', row.versatilityPct, 'versatility'],
    ]) {
      const meter = text('div', 'advice-plan-team-meter');
      const meterHead = text('div', 'advice-plan-team-meter-head');
      meterHead.appendChild(text('span', '', label));
      meterHead.appendChild(text('strong', '', `${Number(value).toFixed(0)} 分`));
      meter.appendChild(meterHead);
      const track = text('span', 'advice-plan-team-meter-track');
      const fillBar = text('span', `advice-plan-team-meter-fill is-${tone}`);
      fillBar.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
      track.appendChild(fillBar);
      meter.appendChild(track);
      meters.appendChild(meter);
    }
    card.appendChild(meters);

    // ---- 补金顺序（用户点名要的那一项）---------------------------------------
    // 用户 2026-10-11 第 5 条：**不显示抽数**、右侧那个「性价比 N」也删掉 ——
    // 一行只留「名字 + 目标状态 + 这一笔几金」。
    // 第 6 条：隐金设置下**不添加成本**的那几笔（`cost === 0`）不显示 ——
    // 它们本来就不用抽，列在「补金顺序」里只会让人以为还得花金。
    const fill = text('ol', 'advice-plan-team-fill');
    row.fill.filter((item) => Number(item.cost ?? item.pulls) > 0).forEach((item) => {
      const li = document.createElement('li');
      li.className = `advice-fill-item is-${item.kind}`;
      const icon = iconUrlOf(item.kind === 'cone' ? 'cone' : 'char', item.name);
      if (icon) li.appendChild(iconImg(icon, 'advice-fill-icon'));
      li.appendChild(text('strong', 'advice-fill-name', fillItemName(item)));
      li.appendChild(text('span', 'advice-fill-step', fillItemText(item)));
      // ⚠️ 这里写的是**不隐金时这一笔要几金**（`pulls`），与卡片上那句「补金 N 金」同一口径：
      // 隐金设置按用户明确要求**只影响角色总榜**，抽卡方案的差额不跟着变。
      // 隐金真把这一笔减到 0 时，这一笔整个不显示（见上面那条 `cost > 0` 的过滤）。
      li.appendChild(text('span', 'advice-fill-cost muted small',
        `${Math.max(0, Math.round(Number(item.pulls) || 0))} 金`));
      fill.appendChild(li);
    });
    card.appendChild(fill);

    // ---- 过渡档位（用户 2026-10-11 第 7 条）-----------------------------------
    // 需要补多笔时，先补前半段就能到一个**成本完全下位**的中间配队（要买的项是子集），
    // 补金顺序天然先到它；这一行把它写出来，方便「平滑地补金」。
    if (row.mid) {
      card.appendChild(text('p', 'advice-plan-team-mid muted small',
        `过渡：先补前 ${row.mid.items} 笔（${row.mid.gold} 金）→ ${midStateText(row.mid)}，`
        + `再补 ${row.mid.rest} 金到本方案`));
    }

    el.teamPlanBody.appendChild(card);
  });

  // 归一化上下限**跟着数据走**（用户 2026-10-11 第 2 条：不能写死），所以必须写在界面上，
  // 否则「为什么只补 1 金却排在 5 金后面」这种问题读者无法自查。
  // ⚠️ 措辞必须把**封顶值那一档**说清楚：② 是**封顶**的（用户第六轮选了「p50 封顶」、
  //    第八轮改到 p75，因为池子放宽之后 p50 自己变小、把强队压死；2026-10-15 调到 p60）——
  //    而且 **2026-10-15 起 0 以下不再截断**（用户：「可不可以让性价比过低的得分改为负数」），
  //    所以文案从「达到或超过就 0 分」改成「正好到 = 0 分、超过就转负分」。
  //    不写出来读者会以为「补 30 金的队伍也拿得到几分」，或者反过来以为贵队一律 0 分
  //    （那正是改前那种「贵队之间全打平」的毛病）。
  // ⚠️ 封顶分位必须**现取** `plan.gapCapPct`：这里原来在另一处的刻度行写死了「池内 p75」，
  //    常量调到 p60 之后界面一直在说假话。
  // ⚠️ 还要写明刻度取自**整个候选池**（第七轮修）：这样「只列前 N 条」就不会被误读成
  //    「分数是按这 N 条算的」——改条数时分数不变，读者得能从文案上看出来。
  // ⚠️ v4.6.83 起候选池的来源是**逐档榜**（每角色 × 每星魂档各一条），不再是总榜 ——
  //    文案必须跟着改，否则读者会拿「总榜 84 支」去对「候选 245 支」，以为算错了。
  const capPct = Math.round((Number(plan.gapCapPct) || 0.75) * 100);
  // ② 那条曲线的指数（用户 2026-10-12 第 9 条）：脚注必须写出来，否则读者按线性算会对不上。
  const gapPower = Math.max(1, Number(plan.gapPower) || 1);
  /**
   * ② 那条曲线上的**取样点**：给两个「补 N 金能拿几分」的实例，读者才量得出这条曲线有多陡。
   *
   * ⚠️ **必须按当前的封顶值与指数现算，不能写死数字**（2026-10-15 修）：改前这里写的是
   *    「补 2 金 79 分、补 8 金 28 分、补 10 金 15 分」——那三个数是对着**旧的**
   *    封顶（池内 p75 ≈ 14 金）与**旧的**指数（^1.5）算出来的。封顶改成 p60、指数改成
   *    ^1.8 之后三个数**一个都不对**，而界面照样印出来 —— 这正是仓库里反复出现的
   *    「口径改了、文案没跟着改，于是界面上写着假话」。现算之后这类改动再也不会失同步。
   * ⚠️ **指数后来又收回 1.5**（用户 2026-10-17「差额接近度以 1.5 为准」；^1.8 越界了
   *    「小差额几乎不动」那条口径，理由见 `advice.js` 里 `teamPlanGapPower` 的换挡史）。
   *    所以现在这一格印的是**封顶 p60 + 指数 1.5**——上面那段 ^1.8 只是当时的记录。
   */
  const gapSample = (g) => {
    const t = 1 - g / Math.max(1, plan.gapMax);
    // ⚠️ 与 `advice.js` 里那条曲线**同一个形状**（含 0 以下的负分，见 `teamPlanGapPower`
    //    的注释）：`sign(t) × |t|^k`，幅值截到 1。负数不能直接开小数次方（JS 给 NaN）。
    const curve = Math.sign(t) * Math.abs(t) ** gapPower;
    return (100 * Math.max(-1, Math.min(1, curve))).toFixed(0);
  };
  const gapHalf = Math.max(1, Math.round(Number(plan.gapMax) / 2));
  // ⚠️ 取一个**明确超过封顶值**的取样点，读者才看得到「负分」那一段长什么样。
  const gapOver = Math.max(Number(plan.gapMax) + 3, Math.round(Number(plan.gapMax) * 1.5));
  const capped = plan.rows.filter((r) => r.gap >= plan.gapMax).length;
  const drawFoot = plan.drawWeights || normalizeDrawWeights(state.drawWeights || {});
  el.teamPlanBody.appendChild(text('p', 'muted small advice-plan-team-foot',
    `口径：候选 = 角色**逐档榜 ∪ 总榜 ∪ 行动值前沿**按队伍去重`
    + `（逐档榜 = 每个角色在 E0/E1/E2/E6 各收敛一条，再并上每个角色的总最佳；`
    + `行动值前沿 = 各副本行动值最好的几支队，${plan.poolAv ?? 0} 支；共 ${plan.poolAll} 支），`
    + `去掉补金 0 金的之后剩 ${plan.pool} 支 —— `
    + '**这样同一支队伍的低配档位也在池内**，便宜但强度略低的队伍能靠补金少拉分；'
    // ⚠️ 2026-10-18 起**整池都列出来**（用户要求「尽可能多的配队」），所以这里不能再写
    //    「只列前 N 条」——那句文案从 v4.6.56 起一直是「截断只影响显示」，现在没有截断了。
    + `**${plan.rows.length} 支**全部列在这里（按补金推荐分排），每页 ${TEAM_PLAN_PAGE_SIZE} 支、`
    + '可翻页，上面的搜索框按角色 / 光锥名筛；'
    // ⚠️ 2026-10-15：① 换成角色总榜那一列的**绝对强度分**（用户 2026-10-14 第 10 条重定：
    //    围绕行动值 + 投入单调，**省金是性价比那一项的事**）。v4.6.91~2026-10-14 这里写的是
    //    「含金数项的整包分按候选池归一」，那会让**池内最省金**的那支自动拿 100 分 ——
    //    用户 2026-10-15 报的「这支 10 金的队强度得分怎么是 100」就是这个错位。
    + `队伍强度 = **角色总榜那一列的强度分**（绝对 0~100，与总榜同一把尺子：`
    + `每副本取**最近版本**那一次成绩的行动值、按关卡权重加权、再按投入档位补 5 分 —— `
    + `所以**行动值越低越高、投入越高越高**，E6S5 > E6S1 > E2S1 > E0S0），`
    + '**与金数无关**（「这支队打得多好」与「你要补几金」是两件事）；'
    // ⚠️ 用户 2026-10-12 第 6 条之后这里**只有一个刻度**（性价比）——
    //    别再写成「差额 × a + 压金 × b」：那层合成已删（它等于同一个数的两种名字）。
    + `队伍性价比 = sign(1 − 补金 ÷ ${plan.gapMax} 金) × |1 − 补金 ÷ ${plan.gapMax} 金|^${gapPower}`
    + `（**候选池**差额的 ${capPct} 分位当封顶值：**正好到封顶值 = 0 分，超过就转负分**，`
    + `最低 −100 —— 2026-10-15 起 0 以下不再截断，否则贵队之间全是 0 分、这一项等于失效；`
    + `指数 ${gapPower} 是「给要补大量金的队伍少给点分」那条曲线 —— 补 2 金 `
    + `${gapSample(2)} 分、补 ${gapHalf} 金 ${gapSample(gapHalf)} 分、`
    + `补到 ${plan.gapMax} 金 0 分、补 ${gapOver} 金 ${gapSample(gapOver)} 分，`
    + `候选池里有 ${capped} 支落在这一档`
    + `${Number(plan.gapRealMax) > Number(plan.gapMax)
      ? `、补金最多的是 ${plan.gapRealMax} 金` : ''}）；`
    + '「这支队总共几金」（卡片上的账面金数）只作参考，**不进分数**；'
    + `补金推荐分 = 队伍强度 × ${formatShare(drawFoot.strength)}`
    + ` + 队伍性价比 × ${formatShare(drawFoot.cost)}（抽卡权重，上面可调）；`
    + '补金顺序按每抽收益（性价比 ÷ 期望抽数）从高到低，光锥一定排在它自己的角色之后。'
    + '① 是绝对刻度（换账号不变）；②③ 的上下限随账号与数据现算，这两个换账号后不可直接比较。'));
};

// ------------------------------------------------------- 跨模式综合结论（渲染）

/**
 * 角色总榜（用户 2026-10-12 第 1 条把「性价比总榜」改名为「角色总榜」）：纯黑塔网数据，角色 / 星魂 / 光锥混排。
 *
 * 榜单**按星魂档分视图**（用户 2026-10-11 报的缺陷）：
 *   * `all` —— `frontierUnits`，每个角色一条（总分最高的整包）；
 *   * `E0/E1/E2/E6` —— `frontierTiers[n]`，**每个档位各自收敛一条**。
 * 选哪一份由 `unitListOf()` 决定，这里不再自己按 `eidolon` 过滤「全部」那份
 * （那正是缺陷的来源：最佳成绩不在这一档的角色会整行消失）。
 */
const renderUnits = () => {
  if (!el.conclusionUnits) return;
  el.conclusionUnits.innerHTML = '';
  const all = state.conclusion?.frontierUnits || [];
  if (!all.length) {
    el.conclusionUnits.appendChild(text('p', 'muted small',
      state.conclusionError
        ? `读取失败：${state.conclusionError}`
        : (state.conclusion ? '本地数据集里还没有可用的压金前沿数据。' : '正在计算…')));
    if (el.unitMeta) el.unitMeta.textContent = '';
    return;
  }
  const list = unitListOf(state.conclusion, state.unitEidolon);
  // 搜索（用户 2026-10-18）：在**当前星魂档**那一份榜里按「角色名 / 光锥名（中英都认）」
  // 做子串匹配。次序仍按榜面名次 —— 搜索结果不该自己重排，用户是在**找**某一项，
  // 而不是在比较它们。
  const query = queryOf(state.unitQuery);
  // ⚠️ 2026-10-18：多关键词**同时包含**（AND），与抽卡方案同一把尺子
  //    （`matchesQuery` + `queryTermsOf` 都在 advice-paging.js）。
  const terms = queryTermsOf(state.unitQuery);
  const matched = terms.length
    ? list.filter((unit) => matchesQuery(unitSearchText(unit), terms))
    : list;
  const filtered = matched.filter((unit) => !state.onlyMissing || ownedStateOf(unit) !== 'have');
  const rows = filtered.slice(0, UNIT_ROWS_MAX);
  // ⚠️ 2026-10-18（用户：「搜索到的结果应当显示其真实的排名，而不是重新开始算」）：
  //    行首的 `#N` 要是这一行在**完整榜**（当前星魂档那一份 `list`）里的名次。
  //    改前那个 `#${i+1}` 是筛选后从 1 重排的，于是搜出来的第一行印「#1」——
  //    读起来像「这个角色在榜上排第 1」，其实是第 41。搜索只是视图，名次是榜的。
  const rowRank = new Map(withRealRank(list, rows).map((x) => [x.row, x.rank]));
  if (el.unitMeta) {
    // 口径写清楚：切到某一档时，这一行报的是**这一档**的角色数，不是「全部」那份的子集。
    const scope = state.unitEidolon === 'all'
      ? `共 ${list.length} 条（每个角色一条）`
      : `${tierNameOf(state.unitEidolon)} 档 ${list.length} 个角色各一条（它抽到这一档时最强的整包）`;
    // 搜索状态**必须印出来**：否则「榜上只剩 3 条」看着像数据丢了（搜索词在工具条里，
    // 而工具条可能已经滚出屏幕）。命中数按「搜索后、只筛匹配前」数 —— 那才是搜索的答案。
    // ⚠️ 同抽卡方案那边：多词要印「同时包含」，否则读者以为是在搜一个长名字。
    const hit = terms.length
      ? `搜索「${terms.join(' + ')}」${terms.length > 1 ? '（同时包含）' : ''}命中 ${matched.length} 条`
      : '';
    const tail = rows.length < filtered.length
      ? `只显示前 ${rows.length} 条（${scope}，筛后 ${filtered.length} 条）`
      : (state.onlyMissing ? `${scope}，筛掉已有的后剩 ${filtered.length} 条` : scope);
    el.unitMeta.textContent = hit ? `${hit} · ${tail}` : tail;
  }
  if (!rows.length) {
    el.conclusionUnits.appendChild(text('p', 'muted small',
      query ? (terms.length > 1
        ? `当前星魂档里没有同时包含「${terms.join(' + ')}」的角色或光锥`
          + '（多个关键词用空格分隔）。'
        : `当前星魂档里没有匹配「${state.unitQuery.trim()}」的角色或光锥。`)
        : '当前筛选下没有条目。'));
    return;
  }
  // 并列：分子只来自队伍，所以同一支队伍的成员必然同分。名次照旧按顺序编，
  // 但在行上加一个标记并说明「与哪些行并列」，否则看起来像排序坏了。
  // ⚠️ 判据用**角色得分**（用户 2026-10-13 第 2 条起榜面按它排序）——
  // 比较 `total` 会与排序键不同源，「并列」标记就会标错行。
  const sameScore = (a, b) => Math.abs(unitRoleScore(a) - unitRoleScore(b)) < 1e-9;
  rows.forEach((unit, i) => {
    const row = text('div', 'advice-unit is-pack');
    const head = text('div', 'advice-unit-head');
    head.appendChild(text('span', 'advice-unit-rank', `#${rowRank.get(unit) || i + 1}`));
    if (i > 0 && sameScore(unit, rows[i - 1])) {
      const tie = text('span', 'advice-unit-tie', '并列');
      tie.title = '与上一行同分：它们属于同一支队伍的最佳证据 —— '
        + '总榜的分子分母都只来自队伍，所以同队成员必然并列。';
      head.appendChild(tie);
    }
    // 用户 2026-10 要求①：总榜每一行都要有「角色头像 + 光锥图标」两张图。
    // 头像摆在名字**前面**（一眼认出是谁）。
    //
    // ⚠️ 光锥图标**不在这里**：它由 `packCostNode()` 放进花费那一格、夹在「+」与
    // 光锥名之间（用户 2026-10-10 第三轮点名：「移到左边好看，但要保证光锥位于
    // 加号右侧、名称左侧，且名称必须带有叠影层数 S1-S5」）——
    //     … E2  + [icon] 菇菇嘎嘎历险记 S5  · 3 金  [性价比得分 +xxx]
    // 演进：第一轮它是 head 的直接子节点（在「E2」之后、花费之前）；第二轮移到名称
    // **右边**；本轮按用户要求移到加号与名称**之间**。
    // ⚠️ 无论哪种排法都**不能**插在花费与性价比得分徽标之间：那条间距有 CDP 断言
    // 盯着（「性价比得分 +xxx 要紧贴花费文字」，见 tools/check-advice-layout.mjs
    // 的 badge.gapToText），插进去会让徽标离文字变远。
    head.appendChild(unitAvatar(unit.name));
    head.appendChild(text('strong', 'advice-unit-name',
      `${cn(unit.name, unit.nameCn)}`));
    const owned = ownedStateOf(unit);
    if (owned === 'have') head.appendChild(text('span', 'advice-own-badge', '已有'));
    // 2026-10 用户要求③：删掉「差这一档」这个标注（只保留「已有」徽标）。
    // 判据没变、`ownedStateOf()` 仍然返回 'gap'（「只看我没有的」筛选还在用它），
    // 只是不再往界面上写这句话 —— 用户嫌它在一行里占位又没给可操作的信息。
    // 整包的星魂档 + 光锥（含叠影）就是这一行的「身份」，代替旧的类型徽标。
    head.appendChild(text('span', 'advice-unit-kind', `E${Number(unit.eidolon) || 0}`));
    head.appendChild(packCostNode(unit));
    // 角色得分徽标紧跟在花费后面（用户要求「移到左边、靠近别的文字」），
    // **点一下**开那个详情大窗口（`advice-tip-window.js`）。
    // ⚠️ 值走 `unitRoleScore()`（= 服务端算好的三个分项加权分，用户 2026-10-13 第 2 条）；
    // 合成夹具没有它时才退回老的 `total`。
    head.appendChild(valueBadge(unitRoleScore(unit),
      lazyTip(() => frontierTip(unit), { teamSlots: teamSlotHint(unit) }), packScoreText));
    row.appendChild(head);

    // 这一行排在这里的**依据**：最佳证据那支队伍的档位 / 金数 / 行动值。
    const best = text('div', 'advice-unit-best');
    const bestEnv = unit.envs[0];
    const bestMeta = bestEnv ? frontierEnvMeta(bestEnv.id) : null;
    if (bestEnv) {
      best.appendChild(text('span', 'advice-unit-best-label', '最佳证据：'));
      best.appendChild(text('span', '', `${bestMeta?.label || bestEnv.id} · `
        + `${tierLabelOf(bestMeta, bestEnv.tier)} · `));
      // ⚠️ 2026-10-17：金数走 `goldText()`（白色加粗）—— 与同一行上面的「花费」、
      //    与抽卡方案卡片上的「账面 / 补金」同一套强调；改前这里是纯文本，
      //    同一块界面上有的金数白加粗、有的随正文色。
      best.appendChild(goldText(bestEnv.bestTeamGold));
      if (Number.isFinite(Number(bestEnv.actionValue))) {
        best.appendChild(text('span', '', ` · 行动值 ${bestEnv.actionValue}`));
      }
      if (bestEnv.evidenceSeason) {
        best.appendChild(text('span', '', ` · ${bestEnv.evidenceSeason} 版本`));
      }
    } else {
      best.appendChild(text('span', 'muted small', '（这条名次较靠后，未逐副本展开证据）'));
    }
    row.appendChild(best);

    const envs = text('div', 'advice-unit-envs');
    // 总榜**行**最多画 3 个关卡 chip（一个整包最多 5 个关卡：混沌 / 虚构 / 末日 /
    // 异相仲裁 / 绝境），超出的用「等 N 个副本」提示。
    // ⚠️ 判据必须是「**画出来的 chip 数**」，不是 `unit.envs.length`（2026-10-11 v4.6.77 修）：
    // 载荷以前把 `envs` 截到 3 个，于是 `envCount > envs.length` 恰好等价；明细发全之后
    // 5 关卡的条目会变成 `5 > 5 = false`，**那半句提示会凭空消失**（用户看到的是「只列了
    // 3 个关卡、又不说还有几个」，比改前更差）。
    const ENV_CHIPS = 3;
    for (const env of unit.envs.slice(0, ENV_CHIPS)) envs.appendChild(envChip(env));
    const envTotal = Number(unit.envCount) || unit.envs.length;
    if (envTotal > ENV_CHIPS) {
      envs.appendChild(text('span', 'muted small', `等 ${envTotal} 个副本`));
    }
    if (envs.childNodes.length) row.appendChild(envs);
    el.conclusionUnits.appendChild(row);
  });
};

// ------------------------------------------------- ② 抽卡方案（按你的角色池 + 边际收益）

/** `Number(null) === 0`：数据里的 null 是「没有这项证据」，不能当成 0 显示。 */
const numOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * 一条补强的「为什么」。三种口径，按副本类型与证据形态挑一种：
 *   * 好打副本（有成本证据）：`0T 队伍一般 5 金 → 这套 4 金（省 1 金）`
 *   * 好打副本（成本尺子退化）：档位变化 ≤2T → 0T —— 实测大量条目走这条，
 *     因为混沌回忆/虚构叙事里人人 0T，成本分不出高下，真正动的是档位
 *   * 难打副本：击败比例 12% → 38%
 *
 * ⚠️ 所有档位一律写成**游戏内实际的量**（`0T` / `积分 ≥3700` / `行动值 <300`）：
 * 用户 2026-10-10 要求「把网页上显示的『满分』『达标』改为具体的行动值」。
 * 判据线由调用方的 `labelsOf(envId)` 给（`tierLabelsOf(row.mode, row.stage, row.tierLines)`），
 * 拿不到时退回 `TIER_PLACEHOLDER` 的中性写法，**不编数字**。
 */
const envGainText = (env, labelsOf, kind) => {
  const labels = labelsOf(env.id) || {};
  const perfectLabel = labels.perfect || TIER_PLACEHOLDER.perfect;
  const targetLabel = labels.target || TIER_PLACEHOLDER.target;
  if (env.easy) {
    const before = numOrNull(env.costBefore);
    const after = numOrNull(env.costAfter);
    if (before !== null && after !== null && after < before) {
      return `「${env.envLabel}」${perfectLabel} 队伍一般 ${before} 金 → 这套 ${after} 金（省 ${before - after} 金）`;
    }
    const move = tierMoveOf(env, labelsOf);
    if (move) return `「${env.envLabel}」${move}`;
    // 星魂 / 光锥在好打副本里的贡献是「把档位的期望抬高多少」（见 advice.js
    // 的 gradeGain）：成本尺子在人人 0T 的副本里量不出高下，这一项才是关键金。
    const step = numOrNull(env.eidolonStep);
    if (kind !== 'char' && step !== null && step > 0.05) {
      if (step >= 0.75) return `「${env.envLabel}」关键金：升这一档能把队伍推上 ${perfectLabel}`;
      return `「${env.envLabel}」关键金：升这一档把「${targetLabel}」的期望抬高 ${Math.round(step * 100)}%`;
    }
    if (after !== null) return `「${env.envLabel}」这套成本与常见解法持平（${after} 金）`;
    return `「${env.envLabel}」这条证据里没有成本差`;
  }
  const before = numOrNull(env.pctBefore);
  const after = numOrNull(env.pctAfter);
  if (after === null) return `「${env.envLabel}」有提升（数据里没有成绩分布）`;
  if (before === null) return `「${env.envLabel}」直接拉到击败 ${after}% 的人`;
  return `「${env.envLabel}」击败比例 ${before}% → ${after}%（+${(after - before).toFixed(1)} 点）`;
};

/** 档位变化（游戏内实际的量：0T / ≤2T / 积分 4000 …）；没有跨档时返回 null。 */
const tierMoveOf = (env, labelsOf) => {
  if (!env.tier || !env.tierFrom || env.tier === env.tierFrom) return null;
  const labels = labelsOf(env.id);
  if (!labels) return null;
  const from = labels[env.tierFrom];
  const to = labels[env.tier];
  if (!from || !to || from === to) return null;
  return tierMoveText(from, to);
};

// ------------------------------------------------------- 跨模式综合结论（渲染）

const renderConclusion = () => {
  if (!el.conclusion) return;
  // 总榜是纯黑塔网口径的，**不依赖登录**，所以这一节始终显示；
  // 「抽卡方案」那一块在没登录时自己会给出说明。
  el.conclusion.hidden = false;
  // 性价比详情的**大窗口**接线（点徽标 → 开窗）：两个榜各接一次。
  wireValueTips(el.conclusionUnits);
  const conclusion = state.conclusion;
  const c = conclusion?.counts || {};
  const frontier = state.conclusion?.frontierUnits || [];
  if (el.conclusionMeta) {
    // ⚠️ 旧版这里写的是「角色 N / 星魂 N / 光锥 N」（按 `kind` 数）—— 整包口径之后
    // 每条都是 `kind: 'pack'`，那三个数**恒为 0 / 0 / 0**，等于一行废话。
    // 换成用户真正会用的维度：每个星魂档各有多少个角色（= 筛选器上的计数）。
    const tiers = tierKeysOf(conclusion);
    const tierText = tiers.length
      ? ` · 按星魂档：${tiers.map((t) => `${tierNameOf(t)} ${unitListOf(conclusion, t).length}`).join(' / ')}`
      : '';
    el.conclusionMeta.textContent = frontier.length
      ? `${c.envs || 0} 个副本/关卡 · 总榜 ${frontier.length} 条（每个角色一条）${tierText}`
      : (state.conclusionError ? '读取失败' : '正在计算…');
  }
  renderUnits();
  renderUnitFilters();
  renderTeamPlan(conclusion);
};

const loadConclusion = async () => {
  if (!state.index) return;
  const payload = accountPayload();
  const key = conclusionKey();
  state.conclusionKey = key;
  state.conclusionError = '';
  try {
    const res = await fetch('/api/archive/conclusion', {
      method: 'POST',
      headers: accessHeaders({ 'Content-Type': 'application/json' }),
      // 副本权重只发**一套**（用户 2026-10-11 第 10 轮「去掉方案权重那一行」）：
      //   frontierWeights → 角色总榜，也是队伍抽卡方案「强度得分」的来源（同一套关卡权重）
      // 服务端仍认得 `planWeights`（旧 API 兼容），界面不再发它；不传时服务端对
      // `plan` 那一侧退回默认口径，而那一侧（旧 `units` 清单）界面已经不渲染了。
      // 隐金设置（用户 2026-10-11）只影响总榜那一块，但**必须显式发**：接口不传 =
      // 一项都不减，而界面的默认值是「全勾」（见 state.hiddenCosts 的注释）。
      body: JSON.stringify({
        account: payload,
        window: 6,
        frontierWeights: activeWeights(WEIGHT_SCOPE),
        hiddenCosts: { ...(state.hiddenCosts || {}) },
        // 抽卡权重（用户 2026-10-13 第 1、2 条）：角色总榜的三个分项按它加权，
        // 而总榜的「每角色只留一条」收敛在服务端 —— 所以**必须显式发**。
        // 服务端会回显归一化后的那一份（`data.drawWeights`），界面据此印比例。
        drawWeights: { ...(state.drawWeights || {}) },
        // 版本权重（用户 2026-10-16 第 3 条）：6 个槽位的**数组**（下标 0 = 每个副本
        // 自己的最新版）。服务端按它现算每个副本的 `seasonWeights`，客户端再拿那份
        // 做跨版本加权 —— 所以**必须显式发**（不传 = 默认表）。
        versionWeights: [...(state.versionWeights || [])],
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      const message = res.status === 401
        ? (readAccessToken()
          ? '访问令牌无效。请检查地址中的 #token=… 后重新加载。'
          : '此服务需要访问令牌，请使用 #token=你的令牌 追加到地址后重新加载。')
        : (data?.error || `HTTP ${res.status}`);
      throw new Error(message);
    }
    // 期间账号或权重又变了就以最新那一次为准，避免旧结果覆盖新结果。
    if (state.conclusionKey !== key) return;
    state.conclusion = data.available === false ? null : data;
    if (data.available === false) state.conclusionError = data.hint || '本地还没有数据集';
  } catch (err) {
    if (state.conclusionKey === key) {
      state.conclusion = null;
      state.conclusionError = err.message;
    }
  }
  renderConclusion();
};

/** 环境统计（上场率）：当前副本 / 版本下，各角色在投稿里出现多少次。 */
const renderCharacters = (stats) => {
  el.chars.innerHTML = '';
  // 这一节改成两列 / 三列的紧凑网格之后高度只有原来的 1/3，所以多给一些
  // （原来 40 行是为了「一屏别铺太长」，现在不需要了）。
  const rows = (stats.characters || []).slice(0, 60);
  el.charMeta.textContent = rows.length
    ? `共 ${stats.characters.length} 个角色 · 近 ${stats.recentSeasons.length} 个版本`
    : '';
  rows.forEach((row, i) => {
    const wrap = text('div', 'advice-char-row');
    wrap.appendChild(text('span', 'advice-rank', `#${i + 1}`));
    const card = text('div', `advice-char${state.owned.has(row.name) ? ' is-owned' : ''}`);
    const head = text('div', 'advice-char-head');
    const name = text('span', 'advice-char-name', characterName(row));
    if (state.owned.has(row.name)) name.appendChild(text('span', 'advice-own-badge', '已有'));
    head.appendChild(name);
    head.appendChild(text('span', 'advice-char-count', `${row.count} 次`));
    card.appendChild(head);

    const meta = text('div', 'advice-char-meta');
    if (row.pathCn || row.path) meta.appendChild(text('span', 'advice-path', row.pathCn || row.path));
    // 绝境王棋关的判据是行动值而不是轮次，所以这里要用 bestAv（最好行动值）；
    // 其余模式用 best（轮次制就是轮次，末日幻影就是积分）。
    const bestRaw = stats.stage === 'plight' && Number.isFinite(row.bestAv)
      ? row.bestAv : row.best;
    if (Number.isFinite(bestRaw)) {
      meta.appendChild(text('span', '', `最佳 ${metricValueText(stats.mode, stats.stage, bestRaw)}`));
    }
    if (row.eidolon?.share) {
      const top = row.eidolon.dist.indexOf(Math.max(...row.eidolon.dist));
      meta.appendChild(text('span', '', `主流 E${top}（${formatRate(row.eidolon.share[top])}）`));
    }
    card.appendChild(meta);
    wrap.appendChild(card);
    el.chars.appendChild(wrap);
  });
};

const render = () => {
  // 三份数据的状态一起画（角色快照 / 战斗记录 / 黑塔网数据），见 `dataStatusCells()`。
  renderDataStatus();
  // 战斗记录与综合结论都跟「当前选中的副本」无关，所以先渲染，
  // 不要被下面「统计还没读到」的提前返回挡掉。
  renderRecord();
  renderConclusion();
  const stats = state.stats;
  if (!stats) return;
  renderCharacters(stats);

  // 「环境统计」这一节按当前副本算，所以把这一期的判据线写进它的说明里
  // （旧的「推荐阵容」标题行连同它的说明块一起按用户要求撤掉了）。
  if (el.charNote) {
    el.charNote.textContent = `判据：${tierLineText(stats).replace(/^判据：/, '')}`
      + `${stats.stage === 'plight' || stats.mode === 'as' ? '' : '（T = 轮次）'}。`
      + '上场率只看「玩的人多不多」，不代表强；要判断强度请看上面的角色总榜。';
  }

  el.body.hidden = false;
  el.empty.hidden = true;
};

// ------------------------------------------------------------------ loading

const loadStats = async () => {
  if (!state.mode || state.loading) return;
  state.loading = true;
  el.loading.hidden = false;
  try {
    const query = new URLSearchParams({ mode: state.mode, window: '6', perBand: '8' });
    if (state.stage) query.set('stage', state.stage);
    if (state.season) query.set('season', state.season);
    state.stats = await apiGet(`/api/archive/stats?${query}`);
    render();
  } catch (err) {
    showEmpty(`读取投稿统计失败：${err.message}`);
  } finally {
    state.loading = false;
    el.loading.hidden = true;
  }
};

/**
 * ⚠️ **并发的 `loadIndex()` 必须共用同一次请求**（2026-10-14 实测踩到）。
 *
 * 启动时会有两个调用方同时进来：顶栏图标的 `applyAppIcon()`（`app.js` 里那句
 * `void applyAppIcon()`）与抽卡页自己的取数。两边都看到 `state.index === null`，
 * 于是 `/api/archive`（实测 **168 KB**）被拉**两遍**，整个索引 UI 也跟着重画两遍。
 * 用一个模块级 promise 把在途请求收口：第二个调用方直接拿同一个结果。
 *
 * ⚠️ `.finally` 里要清空 —— 否则失败之后这个 promise 会被永久缓存，
 * 用户再点「重新读取」也永远读到那次失败（那一类 bug 修过一次：见 `packsCache`
 * 「失败的**不缓存**」那条注释）。
 */
let indexPromise = null;
const loadIndex = async () => {
  if (indexPromise) return indexPromise;
  indexPromise = (async () => {
    state.index = null;
    // 先清掉那一格（重读 / 同步进行中时不该留着上一份的生成时间），取到索引再画。
    renderDataStatus();
    el.loading.hidden = false;
    try {
      const index = await apiGet('/api/archive');
      if (!index.available) {
        showEmpty('还没有采集抽卡推荐所需的资料。', index.hint || '');
        return;
      }
      state.index = index;
      renderDataStatus();
      renderModeOptions();
      const mode = index.modes.find((m) => m.mode === state.mode);
      const stage = (mode?.stages || []).find((s) => s.stage === state.stage);
      state.season = (stage?.seasons || mode?.seasons || []).slice(-1)[0]
        || index.latestPerMode?.[state.mode] || null;
      renderSeasonOptions();
      await loadStats();
    } catch (err) {
      showEmpty(`无法读取本地资料索引：${err.message}`);
    } finally {
      el.loading.hidden = true;
    }
  })().finally(() => { indexPromise = null; });
  return indexPromise;
};

// ------------------------------------------------------------------- 手动更新

/**
 * 「同步黑塔网数据」：只抓缺的版本与各副本最新版本（旧版本不会变，没必要重抓）。
 *
 * 服务端用 SSE 推进度，这里把每一行进度显示在提示条里。更新过程会改写本地
 * theherta/ 数据，所以服务端在动手前先自动留档（见 tools/package.mjs 的思路）。
 */
const runUpdate = () => {
  if (state.updating) return;
  state.updating = true;
  el.update.disabled = true;
  el.empty.innerHTML = '';
  el.empty.hidden = false;
  el.empty.appendChild(text('div', 'warn-lead', '正在同步黑塔网数据…'));
  const log = text('pre', 'update-log');
  el.empty.appendChild(log);
  el.empty.scrollTop = 0;

  const append = (line) => {
    log.textContent += `${line}\n`;
    el.empty.scrollTop = el.empty.scrollHeight;
  };
  const finish = () => {
    append('完成，正在重读本地统计…');
    state.updating = false;
    el.update.disabled = false;
    el.empty.hidden = true;
    state.index = null;
    renderDataStatus();
    loadIndex();
  };
  const fail = (message) => {
    append(`失败：${message || '更新失败'}`);
    state.updating = false;
    el.update.disabled = false;
  };
  void (async () => {
    try {
      const response = await fetch('/api/archive/update', { headers: accessHeaders() });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
        throw new Error(response.status === 401
          ? (readAccessToken() ? '访问令牌无效，请检查 #token=…' : '请使用 #token=你的令牌 访问此服务')
          : payload?.error || `HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = 'message';
      let dataLines = [];
      const dispatch = () => {
        const raw = dataLines.join('\n');
        dataLines = [];
        if (eventName === 'progress') {
          try {
            const data = JSON.parse(raw);
            append(data.message || JSON.stringify(data));
          } catch { append(raw); }
        } else if (eventName === 'done') finish();
        else if (eventName === 'failed') {
          try { fail(JSON.parse(raw).message); } catch { fail(raw); }
        }
        eventName = 'message';
      };
      while (state.updating) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line) { dispatch(); continue; }
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
      }
      if (state.updating) throw new Error('连接中断（服务端可能仍在后台运行）');
      await reader.cancel().catch(() => {});
    } catch (error) {
      if (state.updating) fail(error.message);
    }
  })();
};

// ------------------------------------------------------------------- public

/**
 * Bind the tab. `getSnapshot` is called lazily so the advice view always sees
 * the character list of whatever role the record tab currently has loaded.
 */
export const mountAdviceView = (options = {}) => {
  state.onNeedSnapshot = options.getSnapshot || null;
  state.onNeedSnapshotResponse = options.getSnapshotResponse || null;
  state.onNeedRole = options.getRole || null;
  state.onOpenCharacter = options.onOpenCharacter || null;
  // 角色面板浮层（战斗记录里点角色）：关闭 / 背景 / ESC
  wireRecordPanel();

  /**
   * 搜索框接线（用户 2026-10-18：「为角色总榜和抽卡方案添加 2 个搜索框」）。
   *
   * 三个细节都不是可选项：
   *   ① **防抖**（`SEARCH_DEBOUNCE`）：一次 `input` 事件就是一次重画，连续按键不防抖
   *      等于一秒钟重画十次；
   *   ② **中文输入法**：`compositionstart` 到 `compositionend` 之间，输入框的 `value`
   *      是**拼音**（「liuying」/「liumang」），此时过滤只会得到一片空白，且每敲一个字母
   *      重画一次。所以组字期间只记状态、不触发；
   *   ③ **`search` 事件**：`<input type="search">` 自带的清除按钮（×）在部分浏览器上
   *      只发 `search` 不发 `input`，不接这一条就会出现「点了 × 但榜面没恢复」。
   * ESC 也顺手当清除用（桌面端的老习惯）。
   */
  const wireSearchInput = (input, { timerKey, onQuery }) => {
    if (!input) return;
    let composing = false;
    const apply = () => {
      clearTimeout(state[timerKey]);
      state[timerKey] = setTimeout(() => { onQuery(input.value); }, SEARCH_DEBOUNCE);
    };
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; apply(); });
    input.addEventListener('input', () => { if (!composing) apply(); });
    input.addEventListener('search', apply);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && input.value) {
        event.preventDefault();
        input.value = '';
        apply();
      }
    });
  };
  // 角色总榜：只重画榜面（搜索是纯过滤，名次与分数都不变，所以不重取结论）。
  wireSearchInput(el.unitSearch, {
    timerKey: 'unitQueryTimer',
    onQuery: (value) => {
      if (value === state.unitQuery) return;
      state.unitQuery = value;
      renderUnits();
    },
  });
  // 抽卡方案：换词就**回第 1 页** —— 否则「搜一个只在第 4 页出现的角色」会先落在空页上。
  wireSearchInput(el.teamPlanSearch, {
    timerKey: 'teamPlanQueryTimer',
    onQuery: (value) => {
      if (value === state.teamPlanQuery) return;
      state.teamPlanQuery = value;
      state.teamPlanPage = 1;
      renderTeamPlan(state.conclusion);
    },
  });

  // 权重三大类：先恢复用户上次定下的倾向（关卡权重 + 抽卡权重 + 版本权重），再把
  // 三组输入框画出来（用户 2026-10-16 第 3 条起是三类，三组各占一行）。
  state.weights = loadWeights();
  state.drawWeights = loadDrawWeights();
  state.versionWeights = loadVersionWeights();
  renderWeightRows();

  // 隐金设置（用户 2026-10-11）：先读存档（没有存档 = 五项全勾），再画状态行、
  // 接上「隐金设置」按钮。详情窗口的内容每次打开现建 —— 名单只有 advice.js 那一份，
  // 而「当前勾了哪几项」随时可能被改，缓存一份 DOM 只会多一个会过期的真相。
  state.hiddenCosts = loadHiddenCosts();
  renderHiddenCostsMeta();
  el.hiddenCostsOpen?.addEventListener('click', () => {
    openGoldSettings(buildHiddenCostsBody, {
      title: '隐金设置',
      // 「恢复默认」= 五项全勾（用户给的默认值）。窗口那边重画前调它。
      onReset: resetHiddenCosts,
    });
  });

  el.recordRefresh?.addEventListener('click', () => loadRecords({ refresh: true }));
  el.mode.addEventListener('change', () => {
    // 副本与关卡合成一个下拉框，所以这里一次解析出两者。
    ({ mode: state.mode, stage: state.stage } = parseModeValue(el.mode.value));
    state.season = null;
    renderSeasonOptions();
    loadStats();
  });
  el.season.addEventListener('change', () => {
    state.season = el.season.value;
    loadStats();
  });
  // 权重三大类之一：**关卡权重**输入 → 存本地 → 防抖后请服务端按新权重重算。
  //
  // ⚠️ 2026-10-11 起**只有 frontier 这一套**（用户第 10 轮「去掉方案权重那一行」）：
  // 角色总榜与抽卡方案的「强度得分」都吃它，所以这一行会同时改两块 —— 这是口径使然
  // （两处本来就该同源），不是耦合没拆干净。
  {
    const scope = WEIGHT_SCOPE;
    const grid = WEIGHT_UI.grid();
    if (grid) {
      grid.addEventListener('input', () => {
        state.weights[scope] = readWeights(grid);
        saveWeights();
        renderWeightsMeta(scope);
        const meta = WEIGHT_UI.meta();
        if (meta) meta.classList.add('is-pending');
        clearTimeout(state.weightsTimer);
        state.weightsTimer = setTimeout(async () => {
          // ⚠️ **这一条原先漏了**（用户 2026-10-13 第 10 条报的角色得分权重 bug）：
          // 角色面板 / 角色得分详情里那份「该角色的全部配队」走 `/api/archive/packs?char=`
          // 的 `packsCache`，而它的**缓存键里带着关卡权重**（见 `fetchPacks()` 的注释）。
          // 抽卡权重那一行、以及隐金设置（`scheduleHiddenCostsRecompute()`）都清了这份缓存，
          // 只有这里没清 —— 于是「改了关卡权重 → 总榜重算了 → 点开角色详情，里面还是
          // 旧权重算出来的分」，看起来像服务端没吃新权重，其实是浏览器把旧结果又端了上来。
          // 三处旋钮必须做同一件事，所以这段清理与另外两处**逐字一致**。
          packsCache.clear();
          if (state.index) await loadConclusion();
          if (meta) meta.classList.remove('is-pending');
        }, WEIGHTS_DEBOUNCE);
      });
    }
  }
  // 权重三大类之二：**抽卡权重**输入（用户 2026-10-12 第 2、3、4 条 + 2026-10-13 第 1、2 条）。
  //
  // ⚠️ 它**现在也进服务端请求**（v4.6.95 起，与 v4.6.94 那版相反）：用户 2026-10-13 第 2 条
  // 要求角色总榜受三个权重影响，而总榜的「每角色只留一条」收敛在服务端
  // `buildConclusion` 里 —— 只在浏览器里加权会让收敛选错代表整包。
  // 所以这里与关卡权重走同一条路（防抖 → `loadConclusion()` 重算），
  // 重算完成后 `renderConclusion()` 会顺带重画抽卡方案那一块（它是结论的下游）。
  {
    const grid = el.drawWeightRow;
    if (grid) {
      grid.addEventListener('input', () => {
        state.drawWeights = readDrawWeights(grid);
        saveDrawWeights();
        renderDrawWeightsMeta();
        const meta = el.drawWeightsMeta;
        if (meta) meta.classList.add('is-pending');
        clearTimeout(state.drawWeightsTimer);
        state.drawWeightsTimer = setTimeout(async () => {
          // 角色面板那份「全部配队」是按「总榜权重 + 隐金 + 抽卡权重」缓存的，旋钮一变
          // 就必须作废 —— 否则同一个角色会一直吃旧权重的分（v4.6.69 修的就是这一类）。
          packsCache.clear();
          if (state.index) await loadConclusion();
          else if (state.conclusion) renderTeamPlan(state.conclusion);
          if (meta) meta.classList.remove('is-pending');
        }, WEIGHTS_DEBOUNCE);
      });
    }
  }
  // 权重三大类之三：**版本权重**输入（用户 2026-10-16 第 3 条；2026-10-17 起档位可增删）。
  //
  // ⚠️ 它与抽卡权重一样**进服务端请求**：它决定每个副本窗口里「最新往前 N 个版本」
  // 各占多少，而服务端在当前请求里现算 `seasonWeights`，客户端再拿那一份做跨版本加权
  // （总榜的整包分、详情窗口的「跨版本发挥」都是这条链的下游）。
  // 所以走的还是同一条路：防抖 → `packsCache.clear()` → `loadConclusion()` 重算。
  {
    const grid = el.versionWeightRow;
    /**
     * 版本权重改完（改数 / 加档 / 删档）后统一走的收尾。
     *
     * ⚠️ 按钮那条路**不防抖**（与输入框不同）：点一次就该生效，没有连续输入的场景，
     * 压 300ms 只会让人以为没点到。收尾动作与三处旋钮逐字一致 ——
     * `packsCache.clear()` → `loadConclusion()`，否则同一个角色会一直吃旧权重算出来的分
     * （v4.6.69 / v4.6.93 修的就是这一类）。
     */
    const applyVersionWeights = async (next) => {
      state.versionWeights = next;
      saveVersionWeights();
      renderVersionWeightRow();
      const meta = el.versionWeightsMeta;
      if (meta) meta.classList.add('is-pending');
      clearTimeout(state.versionWeightsTimer);
      packsCache.clear();
      if (state.index) await loadConclusion();
      else if (state.conclusion) renderTeamPlan(state.conclusion);
      if (meta) meta.classList.remove('is-pending');
    };
    if (grid) {
      grid.addEventListener('input', () => {
        state.versionWeights = readVersionWeights(grid);
        saveVersionWeights();
        renderVersionWeightsMeta();
        const meta = el.versionWeightsMeta;
        if (meta) meta.classList.add('is-pending');
        clearTimeout(state.versionWeightsTimer);
        state.versionWeightsTimer = setTimeout(async () => {
          // 三处旋钮做**逐字一致**的一件事（关卡权重 / 抽卡权重那两处也一样）：
          // 角色面板那份「全部配队」是按三类权重 + 隐金缓存的，旋钮一变就必须作废 ——
          // 否则同一个角色会一直吃旧权重算出来的分（v4.6.69 / v4.6.93 修的就是这一类）。
          packsCache.clear();
          if (state.index) await loadConclusion();
          else if (state.conclusion) renderTeamPlan(state.conclusion);
          if (meta) meta.classList.remove('is-pending');
        }, WEIGHTS_DEBOUNCE);
      });
    }
    /**
     * 加一版 / 删最后一版（用户 2026-10-17：「添加两个按钮，让用户可以点击按钮添加更多的
     * 版本权重，或者点击删除最后一个版本」）。
     *
     * ⚠️ 加档**必须保住已有那几档的数值**（`[...current, 新档默认]`）—— 用
     * `versionWeightDefaults(n+1)` 整张重置会把用户调过的权重全抹掉。
     * 新档的默认值取 `versionWeightDefaultAt()`（第 7 档起沿用 0.5，不归零）。
     * 上限 12 / 下限 1 的禁用状态由 `renderVersionWeightButtons()` 反映到按钮上。
     */
    el.versionWeightAdd?.addEventListener('click', () => {
      const current = versionWeightValues(state.versionWeights || []);
      if (current.length >= VERSION_WEIGHT_MAX) return;
      void applyVersionWeights([...current, versionWeightDefaultAt(current.length)]);
    });
    el.versionWeightRemove?.addEventListener('click', () => {
      const current = versionWeightValues(state.versionWeights || []);
      if (current.length <= 1) return;
      void applyVersionWeights(current.slice(0, -1));
    });
  }
  /**
   * 「恢复默认」= 清掉**三大类**权重（关卡权重回到 `envWeightDefaults()`、抽卡权重回到
   * `drawWeightDefaults()`、版本权重回到 `versionWeightDefaults()`）。
   *
   * 为什么一个按钮管三块：它们本来就是一张卡里的同一件事（用户第 2 条：「权重分为两大类」，
   * 2026-10-16 第 3 条又加了第三类），而恢复默认是「我调乱了、回到起点」的动作 ——
   * 分成三个按钮只会让人以为它们是三件互不相关的事。
   */
  const resetWeights = async (scope) => {
    state.weights[scope] = {};
    state.drawWeights = { ...drawWeightDefaults() };
    state.versionWeights = versionWeightDefaults();
    saveWeights();
    saveDrawWeights();
    saveVersionWeights();
    renderWeightRow(scope);
    renderDrawWeightRow();
    renderVersionWeightRow();
    // ⚠️ **和三个输入框处理器做同一件事**（用户 2026-10-13 第 10 条那类 bug）：这一下同样
    // 换掉了「关卡权重 + 抽卡权重 + 版本权重」三个缓存键里的旋钮，所以角色面板 / 角色得分
    // 详情那份「该角色的全部配队」缓存必须一起作废。漏了它的症状与关卡权重那条一模一样
    // ——「点了恢复默认、总榜回去了，点开角色详情还是刚才那组自定义权重算出来的分」，
    // 而且这个按钮是**三套权重一起清**，漏掉时错得更久。
    // 2026-10-16 加上版本权重时这条注释同样适用，所以把「三」一起改掉（避免下次又漏）。
    packsCache.clear();
    if (state.index) await loadConclusion();
  };
  el.frontierWeightsReset?.addEventListener('click', () => resetWeights(WEIGHT_SCOPE));
  el.reload.addEventListener('click', () => {
    state.index = null;
    loadIndex();
  });
  el.update.addEventListener('click', runUpdate);

  return {
    /** Called when the tab becomes visible. */
    show: async () => {
      // The index must be loaded first: it carries the Chinese→English name map
      // that makes ownership matching work at all.
      if (!state.index) await loadIndex();
      const snapshot = state.onNeedSnapshot ? state.onNeedSnapshot() : null;
      state.snapshot = snapshot;
      state.snapshotResponse = state.onNeedSnapshotResponse ? state.onNeedSnapshotResponse() : null;
      const zhToEn = {};
      const allNames = [];
      for (const c of state.index?.refs?.characters || []) {
        if (c.nameCn && c.name) zhToEn[c.nameCn] = c.name;
        if (c.nameCn) allNames.push(c.nameCn);
      }
      const coneZhToEn = {};
      for (const c of state.index?.refs?.lightCones || []) {
        if (c.nameCn && c.name) coneZhToEn[c.nameCn] = c.name;
      }
      state.owned = ownedCharacters(snapshot, zhToEn, allNames);
      state.ownedLightCones = ownedLightCones(snapshot, coneZhToEn);
      state.coneRanks = lightConeRanksOf(snapshot, coneZhToEn);
      state.eidolons = eidolonsOf(snapshot, zhToEn);
      if (state.stats) render();
      // 综合结论只跟持有情况有关：持有情况没变就不重算（服务端要聚合 5 个副本）。
      if (conclusionKey() !== state.conclusionKey) await loadConclusion();
      else renderConclusion();

      // 第一节：战斗记录只按 UID 缓存一次；换了角色（UID）才重读。
      const role = state.onNeedRole ? state.onNeedRole() : null;
      const uid = role?.uid || null;
      if (uid && state.recordsUid !== uid) {
        await loadRecords();
      } else if (!uid && !state.records && !state.recordsError) {
        renderRecord();
      }
    },
    hide: () => {},
    isLoaded: () => Boolean(state.index),
    /**
     * 数据集索引（`/api/archive` 的载荷），给**虚拟账号的角色编辑器**用
     * （用户 2026-10-13 第 3 条）：它要列出全部角色 / 命途 / 专属光锥 / 同命途光锥，
     * 这些东西全在 `index.refs` 里，而 app.js 那一侧没有第二份。
     *
     * ⚠️ 必须是 `ensureIndex()`（会按需加载）而不是直接暴露 `state.index`：
     * 用户可能先切到「角色信息」页就点「＋ 添加角色」，那一刻抽卡页还没加载过索引，
     * 直接读会拿到 `null`，编辑器画出一张空名单（而且不报错）。
     */
    ensureIndex: async () => {
      if (!state.index) await loadIndex();
      return state.index;
    },
  };
};
