// 探针：读**正在运行的那个页面**（CDP）里的真实状态 —— 活跃账号、抽卡权重存档、
// 以及抽卡方案第一张卡的渲染文案。
//
//   node tools/_probe-live-page.mjs [--url=http://127.0.0.1:8372/?view=advice]
//
// 只读，不导航、不刷新（避免破坏用户手上的页面状态）。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const URL_TO_OPEN = arg('url', 'http://127.0.0.1:8372/?view=advice');
const PORT = Number(arg('port', '9222'));
const origin = new URL(URL_TO_OPEN).origin;

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === 'page' && t.url.startsWith(origin));
if (!page) {
  console.error(`没有找到 ${origin} 的标签页：`, list.filter((t) => t.type === 'page').map((t) => t.url));
  process.exit(1);
}
console.log('target:', page.url);

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
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'evaluate failed');
  return res.result.value;
};
await send('Runtime.enable');

const dump = await evaluate(`(() => {
  const ls = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    ls[k] = String(localStorage.getItem(k)).slice(0, 400);
  }
  const cards = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0
    && /补金推荐分/.test(el.textContent || ''));
  const cardTexts = cards.slice(0, 3).map((el) => (el.closest('li, article, div') || el).innerText.slice(0, 1200));
  const planBlock = document.querySelector('[class*="team-plan"], [id*="teamPlan"], [class*="plan"]');
  return {
    href: location.href,
    title: document.title,
    ls,
    cardCount: cards.length,
    cardTexts,
    planBlockText: planBlock ? planBlock.innerText.slice(0, 3000) : null,
  };
})()`);
console.log(JSON.stringify(dump, null, 2));
ws.close();
