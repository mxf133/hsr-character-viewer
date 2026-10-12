// 探针：配装块里那些**加载失败的图标**到底是怎么回事 —— CDN 上没有这张图，
// 还是只是本地网络抖了一下？
//
// 为什么要分清这两件事（用户 2026-10 提问「这些图标是每次联网获取吗？能不能下载到
// 本地，避免渲染出问题」）：
//   * **图不存在**（404）→ 必须换源或本地化，改代码没用；
//   * **图存在、只是这次没拉到** → 是网络/并发问题，本地化就能根治。
// 混为一谈就会得出错误的结论（比如「jsdelivr 没有这张图」其实是代理超时）。
//
// 用法：node tools/_probe-icon-health.mjs [--port 8371] [--cdp 9222]
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const PORT = Number(arg('port', '8371'));
const CDP = Number(arg('cdp', '9222'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 复用 CDP 那套连接（与 _probe-pack-panel.mjs 同源，见 handoff §5：Chrome 必须与探针
// 在**同一条 Bash 调用**里起，否则端口已经空了）
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

// 打开遐蝶的配装块，让图片真的去请求
await evaluate(`import('/scripts/character-modal.js').then((m) => {
  m.openCharacterPanel({ id: '1407', nameCn: '遐蝶', charKey: '遐蝶', eidolon: 2 },
    () => null, { art: null, catalog: {} });
  return true;
})`);
for (let i = 0; i < 50; i += 1) {
  const n = await evaluate(`document.querySelectorAll('#charPanelBody .pack-team-avatar, #charPanelBody .pack-item-cone-icon').length`);
  if (n > 0) break;
  await sleep(500);
}
await sleep(6000);

// 逐张量：naturalWidth 是 0 = 没加载出来；再**逐张单独重试一次**并量耗时。
const report = await evaluate(`(async () => {
  const imgs = [ ...document.querySelectorAll('#charPanelBody .pack-team-avatar, #charPanelBody .pack-item-cone-icon') ];
  const bad = imgs.filter((i) => i.naturalWidth === 0).map((i) => ({
    src: i.getAttribute('src') || '',
    cls: i.className,
  }));
  const ok = imgs.length - bad.length;
  // 单张重试：串行 + 间隔，避开并发被 CDN 限流。
  // ⚠️ 只对**真的有 src** 的失败图重试 —— 没有 src 的那些是「图标数据里查不到这个角色/
  // 光锥」，给空 src 会立刻 error 且耗时 0ms，拿它当「CDN 取不到」是误判。
  //（⚠️ 这段注释放模板字符串里，里面**不能出现反引号**，否则字符串提前结束。）
  const withSrc = bad.filter((b) => b.src);
  const noSrc = bad.filter((b) => !b.src);
  const retried = [];
  for (const { src } of withSrc.slice(0, 12)) {
    const t0 = performance.now();
    const r = await new Promise((res) => {
      const im = new Image();
      im.onload = () => res({ ok: true, ms: Math.round(performance.now() - t0) });
      im.onerror = () => res({ ok: false, ms: Math.round(performance.now() - t0) });
      im.src = src;
    });
    retried.push({ file: src.split('/').slice(-1)[0], ok: r.ok, ms: r.ms });
  }
  return {
    total: imgs.length, ok, badCount: bad.length,
    noSrcCount: noSrc.length, noSrcCls: [...new Set(noSrc.map((b) => b.cls))],
    retried,
  };
})()`);

console.log(`配装块图标 ${report.total} 张：加载成功 ${report.ok}，失败 ${report.badCount}`);
console.log(`其中「根本没有 src」（i18n.icons 里查不到该角色/光锥）${report.noSrcCount} 张`
  + `：${JSON.stringify(report.noSrcCls)}`);
console.log('逐张串行重试（真有 src 的那些）：');
for (const r of report.retried) {
  console.log(`  ${r.ok ? '✓ 这次成功' : '✗ 仍然失败'}  ${String(r.ms).padStart(5)}ms  ${r.file}`);
}
const stillBad = report.retried.filter((r) => !r.ok).length;
console.log(`\n结论：无 src ${report.noSrcCount} 张（数据缺图标，与网络无关）；`
  + `有 src 但拉失败 ${report.retried.length} 张里占 ${stillBad} 张`
  + (stillBad === report.retried.length && report.retried.length
    ? '  → CDN 上确实取不到，本地化是唯一解'
    : '  → 并发时被限流/超时，本地化同样能根治'));
ws.close();
process.exit(0);