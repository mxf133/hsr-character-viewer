// Isolate one variable on Star Rail: does `x-rpc-device_fp` change the answer?
//
// The parity sweep showed `index` returning 10001 "Please login" WITHOUT the
// fingerprint and 10035 (a real business error) WITH it - on a cookie that is
// demonstrably valid (role/basicInfo and rogue both succeed). That suggests
// 10001 here is not an auth failure but a missing-header failure.
import { readFileSync } from 'node:fs';
import { createDS } from '../src/mihoyo/ds.js';
import { APP_VERSION } from '../src/mihoyo/constants.js';

const account = JSON.parse(readFileSync('data/accounts.json', 'utf8')).accounts[0];
const UID = '107987102';
const SERVER = 'prod_gf_cn';
const GAP = 4000;
const wait = (ms = GAP) => new Promise((r) => setTimeout(r, ms));

const cookieHeader = Object.entries(account.cookie)
  .filter(([k]) => ['cookie_token', 'ltoken', 'ltuid', 'account_id'].includes(k))
  .map(([k, v]) => `${k}=${v}`).join('; ');

/** One signed GET; `variant` selects which headers differ. */
const call = async (path, { withFp, withAppId }) => {
  const query = `role_id=${UID}&server=${SERVER}`;
  const headers = {
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/${APP_VERSION}`,
    Accept: 'application/json',
    'x-rpc-app_version': APP_VERSION,
    'x-rpc-client_type': '5',
    'x-rpc-device_id': account.deviceId,
    Referer: 'https://webstatic.mihoyo.com',
    'x-rpc-page': `${APP_VERSION}_#/sr`,
    Cookie: cookieHeader,
    DS: createDS({ query }),
  };
  if (withFp) headers['x-rpc-device_fp'] = account.fingerprint;
  if (withAppId) headers['x-rpc-app_id'] = 'bll8iq97cem8';

  const res = await fetch(
    `https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/${path}?${query}`,
    { headers },
  );
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON means we hit a path that does not exist (e.g. "404 page not found").
    return { retcode: res.status, message: `非 JSON 响应：${text.slice(0, 40)}` };
  }
};

const show = async (label, path, opts) => {
  await wait();
  const json = await call(path, opts);
  const record = json.retcode === 0 ? '✓' : '✗';
  console.log(`  ${record} ${label.padEnd(38)} retcode=${String(json.retcode).padEnd(7)} ${json.message}`);
  return json;
};

console.log(`cookie 有效（role/basicInfo 之前成功），device_fp = ${account.fingerprint ? '有' : '无'}`);
console.log('\n=== 对照组：已知能成功的端点 ===');
await show('role/basicInfo  带指纹', 'role/basicInfo', { withFp: true });
await show('rogue           带指纹', 'rogue', { withFp: true });

console.log('\n=== 实验组：角色相关端点（只变指纹这一个变量）===');
await show('index           不带指纹', 'index', { withFp: false });
await show('index           带指纹', 'index', { withFp: true });
await show('avatar/info     不带指纹', 'avatar/info', { withFp: false });
await show('avatar/info     带指纹', 'avatar/info', { withFp: true });
await show('avatar/basic    带指纹', 'avatar/basic', { withFp: true });

console.log('\ndone');
