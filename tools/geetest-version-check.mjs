// Which Geetest version does miHoYo expect for this challenge?
//
// Evidence that v4 is wrong: gt4.js immediately fires onSuccess with
//   getValidate() = {lot_number:"000000cabf…", gen_time:1623828054, isOffline:true}
// - a canned OFFLINE result, not a solved puzzle - and its fields
// (lot_number/captcha_output/pass_token) are not what verifyVerification wants
// (geetest_challenge/geetest_validate/geetest_seccode).
//
// This dumps the full createVerification payload to look for a version hint and
// compares the two Geetest entry points.
import { readFileSync } from 'node:fs';
import { createDS } from '../src/mihoyo/ds.js';
import { APP_VERSION } from '../src/mihoyo/constants.js';

const account = JSON.parse(readFileSync('data/accounts.json', 'utf8')).accounts[0];
const ORIGIN = 'https://api-takumi-record.mihoyo.com';
const CARD = `${ORIGIN}/game_record/card/wapi`;

const cookieHeader = Object.entries(account.cookie)
  .filter(([k]) => ['cookie_token', 'ltoken', 'ltuid', 'account_id'].includes(k))
  .map(([k, v]) => `${k}=${v}`).join('; ');

const signed = async (url, extraHeaders = {}, method = 'GET', body) => {
  const query = url.includes('?') ? url.split('?')[1] : '';
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
    DS: createDS({ query, body }),
    ...extraHeaders,
  };
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  try { return { status: res.status, json: JSON.parse(t) }; } catch { return { status: res.status, json: null, text: t.slice(0, 200) }; }
};

console.log('=== createVerification 完整返回（找版本线索）===');
const r = await signed(`${CARD}/createVerification?is_high=true`, {
  'x-rpc-challenge_game': '6',
  'x-rpc-challenge_path': '/game_record/app/hkrpg/api/avatar/basic',
});
console.log('HTTP', r.status);
console.log(JSON.stringify(r.json, null, 2));

const d = r.json?.data || {};
console.log('\n=== 关键字段判读 ===');
console.log('  gt                =', d.gt);
console.log('  challenge         =', String(d.challenge).slice(0, 40));
console.log('  new_captcha       =', d.new_captcha);
console.log('  success           =', d.success);
console.log('  gt 是 32 位 MD5 形态 v3 标识:', /^[0-9a-f]{32}$/.test(String(d.gt)));
console.log('  含 v4 线索 (captcha_id/lot_number 等):',
  ['captcha_id', 'lot_number', 'risk_type', 'captcha_type'].filter((k) => k in d).join(',') || '无');

console.log('\n=== 两个 Geetest 入口对比 ===');
console.log('  v3: https://static.geetest.com/static/js/gt.0.4.9.js  -> window.initGeetest(options, cb)');
console.log('      getValidate() -> {geetest_challenge, geetest_validate, geetest_seccode}   ← miHoYo 要的');
console.log('  v4: https://static.geetest.com/v4/gt4.js              -> window.initGeetest4(options, cb)');
console.log('      getValidate() -> {lot_number, captcha_output, pass_token, gen_time}        ← 不匹配');

console.log('\n结论：字段名对不上，应改用 v3（initGeetest + gt.0.4.9.js）。');
