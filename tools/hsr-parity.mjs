// Star Rail diagnosis, mirroring the Genshin method step for step.
//
// Genshin needed three things: the device fingerprint, the official client
// User-Agent, and (crucially) for the temporary risk-control flag to expire.
// This probe replays Star Rail the same way and reports, per endpoint, whether
// the fingerprint changes anything.
//
//   node tools/hsr-parity.mjs
import { readFileSync } from 'node:fs';
import * as sr from '../src/mihoyo/starrail.js';
import { APP_VERSION } from '../src/mihoyo/constants.js';

const account = JSON.parse(readFileSync('data/accounts.json', 'utf8')).accounts[0];
const UID = '100000000';
const SERVER = 'prod_gf_cn';

const base = {
  cookie: account.cookie,
  deviceId: account.deviceId,
  accountId: account.accountId,
};

const wait = (ms = 3000) => new Promise((r) => setTimeout(r, ms));

const probe = async (label, options, fn) => {
  await wait();
  try {
    const v = await fn(options);
    console.log(`  ✓ ${label.padEnd(34)} ${v}`);
    return 'ok';
  } catch (err) {
    console.log(`  ✗ ${label.padEnd(34)} retcode=${err.retcode} ${err.message.replace(/^.*failure/, '')}`);
    return err.retcode;
  }
};

/** Raw signed call, so headers can be varied one at a time. */
const rawCall = async (path, query = {}, extraHeaders = {}, method = 'GET', body) => {
  const entries = Object.entries(query);
  const q = entries.map(([k, v]) => `${k}=${v}`).join('&');
  const url = `https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/${path}`
    + (q ? `?${q}` : '');
  const { createDS } = await import('../src/mihoyo/ds.js');
  const headers = {
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/${APP_VERSION}`,
    Accept: 'application/json',
    'x-rpc-app_version': APP_VERSION,
    'x-rpc-client_type': '5',
    'x-rpc-device_id': account.deviceId,
    Referer: 'https://webstatic.mihoyo.com',
    'x-rpc-page': `${APP_VERSION}_#/sr`,
    Cookie: Object.entries(account.cookie)
      .filter(([k]) => ['cookie_token', 'ltoken', 'ltuid', 'account_id'].includes(k))
      .map(([k, v]) => `${k}=${v}`).join('; '),
    DS: createDS({ query: q, body }),
    ...extraHeaders,
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (json.retcode !== 0) {
    throw Object.assign(new Error(json.message || ''), { retcode: json.retcode });
  }
  return json.data;
};

console.log(`设备指纹: ${account.fingerprint ? `${account.fingerprint.slice(0, 6)}…（已缓存）` : '(无)'}`);
console.log(`device_id: ${account.deviceId}`);

console.log('\n================ A) 不带指纹 ================');
await probe('index', {}, (o) => sr.getPlayerIndex(UID, SERVER, o).then((d) => `${d?.role?.nickname}`));
await probe('avatar/basic', {}, (o) => rawCall('avatar/basic', { role_id: UID, server: SERVER })
  .then((d) => `${(d?.avatars || []).length} 个角色`));
await probe('avatar/info', {}, (o) => sr.getAvatarInfo(UID, SERVER, o).then((d) => `${(d?.avatars || []).length} 条`));

console.log('\n================ B) 带设备指纹 ================');
const withFp = { ...base, deviceFp: account.fingerprint };
await probe('index', withFp, (o) => sr.getPlayerIndex(UID, SERVER, o).then((d) => `${d?.role?.nickname}`));
await probe('avatar/basic', withFp, (o) => rawCall(
  'avatar/basic',
  { role_id: UID, server: SERVER },
  { 'x-rpc-device_fp': account.fingerprint },
).then((d) => `${(d?.avatars || []).length} 个角色`));
await probe('avatar/info', withFp, (o) => sr.getAvatarInfo(UID, SERVER, o).then((d) => `${(d?.avatars || []).length} 条`));

console.log('\n================ C) 换端点：角色列表是否另有其路 ================');
for (const [label, path] of [
  ['avatar/basic', 'avatar/basic'],
  ['avatar/info (GET)', 'avatar/info'],
  ['index', 'index'],
  ['role/basicInfo', 'role/basicInfo'],
  ['rogue', 'rogue'],
]) {
  await probe(`${label}`, {}, () => rawCall(path, { role_id: UID, server: SERVER })
    .then((d) => {
      const n = (d?.avatars || d?.avatar_list || []).length;
      return n ? `${n} 项` : `字段: ${Object.keys(d || {}).join(',')}`;
    }));
}

console.log('\n================ D) 换成 uid+region 参数（部分接口用另一套）================');
await probe('avatar/basic (uid/region)', {}, () => rawCall(
  'avatar/basic',
  { uid: UID, region: SERVER },
).then((d) => `${(d?.avatars || []).length} 个角色`));

console.log('\ndone');
