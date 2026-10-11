// 手工探针（`_` 前缀，不进测试套件）：「隐金设置」的**勾选 → 总榜重算**这一段在真浏览器里
// 到底发生了什么。
//
// 为什么单独一支：`check-advice-layout.mjs` 里那条判据只说「榜面指纹必须变」，它红了
// 分不清三种原因（① 勾选没触发重算；② 触发了但请求失败；③ 重算了但结果恰好一样）。
// 这里把**每一次轮询**都打印出来，并顺带把「总榜第一行 / 状态行 / 结论区文案」一起量，
// 一眼能看出卡在哪一步。
//
//   node tools/_probe-yinjin-toggle.mjs                 # 默认 8371 端口、gift 这一项
//   node tools/_probe-yinjin-toggle.mjs --port 8360     # 指向别的端口
//   node tools/_probe-yinjin-toggle.mjs --id exchange   # 换一个开关试
//
// ⚠️ 与 `check-advice-layout.mjs` 一样：同一时间只让一个脚本连 9222（handoff §6.1 第 10 条）。
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const PORT = Number(arg('port', '8371'));
const CDP = Number(arg('cdp', '9222'));
const TARGET = arg('id', 'gift');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
const origin = `http://127.0.0.1:${PORT}/`;
let page = list.find((t) => t.type === 'page' && t.url.startsWith(origin));
if (!page) {
  page = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`${origin}?view=advice`)}`,
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
  const timer = setTimeout(() => {
    if (pending.delete(id)) reject(new Error(`${method} 超时`));
  }, 20000);
  const wrap = (fn) => (v) => { clearTimeout(timer); fn(v); };
  pending.set(id, { resolve: wrap(resolve), reject: wrap(reject) });
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
const mouseClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  });
};

await send('Page.enable');
await send('Runtime.enable');
// 隐藏页里不取懒加载的图（本探针不看图，但焦点模拟顺带让 visibilityState 变 visible）
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Emulation.setDeviceMetricsOverride',
  { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

/** 榜面状态：指纹 + 第一行文字 + 结论区文案（出错时那里会写「读取失败：…」）。 */
const snap = () => evaluate(`(() => {
  const box = document.getElementById('adviceConclusionUnits');
  const t = box ? box.textContent : '';
  let h = 0;
  for (let i = 0; i < t.length; i += 1) h = (h * 31 + t.charCodeAt(i)) % 2147483647;
  return {
    hash: t.length + ':' + h,
    rows: box ? box.querySelectorAll('.advice-unit').length : 0,
    first: box?.querySelector('.advice-unit')?.textContent?.trim().slice(0, 70) || '',
    meta: document.getElementById('adviceHiddenCostsMeta')?.textContent || '',
    conclusionMeta: document.getElementById('adviceConclusionMeta')?.textContent || '',
    stored: localStorage.getItem('hsr.advice.hiddenCosts') || '(无存档)',
  };
})()`);

// 干净加载：先清掉存档，保证「五项全勾」这个用户指定的初始状态
await send('Page.navigate', { url: `${origin}?view=advice` });
await sleep(1500);
await evaluate("(() => { localStorage.removeItem('hsr.advice.hiddenCosts'); return true; })()");
await send('Page.reload', { ignoreCache: false });
const t0 = Date.now();
let ready = 0;
for (let i = 0; i < 40; i += 1) {
  const rows = await evaluate("document.querySelectorAll('#adviceConclusionUnits .advice-unit').length");
  if (rows > 0) { ready = rows; break; }
  await sleep(500);
}
console.log(`总榜渲染出来用了 ${((Date.now() - t0) / 1000).toFixed(1)}s（${ready} 行）`);
const before = await snap();
console.log('勾选前：', JSON.stringify(before, null, 1));

// 打开窗口 → 点掉目标那一项
const spot = await evaluate(`(() => {
  const btn = document.getElementById('adviceHiddenCostsOpen');
  if (!btn) return null;
  btn.scrollIntoView({ block: 'center' });
  const r = btn.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
if (!spot) { console.log('✗ 找不到「隐金设置」按钮'); process.exit(1); }
await mouseClick(spot.x, spot.y);
await sleep(700);
const opened = await evaluate("(() => { const m = document.querySelector('.advice-gold-modal'); return Boolean(m) && !m.hidden; })()");
console.log(`窗口打开：${opened ? '✓' : '✗'}`);
const clicked = await evaluate(`(() => {
  const box = document.querySelector('.advice-gold-check[data-hidden-cost="${TARGET}"]');
  if (!box) return null;
  const was = box.checked;
  box.click();
  return { was, now: box.checked };
})()`);
console.log(`点掉 ${TARGET}：`, JSON.stringify(clicked));

// 逐轮打印，直到榜面指纹变化（最多 20 秒）
let changed = false;
for (let i = 1; i <= 20; i += 1) {
  await sleep(1000);
  const now = await snap();
  const hit = now.hash !== before.hash;
  console.log(`  t=${i}s hash=${now.hash}${hit ? ' ← 变了 ✓' : ''} 行=${now.rows}`
    + ` 首行=${JSON.stringify(now.first.slice(0, 40))} 状态行=${JSON.stringify(now.meta)}`);
  if (hit) { changed = true; break; }
}
const after = await snap();
console.log(`勾选后：榜面指纹 ${before.hash} → ${after.hash} ${changed ? '✓ 重算了' : '✗ 没变'}`);
if (!changed) {
  console.log('  ← 没变时重点看：状态行是否已更新（说明 JS 走到了）、');
  console.log('     conclusionMeta 是不是「读取失败：…」或「正在计算…」、');
  console.log('     以及服务端那份是不是改动前起的（/conclusion 回 payload=4）。');
}
// 收尾：恢复默认（把那一项勾回去），别把测试用的存档留在用户浏览器里
await evaluate(`(() => {
  const box = document.querySelector('.advice-gold-check[data-hidden-cost="${TARGET}"]');
  if (box && !box.checked) box.click();
  document.getElementById('adviceGoldReset')?.click();
  return true;
})()`);
await sleep(1200);
console.log('收尾后存档：', await evaluate("localStorage.getItem('hsr.advice.hiddenCosts') || '(无存档)'"));
ws.close();
process.exit(0);
