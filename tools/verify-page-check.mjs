// Inspect the verification page over CDP: did gt4.js load, did the widget
// render, and is anything in the page logging errors?
//
// The Geetest widget rendering has never actually been verified end to end, so
// check it objectively instead of assuming.
//
// Usage: node tools/verify-page-check.mjs [cdpPort]
const PORT = Number(process.argv[2] || 9334);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => null);
if (!list) { console.error(`无法连接 CDP 端口 ${PORT}`); process.exit(1); }

const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1:8377/.test(t.url))
  || list.find((t) => t.type === 'page');
if (!page) { console.error('没有找到页面 target'); console.log(list.map((t) => `${t.type} ${t.url}`).join('\n')); process.exit(1); }
console.log('页面:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let id = 1;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = id++;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
  }
});

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return `[异常] ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`;
  return r.result.value;
};

await sleep(500);
console.log('\n=================== 页面状态 ===================');
for (const [label, expr] of [
  ['gt4.js 是否加载', 'String(typeof window.initGeetest4)'],
  ['status 文本', 'String((document.getElementById("status")||{}).textContent||"")'],
  ['holder 子节点数', 'document.getElementById("holder") ? document.getElementById("holder").children.length : -1'],
  ['geetest 相关节点数', 'document.querySelectorAll("[class*=geetest]").length'],
  ['页面内日志', 'String((document.getElementById("log")||{}).textContent||"").slice(-900)'],
  ['body 文本', 'String(document.body.innerText||"").slice(0,400)'],
]) {
  const v = await evaluate(expr);
  console.log(`\n--- ${label} ---`);
  console.log(typeof v === 'string' ? v : JSON.stringify(v));
}

// Try to nudge the widget into rendering and re-check.
console.log('\n=================== 尝试强制渲染 ===================');
await evaluate(`(function(){
  var done = [];
  try {
    if (typeof window.initGeetest4 === 'function') done.push('initGeetest4 可调用');
  } catch (e) { done.push('err:' + e.message); }
  return done.join(',');
})()`);
const after = await evaluate('document.querySelectorAll("[class*=geetest]").length');
console.log('强制后 geetest 节点数:', after);

ws.close();
console.log('\n完成。');
