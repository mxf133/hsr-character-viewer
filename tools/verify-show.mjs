// Make the Geetest v3 widget actually appear.
//
// The DOM subtree exists (`geetest_panel geetest_wind` inside #holder) but the
// panel is display:none / 0x0, so the user sees an empty bordered box.
// This drives the captcha object's own API to reveal it, and reports which
// method worked so the page can call it directly.
//
// Usage: node tools/verify-show.mjs [cdpPort]
const PORT = Number(process.argv[2] || 9334);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === 'page' && /8377/.test(t.url)) || list.find((t) => t.type === 'page');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

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

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return `[异常] ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`;
  return r.result.value;
};

// The page keeps the captcha in a closure variable, so re-expose it: the widget
// also stores a global reference in most v3 builds. Find it.
console.log('=== 寻找 captcha 对象 ===');
console.log(await ev(`(function(){
  var found = [];
  for (var k in window) {
    try {
      var v = window[k];
      if (v && typeof v === 'object' && typeof v.verify === 'function' && typeof v.getValidate === 'function') {
        found.push(k);
      }
    } catch (e) {}
  }
  return '候选全局对象: ' + (found.join(', ') || '(无)') + '\\ntypeof Geetest=' + typeof window.Geetest;
})()`));

// Re-init via the page, but this time try the explicit show()/verify() path and
// log which one makes the panel visible.
console.log('\n=== 用页面自己的按钮重新初始化，同时尝试显示 ===');
console.log(await ev(`(function(){
  // Patch initGeetest to capture the instance for inspection.
  if (!window.__origInit) {
    window.__origInit = window.initGeetest;
    window.initGeetest = function (opts, cb) {
      return window.__origInit(opts, function (cap) {
        window.__cap = cap;
        try { console.log('[probe] captcha captured'); } catch (e) {}
        return cb(cap);
      });
    };
  }
  return 'patched';
})()`));

// Re-init and force show.
await ev(`document.getElementById('reload').click()`);
await sleep(4000);

console.log(await ev(`(function(){
  var c = window.__cap;
  if (!c) return '未捕获到 captcha（按钮未触发？）';
  var out = [];
  out.push('方法: ' + Object.keys(c).filter(function(k){return typeof c[k]==='function'}).join(','));
  var panel = document.querySelector('.geetest_panel');
  out.push('尝试前 panel display=' + (panel ? getComputedStyle(panel).display : 'n/a'));
  // Try every documented reveal path.
  ['verify','show','showCaptcha','refresh'].forEach(function(m){
    if (typeof c[m] === 'function') {
      try { c[m](); out.push(m + '() 已调用'); } catch (e) { out.push(m + '() 异常: ' + e.message); }
    }
  });
  return out.join('\\n');
})()`));
await sleep(1500);

console.log('\n=== 结果 ===');
console.log(await ev(`(function(){
  var p = document.querySelector('.geetest_panel');
  var holder = document.getElementById('holder');
  return JSON.stringify({
    panelDisplay: p ? getComputedStyle(p).display : 'none',
    panelSize: p ? (p.offsetWidth + 'x' + p.offsetHeight) : '0x0',
    holderChildren: holder ? holder.children.length : -1,
    holderHtmlLen: holder ? holder.innerHTML.length : -1
  });
})()`));

const shot = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync('C:\\mumudump\\verify-after-show.png', Buffer.from(shot.data, 'base64'));
console.log('截图: C:\\mumudump\\verify-after-show.png');

ws.close();
console.log('完成。');
