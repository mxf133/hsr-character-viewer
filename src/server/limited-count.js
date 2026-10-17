// 「这个账号有几个**限定**角色 / 几把**限定**光锥」+ 它们的**总成本**。
//
// 用户 2026-10-18：「要显示账号或虚拟账号的**限定角色、限定光锥的数量**」；
// 同轮追加「还需要显示总成本，包含所有限定角色+星魂+光锥，也包含隐金成本」。
//
// ## 总成本（原始，不减隐金）
//
//   限定角色 = 本体 1 金 + 星魂级数（E0=1 … E6=7）
//   限定光锥 = 本体 1 金 × 叠影（S1=1 … S5=5）
//   总成本 = 两者之和（与 advice.js 的 packGoldOf 同口径：E6S5 = 12 金）。
//
// ⚠️ 用户明确选「原始总成本（不减隐金）」：受赠 / 兑换角色与光锥（那些隐金单位）**也按
//   全价算**，不套隐金减免。因为隐金减免的口径是**队伍级**的（「自选其一」「成对」那几条
//   规则只在四人队伍里有意义），账号级、不组队的总成本没法合理套用；如实按全价算最稳。
//
// ## 口径只有一个来源
//
// 谁是限定，只认 `theherta/unit-availability.json` 的 `limited` 标记
// （`tools/herta-availability.mjs` 按官方跃迁记录人工维护；本仓库的成本口径
// `charCostOf` / `coneCostOf` 也用它 —— 不在这里再造一份名单）。
// 实测：限定角色 = 58（全部 5★ 限定），限定光锥 = 58（全部 5★ 限定锥）；
// 常驻 5★（白露/布洛妮娅/克拉拉/杰帕德/姬子/瓦尔特/彦卿）、4★、常驻锥一律不算。
//
// ## 两类账号能数到的**范围不一样**（界面上必须照实写）
//
//   * 虚拟账号：角色名单与光锥名单都是本机构造的**完整**名单
//     （`account.virtualRoster`），数出来就是准数 → `charactersScope/conesScope = 'owned'`。
//   * 真实账号：米游社只给**快照里那些角色**（`avatar/info` 的名单）和他们**身上装备的**
//     光锥 —— 没有「光锥仓库」这种接口（`equip` 是唯一的光锥来源）。
//     所以角色是「这一刻能看到的那些」、光锥是「已装备的那些」，都可能**低于真实库存**
//     → scope 为 `'visible'` / `'equipped'`，界面写「（可见）」并在 tooltip 里说明。
//
// ⚠️ 认不出英文键的角色/光锥**不计入**（宁可少数一个，也不把常驻算成限定）；
//   调用方可以从 `unknown` 看出有多少条没对上 —— 数据集缺角色时那是唯一线索。
import { FORM_AVATAR_ID } from './character-debut.js';

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** `{ 键: true }` —— 只保留 `limited === true` 的那些。 */
const limitedSetOf = (table) => {
  const out = new Set();
  for (const [key, info] of Object.entries(table || {})) {
    if (info?.limited === true) out.add(key);
  }
  return out;
};

/**
 * 角色 `avatar_id → 数据集英文键`。
 *
 * 单形态角色靠 `i18n.charactersById`（id → 英文名，正好是数据集键）；
 * 多形态的 7 个（三月七 ×2、开拓者 ×5）要过一道 `FORM_AVATAR_ID` ——
 * `charactersById` 里 1001 / 8001 这些 id 的英文名是**不带命途**的
 * （`March 7th` / `{NICKNAME}`），与 `unit-availability.json` 的键对不上。
 * 开拓者偶数 id（女主）与奇数（男主）是同一形态，所以 `+1` 也对到同一个键。
 */
const charKeyByIdOf = (i18n) => {
  const map = new Map();
  for (const [id, v] of Object.entries(i18n?.charactersById || {})) {
    if (!v?.en) continue;
    const key = num(id);
    if (key !== null) map.set(key, v.en);
  }
  for (const [key, rawId] of Object.entries(FORM_AVATAR_ID)) {
    const id = num(rawId);
    if (id === null) continue;
    map.set(id, key);
    if (id >= 8001 && id <= 8010) map.set(id + 1, key);
  }
  return map;
};

/** `中文名 → 英文键`（快照里只有中文名时用）。 */
const keyByCnOf = (table, skip) => {
  const map = new Map();
  for (const [key, cn] of Object.entries(table || {})) {
    if (!cn || skip?.has(cn) || map.has(cn)) continue;
    map.set(cn, key);
  }
  return map;
};

/**
 * 光锥 `id → 英文键`：图标表里每把锥的地址都带数字 id（`.../light_cone/23001.png`），
 * 而快照的 `equip.id` 就是同一个 id —— 比按中文名对更稳（译名会改，id 不会）。
 */
const coneKeyByIdOf = (icons) => {
  const map = new Map();
  for (const [key, url] of Object.entries(icons?.lightCones || {})) {
    const hit = /\/(\d+)\.png/.exec(String(url || '').split('?')[0]);
    if (hit) map.set(Number(hit[1]), key);
  }
  return map;
};

/**
 * 统计限定数量。
 *
 * @param {object} options
 * @param {object} options.snapshot      角色快照（`characters[].id/name/equip`）
 * @param {string[]|null} options.ownedCones 虚拟账号的**持有光锥**（数据集英文键）；
 *        给了就按它数（准数），没给就按「已装备」数
 * @param {object} options.availability  `unit-availability.json` 的 `refs.availability`
 * @param {object} options.i18n          `i18n-zh.json`（角色 id / 光锥 id / 中文名对照）
 * @returns {{characters:number, cones:number, charactersScope:string, conesScope:string,
 *            unknown:{characters:number, cones:number}}|null}
 */
export const limitedCountOf = (options = {}) => {
  const {
    snapshot, ownedCones = null, ownedConeRanks = null, availability = {}, i18n = {},
  } = options;
  if (!snapshot || typeof snapshot !== 'object') return null;
  const limitedChars = limitedSetOf(availability.characters);
  const limitedCones = limitedSetOf(availability.lightCones);
  if (!limitedChars.size && !limitedCones.size) return null;

  const charById = charKeyByIdOf(i18n);
  const charByCn = keyByCnOf(i18n.characters, new Set(['开拓者']));
  const coneById = coneKeyByIdOf(i18n.icons);
  const coneByCn = keyByCnOf(i18n.lightCones);

  const rows = Array.isArray(snapshot.characters) ? snapshot.characters : [];
  const chars = new Set();
  const cones = new Set();
  const unknown = { characters: 0, cones: 0 };
  // 总成本（原始，不减隐金）：限定角色 = 本体 1 + 星魂；限定光锥 = 本体 1 × 叠影（S1=1 … S5=5）。
  // 与 advice.js 的 packGoldOf 同口径（E6 = 7 金、S5 = 5 金、E6S5 = 12 金）。
  let charCost = 0;
  let coneCost = 0;

  for (const row of rows) {
    const id = num(row?.id ?? row?.avatar_id ?? row?.avatarId);
    const key = (id !== null ? charById.get(id) : null)
      || charByCn.get(String(row?.name ?? '').trim())
      || null;
    if (!key) { unknown.characters += 1; continue; }
    if (!limitedChars.has(key)) continue;
    chars.add(key);
    const eidolon = Math.max(0, Math.min(6, num(row?.rank ?? row?.actived_constellation_num) ?? 0));
    charCost += 1 + eidolon;
  }

  if (Array.isArray(ownedCones)) {
    // 虚拟账号：名单就是库存（成本 0 的锥也算持有，按键查 limited）。
    for (const key of ownedCones) {
      if (!limitedCones.has(key)) continue;
      cones.add(key);
      const superimp = Math.max(1, num(ownedConeRanks?.[key]) ?? 1);
      coneCost += superimp;
    }
  } else {
    for (const row of rows) {
      const equip = row?.equip || row?.light_cone || row?.lightCone || null;
      if (!equip) continue;
      const id = num(equip?.id ?? equip?.item_id ?? equip?.itemId);
      const key = (id !== null ? coneById.get(id) : null)
        || coneByCn.get(String(equip?.name ?? '').trim())
        || null;
      if (!key) { unknown.cones += 1; continue; }
      if (!limitedCones.has(key)) continue;
      cones.add(key);
      const superimp = Math.max(1, num(equip?.rank ?? equip?.rank_level) ?? 1);
      coneCost += superimp;
    }
  }

  return {
    characters: chars.size,
    cones: cones.size,
    // 虚拟账号是完整名单；真实账号只有快照里能看到的那些。
    charactersScope: Array.isArray(ownedCones) || snapshot.source === 'virtual' ? 'owned' : 'visible',
    conesScope: Array.isArray(ownedCones) || snapshot.source === 'virtual' ? 'owned' : 'equipped',
    cost: { characters: charCost, cones: coneCost, total: charCost + coneCost },
    unknown,
  };
};
