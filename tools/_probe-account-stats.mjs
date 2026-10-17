// 探针：把本机 `data/accounts.json` 里**真实快照**的字段摊开，回答两个问题：
//
//   ① 米游社给的数据里到底有没有「均衡等级 / 活跃天数 / 光锥数量」这三项？
//      （界面 `public/scripts/app.js` 的总览卡片读 `info.world_level`、
//      `stats.active_day_number`、`stats.equipment_num`，但从没人核对过服务端
//      是不是真的发了这几个键 —— 长期显示「—」才是用户报的问题。）
//   ② 真实账号的 `characters` 是**全部角色**还是只有展柜里那几个？
//      限定角色 / 限定光锥的数量能不能按快照数出来。
//
// 用法（必须在**能解密的机器**上跑，本机 Windows 走 DPAPI）：
//
//   node tools/_probe-account-stats.mjs
//   node tools/_probe-account-stats.mjs --data ../data/accounts.json
//
// ⚠️ 只读：不触发联网刷新，也不写任何文件。快照走 `store.getSnapshot()`，
//    与界面点开「角色信息」页拿到的是同一份。
import { resolve } from 'node:path';

import { AccountStore } from '../src/server/store.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const file = resolve(arg('data', resolve(process.cwd(), 'data', 'accounts.json')));
console.log('读取', file);
const store = new AccountStore({ file });
const accounts = await store.listAccounts();
console.log(`账号 ${accounts.length} 个`);

/** 只打印结构，不打印任何凭证字段。 */
const keysOf = (value) => (value && typeof value === 'object' ? Object.keys(value) : typeof value);

for (const account of accounts) {
  console.log(`\n=== ${account.id}（${account.source || 'real'}）===`);
  for (const role of account.roles || []) {
    const snapshot = await store.getSnapshot(account.id, role.uid);
    if (!snapshot) { console.log(`  ${role.uid}: 没有快照`); continue; }
    console.log(`  ${role.uid} 快照顶层字段：${keysOf(snapshot).join(', ')}`);
    console.log(`    index 字段：${keysOf(snapshot.index).join(', ')}`);
    console.log(`    index.role：${JSON.stringify(snapshot.index?.role)}`);
    console.log(`    index.stats：${JSON.stringify(snapshot.index?.stats)}`);
    console.log(`    basicInfo：${JSON.stringify(snapshot.basicInfo)}`);
    console.log(`    card.data：${JSON.stringify(snapshot.card?.data)}`);
    const characters = snapshot.characters || [];
    console.log(`    characters：${characters.length} 个；第一项字段：${keysOf(characters[0]).join(', ')}`);
    console.log(`    第一项 equip：${JSON.stringify(characters[0]?.equip)}`);
    console.log(`    index.avatar_list：${(snapshot.index?.avatar_list || []).length} 个`);
  }
}
