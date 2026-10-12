// 手工探针（_ 前缀）：专查「Archer E0 / 其光锥 S1 时队伍成本被减 2」这一条。
//
// 用户 2026-10-11 报告：「archer 在 E0 或者其光锥在 S1 的情况下，整个队伍成本下降了 2，
// 这是不对的」。这里把**每一种相关组合**的减免逐条打出来，并在真实前沿池里找出
// 「Archer E0」的行，把 原始金数 / 减免 / 减免后 三个数并排看 —— 先量清楚是哪一支在减。
//
//   node tools/_probe-yinjin-archer.mjs

import {
  DEFAULT_HIDDEN_COSTS, hiddenReductionOf, packGoldOf, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const index = await archiveIndex();
const availability = index.refs?.availability || {};
const ON = { ...DEFAULT_HIDDEN_COSTS };
const HELL = 'The Hell Where Ideals Burn';
const BEHOLD = 'I Am As You Behold';

/** 一个成员的「自付金数」的两种口径（与 advice.js 的 memberGoldParts 同算法，这里只用于核对）。 */
const owns = (m) => {
  const body = availability.characters?.[m.char]?.limited === false ? 0 : (m.char ? 1 : 0);
  const eid = Math.max(0, Math.min(6, Math.round(Number(m.eidolon) || 0)));
  const cone = m.lc && availability.lightCones?.[m.lc]?.limited !== false && m.lc ? 1 : 0;
  const sup = Math.max(1, Math.round(Number(m.superimp) || 1));
  return { dataset: body + (body > 0 ? eid : 0) + cone * sup, tiered: body + (body > 0 ? eid : 0) + cone };
};

const cases = [
  ['Archer E0（不带赠送光锥）', [{ char: 'Archer', eidolon: 0, lc: 'Cruising in the Stellar Sea', superimp: 5 }]],
  ['Archer E0 + 理想燃烧的地狱 S1', [{ char: 'Archer', eidolon: 0, lc: HELL, superimp: 1 }]],
  ['Archer E0 + 理想燃烧的地狱 S5', [{ char: 'Archer', eidolon: 0, lc: HELL, superimp: 5 }]],
  ['Archer E1 + 理想燃烧的地狱 S1', [{ char: 'Archer', eidolon: 1, lc: HELL, superimp: 1 }]],
  ['Archer E6 + 理想燃烧的地狱 S1', [{ char: 'Archer', eidolon: 6, lc: HELL, superimp: 1 }]],
  ['别人带理想燃烧的地狱 S1（无 Archer）', [{ char: 'Solid', eidolon: 0, lc: HELL, superimp: 1 }]],
  ['Archer E0 + 所见即我 S1', [{ char: 'Archer', eidolon: 0, lc: BEHOLD, superimp: 1 }]],
  ['Archer E0 + 吉尔伽美什 E0', [{ char: 'Archer', eidolon: 0 }, { char: 'Gilgamesh', eidolon: 0 }]],
  ['Archer E0 + 吉尔伽美什 E0 + 地狱 S1', [{ char: 'Archer', eidolon: 0, lc: HELL, superimp: 1 },
    { char: 'Gilgamesh', eidolon: 0 }]],
  ['地狱 S1 + 所见即我 S1（两个成员各一把）', [{ char: 'Solid', eidolon: 0, lc: HELL, superimp: 1 },
    { char: 'Buddy', eidolon: 0, lc: BEHOLD, superimp: 1 }]],
];

console.log('=== 各组合的减免（team = 整队减几金；byIndex = 每个成员各减几金）===');
for (const [label, members] of cases) {
  const d = hiddenReductionOf(members, availability, ON, 'dataset');
  const t = hiddenReductionOf(members, availability, ON, 'tiered');
  const ownSum = members.reduce((n, m) => n + owns(m).dataset, 0);
  const tag = d.team > ownSum ? '  ⚠️ 减得比自付金数还多' : (d.team > 0 ? '' : '  （不减）');
  console.log(`  ${label}`);
  console.log(`      dataset: team=${d.team} byIndex=[${d.byIndex}]  `
    + `tiered: team=${t.team} byIndex=[${t.byIndex}]  该成员自付 dataset=${ownSum}${tag}`);
}

// ---- 真实前沿池：含 Archer 的行 ----
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
let rows = 0;
let bad = 0;
const samples = [];
/** 「减免 2 是怎么来的」——按成员归属聚合，看清是哪一项在减。 */
const shapeOf = new Map();
for (const f of frontierAll) {
  for (const row of f.frontierRows || []) {
    const members = (row.members || []).map((m) => ({
      char: m.char, eidolon: m.eidolon ?? 0, lc: m.lc || null, superimp: m.superimp ?? 1,
    }));
    if (!members.some((m) => m.char === 'Archer')) continue;
    rows += 1;
    const stored = Math.max(0, Math.round(Number(row.cost) || 0));
    const red = hiddenReductionOf(members, availability, ON, 'dataset');
    const personal = members.reduce((n, m) => n + owns(m).dataset, 0);
    if (red.team > personal) bad += 1;
    if (samples.length < 6) samples.push({ env: f.env, stored, cut: red.team, personal, members });
    // 归属形状：把每个成员的减免拆成「角色那一份 / 光锥那一份」，看 -2 是谁贡献的
    const parts = members
      .map((m, i) => ({ m, i }))
      .filter(({ i }) => red.byIndex[i] > 0)
      .map(({ m, i }) => {
        const p = owns(m);
        return `${m.char}E${m.eidolon}${m.lc ? `+${m.lc.replace(/\s.*$/, '')}S${m.superimp}` : ''}`
          + `=${red.byIndex[i]}`;
      });
    const shape = `${red.team} 金 ← ${parts.join(' , ')}`;
    if (red.team === 2) shapeOf.set(shape, (shapeOf.get(shape) || 0) + 1);
  }
}
console.log(`\n=== 真实前沿池：含 Archer 的行 ${rows} 条，其中「减免 > 成员自付合计」的 ${bad} 条 ===`);

// ---- 穷举不变量核对（用户 2026-10-11 追问「E0 / S1 时整队被减 2」后加的）----------
//
// 用 `hiddenReductionOf` 分开返回的 `byIndexChar` / `byIndexCone` 判四条：
//   ① 角色那一份 ≤ 该成员角色自己的金数（本体 + 星魂）
//   ② 光锥那一份 ≤ 该成员光锥自己的金数（本体 × 叠影）
//   ③ E0 的 Archer，**角色那一份**最多 1（规则 -2，但 E0 只有 1 金可减）
//   ④ S1 的理想燃烧的地狱，**光锥那一份**最多 1（规则 -2，但 S1 只有 1 金可减）
// 四条全 0 违反 ⇒ 封顶无漏洞；此时整队出现 -2 只可能是「两个受赠项叠加」（用户已确认）。
const charOwn = (m) => {
  const body = availability.characters?.[m.char]?.limited === false ? 0 : 1;
  const eid = Math.max(0, Math.min(6, Math.round(Number(m.eidolon) || 0)));
  return body + (body > 0 ? eid : 0);
};
const coneOwn = (m) => {
  if (!m.lc) return 0;
  if (availability.lightCones?.[m.lc]?.limited === false) return 0;
  return Math.max(1, Math.round(Number(m.superimp) || 1));
};
let over = 0;         // ① 角色那份超自付
let coneOver = 0;     // ② 光锥那份超自付
let archerOver = 0;   // ③ E0 Archer 的角色那份 > 1
let coneSubOver = 0;  // ④ S1 理想燃烧的地狱的光锥那份 > 1
const list = (msg) => { console.log(`  ⚠️ ${msg}`); };
for (const f of frontierAll) {
  for (const row of f.frontierRows || []) {
    const members = (row.members || []).map((m) => ({
      char: m.char, eidolon: m.eidolon ?? 0, lc: m.lc || null, superimp: m.superimp ?? 1,
    }));
    if (!members.length) continue;
    const red = hiddenReductionOf(members, availability, ON, 'dataset');
    members.forEach((m, i) => {
      if (red.byIndexChar[i] > charOwn(m)) {
        over += 1;
        if (over <= 3) list(`${f.env}：${m.char}E${m.eidolon} 角色那份被减 ${red.byIndexChar[i]} > 自付 ${charOwn(m)}`);
      }
      if (red.byIndexCone[i] > coneOwn(m)) {
        coneOver += 1;
        if (coneOver <= 3) list(`${f.env}：${m.char} 光锥那份被减 ${red.byIndexCone[i]} > 自付 ${coneOwn(m)}`);
      }
      if (m.char === 'Archer' && m.eidolon === 0 && red.byIndexChar[i] > 1) {
        archerOver += 1;
        if (archerOver <= 3) list(`${f.env}：E0 Archer 角色那份被减 ${red.byIndexChar[i]} > 1`);
      }
      if (m.lc === 'The Hell Where Ideals Burn' && m.superimp === 1 && red.byIndexCone[i] > 1) {
        coneSubOver += 1;
        if (coneSubOver <= 3) list(`${f.env}：S1 理想燃烧的地狱 光锥那份被减 ${red.byIndexCone[i]} > 1`);
      }
    });
  }
}
console.log('\n=== 穷举不变量（全部前沿行，逐成员；用分开的角色 / 光锥归属判）===');
console.log(`  ① 角色那份 > 角色自付：${over}`);
console.log(`  ② 光锥那份 > 光锥自付：${coneOver}`);
console.log(`  ③ E0 Archer 的角色那份 > 1：${archerOver}`);
console.log(`  ④ S1 理想燃烧的地狱的光锥那份 > 1：${coneSubOver}`);
console.log('  ← 四项全 0 = 封顶没有漏洞；此时整队 -2 只可能来自「两个受赠项叠加」（用户已确认）');
console.log('\n=== 「整队减 2 金」的行都是怎么构成的（按出现次数）===');
for (const [shape, n] of [...shapeOf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(4)} 次  ${shape}`);
}
for (const s of samples) {
  console.log(`\n  样例 ${s.env}  原始 ${s.stored} 金 − 减免 ${s.cut} = ${Math.max(1, s.stored - s.cut)} 金`
    + `（成员自付合计 ${s.personal}，整包金数 ${s.members.map((m) => packGoldOf(m, availability)).join('/')}）`);
  console.log(`      ${s.members.map((m) => `${m.char}E${m.eidolon}${m.lc ? `+${m.lc}S${m.superimp}` : ''}`).join(' / ')}`);
}
