// 手工探针：**点击**总榜的性价比得分徽标 → 量「性价比详情**大窗口**」（v4.6.61）。
//
// 为什么需要它：
//   * 窗口里最重要的那一节（「该角色的全部配队」）是**异步**的（要另发一次
//     `/api/archive/packs`），必须等它真的填完才能量；
//   * 那一节最多列 8 条、每条带一支带图的队伍，而窗口是**固定高**
//     （`min(90vh, 1000px)`）—— 每次改排版都要确认两件事：卡片**四边仍在可见区内**、
//     正文**真的能滚**（v4.6.59 之前用户报的正是「无法滚动、会自动关掉」）。
//
// ⚠️ 与 v4.6.59 及更早版本的差别（改这个文件前先读）：
//   * 内容**不再贴在徽标旁边**：`.advice-value-tip` 没有 `.is-placed`、没有行内
//     `left/top`、在窗口正文里 `position` 是 `static`（旧写法是 `placeTip()` 现算
//     视口坐标，v4.6.61 已随大窗口一起删掉）。所以探针改成量
//     `.advice-tip-card`（卡片尺寸 / 是否完整可见）+ `.advice-tip-body`（正文能否滚）；
//   * 显隐判据是 `.advice-tip-modal` 的 **`hidden` 属性**（壳子懒建，第一次点开才建）；
//   * 内容节点在**关窗后被移回**徽标里，所以「窗口里的内容」一律从
//     `.advice-tip-body` 往下查，不要再用 `.advice-value-wrap.is-open .advice-value-tip`
//     这种写法去找（关掉之后它就不在窗口里了）。
//
// ⚠️ 本探针**只打印给人看，不做通过/失败判定**（断言在 `check-advice-layout.mjs`）——
//    下面那四条开合行为打 ✓/✗ 也只是给人扫一眼，不设退出码。
//
// 用法：node tools/_probe-packs-tip.mjs [--port 8360] [--cdp 9222] [--char 遐蝶]
//   `--char` 缺省的角色万一不在榜上（榜是按口径排的，会变），探针自动退回
//   「第一个带配队空槽的行」，并在输出里写明用的是哪一行。
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
// 缺省端口改成 8360：HANDOFF §5.1 里服务固定跑这个端口，而 8371 只是更早那几个
// 探针的旧缺省值（`_probe-icon-health.mjs` 还在用）。带 `--port=` 时不受影响。
const PORT = Number(arg('port', '8360'));
const CDP = Number(arg('cdp', '9222'));
const CHAR = arg('char', '遐蝶');
const OUT = resolve(arg('out', join(HERE, '..', '.snapref', 'packs-tip.png')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
for (const tab of list) {
  if (tab.type === 'page' && tab.url.startsWith(`http://127.0.0.1:${PORT}/`)) {
    await fetch(`http://127.0.0.1:${CDP}/json/close/${tab.id}`).catch(() => {});
  }
}
const page = await fetch(`http://127.0.0.1:${CDP}/json/new?${
  encodeURIComponent(`http://127.0.0.1:${PORT}/?view=advice`)}`, { method: 'PUT' })
  .then((r) => r.json());
await sleep(2500);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let nextId = 1;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (e) => {
  let m;
  try { m = JSON.parse(e.data); } catch { return; }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  }
  const slot = pending.get(m.id);
  if (!slot) return;
  pending.delete(m.id);
  if (m.error) slot.reject(new Error(m.error.message));
  else slot.resolve(m.result);
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = nextId++;
  const timer = setTimeout(() => { if (pending.delete(id)) rej(new Error(`${method} 超时`)); }, 40000);
  pending.set(id, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (x) => { clearTimeout(timer); rej(x); } });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
// ⚠️ 必须先开焦点模拟：本机 CDP 窗口是隐藏页，隐藏页里 Chrome 不取懒加载的图，
// `naturalWidth` 恒为 0（HANDOFF §6.1 第 12 条 / 套件开头那段注释）。
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
// 显式设视口：窗口尺寸是 `min(1180px, 96vw)` / `min(90vh, 1000px)`，跟视口走；
// 不设就退回无头窗口的真实尺寸（本机约 800px 宽），窄屏断点会生效（§6.1 第 15 条）。
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?view=advice` });
await sleep(5000);

// ⚠️ 这个角色的名字**必须**在反引号**外面**先 JSON.stringify 好再插进来。
// 而且别把「插值示例」写进注释放模板串里 —— 注释里的插值语法会让字符串提前结束，
// 报错指向完全无关的行（本轮在三个探针文件上连踩三次，每次都很难看出真因）。
const CHAR_JS = JSON.stringify(CHAR);
// 目标行：先按 `--char` 找，找不到就退回第一个带配队空槽的行（榜的口径会变，
// 「这个角色在第几名」不是探针该依赖的东西）。
const ROW_PICK = `(function () {
  const rows = [ ...document.querySelectorAll('#adviceConclusionUnits .advice-unit') ];
  const byName = rows.find(function (r) { return r.textContent.indexOf(${CHAR_JS}) >= 0; });
  const bySlot = rows.find(function (r) { return r.querySelector('.advice-packs-slot'); });
  const row = byName || bySlot || null;
  return row;
})()`;

/** 一「按」= mousePressed + mouseReleased。只发 mouseMoved 不会触发 click。 */
const mouseClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  });
};

/** 徽标中心（视口坐标）。⚠️ 必须先 scrollIntoView：总榜在限高可滚容器里，
 *  不滚进来 `getBoundingClientRect()` 会给视口外的坐标，鼠标移过去等于什么都没点。 */
const badgeCenter = () => evaluate(`(() => {
  const row = ${ROW_PICK};
  if (!row) return null;
  const badge = row.querySelector('.advice-value-wrap');
  if (!badge) return null;
  const r = badge.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
    name: row.querySelector('.advice-unit-name')?.textContent || '?',
    score: row.querySelector('.advice-unit-value')?.textContent || '',
    inView: r.top >= 0 && r.bottom <= document.documentElement.clientHeight };
})()`);

const scrollRowIntoView = () => evaluate(`(() => {
  const row = ${ROW_PICK};
  if (!row) return false;
  row.scrollIntoView({ block: 'center' });
  return true;
})()`);

const isOpen = () => evaluate(
  "(() => { const m = document.querySelector('.advice-tip-modal'); return Boolean(m) && !m.hidden; })()");

/** 内容节点是不是已经回到徽标里（关窗的**第二半**判据，见 advice-tip-window.js 的 restore）。 */
const contentBackInWrap = () => evaluate(`(() => {
  const row = ${ROW_PICK};
  const wrap = row && row.querySelector('.advice-value-wrap');
  return Boolean(wrap && wrap.querySelector('.advice-value-tip'));
})()`);

// 先滚进视口，再把坐标取一次（滚动要等它稳定，否则点到的还是旧位置）。
if (!await scrollRowIntoView()) {
  console.log('没找到任何总榜行（页面还在算？）：', JSON.stringify(await evaluate(
    "({ rows: document.querySelectorAll('#adviceConclusionUnits .advice-unit').length,"
    + " text: (document.getElementById('adviceConclusionUnits')?.innerText || '').slice(0, 80) })")));
  ws.close();
  process.exit(1);
}
await sleep(400);
const at = await badgeCenter();
console.log(`目标行「${at.name}」${at.score}，徽标在 (${at.x}, ${at.y})`
  + `${at.inView ? '' : '（⚠️ 仍在视口外）'}`);
await mouseClick(at.x, at.y);

// 等异步那一节填完（服务端逐版本加权实测 ~1s）+ 窗口出现。
let probe = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(500);
  probe = await evaluate(`(() => {
    const modal = document.querySelector('.advice-tip-modal');
    if (!modal || modal.hidden) return null;
    const card = modal.querySelector('.advice-tip-card');
    const body = modal.querySelector('.advice-tip-body');
    const tip = body && body.querySelector('.advice-value-tip');
    if (!card || !body || !tip) return null;
    const list = tip.querySelector('.advice-packs-slot .advice-packs-list');
    if (!list || list.querySelector('.advice-packs-loading')) return null;
    const items = [ ...list.querySelectorAll('.advice-packs-item') ];
    const notes = [ ...tip.querySelectorAll('.advice-value-tip-note') ].map((n) => n.textContent);
    const avatars = [ ...tip.querySelectorAll('.advice-team-avatar') ];
    const cones = [ ...tip.querySelectorAll('.advice-team-cone') ];
    const sub = tip.querySelector('.advice-value-tip-sub');
    const kids = sub ? [ ...sub.children ] : [];
    const idxOf = (sel) => kids.findIndex((k) => k.matches(sel));
    const cr = card.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const table = tip.querySelector('.advice-value-tip-table');
    const trs = [ ...(table ? table.querySelectorAll('tbody tr') : []) ];
    const cellsOf = (tr) => [ ...tr.children ].map((td) => td.textContent);
    const totalRow = trs.find((tr) => tr.classList.contains('is-total'));
    return {
      title: document.getElementById('adviceTipTitle')?.textContent || '',
      head: tip.querySelector('.advice-value-tip-head')?.textContent || '',
      card: { x: Math.round(cr.left), y: Math.round(cr.top), w: Math.round(cr.width), h: Math.round(cr.height) },
      viewport: { w: vw, h: vh },
      inside: cr.left >= 0 && cr.right <= vw && cr.top >= 0 && cr.bottom <= vh,
      body: {
        scrollH: body.scrollHeight, clientH: body.clientHeight,
        overflowY: getComputedStyle(body).overflowY,
        scrollable: body.scrollHeight > body.clientHeight + 1,
      },
      tipH: Math.round(tip.getBoundingClientRect().height),
      tipPosition: getComputedStyle(tip).position,
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      docOverflowX: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth,
      caption: tip.querySelector('.advice-packs-caption')?.textContent || '',
      count: tip.querySelector('.advice-packs-count')?.textContent || '',
      more: tip.querySelector('.advice-packs-more')?.textContent || '',
      // 前 8 条的性价比得分（界面上应当**降序**，见 advice-view.js 的 fillPackList）
      scores: items.map((it) => (it.querySelector('.advice-packs-score')?.textContent || '')
        .replace('性价比得分 +', '')),
      teamCards: tip.querySelectorAll('.advice-team-card').length,
      // 用户 2026-10-11 第 5 条：「角色的图标都放进表格内」——
      //   · 表上方那一整块（标题 + 每关卡的说明行）必须**一个都不剩**；
      //   · 每个表体行的**第一格**里都要有占位槽，槽里都要有卡片；
      //   · 关卡之间的线现在就是**表格自己的行线**（每格 td 的下边框）。
      teamCaptionLeft: tip.querySelectorAll('.advice-team-caption').length,
      teamEnvLeft: tip.querySelectorAll('.advice-team-env').length,
      firstCells: trs.filter((tr) => !tr.classList.contains('is-total')).map((tr) => {
        const cell = tr.children[0];
        return {
          slots: cell.querySelectorAll('.advice-plan-team-slot').length,
          cards: cell.querySelectorAll('.advice-team-card').length,
          stage: cell.querySelector('.tip-label-stage')?.textContent || '',
          env: cell.querySelector('.tip-label-env')?.textContent || '',
          season: cell.querySelector('.tip-label-season')?.textContent || '',
          borderBottom: getComputedStyle(cell).borderBottomWidth,
          rowH: Math.round(tr.getBoundingClientRect().height),
        };
      }),
      firstColSeasons: trs.filter((tr) => !tr.classList.contains('is-total'))
        .map((tr) => tr.children[0]?.querySelector('.tip-label-season')?.textContent || ''),
      avatars: avatars.map((a) => a.naturalWidth),
      brokenAvatars: avatars.filter((a) => a.classList.contains('is-missing')).length,
      cones: cones.map((a) => a.naturalWidth),
      subOrder: { table: idxOf('.advice-value-tip-table'),
        packs: idxOf('.advice-packs-slot'), notes: idxOf('.advice-value-tip-notes') },
      headers: [ ...(table ? table.querySelectorAll('thead th') : []) ].map((th) => th.textContent),
      tableRows: trs.filter((tr) => !tr.classList.contains('is-total')).map(cellsOf),
      totalRow: totalRow ? cellsOf(totalRow) : null,
      notes: notes,
    };
  })()`);
  if (probe) break;
}

if (!probe) {
  console.log('❌ 点了徽标但窗口没开 / 配队那一节一直没填完。当前状态：',
    JSON.stringify(await evaluate(
      "({ modal: Boolean(document.querySelector('.advice-tip-modal')),"
      + " hidden: document.querySelector('.advice-tip-modal')?.hidden ?? null,"
      + " open: document.querySelectorAll('.advice-value-wrap.is-open').length,"
      + " bodyText: (document.querySelector('.advice-tip-body')?.innerText || '').slice(0, 120) })")));
  if (errors.length) for (const e of errors) console.log(' ', String(e).split('\n').slice(0, 2).join(' | '));
  ws.close();
  process.exit(1);
}

console.log('\n=== 窗口 ===');
console.log(`标题 / 头行：${JSON.stringify(probe.title)} / ${JSON.stringify(probe.head)}`);
console.log(`卡片 ${probe.card.w}×${probe.card.h} @ (${probe.card.x},${probe.card.y})，`
  + `视口 ${probe.viewport.w}×${probe.viewport.h} → ${probe.inside ? '✓ 四边都在可见区内' : '⚠️ 有部分在可见区外'}`);
console.log(`正文：内容高 ${probe.body.scrollH} / 可视高 ${probe.body.clientH}`
  + ` / overflow-y=${probe.body.overflowY} → `
  + `${probe.body.scrollable ? '✓ 内容超出、可滚' : '（内容没超出，不需要滚）'}`);
console.log(`整块内容高 ${probe.tipH}px，position=${probe.tipPosition}（窗口里应当被中和成 static）`);
console.log(`窗口开着时 html overflow=${probe.htmlOverflow}（应当是 hidden：锁背后页面滚动）`
  + ` / 页面横向滚动：${probe.docOverflowX ? '⚠️ 有' : '无'}`);

console.log('\n=== 「该角色的全部配队」 ===');
console.log(`标题：${JSON.stringify(probe.caption)} / ${JSON.stringify(probe.count)}`
  + `${probe.more ? ` / ${JSON.stringify(probe.more)}` : '（全部列出，没有「另有 N 个」）'}`);
console.log(`列出 ${probe.scores.length} 条，性价比得分：${probe.scores.join(' , ')}`);
const nums = probe.scores.map((s) => Number(s));
const desc = nums.every((n, i) => i === 0 || nums[i - 1] >= n);
console.log(`降序：${desc ? '✓' : '✗（界面应当按性价比得分从高到低，见 fillPackList）'}`);
console.log(`队伍图标在表格第一格里（用户 2026-10-11 第 5 条）：表上方旧块残留`
  + ` 标题 ${probe.teamCaptionLeft} 个 / 说明行 ${probe.teamEnvLeft} 个（都应为 0）`
  + ` / 全窗口卡片 ${probe.teamCards} 张`
  + ` / 头像 naturalWidth=${JSON.stringify(probe.avatars)}（碎图 ${probe.brokenAvatars} 张）`
  + ` / 光锥 ${JSON.stringify(probe.cones)}`);
// 逐行打出来，肉眼核一遍：第一格里是不是同一个关卡、有没有哪一格缺卡片/缺队伍。
probe.firstCells.forEach((c, i) => {
  console.log(`  ${i + 1}. ${c.env} · ${c.stage} · ${c.season}`
    + `｜槽 ${c.slots} / 卡片 ${c.cards}｜行高 ${c.rowH}px（行线 ${c.borderBottom}）`
    + `${c.slots >= 1 && c.cards >= 1 ? '' : '  ← ⚠️ 这一格没有队伍图标'}`);
});
console.log(`第一列的版本小字（逐行取该行第一格）：${JSON.stringify(probe.firstColSeasons)}`);
console.log(`sub 里各块的次序下标：${JSON.stringify(probe.subOrder)}`
  + `（要求 表格 < 全部配队 < 脚注，且没有 team 那一项）`);
console.log(`表头：${JSON.stringify(probe.headers)}（第一列应当是「关卡」）`);
console.log(`逐副本 ${probe.tableRows.length} 行${probe.totalRow ? `，合计 ${JSON.stringify(probe.totalRow)}` : '（单副本，无合计行）'}`);

console.log(`\n=== 脚注 ${probe.notes.length} 条（原文）===`);
probe.notes.forEach((n, i) => console.log(`  ${i + 1}. [${n.length} 字] ${n}`));

// ---- 截图：整窗 + 放大各一张 -------------------------------------------------
// ⚠️ `clip` 用的是**文档坐标**，而 `getBoundingClientRect()` 给的是**视口坐标** ——
// 上面那句 scrollIntoView 会连**窗口**一起滚，`window.scrollY` 往往已经不是 0，
// 不加回偏移就会截到页面上别的地方（HANDOFF §6.1 第 19 条，实测偏 1194px）。
const shot = await send('Page.captureScreenshot', { format: 'png' });
await writeFile(OUT, Buffer.from(shot.data, 'base64'));
console.log('\n截图（整窗，1600×1000 视口）:', OUT);
const box = await evaluate(`(() => {
  const card = document.querySelector('.advice-tip-modal .advice-tip-card');
  if (!card) return null;
  const r = card.getBoundingClientRect();
  return { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY),
    w: Math.round(r.width), h: Math.round(r.height),
    scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) };
})()`);
if (box) {
  const clip = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8),
      width: box.w + 16, height: box.h + 16, scale: 1.4 },
  });
  const out2 = OUT.replace(/\.png$/, '-zoom.png');
  await writeFile(out2, Buffer.from(clip.data, 'base64'));
  console.log(`放大截图: ${out2}（窗口已滚 ${box.scrollX},${box.scrollY}，clip 用的文档坐标）`);
}

// ---- 四条开合行为（只打印 ✓/✗，不判失败） ------------------------------------
// ① 滚动总榜容器 → 窗口不关（v4.6.59「不自动隐藏」：以前有个 scroll 监听会全收掉）
// ② 点**卡片外、外壳内**的背景 → 关
// ③ ESC（挂 document）→ 关
// ④ 点详情**内容**不关窗（④a）+ 关掉之后**再点徽标能重开**（④b）——「再点一次徽标关掉」
//    在窗口开着时几何上测不到（徽标在卡片背后），细节见下面那一段注释
const report = [];
const scroller = await evaluate(`(() => {
  const s = document.getElementById('adviceConclusionUnits');
  if (!s) return null;
  const before = s.scrollTop;
  s.scrollTop = before + 140;
  return { before: before, after: s.scrollTop };
})()`);
await sleep(400);
report.push(['滚动总榜容器不关窗', await isOpen(),
  scroller ? `容器 ${scroller.before} → ${scroller.after}` : '⚠️ 找不到总榜容器']);

/** 背景落点：卡片外、外壳内（对 `event.target === 外壳节点` 那条判据） */
const bgSpot = await evaluate(`(() => {
  const modal = document.querySelector('.advice-tip-modal');
  const card = modal && modal.querySelector('.advice-tip-card');
  if (!modal || !card) return null;
  const c = card.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const cands = [[8, 8], [vw - 8, 8], [8, vh - 8], [vw - 8, vh - 8],
    [Math.round(vw / 2), Math.max(2, Math.round(c.top) - 8)],
    [Math.max(2, Math.round(c.left) - 8), Math.round(vh / 2)]];
  for (const spot of cands) {
    const x = spot[0];
    const y = spot[1];
    if (x >= c.left - 2 && x <= c.right + 2 && y >= c.top - 2 && y <= c.bottom + 2) continue;
    const node = document.elementFromPoint(x, y);
    if (!node) continue;
    if (node === modal) return { x: x, y: y, tag: node.tagName, cls: String(node.className || '') };
  }
  return null;
})()`);
if (bgSpot) {
  await mouseClick(bgSpot.x, bgSpot.y);
  await sleep(400);
  report.push(['点背景会关', !await isOpen(),
    `落点 ${bgSpot.x},${bgSpot.y} = ${bgSpot.tag}.${bgSpot.cls}`]);
} else {
  report.push(['点背景会关', false, '⚠️ 没找到「卡片外、外壳内」的落点']);
}
const afterBg = { open: await isOpen(), contentBack: await contentBackInWrap() };
if (afterBg.open) {
  await evaluate("document.getElementById('adviceTipClose')?.click(); true");
  await sleep(400);
}

/** 重新点开（每一步都独立：上一条没过也不能把下一条带偏）。 */
const reopen = async () => {
  await scrollRowIntoView();
  await sleep(350);
  const c = await badgeCenter();
  await mouseClick(c.x, c.y);
  await sleep(900);
  return c;
};

await reopen();
const escUsesCdp = await send('Input.dispatchKeyEvent', {
  type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
}).then(() => true).catch(() => false);
await send('Input.dispatchKeyEvent', {
  type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
}).catch(() => {});
await sleep(400);
report.push(['ESC 会关', !await isOpen(), `CDP 键事件${escUsesCdp ? '已发' : '发送失败'}`]);
const afterEsc = await contentBackInWrap();
if (await isOpen()) {
  await evaluate("document.getElementById('adviceTipClose')?.click(); true");
  await sleep(400);
}

const beforeToggle = await reopen();
// ④ 「再点一次徽标」在窗口**开着**时是**测不到**的：窗口是满屏遮罩 + 居中卡片，
//    徽标一定在卡片背后，鼠标落不到它身上 —— 落点只可能是「卡片里的内容」或
//    「外壳背景」。所以这一条换成两个**真能测**的判据：
//      ④a 落点落在卡片里 → 点详情内容**不关窗**（这正是用户要的「不自动隐藏」）；
//          （若落点正好是外壳背景，那就是 ②「点背景会关」，不算这里失败。）
//      ④b 关掉之后**再点一次徽标能重新打开** —— 开关的「开」那一半。
//    改前这里印一个 ✗「再点一次徽标会关」，读者会以为功能坏了；实际是几何上够不到。
const toggleHit = await evaluate(`(() => {
  const n = document.elementFromPoint(${beforeToggle.x}, ${beforeToggle.y});
  if (!n) return null;
  return { tag: n.tagName, cls: String(n.className || '').slice(0, 48),
    isShell: n.classList.contains('advice-tip-modal'),
    inCard: Boolean(n.closest && n.closest('.advice-tip-card')) };
})()`);
await mouseClick(beforeToggle.x, beforeToggle.y);
await sleep(500);
const closedByToggleClick = !await isOpen();
const landedInCard = Boolean(toggleHit?.inCard);
if (landedInCard) {
  report.push(['点详情内容不关窗', !closedByToggleClick,
    `落点 ${beforeToggle.x},${beforeToggle.y} = ${toggleHit.tag}.${toggleHit.cls}`]);
}
if (await isOpen()) {
  await evaluate("document.getElementById('adviceTipClose')?.click(); true");
  await sleep(400);
}
// ④b 真正意义上的「再点一次徽标」：**关掉之后**点它，必须重新打开。
await reopen();
report.push(['关掉后再点徽标能重开', await isOpen(), '开关的「开」那一半']);
// 收尾：先把这个窗口关掉再量「内容是否回到徽标里」—— 开着的时候内容正躺在窗口正文里，
// 直接量会让下面那条参考显示 ✗，看起来像「回位坏了」。
if (await isOpen()) {
  await evaluate("document.getElementById('adviceTipClose')?.click(); true");
  await sleep(400);
}
const finalBack = await contentBackInWrap();

console.log('\n=== 开合行为（只打印，不判失败）===');
for (const [name, ok, extra] of report) console.log(`  ${ok ? '✓' : '✗'} ${name} —— ${extra}`);
console.log(`  （参考）ESC 后内容节点回到徽标里：${afterEsc ? '✓' : '✗'}`
  + ` / 点背景后回到徽标里：${afterBg.contentBack ? '✓' : '✗'}`
  + ` / 全部测完：${finalBack ? '✓' : '✗'}`);
console.log(`  （参考）④ 那一击落在**${landedInCard ? '卡片内容' : '卡片外（外壳背景）'}**上`
  + `${landedInCard ? '' : ' —— 徽标此刻在卡片背后、鼠标够不到它，这是模态的必然结果，不是功能坏了'}`);

if (errors.length) {
  console.log('=== 控制台异常 ===');
  for (const e of errors) console.log(' ', String(e).split('\n').slice(0, 2).join(' | '));
}
ws.close();
process.exit(0);
