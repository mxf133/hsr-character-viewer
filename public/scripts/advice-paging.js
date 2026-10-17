/**
 * 抽卡推荐页的**搜索 / 分页**纯逻辑（2026-10-18，用户第 1、2 条）。
 *
 * 为什么单独一个模块：这两件事都是「展示层」的算术 —— 搜索匹配一串名字、把一列行
 * 按页切开、算出翻页条上要显示哪些页码。它们**不碰 DOM、不碰评分**，所以从
 * `advice-view.js` 里抽出来的唯一目的就是**能被 Node 直接测**（`tools/paging-test.mjs`）。
 * 留在视图里的话，要验「284 条是不是 15 页、最后一页 4 条」就得起真浏览器 —— 而本机
 * 沙箱连服务都起不来（DPAPI 要 spawn PowerShell），那条路验不了。
 *
 * ⚠️ 这里**不许**出现任何 DOM / i18n / 评分口径：名字已经由调用方用 `cn()` / `cnCone()`
 *    解析好再传进来（视图那边是唯一的中文名来源）。
 */

/**
 * 搜索词归一化：去掉首尾空格、转小写。
 *
 * 中文没有大小写，但**英文键**（`Firefly` / `firefly`）与半角全角空格混着敲很常见，
 * 所以统一到小写再比。空串（或只有空格）= 不过滤。
 */
export const queryOf = (value) => String(value ?? '').trim().toLowerCase();

/**
 * 拼一份「可搜索文本」：中文名与英文键**都进**，用空格隔开。
 *
 * ⚠️ 用空格而不是直接连起来：连起来会让「流萤」的「萤」与下一个名字的首字拼成一个
 *    假子串（"流萤Firefly" 里搜 "萤F" 会命中）。空格保证每个名字自己是一段。
 */
export const searchTextOf = (names) => (Array.isArray(names) ? names : [names])
  .filter((name) => typeof name === 'string' && name.length > 0)
  .join(' ')
  .toLowerCase();

/**
 * 这一行是否命中搜索词。
 *
 * 子串匹配（`includes`）而不是前缀匹配：用户常常只记得名字的中间一段
 * （「流萤」「Firefly」「专锥」），前缀匹配会让「我记得后半截」的使用者搜不到。
 *
 * ⚠️ **多关键词 = AND**（用户 2026-10-18：「搜索框应当支持多个关键词或者多个角色/光锥
 *    的搜索，给出**同时包含**这些词的搜索结果」）。`query` 传数组或带分隔符的字符串
 *    都行，逐个 term 都命中才算命中（`every`）。
 *    为什么是 AND 而不是 OR：「流萤 银狼」要的是「**这两个都有**的队伍」，OR 会把
 *    「只有流萤」和「只有银狼」全倒出来，等于没筛。
 *    传字符串时按 `queryTermsOf()` 拆 —— 中文里没有词边界，只能靠分隔符。
 */
export const matchesQuery = (text, query) => {
  const terms = Array.isArray(query) ? query.filter(Boolean) : queryTermsOf(query);
  if (!terms.length) return true;
  const hay = String(text ?? '');
  return terms.every((term) => hay.includes(term));
};

/**
 * 把输入框那一串拆成**若干个关键词**（用户 2026-10-18 的多关键词搜索）。
 *
 * 分隔符取「空白 + 中英文逗号 + 顿号 + 加号 + 竖线」：`流萤 银狼`、`流萤,银狼`、
 * `流萤，银狼`、`流萤+银狼`、`流萤|银狼` 都认。中文输入法下用户最常敲的是**空格**
 * （选字候选之间就是空格），所以空格必须是最主要的分隔符。
 *
 * ⚠️ 每个 term 各自 `toLowerCase()`，所以「Firefly 银狼」与「firefly 银狼」等价。
 * ⚠️ 连续分隔符产生空段，全部丢掉（`  流萤  ` → `['流萤']`），空数组 = 不过滤。
 */
export const queryTermsOf = (value) => String(value ?? '')
  .toLowerCase()
  .split(/[\s,，、+|]+/)
  .filter(Boolean);

/** 总页数。**至少 1 页**：结果为空时翻页条也要能算出「第 1/1 页」，而不是 0。 */
export const pageCountOf = (total, pageSize) => {
  const size = Math.max(1, Math.floor(Number(pageSize) || 1));
  const count = Math.max(0, Math.floor(Number(total) || 0));
  return Math.max(1, Math.ceil(count / size));
};

/**
 * 把页码夹回合法区间。
 *
 * ⚠️ 必须夹：搜索把结果从 284 条缩到 3 条时，用户可能还停在**第 12 页** ——
 *    不夹的话页面会停在一个空页上，看起来像「搜索结果没了」。
 */
export const clampPage = (page, pages) => {
  const max = Math.max(1, Math.floor(Number(pages) || 1));
  return Math.min(Math.max(1, Math.floor(Number(page) || 1)), max);
};

/**
 * 翻页条上要显示的页码：**首末页 + 当前页左右各 2 页**，跳过的段用 `'…'` 占位。
 *
 * 为什么窗口化：候选池会随数据长大（实测 284 支 = 15 页），全列出来排在两行之后就
 * 变成一排挤在一起的小方块；窗口化后翻页条**最多 9 个格子**，宽度不随池子变。
 *
 * @returns {Array<number|'…'>}
 */
export const pageWindowOf = (page, pages) => {
  const max = Math.max(1, Math.floor(Number(pages) || 1));
  const current = clampPage(page, max);
  const wanted = new Set([1, max]);
  for (let p = current - 2; p <= current + 2; p += 1) {
    if (p >= 1 && p <= max) wanted.add(p);
  }
  const out = [];
  let prev = 0;
  for (const p of [...wanted].sort((a, b) => a - b)) {
    if (prev && p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
};

/**
 * 按页切一段：返回**这一页的行**、这一页第一行的**全局序号**（0 起）、以及页码与总页数。
 *
 * ⚠️ 序号必须是**全局**的：卡片左上角印 `#12` 指的是「在整份方案里第 12 名」，
 *    不是「本页第 12 张」（一页只有 20 张，页内序号永远 ≤ 20，会把名次说成假的）。
 */
export const pageSliceOf = (list, page, pageSize) => {
  const rows = Array.isArray(list) ? list : [];
  const size = Math.max(1, Math.floor(Number(pageSize) || 1));
  const pages = pageCountOf(rows.length, size);
  const current = clampPage(page, pages);
  const start = (current - 1) * size;
  return { rows: rows.slice(start, start + size), start, page: current, pages, total: rows.length };
};

/**
 * 给**过滤后**的那一批行标上它在**完整列表**里的真实名次（1 起）。
 *
 * 用户 2026-10-18：「搜索到的结果应当显示其真实的排名，而不是重新开始算」。
 * 改之前搜索完直接拿 `i + 1` 编号，于是搜「千冶」出来第 3 张卡印着 `#3` ——
 * 读起来就是「这个角色在榜上排第 3」，是**假话**（它在完整榜上排第 41）。
 * 搜索是**视图**，名次是**榜的**，两者不该互相污染。
 *
 * @param {Array} source  完整列表（名次按它自己的下标）
 * @param {Array} matched 过滤/分页之后的那些行（通常是 `source` 的子集，顺序不变）
 * @param {(row:any)=>any} [keyOf] 行标识。默认按对象本身 —— 两个列表若引用**同一批对象**
 *                        就够用；万一中间被反序列化过（`JSON.parse` 出来的新对象），
 *                        传一个 `(row) => row.key` / `(row) => row.name` 之类的键函数。
 * @returns {Array<{row:any, rank:number}>} 与 `matched` 同序；`rank` 为 0 = 不在完整列表里
 *                        （理论上不该发生，仍然保留 0 而不是丢弃这一行 —— 少显示一行更难查）
 */
export const withRealRank = (source, matched, keyOf = (row) => row) => {
  const rank = new Map();
  (Array.isArray(source) ? source : []).forEach((row, i) => {
    const key = keyOf(row);
    // 同一 key 只记第一次：完整列表里本来就该唯一，重名以先出现的为准（与页面渲染一致）。
    if (!rank.has(key)) rank.set(key, i + 1);
  });
  return (Array.isArray(matched) ? matched : []).map((row) => ({
    row,
    rank: rank.get(keyOf(row)) || 0,
  }));
};
