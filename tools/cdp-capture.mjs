// Capture what the OFFICIAL Star Rail record page actually sends, by driving a
// real Chrome over the DevTools Protocol and recording the request headers and
// POST bodies it builds.
//
// Why: reading the bundle told us which header NAMES the page uses, but the
// VALUES come from the miHoYo app WebView bridge at runtime, so static analysis
// cannot recover them. Letting the page run and intercepting its traffic can.
//
// Usage:
//   node tools/cdp-capture.mjs [--url <recordPageUrl>] [--headful] [--seconds 40]
//
// By default it seeds the page with the stored account cookie + device
// fingerprint (via Network.setCookie / setExtraHTTPHeaders) so the API calls are
// made as this account - the exact scenario we are trying to explain.
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const URL_TO_OPEN = process.env.CDP_URL || arg('url',
  'https://webstatic.mihoyo.com/app/community-game-records/rpg/index.html'
  + '?mhy_presentation_style=fullscreen&bbs_auth_required=true'
  + '&game_id=6&user_id=76090888#/rpg/roles');
const HEADFUL = flag('headful');
const SECONDS = Number(arg('seconds', '40'));

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browser = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('找不到 Chrome / Edge');
  process.exit(1);
}
console.log('浏览器:', browser);

// ---- account material -------------------------------------------------------
let account = null;
try {
  account = JSON.parse(readFileSync('data/accounts.json', 'utf8')).accounts[0];
} catch { /* optional */ }

const profileDir = mkdtempSync(join(tmpdir(), 'cdp-rec-'));
const port = 9223 + Math.floor(Math.random() * 200);

const child = spawn(browser, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-features=Translate,MediaRouter',
  '--window-size=1280,900',
  ...(HEADFUL ? [] : ['--headless=new']),
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll the DevTools HTTP endpoint until the browser is ready. */
const waitForBrowser = async () => {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return res.json();
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('浏览器没有在超时内就绪');
};

const version = await waitForBrowser();
console.log('CDP 就绪:', version.Browser);

// ---- open a page target -----------------------------------------------------
const newTarget = await fetch(
  `http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`,
  { method: 'PUT' },
).then((r) => r.json()).catch(async () => {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  return list.find((t) => t.type === 'page');
});

const ws = new WebSocket(newTarget.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject, method });
  ws.send(JSON.stringify({ id, method, params }));
});

const captured = [];
const responses = [];

ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject, method } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Network.requestWillBeSent') {
    const { request, type } = msg.params;
    if (!/mihoyo\.com/.test(request.url)) return;
    if (/\.(png|jpg|jpeg|webp|css|woff2?|ico|svg|gif)(\?|$)/i.test(request.url)) return;
    captured.push({
      type,
      method: request.method,
      url: request.url,
      headers: request.headers,
      postData: request.postData || null,
    });
  }
  if (msg.method === 'Network.responseReceived') {
    const { response } = msg.params;
    if (/api-takumi-record|game_record/.test(response.url)) {
      responses.push({ url: response.url, status: response.status, requestId: msg.params.requestId });
    }
  }
});

await send('Network.enable', { maxPostDataSize: 65536 });
await send('Page.enable');
await send('Runtime.enable');

// ---- seed the account cookie + fingerprint ---------------------------------
if (account) {
  const domains = ['.mihoyo.com', 'webstatic.mihoyo.com', 'api-takumi-record.mihoyo.com'];
  const jar = account.cookie || {};
  for (const [name, value] of Object.entries(jar)) {
    for (const domain of domains) {
      await send('Network.setCookie', { name, value: String(value), domain, path: '/' })
        .catch(() => {});
    }
  }
  console.log(`已注入 ${Object.keys(jar).length} 个 cookie（账号 ${account.accountId}）`);

  // Mimic the app WebView bridge headers so the page takes the "app present"
  // branch instead of the broken standalone fallback.
  const extra = {
    'x-rpc-device_id': account.deviceId,
    ...(account.fingerprint ? { 'x-rpc-device_fp': account.fingerprint } : {}),
    'x-rpc-device_name': encodeURIComponent('DESKTOP-CDP'),
    'x-rpc-sys_version': encodeURIComponent('Windows 11'),
    'x-rpc-platform': '5',
  };
  await send('Network.setExtraHTTPHeaders', { headers: extra });
  console.log('已注入设备头:', Object.keys(extra).join(', '));
}

console.log(`\n打开: ${URL_TO_OPEN}\n`);
await send('Page.navigate', { url: URL_TO_OPEN });

await sleep(SECONDS * 1000);

// ---- try to read any API responses that came back ---------------------------
console.log('=================== 抓到的请求 ===================');
for (const c of captured) {
  console.log(`\n--- ${c.method} ${c.url}`);
  const interesting = ['x-rpc-', 'ds', 'cookie', 'referer', 'user-agent'];
  for (const [k, v] of Object.entries(c.headers)) {
    if (interesting.some((p) => k.toLowerCase().includes(p))) {
      console.log(`    ${k}: ${String(v).slice(0, 160)}`);
    }
  }
  if (c.postData) console.log(`    body: ${c.postData.slice(0, 300)}`);
}

console.log('\n=================== API 响应状态 ===================');
for (const r of responses) console.log(`  ${r.status}  ${r.url}`);

// Pull the JSON bodies for the record endpoints.
console.log('\n=================== 关键响应体 ===================');
for (const r of responses.filter((x) => /avatar|index|role\/basicInfo/.test(x.url))) {
  try {
    const body = await send('Network.getResponseBody', { requestId: r.requestId });
    const text = body.base64Encoded
      ? Buffer.from(body.body, 'base64').toString('utf8')
      : body.body;
    console.log(`\n--- ${r.url.split('/api/')[1]} -> HTTP ${r.status}`);
    console.log(`    ${text.slice(0, 400)}`);
  } catch (err) {
    console.log(`\n--- ${r.url} (响应体不可读: ${err.message})`);
  }
}

ws.close();
child.kill();
try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
console.log('\n完成。');
