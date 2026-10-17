// 强度口径的不变式。
//
// 用户 2026-10-17 第 2、3 条（本轮整条重做，**推翻了 2026-10-14 的方向**）：
//   ① 成本账：限定角色 E0S0 = 1 金 … E6S5 = **12 金**（不算隐金）；
//   ② **强度与成本无相关性** —— 投入项（那 5 分）与「投入越高不更弱」的单调包络
//      **双双删除**。2026-10-14 的不变式「E6S5 > E6S1 > E2S1 > E0S0」由用户自己推翻；
//   ③ **新两档规则**（逐版本各自算，再按用户设的版本权重加权）：
//        ```
//        0 行动值 → 100 × (该版本 0 行动值配置的最省金 ÷ 本队金数)   顶格档
//        否则     → min(90, 该版本 0 行动值档的最低分) × 强度曲线(行动值)
//        ```
//      用户原话三句：「若某个队伍达成**最低金 0 行动值绝境**，则此配队视为 **100 强度分
//      （最高值）**」「其余必须低于 100 分：(1) 需要更多金达成 0 行动值的投稿，降低强度分；
//      (2) 48 金也达不成的低于 (1)」「每一期的最省金的得分最高 100 分，其余等比降分，
//      **注意不要跨版本对比**，版本权重要按照用户设置的做」。
//
// ⚠️ 本文件不再需要「投入档位」那把尺子（星魂档 + 要金光锥的叠影档）：强度里已经没有
//    投入这一维。`packGoldOf` 的成本账仍然要守 —— 它是**性价比**那一项的输入。
//
// 数据依赖：需要 theherta/archive.json + i18n（离线，不联网）。缺数据时跳过而不是假绿。
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  SCORING, buildConclusion, packGoldOf, perfFactorOf,
} from '../public/scripts/advice.js';
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

// ======================================================================
// ② 合成夹具：新两档规则逐版本怎么算（不依赖真实数据，口径钉死）
// ======================================================================
console.log('');
console.log('▶ ② 新两档规则（合成夹具：0 行动值 → 100 × 最省金 ÷ 本队金数）');

/** 造一个绝境王棋关环境（`aa|plight`）：判据线 300 / 500，行动值越小越好。 */
const plightEnv = (rows, seasons, seasonWeights, zeroAvGoldBySeason) => ({
  id: 'aa|plight',
  mode: 'aa',
  stage: 'plight',
  label: '绝境王棋关',
  season: seasons[seasons.length - 1],
  totalRuns: 100,
  tierLines: { perfect: 300, target: 500 },
  lowerIsBetter: true,
  teams: [],
  frontierRows: rows,
  // 服务端算好的逐版本「0 行动值」金数区间（`aggregateTeams` 的 `zeroAvGoldBySeason`）。
  zeroAvGoldBySeason,
});

const runPlight = (rows, seasons, seasonWeights, zeroAvGoldBySeason, extra = {}) => {
  const env = plightEnv(rows, seasons, seasonWeights, zeroAvGoldBySeason);
  return buildConclusion([env], {
    availability: { characters: {}, lightCones: {} },
    firstSeen: { characters: {}, lightCones: {}, byMode: {} },
    frontier: {
      'aa|plight': { seasons, seasonWeights, weight: 10, frontierRows: rows },
    },
    ...extra,
  });
};

const member = (char) => [{ char, eidolon: 0 }];
// 强度那把尺子（`SCORING.strengthLineWeights`）在判据线上的取值：
//   av = 0 → 1.00；满分线 300 → 0.80；达标线 500 → 0.45；再往外线性衰减到地板。
// ⚠️ 它与**性价比**那条曲线（`frontierPerfLineByEnv`：绝境满分线以内平的 1.00）
//    **不是同一把尺子** —— 混用会让第二档按性价比的曲线打分（用户 2026-10-17 踩过）。
const strengthPerf = (av) => perfFactorOf(av, { perfect: 300, target: 500 }, true, 'perfect',
  SCORING.strengthLineWeights);
const unitOf = (out, name) => out.frontierUnits.find((u) => u.name === name);
const envOf = (out, name) => unitOf(out, name)?.envs?.[0];

// ---- ②-A 单版本：顶格档按「该期最省金 ÷ 本队金数」等比降分 --------------------
{
  const rows = [
    // 4.5 期的 0 行动值配置：最省 10 金、最贵 40 金
    { cost: 10, actionValue: 0, tier: 'perfect', newestSeason: '4.5', members: member('Cheap') },
    { cost: 40, actionValue: 0, tier: 'perfect', newestSeason: '4.5', members: member('Pricey') },
    // 4.5 期**打不出** 0 行动值的两个配置（行动值 400 落在满分线 300 与达标线 500 之间）
    { cost: 20, actionValue: 400, tier: 'perfect', newestSeason: '4.5', members: member('NoZero') },
    { cost: 20, actionValue: 299, tier: 'perfect', newestSeason: '4.5', members: member('Inside') },
  ];
  const zero = { '4.5': { min: 10, max: 40 } };
  const out = runPlight(rows, ['4.5'], { '4.5': 1 }, zero);

  check('⭐ 顶格档：0 行动值且取到该期最省金 → 强度分 100', () => {
    const cheap = unitOf(out, 'Cheap');
    assert.ok(cheap, 'Cheap 应进榜');
    assert.equal(Number(cheap.strengthScore), 100, `实际 ${cheap.strengthScore}`);
    assert.equal(cheap.strengthTopBand, true, '顶格标记要跟着亮');
  });
  check('0 行动值但花更多金 → 等比降分（100 × 最省金 ÷ 本队金数）', () => {
    const pricey = envOf(out, 'Pricey');
    assert.ok(pricey, 'Pricey 应进榜');
    assert.ok(Math.abs(Number(pricey.envStrength) - 25) < 1e-6,
      `40 金那一档应为 100×10/40 = 25，实际 ${pricey.envStrength}`);
  });
  check('⭐ (2) 打不出 0 行动值的档**必须低于**同期 0 行动值档的最低分', () => {
    const noZero = envOf(out, 'NoZero');
    const pricey = envOf(out, 'Pricey');
    assert.ok(noZero && pricey, '两档都应进榜');
    // 封顶 = min(90, 100×10/40 = 25) = 25；行动值 400 的强度曲线分见 `strengthPerf`
    const want = 25 * strengthPerf(400);
    // 载荷上的 `envStrength` 过了一道 `toFixed(4)`，容差放到 1e-3。
    assert.ok(Math.abs(Number(noZero.envStrength) - want) < 1e-3,
      `NoZero 应为 25 × ${strengthPerf(400).toFixed(4)} = ${want.toFixed(4)}，实际 ${noZero.envStrength}`);
    assert.ok(Number(noZero.envStrength) < Number(pricey.envStrength) - 1e-6,
      '「48 金也达不成 0 行动值」必须低于「需要更多金才达成」那一档');
  });
  check('非 0 行动值档的封顶同时受 90 与「该期 0 行动值档最低分」两条约束', () => {
    // Inside：行动值 299 就在满分线内侧 → 曲线分仍 < 1（强度曲线全程递减，没有平的 1.00），
    // 所以 25 × perf < 25，**不会因为 90 这条松上限而越过 Pricey 的 25**
    // —— 那正是「(2) 只是强调必须低于 (1)」。
    const inside = envOf(out, 'Inside');
    assert.ok(inside, 'Inside 应进榜');
    const want = 25 * strengthPerf(299);
    assert.ok(Math.abs(Number(inside.envStrength) - want) < 1e-3,
      `Inside 应为 25 × ${strengthPerf(299).toFixed(4)} = ${want.toFixed(4)}，实际 ${inside.envStrength}`);
    assert.ok(Number(inside.envStrength) <= Number(envOf(out, 'Pricey').envStrength) + 1e-6,
      '第二档不许越过同期 0 行动值档的最低分');
  });
  check('强度分与「本档自身合计」只差一道天花板（包络已删，不再向上兜底）', () => {
    for (const name of ['Cheap', 'Pricey', 'NoZero', 'Inside']) {
      const u = unitOf(out, name);
      assert.ok(Number(u.strengthFloor) <= Number(u.strengthTotal) + 1e-6,
        `${name}: strengthFloor ${u.strengthFloor} 不该高于自身合计 ${u.strengthTotal}（包络已删除）`);
      const want = Number(u.strengthTotal) >= 99.99
        ? Number(u.strengthTotal) : Math.min(Number(u.strengthTotal), SCORING.strengthSecondBandCap);
      assert.ok(Math.abs(Number(u.strengthScore) - want) < 1e-6,
        `${name}: 强度分应为 min(自身, 90)，实际 ${u.strengthScore} vs ${want}`);
    }
  });
  check('非顶格档的强度分一律 ≤ 90（用户 2026-10-16 第 1 条的天花板）', () => {
    for (const name of ['Pricey', 'NoZero', 'Inside']) {
      const u = unitOf(out, name);
      assert.equal(u.strengthTopBand, false, `${name} 不该是顶格档`);
      assert.ok(Number(u.strengthScore) <= SCORING.strengthSecondBandCap + 1e-6,
        `${name}: ${u.strengthScore} 超过了第二档天花板`);
    }
  });
  check('投入项已整条删除（`SCORING.investWeight` 恒 0）', () => {
    assert.equal(Number(SCORING.investWeight), 0,
      '强度与成本无相关性 —— 这一项不许再调回非 0');
  });
}

// ---- ②-B 两个版本：版本权重必须按用户设置生效 --------------------------------
{
  const rows = [
    // Half：4.5 期 10 金 0 行动值（该期最省）；4.4 期 20 金 0 行动值（该期最省 5 金）
    { cost: 10, actionValue: 0, tier: 'perfect', newestSeason: '4.5', members: member('Half') },
    { cost: 20, actionValue: 0, tier: 'perfect', newestSeason: '4.4', members: member('Half') },
    // Anchor：把 4.4 期的最省金压到 5 金（否则 Half 在 4.4 也是满分）
    { cost: 5, actionValue: 0, tier: 'perfect', newestSeason: '4.4', members: member('Anchor') },
  ];
  const zero = { '4.5': { min: 10, max: 10 }, '4.4': { min: 5, max: 20 } };
  const seasons = ['4.4', '4.5'];

  check('⭐ 版本权重按用户设置生效（同一份数据，换权重就换分）', () => {
    // 4.5 期 100 × 3、4.4 期 100×5/20 = 25 × 1 → (300 + 25) / 4 = 81.25
    const a = runPlight(rows, seasons, { '4.5': 3, '4.4': 1 }, zero);
    const halfA = envOf(a, 'Half');
    assert.ok(halfA, 'Half 应进榜');
    assert.ok(Math.abs(Number(halfA.envStrength) - 81.25) < 1e-6,
      `权重 3:1 时应为 81.25，实际 ${halfA.envStrength}`);
    // 换成 1:3 → (100 + 75) / 4 = 43.75
    const b = runPlight(rows, seasons, { '4.5': 1, '4.4': 3 }, zero);
    const halfB = envOf(b, 'Half');
    assert.ok(Math.abs(Number(halfB.envStrength) - 43.75) < 1e-6,
      `权重 1:3 时应为 43.75，实际 ${halfB.envStrength}`);
    assert.ok(Number(halfA.envStrength) > Number(halfB.envStrength),
      '新版本权重更高时，4.5 期拿满分的那一档必须更高');
  });
  check('⭐ 顶格档要求「每个有数据的版本都取到该期最省金」', () => {
    // Half 在 4.4 期是 20 金、而该期最省 5 金 → 那一期不是满分 → 整包不是顶格档。
    const a = runPlight(rows, seasons, { '4.5': 3, '4.4': 1 }, zero);
    const half = unitOf(a, 'Half');
    assert.equal(half.strengthTopBand, false,
      '4.4 期没取到最省金 → 不许算顶格档');
    assert.ok(Number(half.strengthScore) < 100, '非顶格档必须低于 100');
  });
}

// ======================================================================
// ③ 真实数据：包络确实没了、天花板还在、顶格档自洽
// ======================================================================
console.log('');
console.log('▶ ③ 真实数据（强度分 = 本档自己的成绩，无投入项、无包络）');
const want = ['Yao Guang', 'Hyacine', 'Tribbie', 'Castorice', 'Evernight', 'Sparxie',
  'Acheron', 'Cipher', 'Phainon', 'Hysilens', 'Ashveil', 'Evanescia'];
const samples = [];
for (const name of want) {
  const res = await archiveCharacterPacks(name);
  const packs = (res.packs || []).filter((p) => Number.isFinite(Number(p.strengthScore)));
  if (!packs.length) continue;
  samples.push({ name, packs });
}
console.log(`     ${samples.length} 个角色、${samples.reduce((n, s) => n + s.packs.length, 0)} 条整包`);

check('⭐ 单调包络已删除：同角色不同投入档位的强度分**不再互相拉平**', () => {
  // 2026-10-14 的包络会让同角色四档拿到同一个数（实测真珠 E0/E1/E2/E6 全是 73.33）。
  // 现在每一档是自己的成绩 —— 找一例「投入更高、强度更低」来证明包络真的不在了。
  let flat = 0;
  let higher = 0;
  let lower = 0;
  for (const { packs } of samples) {
    const best = new Map();
    for (const p of packs) {
      const k = `${p.eidolon}|${p.lc || '-'}|${p.superimp}`;
      if (!best.has(k) || Number(p.strengthScore) > Number(best.get(k).strengthScore)) best.set(k, p);
    }
    const list = [...best.values()];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = 0; j < list.length; j += 1) {
        if (i === j) continue;
        const a = list[i];
        const b = list[j];
        if ((Number(a.gold) || 0) <= (Number(b.gold) || 0)) continue;
        if (Math.abs(Number(a.strengthScore) - Number(b.strengthScore)) < 1e-6) flat += 1;
        if (Number(a.strengthScore) > Number(b.strengthScore) + 1e-6) higher += 1;
        if (Number(a.strengthScore) < Number(b.strengthScore) - 1e-6) lower += 1;
      }
    }
  }
  console.log(`     更贵却同分 ${flat} 组；更贵更高 ${higher} 组；更贵反而更低 ${lower} 组`);
  assert.ok(lower > 0,
    '一条「更贵反而更低」都没有 —— 单调包络可能复活了（用户 2026-10-17 第 2 条要求强度与成本无相关性）');
  // 反方向也必须存在：否则只是把单调性反过来，那同样是「成本决定强度」。
  assert.ok(higher > 0,
    `一条「更贵更高」都没有（实际 ${higher}）—— 强度不该被成本单向决定，两个方向都要有实例`);
});

check('非顶格档的强度分一律 ≤ 90；顶格档 = 100', () => {
  let top = 0;
  let second = 0;
  for (const { packs } of samples) {
    for (const p of packs) {
      const score = Number(p.strengthScore);
      if (Number(p.strengthTotal) >= 99.99) {
        top += 1;
        assert.ok(Math.abs(score - 100) < 1e-6, `顶格档应为 100，实际 ${score}`);
      } else {
        second += 1;
        assert.ok(score <= SCORING.strengthSecondBandCap + 1e-6,
          `非顶格档 ${score} 超过了 ${SCORING.strengthSecondBandCap}`);
      }
    }
  }
  console.log(`     顶格档 ${top} 条、第二档 ${second} 条`);
});

check('顶格档的自洽性：每一关都 100 ⇔ 整包强度 100', () => {
  let allHundred = 0;
  let compositeTop = 0;
  for (const { packs } of samples) {
    for (const p of packs) {
      const envs = p.envs || [];
      if (!envs.length) continue;
      const every = envs.every((e) => Math.abs(Number(e.envStrength) - 100) < 1e-6);
      if (every) {
        allHundred += 1;
        assert.ok(Number(p.strengthTotal) >= 99.99,
          `每一关都是 100，整包强度却只有 ${p.strengthTotal}`);
      }
      if (Number(p.strengthTotal) >= 99.99) {
        compositeTop += 1;
        assert.ok(every, '整包强度 100 但有关卡不是 100');
        assert.ok(Math.abs(Number(p.strengthScore) - 100) < 1e-6, '顶格档的强度分必须是 100');
      }
    }
  }
  console.log(`     每一关都 100 的整包 ${allHundred} 条；整包顶格 ${compositeTop} 条`);
});

console.log('');
console.log(`强度口径不变式：${passed} 项通过${process.exitCode ? '，有失败' : ' ✓'}`);
