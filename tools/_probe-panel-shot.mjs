// 手工探针：打开角色面板浮层（两处入口各一次），截图 + 记录控制台异常。
//
// 为什么要它：需求 2/3 是「浮层的排版」与「角色信息页点角色也要弹同一个浮层」，
// 这两件事只有真的把界面打开才看得出来（CDP 给的是像素与异常，不是感觉）。
//
// 用法：node tools/_probe-panel-shot.mjs [--port 8360] [--cdp 9222] [--entry records|advice]
//       [--clicked=0]                     不点角色（只想看页面某一块时）
//       [--scroll="#advicePlanWeights"]   截图前把某个元素滚到视口里（看排版用）
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
const ENTRY = arg('entry', 'records');
/** 可选：截图前把某个元素滚到视口中间（看某一块排版时用，例如两行权重）。 */
const SCROLL = arg('scroll', '');
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
for (const tab of list) {
  if (tab.type === 'page' && (tab.url.startsWith(BASE) || tab.url.startsWith('chrome-error://'))) {
    await fetch(`http://127.0.0.1:${CDP}/json/close/${tab.id}`).catch(() => {});
  }
}
const page = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(BASE)}`,
  { method: 'PUT' }).then((r) => r.json());
await sleep(2000);
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
  pending.set(id, { resolve, reject });
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
await send('Emulation.setDeviceMetricsOverride',
  { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: BASE });
await sleep(5000);

if (ENTRY === 'advice') {
  await evaluate(`document.getElementById('tabAdvice')?.click()`);
  await sleep(4500);
}
for (let i = 0; i < 24; i += 1) {
  const ready = ENTRY === 'advice'
    ? await evaluate(`Boolean(document.querySelector('#recordModes .record-chip.is-clickable'))`)
    : await evaluate(`Boolean(document.querySelector('.char-card'))`);
  if (ready) break;
  await sleep(500);
}

const clicked = arg('clicked', '1') === '1' ? await evaluate(ENTRY === 'advice'
  ? `(() => { const n = document.querySelector('#recordModes .record-chip.is-clickable'); if (!n) return null; n.click(); return n.textContent.trim(); })()`
  : `(() => { const n = document.querySelector('.char-card'); if (!n) return null; n.click(); return n.textContent.trim(); })()`) : '(跳过点击)';
await sleep(2500);

const state = await evaluate(`(() => {
  const modal = document.getElementById('charPanelModal');
  const card = modal && modal.querySelector('.char-panel-card');
  const body = document.getElementById('charPanelBody');
  const row = body && body.querySelector('.char-art-row');
  const rect = (n) => { const r = n && n.getBoundingClientRect(); return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null; };
  return {
    modalHidden: modal?.hidden ?? null,
    card: rect(card),
    bodyScrollH: body?.scrollHeight ?? null,
    artRow: rect(row),
    figures: [ ...(body?.querySelectorAll('.char-art') || []) ].map((f) => ({
      cls: f.className, cap: f.querySelector('figcaption')?.textContent || '',
      box: rect(f), img: rect(f.querySelector('img')),
      natural: (() => { const i = f.querySelector('img'); return i ? [i.naturalWidth, i.naturalHeight] : null; })(),
    })),
    hero: rect(body?.querySelector('.char-hero')),
    heroText: rect(body?.querySelector('.char-hero-text')),
    style: (() => {
      const row = body?.querySelector('.char-art-row');
      if (!row) return null;
      const cs = getComputedStyle(row);
      return {
        display: cs.display,
        cols: cs.gridTemplateColumns,
        rowCls: row.className,
        narrow: window.matchMedia('(max-width: 760px)').matches,
        viewport: [window.innerWidth, window.innerHeight],
      };
    })(),
    heroName: body?.querySelector('.char-hero-name')?.textContent || '',
    blocks: [ ...(body?.querySelectorAll('.detail-block h4') || []) ].map((h) => h.textContent),
    skillRows: (() => {
      const hs = [ ...(body?.querySelectorAll('.detail-block h4') || []) ];
      const skill = hs.find((h) => h.textContent === '技能');
      if (!skill) return 0;
      let n = 0;
      for (let s = skill.nextElementSibling; s && s.tagName !== 'H4'; s = s.nextElementSibling) n += 1;
      return n;
    })(),
  };
})()`);

console.log(`入口=${ENTRY} 点击=${JSON.stringify(clicked)}`);
console.log(JSON.stringify(state, null, 2));
if (errors.length) {
  console.log('=== 控制台异常 ===');
  for (const e of errors) console.log(' ', String(e).split('\n').slice(0, 3).join(' | '));
}
if (SCROLL) {
  const scrolled = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(SCROLL)});
    if (!node) return null;
    node.scrollIntoView({ block: 'center' });
    return Math.round(node.getBoundingClientRect().top);
  })()`);
  console.log(`滚动到 ${SCROLL}：top=${scrolled}`);
  await sleep(600);
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
const out = resolve(join(HERE, '..', '.snapref', `panel-${ENTRY}.png`));
await writeFile(out, Buffer.from(shot.data, 'base64'));
console.log('截图:', out);
ws.close();
process.exit(0);
