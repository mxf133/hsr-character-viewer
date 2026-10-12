// GUI dashboard fixture: serves the real app with a pre-seeded account and a
// realistic cached snapshot, so the dashboard layout can be inspected without
// live credentials. Used by tools/gui-shot.mjs and safe to keep.

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore } from '../src/server/store.js';
import { startServer } from '../src/server/app.js';

const dir = join(tmpdir(), 'hsr-fixture');
const file = join(dir, 'accounts.json');
await mkdir(dir, { recursive: true });
await rm(file, { force: true });

const store = new AccountStore({ file });
await store.load();
const account = await store.upsertAccount({
  accountId: '101234567',
  nickname: '开拓者·星',
  cookie: { cookie_token: 'fixture', account_id: '101234567' },
  source: 'qr',
});
await store.setRoles(account.id, [{
  game_uid: '101234567',
  nickname: '星穹列车长',
  level: 70,
  region: 'prod_gf_cn',
  region_name: '官服 · 星穹列车',
}]);

const avatars = [
  {
    id: 1205, name: '刃', rarity: 5, level: 80, rank: 6, actived_constellation_num: 6,
    path: 'Warrior', element: 'Wind',
    // A real miHoYo CDN portrait is used when reachable; the initial is the fallback.
    icon: 'https://act-webstatic.mihoyo.com/hk4e-plugin/20230413/55b7a0b4e0f8b0b8c6e39e9b7b2f9f0e.png',
    properties: [
      { field: 'hp', name: '生命值', value: 12801 },
      { field: 'attack', name: '攻击力', value: 1876 },
      { field: 'defence', name: '防御力', value: 1043 },
      { field: 'speed', name: '速度', value: 136 },
      { field: 'critical_chance', name: '暴击率', value: 0.732 },
      { field: 'critical_damage', name: '暴击伤害', value: 1.842 },
      { field: 'break_damage', name: '击破特攻', value: 0.334 },
      { field: 'sp_rate', name: '能量恢复效率', value: 1.244 },
    ],
    equip: { name: '到不了的彼岸', rarity: 5, rank: 1, level: 80 },
    skills: [
      { name: '普攻 · 云骑剑诀', level: 6 },
      { name: '战技 · 待春时', level: 10 },
      { name: '终结技 · 大辟万世', level: 10 },
      { name: '天赋 · 业镜无明', level: 10 },
      { name: '秘技 · 无罅飞光', level: 1 },
    ],
    relics: [
      { id: '61011', type: 1, name: '骇域漫游的信使', level: 15, rarity: 5, main_property: { name: '生命值', value: 705 }, sub_property_list: [{ name: '暴击率', value: '5.8%' }, { name: '速度', value: '6' }] },
      { id: '61012', type: 2, name: '骇域漫游的信使', level: 15, rarity: 5, main_property: { name: '攻击力', value: 352 }, sub_property_list: [{ name: '暴击伤害', value: '12.3%' }] },
      { id: '61013', type: 3, name: '骇域漫游的信使', level: 15, rarity: 5, main_property: { name: '暴击伤害', value: '64.8%' }, sub_property_list: [{ name: '攻击力', value: '8.6%' }, { name: '速度', value: '4' }] },
      { id: '31014', type: 4, name: '苍狼的终点', level: 15, rarity: 5, main_property: { name: '速度', value: 25 }, sub_property_list: [{ name: '暴击率', value: '6.4%' }] },
      { id: '31015', type: 5, name: '繁星璀璨的天才', level: 15, rarity: 5, main_property: { name: '风属性伤害提高', value: '38.8%' }, sub_property_list: [{ name: '攻击力', value: '11.2%' }] },
      { id: '31016', type: 6, name: '繁星璀璨的天才', level: 15, rarity: 5, main_property: { name: '能量恢复效率', value: '19.4%' }, sub_property_list: [{ name: '暴击伤害', value: '14.1%' }] },
    ],
  },
  {
    id: 1004, name: '三月七', rarity: 4, level: 80, rank: 6, actived_constellation_num: 6,
    path: 'Knight', element: 'Ice',
    properties: [
      { field: 'hp', name: '生命值', value: 10432 },
      { field: 'attack', name: '攻击力', value: 1102 },
      { field: 'defence', name: '防御力', value: 1873 },
      { field: 'speed', name: '速度', value: 122 },
      { field: 'critical_chance', name: '暴击率', value: 0.412 },
    ],
    equip: { name: '余生的第一天', rarity: 4, rank: 5, level: 80 },
    skills: [
      { name: '普攻 · 快照', level: 6 },
      { name: '战技 · 可爱即正义', level: 12 },
      { name: '终结技 · 冰刻箭雨之时', level: 12 },
    ],
    relics: [
      { id: '12011', type: 1, name: '戍卫风雪的铁卫', level: 15, rarity: 5, main_property: { name: '生命值', value: 705 }, sub_property_list: [{ name: '防御力', value: '9.7%' }] },
      { id: '12012', type: 2, name: '戍卫风雪的铁卫', level: 12, rarity: 5, main_property: { name: '攻击力', value: 300 }, sub_property_list: [{ name: '速度', value: '2' }] },
    ],
  },
  {
    id: 8001, name: '{NICKNAME}', rarity: 5, level: 80, rank: 6,
    path: 'Warrior', element: 'Physical',
    properties: [{ field: 'hp', name: '生命值', value: 12060 }, { field: 'attack', name: '攻击力', value: 1602 }],
    equip: { name: '记忆的质料', rarity: 5, rank: 1, level: 80 },
    relics: [],
  },
];

const snapshot = {
  uid: '101234567',
  server: 'prod_gf_cn',
  regionName: '官服 · 星穹列车',
  fetchedAt: new Date().toISOString(),
  basicInfo: { nickname: '星穹列车长', level: 70, world_level: 6, birthday: '0412', avatar_id: 8001 },
  index: {
    stats: {
      active_day_number: 486,
      achievement_num: 731,
      avatar_num: 47,
      equipment_num: 132,
      abyss_process: 12,
      treasure_chest_num: 512,
    },
    avatar_list: avatars,
  },
  avatars: { avatars },
  challenge: { star_num: 33, floors: new Array(12).fill(0), max_floor: 12 },
  rogue: { records: new Array(9).fill(0), unlocked_difficulty: 5 },
  warnings: [{ section: '模拟宇宙', message: '该角色未公开最新赛季数据（示例提示）' }],
};

await store.setSnapshot(account.id, '101234567', snapshot);

const app = await startServer({ port: Number(process.env.FIXTURE_PORT || 8399), host: '127.0.0.1', store });
console.log(`fixture ready: ${app.url}`);
if (process.env.FIXTURE_EXPAND) {
  console.log('(dashboard renders collapsed cards by default)');
}
