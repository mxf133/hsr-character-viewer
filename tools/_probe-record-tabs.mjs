// 一次性探针：确认战斗记录四个副本按钮上**不再出现「新鲜」**（用户 2026-10-10 要求）。
//
// 为什么需要它：`check-advice-layout.mjs` 只盯抽卡推荐页的控件位置/浮层，**不看**
// 四个副本按钮里的状态字；而这一节的渲染要「本机有一份战斗记录缓存 + 登录态」才会
// 出现，`herta-test.mjs` 只能做源码级护栏（断言不再有 `新鲜` 字面量）。这个探针
// 用真浏览器把 DOM 里那四个按钮的文字打出来，是「改对了」的直接证据。
//
// 用法（同一条命令里起服务 + 浏览器）：
//   node bin/serve.mjs --port 8371 &
//   chrome --headless=new --remote-debugging-port=9222 --user-data-dir=<tmp> &
//   node tools/_probe-record-tabs.mjs --port 8371 --cdp 9222
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const PORT = Number(arg('port', '8371'));
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
await sleep(3500);

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

// 等这一节渲染出来（渲染要等 /records，且要有本地缓存）
let ready = false;
for (let i = 0; i < 30; i += 1) {
  ready = await evaluate("Boolean(document.querySelector('#recordTabs .record-tab'))");
  if (ready) break;
  await sleep(1000);
}
const report = await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('#recordTabs .record-tab')];
  return {
    ready: tabs.length > 0,
    tabCount: tabs.length,
    tabs: tabs.map((n) => ({
      mode: n.dataset.mode,
      text: n.textContent,
      freshness: n.querySelector('.record-tab-freshness')?.textContent ?? null,
    })),
    hasFreshWord: tabs.some((n) => n.textContent.includes('新鲜')),
    freshnessNodes: document.querySelectorAll('#recordTabs .record-tab-freshness').length,
    meta: document.getElementById('recordMeta')?.textContent || '',
  };
})()`);
console.log(JSON.stringify(report, null, 2));
console.log(report.ready
  ? (report.hasFreshWord ? '❌ 仍出现「新鲜」' : '✅ 四个副本按钮上没有「新鲜」')
  : '⚠️ 本机这份数据里没有战斗记录缓存，这一节没渲染（无法从 DOM 验证）');

// ---- 反向验证：异常状态（partial / failed / stale）**仍要**挂字 -------------------
// 直接调渲染函数，塞一份合成的 records + freshness 进去。`fresh` 那条是重点：
// 它必须也**不挂**任何节点。
const synthetic = await evaluate(`(async () => {
  const mod = await import('/scripts/battle-record.js');
  const fresh = { sections: [{ key: 'moc', status: 'fresh' }, { key: 'pf', status: 'partial' },
    { key: 'as', status: 'failed' }, { key: 'aa', status: 'stale' }] };
  const records = { summary: [], modes: { moc: {}, pf: {}, as: {}, aa: {} } };
  try { mod.renderRecordSection(document.getElementById('adviceRecord'), records, { freshness: fresh }); }
  catch { /* modeBlock 对空数据可能抛错，但按钮已经画完，不影响这次的判定 */ }
  return [...document.querySelectorAll('#recordTabs .record-tab')].map((n) => ({
    mode: n.dataset.mode,
    freshness: n.querySelector('.record-tab-freshness')?.textContent ?? null,
  }));
})()`);
const byMode = Object.fromEntries(synthetic.map((t) => [t.mode, t.freshness]));
const expectNoFresh = byMode.moc === null;
const expectAbnormal = byMode.pf === '部分' && byMode.as === '失败' && byMode.aa === '旧数据';
console.log('合成状态下的按钮字：', JSON.stringify(byMode));
console.log((expectNoFresh ? '✅' : '❌') + ' fresh 不挂任何字');
console.log((expectAbnormal ? '✅' : '❌') + ' partial/failed/stale 分别挂「部分 / 失败 / 旧数据」');
await fetch(`http://127.0.0.1:${CDP}/json/close/${page.id}`).catch(() => {});
process.exit(0);
