// Offline reader for the dataset scraped from https://theherta.com/archive.
//
// The GUI's recommendation page must work with no network access, so the data
// ships as files under ./theherta and this module is the only thing that reads
// them. `archive.json` is produced by tools/herta-build.mjs out of the raw
// per-season files written by tools/herta-fetch.mjs, and
// `unit-availability.json` (星级 / 限定标记) by tools/herta-availability.mjs.
//
// The whole file is loaded once and cached: it is ~12 MB of counts, and the
// recommendation view re-reads it on every mode change.
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  VERSION_WEIGHTS, VERSION_WINDOW, envWeightOf, versionWeightOf,
} from '../core/advice.js';

const DEFAULT_DIR = resolve(process.cwd(), 'theherta');

/**
 * 叠影（1 = SI1 … 5 = SI5）。**0 是「这个位置没装光锥」，不是「未知」**（用户第 8 条）。
 *
 * 建库侧（`tools/herta-build.mjs` 的 `superimpOf`）已经把站点给的 0 与字段缺失分开；
 * 这里只负责解析紧凑串 `角色|星魂|光锥|叠影`。旧写法 `Number(x) || 5` 会把 '0'
 * 当 falsy 读成 SI5 —— 9,474 个「没装光锥」的位置因此被写成满叠影光锥。
 * 字段缺失（undefined / null / 空串）才是「未知」，那时按满叠影处理。
 */
const superimpOf = (value) => {
  if (value === undefined || value === null || value === '') return 5;
  const n = Number(value);
  if (!Number.isFinite(n)) return 5;
  return Math.max(0, Math.min(5, Math.round(n)));
};

/** Friendly labels for the site's mode slugs. */
export const MODE_LABELS = {
  moc: 'Memory of Chaos',
  pf: 'Pure Fiction',
  as: 'Apocalyptic Shadow',
  aa: 'Anomaly Arbitration',
};

/**
 * The dataset is keyed by the site's full mode names ("Memory of Chaos"), while
 * the GUI and this API speak in short slugs ("moc"). Accept either, because a
 * caller that read `mode` straight out of a previous response will pass the
 * long form back.
 */
export const resolveMode = (input) => {
  if (!input) return 'moc';
  const raw = String(input);
  if (Object.hasOwn(MODE_LABELS, raw)) return raw;
  const match = Object.entries(MODE_LABELS)
    .find(([, label]) => label.toLowerCase() === raw.toLowerCase());
  return match ? match[0] : raw;
};

/** The dataset key (full label) for a slug-or-label input. */
export const modeKey = (input) => MODE_LABELS[resolveMode(input)] || String(input || '');

/**
 * Official Simplified-Chinese mode names.
 *
 * The authoritative copy lives in theherta/i18n-zh.json (built by
 * tools/herta-i18n.mjs) so all game vocabulary is reviewed in one place; these
 * constants are the fallback used when that file is absent.
 *
 * Three are easy to get wrong:
 *   * Memory of Chaos is 混沌回忆 - 忘却之庭 is the UMBRELLA mode (Forgotten
 *     Hall), which the game text splits into 回忆 and 混沌回忆.
 *   * Pure Fiction is 虚构叙事 (not 纯虚构叙事).
 *   * Anomaly Arbitration is 异相仲裁 (not 异常仲裁).
 */
export const MODE_LABELS_CN = {
  moc: '混沌回忆',
  pf: '虚构叙事',
  as: '末日幻影',
  aa: '异相仲裁',
};

/** Subcategory slugs the site records, mapped to something readable. */
export const CATEGORY_LABELS = {
  '0-Cycle': '0 回合',
  Clear: '通关',
  'full stars': '满星',
  '0 AV': '0 行动值',
};

/**
 * 「关卡」标签。异相仲裁是唯一一个把三种难度混在同一版本里的模式：
 *   骑士关 + 普通王棋关  判据是轮次（0T / ≤2T / ≤4T）
 *   绝境王棋关           难度极高，判据是行动值（<300 / <500），只有两档
 * 其余模式的 stage 是空字符串，表示「不分类」。
 */
export const STAGE_LABELS = {
  '': null,
  plight: 'Nightmare King',
};

export const STAGE_LABELS_CN = {
  '': null,
  plight: '绝境王棋关',
};

/**
 * 异相仲裁里「非绝境」那一档其实是**两个**关卡（骑士关与普通王棋关，判据相同），
 * 一个名字说不全——所以它只在异相仲裁里有这个名字，其它模式的空 stage 就是
 * 「不分类」，标签仍然是 null。
 *
 * 不能直接写进 STAGE_LABELS_CN['']：那一格是所有模式共用的默认值，填上
 * 「骑士关 / 普通王棋关」会让混沌回忆的关卡标签也变成这个词。
 */
export const AA_NORMAL_STAGE = 'Knight + King';
// 用户 2026-10 要求把名字改成「王棋和骑士关」（原来是「骑士关 / 普通王棋关」）。
// 它确实是**两个**判据相同的关卡（王棋关 + 3 个骑士关），所以名字要都提到。
export const AA_NORMAL_STAGE_CN = '王棋和骑士关';

/** 关卡标签。只有异相仲裁需要区分，所以标签必须带上模式一起算。 */
export const stageLabelOf = (mode, stage) => (
  String(stage ?? '') === '' && resolveMode(mode) === 'aa'
    ? { label: AA_NORMAL_STAGE, labelCn: AA_NORMAL_STAGE_CN }
    : { label: STAGE_LABELS[stage] || null, labelCn: STAGE_LABELS_CN[stage] || null }
);

const state = {
  dir: DEFAULT_DIR,
  promise: null,
  cache: null,
  i18n: null,
  i18nPromise: null,
};

/** Point the reader at a different directory (tests, or a moved dataset). */
export const setArchiveDir = (dir) => {
  state.dir = dir ? resolve(dir) : DEFAULT_DIR;
  state.promise = null;
  state.cache = null;
  state.i18n = null;
  state.i18nPromise = null;
};

export const archivePath = () => join(state.dir, 'archive.json');
export const i18nPath = () => join(state.dir, 'i18n-zh.json');

/**
 * 本地图标镜像的挂载前缀（`tools/herta-icons.mjs` 拉下来的那份）。
 *
 * 用户 2026-10-10：「这些图标是会完全重新到网上读取吗？能不能下载到本地」。
 * 图标表的 URL 一律是 `https://cdn.jsdelivr.net/gh/Mar-7th/StarRailRes@master/<相对路径>`，
 * 而本地镜像**刻意保持同样的相对路径**（`theherta/icons/<相对路径>`），于是换 base
 * 就行，**图标表里的键一个都不用改**。
 */
export const LOCAL_ICON_BASE = '/icons';

/**
 * 把图标表里的 CDN 地址改写成「本地优先 + CDN 兜底」。
 *
 * 改写成 `/icons/<相对路径>?fallback=<原 CDN 地址>`：本地有就直接 200；没有则由
 * `src/server/app.js` 的 `/icons/*` 路由 **302** 回 CDN。所以**没有镜像也照常工作**，
 * 不用重新生成 `i18n-zh.json`（那是建库产物，不该为一次部署选择而重写）。
 *
 * ⚠️ 只改 URL，**不改键** —— `resolveIcon()` 的四级兜底（原名 → 形态基础名 → 去标点
 * 小写 → 归一化后的基础名）依赖键是数据集英文名，改了键就查不到了。
 *
 * @param {any} data `loadI18n()` 读出来的表
 * @param {string} base 表里的 CDN 前缀（`icons.base`）
 */
const localizeIconUrls = (data, base) => {
  if (!data?.icons || typeof data !== 'object' || !base) return data;
  const rewrite = (table) => {
    if (!table || typeof table !== 'object') return table;
    for (const [key, url] of Object.entries(table)) {
      if (typeof url !== 'string' || !url.startsWith(base)) continue;
      const rel = url.slice(base.length);
      table[key] = `${LOCAL_ICON_BASE}${rel}?fallback=${encodeURIComponent(url)}`;
    }
    return table;
  };
  for (const sub of ['characters', 'lightCones']) rewrite(data.icons[sub]);
  for (const sub of ['characters', 'lightCones']) rewrite(data.icons.previews?.[sub]);
  for (const sub of ['characters', 'lightCones']) rewrite(data.icons.portraits?.[sub]);
  data.icons.base = LOCAL_ICON_BASE;
  return data;
};

/**
 * Load the English → official Chinese name tables.
 *
 * The theherta dataset is in English, but the game and its wiki are Chinese, so
 * every name that reaches the screen goes through here. A missing file is not
 * an error: the page then simply shows the dataset's English names.
 */
export const loadI18n = async () => {
  if (state.i18n) return state.i18n;
  if (state.i18nPromise) return state.i18nPromise;
  state.i18nPromise = (async () => {
    const text = await readFile(i18nPath(), 'utf8');
    const data = JSON.parse(text);
    // 图标地址改成本地优先（理由见 `localizeIconUrls`）。`icons.base` 必须**先**读出来
    // —— 改写之后它就变成 `/icons` 了。
    state.i18n = localizeIconUrls(data, data?.icons?.base);
    return state.i18n;
  })().catch(() => {
    // Degrade to "no translation" rather than failing the whole page.
    state.i18n = null;
    state.i18nPromise = null;
    return null;
  });
  return state.i18nPromise;
};

/**
 * Resolve an English name to its official Chinese name.
 *
 * Exact match first, then a punctuation-insensitive retry, because the site and
 * the game disagree on separators: it writes "Trailblazer: Destruction" as well
 * as "Trailblazer (Destruction)", and drops the exclamation marks from
 * "Dance! Dance! Dance!".
 */
export const normalizeName = (name) => String(name)
  .toLowerCase()
  .replace(/[:\uFF1A]/g, '(')
  .replace(/[\u2022\u00B7\u30FB]/g, ' ')
  .replace(/[^a-z0-9\u4e00-\u9fff]/g, '');

export const zhName = (i18n, table, name) => {
  if (!i18n || !name) return null;
  return i18n[table]?.[name]
    || i18n.lookup?.[`${table}:${normalizeName(name)}`]
    || null;
};

/** Chinese label for a mode, keyed by its slug (static fallback only). */
export const modeLabelCn = (mode) => MODE_LABELS_CN[resolveMode(mode)] || null;

/**
 * Boss/enemy display names. Many bosses are playable characters, so this is a
 * separate table from `characters`; the raw English name is kept as the key.
 */
export const localizeBosses = (i18n, names) => (Array.isArray(names) ? names : [])
  .map((name) => ({ name, nameCn: zhName(i18n, 'bosses', name) }));

/** Localise one schedule entry's boss list, keeping ids and HP untouched. */
export const localizeSchedule = (i18n, schedule) => {
  if (!schedule) return null;
  const out = { ...schedule };
  if (schedule.bosses) {
    out.bosses = schedule.bosses.map((boss) => ({
      ...boss,
      nameCn: zhName(i18n, 'bosses', boss.name),
    }));
  }
  return out;
};

/**
 * Every light cone the dataset references, as plain English names.
 *
 * Covers the per-character top cones AND the site-wide popular table, because
 * the client needs to resolve an English key for any Chinese cone name its own
 * snapshot might contain.
 */
export const collectLightCones = (data) => {
  const names = new Set();
  for (const entry of Object.values(data.characters || {})) {
    for (const list of Object.values(entry?.topLightCones || {})) {
      for (const cone of list || []) if (cone?.name) names.add(cone.name);
    }
  }
  for (const cone of Object.values(data.refs?.popularLightCones || {})) {
    if (typeof cone === 'string') names.add(cone);
  }
  return [...names].sort();
};

/** True when a built dataset is present on disk. */
export const archiveExists = async () => {
  try {
    const info = await stat(archivePath());
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
};

/**
 * Load `archive.json`, memoised. A failed load is not cached permanently - the
 * promise is cleared so a later request can pick the file up after the user has
 * run the fetch/build tools.
 */
export const loadArchive = async () => {
  if (state.cache) return state.cache;
  if (state.promise) return state.promise;
  state.promise = (async () => {
    const text = await readFile(archivePath(), 'utf8');
    const data = JSON.parse(text);
    state.cache = data;
    return data;
  })().catch((err) => {
    state.promise = null;
    throw err;
  });
  return state.promise;
};

/** Drop the memoised archive so a freshly built file is picked up. */
export const reloadArchive = () => {
  state.promise = null;
  state.cache = null;
};

/**
 * The reviewed Chinese mode labels: i18n-zh.json when present, else the
 * constants above. Built per call so a regenerated i18n file is picked up.
 */
const resolveModeLabels = async () => {
  const i18n = await loadI18n();
  if (!i18n?.modes) return { ...MODE_LABELS_CN };
  const out = { ...MODE_LABELS_CN };
  for (const [slug, en] of Object.entries(i18n.modeSlugs || {})) {
    if (i18n.modes[en]) out[slug] = i18n.modes[en];
  }
  return out;
};

/**
 * Everything the recommendation page needs to render its dropdowns without
 * shipping the per-team breakdown.
 */
export const archiveIndex = async () => {
  const data = await loadArchive();
  const i18n = await loadI18n();
  const labelCn = await resolveModeLabels();
  const modes = Object.entries(data.modes || {}).map(([mode, entry]) => {
    // The dataset is keyed by the site's full English mode name, so translate
    // it back to the slug the rest of this API and the GUI use.
    const slug = resolveMode(mode);
    // 「关卡」：绝大多数模式只有一档（空字符串），异相仲裁分骑士关/普通王棋关
    // 与绝境王棋关两档，判据完全不同，所以必须分开成两个可选项。
    const stages = Object.entries(entry.stages || {}).map(([key, stage]) => ({
      stage: key,
      ...stageLabelOf(slug, key),
      seasons: Object.keys(stage.seasons || {}).sort(seasonSort),
      // 每个版本的投稿数：界面选版本时不该建议一个只有 7 条投稿的版本，
      // 跨模式综合结论也要靠它跳过样本不足的版本（「不拿几个样本下结论」）。
      seasonRuns: Object.fromEntries(
        Object.entries(stage.seasons || {}).map(([s, v]) => [s, v.runCount || 0]),
      ),
      runCount: stage.runCount || 0,
    })).sort((a, b) => (a.stage === '' ? -1 : b.stage === '' ? 1 : a.stage.localeCompare(b.stage)));
    const allStageSeasons = [...new Set(stages.flatMap((s) => s.seasons))].sort(seasonSort);
    return {
      mode: slug,
      key: mode,
      label: MODE_LABELS[slug] || mode,
      labelCn: labelCn[slug] || MODE_LABELS[slug] || mode,
      // `seasons` 是该模式所有关卡版本的并集，供下拉框使用；每个关卡自己的
      // 版本列表在 `stages[].seasons`。
      seasons: allStageSeasons,
      stages,
    };
  });
  const allSeasons = [...new Set(modes.flatMap((m) => m.seasons))].sort(seasonSort);
  const latestSeason = allSeasons[allSeasons.length - 1] || null;
  const latestPerMode = Object.fromEntries(
    modes.map((m) => [m.mode, m.seasons[m.seasons.length - 1] || null]),
  );

  return {
    ok: true,
    available: true,
    version: data.version ?? 1,
    source: data.source ?? 'https://theherta.com/archive',
    generatedAt: data.generatedAt ?? null,
    runCount: data.runCount ?? 0,
    minSeasonRuns: data.minSeasonRuns ?? 20,
    latestSeason,
    latestPerMode,
    modes,
    schedule: data.schedule || [],
    submitCategories: data.submitCategories || [],
    // Kept for backwards compatibility; the GUI reads refs.categoryLabels.
    categoryLabels: CATEGORY_LABELS,
    stageLabels: STAGE_LABELS_CN,
    refs: {
      characters: (data.refs?.characters || []).map((name) => ({
        name,
        nameCn: zhName(i18n, 'characters', name),
      })),
      // Only light cones the dataset actually references, so the client can map
      // its Chinese snapshot names onto the English keys it has to match.
      lightCones: collectLightCones(data).map((name) => ({
        name,
        nameCn: zhName(i18n, 'lightCones', name),
      })),
      characterPaths: data.refs?.characterPaths || {},
      popularLightCones: data.refs?.popularLightCones || {},
      // 星级与限定标记，给成本计算与「限定」标签用
      availability: data.refs?.availability || { characters: {}, lightCones: {} },
      /**
       * 角色 / 光锥**首次出现在哪个版本**（建库时扫全部投稿算出来的，见
       * tools/herta-build.mjs 的 firstSeenChar）。
       *
       * 总榜用它判断「某个版本是不是早于这个整包登场」：早于登场 → 不参与平均
       * （既不奖也不罚，用户 2026-10-10）；已登场却无人使用 → 算 0 分。
       *
       * ⚠️ **必须按副本取**（`byMode[mode]`）：黑塔网四个副本各用一套版本号，同一期
       * 真实日期在不同副本里编号不同（实测当前进度 异相仲裁 4.6 / 混沌 4.5 / 末日 4.6
       * / 虚构 4.5）。拿跨副本取最小值的全局值去比某个副本的窗口，判定就会错位 ——
       * 实测真珠因此在异相仲裁被判「4.5 已登场无人使用」（那一期真实日期其实比她
       * 首次出现早一个月），版本因子被压到 ×0.50。
       * 全局 `characters` / `lightCones` 只在老数据集没有 `byMode` 时兜底。
       */
      firstSeen: data.refs?.firstSeen || { characters: {}, lightCones: {}, byMode: {} },
      /**
       * 立绘与图标（角色面板的立绘、总榜每行的头像）。
       *
       * 原来只放在 `i18n-zh.json` 里、**没有**经过 `/api/archive` 暴露出去，
       * 所以界面拿不到图 —— 抽卡推荐页每一行的头像都是空的（用户 2026-10 的截图）。
       * 这里按名字给三张图，全部走镜像域名（见 tools/herta-i18n.mjs 的 ICON_BASE）。
       */
      icons: {
        characters: i18n?.icons?.characters || {},
        lightCones: i18n?.icons?.lightCones || {},
        previews: {
          characters: i18n?.icons?.previews?.characters || {},
          lightCones: i18n?.icons?.previews?.lightCones || {},
        },
      },
      // Slugs/labels so the GUI never has to hard-code game vocabulary.
      modes: modes.map((m) => ({ mode: m.mode, label: m.label, labelCn: m.labelCn })),
      categoryLabels: CATEGORY_LABELS,
    },
    counts: data.counts || {},
  };
};

// 版本权重表（`VERSION_WEIGHTS` / `VERSION_WINDOW` / `versionWeightOf`）定义在
// `src/core/advice.js` —— 它是浏览器与服务端**共用**的那一份，总榜在客户端
// 按版本加权时读的是同一张表。见那里的注释（用户 2026-10 第 7 条）。

/**
 * 「前沿」汇总 —— **池 = 窗口内全部成绩**（v4.6.78 起，不再取最便宜的那一批）。
 *
 * 数据来自建库侧每个版本存的 `frontier`（普通模式满分 + 次高目标档、绝境满分 + 达标档，
 * 按「阵容 + 成本」去重），见 tools/herta-build.mjs 的 `frontierIndex`。
 * ⚠️ 「全部成绩」的边界就是这个**已达标（target / perfect）**的集合 —— 低于达标档的
 * 投稿在建库侧就没进 `frontier`，这里也就永远看不到它们。
 *
 * 这里做两件事：
 *   1. 把**版本窗口内**的前沿合并（跨赛季样本才够谈角色强度）；
 *   2. 统计每个角色 / 星魂档在这批里的**占比**，并按新近度加权。
 *
 * 为什么用占比而不是计数：用户明确说「只要存在压金的可能就说明足够强力，不用太
 * 考虑投稿数量」——同一成绩重复投稿不该加分。建库侧已按「阵容 + 成本」去重。
 *
 * ⚠️ **v4.6.78 去掉了「取最便宜 25%」这一步**（用户 2026-10：「改为所有成绩都要进池，
 * 我不希望估算」）。旧口径会制造一个中间态 ——「有人用、但没挤进最便宜的那批」——
 * 而它只能靠**估算**填充；估算值取自未截断的全部行，与分母（最佳证据那一版，取自池内）
 * 不同源，于是「跨版本发挥 = 各版本加权平均 ÷ 最好的那一版」可以 **> 1**（实测
 * 绯英 E6+邂逅S5 在绝境 ×1.50；全榜 160 条明细里 10 条）。改成全部进池后，分子与分母
 * 取同一个集合，该栏**构造上恒 ≤ 1**，`observedPacks` / `observedPackScores` 这套
 * 估算机器随之整套删除。
 *
 * 代价（用户已知并接受）：池不再等于「压金前沿」——
 *   * `characters` / `eidolons` 的占比语义从「在最便宜前沿里的出场率」变成「在全部
 *     达标投稿里的出场率」，而差距榜（`advice.js` 的 `frontierStrengthOf`）读的正是它；
 *   * 总榜每个整包的「最佳证据」从「最便宜那批里最好的一条」变成「全部行里最好的一条」，
 *     实测证据队伍金数中位 4 → 8、最大 15 → 48。
 *
 * ⚠️ 返回的 `pool` / `merged` 现在**恒等**（都是窗口内的行数）。两个字段都留着是为了
 * 不打断既有探针（`tools/_probe-*.mjs`）与它们的历史对照输出。
 */
export const archiveFrontier = async (mode, options = {}) => {
  const data = await loadArchive();
  // 短码（`moc`）要走 `modeKey` 翻成数据集的全名（`Memory of Chaos`）；
  // 直接拿 `resolveMode` 的结果去查 `data.modes` 会把短码原样返回，永远查不到。
  const entry = data.modes?.[modeKey(mode)];
  if (!entry) return { ok: false, error: `未知模式：${mode}` };
  const stages = Object.keys(entry.stages || {});
  const wantedStage = options.stage === undefined
    ? (stages.includes('') ? '' : stages[0])
    : options.stage;
  const stageData = entry.stages?.[wantedStage];
  if (!stageData) return { ok: false, error: `未知关卡：${options.stage}` };
  const seasons = Object.keys(stageData.seasons || {}).sort(seasonSort);
  if (!seasons.length) return { ok: false, error: '没有版本' };
  const wanted = options.season && stageData.seasons[options.season]
    ? options.season : seasons[seasons.length - 1];
  const windowSize = Math.max(1, Math.min(
    Number(options.window) || VERSION_WINDOW, VERSION_WINDOW, seasons.length,
  ));
  const idx = seasons.indexOf(wanted);
  const recent = seasons.slice(Math.max(0, idx - windowSize + 1), idx + 1);
  const recentDesc = [...recent].reverse();
  // 版本权重 = 按下标查表（下标 0 = 该副本最新的版本，权重 2）。见 VERSION_WEIGHTS。
  const weightOf = (s) => versionWeightOf(recentDesc.indexOf(s));

  // 旧的差距/星魂强度口径仍然只看满分；目标档只进入新的性价比总榜。
  const rows = [];
  for (const s of recent) {
    for (const f of stageData.seasons[s]?.frontier || []) {
      if (f.t !== undefined && Number(f.t) < 2) continue;
      rows.push({ ...f, season: s, w: weightOf(s) });
    }
  }
  // 版本权重（用户第 7 条）：客户端算总榜的「按版本加权」时**必须**用这一份，
  // 不要自己再写一遍 2:2:2:1:1:1:1 —— 版本一更新（黑塔网加了新版本），
  // 这张表整体前移，客户端抄一份就会对不上。
  const seasonWeights = Object.fromEntries(recentDesc.map((s, i) => [s, versionWeightOf(i)]));
  const empty = {
    ok: true, pool: 0, merged: 0, seasons: recent,
    versionWindow: VERSION_WINDOW, seasonWeights,
    characters: {}, eidolons: {}, raw: {}, rawEidolons: {}, frontierRows: [],
  };
  if (!rows.length) return empty;
  // 2) 池 = 窗口内**全部**前沿行（v4.6.78：不再按成本截断「最便宜的那一批」）
  //
  // 保留 `front` 这个名字，是为了让下面「占比」与 `frontierRows` 两段**完全不动** ——
  // 它们本来就只依赖「一批行」，这里换掉的只是这批行的来源。
  //
  // 历史（别再改回去）：旧口径按「合并后的成本分布取最便宜 25%」，而且因为成本是离散
  // 小整数、`cut` 上的并列会被整批纳入，实测拿到的是 27.9%~32.5%。它制造的那个中间态
  // 「有人用但没进池」只能靠估算填，而估算与分母不同源 → 「跨版本发挥」可以 > 1。
  const front = rows;

  // 3) 占比（新近度加权 + 未加权两份：界面显示用未加权，排序用加权）
  const characters = {}; const eidolons = {}; const raw = {}; const rawEidolons = {};
  let wSum = 0;
  for (const r of front) wSum += r.w;
  for (const r of front) {
    for (const packed of r.m || []) {
      const [char, eStr] = String(packed).split('|');
      if (!char) continue;
      const e = Number(eStr) || 0;
      characters[char] = (characters[char] || 0) + r.w / wSum;
      raw[char] = (raw[char] || 0) + 1 / front.length;
      const ek = `${char}|${e}`;
      eidolons[ek] = (eidolons[ek] || 0) + r.w / wSum;
      rawEidolons[ek] = (rawEidolons[ek] || 0) + 1 / front.length;
    }
  }
  // 把同一条前沿记录的完整配装一并传给综合榜。综合榜**只**使用这里记录的行
  // （v4.6.78 起 = 窗口内全部达标/满分行），不再回头从原始投稿里挑，避免挑出一条
  // 偶然极端配置。这个字段只在服务端内部流转，不计投稿数量。
  const frontierRows = front.map((r) => ({
    cost: Number(r.c) || 0,
    actionValue: r.a === null || r.a === undefined || r.a === ''
      ? null : Number(r.a),
    tier: Number(r.t) === 2 ? 'target' : 'perfect',
    season: r.season,
    seasonWeight: Number(r.w) || 1,
    members: (r.m || []).map((packed) => {
      const [char, eidolon, lc, superimp] = String(packed).split('|');
      return {
        char,
        eidolon: Math.max(0, Math.min(6, Math.round(Number(eidolon) || 0))),
        lc: lc || null,
        // 站点用「叠影 0」表示这一位没装光锥（见 superimpOf 的注释）；缺失才是未知。
        superimp: superimpOf(superimp),
      };
    }).filter((member) => member.char),
  }));

  return {
    ok: true,
    // ⚠️ v4.6.78 起 `pool` 与 `merged` **恒等**（= 窗口内的行数）：池就是全部成绩。
    // 两个字段都留着，是为了不打断既有探针与它们的历史对照输出。
    pool: front.length, merged: rows.length,
    seasons: recent, versionWindow: VERSION_WINDOW, seasonWeights,
    characters, eidolons, raw, rawEidolons, frontierRows,
  };
};

/**
 * 副本权重：用户要求「普通关卡压金也有价值，但绝境极其重要」。
 *
 * ⚠️ **默认值只有一张表**：这一条以前在这里又写了一遍（6 / 3 / 1.2 / 1 / 1），
 * 而客户端评分用的是 `SCORING.envWeight`（1.875 / 1.75 / 1 / 0.8 / 0.5），
 * 于是同一个界面里「前沿强度」与「单位性价比」用的是两套系数，权重输入框的
 * 提示值又正好是这里那套 —— 三处对不上。现在统一走 `envWeightOf`
 * （`src/core/advice.js` 是唯一来源）。
 *
 * 但**用户覆盖**是两套（用户 2026-10 要求总榜与方案的权重相互独立）：
 * 这里属于「性价比总榜」那条链，所以固定读 `'frontier'` 口径。
 */
export const frontierEnvWeight = (mode, stage = '') => envWeightOf(mode, stage, 'frontier');

/** 短码 → 站点全名（与服务端 `resolveMode` 同一张表，避免再引一个依赖）。 */
const MODE_ALIASES_FRONTIER = {
  moc: 'Memory of Chaos',
  pf: 'Pure Fiction',
  as: 'Apocalyptic Shadow',
  aa: 'Anomaly Arbitration',
};

/** 把一组环境的前沿强度一次取齐，并带上各副本权重。
 *
 * `options.weights` 可以让调用方覆盖副本权重 —— 这是**总榜口径**的覆盖
 * （界面上「总榜权重」那一行），键形状与 `envWeightOf` 一致
 * （`${全名或短码}|${stage}`）。
 */
export const archiveFrontierAll = async (envs, options = {}) => {
  const override = options.weights || null;
  const weightFor = (mode, stage = '') => {
    const raw = String(mode || '');
    const full = MODE_ALIASES_FRONTIER[raw] || raw;
    if (override) {
      const hit = override[`${full}|${stage}`] ?? override[`${raw}|${stage}`];
      // 允许 0：用户把某个副本调成 0 = 这个副本不进排序。
      if (hit !== undefined && hit !== null && hit !== ''
        && Number.isFinite(Number(hit)) && Number(hit) >= 0) return Number(hit);
    }
    return frontierEnvWeight(mode, stage);
  };
  const out = [];
  for (const env of envs || []) {
    const f = await archiveFrontier(env.mode, {
      // ⚠️ 锚点优先用 `frontierSeason`（**不回退**的最新可靠版本）：`env.season` 是
      // 「主证据版本」，可能被 completeness 回退到上一版，而 `archiveFrontier` 的
      // 窗口是「锚点往前 N 个版本」——跟着回退会把**更新**的版本整个排除出窗口。
      // 见 `conclusion.js` 的 `listEnvs` 注释（v4.6.48 修：砂金•戏浪 #14 → #2）。
      season: env.frontierSeason ?? env.season, stage: env.stage || '',
      window: options.window,
      // ⚠️ v4.6.78 起不再传 `tierLines` / `lowerIsBetter`：它们只服务
      // `observedPackScores`（估算机器），而那套已随「池=全部成绩」一起删除。
    });
    out.push({
      env: env.id, mode: env.mode, stage: env.stage || '',
      weight: weightFor(env.mode, env.stage || ''), ...f,
    });
  }
  return out;
};

/** "4.10" must sort after "4.9", so compare numerically component-wise. */
export const seasonSort = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return String(a).localeCompare(String(b));
};

/** 阵容样本的成员名转中文，供展开配装表使用。 */
const localizeSample = (sample, i18n) => ({
  ...sample,
  bossCn: sample.boss ? zhName(i18n, 'bosses', sample.boss) : null,
  members: (sample.members || []).map((m) => ({
    ...m,
    charCn: zhName(i18n, 'characters', m.char),
    lcCn: m.lc ? zhName(i18n, 'lightCones', m.lc) : null,
  })),
});

// ---------------------------------------------------------------- 聚合口径
//
// archiveStats（单副本主榜）与 conclusion.js（跨模式综合结论）必须对「同一套
// 阵容」给出完全一样的口径，否则同一个账号在两个区块里会看到互相矛盾的结论。
// 所以「解析作用域」和「跨版本聚合」都抽在这里，两处共用。

/**
 * 解析「模式 + 版本 + 关卡」到具体要聚合的版本窗口。
 *
 * 返回 {ok:false,...} 而不是抛异常：调用方是 HTTP 层，错误对象要能直接回给界面。
 */
const resolveScope = (data, mode, season, options = {}) => {
  const slug = resolveMode(mode);
  const key = modeKey(slug);
  const entry = data.modes?.[key];
  if (!entry) {
    return { ok: false, error: `未知模式：${mode}`, availableModes: Object.keys(data.modes || {}) };
  }
  const stages = Object.keys(entry.stages || {});
  // 显式传了一个不存在的关卡要报错，不能悄悄退回默认档——那会让调用方以为
  // 拿到的是「绝境王棋关」的数据，实际是骑士关的。
  if (options.stage !== undefined && options.stage !== null && !stages.includes(String(options.stage))) {
    return { ok: false, error: `未知关卡：${options.stage}`, availableStages: stages };
  }
  const wantedStage = options.stage !== undefined && options.stage !== null
    ? String(options.stage)
    : (stages.includes('') ? '' : stages[0]);
  const stageData = entry.stages?.[wantedStage];
  if (!stageData) {
    return { ok: false, error: `未知关卡：${options.stage}`, availableStages: stages };
  }
  const seasons = Object.keys(stageData.seasons || {}).sort(seasonSort);
  const wanted = season && stageData.seasons[season] ? season : seasons[seasons.length - 1];
  const wantedIndex = seasons.indexOf(wanted);
  // 窗口默认 7 个版本（= 版本权重表的长度，用户 2026-10 第 7 条）。上限也压在
  // VERSION_WINDOW：第 8 个版本起的权重是 0，把它放进窗口只会让成本前沿被更旧的
  // 投稿拉低，却一分权重都拿不到。
  const windowSize = Math.max(1, Math.min(
    Number(options.window) || VERSION_WINDOW, VERSION_WINDOW, seasons.length,
  ));
  const recent = seasons.slice(Math.max(0, wantedIndex - windowSize + 1), wantedIndex + 1);
  // 降序：recentDesc[0] 是最新版本。版本权重按「距最新版本几个版本」查表。
  const recentDesc = [...recent].reverse();
  return {
    ok: true,
    slug,
    key,
    entry,
    stages,
    wantedStage,
    stageData,
    seasons,
    wanted,
    recent,
    wantedIndex,
    windowSize,
    recentDesc,
    versionWeights: VERSION_WEIGHTS,
    weightOf: (s) => versionWeightOf(recentDesc.indexOf(s)),
    /** 可信度：投稿数只用来在强度接近时偏向被反复验证过的解法，不设门槛。 */
    trustOf: (n) => 1 - 0.35 / (1 + n),
  };
};

/**
 * 近 N 个版本的阵容 → 跨版本聚合的阵容表。
 *
 * 只把版本当成权重来源，不按版本分别出结论：玩家要用一个账号横跨多个版本。
 * 样本不足（reliable=false）的版本不计入满分率与行动值——不丢弃投稿，只是
 * 不拿它下结论。
 */
const aggregateTeams = (scope, i18n, options = {}) => {
  const { stageData, recent, wanted, weightOf, trustOf } = scope;
  // 星魂档位的配对证据（同一套阵容里「角色 → {档位: 最好成绩 + 档位 + 成本}」）。
  // 只有综合结论要它：评分按同一阵容里的相邻目标档（E0/E1/E2/E6）比较星魂边际收益，
  // 配对不上就只能退回「跨阵容取各档最好成绩」——那量的是阵容差异，不是星魂差异
  // （花火 E2→E3 就是这么拿到一个来路不明的正值、又爬回榜上的）。
  // 主榜（archiveStats）不分档算星魂，带上它只会让每份响应多几 MB，所以按需给。
  const withEidoPerf = options.withEidoPerf === true;
  const withFrontier = options.withFrontier === true;
  const byRoster = new Map();
  const frontierByBuild = new Map();
  let seasonRuns = 0;
  let windowRuns = 0;

  for (const s of recent) {
    const sd = stageData.seasons[s];
    if (!sd) continue;
    windowRuns += sd.runCount || 0;
    if (s === wanted) seasonRuns = sd.runCount || 0;
    if (withFrontier) {
      for (const entry of sd.frontier || []) {
        const members = (entry.m || []).map((packed) => {
          const [char, eidolon, lc, superimp] = String(packed).split('|');
          return {
            char,
            eidolon: Math.max(0, Math.min(6, Math.round(Number(eidolon) || 0))),
            lc: lc || null,
            // 站点用「叠影 0」表示这一位没装光锥（见 superimpOf 的注释）。
            superimp: superimpOf(superimp),
          };
        }).filter((member) => member.char);
        if (!members.length) continue;
        const cost = Number(entry.c);
        if (!Number.isFinite(cost)) continue;
        const key = `${cost}|${members.map((m) => `${m.char}|${m.eidolon}|${m.lc || ''}|${m.superimp}`)
          .sort().join('~')}`;
        const rawAction = entry.a;
        const parsedAction = rawAction === null || rawAction === undefined || rawAction === ''
          ? null : Number(rawAction);
        // 0 是有效行动值（异相仲裁·绝境用它表示 0 行动值通关），只有缺失、
        // 非数值或负数才按未知处理；把 0 当缺失会抹掉压金通关的最强成绩。
        const actionValue = Number.isFinite(parsedAction) && parsedAction >= 0
          ? parsedAction : null;
        const tier = Number(entry.t) === 2 ? 'target' : 'perfect';
        const previous = frontierByBuild.get(key);
        const seasonWeight = weightOf(s);
        // 同一配置跨版本只留一条最佳成绩，但保留它出现过的版本数和新近度权重。
        // 这能区分“从 4.5 一直稳定强势”的配置与“旧版本偶尔出分、当前消失”的配置，
        // 又不把同一版本的重复投稿当成额外收益。
        if (!previous) {
          frontierByBuild.set(key, {
            cost, actionValue, members, tier,
            historyWeight: seasonWeight,
            seasonCount: 1,
            newestSeason: s,
          });
        } else {
          previous.historyWeight += seasonWeight;
          previous.seasonCount += 1;
          if (!previous.newestSeason || seasonSort(previous.newestSeason, s) < 0) {
            previous.newestSeason = s;
          }
          if (actionValue !== null
            && (previous.actionValue === null || actionValue < previous.actionValue)) {
            previous.actionValue = actionValue;
            previous.members = members;
            previous.cost = cost;
            previous.tier = tier;
          }
        }
      }
    }
    for (const team of sd.teams || []) {
      if (!byRoster.has(team.rosterKey)) {
        byRoster.set(team.rosterKey, {
          rosterKey: team.rosterKey,
          roster: team.roster,
          costs: [],
          costMax: 0,
          over: team.over || [0, 0, 0, 0],
          coneOver: team.coneOver || [0, 0, 0, 0],
          perSeason: [],
          bestMetric: null,
          bestAv: null,
          avSum: 0,
          avN: 0,
          sample: null,
          count: 0,
          // 定档的原始条数（不是比率）：综合结论要按「多数投稿落在哪一档」判断
          // 这套作业能稳定打到什么水平。
          tiers: { perfect: 0, target: 0, pass: 0, below: 0 },
          keyEidolon: team.keyEidolon,
          keyEidolonShare: team.keyEidolonShare,
          eidoDist: team.eidoDist,
          /** 角色 → Map(星魂档 → 该阵容该档的最好成绩)，跨版本按「最好成绩」合并。 */
          eidoPerf: new Map(),
          /**
           * 角色 → Map(星魂档 → { n, hits, hit })，达标率画像，跨版本**按条数**合并。
           *
           * 与 `eidoPerf` 分开：`eidoPerf` 判「有没有跨档」（取最好成绩），
           * 这一张判「升这一档有没有让这套阵容更稳地达标」（取加权达标率）。
           * 只看最好成绩看不见后者——那正是知更鸟 E1→E2 这类提升被判低的原因。
           */
          eidoStats: new Map(),
        });
      }
      const agg = byRoster.get(team.rosterKey);
      const n = team.tierTotal || 0;
      agg.count += team.count || 0;
      // 定档条数只统计**可靠版本**：一个只投了 3 条的版本，它的那条投稿会把
      // 阵容的「多数档」直接定死，这正是「样本不足不下结论」要避免的。
      if (sd.reliable !== false) {
        agg.tiers.perfect += team.perfect || 0;
        agg.tiers.target += team.target || 0;
        agg.tiers.pass += team.pass || 0;
        agg.tiers.below += team.below || 0;
        // 星魂配对证据同样只收可靠版本（与定档条数同一条理由：几份样本不能定档）。
        // 合并规则与「同一副本里一个单位只记最好的一套」一致：同一档位取更好的成绩。
        if (withEidoPerf && team.eidoPerf) {
          for (const [char, levels] of Object.entries(team.eidoPerf)) {
            if (!agg.eidoPerf.has(char)) agg.eidoPerf.set(char, new Map());
            const mine = agg.eidoPerf.get(char);
            for (const [level, entry] of Object.entries(levels || {})) {
              const prev = mine.get(level);
              if (!prev || Number(entry?.perf) > Number(prev?.perf)) mine.set(level, entry);
            }
          }
        }
        // 达标率画像：同一档位把**条数**累加（不是取最好，也不是按比例平均——
        // 各版本的样本数不同，只有条数才能正确加权）。跨版本累加之后
        // `hit = hits / n` 就是该阵容该档位的整体达标率。
        if (withEidoPerf && team.eidoStats) {
          for (const [char, levels] of Object.entries(team.eidoStats)) {
            if (!agg.eidoStats.has(char)) agg.eidoStats.set(char, new Map());
            const mine = agg.eidoStats.get(char);
            for (const [level, entry] of Object.entries(levels || {})) {
              const prev = mine.get(level) || {
                n: 0, hits: 0, hit: 0, tiers: [0, 0, 0, 0], modalTier: entry?.modalTier,
              };
              prev.hits += Number(entry?.hits) || 0;
              prev.n += Number(entry?.n) || 0;
              prev.hit = prev.n ? Number((prev.hits / prev.n).toFixed(4)) : 0;
              // 档位分布同样按条数累加：客户端用它算「升这一档多出多少分」。
              const src = Array.isArray(entry?.tiers) ? entry.tiers : [];
              for (let i = 0; i < 4; i += 1) prev.tiers[i] += Number(src[i]) || 0;
              if (entry?.tier) prev.tier = entry.tier;
              if (entry?.cost !== undefined) prev.cost = entry.cost;
              mine.set(level, prev);
            }
          }
        }
      }
      // 平均行动值按投稿数加权汇总：赛季之间样本量差很多，直接平均会被小版本带偏。
      if (Number.isFinite(team.avgAv)) {
        agg.avSum += team.avgAv * (team.count || 0);
        agg.avN += team.count || 0;
      }
      if (Number.isFinite(team.cost)) agg.costs.push(team.cost);
      if (Number.isFinite(team.costMax)) agg.costMax = Math.max(agg.costMax, team.costMax);
      if (Number.isFinite(team.bestAv)
        && (agg.bestAv === null || team.bestAv < agg.bestAv)) agg.bestAv = team.bestAv;
      if (Number.isFinite(team.best)
        && (agg.bestMetric === null || team.best < agg.bestMetric)) agg.bestMetric = team.best;
      // 展开配装时用成本明细最全的那条样本。
      if (team.sample && (!agg.sample || (team.sample.cost || 0) >= (agg.sample.cost || 0))) {
        agg.sample = team.sample;
      }
      if (n > 0 && sd.reliable !== false) {
        agg.perSeason.push({
          season: s,
          perfect: (team.perfect || 0) / n,
          target: (team.target || 0) / n,
          below: (team.below || 0) / n,
          // 行动值也按版本汇总（不是全窗口合计），这样它和满分率同口径、可比。
          avgAv: Number.isFinite(team.avgAv) ? team.avgAv : null,
          runs: team.count || 0,
          weight: weightOf(s),
        });
      }
    }
  }

  const costOfAgg = (agg) => {
    if (!agg.costs.length) return null;
    const s = [...agg.costs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  const teams = [...byRoster.values()].map((agg) => {
    const wSum = agg.perSeason.reduce((n, p) => n + p.weight, 0);
    const weighted = (pick) => (wSum
      ? agg.perSeason.reduce((n, p) => n + pick(p) * p.weight, 0) / wSum : 0);
    const perfect = weighted((p) => p.perfect);
    const target = weighted((p) => p.target);
    const below = weighted((p) => p.below);
    const cost = costOfAgg(agg);
    const trust = trustOf(agg.count);
    const perfects = agg.perSeason.map((p) => p.perfect);
    // 平均行动值同样按版本权重汇总，和满分率同口径；只要有一个版本缺这个数
    // 就按有数的版本加权，避免用 0 冒充「没有开销」。
    const avSeasons = agg.perSeason.filter((p) => Number.isFinite(p.avgAv));
    const avW = avSeasons.reduce((n, p) => n + p.weight, 0);
    const avgAv = avW
      ? Number((avSeasons.reduce((n, p) => n + p.avgAv * p.weight, 0) / avW).toFixed(3))
      : null;
    const tierTotal = agg.tiers.perfect + agg.tiers.target + agg.tiers.pass + agg.tiers.below;
    return {
      rosterKey: agg.rosterKey,
      roster: agg.roster,
      rosterCn: agg.roster.map((n) => zhName(i18n, 'characters', n)),
      count: agg.count,
      cost,
      costMax: agg.costMax || null,
      over: agg.over,
      coneOver: agg.coneOver,
      // 主榜排序用的量：满分率（含可信度折扣）
      rawPerfect: Number(perfect.toFixed(4)),
      perfect: Number(perfect.toFixed(4)),
      target: Number(target.toFixed(4)),
      below: Number(below.toFixed(4)),
      // 质量分 = 满分率 × 可信度折扣（不含成本）。**这不是排序用的强度**：
      // 强度由「成本升序 + 成绩」定义（见 bands 的注释）。这个字段只是给外部
      // 调用方一个「这套作业本身打得多好」的单一数字，不要拿它当总排名。
      quality: Number((perfect * trust).toFixed(4)),
      trust: Number(trust.toFixed(3)),
      // 定档条数：综合结论用它算「多数投稿落在哪一档」。
      tierCounts: { ...agg.tiers },
      tierTotal,
      // 用「各版本满分率」判断这套阵容会不会过期，而不是只给一个平均值。
      volatility: perfects.length > 1
        ? Number((Math.max(...perfects) - Math.min(...perfects)).toFixed(3)) : 0,
      seasons: agg.perSeason.map((p) => ({
        season: p.season, perfect: Number(p.perfect.toFixed(3)), runs: p.runs,
      })),
      seasonCount: agg.perSeason.length,
      newestSeason: agg.perSeason.length
        ? agg.perSeason[agg.perSeason.length - 1].season : null,
      bestMetric: agg.bestMetric,
      bestAv: agg.bestAv,
      // 平均行动值（按版本权重与满分率同口径）：档内越小越强。
      avgAv,
      keyEidolon: agg.keyEidolon,
      keyEidolonShare: agg.keyEidolonShare,
      eidoDist: agg.eidoDist,
      // 星魂配对证据：客户端按**同一套阵容**配对量星魂的边际收益（见 buildConclusion）。
      // 只在综合结论那条路上给（withEidoPerf），主榜不该为它涨体积。
      eidoPerf: withEidoPerf ? Object.fromEntries([...agg.eidoPerf.entries()].map(([char, levels]) => [
        char, Object.fromEntries(levels),
      ])) : undefined,
      // 达标率画像（同上，只在综合结论那条路上给）：判「升这一档有没有更稳地达标」。
      eidoStats: withEidoPerf && agg.eidoStats.size
        ? Object.fromEntries([...agg.eidoStats.entries()].map(([char, levels]) => [
          char, Object.fromEntries(levels),
        ]))
        : undefined,
      evidence: agg.count >= 10 ? 'solid' : agg.count >= 5 ? 'ok' : agg.count >= 2 ? 'thin' : 'lone',
      sample: agg.sample ? localizeSample(agg.sample, i18n) : null,
    };
  });

  return {
    teams,
    seasonRuns,
    windowRuns,
    frontierRows: withFrontier ? [...frontierByBuild.values()] : undefined,
  };
};

/**
 * 一个 (模式, 关卡) 的完整跨版本阵容表 —— 供跨模式综合结论使用。
 *
 * 和 archiveStats 的区别：不分成本档、不截断、不算角色榜，只要阵容本身。
 * 综合结论要在一套阵容里逐单位算边际成本，截断会直接把候选删掉。
 *
 * `options.withEidoPerf`（默认关）带星魂配对证据；`options.withFrontier`（默认关）带
 * 配装、成本、行动值同源的高分配置。默认关闭以维持普通调用方的载荷形状；
 * 只有综合结论需要这两份额外证据。 */
export const archiveTeams = async (mode, options = {}) => {
  const data = await loadArchive();
  const i18n = await loadI18n();
  const scope = resolveScope(data, mode, options.season, options);
  if (!scope.ok) return scope;
  const { teams, seasonRuns, windowRuns, frontierRows } = aggregateTeams(scope, i18n, {
    withEidoPerf: options.withEidoPerf === true,
    withFrontier: options.withFrontier === true,
  });
  const wantedSeason = scope.stageData.seasons?.[scope.wanted] || {};
  return {
    ok: true,
    mode: scope.slug,
    modeLabel: MODE_LABELS[scope.slug] || scope.key,
    modeLabelCn: (await resolveModeLabels())[scope.slug] || scope.key,
    stage: scope.wantedStage,
    stageLabelCn: stageLabelOf(scope.slug, scope.wantedStage).labelCn,
    season: scope.wanted,
    seasons: scope.seasons,
    recentSeasons: scope.recent,
    windowSize: scope.windowSize,
    // 版本权重表（用户 2026-10 第 7 条）：2:2:2:1:1:1:1，按下标查表。
    versionWeights: scope.versionWeights || VERSION_WEIGHTS,
    minSeasonRuns: data.minSeasonRuns ?? 20,
    totalRuns: seasonRuns,
    windowRuns,
    totalTeams: wantedSeason.totalTeams || 0,
    tierLines: wantedSeason.lines || null,
    lowerIsBetter: wantedSeason.lowerIsBetter !== false,
    median: wantedSeason.median ?? null,
    // 该期成绩分布分位数（击败比例口径，见 tools/herta-build.mjs 的 dist 计算）
    dist: wantedSeason.dist || null,
    reliable: wantedSeason.reliable !== false,
    teams,
    ...(options.withFrontier === true ? { frontierRows: frontierRows || [] } : {}),
  };
};

/**
 * The recommendation payload for one mode + stage + season.
 *
 * 数据模型和早期版本完全不同，口径写清楚：
 *
 *   强度不看投稿数。黑塔网的榜单是按投稿数排的，但投稿多只说明「玩这套的人
 *   多」，不说明强。这里的强度 = **先看成绩档（满分率），同一个成绩里用到的
 *   限定越少越强**，再比平均行动值/轮次；投稿数只做一个温和的可信度折扣。
 *
 *   成本只数限定单位，单位是**金**（界面上也写「金」）：限定角色本体 1 金 +
 *   星魂每级 1 金，限定光锥本体 1 金 + 叠影每级 1 金。站点给的
 *   total_limited_5star_count 不能用——实测 87% 的
 *   投稿里它与 total_standard_5star_count 之和大于 4（一队只有 4 个位置），
 *   说明把光锥也算了进去，拆不出「角色 vs 光锥」。
 *
 *   主榜按成本档分组，档内再按「用到的限定数」从少到多分组、每组取前几套
 *   （见 bands 的注释）。这样既能看到「同样的成绩谁更便宜」，也不会把 1 条投稿
 *   和 700 条投稿混进一个总分。
 *
 *   跨版本综合：玩家要用一个账号横跨多个版本，所以不按版本分别出推荐，而是把
 *   该阵容在各版本的满分率按**版本权重**（用户 2026-10 第 7 条：2:2:2:1:1:1:1，
 *   近 1-3 版本 2 分、近 4-7 版本 1 分，窗口 7 个版本）汇总。样本不足
 *   minSeasonRuns 的版本不参与汇总——不丢弃投稿，只是不拿它下结论。
 */
export const archiveStats = async (mode, season, options = {}) => {
  const data = await loadArchive();
  const i18n = await loadI18n();
  const scope = resolveScope(data, mode, season, options);
  if (!scope.ok) return scope;
  const {
    slug, key, entry, stages, wantedStage, stageData, seasons, wanted, recent, windowSize,
  } = scope;
  const VERSION_WEIGHTS_OF_SCOPE = scope.versionWeights || VERSION_WEIGHTS;

  // 成本档：按实测成本分布（中位数约 10-11 金）划分，让每档都有足够样本。
  const BANDS = [
    { id: 'b0', lo: 0, hi: 2 },
    { id: 'b1', lo: 3, hi: 5 },
    { id: 'b2', lo: 6, hi: 8 },
    { id: 'b3', lo: 9, hi: 12 },
    { id: 'b4', lo: 13, hi: 18 },
    { id: 'b5', lo: 19, hi: Number.POSITIVE_INFINITY },
  ];

  const { teams, seasonRuns, windowRuns } = aggregateTeams(scope, i18n);

  // ---- 主榜：先看成绩档，同档内用到的限定越少越强
  //
  // 排序规则（所有模式一致，用户明确要求）：
  //   1. `perfect`（满分率）降序 —— 「最高成绩」是一切的前提。一个打 4 回合的
  //      0 限定阵容并不比 0 回合的 1 限定阵容强，所以成绩必须先分档。
  //   2. `cost` 升序 —— **用到的限定越少则强度越强**。这是这一版新增的规则，
  //      位置从「最后一键」提到「第二键」：同一个成绩里，越便宜越靠前。
  //      混沌回忆里 95%+ 的投稿都是 0 回合（满分率是天花板），所以这一键实际
  //      就是主键——这正是要的效果：「最高成绩能省成本才是真的强」。
  //   3. 平均行动值/轮次升序 —— 同成绩同成本，谁消耗得少。
  //   4. 可信度折扣降序 —— 一次孤例仍然在榜，只是排在反复验证过的解法后面。
  //      （用户明确说过「投稿多不算强」，所以它排在成本和行动值之后。）
  //
  // 展示规则：按上面的顺序排好后，取前 perBand 条。
  //
  // 早先还有一条「每个价位最多 perCost 条」的规则，那是成本当第一主键时加的
  // （否则 3-5 金档会被 3 金的阵容占满，4/5 金一条都看不到）。改成「成绩优先、
  // 同成绩比成本」之后它反而有害：0-2 金档里 0 成本但 0T 占比 0% 的阵容会占掉
  // 剩下的名额，把 0T 占比 100% 的阵容挤出前 8——榜上会出现「#5 是 0T 占比 0%」
  // 这种误导性名次。而按现在的顺序，同一个成绩里成本本来就是升序的，最便宜的
  // 解法天然排在前面，不需要再人为分配名额。
  const perBand = Math.max(1, Number(options.perBand) || 8);
  const bandRank = (a, b) => b.perfect - a.perfect
    || (a.cost ?? 0) - (b.cost ?? 0)
    || (a.avgAv ?? Number.POSITIVE_INFINITY) - (b.avgAv ?? Number.POSITIVE_INFINITY)
    || b.trust - a.trust
    || (a.bestAv ?? Number.POSITIVE_INFINITY) - (b.bestAv ?? Number.POSITIVE_INFINITY);
  const bands = BANDS.map((band) => {
    const pool = teams.filter((t) => (t.cost ?? 0) >= band.lo && (t.cost ?? 0) <= band.hi
      && t.seasonCount > 0)
      .sort(bandRank);
    const shown = pool.slice(0, perBand);
    return {
      ...band,
      label: band.hi === Number.POSITIVE_INFINITY
        ? `限定 ${band.lo} 金以上` : `限定 ${band.lo}-${band.hi} 金`,
      total: pool.length,
      hidden: Math.max(0, pool.length - shown.length),
      // 这一档实际展示了哪些价位（升序）：说明「同样的成绩能便宜到什么程度」。
      tiers: [...new Set(shown.map((t) => t.cost ?? 0))].sort((a, b) => a - b).map((cost) => ({
        cost,
        count: shown.filter((t) => (t.cost ?? 0) === cost).length,
      })),
      teams: shown.map((t, i) => ({ ...t, rank: i + 1 })),
    };
  }).filter((band) => band.total > 0);

  // ---- 角色榜（「环境统计」，明确只统计所选版本）
  //
  // 用**所选版本全部的阵容行**，不用上面跨版本聚合的结果，也不用 `bands`
  // （bands 每档只截断展示前 N 条）。聚合后的 count 是多个版本的累计值，混进
  // 单版本的角色次数会算出既不是位置数倍数、又超过该版本投稿数的数字。
  const characterRows = new Map();
  for (const team of stageData.seasons?.[wanted]?.teams || []) {
    // 按**位置**计数，不按去重后的名单：同一队里可以有两个同角色不同形态
    // （开拓者•记忆 + 开拓者•欢愉），roster 排序去重后会合成一项，按名单计数会少算。
    const slots = team.slots || team.roster;
    for (const name of slots) {
      if (!characterRows.has(name)) {
        characterRows.set(name, { name, count: 0, best: null, bestAv: null });
      }
      const row = characterRows.get(name);
      row.count += team.count || 0;
      if (Number.isFinite(team.best) && (row.best === null || team.best < row.best)) {
        row.best = team.best;
      }
      // 最好行动值单独记一份：绝境王棋关的判据是行动值，而它的 metric_value 是
      // 轮次（恒为 0），只给 best 的话角色榜会整列显示「最佳 0T」。
      if (Number.isFinite(team.bestAv) && (row.bestAv === null || team.bestAv < row.bestAv)) {
        row.bestAv = team.bestAv;
      }
    }
  }
  const characters = [...characterRows.values()].map((row) => {
    const path = data.refs?.characterPaths?.[row.name] || null;
    const meta = data.characters?.[row.name] || {};
    return {
      name: row.name,
      nameCn: zhName(i18n, 'characters', row.name),
      path,
      pathCn: path ? (i18n?.paths?.[path] || null) : null,
      rarity: meta.rarity ?? null,
      limited: meta.limited ?? null,
      count: row.count,
      best: row.best,
      bestAv: row.bestAv,
      eidolon: meta.eidolon?.[key] || null,
      topLightCones: (meta.topLightCones?.[key] || []).map((cone) => ({
        name: cone.name,
        nameCn: zhName(i18n, 'lightCones', cone.name),
        count: cone.count,
      })),
    };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const wantedSeason = stageData.seasons?.[wanted] || {};
  const schedule = (data.schedule || []).find((s) => s.version === wanted) || null;

  // 该版本**全部**阵容（bands 每档只截断展示前 N 条）。角色榜与任何「整体统计」
  // 都必须基于这一份，否则会与展示出去的分档数据对不上。
  const seasonTeamsView = (wantedSeason.teams || []).map((team) => ({
    rosterKey: team.rosterKey,
    roster: team.roster,
    rosterCn: team.roster.map((n) => zhName(i18n, 'characters', n)),
    slots: team.slots || team.roster,
    count: team.count,
    cost: team.cost,
    avgAv: Number.isFinite(team.avgAv) ? team.avgAv : null,
    bestAv: Number.isFinite(team.bestAv) ? team.bestAv : null,
    perfect: team.tierTotal ? Number((team.perfect / team.tierTotal).toFixed(4)) : 0,
    over: team.over,
    coneOver: team.coneOver,
    keyEidolon: team.keyEidolon,
    keyEidolonShare: team.keyEidolonShare,
    eidoDist: team.eidoDist,
  }));

  return {
    ok: true,
    available: true,
    mode: slug,
    modeLabel: MODE_LABELS[slug] || key,
    modeLabelCn: (await resolveModeLabels())[slug] || key,
    stage: wantedStage,
    stageLabel: stageLabelOf(slug, wantedStage).label,
    stageLabelCn: stageLabelOf(slug, wantedStage).labelCn,
    stages: stages.map((s) => ({
      stage: s,
      labelCn: stageLabelOf(slug, s).labelCn,
      seasons: Object.keys(entry.stages[s].seasons || {}).sort(seasonSort),
    })),
    season: wanted,
    seasons,
    recentSeasons: recent,
    windowSize,
    // 版本权重表（用户 2026-10 第 7 条）：2:2:2:1:1:1:1，按下标查表。
    // 旧字段名 `halfLife` 已撤掉 —— 它描述的是被取代的指数半衰期。
    versionWeights: VERSION_WEIGHTS_OF_SCOPE,
    minSeasonRuns: data.minSeasonRuns ?? 20,
    totalTeams: wantedSeason.totalTeams || 0,
    totalRuns: seasonRuns,
    windowRuns,
    // 本版本的定档线与量纲方向，界面直接显示，避免把判据写死在客户端。
    tierLines: wantedSeason.lines || null,
    tierOrder: data.tierOrder || ['perfect', 'target', 'pass', 'below'],
    lowerIsBetter: wantedSeason.lowerIsBetter !== false,
    median: wantedSeason.median ?? null,
    dist: wantedSeason.dist || null,
    reliable: wantedSeason.reliable !== false,
    seasonTotals: {
      perfect: wantedSeason.perfect || 0,
      target: wantedSeason.target || 0,
      pass: wantedSeason.pass || 0,
      below: wantedSeason.below || 0,
    },
    bands,
    // 该版本**全部**阵容（bands 每档只截断展示前 N 条）。角色榜与任何
    // 「整体统计」都必须基于这一份，否则会与展示的分档数据对不上。
    seasonTeams: seasonTeamsView,
    // 兼容旧字段名：早期接口把该版本的阵容列表叫 `teams`，端到端测试仍在用。
    teams: seasonTeamsView,
    teamCount: teams.length,
    characters,
    bosses: localizeBosses(i18n, data.bosses?.[`${key}|${wantedStage}|${wanted}`]
      || data.bosses?.[`${key}||${wanted}`]),
    schedule: localizeSchedule(i18n, schedule?.modes?.[MODE_LABELS[slug]]),
    categoryLabels: CATEGORY_LABELS,
    refs: {
      characters: (data.refs?.characters || []).map((name) => ({
        name,
        nameCn: zhName(i18n, 'characters', name),
      })),
      characterPaths: Object.fromEntries(
        Object.entries(data.refs?.characterPaths || {}).map(([name, path]) => [
          name, { path, pathCn: i18n?.paths?.[path] || null },
        ]),
      ),
      lightConePaths: Object.fromEntries(
        Object.entries(data.refs?.lightConePaths || {}).map(([name, path]) => [
          name, { path, pathCn: i18n?.paths?.[path] || null },
        ]),
      ),
      popularLightCones: Object.fromEntries(
        Object.entries(data.refs?.popularLightCones || {}).map(([char, cone]) => [
          char, { name: cone, nameCn: zhName(i18n, 'lightCones', cone) },
        ]),
      ),
      // 星级与限定标记：成本计算和「限定」标签都要用
      availability: data.refs?.availability || { characters: {}, lightCones: {} },
      paths: i18n?.paths || {},
      elements: i18n?.elements || {},
    },
  };
};

/** 米游社的模式短码 → 黑塔网 schedule 里的模式名。 */
const SCHEDULE_MODE = {
  moc: 'Memory of Chaos',
  pf: 'Pure Fiction',
  as: 'Apocalyptic Shadow',
  aa: 'Arbitrary Arbitration', // 站点没有这一项（异相仲裁没有投稿口径的首领）
};

/** 米游社的时间戳 `{year,month,day,hour,minute}` → ISO（没有时区，够用）。 */
const isoOfMihoyoTime = (t) => {
  const p = (n) => String(n ?? 0).padStart(2, '0');
  return `${t.year}-${p(t.month)}-${p(t.day)}T${p(t.hour)}:${p(t.minute)}:00`;
};

/**
 * 某一期赛程的敌方名单（每间一个）。
 *
 * 米游社的接口**只有末日幻影与异相仲裁**给首领名；混沌回忆与虚构叙事的载荷里
 * 一个敌方字段都没有（实测翻遍 `all_floor_detail` / `groups` 也只有队伍、时刻、
 * 回合，`upper_boss` 那两个副本恒为 null）。所以这两个副本的敌方只能从黑塔网的
 * 赛程表来。
 *
 * 关键是**怎么对上期**——不按版本号猜，按档期对：站点的
 * `availableDate` / `expireDate` 与游戏内的轮换窗口实测逐字相同
 * （4.5 混沌回忆 2026-09-28 → 11-02，正是游戏里的「来生泅渡」那一期；虚构叙事、
 * 末日幻影的六期也都一一对上），所以拿记录里的 begin_time 落进哪个窗口就定下来了。
 * 老版本没有档期的直接不猜。
 *
 * `bosses` 与 `sideCount` 同长，按「上半 / 下半 / 第三间」的顺序，因此可以按间号
 * 对位。名字是站点表单的口径（社区叫法），带 `hp`（站点登记的敌方血量）供参考。
 */
export const seasonEnemies = async (mode, begin, end) => {
  const label = SCHEDULE_MODE[mode];
  if (!label || !begin) return null;
  const from = String(begin).slice(0, 10);
  const to = String(end || begin).slice(0, 10);
  const archive = await loadArchive();
  const i18n = await loadI18n();
  let latest = null;
  for (const entry of archive.schedule || []) {
    const info = entry.modes?.[label];
    if (!info?.bosses?.length || !info.availableDate || !info.expireDate) continue;
    if (!latest || info.expireDate > latest.info.expireDate) latest = { version: entry.version, info };
    if (!(from >= info.availableDate && from < info.expireDate)) continue;
    return {
      version: entry.version,
      source: 'theherta',
      sides: info.sideCount ?? info.bosses.length,
      list: info.bosses.map((boss) => ({
        name: boss.name,
        nameCn: zhName(i18n, 'bosses', boss.name) || boss.name,
        hp: boss.hp || null,
      })),
      window: [info.availableDate, info.expireDate],
      // 记录比站点登记的那期还早（站点还没补上这一期）时也标出来，界面好写清来源
      partial: to <= info.availableDate,
    };
  }
  // 一期都没对上，而记录这一期又比站点最新一期还新 → **本地数据集落后了**。
  // 这是「换版本还能用」的关键一环：不静默地少一块，而是明说「去点更新」。
  if (latest && from >= latest.info.expireDate) {
    return {
      version: latest.version,
      source: 'theherta',
      behind: true,
      sides: latest.info.sideCount ?? latest.info.bosses.length,
      window: [latest.info.availableDate, latest.info.expireDate],
      list: [],
    };
  }
  return null;
};

/**
 * 把三个副本的敌方名单打包成 `{ moc, pf, as }`，交给战斗记录的归一化用。
 * （异相仲裁不在这里：它自己的端点就带骑士关首领与王棋关首领。）
 */
export const enemiesForRecords = async (raw) => {
  const out = {};
  const currentOf = (groups) => (groups || []).find((g) => g.status === 'Running' || g.status === 'New')
    || (groups || [])[0] || null;
  for (const [mode, key] of [['moc', 'challenge'], ['pf', 'story'], ['as', 'boss']]) {
    const group = currentOf(raw?.[key]?.groups);
    const found = await seasonEnemies(
      mode,
      group?.begin_time ? isoOfMihoyoTime(group.begin_time) : null,
      group?.end_time ? isoOfMihoyoTime(group.end_time) : null,
    );
    if (found) out[mode] = found;
  }
  return out;
};
