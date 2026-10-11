// Dump the RAW role object from the binding API and cross-check the `region`
// value against what the record card reports.
//
// Motivation: vermaysha/hoyoapi issue #64 documents exactly this failure shape
// for Star Rail - daily works, `records()`/`characters()` fail - and the fix
// there was a WRONG `region` string in the client's region table. Snap Hutao's
// own region for Genshin CN is "cn_gf01"; Star Rail CN has two known values
// ("prod_gf_cn" official / "prod_qd_cn" bilibili). If the binding API reports
// something slightly different from what the record endpoints expect, the
// record endpoints answer with an opaque code.
import { readFileSync } from 'node:fs';
import { request } from '../src/mihoyo/http.js';
import { APP_VERSION } from '../src/mihoyo/constants.js';

const account = JSON.parse(readFileSync('data/accounts.json', 'utf8')).accounts[0];
const wait = (ms = 3500) => new Promise((r) => setTimeout(r, ms));

console.log('=================== 绑定接口的原始角色对象 ===================');
const res = await request(
  'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie?game_biz=hkrpg_cn',
  {
    headers: {
      'x-rpc-app_version': APP_VERSION,
      'x-rpc-client_type': '5',
      'x-rpc-app_id': 'bll8iq97cem8',
      'x-rpc-device_id': account.deviceId,
      ...(account.fingerprint ? { 'x-rpc-device_fp': account.fingerprint } : {}),
    },
    cookie: account.cookie,
    origin: 'https://api-takumi.mihoyo.com',
    referer: 'https://webstatic.mihoyo.com',
  },
);
console.log('retcode =', res.json?.retcode, res.json?.message);
for (const role of res.json?.data?.list || []) {
  console.log('\n--- 原始字段 ---');
  for (const [k, v] of Object.entries(role)) console.log(`  ${k.padEnd(18)} = ${JSON.stringify(v)}`);
}

console.log('\n=================== 记录卡片里的 region ===================');
await wait();
const { createDS } = await import('../src/mihoyo/ds.js');
const q = `uid=${account.accountId}`;
const cardRes = await request(
  `https://api-takumi-record.mihoyo.com/game_record/card/wapi/getGameRecordCard?${q}`,
  {
    headers: {
      'x-rpc-app_version': APP_VERSION,
      'x-rpc-client_type': '5',
      'x-rpc-device_id': account.deviceId,
      ...(account.fingerprint ? { 'x-rpc-device_fp': account.fingerprint } : {}),
      DS: createDS({ query: q }),
    },
    cookie: account.cookie,
    origin: 'https://api-takumi-record.mihoyo.com',
    referer: 'https://webstatic.mihoyo.com',
  },
);
for (const e of cardRes.json?.data?.list || []) {
  if (Number(e.game_id) === 6) {
    console.log(`  星铁 region = ${JSON.stringify(e.region)}  game_role_id=${e.game_role_id}  level=${e.level}`);
  }
}
console.log('done');
