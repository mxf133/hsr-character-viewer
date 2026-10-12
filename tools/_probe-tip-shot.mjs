// 手工探针：**点开**性价比得分徽标 → 把那个居中大窗口的内容（贡献值来源表 + 配队卡片 +
// 脚注）整份打出来，并截两张图。
//
// 为什么要它：「列出贡献值来源」与「文字更简略」都是**排版问题** —— 表宽会不会顶出窗口、
// 7 列表会不会挤成两行、脚注是不是真的短了，只有真的把界面打开截一张才看得见。
// 断言版在 `tools/check-advice-layout.mjs`（它只管红/绿，不给肉眼看的图）；
// ⚠️ 2026-10-10（v4.6.61）起徽标点开的是**大窗口**、不再是贴徽标的小浮层，
//    所以这里发的是完整的一「按」而不是 `mouseMoved`，内容也从窗口正文里找。
//    `tools/_probe-packs-tip.mjs` 是同一件事的另一半（它量尺寸 + 开合行为），
//    这个探针负责**打全结构**（表头 / 逐行 / 合计 / 脚注 / 配队卡片）。
//
// 用法：node tools/_probe-tip-shot.mjs [--port 8360] [--cdp 9222] [--row 0] [--out .snapref/tip.png]
//   前置：服务在 --port 上跑着，且 --cdp 端口有调试浏览器（见 handoff §5 / §5.1）。
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const PORT = Number(arg('port', '8360'));
const CDP = Number(arg('cdp', '9222'));
const ROW = Number(arg('row', '0'));
const BASE = `http://127.0.0.1:${PORT}/?view=advice`;
const OUT = resolve(arg('out', join(HERE, '..', '.snapref', 'tip.png')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
for (const tab of list) {
  if (tab.type === 'page' && (tab.url.startsWith(`http://127.0.0.1:${PORT}/`)
    || tab.url.startsWith('chrome-error://'))) {
    await fetch(`http://127.0.0.1:${CDP}/json/close/${tab.id}`).catch(() => {});
  }
}
const page = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(BASE)}`,
  { method: 'PUT' }).then((r) => r.json());
await sleep(2500);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let nextId = 1;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails?.exception?.description
      || msg.params.exceptionDetails?.text || 'exception');
  }
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.error) slot.reject(new Error(msg.error.message));
  else slot.resolve(msg.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} 超时`)); }, 20000);
  pending.set(id, {
    resolve: (v) => { clearTimeout(timer); resolve(v); },
    reject: (e) => { clearTimeout(timer); reject(e); },
  });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || 'evaluate failed');
  }
  return res.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
// 隐藏页里 Chrome 不取懒加载的图（见 check-advice-layout.mjs 开头那段注释）
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Emulation.setDeviceMetricsOverride',
  { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: BASE });
await sleep(4000);

// 等总榜出来（最多 30 秒），并挑一行**有配队空槽**的（名次会随口径变，按结构找）
let ready = false;
for (let i = 0; i < 60 && !ready; i += 1) {
  ready = await evaluate(`document.querySelectorAll('#adviceConclusionUnits .advice-unit').length > 0`);
  if (!ready) await sleep(500);
}
const picked = await evaluate(`(() => {
  const wraps = [ ...document.querySelectorAll('#adviceConclusionUnits .advice-value-wrap') ];
  const rows = wraps.map((w, i) => {
    const unit = w.closest('.advice-unit');
    return { w, i, envs: unit ? unit.querySelectorAll('.advice-unit-env').length : 0 };
  });
  // 排序：先「有配队空槽 + 多副本」（浮层里有来源表的多行 + 合计行），其余按原顺序。
  const rank = (r) => (r.envs > 1 ? 0 : 1) * 10 + (r.w.querySelector('.advice-plan-team-slot') ? 0 : 1);
  const list = rows.slice().sort((a, b) => rank(a) - rank(b) || a.i - b.i);
  const hit = list[${ROW}] || list[0];
  if (!hit) return null;
  hit.w.scrollIntoView({ block: 'center' });
  const unit = hit.w.closest('.advice-unit');
  return {
    idx: hit.i,
    envs: hit.envs,
    name: unit?.querySelector('.advice-unit-name')?.textContent || '?',
    badge: unit?.querySelector('.advice-unit-value')?.textContent || '',
  };
})()`);
if (!picked) {
  console.log('✗ 总榜里没有可点开的性价比得分徽标（页面没算完？）');
  process.exit(1);
}
await sleep(800);
const spot = await evaluate(`(() => {
  const w = document.querySelectorAll('#adviceConclusionUnits .advice-value-wrap')[${picked.idx}];
  const r = w.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
// ⚠️ 只发 `mouseMoved` 不会触发 click（v4.6.59 起浮层是点击开的，v4.6.61 起点开的是大窗口）：
//    必须 mousePressed + mouseReleased 凑成一「按」。见 handoff §6.1 第 9 条。
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y, buttons: 0 });
await send('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', buttons: 1, clickCount: 1,
});
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', buttons: 0, clickCount: 1,
});
await sleep(1800);

const tip = await evaluate(`(() => {
  // 内容节点此刻在**大窗口**的正文里（关闭时才会被移回徽标），所以按窗口找。
  const tip = document.querySelector('.advice-tip-modal .advice-value-tip')
    || document.querySelectorAll('#adviceConclusionUnits .advice-value-tip')[${picked.idx}];
  if (!tip) return null;
  const r = tip.getBoundingClientRect();
  const table = tip.querySelector('.advice-value-tip-table');
  const cells = (tr) => [ ...tr.children ].map((td) => td.textContent);
  const trs = [ ...(table?.querySelectorAll('tbody tr') || []) ];
  return {
    box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    scrollW: tip.scrollWidth,
    clientW: tip.clientWidth,
    tableW: table?.scrollWidth ?? null,
    // ⚠️ v4.6.61 起内容在**固定尺寸的大窗口**里自己滚，所以「内容整块是否在视口内」不再是
    // 有意义的判据（它可能比窗口高）。要看的是**窗口卡片**四边是否都在可见区内 ——
    // 以及正文是不是真的能滚。
    card: (() => {
      const c = document.querySelector('.advice-tip-card')?.getBoundingClientRect();
      return c ? { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) } : null;
    })(),
    cardInsideViewport: (() => {
      const c = document.querySelector('.advice-tip-card')?.getBoundingClientRect();
      return c ? (c.left >= 0 && c.right <= document.documentElement.clientWidth
        && c.top >= 0 && c.bottom <= document.documentElement.clientHeight) : null;
    })(),
    bodyScrollable: (() => {
      const b = document.querySelector('.advice-tip-body');
      return b ? b.scrollHeight > b.clientHeight + 1 : null;
    })(),
    head: tip.querySelector('.advice-value-tip-head')?.textContent || '',
    eq: tip.querySelector('.advice-value-tip-eq')?.textContent || '',
    headers: [ ...(table?.querySelectorAll('thead th') || []) ].map((th) => th.textContent),
    rows: trs.filter((tr) => !tr.classList.contains('is-total')).map(cells),
    total: (trs.find((tr) => tr.classList.contains('is-total')) || null) ? cells(trs.find((tr) => tr.classList.contains('is-total'))) : null,
    notes: [ ...tip.querySelectorAll('.advice-value-tip-note') ].map((n) => n.textContent),
    cards: [ ...tip.querySelectorAll('.advice-team-card') ].map((c) => c.textContent),
  };
})()`);
console.log(`点开「${picked.name}」${picked.badge}`);
console.log(JSON.stringify(tip, null, 2));
if (errors.length) {
  console.log('=== 控制台异常 ===');
  for (const e of errors) console.log(' ', String(e).split('\n').slice(0, 3).join(' | '));
}

// 视口截图（看它在整行里的位置）+ 贴边裁一张放大图（看表宽与折行）
const full = await send('Page.captureScreenshot', { format: 'png' });
await writeFile(OUT, Buffer.from(full.data, 'base64'));
console.log('截图:', OUT);
if (tip?.box) {
  const pad = 12;
  // ⚠️ `Page.captureScreenshot` 的 `clip` 是**页面坐标**（文档坐标），而这里量到的是
  // **视口坐标** —— 不加滚动偏移就会裁到页面别处（实测裁出一张纯黑图）。
  // 裁的是**窗口卡片**（`tip.card`）：内容节点可能比窗口高，裁它只会得到半张图。
  const scroll = await evaluate('({ x: window.scrollX, y: window.scrollY })');
  const box = tip.card || tip.box;
  const clipShot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: {
      x: Math.max(0, box.x + scroll.x - pad),
      y: Math.max(0, box.y + scroll.y - pad),
      width: Math.min(1440, box.w + pad * 2),
      height: Math.min(1020, box.h + pad * 2),
      scale: 1.4,
    },
  });
  const out2 = OUT.replace(/\.png$/, '-zoom.png');
  await writeFile(out2, Buffer.from(clipShot.data, 'base64'));
  console.log('放大截图:', out2);
}
ws.close();
process.exit(0);
