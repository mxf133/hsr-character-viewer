// 「隐金设置」详情窗口的外壳（只负责套壳 + 开关 + 恢复默认，一行口径都不生成）。
//
// 用户 2026-10-11 原话：「我现在需要在性价比总榜添加一个按钮，用于额外设置，将其放置于
// 总榜权重下方……点击后弹出详情界面，角色和光锥都需要有图标，详情页要美观可用，
// 界面信息不出界，以下复选框默认已点击」。
//
// 为什么单独一个模块而不是塞进 `advice-view.js`：那个文件已经 2500 行，而「套壳 + 三条
// 关闭路径 + 锁背景滚动」这套东西**已经有一份**（`advice-tip-window.js`）—— 抄第三份
// 就等于以后每修一次浮层行为要改三处（HANDOFF §6.2 记着这个仓库抄坏过权重表）。
//
// 与 `advice-tip-window.js` 的**结构性差别**（所以没有直接复用它）：
//   * 那个窗口的内容节点是**从徽标里搬进来**的，关掉时要「原样还回去」（记 parent /
//     nextSibling）。隐金设置的内容只在窗口里存在（每次打开现建、关掉即丢），
//     没有「家」可还 —— 硬套那套回位逻辑只会多出一堆恒为 null 的分支。
//   * 这里多一个「恢复默认」按钮，语义是**重画内容**，所以本模块要记住调用方的渲染函数。
//
// 复用 `/styles/app.css` 里已有的 `.modal`（满屏遮罩 + 居中 + `z-index`）与
// `.char-panel-head` / `.char-panel-body`（标题栏 + 可滚正文）——与其他两个大窗口同一套
// 房子，尺寸由 `.advice-gold-card` 自己给（见 app.css 那一段）。

const TITLE_ID = 'adviceGoldTitle';
const CLOSE_ID = 'adviceGoldClose';
const RESET_ID = 'adviceGoldReset';
const BODY_CLASS = 'advice-gold-body';

const DEFAULT_TITLE = '隐金设置';

/** 懒建的外壳（整页生命周期内只建一次，之后复用同一个节点）。 */
let shell = null;
/** 当前这一份的渲染函数：关掉后置空，「恢复默认」后重画时要用。 */
let paint = null;
/** 调用方给的可选回调（`onReset`）。 */
let hooks = {};

/**
 * 建一次外壳并挂到 `document.body`（第一次 `openGoldSettings()` 才建）。
 *
 * 结构照抄 `#charPanelModal` / `.advice-tip-modal`：
 *   .modal.advice-gold-modal
 *     └ .modal-card.advice-gold-card[role=dialog][aria-modal][aria-labelledby]
 *         ├ .char-panel-head → <span id=adviceGoldTitle> + .char-panel-actions > 恢复默认 / 关闭
 *         └ .char-panel-body.advice-gold-body   ← 调用方填内容
 */
const ensureShell = () => {
  if (shell) return shell;

  const modal = document.createElement('div');
  modal.className = 'modal advice-gold-modal';
  // 与另外两个大窗口同一个写法：`hidden` 是浏览器原生的「不显示 + 不进可访问树」。
  modal.hidden = true;

  const card = document.createElement('div');
  card.className = 'modal-card advice-gold-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', TITLE_ID);

  const head = document.createElement('div');
  head.className = 'char-panel-head';

  const title = document.createElement('span');
  title.id = TITLE_ID;
  title.textContent = DEFAULT_TITLE;

  const actions = document.createElement('div');
  actions.className = 'char-panel-actions';

  // 「恢复默认」= 五个复选框重新全勾（用户 2026-10-11 要求数据默认就是全勾）。
  // 为什么要有它：勾掉几项之后想回到起点的唯一办法就是一项项点回来；总榜权重那一行
  // 早就配了「恢复默认」，这里保持一致。
  const resetBtn = document.createElement('button');
  resetBtn.id = RESET_ID;
  resetBtn.className = 'btn btn-ghost btn-sm';
  resetBtn.type = 'button';
  resetBtn.textContent = '恢复默认';

  const closeBtn = document.createElement('button');
  closeBtn.id = CLOSE_ID;
  closeBtn.className = 'btn btn-ghost btn-sm';
  closeBtn.type = 'button';
  closeBtn.textContent = '关闭';

  actions.appendChild(resetBtn);
  actions.appendChild(closeBtn);
  head.appendChild(title);
  head.appendChild(actions);

  const body = document.createElement('div');
  body.className = `char-panel-body ${BODY_CLASS}`;

  card.appendChild(head);
  card.appendChild(body);
  modal.appendChild(card);
  document.body.appendChild(modal);

  shell = modal;
  wireShell();
  return shell;
};

/** 把内容重画一遍（打开时、以及点了「恢复默认」之后）。 */
const repaint = () => {
  if (!shell || typeof paint !== 'function') return;
  const body = shell.querySelector(`.${BODY_CLASS}`);
  if (!body) return;
  body.innerHTML = '';
  paint(body);
};

/** 关掉（背景 / ESC / 关闭按钮三条路都走这里，绝不各写一份）。 */
const close = () => {
  if (!shell || shell.hidden) return;
  shell.hidden = true;
  paint = null;
  hooks = {};
};

/** 关闭 / 点背景 / 恢复默认 / ESC：**只接一次**（外壳是整页共用的那一个节点）。 */
const wireShell = () => {
  shell.querySelector(`#${CLOSE_ID}`)?.addEventListener('click', () => close());
  shell.querySelector(`#${RESET_ID}`)?.addEventListener('click', () => {
    // 先让调用方改状态（把五项写回全勾并触发重算），再重画复选框 —— 顺序反了会
    // 出现「界面已全勾、但状态还是旧的」那一瞬。
    try {
      hooks.onReset?.();
    } catch (error) {
      console.error('[advice-gold-modal] onReset 抛错：', error);
    }
    repaint();
  });
  // 点背景才关：只认 `event.target === 外壳节点`，点在卡片里不算（与另外两个窗口逐字一致）。
  shell.addEventListener('click', (event) => {
    if (event.target === shell) close();
  });
  // ESC 挂 `document`：监听器随外壳常驻，没开窗口时 `close()` 第一行就返回，常驻无代价。
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
};

/**
 * 打开窗口，并用 `render(body)` 填内容。
 *
 * @param {(body: HTMLElement) => void} render 每次打开（以及「恢复默认」后）都会调一次；
 *   本模块**不清缓存、不管口径**，只提供一块干净的正文节点。
 * @param {{ title?: string, onReset?: () => void }} [options]
 * @returns {boolean} 打开了返回 `true`；`render` 不是函数时返回 `false` 且什么都不做。
 */
export const openGoldSettings = (render, options = {}) => {
  if (typeof render !== 'function') return false;
  const modal = ensureShell();
  const body = modal.querySelector(`.${BODY_CLASS}`);
  if (!body) return false;

  paint = render;
  hooks = { onReset: typeof options?.onReset === 'function' ? options.onReset : null };
  const titleEl = modal.querySelector(`#${TITLE_ID}`);
  if (titleEl) titleEl.textContent = options?.title || DEFAULT_TITLE;

  // 每次打开都重画：状态可能已经被别处改过（另一个标签页、或点了恢复默认）。
  repaint();

  modal.hidden = false;
  // 焦点给关闭按钮：`aria-modal="true"` 声明了「这是个模态框」，焦点留在背后的按钮上
  // 读屏软件与键盘用户都会觉得不对（与 `.advice-tip-modal` 同一个做法）。
  modal.querySelector(`#${CLOSE_ID}`)?.focus();
  return true;
};

/** 关掉窗口（没开时是无害的空操作）。 */
export const closeGoldSettings = () => close();

/** 窗口是不是开着（`hidden` 是唯一判据，与另外两个窗口同一写法）。 */
export const isGoldSettingsOpen = () => Boolean(shell) && !shell.hidden;
