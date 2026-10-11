// 手工探针：**干净加载**一次，单独验「两套权重相互独立」（用户 2026-10 的要求）。
//
// 为什么需要它（2026-10-10 实测）：`check-advice-layout.mjs` 里那一组紧跟在
// 「三个视口 × 五个副本」的循环之后，循环最后一步刚 reload 过页面，而 `/conclusion`
// 是异步的 —— 于是那次量到的第一条是 `null`，三条断言全红，看起来像「两套权重串了」。
// 这套探针把同一段逻辑放进一次干净加载里（先等总榜渲染出来再量），用来区分
// 「口径坏了」与「测量的时序问题」。实测结论：**是时序**（总榜 910→1843 而方案恒为
// 1797；再反过来 1797→2160 而总榜不动，两份 localStorage 分开存）。
// 断言本身仍在 `check-advice-layout.mjs` 里，这里只管「给人看 + 定位」。
//
// 用法：node tools/_probe-weights.mjs [--port 8360] [--cdp 9222]
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const PORT = Number(arg('port', '8360'));
const CDP = Number(arg('cdp', '9222'));
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
ws.addEventListener('message', (e) => {
  let m;
  try { m = JSON.parse(e.data); } catch { return; }
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
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?view=advice` });

// 等总榜真的渲染出来（判据：第一行带性价比徽标），并把**等了多久**打出来 ——
// 这个数字决定了 `check-advice-layout.mjs` 里那段有界等待该给多宽。
let rows = 0;
let waited = 0;
for (let i = 0; i < 120; i += 1) {
  await sleep(500);
  waited += 0.5;
  rows = await evaluate("document.querySelectorAll('#adviceConclusionUnits .advice-unit').length");
  if (rows > 0) break;
}
console.log(`等总榜渲染：${waited}s（行数 ${rows}）`);
const read = () => evaluate(`(() => {
  const pick = (sel) => document.querySelector(sel)?.querySelector('.advice-unit-value')?.textContent || null;
  return {
    rows: document.querySelectorAll('#adviceConclusionUnits .advice-unit').length,
    frontier: pick('#adviceConclusionUnits .advice-unit'),
    plan: pick('#adviceBudgetAnswer .advice-budget-item'),
    planRows: document.querySelectorAll('#adviceBudgetAnswer .advice-budget-item').length,
    stored: {
      frontier: localStorage.getItem('hsr.advice.weights.frontier'),
      plan: localStorage.getItem('hsr.advice.weights.plan'),
    },
    frontierInputs: [ ...document.querySelectorAll('#adviceFrontierWeightRow input.advice-weight') ].map((i) => i.value),
    planInputs: [ ...document.querySelectorAll('#advicePlanWeightRow input.advice-weight') ].map((i) => i.value),
    windowScroll: window.scrollY,
    docScroll: document.scrollingElement.scrollTop,
  };
})()`);
const base = await read();
console.log('干净加载后：', JSON.stringify(base, null, 2));

// 只改总榜权重（混沌回忆 1 → 20），看总榜动没动、方案动没动
await evaluate(`(() => {
  const inputs = [ ...document.querySelectorAll('#adviceFrontierWeightRow input.advice-weight') ];
  const values = [1, 1, 1, 20, 1];
  inputs.forEach((input, i) => {
    input.value = String(values[i]);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return inputs.length;
})()`);
await sleep(5000);
const afterFrontier = await read();
console.log('只改总榜权重后：总榜', afterFrontier.frontier, '（原', base.frontier, '）/ 方案',
  afterFrontier.plan, '（原', base.plan, '）');
console.log('存档：', JSON.stringify(afterFrontier.stored));

// 只改方案权重（虚构叙事 1 → 20）
await evaluate(`(() => {
  const inputs = [ ...document.querySelectorAll('#advicePlanWeightRow input.advice-weight') ];
  const values = [1, 1, 1, 1, 20];
  inputs.forEach((input, i) => {
    input.value = String(values[i]);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return inputs.length;
})()`);
await sleep(5000);
const afterPlan = await read();
console.log('再只改方案权重后：方案', afterPlan.plan, '（原', afterFrontier.plan, '）/ 总榜',
  afterPlan.frontier, '（应仍为', afterFrontier.frontier, '）');
console.log('存档：', JSON.stringify(afterPlan.stored));

// 收尾：恢复默认，别把测试用的权值留在用户的浏览器存档里
await evaluate(`(() => {
  document.getElementById('adviceFrontierWeightsReset')?.click();
  document.getElementById('advicePlanWeightsReset')?.click();
  return true;
})()`);
await sleep(1500);
const final = await read();
console.log('恢复默认后：', JSON.stringify(final.stored), '总榜', final.frontier);
await fetch(`http://127.0.0.1:${CDP}/json/close/${page.id}`).catch(() => {});
ws.close();
process.exit(0);
