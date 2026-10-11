// The emulator's official Star Rail record page NOW shows the full character
// list (光明火柴, 66 已解锁角色, 开拓者 Lv.80 星魂6) after the user cleared the
// app's "账号异常" verification.
//
// This tests whether that one-time verification also unblocked the raw record
// API for this client - which is the whole question.
import { readFileSync } from 'node:fs';
import * as sr from '../src/mihoyo/starrail.js';

const account = JSON.parse(readFileSync('data/accounts.json', 'utf8')).accounts[0];
const UID = '100000000';
const SERVER = 'prod_gf_cn';

const opts = {
  cookie: account.cookie,
  deviceId: account.deviceId,
  deviceFp: account.fingerprint,
  accountId: account.accountId,
};

const wait = (ms = 4000) => new Promise((r) => setTimeout(r, ms));

const probe = async (label, fn) => {
  await wait();
  try {
    const v = await fn();
    console.log(`  ✓ ${label.padEnd(26)} ${v}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${label.padEnd(26)} retcode=${err.retcode} ${err.message}`);
    return false;
  }
};

console.log('=== 星铁记录接口（App 刚解锁后）===');
await probe('role/basicInfo', async () => {
  const d = await sr.getRoleBasicInfo(UID, SERVER, opts);
  return `${d?.nickname} Lv.${d?.level}`;
});
await probe('index', async () => {
  const d = await sr.getPlayerIndex(UID, SERVER, opts);
  const n = (d?.avatar_list || []).length;
  return `${d?.role?.nickname} 展示角色=${n} 已解锁=${d?.stats?.avatar_num ?? '?'}`;
});
await probe('avatar/basic', async () => {
  const r = await sr.recordRequest('avatar/basic', { ...opts, query: { role_id: UID, server: SERVER } });
  const d = r.json;
  if (d?.retcode !== 0) throw Object.assign(new Error(d?.message || ''), { retcode: d?.retcode });
  const list = d?.data?.avatars || [];
  console.log(`      前几个: ${list.slice(0, 8).map((a) => `${a.name} Lv.${a.level}`).join(', ')}`);
  return `${list.length} 个角色`;
});
await probe('avatar/info', async () => {
  const d = await sr.getAvatarInfo(UID, SERVER, opts);
  return `${(d?.avatars || []).length} 条详情`;
});
await probe('challenge', async () => {
  const d = await sr.getChallenge(UID, SERVER, 1, opts);
  return `忘却之庭星数=${d?.star_num ?? '?'}`;
});
await probe('note（实时便笺）', async () => {
  const r = await sr.recordRequest('note', { ...opts, query: { role_id: UID, server: SERVER } });
  const d = r.json;
  if (d?.retcode !== 0) throw Object.assign(new Error(d?.message || ''), { retcode: d?.retcode });
  return `体力 ${d?.data?.current_stamina}/${d?.data?.max_stamina}`;
});

console.log('\n=== 完整快照 ===');
await wait();
const snap = await sr.getFullSnapshot(UID, SERVER, opts);
console.log(`  characters = ${snap.characters.length}`);
console.log(`  avatars    = ${(snap.avatars?.avatars || []).length}`);
console.log(`  警告数     = ${snap.warnings.length}`);
for (const w of snap.warnings) console.log(`     [${w.retcode}] ${w.section}: ${w.message}`);
console.log('\ndone');
