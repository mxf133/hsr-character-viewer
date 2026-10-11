// Solve the miHoYo Star Rail "账号可能存在异常" verification in a real Chrome, then
// use the resulting `x-rpc-challenge` to fetch the record.
//
// Current situation this addresses: index / avatar/basic / avatar/info /
// challenge all answer retcode 10035 while role/basicInfo and rogue succeed.
// The server DOES hand out a Geetest challenge for game_id 6, so one solved
// captcha should unlock the data.
//
// Design notes (learned the hard way):
//   * The page must be able to RETRY. A single failed submit previously killed
//     the whole run and left no way to see what went wrong.
//   * The exact payload the page posts is logged verbatim, because a missing
//     geetest_validate is the difference between retcode 0 and -1.
//   * Chrome runs with --remote-debugging-port so the page can be inspected
//     (or driven) while it waits.
//   * Both render paths are attempted: inline appendTo(), then showCaptcha().
//
// Usage:
//   node tools/hsr-verify.mjs                  # stored account, its Star Rail role
//   node tools/hsr-verify.mjs --uid 170556517
//   node tools/hsr-verify.mjs --port 8377
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

const store = JSON.parse(readFileSync(`${ROOT}data/accounts.json`, 'utf8'));
const account = store.accounts[Number(arg('account', '0'))] || store.accounts[0];
if (!account) { console.error('data/accounts.json 里没有账号'); process.exit(1); }

// Default to the account's own Star Rail role.
const hsrRole = (account.roles || []).find((r) => r.game === 'hsr');
const UID = String(arg('uid', hsrRole?.uid || '100000000'));
const SERVER = arg('server', hsrRole?.region || 'prod_gf_cn');
const PORT = Number(arg('port', '8377'));
const CDP_PORT = Number(arg('cdp', '9334'));
const CHALLENGE_GAME = 6;
const CHALLENGE_PATH = '/game_record/app/hkrpg/api/avatar/basic';

const { createDS } = await import('../src/mihoyo/ds.js');
const { APP_VERSION } = await import('../src/mihoyo/constants.js');

const ORIGIN = 'https://api-takumi-record.mihoyo.com';
const CARD = `${ORIGIN}/game_record/card/wapi`;
// The OFFICIAL Star Rail page does not use card/wapi/createVerification at all.
// Its environment module defines:
//   geetestApi = "https://api-takumi.mihoyo.com/event"
// and it calls (GET for create, POST for verify):
//   GET  ${geetestApi}/toolcomsrv/risk/createGeetest?is_high=true&app_key=hkrpg_game_record
//   POST ${geetestApi}/toolcomsrv/risk/verifyGeetest   {...getValidate(), app_key}
// with x-rpc-challenge_game / x-rpc-challenge_path as headers. Verified live:
// createGeetest returns {"retcode":0,"data":{"gt":"729c…","challenge":"…",
// "new_captcha":1,"success":1}}.
const GEETEST_API = 'https://api-takumi.mihoyo.com/event';
const APP_KEY = 'hkrpg_game_record';

const cookieHeader = Object.entries(account.cookie)
  .filter(([k]) => ['cookie_token', 'ltoken', 'ltuid', 'account_id'].includes(k))
  .map(([k, v]) => `${k}=${v}`).join('; ');

const signed = async (url, { method = 'GET', body, extraHeaders = {} } = {}) => {
  const query = url.includes('?') ? url.split('?')[1] : '';
  const headers = {
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/${APP_VERSION}`,
    Accept: 'application/json',
    'x-rpc-app_version': APP_VERSION,
    'x-rpc-client_type': '5',
    'x-rpc-device_id': account.deviceId,
    ...(account.fingerprint ? { 'x-rpc-device_fp': account.fingerprint } : {}),
    Referer: 'https://webstatic.mihoyo.com',
    'x-rpc-page': `${APP_VERSION}_#/rpg/roles`,
    Cookie: cookieHeader,
    DS: createDS({ query, body }),
    ...extraHeaders,
  };
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { retcode: res.status, message: text.slice(0, 120) }; }
};

// --------------------------------------------------------------- challenge
// A Geetest challenge is short-lived: presenting one that is more than a few
// seconds old makes the widget fail with
//   onError {msg:"old challenge", code:"error_02", user_error:"网络不给力"}
// so the challenge is fetched ON DEMAND, right before the widget initialises,
// and refetched every time the user reloads the captcha.
//
// `app_key` is required for Star Rail - copied verbatim from the official page's
// own flow (its P.createVerify call passes {is_high:true, app_key:"hkrpg_game_record"}).
console.log(`账号 ${account.accountId} · 星铁 UID ${UID} (${SERVER})`);

let currentChallenge = null;
let currentTraceId = null;
const fetchChallenge = async () => {
  const qs = new URLSearchParams({ is_high: 'true', app_key: APP_KEY });
  const url = `${GEETEST_API}/toolcomsrv/risk/createGeetest?${qs}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/${APP_VERSION}`,
      Accept: 'application/json',
      'x-rpc-app_version': APP_VERSION,
      'x-rpc-client_type': '5',
      'x-rpc-device_id': account.deviceId,
      ...(account.fingerprint ? { 'x-rpc-device_fp': account.fingerprint } : {}),
      Referer: 'https://webstatic.mihoyo.com',
      'x-rpc-page': `${APP_VERSION}_#/rpg/roles`,
      'x-rpc-challenge_game': String(CHALLENGE_GAME),
      'x-rpc-challenge_path': CHALLENGE_PATH,
      Cookie: cookieHeader,
    },
  });
  // The official page threads this trace id into EVERY subsequent risk call:
  //   headers["x-rpc-challenge_trace"] = response.headers["x-trace-id"]
  // Without it, verifyGeetest rejects a correctly solved captcha.
  currentTraceId = res.headers.get('x-trace-id') || currentTraceId;
  const json = await res.json().catch(() => null);
  if (json?.retcode !== 0 || !json?.data?.gt) {
    throw new Error(`createGeetest 失败 HTTP ${res.status} retcode=${json?.retcode} ${json?.message}`);
  }
  currentChallenge = json.data.challenge;
  // The official page passes offline: !success, so mirror that exactly.
  return {
    gt: json.data.gt,
    challenge: json.data.challenge,
    new_captcha: json.data.new_captcha,
    success: json.data.success,
    offline: !json.data.success,
  };
};

/** Headers shared by createGeetest and verifyGeetest. */
const riskHeaders = () => ({
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/${APP_VERSION}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'x-rpc-app_version': APP_VERSION,
  'x-rpc-client_type': '5',
  'x-rpc-device_id': account.deviceId,
  ...(account.fingerprint ? { 'x-rpc-device_fp': account.fingerprint } : {}),
  Referer: 'https://webstatic.mihoyo.com',
  'x-rpc-page': `${APP_VERSION}_#/rpg/roles`,
  'x-rpc-challenge_game': String(CHALLENGE_GAME),
  'x-rpc-challenge_path': CHALLENGE_PATH,
  ...(currentTraceId ? { 'x-rpc-challenge_trace': currentTraceId } : {}),
  Cookie: cookieHeader,
});

console.log('\n[1/4] 预热一次 createVerification（真正的挑战在页面加载时按需获取）...');
try {
  const warm = await fetchChallenge();
  console.log(`      retcode=0  gt=${warm.gt}`);
} catch (err) {
  console.error('      ', err.message);
  process.exit(1);
}

// ------------------------------------------------------------------- page
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>星铁战绩验证</title>
<style>
 body{font-family:"Microsoft YaHei",system-ui,sans-serif;background:#f5f7fa;margin:0;padding:20px;color:#1f2937}
 .card{max-width:760px;margin:0 auto;background:#fff;border-radius:12px;padding:22px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
 h1{font-size:17px;margin:0 0 6px}
 .sub{color:#6b7280;font-size:13px;line-height:1.7;margin-bottom:16px}
 #holder{min-height:64px;border:1px dashed #e5e7eb;border-radius:8px;padding:8px}
 #status{margin-top:14px;font-size:13px;padding:10px 12px;border-radius:8px;background:#f3f4f6;white-space:pre-wrap}
 .ok{background:#ecfdf5!important;color:#047857}.err{background:#fef2f2!important;color:#b91c1c}
 button{margin-top:10px;padding:8px 14px;border:0;border-radius:6px;background:#2563eb;color:#fff;font-size:13px;cursor:pointer}
 button.ghost{background:#e5e7eb;color:#374151;margin-left:8px}
 code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:12px}
 pre{background:#0f172a;color:#e2e8f0;padding:10px;border-radius:8px;font-size:11px;overflow:auto;max-height:160px}
</style></head><body>
<div class="card">
  <h1>《崩坏：星穹铁道》战绩验证</h1>
  <div class="sub">账号 <b>${account.accountId}</b> · UID <b>${UID}</b><br>
  完成下方验证后，本页会把结果自动交给本地程序，并立即用它拉取星铁角色数据。</div>
  <div id="holder"></div>
  <button id="reload" class="ghost">重新加载验证码</button>
  <div id="status">正在加载 Geetest 组件…</div>
  <pre id="log"></pre>
</div>
<script src="https://static.geetest.com/static/js/gt.0.4.9.js"></script>
<script>
(function () {
  var status = document.getElementById('status');
  var logEl = document.getElementById('log');
  var holder = 'holder';
  var captcha = null;

  function log(msg) {
    var t = new Date().toLocaleTimeString();
    logEl.textContent += '[' + t + '] ' + msg + '\\n';
    logEl.scrollTop = logEl.scrollHeight;
  }
  function nodes() { return document.querySelectorAll('#' + holder + ' [class*=geetest]').length; }
  function setStatus(t, cls) { status.textContent = t; status.className = cls || ''; }

  function submit(r) {
    setStatus('验证通过，正在提交…');
    log('提交: challenge=' + String(r.geetest_challenge).slice(0,20) + ' validate=' + String(r.geetest_validate).slice(0,30));
    fetch('/solve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r)
    }).then(function (x) { return x.json(); }).then(function (j) {
      if (j.ok) {
        setStatus('✅ 验证成功！\\nchallenge = ' + j.challenge + '\\n可以关闭本页，回到运行窗口看结果。', 'ok');
      } else {
        setStatus('❌ 提交被拒：' + (j.error || '未知') + '\\n可点「重新加载验证码」再试一次。', 'err');
      }
    }).catch(function (e) { setStatus('❌ 提交异常：' + e.message, 'err'); });
  }

  function init() {
    // Geetest v3: createVerification returns the classic
    // {gt, challenge, new_captcha, success} shape and verifyVerification wants
    // {geetest_challenge, geetest_validate, geetest_seccode}. gt4.js (v4) returns
    // {lot_number, captcha_output, pass_token} instead AND hands back a canned
    // offline result, which is why v4 never worked here.
    if (!window.initGeetest) {
      setStatus('❌ 未能加载 Geetest v3（gt.0.4.9.js）', 'err');
      log('initGeetest 不存在');
      return;
    }
    document.getElementById(holder).innerHTML = '';
    setStatus('正在获取验证挑战…');

    // Fetch a FRESH challenge every time. A stale one fails with
    //   onError {msg:"old challenge", code:"error_02"}
    fetch('/challenge', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (c) {
        if (!c.ok) throw new Error(c.error || '获取挑战失败');
        log('新挑战: gt=' + String(c.gt).slice(0, 12) + '… challenge=' + String(c.challenge).slice(0, 12)
          + '… offline=' + c.offline);
        // Exactly the official page's configuration:
        //   {gt, challenge, new_captcha, product:'bind', offline: !success}
        // NOTE: the official flow never calls appendTo() - v3 with product:'bind'
        // renders its own bar/popup. Calling appendTo on top of that is what left
        // the panel stuck at display:none.
        window.initGeetest({
          gt: c.gt,
          challenge: c.challenge,
          new_captcha: c.new_captcha,
          product: 'bind',
          offline: !!c.offline
        }, function (cap) {
          if (!cap) { setStatus('❌ 验证组件初始化失败', 'err'); log('callback 收到空 captcha'); return; }
          captcha = cap;
          log('captcha 已创建');
          // This is the piece that was missing: the official page calls
          // verify() INSIDE onReady to actually present the widget. Without it
          // the Geetest panel stays display:none and the user sees an empty box.
          cap.onReady(function () {
            log('onReady -> 调用 verify() 显示验证码');
            try { cap.verify(); } catch (e) { log('verify() 异常: ' + e.message); }
            setTimeout(function () {
              var p = document.querySelector('.geetest_panel');
              log('panel display=' + (p ? getComputedStyle(p).display : 'none')
                + ' size=' + (p ? p.offsetWidth + 'x' + p.offsetHeight : '0x0'));
            }, 1200);
            setStatus('请完成下方验证');
          });
          cap.onSuccess(function () {
            log('onSuccess 触发');
            var r = cap.getValidate();
            log('getValidate() = ' + JSON.stringify(r));
            if (!r || !r.geetest_validate) { setStatus('❌ 未取到验证结果，请点「重新加载验证码」再试', 'err'); return; }
            submit(r);
          });
          cap.onError(function (e) {
            log('onError: ' + JSON.stringify(e));
            setStatus('❌ ' + ((e && e.msg) || '组件报错') + '\\n点「重新加载验证码」换一道新题即可。', 'err');
          });
          cap.onClose(function () { log('onClose'); setStatus('已关闭验证，点「重新加载验证码」重试'); });
        });
      })
      .catch(function (e) {
        log('取挑战失败: ' + e.message);
        setStatus('❌ 无法获取验证挑战：' + e.message, 'err');
      });
  }

  document.getElementById('reload').addEventListener('click', function () { log('用户点击重新加载'); init(); });
  window.addEventListener('load', init);
})();
</script></body></html>`;

// ------------------------------------------------------------------ server
let settle = null;
const solvedPromise = new Promise((res) => { settle = res; });

const server = createServer((req, res) => {
  // Fresh challenge on demand - the page asks for one right before rendering the
  // widget, because a stored challenge goes stale within seconds.
  if (req.method === 'GET' && req.url.startsWith('/challenge')) {
    fetchChallenge()
      .then((c) => {
        console.log(`      [+] 页面取用新挑战 challenge=${c.challenge.slice(0, 16)}…`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          ok: true,
          gt: c.gt,
          challenge: c.challenge,
          new_captcha: c.new_captcha,
          success: c.success,
          offline: c.offline,
        }));
      })
      .catch((err) => {
        console.log(`      [!] 取挑战失败: ${err.message}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (req.method === 'POST' && req.url === '/solve') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let payload = null;
      try { payload = JSON.parse(raw); } catch { /* handled below */ }
      console.log(`\n[3/4] 收到页面提交: ${raw.slice(0, 220)}`);
      if (!payload?.geetest_validate) {
        console.log('      ✗ 缺少 geetest_validate —— 验证码没有被真正完成');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '缺少 geetest_validate，请重新完成验证码' }));
        return;
      }

      // Official verify call: POST ${geetestApi}/toolcomsrv/risk/verifyGeetest
      // body = {...getValidate(), app_key}, headers carry the challenge game/path.
      const verifyBody = {
        geetest_challenge: payload.geetest_challenge || currentChallenge,
        geetest_validate: payload.geetest_validate,
        geetest_seccode: payload.geetest_seccode || `${payload.geetest_validate}|jordan`,
        app_key: APP_KEY,
      };
      const vres = await fetch(`${GEETEST_API}/toolcomsrv/risk/verifyGeetest`, {
        method: 'POST',
        headers: riskHeaders(),
        body: JSON.stringify(verifyBody),
      });
      const verified = await vres.json().catch(() => null);
      console.log(`      verifyGeetest HTTP ${vres.status} retcode=${verified?.retcode} ${verified?.message}`);
      const xrpc = verified?.data?.challenge;
      if (!xrpc) {
        console.log('      ✗ 未拿到 challenge：', JSON.stringify(verified).slice(0, 200));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: `verifyGeetest 失败 retcode=${verified?.retcode} ${verified?.message || ''}`.trim(),
        }));
        return;
      }
      console.log(`      ✓ x-rpc-challenge = ${xrpc}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, challenge: xrpc }));
      settle(xrpc);
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(PAGE);
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const VERIFY_URL = `http://127.0.0.1:${PORT}/`;
console.log(`\n[2/4] 验证页面: ${VERIFY_URL}`);
console.log(`      调试端口 : ${CDP_PORT}  （可用 http://127.0.0.1:${CDP_PORT}/json 查看页面）`);
console.log('      页面支持「重新加载验证码」，提交失败可以重试。');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

if (CHROME) {
  spawn(CHROME, [
    `--app=${VERIFY_URL}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${ROOT}.snapref\\verify-profile`,
    '--window-size=820,760', '--no-first-run', '--no-default-browser-check',
  ], { stdio: 'ignore', detached: true }).unref();
  console.log('      已用 Chrome 打开验证页。');
} else {
  console.log('      请手动在浏览器打开上面的地址。');
}

console.log('\n等待验证完成（最多 15 分钟，可多次重试）…');
let xrpcChallenge = null;
try {
  xrpcChallenge = await Promise.race([
    solvedPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), 15 * 60 * 1000)),
  ]);
} catch (err) {
  console.error(`未完成验证：${err.message}`);
  server.close();
  process.exit(1);
}

// ------------------------------------------------------------------ verify data
console.log('\n[4/4] 用 x-rpc-challenge 拉取星铁数据 ...');
const REC = `${ORIGIN}/game_record/app/hkrpg/api`;
for (const [label, url] of [
  ['avatar/basic', `${REC}/avatar/basic?role_id=${UID}&server=${SERVER}`],
  ['index', `${REC}/index?role_id=${UID}&server=${SERVER}`],
  ['challenge', `${REC}/challenge?role_id=${UID}&server=${SERVER}&schedule_type=1`],
]) {
  const j = await signed(url, { extraHeaders: { 'x-rpc-challenge': xrpcChallenge } });
  const list = j.data?.avatar_list || j.data?.avatars || [];
  console.log(`      ${j.retcode === 0 ? '✓' : '✗'} ${label.padEnd(14)} retcode=${String(j.retcode).padEnd(7)} ${String(j.message).slice(0, 24)}`
    + (list.length ? `  → ${list.length} 个角色` : ''));
  if (list.length) console.log(`         ${list.slice(0, 8).map((a) => `${a.name} Lv.${a.level}`).join(', ')}`);
  await new Promise((r) => setTimeout(r, 2500));
}

console.log('\n提示：x-rpc-challenge 是一次性的。要在应用里用，请把它作为 x-hsr-challenge');
console.log(`      发给 POST /api/accounts/<id>/roles/${UID}/snapshot`);
server.close();
process.exit(0);
