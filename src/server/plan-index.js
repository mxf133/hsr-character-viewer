/**
 * 抽卡方案的**服务端全量索引**：整池缓存 / 全量搜索 / 分页切片。
 *
 * 为什么要有这一层（2026-10-20，用户第 1~3 条）：
 *
 *   改之前 `POST /api/archive/plan` 一次只回**前 20 行**（`maxRows` 默认 20，上限 200），
 *   搜索与分页全在浏览器里对那 20 行做 —— 于是「搜得到」= 「它恰好在前 20 名」。
 *   实测真实数据集 1066 条投稿 → 936 套整包 → **267 个角色组合**，用户只能看到 20 个，
 *   搜一个排在 41 名的角色一条都搜不到。
 *
 *   设计文档 `docs/抽卡推荐重构设计.md` §4.4 / §8 早就定了口径：
 *   **服务端算全量 + 索引，前端只收当前页**。这一份就是那个「索引」。
 *
 * 三层分工（改之前先看清，别把便宜的一层搬到贵的一层上去）：
 *
 *   1. `buildPlanPool()`（`gacha-plan.js`）—— 聚合 / 排序 / 折叠。整池，按输入签名缓存。
 *   2. **本模块** —— 给整池建**词元倒排**、按关键词筛出命中行号、按页切片。
 *      全是纯函数与一个 LRU，**不碰文件、不碰 i18n**（中文名由调用方以 `nameOf` 传进来）。
 *   3. `materializePlanRow()`（`gacha-plan.js`）—— 只给当前这一页算补金明细 / 次选。
 *
 * ⚠️ **搜索是多关键词 AND，不是 OR**（用户 2026-10-18），切词规则必须与前端
 *    `advice-paging.js` 的 `queryTermsOf()` **同一份实现** —— 所以这里直接 import 它，
 *    不抄第二份。抄一份的下场是两个搜索框对同一个词给出不同结果。
 *
 * ⚠️ **命中分两类**：「本队命中」（四个位置 / 光锥里有这个词）与「次选命中」（本队没有，
 *    但卡片上那 3 支次选配队里有）。后者在界面上有单独标记 —— 照抄那支队用不上这个词。
 *    两类都算「搜到」，只有本队命中进 `ownCount`。
 */

import { clampPage, pageCountOf, queryTermsOf } from '../../public/scripts/advice-paging.js';
import { alternativesOf } from './gacha-plan.js';

/** 一页 20 条（与界面「每页 20 个配队」一致，用户 2026-10-18）。 */
export const PLAN_PAGE_SIZE = 20;

/**
 * 页大小上限。
 *
 * 为什么还要有上限：`pageSize` 是外部输入，不夹的话一次 `pageSize=100000` 就会把整池
 * 物化一遍（每行都要算隐金 + 补金清单 + 次选），那是唯一能把服务端拖死的输入。
 * 200 = 一屏能滚到的极限量级；真要更多就翻页。
 */
export const PLAN_PAGE_SIZE_MAX = 200;

/** 整池缓存最多留几个「输入签名」（设计文档 §8：建议 8 个）。 */
export const PLAN_INDEX_CACHE_LIMIT = 8;

/**
 * 整池缓存的总行长预算。
 *
 * ⚠️ 光按「条目数」限不住内存：真实数据集一档只有 ~1000 行（几 MB），但压测那档
 * 10 万行一档就几十 MB，8 档 = 几百 MB。所以同时按**总行数**淘汰 —— 大池子进来时
 * 先把老的小池子挤出去，但**永远至少留一档**（否则刚算完就自己把自己淘汰了）。
 */
export const PLAN_INDEX_ROW_BUDGET = 140000;

/**
 * 「次选」索引的规模上限（超过就不建次选索引，搜索只认本队四个位置）。
 *
 * 为什么要上限：次选是**逐行现算**的（`alternativesOf` 每行要扫四个成员的倒排桶，
 * 每桶最多 400 条）。实测 **0.24 ms/行**（`tools/_probe-plan-page-perf.mjs`）：
 *   绝境 267 行 → 31 ms（第一次搜索付一次）
 *   混沌 1242 行 → ~300 ms
 * 阈值 1500 行 ⇒ 最坏一次性开销约 360 ms。再大就不建（`query.altSearch = false`，
 * 界面如实说「本次只匹配本队四个位置」），因为那时用户要的是「搜得到」，
 * 不是「连相近队伍一起搜出来」。
 */
export const PLAN_ALT_INDEX_MAX_LINEUPS = 1500;

/**
 * FNV-1a（32 位）→ base36 短串。
 *
 * 用途只有一个：把「账号持有 + 三套权重 + 隐金开关」压成一个短 cache key。
 * **不是**安全哈希，也不参与任何评分 —— 碰撞的后果是「命中别人的池子」，
 * 所以 key 里同时带上了账号规模（见 `gacha-plan-run.js` 的 `planSignatureOf`）。
 */
export const hashOf = (text) => {
  let hash = 0x811c9dc5;
  const source = String(text ?? '');
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

/**
 * 一个按 LRU 淘汰的「签名 → 整池」缓存。
 *
 * @param {{limit?:number, rowBudget?:number}} [options]
 */
export const createPlanCache = (options = {}) => {
  const limit = Math.max(1, Number(options.limit) || PLAN_INDEX_CACHE_LIMIT);
  const rowBudget = Math.max(1, Number(options.rowBudget) || PLAN_INDEX_ROW_BUDGET);
  const entries = new Map();      // key → { value, rows }；Map 的插入顺序 = LRU 顺序
  let rows = 0;

  const drop = (key) => {
    const hit = entries.get(key);
    if (!hit) return;
    entries.delete(key);
    rows -= hit.rows;
  };

  return {
    get: (key) => {
      const hit = entries.get(key);
      if (!hit) return null;
      // 触碰即「变新」：删了重插，队尾 = 最近使用。
      entries.delete(key);
      entries.set(key, hit);
      return hit.value;
    },
    set: (key, value, rowCount = 0) => {
      drop(key);
      const size = Math.max(0, Number(rowCount) || 0);
      entries.set(key, { value, rows: size });
      rows += size;
      while (entries.size > limit) drop(entries.keys().next().value);
      while (rows > rowBudget && entries.size > 1) drop(entries.keys().next().value);
      return value;
    },
    has: (key) => entries.has(key),
    delete: (key) => drop(key),
    clear: () => { entries.clear(); rows = 0; },
    get size() { return entries.size; },
    get rows() { return rows; },
  };
};

// ------------------------------------------------------------------ 词元倒排

/**
 * 一行方案的**可搜索词元**：四个位置的角色名 + 光锥名（英文键与中文名都进），
 * 以及**折叠进来的其它配装**用到的角色 / 光锥。
 *
 * ⚠️ 为什么把 `variants` 也算上：卡片上「其它配装」那一栏确实印着那些光锥，
 *    用户照着一张卡片找「用某把专锥的配队」时，那张卡片就该被搜到。
 *    （改之前前端只搜代表行，所以「换个光锥能省几金」的那几条其实搜不到。）
 * ⚠️ 词元之间**不加分隔符地拼接**是错的（`流萤Firefly` 里搜「萤F」会假命中）——
 *    所以这里是一串**独立的**词元，匹配时逐个 `includes`，语义等价于「以空格拼接」。
 */
export const planTokensOf = (row, nameOf = () => null) => {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    if (typeof value !== 'string') return;
    const token = value.trim().toLowerCase();
    if (!token || seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };
  const addMember = (member) => {
    if (!member) return;
    push(member.char);
    push(nameOf('char', member.char));
    push(member.lc);
    push(nameOf('cone', member.lc));
  };
  for (const member of row.members || []) addMember(member);
  for (const variant of row.variants || []) {
    for (const member of variant.members || []) addMember(member);
  }
  return out;
};

/**
 * 每行的「次选可搜索词元」—— **就是卡片上那几支次选配队**的成员词元。
 *
 * ⚠️ 必须与 `alternativesOf()` 的实际输出一致（同一函数、同一份 `byMember` 与名次表）。
 *    2026-10-20 第一版图省事，用了「与本队共享 ≥2 个成员的邻队」这个更宽的定义 ——
 *    实测搜「砂金」得 176 条命中，其中 162 条卡片上印的次选里**根本没有砂金**，
 *    而徽章却写着「次选命中」。那是假话，所以改成真算一遍次选。
 * ⚠️ 语义与改之前的前端一致：把该行**全部**次选配队的成员拼起来搜（AND 也落在这一串上），
 *    所以「A 词在本队、B 词在次选」也会命中 —— 那支队确实得换人才能同时用上这两个。
 */
export const altTokensOf = (index) => {
  if (index.altTokens !== undefined) return index.altTokens;
  if (index.lineups.length > PLAN_ALT_INDEX_MAX_LINEUPS) {
    index.altTokens = null;
    return null;
  }
  const limit = Number(index.maxAlternatives) || 3;
  index.altTokens = index.lineups.map((row) => {
    const alternatives = alternativesOf(row, index.pool, index.rankOf, index.byMember, limit);
    const tokens = [];
    const seen = new Set();
    const push = (value) => {
      if (typeof value !== 'string') return;
      const token = value.trim().toLowerCase();
      if (!token || seen.has(token)) return;
      seen.add(token);
      tokens.push(token);
    };
    for (const alt of alternatives) {
      for (const member of alt.members || []) {
        push(member.char);
        push(index.nameOf('char', member.char));
        push(member.lc);
        push(index.nameOf('cone', member.lc));
      }
    }
    return tokens;
  });
  return index.altTokens;
};

/**
 * 建（或复用）词元倒排：`词元 → 行号数组`。
 *
 * 为什么用倒排而不是「每行拼一个大字符串再 `includes`」：
 *   10 万行 × 8 个词元 = 80 万次 `includes`（每次平均扫几十个字符）≈ 几十 ms，
 *   而倒排只有 ~2000 个**不同**词元（角色 + 光锥 × 中英名），先筛词元再做集合取并，
 *   命中通常落在 1~3 个词元上 —— 实测从 40 ms 降到 2 ms 量级。
 *
 * 懒建：不搜索的用户（只翻页）永远不付这一趟。建一次挂在索引上，随整池缓存一起失效。
 *
 * @param {'own'|'alt'} which `own` = 本队四个位置（含折叠进来的其它配装）；
 *                             `alt` = 卡片上的次选配队（超限时返回 null）
 */
export const tokenIndexOf = (index, which = 'own') => {
  const slot = which === 'alt' ? 'altTokenIndex' : 'tokenIndex';
  if (index[slot]) return index[slot];
  const rowsOf = which === 'alt'
    ? altTokensOf(index)
    : index.lineups.map((row) => planTokensOf(row, index.nameOf));
  if (!rowsOf) return null;
  const map = new Map();
  rowsOf.forEach((tokens, i) => {
    for (const token of tokens) {
      const bucket = map.get(token);
      if (bucket) bucket.push(i); else map.set(token, [i]);
    }
  });
  index[slot] = { map, tokens: [...map.keys()] };
  return index[slot];
};

/** 一个关键词在某一层（本队 / 次选）的命中标志位：所有**包含该词**的词元下的行取并集。 */
const flagsOf = (tokens, size, term) => {
  const flags = new Uint8Array(size);
  for (const token of tokens.tokens) {
    if (!token.includes(term)) continue;
    for (const i of tokens.map.get(token)) flags[i] = 1;
  }
  return flags;
};

/**
 * 在整池里搜一遍，返回**按名次升序**的行号。
 *
 * 语义（与改之前前端那套逐字一致，只是搬到了服务端）：
 *   命中 = （每个词都出现在本队）**或**（每个词都出现在它的次选配队里）。
 *   逐个词取「本队命中 ∪ 次选命中」再交集是**错的** —— 那会出现「A 词在本队、
 *   B 词在另一支次选里」的假命中（没有一支队伍同时含 A 和 B）。
 *
 * @returns {{terms:string[], ids:number[], altOnlyIds:number[], ownCount:number,
 *            altOnly:number, altSearch:boolean}}
 */
export const searchPlanIndex = (index, rawQuery) => {
  const terms = queryTermsOf(rawQuery);
  const size = index.lineups.length;
  if (!terms.length) {
    // 不搜索 = 整池按名次。这份「0..N-1」是**静态**的，挂在索引上复用（10 万行的
    // 数组每次请求都新建一遍是白扔内存）。
    if (!index.allIds) {
      index.allIds = new Array(size);
      for (let i = 0; i < size; i += 1) index.allIds[i] = i;
    }
    return {
      terms, ids: index.allIds, altOnlyIds: [], ownCount: size, altOnly: 0, altSearch: true,
    };
  }

  // 同一个词翻页时不必重算（「搜『流萤』再看第 2 页」是最常见的连续操作）。
  const cacheKey = terms.join('\u0000');
  if (index.lastQuery?.key === cacheKey) return index.lastQuery.result;

  const ownIndex = tokenIndexOf(index, 'own');
  const altIndex = tokenIndexOf(index, 'alt');
  const own = terms.map((term) => flagsOf(ownIndex, size, term));
  const alt = altIndex
    ? terms.map((term) => flagsOf(altIndex, size, term))
    : terms.map(() => new Uint8Array(size));

  const ids = [];
  const altOnlyIds = [];
  for (let i = 0; i < size; i += 1) {
    let ownAll = true;
    let altAll = altIndex !== null;
    for (let k = 0; k < terms.length; k += 1) {
      if (!own[k][i]) ownAll = false;
      if (altIndex && !alt[k][i]) altAll = false;
      if (!ownAll && !altAll) break;
    }
    if (ownAll) ids.push(i);
    else if (altAll) { ids.push(i); altOnlyIds.push(i); }
  }
  const result = {
    terms,
    ids,
    altOnlyIds,
    ownCount: ids.length - altOnlyIds.length,
    altOnly: altOnlyIds.length,
    altSearch: altIndex !== null,
  };
  // 只留最近一次（多关键词 + 整池时一份 ids 可能是几万个 int，留多了白占内存）。
  index.lastQuery = { key: cacheKey, result };
  return result;
};

/**
 * 按页切一段。
 *
 * ⚠️ 页码**必须夹**：搜索把结果从 267 条缩到 3 条时，用户可能还停在第 12 页 ——
 *    不夹的话返回空页，看起来像「搜索结果没了」。
 */
export const planPageOf = (ids, page, pageSize = PLAN_PAGE_SIZE) => {
  const size = Math.max(1, Math.min(
    Math.floor(Number(pageSize) || PLAN_PAGE_SIZE),
    PLAN_PAGE_SIZE_MAX,
  ));
  const total = Array.isArray(ids) ? ids.length : 0;
  const pages = pageCountOf(total, size);
  const current = clampPage(page, pages);
  const start = (current - 1) * size;
  return {
    ids: (ids || []).slice(start, start + size),
    start,
    page: current,
    pages,
    total,
    pageSize: size,
  };
};
