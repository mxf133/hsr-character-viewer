// Confirm createGeetest returns an `x-trace-id` response header, and that
// threading it back as `x-rpc-challenge_trace` is what verifyGeetest needs.
//
// The official page does exactly this:
//   l = {"x-rpc-challenge_game":…, "x-rpc-challenge_path":…,
//        "x-rpc-challenge_trace": resp.headers["x-trace-id"]}
// and passes `l` to BOTH createGeetest and verifyGeetest.
import { readFileSync } from 'node:fs';
import { APP_VERSION } from '../src/mihoyo/constants.js';

const account = JSON.parse(readFileSync('data/accounts.json', 'utf8')).accounts[0];
const GS = 'https://api-takumi.mihoyo.com/event';
const PATH = '/game_record/app/hkrpg/api/avatar/basic';

const cookieHeader = Object.entries(account.cookie)
  .filter(([k]) => ['cookie_token', 'ltoken', 'ltuid', 'account_id'].includes(k))
  .map(([k, v]) => `${k}=${v}`).join('; ');

const baseHeaders = (trace) => ({
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/${APP_VERSION}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'x-rpc-app_version': APP_VERSION,
  'x-rpc-client_type': '5',
  'x-rpc-device_id': account.deviceId,
  ...(account.fingerprint ? { 'x-rpc-device_fp': account.fingerprint } : {}),
  Referer: 'https://webstatic.mihoyo.com',
  'x-rpc-page': `${APP_VERSION}_#/rpg/roles`,
  'x-rpc-challenge_game': '6',
  'x-rpc-challenge_path': PATH,
  ...(trace ? { 'x-rpc-challenge_trace': trace } : {}),
  Cookie: cookieHeader,
});

const qs = new URLSearchParams({ is_high: 'true', app_key: 'hkrpg_game_record' });
const res = await fetch(`${GS}/toolcomsrv/risk/createGeetest?${qs}`, {
  headers: baseHeaders(null),
});
const trace = res.headers.get('x-trace-id');
const json = await res.json();

console.log('=== createGeetest ===');
console.log('HTTP       :', res.status);
console.log('x-trace-id :', trace || '(缺失!)');
console.log('retcode    :', json.retcode, json.message);
console.log('gt         :', json.data?.gt);
console.log('challenge  :', String(json.data?.challenge).slice(0, 32));

console.log('\n=== 所有响应头 ===');
for (const [k, v] of res.headers.entries()) console.log(`  ${k}: ${v}`);

console.log('\n=== verifyGeetest 探测：不带 trace（用假 validate 看错误差异）===');
const probe = async (label, traceValue, ch) => {
  const r = await fetch(`${GS}/toolcomsrv/risk/verifyGeetest`, {
    method: 'POST',
    headers: baseHeaders(traceValue),
    body: JSON.stringify({
      geetest_challenge: ch || json.data?.challenge,
      geetest_validate: '00000000000000000000000000000000',
      geetest_seccode: '00000000000000000000000000000000|jordan',
      app_key: 'hkrpg_game_record',
    }),
  });
  const j = await r.json().catch(() => null);
  console.log(`  ${label.padEnd(30)} HTTP ${r.status} retcode=${j?.retcode} ${String(j?.message).slice(0, 40)}`);
  return j;
};

await probe('不带 trace', null, json.data?.challenge);
await probe('带 trace', trace, json.data?.challenge);

console.log('\n说明：假 validate 一定是失败的，但两次的错误码/文案差异可以看出');
console.log('      trace 是否参与校验（相同则说明服务端先校验 validate）。');
