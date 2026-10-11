// Compare Star Rail record access between the primary account and the
// secondary account ("光明火柴二号机") that the user says is their own.
//
// The point is to isolate account-specific state from client behaviour: the
// SAME code, the SAME headers, the SAME fingerprint are used for both. If the
// secondary UID returns characters while the primary returns 10035, the fault
// is in the account/service state, not in this client.
import { readFileSync } from 'node:fs';
import { createDS } from '../src/mihoyo/ds.js';
import { APP_VERSION } from '../src/mihoyo/constants.js';

const store = JSON.parse(readFileSync('data/accounts.json', 'utf8'));
const account = store.accounts[0];

const GAP = 4500;
const wait = (ms = GAP) => new Promise((r) => setTimeout(r, ms));

const cookieHeader = Object.entries(account.cookie)
  .filter(([k]) => ['cookie_token', 'ltoken', 'ltuid', 'account_id'].includes(k))
  .map(([k, v]) => `${k}=${v}`).join('; ');

const signedGet = async (path, query) => {
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
  try { return JSON.parse(text); } catch { return { retcode: res.status, message: text.slice(0, 60) }; }
};

// Unsigned-ish binding call to discover every role bound to this cookie.
const fetchRoles = async () => {
  const url = 'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie?game_biz=hkrpg_cn';
  const res = await fetch(url, {
    headers: {
      'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/${APP_VERSION}`,
      Accept: 'application/json',
      'x-rpc-app_version': APP_VERSION,
      'x-rpc-client_type': '5',
      'x-rpc-app_id': 'bll8iq97cem8',
      'x-rpc-device_id': account.deviceId,
      ...(account.fingerprint ? { 'x-rpc-device_fp': account.fingerprint } : {}),
      Cookie: cookieHeader,
    },
  });
  return res.json();
};

console.log('=================== 该 cookie 绑定的全部星铁角色 ===================');
const roles = await fetchRoles();
console.log('retcode =', roles.retcode, roles.message);
const list = roles.data?.list || [];
for (const r of list) {
  console.log(`  ${r.nickname}  uid=${r.game_uid}  region=${r.region}  Lv.${r.level}  chosen=${r.is_chosen}`);
}
if (!list.length) console.log('  (没有绑定角色)');

console.log('\n=================== 逐个角色测 index / avatar/basic ===================');
for (const r of list) {
  for (const path of ['index', 'avatar/basic']) {
    await wait();
    const j = await signedGet(path, `role_id=${r.game_uid}&server=${r.region}`);
    const mark = j.retcode === 0 ? '✓' : '✗';
    const n = (j.data?.avatars || j.data?.avatar_list || []).length;
    console.log(`  ${mark} ${r.nickname.padEnd(10)} ${String(r.game_uid).padEnd(11)} ${path.padEnd(13)} `
      + `retcode=${String(j.retcode).padEnd(7)} ${String(j.message).slice(0, 26)}${n ? ` (${n} 个角色)` : ''}`);
  }
}

console.log('\n=================== 旧快照里出现过的其他星铁 UID ===================');
const snapshotUids = Object.keys(account.snapshots || {});
console.log('  当前账号缓存过的 UID:', snapshotUids.join(', ') || '(无)');
// 100000001 was cached earlier under this store; test it as a second data point.
for (const uid of ['100000001']) {
  await wait();
  const j = await signedGet('index', `role_id=${uid}&server=prod_gf_cn`);
  const mark = j.retcode === 0 ? '✓' : '✗';
  console.log(`  ${mark} uid=${uid} index retcode=${j.retcode} ${j.message}`);
}
console.log('done');
