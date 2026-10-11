// Inspect the Star Rail character payload now that the record API answers 0.
// Determine the real field names so the GUI renders actual names/levels.
import { readFileSync } from 'node:fs';
import * as sr from '../src/mihoyo/starrail.js';

const account = JSON.parse(readFileSync('data/accounts.json', 'utf8')).accounts[0];
const opts = { cookie: account.cookie, deviceId: account.deviceId, deviceFp: account.fingerprint };
const UID = '100000000';
const SERVER = 'prod_gf_cn';

const idx = await sr.getPlayerIndex(UID, SERVER, opts);
const list = idx?.avatar_list || [];
console.log(`index.avatar_list = ${list.length} 条`);
if (list.length) {
  console.log('\n=== avatar_list[0] 全部字段 ===');
  for (const [k, v] of Object.entries(list[0])) {
    const s = typeof v === 'object' ? JSON.stringify(v).slice(0, 90) : String(v);
    console.log(`  ${k.padEnd(22)} = ${s}`);
  }
  console.log('\n=== 前 12 个角色 ===');
  for (const a of list.slice(0, 12)) {
    console.log(`  id=${String(a.id).padEnd(6)} ${String(a.name).padEnd(12)} Lv.${String(a.level).padEnd(3)} `
      + `稀有度=${a.rarity ?? '?'} 星魂=${a.rank ?? a.actived_constellation_num ?? '?'} `
      + `属性=${a.element ?? '?'} 命途=${a.path ?? '?'}`);
  }
}

const basic = await sr.recordRequest('avatar/basic', { ...opts, query: { role_id: UID, server: SERVER } });
console.log('\n=== avatar/basic 响应 ===');
console.log(`  retcode=${basic.json?.retcode} data keys=${Object.keys(basic.json?.data || {}).join(',')}`);
const bl = basic.json?.data?.avatars || basic.json?.data?.avatar_list || [];
console.log(`  角色数=${bl.length}`);
if (bl.length) console.log(`  首条字段: ${Object.keys(bl[0]).join(', ')}`);
