// 虚拟账号的**角色编辑器**（用户 2026-10-13 第 3 条）：
//
//   「虚拟账号提供更多的角色可选，目前只能选择几种固定配队，改为用户可给这个虚拟账号
//     自定义添加角色（虚拟账号可在**角色列表末尾**点击添加没有的角色，并设置任意角色的
//     星魂和光锥，设置光锥时选择该角色**同命途**光锥，专属光锥优先）」
//
// 为什么单独一个模块：`app.js` 已经 1200+ 行，而「满屏遮罩 + 标题栏 + 可滚正文」这套房子
// 在 `character-modal.js` / `advice-tip-window.js` / `advice-gold-modal.js` 里各有一份了。
// 这里是**第四份外壳**，但它与前三个的语义都不同（前两个搬内容、第三个管开关），
// 所以直接复用 CSS 类（`.modal` / `.char-panel-head` / `.char-panel-body`）而不复用代码。
//
// 口径分工（改之前先看这里）：
//   * **命途约束与「专属优先」的排序**在本文件（界面层）：下拉框只列同命途光锥，
//     专属那把排第一并标注「专属」；
//   * **合法性收口**在服务端（`normalizeRoster`）：非法键丢弃、星魂吸附到 E0/E1/E2/E6、
//     叠影夹到 1~5、光锥主人必须与它同命途。界面就算被绕过，账号库里也不会出现脏数据。
//
// ⚠️ **一把光锥只能给一个人**（米游社快照里光锥是「装备中」的，没有独立库存）。
// 所以下拉框会**排除已被别人选走的光锥** —— 这样界面选什么、服务端就挂什么，
// 不会出现「给甲选了某把锥，服务端却按专属把它挂到乙身上」这种错位。

const ROOT_ID = 'virtualRosterModal';

/** 星魂的合法停靠点（用户 2026-10-13 第 4 条；与服务端 `EIDOLON_TIERS` 同一份口径）。 */
const EIDOLON_TIERS = [0, 1, 2, 6];
/** 叠影层数。 */
const SUPERIMPOSE = [1, 2, 3, 4, 5];

/**
 * 开拓者的**五个命途形态**（用户第 4 条）。
 *
 * 头像 id 由「形态序号 × 2 + 性别」决定，实测（CDN 逐张下载肉眼核对）：
 *   奇数 = 男主（穹），偶数 = 女主（星）；形态顺序就是下面这个数组的顺序。
 *   8001 毁灭(男) / 8002 毁灭(女) / 8003 存护(男) / 8004 存护(女) /
 *   8005 同谐(男) / 8006 同谐(女) / 8007 记忆(男) / 8008 记忆(女) /
 *   8009 欢愉(男) / 8010 欢愉(女)
 * 与 `src/server/records.js` 的 `TRAILBLAZER_FORMS`（属性 → 形态）是同一套命途口径。
 */
const TRAILBLAZER_FORMS = [
  { key: 'Trailblazer (Destruction)', cn: '毁灭' },
  { key: 'Trailblazer (Preservation)', cn: '存护' },
  { key: 'Trailblazer (Harmony)', cn: '同谐' },
  { key: 'Trailblazer (Remembrance)', cn: '记忆' },
  { key: 'Trailblazer (Elation)', cn: '欢愉' },
];
/** 开拓者的星魂固定 E6（用户第 4 条：**不可改**）。 */
const TRAILBLAZER_EIDOLON = 6;
/** 头像 id 区间（服务端快照里开拓者也只在这个区间里出来）。 */
const TRAILBLAZER_ID_MIN = 8001;
const TRAILBLAZER_ID_MAX = 8010;

/** `Trailblazer (Destruction)` → `{ 序号: 0, 性别: 'male', id: 8001 }`。 */
const TRAILBLAZER_AVATARS = TRAILBLAZER_FORMS.flatMap((form, index) => ([
  { id: TRAILBLAZER_ID_MIN + index * 2, form: form.key, cn: form.cn, gender: 'male' },
  { id: TRAILBLAZER_ID_MIN + index * 2 + 1, form: form.key, cn: form.cn, gender: 'female' },
]));

/** 这一行是不是开拓者（快照里的键是 `Trailblazer (Xxx)`，中文名是「开拓者•Xxx」）。 */
const isTrailblazerKey = (key) => /^trailblazer\b/i.test(String(key || ''));

/** 某个头像 id 对应的那条记录（不在 8001~8010 里给 null）。 */
const trailblazerAvatarById = (id) => TRAILBLAZER_AVATARS
  .find((a) => a.id === Number(id)) || null;

/**
 * 头像地址：图标表里**只有** `{NICKNAME}` 一项（= 8010，女主·欢愉），
 * 其余 id 按同一规则拼 `/icons/icon/character/<id>.png?fallback=<urlencoded cdn>`
 * —— `/icons` 路由会把本地没有的文件 302 到 fallback（与数据集图标表同一套写法）。
 */
const trailblazerIconUrl = (id, sample) => {
  const base = String(sample || '').split('?')[0]
    || '/icons/icon/character/8010.png';
  const path = base.replace(/\d+\.png$/, `${id}.png`);
  const fallback = `https://cdn.jsdelivr.net/gh/Mar-7th/StarRailRes@master/icon/character/${id}.png`;
  return `${path}?fallback=${encodeURIComponent(fallback)}`;
};

/** 「值 + 两行小字」那一列的两个小工具。 */
const el = (tag, className, textContent) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
};

/** 图标地址：数据集图标表里那串（`/icons/...?fallback=<cdn>`）；查不到给 null（不拼 CDN）。 */
const looseKeyOf = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const baseFormKeyOf = (name) => (/^Trailblazer\b/i.test(String(name || ''))
  ? '{NICKNAME}' : String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim());
const iconTable = (table) => {
  const exact = new Map();
  const loose = new Map();
  for (const [key, url] of Object.entries(table || {})) {
    if (!url) continue;
    if (!exact.has(key)) exact.set(key, url);
    const folded = looseKeyOf(key);
    if (folded && !loose.has(folded)) loose.set(folded, url);
  }
  return { exact, loose };
};
const iconFor = (maps, kind, key) => {
  const m = kind === 'cone' ? maps.cone : maps.char;
  return m.exact.get(key) || m.exact.get(baseFormKeyOf(key))
    || m.loose.get(looseKeyOf(key)) || m.loose.get(looseKeyOf(baseFormKeyOf(key))) || null;
};

/**
 * 一把光锥**要不要花金**（= 活动跃迁 5★）。
 *
 * ⚠️ 这是 `public/scripts/advice.js` 的 `coneCostOf()` 的**镜像**，不是第二份口径：
 * 本模块是纯前端，不 import 评分模块（那个 5900 行，还要 availability 之外的东西）。
 * 镜子必须与本体一致 —— `tools/virtual-accounts-test.mjs` 里有一条
 * 「把全部 170 把锥逐个与 `coneCostOf` 比一遍」的回归钉着它。
 */
const coneIsCostly = (cone, refs) => {
  const info = refs?.availability?.lightCones?.[cone];
  if (!info) return true;
  const rarity = Number(info.rarity);
  if (Number.isFinite(rarity) && rarity <= 4) return false;
  return info.limited !== false;
};

/**
 * 某个角色在编辑器里**可选**的光锥。
 *
 * 三条约束（用户 2026-10-13 第 3 条原话「选择该角色**同命途**光锥，**专属光锥优先**」）：
 *   ① 只列与它**同命途**的（`refs.lightConePaths[锥] === refs.characterPaths[角色]`；
 *      命途数据缺失时放宽，只做下面的两条）；
 *   ② **成本 > 0 的锥**已被别人选走时不再列（米游社快照里光锥是「装备中」的、没有独立
 *      库存，而 `cones` 又是**去重的金数口径** —— 同一把限定锥配给两个人会把金数算少）。
 *      ⚠️ 改前**所有**锥都不许共用，于是「平铺档每个角色都有光锥」这件事在编辑器里
 *      一存就退化：4★ 本来就没有专属锥，5 个 4★ 共用一把 4★ 锥是**合法**的
 *      （用户 2026-10-14 第 1 条要的就是每个角色都有光锥）；
 *   ③ 它自己的**专属光锥排第一**（用户要求的「专属优先」）。
 *
 * ⚠️ 单独导出（而不是留在 `openVirtualRoster` 里）是为了**能在 Node 里测**：
 * 这一段是整块改动里唯一有分支的决策逻辑，而 CDP 套件要真浏览器（HANDOFF §5），
 * 本机环境里跑不到 —— 留在闭包里等于这段逻辑没有任何回归。
 *
 * @param {{charKey:string, refs:object, owners:Map<string,string>,
 *          signatures?:object}} input
 *   `signatures` = 服务端算出来的**真专属锥表**（`roster GET` 的 `signatureLightCones`）。
 *   不传就退回 `refs.popularLightCones`（「最常用光锥」）—— 老接口 / 单元测试那条路。
 */
export const coneChoicesFor = ({ charKey, refs, owners, signatures = null }) => {
  const conePaths = refs?.lightConePaths || {};
  const charPath = (refs?.characterPaths || {})[charKey];
  const all = Object.keys(refs?.availability?.lightCones || {});
  const signature = signatures?.[charKey] || refs?.popularLightCones?.[charKey] || null;
  const list = all.filter((cone) => {
    if (charPath && conePaths[cone] && conePaths[cone] !== charPath) return false;
    const owner = owners?.get(cone) || null;
    // ②：只有**成本 > 0** 的锥不许共用（免费锥可以多人装备，见上面那段注释）。
    if (owner && owner !== charKey && coneIsCostly(cone, refs)) return false;
    return true;
  });
  return list.sort((a, b) => (a === signature ? -1 : b === signature ? 1 : a.localeCompare(b)));
};

/**
 * 给一个角色配上它的专属光锥（如果那把锥还空着）——**「添加角色」时的默认动作**。
 * 返回 `{ cone, sup }` 或 `null`（没有专属锥 / 已被别人选走 / 命途不符）。
 *
 * ⚠️ 「已被别人选走」只对**成本 > 0** 的锥成立（与 `coneChoicesFor` 同一条口径）：
 * 4★ 的专属锥本身就是免费锥，别人也拿着它并不妨碍你再配一次。
 */
export const defaultConeFor = ({ charKey, refs, owners, signatures = null }) => {
  const signature = signatures?.[charKey] || refs?.popularLightCones?.[charKey] || null;
  if (!signature) return null;
  if (!refs?.availability?.lightCones?.[signature]) return null;
  const takenByOther = owners?.get(signature) && owners.get(signature) !== charKey;
  if (takenByOther && coneIsCostly(signature, refs)) return null;
  const conePath = (refs?.lightConePaths || {})[signature];
  const charPath = (refs?.characterPaths || {})[charKey];
  if (conePath && charPath && conePath !== charPath) return null;
  return { cone: signature, sup: 1 };
};

/**
 * 打开编辑器。调用方（`app.js`）负责把 `api` / `ensureIndex` 传进来：
 * 这样鉴权、CSRF、错误提示都走同一条路，不在这个模块里再实现一遍。
 *
 * @param {{accountId:string, nickname?:string, api:Function, ensureIndex:Function,
 *          onSaved?:Function}} options
 */
export const openVirtualRoster = async (options) => {
  const {
    accountId, nickname, api, ensureIndex, onSaved,
  } = options || {};
  if (!accountId) return;

  const index = await ensureIndex();
  const refs = index?.refs || {};
  const availability = refs.availability || {};
  /**
   * 图标表按 `iconFor()` 期望的形状收好。
   *
   * ⚠️ **这里原来是「＋ 添加角色」完全打不开的根因**（用户第 3 条）：
   * `iconTable()` 返回的是 `{ exact, loose }`（两张 Map），而 `iconFor(maps, kind, key)`
   * 取的是 `maps.char` / `maps.cone` —— 传进去的就是那张 `{ exact, loose }` 本身，
   * 于是 `maps.char` 恒为 `undefined`，第 207 行的第一个角色就抛
   * `TypeError: Cannot read properties of undefined (reading 'exact')`。
   * 异常穿过 `paint()` 冒到 `openVirtualRoster()` 的返回值上，被 `app.js` 那句
   * `.catch((err) => toast(err.message, 'err'))` 吞成一条一闪而过的英文提示，
   * 屏幕上只剩一个**一行都没有的空壳窗口** —— 看起来就是「点了没反应」。
   */
  const icons = {
    char: iconTable(refs.icons?.characters),
    cone: iconTable(refs.icons?.lightCones),
  };
  const charPaths = refs.characterPaths || {};
  const conePaths = refs.lightConePaths || {};
  const pathLabels = refs.pathLabels || {};
  const roster = await api(`/api/virtual-accounts/${accountId}/roster`);
  /**
   * **真正的专属光锥表**：优先用服务端随名单下发的 `signatureLightCones`
   * （`deriveSignatureCones()` 现算的、限定 5★ 一对一），退回 `refs.popularLightCones`
   * （「最常用**光锥**」—— 老接口 / 单元测试那条路）。
   *
   * ⚠️ 用错这张表就是用户报的那个 bug：花火 / 缇宝 的「专属」会被标成
   * `Dance Dance Dance`（一把 8 个人共用的通用锥）。见 `src/server/virtual-accounts.js`
   * 的 `deriveSignatureCones` 注释。
   */
  const signatures = roster?.signatureLightCones && Object.keys(roster.signatureLightCones).length
    ? roster.signatureLightCones : null;
  /**
   * **权威专武**（常驻 7 个 + 限定 5★，见服务端 `signatureCones()`）。
   *
   * ⚠️ 只用来打「（专属）」这个标。**不要**拿 `popularLightCones` 顶替：那是
   * 「最常用光锥」，4★ / 辅助角色常常是一把通用锥（实测花火与缇宝都指向
   * `Dance Dance Dance`），标成「专属」是错的（用户第 1 条报的就是它）。
   */
  const signatureOf = (key) => signatures?.[key] || null;
  /**
   * 「下拉框里排第一 / 添加角色时的默认配锥」用哪个：权威专武优先，没有就用
   * `popularLightCones`（最常用那把）—— 对 4★ 来说这就是最合理的默认值，
   * 只是**不标「专属」**。
   */
  const preferredConeOf = (key) => signatureOf(key) || refs.popularLightCones?.[key] || null;
  const pathName = (path) => pathLabels[path] || path || '—';

  // 名单：`chars` = 角色 → 星魂档；`cones` = 光锥 → 叠影（**去重的持有集合**）；
  //       `charCones` = 角色 → 装备的光锥（**逐角色装备，权威**）；
  //       `owners` = 光锥 → 主人（旧形状，保存时仍要回传）。
  const chars = new Map(Object.entries(roster?.roster?.chars || {}).map(([k, v]) => [k, Number(v) || 0]));
  const cones = new Map(Object.entries(roster?.roster?.cones || {}).map(([k, v]) => [k, Number(v) || 1]));
  const charCones = new Map(Object.entries(roster?.roster?.charCones || {}));
  const owners = new Map(Object.entries(roster?.roster?.coneOwners || {}));
  // 老账号（没有 `charCones`）：先按 `coneOwners` 反推；还没有主人的那些锥，
  // 按「专属锥恰好是这一把」在名单内现找一份（与服务端 GET 的兜底同一口径）。
  for (const [cone] of cones) {
    if (owners.has(cone)) continue;
    const owner = Object.keys(charPaths).find((c) => chars.has(c) && preferredConeOf(c) === cone);
    if (owner) owners.set(cone, owner);
  }
  for (const [cone, owner] of owners) if (!charCones.has(owner)) charCones.set(owner, cone);
  /**
   * 把「逐角色装备」同步回两个派生集合（**每次改动都要调一次**）：
   *   * `cones` = **去重的持有集合**（金数口径按它记账）：先补齐新装备的锥的叠影，
   *     再删掉「已经没有任何角色装备」的锥 —— 不删的话，用户把某把限定锥卸下之后，
   *     它还会留在持有集合里继续算金；
   *   * `owners` = 旧的「光锥 → 主人」（一把锥被多人装备时只记第一个，`charCones` 才是权威）。
   */
  const syncCones = () => {
    const held = new Set(charCones.values());
    for (const cone of held) if (!cones.has(cone)) cones.set(cone, 1);
    for (const cone of [...cones.keys()]) if (!held.has(cone)) cones.delete(cone);
    owners.clear();
    for (const [char, cone] of charCones) if (!owners.has(cone)) owners.set(cone, char);
  };

  const allChars = Object.keys(availability.characters || {});
  const zhOf = (key) => (refs.characters || []).find((c) => c.name === key)?.nameCn || key;
  const zhOfCone = (key) => (refs.lightCones || []).find((c) => c.name === key)?.nameCn || key;

  // ---- 开拓者（用户第 4 条）：永远已拥有、星魂固定 E6、不可移除 ------------------
  //
  // 服务端快照里 `Trailblazer (Destruction|Preservation|Harmony|Remembrance|Elation)`
  // 五个键是**主线赠送**的，所以永远算已拥有。编辑器把**女主的欢愉形态**当作「开拓者
  // 这一行」的存放处（图标表里 `{NICKNAME}` 指的就是它），另外四个形态在名单里保留、
  // 但不单独占一行 —— 否则画面上会出现 5 个一模一样的「开拓者•XX」。
  /** 图标表里 {@code {NICKNAME}} 那一项（= 8010），拼其余 id 的头像地址要用它当模板。 */
  const trailblazerIconSample = refs.icons?.characters?.['{NICKNAME}'] || null;
  /** 「开拓者这一行」用哪个形态承载（优先级：名单里已有的欢愉 → 名单里任一形态 → 欢愉）。 */
  const pickTrailblazerKey = () => {
    const owned = TRAILBLAZER_FORMS.map((f) => f.key).filter((k) => chars.has(k));
    return owned.find((k) => k === 'Trailblazer (Elation)') || owned[0] || 'Trailblazer (Elation)';
  };
  const trailblazerKey = pickTrailblazerKey();
  /**
   * 当前选中的头像 id（8001~8010）。来源优先级：
   *   ① 服务端存下的 `roster.trailblazer.id`（用户上一次选的）；
   *   ② 名单里**已拥有**的开拓者形态对应的男主头像（老账号没有 ① 时的退化）。
   */
  const trailblazerOwned = TRAILBLAZER_FORMS.map((f) => f.key).filter((k) => chars.has(k));
  let trailblazerId = trailblazerAvatarById(roster?.roster?.trailblazer?.id)?.id
    || trailblazerAvatarById(availability.characters?.[trailblazerKey]?.id)?.id
    || TRAILBLAZER_AVATARS.find((a) => a.form === trailblazerOwned[0])?.id
    || TRAILBLAZER_ID_MIN;
  /** 五个形态一律算已拥有且 E6（用户第 4 条：不可移除、星魂固定）。 */
  for (const form of TRAILBLAZER_FORMS) chars.set(form.key, TRAILBLAZER_EIDOLON);
  /**
   * 已拥有但**不在名单原文里**的开拓者形态。
   *
   * 它们被强行塞进了 `chars`（上面那一句），而 `chars` 就是「保存时发回去的名单」——
   * 原样发回去会让每次打开编辑器都往名单里写进 5 个开拓者形态。所以先记下「谁是我塞的」，
   * 保存前把它们摘掉，只回传承载行那一个（服务端 `normalizeRoster` 也会挡一道，但那是兜底）。
   */
  const injectedTrailblazers = new Set(TRAILBLAZER_FORMS
    .filter((f) => !(roster?.roster?.chars || {})[f.key]).map((f) => f.key));
  // 只有**承载行**那个形态参与列表渲染，其余四个隐藏（但仍在 `chars` 里，所以不会被移除）。
  const trailblazerRowKeys = new Set([trailblazerKey]);
  let listChars = allChars.filter((key) => !isTrailblazerKey(key) || trailblazerRowKeys.has(key));
  /** 当前头像对应的那条记录。 */
  const avatarOf = () => trailblazerAvatarById(trailblazerId) || TRAILBLAZER_AVATARS[0];
  /** 换头像：id 决定形态，所以换头像时「承载行」也要跟着挪到对应形态上。 */
  const setTrailblazerId = (id) => {
    const next = trailblazerAvatarById(id);
    if (!next) return;
    trailblazerId = next.id;
    trailblazerRowKeys.clear();
    trailblazerRowKeys.add(next.form);
    listChars = allChars.filter((key) => !isTrailblazerKey(key) || trailblazerRowKeys.has(key));
  };
  /** 开拓者那一行的「中文名」：`开拓者•毁灭`（男主/女主只差头像）。 */
  const trailblazerLabel = (formKey) => zhOf(formKey) || '开拓者';
  /**
   * 一个头像的命途显示名：**优先取 `refs.pathLabels`**（与角色行、抽卡页同一份口径），
   * 取不到退回静态表里那份中文，再取不到就如实写「头像 8001」—— 不猜。
   */
  const avatarLabelOf = (avatar) => {
    const label = pathName(charPaths[avatar.form]);
    return label === '—' ? `头像 ${avatar.id}` : label;
  };

  const previous = document.getElementById(ROOT_ID);
  if (previous) previous.remove();
  const modal = el('div', 'modal advice-gold-modal');
  modal.id = ROOT_ID;
  const card = el('div', 'modal-card advice-gold-card is-vroster');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const head = el('div', 'char-panel-head');
  const title = el('span', '', `自定义角色 · ${nickname || '虚拟账号'}`);
  const actions = el('div', 'char-panel-actions');
  const closeBtn = el('button', 'btn btn-ghost btn-sm', '关闭');
  actions.append(closeBtn);
  head.append(title, actions);
  const body = el('div', 'char-panel-body advice-gold-body');
  card.append(head, body);
  modal.appendChild(card);
  document.body.appendChild(modal);

  const filter = { text: '', only: 'all' };
  const searchRow = el('div', 'vroster-toolbar');
  const search = el('input', 'vroster-search');
  search.type = 'search';
  search.placeholder = '搜索角色名 / 命途（如「同谐」「毁灭」）';
  search.setAttribute('aria-label', '搜索角色');
  const filterRow = el('div', 'vroster-filters');
  const countLabel = el('span', 'vroster-count');
  searchRow.append(search, filterRow, countLabel);
  const list = el('div', 'vroster-list');
  const foot = el('div', 'vroster-foot');
  const hint = el('span', 'vroster-hint');
  const saveBtn = el('button', 'btn btn-sm', '保存');
  const cancelBtn = el('button', 'btn btn-ghost btn-sm', '取消');
  foot.append(hint, cancelBtn, saveBtn);
  body.append(searchRow, list, foot);

  const close = () => { modal.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
  search.addEventListener('input', () => { filter.text = search.value.trim(); paint(); });
  for (const [id, label] of [['all', '全部'], ['have', '已拥有'], ['missing', '未拥有']]) {
    const btn = el('button', 'vroster-filter', label);
    btn.dataset.only = id;
    btn.addEventListener('click', () => { filter.only = id; paint(); });
    filterRow.appendChild(btn);
  }

  /** 某个角色可选的光锥：约束与排序都在 `coneChoicesFor` 里（那一段有回归）。 */
  const coneChoices = (charKey) => coneChoicesFor({ charKey, refs, owners, signatures });

  /** 给一个角色配上它的专属锥（如果那把锥还空着）。**添加角色时的默认动作**。 */
  const equipSignature = (charKey) => {
    const pick = defaultConeFor({ charKey, refs, owners, signatures });
    if (!pick) return;
    charCones.set(charKey, pick.cone);
    syncCones();
  };

  /** 当前头像选择器的宿主行（只在开拓者那一次重绘里活着）。 */
  let trailblazerRow = null;

  /** 行：一个角色（已拥有给三个下拉框，未拥有给「＋ 添加」）。 */
  const renderRow = (charKey, owned) => {
    const row = el('div', `vroster-row${owned ? ' is-owned' : ''}`);
    const isTB = isTrailblazerKey(charKey);
    // 开拓者的图标表里只有 `{NICKNAME}`（= 8010），所以这一行直接用**当前头像 id** 拼地址。
    // ⚠️ `iconFor()` 的第一个参数要的是**两张表**（`{ char, cone }`），不是单独一张 ——
    // 传 `icons.char` 进去的话 `maps.char` 又是 `undefined`，渲染第一行就抛
    // `Cannot read properties of undefined (reading 'exact')`（**这就是用户第 3 条的原症状**，
    // 实测在真浏览器里复现过：弹窗打开、里面一行都没有、toast 一闪而过）。
    const icon = isTB
      ? trailblazerIconUrl(trailblazerId, trailblazerIconSample)
      : iconFor(icons, 'char', charKey);
    if (icon) {
      const img = el('img', 'vroster-icon');
      img.src = icon;
      img.alt = '';
      img.loading = 'lazy';
      row.appendChild(img);
    } else {
      row.appendChild(el('span', 'vroster-icon is-empty', zhOf(charKey).slice(0, 1)));
    }
    const meta = el('div', 'vroster-meta');
    meta.append(
      el('span', 'vroster-name', isTB ? trailblazerLabel(charKey) : zhOf(charKey)),
      el('span', 'vroster-sub', `${pathName(charPaths[charKey])} · `
        + `${Number(availability.characters?.[charKey]?.rarity) || 4}★`
        + `${availability.characters?.[charKey]?.limited === false ? '' : ' · 限定'}`),
    );
    if (isTB) {
      const avatar = avatarOf();
      meta.append(el('span', 'vroster-sub',
        `开拓者 · ${avatar.gender === 'male' ? '男主（穹）' : '女主（星）'} · 星魂 E${TRAILBLAZER_EIDOLON} 固定`));
    }
    row.appendChild(meta);

    const tools = el('div', 'vroster-tools');
    if (!owned) {
      const add = el('button', 'btn btn-ghost btn-sm', '＋ 添加');
      add.addEventListener('click', () => {
        chars.set(charKey, 0);
        equipSignature(charKey);
        paint();
      });
      tools.appendChild(add);
      row.appendChild(tools);
      return row;
    }

    // 开拓者：星魂固定 E6（不可改）、**不可移除**，也不给配光锥（用户第 4 条）。
    // 头像 / 形态由**这一行内**那个「开拓者头像」选择器统一决定（选择器挂在行内，
    // 不在 `paint()` 的重绘范围里 —— 点它不会重建列表、也就不会丢滚动位置）。
    if (isTB) {
      const locked = el('button', 'btn btn-ghost btn-sm', `星魂 E${TRAILBLAZER_EIDOLON}`);
      locked.type = 'button';
      locked.disabled = true;
      locked.title = '开拓者的星魂通过主线解锁，固定 E6，不可修改。';
      const change = el('button', 'btn btn-ghost btn-sm', '更换头像');
      change.type = 'button';
      change.addEventListener('click', () => {
        // 重新取一次（这行可能刚被重绘过，而选择器实例是复用的那一个）。
        const host = trailblazerRow?.querySelector('.vroster-toolbar');
        if (!host) return;
        host.hidden = false;
        pickerSearch.focus();
      });
      tools.append(locked, change);
      row.appendChild(tools);
      if (picker) row.appendChild(picker);
      trailblazerRow = row;
      return row;
    }

    const eid = el('select', 'vroster-select');
    eid.setAttribute('aria-label', `${zhOf(charKey)} 的星魂`);
    for (const tier of EIDOLON_TIERS) {
      const opt = el('option', '', `E${tier}`);
      opt.value = String(tier);
      if ((chars.get(charKey) || 0) === tier) opt.selected = true;
      eid.appendChild(opt);
    }
    eid.addEventListener('change', () => { chars.set(charKey, Number(eid.value) || 0); paint(); });
    tools.appendChild(eid);

    const current = charCones.get(charKey) || '';
    const cone = el('select', 'vroster-select is-cone');
    cone.setAttribute('aria-label', `${zhOf(charKey)} 的光锥`);
    const none = el('option', '', '不装备光锥');
    none.value = '';
    cone.appendChild(none);
    for (const key of coneChoices(charKey)) {
      const sig = signatureOf(charKey) === key;
      const opt = el('option', '', `${zhOfCone(key)}${sig ? '（专属）' : ''}`);
      opt.value = key;
      if (current === key) opt.selected = true;
      cone.appendChild(opt);
    }
    if (current && !coneChoices(charKey).includes(current)) {
      // 当前那把锥不在候选里（例如被人抢走了 / 命途数据缺失）：仍然如实列出来，
      // 否则用户看到的「不装备光锥」与他实际持有的锥不一致。
      const stray = el('option', '', zhOfCone(current));
      stray.value = current;
      stray.selected = true;
      cone.appendChild(stray);
    }
    cone.addEventListener('change', () => {
      // 只动**这个角色**的装备：`charCones` 是权威，`syncCones()` 再把两个派生集合
      // （去重的持有集合 `cones` / 旧的 `owners`）重算一遍。
      // ⚠️ 改前这里按 `owners`（锥 → 单个主人）删改，于是「5 个 4★ 共用一把锥」
      // 这种合法状态一存就被压成一个人持有 —— 用户第 1 条要的「每个角色都有光锥」
      // 会在编辑器里被悄悄改回去。
      if (cone.value) charCones.set(charKey, cone.value);
      else charCones.delete(charKey);
      syncCones();
      paint();
    });
    tools.appendChild(cone);

    if (current) {
      const sup = el('select', 'vroster-select is-sup');
      sup.setAttribute('aria-label', `${zhOf(charKey)} 的光锥叠影`);
      for (const n of SUPERIMPOSE) {
        const opt = el('option', '', `S${n}`);
        opt.value = String(n);
        if ((cones.get(current) || 1) === n) opt.selected = true;
        sup.appendChild(opt);
      }
      sup.addEventListener('change', () => { cones.set(current, Number(sup.value) || 1); paint(); });
      tools.appendChild(sup);
    }

    const remove = el('button', 'btn btn-ghost btn-sm btn-danger', '移除');
    remove.addEventListener('click', () => {
      chars.delete(charKey);
      charCones.delete(charKey);
      syncCones();
      paint();
    });
    tools.appendChild(remove);
    row.appendChild(tools);
    return row;
  };

  /**
   * 只换头像时的**轻量刷新**：把开拓者那一行的头像与副标题就地改掉。
   *
   * ⚠️ 不能直接 `paint()` —— 那会 `list.replaceChildren(93 行)`，把用户刚点中的选择器
   * 连同滚动位置一起丢掉（用户报的「点了像没反应」里也有一部分是这个：慢机器上整表重建
   * 期间画面是静止的）。这里只碰那一个 `<img>` / 两行小字。
   */
  const refreshTrailblazerRow = () => {
    if (!trailblazerRow) return;
    const avatar = avatarOf();
    const img = trailblazerRow.querySelector('.vroster-icon');
    if (img) img.src = trailblazerIconUrl(trailblazerId, trailblazerIconSample);
    const subs = trailblazerRow.querySelectorAll('.vroster-sub');
    if (subs[0]) {
      subs[0].textContent = `${pathName(charPaths[avatar.form])} · `
        + `${Number(availability.characters?.[avatar.form]?.rarity) || 5}★ · 开拓者`;
    }
    if (subs[1]) {
      subs[1].textContent = `开拓者 · ${avatar.gender === 'male' ? '男主（穹）' : '女主（星）'}`
        + ` · 星魂 E${TRAILBLAZER_EIDOLON} 固定`;
    }
    renderPicker();
  };

  /**
   * 开拓者头像选择器（用户第 4 条）：10 个头像 = 2 性别 × 5 命途，**按性别 + 命途名分组**。
   *
   * 命途名从 `refs.pathLabels` 取（与角色行、抽卡页同一份口径）；取不到就退回静态表里
   * 那份中文，再取不到就写「头像 8001」——**不猜**。
   * ⚠️ 它是**行内**那一格的持久实例（`renderRow` 只负责把它挂进去）：点它只走
   * `refreshTrailblazerRow()`，不重建列表，所以滚动位置与它自己的搜索框内容都保得住。
   */
  const picker = el('div', 'vroster-toolbar');
  picker.hidden = true;
  const pickerTitle = el('span', 'vroster-name', '开拓者头像');
  const pickerHint = el('span', 'vroster-sub',
    '10 个头像 = 2 性别 × 5 命途；开拓者永远已拥有、星魂固定 E6、不可移除。');
  const pickerSearch = el('input', 'vroster-search');
  pickerSearch.type = 'search';
  pickerSearch.value = filter.text;
  pickerSearch.placeholder = '搜索开拓者命途（如「同谐」「记忆」）';
  pickerSearch.setAttribute('aria-label', '搜索开拓者命途');
  /** 分组标签（男主/女主）单独一行：它们是「提示」而不是「可选的项」。 */
  const pickerGenderRow = el('div', 'vroster-toolbar');
  const pickerGrid = el('div', 'vroster-list');
  function renderPicker() {
    const needle = pickerSearch.value.trim().toLowerCase();
    pickerGrid.replaceChildren();
    pickerGenderRow.replaceChildren();
    const selected = avatarOf();
    const groups = [['male', '男主（穹）'], ['female', '女主（星）']];
    for (const [gender, genderLabel] of groups) {
      const avatars = TRAILBLAZER_AVATARS
        .filter((a) => a.gender === gender)
        .filter((a) => !needle || `${avatarLabelOf(a)} ${a.cn} ${a.form}`.toLowerCase().includes(needle));
      if (!avatars.length) continue;
      pickerGenderRow.append(el('span', 'vroster-count', `${genderLabel} · ${avatars.length} 个头像`));
      for (const avatar of avatars) {
        const chosen = avatar.id === selected.id;
        const btn = el('button', `vroster-row is-owned${chosen ? ' is-chosen' : ''}`);
        btn.type = 'button';
        btn.title = `${genderLabel} · ${avatarLabelOf(avatar)}（头像 ${avatar.id}）`;
        btn.addEventListener('click', () => { setTrailblazerId(avatar.id); refreshTrailblazerRow(); paint({ full: false }); });
        const img = el('img', 'vroster-icon');
        img.src = trailblazerIconUrl(avatar.id, trailblazerIconSample);
        img.alt = '';
        img.loading = 'lazy';
        btn.appendChild(img);
        const meta = el('div', 'vroster-meta');
        meta.append(
          el('span', 'vroster-name', avatar.gender === 'male' ? '男主' : '女主'),
          el('span', 'vroster-sub', `${avatarLabelOf(avatar)} · 头像 ${avatar.id}${chosen ? ' · 当前' : ''}`),
        );
        btn.appendChild(meta);
        pickerGrid.appendChild(btn);
      }
    }
    if (!pickerGrid.children.length) pickerGrid.appendChild(el('p', 'muted small', '没有匹配的开拓者命途。'));
    pickerTitle.textContent = `开拓者头像 · 当前 ${avatarLabelOf(selected)}（头像 ${selected.id}）`;
  }
  pickerSearch.addEventListener('input', renderPicker);
  picker.append(pickerTitle, pickerHint, pickerSearch, pickerGenderRow, pickerGrid);

  function paint({ full = true } = {}) {
    for (const btn of filterRow.children) {
      btn.classList.toggle('is-active', btn.dataset.only === filter.only);
    }
    if (full) {
      const needle = filter.text.toLowerCase();
      const rows = listChars.filter((key) => {
        const owned = chars.has(key);
        if (filter.only === 'have' && !owned) return false;
        if (filter.only === 'missing' && owned) return false;
        if (!needle) return true;
        const hay = `${zhOf(key)} ${pathName(charPaths[key])} ${key}`.toLowerCase();
        return hay.includes(needle);
      })
        // 已拥有的排前面，然后按中文名（用户是来「补人」的，先看见自己已经有的那一批）。
        .sort((a, b) => (chars.has(b) ? 1 : 0) - (chars.has(a) ? 1 : 0)
          || zhOf(a).localeCompare(zhOf(b)));
      list.replaceChildren(...rows.map((key) => renderRow(key, chars.has(key))));
      if (!rows.length) list.appendChild(el('p', 'muted small', '没有匹配的角色。'));
    }
    /** 已拥有的角色数不含「我为了保护开拓者而塞进去、但名单原文里并没有」的那几个形态。 */
    const ownedCount = [...chars.keys()].filter((key) => !injectedTrailblazers.has(key)).length;
    countLabel.textContent = `已拥有 ${ownedCount} 个角色 · ${cones.size} 把光锥`
      + `（共 ${allChars.length} 个角色可选）`;
    const noCone = [...chars.keys()].filter((key) => !preferredConeOf(key)
      || !charCones.has(key));
    hint.textContent = noCone.length
      ? `有 ${noCone.length} 个角色没配光锥（不影响持有判断）。`
      : '每个角色都配了光锥。';
    hint.classList.toggle('is-warn', noCone.length > 0);
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    hint.textContent = '正在保存…';
    hint.classList.remove('is-warn');
    try {
      /**
       * ⚠️ 发回去的名单要**先把我塞进去的开拓者形态摘掉**（见 `injectedTrailblazers`），
       * 只留承载行那一个 —— 否则每开一次编辑器，名单里就多写进 4 个用户没选过的形态。
       * 头像单独用 `roster.trailblazer = { id }` 回传（用户第 4 条）。
       */
      const outChars = Object.fromEntries([...chars].filter(([key]) => (
        !isTrailblazerKey(key) || key === trailblazerKey || !injectedTrailblazers.has(key)
      )));
      await api(`/api/virtual-accounts/${accountId}/roster`, {
        method: 'POST',
        body: {
          chars: outChars,
          cones: Object.fromEntries(cones),
          coneOwners: Object.fromEntries(owners),
          // 逐角色装备（**权威**，2026-10-14 第 1 条）：同一把**成本 0** 的锥可以被多个
          // 角色装备，而 `coneOwners`（锥 → 单个主人）表达不了 —— 不回传它的话，
          // 平铺档里 4★ 共用的那些锥一保存就全没了（用户报的「缺光锥」会复发）。
          charCones: Object.fromEntries(charCones),
          // 用户第 4 条：`roster.trailblazer = { id }`（服务端据此把承载行换成对应形态）。
          trailblazer: { id: trailblazerId },
        },
      });
      close();
      if (typeof onSaved === 'function') await onSaved();
    } catch (err) {
      saveBtn.disabled = false;
      hint.textContent = `保存失败：${err.message}`;
      hint.classList.add('is-warn');
    }
  });

  modal.hidden = false;
  renderPicker();
  paint();
  search.focus();
};
