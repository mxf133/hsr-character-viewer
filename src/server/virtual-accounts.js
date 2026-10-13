// 虚拟账号：**预设 + 快照构造**（用户 2026-10-12：「在账号与角色界面新建一个选择，方便用户
// 新建虚拟账号，提供一些选项，这些账号有非常不同的角色池，类似真正的玩家们各种各样的偏好」）。
//
// 为什么放在服务端：界面上的「新建虚拟账号」要落进账号库（`AccountStore`），而账号库里的
// 账号必须带**米游社快照形状**的数据；把这份定义放这里，`tools/make-virtual-accounts.mjs`
// 也直接复用同一份 —— 两处各写一遍迟早会长歪（图标/星级就是这么歪过一次的）。
//
// ⚠️ 三条硬约束（都是实测踩出来的）：
//   ① 角色 / 光锥的 `icon` 必须是 **`/icons/...` 同源路径**或 CDN 地址：数据集图标表里存的就是
//      `/icons/icon/character/<id>.png?fallback=<cdn>`，本地没有该文件时 `/icons` 路由会 **302**
//      到 fallback（见 app.js 那条路由）。⚠️ 前端 `characterCard()` 原来只认 `^https?://`，
//      于是虚拟账号的图标全变成首字占位 —— **那条判断要一起放宽**（同源 `/icons` 也要认）。
//   ② `rarity` 必须给：卡片靠它上色/画星（缺了就默认 4★，看起来「星级显示有误」）。
//   ③ `id` 是**角色 id**（数字）：卡片 `data-char-id` 与抽卡页「点角色 chip 滚过去」都靠它。
//
// 角色名用**中文**（米游社快照就是中文），英文键只用于查数据集（星级 / 图标 / 命途 / id）。
import { existsSync } from 'node:fs';

/**
 * 预设清单。`spec(ctx)` 返回 `{ chars, cones, note }`：
 *   * `chars` = { 数据集英文键: 星魂档 }（0/1/2/6）
 *   * `cones` = { 数据集英文键: 叠影 }（1~5）
 * 写成函数是为了让「老玩家 / 专锥党 / 全图鉴」这些**按数据集现算**，数据集更新不会失效。
 */
export const VIRTUAL_PRESETS = [
  {
    id: 'newbie',
    title: '全新账号（0 限定）',
    hint: '只有免费角色（4★ / 常驻 / 开拓者）。看「从零开始该抽什么」。',
    spec: () => ({ chars: {}, cones: {} }),
  },
  {
    id: 'single-core',
    title: '单核起步（一个限定本体）',
    hint: '只抽到一个限定本体（E0），没有星魂也没有专锥。',
    spec: () => ({ chars: { Castorice: 0 }, cones: {} }),
  },
  {
    id: 'one-true',
    title: '单推厨（一个角色拉到满配）',
    hint: '资源全砸一个角色：E6 + 专锥 S5，其他一概没有。',
    spec: () => ({ chars: { Castorice: 6 }, cones: { 'Make Farewells More Beautiful': 5 } }),
  },
  {
    id: 'dps-duo',
    title: '双核主C（两把专锥）',
    hint: '两个主C各带专锥，辅助全靠免费角色。',
    spec: () => ({
      chars: { Castorice: 0, Phainon: 0 },
      cones: { 'Make Farewells More Beautiful': 1, 'Thus Burns the Dawn': 1 },
    }),
  },
  {
    id: 'support-first',
    title: '辅助优先（同谐 / 虚无党）',
    hint: '先把辅助抽齐（含星魂），主C 还没影。',
    spec: () => ({
      chars: { Cyrene: 2, Cerydra: 1, Sparkle: 2, Sunday: 0 },
      cones: { 'This Love, Forever': 1 },
    }),
  },
  {
    id: 'bai-e',
    title: '白厄队（昔涟 + 刻律德菈 + 花火）',
    hint: '白厄 E2S1 + 昔涟 E2S1 + 花火 E2，刻律德菈停在 E0：只差那一金。',
    spec: () => ({
      chars: { Phainon: 2, Cyrene: 2, Cerydra: 0, Sparkle: 2 },
      cones: { 'Thus Burns the Dawn': 1, 'This Love, Forever': 1 },
    }),
  },
  {
    id: 'dolphin',
    title: '中氪（核心队 E2 + 两把专锥）',
    hint: '主力队成型一半，专锥只有核心那两把。',
    spec: () => ({
      chars: { Castorice: 2, Hyacine: 2, Cyrene: 0, Evernight: 0 },
      cones: { 'Make Farewells More Beautiful': 1, 'To Evernight\'s Stars': 1 },
    }),
  },
  {
    id: 'whale',
    title: '重氪（多个满配主力）',
    hint: '好几支队伍的核心都 E2/E6，专锥也齐。差额很小，看方案改推什么。',
    spec: () => ({
      chars: { Castorice: 6, Cyrene: 2, Hyacine: 2, Evernight: 2, Phainon: 2 },
      cones: {
        'Make Farewells More Beautiful': 1, 'This Love, Forever': 1, 'Thus Burns the Dawn': 1,
      },
    }),
  },
  {
    id: 'cone-collector',
    title: '专锥收集党（角色都 E0）',
    hint: '抽了一堆专锥（S5），角色本体都没升星魂 —— 典型的「歪锥」玩家。',
    spec: (ctx) => ({
      chars: Object.fromEntries(ctx.limitedChars.slice(0, 6).map((c) => [c, 0])),
      cones: Object.fromEntries(ctx.limitedCones.slice(0, 8).map((c) => [c, 5])),
    }),
  },
  {
    id: 'old-guard',
    title: '老玩家偏科（旧角色多、新角色少）',
    hint: '早于 4.0 登场的限定都抽了（E0），近版本的新角色一概没有。',
    spec: (ctx) => ({
      chars: Object.fromEntries(ctx.oldLimited.map((c) => [c, 0])),
      cones: {},
    }),
  },
  {
    id: 'full',
    title: '全图鉴（限定全 E6 + 专锥全 S5）',
    hint: '理论上没有队伍需要补金 —— 方案应当是空的（用来验证「不硬推」）。',
    spec: (ctx) => ({
      chars: Object.fromEntries(ctx.limitedChars.map((c) => [c, 6])),
      cones: Object.fromEntries(ctx.limitedCones.map((c) => [c, 5])),
    }),
  },
];

export const presetById = (id) => VIRTUAL_PRESETS.find((p) => p.id === id) || null;

/** 预设要用到的数据集上下文（与 `advice.js` 的 `charCostOf` / `coneCostOf` 同口径：成本 0 = 免费）。 */
export const presetContext = ({ availability, firstSeen, charCostOf, coneCostOf }) => {
  const chars = Object.keys(availability?.characters || {});
  const cones = Object.keys(availability?.lightCones || {});
  const oldLimited = chars.filter((k) => {
    if (!(charCostOf(k, availability) > 0)) return false;
    const v = String(firstSeen?.[k] ?? '');
    const major = Number(v.split('.')[0]);
    return Number.isFinite(major) && major < 4;
  });
  return {
    limitedChars: chars.filter((k) => charCostOf(k, availability) > 0),
    limitedCones: cones.filter((k) => coneCostOf(k, availability) > 0),
    freeChars: chars.filter((k) => charCostOf(k, availability) === 0),
    freeCones: cones.filter((k) => coneCostOf(k, availability) === 0),
    oldLimited,
  };
};

/**
 * 把一个预设变成**账号库里的 account 对象**（含米游社快照形状）。
 *
 * @param {{preset:object, index:object, i18n:object, availability:object,
 *          charCostOf:Function, coneCostOf:Function, uid:string, nickname?:string,
 *          accountId?:string, nowIso?:string}} options
 */
export const buildVirtualAccount = (options) => {
  const {
    preset, index, i18n, availability, charCostOf, coneCostOf,
    uid, nickname, accountId, nowIso = new Date().toISOString(),
  } = options;
  const refs = index?.refs || {};
  const icons = refs.icons || {};
  const zhOfChar = (key) => i18n?.characters?.[key] || key;
  const zhOfCone = (key) => i18n?.lightCones?.[key] || key;
  // 角色 id：`charactersById` 是 id → {en, cn}，反过来查；查不到就从图标路径里抠数字。
  const idByChar = new Map();
  for (const [id, v] of Object.entries(i18n?.charactersById || {})) {
    if (v?.en) idByChar.set(v.en, Number(id) || null);
    if (v?.cn) idByChar.set(v.cn, Number(id) || null);
  }
  const idFromIcon = (raw) => {
    const m = /\/(\d+)\.png/.exec(String(raw || ''));
    return m ? Number(m[1]) : null;
  };
  /** 图标：直接用数据集图标表里那串（`/icons/...?fallback=<cdn>`，`/icons` 路由会兜底 302）。 */
  const iconOf = (table, key) => {
    const raw = table?.[key];
    if (!raw) return null;
    if (/^https?:\/\//.test(raw)) return raw;
    if (String(raw).startsWith('/icons/')) return raw;
    return null;
  };

  const ctx = presetContext({ availability, firstSeen: refs.firstSeen?.characters,
    charCostOf, coneCostOf });
  const { chars: presetChars = {}, cones: presetCones = {}, note } = preset.spec(ctx) || {};

  const rows = [];
  const byName = new Map();
  const push = (key, tier) => {
    const name = zhOfChar(key);
    const info = availability?.characters?.[key] || {};
    const icon = iconOf(icons.characters, key);
    const row = {
      // ⚠️ 这三个字段一个都不能少：id（卡片身份 / 抽卡页跳转）、rarity（星级与配色）、icon。
      id: idByChar.get(key) || idByChar.get(name) || idFromIcon(icon),
      name,
      level: 80,
      promotion: 6,
      rarity: Number(info.rarity) || 5,
      rank: Number(tier) || 0,
      actived_constellation_num: Number(tier) || 0,
      path: refs.characterPaths?.[key] || null,
      icon,
      image: null,
      equip: null,
    };
    const prev = byName.get(name);
    if (prev) Object.assign(prev, row);
    else { rows.push(row); byName.set(name, row); }
  };
  // 免费角色全预置（真实账号都有；成本恒为 0，不影响分数，只影响「已有 / 缺」的显示）。
  for (const key of ctx.freeChars) push(key, 6);
  for (const [key, tier] of Object.entries(presetChars)) push(key, tier);

  // 光锥挂在限定角色身上（米游社只返回**装备中**的光锥；挂给谁不影响算分）。
  const carriers = rows.filter((r) => Object.keys(presetChars)
    .map((k) => zhOfChar(k)).includes(r.name));
  let ci = 0;
  for (const [key, sup] of Object.entries(presetCones)) {
    const info = availability?.lightCones?.[key] || {};
    const rank = Math.max(1, Number(sup) || 1);
    const carrier = carriers[ci] || rows.find((r) => !r.equip) || rows[0];
    ci += 1;
    if (!carrier) continue;
    carrier.equip = {
      id: Number(info.id) || null,
      name: zhOfCone(key),
      level: 80,
      rank,
      rarity: Number(info.rarity) || 5,
      icon: iconOf(icons.lightCones, key),
    };
  }

  return {
    id: accountId,
    accountId,
    nickname: nickname || `虚拟·${preset.title}`,
    source: 'virtual',
    virtualPreset: preset.id,
    createdAt: nowIso,
    lastLoginAt: null,
    rolesUpdatedAt: nowIso,
    roles: [{
      uid: String(uid), nickname: nickname || `虚拟·${preset.title}`, level: 70,
      region: 'prod_gf_cn', regionName: '国服', gameBiz: 'hkrpg_cn', game: 'hsr',
    }],
    snapshots: {
      [String(uid)]: {
        uid: String(uid), game: 'hsr', source: 'virtual', virtualPreset: preset.id,
        characters: rows,
        // 角色面板要用的立绘 / 详情这里没有（虚拟账号没有真数据），留空即可。
        details: [],
        basicInfo: { nickname: nickname || `虚拟·${preset.title}`, level: 70 },
        note: note || preset.hint,
      },
    },
  };
};

/** 预留一个没被占用的 uid（纯数字！快照路由是 /roles/(\d+)/snapshot）。 */
export const nextVirtualUid = (taken = []) => {
  const used = new Set(taken.map((u) => String(u)));
  for (let i = 1; i <= 9999; i += 1) {
    const uid = String(900000 + i);
    if (!used.has(uid)) return uid;
  }
  return String(Date.now());
};

/** 本地是否真的拉了图标镜像（拉了就用同源路径，没拉就走 fallback 302）。 */
export const iconsMirrored = (dir) => Boolean(dir) && existsSync(dir);
