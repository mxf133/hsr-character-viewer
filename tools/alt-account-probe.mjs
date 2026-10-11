// Diagnose why the ALT account's Star Rail characters are not visible.
//
// Two independent questions:
//   A) Is the alt account's record PUBLIC? If it is, the main account's cookie
//      can read it via the card API + the record endpoints (that is exactly how
//      "查看他人战绩" works, and how the official page is opened for another
//      user_id).
//   B) If it is not public, the alt account needs its own cookie - which is a
//      login problem, not a code problem.
//
// Alt account UID 100000001 appeared in an earlier snapshot of this store, so
// probe that first, plus the main account as a control.
import { readFileSync } from 'node:fs';
import { createDS } from '../src/mihoyo/ds.js';
import { APP_VERSION } from '../src/mihoyo/constants.js';

const account = JSON.parse(readFileSync('data/accounts.json', 'utf8')).accounts[0];
const GAP = 4000;
const wait = (ms = GAP) => new Promise((r) => setTimeout(r, ms));

const cookieHeader = Object.entries(account.cookie)
  .filter(([k]) => ['cookie_token', 'ltoken', 'ltuid', 'account_id'].includes(k))
  .map(([k, v]) => `${k}=${v}`).join('; ');

const signed = async (url, query = '', body) => {
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
  };
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { retcode: res.status, message: text.slice(0, 60) }; }
};

const RECORD = 'https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api';

console.log('=== A) 小号 UID 100000001 —— 用大号 cookie 能否读到公开战绩 ===');
for (const [label, path, query] of [
  ['星铁 index', 'index', 'role_id=100000001&server=prod_gf_cn'],
  ['星铁 avatar/basic', 'avatar/basic', 'role_id=100000001&server=prod_gf_cn'],
  ['星铁 role/basicInfo', 'role/basicInfo', 'role_id=100000001&server=prod_gf_cn'],
]) {
  await wait();
  const j = await signed(`${RECORD}/${path}`, query);
  const mark = j.retcode === 0 ? '✓' : '✗';
  const n = (j.data?.avatar_list || j.data?.avatars || []).length;
  console.log(`  ${mark} ${label.padEnd(22)} retcode=${String(j.retcode).padEnd(7)} `
    + `${String(j.message).slice(0, 30)}${n ? `  → ${n} 个角色` : ''}`);
  if (j.retcode === 0 && j.data?.role) console.log(`      玩家: ${j.data.role.nickname} Lv.${j.data.role.level}`);
}

console.log('\n=== B) 记录卡片：两个账号各自的开关状态 ===');
for (const uid of [account.accountId, '100000001']) {
  await wait();
  const j = await signed(
    `https://api-takumi-record.mihoyo.com/game_record/card/wapi/getGameRecordCard?uid=${uid}`,
  );
  console.log(`\n  --- 查询 uid=${uid}  (retcode=${j.retcode}) ---`);
  if (j.retcode !== 0) { console.log(`      ${j.message}`); continue; }
  for (const e of j.data?.list || []) {
    const sw = (e.data_switches || []).map((s) => `${s.switch_name}=${s.is_public}`).join(', ');
    console.log(`      game_id=${e.game_id} ${e.game_name} | ${e.nickname} Lv.${e.level} `
      + `region=${e.region} is_public=${e.is_public}`);
    console.log(`         ${sw}`);
    console.log(`         role_id=${e.game_role_id}`);
  }
}

console.log('\n=== C) 大号自己作为对照 ===');
await wait();
const mine = await signed(`${RECORD}/index`, 'role_id=100000000&server=prod_gf_cn');
console.log(`  index retcode=${mine.retcode} 角色数=${(mine.data?.avatar_list || []).length}`);
console.log('done');
