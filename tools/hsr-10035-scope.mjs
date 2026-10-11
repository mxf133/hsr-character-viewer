// Narrow down what actually triggers 10035 on Star Rail.
//
// Established so far:
//   * without x-rpc-device_fp  -> 10041 ("当前账号存在风险" per the official map)
//   * with    x-rpc-device_fp  -> 10035
//   * x-rpc-page / device_name / sys_version / platform make NO difference
//   * role/basicInfo and rogue succeed; index / avatar/basic / avatar/info do not
//   * the official page defines 10035 as a constant but ships NO message for it
//
// The open question: is 10035 about the ROLE, or about the ACCOUNT's record
// visibility? Test with the SAME cookie against a different UID - if another
// player's UID also answers 10035, it is not our own privacy switch.
import { readFileSync } from 'node:fs';
import { createDS } from '../src/mihoyo/ds.js';
import { APP_VERSION } from '../src/mihoyo/constants.js';

const account = JSON.parse(readFileSync('data/accounts.json', 'utf8')).accounts[0];
const GAP = 4500;
const wait = (ms = GAP) => new Promise((r) => setTimeout(r, ms));

const cookieHeader = Object.entries(account.cookie)
  .filter(([k]) => ['cookie_token', 'ltoken', 'ltuid', 'account_id'].includes(k))
  .map(([k, v]) => `${k}=${v}`).join('; ');

const call = async (path, query) => {
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
  };
  const res = await fetch(
    `https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/${path}?${query}`,
    { headers },
  );
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { retcode: res.status, message: text.slice(0, 50) }; }
};

const run = async (label, path, query) => {
  await wait();
  const j = await call(path, query);
  const mark = j.retcode === 0 ? '✓' : '✗';
  const extra = j.retcode === 0
    ? ` avatars=${(j.data?.avatars || j.data?.avatar_list || []).length}`
    : '';
  console.log(`  ${mark} ${label.padEnd(46)} retcode=${String(j.retcode).padEnd(7)} ${j.message}${extra}`);
  return j;
};

console.log('=== 自己的 UID（官服 prod_gf_cn）===');
await run('role/basicInfo', 'role/basicInfo', 'role_id=100000000&server=prod_gf_cn');
await run('index', 'index', 'role_id=100000000&server=prod_gf_cn');
await run('avatar/basic', 'avatar/basic', 'role_id=100000000&server=prod_gf_cn');

console.log('\n=== 换成别人的 UID（验证 10035 是否与“我的”隐私有关）===');
// A well-known public Star Rail CN UID used by community tools for smoke tests.
for (const otherUid of ['101234567', '100000001']) {
  await run(`avatar/basic uid=${otherUid}`, 'avatar/basic', `role_id=${otherUid}&server=prod_gf_cn`);
}

console.log('\n=== 不存在的 UID（对照：错误码会不会不同）===');
await run('avatar/basic uid=1', 'avatar/basic', 'role_id=1&server=prod_gf_cn');
await run('avatar/basic uid=999999999', 'avatar/basic', 'role_id=999999999&server=prod_gf_cn');

console.log('\n=== 换 B 服 server（看是否 server 参数问题）===');
await run('avatar/basic server=prod_qd_cn', 'avatar/basic', 'role_id=100000000&server=prod_qd_cn');

console.log('\n=== 其它能通的端点做对照 ===');
await run('note（实时便笺）', 'note', 'role_id=100000000&server=prod_gf_cn');
await run('achievement', 'achievement', 'role_id=100000000&server=prod_gf_cn');
await run('challenge', 'challenge', 'role_id=100000000&server=prod_gf_cn&schedule_type=1');

console.log('\ndone');
