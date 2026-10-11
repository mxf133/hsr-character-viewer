// Test the OFFICIAL Star Rail risk-verification endpoints (not Snap Hutao's
// Genshin path).
//
// Recovered from the page's own environment module:
//   geetestApi = "https://api-takumi.mihoyo.com/event"
// and its two calls:
//   createVerify -> POST ${geetestApi}/toolcomsrv/risk/createGeetest
//                   body {is_high:true, app_key:"hkrpg_game_record"}
//                   headers {x-rpc-challenge_game, x-rpc-challenge_path, x-rpc-challenge_trace}
//   verify       -> POST ${geetestApi}/toolcomsrv/risk/verifyGeetest
//                   body {...getValidate(), app_key:"hkrpg_game_record"}
//                   -> response.challenge  (this becomes x-rpc-challenge)
import { readFileSync } from 'node:fs';
import { createDS } from '../src/mihoyo/ds.js';
import { APP_VERSION } from '../src/mihoyo/constants.js';

const account = JSON.parse(readFileSync('data/accounts.json', 'utf8')).accounts[0];
const GS = 'https://api-takumi.mihoyo.com/event';
const UID = '170556517';
const RECORD_PATH = '/game_record/app/hkrpg/api/avatar/basic';

const cookieHeader = Object.entries(account.cookie)
  .filter(([k]) => ['cookie_token', 'ltoken', 'ltuid', 'account_id'].includes(k))
  .map(([k, v]) => `${k}=${v}`).join('; ');

const post = async (url, body, extraHeaders = {}, method = 'POST') => {
  const headers = {
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/${APP_VERSION}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-rpc-app_version': APP_VERSION,
    'x-rpc-client_type': '5',
    'x-rpc-device_id': account.deviceId,
    ...(account.fingerprint ? { 'x-rpc-device_fp': account.fingerprint } : {}),
    Referer: 'https://webstatic.mihoyo.com',
    'x-rpc-page': `${APP_VERSION}_#/rpg/roles`,
    Cookie: cookieHeader,
    ...extraHeaders,
  };
  const res = await fetch(url, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const traceId = res.headers.get('x-trace-id');
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: res.status, json, text: text.slice(0, 300), traceId };
};

// Module 7's `a` helper is the GET path (a POST returned 405), and the page
// passes its payload as query parameters.
const qs = new URLSearchParams({ is_high: 'true', app_key: 'hkrpg_game_record' });
console.log('=== 官方路径: GET /event/toolcomsrv/risk/createGeetest ===');
const create = await post(`${GS}/toolcomsrv/risk/createGeetest?${qs}`, null,
  {
    'x-rpc-challenge_game': '6',
    'x-rpc-challenge_path': RECORD_PATH,
  }, 'GET');
console.log(`HTTP ${create.status}  x-trace-id=${create.traceId || '(无)'}`);
console.log(JSON.stringify(create.json, null, 2) || create.text);

const d = create.json?.data || create.json;
console.log('\n=== 判读 ===');
console.log('  retcode   =', create.json?.retcode, create.json?.message);
console.log('  gt        =', d?.gt);
console.log('  challenge =', String(d?.challenge).slice(0, 40));
console.log('  success   =', d?.success);
console.log('  new_captcha =', d?.new_captcha);

if (d?.gt) {
  console.log('\n结论：官方 createGeetest 可用（不需要 card/wapi）。');
  console.log('      gt 为 32 位 v3 标识 -> 用 gt.0.4.9.js + initGeetest。');
  console.log('      拿到 getValidate() 后 POST /event/toolcomsrv/risk/verifyGeetest，');
  console.log('      body 为 {...validate, app_key:"hkrpg_game_record"}，');
  console.log('      响应里的 challenge 就是后续记录接口要的 x-rpc-challenge。');
} else {
  console.log('\n未拿到 gt，原始返回：');
  console.log(create.text);
}
