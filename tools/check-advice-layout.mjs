// Verify the 抽卡推荐 header controls never move.
//
// The bug: switching 副本 changes the length of the one-line summary under the
// title, and the header used to re-flow (the 591px control group wrapped onto a
// second line, and `align-items: flex-end` then pushed 副本/版本/重读本地数据 down by
// up to 114px). The controls must sit at the SAME top in every mode and every
// viewport width, and must not wrap onto their own line.
//
// 这个套件后来扩成了「抽卡推荐页 + 两处角色浮层 + 性价比详情大窗口」的**唯一**
// 排版/图片回归网，现在盯：
//   * 控件位置稳定性（副本 / 版本两个下拉框、两行权重、性价比徽标贴文字）；
//   * 角色面板两个入口是同一个界面（结构一致 / 两张图真的加载 / hero 顶部对齐）；
//   * 两套副本权重相互独立（改一方另一方不动 + 两份 localStorage）；
//   * 用户 2026-10 点名的四条：总榜每行的角色头像 + 光锥图标（naturalWidth > 0）、
//     详情里的配队卡片（带图）、界面上不再有「差这一档」、总榜不再写「赛季」；
//   * **2026-10-10 第二轮（v4.6.61）：点徽标开的是「居中的大窗口」**（原来那个
//     `max-width: 620px` 的贴徽标小浮层已经不存在了）—— 判据跟着换成
//     「`.advice-tip-modal` 不是 hidden / `.advice-tip-card` 四边都在可见区内 /
//     正文自己可滚 / 关掉后内容节点回到徽标里」，详见第二节那一段注释。
// ⚠️ 凡是引用 `.advice-value-tip.is-placed`、`position: fixed`、浮层宽 ≤620px 的旧判据
//     一律要按窗口形态改写（本轮已改）；留着就是「怎么改都过不去」的死判据。
//
// ⚠️ 图片类断言必须先开 `Emulation.setFocusEmulationEnabled`（见脚本开头那段注释）：
// 本机 CDP 窗口是隐藏的，隐藏页里 Chrome 不取懒加载的图，naturalWidth 恒为 0。
//
// Usage: node tools/check-advice-layout.mjs [--url ...] [--port 9222]
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const RAW_URL = arg('url', 'http://127.0.0.1:8360/?view=advice');
/**
 * 套件要打开的那个地址 —— **一律深链到抽卡推荐页**（`?view=advice`）。
 *
 * ⚠️ 2026-10-13 修：这里以前只给「带 `?` 的 URL 追加 `&view=advice`」，而
 * `URL_TO_OPEN` 保持调用方给的原样、第 100 / 552 行两次导航用的又是它 ——
 * 于是 `--url=http://127.0.0.1:8360/`（**不带 `?view` 的裸地址**）会让那两次导航落在
 * 默认的「角色信息」页上：抽卡推荐页的视图**根本没挂载**（`#adviceConclusionUnits`
 * 一行都没有、权重输入框 0 个），后面「关卡权重 / 清空输入 / 抽卡权重」那 9 条断言
 * 全读到 `null`，看起来像九项布局回归，其实只是页面没切过去。
 *
 * `run-tests.mjs` 的注释里早就写过这个坑（「URL 必须带 `?view=advice`」），但那只挡住了
 * 「调用方记得带」这一半 —— 靠人记的东西迟早会忘（本轮就是自己踩的）。
 * 现在两边都规范化：**传什么地址都会落到抽卡推荐页**，`URL_TO_OPEN` 与 `ADVICE_URL`
 * 是同一个值（后者保留旧名字，下面还有很多地方在用）。
 */
const URL_TO_OPEN = (() => {
  const url = new URL(RAW_URL);
  url.searchParams.set('view', 'advice');
  return url.toString();
})();
// 深链 ?view=advice 会直接落到抽卡推荐页；每次导航后还要等下拉框真的建出来，
// 否则设 value 会碰到 null。
const ADVICE_URL = URL_TO_OPEN;
const PORT = Number(arg('port', '9222'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const origin = new URL(URL_TO_OPEN).origin;
let page = list.find((t) => t.type === 'page' && t.url.startsWith(origin));
if (!page) {
  page = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_TO_OPEN)}`,
    { method: 'PUT' }).then((r) => r.json());
  await sleep(2500);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.error) slot.reject(new Error(msg.error.message));
  else slot.resolve(msg.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  // Never let a dropped frame hang the whole run.
  const timer = setTimeout(() => {
    if (pending.delete(id)) reject(new Error(`${method} 超时`));
  }, 15000);
  const wrap = (fn) => (v) => { clearTimeout(timer); fn(v); };
  pending.set(id, {
    resolve: wrap(resolve),
    reject: wrap(reject),
  });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || 'evaluate failed');
  }
  return res.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
// ⚠️ 必须先打开「焦点模拟」，否则所有 `img.naturalWidth` 都会是 0（假失败）。
//
// 这个 CDP 浏览器窗口在本机是**不可见**的：`document.visibilityState === 'hidden'`、
// `document.hasFocus() === false`（实测 `Page.bringToFront` 也救不回来）。而 Chrome 在
// 隐藏页里**根本不去取懒加载的图片**：总榜 80 行 × 2 张图标（`loading="lazy"`）以及
// 角色面板里的立绘 / 光锥卡面，`complete` 永远是 false、`naturalWidth` 永远是 0，
// 看起来像「图全挂了」。实测打开焦点模拟后 `visibilityState` 变 `visible`、
// 懒加载的图正常加载（滚动一遍后 80 行 160 张全部 naturalWidth > 0）。
//
// 这一条以前没做，所以下面那两条「角色面板两张图」的断言在本机**长期是红的**
// （显示「图未加载」），被当成环境问题放过了 —— 其实断言本身是对的，缺的是这一步。
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Page.navigate', { url: URL_TO_OPEN });
await sleep(3500);

/** Top offset of each header control, plus whether the group wrapped. */
const measure = () => evaluate(`(() => {
  const box = (id) => {
    const el = document.getElementById(id);
    const r = el && el.getBoundingClientRect();
    return r ? { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width) } : null;
  };
  const head = document.querySelector('#layoutAdvice .dash-head');
  const kids = head ? [ ...head.children ].map((k) => ({
    cls: k.className,
    top: Math.round(k.getBoundingClientRect().top),
    h: Math.round(k.getBoundingClientRect().height),
  })) : [];
  const actions = document.querySelector('#layoutAdvice .dash-actions');
  const actionKids = actions ? [ ...actions.children ].map((k) => {
    const control = k.querySelector?.('select,button') || k;
    const r = control.getBoundingClientRect();
    return {
      id: control.id || k.className,
      top: Math.round(r.top),
      h: Math.round(r.height),
      w: Math.round(r.width),
      text: control.selectedOptions?.[0]?.textContent || control.textContent?.trim().slice(0, 18) || '',
    };
  }) : [];
  return {
    mode: box('adviceMode'),
    reload: box('adviceReload'),
    // 抽卡方案（队伍口径，2026-10-11 第 10 轮）：整块的容器
    // ⚠️ id 是 adviceTeamPlanBody（不是 adviceTeamPlan）—— 这条曾经写成没有 Body 的
    //    那个名字，于是 teamPlan 恒为 null、三个视口全红（feat/team-plan 本轮没跑过
    //    CDP 套件，收尾人补上的）。⚠️ 本段是模板字符串，注释里不能出现反引号。
    teamPlan: box('adviceTeamPlanBody'),
    // 「战斗记录」这一节在页面上方：切副本不该让它动
    recordTop: box('adviceRecord')?.top ?? null,
    // 三个下拉框挪进各自的节之后仍然要在（副本/版本现在挂在「环境统计」标题行上）
    fields: {
      mode: Boolean(document.getElementById('adviceMode')),
      season: Boolean(document.getElementById('adviceSeason')),
      teamPlan: Boolean(document.getElementById('adviceTeamPlanBody')),
    },
    // 用户 2026-10 要求撤掉的两节：查得到就是没撤干净
    removedSections: {
      plan: Boolean(document.getElementById('advicePlan')),
      bands: Boolean(document.getElementById('adviceBands')),
    },
    // 性价比总榜（纯数据集口径）与抽卡方案（按角色池）：两块都要有内容
    frontierRows: document.querySelectorAll('#adviceConclusionUnits .advice-unit').length,
    teamRows: document.querySelectorAll('#adviceTeamPlanBody .advice-plan-team').length,
    // 每个结果都必须带「补金顺序」，所以条数应当 ≥ 行数
    teamFills: document.querySelectorAll('#adviceTeamPlanBody .advice-fill-item').length,
    // 用户 2026-10-11 第 10 轮撤掉的旧「预算控件」（打算投入金数那个输入框）：
    // 这份必须为 0，判据在 node 里用（那边碰不到 document）。
    legacyBudgetBoxes: document.querySelectorAll('#adviceBudgetControl, #adviceBudget').length,
    // 权重**两大类**（用户 2026-10-12 第 2 条）：关卡权重 5 个输入框（#adviceFrontierWeightRow）
    // + 抽卡权重 3 个（#adviceDrawWeightRow，强度 / 性价比 / 泛用性）。
    // ⚠️ 这段整体是模板字符串：注释里**不能出现反引号**（HANDOFF §6.1 第 16 条）。
    weightInputs: document.querySelectorAll('#adviceFrontierWeightRow input.advice-weight').length,
    drawWeightInputs: document.querySelectorAll('#adviceDrawWeightRow input.advice-draw-weight').length,
    // 用户 2026-10-11 第 10 轮「去掉方案权重那一行」：这份**必须**是 0
    legacyPlanWeightBoxes: document.querySelectorAll('#advicePlanWeights, #advicePlanWeightRow').length,
    // 权重两类各带自己的「已改 / 生效」摘要，恢复默认是**共用**的那一个按钮
    weightMeta: {
      frontier: Boolean(document.getElementById('adviceFrontierWeightsMeta')?.textContent),
      draw: Boolean(document.getElementById('adviceDrawWeightsMeta')?.textContent),
      reset: Boolean(document.getElementById('adviceFrontierWeightsReset')),
    },
    // 2026-10 用户要求「性价比 +xxx 移到左边，靠近别的文字」：
    // 量一下徽标与它左边「花费」文字之间的间距，以及它离容器右边缘有多远。
    // 以前是 margin-left:auto 顶到行尾，间距会是几百像素。
    // ⚠️ v4.6.61 把「点开之后显示在哪」换成了居中的大窗口，但徽标**本身的位置没动**
    //    （实测间距仍是 8px），所以这两条判据照旧有效 —— 下面那条 tip 只说明
    //    「这一行还带着详情内容节点」（关窗时它会被窗口移回徽标里，见 advice-tip-window.js
    //    的 restore()），**不再**代表「点开就是贴在旁边的小浮层」。
    badge: (() => {
      const unitHead = document.querySelector('#adviceConclusionUnits .advice-unit-head');
      const costNode = unitHead && unitHead.querySelector('.advice-unit-cost');
      const wrapNode = unitHead && unitHead.querySelector('.advice-value-wrap');
      if (!costNode || !wrapNode) return null;
      const c = costNode.getBoundingClientRect();
      const b = wrapNode.getBoundingClientRect();
      const list = document.getElementById('adviceConclusionUnits').getBoundingClientRect();
      return {
        gapToText: Math.round(b.left - c.right),
        gapToEdge: Math.round(list.right - b.right),
        tip: Boolean(unitHead.querySelector('.advice-value-tip')),
      };
    })(),
    // ⚠️ 旧的「抽卡方案浮层的权重列」判据已随 planTip() 一起删掉
    // （2026-10-11 第 10 轮：方案改成队伍口径，那个窗口不存在了）。
    // 队伍方案的**可点开详情**只有「总榜整包」那一处，仍由 frontierTip() 提供。
    weights: [ ...document.querySelectorAll('#adviceFrontierWeightRow input.advice-weight') ]
      .map((i) => i.value),
    // 开拓者的各命途形态在「已有」徽标上必须**一致**（要么全有、要么全没有）：
    // 用户 2026-10 要求「开拓者及其不同命途的变体应当视为已拥有」——保留 4 个、
    // 只给当前那一个上徽标就是没做。这段只是界面侧的一致性检查，真正的判据在
    // herta-test 那条「真实数据集 + 真实中英映射」的用例里（它知道账号有没有开拓者）。
    trailblazerOwn: (() => {
      const rows = [ ...document.querySelectorAll('#adviceChars .advice-char') ]
        .filter((n) => /开拓者/.test(n.querySelector('.advice-char-name')?.textContent || ''));
      const withBadge = rows.filter((n) => n.querySelector('.advice-own-badge')).length;
      return { rows: rows.length, withBadge };
    })(),
    // ⚠️ 键名别再叫 planWeights：上面 104 行已经用它存「方案权重那块容器的位置」，
    // 同一个对象字面量里重复的键会让后者覆盖前者（后者是数组、没有 top 属性），
    // 于是 budgetAboveWeights 那条断言恒为假 —— 一个静默失效了很久的测试 bug
    // （本套件平时没浏览器就被跳过，所以一直没暴露）。
    // 只剩一套权重，所以「权重当前值」只有一份（原来的 planWeightsValues 已删）
    weightValues: [ ...document.querySelectorAll('#adviceFrontierWeightRow input.advice-weight') ]
      .map((i) => i.value),
    headHeight: head ? Math.round(head.getBoundingClientRect().height) : null,
    headRows: new Set(kids.map((k) => k.top)).size,
    actionRows: new Set(actionKids.map((k) => k.top)).size,
    kids,
    actionKids,
    // 摘要占几行：它是内容驱动的，行数变化会改变整页高度，进而影响控件在视口里的位置
    summaryLines: (() => {
      const src = document.getElementById('adviceSource');
      if (!src) return null;
      const cs = getComputedStyle(src);
      const lh = parseFloat(cs.lineHeight) || 20;
      return Math.round(src.getBoundingClientRect().height / lh);
    })(),
    summaryStyle: (() => {
      const src = document.getElementById('adviceSource');
      if (!src) return null;
      const cs = getComputedStyle(src);
      const r = src.getBoundingClientRect();
      return [Math.round(r.height) + 'px', 'lh=' + cs.lineHeight, 'minH=' + cs.minHeight,
        'maxW=' + cs.maxWidth, 'w=' + Math.round(r.width)].join(' ');
    })(),
    scrollOverflow: document.scrollingElement
      ? document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth : false,
    label: document.getElementById('adviceMode')?.selectedOptions?.[0]?.textContent || '',
  };
})()`);

let failures = 0;
const results = [];
for (const width of [1920, 1440, 1280]) {
  // 顺序很重要：先导航、再套视口尺寸、最后硬刷新。
  // 反过来（先 setDeviceMetricsOverride 再导航）在本机实测会让导航失败成
  // chrome-error://chromewebdata/（ERR_CONNECTION_REFUSED），量出来全是 null。
  await send('Page.navigate', { url: ADVICE_URL });
  await sleep(1500);
  await send('Emulation.setDeviceMetricsOverride',
    { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.reload', { ignoreCache: false });
  await sleep(4000);
  // 等副本下拉框真的建出来再开始量
  for (let i = 0; i < 20; i += 1) {
    const ready = await evaluate(`Boolean(document.getElementById('adviceMode')?.options?.length)`);
    if (ready) break;
    await sleep(500);
  }
  const seen = [];
  // 值形如 `副本|关卡`（单档副本的关卡是空串）。异相仲裁两档各测一遍：
  // 以前「关卡」是独立控件，只有异相仲裁会多出一个下拉框，控件行因此在
  // 一行/两行之间来回换行、整排控件跳 131px；现在两者合成一个选择器，
  // 控件行宽度恒定，切到任何一档都不该动。
  for (const value of ['aa|', 'moc|', 'pf|', 'as|', 'aa|plight']) {
    await evaluate(`(() => {
      const m = document.getElementById('adviceMode');
      if (!m) throw new Error('页面还没切到抽卡推荐：'
        + location.href + ' | ' + (document.body.innerText || '').slice(0, 120));
      m.value = ${JSON.stringify(value)};
      m.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(1500);
    const m = await measure();
    seen.push(m);
    results.push({ width, value, ...m });
  }
  const modeTops = seen.map((s) => s.mode?.top);
  const reloadTops = seen.map((s) => s.reload?.top);
  const headTops = seen.map((s) => s.recordTop);
  const rows = seen.map((s) => s.headRows);
  const heights = seen.map((s) => s.headHeight);
  // 断言（随布局改过一次，说清楚现在的判据）：
  //
  // 当初的 bug 是「副本 / 关卡两个下拉框只有异相仲裁会多一个，控件行在一行与两行
  // 之间来回换行，整排控件跳 131px」。现在副本 / 版本已经挪到它们真正起作用
  // 的那一节里（顶部那排控件撤掉了），所以判据变成：
  //   * 顶部标题栏高度不随副本变化（不换行）；
  //   * 「战斗记录」这一节的位置不随副本变化（页面上方不能跳）；
  //   * 两个下拉框仍然存在（挪了位置但没丢），且不再询问投入金数；
  //   * 不出现横向滚动。
  // 副本框自己的 top 现在位于各节内容之后，会随内容长度变化，只作参考打印。
  const drift = Math.max(...modeTops) - Math.min(...modeTops);
  const reloadDrift = Math.max(...reloadTops) - Math.min(...reloadTops);
  const headDrift = Math.max(...headTops) - Math.min(...headTops);
  const heightChanged = new Set(heights).size > 1;
  const overflow = seen.some((s) => s.scrollOverflow);
  const fieldsPresent = seen.every((s) => s.fields?.mode && s.fields?.season && s.fields?.teamPlan);
  // 用户 2026-10-11 第 10 轮：旧的「预算控件 / 方案权重行」必须真的不在 DOM 里，
  // 而新的「队伍方案」容器必须在。三条合成一条判据。
  // ⚠️ 三个 id 的存在性必须在**页面里**量（`measure()` 的 `legacyBudgetBoxes`）——
  //    这一段跑在 node 里，写 `document.getElementById(...)` 会直接 ReferenceError
  //    （`feat/team-plan` 本轮没跑过 CDP，所以一直没暴露：那时 `s.teamPlan` 是 null，
  //    短路后面根本不会求值；收尾人把 id 修对之后它才浮出来）。
  const budgetRemoved = seen.every((s) => s.teamPlan
    && s.legacyBudgetBoxes === 0
    && s.legacyPlanWeightBoxes === 0);
  // 2026-10 的判据（都是用户点名的改动）：
  //   * 「你的补强路径」与「推荐阵容 · 按金数分档」两节必须撤掉；
  //   * 角色总榜（纯数据集口径）、抽卡方案（按角色池）都要有内容；
  //   * 权重是**两大类**（用户 2026-10-12 第 2 条）：关卡权重 5 个输入框 + 抽卡权重
  //     3 个（强度 / 性价比 / 泛用性），两类各带自己的摘要、共用一个「恢复默认」。
  const sectionsGone = seen.every((s) => !s.removedSections?.plan && !s.removedSections?.bands);
  const blocksPresent = seen.every((s) => s.frontierRows > 0 && s.teamRows > 0
    // ⚠️ 抽卡权重是 **3** 个输入框（用户 2026-10-13 第 1 条加了「泛用性」），
    // 从 v4.6.95 起写死 2 就会整条判红。
    && s.weightInputs === 5 && s.drawWeightInputs === 3 && s.legacyPlanWeightBoxes === 0
    && s.weightMeta?.frontier && s.weightMeta?.draw && s.weightMeta?.reset);
  // 性价比徽标必须**紧贴左边的花费文字**（用户要求从行尾移到左边），并且这一行
  // 带着详情内容节点（点它开大窗口）。
  // 判据：间距 ≤ 24px（实测 8px），且离容器右边缘 > 60px（`margin-left:auto` 时约等于 0）。
  // ⚠️ v4.6.61 换成大窗口后这两条**没有失效**（徽标位置没动，见 measure() 里的注释）；
  //    别因为它们原来配着「小浮层」就顺手删掉。
  const badgeOk = seen.every((s) => s.badge && s.badge.tip
    && s.badge.gapToText >= 0 && s.badge.gapToText <= 24 && s.badge.gapToEdge > 60);
  // ⚠️ 旧的「抽卡方案浮层的权重列不能是 ×—」那条判据已随 `planTip()` 一起删掉
  // （2026-10-11 第 10 轮：方案改成队伍口径，那个窗口不存在了）。
  // 开拓者的各命途形态「已有」徽标必须一致（见 measure() 里的注释）
  const trailblazerOk = seen.every((s) => !s.trailblazerOwn
    || s.trailblazerOwn.withBadge === 0
    || s.trailblazerOwn.withBadge === s.trailblazerOwn.rows);
  // ⚠️ 这里原来还串着 `tipWeightsOk`（旧「抽卡方案浮层的权重列不能是 ×—」那条判据）。
  //    `feat/team-plan` 删掉了那条判据（那个浮层随 `planTip()` 一起没了），但**忘了把它
  //    从这个与链里摘掉** —— 它成了未定义标识符；只因为 `budgetRemoved` 当时恒为 false
  //    被短路掉才没暴露。收尾人把 id 修对之后立刻 ReferenceError，遂摘掉。
  const ok = headDrift === 0 && reloadDrift === 0 && !heightChanged && !overflow
    && fieldsPresent && budgetRemoved && sectionsGone && blocksPresent && badgeOk && trailblazerOk;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} 视口 ${width}px`);
  console.log(`      战斗记录节 top: ${headTops.join(' / ')}   跳动 ${headDrift}px（断言必须为 0）`);
  console.log(`      重读本地数据 top: ${reloadTops.join(' / ')}   跳动 ${reloadDrift}px（断言必须为 0）`);
  console.log(`      副本框 top:     ${modeTops.join(' / ')}   跳动 ${drift}px（随内容变化，仅供参考）`);
  console.log(`      dash-head 高 ${heights.join('/')}px   标题/控件行数 ${rows.join('/')}`
    + (heightChanged ? '  ← 高度随副本变化' : ''));
  console.log(`      副本 / 版本下拉框：${fieldsPresent ? '都在 ✓' : `缺失 ${JSON.stringify(seen[0].fields)}`}`);
  console.log(`      不再询问投入金数：${budgetRemoved ? '✓' : '✗'}`
    + `（队伍方案块 top=${seen.map((s) => s.teamPlan?.top ?? 'null').join('/')}）`);
  console.log(`      两节已撤掉：${sectionsGone ? '✓' : `仍在 ${JSON.stringify(seen[0].removedSections)}`}`);
  console.log(`      总榜 ${seen[0].frontierRows} 行 / 队伍方案 ${seen[0].teamRows} 支`
    + ` / 补金顺序 ${seen[0].teamFills} 条 / 关卡权重框 ${seen[0].weightInputs} 个`
    + ` / 抽卡权重框 ${seen[0].drawWeightInputs} 个`
    + ` / 旧的方案权重块 ${seen[0].legacyPlanWeightBoxes} 个（应为 0）`
    + (blocksPresent ? ' ✓' : ' ← 缺内容或权重块数目不对'));
  console.log(`      性价比徽标：距左边文字 ${seen[0].badge?.gapToText}px / 距右边缘 ${seen[0].badge?.gapToEdge}px`
    + ` / 带详情内容节点 ${seen[0].badge?.tip ? '✓' : '✗'}` + (badgeOk ? ' ✓' : ' ← 应紧贴文字且不在行尾'));
  console.log(`      开拓者的「已有」徽标：上场率里 ${seen[0].trailblazerOwn?.rows ?? 0} 个形态，`
    + `${seen[0].trailblazerOwn?.withBadge ?? 0} 个带徽标` + (trailblazerOk ? ' ✓' : ' ← 各命途必须一致'));
  if (overflow) console.log('      ← 出现横向滚动');
  console.log('      dash-head 子元素: ' + seen[0].kids.map((k) => `${k.cls || '(左侧标题)'}=${k.h}px@${k.top}`).join(' '));
  for (const s of seen.slice(0, 4)) {
    console.log(`      [${s.label.slice(0, 12)}] 左侧 ${s.kids.find((k) => !k.cls)?.h}px `
      + `控件组@${s.kids.find((k) => k.cls?.includes('actions'))?.top} `
      + `副本框@${s.mode?.top} 摘要 ${s.summaryStyle}`);
  }
}

// 下面这些断言要看的是**宽屏**下的浮层与两套权重：先把视口固定成 1600×1000。
// 注意不能只 clearDeviceMetricsOverride 了事 —— 那会退回无头窗口的真实尺寸
// （约 800px 宽），于是浮层的窄屏样式（立绘与文字上下排）生效，顶部对齐的断言
// 会假失败（实测踩过）。
await send('Emulation.setDeviceMetricsOverride',
  { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
// 再开一次焦点模拟：后面的断言都要看**真的加载出来的图**（角色面板两张图、
// 总榜行图标、浮层配队头像），理由见脚本开头那一段。
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Page.reload', { ignoreCache: false });
await sleep(3000);

// ---- 数据状态：三份缓存的记录整合在一块（用户 2026-10-11）----------------------
//
// 用户原话：「将角色快照、战斗记录、黑塔网数据三者的缓存记录整合在一起，共同放置于
// 抽卡推荐下方，保持界面美观」。改前这三件事分在三处、写法还各不相同 ——
// `#adviceSnapshotFreshness`（正文最上面一行）/ `#recordFreshness`（① 那一节里）/
// `#adviceDataUpdated`（标题栏右侧一行小字）。这一节钉住整合后的形态：
//   * `#adviceDataStatus` 存在，且**在 ① 战斗记录与 ② 综合结论之上**（就在标题下方）；
//   * 三格是 `.data-status-grid` 的**直接子元素**（格子本身就是 `.data-freshness`，
//     中间不许再套一层 —— `renderDataStatusCell()` 是整块重写那一格的）；
//   * 三格各写自己的名字（角色快照 / 战斗记录 / 黑塔网数据），并且**都有字**
//     （有数据 = 状态 + 时间两行；没数据 = 空态也要说清怎么办，不能是空盒子）；
//   * 黑塔网那一格用**它自己的词**：`本机数据集 · 黑塔网聚合` + `生成于`。它不是账号接口的
//     本机缓存——它是本机 theherta/ 里的聚合数据集（见 `datasetFreshness()`）；
//   * 旧的三处不能留残影：`#adviceDataUpdated` 必须不存在、① 那一节里不能再有
//     `.data-freshness`、`#recordMeta` 不能再写「读取于」（那样同一份时间会在页面上
//     出现两次，正是这次要治的）；
//   * 宽屏（1600px）下三格**同一行**（top 相同、各列等宽）且不越出视口。
//
// ⚠️ 黑塔网那一格要等 `/api/archive` 回来才有字，所以这里轮询等它出现（最多 10 秒）。
//    轮询期间**不要**用「三格都非空」当条件 —— 本机没登录时快照 / 战斗记录那两格
//    本来就该是空态，那样会一直等下去。
console.log('\n▶ 数据状态：三份缓存的记录整合在标题下方');
let statusReport = null;
for (let i = 0; i < 20; i += 1) {
  statusReport = await evaluate(`(() => {
    const block = document.getElementById('adviceDataStatus');
    if (!block) return { block: false };
    const grid = block.querySelector('.data-status-grid');
    const cells = [ ...(grid ? grid.children : []) ];
    const rect = (n) => {
      const r = n.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right),
        w: Math.round(r.width), h: Math.round(r.height) };
    };
    const at = (id) => {
      const n = document.getElementById(id);
      return n ? Math.round(n.getBoundingClientRect().top) : -1;
    };
    return {
      block: true,
      vw: window.innerWidth,
      blockTop: Math.round(block.getBoundingClientRect().top),
      recordTop: at('adviceRecord'),
      conclusionTop: at('adviceConclusion'),
      headText: (block.querySelector('.data-status-head') || {}).textContent || '',
      cellIds: cells.map((n) => n.id),
      isFreshness: cells.map((n) => n.classList.contains('data-freshness')),
      leads: cells.map((n) => ((n.querySelector('.freshness-lead') || {}).textContent || '').trim()),
      details: cells.map((n) => ((n.querySelector('.freshness-details') || {}).textContent || '').trim()),
      rects: cells.map(rect),
      isEmpty: cells.map((n) => n.classList.contains('is-empty')),
      datasetText: ((document.getElementById('adviceDatasetFreshness') || {}).textContent || '').trim(),
      oldNode: Boolean(document.getElementById('adviceDataUpdated')),
      staleInRecord: document.querySelectorAll('#adviceRecord .data-freshness').length,
      recordMeta: ((document.getElementById('recordMeta') || {}).textContent || '').trim(),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  })()`);
  if (statusReport?.datasetText.includes('本机数据集')) break;
  await sleep(500);
}
{
  const r = statusReport || {};
  const cellIdsOk = (r.cellIds || []).join(',')
    === 'adviceSnapshotFreshness,recordFreshness,adviceDatasetFreshness'
    && (r.isFreshness || []).every(Boolean);
  const labelsOk = (r.leads || []).length === 3
    && r.leads[0].startsWith('角色快照') && r.leads[1].startsWith('战斗记录')
    && r.leads[2].startsWith('黑塔网数据');
  // 每格都要有字：`freshness-lead` 是「名字：[状态词] · 已存在 X」，`freshness-details`
  // 是「最后抓取：… · X 前」或空态那句「还没有读到…」。
  const filledOk = (r.leads || []).every((t) => t.length > 4)
    && (r.details || []).every((t) => t.length > 4);
  const datasetWordOk = r.datasetText.includes('本机数据集') && r.datasetText.includes('生成于：');
  const orderOk = r.block && r.blockTop >= 0 && r.blockTop < r.recordTop
    && r.blockTop < r.conclusionTop;
  const hintOk = String(r.headText || '').includes('只读本机');
  const noLeftoverOk = r.oldNode === false && r.staleInRecord === 0
    && !r.recordMeta.includes('读取于');
  const rects = r.rects || [];
  const oneRowOk = rects.length === 3 && new Set(rects.map((x) => x.top)).size === 1
    && rects.every((x) => x.left >= 0 && x.right <= r.vw && x.w > 150);
  const statusOk = Boolean(r.block) && cellIdsOk && labelsOk && filledOk && datasetWordOk
    && orderOk && hintOk && noLeftoverOk && oneRowOk && !r.overflowX;
  if (!statusOk) failures += 1;
  console.log(`  ${statusOk ? '✓' : '✗'} 三格与位置`);
  console.log(`      三格：${(r.cellIds || []).join(' / ')}`
    + `（都是 .data-freshness：${cellIdsOk ? '✓' : '✗'}）`);
  console.log(`      名字：${(r.leads || []).map((t) => JSON.stringify(t)).join('  ')}`);
  console.log(`      时间：${(r.details || []).map((t) => JSON.stringify(t)).join('  ')}`);
  console.log('      黑塔网那一格：' + JSON.stringify(r.datasetText || '')
    + (datasetWordOk ? ' ✓' : ' ← 必须写「本机数据集」+「生成于：」'));
  console.log(`      位置：块 top ${r.blockTop} < 战斗记录 ${r.recordTop} < 综合结论 ${r.conclusionTop}`
    + (orderOk ? ' ✓' : ' ✗'));
  console.log(`      标题行文案含「只读本机」：${hintOk ? '✓' : '✗'}`
    + ` / 三格一行（top ${rects.map((x) => x.top).join('/')} 宽 ${rects.map((x) => x.w).join('/')}，视口 ${r.vw}px）：${oneRowOk ? '✓' : '✗'}`);
  console.log(`      旧位置清干净：adviceDataUpdated ${r.oldNode ? '仍在 ✗' : '已删 ✓'}`
    + ` / ① 节里的 .data-freshness ${r.staleInRecord} 个（应为 0）`
    + ` / #recordMeta ${JSON.stringify(r.recordMeta)}（不该再写「读取于」）`);
  console.log(`      空态格：${(r.isEmpty || []).map((x, i) => `${(r.cellIds || [])[i]}=${x}`).join(' ')}`
    + '（本机没登录时快照 / 战斗记录两格为空态，属正常）');
  if (r.overflowX) console.log('      ← 出现横向滚动');
}

// ---- 两处入口弹出的是**同一个面板**（用户 2026-10 要求）------------------------
//
//   * 抽卡推荐页：战斗记录里点角色 chip；
//   * 角色信息页：点角色卡（改前这里写着一个不存在的标识符 `elementCn`，
//     点一下直接抛 ReferenceError，浮层根本弹不出来）。
//
// 判据：两个入口给出的面板结构完全一致（标题 / 两张图都真的加载出来 / hero 区 /
// 三块明细），并且「名字与图片顶部对齐」——改前文字被垂直居中到立绘腰上。
const panelProbe = `(() => {
  const modal = document.getElementById('charPanelModal');
  const body = document.getElementById('charPanelBody');
  const figs = [ ...(body?.querySelectorAll('.char-art') || []) ];
  const rect = (n) => { const r = n && n.getBoundingClientRect(); return r ? { top: Math.round(r.top), left: Math.round(r.left), h: Math.round(r.height) } : null; };
  return {
    hidden: modal?.hidden,
    title: document.getElementById('charPanelTitle')?.textContent || '',
    figures: figs.map((f) => ({
      cls: f.className,
      caption: f.querySelector('figcaption')?.textContent || '(无说明)',
      loaded: Boolean(f.querySelector('img')?.naturalWidth),
    })),
    hero: body?.querySelector('.char-hero-name')?.textContent || '',
    // 排版：hero **面板**的顶部应与立绘顶部齐平；面板里的文字要贴着面板顶部
    // （改前是整行 align-items: center，文字被垂直居中到立绘腰上，实测差 125px）
    artTop: rect(body?.querySelector('.char-art.is-character'))?.top ?? null,
    heroTop: rect(body?.querySelector('.char-hero'))?.top ?? null,
    heroTextTop: rect(body?.querySelector('.char-hero-text'))?.top ?? null,
    coneTop: rect(body?.querySelector('.char-art.is-cone'))?.top ?? null,
    blocks: [ ...(body?.querySelectorAll('.detail-block h4') || []) ].map((h) => h.textContent),
    // 技能等级默认收起；标题栏那个按钮应当在
    skillRows: (() => {
      const hs = [ ...(body?.querySelectorAll('.detail-block h4') || []) ];
      const skill = hs.find((h) => h.textContent === '技能');
      if (!skill) return 0;
      let n = 0;
      for (let s = skill.nextElementSibling; s && s.tagName !== 'H4'; s = s.nextElementSibling) n += 1;
      return n;
    })(),
    toggle: (() => {
      const b = document.getElementById('charPanelToggle');
      return b ? { hidden: b.hidden, text: b.textContent } : null;
    })(),
  };
})()`;

const judgePanel = (label, panel, expectFigures) => {
  // 排版断言（两条，都是「图片与文本的排版」这条需求的判据）：
  //   ① hero 面板的顶部与立绘顶部齐平（差 ≤ 8px）；
  //   ② 面板里的文字贴着面板顶部（差 ≤ 24px，那点差是面板自己的 padding），
  //      也就是「顶部对齐」而不是「垂直居中到立绘腰上」。
  const aligned = panel.heroTop !== null && panel.artTop !== null
    && Math.abs(panel.heroTop - panel.artTop) <= 8;
  const textAtTop = panel.heroTextTop !== null && panel.heroTop !== null
    && panel.heroTextTop - panel.heroTop <= 24;
  const figuresOk = !panel.hidden && panel.figures.length === expectFigures
    && panel.figures.every((f) => f.loaded) && Boolean(panel.hero);
  const ok = figuresOk && aligned && textAtTop;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label} → ${panel.title}`);
  console.log(`      立绘 ${panel.figures.length} 张：`
    + panel.figures.map((f) => `${f.cls.replace('char-art ', '')}=${f.caption}${f.loaded ? '' : '(图未加载)'}`).join(' / '));
  console.log(`      hero 区：${panel.hero || '(缺)'}   明细块：${panel.blocks.join(' / ') || '(缺)'}`
    + `   技能行 ${panel.skillRows}（默认应收起）`);
  console.log(`      顶部对齐：立绘 top=${panel.artTop} 面板 top=${panel.heroTop}`
    + ` 文字 top=${panel.heroTextTop} 卡面 top=${panel.coneTop}`
    + (aligned ? ' ✓' : ' ← hero 面板应与立绘顶部对齐')
    + (textAtTop ? '' : ' ← 文字该贴面板顶部，不要居中'));
  return panel;
};

console.log('\n▶ 角色面板浮层 · 入口一：抽卡推荐页的战斗记录');
await send('Page.navigate', { url: URL_TO_OPEN });
await sleep(4000);
for (let i = 0; i < 24; i += 1) {
  const ready = await evaluate(`Boolean(document.querySelector('#recordModes .record-chip.is-clickable'))`);
  if (ready) break;
  await sleep(500);
}

// ---- 战斗记录的角色 chip：外框**统一白色**（用户 2026-10-11）------------------------
//
// 用户原话：「战斗记录的角色的外框颜色统一为白色」。改前每张 chip 按角色属性上边框色
// （`is-fire` / `is-quantum` …，见 app.css 里那段已删注释），同一支队伍里四五种颜色，
// 比名字还抢眼。判据两条：
//   * 页面里**所有** chip 的 `border-top-color` 完全相同，且是白色（r=g=b，够亮）；
//   * DOM 上**不许**再挂属性 class（`is-fire` …）—— 只把 CSS 改成同色、class 还留着的话，
//     下一次有人给 `is-fire` 加回一条规则就又花了，那正是这次要撤掉的东西。
// ⚠️ 本机没登录 / 没抓过战绩时这一节没有 chip：那时只打印「无从验证」，**不判红**
//    （与下面「角色面板浮层 · 入口一」同一条规矩）。
const chipBorder = await evaluate(`(() => {
  const chips = [ ...document.querySelectorAll('#recordModes .record-chip') ];
  if (!chips.length) return { count: 0 };
  const nums = (s) => (s.match(/[0-9.]+/g) || []).map(Number);
  const first = getComputedStyle(chips[0]).borderTopColor;
  const bad = [ ...new Set(chips.map((c) => [ ...c.classList ]
    .filter((k) => k.indexOf('is-') === 0 && k !== 'is-clickable' && k !== 'is-unavailable'))) ]
    .filter((list) => list.length);
  return {
    count: chips.length,
    colors: [ ...new Set(chips.map((c) => getComputedStyle(c).borderTopColor)) ],
    firstRgb: nums(first),
    elementClassChips: bad.length,
    elementClasses: bad.map((list) => list.join('+')),
    samples: chips.slice(0, 4).map((c) => c.textContent.trim() + ' → ' + getComputedStyle(c).borderTopColor),
  };
})()`);
{
  const r = chipBorder;
  if (!r.count) {
    console.log('  （战斗记录里没有角色 chip —— 未登录或没抓过战绩时这一项无从验证）');
  } else {
    const [red, green, blue, alpha = 1] = r.firstRgb;
    const oneColor = r.colors.length === 1;
    const isWhite = red === green && green === blue && red >= 200 && alpha >= 0.3;
    const noElementClass = r.elementClassChips === 0;
    const ok = oneColor && isWhite && noElementClass;
    if (!ok) failures += 1;
    console.log(`  ${ok ? '✓' : '✗'} 角色 chip 外框统一白色（${r.count} 张）`);
    console.log(`      边框色：${oneColor ? r.colors[0] : `${r.colors.length} 种 → ${r.colors.join(' / ')}`}`
      + `${isWhite ? '（白）' : '（**不是白色**）'}`);
    console.log(`      属性 class：${noElementClass ? 'DOM 上已无 is-* ✓' : `仍有 ${r.elementClassChips} 张挂 ${r.elementClasses.join(' ')} ✗`}`);
    for (const s of r.samples) console.log(`      · ${s}`);
  }
}
const opened = await evaluate(`(() => {
  const chip = document.querySelector('#recordModes .record-chip.is-clickable');
  if (!chip) return '没有可点的角色 chip（可能未登录 / 没抓过战绩）';
  chip.click();
  return chip.textContent.trim();
})()`);
await sleep(2500);
const recordPanel = await evaluate(panelProbe);
if (String(opened).startsWith('没有可点的角色 chip')) {
  // ⚠️ 虚拟账号库（`tools/make-virtual-accounts.mjs`）每个账号都没有战斗记录，所以这两个
  //    入口在这里**无从验证** —— 打印跳过说明，别计失败（否则对虚拟库跑这套永远是红的）。
  console.log(`  – 点战斗记录的角色 chip：跳过（${opened}）`);
} else {
  judgePanel(`点战斗记录「${opened}」`, recordPanel, 2);
  // 关掉再走下一个入口（顺带验证「关得掉」—— 这条以前在角色信息页是坏的）
  const closed = await evaluate(`(() => {
    document.getElementById('charPanelClose')?.click();
    return document.getElementById('charPanelModal')?.hidden;
  })()`);
  if (closed !== true) {
    failures += 1;
    console.log('  ✗ 点「关闭」后浮层没有收起来');
  }
}

if (!recordPanel.figures.length) {
  console.log('  （未登录或没抓过战绩时这一项无从验证——需要先在「角色信息」页扫码并读一次战绩）');
} else {
  console.log('\n▶ 角色面板浮层 · 入口二：角色信息页点角色卡');
  await evaluate(`document.getElementById('tabRecords')?.click()`);
  await sleep(2500);
  for (let i = 0; i < 24; i += 1) {
    const ready = await evaluate(`Boolean(document.querySelector('.char-card'))`);
    if (ready) break;
    await sleep(500);
  }
  const cardName = await evaluate(`(() => {
    const card = document.querySelector('.char-card');
    if (!card) return null;
    card.click();
    return card.querySelector('.char-name')?.textContent || card.textContent.slice(0, 12);
  })()`);
  await sleep(2500);
  const cardPanel = await evaluate(panelProbe);
  judgePanel(`点角色卡「${cardName}」`, cardPanel, 2);
  // 两个入口给出的必须是**同一个界面**（结构一致）。
  //
  // ⚠️ 比较前要剔掉「随角色数据变化」的块：这里比的是**两个不同角色**（战斗记录里那条
  // 首发角色 vs 角色信息页第一张卡），而「忆灵」只有部分角色有（v4.6.29 起渲染）——
  // 不剔除就会把「开拓者带忆灵、流萤不带」当成界面结构不一致（实测误报过）。
  const structuralBlocks = (panel) => (panel.blocks || []).filter((b) => !/^忆灵/.test(b));
  const cardShape = JSON.stringify({
    figures: cardPanel.figures.length,
    hero: Boolean(cardPanel.hero),
    blocks: structuralBlocks(cardPanel),
  });
  const recordShapeOnly = JSON.stringify({
    figures: recordPanel.figures.length,
    hero: Boolean(recordPanel.hero),
    blocks: structuralBlocks(recordPanel),
  });
  const sameShape = recordShapeOnly === cardShape;
  if (!sameShape) failures += 1;
  console.log(`  ${sameShape ? '✓' : '✗'} 两个入口的面板结构一致（比较时忽略随角色变化的忆灵块）：`
    + `${recordShapeOnly}${sameShape ? ' == ' : ' != '}${cardShape}`);
  // 技能开关：默认收起，点一下要真的多出技能行（两个入口共用一个开关）
  const toggled = await evaluate(`(() => {
    const before = document.querySelectorAll('#charPanelBody .kv').length;
    document.getElementById('charPanelToggle')?.click();
    return before;
  })()`);
  await sleep(600);
  const after = await evaluate(panelProbe);
  const skillToggleOk = after.skillRows > 0 && after.toggle?.text.includes('隐藏');
  if (!skillToggleOk) failures += 1;
  console.log(`  ${skillToggleOk ? '✓' : '✗'} 「显示技能等级」：展开前 .kv ${toggled} 行 →`
    + ` 展开后技能 ${after.skillRows} 行，按钮文案「${after.toggle?.text}」`);
}

// ---- 权重只驱动两个榜的「分」（2026-10-11 第 10 轮起副本权重只剩一套）----------
//
// 演进：用户 2026-10 要求「性价比总榜和抽卡方案的权重相互独立」→ 两行输入框；
// 2026-10-11 第 10 轮又说「去掉方案权重那一行」—— 因为新的抽卡方案是**队伍口径**。
// 2026-10-12 第 2 条把权重分成两大类：**关卡权重**（下面这一段，一套同时驱动总榜与
// 抽卡方案的强度侧）+ **抽卡权重**（强度/性价比，见再下面那一段）。
console.log('\n▶ 关卡权重：一套驱动总榜（抽卡方案的强度得分也来自它）');
const badges = () => evaluate(`(() => {
  const pick = (sel) => document.querySelector(sel)?.querySelector('.advice-unit-value')?.textContent || null;
  const teamHead = document.querySelector('#adviceTeamPlanBody .advice-plan-team .advice-plan-team-head');
  return {
    frontier: pick('#adviceConclusionUnits .advice-unit'),
    // 队伍方案第一条的「总分」徽标（⚠️ 这一节自己也吃总榜权重，见下面的注释）
    plan: pick('#adviceTeamPlanBody .advice-plan-team'),
    // 队伍方案第一支队伍的成员名单（顺序与挑选都不该被权重改掉，只该改分数）
    roster: teamHead ? (teamHead.parentElement.querySelector('.advice-plan-team-slots')?.textContent || '').trim() : null,
    stored: {
      frontier: localStorage.getItem('hsr.advice.weights.frontier'),
      plan: localStorage.getItem('hsr.advice.weights.plan'),
    },
  };
})()`);
/** 往权重输入框里填一组值，等结论重算完（防抖 450ms + 服务端聚合）。 */
const setWeights = async (scope, values) => {
  // ⚠️ 只剩一套权重（2026-10-11 第 10 轮）：scope 参数保留是为了不改调用点，
  // 两个值现在都指同一个输入框行。
  const grid = 'adviceFrontierWeightRow';
  await evaluate(`(() => {
    const inputs = [ ...document.querySelectorAll('#${grid} input.advice-weight') ];
    const values = ${JSON.stringify(values)};
    inputs.forEach((input, i) => {
      input.value = String(values[i]);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return inputs.length;
  })()`);
  // 服务端要重算 5 个环境的完整阵容表，实测 1~4 秒；这里最多等 20 秒。
  const before = await badges();
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const now = await badges();
    if (now.frontier !== before.frontier || now.plan !== before.plan) {
      // 再等一拍，确保两边都渲染完
      await sleep(600);
      return badges();
    }
  }
  return badges();
};

// ⚠️ 先给异步的 `/conclusion` 一点时间再量第一次（2026-10-10）：
// 干净加载时总榜 0.5 秒就出来了（`tools/_probe-weights.mjs` 实测），而把同一段逻辑
// 放到干净加载里单独量是全绿的：总榜 910→1843 而方案恒为 1797，再反过来 1797→2160
// 而总榜不动 —— 所以口径没问题。
//
// ⚠️ **但这段等待并不能治好本机「独立跑时这里读到 null」那个现象**：实测把它从
// 20 秒加到 60 秒（还改成「第一行徽标连续两次可读」），那两次量到的仍然是 null，
// 而同一套在 `run-tests.mjs` 里反而全绿。所以那不是「还没渲染完」，更像是那段时间里
// `/conclusion` 根本没给出结果（切副本 × 5 + 紧跟的重算会连着打这个接口，它有节流）。
// 结论：这里只留 10 秒的短等待（对「页面刚加载完」这类正常时序有用），
// 别再往上加时间了 —— 红了先看 `#adviceConclusionUnits` 的文案是不是
// 「正在计算…」/「读取失败：…」，详见 HANDOFF §6.3 第 7 条。
let badgeStable = 0;
for (let i = 0; i < 20; i += 1) {
  const text = await evaluate("document.querySelector('#adviceConclusionUnits .advice-unit .advice-unit-value')?.textContent || ''");
  badgeStable = text ? badgeStable + 1 : 0;
  if (badgeStable >= 2) break;
  await sleep(500);
}
const base = await badges();
console.log(`  初始：总榜第一条 ${base.frontier} / 队伍方案第一条 ${base.plan}`);
// ⚠️ **读不到就当场把榜面的状态印出来**（上面那段注释里 HANDOFF §6.3 第 7 条要的那一眼）。
// 这一段是 2026-10-13 加的：以前红了只能看到一排 `null`，既分不清「视图没挂载」
// 「榜面在『正在计算…』」还是「接口报错」，也分不清是页面问题还是探针写错。
if (base.frontier === null) {
  const diag = await evaluate(`(() => {
    const box = document.getElementById('adviceConclusionUnits');
    const layout = document.getElementById('layoutAdvice');
    const tab = document.querySelector('.tab.is-active');
    return {
      activeTab: tab ? tab.dataset.view : null,
      adviceHidden: Boolean(layout && layout.hidden),
      boxExists: Boolean(box),
      unitRows: box ? box.querySelectorAll('.advice-unit').length : -1,
      valueNodes: box ? box.querySelectorAll('.advice-unit-value').length : -1,
      text: String(box && box.textContent || '').replace(/[\\s\\u3000]+/g, ' ').trim().slice(0, 140),
      drawInputs: document.querySelectorAll('#adviceDrawWeightRow input').length,
      frontierInputs: document.querySelectorAll('#adviceFrontierWeightRow input').length,
    };
  })()`);
  console.log(`  ⚠️ 总榜第一条读不到，榜面诊断：${JSON.stringify(diag)}`);
}
// ⚠️ 2026-10-11 第 10 轮起副本权重只有一套（用户：「去掉方案权重那一行」）：
// 抽卡方案的**强度得分**走同一条 `frontier` 口径的链，所以这一行会同时改两个榜的分数 ——
// 那是口径使然（两处本来就该同源），不再是「耦合没拆干净」。
// 输入框有 5 个，对应 ENV_WEIGHT_ROWS 的顺序（见 `advice.js`）。这里把两个不同的
// 副本各调一次，验证「同一个输入框真的驱动了两块」。
const afterWeights = await setWeights('frontier', [0, 1, 1, 1, 1]);
const boardChanged = afterWeights.frontier !== base.frontier;
const planChanged = afterWeights.plan !== base.plan;
// 判据只要求「总榜那条分变了」；队伍方案是否换名次取决于数据，所以只打印、不判红
// （否则会变成一个看数据脸色的死判据，见 HANDOFF §6.3 第 7 条的同款教训）。
if (!boardChanged) failures += 1;
console.log(`  ${boardChanged ? '✓' : '✗'} 改权重 → 总榜第一条 ${base.frontier} → ${afterWeights.frontier}`);
console.log(`  ${planChanged ? '✓' : '·'} 同一个输入框也驱动队伍方案：${base.plan} → ${afterWeights.plan}`);
const storedOk = Boolean(afterWeights.stored?.frontier);
if (!storedOk) failures += 1;
console.log(`  ${storedOk ? '✓' : '✗'} 权重存档在 hsr.advice.weights.frontier：${afterWeights.stored?.frontier}`);
// 收尾：恢复默认，别把测试用的权值留在用户的浏览器存档里（只剩总榜这一行）
await evaluate(`(() => {
  document.getElementById('adviceFrontierWeightsReset')?.click();
  return true;
})()`);
await sleep(1500);

// 清空输入框也必须是一次明确的「关闭该副本」：如果读值时把空串跳过，
// state.weights 会变回空覆盖表，服务端随后按默认权重计算。这里直接走真实 DOM
// 事件并检查 localStorage，钉住「界面空值 → 0」这条接线（用户 2026-10 要求）。
console.log('\n▶ 清空副本权重输入按 0 计算');
const clearedState = await evaluate(`(() => {
  const input = document.querySelector('#adviceFrontierWeightRow input.advice-weight');
  if (!input) return null;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem('hsr.advice.weights.frontier') || 'null'); } catch {}
  return { input: input.value, value: stored?.['aa|plight'] };
})()`);
const blankWeightOk = clearedState?.input === '' && clearedState?.value === 0;
if (!blankWeightOk) failures += 1;
console.log(`  ${blankWeightOk ? '✓' : '✗'} 清空「异相仲裁 · 绝境」后按 0 保存：`
  + `输入框=${JSON.stringify(clearedState?.input)} / 存档=${JSON.stringify(clearedState?.value)}`);
// 不把测试值留在用户浏览器里；这里只恢复总榜这一行，方案行已在上面恢复。
await evaluate(`document.getElementById('adviceFrontierWeightsReset')?.click()`);
await sleep(1500);

// ---- 抽卡权重：强度 / 性价比 / 泛用性（用户 2026-10-12 第 2、3、4 条 + 2026-10-13 第 1、2 条）
//
// ⚠️ 这一类权重的作用面在 v4.6.95 **翻了**：v4.6.94 时它不进服务端请求（只决定浏览器里
// `teamPlan()` 那两个分项怎么加权），所以当时这里断言「改它不该动角色总榜」。用户
// 2026-10-13 第 2 条要求**角色总榜受三个抽卡权重影响**，而总榜「每角色只留一条」的收敛
// 发生在服务端的 `buildConclusion` 里 —— 所以现在改它**必须**重算结论、**必须**动总榜。
// 这里钉五件事：① 三个输入框在、② 存档写进 `hsr.advice.drawWeights`、
// ③ 改它之后总榜那条分真的变了、④ 总榜摘要印归一化比例、
// ⑤ 抽卡方案那两个系数仍然只按「强度 : 性价比」两两归一（泛用性旋钮不许动方案）。
console.log('\n▶ 抽卡权重：强度 / 性价比 / 泛用性（改它要重算角色总榜）');
const drawProbe = () => evaluate(`(() => {
  const eq = document.querySelector('#adviceTeamPlanBody .advice-plan-team .advice-plan-team-eq');
  const board = document.querySelector('#adviceConclusionUnits .advice-unit .advice-unit-value');
  return {
    eq: eq ? eq.textContent : null,
    board: board ? board.textContent : null,
    inputs: [ ...document.querySelectorAll('#adviceDrawWeightRow input.advice-draw-weight') ].map((i) => i.value),
    meta: document.getElementById('adviceDrawWeightsMeta')?.textContent || null,
    stored: localStorage.getItem('hsr.advice.drawWeights'),
  };
})()`);
/** 往抽卡权重输入框里填一组值，等角色总榜重算完（防抖 + 服务端聚合，最多 20 秒）。 */
const setDrawWeights = async (values) => {
  await evaluate(`(() => {
    const inputs = [ ...document.querySelectorAll('#adviceDrawWeightRow input.advice-draw-weight') ];
    const values = ${JSON.stringify(values)};
    inputs.forEach((input, i) => {
      input.value = String(values[i]);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return inputs.length;
  })()`);
  const before = await drawProbe();
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const now = await drawProbe();
    if (now.board !== before.board) {
      // 再等一拍，确保榜面与方案都渲染完
      await sleep(600);
      return drawProbe();
    }
  }
  return drawProbe();
};
const drawBase = await drawProbe();
const drawInputsOk = drawBase.inputs.length === 3;
if (!drawInputsOk) failures += 1;
console.log(`  ${drawInputsOk ? '✓' : '✗'} 抽卡权重有 3 个输入框（强度 / 性价比 / 泛用性）`);
console.log(`  初始：${drawBase.eq}`);
console.log(`        摘要 ${drawBase.meta}`);
// 3 : 1 : 1 → **总榜与抽卡方案都是** 0.6 / 0.2 / 0.2（用户 2026-10-13 第 3 条原话：
// 「泛用性权重也适用于补金推荐」）。v4.6.95/96 时方案只吃强度/性价比、两项自己再归一，
// 所以那时这里钉的是「方案印 × 0.75 / × 0.25」——**已经反过来**了。
const drawAfter = await setDrawWeights([3, 1, 1]);
const drawEqOk = Boolean(drawAfter.eq && drawAfter.eq.includes('× 0.6')
  && drawAfter.eq.includes('× 0.2') && drawAfter.eq.includes('泛用性'));
if (!drawEqOk) failures += 1;
console.log(`  ${drawEqOk ? '✓' : '✗'} 抽卡方案三项一起归一 → 0.6 / 0.2 / 0.2，`
  + `且等式里带「泛用性」—— ${drawAfter.eq}`);
const drawMetaOk = Boolean(drawAfter.meta && drawAfter.meta.includes('强度 60%')
  && drawAfter.meta.includes('性价比 20%') && drawAfter.meta.includes('泛用性 20%'));
if (!drawMetaOk) failures += 1;
console.log(`  ${drawMetaOk ? '✓' : '✗'} 总榜摘要印归一化比例（60 / 20 / 20）—— ${drawAfter.meta}`);
const drawStoredOk = Boolean(drawAfter.stored && /"strength":3/.test(drawAfter.stored));
if (!drawStoredOk) failures += 1;
console.log(`  ${drawStoredOk ? '✓' : '✗'} 抽卡权重存档在 hsr.advice.drawWeights：${drawAfter.stored}`);
// ⚠️ 这条断言在 v4.6.94 是**反向**的（「角色总榜不受抽卡权重影响」）；用户 2026-10-13
// 第 2 条把口径翻了过来 —— 现在总榜**必须**跟着变，不变就说明权重没送到服务端。
const drawBoardOk = drawAfter.board !== drawBase.board;
if (!drawBoardOk) failures += 1;
console.log(`  ${drawBoardOk ? '✓' : '✗'} 角色总榜受抽卡权重影响：`
  + `${drawBase.board} → ${drawAfter.board}`);
// 收尾：恢复默认（同一个按钮管两大类）。
await evaluate(`document.getElementById('adviceFrontierWeightsReset')?.click()`);
await sleep(2500);
const drawReset = await drawProbe();
// ⚠️ 恢复默认 = 三个框都回到 1 → 三等分 → `formatShare(1/3)` 印成 `0.33`
//（`toFixed(2)` 去掉尾零）。v4.6.95/96 时是两项 `0.5 / 0.5`，别再按那个写。
const drawResetOk = (drawReset.inputs || []).join(',') === '1,1,1'
  && Boolean(drawReset.eq && drawReset.eq.includes('× 0.33'));
if (!drawResetOk) failures += 1;
console.log(`  ${drawResetOk ? '✓' : '✗'} 「恢复默认」把抽卡权重也还原成 1 : 1 : 1 —— ${drawReset.eq}`);

// ---- 总榜行图标 / 详情大窗口 / 文案（用户 2026-10 点名的四条）--------------------
//
// 这一节验的是**用户真的能看到的界面**，所以要先回到抽卡推荐页（上面刚点过
// 「角色信息」分页），并且要在**宽屏**（1600×1000）下量。
//
// 四条要求对应这几组断言：
//   ① 总榜每一行有「角色头像 + 光锥图标」两张图，且至少一张**真的加载出来**
//      （`naturalWidth > 0`，不是只看 `src` —— handoff §6.1 第 12 条）；
//   ② **点击**性价比得分徽标 → 居中的**大窗口**（2026-10-10 第二轮，v4.6.61）：
//      窗口里出现配队卡片（头像真加载）、贡献值来源表、改名后的「该角色的全部配队」、
//      七条脚注；并断言卡片四边在可见区内、正文自己可滚、背后页面滚动被锁、
//      **ESC 与点背景**都能关且内容节点回到徽标里；顺带守一条 2026-10-10 第一轮的
//      「滚动不自动隐藏」（v4.6.59）；
//   ③ 界面上不再有「差这一档」（连死样式一起清掉）、总榜不再写「赛季」、花费文案简化；
//   ④ ⚠️ 不要写死总榜的**条数或名次**：总榜口径（每个角色只出场一次 / 按版本加权 /
//      同金数比限定光锥数）一直在改，行数与顺序都会变。这里一律用「第一行」或
//      「任意一行」来定位。

/** 把一个容器里的图都逼出来：先滚进视口、再滚一遍，最后对没加载出来的有界重试。 */
const settleImages = async (containerId, { rounds = 4 } = {}) => {
  const id = JSON.stringify(containerId);
  // 容器在窗口视口之外时，懒加载（loading="lazy"）**永远不会触发**，所以先滚进来。
  await evaluate(`document.getElementById(${id}).scrollIntoView({ block: 'center' })`);
  await sleep(900);
  const height = await evaluate(`document.getElementById(${id}).scrollHeight`);
  for (let y = 0; y <= height; y += 150) {
    await evaluate(`document.getElementById(${id}).scrollTop = ${y}`);
    await sleep(120);
  }
  await evaluate(`document.getElementById(${id}).scrollTop = 0`);
  await sleep(2000);
  // 有界重试：图标走的 cdn.jsdelivr.net 对 `@master` 这种分支引用，未命中缓存时会
  // 302 到 raw.githubusercontent.com，而本机对后者的连通性不稳定（实测同一批 160 张里
  // 有十几张一次失败，重新赋 src 再取就成功 —— 第一次请求已经把它灌进 jsdelivr 的缓存）。
  // 所以这里对「还没加载出来」的图重设 src，最多 `rounds` 轮。
  for (let round = 0; round < rounds; round += 1) {
    const left = await evaluate(`(() => {
      const imgs = [ ...document.querySelectorAll('#' + ${id} + ' img') ]
        .filter((i) => i.naturalWidth === 0);
      for (const img of imgs) {
        img.classList.remove('is-missing');
        const url = img.getAttribute('src');
        img.removeAttribute('src');
        img.src = url;
      }
      return imgs.length;
    })()`);
    if (!left) break;
    await sleep(2500);
  }
};

console.log('\n▶ 总榜行图标 / 详情大窗口 / 文案（用户 2026-10 的四条）');
await send('Page.navigate', { url: ADVICE_URL });
await sleep(3000);
for (let i = 0; i < 24; i += 1) {
  if (await evaluate("Boolean(document.querySelector('#adviceConclusionUnits .advice-unit'))")) break;
  await sleep(500);
}
await sleep(1500);

// ③④ 文案：不再有「差这一档」（文案 + 徽标 + 死样式三处都要干净），
//     总榜里不再出现「赛季」，改为「版本」。
const copyProbe = await evaluate(`(() => {
  const page = document.getElementById('layoutAdvice')?.innerText || '';
  const units = document.getElementById('adviceConclusionUnits')?.innerText || '';
  const envTitles = [ ...document.querySelectorAll('#adviceConclusionUnits .advice-unit-env') ]
    .map((n) => n.title || '');
  const gapRule = [ ...document.styleSheets ].some((sheet) => {
    try {
      return [ ...sheet.cssRules ].some((r) => (r.selectorText || '').includes('advice-unit-gap'));
    } catch { return false; }
  });
  return {
    gapText: page.includes('差这一档'),
    gapBadge: Boolean(document.querySelector('#layoutAdvice .advice-unit-gap')),
    unitsSeason: units.includes('赛季'),
    envTitleSeason: envTitles.some((t) => t.includes('赛季')),
    envTitleVersion: envTitles.some((t) => t.includes('版本')),
    envTitleCount: envTitles.length,
    gapRule,
  };
})()`);
const copyOk = !copyProbe.gapText && !copyProbe.gapBadge && !copyProbe.unitsSeason
  && !copyProbe.envTitleSeason && copyProbe.envTitleVersion && !copyProbe.gapRule;
if (!copyOk) failures += 1;
console.log(`  ${copyOk ? '✓' : '✗'} 文案与死样式：`
  + `「差这一档」文字 ${copyProbe.gapText ? '仍在' : '没了'} / 徽标 ${copyProbe.gapBadge ? '仍在' : '没了'}`
  + ` / 采样到的赛季文案 ${copyProbe.unitsSeason ? '仍在' : '没了'}`
  + `（副本 chip 的 title ${copyProbe.envTitleCount} 条：`
  + `赛季 ${copyProbe.envTitleSeason ? '有' : '无'}、版本 ${copyProbe.envTitleVersion ? '有' : '无'}）`
  + ` / .advice-unit-gap 规则 ${copyProbe.gapRule ? '仍在' : '已删'}`);

// ⑤ 星魂档筛选：用户 2026-10-11 报的缺陷 ——「性价比总榜-全部榜单目前做的比较不错，
//    但拆分到 E0/1/2/6，则只能看到存在最佳成绩的角色，而看不到非最佳成绩的每个角色」。
//
//    修法是**服务端另发一份 `frontierTiers`**（每个档位各自按角色收敛一条），界面切档时
//    换用它。所以这条界面断言必须问三件事，缺一条都测不出这个缺陷：
//      * 切到某一档后，**渲染出来的行**都是那一档（不能混档）、且行数 = 筛选器上的计数；
//      * 这一档里出现了**「全部」看不到的角色**（旧口径下它们整行消失）—— 这才是缺陷判据；
//      * 切回「全部」行数还原（切档不是破坏性的）。
//    ⚠️ 一律不写死行数或名次（口径会变），只比「这一档 vs 全部」两侧的集合关系。
console.log('\n▶ 星魂档筛选：每一档都看得到「最佳成绩不在这一档」的角色（用户 2026-10-11）');
const tierProbe = await evaluate(`(() => {
  const chips = () => [ ...document.querySelectorAll('#adviceUnitFilter .advice-filter') ];
  const chipOf = (label) => chips().find((c) => (c.textContent || '').trim().startsWith(label + ' '));
  const chipCount = (label) => {
    const chip = chipOf(label);
    if (!chip) return null;
    const n = Number(((chip.textContent || '').trim().split(/\\s+/).pop() || ''));
    return Number.isFinite(n) ? n : null;
  };
  const rows = () => [ ...document.querySelectorAll('#adviceConclusionUnits .advice-unit') ];
  const nameOf = (r) => r.querySelector('.advice-unit-name')?.textContent || '';
  const kindOf = (r) => (r.querySelector('.advice-unit-kind')?.textContent || '').trim();
  const click = (label) => { const c = chipOf(label); if (!c) return false; c.click(); return true; };
  const out = { chips: chips().map((c) => (c.textContent || '').trim()), tiers: {} };
  click('全部');
  out.allRows = rows().length;
  out.allNames = rows().map(nameOf);
  out.allKinds = [ ...new Set(rows().map(kindOf)) ].sort();
  // ⚠️ 判据必须是「**同名的角色**在这一档里的行，档位与它在『全部』里那一行不同」，
  // 不能比「名字没出现过」：一个角色只要进了榜就一定会出现在「全部」里（不论哪一档），
  // 所以名字集合本来就是重叠的 —— 旧口径丢掉的是**这一档的那一行**，不是那个角色。
  const allTierByName = {};
  rows().forEach((r) => { allTierByName[nameOf(r)] = kindOf(r); });
  for (const label of ['E0', 'E1', 'E2', 'E6']) {
    if (!chipOf(label)) continue;
    click(label);
    const now = rows();
    out.tiers[label] = {
      chip: chipCount(label),
      rows: now.length,
      kinds: [ ...new Set(now.map(kindOf)) ].sort(),
      // 在这一档里有行、但在「全部」里那一行的档位**不是**这一档的角色
      // = 旧口径下会整行消失的那些（它们的最佳成绩在别的档位）。
      newcomers: now.map(nameOf).filter((n) => allTierByName[n] && allTierByName[n] !== label),
      unknown: now.map(nameOf).filter((n) => !allTierByName[n]),
      meta: document.getElementById('adviceUnitMeta')?.textContent || '',
    };
  }
  click('全部');
  out.backRows = rows().length;
  out.backKinds = [ ...new Set(rows().map(kindOf)) ].sort();
  out.conclusionMeta = document.getElementById('adviceConclusionMeta')?.textContent || '';
  out.filterTitles = chips().map((c) => c.title || '');
  return out;
})()`);
const tierLabels = Object.keys(tierProbe.tiers);
// ⚠️ 界面只渲染前 `UNIT_ROWS_MAX`（80）条，chip 上的计数是**榜上的完整条数** ——
// 池改成「全部成绩」之后 E6 档有 84 条，两者不再永远相等，所以按 min(chip, 80) 比。
// 80 这个数必须与 `advice-view.js` 的 `UNIT_ROWS_MAX` 一致。
const UNIT_ROWS_MAX = 80;
const tierShapeOk = tierLabels.length >= 3 && tierLabels.every((label) => {
  const t = tierProbe.tiers[label];
  return t.rows > 0 && t.rows === Math.min(t.chip, UNIT_ROWS_MAX)
    && t.kinds.length === 1 && t.kinds[0] === label;
});
const tierGrew = tierLabels.filter((label) => tierProbe.tiers[label].newcomers.length > 0);
const tierOk = tierShapeOk && tierGrew.length > 0
  && tierProbe.backRows === tierProbe.allRows
  && tierProbe.backKinds.length === tierProbe.allKinds.length;
if (!tierOk) failures += 1;
console.log(`  ${tierOk ? '✓' : '✗'} 星魂档筛选共 ${tierProbe.chips.length} 个 chip`
  + `（${tierProbe.chips.join(' / ')}）`);
console.log(`      全部 ${tierProbe.allRows} 行（${tierProbe.allKinds.join(' ')}） → 切档后：`
  + tierLabels.map((label) => {
    const t = tierProbe.tiers[label];
    return `${label} ${t.rows} 行[${t.kinds.join('')}/${t.chip}]`;
  }).join('  ')
  + ` → 切回全部 ${tierProbe.backRows} 行`);
console.log(`      ${tierShapeOk ? '✓' : '✗'} 每一档的行数 = 筛选器计数、且行内档位一律是它自己`
  + `（混档 ${tierLabels.filter((l) => tierProbe.tiers[l].kinds.length !== 1).length} 个）`);
console.log(`      ${tierGrew.length ? '✓' : '✗'} 「最佳成绩不在这一档」的角色真的出现了（在「全部」里它们的档位不是这一档）：`
  + tierLabels.map((label) => `${label} +${tierProbe.tiers[label].newcomers.length}`).join(' / ')
  + `（旧口径下这些角色在对应档位里整行消失）`);
console.log(`      ${tierProbe.backRows === tierProbe.allRows ? '✓' : '✗'} 切回「全部」行数还原`
  + `（${tierProbe.allRows} → ${tierProbe.backRows}）`
  + ` / 总榜统计行：「${tierProbe.conclusionMeta}」`);

// ③′ 总榜行的花费：用户 2026-10-10 第 3 条「角色+光锥介绍简化，文本不用重复，
//     3金要用白色加粗」。改前那一格是 `E2 + 本体 + 菇菇嘎嘎历险记 S5 · 3 金`，
//     星魂档在行里重复了第二遍（`.advice-unit-kind` 已经有一个 E2）、「本体」是废话。
//     判据三条：
//       * 花费格里的旧写法（`本体` / 开头的 `E数字`）**查不到**；
//       * 花费格只剩「[+ 光锥名 [S叠影] · ]N 金」这一种形状（没光锥的整包就只有 N 金）；
//       * 那个数字是 `.advice-gold-num`：颜色白、加粗（实测 rgb(255,255,255) / 700）。
const costProbe = await evaluate(`(() => {
  const rows = [ ...document.querySelectorAll('#adviceConclusionUnits .advice-unit') ];
  const costs = rows.map((r) => r.querySelector('.advice-unit-cost')?.textContent || '');
  const nums = [ ...document.querySelectorAll('#adviceConclusionUnits .advice-unit-cost .advice-gold-num') ];
  const styles = nums.map((n) => {
    const cs = getComputedStyle(n);
    return { color: cs.color, weight: Number(cs.fontWeight) || 0 };
  });
  // 用户 2026-10-10 第 8 轮：「s1 和 8 金应该隔开一点点」。改前分隔符是没有 class 的
  // span、两侧空格被 HTML 折叠，实测净间隙只有 2.9px（就剩「·」一个字符）。
  // 这条量的是**光锥名那一段的右缘** 到 **「N 金」那一段的左缘** 的真实像素。
  const gaps = rows.map((r) => {
    const cost = r.querySelector('.advice-unit-cost');
    if (!cost) return null;
    const t = cost.querySelector('.advice-unit-cone-text');
    const g = cost.querySelector('.advice-gold');
    const sep = cost.querySelector('.advice-unit-sep');
    if (!t || !g) return null;
    return {
      sep: Boolean(sep),
      sepPre: sep ? getComputedStyle(sep).whiteSpace : null,
      gap: Math.round((g.getBoundingClientRect().left - t.getBoundingClientRect().right) * 10) / 10,
    };
  }).filter(Boolean);
  return {
    rows: rows.length,
    legacy: costs.filter((t) => t.includes('本体') || /(^|\\s)E\\d/.test(t)),
    odd: costs.filter((t) => !/^(\\+ .+ · )?\\d+ 金$/.test(t)),
    goldNums: nums.length,
    notWhite: styles.filter((s) => s.color !== 'rgb(255, 255, 255)').length,
    notBold: styles.filter((s) => s.weight < 600).length,
    sample: costs[0] || '',
    sampleStyle: styles[0] || null,
    gapCount: gaps.length,
    gapNoSep: gaps.filter((g) => !g.sep).length,
    gapTooSmall: gaps.filter((g) => g.gap < 6).length,
    gapMin: gaps.length ? Math.min(...gaps.map((g) => g.gap)) : null,
    gapMax: gaps.length ? Math.max(...gaps.map((g) => g.gap)) : null,
  };
})()`);
const costTextOk = costProbe.rows > 0 && costProbe.legacy.length === 0 && costProbe.odd.length === 0;
const goldStyleOk = costProbe.goldNums > 0 && costProbe.notWhite === 0 && costProbe.notBold === 0;
// 「名称 S层」与「N 金」之间必须有真实间隙（≥6px）——见上面那段注释。
const costGapOk = costProbe.gapCount > 0 && costProbe.gapNoSep === 0 && costProbe.gapTooSmall === 0;
const costOk = costTextOk && goldStyleOk && costGapOk;
if (!costOk) failures += 1;
console.log(`  ${costOk ? '✓' : '✗'} 总榜花费文案（用户 2026-10-10 第 3 条）：`
  + `${costProbe.rows} 行，首行 ${JSON.stringify(costProbe.sample)}`
  + ` / 旧写法（本体 / 开头的 E 数字）${costProbe.legacy.length
    ? `仍在 ${JSON.stringify(costProbe.legacy.slice(0, 3))}` : '查不到 ✓'}`
  + ` / 形状不符 ${costProbe.odd.length ? JSON.stringify(costProbe.odd.slice(0, 3)) : '无 ✓'}`);
console.log(`      ${goldStyleOk ? '✓' : '✗'} 「N 金」的数字：${costProbe.goldNums} 个 .advice-gold-num`
  + `，白色 ${costProbe.notWhite === 0 ? '✓' : `✗（${costProbe.notWhite} 个不是 rgb(255, 255, 255)）`}`
  + `，加粗 ${costProbe.notBold === 0 ? '✓' : `✗（${costProbe.notBold} 个 font-weight < 600）`}`
  + `（首个 ${JSON.stringify(costProbe.sampleStyle)}）`);
console.log(`      ${costGapOk ? '✓' : '✗'} 「S叠影」与「N 金」之间的间隙`
  + `（用户 2026-10-10 第 8 轮，判据 ≥6px）：${costProbe.gapCount} 行可量`
  + ` / 缺分隔段的 ${costProbe.gapNoSep} 行 / 间隙过小的 ${costProbe.gapTooSmall} 行`
  + `（实测 ${costProbe.gapMin}~${costProbe.gapMax}px）`);

// ① 总榜行图标
await settleImages('adviceConclusionUnits');
const iconProbe = await evaluate(`(() => {
  const list = [ ...document.querySelectorAll('#adviceConclusionUnits .advice-unit') ];
  const noImg = [];
  const notLoaded = [];
  const noCone = [];
  // 用户 2026-10-10 第三轮：「光锥图标还是移动到左边好看，但要保证光锥位于加号右侧、
  // 名称左侧，且名称必须带有叠影层数（S1-S5）」。
  // 判据（**DOM 顺序**与**实际像素**都要，只看一条会被 flex 的 order 之类骗过去）：
  //   * 花费格里必须有 .advice-unit-plus / .advice-unit-cone / .advice-unit-cone-text
  //     三段，且图标在 DOM 上排在光锥名**前面**；
  //   * 图标左边缘 >= 加号右边缘、右边缘 <= 光锥名左边缘（同一行时）；
  //   * 光锥名的文字**必须以 S1~S5 结尾**（用户点名「名称必须带有叠影层数」；
  //     改前 S1 被省略，实测 67 行里有 29 行看不到层数）。
  // ⚠️ 注入代码里**不能出现反引号**（handoff §6.1 第 16 条）：这整段套在模板字符串里，
  //    注释里写一个反引号就会把字符串提前截断、后面的中文被当代码解析。
  //    （上一轮真踩了：报 ReferenceError: unit is not defined，正是这里。）
  const coneSide = list.map((row) => {
    const cost = row.querySelector('.advice-unit-cost');
    const icon = row.querySelector('.advice-unit-cone');
    if (!cost || !icon) return null;
    const plusNode = cost.querySelector('.advice-unit-plus');
    const textNode = cost.querySelector('.advice-unit-cone-text');
    if (!textNode) return { text: null };
    const ir = icon.getBoundingClientRect();
    const pr = plusNode ? plusNode.getBoundingClientRect() : null;
    const tr = textNode.getBoundingClientRect();
    // 同一行时要求严格夹在加号与名字之间；换了行（窄屏）退化成「不早于加号、不晚于名字」。
    const sameLine = ir.top < tr.bottom - 2 && ir.bottom > tr.top + 2;
    return {
      inside: cost.contains(icon),
      text: textNode.textContent,
      hasPlus: Boolean(plusNode),
      hasSuperimp: / S[1-5]$/.test(textNode.textContent),
      sameLine,
      afterPlus: !pr || ir.left >= pr.right - 1,
      beforeName: sameLine ? ir.right <= tr.left + 1 : ir.top <= tr.top,
    };
  }).filter(Boolean);
  list.forEach((row, i) => {
    const name = row.querySelector('.advice-unit-name')?.textContent || '?';
    const imgs = [ ...row.querySelectorAll('img') ];
    if (!imgs.length) noImg.push(i + 1);
    else if (!imgs.some((x) => x.naturalWidth > 0)) notLoaded.push(i + 1);
    if (!row.querySelector('.advice-unit-cone')) noCone.push(name);
  });
  const all = [ ...document.querySelectorAll('#adviceConclusionUnits img') ];
  return {
    rows: list.length,
    avatarSlots: document.querySelectorAll('#adviceConclusionUnits .advice-unit-avatar').length,
    avatarImgs: document.querySelectorAll('#adviceConclusionUnits img.advice-unit-avatar').length,
    coneImgs: document.querySelectorAll('#adviceConclusionUnits img.advice-unit-cone').length,
    loadedImgs: all.filter((i) => i.naturalWidth > 0).length,
    missingImgs: all.filter((i) => i.classList.contains('is-missing')).length,
    noImg,
    notLoaded,
    noCone,
    coneSide: coneSide.length,
    coneOutside: coneSide.filter((c) => !c.inside).length,
    coneNoText: coneSide.filter((c) => c.text === null).length,
    coneNoPlus: coneSide.filter((c) => c.hasPlus !== true).length,
    coneAfterPlus: coneSide.filter((c) => c.afterPlus === false).length,
    coneAfterName: coneSide.filter((c) => c.beforeName === false).length,
    coneNoSuperimp: coneSide.filter((c) => c.hasSuperimp !== true).length,
    coneSample: coneSide[0] || null,
    coneNoSuperimpSample: coneSide.find((c) => c.hasSuperimp !== true)?.text ?? null,
  };
})()`);
const iconsOk = iconProbe.rows > 0 && iconProbe.noImg.length === 0
  && iconProbe.notLoaded.length === 0 && iconProbe.avatarSlots === iconProbe.rows
  && iconProbe.avatarImgs > 0 && iconProbe.coneImgs > 0 && iconProbe.noCone.length === 0
  // 光锥图标必须在花费格里、夹在「+」与光锥名之间，且名字带叠影层数（见上面那段注释）
  && iconProbe.coneSide > 0 && iconProbe.coneOutside === 0
  && iconProbe.coneNoText === 0 && iconProbe.coneNoPlus === 0
  && iconProbe.coneAfterPlus === 0 && iconProbe.coneAfterName === 0
  && iconProbe.coneNoSuperimp === 0;
if (!iconsOk) failures += 1;
console.log(`  ${iconsOk ? '✓' : '✗'} 总榜 ${iconProbe.rows} 行：头像槽 ${iconProbe.avatarSlots} 个`
  + `（其中 img ${iconProbe.avatarImgs} 个）/ 光锥图标 ${iconProbe.coneImgs} 个`
  + ` / 真的加载出来 ${iconProbe.loadedImgs} 张，隐藏的碎图 ${iconProbe.missingImgs} 张`);
console.log(`      没有 img 的行：${iconProbe.noImg.length ? JSON.stringify(iconProbe.noImg) : '无'}`
  + `   一张都没加载出来的行：${iconProbe.notLoaded.length ? JSON.stringify(iconProbe.notLoaded) : '无'}`
  + `   缺光锥图标的行：${iconProbe.noCone.length ? JSON.stringify(iconProbe.noCone) : '无'}`);
// ①②′ 光锥图标的位置（用户 2026-10-10 第三轮）：在花费格里，夹在「+」与光锥名之间。
const coneSideOk = iconProbe.coneSide > 0 && iconProbe.coneOutside === 0
  && iconProbe.coneNoText === 0 && iconProbe.coneNoPlus === 0
  && iconProbe.coneAfterPlus === 0 && iconProbe.coneAfterName === 0;
console.log(`  ${coneSideOk ? '✓' : '✗'} 光锥图标在「+」右侧、名称左侧（用户 2026-10-10 第三轮）：`
  + `${iconProbe.coneSide} 行可量 / 不在花费格里的 ${iconProbe.coneOutside} 行`
  + ` / 找不到「+」的 ${iconProbe.coneNoPlus} 行 / 找不到光锥名的 ${iconProbe.coneNoText} 行`
  + ` / 跑到「+」左边的 ${iconProbe.coneAfterPlus} 行 / 跑到名字右边的 ${iconProbe.coneAfterName} 行`
  + `${iconProbe.coneSample ? `（首行「+ [图标] ${iconProbe.coneSample.text}」）` : ''}`);
// 叠影层数：用户点名「名称必须带有叠影层数（S1-S5）」—— S1 也写出来。
const superimpOk = iconProbe.coneSide > 0 && iconProbe.coneNoSuperimp === 0;
console.log(`  ${superimpOk ? '✓' : '✗'} 光锥名一律带叠影层数 S1~S5（用户 2026-10-10 第三轮）：`
  + `${iconProbe.coneSide} 行里 ${iconProbe.coneNoSuperimp} 行缺层数`
  + `${iconProbe.coneNoSuperimpSample ? `（例：${JSON.stringify(iconProbe.coneNoSuperimpSample)}）` : ''}`);
// ⚠️ 上面两条**必须**计入失败：光锥图标的位置与叠影层数是用户点名两轮的要求，
//    只打印不打红等于「怎么改都过不去」——上一轮它们就漏计过一次。
if (!coneSideOk || !superimpOk) failures += 1;

// ② **点击**性价比得分徽标 → **居中的大窗口**（`.advice-tip-modal`）
//    挑「第一个带配队空槽的行」（名次会随口径变化，所以按结构找、不按名次找）。
//
// ⚠️ 这里叠着 2026-10-10 的**两轮**要求：
//   * 第一轮（v4.6.59）：显隐从 `:hover` 改成**点击**（用户原话「当前性价比界面无法
//     滚动，会自动关掉，改为点击性价比 +xxx，弹出的窗口不自动隐藏」）。所以这里发的是
//     `mousePressed` + `mouseReleased`，**不是** `mouseMoved` —— 只发 `mouseMoved`
//     的话 `:hover` 生效但 click 不触发，窗口根本不开（HANDOFF §6.1 第 9 条）。
//   * 第二轮（v4.6.61）：内容不再贴在徽标旁边，而是搬进一个**居中的大窗口**
//     （`min(1180px,96vw)` × `min(90vh,1000px)`，正文自己滚）。所以判据从
//     「浮层宽 ≤620px / `position: fixed` / 贴徽标」整套换成「窗口卡片四边都在可见区内 /
//     正文可滚 / 关掉后内容回到徽标里」—— 旧写法（`.advice-value-tip.is-placed`、
//     `placeTip()` 的坐标）已经没有对应物了，别再从 git 历史里搬回来。
const tipTarget = await evaluate(`(() => {
  const wraps = [ ...document.querySelectorAll('#adviceConclusionUnits .advice-value-wrap') ];
  // ⚠️ 占位槽的类名是 .advice-plan-team-slot（feat/team-plan 从 .advice-team-slot 改的名，
  //    与「队伍方案」那一节同名）：老名字**一个节点都没有**，用它找出来是 -1，
  //    而下面 wraps[idx] 在 -1 上会直接抛 Cannot read properties of undefined。
  //    ⚠️ 这一段整个是模板字符串：注释里**不能出现反引号**（见 HANDOFF §6.1 第 16 条）。
  // ⚠️ 还要挑**关卡最多的那一行**：下面要断言「最佳证据覆盖所有关卡」与「关卡之间有分隔线」，
  //    而榜首那一行可能只有一个关卡的证据（实测第 2 行起才有 5 块）。
  const count = wraps.map((w) => w.querySelectorAll('.advice-plan-team-slot').length);
  let idx = 0;
  for (let i = 1; i < count.length; i += 1) if (count[i] > count[idx]) idx = i;
  const wrap = wraps[idx];
  if (!wrap) return null;
  // ⚠️ 先滚进视口再算坐标：不在视口内点击点不中（handoff §6.1 第 9 条）
  wrap.scrollIntoView({ block: 'center' });
  return { idx, unit: wrap.closest('.advice-unit')?.querySelector('.advice-unit-name')?.textContent || '?' };
})()`);

/** 一「按」= mousePressed + mouseReleased（只发 mouseMoved 不会触发 click）。 */
const mouseClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  });
};

/** 徽标中心的**视口**坐标：每次都现算（滚动容器 / 关窗回位都会让它动）。 */
const badgeCenter = async () => {
  await evaluate(`(() => {
    const w = document.querySelectorAll('#adviceConclusionUnits .advice-value-wrap')[${tipTarget.idx}];
    w?.scrollIntoView({ block: 'center' });
    return Boolean(w);
  })()`);
  await sleep(600);
  return evaluate(`(() => {
    const w = document.querySelectorAll('#adviceConclusionUnits .advice-value-wrap')[${tipTarget.idx}];
    const r = w.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
};

/** 点一次徽标（第一次开窗、后面重开都用它）。 */
const clickBadge = async () => {
  const spot = await badgeCenter();
  await mouseClick(spot.x, spot.y);
  await sleep(1200);
  return spot;
};

/** 窗口是不是开着：`hidden` 是唯一判据（与 `isTipWindowOpen()` 同一写法）。 */
const windowOpen = () => evaluate(
  "(() => { const m = document.querySelector('.advice-tip-modal'); return Boolean(m) && !m.hidden; })()");

/** 内容节点是不是回到了徽标里（关窗的**第二半**判据，见 advice-tip-window.js 的 restore）。 */
const tipBackInWrap = () => evaluate(`Boolean(
  document.querySelectorAll('#adviceConclusionUnits .advice-value-wrap')[${tipTarget.idx}]
    ?.querySelector('.advice-value-tip'))`);

let tipOk = false;
let tipReport = null;
let closeOk = false;
if (!tipTarget) {
  failures += 1;
  console.log('  ✗ 总榜里找不到带配队空槽的 `.advice-value-wrap`（一行都没有？）');
} else {
  await clickBadge();
  // 外壳是点开那一刻**同步**建的，但「该角色的全部配队」要另发一次
  // `/api/archive/packs`（实测 ~1s）—— 等那一节真填完再量，否则量到的是「正在读取…」。
  for (let i = 0; i < 40; i += 1) {
    const ready = await evaluate(`(() => {
      const modal = document.querySelector('.advice-tip-modal');
      if (!modal || modal.hidden) return false;
      const slot = modal.querySelector('.advice-packs-slot');
      if (!slot || slot.dataset.filled !== '1') return false;
      const list = slot.querySelector('.advice-packs-list');
      return Boolean(list) && !list.querySelector('.advice-packs-loading');
    })()`);
    if (ready) break;
    await sleep(500);
  }
  const tipProbeExpr = `(() => {
    // ⚠️ 内容节点此刻在**窗口正文**里：点开时被搬进去、关掉时才由窗口还回徽标
    // （advice-tip-window.js 的 restore()）。所以一切都从 .advice-tip-body 往下查 ——
    // 再用 .advice-value-wrap.is-open .advice-value-tip 那种写法会查不到东西。
    const modal = document.querySelector('.advice-tip-modal');
    const card = modal?.querySelector('.advice-tip-card');
    const body = modal?.querySelector('.advice-tip-body');
    const tip = body?.querySelector('.advice-value-tip');
    if (!modal || !card || !body || !tip) return null;
    const cr = card.getBoundingClientRect();
    // ⚠️ 判「四边都在可见区内」用 documentElement.clientWidth/Height，**不是**
    //    innerWidth/Height：可视区（去掉滚动条）才是用户真的看得到的那一块。
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const sub = tip.querySelector('.advice-value-tip-sub');
    const kids = sub ? [ ...sub.children ] : [];
    const idxOf = (sel) => kids.findIndex((k) => k.matches(sel));
    // 贡献值来源表的取数方式与改前一致（表结构没变，只换了容器）。
    // ⚠️ 用户 2026-10-13 第 1、2 条之后这个浮层里有**两张**表（class 都是
    //    advice-value-tip-table）：上面那张是「角色得分 = 强度 + 性价比 + 泛用性」
    //    （在 advice-score-split 里），下面那张才是**逐关卡来源**主表。
    //    主表额外带 is-source，所以这里必须按它选 —— 只写类名会拿到上面那张，
    //    于是列数 / 因子 / 合计 / 第一格卡片等**十几条断言会静默量错对象**。
    //    ⚠️ 本段是模板字符串，注释里不能出现反引号（HANDOFF §6.1 第 16 条）。
    const table = tip.querySelector('.advice-value-tip-table.is-source');
    const splitTable = tip.querySelector('.advice-score-split .advice-value-tip-table');
    // 强度来源那张表（用户 2026-10-13：三项都要有「完整得分来源」）——它有自己的 class。
    const strengthTable = tip.querySelector('.advice-value-tip-table.is-strength-source');
    const strengthTrs = [ ...(strengthTable?.querySelectorAll('tbody tr') || []) ];
    // 泛用性的来源块：一份队友名单 + 一句归一换算（它**不是**表格，是名单）。
    const versBlock = [ ...tip.querySelectorAll('.advice-score-split') ]
      .find((b) => /^泛用性来源/.test(b.querySelector('.advice-score-split-title')?.textContent || ''));
    const versMembers = versBlock?.querySelector('.advice-vtip-members')?.textContent || '';
    // ⚠️ 按**元素**数数，不要 split 文本：角色名里本来就有「•」（砂金•戏浪），
    //    用分隔符切会把一个名字切成两个（假红）。
    const versMemberCount = versBlock
      ? versBlock.querySelectorAll('.advice-vtip-member').length : 0;
    const trs = [ ...(table?.querySelectorAll('tbody tr') || []) ];
    const cellsOf = (tr) => [ ...tr.children ].map((td) => td.textContent);
    const totalRow = trs.find((tr) => tr.classList.contains('is-total'));
    const avatars = [ ...tip.querySelectorAll('.advice-team-avatar') ];
    // ⚠️ 卡片里的光锥图标类名是 .advice-plan-team-cone（feat/team-plan 改的名，
    //    见 advice-view.js 的 fillTeamCards()）；写成旧的 .advice-team-cone 会一个都
    //    查不到，于是 cones.length > 0 假红。⚠️ 本段是模板字符串，注释里不能有反引号。
    const cones = [ ...tip.querySelectorAll('.advice-plan-team-cone') ];
    const slot = tip.querySelector('.advice-packs-slot');
    const list = slot?.querySelector('.advice-packs-list');
    const items = [ ...(list?.querySelectorAll('.advice-packs-item') || []) ];
    return {
      modalHidden: modal.hidden,
      card: { x: Math.round(cr.left), y: Math.round(cr.top),
        w: Math.round(cr.width), h: Math.round(cr.height) },
      cardInside: cr.left >= 0 && cr.right <= vw && cr.top >= 0 && cr.bottom <= vh,
      viewport: vw + '×' + vh,
      title: document.getElementById('adviceTipTitle')?.textContent || '',
      headText: tip.querySelector('.advice-value-tip-head')?.textContent || '',
      // 窗口开着时背后页面该被锁住（app.css：html:has(.advice-tip-modal:not([hidden]))）
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      bodyScrollH: body.scrollHeight,
      bodyClientH: body.clientHeight,
      bodyOverflowY: getComputedStyle(body).overflowY,
      bodyNeedsScroll: body.scrollHeight > body.clientHeight + 1,
      bodyScrollable: body.scrollHeight > body.clientHeight,
      // 小浮层时代内容是 max-width: 620px；窗口里宽度该由窗口给（实测 ~1136px）
      tipWidth: Math.round(tip.getBoundingClientRect().width),
      tipPosition: getComputedStyle(tip).position,
      // sub 里各块的**次序**（用户 2026-10-10 第 4 条：等式 → 表 → 全部配队 → 脚注）。
      // ⚠️ 2026-10-11 第 5 条起**不再有「队伍在表上方」这一项**：队伍图标搬进了表格
      //    第一格，占位槽不再是 sub 的直接子节点（idxOf 会返回 -1）。
      order: { table: idxOf('.advice-value-tip-table.is-source'),
        packs: idxOf('.advice-packs-slot'), notes: idxOf('.advice-value-tip-notes') },
      slotFilled: slot?.dataset.filled ?? null,
      packRows: items.length,
      packScores: items.map((it) => (it.querySelector('.advice-packs-score')?.textContent || '')
        .replace('角色得分 +', '')),
      // ---- 三个分项那张表（用户 2026-10-13 第 1、2 条）------------------------------
      // 它是这个窗口的**第一层拆解**：强度 / 性价比 / 泛用性三个分项 + 归一后的得分 +
      // 抽卡权重 + 贡献，合计行的数必须与标题上那个数**逐字相同**（同一个 packScoreText）。
      // ⚠️ 本段是模板字符串，注释里不能出现反引号（HANDOFF §6.1 第 16 条）。
      splitHeaders: [ ...(splitTable?.querySelectorAll('th') || []) ].map((n) => n.textContent),
      // 强度来源表（用户 2026-10-13）：列名、逐关卡行数、合计那一行。
      strengthHeaders: [ ...(strengthTable?.querySelectorAll('th') || []) ].map((n) => n.textContent),
      strengthRowCount: strengthTrs.filter((tr) => !tr.classList.contains('is-total')).length,
      strengthTotalRow: (() => {
        const tr = strengthTrs.find((r) => r.classList.contains('is-total'));
        return tr ? [ ...tr.children ].map((td) => td.textContent) : null;
      })(),
      // 泛用性来源块：名单文本 + 它下面的归一换算那句。
      versMembers,
      versListCount: versMemberCount,
      versNote: versBlock?.querySelector('.advice-source-note')?.textContent || '',
      versRaw: (() => {
        const t = versBlock?.querySelector('.advice-score-split-title')?.textContent || '';
        return Number((t.match(/共\\s*(\\d+)\\s*个/) || [])[1]);
      })(),
      splitTotal: String(splitTable
        ?.querySelector('tr.is-total td:last-child')?.textContent || ''),
      splitRowCount: splitTable ? splitTable.querySelectorAll('tbody tr').length : 0,
      // 逐关卡来源那张表的合计该等于什么：**性价比分项的原始分**（整包对象的 total），
      // 不再是徽标上的角色得分（用户 2026-10-13 第 2 条之后两者不是同一个数：
      // 实测合计 +1098 而徽标 +96）。整包对象由 frontierTip() 挂在节点上（tip.__unit）。
      // ⚠️ 写法用字符串拼接而不是嵌套模板串 —— 这一段本身就在模板字符串里。
      sourceTotal: (() => {
        const unit = tip.__unit;
        const total = Number(unit && unit.total);
        return Number.isFinite(total) ? '+' + Math.round(total) : null;
      })(),
      caption: tip.querySelector('.advice-packs-caption')?.textContent || '',
      packCount: tip.querySelector('.advice-packs-count')?.textContent || '',
      packMore: tip.querySelector('.advice-packs-more')?.textContent || '',
      cards: tip.querySelectorAll('.advice-team-card').length,
      // ---- 用户 2026-10-11 第 5 条（本轮）：「角色的图标都放进表格内」-----------------
      // 判据分三点，逐条对应量出来的数：
      //  ① 表上方**不再有**那一整块（标题 + 说明行）—— 它们已随搬迁删除；
      //  ② **每一个表体行的第一格**里都有占位槽，且槽里都真的有卡片（点开窗口后由
      //     fillTeamCards() 建）；
      //  ③ 第一格里仍然写着**中文关卡名**，且每一行 td 自己带下边框 ——
      //     「关卡与关卡之间的线」现在就是表格的行线（第 ① 条的原话是「用已有的线」）。
      teamCaptionLeft: tip.querySelectorAll('.advice-team-caption').length,
      teamEnvLeft: tip.querySelectorAll('.advice-team-env').length,
      firstCells: trs.filter((tr) => !tr.classList.contains('is-total')).map((tr) => {
        const cell = tr.children[0];
        // 一格里第一段文字的**实际顶边 / 中心**（用 Range 取内容盒，不是格子的盒子）。
        const textTopOf = (node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return range.getBoundingClientRect().top;
        };
        const textMidOf = (node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const r = range.getBoundingClientRect();
          return (r.top + r.bottom) / 2;
        };
        const titleTop = textTopOf(cell);
        const others = [ ...tr.children ].slice(1).map((td) => textTopOf(td));
        const cardRow = cell.querySelector('.advice-team');
        const cards = cardRow ? [ ...cardRow.children ] : [];
        const firstCard = cards[0]?.getBoundingClientRect();
        const lastCard = cards[cards.length - 1]?.getBoundingClientRect();
        const cellRect = cell.getBoundingClientRect();
        // 用户 2026-10-11 追加：「非『关卡』列居中，**上下要居中**」——
        // 量第 3 格（「表现」）文字中心与整行中心的偏差；vertical-align: middle 时 ≈ 0，
        // 回到 top 会差到几十 px（那时这个值 = 行高与文字高度差值的一半）。
        const rowRect = tr.getBoundingClientRect();
        const numCell = tr.children[2] || null;
        return {
          slots: cell.querySelectorAll('.advice-plan-team-slot').length,
          cards: cell.querySelectorAll('.advice-team-card').length,
          stage: cell.querySelector('.tip-label-stage')?.textContent || '',
          env: cell.querySelector('.tip-label-env')?.textContent || '',
          season: cell.querySelector('.tip-label-season')?.textContent || '',
          // 「一行标题」：副本名与关卡名必须在**同一个** .tip-label-title 里
          title: cell.querySelector('.tip-label-title')?.textContent || '',
          // 表格行线（＝关卡之间的线）：每一格自己带的下边框。
          borderBottom: getComputedStyle(cell).borderBottomWidth,
          rowHeight: Math.round(tr.getBoundingClientRect().height),
          // ① 旧判据「关卡、权重、表现等文字**等高**」：第一格文字顶 vs 其余各列文字顶的
          //    最大偏差（top 对齐时 ≈0）。已被下面那条新要求取代，只留作打印诊断。
          alignDelta: Math.round(Math.max(0, ...others.map((t) => Math.abs(t - titleTop)))),
          // ①′ 新判据：非关卡列**上下居中** —— 数字格文字中心 vs 整行中心。
          midDelta: numCell ? Math.round(Math.abs(textMidOf(numCell) - (rowRect.top + rowRect.bottom) / 2)) : 999,
          // ② 「图标往右边分散一点」：卡片行算出来的 justify-content + 卡片实际铺开的比例
          //    （首张左边缘 → 末张右边缘 / 该格宽度）。center 时约 0.72，space-evenly 约 0.9。
          justify: cardRow ? getComputedStyle(cardRow).justifyContent : '',
          spread: firstCard && lastCard && cellRect.width
            ? Number(((lastCard.right - firstCard.left) / cellRect.width).toFixed(3)) : null,
        };
      }),
      tipHeight: Math.round(tip.getBoundingClientRect().height),
      // ④ 第一列的版本小字：**逐行取自该行第一格**，而不是全窗口数一遍 ——
      //    要求「第一列的文本里必须出现该关卡的版本号」，落点就在这一格。
      firstColSeasons: trs.filter((tr) => !tr.classList.contains('is-total'))
        .map((tr) => tr.children[0]?.querySelector('.tip-label-season')?.textContent || ''),
      // 用户 2026-10-11（详情页第 1 条）：「权重 / 表现 / 金数 / 跨版本发挥 / 贡献这几列的
      // 内容需要居中，并放大一点字体（**不包括**关卡列）」——这里量两列的实际字号，
      // 断言数字列比关卡列大一档（居中由 CSS 保证，见 app.css 里那一条）。
      stageFont: (() => {
        const td = trs.find((tr) => !tr.classList.contains('is-total'))?.children[0];
        return td ? Number.parseFloat(getComputedStyle(td).fontSize) : 0;
      })(),
      numFont: (() => {
        const td = trs.find((tr) => !tr.classList.contains('is-total'))?.children[2];
        return td ? Number.parseFloat(getComputedStyle(td).fontSize) : 0;
      })(),
      numAlign: (() => {
        const td = trs.find((tr) => !tr.classList.contains('is-total'))?.children[2];
        return td ? getComputedStyle(td).textAlign : '';
      })(),
      // ⑤ 整段正文里**不许再出现除号 ÷**（用户 2026-10-11 第 2 条：金数的符号改成斜杠）。
      hasDivisionSign: (tip.textContent || '').includes('÷'),
    // 有除号时把**上下文**一起带出来：只报一句「全文含除号 ✗ 有」的话，人得自己
    // 在几百行渲染结果里找那一个字符（本轮实测为此多跑了一整轮 CDP）。
    divisionContext: (() => {
      const t = tip.textContent || '';
      const i = t.indexOf('÷');
      return i < 0 ? '' : t.slice(Math.max(0, i - 50), i + 50);
    })(),
      avatars: avatars.map((a) => a.naturalWidth),
      avatarHidden: avatars.filter((a) => a.classList.contains('is-missing')).length,
      cones: cones.map((a) => a.naturalWidth),
      notes: tip.querySelectorAll('.advice-value-tip-note').length,
      noteTexts: [ ...tip.querySelectorAll('.advice-value-tip-note') ].map((n) => n.textContent),
      headers: [ ...(table?.querySelectorAll('thead th') || []) ].map((th) => th.textContent),
      rows: trs.filter((tr) => !tr.classList.contains('is-total')).map(cellsOf),
      totalRow: totalRow ? cellsOf(totalRow) : null,
      docOverflow: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth,
    };
  })()`;
  // 窗口里的图是点开那一刻才插进 DOM 的，给它一点时间；再对没出来的做有界重试
  // （jsdelivr 对 `@master` 这种分支引用未命中缓存时会 302 到 raw.githubusercontent.com，
  // 本机对后者的连通性不稳定 —— 重新赋一次 src 往往就成功）。
  for (let round = 0; round < 3; round += 1) {
    const left = await evaluate(`(() => {
      const modal = document.querySelector('.advice-tip-modal');
      const imgs = [ ...(modal?.querySelectorAll('.advice-team-avatar, .advice-plan-team-cone') || []) ]
        .filter((i) => i.naturalWidth === 0);
      for (const img of imgs) {
        img.classList.remove('is-missing');
        const url = img.getAttribute('src');
        img.removeAttribute('src');
        img.src = url;
      }
      return imgs.length;
    })()`);
    if (!left) break;
    await sleep(2500);
  }
  tipReport = await evaluate(tipProbeExpr);
  // ---- 判据：窗口形态 + 内容（用户 2026-10-10 的两轮要求）-----------------------
  //   * **窗口真的开了**：外壳不是 `hidden`、卡片**四边都在可见区内**；
  //   * **正文可滚**：内容比正文高时 `scrollHeight > clientHeight`（实测 922 > 839）——
  //     用户第一轮报的「无法滚动」就死在这一条上；
  //   * 内容不再受 620px 小浮层上限约束（实测 ~1136px）：这就是「换大窗口」这件事本身；
  //   * **最佳证据的队伍排在表上方**（sub 里的次序 team < table）；
  //   * **列出贡献值来源**：表头七列、每格是真值（不许 NaN/undefined/Infinity）、
  //     多副本时有合计行且其数字 = 标题上的那个数；
  //   * 配队卡片与头像真的加载（`naturalWidth > 0`）、没有藏起来的碎图；
  //   * 改名文案：「该角色的全部配队」/「N 个配队 · 按性价比得分从高到低」/「另有 …」；
  //   * 脚注：**≥7 条**、逐字对得上（其中「档位」「行动值」必须是**两条独立**脚注）、
  //     每条 ≤60 字（改前是七段两三行的长解释，只靠肉眼看很容易再长回去）；
  //   * 标题与头行都是「性价比得分 +N」；窗口开着时锁住背后页面滚动；不出现横向滚动。
  // ⚠️ 第 6 列是「跨版本发挥」（用户 2026-10-10 第 6 轮改名）：它原名「版本」，
  //    与左边的版本权重表撞名、看不出在算什么。改叫「跨版本发挥」＝各版本加权平均
  //    ÷ 最好的那一版（恒 ≤ 1）。
  //
  // ⚠️ **2026-10-11 缺陷 3：「档位」与「行动值」两列合并成一列「表现」**。
  //    它们本是同一维度（档位就是拿成绩与判据线比出来的），乘两次等于把差距平方、
  //    并在判据线处跳变 2 倍。合并后 7 列 → **6 列**，第 3 列的主值仍是游戏内量纲
  //    （`0T` / `行动值 <300`），副值（系数）改由 `perfFactorOf()` 现算。
  //
  // ⚠️ **2026-10-11 第 2 条：第一列「副本/关卡」→「关卡」**（用户原话「"副本/关卡"
  //    改为"关卡"，并备注关卡的版本号」）。第一列的内容没变（仍是两级写法：副本一行 /
  //    关卡一行），变的是表头这两个字 —— 它原来把「副本」也写进去了，与第一列实际
  //    在认的东西（关卡）不一致。
  const SOURCE_HEADERS = ['关卡', '权重', '表现', '金数', '跨版本发挥', '贡献'];
  const factorCellsOk = (cells) => cells.length === SOURCE_HEADERS.length
    && cells.slice(1).every((c) => c.length > 0 && !/NaN|undefined|Infinity/.test(c));
  const headValue = tipReport ? ((tipReport.headText.match(/(\+\d+)$/) || [])[1] || null) : null;
  /**
   * 逐关卡来源表的合计。
   *
   * ⚠️ **用户 2026-10-13 第 2 条之后它不再等于徽标上的数**：徽标是「角色得分」
   * （三个分项按抽卡权重加权的**榜内归一分**），而这张表是**性价比分项**的原始来源，
   * 合计也就是 `unit.total` 的原始量纲 —— 实测同一行「合计 +1098 / 徽标 +96」。
   * 所以判据从「= 标题上的数」改成「= 探针从 `tip.__unit.total` 现取的期望值」，
   * 这样它仍然钉住「表里的分加起来等于这一项的原始分」这条恒等式。
   */
  const sourceTotalExpected = tipReport?.sourceTotal ?? null;
  const sourceOk = Boolean(tipReport)
    && JSON.stringify(tipReport.headers) === JSON.stringify(SOURCE_HEADERS)
    && tipReport.rows.length > 0 && tipReport.rows.every(factorCellsOk)
    && (tipReport.rows.length === 1
      ? tipReport.totalRow === null
      : Array.isArray(tipReport.totalRow)
        && sourceTotalExpected !== null
        && tipReport.totalRow[tipReport.totalRow.length - 1] === sourceTotalExpected);
  // ---- 2026-10-11 第 2 条（本轮）：改名 + 版本号 + 队伍块覆盖所有关卡 ----------
  // 用户原话：「"副本/关卡"改为"关卡"，并备注关卡的版本号，最佳证据的队伍要显示所有
  // 关卡的情况和贡献」。三条判据分别钉这三件事。
  //
  // ① 表头第一列必须是「关卡」，且任何表头里都不许再出现「副本」。
  const headerRenameOk = Boolean(tipReport) && tipReport.headers.length > 0
    && tipReport.headers[0] === '关卡'
    && !tipReport.headers.some((h) => /副本/.test(h));
  // ② 第一列的文本里必须出现**该关卡的版本号**（形如 `4.6 版本`，与「该角色的全部配队」
  //    那一行的 `.advice-packs-env-season` 同一文案）。逐行取该行第一格，
  //    行数对不上就说明有行没写版本。
  //    ⚠️ 这条依赖 `env.evidenceSeason`（← advice.js 的 `evidence.season`）**每一行都有**：
  //    实测（2026-10-11，默认权重）总榜 62 条 / 逐副本条目 167 个（v4.6.77 起不再截到 3 个），
  //    缺失 0 个。哪天数据里出现空值，这里会如实报红 —— 那正是「第一列必须备注版本号」这条要求
  //    在数据侧失效的信号，不要为了让它变绿而放宽成「有就行」。
  const seasonColOk = Boolean(tipReport) && tipReport.rows.length > 0
    && tipReport.firstColSeasons.length === tipReport.rows.length
    && tipReport.firstColSeasons.every((t) => /^\d+(\.\d+)? 版本$/.test(t));
  // ③ 「角色的图标都放进表格内」（用户 2026-10-11 第 5 条）：
  //    · 表上方那一整块**必须真的没了**（标题 `.advice-team-caption`、说明行
  //      `.advice-team-env` 都是 0 个）—— 只把卡片搬走却留着说明行 = 信息仍然重复；
  //    · **每一个表体行的第一格**里都有一个占位槽，且槽里都**真的有卡片**
  //      （空槽没填 = 点开窗口后用户看到一片空）；
  //    · 每格自己带下边框（＝「关卡与关卡之间的线」，用户原话「用已有的线」）；
  //    · 第一格里仍然写着中文关卡名（见下面的 stageNameCnOk）。
  //    实测（2026-10-11 第 5 条，默认权重）被挑中的那条是 5 个关卡 / 5 格 / 20 张卡片。
  //
  // ⚠️ **上一版这三条第一次上线（v4.6.76）时是绿的假象，别再犯**：当时是在 node 里用最小
  //    DOM shim 直接跑**未经瘦身**的 `buildConclusion()` 输出（每个条目 5 个关卡、
  //    每个关卡都带 `members`），而浏览器拿到的是 `/conclusion` 瘦身后的
  //    `frontierUnits` —— 那里 `.slice(0, 3)`、且只有头条证据带队友。用户截图里就是真相：
  //    只列 3 个关卡、且只有第一条有关系队伍卡片。v4.6.77 已把服务端那两处取舍改掉
  //    （`src/server/conclusion.js` 的 `slimFrontierUnit`）并补上逐条 `envLabel`。
  //    **教训：界面判据的数据前提必须在服务端载荷上量，不能拿 `buildConclusion()` 的
  //    原始输出代替**。`tools/e2e-test.mjs` 现在也有对应的服务端断言（envs 条数 = envCount、
  //    每条都有 envLabel 与 members）。
  const firstCells = tipReport?.firstCells || [];
  // 用户 2026-10-11 第 6 条两条 + 本轮的追加，都只能靠**量几何**来验（肉眼在别的机器上
  // 不一定看得出）：
  //   ①′ **非关卡列上下居中**（用户本轮追加：「非『关卡』列居中，上下要居中」）——
  //      数字格文字中心与整行中心的偏差 ≤4px。⚠️ 这一条**取代**了上一版的「与第一格文字
  //      顶边齐平（≤4px）」：两者不可能同时成立（第一列要塞 4 张卡片、行很高，别的列
  //      `top` 对齐才与第一行文字齐平，`middle` 对齐才上下居中）。`alignDelta` 仍在打印里，
  //      作为诊断信息保留。
  //   ② 「图标往右边**分散**一点」—— 卡片行必须 `space-evenly`，且四张卡实际铺开的宽度
  //      占该格 ≥80%（只加 `center` 时约 0.72，只把格子撑开而没撑开槽时会更小）。
  const alignOk = firstCells.length > 0 && firstCells.every((c) => c.midDelta <= 4);
  const spreadOk = firstCells.length > 0
    && firstCells.every((c) => c.justify === 'space-evenly' && (c.spread ?? 0) >= 0.8);
  const teamBlockOk = Boolean(tipReport) && tipReport.teamCaptionLeft === 0
    && tipReport.teamEnvLeft === 0
    && firstCells.length > 0 && firstCells.length === tipReport.rows.length
    && firstCells.every((c) => c.slots >= 1 && c.cards >= 1)
    && firstCells.every((c) => Number.parseFloat(c.borderBottom) > 0)
    && alignOk && spreadOk;
  // ④ 关卡名必须是**中文名**，不许印数据集英文 id（`aa/plight` / `as` / `moc` / `pf` / `aa`）。
  //    用户 2026-10-11 原话：「去除 最佳证据的队伍 下方的这些英语简称，我没要求添加」。
  //    判据取「必须含汉字」，比列黑名单稳：数据里出现新的 mode/id 也不会漏。
  //    表体第一列同样要过这一关（两处是同一个信息，不能一处中文一处英文）。
  const cjkRe = /[\u3400-\u9fff]/;
  // ⚠️ `.tip-label-env` **只有两段式标签才有**（「异相仲裁·绝境王棋关」有、单独的
  //    「末日幻影」没有 —— 见 advice-view.js 的 `envLabelNode()`）：所以这里判「有就必须
  //    是中文」，不能要求每一格都有它，否则单段关卡会假红。
  const stageNameCnOk = Boolean(tipReport) && firstCells.length > 0
    && firstCells.every((c) => cjkRe.test(c.stage) && (!c.env || cjkRe.test(c.env)))
    && tipReport.rows.every((r) => cjkRe.test(String(r[0] ?? '')));
  // ⚠️ 这四条都进了下面的 `tipOk` ⇒ **会计入 failures**（本仓库踩过「只打印不打红」
  //    的坑，见 HANDOFF §4.2w 的 ⚠️ 第 2 条）：只打印不打红的判据等于没有判据。
  // 脚注逐字。
  //
  // ⚠️ 「表现」那一条**不能写死**（它把该副本的判据线原样写出来，跟着数据走）：
  //    正则必须**卡死形状** —— 出现「满分 / 达标 / 及格」就直接不匹配（那正是这条
  //    需求要消灭的写法）。
  // ⚠️ 曲线说明只列「档位 系数」对（脚注有 60 字上限），形如
  //    `行动值 0 1.00 → 行动值 <300 0.85 → 行动值 <500 0.50`（默认那套）
  //    `行动值 0 1.00 → 行动值 <300 1.00 → 行动值 <500 0.60`（**绝境**：v4.6.78 起
  //      按副本覆盖，满分线以内固定 1.00、达标线 0.60 —— 见 `SCORING.frontierPerfLineByEnv`）
  //    `0T 1.00 → ≤2T 0.50 → ≤4T 0.25`
  //    末段可选（及格线外的衰减没写进脚注）；系数一律**两位小数**，正则不写死数值。
  const notePerfRe = /^表现：列里是实测成绩，系数按 (?!.*(?:满分|达标|及格)).+ \d\.\d{2}( → .+ \d\.\d{2})+。$/;
  // ⚠️ 这里**只列与本条需求有关、且形状稳定**的那几条（`notesTextOk` 判的是「包含」，
  //    不是「恰好等于」）—— 脚注条数与其余文案正被另一轮改动动到，逐字列全会互相打架。
  const NOTE_EXACT = [
    // 「该版本」三个字是本条口径的一部分（v4.6.63 起分母是那一版自己的最便宜金数），
    // 所以它跟着「表现必须写具体行动值」一起被钉住。
    // ⚠️ 2026-10-11 第 2、3 条改过它的两个符号/半句：除号 `÷` → **斜杠 `/`**（用户点名），
    // 以及补上「封顶 ×1；0 金通关 ×1.2」（用户第 3 条）。改这一句必须同步 `herta-test.mjs`
    // 的实测（它断言封顶后没有任何明细 > 1）与 `advice-view.js` 里那条脚注。
    '金数 = 该版本最便宜的配置 / 这支队伍，封顶 ×1；0 金通关 ×1.2。',
    // v4.6.78：池改成「全部成绩」之后，估算机器删掉，那句「非前沿投稿按质量梯度估算」
    // 也一并去掉；这里**逐字钉住**新的算式说明，免得下一轮又悄悄改口径而不改文案。
    // ⚠️ 除号同样写成 `/`（浮层正文里不许出现 ÷）。
    '跨版本发挥 = 各版本加权平均 / 最好的那一版，恒 ≤ 1。',
  ];
  // 三条**跟着数据走**的：① 里的整包金数、⑤ 里的版本窗口「7」（出了新版本自己往前滚）、
  // 以及上面那条「表现」（判据线来自数据集）。
  const NOTE_RE = [
    /^整包 = 角色 \+ 星魂档 \+ 光锥（含叠影）；整包自身 \d+ 金不进公式。$/,
    // ⚠️ 比例与版数都**跟着数据走**（2026-10-12 第 5 条把窗口从 7 版收到 3 版，
    // `VERSION_WEIGHTS` 也随之从 2:2:2:1:1:1:1 变成 2:2:2），所以正则只能钉形状。
    /^最近 \d+ 个版本按 [\d:]+ 加权，未上线版本不参与加权。$/,
    notePerfRe,
    // 用户 2026-10-11 缺陷 5：证据基础必须写出来（新角色按单版最大值、老角色按 7 版平均）。
    /^实测证据 \d+ 个（副本×版本）；证据越少，分数波动越大。$/,
  ];
  const noteIdxRe = (re) => (tipReport ? tipReport.noteTexts.findIndex((t) => re.test(t)) : -2);
  const notesTextOk = Boolean(tipReport) && tipReport.notes >= 6
    && NOTE_EXACT.every((t) => tipReport.noteTexts.includes(t))
    && NOTE_RE.every((re) => tipReport.noteTexts.some((t) => re.test(t)));
  // **表现列与脚注都必须写游戏内实际的量**（用户 2026-10-10：把「满分」「达标」改为
  // 具体的行动值；2026-10-11 第二轮：**直接写实测成绩**，如 `285` / `0T` / `3852`）。
  const bannedWords = /及格|达标|满分/;
  // ⚠️ 表现列的列号**从表头现取**，不写死 2：表头顺序改过一次（第 6 列改名），
  //    写死会在这类改动里静默量到别的列。
  const tierCol = SOURCE_HEADERS.indexOf('表现');
  const tierCells = tipReport && tierCol >= 0
    ? tipReport.rows.map((r) => r[tierCol]) : [];
  // 单元格是「成绩 + 系数」上下两行（`.tip-stack`），`textContent` 是 `285（0.86）` ——
  // 校验主值时要把括号里的系数剥掉，否则合法取值也会被判不合格。
  const tierMain = (c) => String(c).replace(/（[\s\S]*$/, '').trim();
  const tierCellOk = tierCol >= 0 && tierCells.length > 0
    && tierCells.every((c) => c.length > 0 && !bannedWords.test(c))
    // 主值必须是**游戏内那个量本身**：`285` / `0T` / `1T` / `3852`（裸数字或 `N T`），
    // 不许退化成「最好一档」那种没信息量的兜底写法。
    // 数值成绩必须带小数时用 `toFixed(2)`（`formatAv`），所以允许 `12.5` 这类。
    && tierCells.every((c) => /^\d+(\.\d+)?$/.test(tierMain(c))
      || /^\d+(\.\d+)?T$/.test(tierMain(c)));
  const notesNoBannedOk = Boolean(tipReport)
    && tipReport.noteTexts.every((t) => !bannedWords.test(t));
  const notesShortOk = Boolean(tipReport)
    && tipReport.notes > 0 && tipReport.noteTexts.every((t) => t.length <= 60);
  // ---- 用户 2026-10-11（详情页第 1 条）：非关卡列「居中 + 字号大一档」 ----------------
  // 字数列（第 3 列「表现」）实测 12.5px、关卡列 11px（见 app.css 里那一条）；
  // `text-align` 也顺带钉住 —— 只放大不改居中，或反过来，都会让这一页看着不协调。
  const fontOk = Boolean(tipReport) && tipReport.numFont >= 12
    && tipReport.numFont > tipReport.stageFont
    && tipReport.numAlign === 'center';
  // ---- 2026-10-11 第 2、3 条：金数那一列的符号与口径 ------------------------------------
  // ① 「金数的符号改为斜杠，表示除以」：主值只能是 `7/9` 这种斜杠写法，或者是 0 金那一支
  //    （`0 金`：分母为 0 时写 `7/0` 是无意义的）。**整段正文里不许再出现 `÷`**。
  // ② 「倍数封顶 1.00」：封顶那一格的副值必须带「封顶」字样 —— 主值 `7/1` 与副值 `1.00`
  //    不标一下会自相矛盾（这正是用户报那个 `7÷1` 时看到的东西）。
  // ③ 「使用 0 金通关额外获得 1.2 的倍率」：0 金那一格的副值必须是 `×1.20`。
  // （第 ④ 条「用已有的线分割不同关卡」的判据现在在 `teamBlockOk` 里 —— 那条线已经换成
  //   **表格自己的行线**了，见上面的注释。）
  const costCol = SOURCE_HEADERS.indexOf('金数');
  const costCells = Boolean(tipReport) && costCol >= 0
    ? tipReport.rows.map((r) => String(r[costCol] ?? '')) : [];
  const costMain = (c) => String(c).replace(/（[\s\S]*$/, '').trim();
  const costSub = (c) => (String(c).match(/（([\s\S]*?)）/) || [])[1] || '';
  const costCellOk = costCol >= 0 && costCells.length > 0
    && !tipReport.hasDivisionSign
    && costCells.every((c) => /^\d+\/\d+$/.test(costMain(c)) || costMain(c) === '0 金' || costMain(c) === '—')
    && costCells.every((c) => {
      const main = costMain(c);
      const sub = costSub(c);
      if (main === '—') return true;
      if (main === '0 金') return /^×1\.20$/.test(sub);
      // 封顶：主值（原始金数之比）> 1 时必须标「封顶」，副值恒为 1.00。
      const [a, b] = main.split('/').map(Number);
      return a > b ? /^1\.00 封顶$/.test(sub) : /^\d\.\d{2}$/.test(sub);
    });
  const titleOk = Boolean(tipReport) && /^角色得分 \+\d+$/.test(tipReport.headText)
    && /^角色得分 \+\d+$/.test(tipReport.title);
  const renameOk = Boolean(tipReport) && tipReport.caption === '该角色的全部配队'
    && /^\d+ 个配队 · 按角色得分从高到低$/.test(tipReport.packCount)
    && (!tipReport.packMore || /^另有 \d+ 个配队未列出（该角色共 \d+ 个）$/.test(tipReport.packMore));
  // ---- 三个分项那张表（用户 2026-10-13 第 1、2 条）--------------------------------
  // 三行（强度 / 性价比 / 泛用性）+ 一行合计；表头固定；**合计 = 标题上那个数**。
  // 这条恒等式是整块改动的锚点：权重接错层、归一化取样集合写错、或者某天有人把
  // 角色得分又改回「含金数项总分」，这一格立刻与标题对不上。
  const SPLIT_HEADERS = ['分项', '原始量', '得分', '权重', '贡献'];
  const splitOk = Boolean(tipReport)
    && JSON.stringify(tipReport.splitHeaders) === JSON.stringify(SPLIT_HEADERS)
    && tipReport.splitRowCount === 4
    && tipReport.splitTotal === headValue;
  // ---- 强度 / 泛用性 两项的「完整得分来源」（用户 2026-10-13）------------------------
  //
  // 上面的 `sourceOk` 只管**性价比**那一张（逐关卡 × 金数）。用户要的是**三项都给来源**，
  // 所以强度那张表（逐关卡 × 表现 × 跨版本发挥，**没有金数**）与泛用性那块（队友名单 +
  // 归一换算）各自也要有判据 —— 否则「加了但没人测」等于下次改坏了也不知道。
  const STRENGTH_HEADERS = ['关卡', '权重', '表现', '跨版本发挥', '贡献'];
  const strengthSourceOk = Boolean(tipReport)
    && JSON.stringify(tipReport.strengthHeaders) === JSON.stringify(STRENGTH_HEADERS)
    && tipReport.strengthRowCount > 0
    // 合计那一行只在多关卡时出现（与性价比表同一条约定）；出现时最后一格必须是 `+N`。
    && (tipReport.strengthTotalRow === null
      || /^\+\d+$/.test(tipReport.strengthTotalRow[tipReport.strengthTotalRow.length - 1] || ''));
  // 泛用性那块：**名单真的有内容**、条数 = 标题上那个数、并写出归一换算。
  const versatilitySourceOk = Boolean(tipReport)
    && tipReport.versListCount > 0
    && tipReport.versListCount === tipReport.versRaw
    && /得分 = 100 ×（\d+ − [\d.]+）\/（[\d.]+ − [\d.]+）/.test(tipReport.versNote);
  // 次序：等式（`.advice-value-tip-eq`，永远是 sub 的第一个子节点）→ 表 → 全部配队 → 脚注。
  // ⚠️ 2026-10-11 第 5 条起队伍图标在**表格里面**，所以不再有「队伍块在表之前」这一项。
  const orderOk = Boolean(tipReport) && tipReport.order.table >= 0
    && tipReport.order.packs > tipReport.order.table
    && tipReport.order.notes > tipReport.order.packs;
  const bodyScrollOk = Boolean(tipReport) && tipReport.bodyOverflowY === 'auto'
    && (!tipReport.bodyNeedsScroll || tipReport.bodyScrollable);
  tipOk = Boolean(tipReport) && tipReport.modalHidden === false && tipReport.cardInside
    && bodyScrollOk && tipReport.tipWidth > 620
    && tipReport.htmlOverflow === 'hidden' && !tipReport.docOverflow
    && tipReport.slotFilled === '1' && tipReport.cards > 0
    && tipReport.avatars.length > 0 && tipReport.avatars.every((w) => w > 0)
    && tipReport.avatarHidden === 0
    && tipReport.cones.length > 0 && tipReport.cones.every((w) => w > 0)
    && titleOk && renameOk && orderOk && sourceOk
    // 用户 2026-10-13 第 1、2 条：三个分项那张表（列名 / 三行 + 合计 / 合计 = 标题上的数）。
    && splitOk
    // 用户 2026-10-13：「三项都要有**完整得分来源**」——强度那张表 + 泛用性那块名单。
    && strengthSourceOk && versatilitySourceOk
    && notesTextOk && notesShortOk
    // 用户 2026-10-11（详情页第 1 条）：非关卡列居中 + 字号大一档。
    && fontOk
    // 2026-10-11 第 2 条：表头第一列改名 / 第一列备注版本号 / 队伍块覆盖所有关卡。
    // 2026-10-11 第 2 条：表头第一列改名 / 第一列备注版本号 / **队伍图标在表格第一格里**。
    && headerRenameOk && seasonColOk && teamBlockOk && stageNameCnOk
    // 2026-10-10（本轮需求）：档位列与脚注都不许再出现「满分 / 达标 / 及格」，
    // 且档位列必须写得出游戏内实际的量（`0T` / `积分 …` / `行动值 …`）。
    && tierCellOk && notesNoBannedOk
    // 2026-10-11 第 2、3 条：金数列用斜杠（全文不许有 `÷`）、封顶要标出来、0 金通关写 ×1.20。
    // （「关卡之间的线」的判据已经并进 `teamBlockOk` —— 现在那条线就是**表格的行线**。）
    && costCellOk;
  // ⚠️ 这一条的失败**必须**计入：窗口没开 / 内容没回位时下面那些 `tipReport.xxx`
  //    全都无从谈起，只打印不打红就等于放过了「点徽标什么都没发生」。
  if (!tipOk) failures += 1;

  // ---- 关闭：至少验 **ESC** 与**点背景**两条（用户 2026-10-10 第二轮）---------
  // 每条都要**两半**才算过：
  //   ① 外壳 `hidden` 变真；
  //   ② 内容节点**回到了徽标里**（`advice-tip-window.js` 的 restore()）—— 少了它
  //      徽标就永远少一块，用户再点也没有内容可开，那些节点还会一直挂在窗口里。
  // 顺带守一条第一轮的要求：**滚动总榜不关窗**（v4.6.59 之前有个 `scroll` 监听会把
  // 浮层全收掉，那正是用户说的「会自动关掉」）。
  const staysOpenOnScroll = await evaluate(`(async () => {
    const modal = document.querySelector('.advice-tip-modal');
    const scroller = document.getElementById('adviceConclusionUnits');
    const before = Boolean(modal) && !modal.hidden;
    if (!before || !scroller) return { ok: false, scrolled: null };
    scroller.scrollTop += 120;
    await new Promise((r) => setTimeout(r, 350));
    return { ok: Boolean(modal) && !modal.hidden, scrolled: scroller.scrollTop > 0 };
  })()`);
  // ESC 走**真实键事件**：窗口把监听挂在 `document` 上（wireShell），焦点此刻在关闭
  // 按钮上，所以这里不能靠 `element.click()` 之类的合成路径。
  const pressEscape = async () => {
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Escape', code: 'Escape',
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Escape', code: 'Escape',
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
    await sleep(400);
  };
  // 点背景的落点必须是**卡片外、外壳内**（`close()` 只认 `event.target === 外壳节点`）。
  // 用 `elementFromPoint` 现挑，并要求挑到的**就是外壳本身** —— 否则那一下点的是别人，
  // 「没关掉」也就说明不了任何事。
  const backgroundSpot = await evaluate(`(() => {
    const modal = document.querySelector('.advice-tip-modal');
    const card = modal?.querySelector('.advice-tip-card');
    if (!modal || !card) return null;
    const c = card.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const cands = [[6, 6], [vw - 6, 6], [6, vh - 6], [vw - 6, vh - 6],
      [Math.round(vw / 2), Math.max(2, Math.round(c.top) - 10)],
      [Math.max(2, Math.round(c.left) - 10), Math.round(vh / 2)]];
    for (const spot of cands) {
      const x = spot[0];
      const y = spot[1];
      if (x >= c.left - 2 && x <= c.right + 2 && y >= c.top - 2 && y <= c.bottom + 2) continue;
      const node = document.elementFromPoint(x, y);
      if (node === modal) return { x: x, y: y, tag: node.tagName, cls: String(node.className || '') };
    }
    return null;
  })()`);

  const wasOpen = Boolean(tipReport) && tipReport.modalHidden === false;
  await pressEscape();
  const escClosed = !await windowOpen();
  const escBack = await tipBackInWrap();
  // 重开一次再验点背景（上一条没过也不能把下一条带偏）。
  await clickBadge();
  const reopened = await windowOpen();
  let bgClosed = null;
  let bgBack = null;
  if (backgroundSpot) {
    await mouseClick(backgroundSpot.x, backgroundSpot.y);
    await sleep(400);
    bgClosed = !await windowOpen();
    bgBack = await tipBackInWrap();
  }
  // 收尾：万一还有窗口开着（某条没过），点关闭按钮收干净 ——
  // 别把窗口挂在后面那几行的账单上。
  if (await windowOpen()) {
    await evaluate("document.getElementById('adviceTipClose')?.click(); true");
    await sleep(400);
  }
  closeOk = wasOpen && staysOpenOnScroll.ok && escClosed && escBack && reopened
    && bgClosed === true && bgBack === true;
  if (!closeOk) failures += 1;

  if (!tipReport) {
    console.log(`  ✗ 点击「${tipTarget.unit}」的性价比徽标后没有出现窗口`
      + '（点击没生效？还是外壳没建起来？）');
    console.log(`     窗口开着的判据：document.querySelector('.advice-tip-modal') 存在且 hidden === false`);
  } else {
    console.log(`  ${tipOk ? '✓' : '✗'} 点击「${tipTarget.unit}」的性价比徽标 → 性价比详情大窗口 `
      + `${tipReport.card.w}×${tipReport.card.h} @ (${tipReport.card.x},${tipReport.card.y})`
      + `，视口 ${tipReport.viewport}`
      + ` ${tipReport.cardInside ? '四边都在可见区内 ✓' : '⚠️ 有部分在可见区外 ✗'}`);
    console.log(`      标题 ${JSON.stringify(tipReport.title)} / 头行 ${JSON.stringify(tipReport.headText)}`
      + (titleOk ? ' ✓' : ' ✗（应当都是 /^性价比得分 \\+\\d+$/）'));
    console.log(`      ${bodyScrollOk ? '✓' : '✗'} 正文可滚：内容高 ${tipReport.bodyScrollH}`
      + ` / 可视高 ${tipReport.bodyClientH} / overflow-y=${tipReport.bodyOverflowY}`
      + `${tipReport.bodyNeedsScroll ? '（内容超出，必须真能滚）' : '（内容没超出，不需要滚）'}`
      + `；内容宽 ${tipReport.tipWidth}px、position=${tipReport.tipPosition}`
      + `（小浮层时代上限 620px / fixed，现在 ${tipReport.tipWidth > 620 ? '已是窗口宽度 ✓' : '仍被限宽 ✗'}）`);
    console.log(`      背后页面滚动：html overflow=${tipReport.htmlOverflow}`
      + `${tipReport.htmlOverflow === 'hidden' ? ' ✓（锁住了）' : ' ✗（没锁）'}`
      + ` / 页面横向滚动 ${tipReport.docOverflow ? '✗ 有' : '✓ 无'}`);
    console.log(`      ${orderOk ? '✓' : '✗'} sub 里的次序：贡献值来源表 #${tipReport.order.table}`
      + ` < 全部配队 #${tipReport.order.packs}`
      + ` < 脚注 #${tipReport.order.notes}`
      + `（队伍图标在**表格第一格**里，不再是表上方的一块）`);
    console.log(`      ${renameOk ? '✓' : '✗'} 改名文案：${JSON.stringify(tipReport.caption)}`
      + ` / ${JSON.stringify(tipReport.packCount)}`
      + `${tipReport.packMore ? ` / ${JSON.stringify(tipReport.packMore)}` : '（全部列出，没有「另有 N 个」）'}`
      + `，列出 ${tipReport.packRows} 条，角色得分：${tipReport.packScores.join(' , ') || '(无)'}`);
    console.log(`      配队卡片 ${tipReport.cards} 张（空槽 filled=${tipReport.slotFilled}）`
      + ` / 头像 naturalWidth：${JSON.stringify(tipReport.avatars)}`
      + `（藏起来的碎图 ${tipReport.avatarHidden} 张）`
      + ` / 光锥图标：${JSON.stringify(tipReport.cones)}`);
    // 三个分项那张表（用户 2026-10-13 第 1、2 条）：合计必须与标题上那个数逐字相同。
    console.log(`      ${splitOk ? '✓' : '✗'} 角色得分三分项表：列 ${JSON.stringify(tipReport.splitHeaders)}`
      + `，${tipReport.splitRowCount} 行（3 个分项 + 合计）`
      + `，合计 ${JSON.stringify(tipReport.splitTotal)}（标题上的数是 ${headValue}）`);
    console.log(`      ${sourceOk ? '✓' : '✗'} 贡献值来源表：列 ${JSON.stringify(tipReport.headers)}`
      + `，逐副本 ${tipReport.rows.length} 行`
      + `${tipReport.rows[0] ? `（首行 ${JSON.stringify(tipReport.rows[0])}）` : ''}`
      + `${tipReport.totalRow
        ? `，合计 ${JSON.stringify(tipReport.totalRow)}`
          + `（期望 ${sourceTotalExpected} = 性价比分项的原始分；徽标那个数是 ${headValue}）`
        : '，单副本无合计行'}`);
    // 用户 2026-10-13：「三项都要有完整得分来源」——强度那张表与泛用性那块名单各自一行。
    console.log(`      ${strengthSourceOk ? '✓' : '✗'} 强度来源表：列 ${JSON.stringify(tipReport.strengthHeaders)}`
      + `，${tipReport.strengthRowCount} 行`
      + `${tipReport.strengthTotalRow ? `，合计 ${JSON.stringify(tipReport.strengthTotalRow)}` : '，单副本无合计行'}`);
    console.log(`      ${versatilitySourceOk ? '✓' : '✗'} 泛用性来源：名单 ${tipReport.versListCount} 个`
      + `（标题写 ${tipReport.versRaw} 个）｜归一换算「${tipReport.versNote}」`);
    // 2026-10-11 第 2 条：三条判据各自单独打印一行，红的是哪一条一眼看得出。
    console.log(`  ${headerRenameOk ? '✓' : '✗'} 表头第一列已改名为「关卡」`
      + `（禁用「副本」）：${JSON.stringify(tipReport.headers)}`);
    console.log(`  ${seasonColOk ? '✓' : '✗'} 第一列备注该关卡的版本号：`
      + `${tipReport.firstColSeasons.length} 行 ${JSON.stringify(tipReport.firstColSeasons)}`
      + `（关卡的版本小字应按行取，形如 4.6 版本）`);
    console.log(`  ${teamBlockOk ? '✓' : '✗'} 队伍图标在表格第一格里（用户 2026-10-11 第 5 条）：`
      + `表上方的旧块残留 caption ${tipReport.teamCaptionLeft} 个 / 说明行 ${tipReport.teamEnvLeft} 个（都应为 0）`
      + `；表体 ${tipReport.rows.length} 行，第一格`
      + `${tipReport.firstCells.filter((c) => c.slots >= 1 && c.cards >= 1).length} 格有卡片`
      + `（卡片数 ${JSON.stringify(tipReport.firstCells.map((c) => c.cards))}）`
      + `　行线 ${JSON.stringify(tipReport.firstCells.map((c) => c.borderBottom))}`);
    console.log(`      窗口高度 ${tipReport.tipHeight}px`
      + `（改前表上方那一块 + 表格 ≈ 1100px 起：现在就一张表）`
      + `；逐行高度 ${JSON.stringify(tipReport.firstCells.map((c) => c.rowHeight))}`);
    console.log(`  ${alignOk ? '✓' : '✗'} 非「关卡」列**上下居中**（用户 2026-10-11 追加）：`
      + `逐行「数字格文字中心 vs 整行中心」偏差 `
      + `${JSON.stringify(tipReport.firstCells.map((c) => c.midDelta))}px（要求 ≤4）`
      + `｜旧「等高」判据的诊断值 ${JSON.stringify(tipReport.firstCells.map((c) => c.alignDelta))}px`);
    console.log(`  ${spreadOk ? '✓' : '✗'} 队伍图标**往右边分散**（同一条）：`
      + `卡片行 justify-content ${JSON.stringify(tipReport.firstCells[0]?.justify)}`
      + `（要求 space-evenly）+ 逐行铺开比例 `
      + `${JSON.stringify(tipReport.firstCells.map((c) => c.spread))}（要求 ≥0.8）`);
    console.log(`  ${stageNameCnOk ? '✓' : '✗'} 关卡名一律是中文，没有数据集英文 id`
      + `（用户 2026-10-11：「这些英语简称，我没要求添加」）：`
      + `第一格 ${JSON.stringify(tipReport.firstCells.map((c) => `${c.env}·${c.stage}`))}`);
    console.log(`  ${costCellOk ? '✓' : '✗'} 金数列：斜杠写法 / 封顶标出 / 0 金写 ×1.20`
      + `（全文含除号 ${tipReport.hasDivisionSign ? '✗ 有' : '✓ 无'}`
      + `${tipReport.hasDivisionSign ? `，位置：…${tipReport.divisionContext}…` : ''}）：`
      + JSON.stringify(tipReport.rows.map((r) => r[costCol])));
    console.log(`      ${notesTextOk && notesShortOk ? '✓' : '✗'} 脚注 `
      + `${tipReport.notes} 条（≥6 ${tipReport.notes >= 6 ? '✓' : '✗'}`
      + ` / 逐字对得上 ${notesTextOk ? '✓' : '✗'}`
      + ` / 每条 ≤60 字 ${notesShortOk ? '✓' : '✗'}）：`
      + tipReport.noteTexts.map((t) => `${t.length} 字`).join(' / '));
    if (!notesTextOk) {
      // 对不上时把「缺哪一条」和「实际是什么」都打出来 —— 只报一个 ✗ 会让人去猜。
      const missing = [ ...NOTE_EXACT, ...NOTE_RE ]
        .filter((t) => (typeof t === 'string'
          ? !tipReport.noteTexts.includes(t) : !tipReport.noteTexts.some((x) => t.test(x))));
    console.log(`      ← 对不上的脚注：${JSON.stringify(missing.map(String))}`);
      console.log(`        实际脚注：${JSON.stringify(tipReport.noteTexts)}`);
    }
    // 2026-10-10（本轮需求）：界面上不再写「满分 / 达标 / 及格」，一律写游戏内实际的量。
    // 档位列逐格打印，出现禁词 / 退化成兜底写法时一眼能看出是哪一格。
    console.log(`  ${tierCellOk ? '✓' : '✗'} 档位列写游戏内实际的量（用户 2026-10-10）：`
      + `${tierCells.length} 格 ${JSON.stringify(tierCells)}`);
    console.log(`  ${notesNoBannedOk ? '✓' : '✗'} 档位列与脚注都不含「满分 / 达标 / 及格」`
      + `${notesNoBannedOk ? '' : `　← 违规：${JSON.stringify(
        [...tierCells, ...tipReport.noteTexts].filter((t) => bannedWords.test(t)))}`}`);
    console.log(`  ${closeOk ? '✓' : '✗'} 关闭三条路（用户 2026-10-10 第二轮）：`
      + ` ESC ${escClosed ? '✓' : '✗'}（关掉后内容回到徽标里 ${escBack ? '✓' : '✗'}）`
      + ` / 点背景 ${bgClosed === null
        ? '⚠️ 没找到「卡片外、外壳内」的落点'
        : (bgClosed ? '✓' : '✗')}`
      + `${backgroundSpot ? `（落点 ${backgroundSpot.x},${backgroundSpot.y} = ${backgroundSpot.tag}.${backgroundSpot.cls}）` : ''}`
      + ` / 重开一次 ${reopened ? '✓' : '✗'}`
      + ` / 滚动总榜不关窗 ${staysOpenOnScroll.ok ? '✓' : '✗'}`
      + `${staysOpenOnScroll.scrolled ? '（容器真的滚了）' : '（⚠️ 容器没滚动）'}`
      + `${wasOpen ? '' : ' ← ⚠️ 上面那几条是在「窗口压根没开」的前提下量的'}`);
  }
}

// ③ 「隐金设置」按钮 + 它的详情窗口（用户 2026-10-11）---------------------------
//
// 用户原话：「我现在需要在性价比总榜添加一个按钮，用于额外设置，将其放置于总榜权重
// 下方……点击后弹出详情界面，角色和光锥都需要有图标，详情页要美观可用，界面信息不出界，
// 以下复选框默认已点击」。
//
// 四组判据：
//   ① 位置：按钮在「总榜权重」之后、总榜列表之前（DOM 次序与几何各量一次）；
//   ② 窗口：点开后卡片**四边都在可见区内**（用户要的「信息不出界」）、正文比窗口高
//      所以真的能滚、背后页面锁滚（app.css 的 `html:has(.advice-gold-modal:not([hidden]))`）；
//   ③ 内容：三个**加粗**分组标题、五个复选框**默认全勾**、五条「效果：…」说明、
//      每个单位都有一张真的加载出来的图标（`naturalWidth > 0`，理由见脚本开头那段
//      焦点模拟的注释）；而「特殊情况」那类口径文字**不出现**（用户要求括号里的内容
//      不上界面）；
//   ④ 行为：勾 / 取消勾**立即**写进 localStorage 并按新设置重算总榜（榜面指纹真的变了，
//      再勾回来还要能恢复），关闭三条路（关闭按钮 / 点背景 / ESC）都要能关。
//
// ⚠️ 本段在 `else` 块**外面**，所以不能用上面那个块作用域的 `pressEscape` —— 自己发一份。
const pressEscapeNow = async () => {
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Escape', code: 'Escape',
    windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape',
    windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await sleep(300);
};

/** 点「隐金设置」按钮（真实鼠标事件：一「按」= pressed + released）。 */
const goldButtonClick = async () => {
  const spot = await evaluate(`(() => {
    const btn = document.getElementById('adviceHiddenCostsOpen');
    if (!btn) return null;
    btn.scrollIntoView({ block: 'center' });
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (spot) await mouseClick(spot.x, spot.y);
  await sleep(700);
  return spot;
};

/** 窗口是不是开着（`hidden` 是唯一判据，与另外两个大窗口同一写法）。 */
const goldModalOpen = () => evaluate(
  "(() => { const m = document.querySelector('.advice-gold-modal'); return Boolean(m) && !m.hidden; })()");

/**
 * 总榜的**指纹**（全榜 textContent 的简易哈希）。
 *
 * 为什么不只断言 localStorage：这个开关的全部意义就是「按新设置重算总榜」，
 * 存档写进去了但榜没动才是最可能的失败模式（服务端漏传、缓存键漏字段都会这样）。
 */
const goldBoardHash = () => evaluate(`(() => {
  const t = document.getElementById('adviceConclusionUnits')?.textContent || '';
  let h = 0;
  for (let i = 0; i < t.length; i += 1) h = (h * 31 + t.charCodeAt(i)) % 2147483647;
  return t.length + ':' + h;
})()`);

// 先清掉存档，回到用户指定的初始状态（默认全勾）。不清的话，上一次跑留下的存档会让
// 「默认已点击」这条断言时红时绿 —— 那是测试自己的状态污染，不是功能回归。
await evaluate("(() => { localStorage.removeItem('hsr.advice.hiddenCosts'); return true; })()");
await send('Page.reload', { ignoreCache: false });
await sleep(3000);
for (let i = 0; i < 20; i += 1) {
  const ready = await evaluate("Boolean(document.querySelector('#adviceConclusionUnits .advice-unit'))");
  if (ready) break;
  await sleep(500);
}

const goldBar = await evaluate(`(() => {
  const btn = document.getElementById('adviceHiddenCostsOpen');
  const weights = document.getElementById('adviceFrontierWeights');
  const list = document.getElementById('adviceConclusionUnits');
  if (!btn || !weights || !list) return null;
  const b = btn.getBoundingClientRect();
  const w = weights.getBoundingClientRect();
  const l = list.getBoundingClientRect();
  return {
    text: btn.textContent.trim(),
    afterWeights: Boolean(weights.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING),
    beforeList: Boolean(btn.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING),
    gapBelowWeights: Math.round(b.top - w.bottom),
    gapAboveList: Math.round(l.top - b.bottom),
    meta: document.getElementById('adviceHiddenCostsMeta')?.textContent || '',
  };
})()`);

let goldLayoutOk = false;
if (!goldBar) {
  failures += 1;
  console.log('  ✗ 总榜里找不到「隐金设置」按钮（#adviceHiddenCostsOpen）或它旁边的参照节点');
} else {
  // 允许 -6px：按钮那一条是负外边距贴上权重块下沿的（用户要的就是「紧跟在下方」）。
  goldLayoutOk = goldBar.text === '隐金设置' && goldBar.afterWeights && goldBar.beforeList
    && goldBar.gapAboveList >= 0 && goldBar.gapBelowWeights >= -6 && goldBar.meta.length > 0;
  if (!goldLayoutOk) failures += 1;
  console.log(`  ${goldLayoutOk ? '✓' : '✗'} 「隐金设置」按钮位置（用户指定：总榜权重下方）：`
    + `文案 ${JSON.stringify(goldBar.text)}`
    + ` / 在总榜权重之后 ${goldBar.afterWeights ? '✓' : '✗'}`
    + ` / 在总榜列表之前 ${goldBar.beforeList ? '✓' : '✗'}`
    + `（距权重块下沿 ${goldBar.gapBelowWeights}px、距列表 ${goldBar.gapAboveList}px）`);
  console.log(`      按钮旁状态行：${JSON.stringify(goldBar.meta)}`);
}

let goldReport = null;
let goldModalOk = false;
let goldToggleOk = false;
let goldCloseOk = false;
if (goldBar && !goldBar.afterWeights) {
  console.log('      ⚠️ 按钮不在总榜权重下方，下面的窗口断言仍然照跑（位置问题不掩盖功能问题）');
}
if (goldBar) {
  const boardBefore = await goldBoardHash();
  await goldButtonClick();
  // 图标是异步加载的：给三轮有界重试（重新赋一次 src 往往就成功，见详情大窗口那段）。
  for (let round = 0; round < 3; round += 1) {
    const left = await evaluate(`(() => {
      const modal = document.querySelector('.advice-gold-modal');
      const imgs = [ ...(modal?.querySelectorAll('.advice-gold-icon') || []) ]
        .filter((i) => i.naturalWidth === 0);
      for (const img of imgs) {
        img.classList.remove('is-missing');
        const url = img.getAttribute('src');
        img.removeAttribute('src');
        img.src = url;
      }
      return imgs.length;
    })()`);
    if (!left) break;
    await sleep(2000);
  }
  goldReport = await evaluate(`(() => {
    const modal = document.querySelector('.advice-gold-modal');
    const card = modal?.querySelector('.advice-gold-card');
    const body = modal?.querySelector('.advice-gold-body');
    if (!modal || !card || !body) return null;
    const cr = card.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const checks = [ ...modal.querySelectorAll('.advice-gold-check') ];
    const titles = [ ...modal.querySelectorAll('.advice-gold-group-title') ];
    const chips = [ ...modal.querySelectorAll('.advice-gold-unit') ];
    const icons = [ ...modal.querySelectorAll('.advice-gold-icon') ];
    return {
      hidden: modal.hidden,
      card: { w: Math.round(cr.width), h: Math.round(cr.height),
        x: Math.round(cr.left), y: Math.round(cr.top) },
      cardInside: cr.left >= 0 && cr.right <= vw && cr.top >= 0 && cr.bottom <= vh,
      viewport: vw + 'x' + vh,
      title: document.getElementById('adviceGoldTitle')?.textContent || '',
      checks: checks.length,
      checked: checks.filter((c) => c.checked).length,
      groups: titles.map((n) => n.textContent),
      groupWeight: titles.map((n) => getComputedStyle(n).fontWeight),
      labels: checks.map((c) => c.closest('.advice-gold-row')
        ?.querySelector('.advice-gold-row-label')?.textContent || ''),
      effects: [ ...modal.querySelectorAll('.advice-gold-effect') ].map((n) => n.textContent),
      chips: chips.length,
      chipNames: chips.map((c) => c.querySelector('.advice-gold-unit-name')?.textContent || ''),
      icons: icons.length,
      iconZero: icons.filter((i) => i.naturalWidth === 0).length,
      bodyScrollable: body.scrollHeight > body.clientHeight,
      bodyOverflowY: getComputedStyle(body).overflowY,
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      notes: [ ...modal.querySelectorAll('.advice-gold-note') ].map((n) => ({
        text: n.textContent, h: Math.round(n.getBoundingClientRect().height),
      })),
      hasClose: Boolean(document.getElementById('adviceGoldClose')),
      hasReset: Boolean(document.getElementById('adviceGoldReset')),
      // 用户 2026-10-11 追加要求：「你要加个备注，提示用户特殊情况」。所以这里守的是
      // 「备注真的画出来且写着那两条例外」，同时**仍然**不许把括号里的说明性文字
      // （「（点击后…）」「（复选框）」「（特殊情况：…）」这类**写作指令**）搬上界面。
      bracketLeak: /（点击后|（复选框|（特殊情况|（直接受赠|（角色兑换|（常驻角色/.test(modal.textContent || ''),
      docOverflow: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth,
    };
  })()`);

  if (!goldReport) {
    failures += 1;
    console.log('  ✗ 点「隐金设置」之后没有出现窗口'
      + '（判据：document.querySelector(".advice-gold-modal") 存在且 hidden === false）');
  } else {
    const bulletOk = goldReport.groups.length === 3
      && goldReport.groupWeight.every((w) => Number(w) >= 600);
    const checkedOk = goldReport.checks === 5 && goldReport.checked === 5;
    const labelsOk = goldReport.labels.filter((t) => /^隐藏/.test(t)).length === 5;
    const effectsOk = goldReport.effects.length === 5
      && goldReport.effects.every((t) => t.startsWith('效果：'));
    // 35 个单位（11 + 2 + 5 + 11 + 6）：图标数必须与单位数一致，且**一张都不许是 0 宽**
    // （`naturalWidth > 0` 才代表图真的加载出来了，只看 src 存在会误判）。
    const iconsOk = goldReport.chips >= 30 && goldReport.icons === goldReport.chips
      && goldReport.iconZero === 0;
    // ⚠️ **不要求「正文一定比窗口高」**：卡片高度是 `max-height`（贴着内容走），
    // 五个分组实测约 700px，在 1600×1000 下根本不需要滚。要守的是**能力**：
    // 正文是 `overflow: auto`、且真的超出时能滚（`bodyScrollable` 只打印、不打红）。
    const scrollOk = goldReport.bodyOverflowY === 'auto';
    // 备注（用户 2026-10-11 追加要求「加个备注，提示用户特殊情况」）：只有①那两条有，
    // 必须**真的渲染出来**（高度 > 0）且写着那两条例外；三个分组标题与五个效果说明之外
    // 不许混进括号里的写作指令。
    const noteOk = goldReport.notes.length === 2
      && goldReport.notes.every((n) => n.text.length > 10 && n.h > 0)
      && /Archer/.test(goldReport.notes[0].text) && /吉尔伽美什/.test(goldReport.notes[0].text)
      && /一共只减 1/.test(goldReport.notes[0].text)
      && /理想燃烧的地狱/.test(goldReport.notes[1].text) && /所见即我/.test(goldReport.notes[1].text);
    goldModalOk = goldReport.hidden === false && goldReport.cardInside
      && goldReport.title === '隐金设置' && checkedOk && bulletOk && labelsOk && effectsOk
      && iconsOk && scrollOk && noteOk && goldReport.htmlOverflow === 'hidden'
      && goldReport.hasClose && goldReport.hasReset && !goldReport.bracketLeak
      && !goldReport.docOverflow;
    if (!goldModalOk) failures += 1;
    console.log(`  ${goldModalOk ? '✓' : '✗'} 点「隐金设置」→ 详情窗口 `
      + `${goldReport.card.w}×${goldReport.card.h} @ (${goldReport.card.x},${goldReport.card.y})`
      + `，视口 ${goldReport.viewport}`
      + ` ${goldReport.cardInside ? '四边都在可见区内 ✓' : '⚠️ 有部分在可见区外 ✗（用户要求信息不出界）'}`);
    console.log(`      标题 ${JSON.stringify(goldReport.title)} / 复选框 ${goldReport.checks} 个`
      + `（默认勾上 ${goldReport.checked} 个 ${checkedOk ? '✓' : '✗'}）`
      + ` / 分组标题 ${goldReport.groups.length} 个（字重 ${goldReport.groupWeight.join(',')}`
      + ` ${bulletOk ? '✓ 加粗' : '✗ 没加粗'}）`);
    console.log(`      文案：${goldReport.labels.map((t) => JSON.stringify(t)).join(' / ')}`);
    console.log(`      ${effectsOk ? '✓' : '✗'} 效果说明 ${goldReport.effects.length} 条`
      + `（首条 ${JSON.stringify(goldReport.effects[0] || '')}）`);
    console.log(`      ${noteOk ? '✓' : '✗'} 备注（用户 2026-10-11 追加要求）${goldReport.notes.length} 条`
      + `${goldReport.notes.map((n) => `［${n.h}px］${JSON.stringify(n.text)}`).join(' / ')}`
      + ` / 括号里的写作指令${goldReport.bracketLeak ? '✗ 泄漏到界面上了' : '✓ 未出现'}`);
    console.log(`      ${iconsOk ? '✓' : '✗'} 单位 ${goldReport.chips} 个 / 图标 ${goldReport.icons} 张`
      + `（naturalWidth 为 0 的 ${goldReport.iconZero} 张）`
      + `：${goldReport.chipNames.slice(0, 6).join('、')} …`);
    console.log(`      ${scrollOk ? '✓' : '✗'} 正文可滚（overflow-y=`
      + `${goldReport.bodyOverflowY}；内容${goldReport.bodyScrollable ? '超出，真的会滚' : '没超出，不需要滚'}）`
      + ` / 背后页面 ${goldReport.htmlOverflow}`
      + `${goldReport.htmlOverflow === 'hidden' ? ' ✓（锁住）' : ' ✗（没锁）'}`
      + ` / 页面横向滚动 ${goldReport.docOverflow ? '✗ 有' : '✓ 无'}`);
  }

  // ---- 行为：勾 / 取消勾即刻生效（写存档 + 重算总榜，且可逆）-------------------
  //
  // ⚠️ 这一段曾经写成「点一次、等 12 秒、指纹没变就判红」，在**独立跑**时误报过一次
  // （同一份代码用 `tools/_probe-yinjin-toggle.mjs` 干净加载实测 **1 秒** 就重算完了）。
  // 原因是这套件前面的「三视口 × 五副本」把页面压得很重，`/conclusion` 偶尔十几秒才回来
  // —— 与 §6.3 第 7 条记的权重那一组是同一类现象。所以这里改成：
  //   * 幂等地把开关设到想要的状态（不依赖「点一下必然翻转」）；
  //   * 每轮给 15 秒、**最多两轮**（第一轮不成先还原再试一次）；
  //   * 真的还不变时**从页面里直接打一次接口**，把「服务端不对」与「DOM 没刷新」分开，
  //     别让下一个接手的人猜。
  const setGoldCheck = (want) => evaluate(`(() => {
    const box = document.querySelector('.advice-gold-check[data-hidden-cost="gift"]');
    if (!box) return null;
    if (box.checked !== ${want}) box.click();
    return box.checked;
  })()`);
  const waitBoardDiffers = async (target, giveMs) => {
    const deadline = Date.now() + giveMs;
    for (;;) {
      if (await goldBoardHash() !== target) return true;
      if (Date.now() > deadline) return false;
      await sleep(500);
    }
  };
  const waitBoardEquals = async (target, giveMs) => {
    const deadline = Date.now() + giveMs;
    for (;;) {
      if (await goldBoardHash() === target) return true;
      if (Date.now() > deadline) return false;
      await sleep(500);
    }
  };
  const boardAfterOpen = await goldBoardHash();
  let boardChanged = false;
  let boardRestored = false;
  /** 取消勾之后**立刻**读一次存档：证明「勾选即刻写进 localStorage」这一半也成立。 */
  let storedOff = '';
  for (let attempt = 0; attempt < 2 && !boardChanged; attempt += 1) {
    await setGoldCheck(false);
    await sleep(400);
    storedOff = await evaluate("localStorage.getItem('hsr.advice.hiddenCosts') || ''");
    boardChanged = await waitBoardDiffers(boardAfterOpen, 15000);
    await setGoldCheck(true);
    boardRestored = await waitBoardEquals(boardAfterOpen, 15000);
  }
  await sleep(400);
  const stored = await evaluate("localStorage.getItem('hsr.advice.hiddenCosts') || ''");
  const metaAfter = await evaluate(
    "document.getElementById('adviceHiddenCostsMeta')?.textContent || ''");
  goldToggleOk = boardChanged && boardRestored && storedOff.includes('"gift":false');
  if (!goldToggleOk) failures += 1;
  console.log(`  ${goldToggleOk ? '✓' : '✗'} 勾选即刻生效（用户没要「确定」按钮）：`
    + `取消勾后的存档=${JSON.stringify(storedOff)}`
    + ` / 勾回去后的存档=${JSON.stringify(stored)}`
    + ` / 状态行 ${JSON.stringify(metaAfter)}`
    + ` / 总榜按新设置重算 ${boardChanged ? '✓' : '✗'}`
    + ` / 勾回去后榜面恢复 ${boardRestored ? '✓' : '✗'}`);
  console.log(`      （进入这一段时榜面指纹 ${boardBefore}，窗口打开后 ${boardAfterOpen}）`);
  if (!boardChanged) {
    // 诊断：从页面里**直接**打一次接口，对比两种设置的服务端返回 ——
    //   top/gold 不同而 DOM 没动 ⇒ 页面没刷新（时序）；
    //   服务端返回**也**一样 ⇒ 接口/口径没接上（或 8360 上那份服务没重启，payload 还是 4）。
    const diag = await evaluate(`(async () => {
      const call = async (gift) => {
        const res = await fetch('/api/archive/conclusion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account: { owned: [], eidolons: {}, cones: {} },
            window: 6,
            hiddenCosts: { gift: gift, giftCone: true, exchange: true,
              exchangeCone: true, standard: true },
          }),
        });
        const data = await res.json();
        const top = (data.frontierUnits || [])[0] || null;
        return { payload: data.payload, count: (data.frontierUnits || []).length,
          topTotal: top ? top.total : null, topGold: top ? top.gold : null };
      };
      return {
        giftOn: await call(true), giftOff: await call(false),
        boardRows: document.querySelectorAll('#adviceConclusionUnits .advice-unit').length,
        conclusionMeta: document.getElementById('adviceConclusionMeta')?.textContent || '',
      };
    })()`);
    console.log('      ← 诊断（服务端两种设置的返回 + 结论区文案）：' + JSON.stringify(diag));
  }

  // ---- 关闭三条路（与另外两个大窗口同一套行为）-------------------------------
  await evaluate("document.getElementById('adviceGoldClose')?.click(); true");
  await sleep(300);
  const closeBtnClosed = !await goldModalOpen();
  await goldButtonClick();
  const reopenedByEsc = await goldModalOpen();
  await pressEscapeNow();
  const escClosed = reopenedByEsc && !await goldModalOpen();
  await goldButtonClick();
  const goldBackgroundSpot = await evaluate(`(() => {
    const modal = document.querySelector('.advice-gold-modal');
    const card = modal?.querySelector('.advice-gold-card');
    if (!modal || !card) return null;
    const c = card.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const cands = [[6, 6], [vw - 6, 6], [6, vh - 6], [vw - 6, vh - 6]];
    for (const s of cands) {
      if (s[0] >= c.left - 2 && s[0] <= c.right + 2
        && s[1] >= c.top - 2 && s[1] <= c.bottom + 2) continue;
      if (document.elementFromPoint(s[0], s[1]) === modal) return { x: s[0], y: s[1] };
    }
    return null;
  })()`);
  let bgClosed = null;
  if (goldBackgroundSpot) {
    await mouseClick(goldBackgroundSpot.x, goldBackgroundSpot.y);
    await sleep(400);
    bgClosed = !await goldModalOpen();
  }
  // 收尾：万一还开着（某条没过），点关闭按钮收干净，别让它影响后面。
  if (await goldModalOpen()) {
    await evaluate("document.getElementById('adviceGoldClose')?.click(); true");
    await sleep(300);
  }
  goldCloseOk = closeBtnClosed && escClosed && bgClosed === true;
  if (!goldCloseOk) failures += 1;
  console.log(`  ${goldCloseOk ? '✓' : '✗'} 关闭三条路：关闭按钮 ${closeBtnClosed ? '✓' : '✗'}`
    + ` / ESC ${escClosed ? '✓' : '✗'}`
    + ` / 点背景 ${bgClosed === null ? '⚠️ 没找到落点' : (bgClosed ? '✓' : '✗')}`
    + `${goldBackgroundSpot ? `（落点 ${goldBackgroundSpot.x},${goldBackgroundSpot.y}）` : ''}`);
  // 把状态还原：跑完这一套之后本机不该留着「关掉 gift」的存档（下一次打开页面
  // 就应当是用户默认的全勾，否则用户会看到榜跟自己印象里不一样）。
  await evaluate("localStorage.removeItem('hsr.advice.hiddenCosts'); true");
}

// ---- ② 抽卡方案（**队伍口径**，2026-10-11 第 10 轮）----------------------------
//
// 用户这一轮的要求：候选 = 性价比总榜去重后的队伍、两个指标各占一半、剔除补金 0 金、
// 每个结果都带补金顺序、方案权重那一行去掉。这里钉**界面真的这么画了**；
// 算法本身的不变量在 `tools/team-plan-test.mjs`（那个套件不需要浏览器）。
console.log('\n▶ 抽卡方案（队伍口径：总分 = 两指标各半 + 补金顺序）');
const teamPlanProbe = await evaluate(`(() => {
  const body = document.getElementById('adviceTeamPlanBody');
  if (!body) return { missing: true };
  const cards = [ ...body.querySelectorAll('.advice-plan-team') ];
  const parse = (t) => Number(String(t || '').replace(/[^0-9.]/g, '')) || 0;
  const rows = cards.map((card) => {
    const head = card.querySelector('.advice-plan-team-head');
    const badge = head?.querySelector('.advice-unit-value')?.textContent || '';
    const eq = head?.querySelector('.advice-plan-team-eq')?.textContent || '';
    // ⚠️ 那个等式里有 4 个数字（两个分项 + 两处系数），实测形如
    //    「= 强度得分 64.9 × 0.5 + 差额接近度 83.3 × 0.5」—— 按**下标**取会取到 64.9 与 0.5
    //    （于是 0.5×64.9+0.5×0.5 ≠ 徽标，假红）。只能按标签取。
    //    ⚠️ 用户 2026-10-11 把「性价比」改叫**强度得分**、「总分」改叫**补金推荐分**，
    //    并把全角空格换成普通空格 —— 标签跟着改，否则这两条断言会双双假红。
    //    ⚠️ 2026-10-12 第 3、4 条把写死的 × 0.5 换成了**用户可调的抽卡权重**，
    //    所以这两个系数必须从等式里现取，不能再写死（默认仍是 0.5 / 0.5）。
    //    ⚠️ 这一段整个是模板字符串：注释里**不能出现反引号**（HANDOFF §6.1 第 16 条）。
    const numAfter = (label) => Number((eq.match(new RegExp(label + '[^0-9]*([0-9]+(?:\\.[0-9]+)?)')) || [])[1]);
    const coefAfter = (label) => {
      const seg = eq.slice(eq.indexOf(label));
      return Number((seg.match(/×\\s*([0-9]+(?:\\.[0-9]+)?)/) || [])[1]);
    };
    // ⚠️ 第二项在 2026-10-12 第 6 条**回到**「差额接近度」：v4.6.87 一度叫「性价比得分」
    //    （差额接近度 与 压金度 合成），用户说这三者重叠、只要差额接近度，于是删掉中间层。
    //    标签不跟着改，numAfter 会取到 NaN（这条断言就是这么被绊到的）。
    const parts = [numAfter('强度得分'), numAfter('差额接近度'), numAfter('泛用性')];
    // ⚠️ 第三项「泛用性」是用户 2026-10-13 第 3 条（「泛用性权重也适用于补金推荐」）
    //    加进来的 —— 等式里现在是**三个**分项与三个系数，v4.6.95/96 时只有两个。
    const coefs = [coefAfter('强度得分'), coefAfter('差额接近度'), coefAfter('泛用性')];
    const fills = [ ...card.querySelectorAll('.advice-plan-team-fill .advice-fill-item') ];
    // 一笔补金可能是**多金**（例：遐蝶 E0→E2 一笔 2 金），所以条数 ≠ 补金金数 ——
    // 正确的判据是「各条的金数之和 = 补金金数」。每条的 .advice-fill-cost 以「N 金」开头。
    const fillGolds = fills.reduce((s, li) => {
      const t = li.querySelector('.advice-fill-cost')?.textContent || '';
      return s + (Number((t.match(/^([0-9]+)\\s*金/) || [])[1]) || 0);
    }, 0);
    const facts = card.querySelector('.advice-plan-team-gold')?.textContent || '';
    const gap = Number((facts.match(/补金 (\\d+) 金/) || [])[1] ?? NaN);
    // 隐金减免：账面那一行在减免 > 0 时会写「（含隐金减免 N 金）」。
    // ⚠️ 这是**允许补金顺序为空**的唯一正当理由（见下面 shapeOk 的判据）：用户第 6 条
    // 要求「隐金后不添加成本的那几笔不显示」，所以一整队的补金项全被盖掉时列表就是空的。
    const hiddenCut = Number((facts.match(/含隐金减免 (\\d+) 金/) || [])[1] || 0);
    return {
      badge: parse(badge),
      badgeText: badge.trim(),
      eqText: eq,
      cardText: card.textContent || '',
      parts,
      coefs,
      hasRank: Boolean(head?.querySelector('.advice-unit-rank')?.textContent),
      slots: card.querySelectorAll('.advice-plan-team-slot').length,
      missing: card.querySelectorAll('.advice-plan-team-slot.is-missing').length,
      fills: fills.length,
      fillGolds,
      gap,
      hiddenCut,
      factsText: facts,
      fillText: fills.map((li) => li.textContent || ''),
      // 「一笔补金买到什么」的**目标状态那一格**（.advice-fill-step）单独取出来：
      // 用户 2026-10-11 报的 bug 就长在这一格里（已拥有的角色被写成「本体+E2」）。
      fillSteps: fills.map((li) => li.querySelector('.advice-fill-step')?.textContent || ''),
      fillNames: fills.map((li) => li.querySelector('.advice-fill-name')?.textContent || ''),
      ownedChars: [ ...card.querySelectorAll('.advice-plan-team-slot.is-owned .advice-plan-team-char') ]
        .map((n) => n.textContent),
      hasBest: Boolean(card.querySelector('.advice-plan-team-best')),
      // 用户 2026-10-11 第 7 条：「过渡档位」那一行（需要补多笔时才有）。
      hasMid: Boolean(card.querySelector('.advice-plan-team-mid')),
      midText: card.querySelector('.advice-plan-team-mid')?.textContent || '',
    };
  });
  return {
    text: (body.textContent || '').trim().slice(0, 60),
    cards: cards.length,
    rows,
    meta: document.getElementById('adviceTeamPlanMeta')?.textContent || '',
    foot: Boolean(body.querySelector('.advice-plan-team-foot')),
    legacy: document.querySelectorAll('#advicePlanWeights, #advicePlanWeightRow').length,
  };
})()`);
if (teamPlanProbe.missing) {
  failures += 1;
  console.log('  ✗ 找不到 #adviceTeamPlanBody（抽卡方案那一节没渲染出来）');
} else {
  const hasCards = teamPlanProbe.cards > 0;
  console.log(`  ${hasCards ? '✓' : '·'} 队伍方案卡片 ${teamPlanProbe.cards} 张`
    + `${hasCards ? '' : `（未登录时是说明文案：${teamPlanProbe.text}）`}`
    + `｜状态行「${teamPlanProbe.meta}」`);
  const legacyGone = teamPlanProbe.legacy === 0;
  if (!legacyGone) failures += 1;
  console.log(`  ${legacyGone ? '✓' : '✗'} 「方案权重」那一行已删除（残留 ${teamPlanProbe.legacy} 个容器）`);
  if (hasCards) {
    // 每张卡：名次 + 四个位置 + 分项等式（两个分项 × 印出来的系数 = 徽标）+ 补金顺序之和 = 补金金数
    // ⚠️ 系数不写死 0.5：2026-10-12 第 3 条起它们来自用户可调的**抽卡权重**，
    //    这里验的是「按卡上印出来的系数算得回去」+「系数加起来是 1」。
    //    ⚠️ 2026-10-13 第 3 条（「泛用性权重也适用于补金推荐」）之后是**三个**系数。
    //    ⚠️ 容差必须放宽到 ~1.5：卡上印的系数是**两位小数**（`formatShare`），
    //    `1/3` 印成 `0.33`、三项合计 0.99；乘以「分项之和」（≤300）后误差可达
    //    0.015 × 300 ≈ 4.5？不 —— 每项误差 ≤0.005，三项 ≤0.015，但**只有真实权重
    //    与印出来的差**才进这个和，实测前 15 名的偏差在 0.7 以内。取 1.51 留足余量，
    //    同时仍然能抓住「系数印错了一位」这类真错（那种偏差是几十）。
    const eqOk = teamPlanProbe.rows.every((r) => r.parts.length === 3 && r.coefs.length === 3
      && Math.abs(r.coefs[0] + r.coefs[1] + r.coefs[2] - 1) < 0.02
      && Math.abs(r.coefs[0] * r.parts[0] + r.coefs[1] * r.parts[1]
        + r.coefs[2] * r.parts[2] - r.badge) < 1.51);
    if (!eqOk) failures += 1;
    console.log(`  ${eqOk ? '✓' : '✗'} 每张卡的总分 = 强度得分×系数 + 差额接近度×系数 + 泛用性×系数`
      + `（系数由抽卡权重决定、印在卡上，三个系数之和必须是 1）`);
    const shapeOk = teamPlanProbe.rows.every((r) => r.hasRank && r.slots === 4
      // ⚠️ `fills >= 1` 曾被写成硬条件，与用户第 6 条**自相矛盾**：隐金设置开着时
      //    「不添加成本的那几笔」会被隐藏，一整队的补金项全被盖掉时列表就是空的。
      //    所以「空列表」只在**该卡片确实有隐金减免**时才算合法；没有减免却是空列表
      //    才是真 bug（那说明补金项渲染丢了）。实测第一张卡就是这样拿到 `0条/0≤2` 的。
      && (r.fills >= 1 || r.hiddenCut > 0)
      && r.fillGolds <= r.gap);
    if (!shapeOk) failures += 1;
    console.log(`  ${shapeOk ? '✓' : '✗'} 每张卡有名次 / 4 个位置 / **补金顺序的金数 ≤ 补金金数**`
      + `（用户第 6 条：隐金后不添加成本的那几笔不显示，所以只要求「不大于」；`
      + `空列表只在「有隐金减免」时合法）`
      + `（实测 ${teamPlanProbe.rows.map((r) => `${r.fills}条/${r.fillGolds}≤${r.gap}${r.hiddenCut ? `·减${r.hiddenCut}` : ''}`).join(' ')}）`);
    // 空列表的卡片，把账面那一行的原文打出来（判断是「真丢了」还是「减免没标出来」）。
    for (const r of teamPlanProbe.rows.filter((x) => x.fills === 0)) {
      console.log(`      ⚠️ 空补金顺序的卡片：补金 ${r.gap} 金｜hiddenCut=${r.hiddenCut}`
        + `｜账面原文「${(r.factsText || '').trim()}」`);
    }
    const first = teamPlanProbe.rows[0];
    console.log(`  首条：${first.badgeText}（${first.parts.join(' / ')}）`
      + `｜缺位 ${first.missing} 个｜补金顺序 ${first.fills} 条`
      + `｜最佳证据 ${first.hasBest ? '✓' : '✗'}`);
    console.log(`        ${first.fillText[0]?.replace(/\\s+/g, ' ').trim().slice(0, 70) || '(空)'}`);
    if (!first.hasBest) failures += 1;
    // ---- 用户 2026-10-11 的抽卡方案第 2~6 条 ----------------------------------------
    //   ② 徽标标签必须叫「补金推荐分」、「性价比」必须改叫「强度得分」，
    //      且等式里**不许再用全角空格**（用户：「注意空格不要离得太远」）；
    //   ③ 补金顺序写「本体 / 本体+E1」，**不许再出现箭头 `→`**；
    //   ④ 界面**不显示抽数**、补金顺序里也不许再写「性价比」；
    //      ⚠️ 2026-10-12 起判据是「不许出现 `N 抽` / `抽数`」而不是单个「抽」字 ——
    //      用户第 2 条把第二类权重命名为**抽卡权重**，那个功能名必然含「抽」。
    //   ⑤ 条数上限 15。
    const labelOk = teamPlanProbe.rows.every((r) => /^补金推荐分 \+/.test(r.badgeText)
      && r.eqText.includes('强度得分') && !r.eqText.includes('　'));
    if (!labelOk) failures += 1;
    console.log(`  ${labelOk ? '✓' : '✗'} 标签改成「补金推荐分 / 强度得分」且等式里没有全角空格`
      + `（首条「${teamPlanProbe.rows[0]?.badgeText || ''}」/「${(teamPlanProbe.rows[0]?.eqText || '').slice(0, 60)}」）`);
    // ⚠️ 「不出现抽」这条判据在 2026-10-12 收窄成「不出现**抽数**」：用户第 2 条把
    //    第二类权重命名为**抽卡权重**（那是功能名，必然含「抽」字），而这条判据的本意是
    //    「界面不显示抽数」（用户 2026-10-11 第 5 条）。所以禁词是 `N 抽` / `抽数`，
    //    不是单独一个「抽」字 —— 只禁那个字会连功能名一起误杀。
    const noPulls = !teamPlanProbe.rows.some((r) => /抽数|\d\s*抽/.test(r.cardText));
    const stepOk = noPulls && teamPlanProbe.rows.every((r) => r.fillSteps.every((t, i) => {
      // ⚠️ 用户 2026-10-11 报的 bug：「遐蝶 本体+E2 2 金 这个描述有误，我已有遐蝶，
      //    应改为 E1-E2」——**已拥有**的角色只能写「Ea→Eb」，写「本体…」就是错的
      //    （那一笔根本不包含本体）。没拥有的角色/光锥才写「本体」或「本体+E1」。
      if (r.ownedChars.includes(r.fillNames[i])) return /^E\d→E\d$/.test(t);
      return /^本体(\+[ES]\d)?$/.test(t) || /^[ES]\d→[ES]\d$/.test(t);
    }));
    if (!stepOk) failures += 1;
    console.log(`  ${stepOk ? '✓' : '✗'} 补金顺序：**已拥有**的角色写「E1→E2」、没拥有才写「本体 / 本体+E1」`
      + `（用户 2026-10-11 报的「我已有遐蝶」），全文不出现抽数（${noPulls ? '✓' : '✗'}）`
      + `（首条 ${JSON.stringify(teamPlanProbe.rows[0]?.fillSteps || [])}）`);
    const capOk = teamPlanProbe.cards <= 15;
    if (!capOk) failures += 1;
    console.log(`  ${capOk ? '✓' : '✗'} 只列前 15 条补金建议（实测 ${teamPlanProbe.cards} 张）`);
    // ---- 用户 2026-10-11 第 7、8 条（界面） ----------------------------------------
    //   ⑦ 需要补多笔的卡片上要有「过渡：先补前 k 笔（N 金）→ …，再补 M 金到本方案」那一行；
    //   ⑧ 点「补金推荐分」徽标 → 打开详情窗口，里面有分数的来源（刻度表）与次选配队。
    const midRows = teamPlanProbe.rows.filter((r) => r.hasMid);
    const midOk = midRows.length > 0
      && midRows.every((r) => /过渡：先补前 \d+ 笔（\d+ 金）/.test(r.midText)
        && /再补 \d+ 金到本方案/.test(r.midText));
    if (!midOk) failures += 1;
    console.log(`  ${midOk ? '✓' : '✗'} ⑦ 需要补多笔的卡片带「过渡档位」一行（${midRows.length} 张）`
      + `（首条「${(midRows[0]?.midText || '').replace(/\\s+/g, ' ').slice(0, 56)}」）`);
    const tipSpot = await evaluate(`(() => {
      // ⚠️ 必须点**带「过渡档位」那一行**的那张卡，不能点第一张：
      //    过渡档位 / 次选配队这两段只在「这一队要补多笔」时才渲染，而排第一的队伍
      //    可能只差一笔（实测本轮第一张就是「补 2 金、1 条」，它没有过渡档位）。
      //    改前固定点第一张，于是判据实际上在赌「第一名恰好要多笔」——v4.6.81
      //    换了名次之后这条就红了。见 HANDOFF §6 的「测试别把顺序当契约」。
      const cards = [ ...document.querySelectorAll('#adviceTeamPlanBody .advice-plan-team') ];
      const card = cards.find((c) => c.querySelector('.advice-plan-team-mid'))
        || cards.find((c) => c.querySelectorAll('.advice-plan-team-fill .advice-fill-item').length >= 2)
        || cards[0];
      const wrap = card?.querySelector('.advice-value-wrap');
      if (!wrap) return null;
      wrap.scrollIntoView({ block: 'center' });
      const r = wrap.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    let scoreTip = null;
    if (!tipSpot) {
      failures += 1;
      console.log('  ✗ ⑧ 抽卡方案里找不到「补金推荐分」徽标');
    } else {
      await mouseClick(tipSpot.x, tipSpot.y);
      await sleep(1200);
      scoreTip = await evaluate(`(() => {
        const modal = document.querySelector('.advice-tip-modal');
        const card = modal?.querySelector('.advice-tip-card');
        if (!modal || modal.hidden || !card) return { open: false };
        const headers = [ ...card.querySelectorAll('.advice-value-tip-table th') ].map((n) => n.textContent);
        const blocks = [ ...card.querySelectorAll('.advice-plan-tip-block') ].map((n) => n.textContent);
        // ⚠️ 用户 2026-10-12 第 6 条：「性价比得分、差额接近分、压金度，三者是不是过于重叠了，
        //    我只想保留差额接近度的得分」—— 所以这张「分数来源」表**只有两行**
        //    （强度得分 / 差额接近度），中间那层「性价比得分」与「压金度」都不许再出现。
        const rowLabels = [ ...card.querySelectorAll('.advice-value-tip-table tbody tr') ]
          .map((tr) => (tr.children[0]?.textContent || '').trim());
        return {
          open: true,
          title: card.querySelector('.advice-value-tip-head')?.textContent || '',
          headers,
          rowLabels,
          text: card.textContent || '',
          blocks,
          alts: card.querySelectorAll('.advice-plan-tip-alt').length,
        };
      })()`);
      const tipScoreOk = Boolean(scoreTip?.open)
        && /^补金推荐分 \+\d/.test(scoreTip.title)
        // ⚠️ 表头写的是「按候选池现算」—— v4.6.81 起刻度取自全池，
        //    改文案时这条判据要一起改（改前是「按下发这批现算」）。
        && scoreTip.headers.includes('刻度（按候选池现算）')
        && scoreTip.blocks.some((b) => b.includes('过渡档位'))
        && scoreTip.blocks.some((b) => b.includes('次选配队'))
        && scoreTip.alts >= 1 && scoreTip.alts <= 3;
      if (!tipScoreOk) failures += 1;
      console.log(`  ${tipScoreOk ? '✓' : '✗'} ⑧ 点「补金推荐分」→ 详情窗口「${scoreTip?.title || ''}」`
        + `（表头 ${JSON.stringify(scoreTip?.headers || [])}，次选 ${scoreTip?.alts ?? 0} 支，`
        + `内容块 ${(scoreTip?.blocks || []).length} 段`
        + `${tipScoreOk ? '' : `：${(scoreTip?.blocks || []).map((b) => b.slice(0, 18)).join(' / ') || '（空）'}`}）`);
      // ⚠️ 用户 2026-10-12 第 6 条：分数来源**只有真实生效的那几个刻度**，
      //    且不许再出现「压金度 / 性价比得分」。2026-10-13 第 3 条（泛用性也进补金推荐）
      //    之后是**三行** —— v4.6.95/96 时这里钉的是两行。
      const scoreScaleOk = JSON.stringify(scoreTip?.rowLabels)
        === JSON.stringify(['强度得分', '差额接近度', '泛用性'])
        && !scoreTip.text.includes('压金度')
        && !scoreTip.text.includes('性价比得分');
      if (!scoreScaleOk) failures += 1;
      console.log(`  ${scoreScaleOk ? '✓' : '✗'} 分数来源表是「强度得分 / 差额接近度 / 泛用性」三行、`
        + `全文不出现「压金度 / 性价比得分」（实际 ${JSON.stringify(scoreTip?.rowLabels || [])}）`);
      await evaluate("document.querySelector('#adviceTipClose')?.click(); true");
      await sleep(300);
    }
  }
  const footOk = teamPlanProbe.foot;
  if (!footOk) failures += 1;
  console.log(`  ${footOk ? '✓' : '✗'} 脚注写清归一化上下限与补金顺序口径（那两个数随账号/数据变，必须写出来）`);
}

// ---- 用户 2026-10-11（详情页第 2 条）：逐档榜的详情页必须显示**全部**关卡 ------------
//
// 原话：「修复 E1/E2/E6 的性价比详情页仅显示一种关卡的 bug」。
// 根因：逐档榜（`frontierTiers`）为了压 600 KB 硬上限只带**最好的那一个关卡**的明细
// （`src/server/conclusion.js` 的 `slimFrontierUnit(unit, i, 1)`），而「全部」那一页
// 是满的 —— 于是切到 E0/E1/E2/E6 再点开详情，表里只剩一行。
// 修法：点开时按需取 `/api/archive/packs?char=`（与「该角色的全部配队」同一份缓存）
// 把整包的全部关卡补回来（`advice-view.js` 的 `enrichTierDetail()`）。
console.log('\n▶ 逐档榜的详情页必须显示全部关卡（用户 2026-10-11 报过「只显示一种关卡」）');
let tierTipRows = 0;
let tierTipUnit = '?';
const tierChipOk = await evaluate(`(() => {
  const chip = [ ...document.querySelectorAll('#adviceUnitFilter .advice-filter') ]
    .find((c) => /^E0 /.test(c.textContent));
  if (!chip) return false;
  chip.click();
  return true;
})()`);
await sleep(900);
if (!tierChipOk) {
  failures += 1;
  console.log('  ✗ 找不到 E0 那个筛选 chip（星魂档筛选器没渲染出来？）');
} else {
  // ⚠️ 先确保**没有别的窗口开着**：窗口开着时 `advice-view.js` 的 document 级 click 处理器会
  //    直接 return（「关闭只归窗口管」），于是这里点不出逐档榜那张表 —— 而窗口元素里**留着
  //    上一次的内容**（这里是抽卡方案那张 4 列的表），按行数等条件会「等到」一份陈旧数据。
  //    这正是这个小组原先那条「表体 > 1 行」判据一直在空跑的原因（它数的是别的窗口的行）。
  //    ⚠️ 关闭按钮的选择器是 **`#adviceTipClose`**（它的类名只有 `btn btn-ghost btn-sm`）：
  //    这里以前写的是 `.advice-tip-close` —— 一个都匹配不到，「关窗」其实是空操作。
  await evaluate("document.querySelector('#adviceTipClose')?.click(); true");
  for (let i = 0; i < 10; i += 1) {
    const stillOpen = await evaluate("(() => { const m = document.querySelector('.advice-tip-modal'); return Boolean(m) && !m.hidden; })()");
    if (!stillOpen) break;
    await sleep(200);
  }
  const target = await evaluate(`(() => {
    const w = document.querySelector('#adviceConclusionUnits .advice-value-wrap');
    if (!w) return null;
    w.scrollIntoView({ block: 'center' });
    // ⚠️ 这里用**合成 DOM click**而不是坐标点击：坐标点击要求「量完到点下去之间页面不动」，
    //    而切档之后还有异步渲染 / 滚动回弹，实测会点到别的地方。
    //    advice-view.js 的处理器挂在 document 上按 closest('.advice-value-wrap') 判定，
    //    合成事件同样能触发。（⚠️ 本段是模板字符串，注释里不能写反引号。）
    w.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { unit: w.closest('.advice-unit')?.querySelector('.advice-unit-name')?.textContent || '?' };
  })()`);
  if (!target) {
    failures += 1;
    console.log('  ✗ E0 档一行都没有');
  } else {
    tierTipUnit = target.unit;
    // 等两件事：① 窗口真的**开着且是总榜那一张**（标题以「角色得分」开头）；
    //     ⚠️ 用户 2026-10-13 第 2 条把这个指标从「性价比得分」改名「角色得分」；
    //     名称本身由上面的 `titleOk` 钉住，这里只用它认窗口。
    // ② 明细被 `enrichTierDetail()` **按需补齐**（那一步另发一次 packs 请求，实测 ~1s）——
    //    逐档榜的整包初始只带 1 个 env，补齐之后才有多行。
    //
    // ⚠️ v4.6.88 修的真 bug 就在这一步之后：补明细会把 `unit.envs` **整份换成面板那一路的
    //    数据**，而面板当时少发 `seasonMinCost` → 金数项退回全窗口最小值 →「跨版本发挥」
    //    算出 **> 1**（实测 39% 的行、最大 ×5.76，用户报的就是这个）。
    //    所以判据必须落在**补齐之后**那一列上，而且**按表头认表**（窗口里不止一张表）。
    //    判据：每一格都必须是 ×N，且 N ≤ 1（显示只到两位小数，给 1.005 容差）。
    let tierFactorTable = null;
    for (let i = 0; i < 30; i += 1) {
      tierFactorTable = await evaluate(`(() => {
        const modal = document.querySelector('.advice-tip-modal');
        const tables = [ ...(modal?.querySelectorAll('.advice-value-tip-table') || []) ];
        const heads = tables.map((t) => [ ...t.querySelectorAll('th') ].map((h) => h.textContent));
        const hit = tables.find((t) => [ ...t.querySelectorAll('th') ]
          .some((h) => (h.textContent || '').includes('跨版本发挥')));
        const title = modal?.querySelector('.advice-value-tip-head')?.textContent || '';
        if (!hit) return { open: Boolean(modal && !modal.hidden), title, heads, cells: [] };
        const col = [ ...hit.querySelectorAll('th') ]
          .findIndex((h) => (h.textContent || '').includes('跨版本发挥')) + 1;
        return {
          open: Boolean(modal && !modal.hidden),
          title,
          heads,
          col,
          cells: [ ...hit.querySelectorAll('tbody tr:not(.is-total)') ]
            .map((tr) => (tr.children[col - 1]?.textContent || '').trim()),
        };
      })()`);
      if (tierFactorTable?.open && tierFactorTable.cells?.length > 1) break;
      await sleep(400);
    }
    tierTipRows = (tierFactorTable?.cells || []).length;
    const tierFactors = (tierFactorTable?.cells || []).map((t) => Number(String(t).replace(/[^0-9.]/g, '')));
    const tierFactorOk = Boolean(tierFactorTable?.cells?.length > 1)
      && tierFactorTable.cells.every((t) => t.startsWith('×'))
      && tierFactors.every((n) => Number.isFinite(n) && n <= 1.005);
    if (!tierFactorOk) failures += 1;
    console.log(`  ${tierFactorOk ? '✓' : '✗'} 补齐明细后的「跨版本发挥」恒 ≤ 1：`
      + `${JSON.stringify(tierFactorTable?.cells || null)}`);
    if (!tierFactorOk) {
      console.log(`      ⚠️ 窗口「${tierFactorTable?.title || '?'}」的表头：`
        + `${JSON.stringify(tierFactorTable?.heads || null)}（第 ${tierFactorTable?.col} 列）`);
    }
    // 收尾：关掉窗口 + 切回「全部」，别把状态留给后面的统计与下一次运行。
    await evaluate("document.querySelector('#adviceTipClose')?.click(); true");
    await sleep(300);
    await evaluate(`(() => {
      const chip = [ ...document.querySelectorAll('#adviceUnitFilter .advice-filter') ]
        .find((c) => /^全部 /.test(c.textContent));
      chip?.click();
      return true;
    })()`);
    await sleep(400);
    const tierTipOk = tierTipRows > 1;
    if (!tierTipOk) failures += 1;
    console.log(`  ${tierTipOk ? '✓' : '✗'} E0 档第一行「${tierTipUnit}」的详情页表体 `
      + `${tierTipRows} 行（必须 > 1 —— 只有一行就是用户报的那个 bug）`);
  }
}

// ---- 切账号必须让抽卡方案**重算**（本机只有多账号时才验）------------------------
//
// 2026-10-12 修的真 bug：`selectAccount()` 当时只调 `renderView()`，而那个函数**不画**
// 抽卡页（抽卡页是 `selectTab('advice')` 调的 `show()` 画的），于是切账号后方案会静静停在
// 旧账号的数字上。
//
// 怎么验才**决定性**：切到「虚拟·全图鉴」那个账号 —— 它限定全 E6 / 专锥全 S5，所有队伍
// 差额都是 0，候选池按设计为 0 ⇒ 方案区必须**从卡片变成空态**。若方案没重算，卡片会留在
// 原地（那正是 bug 的症状）。找不到那个账号时退回「换账号后方案文本必须变」，仍取不到
// 差异就跳过并打印说明（不做无根据的失败）。
{
  const chips = await evaluate("[ ...document.querySelectorAll('.role-chip') ].map((b) => b.textContent.trim())");
  if (!chips || chips.length < 2) {
    console.log(`  – 切账号重算：跳过（本页只有 ${chips?.length ?? 0} 个角色 chip，`
      + `需要 ≥2 个账号；用 tools/make-virtual-accounts.mjs 起虚拟账号库再跑这条）`);
  } else {
    const planText = async () => evaluate(
      `(document.getElementById('adviceTeamPlanBody')?.textContent || '').replace(/\\s+/g, ' ').trim()`);
    const cardCount = async () => evaluate(
      "document.querySelectorAll('#adviceTeamPlanBody .advice-plan-team').length");
    const before = await planText();
    const beforeCards = await cardCount();
    const targetIdx = chips.findIndex((t) => t.includes('全图鉴'));
    const idx = targetIdx >= 0 ? targetIdx : 1;
    await evaluate(`[ ...document.querySelectorAll('.role-chip') ][${idx}]?.click(); true`);
    await sleep(7000);
    const after = await planText();
    const afterCards = await cardCount();
    const activeIdx = await evaluate(`[ ...document.querySelectorAll('.role-chip') ]
      .findIndex((b) => b.className.includes('active'))`);
    let ok;
    if (targetIdx >= 0) {
      ok = activeIdx === idx && afterCards === 0;
      if (!ok) failures += 1;
      console.log(`  ${ok ? '✓' : '✗'} 切到「${chips[idx]}」后方案重算成空态：`
        + `切前 ${beforeCards} 张卡 → 切后 ${afterCards} 张（激活 chip #${activeIdx + 1}）`);
    } else {
      ok = activeIdx === idx && after !== before;
      if (ok) console.log(`  ✓ 切账号后抽卡方案会重算（切到「${chips[idx]}」方案文本已变）`);
      else console.log('  – 切账号重算：跳过（本页没有「全图鉴」账号，且两个账号的方案文本相同，'
        + '取不到决定性差异）');
    }
    // 切回第一个账号，别把状态留给下一次运行。
    await evaluate("[ ...document.querySelectorAll('.role-chip') ][0]?.click(); true");
    await sleep(5000);
  }
}

console.log('');
for (const r of results) {
  console.log(`  ${String(r.width).padStart(4)}px  ${r.label.padEnd(30)} 副本框 top=${r.mode?.top}`);
}
await send('Emulation.clearDeviceMetricsOverride');
console.log(`\n控件位置稳定性 + 两处入口 + 两套权重 + 总榜行图标 / 详情大窗口 / 文案: `
  + `${failures === 0 ? '通过 ✓' : `${failures} 项不通过`}`);
ws.close();
// Force exit: the CDP socket can keep the loop alive.
process.exit(failures === 0 ? 0 : 1);
