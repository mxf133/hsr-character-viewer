// 把玩家自己的队伍丢进黑塔网的榜单里比一比。
//
// 为什么要独立一个模块：榜单池是按「模式 × 关卡」聚合的（近 N 个版本），一次对照
// 可能要查四个副本；而界面那边只能看到当前选中副本的榜。所以这里按需取池、
// 只回传命中的那几行（几百字节），而不是把整个池子发给浏览器。
//
// 匹配口径 — **用官方简中的「基础名」**：
//   记录接口给的是数字 id，我们把它翻成官方简中（遐蝶 / 长夜月 / 知更鸟•晴歌）；
//   黑塔网的阵容是英文名（Castorice / Evernight / Robin • Summeretto），
//   它的中文也是同一份 StarRailRes 表翻出来的。但两边**后缀写法不一定一致**
//   （游戏里 1309 号只有「知更鸟」，黑塔网把皮肤写成「知更鸟•晴歌」），
//   所以统一取 `•`/`·` 之前的部分再比。开拓者同理（开拓者•记忆 → 开拓者）。
import { archiveTeams, loadArchive, loadI18n, zhName } from './archive.js';

/** 「知更鸟•晴歌」→「知更鸟」；「Trailblazer (Remembrance)」→ 中文后再取基础名。 */
export const baseName = (name) => String(name || '').split(/[•·]/)[0].trim();

/** 一个阵容（英文名数组）→ 用于匹配的规范化键。 */
const keyOf = (names) => [...new Set(names.map(baseName).filter(Boolean))]
  .sort().join('|');

/**
 * 把一个副本的阵容池做成 `基础名键 → 汇总` 的索引。
 *
 * 注意同一套阵容在池子里本来就是一行（按 rosterKey 聚合过），但规范化之后
 * 可能有多行并到一起（例如「知更鸟」与「知更鸟•晴歌」是同一行里的不同写法）。
 * 合并时按投稿数加权，`count` 相加。
 */
const indexPool = async (mode, stage, window, i18n) => {
  const pool = await archiveTeams(mode, { stage, window });
  if (!pool.ok) return null;
  const byKey = new Map();
  for (const team of pool.teams || []) {
    const cnNames = (team.roster || []).map((en) => baseName(zhName(i18n, 'characters', en) || en));
    const key = keyOf(cnNames);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...team, cnNames, count: team.count || 0 });
      continue;
    }
    const total = (prev.count || 0) + (team.count || 0);
    // 按投稿数加权合并平均行动值；其它字段取「更强的那一套」。
    const weighted = (a, b) => ((a ?? 0) * (prev.count || 0) + (b ?? 0) * (team.count || 0)) / (total || 1);
    prev.count = total;
    if (Number.isFinite(team.avgAv)) {
      prev.avgAv = Number(weighted(prev.avgAv, team.avgAv).toFixed(3));
    }
    if (team.perfect > prev.perfect) prev.perfect = team.perfect;
    if (Number.isFinite(team.bestAv) && (!Number.isFinite(prev.bestAv) || team.bestAv < prev.bestAv)) {
      prev.bestAv = team.bestAv;
    }
    prev.tierCounts = prev.tierCounts || team.tierCounts;
  }
  // 排名：同环境下按平均行动值（越小越好），再按满分率。
  const ranked = [...byKey.values()].sort((a, b) => (a.avgAv ?? Infinity) - (b.avgAv ?? Infinity)
    || b.perfect - a.perfect);
  ranked.forEach((row, i) => { row.rankByAv = i + 1; byKey.set(keyOf(row.cnNames), row); });
  return {
    mode: pool.mode,
    stage: pool.stage,
    season: pool.season,
    recentSeasons: pool.recentSeasons,
    totalRosters: ranked.length,
    totalRuns: pool.windowRuns,
    // 本期最强（榜首）供「差距」参照
    top: ranked[0] || null,
    byKey,
  };
};

/**
 * @param {Array<{mode:string, stage?:string, names:string[]}>} items
 * @param {{ window?:number }} [options]
 */
export const compareRosters = async (items, options = {}) => {
  const window = Math.max(1, Math.min(Number(options.window) || 6, 12));
  const i18n = await loadI18n();
  const pools = new Map();
  const poolOf = async (mode, stage) => {
    const cacheKey = `${mode}|${stage}`;
    if (!pools.has(cacheKey)) pools.set(cacheKey, await indexPool(mode, stage, window, i18n));
    return pools.get(cacheKey);
  };

  const results = [];
  for (const item of Array.isArray(items) ? items : []) {
    const mode = item?.mode;
    const stage = item?.stage || '';
    const names = Array.isArray(item?.names) ? item.names : [];
    if (!mode || !names.length) {
      results.push({ found: false, reason: '参数不完整' });
      continue;
    }
    const pool = await poolOf(mode, stage);
    if (!pool) {
      results.push({ found: false, mode, stage, reason: '这个副本没有数据' });
      continue;
    }
    const key = keyOf(names);
    const hit = pool.byKey.get(key);
    const env = {
      mode: pool.mode,
      stage: pool.stage,
      season: pool.season,
      recentSeasons: pool.recentSeasons,
      totalRosters: pool.totalRosters,
      totalRuns: pool.totalRuns,
    };
    if (!hit) {
      results.push({ found: false, env, names, top: pool.top ? {
        rosterCn: pool.top.cnNames, avgAv: pool.top.avgAv, perfect: pool.top.perfect,
      } : null });
      continue;
    }
    results.push({
      found: true,
      env,
      names,
      count: hit.count,
      avgAv: hit.avgAv,
      bestAv: hit.bestAv,
      perfect: Number.isFinite(hit.perfect) ? hit.perfect : null,
      tierCounts: hit.tierCounts || null,
      seasonCount: hit.seasonCount,
      evidence: hit.evidence,
      rankByAv: hit.rankByAv,
      totalRosters: pool.totalRosters,
      // 榜首（同环境平均成绩最好的那套）—— 用来回答「离最强差多少」
      top: pool.top ? { rosterCn: pool.top.cnNames, avgAv: pool.top.avgAv, perfect: pool.top.perfect } : null,
    });
  }

  const archive = await loadArchive();
  return {
    ok: true,
    window,
    minSeasonRuns: archive.minSeasonRuns ?? 20,
    results,
  };
};
