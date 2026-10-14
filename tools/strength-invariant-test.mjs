// 强度口径的两条不变式（用户 2026-10-14 点名）：
//   ① 成本账：限定角色 E0S0 = 1 金 … E6S5 = **12 金**（不算隐金）；
//   ② **投入越高强度不可能更低**：任何角色都满足 E6S5 > E6S1 > E2S1 > E0S0
//      —— 哪怕低投入档位先达成 0 行动值通关（稀疏数据也不许把高投入档位压低）。
//
// 数据依赖：需要 theherta/archive.json + i18n（离线，不联网）。缺数据时跳过而不是假绿。
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { packGoldOf, eidolonTierOf } from '../public/scripts/advice.js';
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
console.log('▶ ② 强度对「投入」单调（E6S5 ≥ E6S1 ≥ E2S1 ≥ E0S0，且同角色内可比档位不降）');
// 取一批有代表性的角色（输出里能看到具体数值，便于人工核对）。
const want = ['Hyacine', 'Tribbie', 'Yao Guang', 'Castorice', 'Evernight', 'Sparxie', 'Acheron', 'Cipher'];
const rowsOf = async (name) => {
  const res = await archiveCharacterPacks(name);
  const packs = res.packs || [];
  const byES = new Map();
  for (const p of packs) {
    const key = `${eidolonTierOf(p.eidolon)}|${Math.max(1, Number(p.superimp) || 1)}`;
    const cur = byES.get(key);
    if (!cur || Number(p.strengthScore) > Number(cur.strengthScore)) byES.set(key, p);
  }
  return byES;
};
let checkedChars = 0;
let checkedPairs = 0;
let worst = null;
const chainInfo = [];
// ⚠️ 先把数据全收完（异步），再跑**同步**断言 —— `check()` 是同步的，里面 `await` 会直接
// 抛 SyntaxError（实测踩过：Unexpected reserved word）。
for (const name of want) {
  const byES = await rowsOf(name);
  if (!byES.size) continue;
  checkedChars += 1;
  const entries = [...byES.entries()].map(([k, p]) => {
    const [e, s] = k.split('|').map(Number);
    return { e, s, score: Number(p.strengthScore), gold: Number(p.gold) };
  });
  // 二维偏序：E' ≤ E 且 S' ≤ S ⇒ score' ≤ score（这条一成立，点名的那条链自然成立）
  for (const a of entries) {
    for (const b of entries) {
      if (a.e > b.e || a.s > b.s) continue;
      if (a.e === b.e && a.s === b.s) continue;
      checkedPairs += 1;
      if (a.score > b.score + 1e-6) {
        const bad = `E${a.e}S${a.s}(${a.score.toFixed(1)}) > E${b.e}S${b.s}(${b.score.toFixed(1)})`;
        if (!worst) worst = `${name}: ${bad}`;
      }
    }
  }
  const chain = [[6, 5], [6, 1], [2, 1], [0, 0]]
    .map(([e, s]) => {
      const hit = entries.find((x) => x.e === e && x.s === s);
      return hit ? `E${e}S${s}=${hit.score.toFixed(1)}(金${hit.gold})` : `E${e}S${s}=—`;
    }).join('  ');
  chainInfo.push(`${name}: ${chain}`);
  console.log(`     ${chain}`);
}
check(`⭐ 抽样 ${checkedChars} 个角色、${checkedPairs} 组可比档位：投入更高时强度从不更低`, () => {
  assert.equal(worst, null, worst || '');
});
check('点名的链在抽样角色上**严格**成立（E6S5 > E6S1 > E2S1 > E0S0）', () => {
  // 只在四档齐全的角色上判「严格」（缺档的不算）。严格 > 的依据：投入项占 5 分，
  // 而行动值那 95 分已经被单调包络抹平 —— 所以 E6S5 必然比 E6S1 高 5×(12−8)/12 ≈ 1.7 分。
  const need = [[6, 5], [6, 1], [2, 1], [0, 0]];
  const vals = need.map(() => null);
  // 用上面收好的数值（按角色各自判，缺档跳过）。
  const byChar = new Map(chainInfo.map((line) => [line.split(':')[0], line]));
  let any = false;
  for (const name of want) {
    if (!byChar.has(name)) continue;
    const line = byChar.get(name);
    const got = need.map(([e, s]) => {
      const m = line.match(new RegExp(`E${e}S${s}=([\\d.]+)`));
      return m ? Number(m[1]) : null;
    });
    if (got.some((v) => v === null)) continue;
    any = true;
    for (let i = 0; i + 1 < got.length; i += 1) {
      assert.ok(got[i] > got[i + 1] + 1e-6,
        `${name}: E${need[i].join('S')}(${got[i].toFixed(1)}) 必须严格大于 E${need[i + 1].join('S')}(${got[i + 1].toFixed(1)})`);
    }
  }
  void vals;
  if (!any) console.log('     （没有四档齐全的角色，跳过严格判定）');
});

console.log('');
console.log(`强度口径不变式：${passed} 项通过${process.exitCode ? '，有失败' : ' ✓'}`);
