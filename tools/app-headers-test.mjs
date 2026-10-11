// Decisive test: replay the Star Rail record request using the REAL header set
// and REAL cookie taken from the running miHoYo app on the MuMu emulator,
// instead of this project's synthetic ones.
//
// Real values recovered from the app:
//   combo_device_fingerprint.xml -> fp = 38d81ce7d2aff
//   pre_device.xml.xml           -> device_id = 991d6a46-1ef8-337f-b1c4-ef4d2cc24792
//   WebView Local Storage        -> x-rpc-app_id = cwk gxatrexhc (NOT bll8iq97cem8)
//                                   x-rpc-device_fp = 5486385032
//                                   x-rpc-device_id = fdf4d362-db42-47bf-85ed-a4db8116a74a
//   WebView Cookies.sqlite       -> cookie_token_v2 / ltoken_v2 / ltuid_v2 / account_id_v2
//
// The point is a controlled A/B: same endpoint, same account, same network -
// only the header/cookie provenance changes.
import { readFileSync } from 'node:fs';
import { createHash, randomInt } from 'node:crypto';

const GAP = 5000;
const wait = (ms = GAP) => new Promise((r) => setTimeout(r, ms));

const UID = '107987102';
const SERVER = 'prod_gf_cn';
const APP_VERSION = '2.109.0';
const X4_SALT = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs';

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

const ds = (salt, query = '', body = '') => {
  const t = Math.floor(Date.now() / 1000);
  const r = randomInt(100001, 200001);
  return `${t},${r},${md5(`salt=${salt}&t=${t}&r=${r}&b=${body}&q=${query}`)}`;
};

// ---- material ---------------------------------------------------------------
// The Cookies DB stores the tokens under v2 names, but the record API wants them
// under the V1 names (this is exactly the quirk Snap Hutao works around: it
// sends `cookie_token=<v2 value>; ltoken=<v2 value>`). Build both spellings.
const rawApp = readFileSync('C:\\mumudump\\app-cookie.txt', 'utf8').trim();
const pick = (name) => {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(rawApp);
  return m ? m[1] : null;
};

const appCookie = [
  ['cookie_token', pick('cookie_token_v2') || pick('cookie_token')],
  ['ltoken', pick('ltoken_v2') || pick('ltoken')],
  ['ltuid', pick('ltuid_v2') || '76090888'],
  ['account_id', pick('account_id_v2') || '76090888'],
  ['ltmid_v2', pick('ltmid_v2')],
].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');

const appCookieV2 = rawApp;

const project = JSON.parse(readFileSync('data/accounts.json', 'utf8')).accounts[0];
const projectCookie = Object.entries(project.cookie)
  .filter(([k]) => ['cookie_token', 'ltoken', 'ltuid', 'account_id'].includes(k))
  .map(([k, v]) => `${k}=${v}`).join('; ');

// Values read out of the emulator.
const APP = {
  cookie: appCookie,
  deviceId: 'fdf4d362-db42-47bf-85ed-a4db8116a74a',
  deviceFp: '5486385032',
  appId: 'cwk gxatrexhc',
  appVersion: '3.0.0',
  sdkVersion: '2.5.1',
  deviceModel: 'Android Browser 4.0',
  deviceName: 'Android Browser',
  deviceOs: 'Android 12',
  gameBiz: 'hk4e_cn',
};

const PROJECT = {
  cookie: projectCookie,
  deviceId: project.deviceId,
  deviceFp: project.fingerprint,
};

const call = async (variant, path, query) => {
  const headers = {
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/${APP_VERSION}`,
    Accept: 'application/json',
    'x-rpc-app_version': variant.appVersion || APP_VERSION,
    'x-rpc-client_type': '5',
    'x-rpc-device_id': variant.deviceId,
    ...(variant.deviceFp ? { 'x-rpc-device_fp': variant.deviceFp } : {}),
    ...(variant.appId ? { 'x-rpc-app_id': variant.appId } : {}),
    ...(variant.sdkVersion ? { 'x-rpc-sdk_version': variant.sdkVersion } : {}),
    ...(variant.deviceModel ? { 'x-rpc-device_model': encodeURIComponent(variant.deviceModel) } : {}),
    ...(variant.deviceName ? { 'x-rpc-device_name': encodeURIComponent(variant.deviceName) } : {}),
    ...(variant.deviceOs ? { 'x-rpc-device_os': encodeURIComponent(variant.deviceOs) } : {}),
    ...(variant.gameBiz ? { 'x-rpc-game_biz': variant.gameBiz } : {}),
    Referer: 'https://webstatic.mihoyo.com',
    'x-rpc-page': `${APP_VERSION}_#/rpg/roles`,
    Cookie: variant.cookie,
    DS: ds(X4_SALT, query),
  };
  const res = await fetch(
    `https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/${path}?${query}`,
    { headers },
  );
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { retcode: res.status, message: text.slice(0, 70) }; }
};

const run = async (label, variant, path, query) => {
  await wait();
  const j = await call(variant, path, query);
  const mark = j.retcode === 0 ? '✓' : '✗';
  const list = j.data?.avatars || j.data?.avatar_list || [];
  console.log(`  ${mark} ${label.padEnd(44)} retcode=${String(j.retcode).padEnd(7)} `
    + `${String(j.message).slice(0, 28)}${list.length ? `  → ${list.length} 个角色!` : ''}`);
  if (list.length) {
    console.log(`      ${list.slice(0, 8).map((a) => a.name || a.id).join(', ')}`);
  }
  return j;
};

console.log('=== cookie 来源 ===');
console.log(`  App(v1 名 + v2 值): ${appCookie.slice(0, 70)}…`);
console.log(`  App(v2 名)        : ${appCookieV2.slice(0, 70)}…`);
console.log(`  本项目            : ${projectCookie.slice(0, 70)}…`);

console.log('\n=== A) 项目现有配置（对照组）===');
await run('项目 cookie + 项目头 + index', { ...PROJECT }, 'index', `role_id=${UID}&server=${SERVER}`);

console.log('\n=== B) App 新鲜 token 值 + v1 名 + 项目头 ===');
await run('App(v1名) + 项目头 + index', { ...PROJECT, cookie: appCookie }, 'index', `role_id=${UID}&server=${SERVER}`);
await run('App(v1名) + 项目头 + avatar/basic', { ...PROJECT, cookie: appCookie }, 'avatar/basic', `role_id=${UID}&server=${SERVER}`);

console.log('\n=== C) App 新鲜 token + App 真实头 ===');
await run('App(v1名) + App 头 + index', { ...APP, cookie: appCookie }, 'index', `role_id=${UID}&server=${SERVER}`);
await run('App(v1名) + App 头 + avatar/basic', { ...APP, cookie: appCookie }, 'avatar/basic', `role_id=${UID}&server=${SERVER}`);
await run('App(v1名) + App 头 + role/basicInfo', { ...APP, cookie: appCookie }, 'role/basicInfo', `role_id=${UID}&server=${SERVER}`);

console.log('\n=== D) App 新鲜 token + App 真实头 + App 自己的 fp ===');
await run('App(v1名) + App头 + index (fp=5486385032)', { ...APP, cookie: appCookie, deviceFp: APP.deviceFp }, 'index', `role_id=${UID}&server=${SERVER}`);
await run('App(v1名) + App头 + avatar/basic (fp=5486385032)', { ...APP, cookie: appCookie, deviceFp: APP.deviceFp }, 'avatar/basic', `role_id=${UID}&server=${SERVER}`);

console.log('\ndone');
