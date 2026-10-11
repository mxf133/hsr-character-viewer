// Inspect the real record payloads with a valid cookie, and report the exact
// field paths the GUI depends on. Usage:
//
//   node tools/record-inspect.mjs <gameUid> <cookieHeaderFile>
import { readFileSync } from 'node:fs';
import {
  getPlayerIndex, getRoleBasicInfo, getAvatarInfo, getChallenge, getRogue,
} from '../src/mihoyo/starrail.js';
import { parseCookieHeader } from '../src/mihoyo/http.js';

const gameUid = process.argv[2];
const cookieFile = process.argv[3];
if (!gameUid || !cookieFile) {
  console.error('用法: node tools/record-inspect.mjs <gameUid> <cookieFile>');
  process.exit(2);
}
const cookie = parseCookieHeader(readFileSync(cookieFile, 'utf8'));
const server = 'prod_gf_cn';

const show = async (label, fn) => {
  try {
    const data = await fn();
    console.log(`\n===== ${label} : OK =====`);
    console.log(JSON.stringify(data, null, 2).slice(0, 2600));
    return data;
  } catch (err) {
    console.log(`\n===== ${label} : retcode=${err.retcode} ${err.message}`);
    return null;
  }
};

const index = await show('index', () => getPlayerIndex(gameUid, server, { cookie }));
await show('role/basicInfo', () => getRoleBasicInfo(gameUid, server, { cookie }));
const avatars = await show('avatar/info', () => getAvatarInfo(gameUid, server, { cookie }));
await show('challenge', () => getChallenge(gameUid, server, 1, { cookie }));
await show('rogue', () => getRogue(gameUid, server, 1, { cookie }));

// ---- report the exact shape the GUI reads ------------------------------
console.log('\n\n########## GUI 依赖的字段核对 ##########');
if (index) {
  console.log('index.role              :', JSON.stringify(index.role));
  console.log('index.stats 键           :', Object.keys(index.stats || {}).join(', '));
  const list = index.avatar_list;
  console.log('index.avatar_list 长度   :', Array.isArray(list) ? list.length : '(缺失)');
  if (Array.isArray(list) && list[0]) {
    console.log('avatar_list[0] 键        :', Object.keys(list[0]).join(', '));
    console.log('avatar_list[0] 摘要      :', JSON.stringify({
      id: list[0].id, name: list[0].name, level: list[0].level, rarity: list[0].rarity,
      rank: list[0].rank, path: list[0].path, element: list[0].element, icon: !!list[0].icon,
    }));
    console.log('avatar_list[0].properties:', JSON.stringify((list[0].properties || []).slice(0, 3)));
  }
}
if (avatars) {
  const list = avatars.avatars || avatars.avatar_list || [];
  console.log('\navatar/info 顶层键        :', Object.keys(avatars).join(', '));
  console.log('avatars 长度             :', list.length);
  if (list[0]) {
    console.log('avatars[0] 键            :', Object.keys(list[0]).join(', '));
    console.log('avatars[0] 摘要          :', JSON.stringify({
      id: list[0].id, name: list[0].name, level: list[0].level, rank: list[0].rank,
      rarity: list[0].rarity, path: list[0].path, element: list[0].element,
      equip: list[0].equip?.name, relicCount: (list[0].relics || []).length,
      skillCount: (list[0].skills || []).length,
      propCount: (list[0].properties || []).length,
    }));
    if (list[0].properties?.[0]) console.log('properties[0]            :', JSON.stringify(list[0].properties[0]));
    if (list[0].relics?.[0]) console.log('relics[0]                :', JSON.stringify(list[0].relics[0]).slice(0, 400));
    if (list[0].skills?.[0]) console.log('skills[0]                :', JSON.stringify(list[0].skills[0]));
    if (list[0].ranks?.[0]) console.log('ranks[0]                 :', JSON.stringify(list[0].ranks[0]).slice(0, 200));
  }
}
