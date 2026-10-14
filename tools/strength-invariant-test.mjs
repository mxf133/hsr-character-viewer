// 强度口径的两条不变式（用户 2026-10-14 点名）：
//   ① 成本账：限定角色 E0S0 = 1 金 … E6S5 = **12 金**（不算隐金）；
//   ② **投入越高强度不可能更低**：任何角色都满足 E6S5 > E6S1 > E2S1 > E0S0
//      —— 哪怕低投入档位先达成 0 行动值通关（稀疏数据也不许把高投入档位压低）；
//   ③ **要金的光锥压过免费光锥**：用户追加的「从纯粹强度考虑，1+1 爻光为什么不如 1+0 爻光」
//      —— 免费 / 4★ 光锥的叠影**不花一抽**，不该算进投入档位（爻光 E1 实测：免费锥 S5
//      曾经 95.0 > 专武 S1 93.2，就是这条被算错）。
//
// ⚠️ 本文件里的「投入档位」必须与 `advice.js` 的 `investRankOf()` **同一把尺子**：
//    星魂档 + **要金光锥**的叠影档。改那边就要改这里，否则测试会假绿。
//
// 数据依赖：需要 theherta/archive.json + i18n（离线，不联网）。缺数据时跳过而不是假绿。
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { packGoldOf, eidolonTierOf, coneCostOf } from '../public/scripts/advice.js';
import { archiveIndex } from '../src/server/archive.js';
import { archiveCharacterPacks } from '../src/server/conclusion.js';

const ROOT = resolve(import.meta.dirname, '..');
let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
    process.exitCode = 1;
  }
};

const archive = resolve(ROOT, 'theherta/archive.json');
if (!existsSync(archive)) {
  console.log('  跳过：theherta/archive.json 不存在（先跑 herta-build）');
  process.exit(0);
}
const index = await archiveIndex();
const availability = index.refs?.availability || {};
const limitedChar = Object.keys(availability.characters || {})
  .find((k) => availability.characters[k]?.limited === true && !/\b(Trailblazer)/.test(k));
const limitedCone = Object.keys(availability.lightCones || {})
  .find((k) => availability.lightCones[k]?.limited === true);

console.log('▶ ① 成本账（整包金数，不算隐金）');
check('限定角色 E0S0 = 1 金（只有本体）', () => {
  assert.equal(packGoldOf({ char: limitedChar, eidolon: 0, lc: null, superimp: 0 }, availability), 1);
});
check('限定角色 E0S1 = 2 金', () => {
  assert.equal(packGoldOf({ char: limitedChar, eidolon: 0, lc: limitedCone, superimp: 1 }, availability), 2);
});
check('限定角色 E2S1 = 4 金（本体 + 2 星魂 + 光锥）', () => {
  assert.equal(packGoldOf({ char: limitedChar, eidolon: 2, lc: limitedCone, superimp: 1 }, availability), 4);
});
check('限定角色 E6S1 = 8 金', () => {
  assert.equal(packGoldOf({ char: limitedChar, eidolon: 6, lc: limitedCone, superimp: 1 }, availability), 8);
});
check('⭐ 限定角色 E6S5 = **12 金**（用户点名的那个数）', () => {
  assert.equal(packGoldOf({ char: limitedChar, eidolon: 6, lc: limitedCone, superimp: 5 }, availability), 12,
    'E6S5 应当是 本体1 + 星魂6 + 光锥本体1 + 叠影4 = 12');
});
check('叠影**要算钱**：同一光锥 S5 比 S1 贵 4 金（改前两者同价）', () => {
  const s1 = packGoldOf({ char: limitedChar, eidolon: 0, lc: limitedCone, superimp: 1 }, availability);
  const s5 = packGoldOf({ char: limitedChar, eidolon: 0, lc: limitedCone, superimp: 5 }, availability);
  assert.equal(s5 - s1, 4);
});
check('4★ / 常驻光锥仍是 0 金（乘叠影也不加钱）', () => {
  const free = Object.keys(availability.lightCones || {})
    .find((k) => availability.lightCones[k]?.limited === false);
  if (!free) return;
  assert.equal(packGoldOf({ char: limitedChar, eidolon: 0, lc: free, superimp: 5 }, availability), 1);
});

console.log('');
console.log('▶ ② 强度对「投入」单调（同一把尺子：星魂档 + 要金光锥的叠影档）');
// 取一批有代表性的角色（输出里能看到具体数值，便于人工核对）。
const want = ['Yao Guang', 'Hyacine', 'Tribbie', 'Castorice', 'Evernight', 'Sparxie',
  'Acheron', 'Cipher', 'Phainon', 'Hysilens', 'Ashveil', 'Evanescia'];

/** `advice.js` 的 `coneRankOf()` 同义：**只有要金的光锥**的叠影才算投入档位。 */
const coneRankOf = (p) => (p.lc && coneCostOf(p.lc, availability) > 0
  ? Math.max(1, Math.round(Number(p.superimp) || 1)) : 0);

const rankLabel = (e, c) => `E${e}C${c}`;
const byChar = new Map();      // 角色 → Map(`E{e}C{c}` → { score, gold, e, c })
const coneCompare = [];        // 每个角色每个星魂档：要金锥最高分 vs 免费锥最高分
let checkedChars = 0;
let checkedPairs = 0;
let worst = null;
// ⚠️ 先把数据全收完（异步），再跑**同步**断言 —— `check()` 是同步的，里面 `await` 会直接
// 抛 SyntaxError（实测踩过：Unexpected reserved word）。
for (const name of want) {
  const res = await archiveCharacterPacks(name);
  const packs = (res.packs || []).filter((p) => Number.isFinite(Number(p.strengthScore)));
  if (!packs.length) continue;
  checkedChars += 1;
  const ranks = new Map();
  const paidByE = new Map();
  const freeByE = new Map();
  for (const p of packs) {
    const e = eidolonTierOf(p.eidolon);
    const c = coneRankOf(p);
    const score = Number(p.strengthScore);
    const key = rankLabel(e, c);
    const cur = ranks.get(key);
    if (!cur || score > cur.score) ranks.set(key, { e, c, score, gold: Number(p.gold) });
    const paid = p.lc && coneCostOf(p.lc, availability) > 0;
    const bucket = paid ? paidByE : freeByE;
    if (!bucket.has(e) || score > bucket.get(e)) bucket.set(e, score);
  }
  byChar.set(name, ranks);
  for (const [e, v] of paidByE) {
    if (!freeByE.has(e)) continue;
    coneCompare.push({ name, e, paid: v, free: freeByE.get(e) });
  }
  // 二维偏序：e' ≤ e 且 c' ≤ c（且至少一维严格更小）⇒ score' ≤ score
  const list = [...ranks.values()];
  for (const a of list) {
    for (const b of list) {
      if (a === b) continue;
      if (a.e > b.e || a.c > b.c) continue;
      if (a.e === b.e && a.c === b.c) continue;
      checkedPairs += 1;
      if (a.score > b.score + 1e-6) {
        const bad = `${rankLabel(a.e, a.c)}(${a.score.toFixed(1)}) > ${rankLabel(b.e, b.c)}(${b.score.toFixed(1)})`;
        if (!worst) worst = `${name}: ${bad}`;
      }
    }
  }
  const chain = [[0, 0], [2, 1], [6, 1], [6, 5]]
    .map(([e, c]) => {
      const hit = ranks.get(rankLabel(e, c));
      return hit ? `E${e}${c ? `+专武S${c}` : '无锥'}=${hit.score.toFixed(1)}(金${hit.gold})` : null;
    }).filter(Boolean).join('  ');
  console.log(`     ${name}: ${chain || '（无对标档位）'}`);
}
check(`⭐ 抽样 ${checkedChars} 个角色、${checkedPairs} 组可比档位：投入更高时强度从不更低`, () => {
  assert.equal(worst, null, worst || '');
});
check('⭐ 要金的光锥**压过**免费光锥（用户：「1+1 爻光为什么不如 1+0 爻光」）', () => {
  assert.ok(coneCompare.length > 0, '样本里没有可比的「要金锥 vs 免费锥」组合');
  const bad = coneCompare.filter((x) => x.paid < x.free - 1e-6);
  assert.equal(bad.length, 0,
    bad.slice(0, 5).map((x) => `${x.name} E${x.e}: 要金锥 ${x.paid.toFixed(1)} < 免费锥 ${x.free.toFixed(1)}`).join('；'));
});
check('点名的链在抽样角色上**严格**成立（E6S5 > E6S1 > E2S1 > E0S0）', () => {
  // 只在四档齐全的角色上判「严格」（缺档的不算）。严格 > 的依据：投入项占 5 分，
  // 而行动值那 95 分已经被单调包络抹平 —— 所以 E6S5 必然比 E6S1 高 5×(11−7)/11 ≈ 1.8 分。
  const need = [[6, 5], [6, 1], [2, 1], [0, 0]];
  let any = false;
  for (const [name, ranks] of byChar) {
    const got = need.map(([e, c]) => ranks.get(rankLabel(e, c))?.score ?? null);
    if (got.some((v) => v === null)) continue;
    any = true;
    for (let i = 0; i + 1 < got.length; i += 1) {
      assert.ok(got[i] > got[i + 1] + 1e-6,
        `${name}: E${need[i][0]}+S${need[i][1]}(${got[i].toFixed(1)}) 必须严格大于 `
        + `E${need[i + 1][0]}+S${need[i + 1][1]}(${got[i + 1].toFixed(1)})`);
    }
  }
  if (!any) console.log('     （没有四档齐全的角色，跳过严格判定）');
});

console.log('');
console.log(`强度口径不变式：${passed} 项通过${process.exitCode ? '，有失败' : ' ✓'}`);
