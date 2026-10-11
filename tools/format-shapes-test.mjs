// Verifies the front-end formatters against REAL record API payload shapes
// captured from live responses. Regression guard for field-path drift.
import {
  challengeSummary, charactersOf, displayName, lightConeOf, playerInfoOf,
  effectiveSubstatHits, relicsOf, rogueSummary, skillsOf, slotName, statValue, statsOf, cardStats,
  elementName,
} from '../public/scripts/format.js';

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`); }
};

// ---- real role/basicInfo payload ---------------------------------------
console.log('[role/basicInfo — 实测返回]');
const basicInfo = {
  avatar: 'https://act-webstatic.mihoyo.com/darkmatter/hkrpg/prod_gf_cn/item_icon_u064oe/x.png',
  nickname: '光明火柴',
  region: 'prod_gf_cn',
  level: 70,
};
const info = playerInfoOf({ basicInfo });
check('解析出昵称', info.nickname === '光明火柴', JSON.stringify(info));
check('解析出等级', info.level === 70, String(info.level));
check('解析出区服', info.region === 'prod_gf_cn');

// ---- real index payload shape (when public) ----------------------------
console.log('\n[index — 公开时的结构]');
const indexPayload = {
  role: { nickname: '光明火柴', level: 70, region: 'prod_gf_cn' },
  stats: { active_day_number: 486, achievement_num: 731, avatar_num: 47, equipment_num: 132, abyss_process: 12 },
  avatar_list: [],
};
const infoFromIndex = playerInfoOf({ index: indexPayload, basicInfo });
check('playerInfoOf 优先取 index.role', infoFromIndex.nickname === '光明火柴');
check('只有 index 时也能取到', playerInfoOf({ index: indexPayload }).level === 70);
check('空快照返回空对象', Object.keys(playerInfoOf({})).length === 0);

// ---- real rogue payload -------------------------------------------------
console.log('\n[rogue — 实测返回]');
const rogue = {
  role: { server: 'prod_gf_cn', nickname: '光明火柴', level: 70 },
  basic_info: { unlocked_buff_num: 232, unlocked_miracle_num: 61, unlocked_skill_points: 42 },
  current_record: {
    basic: { id: 33, finish_cnt: 0, current_rogue_score: 18000, max_rogue_score: 18000 },
    records: [],
    has_data: false,
    best_record: null,
  },
  last_record: null,
  latest_record: null,
};
const rogueRows = rogueSummary({ rogue });
check('模拟宇宙解析出多行', Array.isArray(rogueRows) && rogueRows.length >= 5, JSON.stringify(rogueRows));
const rogueMap = Object.fromEntries((rogueRows || []).map((r) => [r.label, r.value]));
check('本期期数 = 第 33 期', rogueMap['本期期数'] === '第 33 期', rogueMap['本期期数']);
check('本期积分带上限', rogueMap['本期积分'] === '18,000 / 18,000', rogueMap['本期积分']);
check('已解锁祝福 = 232', rogueMap['已解锁祝福'] === '232', rogueMap['已解锁祝福']);
check('已解锁奇物 = 61', rogueMap['已解锁奇物'] === '61');
check('空对象返回 null', rogueSummary({}) === null);
check('缺 basic_info 不崩', rogueSummary({ rogue: { current_record: { basic: { id: 1 } } } }) !== null);

// ---- character list shapes ---------------------------------------------
console.log('\n[角色列表来源]');
const charList = [{ id: 1205, name: '刃', level: 80, rarity: 5 }];
check('index.avatar_list', charactersOf({ index: { avatar_list: charList } }).length === 1);
check('avatars.avatars', charactersOf({ avatars: { avatars: charList } }).length === 1);
check('avatars.avatar_list', charactersOf({ avatars: { avatar_list: charList } }).length === 1);
check('都没有则空数组', charactersOf({}).length === 0);

// ---- character detail shapes -------------------------------------------
console.log('\n[角色详情]');
const character = {
  id: 1205, name: '刃', level: 80, rank: 6, rarity: 5,
  equip: { name: '到不了的彼岸', rarity: 5, rank: 1, level: 80 },
  skills: [{ name: '普攻', level: 6 }, { name: '战技', level: 10 }],
  properties: [{ field: 'hp', name: '生命值', value: 12801 }, { field: 'critical_damage', name: '暴击伤害', value: 1.842 }],
  relics: [{
    id: '61013', type: 3, name: '骇域漫游的信使', level: 15, rarity: 5,
    icon: 'https://example.test/relic.png',
    main_property: { name: '暴击伤害', value: '64.8%' },
    sub_property_list: [{ name: '攻击力', value: '8.6%' }, { name: '速度', value: '4' }],
  }],
};
check('lightConeOf', lightConeOf(character)?.name === '到不了的彼岸');
check('skillsOf 数量', skillsOf(character).length === 2);
check('statsOf 数量', statsOf(character).length === 2);
check('relicsOf 数量', relicsOf(character).length === 1);
check('relicsOf 保留遗器图标地址', relicsOf(character)[0].icon === 'https://example.test/relic.png');
// 星铁的遗器是 4 件套（`relics`，pos 1-4）+ 2 件位面饰品（`ornaments`，pos 5/6）。
// 只读 `relics` 会少两件——界面上就写成「遗器 · 4」，这是用户实际发现的 bug。
const withOrnaments = {
  ...character,
  ornaments: [
    { id: '63085', pos: 5, name: '翁瓦克的诞生之岛', level: 15, rarity: 5, main_property: { name: '冰属性伤害提高', value: '38.8%' }, properties: [{ name: '暴击率', value: '4.3%' }] },
    { id: '63086', pos: 6, name: '翁瓦克的走马灯', level: 15, rarity: 5, main_property: { name: '能量恢复效率', value: '19.4%' }, properties: [] },
  ],
};
// 这条 fixture 的 `relics` 只有 1 件（真实快照里是 4 件），所以断言是 1 + 2 = 3；
// 真实的 4 + 2 = 6 由 herta-test 的实测快照用例覆盖。
check('relicsOf 把 ornaments 也读进来', relicsOf(withOrnaments).length === 3,
  String(relicsOf(withOrnaments).length));
check('饰品槽位名（位面球 / 连结绳）',
  relicsOf(withOrnaments, 'hsr')[1]?.slotName === '位面球'
  && relicsOf(withOrnaments, 'hsr')[2]?.slotName === '连结绳',
  `${relicsOf(withOrnaments, 'hsr')[1]?.slotName}/${relicsOf(withOrnaments, 'hsr')[2]?.slotName}`);
check('relicsOf 主词条', relicsOf(character)[0].mainName === '暴击伤害');
check('relicsOf 副词条', relicsOf(character)[0].subs.length === 2);
check('relicsOf 槽位名', slotName(3) === '躯干', slotName(3));
check('slotName 数字 5 = 位面球', slotName(5) === '位面球');

const propertyInfo = {
  1: { name: '生命值' }, 2: { name: '攻击力' }, 4: { name: '速度' },
  51: { name: '速度' }, 52: { name: '暴击率' }, 53: { name: '暴击伤害' },
};
const officialShape = {
  id: 8007,
  properties: [{ property_type: 1, base: '1894', add: '1360', final: '3255' },
    { property_type: 4, base: '103', add: '47', final: '150' }],
  relics: [{ properties: [
    { property_type: 53, value: '17.4%', times: 3 },
    { property_type: 51, value: '4', times: 2 },
  ] }],
  servant_detail: {
    servant_name: '迷迷',
    servant_properties: [{ property_type: 1, base: '1629', add: '1858', final: '3487' }],
  },
};
check('官方属性字段 property_type/base/add/final', statsOf(officialShape, propertyInfo)[0]?.value === '3255');
check('官方属性保留基础与追加值', statsOf(officialShape, propertyInfo)[0]?.base === '1894'
  && statsOf(officialShape, propertyInfo)[0]?.add === '1360');
check('忆灵属性字段可解析', statsOf(officialShape.servant_detail, propertyInfo,
  officialShape.servant_detail.servant_properties)[0]?.value === '3487');
check('有效词条按推荐与强化次数统计', effectiveSubstatHits(officialShape,
  { recommend_relic_properties: [53, 51] }, propertyInfo).total === 5);

// ---- the stat scaling bug found in a live screenshot -------------------
console.log('\n[百分比格式化 — 修过的真实 bug]');
check('暴击伤害 1.842 -> 184.2%', statValue('critical_damage', 1.842) === '184.2%', statValue('critical_damage', 1.842));
check('暴击率 0.732 -> 73.2%', statValue('critical_chance', 0.732) === '73.2%', statValue('critical_chance', 0.732));
check('已是百分数 33.4 -> 33.4%', statValue('break_damage', 33.4) === '33.4%', statValue('break_damage', 33.4));
check('生命值不加百分号', statValue('hp', 12801) === '12,801', statValue('hp', 12801));
check('缺失值 -> —', statValue('hp', null) === '—');

// ---- public profile card (survives the privacy gate) --------------------
console.log('\n[公开卡片 — 实测返回]');
const card = {
  has_role: true, game_id: 6, game_role_id: '100000000', nickname: '光明火柴',
  level: 70, is_public: true,
  data: [
    { name: '活跃天数', type: 1, value: '1206' },
    { name: '已解锁角色', type: 1, value: '66' },
    { name: '达成成就数', type: 1, value: '1606' },
    { name: '战利品开启', type: 1, value: '2069' },
  ],
};
const rows = cardStats({ card });
check('cardStats 解析 4 行', rows?.length === 4, JSON.stringify(rows));
const map = Object.fromEntries((rows || []).map((r) => [r.label, r.value]));
check('活跃天数 = 1206', map['活跃天数'] === '1206', map['活跃天数']);
check('已解锁角色 = 66', map['已解锁角色'] === '66');
check('无 card 返回 null', cardStats({}) === null);
check('card 无 data 返回 null', cardStats({ card: {} }) === null);
check('playerInfoOf 回退到 card', playerInfoOf({ card }).nickname === '光明火柴');

check('星铁元素 Thunder -> 雷', elementName('Thunder') === '雷');

// ---- misc ---------------------------------------------------------------
console.log('\n[其它]');
check('拓荒者占位名替换', displayName('{NICKNAME}') === '开拓者');
check('正常名字保留', displayName('刃') === '刃');
check('challengeSummary 处理缺失', challengeSummary({}) === null);
check('challengeSummary 处理记录', Array.isArray(challengeSummary({ challenge: { star_num: 33, floors: new Array(12) } })));

console.log(`\n${'='.repeat(52)}`);
console.log(`字段格式测试: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
