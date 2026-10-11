// 一次性脚本：把浏览器里 8360 origin 的 `hsr.*` localStorage 搬到另一个 origin，
// 让在新端口上跑的 CDP 套件有同样的登录态 / 账号选择（否则会报「没有可点的角色 chip」、
// 「总榜第一条 null」这类**环境**失败，与代码无关）。
//
//   node tools/_probe-seed-localstorage.mjs --from=http://127.0.0.1:8360/ --to=http://127.0.0.1:8390/
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const FROM = arg('from', 'http://127.0.0.1:8360/');
const TO = arg('to', 'http://127.0.0.1:8390/');
const PORT = Number(arg('port', '9222'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const page = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(FROM)}`,
  { method: 'PUT' }).then((r) => r.json());
await sleep(2500);

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
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'evaluate 失败');
  return res.result.value;
};
const goto = async (url, wait = 4000) => {
  await send('Page.navigate', { url });
  await sleep(wait);
};

await goto(FROM, 6000);
const snapshot = await evaluate(`(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (k.startsWith('hsr.')) out[k] = localStorage.getItem(k);
  }
  return out;
})()`);
const keys = Object.keys(snapshot || {});
console.log(`从 ${FROM} 读到 ${keys.length} 个 hsr.* 键：${keys.join(', ') || '（一个都没有）'}`);
if (!keys.length) {
  console.log('⚠️ 源 origin 没有可搬的状态 —— 说明那台的登录态也不在 localStorage 里，换个思路。');
}

await goto(TO, 5000);
const written = await evaluate(`(() => {
  const data = ${JSON.stringify(snapshot || {})};
  let n = 0;
  for (const [k, v] of Object.entries(data)) { localStorage.setItem(k, v); n += 1; }
  return n;
})()`);
console.log(`往 ${TO} 写入 ${written} 个键`);

// ⚠️ 关键：**把 tab 留着并预热**。CDP 套件开头的「副本权重」那一节跑得很早
// （`Page.navigate` 之后几乎立刻就读 `#adviceConclusionUnits .advice-unit`），
// 而抽卡推荐页第一次渲染要等服务端聚合 + 前端画表。若套件此时**新建**一个 tab，
// 它读到的就是 null —— 实测 pristine HEAD 在同一 origin 上也是完全相同的 4 项失败，
// 所以那是**环境/时序**问题，不是代码问题。这里先把它渲染出来并停在页面上。
const warm = arg('warm', 'true') !== 'false';
if (warm) {
  await goto(`${TO}${TO.includes('?') ? '&' : '?'}view=advice`, 12000);
  for (let i = 0; i < 30; i += 1) {
    const ready = await evaluate(`(() => ({
      unit: Boolean(document.querySelector('#adviceConclusionUnits .advice-unit')),
      weight: document.querySelectorAll('#adviceFrontierWeightRow input.advice-weight').length,
      plan: Boolean(document.querySelector('#adviceTeamPlanBody .advice-plan-team')),
    }))()`);
    if (ready.unit && ready.weight && ready.plan) {
      console.log(`预热完成：总榜 ✓ / 权重输入框 ${ready.weight} 个 ✓ / 队伍方案 ✓（tab 留着不动）`);
      break;
    }
    await sleep(1000);
    if (i === 29) console.log(`⚠️ 预热 30 秒仍未就绪：${JSON.stringify(ready)}`);
  }
}
console.log('现在可以跑：node tools/check-advice-layout.mjs --url=' + TO);
ws.close();

