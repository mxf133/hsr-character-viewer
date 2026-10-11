// Verify the record API using a valid record cookie supplied on stdin, and
// confirm that the account id must NOT be used as the game UID.
//
//   node tools/record-probe.mjs "<cookie header>"
import { getPlayerIndex, getRoleBasicInfo, getAvatarInfo, getChallenge } from '../src/mihoyo/starrail.js';
import { fetchGameRoles } from '../src/mihoyo/auth.js';
import { parseCookieHeader } from '../src/mihoyo/http.js';
import { GAME_BIZ } from '../src/mihoyo/constants.js';

const raw = process.argv[2] || '';
const cookie = parseCookieHeader(raw);
if (Object.keys(cookie).length === 0) {
  console.error('用法: node tools/record-probe.mjs "<cookie header>"');
  process.exit(2);
}
const accountId = cookie.account_id || cookie.account_id_v2 || cookie.ltuid;

console.log('cookie 名称:', Object.keys(cookie).sort().join(', '));
console.log('account_id (米游社账号):', accountId);

// 1. role list works with the account cookie
let roles = [];
try {
  roles = await fetchGameRoles(cookie, undefined, GAME_BIZ);
  console.log(`\n角色列表: ${roles.length} 个`);
  for (const r of roles) console.log(`  - ${r.nickname}  game_uid=${r.game_uid}  region=${r.region}  Lv.${r.level}`);
} catch (err) {
  console.log('角色列表失败:', err.message, `retcode=${err.retcode}`);
  process.exit(1);
}
if (roles.length === 0) { console.log('该账号没有星穹铁道角色'); process.exit(0); }

const gameUid = roles[0].game_uid;
const server = roles[0].region || 'prod_gf_cn';

// 2. prove that using the account id as role_id fails
console.log('\n--- 对照：把米游社 account_id 当作 role_id ---');
try {
  await getRoleBasicInfo(accountId, server, { cookie });
  console.log('  意外成功');
} catch (err) {
  console.log(`  retcode=${err.retcode} ${err.message}`);
}

// 3. correct usage: the GAME uid
console.log(`\n--- 正确用法：role_id=${gameUid} server=${server} ---`);
for (const [label, fn] of [
  ['role/basicInfo', (u, s, o) => getRoleBasicInfo(u, s, o)],
  ['index', (u, s, o) => getPlayerIndex(u, s, o)],
  ['avatar/info', (u, s, o) => getAvatarInfo(u, s, o)],
  ['challenge', (u, s, o) => getChallenge(u, s, 1, o)],
]) {
  try {
    const data = await fn(gameUid, server, { cookie });
    const summary = JSON.stringify(data);
    console.log(`  ${label}: OK  ${summary.slice(0, 140)}`);
    if (label === 'index') {
      const stats = data?.stats || {};
      console.log(`     玩家: ${data?.role?.nickname ?? '?'}  Lv.${data?.role?.level ?? '?'}`);
      console.log(`     统计: 角色=${stats.avatar_num} 光锥=${stats.equipment_num} 成就=${stats.achievement_num} 活跃=${stats.active_day_number}`);
      console.log(`     展示角色数: ${(data?.avatar_list || []).length}`);
    }
    if (label === 'avatar/info') {
      const list = data?.avatars || [];
      console.log(`     角色详情条目: ${list.length}`);
      if (list[0]) {
        console.log(`     首个: ${list[0].name} Lv.${list[0].level} 星魂${list[0].rank} 遗器${(list[0].relics || []).length}件 光锥=${list[0].equip?.name}`);
      }
    }
  } catch (err) {
    console.log(`  ${label}: retcode=${err.retcode} ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 500));
}
