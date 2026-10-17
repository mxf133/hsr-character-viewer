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
 * 这一行是否命中搜索词（`query` 必须是 `queryOf()` 的结果）。
 *
 * 子串匹配（`includes`）而不是前缀匹配：用户常常只记得名字的中间一段
 * （「流萤」「Firefly」「专锥」），前缀匹配会让「我记得后半截」的使用者搜不到。
 */
export const matchesQuery = (text, query) => !query || String(text ?? '').includes(query);

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
