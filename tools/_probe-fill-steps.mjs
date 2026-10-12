// 一次性探针：把「抽卡方案」每张卡的（补金顺序名字 / 目标状态 / 已有角色）打出来，
// 用来定位 `check-advice-layout.mjs` 里「已拥有的角色必须写 E1→E2」那条判据的失败。
//
//   node tools/_probe-fill-steps.mjs [--url=http://127.0.0.1:8371/] [--port=9222]
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const URL_TO_OPEN = arg('url', 'http://127.0.0.1:8371/?view=advice');
const PORT = Number(arg('port', '9222'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const origin = new URL(URL_TO_OPEN).origin;
const page = list.find((t) => t.type === 'page' && t.url.startsWith(origin));
if (!page) {
  console.log(`找不到 ${origin} 的标签页，先跑 tools/check-advice-layout.mjs 或手动打开它`);
  process.exit(1);
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
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'evaluate 失败');
  return res.result.value;
};
await sleep(500);
const out = await evaluate(`(() => {
  const cards = [ ...document.querySelectorAll('#adviceTeamPlanBody .advice-plan-team') ];
  return cards.map((card, i) => {
    const fills = [ ...card.querySelectorAll('.advice-plan-team-fill .advice-fill-item') ];
    return {
      i: i + 1,
      badge: card.querySelector('.advice-unit-value')?.textContent || '',
      owned: [ ...card.querySelectorAll('.advice-plan-team-slot.is-owned .advice-plan-team-char') ]
        .map((n) => n.textContent),
      pairs: fills.map((li) => [
        li.querySelector('.advice-fill-name')?.textContent || '',
        li.querySelector('.advice-fill-step')?.textContent || '',
      ]),
      hasChou: (card.textContent || '').includes('抽'),
      chouIn: (() => {
        const hits = [];
        for (const node of card.querySelectorAll('*')) {
          if (node.children.length) continue;
          const t = node.textContent || '';
          if (t.includes('抽')) hits.push((node.className || node.tagName) + ': ' + t.trim().slice(0, 60));
        }
        return hits.slice(0, 4);
      })(),
    };
  });
})()`);
for (const c of out) {
  console.log(`#${c.i} ${c.badge.trim()}｜已有 ${c.owned.join('/')}${c.hasChou ? `  ⚠️ 卡片里有「抽」：${c.chouIn.join(' ｜ ')}` : ''}`);
  for (const [name, step] of c.pairs) console.log(`     ${name}｜${step}`);
}
ws.close();
