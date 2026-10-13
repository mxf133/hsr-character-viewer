// Front-end controller: QR login, account list, role switching, snapshot render.
//
// The browser never sees cookie material — the API only returns public account
// projections, role lists and record payloads.

import {
  cardStats, challengeSummary, charactersOf, displayName, elementName, formatDateTime,
  integer, num, pathName, playerInfoOf, percent, rarityColor,
  rogueSummary,
} from './format.js';
import { mountAdviceView } from './advice-view.js';
// 角色面板与 kv 现在和抽卡推荐页共用一份实现（战斗记录里点角色也用它）。
import { kv } from './character-panel.js';
import { openCharacterPanel } from './character-modal.js';
import { accessHeaders, readAccessToken } from './access.js';

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

const statCard = (label, value, small = false) => {
  const box = document.createElement('div');
  box.className = 'stat';
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
  const totalCharacters = charactersOf(snapshot).length;
  const pickStat = (...keys) => {
    for (const key of keys) {
      const value = stats[key];
      if (value !== undefined && value !== null && value !== '' && value !== '-') return value;
    }
    return null;
  };

  const overview = document.createElement('div');
  overview.className = 'overview';
  overview.append(
    statCard('开拓者', displayName(info.nickname || snapshot.nickname), true),
    statCard('开拓等级',
      info.level === undefined || info.level === null ? '—' : `Lv.${integer(info.level)}`),
    statCard('均衡等级',
      info.world_level === undefined || info.world_level === null ? '—' : String(info.world_level)),
    statCard('已解锁角色', (() => {
      const value = pickStat('avatar_num', 'avatar_number');
      if (value !== null) return integer(value);
      return totalCharacters ? String(totalCharacters) : '—';
    })()),
  );
  overview.append(statCard('光锥数量', integer(pickStat('equipment_num', 'light_cone_num'))));
  overview.append(
    statCard('达成成就', integer(pickStat('achievement_num', 'achievement_number'))),
    statCard('忘却之庭',
      stats.abyss_process ? `第 ${stats.abyss_process} 层` : (() => {
        const abyss = pickStat('spiral_abyss');
        return abyss === null ? '—' : String(abyss);
      })()),
    statCard('活跃天数', integer(pickStat('active_day_number'))),
  );
  container.appendChild(overview);

  // ---- characters --------------------------------------------------------
  const characters = charactersOf(snapshot);
  if (characters.length === 0) {
    container.appendChild(sectionTitle('角色列表'));
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = '该角色未公开角色详情，或展柜中没有角色。请在游戏内「资料」中开启展示角色详情。';
    container.appendChild(note);
  } else {
    container.appendChild(sectionTitle(`角色列表 · ${characters.length}`));
    const grid = document.createElement('div');
    grid.className = 'char-grid';
    for (const character of characters) {
      grid.appendChild(characterCard(character));
    }
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
  subLine.textContent = [
    character.path ? pathName(character.path) : null,
    character.element ? elementName(character.element) : null,
  ].filter(Boolean).join(' · ') || `Lv.${character.level ?? '?'}`;
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

const loadConfig = async () => {
  state.accessToken = readAccessToken();
  const data = await api('/api/config');
  state.csrfToken = data.csrfToken;
  state.accounts = data.accounts;
  // 版本号来自服务端（src/version.js 是唯一来源）。页脚那一段是一直存在的，
  // 只是首次拿到配置前留空——不做动画也不改高度，避免影响标题栏位置。
  if (el.appVersion) {
    el.appVersion.textContent = data.versionText ? ` · ${data.versionText}` : '';
    el.appVersion.hidden = !data.versionText;
  }
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
