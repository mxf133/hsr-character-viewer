// 数据集**分不清**的多形态角色 → 权威头像 id（以及派生图标地址的工具）。
//
// 为什么单独一个模块：这份修正表以前只长在 `virtual-accounts.js` 里，于是
// **只有虚拟账号的快照**用上它 —— 「选择程序图标」的选择器、虚拟账号角色编辑器、
// 抽卡推荐页的角色头像走的都是另外三份各自为政的「掉括号回退」，四条路一律把
// `March 7th (Preservation)` 指到 `1224.png`（= 巡猎那张图）。用户 2026-10-14 报的
// 「选择程序图标的三月七（存护）的图标错了」就是它。
//
// 现在表只有这一份，`archive.js`（i18n 图标表加载期）与 `virtual-accounts.js`
// （快照构造期）都从这里取 —— 前者一次修正，上面那四条路全部跟着对。
//
// ## 为什么数据集本身分不出来
//
// `i18n.charactersById` 把**两个 id 都写成同一个名字**：实测
// `1001 → {en:'March 7th', cn:'三月七'}`、`1224 → {en:'March 7th', cn:'三月七'}`，
// **没有命途信息**；`tools/herta-i18n.mjs` 又是按 `name` 收口的
// （`Object.fromEntries(...map((c) => [c.name, ...]))`），后一条把前一条覆盖掉 ——
// 于是 `i18n-zh.json` 的 `icons.characters` 里只剩一条 `March 7th → 1224.png`。
// 而 `refs.characters` / `availability.characters` 用的是**带命途的键**
// （`March 7th (Preservation)` / `March 7th (Hunt)`），两边对不上。
//
// ## 依据（实测，不是猜的）
//
//   * StarRailRes `index_min/en/characters.json`：`1001` = `March 7th` / path **Knight**
//     / rarity 4 → 即**存护**；`1224` = `March 7th` / path **Rogue** / rarity 4 → 即**巡猎**；
//   * 与 `theherta/character_paths.json` 一致（`March 7th (Preservation): "Knight"`、
//     `March 7th (Hunt): "Rogue"`）；
//   * 两张图标 `icon/character/1001.png` 与 `1224.png` 都请求得到（200）。

/** `{ 数据集角色英文键: 权威头像 id }`——只列数据集自己分不出来的那些。 */
export const CHARACTER_ID_OVERRIDES = Object.freeze({
  'March 7th (Preservation)': 1001,
  'March 7th (Hunt)': 1224,
});

/**
 * 把一条图标地址里的**文件名 id** 换成目标的
 * （`/icons/.../<id>.png?fallback=<cdn .../<id>.png>`）。
 *
 * ⚠️ 正则必须带 `g`：`fallback` 那一段里**也有同一个文件名**，只换第一处的话，
 * 本地没镜像时 `/icons` 会 302 回**原来那个 id**（开拓者就会永远显示 8010 = 女主·欢愉）。
 */
export const iconWithId = (raw, id) => (raw ? String(raw).replace(/(\d+)\.png/g, `${id}.png`) : null);

/**
 * 去掉尾巴上的形态括号（`March 7th (Preservation)` → `March 7th`）。
 * 与三份前端实现（`app.js` 的 `iconUrlOf`、`virtual-roster.js` 的 `baseFormKeyOf`、
 * `advice-view.js` 的 `iconUrlOf`）以及 `conclusion.js` 的 `baseFormKeyOf` 同口径。
 */
export const baseFormKeyOf = (key) =>
  String(key ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();

/**
 * 把上面那张表**补成图标表里的显式键**（就地改 `table` 并返回它）。
 *
 * 补完之后 `table['March 7th (Preservation)']` 就是一个正确的 `/icons/.../1001.png`
 * 地址，于是所有「先查原名、查不到才掉括号」的兜底**第一跳就命中**，四条路自动一致 ——
 * 不需要改动任何一份前端兜底函数（改它们才是四份要同步的地狱）。
 *
 * ⚠️ 已有同名键时**不覆盖**：数据里哪天真的生成了 `March 7th (Preservation)` 这一条，
 *    以数据为准，这张表只当补丁。
 */
export const applyCharacterIdOverrides = (table) => {
  if (!table || typeof table !== 'object') return table;
  for (const [key, id] of Object.entries(CHARACTER_ID_OVERRIDES)) {
    if (table[key]) continue;
    const raw = table[baseFormKeyOf(key)];
    if (raw) table[key] = iconWithId(raw, id);
  }
  return table;
};
