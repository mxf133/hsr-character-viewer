// Figure out why the Geetest v3 panel stays display:none, and force it visible.
//
// Facts gathered so far:
//   * v3 script loaded, /gettype.php and /get.php both returned HTTP 200
//   * Geetest created a `geetest_panel geetest_wind` subtree INSIDE #holder
//   * that panel is display:none, so nothing is visible to the user
//   * onReady fired, so the library thinks it is ready
//
// v3 renders either an inline bar or a popup, and in `bind` mode the panel can
// stay hidden until shown. This probes the captcha object and tries the
// documented ways to make it appear.
//
// Usage: node tools/verify-force-show.mjs [cdpPort]
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

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return `[异常] ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`;
  return r.result.value;
};

// 1. Screenshot so we can see what the user sees.
const shot = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync('C:\\mumudump\\verify-page.png', Buffer.from(shot.data, 'base64'));
console.log('截图已保存: C:\\mumudump\\verify-page.png');

// 2. Inspect the panel and the captcha object.
console.log('\n=== panel 现状 ===');
console.log(await ev(`(function(){
  var p = document.querySelector('.geetest_panel');
  if (!p) return '没有 .geetest_panel';
  var cs = getComputedStyle(p);
  return JSON.stringify({
    display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
    position: cs.position, zIndex: cs.zIndex, width: p.offsetWidth, height: p.offsetHeight
  });
})()`));

console.log('\n=== 页面里的 captcha 对象暴露了什么 ===');
console.log(await ev(`(function(){
  var out = {};
  // The widget keeps a global reference in several v3 builds.
  for (var k of ['GeeGT','GeeChallenge','Geetest','gt','captcha','__geetest']) {
    if (window[k] !== undefined) out[k] = typeof window[k];
  }
  var h = document.getElementById('holder');
  out.holderHtmlLen = h ? h.innerHTML.length : -1;
  out.panels = document.querySelectorAll('.geetest_panel').length;
  out.panelParents = [];
  document.querySelectorAll('.geetest_panel').forEach(function(p){
    out.panelParents.push((p.parentElement && (p.parentElement.id || p.parentElement.className)) || '?');
  });
  return JSON.stringify(out);
})()`));

// 3. Try the documented ways to reveal it.
console.log('\n=== 尝试强制显示 ===');
console.log(await ev(`(function(){
  var results = [];
  var panel = document.querySelector('.geetest_panel');
  if (panel) {
    // Reason 1: an ancestor is hidden.
    var hiddenAncestor = null, cur = panel;
    while (cur && cur !== document.body) {
      var cs = getComputedStyle(cur);
      if (cs.display === 'none') { hiddenAncestor = (cur.tagName + '.' + String(cur.className||'').split(' ')[0]); break; }
      cur = cur.parentElement;
    }
    results.push('隐藏祖先: ' + (hiddenAncestor || '无'));
    // Reason 2: zero-size / no layout.
    results.push('panel 尺寸: ' + panel.offsetWidth + 'x' + panel.offsetHeight);
  }
  return results.join('\\n');
})()`));

// Force-show attempt: make the panel and its ancestors visible.
console.log(await ev(`(function(){
  var panel = document.querySelector('.geetest_panel');
  if (!panel) return 'no panel';
  var log = [];
  // Climb and clear display:none on ancestors of the panel.
  var cur = panel;
  while (cur && cur !== document.body) {
    if (getComputedStyle(cur).display === 'none') {
      cur.style.display = 'block';
      log.push('强制显示 ' + cur.tagName + '.' + String(cur.className||'').split(' ')[0]);
    }
    cur = cur.parentElement;
  }
  panel.style.display = 'block';
  panel.style.visibility = 'visible';
  panel.style.opacity = '1';
  panel.style.position = 'relative';
  panel.style.zIndex = '9999';
  log.push('panel 现在尺寸 ' + panel.offsetWidth + 'x' + panel.offsetHeight);
  return log.join('\\n');
})()`));
await sleep(1200);
console.log('强制后可见节点数:', await ev(`document.querySelectorAll('.geetest_panel').length`));
console.log('强制后 panel 尺寸:', await ev(`(function(){var p=document.querySelector('.geetest_panel');return p?p.offsetWidth+'x'+p.offsetHeight:'none'})()`));

// 4. Second screenshot to compare.
const shot2 = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('C:\\mumudump\\verify-page-forced.png', Buffer.from(shot2.data, 'base64'));
console.log('强制后截图: C:\\mumudump\\verify-page-forced.png');

ws.close();
console.log('\n完成。');
