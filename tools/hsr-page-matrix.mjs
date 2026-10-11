// Star Rail header matrix.
//
// Reason for this: the official record page sets, per request,
//     x-rpc-page         = "<toolVersion>_" + window.location.hash
//     x-rpc-tool_verison = "<toolVersion>"
// i.e. the route you are ON is part of the request. This client has always sent
// a single generic "#/sr" for every endpoint.
//
// The same bundle also hard-codes a salt used when running outside the miHoYo
// app WebView: md5("h8w582wxwgqvahcdkpvdhbh2w9casgfl") with app_version 2.3.0
// and client_type 5, and no x-rpc-platform.
//
// This probe walks every combination to find which one the API accepts.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const account = JSON.parse(readFileSync('data/accounts.json', 'utf8')).accounts[0];
const UID = '107987102';
const SERVER = 'prod_gf_cn';
const GAP = 4000;
const wait = (ms = GAP) => new Promise((r) => setTimeout(r, ms));

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

/** DS2 with an arbitrary salt (the X4 shape). */
const ds = (salt, query) => {
  const t = Math.floor(Date.now() / 1000);
  const r = Math.floor(Math.random() * 900000) + 100000;
  return `${t},${r},${md5(`salt=${salt}&t=${t}&r=${r}&b=&q=${query}`)}`;
};

const X4_SALT = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs';
// From the bundle: md5 of this constant is the fallback salt value.
const FALLBACK_SALT_SOURCE = 'h8w582wxwgqvahcdkpvdhbh2w9casgfl';

const cookieHeader = Object.entries(account.cookie)
  .filter(([k]) => ['cookie_token', 'ltoken', 'ltuid', 'account_id'].includes(k))
  .map(([k, v]) => `${k}=${v}`).join('; ');

const call = async (path, query, variant) => {
  const headers = {
    Accept: 'application/json',
    Cookie: cookieHeader,
    Referer: 'https://webstatic.mihoyo.com',
    DS: ds(variant.salt || X4_SALT, query),
    ...variant.headers,
  };
  const url = `https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/${path}?${query}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { retcode: res.status, message: text.slice(0, 50) }; }
};

const run = async (label, path, query, variant) => {
  await wait();
  const json = await call(path, query, variant);
  const mark = json.retcode === 0 ? '✓' : '✗';
  console.log(`  ${mark} ${label.padEnd(52)} retcode=${String(json.retcode).padEnd(7)} ${String(json.message).slice(0, 40)}`);
  return json;
};

const Q = `role_id=${UID}&server=${SERVER}`;
const fp = account.fingerprint;
const did = account.deviceId;

const base = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/2.109.0',
  'x-rpc-app_version': '2.109.0',
  'x-rpc-client_type': '5',
  'x-rpc-device_id': did,
  ...(fp ? { 'x-rpc-device_fp': fp } : {}),
};

console.log('=================== A) x-rpc-page 用页面对应路由 ===================');
await run('index         page=#/rpg', 'index', Q, { headers: { ...base, 'x-rpc-page': '2.109.0_#/rpg' } });
await run('index         page=#/rpg/roles', 'index', Q, { headers: { ...base, 'x-rpc-page': '2.109.0_#/rpg/roles' } });
await run('index         page=#/', 'index', Q, { headers: { ...base, 'x-rpc-page': '2.109.0_#/' } });
await run('index         不带 page', 'index', Q, { headers: { ...base } });

console.log('\n=================== B) avatar/basic 各路由 ===================');
for (const page of ['#/rpg/roles', '#/rpg/role', '#/rpg', '#/']) {
  await run(`avatar/basic  page=${page}`, 'avatar/basic', Q, {
    headers: { ...base, 'x-rpc-page': `2.109.0_${page}` },
  });
}

console.log('\n=================== C) 补上缺失的头 ===================');
await run('avatar/basic + device_name/sys_version', 'avatar/basic', Q, {
  headers: {
    ...base,
    'x-rpc-page': '2.109.0_#/rpg/roles',
    'x-rpc-device_name': encodeURIComponent('DESKTOP-ABC'),
    'x-rpc-sys_version': encodeURIComponent('Windows 11'),
    'x-rpc-platform': '5',
    'x-rpc-tool_verison': 'v4.6.0',
  },
});

console.log('\n=================== D) 纯浏览器兜底配方（app_version 2.3.0）===================');
const fallbackBase = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  'x-rpc-app_version': '2.3.0',
  'x-rpc-client_type': '5',
  'x-rpc-device_id': did,
  'x-rpc-page': '2.3.0_#/rpg/roles',
};
for (const [label, salt] of [
  ['md5(常量) 作为 salt', md5(FALLBACK_SALT_SOURCE)],
  ['常量本身作为 salt', FALLBACK_SALT_SOURCE],
  ['X4 salt', X4_SALT],
]) {
  await run(`avatar/basic 2.3.0 — ${label}`, 'avatar/basic', Q, { headers: fallbackBase, salt });
}

console.log('\n=================== E) 已知成功的端点做对照 ===================');
await run('role/basicInfo page=#/rpg/roles', 'role/basicInfo', Q, {
  headers: { ...base, 'x-rpc-page': '2.109.0_#/rpg/roles' },
});
await run('avatar/info page=#/rpg/role', 'avatar/info', Q, {
  headers: { ...base, 'x-rpc-page': '2.109.0_#/rpg/role' },
});

console.log('\ndone');
