// Run the OFFICIAL Star Rail record page inside a real Chrome, by injecting a
// shim for the miHoYo app WebView bridge over the DevTools Protocol.
//
// Why this is needed: the page bails out before issuing a single request unless
// `window.$bbsApp.appVersion` is truthy, and its no-bridge fallback calls a
// webpack module that exports a PNG (so it throws). Verified earlier: in a plain
// browser both the Genshin and Star Rail record pages make 0 API calls.
//
// What the shim provides (all usages found in the page bundle):
//   appVersion, isIOS, getStatusBarHeight(), onScreenshot(),
//   getHTTPRequestHeaders(cb) -> {data:{x-rpc-device_id, x-rpc-device_fp, ...}}
//   getDS2({query,body}, cb)  -> {retcode:0, data:{DS}}
//   getCookieToken(), toLogin(), closePage(), setFullscreen(), eventTrack()
//
// Usage:
//   node tools/cdp-official.mjs                 # headless, just capture traffic
//   node tools/cdp-official.mjs --headful       # visible window (solve captcha)
//   node tools/cdp-official.mjs --url <url>     # override the page
//   node tools/cdp-official.mjs --seconds 60
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes(`--${n}`);

const HEADFUL = flag('headful');
const SECONDS = Number(arg('seconds', '45'));
const CDP_PORT = Number(arg('port', '9333'));
const APP_VERSION = '2.109.0';
const SALT = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs';
const UID = arg('uid', '100000000');
const URL_TO_OPEN = arg('url',
  `https://webstatic.mihoyo.com/app/community-game-records/rpg/index.html`
  + `?mhy_presentation_style=fullscreen&game_id=6&user_id=76090888#/rpg/roles`);

// ---- account material -------------------------------------------------------
const account = JSON.parse(readFileSync(`${ROOT}data/accounts.json`, 'utf8')).accounts[0];
const cookieJar = account.cookie;
const DEVICE_ID = account.deviceId;
const DEVICE_FP = account.fingerprint || '';

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

/**
 * The shim runs in the page's own world before any page script, so the Vue app
 * sees a bridge that looks exactly like the app's.
 */
const shim = `(() => {
  const SALT = ${JSON.stringify(SALT)};
  const APP_VERSION = ${JSON.stringify(APP_VERSION)};
  const DEVICE_ID = ${JSON.stringify(DEVICE_ID)};
  const DEVICE_FP = ${JSON.stringify(DEVICE_FP)};
  const log = (...a) => { try { console.log('[bridge]', ...a); } catch (e) {} };

  const md5 = (s) => {
    // Tiny MD5 for DS. Implemented inline to avoid loading anything.
    function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
    function au(x, y) { const l = (x & 0xFFFF) + (y & 0xFFFF); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xFFFF); }
    function cmn(q, a, b, x, s, t) { return au(rl(au(au(a, q), au(x, t)), s), b); }
    function ff(a,b,c,d,x,s,t){return cmn((b&c)|((~b)&d),a,b,x,s,t);}
    function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&(~d)),a,b,x,s,t);}
    function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}
    function ii(a,b,c,d,x,s,t){return cmn(c^(b|(~d)),a,b,x,s,t);}
    function tb(str){const n=[];for(let i=0;i<str.length*8;i+=8){n[i>>5]|=(str.charCodeAt(i/8)&0xFF)<<(i%32);}return n;}
    function th(n){let s='';for(let i=0;i<n.length*4;i++){s+=('0'+((n[i>>2]>>((i%4)*8))&0xFF).toString(16)).slice(-2);}return s;}
    function utf8(str){return unescape(encodeURIComponent(str));}
    const x = tb(utf8(s));
    const len = utf8(s).length * 8;
    x[len >> 5] |= 0x80 << (len % 32);
    x[(((len + 64) >>> 9) << 4) + 14] = len;
    let a=1732584193,b=-271733879,c=-1732584194,d=271733878;
    for(let i=0;i<x.length;i+=16){
      const oa=a,ob=b,oc=c,od=d;
      a=ff(a,b,c,d,x[i],7,-680876936);d=ff(d,a,b,c,x[i+1],12,-389564586);c=ff(c,d,a,b,x[i+2],17,606105819);b=ff(b,c,d,a,x[i+3],22,-1044525330);
      a=ff(a,b,c,d,x[i+4],7,-176418897);d=ff(d,a,b,c,x[i+5],12,1200080426);c=ff(c,d,a,b,x[i+6],17,-1473231341);b=ff(b,c,d,a,x[i+7],22,-45705983);
      a=ff(a,b,c,d,x[i+8],7,1770035416);d=ff(d,a,b,c,x[i+9],12,-1958414417);c=ff(c,d,a,b,x[i+10],17,-42063);b=ff(b,c,d,a,x[i+11],22,-1990404162);
      a=ff(a,b,c,d,x[i+12],7,1804603682);d=ff(d,a,b,c,x[i+13],12,-40341101);c=ff(c,d,a,b,x[i+14],17,-1502002290);b=ff(b,c,d,a,x[i+15],22,1236535329);
      a=gg(a,b,c,d,x[i+1],5,-165796510);d=gg(d,a,b,c,x[i+6],9,-1069501632);c=gg(c,d,a,b,x[i+11],14,643717713);b=gg(b,c,d,a,x[i],20,-373897302);
      a=gg(a,b,c,d,x[i+5],5,-701558691);d=gg(d,a,b,c,x[i+10],9,38016083);c=gg(c,d,a,b,x[i+15],14,-660478335);b=gg(b,c,d,a,x[i+4],20,-405537848);
      a=gg(a,b,c,d,x[i+9],5,568446438);d=gg(d,a,b,c,x[i+14],9,-1019803690);c=gg(c,d,a,b,x[i+3],14,-187363961);b=gg(b,c,d,a,x[i+8],20,1163531501);
      a=gg(a,b,c,d,x[i+13],5,-1444681467);d=gg(d,a,b,c,x[i+2],9,-51403784);c=gg(c,d,a,b,x[i+7],14,1735328473);b=gg(b,c,d,a,x[i+12],20,-1926607734);
      a=hh(a,b,c,d,x[i+5],4,-378558);d=hh(d,a,b,c,x[i+8],11,-2022574463);c=hh(c,d,a,b,x[i+11],16,1839030562);b=hh(b,c,d,a,x[i+14],23,-35309556);
      a=hh(a,b,c,d,x[i+1],4,-1530992060);d=hh(d,a,b,c,x[i+4],11,1272893353);c=hh(c,d,a,b,x[i+7],16,-155497632);b=hh(b,c,d,a,x[i+10],23,-1094730640);
      a=hh(a,b,c,d,x[i+13],4,681279174);d=hh(d,a,b,c,x[i],11,-358537222);c=hh(c,d,a,b,x[i+3],16,-722521979);b=hh(b,c,d,a,x[i+6],23,76029189);
      a=hh(a,b,c,d,x[i+9],4,-640364487);d=hh(d,a,b,c,x[i+12],11,-421815835);c=hh(c,d,a,b,x[i+15],16,530742520);b=hh(b,c,d,a,x[i+2],23,-995338651);
      a=ii(a,b,c,d,x[i],6,-198630844);d=ii(d,a,b,c,x[i+7],10,1126891415);c=ii(c,d,a,b,x[i+14],15,-1416354905);b=ii(b,c,d,a,x[i+5],21,-57434055);
      a=ii(a,b,c,d,x[i+12],6,1700485571);d=ii(d,a,b,c,x[i+3],10,-1894986606);c=ii(c,d,a,b,x[i+10],15,-1051523);b=ii(b,c,d,a,x[i+1],21,-2054922799);
      a=ii(a,b,c,d,x[i+8],6,1873313359);d=ii(d,a,b,c,x[i+15],10,-30611744);c=ii(c,d,a,b,x[i+6],15,-1560198380);b=ii(b,c,d,a,x[i+13],21,1309151649);
      a=ii(a,b,c,d,x[i+4],6,-145523070);d=ii(d,a,b,c,x[i+11],10,-1120210379);c=ii(c,d,a,b,x[i+2],15,718787259);b=ii(b,c,d,a,x[i+9],21,-343485551);
      a=au(a,oa);b=au(b,ob);c=au(c,oc);d=au(d,od);
    }
    return th([a,b,c,d]);
  };

  const makeDS = (query, body) => {
    const t = Math.floor(Date.now() / 1000);
    const r = Math.floor(Math.random() * 900000) + 100000;
    const b = body || '';
    const q = query && typeof query === 'object' ? '' : (query || '');
    return t + ',' + r + ',' + md5('salt=' + SALT + '&t=' + t + '&r=' + r + '&b=' + b + '&q=' + q);
  };

  window.__DSH_BRIDGE_LOG = [];
  const bridge = {
    appVersion: APP_VERSION,
    isIOS: false,
    isAndroid: true,
    getStatusBarHeight: () => Promise.resolve({ data: { statusBarHeight: 24 } }),
    onScreenshot: () => {},
    onWebViewOrientationChanged: () => {},
    onWebViewWillAppear: () => {},
    setFullscreen: () => {},
    imageShare: () => {},
    screenshotShare: () => {},
    appPage: () => {},
    closePage: () => {},
    toLogin: () => log('toLogin() called'),
    getCookieToken: () => { log('getCookieToken() called'); return Promise.resolve({ data: {} }); },
    eventTrack: () => {},
    getCookieInfo: () => Promise.resolve({ data: {} }),
    // The two that actually matter for data access:
    getHTTPRequestHeaders: (opts, cb) => {
      log('getHTTPRequestHeaders() requested');
      const data = {
        'x-rpc-device_id': DEVICE_ID,
        'x-rpc-device_fp': DEVICE_FP,
        'x-rpc-device_name': encodeURIComponent('Android Browser'),
        'x-rpc-sys_version': encodeURIComponent('Android 12'),
      };
      if (typeof cb === 'function') cb({ data });
      return Promise.resolve({ data });
    },
    getDS2: (params, cb) => {
      const ds = makeDS(params && params.query, params && params.body);
      log('getDS2() ->', ds);
      const payload = { retcode: 0, data: { DS: ds } };
      if (typeof cb === 'function') cb(payload);
      return Promise.resolve(payload);
    },
    // Some builds call this instead of getDS2.
    getDs: () => Promise.resolve({ data: { DS: makeDS('', '') } }),
  };

  window.$bbsApp = bridge;
  // The page reads these off the Vue prototype; mirror them so either access
  // path works.
  window.__DSH_BRIDGE_INSTALLED = true;
  log('bridge installed, appVersion =', bridge.appVersion);
})();`;

// ---- launch Chrome ----------------------------------------------------------
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) { console.error('找不到 Chrome/Edge'); process.exit(1); }

const PROFILE = arg('profile', `${ROOT}.snapref\\chrome-profile`);
mkdirSync(PROFILE, { recursive: true });

console.log('浏览器 :', browser);
console.log('页面   :', URL_TO_OPEN);
console.log('模式   :', HEADFUL ? '有窗口（可手动过验证码）' : '无头');
console.log('调试端口:', CDP_PORT);

const child = spawn(browser, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking',
  '--disable-features=Translate,MediaRouter',
  '--window-size=1280,900',
  ...(HEADFUL ? [] : ['--headless=new']),
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const version = await (async () => {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return r.json();
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome 未就绪');
})();
console.log('CDP    :', version.Browser);

const target = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })
  .then((r) => r.json())
  .catch(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()))
    .find((t) => t.type === 'page'));

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let nextId = 1;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject, method });
  ws.send(JSON.stringify({ id, method, params }));
});

const apiCalls = [];
const apiResponses = [];
const consoleLines = [];

ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const { resolve, reject, method } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(`${method}: ${m.error.message}`)); else resolve(m.result);
    return;
  }
  if (m.method === 'Network.requestWillBeSent') {
    const { request } = m.params;
    // Only the record API matters here.
    if (/api-takumi-record\.mihoyo\.com|api-takumi\.mihoyo\.com/.test(request.url)) {
      apiCalls.push({ method: request.method, url: request.url, headers: request.headers, postData: request.postData });
    }
  }
  if (m.method === 'Network.responseReceived') {
    if (/api-takumi-record/.test(m.params.response.url)) {
      apiResponses.push({
        url: m.params.response.url,
        status: m.params.response.status,
        requestId: m.params.requestId,
      });
    }
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    consoleLines.push(`[${m.params.type}] ${text}`.slice(0, 300));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    consoleLines.push(`[EXCEPTION] ${d.text || ''} ${(d.exception && d.exception.description) || ''}`.slice(0, 400));
  }
  if (m.method === 'Log.entryAdded') {
    const e = m.params.entry || {};
    consoleLines.push(`[log:${e.level}] ${e.text || ''} ${e.url || ''}`.slice(0, 300));
  }
});

await send('Network.enable', { maxPostDataSize: 65536 });
await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');

// Seed cookies so the page is logged in as this account.
const domains = ['.mihoyo.com', 'webstatic.mihoyo.com', 'api-takumi-record.mihoyo.com'];
for (const [name, value] of Object.entries(cookieJar)) {
  for (const domain of domains) {
    await send('Network.setCookie', { name, value: String(value), domain, path: '/' }).catch(() => {});
  }
}
console.log(`已注入 ${Object.keys(cookieJar).length} 个 cookie`);

// Inject the bridge BEFORE any page script runs.
const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: shim });
console.log('桥已注册:', identifier);

console.log(`\n打开页面，观察 ${SECONDS} 秒 ...\n`);
await send('Page.navigate', { url: URL_TO_OPEN });
await sleep(SECONDS * 1000);

// Did the bridge actually take effect?
try {
  const probe = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      bridge: !!window.$bbsApp,
      appVersion: window.$bbsApp && window.$bbsApp.appVersion,
      hash: location.hash,
      title: document.title,
      rootHtml: (document.getElementById('root') && document.getElementById('root').innerHTML || '').slice(0, 200),
      body: (document.body && document.body.innerText || '').slice(0, 400),
      scripts: [...document.scripts].map(function (s) { return s.src.split('/').pop(); }),
      vue: typeof window.Vue,
      errors: (window.__DSH_ERRORS || []).slice(0, 5)
    })`,
    returnByValue: true,
  });
  console.log('页面状态:', probe.result.value);
} catch (err) {
  console.log('页面状态读取失败:', err.message);
}

console.log(`\n=================== 页面发出的 API 请求（${apiCalls.length} 个）===================`);
for (const c of apiCalls) {
  console.log(`\n--- ${c.method} ${c.url}`);
  for (const [k, v] of Object.entries(c.headers)) {
    if (/^(x-rpc-|ds$|cookie|referer|content-type)/i.test(k)) {
      console.log(`      ${k}: ${String(v).slice(0, 150)}`);
    }
  }
  if (c.postData) console.log(`      body: ${c.postData.slice(0, 200)}`);
}

console.log('\n=================== API 响应 ===================');
for (const r of apiResponses) {
  let body = '';
  try {
    const b = await send('Network.getResponseBody', { requestId: r.requestId });
    body = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
  } catch { body = '(不可读)'; }
  const short = r.url.split('/api/')[1] || r.url;
  console.log(`\n--- ${short}`);
  console.log(`      HTTP ${r.status}  ${body.slice(0, 260)}`);
}

if (consoleLines.length) {
  console.log('\n=================== 页面 console ===================');
  for (const l of consoleLines.slice(0, 20)) console.log('  ' + l);
}

// Optional: evaluate an expression in the page to poke at its internals.
// Passed via DSH_CDP_EVAL so multi-line expressions survive the command line.
const EVAL = process.env.DSH_CDP_EVAL || arg('eval', null);
if (EVAL) {
  try {
    const r = await send('Runtime.evaluate', {
      expression: EVAL,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log('\n=================== --eval 结果 ===================');
    console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 2));
    if (r.exceptionDetails) console.log('异常:', JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  } catch (err) {
    console.log('\n--eval 失败:', err.message);
  }
}

if (HEADFUL) {
  console.log('\n浏览器窗口保持打开，供你手动完成验证。');
  console.log(`关闭窗口后本进程退出（或等待 ${SECONDS}s 已到）。`);
} else {
  ws.close();
  child.kill();
}
console.log('\n完成。');
