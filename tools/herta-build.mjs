// Turn the raw theherta archive into the compact aggregate the GUI serves.
//
// Input : theherta/raw/submissions/<season>-<mode>.json  (from herta-fetch.mjs)
//         theherta/unit-availability.json                (from herta-availability.mjs)
//         theherta/submission_config.json, characters_config.json, ...
// Output: theherta/archive.json
//
// 数据结构只保留一份事实：**阵容级记录**。角色在某版本的上场次数、成绩、星魂
// 分布都能从阵容表算出来（见 src/server/archive.js 的 aggregate），所以不再重复
// 存「角色 × 模式 × 关卡 × 版本」的那一大块——上一版那样存会让文件从 8.9 MB
// 涨到 15.5 MB，而信息量没变。
//
// Usage: node tools/herta-build.mjs
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'theherta');
const RAW = join(OUT, 'raw');

const readJson = async (rel) => JSON.parse(await readFile(join(OUT, rel), 'utf8'));

/**
 * A run's characters live in flat `p1_char` … `p4_char` fields plus matching
 * `_eidolon` / `_lc` / `_superimp` fields. Missing player slots are simply
 * absent, so skip blanks rather than emitting empty members.
 */
/**
 * 叠影（1 = SI1 … 5 = SI5）。**0 是「这个位置没装光锥」，不是「未知」**（用户第 8 条）。
 *
 * 实测（`theherta/raw/submissions` 全量 118,562 个已配装位置）：
 *   * **有光锥**的 107,765 个位置，叠影只取 1/2/3/4/5，**从不为 0**；
 *   * **没有光锥**的 10,797 个位置，叠影为 0 的占 87.75%（3.3 有 3898 个、3.4 有
 *     4777 个，3.1/3.2 各 108 个）。
 * 也就是说站点用「叠影 0」表示这一位没装光锥。旧写法 `Number(x) || 5` 把 0 当 falsy，
 * 于是 **9,474 个「没装光锥」的位置被写成「满叠影 SI5」** —— 凭空造出一把满叠影光锥，
 * 整包口径的打包键（`角色|星魂|光锥|叠影`）因此多出一整个假的 S5 维度。
 *
 * 字段真的缺失（undefined / null / 空串）才是「未知」，那时才按满叠影处理
 * —— 这是原注释的本意，也是「宁可高估成本」的方向（与 `coneCostOf` 的兜底一致）。
 * 注意：是否计金仍然只看光锥是否来自限定跃迁（`costOf` 里有 `m.lc &&` 守卫），
 * 所以这条修复不会动队伍金数，只让打包键与配装显示恢复正确。
 */
const superimpOf = (value) => {
  if (value === undefined || value === null || value === '') return 5;
  const n = Number(value);
  if (!Number.isFinite(n)) return 5;
  return Math.max(0, Math.min(5, Math.round(n)));
};

const membersOf = (run) => {
  const out = [];
  for (let i = 1; i <= 4; i += 1) {
    const char = run[`p${i}_char`];
    if (typeof char !== 'string' || !char.trim()) continue;
    out.push({
      char: char.trim(),
      eidolon: Math.max(0, Number(run[`p${i}_eidolon`]) || 0),
      lc: typeof run[`p${i}_lc`] === 'string' && run[`p${i}_lc`].trim()
        ? run[`p${i}_lc`].trim() : null,
      superimp: superimpOf(run[`p${i}_superimp`]),
    });
  }
  return out;
};

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * 星魂档位：0 / 1 / 2 / 3-5 / 6。
 * 分布要能读出「主流停在哪个档」，所以 3-5 合并（样本少），0、1、2、6 单列。
 */
const EIDO_BUCKET = [0, 1, 2, 2, 2, 3, 4];
const EIDO_BUCKET_COUNT = 5;
/** 一个星魂档位至少要有这么多条投稿，成绩质量才对外给数。 */
const MIN_BUCKET_SAMPLE = 20;
/** 一个版本至少要有这么多条投稿，它的档位分布才参与强度计算。 */
const MIN_SEASON_RUNS = 20;
/**
 * 一套阵容至少要有这么多条投稿，才给它算**达标率画像**。
 *
 * 实测原始投稿里每套阵容的投稿数中位数是 2、均值 6.5，门槛取 5 时只有 11% 的
 * 阵容有画像，星魂条目经常退回旧口径。所以放到 3：先让画像铺开，
 * 「样本少 → 画像不可信」交给客户端的样本折扣处理（见 advice.js 的
 * `stabilityDelta`，它按 min(n) 打折而不是二值地丢弃）。
 */
const MIN_STABILITY_RUNS = 3;

/**
 * 档位的数值序（越大越好）。达标率画像要拿它和「该阵容的常见档位」比较，
 * 所以必须是一个**单调可比**的数，不能靠字符串。顺序与 advice.js 的
 * `tierRankOf` / `TIER_SCORE` 一致：below < pass < target < perfect。
 */
const TIER_CODE = { below: 0, pass: 1, target: 2, perfect: 3 };

const medianNum = (list) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * 定档。用户给的参考线，按模式区分：
 *
 *   末日幻影    积分 ≥4000 满分 / ≥3700 达标 / ≥3400 及格
 *   忘却之庭   轮次 ≤0 满分 / ≤2 达标 / ≤4 及格
 *   虚构叙事   轮次 同忘却之庭
 *   异相仲裁   骑士关与普通王棋关用轮次线；绝境王棋关难度极高，用行动值
 *              <300 满分 / <500 达标，且只有两档（实测 action_value 上界就是
 *              499，100% 落在 500 以内，硬凑一个及格线没有依据）
 *
 * 返回 [满分线, 达标线, 及格线] 三个数，方向由模式决定：
 *   轮次与行动值 → 越小越好（<= 线 即达成）
 *   末日幻影积分 → 越大越好（>= 线 即达成）
 */
const TIER_ORDER = ['perfect', 'target', 'pass', 'below', 'unknown'];
const TIER_LINES = {
  'Apocalyptic Shadow': { perfect: 4000, target: 3700, pass: 3400 },
  default: { perfect: 0, target: 2, pass: 4 },
  plight: { perfect: 300, target: 500 },
};

const tierOf = (mode, stage, metric, actionValue) => {
  if (!Number.isFinite(metric)) return 'unknown';
  if (mode === 'Apocalyptic Shadow') {
    return metric >= 4000 ? 'perfect' : metric >= 3700 ? 'target'
      : metric >= 3400 ? 'pass' : 'below';
  }
  if (mode === 'Anomaly Arbitration' && stage === 'plight') {
    if (!Number.isFinite(actionValue)) return 'unknown';
    return actionValue < 300 ? 'perfect' : actionValue < 500 ? 'target' : 'pass';
  }
  return metric <= 0 ? 'perfect' : metric <= 2 ? 'target'
    : metric <= 4 ? 'pass' : 'below';
};

const bump = (map, key, by = 1) => {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + by);
};

/** Top-N of a Map<string, number>, as a sorted array. */
const top = (map, n) => [...map.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, n)
  .map(([name, count]) => ({ name, count }));

/**
 * 版本号比较（`'3.0' < '4.6'`）。
 *
 * ⚠️ **不要用字典序**：版本号迟早出现 `4.10`，字典序会把它排在 `4.2` 前面。
 * 按 `主.次` 拆成数字逐段比。
 */
const cmpVersion = (a, b) => {
  const pa = String(a ?? '').split('.').map((n) => Number(n) || 0);
  const pb = String(b ?? '').split('.').map((n) => Number(n) || 0);
  return (pa[0] || 0) - (pb[0] || 0) || (pa[1] || 0) - (pb[1] || 0);
};

/**
 * 成本：把「凑到作业里这个水平」需要多少**金**算出来（1 金 = 一个限定单位，
 * 界面上也一律写「金」，不再写抽）。
 *
 *   限定角色本体 1 金 + 该角色的星魂每级 1 金
 *   限定光锥本体 1 金 + 该光锥的叠影每级 1 金
 *
 * 逐位配装（`p1_char` … `p4_superimp`）能拆出「角色 vs 光锥」，所以是主口径。
 * 站点的 `total_limited_5star_count` 拆不出这个结构（实测 87% 的投稿里它与
 * `total_standard_5star_count` 之和大于 4，说明它把光锥也算进去了），
 * **但它是一个完整的合计数**，用来兜住逐位配装的缺口（见 `repairCostWithSiteGold`）。
 */
const costOf = (members, isLimitedChar, isLimitedCone) => {
  let total = 0;
  const items = [];
  for (const m of members) {
    if (isLimitedChar(m.char)) {
      const pulls = 1 + m.eidolon;
      total += pulls;
      items.push({ kind: 'char', name: m.char, pulls, eidolon: m.eidolon });
    }
    if (m.lc && isLimitedCone(m.lc)) {
      const pulls = 1 + Math.max(0, m.superimp - 1);
      total += pulls;
      items.push({ kind: 'cone', name: m.lc, pulls, superimpose: m.superimp });
    }
  }
  return { total, items };
};

/**
 * 用站点自己的「限定 5★ 总数」把逐位配装的**缺口**兜住（用户第 8 条）。
 *
 * 背景（实测，探针 `tools/_probe-superimp9.mjs`、`tools/_probe-live-lc.mjs`）：
 * 老版本（3.1–3.4 一带）有 **2542 条投稿的 `p*_lc` 整条是 null** —— 光锥和它的
 * 叠影一起缺。这不是本地副本旧了：直接问线上
 * `/api/archive/submissions?season=3.1&mode=Memory of Chaos`，同样 64/75 条没有
 * 光锥。也就是说**站点在这些老投稿上只给了合计，没给逐位光锥**。
 *
 * 后果很具体：我们还原出来的队伍金数偏低（缺了光锥本体与叠影），而性价比总榜的
 * 分母正是「这套队伍几金」—— 金数被低估 → 那条配置的性价比被**高估**，
 * 于是「数据不全的旧投稿」反而霸榜。
 *
 * 所以把站点的合计当作**下限**：只有我们数少了才补上。数多了**不动** ——
 * 多出来的那点（实测 19/29769 = 0.06%，例如 3.4 命运联动那批光锥的卡池归属）
 * 属于 availability 的边界个案，而「宁可高估成本」与 `coneCostOf` 的兜底方向一致。
 */
const repairCostWithSiteGold = (cost, run) => {
  const siteGold = Number(run.total_limited_5star_count);
  if (!Number.isFinite(siteGold) || siteGold <= cost.total) return cost;
  return { ...cost, total: siteGold, siteFloor: siteGold, floorApplied: true };
};

/**
 * 成绩质量：0 = 打平本版本中位水平，1 = 明显更好，-1 = 明显更差。
 * 各模式量纲不同（轮次 / 积分 / 行动值），所以必须按版本自己的中位数归一化，
 * 否则「提升」会出现几百上千的假值。
 */
const qualityOf = (metric, median, lowerIsBetter) => {
  if (!Number.isFinite(metric) || !Number.isFinite(median)) return null;
  if (median === 0) {
    // 轮次制的中位数几乎必然是 0，除法会炸，退化成「是否最优」。
    if (!lowerIsBetter) return metric >= 1 ? 1 : 0;
    return clamp01(1 - metric);
  }
  const q = lowerIsBetter ? 1 - metric / median : metric / median - 1;
  return Math.max(-1, Math.min(1, q));
};

const main = async () => {
  const [config, charConfig, charPaths, lcPaths, popularLc, availability] = await Promise.all([
    readJson('submission_config.json'),
    readJson('characters_config.json'),
    readJson('character_paths.json'),
    readJson('lightcone_paths.json'),
    readJson('popular_lightcones.json'),
    readJson('unit-availability.json').catch(() => null),
  ]);

  if (!availability) {
    console.error('缺少 theherta/unit-availability.json —— 先运行 node tools/herta-availability.mjs');
    process.exitCode = 1;
    return;
  }
  const charAvail = availability.characters || {};
  const coneAvail = availability.lightCones || {};
  const isLimitedChar = (name) => charAvail[name]?.limited === true;
  const isLimitedCone = (name) => coneAvail[name]?.limited === true;

  let files = [];
  try {
    files = (await readdir(join(RAW, 'submissions'))).filter((f) => f.endsWith('.json'));
  } catch {
    console.error('找不到 theherta/raw/submissions —— 先运行 node tools/herta-fetch.mjs');
    process.exitCode = 1;
    return;
  }

  // ---- 第一趟：收齐去重后的投稿，并按 (模式,关卡,版本) 统计成绩基准
  const collected = [];
  /** `${mode}|${stage}|${season}` -> number[] of metric */
  const metricIndex = new Map();
  const seasonModes = new Map();
  let runCount = 0;
  const seenRunIds = new Set();
  /**
   * 角色 / 光锥**首次出现在哪个版本**（用户第 6 条「新角色缺少旧版本的数据」的判据）。
   *
   * 用**全部投稿**（不只是前沿）来算，所以它是「这个单位什么时候开始有人用」的下限近似：
   * 数据从 3.0 开始，所以 3.0 之前就有的老角色一律记成 3.0 —— 这正是我们想要的
   * （「它当时存在」→ 不该因为缺证据而被放大）。
   *
   * 为什么不看「它在榜单上最早出现在哪个版本」：那是**证据**的起点，不是**存在**的起点。
   * 一个老角色只是没人上传旧版本的成绩，用证据起点当判据会把它当成新角色去放大 ——
   * 实测这会让锚在 4.2（场地水平最高的那期）的整包被凭空放大到 2 倍，霸占榜首。
   *
   * ⚠️ **必须按副本（模式）分别记**（2026-10-10 修）：黑塔网的四个副本**各用一套版本号**，
   * 它们并不同步 —— 同一期（真实日期 2026-09-28~10-04）在异相仲裁叫 4.6、在混沌回忆
   * 叫 4.5、在末日幻影/虚构叙事也各是 4.5。实测：各副本当前进度 4.6/4.5/4.6/4.5。
   *
   * 以前只存全局一份（跨副本取最小值），于是拿「某副本里的 4.5」去和另一个副本的窗口比，
   * 判定就会错位。实测真珠：她最早投稿是 2026-09-28（= 异相仲裁的 **4.6**、混沌回忆的
   * **4.5**），全局 firstSeen 记成 4.5；拿它去比异相仲裁的窗口 `[4.0…4.5,4.6]` 时，
   * **4.5 被判成「已登场却无人使用」→ 算 0 分**，而那一期真实日期是 2026-08-26
   * （比真珠首次出现早一个月）→ 版本因子被压到 ×0.50。
   *
   * 全局值仍保留（`characters` / `lightCones`）作为**兜底**：调用方拿不到本副本的值时
   * （老数据集 / 测试夹具）回退到它，行为与以前一致。
   */
  const firstSeenChar = new Map();
  const firstSeenCone = new Map();
  /** `mode -> Map(名字 -> 该副本内的最早版本)`。键用数据集里的模式全名。 */
  const firstSeenCharByMode = new Map();
  const firstSeenConeByMode = new Map();
  const bucketOf = (outer, mode) => {
    if (!outer.has(mode)) outer.set(mode, new Map());
    return outer.get(mode);
  };
  const noteFirst = (map, name, season) => {
    if (!name) return;
    const cur = map.get(name);
    if (cur === undefined || cmpVersion(season, cur) < 0) map.set(name, season);
  };
  /** 异相仲裁绝境王棋关靠首领名带 Plight 标识（赛程里每版本恰好一个）。 */
  const stageOf = (mode, boss) => (mode === 'Anomaly Arbitration' && /plight/i.test(boss)
    ? 'plight' : '');

  for (const file of files.sort()) {
    const stem = file.replace(/\.json$/, '');
    const split = stem.indexOf('-');
    const season = stem.slice(0, split);
    const mode = stem.slice(split + 1).replace(/_/g, ' ');

    let payload;
    try {
      payload = JSON.parse(await readFile(join(RAW, 'submissions', file), 'utf8'));
    } catch {
      continue;
    }
    const runs = Array.isArray(payload.items) ? payload.items : [];
    if (!runs.length) continue;

    if (!(seasonModes.get(season) instanceof Set)) seasonModes.set(season, new Set());
    seasonModes.get(season).add(mode);

    for (const run of runs) {
      // 一条投稿的 id 唯一，但站点在它涉及的每个首领查询里各返回一次，
      // 不去重的话每个上场率都会被「该副本有几个首领」放大。
      const rid = String(run.id ?? `${season}|${mode}|${run.author_name}|${run.video_url}`);
      if (seenRunIds.has(rid)) continue;
      seenRunIds.add(rid);
      runCount += 1;

      const members = membersOf(run);
      if (!members.length) continue;
      // 记录角色 / 光锥的**首次出现版本**（用户第 6 条，见 firstSeenChar 的注释）。
      // 两份都记：全局（兜底）+ 按副本（正确判据 —— 四个副本各用一套版本号）。
      for (const member of members) {
        noteFirst(firstSeenChar, member.char, season);
        noteFirst(firstSeenCone, member.lc, season);
        noteFirst(bucketOf(firstSeenCharByMode, mode), member.char, season);
        noteFirst(bucketOf(firstSeenConeByMode, mode), member.lc, season);
      }
      const boss = typeof run.boss_name === 'string' ? run.boss_name : '(unknown)';
      const stage = stageOf(mode, boss);
      const metric = Number.isFinite(Number(run.metric_value)) ? Number(run.metric_value) : null;
      // 行动值：末日幻影 = 4000 − 积分；绝境王棋关直接取 action_value；其余模式
      // 的判据本身就是轮次，所以用 metric。
      //
      // 关键：站点的 action_value 只有**异相仲裁绝境王棋关**那一批真的填了，
      // 其余模式是 null 或空串。而 Number(null) === 0、Number('') === 0，
      // 直接 Number() 会把「没有这个字段」读成「行动值就是 0」——上一版因此让
      // 混沌回忆 / 虚构叙事 / 异相仲裁骑士关的 avgAv 全为 0，平均轮次、排序主键
      // 和「补强能省多少行动值」三处一起失去意义。所以必须先判断字段是否真的存在。
      const rawAv = run.action_value;
      const hasAv = rawAv !== null && rawAv !== undefined && rawAv !== ''
        && Number.isFinite(Number(rawAv));
      const actionValue = mode === 'Apocalyptic Shadow'
        ? (metric === null ? null : 4000 - metric)
        : (stage === 'plight' && hasAv ? Number(rawAv) : metric);
      const limitedRaw = Number(run.total_limited_5star_count);

      const seasonKey = `${mode}|${stage}|${season}`;
      if (!metricIndex.has(seasonKey)) metricIndex.set(seasonKey, []);
      // 分布要用**同一把尺子**：末日幻影与绝境王棋关的成绩是行动值（行动值 = 4000 − 积分），
      // 直接用 metric 会得到一堆 0（那些模式的 metric 字段本身就是 0）。
      const comparable = actionValue ?? metric;
      if (comparable !== null && Number.isFinite(Number(comparable))) {
        metricIndex.get(seasonKey).push(Number(comparable));
      }

      collected.push({
        season, mode, stage, seasonKey, run, members, metric, actionValue, boss,
        // 统一量纲后的成绩（末日幻影/绝境 = 行动值，其余 = 轮次）：稳定性画像要用它。
        comparable,
        limited: Number.isFinite(limitedRaw) ? limitedRaw : null,
        tier: tierOf(mode, stage, metric, actionValue),
        // 逐位配装算出来的金数，再用站点自己的合计数兜住缺口（用户第 8 条，见
        // `repairCostWithSiteGold`）。下游（前沿、阵容成本、星魂配对）一律读这个值。
        cost: repairCostWithSiteGold(costOf(members, isLimitedChar, isLimitedCone), run),
      });
    }
  }

  const seasonQuality = new Map();
  for (const [key, list] of metricIndex) {
    // 量纲方向**按模式判定**，不要从数据里猜：末日幻影的成绩是积分（越大越好），
    // 其余（轮次 / 行动值）都是越小越好。早先用「最小值是不是 0」猜，结果我把分布
    // 改成存行动值之后，末日幻影的 actionValue 里有 0（满分），被误判成「越小越好」。
    const lowerIsBetter = !key.startsWith('Apocalyptic Shadow');
    // 成绩分布（用户口径）：不再用「跨了几档」当分数——低难副本人人满分就没水分，
    // 高难副本（绝境）人少、进步空间大，于是自动放大。分位数按**每一份投稿**算，
    // 所以「击败比例」是真实人群比例，不是拍出来的档位分。
    const sorted = [...list].sort((a, b) => (lowerIsBetter ? a - b : b - a));
    // 从 0% 到 100% 每 5% 取一个分位点（21 个）：分辨率 5% 个百分点。
    // 早先只取 7 个点（1/7 ≈ 14%），同一个格子里的小差距会被抹成 0，
    // 结果高难副本的进步反而被算没了。
    const values = [];
    for (let i = 0; i <= 20; i += 1) {
      const p = i / 20;
      values.push(sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))]
        : null);
    }
    seasonQuality.set(key, {
      median: medianNum(list),
      lowerIsBetter,
      n: list.length,
      dist: { step: 0.05, values },
      // 定档线由模式决定，但记在版本上，将来要按版本微调不必改客户端。
      lines: key.startsWith('Apocalyptic Shadow') ? TIER_LINES['Apocalyptic Shadow']
        : key.includes('|plight|') ? TIER_LINES.plight
          : TIER_LINES.default,
    });
  }

  // ---- 第二趟：累加阵容、角色星魂画像
  /** `${mode}|${stage}|${season}` -> Map(rosterKey -> team) */
  const teamIndex = new Map();
  /** `${char}|${mode}` -> Map(lightcone -> count) */
  const lcPref = new Map();
  /** `${char}|${mode}` -> 星魂档位分布 + 各档成绩质量（跨版本汇总，样本更足） */
  const charEido = new Map();
  const bossIndex = new Map();
  /**
   * 「压金出分前沿」（用户 2026-10 的口径）。
   *
   * 每个 `${mode}|${stage}|${season}` 里，把**满分档 + 0-Cycle** 的投稿按
   * 「阵容 + 成本」去重后存下来。为什么单独一份、不复用 `teams`：
   *   * `teams` 是**按阵容聚合**的（同一套阵容的所有投稿压成一条），
   *     拿不到「这套阵容最便宜花了几金」这种逐条的分布；
   *   * 前沿要按**单条投稿的成本**排序，去重键是「阵容 + 成本」——
   *     同一成绩重复投稿不该加分（用户明确要求「多次投稿会干扰数据池」），
   *     但**同阵容更低成本的投稿是不同证据**，必须留下。
   *
   * 消费方：src/server/archive.js 的 `archiveFrontier` → advice.js 的 `gapUnits`。
   * 强度 = 角色/星魂档在**最便宜的那批满分投稿**里的占比；
   * 「存在压金的可能就说明强力」→ 看能不能挤进前沿，不看投稿数量。
   */
  const frontierIndex = new Map();

  for (const entry of collected) {
    const { season, mode, stage, seasonKey, run, members, metric, actionValue, tier, boss, limited, cost, comparable } = entry;
    const quality = seasonQuality.get(seasonKey) || { median: null, lowerIsBetter: true };

    if (!bossIndex.has(seasonKey)) bossIndex.set(seasonKey, new Map());
    bump(bossIndex.get(seasonKey), boss);

    for (const m of members) {
      const lcKey = `${m.char}|${mode}`;
      if (!lcPref.has(lcKey)) lcPref.set(lcKey, new Map());
      if (m.lc) bump(lcPref.get(lcKey), m.lc);

      if (!charEido.has(lcKey)) {
        charEido.set(lcKey, {
          count: 0,
          buckets: new Array(EIDO_BUCKET_COUNT).fill(0),
          qualitySum: new Array(EIDO_BUCKET_COUNT).fill(0),
          qualityN: new Array(EIDO_BUCKET_COUNT).fill(0),
        });
      }
      const ce = charEido.get(lcKey);
      ce.count += 1;
      const b = EIDO_BUCKET[Math.max(0, Math.min(6, Math.round(m.eidolon)))];
      ce.buckets[b] += 1;
      const q = qualityOf(metric, quality.median, quality.lowerIsBetter);
      if (q !== null) { ce.qualitySum[b] += q; ce.qualityN[b] += 1; }
    }

    const roster = members.map((m) => m.char).slice().sort();
    const rosterKey = roster.join(' + ');
    if (!teamIndex.has(seasonKey)) teamIndex.set(seasonKey, new Map());
    const teams = teamIndex.get(seasonKey);
    if (!teams.has(rosterKey)) {
      teams.set(rosterKey, {
        roster, count: 0, best: null, bosses: new Map(), subcategories: new Map(), sample: null,        tiers: new Map(), eidoDist: new Array(7).fill(0), eidoN: 0,
        costs: [], over: [0, 0, 0, 0], coneOver: [0, 0, 0, 0], bestAv: null,
        // 行动值合计与条数：成本档内真正用来分高下的量。
        // 达标率（满分率）在这个数据集里几乎是天花板——混沌回忆 95.7% 的投稿
        // 都是 0 回合，所以同一成本档里人人 100%，排不出名次；行动值是连续的，
        // 能分出「都满分，但谁用得更少」。
        avSum: 0, avN: 0,
        // **同一套阵容、同一角色、不同星魂档**各自的最好成绩。
        // 客户端算星魂的边际收益时要按阵容配对才干净（跨阵容比出来的是阵容差异），
        // 而聚合后的每套阵容只有一条代表记录，所以必须在建库时按档位分层记下来。
        // 结构：{ 角色名: { 档位: 该档最好成绩 } }
        eidoPerf: new Map(),
        // 同一阵容里「角色 → {星魂档: {n, meanQ}}」：稳定性画像（第二趟半填）。
        eidoStats: new Map(),
        // 这套阵容**每一条投稿**的成绩（用于第二趟算稳定性，见下面的 eidoStats）。
        // 只留算分位数需要的两个量，不留整条 payload。
        // 结构：[{ metric, members: [[char, level], …] }]
        runs: [],
      });
    }
    const t = teams.get(rosterKey);
    t.count += 1;
    t.slots = members.map((m) => m.char);
    bump(t.tiers, tier);
    for (const m of members) {
      const e = Math.max(0, Math.min(6, Math.round(m.eidolon)));
      t.eidoDist[e] += 1;
      t.eidoN += 1;
      // 同一阵容里该角色在这个星魂档下的**成绩 + 档位 + 这套阵容的成本**。
      // 只存成绩不够：星魂档的价值要回答「升这一档，档位变了吗？成本还压得住吗？」
      // ——好打副本里升档只会让成本上升，所以必须同时知道档位与成本才能判它值不值。
      if (!t.eidoPerf.has(m.char)) t.eidoPerf.set(m.char, new Map());
      const perChar = t.eidoPerf.get(m.char);
      const better = mode === 'Apocalyptic Shadow'
        ? (actionValue === null ? null : -actionValue)   // 行动值越小越好
        : -(Number(actionValue ?? metric) || 0);
      const cur = perChar.get(e);
      if (better !== null && (cur === undefined || better > cur.perf)) {
        perChar.set(e, { perf: Number(better.toFixed(3)), tier, cost: cost.total });
      }
    }
    t.costs.push(cost.total);
    // 成本指纹：分开记「星魂溢出」与「叠影溢出」，否则把光锥叠影混进角色星魂里，
    // 对不上任何一种口径（限定角色本体数 + 星魂 <= cost <= ... 的自检会失败）。
    members.forEach((m, i) => {
      if (isLimitedChar(m.char) && m.eidolon > 0) t.over[i] += m.eidolon;
      if (m.lc && isLimitedCone(m.lc)) {
        const dupes = Math.max(0, m.superimp - 1);
        if (dupes > 0) t.coneOver[i] += dupes;
      }
    });
    if (Number.isFinite(actionValue) && (t.bestAv === null || actionValue < t.bestAv)) {
      t.bestAv = actionValue;
    }
    if (Number.isFinite(actionValue)) { t.avSum += actionValue; t.avN += 1; }
    if (metric !== null && (!Number.isFinite(t.best) || metric < t.best)) {
      t.best = metric;
      t.sample = {
        id: run.id ?? null,
        author: run.author_name ?? null,
        video: run.video_url ?? null,
        date: run.video_date ?? null,
        boss,
        stage: stage || null,
        subcategory: run.subcategory ?? null,
        metric,
        actionValue,
        tier,
        limited,
        cost: cost.total,
        members,
      };
    }
    bump(t.bosses, boss);
    bump(t.subcategories, run.subcategory || '(none)');

    // 稳定性要用的：这一条投稿的成绩 + 四个位置的星魂档 + 这条投稿的档位。
    // `comparable` 已经把「末日幻影/绝境看行动值、其余看轮次」统一过了。
    if (comparable !== null && Number.isFinite(Number(comparable))) {
      t.runs.push({
        metric: Number(comparable),
        tier: TIER_CODE[tier] ?? 0,
        members: members.map((m) => ([
          m.char, Math.max(0, Math.min(6, Math.round(m.eidolon))),
        ])),
      });
    }

    // ---- 性价比榜证据：保留满分与次高目标档。绝境的 <500 行动值达标投稿
    // 是用户观察 E2 强势的核心数据，不能只保留 <300 的满分投稿。
    // 这样普通模式中 E0/E1/E2 的压金通关可作为独立证据；绝境仍只认 <300 行动值。
    // `tier` 也会保存下来，旧的绝境/差距榜继续只读取满分档。
    if (tier === 'perfect' || tier === 'target') {
      if (!frontierIndex.has(seasonKey)) frontierIndex.set(seasonKey, new Map());
      const fmap = frontierIndex.get(seasonKey);
      // 去重键：阵容（角色 + 星魂档 + 光锥叠影）+ 队伍成本
      const rosterId = members
        .map((m) => `${m.char}E${Math.max(0, Math.min(6, Math.round(m.eidolon)))}/${m.lc || '-'}S${m.superimp || 0}`)
        .sort().join('|');
      const fkey = `${rosterId}@${cost.total}`;
      const comparableValue = comparable !== null && Number.isFinite(Number(comparable))
        ? Number(comparable) : null;
      if (!fmap.has(fkey)) {
        fmap.set(fkey, {
          cost: cost.total,
          // comparable 已统一为越小越好的行动值 / 轮次 / 末日积分差。
          av: comparableValue,
          members: members.map((m) => ({
            char: m.char,
            eidolon: Math.max(0, Math.min(6, Math.round(m.eidolon))),
            lc: m.lc || null,
            superimp: Math.max(0, Number(m.superimp) || 0),
          })),
          rosterKey: t.roster.join(' + '),
          tier,
          season,
          count: 0,
        });
      } else {
        const previous = fmap.get(fkey);
        // 同配置同成本只保留最好的已归一成绩；重复投稿不增加权重。
        if (comparableValue !== null && (previous.av === null || comparableValue < previous.av)) {
          previous.av = comparableValue;
          previous.tier = tier;
        }
      }
      fmap.get(fkey).count += 1;
    }
  }

  // ------------------------------------------- 第二趟半：星魂的**达标率**画像
  //
  // 为什么需要它（用户 2026-10 追问「为什么知更鸟 E1→E2、刻律德菈 E0→E1 排名低」）：
  //
  // `eidoPerf` 每档只留**最好成绩**，于是「升一档有没有用」只能判「档位有没有跨过去」。
  // 实测混沌回忆里 96.6% 的星魂配对起点就已经是满分 → 再升也不可能跨档 →
  // 贡献恒为 0。而 E1→E2 这类提升的真实内容往往是**让同样的阵容更稳地达标**
  // （行动提前、容错更高），它不抬天花板，只抬**达标率**——只看最好成绩的度量
  // 结构上就看不见它。
  //
  // 做法：在**同一套阵容内部**统计这条投稿达到「该阵容的常见档位」的比例。
  // 一个角色在某个星魂档的达标率 = 它参与的那些投稿里、达到该阵容常见档位的比例。
  // 同一套阵容、同一角色、两个档位之间达标率之差，就是「升这一档让这套阵容稳了多少」。
  //
  // 只在同阵容内比较，所以量到的是星魂差异而不是阵容差异，与 `eidoPerf` 同一口径。
  //
  // ⚠️ 这个量**会被投稿样本的选择效应污染**（玩家只投稿自己打得好的那几把，
  // 而且高星魂档的玩家整体投入更多）。所以客户端把它当成**门槛/折扣**用，
  // 而不是单独拿它加分：跨档仍由 `eidoAgg.tierUp` 决定，达标率只用来区分
  // 「所以升这一档到底稳了多少」。见 advice.js 的 `eidolonStepValue`。
  for (const [seasonKey, teams] of teamIndex) {
    for (const t of teams.values()) {
      const runs = t.runs;
      if (runs.length < MIN_STABILITY_RUNS) continue;
      // 该阵容的「常见档位」= 出现最多的档位（中位数档，抗离群）。
      const tierDist = new Map();
      for (const r of runs) tierDist.set(r.tier, (tierDist.get(r.tier) || 0) + 1);
      const modalTier = [...tierDist.entries()].sort((a, b) => b[1] - a[1])[0][0];
      // `${char}|${level}` -> { sum, n, tiers: [below,pass,target,perfect] }
      const acc = new Map();
      for (const r of runs) {
        const hit = r.tier >= modalTier ? 1 : 0;
        for (const [char, level] of r.members) {
          const key = `${char}|${level}`;
          if (!acc.has(key)) acc.set(key, { sum: 0, n: 0, tiers: [0, 0, 0, 0] });
          const a = acc.get(key);
          a.sum += hit;
          a.n += 1;
          a.tiers[r.tier] += 1;
        }
      }
      for (const [key, a] of acc) {
        const [char, levelStr] = key.split('|');
        const level = Number(levelStr);
        if (!t.eidoStats.has(char)) t.eidoStats.set(char, new Map());
        const perChar = t.eidoStats.get(char);
        const entry = perChar.get(level) || {
          n: 0, hits: 0, hit: 0, tiers: [0, 0, 0, 0], modalTier,
        };
        // 稳定性/出分画像按样本数累加。同时记 `hits`（达到常见档位的**条数**）
        // 与 `tiers`（各档位的**条数**）而不是只记比例：聚合层要跨版本合并同一套
        // 阵容时，只有条数才能正确加权（按比例平均会在样本数不同的版本之间算错）。
        //
        // `tiers` 是**每一步自己的档位分布**（不是整套阵容的），客户端用它算
        // 「升这一档把档位分布的期望值抬了多少」= 多出多少分。
        entry.hits += a.sum;
        entry.n += a.n;
        entry.hit = Number((entry.hits / entry.n).toFixed(4));
        for (let i = 0; i < 4; i += 1) entry.tiers[i] += a.tiers[i];
        const perf = t.eidoPerf.get(char)?.get(level);
        if (perf) { entry.tier = perf.tier; entry.cost = perf.cost; }
        perChar.set(level, entry);
      }
    }
  }

  // ---------------------------------------------------------------- serialise
  const modes = {};
  for (const [seasonKey, teams] of teamIndex) {
    const [mode, stage, season] = seasonKey.split('|');
    if (!modes[mode]) modes[mode] = { stages: {} };
    const stageKey = stage || '';
    if (!modes[mode].stages[stageKey]) {
      modes[mode].stages[stageKey] = { seasons: {}, runCount: 0, teamsSeen: 0 };
    }
    const bucket = modes[mode].stages[stageKey];
    const list = [...teams.values()].map((t) => {
      const tiers = Object.fromEntries(t.tiers);
      const total = Object.values(tiers).reduce((a, b) => a + b, 0);
      const eidoTotal = t.eidoN || 1;
      // 关键星魂：这套阵容里用得最多的那个星魂档（累计占比过半的最小档）。
      let keyEidolon = 0;
      let acc = 0;
      for (let e = 0; e < 7; e += 1) {
        acc += t.eidoDist[e];
        keyEidolon = e;
        if (acc >= eidoTotal / 2) break;
      }
      return {
        rosterKey: t.roster.join(' + '),
        roster: t.roster,
        // 按位置的原始名单：roster 是排序去重的，同一队里两个同角色不同形态
        // （开拓者•记忆 + 开拓者•欢愉）会被合并，角色统计必须按位置数。
        slots: t.slots,
        count: t.count,
        best: Number.isFinite(t.best) ? t.best : null,
        bestAv: t.bestAv,
        // 平均行动值：同一成本档里越小越强。round 到 3 位避免存一堆浮点噪声。
        avgAv: t.avN ? Number((t.avSum / t.avN).toFixed(3)) : null,
        bosses: top(t.bosses, 3),
        subcategories: top(t.subcategories, 3),
        perfect: tiers.perfect || 0,
        target: tiers.target || 0,
        pass: tiers.pass || 0,
        below: tiers.below || 0,
        tierTotal: total,
        cost: medianNum(t.costs),
        costMax: t.costs.length ? Math.max(...t.costs) : null,
        // 成本指纹：四个位置各花了多少「本体之外的抽数」——over 是星魂溢出，
        // coneOver 是限定光锥的叠影溢出，两者分开记才能自洽地还原成本。
        // cost = 限定单位本体数 + sum(over) + sum(coneOver)，界面上直接列出来。
        // 不存完整成本明细：那会让文件涨 1.5 MB，而明细只有展开那一条时才需要，
        // 那时用 sample.costItems 就够了。
        over: t.over,
        coneOver: t.coneOver,
        keyEidolon,
        keyEidolonShare: Number((t.eidoDist[keyEidolon] / eidoTotal).toFixed(3)),
        eidoDist: t.eidoDist,
        // 同一阵容里「角色 → {星魂档: 最好成绩}」：客户端要按阵容配对算星魂的边际收益
        // （跨阵容比出来的是阵容差异，不是星魂差异）。成绩存成「越大越好」的等价分。
        eidoPerf: Object.fromEntries([...t.eidoPerf.entries()].map(([char, levels]) => [
          char,
          Object.fromEntries([...levels.entries()].map(([lv, v]) => [lv, v])),
        ])),
        // 同一阵容里「角色 → {星魂档: {n, hit}}」：达标率画像。
        // `hit` = 这个角色在这个星魂档下、这套阵容内达到「该阵容常见档位」的投稿比例。
        // 客户端用它算「升一档让这套阵容稳了多少」——只看最好成绩的 eidoPerf 看不见这个。
        // 没有画像（投稿不足 MIN_STABILITY_RUNS）的阵容不带这个字段，客户端自动回退。
        eidoStats: t.eidoStats.size
          ? Object.fromEntries([...t.eidoStats.entries()].map(([char, levels]) => [
            char,
            Object.fromEntries([...levels.entries()].map(([lv, v]) => [lv, v])),
          ]))
          : undefined,
        sample: t.sample,
      };
    // 档内排序：先看有没有人大面积达不到满分（满分率作为门槛），
    // 再用平均行动值分高下——这样「都满分，但谁用得更少」才排得出来。
    }).sort((a, b) => (b.perfect / Math.max(1, b.tierTotal))
      - (a.perfect / Math.max(1, a.tierTotal))
      || (a.avgAv ?? Infinity) - (b.avgAv ?? Infinity)
      || (a.bestAv ?? Infinity) - (b.bestAv ?? Infinity)
      || b.count - a.count);

    const q = seasonQuality.get(seasonKey) || {};
    bucket.seasons[season] = {
      runCount: q.n ?? 0,
      totalTeams: list.length,
      median: q.median ?? null,
      lowerIsBetter: q.lowerIsBetter !== false,
      // 成绩分布（每 5% 一个分位点）：客户端用它把「提升」换算成「击败比例」
      dist: q.dist || null,
      lines: q.lines || TIER_LINES.default,
      // 样本太少时该版本不参与强度计算（不是丢弃投稿，是不拿它下结论）。
      reliable: (q.n ?? 0) >= MIN_SEASON_RUNS,
      perfect: list.reduce((n, t) => n + t.perfect, 0),
      target: list.reduce((n, t) => n + t.target, 0),
      pass: list.reduce((n, t) => n + t.pass, 0),
      below: list.reduce((n, t) => n + t.below, 0),
      // 性价比证据：普通模式满分 + 次高目标档，绝境仅满分；按「阵容 + 成本」去重。
      // 只留前沿需要的字段（成本 / 成绩 / 四个位置），体积很小。
      // 排序交给读的一方：服务端要按**窗口内合并后的成本分布**取前沿，
      // 所以这里不预先截断（截断会把跨赛季的可比性做坏）。
      frontier: (() => {
        const fmap = frontierIndex.get(seasonKey);
        if (!fmap || !fmap.size) return undefined;
        // 紧凑编码：每个位置压成 `角色|星魂|光锥|叠影` 一个字符串。
        // 展开成对象会让这一节从 ~2 MB 涨到 ~7 MB（实测），而这些字段里
        // 读的一方只用到「谁、几命」和「成本」。
        return [...fmap.values()].map((f) => ({
          c: f.cost,
          a: f.av,
          t: TIER_CODE[f.tier] ?? 0,
          m: f.members.map((m) => `${m.char}|${m.eidolon}|${m.lc || ''}|${m.superimp}`),
        }));
      })(),
      teams: list,
    };
    bucket.runCount += q.n ?? 0;
    bucket.seasons[season] && (bucket.teamsSeen += list.length);
  }
  for (const entry of Object.values(modes)) {
    for (const stage of Object.values(entry.stages)) {
      stage.seasonList = Object.keys(stage.seasons).sort();
    }
  }

  const characters = {};
  for (const name of charConfig.characters || []) {
    const avail = charAvail[name] || {};
    characters[name] = { rarity: avail.rarity ?? null, limited: avail.limited ?? null };
  }
  for (const [key, ce] of charEido) {
    const [name, mode] = key.split('|');
    if (!characters[name]) characters[name] = { rarity: null, limited: null };
    if (!characters[name].eidolon) characters[name].eidolon = {};
    const total = ce.count || 1;
    characters[name].eidolon[mode] = {
      total: ce.count,
      dist: ce.buckets,
      share: ce.buckets.map((n) => Number((n / total).toFixed(4))),
      quality: ce.buckets.map((n, i) => (n >= MIN_BUCKET_SAMPLE && ce.qualityN[i]
        ? Number((ce.qualitySum[i] / ce.qualityN[i]).toFixed(3)) : null)),
    };
  }
  for (const [key, pref] of lcPref) {
    const [name, mode] = key.split('|');
    if (!characters[name]) characters[name] = { rarity: null, limited: null };
    if (!characters[name].topLightCones) characters[name].topLightCones = {};
    characters[name].topLightCones[mode] = top(pref, 5);
  }

  const bosses = {};
  for (const [key, map] of bossIndex) {
    bosses[key] = top(map, 50).map((e) => e.name).filter((n) => n !== '(unknown)');
  }

  const archive = {
    version: 2,
    source: 'https://theherta.com/archive',
    generatedAt: new Date().toISOString(),
    runCount,
    seasonCount: seasonModes.size,
    minSeasonRuns: MIN_SEASON_RUNS,
    tierOrder: TIER_ORDER,
    counts: {
      characters: Object.keys(characters).length,
      modes: Object.keys(modes).length,
      // 逐位配装缺了光锥 / 叠影、靠站点自己的合计兜住的投稿数（用户第 8 条）。
      // 正常数据下这个数应该远小于 runCount（实测 2542 / 29769 左右），
      // 它突然涨到接近总数就说明黑塔网又开始整批不给逐位光锥了。
      costFloorApplied: collected.filter((e) => e.cost?.floorApplied).length,
    },
    refs: {
      characters: charConfig.characters || [],
      lightCones: charConfig.lightcones || [],
      characterPaths: charPaths,
      lightConePaths: lcPaths,
      popularLightCones: popularLc,
      availability: { characters: charAvail, lightCones: coneAvail },
      // 角色 / 光锥**首次出现在哪个版本**（用户第 6 条「新角色缺少旧版本的数据」的判据）：
      // 总榜用「这个整包当时还不存在」来判定旧版本不参与平均，判据就是它。
      // 数据从 3.0 开始，所以 3.0 之前就有的老角色一律是 '3.0'（= 当时就存在）。
      //
      // ⚠️ 两组都要：`byMode` 是**正确判据**（四个副本各用一套版本号，必须用本副本的编号
      // 去比本副本的窗口）；`characters` / `lightCones` 是跨副本取最小值的**兜底**，
      // 只在调用方拿不到本副本值时用（老数据集 / 测试夹具）。详见注释里真珠那个例子。
      firstSeen: {
        characters: Object.fromEntries(firstSeenChar),
        lightCones: Object.fromEntries(firstSeenCone),
        byMode: Object.fromEntries([...firstSeenCharByMode].map(([mode, m]) => [mode, {
          characters: Object.fromEntries(m),
          lightCones: Object.fromEntries(firstSeenConeByMode.get(mode) || new Map()),
        }])),
      },
    },
    schedule: config.seasons || [],
    submitCategories: config.categories || [],
    modes,
    characters,
    bosses,
  };

  await mkdir(OUT, { recursive: true });
  const text = JSON.stringify(archive);
  await writeFile(join(OUT, 'archive.json'), text, 'utf8');
  const mb = (Buffer.byteLength(text) / 1024 / 1024).toFixed(2);
  console.log(`已写出 theherta/archive.json  ${mb} MB`);
  console.log(`  战绩 ${runCount} 条（去重后）`);
  console.log(`  角色 ${archive.counts.characters} 个，模式 ${archive.counts.modes} 个，版本 ${seasonModes.size} 个`);
  for (const [mode, m] of Object.entries(modes)) {
    for (const [stage, s] of Object.entries(m.stages)) {
      const seasons = Object.keys(s.seasons).sort();
      const teams = seasons.reduce((n, k) => n + s.seasons[k].totalTeams, 0);
      const thin = seasons.filter((k) => !s.seasons[k].reliable).length;
      console.log(`  ${mode}${stage ? `【${stage}】` : ''}: ${seasons.length} 个版本`
        + `（其中 ${thin} 个样本不足不参与强度）, ${teams} 套阵容, ${s.runCount} 条投稿`);
    }
  }
};

main().catch((err) => {
  console.error('聚合失败:', err);
  process.exitCode = 1;
});
