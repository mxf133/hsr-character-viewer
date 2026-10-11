// Is the Star Rail record service offering a verification challenge right now?
//
// Both accounts (main 107987102 and alt 170556517) currently answer 10035 on
// index/avatar/* while role/basicInfo succeeds, and BOTH accounts' Genshin data
// is readable. That pattern points at a service-level state rather than one
// account being flagged, so ask the API for a challenge the way the official
// client does and see what it says.
import { readFileSync } from 'node:fs';
import { createDS } from '../src/mihoyo/ds.js';
import { APP_VERSION } from '../src/mihoyo/constants.js';

const account = JSON.parse(readFileSync('data/accounts.json', 'utf8')).accounts[0];
const wait = (ms = 4000) => new Promise((r) => setTimeout(r, ms));

const cookieHeader = Object.entries(account.cookie)
  .filter(([k]) => ['cookie_token', 'ltoken', 'ltuid', 'account_id'].includes(k))
  .map(([k, v]) => `${k}=${v}`).join('; ');

const call = async (url, query, extraHeaders = {}, body) => {
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
  const res = await fetch(query ? `${url}?${query}` : url, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null, text: text.slice(0, 200) }; }
};

const CARD = 'https://api-takumi-record.mihoyo.com/game_record/card/wapi';

console.log('=== 1) 为星铁申请验证挑战（check_game=6）===');
for (const [label, path, game, cpath] of [
  ['星铁 index', 'index', 6, '/game_record/app/hkrpg/api/index'],
  ['星铁 avatar/basic', 'avatar/basic', 6, '/game_record/app/hkrpg/api/avatar/basic'],
]) {
  await wait();
  const r = await call(
    `${CARD}/createVerification?is_high=true`, '',
    { 'x-rpc-challenge_game': String(game), 'x-rpc-challenge_path': cpath },
  );
  const j = r.json;
  console.log(`\n  --- ${label} ---`);
  console.log(`  HTTP ${r.status}  retcode=${j?.retcode}  ${j?.message ?? r.text ?? ''}`);
  if (j?.data) {
    console.log(`      gt        = ${String(j.data.gt).slice(0, 40)}`);
    console.log(`      challenge = ${String(j.data.challenge).slice(0, 40)}`);
    console.log(`      new_captcha = ${j.data.new_captcha}`);
  }
}

console.log('\n\n=== 2) 直接重试星铁 index（看是否间歇）===');
for (let i = 1; i <= 3; i += 1) {
  await wait();
  const r = await call(
    'https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/index',
    'role_id=107987102&server=prod_gf_cn',
  );
  console.log(`  第 ${i} 次: retcode=${r.json?.retcode} ${String(r.json?.message ?? '').slice(0, 30)}`);
}

console.log('\n\n=== 3) 星铁其它端点 ===');
for (const [label, path, query] of [
  ['rogue', 'rogue', 'role_id=107987102&server=prod_gf_cn&schedule_type=1'],
  ['note', 'note', 'role_id=107987102&server=prod_gf_cn'],
  ['challenge', 'challenge', 'role_id=107987102&server=prod_gf_cn&schedule_type=1'],
  ['role/basicInfo', 'role/basicInfo', 'role_id=107987102&server=prod_gf_cn'],
]) {
  await wait();
  const r = await call(`https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/${path}`, query);
  console.log(`  ${r.json?.retcode === 0 ? '✓' : '✗'} ${label.padEnd(18)} retcode=${String(r.json?.retcode).padEnd(7)} ${String(r.json?.message ?? '').slice(0, 30)}`);
}
console.log('done');
