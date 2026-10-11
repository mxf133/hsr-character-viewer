// Deep inspection of the verification page: where did the Geetest widget
// actually go, and what is it waiting on?
//
// Earlier signal: `#holder` has 0 children while 52 `[class*=geetest]` nodes
// exist somewhere in the document - so the widget renders, but not where we
// expect, or it is stuck in a loading state.
//
// Usage: node tools/verify-page-deep.mjs [cdpPort]
const PORT = Number(process.argv[2] || 9334);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => null);
if (!list) { console.error(`无法连接 CDP ${PORT}`); process.exit(1); }
const page = list.find((t) => t.type === 'page' && /8377/.test(t.url)) || list.find((t) => t.type === 'page');
if (!page) { console.error('没找到页面'); process.exit(1); }
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

const netFailures = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
    return;
  }
  if (m.method === 'Network.loadingFailed') {
    netFailures.push(`${m.params.errorText} (${m.params.type}) blocked=${m.params.blockedReason || '-'}`);
  }
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url;
    if (/geetest|gcaptcha/i.test(u)) {
      netFailures.push(`HTTP ${m.params.response.status} ${u.slice(0, 110)}`);
    }
  }
});

await send('Network.enable');
await send('Runtime.enable');
await sleep(300);

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return `[异常] ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`;
  return r.result.value;
};

console.log('\n=================== Geetest 节点都在哪 ===================');
console.log(await evaluate(`(function(){
  var out = [];
  var nodes = document.querySelectorAll('[class*=geetest]');
  var seen = {};
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    var p = n.parentElement;
    var path = [];
    var cur = n;
    while (cur && cur !== document.body && path.length < 6) {
      path.unshift(cur.tagName.toLowerCase() + (cur.id ? '#' + cur.id : '') + (cur.className && typeof cur.className === 'string' ? '.' + cur.className.split(' ').slice(0,2).join('.') : ''));
      cur = cur.parentElement;
    }
    var key = path.join('>');
    if (!seen[key]) { seen[key] = 1; out.push(key + '   [display=' + getComputedStyle(n).display + ' visible=' + (n.offsetWidth>0&&n.offsetHeight>0) + ' ' + n.offsetWidth + 'x' + n.offsetHeight + ']'); }
  }
  return out.slice(0, 14).join('\\n');
})()`));

console.log('\n=================== #holder 内容 ===================');
console.log(await evaluate(`(function(){
  var h = document.getElementById('holder');
  if (!h) return 'holder 不存在';
  var cs = getComputedStyle(h);
  return 'innerHTML 长度=' + h.innerHTML.length +
    '\\n子元素=' + h.children.length +
    '\\n尺寸=' + h.offsetWidth + 'x' + h.offsetHeight +
    '\\ndisplay=' + cs.display + ' visibility=' + cs.visibility + ' overflow=' + cs.overflow +
    '\\ninnerHTML=' + h.innerHTML.slice(0, 400);
})()`));

console.log('\n=================== 页面上可见的顶层元素 ===================');
console.log(await evaluate(`(function(){
  var out = [];
  var kids = document.body.querySelectorAll('body > *, #holder > *, body > div > *');
  for (var i = 0; i < kids.length && out.length < 20; i++) {
    var n = kids[i];
    if (n.offsetWidth > 0 && n.offsetHeight > 0) {
      out.push(n.tagName.toLowerCase() + (n.id?'#'+n.id:'') + '.' + String(n.className||'').split(' ').slice(0,2).join('.') + '  ' + n.offsetWidth + 'x' + n.offsetHeight);
    }
  }
  return out.join('\\n') || '(没有可见的顶层元素)';
})()`));

console.log('\n=================== Geetest 全局对象状态 ===================');
console.log(await evaluate(`(function(){
  var g = window.Geetest || window.GeeGT || null;
  return JSON.stringify({
    initGeetest: typeof window.initGeetest,
    GeeGT: window.GeeGT || null,
    GeeChallenge: window.GeeChallenge || null,
    gtLoaded: !!document.querySelector('script[src*="gt.0.4.9"]')
  });
})()`));

console.log('\n=================== 重新初始化一次并观察 ===================');
await evaluate(`(function(){
  var s = document.getElementById('status');
  if (s) s.textContent = '（调试：重新初始化）';
  var b = document.getElementById('reload');
  if (b) b.click();
  return 'clicked';
})()`);
await sleep(6000);
console.log('状态:', await evaluate('String((document.getElementById("status")||{}).textContent||"")'));
console.log('日志尾部:\n' + await evaluate('String((document.getElementById("log")||{}).textContent||"").slice(-500)'));
console.log('#holder 子元素:', await evaluate('document.getElementById("holder").children.length'));
console.log('geetest 节点数:', await evaluate('document.querySelectorAll("[class*=geetest]").length'));

if (netFailures.length) {
  console.log('\n=================== Geetest 相关网络 ===================');
  console.log([...new Set(netFailures)].slice(0, 20).join('\n'));
}

ws.close();
console.log('\n完成。');
