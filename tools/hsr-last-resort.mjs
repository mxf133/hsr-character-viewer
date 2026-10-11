// Last round of Star Rail variations, plus a stability check.
//
// Everything already ruled out (each verified with the same cookie, where
// role/basicInfo returns 0):
//   x-rpc-device_fp .......... required (without it -> 10041)
//   x-rpc-page route ......... no effect
//   x-rpc-device_name ........ no effect
//   x-rpc-sys_version ........ no effect
//   x-rpc-platform ........... no effect
//   app_version 2.3.0 + fallback salts -> -10001 (wrong signature)
//   server / region .......... matches the binding API and record card exactly
//
// Still untested: x-rpc-app_id, the oversea host, and plain repetition.
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

const call = async (path, query, extra = {}, host = 'https://api-takumi-record.mihoyo.com') => {
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
    DS: createDS({ query }),
    ...extra,
  };
  const res = await fetch(`${host}/game_record/app/hkrpg/api/${path}?${query}`, { headers });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { retcode: res.status, message: text.slice(0, 60) }; }
};

const run = async (label, path, query, extra, host) => {
  await wait();
  const j = await call(path, query, extra, host);
  const mark = j.retcode === 0 ? '✓' : '✗';
  const n = (j.data?.avatars || j.data?.avatar_list || []).length;
  console.log(`  ${mark} ${label.padEnd(46)} retcode=${String(j.retcode).padEnd(7)} ${String(j.message).slice(0, 30)}${n ? ` (${n})` : ''}`);
  return j;
};

const Q = `role_id=${UID}&server=${SERVER}`;

console.log('=== 稳定性：index 连续 4 次 ===');
for (let i = 1; i <= 4; i += 1) await run(`index 第 ${i} 次`, 'index', Q);

console.log('\n=== 加 x-rpc-app_id ===');
await run('avatar/basic + app_id', 'avatar/basic', Q, { 'x-rpc-app_id': 'bll8iq97cem8' });

console.log('\n=== 加 x-rpc-language / x-rpc-lang ===');
await run('avatar/basic + x-rpc-language', 'avatar/basic', Q, { 'x-rpc-language': 'zh-cn' });
await run('avatar/basic + x-rpc-lang', 'avatar/basic', Q, { 'x-rpc-lang': 'zh-cn' });

console.log('\n=== 国际服 host 试一下（预期不行，仅为排除）===');
await run('avatar/basic @ bbs-api-os', 'avatar/basic', Q, {}, 'https://bbs-api-os.hoyolab.com');

console.log('\n=== role/basicInfo 返回的数据结构（对照为何它能通）===');
await wait();
const bi = await call('role/basicInfo', Q);
console.log('  retcode =', bi.retcode);
console.log('  data    =', JSON.stringify(bi.data));

console.log('\n=== index 的原始完整响应（含空 message 的细节）===');
await wait();
const idx = await call('index', Q);
console.log('  ', JSON.stringify(idx).slice(0, 400));

console.log('\ndone');
