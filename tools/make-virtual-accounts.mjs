// 把「虚拟账号」写成一份**独立的账号库文件**，这样网页界面里能直接选到它们、看到真实的
// 抽卡方案渲染结果（`tools/team-plan-cases.mjs` 只在终端里跑，看不到界面）。
//
// ⚠️ **绝不碰真实账号库**：默认写到 `data/accounts-virtual.json`，配合
// `DSH_HSR_DATA_FILE=data/accounts-virtual.json` 起第二个服务（另一个端口）即可。
// 真实数据 `data/accounts.json` 与本机其它服务完全不受影响。
//
// 抽卡方案吃的是「米游社快照」里的角色 / 星魂 / 装备光锥，所以这里按快照的形状造数据：
//   characters: [{ name: '遐蝶', rank: 2, actived_constellation_num: 2,
//                  equip: { name: '让告别，更美一些', rank: 1 } }, ...]
// 名字用**中文**（米游社就是中文），服务端与前端都会按 i18n 映射到数据集英文键。
//
//   node tools/make-virtual-accounts.mjs [--out=data/accounts-virtual.json] [--list]
import fs from 'node:fs';
import { charCostOf, coneCostOf } from '../public/scripts/advice.js';
import { archiveIndex, loadI18n, zhName } from '../src/server/archive.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const OUT = arg('out', 'data/accounts-virtual.json');
const LIST_ONLY = process.argv.includes('--list');

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const en2zhChar = (k) => zhName(i18n, 'characters', k) || k;
const en2zhCone = (k) => zhName(i18n, 'lightCones', k) || k;
const zh2en = (table, name) => Object.entries(i18n[table] || {})
  .find(([, zh]) => zh === name)?.[0] || name;

const FREE_CHARS = Object.keys(availability.characters || {})
  .filter((k) => charCostOf(k, availability) === 0);
const FREE_CONES = Object.keys(availability.lightCones || {})
  .filter((k) => coneCostOf(k, availability) === 0);
const LIMITED_CHARS = Object.keys(availability.characters || {})
  .filter((k) => charCostOf(k, availability) > 0);

// ---- 虚拟账号清单 -----------------------------------------------------------
//
// 每个账号：`chars` = { 中文名: 星魂档 }、`cones` = { 中文光锥: 叠影 }。
// 免费角色（4★ / 常驻 / 开拓者）统一按 E6 预置、免费光锥按 S5 —— 真实账号都有，
// 而且它们的成本恒为 0，不影响分数，只影响界面上「已有 / 缺」的显示。
const ACCOUNTS = [
  {
    id: 'virtual-newbie',
    nickname: '虚拟·全新账号（0 限定）',
    note: '只有免费角色。看「从零开始该抽什么」。',
    chars: {}, cones: {},
  },
  {
    id: 'virtual-single',
    nickname: '虚拟·单核起步（遐蝶 E0）',
    note: '一个限定本体，没有任何星魂与专锥。',
    chars: { 遐蝶: 0 }, cones: {},
  },
  {
    id: 'virtual-light',
    nickname: '虚拟·小氪（遐蝶 E0S1 + 风堇 E0）',
    note: '两个限定本体 + 一把专锥。',
    chars: { 遐蝶: 0, 风堇: 0 }, cones: { '让告别，更美一些': 1 },
  },
  {
    id: 'virtual-mid',
    nickname: '虚拟·中氪（遐蝶 E2S1 + 风堇 E2 + 昔涟 E0）',
    note: '核心队成型一半，专锥只有一把。',
    chars: { 遐蝶: 2, 风堇: 2, 昔涟: 0 },
    cones: { '让告别，更美一些': 1 },
  },
  {
    id: 'virtual-heavy',
    nickname: '虚拟·重氪（遐蝶 E6S1 + 昔涟 E2S1 + 风堇 E2 + 长夜月 E2）',
    note: '主力满配，用来验证方案会不会「无事可做」（差额小）时改推别的方向。',
    chars: { 遐蝶: 6, 昔涟: 2, 风堇: 2, 长夜月: 2 },
    cones: { '让告别，更美一些': 1, '爱如此刻永恒': 1 },
  },
  {
    id: 'virtual-baiE',
    nickname: '虚拟·白厄队（白厄 E2S1 + 昔涟 E2 + 刻律德菈 E0 + 花火 E2）',
    note: '复现 2026-10-12 那一问：只差刻律德菈 E0→E1 那一金。',
    chars: { 白厄: 2, 昔涟: 2, 刻律德菈: 0, 花火: 2 },
    cones: { '黎明恰如此燃烧': 1, '爱如此刻永恒': 1 },
  },
  {
    id: 'virtual-full',
    nickname: '虚拟·全图鉴（限定全 E6 + 专锥全 S5）',
    note: '理论上没有队伍需要补金 —— 候选池应当是空的（用来验证「不硬推」）。',
    chars: Object.fromEntries(LIMITED_CHARS.map((k) => [en2zhChar(k), 6])),
    cones: Object.fromEntries(Object.keys(availability.lightCones || {})
      .filter((k) => coneCostOf(k, availability) > 0).map((k) => [en2zhCone(k), 5])),
  },
];

/** 一个虚拟账号 → 账号库里的 `account` 对象（含米游社快照形状）。 */
const toAccount = (spec, index) => {
  const characters = [];
  for (const key of FREE_CHARS) {
    characters.push({ name: en2zhChar(key), rank: 6, actived_constellation_num: 6, equip: null });
  }
  const byName = new Map(characters.map((c) => [c.name, c]));
  for (const [zhNameRaw, tier] of Object.entries(spec.chars)) {
    const key = availability.characters[zhNameRaw] ? zhNameRaw : zh2en('characters', zhNameRaw);
    const name = en2zhChar(key);
    const row = { name, rank: Number(tier) || 0, actived_constellation_num: Number(tier) || 0, equip: null };
    if (byName.has(name)) Object.assign(byName.get(name), row);
    else { characters.push(row); byName.set(name, row); }
  }
  // 光锥依次挂在「限定角色」身上（米游社只返回**装备中**的光锥，界面正是按
  // 「名字 → 最高叠影」建表的，所以挂给谁不影响算分；挂给本人只是看起来更真）。
  const carriers = characters.filter((c) => Object.keys(spec.chars)
    .map((n) => en2zhChar(availability.characters[n] ? n : zh2en('characters', n)))
    .includes(c.name));
  let ci = 0;
  for (const [zhConeRaw, sup] of Object.entries(spec.cones)) {
    const key = availability.lightCones[zhConeRaw] ? zhConeRaw : zh2en('lightCones', zhConeRaw);
    const coneName = en2zhCone(key);
    const rank = Math.max(1, Number(sup) || 1);
    const carrier = carriers[ci] || characters[ci] || characters[0];
    ci += 1;
    if (carrier) carrier.equip = { name: coneName, rank, rank_level: rank };
  }
  // ⚠️ uid 必须是**纯数字**：快照路由是 `/roles/(\d+)/snapshot`（实测传 '9baiE' 会 404）。
  const uid = String(900000 + index + 1);
  return {
    id: spec.id,
    accountId: spec.id,
    nickname: spec.nickname,
    source: 'virtual',
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
    rolesUpdatedAt: new Date().toISOString(),
    roles: [{
      uid, nickname: spec.nickname, level: 70, region: 'prod_gf_cn',
      regionName: '国服', gameBiz: 'hk4e_cn', game: 'hsr',
    }],
    snapshots: {
      [uid]: {
        uid,
        game: 'hsr',
        source: 'virtual',
        characters,
        // 「角色面板」那一块会用到的字段：虚拟账号不做立绘/技能，留空即可。
        details: [],
        basicInfo: { nickname: spec.nickname, level: 70 },
        note: spec.note,
      },
    },
  };
};

const accounts = ACCOUNTS.map((spec, i) => toAccount(spec, i));

if (LIST_ONLY) {
  for (const a of accounts) {
    const snap = a.snapshots[Object.keys(a.snapshots)[0]];
    console.log(`${a.id}\n  昵称：${a.nickname}\n  角色 ${snap.characters.length} 个`
      + `（其中限定 ${snap.characters.filter((c) => charCostOf(zh2en('characters', c.name), availability) > 0).length} 个）`
      + `｜光锥 ${snap.characters.filter((c) => c.equip).length} 把`);
  }
} else {
  fs.writeFileSync(OUT, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`);
  console.log(`已写入 ${OUT}：${accounts.length} 个虚拟账号`);
  console.log(`启动沙箱界面（**不碰真实账号库**）：`);
  // ⚠️ `DSH_HSR_DATA_FILE` 是**相对 `data/` 目录**解析的（`resolve(cwd, 'data', env)`），
  //    写 'data/accounts-virtual.json' 会变成 data/data/...（实测踩过）。
  console.log(`  $env:DSH_HSR_DATA_FILE='${OUT.replace(/^data[\\/]/, '')}'; node bin/serve.mjs --port 8372 --host 127.0.0.1`);
  console.log('');
  for (const a of accounts) {
    const snap = a.snapshots[Object.keys(a.snapshots)[0]];
    console.log(`  · ${a.nickname}｜${snap.characters.length} 个角色；${a.snapshots[Object.keys(a.snapshots)[0]].note}`);
  }
}
