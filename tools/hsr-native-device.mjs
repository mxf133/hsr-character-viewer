// Last untried variable: the device identity the NATIVE app uses.
//
// Everything else has been ruled out by experiment. The one value never used
// against the record API is the native app's own device identity, recovered from
// the MuMu emulator:
//
//   /data/data/com.mihoyo.hyperion/shared_prefs/pre_device.xml.xml
//       device_id        = 991d6a46-1ef8-337f-b1c4-ef4d2cc24792   (UUIDv5 shaped)
//       device_id_suffix = efb6b56fb82c9f7d1db55d3f5ab8a749
//       device_id_mock   = 4995e005-f904-4537-8355-74f829b99cbc
//   /data/data/.../shared_prefs/combo_device_fingerprint.xml
//       fp = 38d81ce7d2aff
//
// This project has been sending a randomly generated UUIDv4 for x-rpc-device_id.
// If the server binds the verification/anti-abuse state to the device that
// actually plays the game, a synthetic id would never match.
import { readFileSync } from 'node:fs';
import { createDS } from '../src/mihoyo/ds.js';
import { APP_VERSION } from '../src/mihoyo/constants.js';

const account = JSON.parse(readFileSync('data/accounts.json', 'utf8')).accounts[0];
const UID = '100000000';
const SERVER = 'prod_gf_cn';
const GAP = 5000;
const wait = (ms = GAP) => new Promise((r) => setTimeout(r, ms));

const cookieHeader = Object.entries(account.cookie)
  .filter(([k]) => ['cookie_token', 'ltoken', 'ltuid', 'account_id'].includes(k))
  .map(([k, v]) => `${k}=${v}`).join('; ');

const APP_DEVICE_ID = '991d6a46-1ef8-337f-b1c4-ef4d2cc24792';
const APP_FP = '38d81ce7d2aff';

const call = async (path, query, variant) => {
  const headers = {
    'User-Agent': `Mozilla/5.0 (Linux; Android 12) miHoYoBBS/${APP_VERSION}`,
    Accept: 'application/json',
    'x-rpc-app_version': APP_VERSION,
    'x-rpc-client_type': '5',
    'x-rpc-device_id': variant.deviceId,
    ...(variant.fp ? { 'x-rpc-device_fp': variant.fp } : {}),
    ...(variant.deviceName ? { 'x-rpc-device_name': variant.deviceName } : {}),
    ...(variant.sysVersion ? { 'x-rpc-sys_version': variant.sysVersion } : {}),
    Referer: 'https://webstatic.mihoyo.com',
    'x-rpc-page': `${APP_VERSION}_#/rpg/roles`,
    Cookie: cookieHeader,
    DS: createDS({ query }),
  };
  const res = await fetch(
    `https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/${path}?${query}`,
    { headers },
  );
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { retcode: res.status, message: text.slice(0, 50) }; }
};

const run = async (label, variant, path = 'index') => {
  await wait();
  const j = await call(path, `role_id=${UID}&server=${SERVER}`, variant);
  const mark = j.retcode === 0 ? '✓' : '✗';
  const n = (j.data?.avatar_list || []).length;
  console.log(`  ${mark} ${label.padEnd(46)} retcode=${String(j.retcode).padEnd(7)} `
    + `${String(j.message).slice(0, 22)}${n ? `  → ${n} 个角色` : ''}`);
  return j;
};

console.log('=== A) 项目自己生成的 device_id（对照，已知 10035）===');
await run('合成 uuid + 服务器指纹', { deviceId: account.deviceId, fp: account.fingerprint });

console.log('\n=== B) App 原生的 device_id + fp ===');
await run('App device_id + App fp', { deviceId: APP_DEVICE_ID, fp: APP_FP });

console.log('\n=== C) App 原生 device_id + App fp + Android 设备头 ===');
await run('App 全套设备身份', {
  deviceId: APP_DEVICE_ID,
  fp: APP_FP,
  deviceName: 'ALN-AL00',
  sysVersion: 'Android 12',
});

console.log('\n=== D) 同一套身份测 role/basicInfo 与 index ===');
await run('App 身份 role/basicInfo', { deviceId: APP_DEVICE_ID, fp: APP_FP }, 'role/basicInfo');
await run('App 身份 avatar/basic', { deviceId: APP_DEVICE_ID, fp: APP_FP }, 'avatar/basic');

console.log('\n=== E) 小号 UID 170556517（App 身份）===');
await wait();
const alt = await call('index', 'role_id=170556517&server=prod_gf_cn', { deviceId: APP_DEVICE_ID, fp: APP_FP });
console.log(`  ${alt.retcode === 0 ? '✓' : '✗'} 小号 index  retcode=${alt.retcode} ${String(alt.message).slice(0, 30)}`
  + (alt.retcode === 0 ? `  → ${(alt.data?.avatar_list || []).length} 个角色` : ''));

console.log('\ndone');
