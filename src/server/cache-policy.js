// 缓存与「要不要回源米游社」的策略。
//
// ## 为什么改成「读本地、显式才联网」（用户 2026-10 要求）
//
// 改造前，GET /snapshot 与 GET /records 走的是「缓存超过 TTL 就自动回源」这条老路
// （`CACHE_TTL_MS.snapshot` 15 分钟 / `.records` 30 分钟）。后果是**每刷新一次页面、
// 每切一次抽卡推荐页就会自动打一次米游社**——只要缓存过了那个时间窗。
//
// 米游社的风控（retcode 10041「当前账号存在风险」/ 5003 / 1034）是按请求频率算的。
// 请求一密就整片拒绝，用户看到的症状就是「数据爬取出错」；而且越反复刷新坏得越快、
// 恢复得越慢（风控解除要按小时计）。用户原话：
// 「此项目不需要每次刷新都去更新数据，过多的请求会导致数据爬取出错」。
//
// 现在的规则：
//
//   1. **有本地数据时，读取一律不联网。** 缓存过多久都直接返回。
//      `CACHE_TTL_MS` 从此只用来算「显示上要不要提示数据偏旧」，不再决定发不发请求。
//   2. **只有显式刷新才联网**（POST 或 `?refresh=1`），也就是界面上那个
//      「刷新米游社战绩」按钮。这本来就是用户点一下的动作，不该被自动触发。
//   3. **显式刷新也限流**：两次真实请求之间至少隔 `minIntervalMs`（默认 60 秒，
//      见 `MIN_REFETCH_INTERVAL_MS`）。连点按钮、脚本重复调用、失败后立刻重试，
//      都会被挡下并直接返回本地那份，附带还要等多久。这一条防的是
//      「风控已经报警、再补一刀」——那正是把临时限制变成小时级限制的做法。
//   4. **完全没有本地数据时仍然会抓一次**（首次使用、换了新角色），否则界面只能空白。
//
// 第 4 条是刻意的例外：本工具的价值就是看自己的角色数据，第一次必须真抓一次。
// 之后所有读取都走本地。

/**
 * 「多久算偏旧」——**纯显示用**，不再触发任何网络请求。
 *
 * 之所以还留着这个概念：界面要能告诉用户「你看到的这份数据是多少天前的」，
 * 否则手动刷新就变成了盲操作（用户不知道刚才那次刷新到底有没有生效）。
 *
 * 数值 = **7 天**（用户 2026-10：「不超过 7 天不用提示过期/旧数据」）。
 * 演进过程记一下，别再往回调：15/30 分钟（自动重抓时代）→ 6 小时（v4.6.52 改成
 * 读本地时放宽）→ 7 天（用户明确要求）。改成读本地之后数据本来就只在手动刷新时
 * 才会变新，按分钟/按小时划线只会让「过期/旧数据」那块红字一直亮着，变成噪音。
 */
export const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const CACHE_TTL_MS = Object.freeze({
  snapshot: FRESH_WINDOW_MS,
  records: FRESH_WINDOW_MS,
});

/**
 * 两次**真实网络请求**之间的最小间隔（毫秒）。
 *
 * 只管显式刷新那条路；自动读取已经不发请求了，所以平时根本用不到。
 * 60 秒是个凭手感定的值：足够挡住连点和脚本重试，又不至于让人「我刚点过怎么
 * 没反应」——返回里会带上还要等多少秒，界面直接显示出来。
 */
export const MIN_REFETCH_INTERVAL_MS = (() => {
  const raw = Number(process.env.DSH_HSR_MIN_REFETCH_INTERVAL_MS);
  // 显式给 0 是在测试里关掉限流；NaN / 负数 / 非数字一律走默认。
  return Number.isFinite(raw) && raw >= 0 ? raw : 60 * 1000;
})();

/** 限流原因 → 给用户看的一句话（服务端与界面共用同一份口径，别各写一份）。 */
export const REFETCH_MESSAGES = Object.freeze({
  cached: '显示的是本地已保存的数据，本工具不会自动联网更新。',
  throttled: '刚刚才请求过米游社，为避免触发风控，请稍后再点刷新。',
  'no-cache': '本地还没有数据，正在首次抓取。',
  forced: '正在按你的要求重新抓取。',
});

/**
 * 缓存的新鲜度元信息。**注意 `stale` 不再意味着「该去联网了」**，它只表示
 * 「超过 `CACHE_TTL_MS` 了，界面上提示一下数据偏旧」。
 */
export const cacheMeta = (value, ttlMs, now = Date.now(), extra = {}) => {
  const fetchedAt = value?.fetchedAt || null;
  const timestamp = fetchedAt ? new Date(fetchedAt).getTime() : 0;
  const cacheAgeMs = timestamp > 0 ? Math.max(0, now - timestamp) : null;
  const expiresAt = timestamp > 0 ? new Date(timestamp + ttlMs).toISOString() : null;
  const stale = cacheAgeMs === null || cacheAgeMs >= ttlMs;
  return {
    fetchedAt,
    cacheAgeMs,
    expiresAt,
    stale,
    staleReason: stale
      ? (fetchedAt ? '这是上次手动同步的数据，本工具不会自动联网更新。' : '服务端未返回抓取时间。')
      : null,
    ...extra,
  };
};

/**
 * 回源闸门：决定「这一次要不要真的去打米游社」，并对真实请求做最小间隔限流。
 *
 * 每个进程一个实例就够（服务是单机的，状态只在本进程内活）。`createApp` 里建一个
 * 挂在闭包里，测试里可以 `minIntervalMs: 0` 关掉限流。
 *
 * @param {{ minIntervalMs?: number }} [options]
 */
export const createRefetchGate = (options = {}) => {
  const minIntervalMs = Number.isFinite(options.minIntervalMs)
    ? Math.max(0, options.minIntervalMs)
    : MIN_REFETCH_INTERVAL_MS;
  /** @type {Map<string, number>} key → 上一次**真实请求**发起的时间戳 */
  const attempts = new Map();

  return {
    minIntervalMs,

    /**
     * @param {string} key 资源标识（建议 `${accountId}/${uid}/${kind}`）
     * @param {{ cached?: any, force?: boolean, now?: number }} input
     * @returns {{ refetch: boolean, reason: 'cached'|'throttled'|'no-cache'|'forced',
     *            throttled: boolean, retryAfterMs: number }}
     */
    decide(key, { cached = null, force = false, now = Date.now() } = {}) {
      // 1) 有本地数据 + 不是显式刷新 → 读本地，永不联网（本次改动的核心）。
      if (cached && !force) {
        return { refetch: false, reason: 'cached', throttled: false, retryAfterMs: 0 };
      }
      // 2) 真的要联网，但距上一次真实请求太近 → 限流，返回本地那份。
      const last = attempts.get(key) || 0;
      const elapsed = now - last;
      if (last > 0 && elapsed < minIntervalMs) {
        return {
          refetch: false,
          reason: 'throttled',
          throttled: true,
          retryAfterMs: Math.max(0, minIntervalMs - elapsed),
        };
      }
      // 3) 放行，并**顺手记下这次尝试**。
      //    记在「决定联网」的这一刻而不是「请求成功」的之后：请求失败时同样消耗了
      //    一次配额，风控不会因为我们失败就少算一次。
      attempts.set(key, now);
      return {
        refetch: true,
        reason: cached ? 'forced' : 'no-cache',
        throttled: false,
        retryAfterMs: 0,
      };
    },

    /** 测试与诊断用：当前记录到的尝试时间点。 */
    attempts: () => Object.fromEntries(attempts),

    /** 清掉记录（测试之间隔离用）。 */
    reset: (key) => { if (key === undefined) attempts.clear(); else attempts.delete(key); },
  };
};