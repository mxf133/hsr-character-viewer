// 一次性探针：截「战斗记录」那一节的图，作为「新鲜已去掉」的视觉证据。
// 用法同 _probe-record-tabs.mjs。
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const PORT = Number(arg('port', '8371'));
const CDP = Number(arg('cdp', '9222'));
const OUT = arg('out', 'tools/_shot-record-tabs.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { writeFileSync } = await import('node:fs');

const list = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
for (const tab of list) {
  if (tab.type === 'page' && tab.url.startsWith(`http://127.0.0.1:${PORT}/`)) {
    await fetch(`http://127.0.0.1:${CDP}/json/close/${tab.id}`).catch(() => {});
  }
}
const page = await fetch(`http://127.0.0.1:${CDP}/json/new?${
  encodeURIComponent(`http://127.0.0.1:${PORT}/?view=advice`)}`, { method: 'PUT' })
  .then((r) => r.json());
await sleep(4000);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  const s = pending.get(m.id); if (!s) return; pending.delete(m.id);
  if (m.error) s.reject(new Error(m.error.message)); else s.resolve(m.result);
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = nextId++;
  const t = setTimeout(() => { if (pending.delete(id)) rej(new Error(`${method} 超时`)); }, 30000);
  pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (x) => { clearTimeout(t); rej(x); } });
  ws.send(JSON.stringify({ id, method, params }));
});
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
for (let i = 0; i < 30; i += 1) {
  const ok = await send('Runtime.evaluate', {
    expression: "Boolean(document.querySelector('#recordTabs .record-tab'))", returnByValue: true });
  if (ok.result.value) break;
  await sleep(1000);
}
// 滚到战斗记录那一节
await send('Runtime.evaluate', { expression:
  "document.getElementById('adviceRecord')?.scrollIntoView({block:'start'});" });
await sleep(1200);
const box = await send('Runtime.evaluate', { expression: `(() => {
  const el = document.querySelector('#recordTabs')?.parentElement?.parentElement || document.getElementById('adviceRecord');
  const r = el.getBoundingClientRect();
  return { x: Math.max(0, r.x), y: Math.max(0, r.y), w: Math.min(r.width, 1280), h: Math.min(r.height, 900) };
})()`, returnByValue: true });
const { x, y, w, h } = box.result.value;
const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x, y, width: w, height: h, scale: 1 },
  captureBeyondViewport: false,
});
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('已写出', OUT, `${Math.round(w)}×${Math.round(h)}`);
await fetch(`http://127.0.0.1:${CDP}/json/close/${page.id}`).catch(() => {});
process.exit(0);
