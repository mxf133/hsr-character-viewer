// 命途 / 属性 的**游戏内图标**地址（九条命途 + 七种属性）。
//
// 用户 2026-10-18：「角色信息页的**命途和属性需要显示图标**……**虚拟账户也要这样显示**」。
//
// ## 图从哪来
//
// 游戏自己的 `icon/path/*.png` 与 `icon/element/*.png` —— 就是背包/角色页上那两枚
// 小图标（命途是白色刻痕、属性是七色符号），与游戏 wiki 角色页右上角那两栏同源。
// 走 `Mar-7th/StarRailRes` 镜像（与本仓库既有的头像 / 光锥 / 立绘**同一个 base**），
// 因此不需要新开数据源，也不需要再写一套缓存策略：
//
//   `/icons/icon/path/Destruction.png?fallback=<urlencoded cdn>`
//   ↑ `/icons` 路由：本地镜像有就直发，没有就 302 到 CDN（见 src/server/app.js）。
//   `node tools/herta-icons.mjs --only=icons` 会把这两组一起镜像到本地。
//
// ## 键怎么对
//
// 命途在仓库里有**两套写法**，这里都收：
//   * 数据集 / 米游社记录：`Warrior` `Rogue` `Mage` `Shaman` `Warlock` `Knight` `Priest`
//     `Memory` `Elation`（`theherta/character_paths.json` 用的就是这套）；
//   * 游戏素材与 `refs.pathLabels` 里的英文名：`Destruction` `Hunt` `Erudition` `Harmony`
//     `Nihility` `Preservation` `Abundance` `Remembrance` `Elation`。
// 属性同理：快照给 `Fire / Ice / Thunder / Wind / Quantum / Imaginary / Physical`，
// 前端别处还会写 `Lightning`（`format.js` 的 `ELEMENT_LABELS` 两种都认），这里一并收。
//
// ⚠️ 认不出的键返回**空串**，调用方据此不画图标 —— 宁可少一枚图标，也不画错的。
//   （新命途 / 新属性真的上线时，这里会先「缺一枚图标」，而不会误导成别的命途。）

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/Mar-7th/StarRailRes@master';

/** 命途键（两套写法，大小写不敏感）→ 素材文件名。 */
const PATH_FILES = {
  // 数据集写法
  warrior: 'Destruction',
  rogue: 'Hunt',
  mage: 'Erudition',
  shaman: 'Harmony',
  warlock: 'Nihility',
  knight: 'Preservation',
  priest: 'Abundance',
  memory: 'Remembrance',
  elation: 'Elation',
  // 游戏素材 / i18n 写法
  destruction: 'Destruction',
  hunt: 'Hunt',
  erudition: 'Erudition',
  harmony: 'Harmony',
  nihility: 'Nihility',
  preservation: 'Preservation',
  abundance: 'Abundance',
  remembrance: 'Remembrance',
};

/** 属性键（大小写不敏感）→ 素材文件名。素材里是 `Thunder`，不是 `Lightning`。 */
const ELEMENT_FILES = {
  physical: 'Physical',
  fire: 'Fire',
  ice: 'Ice',
  thunder: 'Thunder',
  lightning: 'Thunder',
  wind: 'Wind',
  quantum: 'Quantum',
  imaginary: 'Imaginary',
};

const urlOf = (group, file) => {
  if (!file) return '';
  const cdn = `${CDN_BASE}/icon/${group}/${file}.png`;
  return `/icons/icon/${group}/${file}.png?fallback=${encodeURIComponent(cdn)}`;
};

/**
 * 这两组素材的**文件名清单**（去重后的 9 + 7 张）。
 *
 * `tools/herta-icons.mjs` 用它们把图标一起镜像到本地 —— 那份工具读的是
 * `i18n.icons.*` 表，而命途/属性这两组**不在那张表里**（那是按角色/光锥名登记的），
 * 所以在这里导出清单，避免文件名在镜像脚本里再抄一遍。
 */
export const PATH_ICON_FILES = Object.freeze([...new Set(Object.values(PATH_FILES))]);
export const ELEMENT_ICON_FILES = Object.freeze([...new Set(Object.values(ELEMENT_FILES))]);

/** 命途图标地址；认不出给空串。 */
export const pathIconUrl = (path) =>
  urlOf('path', PATH_FILES[String(path ?? '').trim().toLowerCase()] || '');

/** 属性图标地址；认不出给空串。 */
export const elementIconUrl = (element) =>
  urlOf('element', ELEMENT_FILES[String(element ?? '').trim().toLowerCase()] || '');

/**
 * 一枚图标节点（`<img>`）；没有地址时返回 `null`，调用方直接不 append。
 *
 * 图挂了（断网 / 素材改名）就把自己移除 —— 与角色卡立绘同一套兜底，不让用户看到破图。
 */
export const gameIcon = (url, className = 'char-icon') => {
  if (!url) return null;
  const img = document.createElement('img');
  img.className = className;
  img.src = url;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => img.remove(), { once: true });
  return img;
};
