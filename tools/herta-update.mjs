// 增量更新本地 theherta 数据集：只抓「还没同步过的期」和「还在收投稿的期」。
//
// 为什么不整包重抓：已经结束的期不会再变，重抓纯属浪费带宽和时间。
//
// 判定规则（2026-10-14 重写，理由见 `planTargets` 上的长注释；2026-10-21 加宽限期与
// 轮转清扫，审计结论见 docs/同步漏投稿审计.md）：
//   抓取集合 = { 本地从未同步过的组合 } ∪ { 该副本最新的一期 } ∪ { 期还没结束的 }
//            ∪ { 期结束未满宽限期的 } ∪ { 每次轮转清扫 N 个最久没抓的已结束组合 }
//   跳过     = 已经同步过、且这一期已结束超过宽限期（或压根没排期过）的组合
// 「已经同步过」包含**同步回来就是 0 条**：3.0~3.5 那些该副本当时还没上线的永久空档，
// 正是靠这条才不再每次都重抓（旧判据 `count <= 0` 把它们判成「缺数据」，永远重抓）。
//
// 为什么要宽限期 + 清扫（2026-10-21 实测）：黑塔网**在期结束后很久还会放出投稿** ——
// 4.5 异相仲裁有一条 video_date 09-29 的投稿，期 10-04 结束、我们 10-14 抓过，
// 它 10-21 才上站（滞后 ≥2 周）。旧判据「过期即永久跳过」已经丢了 11 条
// （4.5 虚构 10 条 + 4.5 异相 1 条，占该期 3.8%）。
//
// 另外本脚本开头会**先刷新 submission_config.json**（2026-10-21 加）：增量链此前从不
// 刷排期，线上新增的版本对它完全不可见（实测线上已排到 4.7、本地只见 4.6）。
// 刷新失败只警告、用本地排期继续，不阻断同步。
//
// 输出：每完成一个组合就打一行 JSON 到 stdout，供服务端 SSE 转发给界面：
//   {"type":"plan","latest":…,"total":n,"skipped":m,"combos":k,"targets":[…]}
//   {"type":"progress","done":n,"total":m,"message":"..."}
//   {"type":"done","added":x,"updated":y,"errors":[...],"shrunk":[...]}
// 自洽关系：`total + skipped + capped === combos`（不带 --limit 时 capped 为 0）。
//
// 用法:
//   node tools/herta-update.mjs                    # 增量（推荐）
//   node tools/herta-update.mjs --all              # 忽略增量，抓全部组合
//   node tools/herta-update.mjs --json             # 只输出 JSON 行（服务端用）
//   node tools/herta-update.mjs --plan-only        # 只算计划、不发任何请求（测试用）
//   node tools/herta-update.mjs --limit=N          # 只抓计划里的前 N 个（测试用）
//   node tools/herta-update.mjs --concurrency=4    # 并发上限（默认 4）
//   node tools/herta-update.mjs --timeout=20000    # 单请求超时 ms（默认 20000）
//   node tools/herta-update.mjs --grace=30         # 期结束后继续重抓的天数（默认 30，0 关掉）
//   node tools/herta-update.mjs --sweep=2          # 每次轮转清扫几个最久没抓的组合（默认 2，0 关掉）
//   node tools/herta-update.mjs --allow-shrink     # 允许「线上条数变少」时覆盖本地文件
// 环境变量:
//   HERTA_BASE=<url>        覆盖站点（与 tools/herta-fetch.mjs 一致）
//   HERTA_DATA_DIR=<dir>    覆盖数据目录（默认 <仓库>/theherta）
//   HERTA_TODAY=YYYY-MM-DD  覆盖「今天」（只影响「这一期结束了没」的判断）
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/** 数据目录可用 HERTA_DATA_DIR 覆盖（测试夹具 / 自定义布局）；默认 <仓库>/theherta。 */
const OUT = process.env.HERTA_DATA_DIR ? resolve(process.env.HERTA_DATA_DIR) : join(ROOT, 'theherta');
const RAW = join(OUT, 'raw', 'submissions');
const BASE = process.env.HERTA_BASE || 'https://theherta.com';
const JSON_ONLY = process.argv.includes('--json');
const ALL = process.argv.includes('--all');
/** 只算计划、不发请求也不写盘（测试 / 预演用）。排期刷新也一并跳过。 */
const PLAN_ONLY = process.argv.includes('--plan-only');
/** 显式接受「线上条数比本地少」（站点删稿）。默认保留本地文件并告警。 */
const ALLOW_SHRINK = process.argv.includes('--allow-shrink');

/** 取一个正整数开关；非法值一律退回默认值，**默认行为不会被命令行弄松**。 */
const intArg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const n = Number(hit.slice(name.length + 3));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

/**
 * 取一个**非负**整数开关（0 = 显式关掉）。与 intArg 的差别就在 0：
 * `--grace=0` / `--sweep=0` 是合法的「关闭」，不能被当成非法值退回默认。
 */
const nonNegArg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const n = Number(hit.slice(name.length + 3));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
};

/** 只抓前 N 个组合（测试用）。0 = 不限。 */
const LIMIT = intArg('limit', 0);
/** 并发上限：站点是普通 Next.js 应用，串行实测 16 个请求要 76 秒，没必要也不该更高。 */
const CONCURRENCY = intArg('concurrency', 4);
/** 单请求超时：`fetch` 没有默认超时，一个卡死的连接会拖死整个同步。 */
const TIMEOUT_MS = intArg('timeout', 20000);
/**
 * 期结束后仍继续重抓的天数。实测站方收录滞后 ≥2 周（video_date 09-29 的投稿
 * 10-21 才上站），30 天盖得住「季末最后几天」+「滞后放出」两段。
 */
const GRACE_DAYS = nonNegArg('grace', 30);
/** 每次同步额外重抓的「最久没抓过」的已结束组合数（轮转清扫）。 */
const SWEEP = nonNegArg('sweep', 2);


/** 人类可读日志；--json 时改成 JSON 行，避免污染事件流。 */
const emit = (payload, human) => {
  if (JSON_ONLY) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else if (human) console.log(human);
};

const fileFor = (season, mode) => join(RAW, `${season}-${mode.replace(/\s+/g, '_')}.json`);

const readCount = async (season, mode) => {
  try {
    const data = JSON.parse(await readFile(fileFor(season, mode), 'utf8'));
    return Array.isArray(data.items) ? data.items.length : 0;
  } catch {
    return -1; // 文件不存在
  }
};

/** 条数 + 文件 mtime（轮转清扫按「最久没抓」排序用）。 */
const readInfo = async (season, mode) => {
  try {
    const p = fileFor(season, mode);
    const data = JSON.parse(await readFile(p, 'utf8'));
    const info = await stat(p);
    return {
      count: Array.isArray(data.items) ? data.items.length : 0,
      mtime: info.mtimeMs,
    };
  } catch {
    return { count: -1, mtime: 0 }; // 文件不存在
  }
};

const getJson = async (path) => {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      accept: 'application/json',
      // 站点没有 Cloudflare 门禁，但带上 UA 更稳妥。
      'user-agent': 'Mozilla/5.0 (compatible; hsr-character-viewer/1.0)',
    },
    // 没有超时的话，一个卡住的连接会把整个同步挂住（用户报的「耗时过长」之一）。
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/** `YYYY-MM-DD` → 可字典序比较的日期串；认不出来就返回 null。 */
const parseDay = (value) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

/** `YYYY-MM-DD` ± n 天（UTC 算术，避免夏令时；只用于日期字符串比较）。 */
const addDays = (day, delta) => {
  const [y, m, d] = String(day).split('-').map(Number);
  if (!y || !m || !d) return day;
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
};

/** 今天（本地时区）。HERTA_TODAY 可覆盖，好让判据在测试里可复现。 */
const today = () => {
  const injected = parseDay(process.env.HERTA_TODAY);
  if (injected) return injected;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * 算出这次要抓哪些组合。
 *
 * ⚠️ **为什么不能只用「全局最新版本」**（2026-10-14 修「同步不了 / 耗时过长 / 旧数据不跳过」）：
 * 黑塔网四个副本**各用一套版本号、进度也不同步**。实测 2026-10-14 的
 * `submission_config.json`：
 *
 *   4.6 异相仲裁 09-28 ~ 11-08（进行中）    4.6 末日幻影 10-05 ~ 11-16（进行中）
 *   4.6 虚构叙事 10-19 ~ 11-30（**还没开始**）  4.6 混沌回忆 11-02 ~ 12-14（**还没开始**）
 *   4.5 混沌回忆 09-28 ~ 11-02（**此刻真正在收投稿**）
 *   4.5 虚构叙事 09-14 ~ 10-19（**此刻真正在收投稿**）
 *
 * 旧规则只有 `season === 全局最新(4.6)` 与 `count <= 0` 两条，于是**恰好把两个活跃期
 * （4.5 混沌回忆 / 4.5 虚构叙事）全部跳过**，转头去抓两个还没开始的空期，再加上 3.0~3.5
 * 那 12 个「该副本当时还没上线」的永久空档每次重抓 —— 实测计划是
 * `抓 16 / 跳过 48`、耗时 76.4 秒，其中只有 2 个组合真的拿到了新数据。
 *
 * 现在的判据按**副本 × 期**各自判断（2026-10-21 起加 ④⑤）：
 *   抓   ① 从未同步过（文件不存在 / 不是 JSON）
 *        ② 该副本最新的一期（版本号落后的副本也能刷新）
 *        ③ 这一期的 `expireDate` 还没过（站点排期说它还在收投稿）
 *        ④ 期结束未满 `GRACE_DAYS`（站方收录滞后，见文件头注释）
 *        ⑤ 轮转清扫：每次从「跳过」里挑 `SWEEP` 个**文件最旧**的组合重抓一次，
 *          捞站方的事后补录（3.x 还有 14 个 0 条组合，谁也不知道哪天会进数据）
 *   跳过 = 已同步过、且这一期已结束超过宽限期（或压根没排期过）
 *
 * `expireDate` 只在 4.0 之后的排期里才有；更老的排期没有日期，靠「该副本最新一期」
 * 和轮转清扫兜住。
 */
const planTargets = async (config) => {
  const seasons = (config.seasons || []).map((s) => s.version).filter(Boolean);
  const allModes = config.modes || [];
  /** "最新版本"按数字比较，4.10 要排在 4.9 之后。 */
  const cmp = (a, b) => {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  const latest = [...seasons].sort(cmp).pop();
  const seasonEntry = (season) => config.seasons.find((s) => s.version === season) || {};
  const scheduledModes = (season) => Object.keys(seasonEntry(season).modes || {});

  /** 每个副本「最新的一期」：排期里显式列过这个副本的最大版本号。 */
  const latestByMode = {};
  for (const season of seasons) {
    for (const mode of scheduledModes(season)) {
      if (!latestByMode[mode] || cmp(season, latestByMode[mode]) > 0) latestByMode[mode] = season;
    }
  }

  const now = today();
  /** 宽限下限：expireDate 晚于它（但早于今天）的期仍在宽限期内。 */
  const graceLimit = addDays(now, -GRACE_DAYS);
  const targets = [];
  const skipped = [];
  let combos = 0;
  for (const season of seasons) {
    // 排期只列了「这一期跑过哪些副本」；站点偶尔会多出排期没写的组合，
    // 所以取并集。多出来的组合只要同步过一次就会进跳过分支，不会反复抓。
    const modes = [...new Set([...scheduledModes(season), ...allModes])];
    for (const mode of modes) {
      combos += 1;
      const entry = seasonEntry(season).modes?.[mode];
      const expire = parseDay(entry?.expireDate);
      const isLatest = latestByMode[mode] === season;
      const live = expire !== null && expire >= now;
      const grace = !live && expire !== null && expire >= graceLimit;
      const info = await readInfo(season, mode);
      const neverSynced = info.count < 0;
      if (ALL || neverSynced || isLatest || live || grace) {
        targets.push({
          season,
          mode,
          existing: Math.max(0, info.count),
          reason: neverSynced ? 'missing'
            : (isLatest ? 'latest' : (live ? 'live' : (grace ? 'grace' : 'forced'))),
        });
      } else {
        skipped.push({ season, mode, count: info.count, mtime: info.mtime, expire });
      }
    }
  }

  // 轮转清扫：从跳过集合里挑「文件最旧」的 N 个补抓一次（站方补录 / 长期断更兜底）。
  // mtime 用文件系统时间戳，不引入新的索引字段；同为 0（没有文件）不会出现在这里，
  // 因为没有文件时 neverSynced 已经把它抓走了。
  if (SWEEP > 0 && !ALL) {
    const sweepPicks = skipped
      .slice()
      .sort((a, b) => a.mtime - b.mtime
        || cmp(a.season, b.season) || a.mode.localeCompare(b.mode))
      .slice(0, SWEEP);
    for (const pick of sweepPicks) {
      const i = skipped.indexOf(pick);
      skipped.splice(i, 1);
      targets.push({
        season: pick.season,
        mode: pick.mode,
        existing: Math.max(0, pick.count),
        reason: 'sweep',
      });
    }
  }

  // 活跃的期排在前面：万一中途被打断，先拿到的是还在变的那些数据。
  const rank = { latest: 0, live: 1, missing: 2, grace: 3, sweep: 4, forced: 5 };
  targets.sort((a, b) => (rank[a.reason] - rank[b.reason])
    || cmp(a.season, b.season) || a.mode.localeCompare(b.mode));

  return { seasons, allModes, latest, latestByMode, now, graceLimit, combos, targets, skipped };
};

/**
 * 同步开头先刷新排期文件。增量同步的一切判据都读本地 `submission_config.json`，
 * 而增量链里没有别的步骤会去拉它 —— 不刷的话，线上新增的版本（新的一期）对
 * 增量同步是**永久不可见**的（2026-10-21 实测：线上已排到 4.7，本地只见 4.6）。
 * 结构不对 / 请求失败都只警告、沿用本地排期，绝不因为排期刷新失败而中断同步。
 */
const refreshConfig = async () => {
  try {
    const remote = await getJson('/submission_config.json');
    const okShape = Array.isArray(remote?.seasons) && remote.seasons.length > 0
      && Array.isArray(remote?.modes) && remote.modes.length > 0;
    if (!okShape) throw new Error('返回内容里没有 seasons / modes 列表');
    await writeFile(join(OUT, 'submission_config.json'), JSON.stringify(remote, null, 2), 'utf8');
    const n = remote.seasons.length;
    emit({ type: 'progress', message: `排期已刷新（${n} 个期）` },
      `排期已刷新：${n} 个期、${remote.modes.length} 个副本`);
    return true;
  } catch (err) {
    emit({ type: 'progress', message: `⚠ 排期刷新失败（用本地排期继续）：${err.message}` },
      `⚠ 排期刷新失败（用本地排期继续）：${err.message}`);
    return false;
  }
};

const main = async () => {
  if (!PLAN_ONLY) await refreshConfig();
  const config = JSON.parse(await readFile(join(OUT, 'submission_config.json'), 'utf8'));
  const plan = await planTargets(config);
  const { latest, latestByMode, skipped, graceLimit } = plan;
  if (!plan.seasons.length || !plan.allModes.length) {
    emit({ type: 'failed', message: 'submission_config.json 里没有版本或模式列表' });
    process.exitCode = 1;
    return;
  }

  // ---- 计划：哪些组合要抓（--limit 只截断「要抓的那部分」，不影响判据本身）
  const planned = plan.targets.length;
  const capped = LIMIT > 0 ? Math.max(0, planned - LIMIT) : 0;
  const queue = LIMIT > 0 ? plan.targets.slice(0, LIMIT) : plan.targets.slice();
  const total = queue.length;
  const tally = (reason) => plan.targets.filter((t) => t.reason === reason).length;
  const modeSummary = Object.entries(latestByMode)
    .map(([mode, season]) => `${mode}=${season}`).join('、');

  emit({
    type: 'plan',
    latest,
    latestByMode,
    targets: queue.map((t) => `${t.season} / ${t.mode}`),
    total,
    skipped: skipped.length,
    combos: plan.combos,
    planned,
    capped,
    today: plan.now,
    graceDays: GRACE_DAYS,
    graceLimit,
    sweep: SWEEP,
    reasons: {
      missing: tally('missing'), latest: tally('latest'), live: tally('live'),
      grace: tally('grace'), sweep: tally('sweep'), forced: tally('forced'),
    },
  }, `增量计划：抓 ${total} 个组合（进行中/最新 ${tally('latest') + tally('live')}、`
    + `从未同步 ${tally('missing')}、宽限期内 ${tally('grace')}、轮转清扫 ${tally('sweep')}、`
    + `强制 ${tally('forced')}），跳过 ${skipped.length} 个已结束的期`
    + `（各副本最新：${modeSummary}）`);

  if (PLAN_ONLY) return;

  await mkdir(RAW, { recursive: true });
  const errors = [];
  /** 「线上条数比本地少」的组合：默认不覆盖本地文件，只上报。 */
  const shrunk = [];
  let added = 0;
  let updated = 0;
  let done = 0;

  /**
   * 抓一个组合。单个组合失败只记进 errors，不中断其余（旧行为，保留）。
   * 返回 { payload, human }：payload 进 JSON 行协议，human 是给人看的日志。
   *
   * ⚠️ **缩水护栏（2026-10-21 加）**：线上条数比本地少时**不覆盖本地文件**。
   * 站点接口偶发的空/短响应会把整期清零，而且这一期从此被标成「已同步」、
   * 永远不会被重抓；`theherta/raw/` 不进 git、留档也不含它，一旦写坏就没了。
   * `herta-build.mjs` 的缩水护栏是**总量** 50%，单期清零只掉几个百分点，兜不住。
   * 真的要接受删稿就加 `--allow-shrink`。
   */
  const fetchOne = async (target) => {
    const { season, mode, existing } = target;
    const qs = new URLSearchParams({ season, mode });
    try {
      const data = await getJson(`/api/archive/submissions?${qs}`);
      const count = Array.isArray(data.items) ? data.items.length : 0;
      if (count < existing && !ALLOW_SHRINK) {
        shrunk.push({ season, mode, existing, count });
        return {
          payload: {
            type: 'progress',
            message: `${season} / ${mode}：⚠ 线上 ${count} 条 < 本地 ${existing} 条，`
              + `疑似异常响应，保留本地文件（确认要接受就加 --allow-shrink）`,
          },
          human: `${season} / ${mode} → ⚠ 线上 ${count} < 本地 ${existing}，保留本地文件`,
        };
      }
      await writeFile(fileFor(season, mode), JSON.stringify(data), 'utf8');
      if (existing === 0 && count > 0) added += count;
      else if (count !== existing) updated += Math.abs(count - existing);
      const note = existing > 0
        ? `（原有 ${existing}，${count === existing ? '无变化' : `变为 ${count}`}）`
        : '（新增文件）';
      return {
        payload: { type: 'progress', message: `${season} / ${mode}：${count} 条${note}` },
        human: `${season} / ${mode} → ${count} 条${note}`,
      };
    } catch (err) {
      errors.push({ season, mode, error: err.message });
      return {
        payload: { type: 'progress', message: `${season} / ${mode}：失败（${err.message}）` },
        human: `${season} / ${mode} → 失败：${err.message}`,
      };
    }
  };

  /**
   * 有上限的并发。串行抓 16 个组合实测 76.4 秒（≈4.8 s/个），并发 4 就够把这段
   * 压到 20 秒上下；再高只是给站点添麻烦。进度按**完成顺序**上报，
   * done/total 仍然是单调自洽的。
   */
  const workers = Array.from({ length: Math.max(1, Math.min(CONCURRENCY, total)) }, async () => {
    for (;;) {
      const target = queue.shift();
      if (!target) return;
      const { payload, human } = await fetchOne(target);
      done += 1;
      emit({ ...payload, done, total }, `  [${done}/${total}] ${human}`);
    }
  });
  await Promise.all(workers);

  // ---- 更新索引（只刷新这次动过的组合）
  const attempted = LIMIT > 0 ? plan.targets.slice(0, LIMIT) : plan.targets;
  try {
    const indexPath = join(OUT, 'raw', 'submissions-index.json');
    let index = { fetchedAt: null, combos: [], counts: {} };
    try { index = JSON.parse(await readFile(indexPath, 'utf8')); } catch { /* 首次 */ }
    const touched = new Set(attempted.map((t) => `${t.season}|${t.mode}`));
    index.fetchedAt = new Date().toISOString();
    index.combos = (index.combos || []).filter((c) => !touched.has(`${c.season}|${c.mode}`));
    for (const target of attempted) {
      const count = await readCount(target.season, target.mode);
      // 抓失败又本来就没有文件时记 -1 会让下游把它当成「有 0 条」；保留原样，
      // 只把真的读到的数写进去。
      if (count < 0) continue;
      index.combos.push({
        season: target.season,
        mode: target.mode,
        count,
        file: `raw/submissions/${target.season}-${target.mode.replace(/\s+/g, '_')}.json`,
      });
      index.counts[`${target.season}|${target.mode}`] = count;
    }
    await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');
  } catch (err) {
    errors.push({ season: '-', mode: 'index', error: err.message });
  }

  emit({
    type: 'done', added, updated, errors, shrunk, total, skipped: skipped.length,
  }, `\n增量抓取完成：新增 ${added} 条、变化 ${updated} 条`
    + (errors.length ? `，${errors.length} 个组合失败` : '')
    + (shrunk.length ? `，${shrunk.length} 个组合线上条数变少（已保留本地文件）` : ''));
  if (errors.length) process.exitCode = 1;
};

main().catch((err) => {
  emit({ type: 'failed', message: err.message }, `抓取失败：${err.message}`);
  process.exitCode = 1;
});
