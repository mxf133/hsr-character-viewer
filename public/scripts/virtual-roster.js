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
 * 某个角色在编辑器里**可选**的光锥。
 *
 * 三条约束（用户 2026-10-13 第 3 条原话「选择该角色**同命途**光锥，**专属光锥优先**」）：
 *   ① 只列与它**同命途**的（`refs.lightConePaths[锥] === refs.characterPaths[角色]`；
 *      命途数据缺失时放宽，只做下面的两条）；
 *   ② 已被**别人**选走的光锥不列（一把锥只挂一个人 —— 米游社快照里光锥是「装备中」的，
 *      没有独立库存。不排掉的话，界面给甲选了某把锥、服务端却按专属把它挂到乙身上）；
 *   ③ 它自己的**专属光锥排第一**（用户要求的「专属优先」）。
 *
 * ⚠️ 单独导出（而不是留在 `openVirtualRoster` 里）是为了**能在 Node 里测**：
 * 这一段是整块改动里唯一有分支的决策逻辑，而 CDP 套件要真浏览器（HANDOFF §5），
 * 本机环境里跑不到 —— 留在闭包里等于这段逻辑没有任何回归。
 *
 * @param {{charKey:string, refs:object, owners:Map<string,string>}} input
 */
export const coneChoicesFor = ({ charKey, refs, owners }) => {
  const conePaths = refs?.lightConePaths || {};
  const charPath = (refs?.characterPaths || {})[charKey];
  const all = Object.keys(refs?.availability?.lightCones || {});
  const signature = refs?.popularLightCones?.[charKey] || null;
  const list = all.filter((cone) => {
    if (charPath && conePaths[cone] && conePaths[cone] !== charPath) return false;
    const owner = owners?.get(cone) || null;
    return !owner || owner === charKey;
  });
  return list.sort((a, b) => (a === signature ? -1 : b === signature ? 1 : a.localeCompare(b)));
};

/**
 * 给一个角色配上它的专属光锥（如果那把锥还空着）——**「添加角色」时的默认动作**。
 * 返回 `{ cone, sup }` 或 `null`（没有专属锥 / 已被别人选走 / 命途不符）。
 */
export const defaultConeFor = ({ charKey, refs, owners }) => {
  const signature = refs?.popularLightCones?.[charKey] || null;
  if (!signature) return null;
  if (!refs?.availability?.lightCones?.[signature]) return null;
  if (owners?.get(signature) && owners.get(signature) !== charKey) return null;
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
  const charIcons = iconTable(refs.icons?.characters);
  const coneIcons = iconTable(refs.icons?.lightCones);
  const charPaths = refs.characterPaths || {};
  const conePaths = refs.lightConePaths || {};
  const pathLabels = refs.pathLabels || {};
  const signatureOf = (key) => refs.popularLightCones?.[key] || null;
  const pathName = (path) => pathLabels[path] || path || '—';

  // 名单：`chars` = 角色 → 星魂档；`cones` = 光锥 → 叠影；`owners` = 光锥 → 挂在谁身上。
  const roster = await api(`/api/virtual-accounts/${accountId}/roster`);
  const chars = new Map(Object.entries(roster?.roster?.chars || {}).map(([k, v]) => [k, Number(v) || 0]));
  const cones = new Map(Object.entries(roster?.roster?.cones || {}).map(([k, v]) => [k, Number(v) || 1]));
  const owners = new Map(Object.entries(roster?.roster?.coneOwners || {}));
  // 老账号 / 预设账号没记过主人：按「专属锥的主人」补一份（与服务端那条推法一致）。
  for (const [cone] of cones) {
    if (owners.has(cone)) continue;
    const owner = Object.keys(charPaths).find((c) => chars.has(c) && signatureOf(c) === cone);
    if (owner) owners.set(cone, owner);
  }

  const allChars = Object.keys(availability.characters || {});
  const zhOf = (key) => (refs.characters || []).find((c) => c.name === key)?.nameCn || key;
  const zhOfCone = (key) => (refs.lightCones || []).find((c) => c.name === key)?.nameCn || key;

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
  const coneChoices = (charKey) => coneChoicesFor({ charKey, refs, owners });

  /** 给一个角色配上它的专属锥（如果那把锥还空着）。**添加角色时的默认动作**。 */
  const equipSignature = (charKey) => {
    const pick = defaultConeFor({ charKey, refs, owners });
    if (!pick) return;
    cones.set(pick.cone, pick.sup);
    owners.set(pick.cone, charKey);
  };

  /** 行：一个角色（已拥有给三个下拉框，未拥有给「＋ 添加」）。 */
  const renderRow = (charKey, owned) => {
    const row = el('div', `vroster-row${owned ? ' is-owned' : ''}`);
    const icon = iconFor(charIcons, 'char', charKey);
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
      el('span', 'vroster-name', zhOf(charKey)),
      el('span', 'vroster-sub', `${pathName(charPaths[charKey])} · `
        + `${Number(availability.characters?.[charKey]?.rarity) || 4}★`
        + `${availability.characters?.[charKey]?.limited === false ? '' : ' · 限定'}`),
    );
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

    const current = [...owners].find(([, owner]) => owner === charKey)?.[0] || '';
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
      const stray = el('option', '', zhOfCone(current));
      stray.value = current;
      stray.selected = true;
      cone.appendChild(stray);
    }
    cone.addEventListener('change', () => {
      // 先把这个角色原来那把锥摘掉（一把锥只能挂一个人）。
      for (const [key, owner] of [...owners]) if (owner === charKey) { owners.delete(key); cones.delete(key); }
      if (cone.value) {
        cones.set(cone.value, cones.get(cone.value) || 1);
        owners.set(cone.value, charKey);
      }
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
      for (const [key, owner] of [...owners]) if (owner === charKey) { owners.delete(key); cones.delete(key); }
      paint();
    });
    tools.appendChild(remove);
    row.appendChild(tools);
    return row;
  };

  function paint() {
    for (const btn of filterRow.children) {
      btn.classList.toggle('is-active', btn.dataset.only === filter.only);
    }
    const needle = filter.text.toLowerCase();
    const rows = allChars.filter((key) => {
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
    countLabel.textContent = `已拥有 ${chars.size} 个角色 · ${cones.size} 把光锥`
      + `（共 ${allChars.length} 个角色可选）`;
    const noCone = [...chars.keys()].filter((key) => !signatureOf(key)
      || ![...owners.values()].includes(key));
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
      await api(`/api/virtual-accounts/${accountId}/roster`, {
        method: 'POST',
        body: {
          chars: Object.fromEntries(chars),
          cones: Object.fromEntries(cones),
          coneOwners: Object.fromEntries(owners),
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
  paint();
  search.focus();
};
