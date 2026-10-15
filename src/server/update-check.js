// 「和 GitHub 上的最新发布比一比」——用户 2026-10-14 第 5 条。
//
// 用户原话：「程序要支持与从 GitHub 比较最新版本，当版本与此项目的 GitHub 版本不同时，
// 点击提示进行更新，当版本与 GitHub 项目相同时，提示已是最新版本，显示此程序的版本号」。
//
// ## 为什么单独一个模块
//
// `src/server/app.js` 已经 1200 多行，而这一段有它自己的完整契约（超时、限流、缓存、
// 版本号比较、失败降级），塞进路由处理器里就没法单独测。这里只做**纯函数 + 一次取数**，
// 路由那边只剩「读 query → 调它 → json」。
//
// ## 网络策略（仓库不变式）
//
// `AGENTS.md` 写着「Keep reads of cached Star Rail data offline. Network refreshes must
// remain explicit」。这条检查**不是**星穹铁道数据，但它同样是**外网出口**，所以：
//   * 它**只在用户点击「检查更新」时**才跑 —— 启动、开页面、切分页都**不会**触发它；
//   * 结果在内存里缓存 `CACHE_TTL_MS`，连点不会把 GitHub 的匿名配额（60 次/小时/IP）用光。
//
// ## 失败也要说清楚
//
// 取不到（断网 / 被墙 / 触发限流）时返回 `ok: false` + 一句能照做的中文，而**不是**抛错 ——
// 界面上「检查更新失败」与「已是最新版本」必须是两种不同的结果，不能混。
import { PROGRAM_VERSION } from '../version.js';

/** GitHub 仓库（与 `package.json` / README 里的下载入口同一个）。 */
export const UPDATE_REPO = 'mxf133/hsr-character-viewer';

/** 取「最新发布」的 API：比 `/releases` 更省 —— 一条就够，不必翻页。 */
export const UPDATE_API_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

/** 没有发布记录 / 拿不到 API 时，给用户一个能自己去看的入口。 */
export const UPDATE_RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases`;

/** 缓存多久：10 分钟。够挡住连点，又不会让用户重开页面还看到旧结果。 */
export const CACHE_TTL_MS = 10 * 60 * 1000;

/** 单次请求超时：8 秒。GitHub 在国内直连时偶尔很慢，等太久不如早报失败。 */
export const REQUEST_TIMEOUT_MS = 8000;

/**
 * 从 tag 里取出**版本号**：`v4.6.104` / `V4.6.104` / `4.6.104` / `hsr-4.6.104-portable`
 * → `4.6.104`；取不到数字段时返回空串。
 *
 * ⚠️ 用「抓第一段 `数字(.数字)*`」而不是「去掉开头的 v」：这个仓库的 Release tag 由发布时
 * 手写，带不带 `v`、带不带前缀都出现过（`docs/发布到GitHub.md` 里的例子是 `v4.6.104`）。
 * 只去 `v` 的话 `hsr-4.6.104` 会被整串留下，`compareVersions` 把它当 0 段 —— 于是
 * **已经是最新反而提示「有更新」或「本地更新」**，两种都是错的。
 *
 * ⚠️ 取不到（`tag_name` 为空、或整串没有数字）时返回 `''`，由调用方判成 `error` ——
 * **绝不拿它去和当前版本比**：那样 `''` 会被当 0 段，得出「本地比 GitHub 新」这种假结论。
 */
export const normalizeVersion = (tag) => {
  const m = String(tag ?? '').match(/\d+(?:\.\d+)*/);
  return m ? m[0] : '';
};

/**
 * 逐段比版本号：`a > b` → 1，相等 → 0，`a < b` → -1。
 *
 * ⚠️ **不能按字符串比**：这个项目的版本号是「游戏主版本 + 修订号」（`4.6.104`），
 * 修订号迟早到三位数以上，但更早出问题的是**次版本**——`4.10` 的字典序小于 `4.6`，
 * 那样比会把「已经升到 4.10」判成「比 4.6 旧」。所以按 `.` 拆开逐段比数字。
 * 段数不同时短的补 0（`4.6` 与 `4.6.0` 视为同一个版本）。
 * 含非数字段（`4.6.1-rc1`）时，该段按 `parseInt` 取到的数字；取不到就按 0。
 */
export const compareVersions = (a, b) => {
  const pa = normalizeVersion(a).split('.');
  const pb = normalizeVersion(b).split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = Number.parseInt(pa[i] ?? '0', 10) || 0;
    const nb = Number.parseInt(pb[i] ?? '0', 10) || 0;
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
};

/** 上一次成功/失败的结果（`{ at, payload }`）。失败也缓存 —— 否则断网时会连点连失败。 */
let cache = null;

/** 清掉缓存（测试与探针用；生产只在进程内）。 */
export const resetUpdateCheckCache = () => { cache = null; };

/**
 * 问一次 GitHub，回答「要不要更新」。
 *
 * @param {object} options
 * @param {Function} options.fetchImpl  注入 fetch（测试用）。
 * @param {number} options.now          注入时钟（测试用）。
 * @param {number} options.ttlMs        缓存时长。
 * @param {number} options.timeoutMs    单次请求超时。
 * @param {boolean} options.force       跳过缓存。
 * @returns {Promise<object>} 形状见下面 `base` 的注释；**永远 resolve**，不抛。
 */
export const checkForUpdate = async (options = {}) => {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : CACHE_TTL_MS;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS;
  if (!options.force && cache && now - cache.at < ttlMs) {
    return { ...cache.payload, cached: true };
  }

  /**
   * 回答的形状（界面按 `status` 三分支，不再自己拆 error 字符串）：
   *   * `status: 'latest'`  —— 已是最新版本（`latest === current`）
   *   * `status: 'update'`  —— 有更新（`latest > current`）
   *   * `status: 'ahead'`   —— 本地比 GitHub 还新（开发中的分支 / 提前打包，**不算错**）
   *   * `status: 'error'`   —— 这次没问成（断网 / 限流 / 解析失败），`error` 是可读中文
   */
  const base = {
    current: PROGRAM_VERSION,
    repo: UPDATE_REPO,
    releasesPage: UPDATE_RELEASES_PAGE,
    checkedAt: new Date(now).toISOString(),
  };
  const fail = (error) => {
    const payload = { ok: false, status: 'error', ...base, error };
    // ⚠️ 失败也进缓存：连点「检查更新」时不该每次都去撞一次墙（GitHub 匿名限流是
    //    60 次/小时/IP，断网时每次都要等满 8 秒超时，体验更差）。
    cache = { at: now, payload };
    return payload;
  };

  if (typeof fetchImpl !== 'function') return fail('当前运行环境没有 fetch，无法联网检查。');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(UPDATE_API_URL, {
      headers: {
        // GitHub 的 API **必须**带 User-Agent，不带直接 403。
        'User-Agent': `hsr-warp-advisor/${PROGRAM_VERSION}`,
        Accept: 'application/vnd.github+json',
      },
      signal: controller.signal,
    });
    if (res.status === 404) {
      // 仓库还没有任何 Release：这不是错误，是「查不到可比的版本」。
      const payload = {
        ok: true, status: 'ahead', ...base, latest: null, url: UPDATE_RELEASES_PAGE,
        error: null, note: 'GitHub 上还没有任何发布记录，无法比较（本地版本可能就是最新）。',
      };
      cache = { at: now, payload };
      return payload;
    }
    if (!res.ok) {
      const hint = res.status === 403 || res.status === 429
        ? '（GitHub 匿名调用有每小时次数限制，过一会儿再试）' : '';
      return fail(`GitHub 返回 ${res.status}${hint}。`);
    }
    const data = await res.json().catch(() => null);
    const latest = normalizeVersion(data?.tag_name || data?.name || '');
    if (!latest) return fail('GitHub 的返回里没有版本号（tag_name 为空）。');
    const cmp = compareVersions(latest, PROGRAM_VERSION);
    const payload = {
      ok: true,
      status: cmp > 0 ? 'update' : (cmp < 0 ? 'ahead' : 'latest'),
      ...base,
      latest,
      // 优先用这一条发布自己的页面（`html_url`），拿不到才退回 releases 列表。
      url: typeof data?.html_url === 'string' && data.html_url ? data.html_url : UPDATE_RELEASES_PAGE,
      publishedAt: typeof data?.published_at === 'string' ? data.published_at : null,
      title: typeof data?.name === 'string' && data.name ? data.name : null,
      error: null,
    };
    cache = { at: now, payload };
    return payload;
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return fail(aborted
      ? `连接 GitHub 超时（超过 ${Math.round(timeoutMs / 1000)} 秒）。`
      : `连不上 GitHub：${err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }
};
