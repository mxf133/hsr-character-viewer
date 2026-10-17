// Front-end controller: QR login, account list, role switching, snapshot render.
//
// The browser never sees cookie material — the API only returns public account
// projections, role lists and record payloads.

import {
  cardStats, challengeSummary, charactersOf, displayName, elementName, formatDateTime,
  integer, lightConeOf, num, pathName, playerInfoOf, percent, rarityColor,
  rogueSummary,
} from './format.js';
import { mountAdviceView } from './advice-view.js';
// 角色面板与 kv 现在和抽卡推荐页共用一份实现（战斗记录里点角色也用它）。
import { kv } from './character-panel.js';
import { openCharacterPanel } from './character-modal.js';
import { openVirtualRoster } from './virtual-roster.js';
import { accessHeaders, readAccessToken } from './access.js';
// 命途 / 属性 的游戏内图标（九条命途 + 七种属性），见 game-icons.js。
import { elementIconUrl, gameIcon, pathIconUrl } from './game-icons.js';

const $ = (id) => document.getElementById(id);

/**
 * 角色面板的立绘：`{ character, lightCone }`。
 *
 * 角色信息页的角色直接来自米游社快照，而快照自带图，所以这里**不需要**查数据集：
 *   `character.image` = 750×1624 全身立绘（avatar_skin_image），实测 HTTP 200
 *   `character.icon`  = 160×188 头像（兜底）
 *   `character.equip.icon` = 该角色当前装备光锥的图
 * 全部来自米哈游自己的 CDN，不受 GitHub 可达性影响（那份数据集图标表在
 * raw.githubusercontent 上，本机超时——已改用 jsDelivr，但快照这条路更稳）。
 */
const panelArtFor = (character) => {
  if (!character) return null;
  return {
    character: character.image || character.icon || null,
    lightCone: character.equip?.icon || null,
  };
};

const el = {
  statusPill: $('statusPill'),
  logoutBtn: $('logoutBtn'),
  accountList: $('accountList'),
  addAccountBtn: $('addAccountBtn'),
  // 虚拟账号（用户 2026-10-12）：账号与角色面板上的「＋ 虚拟账号」与它的预设列表。
  virtualAccountBtn: $('virtualAccountBtn'),
  virtualAccountPanel: $('virtualAccountPanel'),
  virtualAccountList: $('virtualAccountList'),
  virtualAccountClose: $('virtualAccountClose'),
  // 程序图标（用户 2026-10-14 第 6 条）：顶栏那个可点的品牌图标 + 标签页图标。
  // ⚠️ 两个 id 由 `index.html` 提供（`#brandMark` 是 `<button>`、`#appIcon` 是
  // `<link rel="icon">`），改名要两边一起改。
  brandMark: $('brandMark'),
  appIcon: $('appIcon'),
  viewLogin: $('viewLogin'),
  viewDashboard: $('viewDashboard'),
  loginTitle: $('loginTitle'),
  loginCancel: $('loginCancel'),
  qrWrap: $('qrWrap'),
  qrImage: $('qrImage'),
  qrPlaceholder: $('qrPlaceholder'),
  qrStatus: $('qrStatus'),
  qrRefresh: $('qrRefresh'),
  toggleCookieBtn: $('toggleCookieBtn'),
  cookieForm: $('cookieForm'),
  cookieInput: $('cookieInput'),
  cookieSubmit: $('cookieSubmit'),
  cookieCancel: $('cookieCancel'),
  dashTitle: $('dashTitle'),
  dashSubtitle: $('dashSubtitle'),
  snapshotUpdated: $('snapshotUpdated'),
  roleSelect: $('roleSelect'),
  refreshBtn: $('refreshBtn'),
  warningBox: $('warningBox'),
  loadingBox: $('loadingBox'),
  errorBox: $('errorBox'),
  snapshot: $('snapshot'),
  toast: $('toast'),
  verifyModal: $('verifyModal'),
  geetestBox: $('geetestBox'),
  verifyStatus: $('verifyStatus'),
  verifyCancel: $('verifyCancel'),
  challengeInput: $('challengeInput'),
  challengeSubmit: $('challengeSubmit'),
  verifyRetry: $('verifyRetry'),
  verifyRecheck: $('verifyRecheck'),
  tabs: $('tabs'),
  layoutRecords: $('layoutRecords'),
  layoutAdvice: $('layoutAdvice'),
  appVersion: $('appVersion'),
  topbarVersion: $('topbarVersion'),
  appUpdateCheck: $('appUpdateCheck'),
  appUpdateResult: $('appUpdateResult'),
};

const state = {
  csrfToken: '',
  accounts: [],
  addingAccount: false,
  activeAccountId: null,
  activeUid: null,
  qrSessionId: null,
  qrTimer: null,
  qrDone: false,
  challenge: null,
  expanded: new Set(),
  snapshot: null,
  snapshotResponse: null,
  accessToken: '',
};

// ---------------------------------------------------------------- utilities

let toastTimer = null;
const toast = (message, kind = '') => {
  el.toast.textContent = stripJargon(message);
  el.toast.className = `toast show ${kind}`;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove('show');
    setTimeout(() => { el.toast.hidden = true; }, 250);
  }, 4200);
};

/**
 * Translate developer-facing error text into something a player can act on.
 * The API surfaces RetCode numbers and upstream wording; users only need to
 * know what happened and what to do.
 */
const stripJargon = (message) => {
  if (!message) return '';
  let text = String(message);

  // "获取开拓者总览失败：未知错误（该玩家未公开战绩，请在游戏内「资料 → 展示设置」中开启公开显示）"
  const parts = text.split('（');
  const main = parts[0];
  const hint = (parts[1] || '').replace(/）\s*$/, '');

  // Prefer the actionable hint when there is one.
  if (hint) text = hint;

  // Drop the "xxx失败：" prefix, keep the reason.
  text = text.replace(/^[^：]{0,12}失败：/, '');
  // Remove raw RetCode / HTTP chatter.
  text = text.replace(/[（(]?\s*retcode[=＝]\s*-?\d+\s*[）)]?/gi, '');
  text = text.replace(/[（(]?\s*HTTP\s*\d+\s*[）)]?/gi, '');
  text = text.replace(/未知错误/g, '服务返回异常');
  text = text.replace(/\s{2,}/g, ' ').trim();
  return text || main;
};

const roleIsEnabled = (role) => !role?.game || role.game === 'hsr';

const setStatus = (text, kind = 'pill-idle') => {
  el.statusPill.textContent = text;
  el.statusPill.className = `pill ${kind}`;
};

const api = async (path, options = {}) => {
  const headers = accessHeaders(options.headers || {});
  if (options.method && options.method !== 'GET') headers['x-hsr-csrf'] = state.csrfToken;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* non-JSON */ }
  if (!response.ok || !payload?.ok) {
    const message = response.status === 401
      ? (state.accessToken
        ? '访问令牌无效或已失效。请检查地址中的 #token=…，确认后重新加载页面。令牌仅保存在当前页面内存中。'
        : '此服务启用了访问令牌。请使用 #token=你的令牌 追加到地址后重新加载页面；令牌不会保存到本地。')
      : (payload?.error || `请求失败（HTTP ${response.status}）`);
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
};

const showError = (message) => {
  el.errorBox.textContent = stripJargon(message);
  el.errorBox.hidden = false;
};
const clearError = () => { el.errorBox.hidden = true; el.errorBox.textContent = ''; };

/**
 * Banner shown when a refresh was refused but we still have earlier data.
 * Tells the user the characters on screen are real but not current, why, and
 * what (not) to do about it.
 */
const showStaleNotice = (error, retcode) => {
  el.warningBox.innerHTML = '';
  const tip = document.createElement('div');
  tip.className = 'warn-lead';
  const isRisk = Number(retcode) === 10041 || Number(retcode) === 5003;
  tip.innerHTML = isRisk
    ? '⚠️ 以下角色是<b>上次同步</b>的数据，不是最新的。<br>'
      + '米游社返回「<b>当前账号存在风险，暂无数据</b>」，暂时拒绝提供战绩。'
      + '这是<b>临时</b>状态，通常几小时后自动解除。'
      + '期间请<b>不要反复点刷新</b>，那会延长限制时间。'
    : `⚠️ 以下角色是<b>上次同步</b>的数据，不是最新的。<br>原因：${stripJargon(error || '')}`;
  el.warningBox.appendChild(tip);
  el.warningBox.hidden = false;
};

const showWarnings = (warnings, snapshot) => {
  const list = Array.isArray(warnings) ? warnings : [];
  // A capped/gated battle record. The public profile card usually still works,
  // so this is a partial-result notice rather than a hard error.
  const gated = list.some((w) => [10035, 10041, 1034, 5003].includes(Number(w.retcode))
    || /未公开|风控|风险|验证|暂无战绩/.test(String(w.message)));
  const risky = list.some((w) => Number(w.retcode) === 10041 || /账号存在风险/.test(String(w.message)));
  // 1034 = the account may read the data once it passes a Geetest challenge.
  const needsVerify = list.some((w) => Number(w.retcode) === 1034);
  // 5003 is the account-level risk flag (Snap Hutao: 当前账号存在风险，暂无数据).
  const riskFlag = list.some((w) => Number(w.retcode) === 5003);
  // 10035 is Star Rail's undocumented "record service returned nothing" code.
  // It is NOT the in-game privacy switch - see src/mihoyo/errors.js.
  const noRecord = list.some((w) => Number(w.retcode) === 10035);
  const hasCard = Boolean(snapshot?.card);

  if (list.length === 0) {
    el.warningBox.hidden = true;
    el.warningBox.innerHTML = '';
    return;
  }

  el.warningBox.innerHTML = '';
  if (gated) {
    const tip = document.createElement('div');
    tip.className = 'warn-lead';
    if (needsVerify) {
      tip.innerHTML = '米游社要求先通过一次<b>验证码</b>才能读取战绩数据。'
        + '这一步必须在浏览器里完成（和 Snap Hutao 弹验证码是同一个机制）。';
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'btn btn-primary btn-sm';
      action.style.marginTop = '10px';
      action.textContent = '开始验证';
      action.addEventListener('click', () => openVerifyModal(state.activeAccountId));
      tip.appendChild(document.createElement('br'));
      tip.appendChild(action);
    } else if (risky) {
      tip.innerHTML = '米游社提示<b>操作过于频繁</b>，已暂时限制该账号访问战绩。'
        + '请<b>等待一段时间</b>再点「刷新数据」，期间不要反复重试。';
    } else if (riskFlag) {
      tip.innerHTML = '米游社返回「<b>当前账号存在风险，暂无数据</b>」——这是<b>临时</b>风控，'
        + '通常几小时后自动解除。期间请<b>不要反复点刷新</b>，那会延长限制时间。';
    } else if (noRecord) {
      // Root cause confirmed live: the account is flagged "可能存在异常" and the
      // OFFICIAL app refuses to render the record too, until a "依次点击"
      // challenge is passed once. Telling the user about a privacy switch they
      // already enabled is how this was misdiagnosed before.
      tip.innerHTML = '米游社把这个账号标记为<b>「可能存在异常」</b>，需要先完成<b>一次验证</b>。'
        + '（错误码 10035 是官方未公开含义的兜底码。）'
        + '<br><br>做法：用<b>米游社 App</b>打开官方星铁战绩页 → '
        + '会弹出「检测到账号可能存在异常，需要通过验证」→ 按提示<b>依次点击</b>图片完成验证 → '
        + '回到本页点「刷新数据」。'
        + '<br><br>验证只需做一次，之后角色、忘却之庭、实时便笺都会恢复正常。';
    } else {
      tip.innerHTML = hasCard
        ? '详细战绩未公开，已为你显示<b>公开的个人主页卡片</b>数据。'
          + '想看完整角色详情，请在<b>游戏内</b>开启战绩公开后点「刷新数据」。'
        : '详细战绩未公开。请在<b>游戏内</b>开启战绩公开后点「刷新数据」。';
    }
    el.warningBox.appendChild(tip);
  }
  const title = document.createElement('div');
  title.textContent = gated ? '未能获取的板块：' : '部分数据未能获取：';
  title.style.marginTop = gated ? '8px' : '0';
  el.warningBox.appendChild(title);
  const ul = document.createElement('ul');
  for (const warning of list) {
    const item = document.createElement('li');
    item.textContent = `${warning.section}：${stripJargon(warning.message)}`;
    ul.appendChild(item);
  }
  el.warningBox.appendChild(ul);
  el.warningBox.hidden = false;
};

// ------------------------------------------------------------- QR login flow

const stopQrPolling = () => {
  if (state.qrTimer) {
    clearInterval(state.qrTimer);
    state.qrTimer = null;
  }
};

const setQrStatus = (text, kind = '') => {
  el.qrStatus.textContent = text;
  el.qrStatus.className = `qr-status ${kind}`;
};

const startQrLogin = async () => {
  stopQrPolling();
  state.qrDone = false;
  state.qrSessionId = null;
  el.qrImage.hidden = true;
  el.qrPlaceholder.hidden = false;
  setQrStatus('正在获取二维码…');
  setStatus('等待扫码', 'pill-wait');

  try {
    const data = await api('/api/login/qr', { method: 'POST' });
    state.qrSessionId = data.sessionId;
    el.qrImage.src = `/api/login/qr/image?sessionId=${encodeURIComponent(data.sessionId)}`;
    el.qrImage.hidden = false;
    el.qrPlaceholder.hidden = true;
    setQrStatus('请使用米游社 App 扫码（二维码约 2 分钟有效）');
    el.qrTimer = setInterval(() => pollQrStatus(data.sessionId), 2000);
  } catch (err) {
    el.qrPlaceholder.hidden = false;
    setQrStatus(err.message, 'err');
    setStatus('获取二维码失败', 'pill-err');
  }
};

const pollQrStatus = async (sessionId) => {
  // Ignore results from a session we already moved on from (refresh/confirm).
  if (state.qrSessionId !== sessionId || state.qrDone) return;
  try {
    const data = await api(`/api/login/qr/status?sessionId=${encodeURIComponent(sessionId)}`);
    if (state.qrSessionId !== sessionId || state.qrDone) return;
    switch (data.status) {
      case 'Created':
        setQrStatus('等待扫码…');
        break;
      case 'Scanned':
        setQrStatus('已扫码，请在手机上确认登录', 'ok');
        setStatus('待确认', 'pill-wait');
        break;
      case 'Expired':
      case 'Cancelled':
        stopQrPolling();
        setQrStatus(`${data.message || '二维码已失效'} · 正在自动刷新…`, 'err');
        setStatus('二维码已失效', 'pill-err');
        // A ticket lives only ~2 minutes; refresh automatically so the user
        // does not have to click anything.
        state.qrSessionId = null;
        setTimeout(() => { if (!state.qrDone) startQrLogin(); }, 900);
        break;
      case 'Confirmed': {
        // Latch before any further work so late poll results are ignored.
        state.qrDone = true;
        stopQrPolling();
        setQrStatus('登录成功！', 'ok');
        setStatus('已登录', 'pill-ok');
        toast(data.account?.nickname ? `欢迎，${data.account.nickname}` : '登录成功', 'ok');
        if (data.roleError) toast(`角色列表获取失败：${data.roleError}`, 'err');
        state.addingAccount = false;
        state.activeAccountId = data.account?.id || null;
        state.activeUid = (data.roles || []).filter(roleIsEnabled)[0]?.uid ?? null;
        state.snapshot = null;
        await loadConfig();
        break;
      }
      default:
        break;
    }
  } catch (err) {
    if (state.qrSessionId !== sessionId || state.qrDone) return;
    stopQrPolling();
    setQrStatus(err.message, 'err');
    setStatus('登录失败', 'pill-err');
  }
};

// ----------------------------------------------------------- 程序图标（第 6 条）

/**
 * 程序图标（用户 2026-10-14 第 6 条：「图标默认为大黑塔的角色头像，点击可以更换」）。
 *
 * 改的落点有**两个**，必须同时改，否则「换了图标」只生效一半：
 *   ① 顶栏那个品牌图标（`.brand-mark`；`index.html` 里是 `<button id="brandMark">`，
 *      可点 → 开选择器，键盘 Tab 也能到）；
 *   ② 浏览器标签页的图标（`<link id="appIcon" rel="icon">` 的 `href`）。
 *
 * 存档只记**数据集英文键**（`localStorage['hsr.appIcon']`）：中文名会随译名变，
 * 存中文名的话改一次译名用户的图标就丢了。
 * ⚠️ 拿不到图标表（数据集还没采集）时**保持 `index.html` 里的 emoji 兜底**，
 * 不要写一个必然 404 的地址 —— 那是「图标坏掉」而不是「图标还没好」。
 */
const APP_ICON_KEY = 'hsr.appIcon';
/** 默认图标 = 大黑塔（没有任何存档时用它）。 */
const APP_ICON_DEFAULT = 'The Herta';

const readAppIconChar = () => {
  try { return localStorage.getItem(APP_ICON_KEY) || APP_ICON_DEFAULT; } catch { return APP_ICON_DEFAULT; }
};
const writeAppIconChar = (charKey) => {
  try { localStorage.setItem(APP_ICON_KEY, charKey); } catch { /* 隐私模式：记不住就记不住 */ }
};

/**
 * 某个角色的头像地址。图标表是按 **StarRailRes 的角色名**登记的，而角色键来自
 * theherta —— 两者对有多个形态的角色不一样（`March 7th (Hunt)` 只有 `March 7th`），
 * 所以掉一次括号后缀再找一遍（与服务端 `iconOf()` 的宽松回退同一口径）。
 */
const iconUrlOf = (index, charKey) => {
  const table = index?.refs?.icons?.characters || {};
  if (table[charKey]) return table[charKey];
  const base = String(charKey || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  return base && table[base] ? table[base] : null;
};

/** 角色的中文名（选择器与 tooltip 用；取不到就退回英文键）。 */
const charLabelOf = (index, charKey) => (index?.refs?.characters || [])
  .find((c) => c.name === charKey)?.nameCn || charKey;

/** 把「当前选中的角色头像」应用到顶栏 + 标签页图标。 */
const applyAppIcon = async () => {
  const key = readAppIconChar();
  let index = null;
  try { index = await adviceOf().ensureIndex(); } catch { index = null; }
  const url = iconUrlOf(index, key) || iconUrlOf(index, APP_ICON_DEFAULT);
  if (!url) return; // 没有图标表：保留 index.html 里的 emoji / ✦
  if (el.brandMark) {
    const img = document.createElement('img');
    img.className = 'brand-mark-img';
    img.alt = '';
    img.src = url;
    // ⚠️ `replaceChildren` 而不是 `appendChild`：重复调用（换图标之后）不能越堆越多。
    el.brandMark.replaceChildren(img);
    el.brandMark.title = `程序图标：${charLabelOf(index, key)}（点击更换）`;
  }
  if (el.appIcon) el.appIcon.href = url;
};

/** 角色头像选择器（点顶栏图标打开）。 */
const openIconPicker = async () => {
  let index = null;
  try {
    index = await adviceOf().ensureIndex();
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  const chars = (index?.refs?.characters || []).filter((c) => iconUrlOf(index, c.name));
  if (!chars.length) {
    toast('还没有图标数据：先在「抽卡推荐」页点「同步黑塔网数据」', 'err');
    return;
  }
  const current = readAppIconChar();
  const previous = document.getElementById('appIconPicker');
  if (previous) previous.remove();
  const modal = document.createElement('div');
  modal.id = 'appIconPicker';
  modal.className = 'modal';
  const card = document.createElement('div');
  card.className = 'modal-card icon-picker-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', '选择程序图标');
  const top = document.createElement('div');
  top.className = 'icon-picker-top';
  const head = document.createElement('h3');
  head.textContent = '选择程序图标';
  const hint = document.createElement('p');
  hint.className = 'muted small';
  hint.textContent = '默认是大黑塔。选中的头像会同时用在顶栏和浏览器标签页上，并记在本机。';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '搜索角色名';
  search.setAttribute('aria-label', '搜索角色');
  const grid = document.createElement('div');
  grid.className = 'icon-picker-grid';
  /**
   * 网格外面必须再套一个**可滚动的正文**（用户 2026-10-14 报「点击左上角头像，
   * 不能滚动选择头像的界面」）。
   *
   * 原因：这里最早直接用了通用的 `.modal-card` —— 那个类**没有 `max-height`**，
   * 于是 88 个头像把卡片撑得比视口还高，而 `.modal` 是 `place-items: center` 的居中网格，
   * 超出上下两边的部分就这么被切掉、**既看不见也滚不动**（页面锁死、卡片不动）。
   * 现在按仓库里高浮层的既有做法（见 app.css 的 `.advice-gold-card`）：
   * 卡片 `max-height` + flex 纵列 + `overflow: hidden`，正文 `min-height: 0` + `overflow-y: auto`。
   * ⚠️ `min-height: 0` **不能省** —— flex 子项默认 `min-height: auto`，不写它长内容会把卡片撑破、
   * 正文的 `overflow-y` 直接失效（那条注释在 `.advice-gold-card` 上面已经踩过一次）。
   */
  const body = document.createElement('div');
  body.className = 'icon-picker-body';
  body.appendChild(grid);
  const actions = document.createElement('div');
  actions.className = 'icon-picker-actions';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn btn-ghost btn-sm';
  reset.textContent = '恢复默认（大黑塔）';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-ghost btn-sm';
  close.textContent = '关闭';
  actions.append(reset, close);
  top.append(head, hint, search);
  card.append(top, body, actions);
  modal.appendChild(card);
  document.body.appendChild(modal);

  const closePicker = () => {
    modal.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); closePicker(); }
  };
  document.addEventListener('keydown', onKey);
  close.addEventListener('click', closePicker);
  modal.addEventListener('click', (event) => { if (event.target === modal) closePicker(); });

  const pick = async (charKey) => {
    writeAppIconChar(charKey);
    await applyAppIcon();
    closePicker();
    toast(`程序图标已改为 ${charLabelOf(index, charKey)}`, 'ok');
  };
  reset.addEventListener('click', () => { void pick(APP_ICON_DEFAULT); });

  const renderGrid = () => {
    const needle = search.value.trim().toLowerCase();
    const rows = chars.filter((c) => !needle
      || `${c.nameCn || ''} ${c.name}`.toLowerCase().includes(needle));
    grid.replaceChildren(...rows.slice(0, 200).map((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `icon-picker-item${c.name === current ? ' is-active' : ''}`;
      btn.title = c.nameCn || c.name;
      const img = document.createElement('img');
      img.src = iconUrlOf(index, c.name);
      img.alt = '';
      img.loading = 'lazy';
      const label = document.createElement('span');
      label.textContent = c.nameCn || c.name;
      btn.append(img, label);
      btn.addEventListener('click', () => { void pick(c.name); });
      return btn;
    }));
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'muted small';
      empty.textContent = '没有匹配的角色。';
      grid.replaceChildren(empty);
    }
  };
  search.addEventListener('input', renderGrid);
  renderGrid();
  modal.hidden = false;
  search.focus();
};

// ------------------------------------------------------------------- account

const renderAccounts = () => {
  el.accountList.innerHTML = '';
  if (state.accounts.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '尚未登录。使用右侧二维码登录米游社后，账号会出现在这里。';
    el.accountList.appendChild(p);
    return;
  }

  for (const account of state.accounts) {
    const card = document.createElement('div');
    card.className = `account-card${account.id === state.activeAccountId ? ' active' : ''}`;

    // 虚拟账号（用户 2026-10-12）：卡片上先挂一枚标记，一眼能区分「真实登录的账号」
    // 与「为试各种角色池而建的假账号」—— 免得用户以为自己的账号被动过。
    if (account.source === 'virtual') {
      const flag = document.createElement('span');
      flag.className = 'virtual-flag';
      flag.textContent = '虚拟账号';
      flag.title = '本机构造的角色池，用来试抽卡方案；与你的米游社账号无关。';
      card.appendChild(flag);
    }

    const chips = document.createElement('div');
    chips.className = 'role-chips';
    const roles = (account.roles || []).filter(roleIsEnabled);
    if (roles.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'muted small';
      empty.textContent = '未找到星穹铁道角色';
      chips.appendChild(empty);
    }
    for (const role of roles) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `role-chip${account.id === state.activeAccountId && role.uid === state.activeUid ? ' active' : ''}`;
      chip.textContent = `${role.nickname || '开拓者'} · Lv.${role.level ?? '?'}`;
      chip.title = `UID ${role.uid}`;
      chip.addEventListener('click', (event) => {
        event.stopPropagation();
        selectAccount(account.id, role.uid);
      });
      chips.appendChild(chip);
    }
    card.appendChild(chips);

    const actions = document.createElement('div');
    actions.className = 'account-actions';
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'btn btn-ghost btn-sm';
    refresh.textContent = '刷新角色';
    refresh.addEventListener('click', async (event) => {
      event.stopPropagation();
      refresh.disabled = true;
      try {
        const data = await api(`/api/accounts/${account.id}/roles`, { method: 'POST' });
        toast(`已更新 ${data.roles.length} 个角色`, 'ok');
        await loadConfig();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        refresh.disabled = false;
      }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-ghost btn-sm btn-danger';
    remove.textContent = '删除';
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!window.confirm('确定要删除这个账号的本地登录凭证吗？')) return;
      try {
        await api(`/api/accounts/${account.id}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        if (state.activeAccountId === account.id) {
          state.activeAccountId = null;
          state.activeUid = null;
          state.snapshot = null;
          renderView();
        }
        await loadConfig();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    // ---- 虚拟账号专属的两个动作（用户 2026-10-14 第 5 条）------------------------
    //
    // ① 「**新增同配置虚拟账号**」：按钮就放在**这个真实账号自己的选项框里**
    //    （用户原话：「该按钮位于此用户的真实账号的选项框内」）。它把该账号
    //    **当前选中角色**的角色 / 星魂 / 光锥整份复制成一个虚拟账号，用来试抽卡方案
    //    —— 源账号只读不动（服务端那条路由的注释里写了为什么不会碰到它）。
    // ② 「重命名」：只给虚拟账号（真实账号的昵称来自米游社，本地改会被下一次刷新覆盖）。
    if (account.source === 'virtual') {
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'btn btn-ghost btn-sm';
      rename.textContent = '重命名';
      rename.title = '给这个虚拟账号改个名字';
      rename.addEventListener('click', async (event) => {
        event.stopPropagation();
        const next = window.prompt('给这个虚拟账号改个名字：', account.nickname || '');
        if (next === null) return;
        try {
          await api(`/api/virtual-accounts/${account.id}/rename`, {
            method: 'POST', body: { nickname: next },
          });
          toast('已重命名', 'ok');
          await loadConfig();
        } catch (err) {
          toast(err.message, 'err');
        }
      });
      actions.appendChild(rename);
    } else {
      const clone = document.createElement('button');
      clone.type = 'button';
      clone.className = 'btn btn-ghost btn-sm';
      clone.textContent = '新增同配置虚拟账号';
      clone.title = '把当前选中角色的角色 / 星魂 / 光锥复制成一个虚拟账号，用来试抽卡方案；不会动你的真实账号';
      clone.addEventListener('click', async (event) => {
        event.stopPropagation();
        clone.disabled = true;
        try {
          // 用**这个账号当前选中的角色**；不是当前账号时用它自己的第一个角色。
          const uid = state.activeAccountId === account.id
            ? state.activeUid
            : ((account.roles || []).filter(roleIsEnabled)[0]?.uid ?? null);
          const data = await api('/api/virtual-accounts/from-account', {
            method: 'POST', body: { accountId: account.id, uid },
          });
          toast(data.skipped
            ? `已新建 ${data.account?.nickname || '虚拟账号'}（有 ${data.skipped} 项没能复制）`
            : `已新建 ${data.account?.nickname || '虚拟账号'}`, 'ok');
          const keepId = data.account?.id || null;
          await loadConfig();
          const created = state.accounts.find((a) => a.id === keepId);
          const newUid = created?.roles?.[0]?.uid || null;
          if (created && newUid) await selectAccount(created.id, newUid);
          else renderView();
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          clone.disabled = false;
        }
      });
      actions.appendChild(clone);
    }
    actions.append(refresh, remove);
    card.appendChild(actions);

    card.addEventListener('click', () => selectAccount(account.id));
    el.accountList.appendChild(card);
  }
};

const renderView = () => {
  const loggedIn = state.accounts.length > 0;
  el.viewLogin.hidden = loggedIn && !state.addingAccount;
  el.viewDashboard.hidden = !loggedIn || state.addingAccount;
  el.logoutBtn.hidden = !loggedIn || state.addingAccount;
  el.addAccountBtn.hidden = !loggedIn;
  el.loginCancel.hidden = !state.addingAccount;
  el.loginTitle.textContent = state.addingAccount ? '添加米游社账号' : '扫码登录米游社';
  if (loggedIn) {
    const account = state.accounts.find((a) => a.id === state.activeAccountId);
    el.dashTitle.textContent = state.activeUid ? '角色信息' : '选择角色';
    const role = account?.roles.find((r) => r.uid === state.activeUid && roleIsEnabled(r));
    el.dashSubtitle.textContent = role
      ? `UID ${role.uid} · ${role.regionName || role.region || ''}`
      : '请选择一个角色以查询战绩';
  }
};

const renderRoleSelect = () => {
  const account = state.accounts.find((a) => a.id === state.activeAccountId);
  const roles = (account?.roles || []).filter(roleIsEnabled);
  el.roleSelect.innerHTML = '';
  if (roles.length === 0) {
    const option = document.createElement('option');
    option.textContent = '没有可用角色';
    option.value = '';
    el.roleSelect.appendChild(option);
    el.roleSelect.disabled = true;
    return;
  }
  el.roleSelect.disabled = false;
  for (const role of roles) {
    const option = document.createElement('option');
    option.value = role.uid;
    option.textContent = `${role.nickname || '开拓者'} · UID ${role.uid} · Lv.${role.level ?? '?'}`;
    if (role.uid === state.activeUid) option.selected = true;
    el.roleSelect.appendChild(option);
  }
};

const selectAccount = async (accountId, uid) => {
  if (state.addingAccount) {
    stopQrPolling();
    state.qrSessionId = null;
    state.qrDone = true;
    state.addingAccount = false;
  }
  const previousAccountId = state.activeAccountId;
  state.activeAccountId = accountId;
  const account = state.accounts.find((a) => a.id === accountId);
  const roles = (account?.roles || []).filter(roleIsEnabled);
  const requestedRole = roles.find((role) => role.uid === uid);
  const previousRole = previousAccountId === accountId
    ? roles.find((role) => role.uid === state.activeUid)
    : null;
  state.activeUid = requestedRole?.uid || previousRole?.uid || roles[0]?.uid || null;
  state.snapshot = null;
  state.expanded.clear();
  el.snapshot.hidden = true;
  renderAccounts();
  renderRoleSelect();
  setStatus('已登录', 'pill-ok');
  // ⚠️ **先等快照，再画页面**：抽卡方案的差额是**按当前快照现算**的
  // （`mountAdviceView` 通过 `getSnapshot()` 现取），早画会让它拿上一份（或空）快照
  // 算出另一套名次。代价只是切换时多转一会儿圈（加载态本来就有）。
  if (state.activeUid) await loadSnapshot();
  renderView();
  // ⚠️ 还必须**显式重画一次抽卡页**：`renderView()` 只切登录/面板的显隐，抽卡那页是
  //    `selectTab('advice')` 调的 `show()` 画的 —— 不补这一句，切账号后方案会静静停在
  //    旧账号的数字上（实测踩到：切到「虚拟·白厄队」后首卡仍是「全新账号」那套）。
  //    只在抽卡页当前可见时才画，免得白算一遍 teamPlan。
  if (activeTab() === 'advice') await adviceOf().show();
};

// ---------------------------------------------- 1034 验证（Geetest）
//
// miHoYo answers `1034` when an account must clear a Geetest challenge before
// the record API will serve character data. Snap Hutao solves this by rendering
// the Geetest widget inside WebView2; we do the equivalent by loading Geetest's
// official script into this page and letting the user drag the slider.

const GT_SCRIPT = 'https://static.geetest.com/v4/gt4.js';

let gtScriptPromise = null;
const loadGeetest = () => {
  if (window.initGeetest4) return Promise.resolve();
  if (gtScriptPromise) return gtScriptPromise;
  gtScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GT_SCRIPT;
    script.async = true;
    script.onload = () => (window.initGeetest4 ? resolve() : reject(new Error('Geetest 脚本加载后未就绪')));
    script.onerror = () => reject(new Error('无法加载 Geetest 脚本（可能被网络或广告拦截插件阻止）'));
    document.head.appendChild(script);
  }).catch((err) => {
    gtScriptPromise = null;
    throw err;
  });
  return gtScriptPromise;
};

const closeVerifyModal = () => {
  el.verifyModal.hidden = true;
  el.geetestBox.innerHTML = '';
  state.pendingVerify = null;
};

const openVerifyModal = async (accountId) => {
  el.verifyModal.hidden = false;
  el.geetestBox.innerHTML = '<div class="spinner" aria-hidden="true"></div>';
  el.verifyStatus.textContent = '正在向米游社申请验证…';

  try {
    const data = await api('/api/verify/challenge', {
      method: 'POST',
      body: { accountId, kind: 'list' },
    });
    const { id, gt, challenge } = data.challenge;
    state.pendingVerify = { id, accountId };

    await loadGeetest();
    // Geetest v4 renders either inline (appendTo) or as a popup (showCaptcha),
    // depending on the widget type miHoYo returns. Try inline, then fall back to
    // the popup, so the box is never silently empty.
    const holderId = 'geetestHolder';
    el.geetestBox.innerHTML = `<div id="${holderId}"></div>`;
    el.verifyStatus.textContent = '正在加载验证组件…';
    const host = document.getElementById(holderId);
    const renderedNodes = () => (host ? host.querySelectorAll('[class*=geetest]').length : 0);

    window.initGeetest4({
      gt,
      challenge,
      language: 'zh-cn',
      protocol: 'https://',
      product: 'bind',
      riskType: 'slide',
    }, (captcha) => {
      if (!captcha) {
        el.verifyStatus.textContent = '验证组件初始化失败，请点「重新验证」再试';
        return;
      }

      const render = () => {
        if (typeof captcha.appendTo === 'function') {
          try { captcha.appendTo(holderId); } catch { /* try the popup path */ }
        }
        if (renderedNodes() === 0 && typeof captcha.showCaptcha === 'function') {
          try { captcha.showCaptcha(); } catch (err) {
            el.verifyStatus.textContent = `无法显示验证码：${err.message}`;
          }
        }
        // Surface a stuck state instead of failing silently.
        el.verifyStatus.textContent = renderedNodes() > 0
          ? '请完成下方验证'
          : '验证组件未渲染，请点「重新验证」；若持续失败请反馈';
      };

      captcha.onReady(render);
      captcha.onSuccess(() => {
        const result = typeof captcha.getValidate === 'function' ? captcha.getValidate() : null;
        if (!result) {
          el.verifyStatus.textContent = '未取到验证结果，请点「重新验证」再试';
          return;
        }
        submitSolved(result);
      });
      captcha.onClose(() => { el.verifyStatus.textContent = '已取消验证，可点「重新验证」重试'; });
      captcha.onError((err) => {
        const detail = err?.msg || err?.error_code || err?.message || '未知';
        el.verifyStatus.textContent = `验证组件报错：${detail}`;
      });
      // Defensive: if onReady never fires, attempt to render anyway.
      setTimeout(() => { if (renderedNodes() === 0) render(); }, 3000);
    });
  } catch (err) {
    el.verifyStatus.textContent = stripJargon(err.message);
    el.geetestBox.innerHTML = '<p class="muted small">无法申请验证，请点「重新验证」再试。</p>';
  }
};

/** Re-request a fresh challenge and render it again. */
const retryVerify = () => {
  const pending = state.pendingVerify;
  const accountId = pending?.accountId || state.activeAccountId;
  openVerifyModal(accountId);
};

const submitSolved = async (result) => {
  const pending = state.pendingVerify;
  if (!pending) return;
  el.verifyStatus.textContent = '验证通过，正在确认…';
  try {
    const data = await api('/api/verify/solve', {
      method: 'POST',
      body: {
        challengeId: pending.id,
        validate: result.geetest_validate,
        seccode: result.geetest_seccode,
        challenge: result.geetest_challenge,
      },
    });
    state.challenge = data.challenge;
    el.verifyStatus.textContent = '验证成功，正在重新读取数据…';
    closeVerifyModal();
    toast('验证成功，正在刷新数据', 'ok');
    await loadSnapshot(true);
  } catch (err) {
    el.verifyStatus.textContent = `${stripJargon(err.message)}（可以重新拖动滑块再试）`;
  }
};

// ------------------------------------------------------------------ snapshot

const loadSnapshot = async (refresh = false) => {
  if (!state.activeAccountId || !state.activeUid) return;
  clearError();
  showWarnings(null);
  el.snapshotUpdated.hidden = true;
  el.snapshotUpdated.textContent = '';
  el.snapshot.hidden = true;
  el.loadingBox.hidden = false;
  try {
    const url = `/api/accounts/${state.activeAccountId}/roles/${state.activeUid}/snapshot${refresh ? '?refresh=1' : ''}`;
    // A solved 1034 verification yields a single-use `x-rpc-challenge`.
    // Re-sending it poisons every later request (the record API
    // answers 1008 instead of real data), so consume it here unconditionally.
    const challenge = state.challenge;
    state.challenge = null;
    const headers = challenge ? { 'x-hsr-challenge': challenge } : {};
    const data = await api(url, refresh ? { method: 'POST', headers } : { headers });
    state.snapshotResponse = data;
    state.snapshot = data.snapshot ? { ...data.snapshot, cacheMeta: data.cache || null, cached: Boolean(data.cached), degraded: Boolean(data.degraded) } : data.snapshot;
    renderSnapshot(data.snapshot);
    if (data.degraded) {
      // The refresh failed and we are showing previously synced characters -
      // the same behaviour Snap Hutao has when its API calls are blocked.
      toast(`米游社暂时拒绝返回数据（${stripJargon(data.error || '')}），已显示上次同步的角色`, 'warn');
      showStaleNotice(data.error, data.retcode);
    } else if (data.throttled) {
      // 服务端限流挡住了连点（用户 2026-10：过多的请求会导致数据爬取出错）。
      // 说清楚是「请求太密」而不是「没数据」，并告诉还要等多久。
      toast(`刚才已经请求过米游社，为避免触发风控请稍后再试（约 ${Math.ceil((data.retryAfterMs || 0) / 1000)} 秒）`, 'warn');
    }
    // 「读本地」是**默认路径**，不再弹 toast —— 以前只有缓存新鲜时才走这里，
    // 现在每次打开页面都会走，弹一次就成了噪音。说明放在下面那行更新时间里。
  } catch (err) {
    showError(err.message);
  } finally {
    el.loadingBox.hidden = true;
  }
};

const statCard = (label, value, small = false, hint = '') => {
  const box = document.createElement('div');
  box.className = 'stat';
  if (hint) box.title = hint;
  const l = document.createElement('div');
  l.className = 'stat-label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = `stat-value${small ? ' small' : ''}`;
  v.textContent = value;
  box.append(l, v);
  return box;
};

const sectionTitle = (text) => {
  const h = document.createElement('div');
  h.className = 'section-title';
  h.textContent = text;
  return h;
};

/** kv 行来自 character-panel.js（与角色面板共用）。 */

/**
 * 从别的分页点一个角色：切回「角色信息」页、展开那张卡、滚过去并闪一下。
 *
 * 战斗记录里只有数字 id，所以先按 id 找（最准）；找不到再按中文名，最后按
 * 「•」前的基础名（开拓者的各形态、皮肤写法在这个口径下能对上）。
 * 助战角色不在自己的角色列表里，这时返回 false，让调用方给出提示。
 */
const revealCharacter = (id, name) => {
  const characters = charactersOf(state.snapshot);
  if (!characters.length) return false;
  const keyOf = (c) => String(c.id ?? c.avatar_id ?? c.avatarId ?? '');
  const base = (value) => String(value || '').split(/[•·]/)[0].trim();
  const target = characters.find((c) => keyOf(c) && keyOf(c) === String(id))
    || characters.find((c) => name && displayName(c.name) === name)
    || characters.find((c) => name && base(displayName(c.name)) === base(name));
  if (!target || !keyOf(target)) return false;
  state.expanded.add(keyOf(target));
  selectTab('records');
  renderSnapshot(state.snapshot);
  const node = el.snapshot.querySelector(`.char-card[data-char-id="${keyOf(target)}"]`);
  if (node) {
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('is-flash');
    setTimeout(() => node.classList.remove('is-flash'), 1500);
  }
  return true;
};

// --------------------------------------------------- 角色列表排序（第 8 条）

/**
 * 中文名 → 命途键（`{ '巡猎' … }`），由 `refs.characters` 的 `{ name, nameCn }` 与
 * `refs.characterPaths` 的 `{ 英文键: 'Rogue' }` 现算一次。
 *
 * ⚠️ 只是把**已有的两份**数据对成一张表，不新增任何口径：命途的唯一来源仍是数据集
 * （`theherta/character_paths.json`），中文名仍是 `i18n-zh.json`。
 */
const pathByCnOf = (chars, paths) => {
  const map = new Map();
  for (const row of chars || []) {
    const key = paths?.[row?.name];
    if (key && row?.nameCn && !map.has(row.nameCn)) map.set(row.nameCn, key);
  }
  return map;
};

/**
 * avatar_id → 命途键，**只覆盖多形态角色**（三月七 ×2、开拓者 ×5）。
 *
 * 为什么还需要它：快照里这些角色的中文名是光秃秃的「三月七」「开拓者」，而数据集把
 * 每个形态拆成带命途的英文键（「三月七•存护」/「开拓者•毁灭」）—— 按名字反查不到。
 * id 是唯一的，所以按 id 查 `refs.formAvatarIds`（= 服务端 `FORM_AVATAR_ID`）。
 *
 * ⚠️ 开拓者的表里只有**奇数 id**（男主），偶数 id 是同命途的女主，两张卡在游戏里是
 * 「同一个角色换性别」，所以 `+1` 直接对到同一个键；**只对 8001–8010 这么做** ——
 * 三月七的 1001+1 = 1002 是丹恒，加一就串人了。
 */
const pathByIdOf = (formAvatarIds, paths) => {
  const map = new Map();
  for (const [key, rawId] of Object.entries(formAvatarIds || {})) {
    const path = paths?.[key];
    const id = Number(rawId);
    if (!path || !Number.isFinite(id)) continue;
    map.set(id, path);
    if (id >= 8001 && id <= 8010) map.set(id + 1, path);
  }
  return map;
};

/**
 * `avatar_id → 属性`（`refs.characterElements`，服务端 `character-elements.js`）。
 *
 * 为什么要这张表：真实账号的属性来自米游社 `index.avatar_list`，**虚拟账号没有那个数组**
 * —— 不补的话，虚拟账号的角色卡只能显示命途，属性那半句（和它的图标）永远空着。
 * 只补缺、不改原件：快照自带的 `element` 优先（见 `withCharacterMeta()`）。
 *
 * ⚠️ 开拓者的表里只有**奇数 id**（男主），偶数 id 是同形态的女主 —— 虚拟账号的头像
 * 从 8001~8010 里随机挑，`+1` 直接对到同一个属性；**只对 8001–8010 这么做**
 * （与 `pathByIdOf()` 同一条规则：三月七 1001+1 = 1002 是丹恒）。
 */
const elementByAvatarIdOf = (table) => {
  const map = new Map();
  for (const [rawId, element] of Object.entries(table || {})) {
    const id = Number(rawId);
    if (!Number.isFinite(id) || !element) continue;
    map.set(id, element);
    if (id >= 8001 && id <= 8010) map.set(id + 1, element);
  }
  return map;
};

/**
 * 角色列表的排序键：`/api/archive` 的 `refs.debutOrder`（`{ 英文键: 序号 }`，
 * 序号**越大越新**）+ `refs.characters`（英文键 ↔ 中文名对照）。
 *
 * 排序口径全在服务端 `src/server/character-debut.js` 的 `buildDebutOrder()` 里
 * （① 黑塔网 `firstSeen` ② wiki 实装版本 ③ avatar_id），前端**只做一次降序查表** ——
 * 不在这里再抄一份版本比较函数（本仓库版本比较只允许有一份实现）。
 */
let debutOrderCache = null;
let debutOrderPromise = null;
const ensureDebutOrder = async () => {
  if (debutOrderCache) return debutOrderCache;
  if (!debutOrderPromise) {
    debutOrderPromise = adviceOf().ensureIndex()
      .then((index) => {
        const chars = index?.refs?.characters || [];
        const paths = index?.refs?.characterPaths || {};
        debutOrderCache = {
          order: index?.refs?.debutOrder || {},
          byId: index?.refs?.debutOrderById || {},
          chars,
          // 角色卡上的命途（用户 2026-10-17 第 2 条）：真实账号的快照里**没有**
          // `path`，只能按中文名从数据集反查；虚拟账号的快照自带 `path`，优先用那个。
          paths,
          // 命途中文名的权威那份（服务端 `refs.pathLabels`，含「欢愉」；
          // `format.js` 那张 `PATH_LABELS` 只是兜底）。
          pathLabels: index?.refs?.pathLabels || {},
          pathByCn: pathByCnOf(chars, paths),
          // 多形态角色（三月七 / 开拓者）按 id 反查命途，见 `pathByIdOf()`。
          pathById: pathByIdOf(index?.refs?.formAvatarIds, paths),
          // 属性按 avatar_id 查（用户 2026-10-18「属性要显示图标，虚拟账户也要」）：
          // 真实账号的快照自带 `element`，虚拟账号的**没有** —— 那张表是唯一来源。
          elementById: elementByAvatarIdOf(index?.refs?.characterElements),
        };
        return debutOrderCache;
      })
      // 数据集还没采集 / 读取失败：退化成空表，`sortCharactersByDebut()` 会走
      // 「按 avatar_id 升序」的固定兜底，而**不是**抛异常让整块列表消失。
      // ⚠️ **一定要把原因印出来**（本仓库吃过的教训：`catch {}` 吞掉的异常会让一个
      //    功能静默退化成「另一套口径」，谁也看不出哪里坏了 —— 见 `advice-view.js` 里
      //    那个被吞了很久的 `ReferenceError`）。这里只是降级，不影响页面可用性，
      //    所以用 `console.warn` 而不是弹 toast。
      .catch((err) => {
        console.warn('[角色列表] 拿不到登场版本表，退回 avatar_id 升序：', err);
        debutOrderCache = {
          order: {}, byId: {}, chars: [], paths: {}, pathLabels: {},
          pathByCn: new Map(), pathById: new Map(), elementById: new Map(),
        };
        return debutOrderCache;
      })
      .finally(() => { debutOrderPromise = null; });
  }
  return debutOrderPromise;
};

/**
 * 把角色列表按「**黑塔网首次登场版本降序**（最新的角色在前，旧角色在后）」排好。
 *
 * 用户 2026-10-16 第 8 条原话：「角色信息-角色列表要按照该角色在黑塔网首次登场的版本排序，
 * 最新的角色在前，旧角色在后（再老的角色排序顺序固定，请参考 wiki 的登场时间排序），
 * 且支持未来的新角色登场后自动排序在前」。
 *
 * 三层（与服务端 `buildDebutOrder()` 同一套，见 `refs.debutOrder`）：
 *   ① `debutOrder[英文键]` / `debutOrderById[avatar_id]` 降序 —— 主键；数据集现算的
 *      `firstSeen` 打平的那 51 个旧角色由 ②③（wiki 实装版本 / avatar_id）摊开，
 *      **未来新角色**的 firstSeen 必然最新 → 自动排最前，无需改代码；
 *   ②③ 已经在服务端的序号里了，前端看不到也不需要再算。
 *
 * 匹配顺序：**先 avatar_id、再中文名**。多形态角色只报一个中文名（三月七 / 开拓者），
 * 按名字匹配会全部落进兜底；而 id 是唯一的（1001/1224、8001..8010），能精确对上。
 *
 * ⚠️ **兜底必须与快照返回顺序、`localeCompare` 都无关**（用户明确要求「再老的角色排序
 * 顺序固定」）：取不到序号的角色（虚拟账号里将来可能加的人造角色、id 与名字都认不出的）
 * 一律排到最后，组内按 **avatar_id 升序**（固定），id 也缺失时再按**稳定的原下标**保序。
 * 这样同一份数据每次渲染的顺序完全一致，不会随数据集刷新而漂。
 *
 * 卡片外观与「＋ 添加/修改角色」那张尾卡**不动**（那张卡不在 `characters` 里，由调用方另加）。
 */
const sortCharactersByDebut = (characters, cache = {}) => {
  if (!Array.isArray(characters) || characters.length < 2) return characters;
  const { order = {}, byId = {}, chars = [] } = cache;
  const cnToEn = new Map();
  for (const row of chars) {
    if (row?.nameCn && row?.name && !cnToEn.has(row.nameCn)) cnToEn.set(row.nameCn, row.name);
  }
  const idOf = (character) => {
    const n = Number(character?.id ?? character?.avatar_id ?? character?.avatarId);
    return Number.isFinite(n) ? n : null;
  };
  const rankOf = (character) => {
    const id = idOf(character);
    if (id !== null && byId[id] !== undefined) return Number(byId[id]);
    // 快照的 `name` 就是中文名（`displayName` 把 `{NICKNAME}` 折成「开拓者」）。
    const key = cnToEn.get(displayName(character?.name));
    const rank = key !== undefined ? Number(order[key]) : NaN;
    return Number.isFinite(rank) ? rank : -1;
  };
  return characters
    .map((character, index) => ({ character, index, rank: rankOf(character) }))
    .sort((a, b) => (b.rank - a.rank)
      || ((idOf(a.character) ?? Number.MAX_SAFE_INTEGER) - (idOf(b.character) ?? Number.MAX_SAFE_INTEGER))
      || (a.index - b.index))
    .map((entry) => entry.character);
};

// ------------------------------------------- 角色卡的「命途 / 属性」（2026-10-17 第 2 条）

/**
 * 属性英文键 → 卡片配色用的键（`Thunder` 与 `Lightning` 都是雷，统一成 `lightning`）。
 * 颜色本身写在 CSS 的 `.char-el[data-element=…]` 里，JS 不持有一份色板。
 */
const ELEMENT_COLOR_KEYS = {
  physical: 'physical', fire: 'fire', ice: 'ice',
  thunder: 'lightning', lightning: 'lightning',
  wind: 'wind', quantum: 'quantum', imaginary: 'imaginary',
};

/**
 * 快照里 `index.avatar_list` 的 `id → 属性`。
 *
 * 为什么需要这条兜底：角色列表优先用 `avatar/info`（`charactersOf()` 的第一顺位），
 * 而**那一侧不带 `element`**；同一次快照里的 `index.avatar_list` 每项都带
 * （`tools/hsr-parse-test.mjs` 就钉在实测样本的这个字段上）。取不到就留空 ——
 * 不猜、也不写死一张「角色 → 属性」表。
 */
const elementByIdOf = (snapshot) => {
  const map = new Map();
  for (const row of snapshot?.index?.avatar_list || []) {
    const id = Number(row?.id ?? row?.avatar_id);
    if (Number.isFinite(id) && row?.element && !map.has(id)) map.set(id, row.element);
  }
  return map;
};

/**
 * 给快照里的角色补齐 `path` / `element`（**只补不改**：快照自带的永远优先）。
 *
 * 三处来源（用户 2026-10-17 第 2 条「角色列表需要显示属性和命途」）：
 *   * `path`：虚拟账号的快照自带（服务端从 `refs.characterPaths` 补的）；真实账号没有，
 *     先按 **avatar_id** 查多形态表（三月七 / 开拓者），再按**中文名**查数据集 ——
 *     两张表都来自排序用的那次 `/api/archive`，不额外打接口；
 *   * `element`：快照角色自己没有就按 `id` 从 `index.avatar_list` 拿（见 `elementByIdOf`），
 *     连 `index` 都没有（= 虚拟账号）就查 `refs.characterElements`（用户 2026-10-18：
 *     「属性要显示图标，**虚拟账户**也要这样显示」）。
 *
 * ⚠️ 返回的可能是**同一个对象**（没有可补的字段时不复制）：`state.expanded`、点击回调
 * 都按引用/`id` 走，多造一层副本没有好处；一旦要补就返回浅拷贝，绝不去改 `state.snapshot`。
 */
const withCharacterMeta = (characters, snapshot) => {
  const elementById = elementByIdOf(snapshot);
  const cache = debutOrderCache || {};
  return characters.map((character) => {
    const id = Number(character?.id ?? character?.avatar_id ?? character?.avatarId);
    const element = character?.element
      || (Number.isFinite(id)
        ? (elementById.get(id) || cache.elementById?.get(id) || null)
        : null) || '';
    const path = character?.path
      || (Number.isFinite(id) ? cache.pathById?.get(id) : null)
      || cache.pathByCn?.get(displayName(character?.name)) || '';
    if (element === (character?.element || '') && path === (character?.path || '')) return character;
    return { ...character, element: element || character?.element, path: path || character?.path };
  });
};

/** 命途键 → 中文名（权威那份是服务端 `refs.pathLabels`，`format.js` 那张表兜底）。 */
const pathLabelOf = (key) => (key ? (debutOrderCache?.pathLabels?.[key] || pathName(key)) : '');

/** 属性键 → `{ label: '风属性', color: 'wind' }`；认不出来就返回 `null`（卡片不画那一格）。 */
const elementBadgeOf = (key) => {
  if (!key) return null;
  const label = elementName(key);
  if (!label || label === '未知') return null;
  return { label: `${label}属性`, color: ELEMENT_COLOR_KEYS[String(key).toLowerCase()] || '' };
};

const renderSnapshot = (snapshot) => {
  const container = el.snapshot;
  container.innerHTML = '';
  if (!snapshot) {
    showError('没有可展示的数据');
    return;
  }
  showWarnings(snapshot.warnings, snapshot);
  const cache = state.snapshotResponse?.cache || snapshot.cacheMeta || null;
  const hasStaleSections = Object.values(snapshot.sectionFreshness || {}).some((section) =>
    ['stale', 'partial', 'failed'].includes(section?.status));
  const isCached = cache?.cached ?? state.snapshotResponse?.cached ?? snapshot.cached;
  // 虚拟账号（用户 2026-10-12）：角色数据是**本机构造**的（服务端不会去请求米游社），
  // 所以那一行的措辞要改成「虚拟账号」，别写「本地缓存 / 点刷新取最新」——那两句会误导。
  const isVirtual = Boolean(state.snapshotResponse?.virtual || snapshot.source === 'virtual');
  if (isVirtual) {
    el.snapshotUpdated.textContent = '虚拟账号：角色数据由本机构造（用来试各种角色池），没有米游社战绩';
    el.snapshotUpdated.title = '虚拟账号只用来演示抽卡方案在不同角色池下怎么推；它不是你的真实账号数据。';
    el.snapshotUpdated.hidden = false;
  } else {
    // 「本地缓存」现在是**常态**（用户 2026-10 要求：读取一律读本地，不自动联网），
    // 所以这里必须写清楚「要最新请点刷新」，否则用户会以为数据一直在自动更新。
    const suffix = cache?.stale
      ? ` · ⚠ ${cache.staleReason || '这是旧数据，请点刷新获取最新'}`
      : (snapshot.partial || hasStaleSections
        ? ' · 部分更新（个别板块沿用旧数据或未取得）'
        : (isCached ? ' · 本地缓存（不会自动联网更新，点「刷新米游社战绩」取最新）' : ' · 本次同步'));
    el.snapshotUpdated.textContent = `数据更新时间：${formatDateTime(snapshot.fetchedAt)}${suffix}`;
    el.snapshotUpdated.title = isCached
      ? '这是上次抓取后保存在本机的数据。打开页面、切换分页都不会重新请求米游社；需要最新数据请点「刷新米游社战绩」。'
      : '';
    el.snapshotUpdated.hidden = false;
  }

  const info = playerInfoOf(snapshot);
  const index = snapshot.index || {};
  const stats = index.stats || {};

  // ---- overview ----------------------------------------------------------
  //
  // 用户 2026-10-18：「**均衡等级、活跃天数、光锥数量获取不到就算了可以不显示**，
  // 你先尽量查下米游社获取的数据是否包含这两项」。
  //
  // 查证结果（改这一块之前逐条核过）：
  //   * `world_level`（均衡等级）**整个仓库只有这一行在读**，没有任何地方写过 ——
  //     米游社星铁战绩接口的 `role` 只有 `avatar/nickname/level/region`（`world_level`
  //     是原神那个 `role` 对象的字段）；`tools/gui-fixture.mjs` 里那行 `world_level: 6`
  //     是**手写夹具**，不是实测响应。→ 取不到，不显示。
  //   * `equipment_num`（光锥数量）同样是**照原神的 stats 键猜的**（代码里 `avatar_num` /
  //     `avatar_number` 两种写法都试，就是这个原因）。星铁战绩没有光锥仓库接口，
  //     唯一的光锥来源是「角色身上的 `equip`」。→ 取不到，不显示。
  //   * `active_day_number`（活跃天数）**有**：公开的个人主页卡片
  //     （`card.data: [{name:'活跃天数', value:'1206'}, …]`）会带，而且它不受
  //     「战绩是否公开」影响（见 `format.js` 的 `cardStats()` 注释，实测样本）。
  //
  // 所以这一块改成「**取到什么画什么**」：`stats` 与 `card.data` 两路都试，
  // 两路都没有就**整张卡不画**，而不是挂一个占位的「—」让人以为程序坏了。
  const totalCharacters = charactersOf(snapshot).length;
  const cardRows = cardStats(snapshot) || [];
  /** 「这个值能不能显示」——空串 / 占位符一律当没有。 */
  const usable = (value) => value !== undefined && value !== null && value !== ''
    && value !== '-' && value !== '—';
  const pickStat = (...keys) => {
    for (const key of keys) {
      const value = stats[key];
      if (usable(value)) return value;
    }
    return null;
  };
  /** 公开卡片的行是按**中文名**给的（`{ name, value }`），按名字取一份兜底。 */
  const cardValue = (...names) => {
    for (const name of names) {
      const hit = cardRows.find((row) => row.label === name);
      if (hit && usable(hit.value)) return hit.value;
    }
    return null;
  };

  const overview = document.createElement('div');
  overview.className = 'overview';
  overview.appendChild(
    statCard('开拓者', displayName(info.nickname || snapshot.nickname) || '—', true),
  );
  if (usable(info.level)) overview.appendChild(statCard('开拓等级', `Lv.${integer(info.level)}`));
  // 均衡等级：字段名保留（`world_level`），将来接口真给了就自动出现，取不到整张卡不画。
  const worldLevel = usable(info.world_level) ? info.world_level : cardValue('均衡等级');
  if (usable(worldLevel)) {
    overview.appendChild(statCard('均衡等级', String(worldLevel),
      false, '米游社星铁战绩接口目前不返回均衡等级；这里是接口若返回时的显示位。'));
  }
  // 已解锁角色：`stats` → 公开卡片 → 快照里实际有几个（最后一个一定拿得到）。
  const ownedChars = pickStat('avatar_num', 'avatar_number')
    ?? cardValue('已解锁角色') ?? (totalCharacters || null);
  if (usable(ownedChars)) overview.appendChild(statCard('已解锁角色', integer(ownedChars)));
  const coneCount = pickStat('equipment_num', 'light_cone_num') ?? cardValue('光锥数量');
  if (usable(coneCount)) overview.appendChild(statCard('光锥数量', integer(coneCount)));
  const achievements = pickStat('achievement_num', 'achievement_number') ?? cardValue('达成成就');
  if (usable(achievements)) overview.appendChild(statCard('达成成就', integer(achievements)));
  const abyss = usable(stats.abyss_process)
    ? `第 ${stats.abyss_process} 层`
    : (usable(pickStat('spiral_abyss')) ? String(pickStat('spiral_abyss')) : null);
  if (usable(abyss)) overview.appendChild(statCard('忘却之庭', abyss));
  const activeDays = pickStat('active_day_number', 'active_day_num') ?? cardValue('活跃天数');
  if (usable(activeDays)) overview.appendChild(statCard('活跃天数', integer(activeDays)));

  // 限定角色 / 限定光锥（用户 2026-10-18）。数字由服务端算好随快照下发
  // （`state.snapshotResponse.limited`）：光锥的那份名单对两类账号来源不同，
  // 浏览器手上没有虚拟账号的 `virtualRoster`，见 `src/server/limited-count.js`。
  // ⚠️ 真实账号只能数到「快照里能看到的角色」和「身上装备的光锥」（米游社没有光锥仓库），
  //    所以标「（可见）」并把口径写进 tooltip；虚拟账号是完整名单，不标。
  const limited = state.snapshotResponse?.limited || null;
  const limitedCount = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const limitedChars = limitedCount(limited?.characters);
  if (limitedChars !== null) {
    const partial = limited?.charactersScope !== 'owned';
    overview.appendChild(statCard(
      partial ? '限定角色（可见）' : '限定角色',
      integer(limitedChars), false,
      partial
        ? '米游社只返回快照里那些角色（展柜 / 公开角色），所以这是「能看到的」限定角色数，可能少于实际拥有数。'
        : '按该虚拟账号的完整角色名单统计：全部 5★ 限定角色，不含常驻、4★ 与开拓者。',
    ));
  }
  const limitedCones = limitedCount(limited?.cones);
  if (limitedCones !== null) {
    const partial = limited?.conesScope !== 'owned';
    overview.appendChild(statCard(
      partial ? '限定光锥（可见）' : '限定光锥',
      integer(limitedCones), false,
      partial
        ? '米游社不返回光锥仓库，只能数到角色身上**已装备**的限定光锥；实际拥有数可能更多。'
        : '按该虚拟账号的完整光锥名单统计：全部 5★ 限定光锥，不含常驻与 3/4★。',
    ));
  }
  // 总成本（用户 2026-10-18）＝ 限定角色(本体+星魂) + 限定光锥(本体×叠影) 的**原始金数**，
  // 不减隐金（隐金单位也按全价算）。服务端随 limited 一起下发（limited.cost.total）。
  const totalCost = limitedCount(limited?.cost?.total);
  if (totalCost !== null) {
    overview.appendChild(statCard(
      '总成本', `${integer(totalCost)} 金`, false,
      '所有限定角色（本体 1 + 星魂）+ 限定光锥（本体 × 叠影）按**原始**金数合计，不减隐金'
        + '（受赠 / 兑换角色与光锥也按全价算）。与抽卡页「E6S5 = 12 金」同一套口径。',
    ));
  }
  container.appendChild(overview);

  // ---- characters --------------------------------------------------------
  // ⚠️ `withCharacterMeta` 给每张卡补齐「命途 / 属性」（用户 2026-10-17 第 2 条）。
  //    它只补缺、不改原件；数据集表还没到位时命途为空，等 `ensureDebutOrder()`
  //    回来后的那次重画会补上（同一次请求也负责排序）。
  const characters = withCharacterMeta(charactersOf(snapshot), snapshot);
  /**
   * 这个账号是不是虚拟账号（用户 2026-10-13 第 3 条）：只有它才允许**自定义角色名单**。
   * 真实账号的角色来自米游社，界面上加一个只会在下一次刷新时消失（纯自欺欺人）。
   */
  const isVirtualAccount = state.accounts
    .find((a) => a.id === state.activeAccountId)?.source === 'virtual';
  // 排序键（用户 2026-10-16 第 8 条）：拿缓存里的直接排；缓存还没到位就先按
  // avatar_id 固定兜底画一次，等它到位再原地重画一次（`renderSnapshot` 幂等）。
  // ⚠️ 只在**缓存为 null** 时才触发加载：加载失败也会落成空表（见 `ensureDebutOrder`），
  // 否则这里会反复重画。虚拟账号与真实账号共用这条路径。
  if (!debutOrderCache) {
    void ensureDebutOrder().then(() => {
      // ⚠️ **不能拿 `snapshot` 做同一性判断**（`state.snapshot` 会被新的快照对象替换 ——
      //    实测那样守卫时这次重排**永远不会发生**，角色列表就一直是 `avatar_id` 兜底顺序，
      //    用户第 8 条的功能等于没做）。改成重画**当前**快照：`renderSnapshot` 幂等，
      //    而且此刻 `debutOrderCache` 已非空 → 不会再触发一次加载（不会递归）。
      if (state.snapshot) renderSnapshot(state.snapshot);
    });
  }
  const orderedCharacters = sortCharactersByDebut(characters, debutOrderCache || undefined);
  if (characters.length === 0 && !isVirtualAccount) {
    container.appendChild(sectionTitle('角色列表'));
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = '该角色未公开角色详情，或展柜中没有角色。请在游戏内「资料」中开启展示角色详情。';
    container.appendChild(note);
  } else {
    container.appendChild(sectionTitle(`角色列表 · ${characters.length}`));
    const grid = document.createElement('div');
    grid.className = 'char-grid';
    for (const character of orderedCharacters) {
      grid.appendChild(characterCard(character));
    }
    // 用户 2026-10-13 第 3 条原话：「虚拟账号可在**角色列表末尾**点击添加没有的角色」。
    if (isVirtualAccount) grid.appendChild(addCharacterCard());
    container.appendChild(grid);
  }

  // ---- extra sections ----------------------------------------------------
  const extras = [];
  const challenge = challengeSummary(snapshot);
  if (challenge) extras.push(['忘却之庭', challenge]);
  const rogue = rogueSummary(snapshot);
  if (rogue) extras.push(['模拟宇宙', rogue]);
  // The public card survives the privacy gate, so show it when the detailed
  // overview is unavailable.
  const card = cardStats(snapshot);
  if (card && (snapshot.recordPublic === false || !index.stats)) {
    extras.push(['公开卡片（个人主页）', card]);
  }
  if (extras.length) {
    container.appendChild(sectionTitle('其他记录'));
    const grid = document.createElement('div');
    grid.className = 'overview';
    for (const [title, rows] of extras) {
      const box = document.createElement('div');
      box.className = 'stat';
      const head = document.createElement('div');
      head.className = 'stat-label';
      head.textContent = title;
      box.appendChild(head);
      for (const row of rows) box.appendChild(kv(row.label, row.value));
      grid.appendChild(box);
    }
    container.appendChild(grid);
  }

  container.hidden = false;
};

/**
 * 角色列表**末尾**那张「＋ 添加角色」卡片（用户 2026-10-13 第 3 条）。
 *
 * 它只出现在虚拟账号的角色列表里（`renderSnapshot` 判 `source === 'virtual'`）：
 * 真实账号的角色是米游社发下来的，本地加一个只会在下次刷新时消失。
 *
 * ⚠️ 做成 `<button>` 而不是 `<div>`：键盘 Tab 能到、回车/空格能开 —— 这一页其它卡片
 * 都是可点的 `div`（靠 `onclick`），新加的这张没有历史包袱，直接用原生语义。
 * ⚠️ 保存之后要**两件事都做**：① `loadSnapshot()` 重取快照（角色列表立刻变）；
 * ② 抽卡页可见时 `adviceOf().show()` —— 持有情况变了，结论与方案都得重算
 * （`show()` 里那句 `conclusionKey() !== state.conclusionKey` 就是干这个的）。
 */
const addCharacterCard = () => {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'char-card is-add';
  card.id = 'virtualAddCharacter';
  const plus = document.createElement('div');
  plus.className = 'char-add-plus';
  plus.textContent = '＋';
  const label = document.createElement('div');
  label.className = 'char-add-label';
  // 用户 2026-10-14：「虚拟账号-**添加角色**改为**添加/修改角色**」。
  // 这张卡本来就不只做「添加」：点开的是同一个角色编辑器，已有角色也能改星魂 / 光锥
  // （`openVirtualRoster()` 列出账号里全部角色，未拥有的那几行才是「＋ 添加」）。
  label.textContent = '添加/修改角色';
  const hint = document.createElement('div');
  hint.className = 'char-add-hint';
  hint.textContent = '任意角色 / 星魂 / 同命途光锥';
  card.append(plus, label, hint);
  card.addEventListener('click', () => {
    const account = state.accounts.find((a) => a.id === state.activeAccountId);
    void openVirtualRoster({
      accountId: state.activeAccountId,
      nickname: account?.nickname || account?.roles?.[0]?.nickname || '',
      // 走同一条 `api()`：鉴权、CSRF、错误提示都不必在这里再实现一遍。
      api,
      // 数据集索引在抽卡页那一侧（编辑器要列全部角色 / 命途 / 专属光锥）。
      ensureIndex: () => adviceOf().ensureIndex(),
      onSaved: async () => {
        await loadSnapshot();
        toast('角色已更新', 'ok');
        if (activeTab() === 'advice') await adviceOf().show();
      },
    }).catch((err) => toast(err.message, 'err'));
  });
  return card;
};

const characterCard = (character) => {
  const id = String(character.id ?? character.avatar_id ?? character.avatarId ?? Math.random());
  const name = displayName(character.name);
  const rarity = num(character.rarity) ?? 4;
  const card = document.createElement('div');
  card.className = `char-card${state.expanded.has(id) ? ' expanded' : ''}`;
  // 记下 id：抽卡推荐页点角色 chip 时要靠它把这张卡找出来（滚过去 + 闪一下）。
  card.dataset.charId = id;
  card.style.setProperty('--rarity-color', rarityColor(rarity));

  const top = document.createElement('div');
  top.className = 'char-top';

  const avatar = document.createElement('div');
  avatar.className = 'char-avatar';
  // miHoYo serves the portrait from its own CDN; fall back to the initial.
  const icon = character.icon || character.avatar_icon || character.image
    || character.head_icon || character.portrait;
  const fallbackInitial = () => {
    avatar.textContent = name.slice(0, 1);
  };
  // ⚠️ **同源 `/icons/...` 也要认**（2026-10-12 修）：数据集图标表里存的是
  // `/icons/icon/character/1407.png?fallback=<cdn>`，本地没有该文件时 `/icons` 路由会 302
  // 到 CDN（见 app.js 那条静态路由）。原来这里只认 `^https?://`，于是**虚拟账号的图标
  // 全变成首字占位**（虚拟快照用的就是这串同源地址）—— 这条判断放宽之后图标就正常了。
  if (icon && (/^https?:\/\//.test(icon) || String(icon).startsWith('/icons/'))) {
    const img = document.createElement('img');
    img.src = icon;
    img.alt = name;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      img.remove();
      fallbackInitial();
    });
    avatar.appendChild(img);
  } else {
    fallbackInitial();
  }

  const meta = document.createElement('div');
  const nameLine = document.createElement('div');
  nameLine.className = 'char-name';
  nameLine.textContent = name;
  const subLine = document.createElement('div');
  subLine.className = 'char-sub';
  // 副标题写「命途 · 属性」（用户 2026-10-17 第 2 条：「角色列表需要显示属性和命途」），
  // 每一半前面挂**游戏内那枚图标**（用户 2026-10-18：「命途和属性需要显示图标」）。
  // 两者都拿不到才退回等级 —— 否则会在名字下面留一条空行。
  const pathText = pathLabelOf(character?.path);
  const element = elementBadgeOf(character?.element);
  if (pathText) {
    const span = document.createElement('span');
    span.className = 'char-path';
    const icon = gameIcon(pathIconUrl(character?.path));
    if (icon) span.appendChild(icon);
    span.appendChild(document.createTextNode(pathText));
    subLine.appendChild(span);
  }
  if (element) {
    if (pathText) {
      const dot = document.createElement('span');
      dot.className = 'char-sub-dot';
      dot.textContent = '·';
      subLine.appendChild(dot);
    }
    const span = document.createElement('span');
    span.className = 'char-el';
    if (element.color) span.dataset.element = element.color;
    const icon = gameIcon(elementIconUrl(character?.element));
    if (icon) span.appendChild(icon);
    span.appendChild(document.createTextNode(element.label));
    subLine.appendChild(span);
  }
  if (!subLine.childNodes.length) subLine.textContent = `Lv.${character.level ?? '?'}`;
  meta.append(nameLine, subLine);
  top.append(avatar, meta);
  card.appendChild(top);

  const tags = document.createElement('div');
  tags.className = 'char-meta';
  const tag = (text, cls = '') => {
    const t = document.createElement('span');
    t.className = `tag ${cls}`.trim();
    t.textContent = text;
    return t;
  };
  if (rarity) tags.appendChild(tag(`${rarity}★`, rarity === 5 ? 'tag-gold' : (rarity === 4 ? 'tag-violet' : 'tag-cyan')));
  tags.appendChild(tag(`Lv.${character.level ?? '?'}`));
  // One constellation/star-soul tag only - both fields may carry the same number.
  const constellation = character.actived_constellation_num ?? character.rank;
  if (constellation !== undefined && constellation !== null && num(constellation) !== null) {
    const count = num(constellation);
    tags.appendChild(tag(
      count > 0 ? `星魂 ${count}` : '未解锁星魂',
      count > 0 ? 'tag-gold' : '',
    ));
  }
  card.appendChild(tags);

  // 光锥（用户 2026-10-18）：角色列表卡片上直接显示当前装备的光锥——图标 + 名字
  // + 叠影（精炼值），星级用金（5★）/ 紫（4★）/ 蓝（3★）三色区分，与角色卡左边那条
  // 星级色条同一套语义。没有光锥（或未公开）时不渲染这一行，别留空框。
  const cone = lightConeOf(character);
  if (cone) {
    const coneLine = document.createElement('div');
    coneLine.className = 'char-cone';
    const coneRarity = num(cone.rarity) ?? 4;
    coneLine.dataset.rarity = String(coneRarity);
    // 光锥图标：快照自带 equip.icon（米游社 CDN / /icons/... 同源）。与角色头像同一条
    // 判断（同源 /icons 也要认，见上面头像那段注释）。
    const coneIconUrl = cone.icon;
    if (coneIconUrl && (/^https?:\/\//.test(coneIconUrl) || String(coneIconUrl).startsWith('/icons/'))) {
      const coneImg = document.createElement('img');
      coneImg.className = 'char-cone-icon';
      coneImg.src = coneIconUrl;
      coneImg.alt = cone.name;
      coneImg.loading = 'lazy';
      coneImg.referrerPolicy = 'no-referrer';
      // 图挂了（网络 / 缺图）就撤掉图标、留名字——绝不画破图。
      coneImg.addEventListener('error', () => coneImg.remove(), { once: true });
      coneLine.appendChild(coneImg);
    }
    const coneName = document.createElement('span');
    coneName.className = 'char-cone-name';
    coneName.textContent = cone.name;
    coneLine.appendChild(coneName);
    // 叠影（精炼值）：只在有值且 > 0 时显示，避免「叠影 0」这种噪声。
    const coneRank = num(cone.rank);
    if (coneRank !== null && coneRank > 0) {
      const coneRankSpan = document.createElement('span');
      coneRankSpan.className = 'char-cone-rank';
      coneRankSpan.textContent = `叠影 ${coneRank}`;
      coneLine.appendChild(coneRankSpan);
    }
    card.appendChild(coneLine);
  }

  // 点角色卡 → 弹出角色面板浮层（用户 2026-10 要求：与抽卡推荐页**同一个浮层**，
  // 含角色立绘与光锥卡面）。**不再在本页原地展开** —— 展开会把整张网格重排，
  // 点一次就要重建所有角色卡（原来 renderSnapshot 全量重画）。
  //
  // ⚠️ 这里曾经写着一个不存在的标识符 `elementCn`（想给副标题传属性名），
  // 于是点角色的瞬间抛 `ReferenceError: elementCn is not defined`，浮层根本弹不出来
  // （用户报的就是「角色信息页点角色看不到弹窗」）。属性名的唯一来源是
  // `elementName(character.element)`，与浮层里标签用同一个函数。
  card.addEventListener('click', () => {
    openCharacterPanel(
      {
        id,
        nameCn: name,
        name: character?.name,
        elementCn: character?.element ? elementName(character.element) : '',
        eidolon: constellation,
      },
      () => character,
      { art: panelArtFor(character), catalog: state.snapshot?.avatars || {} },
    );
  });

  return card;
};

/** 角色面板：实现在 character-panel.js（抽卡推荐页的战斗记录也用它）。 */

// -------------------------------------------------------------------- bootstrap

/**
 * 「检查更新」——用户 2026-10-14 第 5 条；2026-10-16 第 7 条把落点搬到**顶栏标题栏**。
 *
 * 用户原话（第 5 条）：「程序要支持与从 GitHub 比较最新版本，当版本与此项目的 GitHub 版本
 * 不同时，点击提示进行更新，当版本与 GitHub 项目相同时，提示已是最新版本，显示此程序的
 * 版本号」。用户原话（第 7 条）：「版本号、检查更新应显示在页面上方的标题栏较为显眼的
 * 地方，提示及时更新」。
 *
 * 三种结果分开处理（服务端已经把 `status` 判好了，界面**不**再自己比版本号 ——
 * 比版本号这件事只有 `src/server/update-check.js` 一个实现，抄一份到浏览器迟早分会叉）：
 *   * `latest`  → 「已是最新版本 v4.6.108」
 *   * `update`  → 「发现新版本 v4.6.109（当前 v4.6.108）」+ 一个**前往下载**的外链，
 *                 并给顶栏那一块加 `is-outdated`（金色高亮 + 发光）——**这就是第 7 条要的
 *                 「提示及时更新」**：用户一眼能看见，不必去读浮层里的句子。
 *   * `ahead`   → 本地比 GitHub 还新（开发分支 / 提前打包，不是错）
 *   * `error`   → 「检查更新失败：…（当前 v4.6.108）」
 *
 * ⚠️ 结果**留在顶栏那一块下方**（绝对定位的结果气泡）而不是只弹一个 toast：toast 4.2 秒
 *    就没了，而这里有一个要点得开的下载链接，而且用户可能想回头再看一次。toast 照样弹一下
 *    （那是「点击的即时反馈」）。气泡**不占标题栏宽度**，长句子不会把顶栏挤坏。
 * ⚠️ 气泡**有四条收起路径**（用户 2026-10-16 报的就是「它一直挂着不消失」—— 最初那版只设
 *    `hidden = false`，之后谁都不收它）：① 挂 10 秒自动收（`UPDATE_RESULT_LINGER_MS`，
 *    比 toast 的 4.2s 长，够把句子读完）；② 悬停在气泡上时暂停计时（读句子 / 够「前往下载」
 *    链接时不会被中途收走，移开再挂满剩余时间）；③ 点气泡外任意处收；④ Esc 收。
 *    气泡收掉后「有新版本」这件事**不丢**：按钮的高亮态（`is-outdated`）与「有新版本 vX」
 *    文案都还在顶栏上，那才是第 7 条要的「提示及时更新」的常驻落点。
 * ⚠️ 按钮在请求期间**禁用并改文案**：GitHub 直连偶尔要好几秒，没有这个反馈用户会连点，
 *    而服务端缓存只挡得住第二次之后的请求（第一次照样要等满）。
 */
/** 结果气泡自动收起前挂多少毫秒（见 renderUpdateResult 头注释的收起路径 ①）。 */
const UPDATE_RESULT_LINGER_MS = 10000;
/** 气泡自动收起的计时器句柄：每次渲染 / 悬停都要先清旧的，避免上一轮的定时器提前收走本轮。 */
let updateResultHideTimer = 0;

const hideUpdateResult = () => {
  window.clearTimeout(updateResultHideTimer);
  updateResultHideTimer = 0;
  if (el.appUpdateResult) el.appUpdateResult.hidden = true;
};

const scheduleUpdateResultHide = (delay = UPDATE_RESULT_LINGER_MS) => {
  window.clearTimeout(updateResultHideTimer);
  updateResultHideTimer = window.setTimeout(hideUpdateResult, delay);
};
const renderUpdateResult = (data) => {
  const el2 = el.appUpdateResult;
  if (!el2) return;
  const current = data?.current || el.appVersion?.textContent || '';
  const status = data?.status || 'error';
  el2.replaceChildren();
  let text2 = '';
  let kind = '';
  if (status === 'latest') {
    text2 = `已是最新版本 ${current}`;
    kind = 'is-ok';
  } else if (status === 'update') {
    text2 = `发现新版本 ${data.latest}（当前 ${current}），`;
    kind = 'is-update';
  } else if (status === 'ahead') {
    text2 = data.latest
      ? `本地 ${current} 比 GitHub 上的 ${data.latest} 还新（那边的发布还没跟上）。`
      : (data.note || `GitHub 上还没有发布记录可比较（本地 ${current}）。`);
    kind = 'is-ok';
  } else {
    text2 = `检查更新失败：${data?.error || '未知原因'}（当前 ${current}）`;
    kind = 'is-err';
  }
  el2.className = `topbar-update-result ${kind}`;
  el2.appendChild(document.createTextNode(text2));
  if (status === 'update' && data.url) {
    const a = document.createElement('a');
    a.href = data.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = '前往下载';
    a.title = '在 GitHub 上打开这一条发布（在新标签页）';
    el2.appendChild(a);
  }
  el2.hidden = false;
  // 弹出即挂自动收起的表（收起路径 ①；悬停 / 点外部 / Esc 另有各自的入口）。
  scheduleUpdateResultHide();
  /**
   * 「及时更新」的高亮（用户第 7 条）：有新版本时给**整块**加 `is-outdated`
   * （`app.css` 里版本号变金色、按钮变「有新版本 vX」+ 发光），检查一次是旧版本就把
   * 上一次的高亮撤掉。⚠️ 只在 `update` 时点亮 —— `ahead` / `error` 都不是「该更新」。
   */
  const flagged = status === 'update';
  const btn = el.appUpdateCheck;
  const flagTargets = [el.topbarVersion, btn];
  for (const node of flagTargets) node?.classList.toggle('is-outdated', flagged);
  if (btn && !btn.disabled) {
    btn.textContent = flagged && data.latest ? `有新版本 v${data.latest}` : '检查更新';
    btn.title = flagged
      ? `GitHub 上有新版本 v${data.latest}，点「前往下载」获取（当前 ${current}）`
      : '与 GitHub 上的最新发布比较（只有点这个按钮才会联网）';
  }
  toast(text2.replace(/，$/, ''), status === 'error' ? 'err' : (status === 'update' ? '' : 'ok'));
};

const checkUpdate = async () => {
  const btn = el.appUpdateCheck;
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  // 请求期间禁用并改文案（见上面的注释）。**先记住当前文案**：请求失败（没拿到
  // `status`）时要把按钮还原成点之前的样子，而不是留在「检查中…」。
  const label = btn.textContent;
  btn.textContent = '检查中…';
  let result = null;
  try {
    // `check=1` 是**唯一**会真的联网的形态（不带它时服务端只回本地版本号）。
    result = await api('/api/update-check?check=1');
  } catch (err) {
    result = { ok: false, status: 'error', error: err.message };
  }
  // ⚠️ 顺序要紧：先把按钮恢复成**可点**，再 `renderUpdateResult()` —— 后者只在
  // `!btn.disabled` 时才写文案与高亮（否则「有新版本 vX」会被这里还原成「检查更新」）。
  btn.disabled = false;
  btn.textContent = label;
  renderUpdateResult(result);
};

// ---- 结果气泡的三条手动收起路径（收起路径 ②③④，见 renderUpdateResult 头注释）--------
//
// ② 悬停暂停：`mouseenter` 清掉计时器（挂表时机在 renderUpdateResult）、`mouseleave`
//    重新挂满 10 秒 —— 用户正读句子或正把鼠标移向「前往下载」链接时不能被收走。
//    用 `pointerenter/pointerleave` 而不是 mouse 系：触屏上 mouseenter 会在点按后
//    迟到地补发一次，行为不如 pointer 系一致。
el.appUpdateResult?.addEventListener('pointerenter', () => {
  window.clearTimeout(updateResultHideTimer);
  updateResultHideTimer = 0;
});
el.appUpdateResult?.addEventListener('pointerleave', () => {
  if (!el.appUpdateResult?.hidden) scheduleUpdateResultHide();
});
// ③ 点气泡外任意处收：`pointerdown` 捕获阶段判断，点到气泡 / 版本区 / 检查按钮本身都不收
//    （检查按钮点了会重新渲染气泡，收了也是立刻弹回来，白闪一下）。
document.addEventListener('pointerdown', (event) => {
  if (el.appUpdateResult?.hidden) return;
  if (event.target instanceof Node
    && (el.appUpdateResult.contains(event.target)
      || el.topbarVersion?.contains(event.target))) return;
  hideUpdateResult();
}, true);
// ④ Esc 收：只在气泡开着时拦，别抢别的浮层的键。
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.appUpdateResult?.hidden) hideUpdateResult();
});

const loadConfig = async () => {
  state.accessToken = readAccessToken();
  const data = await api('/api/config');
  state.csrfToken = data.csrfToken;
  state.accounts = data.accounts;
  // 版本号来自服务端（src/version.js 是唯一来源）。顶栏那一块一直在（用户 2026-10-16
  // 第 7 条把它从页脚搬到了标题栏），首次拿到配置前留空 —— 不做动画也不改高度，
  // 避免影响标题栏与分页签的位置。
  if (el.appVersion) {
    el.appVersion.textContent = data.versionText || '';
    el.appVersion.hidden = !data.versionText;
    el.appVersion.title = data.versionText
      ? `本工具版本 ${data.versionText}（点右边「检查更新」可与 GitHub 上的最新发布比较）`
      : '';
  }
  // 「检查更新」按钮（用户 2026-10-14 第 5 条）：版本号一显示出来就给用户这个入口。
  // ⚠️ 它**不会**自己点自己 —— 外网请求只发生在用户点击之后（见 `checkUpdate()`）。
  if (el.appUpdateCheck) el.appUpdateCheck.hidden = !data.versionText;
  if (state.activeAccountId && !state.accounts.some((a) => a.id === state.activeAccountId)) {
    state.activeAccountId = null;
    state.activeUid = null;
  }
  if (!state.activeAccountId && state.accounts.length) {
    state.activeAccountId = state.accounts[0].id;
    state.activeUid = state.accounts[0].roles.filter(roleIsEnabled)[0]?.uid ?? null;
  }
  // Deep link: ?role=<uid> preselects a role (handy for sharing / screenshots).
  const wantsRole = new URLSearchParams(window.location.search).get('role');
  const ownsRole = (account, uid) => (account.roles || [])
    .some((r) => r.uid === uid && roleIsEnabled(r));
  if (wantsRole && state.accounts.some((a) => ownsRole(a, wantsRole))) {
    state.activeUid = wantsRole;
    const owner = state.accounts.find((a) => ownsRole(a, wantsRole));
    state.activeAccountId = owner.id;
  }
  renderAccounts();
  renderRoleSelect();
  renderView();
  if (state.accounts.length) {
    setStatus('已登录', 'pill-ok');
    if (state.activeUid && !state.snapshot) await loadSnapshot();
  } else {
    setStatus('未登录', 'pill-idle');
  }
  return data;
};

// ------------------------------------------------------------------- tabs
//
// Two top-level pages share the shell: the record view (login + characters) and
// the recommendation view (offline theherta data). The record view reads the
// active snapshot, so the advice view asks for it lazily via the getter below
// rather than caching a stale copy.

let adviceView = null;
const adviceOf = () => {
  if (!adviceView) {
    adviceView = mountAdviceView({
      getSnapshot: () => state.snapshot,
      getSnapshotResponse: () => state.snapshotResponse,
      // 抽卡推荐第一节要读米游社的战斗记录：按当前账号/角色取，刷新时还要 CSRF。
      getRole: () => ({
        accountId: state.activeAccountId,
        uid: state.activeUid,
        csrfToken: state.csrfToken,
      }),
      // 点第一节队伍里的角色 → 切回角色信息页展开那张卡（面板）。
      // 助战角色/不在持有列表里的返回 false，界面据此标成不可点。
      onOpenCharacter: (member) => revealCharacter(member?.id, member?.nameCn),
    });
  }
  return adviceView;
};

const activeTab = () => el.tabs?.querySelector('.tab.is-active')?.dataset.view || 'records';

const selectTab = async (view) => {
  for (const tab of el.tabs?.querySelectorAll('.tab') || []) {
    const isActive = tab.dataset.view === view;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  }
  el.layoutRecords.hidden = view !== 'records';
  el.layoutAdvice.hidden = view !== 'advice';
  if (view === 'advice') {
    try {
      await adviceOf().show();
    } catch (err) {
      toast(err.message, 'err');
    }
  }
};

const wireTabs = () => {
  if (!el.tabs) return;
  el.tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab || tab.dataset.view === activeTab()) return;
    selectTab(tab.dataset.view);
  });
};

const wireEvents = () => {
  wireTabs();
  // 顶栏那个品牌图标可点（用户 2026-10-14 第 6 条：「点击可以更换」）。
  el.brandMark?.addEventListener('click', () => { void openIconPicker(); });
  // 「检查更新」（用户 2026-10-14 第 5 条）：**只有点它**才会去打 GitHub。
  el.appUpdateCheck?.addEventListener('click', () => { void checkUpdate(); });
  el.qrRefresh.addEventListener('click', startQrLogin);
  // ---- 虚拟账号（用户 2026-10-12）------------------------------------------
  //
  // 「＋ 虚拟账号」列出预设（全新账号 / 单核 / 单推厨 / 辅助优先 / 中氪 / 重氪 /
  // 专锥收集党 / 老玩家偏科 / 全图鉴 …），点一个就建一个**虚拟账号**：
  //   * 强度那一档用**真实数据集**算（黑塔网投稿），只有「你拥有什么」是假的；
  //   * 只写进本机账号库，**绝不动你已登录的真实账号**（服务端只增不删）。
  const renderVirtualPresets = async () => {
    if (!el.virtualAccountList) return;
    el.virtualAccountList.innerHTML = '';
    const loading = document.createElement('p');
    loading.className = 'muted small';
    loading.textContent = '正在读取预设…';
    el.virtualAccountList.appendChild(loading);
    let presets = [];
    try {
      const data = await api('/api/virtual-accounts/presets');
      presets = data.presets || [];
    } catch (err) {
      loading.textContent = `读取预设失败：${err.message}`;
      return;
    }
    el.virtualAccountList.innerHTML = '';
    if (!presets.length) {
      loading.textContent = '数据集还没采集，暂时没有预设可用。';
      el.virtualAccountList.appendChild(loading);
      return;
    }
    for (const p of presets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'virtual-item';
      btn.dataset.preset = p.id;
      const title = document.createElement('span');
      title.className = 'virtual-item-title';
      title.textContent = p.title;
      const hint = document.createElement('span');
      hint.className = 'virtual-item-hint';
      hint.textContent = `${p.hint}（${p.chars} 限定角色 / ${p.cones} 专锥）`;
      btn.append(title, hint);
      el.virtualAccountList.appendChild(btn);
    }
  };
  el.virtualAccountBtn?.addEventListener('click', async () => {
    if (!el.virtualAccountPanel) return;
    el.virtualAccountPanel.hidden = !el.virtualAccountPanel.hidden;
    if (!el.virtualAccountPanel.hidden) await renderVirtualPresets();
  });
  el.virtualAccountClose?.addEventListener('click', () => {
    if (el.virtualAccountPanel) el.virtualAccountPanel.hidden = true;
  });
  el.virtualAccountList?.addEventListener('click', async (event) => {
    const btn = event.target.closest?.('.virtual-item');
    if (!btn || btn.disabled) return;
    const preset = btn.dataset.preset;
    btn.disabled = true;
    btn.classList.add('is-busy');
    try {
      const data = await api('/api/virtual-accounts', { method: 'POST', body: { preset } });
      toast(`已新建 ${data.account?.nickname || '虚拟账号'}`, 'ok');
      if (el.virtualAccountPanel) el.virtualAccountPanel.hidden = true;
      // 刷新账号列表并**直接切到新账号**，省得用户自己再找一遍。
      const keepId = data.account?.id || null;
      await loadConfig();
      if (keepId) {
        const acc = state.accounts.find((a) => a.id === keepId);
        const uid = acc?.roles?.[0]?.uid || null;
        if (acc && uid) {
          await selectAccount(acc.id, uid);
          return;
        }
      }
      renderView();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  });
  el.addAccountBtn.addEventListener('click', async () => {
    state.addingAccount = true;
    renderView();
    await startQrLogin();
  });
  el.loginCancel.addEventListener('click', () => {
    stopQrPolling();
    state.qrSessionId = null;
    state.qrDone = true;
    state.addingAccount = false;
    el.qrImage.hidden = true;
    el.qrPlaceholder.hidden = false;
    setQrStatus('已返回账号');
    renderView();
    setStatus(state.accounts.length ? '已登录' : '未登录', state.accounts.length ? 'pill-ok' : 'pill-idle');
  });
  el.refreshBtn.addEventListener('click', () => loadSnapshot(true));
  el.roleSelect.addEventListener('change', () => {
    state.activeUid = el.roleSelect.value;
    state.expanded.clear();
    state.snapshot = null;
    renderAccounts();
    loadSnapshot();
  });
  el.logoutBtn.addEventListener('click', async () => {
    if (!state.activeAccountId) return;
    if (!window.confirm('确定退出并删除本地保存的登录凭证吗？')) return;
    try {
      await api(`/api/accounts/${state.activeAccountId}`, { method: 'DELETE' });
      state.activeAccountId = null;
      state.activeUid = null;
      state.snapshot = null;
      el.snapshot.hidden = true;
      await loadConfig();
      toast('已退出登录', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  el.toggleCookieBtn.addEventListener('click', () => {
    el.cookieForm.hidden = !el.cookieForm.hidden;
  });
  el.cookieCancel.addEventListener('click', () => {
    el.cookieForm.hidden = true;
  });

  // 1034 verification modal
  el.verifyCancel.addEventListener('click', closeVerifyModal);
  el.verifyRetry.addEventListener('click', retryVerify);
  el.verifyRecheck.addEventListener('click', async () => {
    el.verifyStatus.textContent = '正在重新读取…';
    closeVerifyModal();
    await loadSnapshot(true);
  });
  el.challengeSubmit.addEventListener('click', async () => {
    const value = el.challengeInput.value.trim();
    if (!value) { toast('请先粘贴 x-rpc-challenge', 'err'); return; }
    const pending = state.pendingVerify;
    if (!pending) { toast('验证会话已失效，请重新点「开始验证」', 'err'); return; }
    el.verifyStatus.textContent = '正在使用该 challenge 重试…';
    try {
      // A manually supplied challenge can be used directly for the retry.
      state.challenge = value;
      closeVerifyModal();
      await loadSnapshot(true);
    } catch (err) {
      toast(stripJargon(err.message), 'err');
    }
  });
  el.cookieSubmit.addEventListener('click', async () => {
    const raw = el.cookieInput.value.trim();
    if (!raw) { toast('请先粘贴 Cookie', 'err'); return; }
    el.cookieSubmit.disabled = true;
    try {
      const data = await api('/api/login/cookie', { method: 'POST', body: { cookie: raw } });
      el.cookieInput.value = '';
      el.cookieForm.hidden = true;
      toast('Cookie 登录成功', 'ok');
      if (data.roleError) toast(`角色列表获取失败：${data.roleError}`, 'err');
      state.addingAccount = false;
      state.activeAccountId = data.account?.id || null;
      state.activeUid = (data.roles || []).filter(roleIsEnabled)[0]?.uid ?? null;
      state.snapshot = null;
      await loadConfig();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      el.cookieSubmit.disabled = false;
    }
  });
};

const main = async () => {
  wireEvents();
  try {
    const config = await loadConfig();
    // 程序图标（用户 2026-10-14 第 6 条）：默认大黑塔、可在本机改。放在 loadConfig
    // **之后**（它要先拿到 `/api/archive` 的图标表）；拿不到就保持 emoji 兜底，不报错。
    void applyAppIcon();
    if (config.accounts.length === 0) await startQrLogin();
    // Deep link: ?view=advice opens the recommendation page directly. Runs
    // after loadConfig so the advice view can see the active snapshot.
    if (new URLSearchParams(window.location.search).get('view') === 'advice') {
      await selectTab('advice');
    }
    // Optional deep link: ?expand=all renders every character card expanded.
    // Handy for screenshots and for sharing a fully expanded view.
    const expand = new URLSearchParams(window.location.search).get('expand');
    if (expand === 'all' && state.snapshot) {
      for (const character of charactersOf(state.snapshot)) {
        state.expanded.add(String(character.id ?? character.avatar_id ?? character.avatarId));
      }
      renderSnapshot(state.snapshot);
    }
  } catch (err) {
    setStatus('连接失败', 'pill-err');
    showError(`无法连接后端服务：${err.message}`);
  }
};

main();
