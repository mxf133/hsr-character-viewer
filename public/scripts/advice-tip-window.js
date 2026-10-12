// 性价比详情**大窗口**的外壳（只负责「套壳 + 开关」）。
//
// 为什么单独一个模块：性价比浮层以前是**贴在徽标旁边的小浮层**（`max-width: 620px`，
// 见 app.css 的 `.advice-value-tip`），而那块内容越长越多（七列贡献值来源表 +
// 「最佳证据的队伍」配队卡片 + 「该角色的全部配队」最多 30 条）。用户 2026-10 原话
// 是「性价比详情页目前的组件过多，需要单独开一个较大的窗口避免部分内容被网页遮挡」——
// 所以这里给**已经存在的那块内容**换一个容器：点徽标 → 居中的大窗口，而不是贴边浮层。
//
// ⚠️ 本模块**只管外壳**，一行业务内容都不生成、不改：
//   * 内容节点（`.advice-value-tip`）由 `advice-view.js` 现建、现填；
//   * 这里只做三件事：**收进窗口 / 关掉时原样还回去 / 记住是谁要的**。
//   这样口径仍在 `advice.js`、渲染仍在 `advice-view.js`，壳子坏了不会算出错的分。
//
// 为什么复用 `.modal` / `.char-panel-*` 这套房子类，而不是自己新造一套：
//   * `.modal` 在 app.css 里已经带了 `position: fixed; inset: 0; z-index: 80;
//     display: grid; place-items: center` + 背景模糊 + `padding: 20px` —— 「居中大窗口」
//     要的定位与遮罩全在里面，重写一份等于给同一个东西留两份定义（§7.2：一个数字
//     只在一个地方定义）；z-index 也因此**不用自己拍一个数**，与角色面板浮层同一个层级。
//   * 标题栏 / 正文抄 `index.html` 里 `#charPanelModal` 那一段的结构、开关抄
//     `character-modal.js`（点背景只认 `event.target === 外壳节点`、ESC 挂 document、
//     关闭按钮 click），两个大窗口于是长得一样、行为也一样。
//
// 与 `character-modal.js` 的**唯一**结构性差别：那个浮层的节点是 index.html 里写死的
// （`#charPanelModal`），本窗口的节点是**懒建**的 —— 见 `ensureShell()` 的注释。

/** 标题栏 / 正文的固定 id：`aria-labelledby` 与关闭按钮都要引用它们。 */
const TITLE_ID = 'adviceTipTitle';
const CLOSE_ID = 'adviceTipClose';

const DEFAULT_TITLE = '性价比得分详情';

/** 懒建的外壳（整页生命周期内只建一次，之后复用同一个节点）。 */
let shell = null;
/** 当前窗口里放着的那一份：内容节点 + 回位坐标 + 调用方的回调。 */
let current = null;

/**
 * 建一次外壳并挂到 `document.body`。
 *
 * 为什么**懒建**（第一次 `openTipWindow()` 才建）：这是「抽卡推荐」一个分页的一个
 * 交互，页面一打开就多一个盖满全屏的空 `.modal` 属于白占 DOM；而且本模块是从
 * `advice-view.js` 静态 import 的，模块求值发生在 `<head>`/`<body>` 还没闭合时，
 * 顶层就 `appendChild(document.body)` 有一定风险，懒建顺手绕开这一层。
 *
 * 结构照抄 `index.html` 的 `#charPanelModal`：
 *   .modal.advice-tip-modal
 *     └ .modal-card.advice-tip-card[role=dialog][aria-modal][aria-labelledby]
 *         ├ .char-panel-head → <span id=adviceTipTitle> + .char-panel-actions > 关闭按钮
 *         └ .char-panel-body.advice-tip-body   ← 内容节点搬进这里
 *
 * 关闭 / 背景 / ESC 的接线也放在这里（`wireShell()` 只接一次）。
 */
const ensureShell = () => {
  if (shell) return shell;

  const modal = document.createElement('div');
  modal.className = 'modal advice-tip-modal';
  // 默认藏起来。用 `hidden` 而不是某个 `.is-open` 类：与 `#charPanelModal` 的
  // 开合同一个写法（`character-modal.js` 也是 `modal.hidden = false/true`），
  // 而且 `hidden` 是浏览器原生的「不显示 + 不进可访问树」，比自定义类可靠。
  modal.hidden = true;

  const card = document.createElement('div');
  // `role="dialog"` + `aria-modal` 写在**卡片**上（不是外壳上）：外壳是那层盖满屏的
  // 遮罩，读屏软件要认的「对话框」是这个卡片。与 index.html 里 `#charPanelModal`
  // 的写法一致。
  card.className = 'modal-card advice-tip-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', TITLE_ID);

  const head = document.createElement('div');
  head.className = 'char-panel-head';

  const title = document.createElement('span');
  title.id = TITLE_ID;
  // `<span>` 而不是 `<h3>`：`#charPanelModal` 用的是 h3，但那是页面里唯一的标题层级；
  // 这里用 span 更保守 —— 不往文档大纲里塞一个「性价比详情」的标题（同一个分页可能
  // 反复开关几十次），`aria-labelledby` 照样能给读屏软件一个名字。
  // 字号由 `.advice-tip-card .char-panel-head` 那一小条 CSS 补上（见 .css 的注释）。
  title.textContent = DEFAULT_TITLE;

  const actions = document.createElement('div');
  actions.className = 'char-panel-actions';

  const closeBtn = document.createElement('button');
  closeBtn.id = CLOSE_ID;
  closeBtn.className = 'btn btn-ghost btn-sm';
  closeBtn.type = 'button';
  closeBtn.textContent = '关闭';

  actions.appendChild(closeBtn);
  head.appendChild(title);
  head.appendChild(actions);

  const body = document.createElement('div');
  body.className = 'char-panel-body advice-tip-body';

  card.appendChild(head);
  card.appendChild(body);
  modal.appendChild(card);
  document.body.appendChild(modal);

  shell = modal;
  wireShell();
  return shell;
};

/** 关掉（背景 / ESC / 关闭按钮三条路都走这里，绝不各写一份）。 */
const close = () => {
  if (!current || !shell) return;
  // 先取下来再清 `current`：`restore()` 里要判断「原位置还在不在」
  // （见它的注释），拿不到这一份就没法还回去了。
  const entry = current;
  current = null;

  // ① 先通知调用方（用户要求「先调 onClose」）。放在回位**之前**：调用方拿到的是
  //    「窗口要关了」这件事，此时内容节点还在窗口里 —— 它想读一眼内容（记滚动位置、
  //    清掉自己那层 `.is-open`）都还来得及。抛异常也不能把回位卡住：内容节点是徽标
  //    按钮的子节点，留在窗口里徽标就永远少一块。
  try {
    entry.onClose?.();
  } catch (error) {
    // 静默：一行的关闭动作不该被调用方的异常打断后续的回位与隐藏。
    // （`advice-view.js` 的 onClose 要负责把自己的 `.is-open` 摘掉，真抛了要去看那里。）
    console.error('[advice-tip-window] onClose 抛错：', error);
  }

  // ② 原样还回去。
  restore(entry);

  // ③ 藏起外壳、放掉引用。
  shell.hidden = true;
};

/**
 * 把内容节点移回它原来待的位置（徽标按钮里面）。
 *
 * 为什么非还回去不可：这个内容节点是 `.advice-value-wrap`（徽标外面那层 span）的
 * 子节点 —— 是徽标的一部分。留在窗口里的话，徽标那一下点击的事主就不在自己家了，
 * 再点徽标要么找不到它、要么整个徽标的行为跟着变。
 *
 * 回位用 `insertBefore(el, 当初记下的 nextSibling)`，`nextSibling` 为 null 时等价于
 * append（用户要求「原样移回去」，所以记的是**位置**而不是只记父亲）。
 */
const restore = (entry) => {
  const { contentEl, parent, nextSibling } = entry;
  if (!parent) return;
  // ⚠️ 兜底：窗口开着的时候榜单**可能被整个重画**（切权重 / 切副本都会
  // `innerHTML = ''` 重建总榜行），那样这个父节点自己也已经不在文档里了。
  // 往一个游离节点里 insertBefore 不会报错，但内容节点会跟着一起变成游离的
  // —— 等于被丢进内存垃圾桶。这种情况什么都不做更好：内容已经随旧行一起没了，
  // 而新行会自己建一份新的。
  if (!parent.isConnected) return;
  parent.insertBefore(contentEl, nextSibling || null);
};

/** 关闭 / 点背景 / ESC：**只接一次**（外壳是整页共用的那一个节点）。 */
const wireShell = () => {
  shell.querySelector(`#${CLOSE_ID}`)?.addEventListener('click', () => close());

  // 点背景才关：只认 `event.target === 外壳节点`，点在卡片里不算
  // —— 与 `character-modal.js` 的判法逐字一致。
  shell.addEventListener('click', (event) => {
    if (event.target === shell) close();
  });

  // ESC 挂在 `document` 上：焦点此刻在窗口里的关闭按钮上，但用户也可能点了别处
  // （配装清单里的滚动 / 选中），挂 document 才一定收得到。监听器随外壳**常驻**
  // 而不随开关增删 —— 一份监听器管一辈子，比每次开关 add/remove 更不容易漏
  // （漏了就是「关一次之后再按 ESC 关不掉第二个」这类 bug）。
  // 没开窗口时 `close()` 第一行就返回，常驻没有代价。
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
};

/**
 * 打开大窗口，把 `contentEl` 收进去。
 *
 * @param {Element} contentEl 已经存在的那个内容节点（`.advice-value-tip`）。
 *   ⚠️ 本模块**不生成**它，只搬它。
 * @param {{ title?: string, onClose?: () => void }} [options]
 *   `title` 不传时用「性价比得分详情」；`onClose` 在关闭时**先于**回位被调用。
 * @returns {boolean} 打开了返回 `true`；`contentEl` 为空 / 不是元素时返回 `false`
 *   且**什么都不做**（不建外壳、不动 DOM、不改上一次的状态）。
 */
export const openTipWindow = (contentEl, options = {}) => {
  // 元素判据用 `nodeType === 1`：只要 Element（HTMLElement / SVGElement 都算），
  // 文本节点 / null / undefined / 字符串一律拒绝 —— 契约写的是「不是元素时返回 false
  // 且什么都不做」，所以下面没有任何副作用，`:has()` 之类的副作用都不该发生。
  if (!contentEl || contentEl.nodeType !== 1) return false;

  // 已经开着时再来一次：先把上一个**正常关掉**（走同一个 `close()`，它自己的
  // `onClose` 与回位都会发生），再开新的。为什么不能直接覆盖 `current`：
  // 那样上一个内容节点会永远留在窗口里，而它原本是另一个徽标的子节点 —— 那个徽标
  // 从此少一块，且那块内容再也不会回到它该在的位置。
  if (current) close();

  const modal = ensureShell();
  const body = modal.querySelector('.advice-tip-body');
  // 外壳是懒建且结构固定的，取不到正文只可能是外壳被人从外部拆了；照实失败而不是抛。
  if (!body) return false;

  // ⚠️ `parentNode` 与 `nextSibling` 必须在**移走之前**记下来：`appendChild()`
  // 一执行，这两个值就都变成窗口里的位置了（而且 `nextSibling` 会直接变成 null）。
  const entry = {
    contentEl,
    parent: contentEl.parentNode,
    nextSibling: contentEl.nextSibling,
    onClose: typeof options?.onClose === 'function' ? options.onClose : null,
  };

  const titleEl = modal.querySelector(`#${TITLE_ID}`);
  if (titleEl) titleEl.textContent = options?.title || DEFAULT_TITLE;

  // 搬进正文（`appendChild` 会顺手把节点从原位置摘下来 —— 不需要先 remove）。
  body.appendChild(contentEl);

  modal.hidden = false;
  current = entry;

  // 焦点给关闭按钮：`aria-modal="true"` 声明了「这是个模态框」，焦点若还留在背后的
  // 徽标上，读屏软件与键盘用户都会觉得不对。放在**最后**做 —— 先摆好、显示出来，
  // 再移焦点，否则某些浏览器会给一个还不可见（`hidden`）的元素设焦点而失败。
  // 用 optional chaining：万一按钮被外部拆了，也不要让「打开」这一步整个抛掉。
  modal.querySelector(`#${CLOSE_ID}`)?.focus();

  return true;
};

/**
 * 关掉窗口（没开时是无害的空操作）。
 *
 * 顺带说明「谁负责摘徽标上的 `.is-open`」：那是 `advice-view.js` 的状态，
 * 本模块不越界去改别人的类名 —— 调用方通过 `options.onClose` 自己摘（见上面
 * `close()` 第 ① 步的顺序：先 `onClose` 再回位，所以它此刻还找得到内容节点）。
 */
export const closeTipWindow = () => close();

/** 窗口是不是开着（`hidden` 是唯一判据，与 `characterPanelOpen()` 同一写法）。 */
export const isTipWindowOpen = () => Boolean(shell) && !shell.hidden;
