// 手工探针：量「数据状态」那一块 —— 角色快照 / 战斗记录 / 黑塔网数据三份缓存的记录
// **整合在一起、贴在「抽卡推荐」标题下方**（用户 2026-10-11 第 3 条）。
//
// 为什么需要它：断言在 `check-advice-layout.mjs` 里（那一套要连 9222、一次跑两三分钟），
// 而改这一块排版时想知道的是几件很具体的事：三格是不是同一行、宽窄屏怎么折、
// 每格印出来的字是什么、旧的三处有没有清干净。这个探针只打印、不判定（退出码恒 0），
// 并落一张截图当视觉证据。
//
// 用法（同 `_probe-packs-tip.mjs`：服务与 CDP 浏览器都要先起来）：
//   node bin/serve.mjs --port 8360 --host 127.0.0.1
//   Start-Process "$env:USERPROFILE\Desktop\Chrome CDP.lnk"     # 桌面那个，不要自己起
//   node tools/_probe-data-status.mjs --port 8360
//
// ⚠️ 注入进 `Runtime.evaluate` 的代码里**不能出现反引号**（HANDOFF §6.1 第 16 条：
//    整个片段套在模板字符串里，注释里写一个反引号就会把字符串提前截断）。下面一律用
//    普通引号或字符串拼接。
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
const OUT = resolve(arg('out', join(HERE, '..', '.snapref', 'data-status.png')));
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
  const timer = setTimeout(() => { if (pending.delete(id)) rej(new Error(`${method} 超时`)); }, 30000);
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
// 隐藏页里 Chrome 不取懒加载的图（§6.1 第 12 条）；这一块没有图，但页面别处有。
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Emulation.setDeviceMetricsOverride',
  { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?view=advice` });
await sleep(4000);

/**
 * 量一次。注入代码里不用反引号、不用字符串插值；返回的都是能直接 JSON.stringify 的值。
 *
 * `expectedOneRow` 由调用方判断：宽屏应当三格同 top，窄屏应当三格各自一行。
 */
const measure = () => evaluate(`(() => {
  const block = document.getElementById('adviceDataStatus');
  if (!block) return { block: false };
  const grid = block.querySelector('.data-status-grid');
  const cells = [ ...(grid ? grid.children : []) ];
  const rect = (n) => {
    const r = n.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right),
      w: Math.round(r.width), h: Math.round(r.height) };
  };
  const topOf = (id) => {
    const n = document.getElementById(id);
    return n ? Math.round(n.getBoundingClientRect().top) : -1;
  };
  const cellInfo = (n) => ({
    id: n.id || '(无 id)',
    cls: n.className,
    lead: ((n.querySelector('.freshness-lead') || {}).textContent || '').trim(),
    details: ((n.querySelector('.freshness-details') || {}).textContent || '').trim(),
    reason: ((n.querySelector('.freshness-reason') || {}).textContent || '').trim(),
    gap: ((n.querySelector('.freshness-contract-gap') || {}).textContent || '').trim(),
    hint: ((n.querySelector('.freshness-hint') || {}).textContent || '').trim(),
    rect: rect(n),
  });
  return {
    block: true,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    blockText: block.textContent.trim(),
    headText: ((block.querySelector('.data-status-head') || {}).textContent || '').trim(),
    blockTop: Math.round(block.getBoundingClientRect().top),
    blockRect: rect(block),
    recordTop: topOf('adviceRecord'),
    conclusionTop: topOf('adviceConclusion'),
    kids: cells.map(cellInfo),
    // 旧的三处有没有清干净
    oldNode: Boolean(document.getElementById('adviceDataUpdated')),
    staleInRecord: document.querySelectorAll('#adviceRecord .data-freshness').length,
    recordMeta: ((document.getElementById('recordMeta') || {}).textContent || '').trim(),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
})()`);

// 等黑塔网那一格出字（要等 /api/archive；快照 / 战斗记录两格在本机没登录时本来就该是空态）
let wide = null;
for (let i = 0; i < 24; i += 1) {
  wide = await measure();
  if (wide?.kids?.[2]?.lead) break;
  await sleep(500);
}

const dump = (title, r) => {
  console.log(`\n=== ${title}（视口 ${r.viewport.w}×${r.viewport.h}）===`);
  console.log(`块 top ${r.blockTop} / 高 ${r.blockRect.h}，宽 ${r.blockRect.w}`
    + ` ｜ ① 战斗记录 top ${r.recordTop} ｜ ② 综合结论 top ${r.conclusionTop}`
    + ` → ${r.blockTop < r.recordTop && r.blockTop < r.conclusionTop ? '✓ 在两者之前（标题下方）' : '✗ 位置不对'}`);
  console.log(`标题行：${JSON.stringify(r.headText)}`);
  r.kids.forEach((c, i) => {
    console.log(`  格${i + 1} ${c.id}  [${c.cls}]  ${c.rect.w}×${c.rect.h} @ (${c.rect.left},${c.rect.top})`);
    console.log(`      名字：${JSON.stringify(c.lead)}`);
    console.log(`      时间：${JSON.stringify(c.details)}`);
    if (c.reason) console.log(`      原因：${JSON.stringify(c.reason)}`);
    if (c.hint) console.log(`      指路：${JSON.stringify(c.hint)}`);
    if (c.gap) console.log(`      接口缺口：${JSON.stringify(c.gap)}`);
  });
  const tops = r.kids.map((c) => c.rect.top);
  console.log(`  三格 top：${tops.join(' / ')} →`
    + `${new Set(tops).size === 1 ? ' 同一行' : ` 分 ${new Set(tops).size} 行`}`);
  const widths = r.kids.map((c) => c.rect.w);
  console.log(`  三格宽：${widths.join(' / ')}`
    + `（等宽判据：最大最小相差 ≤ 2px → ${Math.max(...widths) - Math.min(...widths) <= 2 ? '等宽 ✓' : '不等宽'}）`);
  console.log(`  三格越出视口：${r.kids.some((c) => c.rect.left < 0 || c.rect.right > r.viewport.w + 1) ? '有 ⚠️' : '无 ✓'}`);
  console.log(`  旧位置：adviceDataUpdated ${r.oldNode ? '仍在 ⚠️' : '已删 ✓'}`
    + ` / ① 节里的 .data-freshness ${r.staleInRecord} 个（应为 0）`
    + ` / #recordMeta ${JSON.stringify(r.recordMeta)}`);
  console.log(`  页面横向滚动：${r.overflowX ? '有 ⚠️' : '无 ✓'}`);
};

dump('宽屏', wide);

// ---- 窄屏：三格应当竖排成单列（CSS 断点是 900px）--------------------------------
await send('Emulation.setDeviceMetricsOverride',
  { width: 760, height: 1200, deviceScaleFactor: 1, mobile: false });
await sleep(1200);
dump('窄屏', await measure());

// ---- 截图：整窗一张（回到宽屏，视觉证据）----------------------------------------
await send('Emulation.setDeviceMetricsOverride',
  { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await sleep(800);
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?view=advice` });
await sleep(4000);
const full = await send('Page.captureScreenshot', { format: 'png' });
await writeFile(OUT, Buffer.from(full.data, 'base64'));
console.log('\n截图（整窗，1600×1000 视口）:', OUT);

// ⚠️ `clip` 用的是**文档坐标**，`getBoundingClientRect()` 是**视口坐标**：不加回
//    window.scrollX/Y 就会截到页面上别的地方（HANDOFF §6.1 第 19 条，实测偏 1194px）。
const box = await evaluate(`(() => {
  const block = document.getElementById('adviceDataStatus');
  if (!block) return null;
  const r = block.getBoundingClientRect();
  return { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY),
    w: Math.round(r.width), h: Math.round(r.height) };
})()`);
if (box) {
  const clip = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x - 8, y: box.y - 8, width: box.w + 16, height: box.h + 16, scale: 1 },
  });
  const near = OUT.replace(/\.png$/, '-block.png');
  await writeFile(near, Buffer.from(clip.data, 'base64'));
  console.log('截图（只截「数据状态」这一块）:', near);
}

if (errors.length) {
  console.log('\n⚠️ 页面里有异常：');
  for (const e of errors) console.log(' ', String(e).split('\n').slice(0, 2).join(' | '));
}
await fetch(`http://127.0.0.1:${CDP}/json/close/${page.id}`).catch(() => {});
process.exit(0);
