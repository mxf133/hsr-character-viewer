// Screenshot the verification page over CDP, so we can see what the user sees.
// Usage: node tools/verify-shot.mjs [cdpPort] [outFile]
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 9334);
const OUT = process.argv[3] || 'C:\\mumudump\\verify-shot.png';

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === 'page' && /8377/.test(t.url)) || list.find((t) => t.type === 'page');
if (!page) { console.error('没找到页面'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));

let id = 1;
const pending = new Map();
const send = (m, p = {}) => new Promise((resolve, reject) => {
  const mid = id++;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method: m, params: p }));
});
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
  }
});

// Capture the whole viewport with the widget state.
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log(`截图已保存: ${OUT}`);

const st = await send('Runtime.evaluate', {
  expression: `(function(){
    var p = document.querySelector('.geetest_panel');
    var s = document.getElementById('status');
    return JSON.stringify({
      status: s ? s.textContent : '',
      panelDisplay: p ? getComputedStyle(p).display : '无',
      panelSize: p ? (p.offsetWidth + 'x' + p.offsetHeight) : '0x0'
    });
  })()`,
  returnByValue: true,
});
console.log('页面状态:', st.result.value);
ws.close();
