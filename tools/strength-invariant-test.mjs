// 强度口径的不变式。
//
// 2026-10-17 **晚**（本轮再改一次，用户原话：「强度得分应仅考虑强度（不考虑别的，因此
// 低难副本普遍能拿满分）」）：
//
//   ① 成本账：限定角色 E0S0 = 1 金 … E6S5 = **12 金**（不算隐金）—— 它只服务**性价比**。
//   ② **强度只看行动值**：
//        ```
//        0 行动值 → 100
//        否则     → 90 × 强度曲线(行动值)
//        ```
//      金数**完全退出**：改前顶格档是 `100 × 该期最省金 ÷ 本队金数`、第二档封顶是
//      `min(90, 100 × 最省 ÷ 最贵)`，两处都在按成本折分，于是 18 金的队在「1 金就能
//      0 行动值」的副本里只拿个位数。用户当轮明确接受「低难副本普遍拿满分」。
//   ③ **继承**：已登场却缺证据的版本，若同角色有「成本更低**且**那一期有成绩」的整包，
//      取其**最高分**（用户：「人们一般不会上传低难度关卡用超高成本通关的记录」）。
//      继承不到（同角色所有更便宜版本也没成绩）→ 仍是**算 0 分**，权重进分母。
//   ④ 版本权重按用户设置加权；分母永远是**全部副本**的关卡权重（缺副本按 0）。
//
// ⚠️ 2026-10-14 的「E6S5 > E6S1 > E2S1 > E0S0」早已被用户自己推翻（2026-10-17 第 2 条
//    「强度与成本改为无相关性」），这里**不要**再把成本单调性加回来。
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
// ② 合成夹具：两档规则只看行动值（不依赖真实数据，口径钉死）
// ======================================================================
console.log('');
console.log('▶ ② 两档规则（合成夹具：0 行动值 → 100；其余 → 90 × 曲线）');

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
  // ⚠️ 2026-10-17 晚起强度**不再读**这份基准（金数已退出强度）。仍传进来，
  //    是为了有一条判据专门钉「换掉它分数不变」。
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

const member = (char, eidolon = 0) => [{ char, eidolon }];
// 强度那把尺子（`SCORING.strengthLineWeights`）在判据线上的取值：
//   av = 0 → 1.00；满分线 300 → 0.80；达标线 500 → 0.45；再往外线性衰减到地板。
// ⚠️ 它与**性价比**那条曲线（`frontierPerfLineByEnv`：绝境满分线以内平的 1.00）
//    **不是同一把尺子** —— 混用会让第二档按性价比的曲线打分（用户 2026-10-17 踩过）。
const strengthPerf = (av) => perfFactorOf(av, { perfect: 300, target: 500 }, true, 'perfect',
  SCORING.strengthLineWeights);
// ⚠️ 读 `frontierTiers`（按星魂档分的全量），**不要读 `frontierUnits`**：
//    后者是「每个角色只留总分最高的那一条」的收敛结果（用户 2026-10 第 1 条），
//    夹具里 E0 的总分必然高于 E6，E6 会被收敛掉 —— 那是**榜单**的口径，不是算分的口径。
const allUnits = (out) => Object.values(out.frontierTiers || {}).flat();
const unitOf = (out, name) => allUnits(out).find((u) => u.name === name);
const envOf = (out, name) => unitOf(out, name)?.envs?.[0];
const unitOfE = (out, name, eidolon) => allUnits(out)
  .find((u) => u.name === name && Number(u.eidolon) === eidolon);

// ---- ②-A 单版本：强度只由行动值决定，金数不参与 ------------------------------
{
  const rows = [
    // 两个 0 行动值的配置，成本差 4 倍 —— 新口径下**必须同分**
    { cost: 10, actionValue: 0, tier: 'perfect', newestSeason: '4.5', members: member('Cheap') },
    { cost: 40, actionValue: 0, tier: 'perfect', newestSeason: '4.5', members: member('Pricey') },
    // 打不出 0 行动值的两个配置（400 在满分线与达标线之间、299 在满分线内侧）
    { cost: 20, actionValue: 400, tier: 'perfect', newestSeason: '4.5', members: member('NoZero') },
    { cost: 20, actionValue: 299, tier: 'perfect', newestSeason: '4.5', members: member('Inside') },
  ];
  // 刻意给一个「最省 10 金 / 最贵 40 金」的基准：旧口径会拿它把 40 金那档折成 25 分。
  const zero = { '4.5': { min: 10, max: 40 } };
  const out = runPlight(rows, ['4.5'], { '4.5': 1 }, zero);

  check('⭐ 顶格档：0 行动值 → 100（不再按金数折）', () => {
    for (const name of ['Cheap', 'Pricey']) {
      const env = envOf(out, name);
      assert.ok(env, `${name} 应进榜`);
      assert.ok(Math.abs(Number(env.envStrength) - 100) < 1e-6,
        `${name}（0 行动值）应为 100，实际 ${env.envStrength}`);
      assert.equal(unitOf(out, name).strengthTopBand, true, `${name} 的顶格标记要跟着亮`);
    }
  });
  check('⭐ 金数不参与强度：10 金与 40 金、同样 0 行动值 → 同分', () => {
    assert.equal(Number(envOf(out, 'Cheap').envStrength), Number(envOf(out, 'Pricey').envStrength),
      '同一个行动值换成本差 4 倍，分数必须一样（用户 2026-10-17 晚）');
  });
  check('⭐ 该期「0 行动值金数区间」不再影响强度（换一份极端基准，分数不变）', () => {
    const a = runPlight(rows, ['4.5'], { '4.5': 1 }, { '4.5': { min: 1, max: 1 } });
    const b = runPlight(rows, ['4.5'], { '4.5': 1 }, { '4.5': { min: 40, max: 40 } });
    for (const name of ['Pricey', 'NoZero', 'Inside']) {
      assert.equal(Number(envOf(a, name).envStrength), Number(envOf(b, name).envStrength),
        `${name}：基准换成 1/1 与 40/40，强度必须一致（金数已退出强度）`);
    }
  });
  check('非 0 行动值 → 90 × 强度曲线（不看金数）', () => {
    for (const [name, av] of [['NoZero', 400], ['Inside', 299]]) {
      const want = SCORING.strengthSecondBandCap * strengthPerf(av);
      const got = Number(envOf(out, name).envStrength);
      assert.ok(Math.abs(got - want) < 1e-3,
        `${name}（av=${av}）应为 90 × ${strengthPerf(av).toFixed(4)} = ${want.toFixed(4)}，实际 ${got}`);
    }
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
    for (const name of ['NoZero', 'Inside']) {
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
    // Half：4.5 期 0 行动值（100）；4.4 期行动值 500（正好压在达标线上 → 90 × 0.45）
    { cost: 10, actionValue: 0, tier: 'perfect', newestSeason: '4.5', members: member('Half') },
    { cost: 20, actionValue: 500, tier: 'perfect', newestSeason: '4.4', members: member('Half') },
  ];
  const seasons = ['4.4', '4.5'];
  const zero = { '4.5': { min: 10, max: 10 }, '4.4': { min: 20, max: 20 } };
  const v45 = 100;
  const v44 = SCORING.strengthSecondBandCap * strengthPerf(500);

  check('⭐ 版本权重按用户设置生效（同一份数据，换权重就换分）', () => {
    const a = runPlight(rows, seasons, { '4.5': 3, '4.4': 1 }, zero);
    const wantA = (v45 * 3 + v44 * 1) / 4;
    const halfA = envOf(a, 'Half');
    assert.ok(halfA, 'Half 应进榜');
    assert.ok(Math.abs(Number(halfA.envStrength) - wantA) < 1e-3,
      `权重 3:1 时应为 ${wantA.toFixed(4)}，实际 ${halfA.envStrength}`);
    const b = runPlight(rows, seasons, { '4.5': 1, '4.4': 3 }, zero);
    const wantB = (v45 * 1 + v44 * 3) / 4;
    const halfB = envOf(b, 'Half');
    assert.ok(Math.abs(Number(halfB.envStrength) - wantB) < 1e-3,
      `权重 1:3 时应为 ${wantB.toFixed(4)}，实际 ${halfB.envStrength}`);
    assert.ok(Number(halfA.envStrength) > Number(halfB.envStrength),
      '新版本权重更高时，4.5 期拿满分的那一档必须更高');
  });
  check('⭐ 顶格档要求「每一个有数据的版本都打出 0 行动值」', () => {
    const a = runPlight(rows, seasons, { '4.5': 3, '4.4': 1 }, zero);
    const half = unitOf(a, 'Half');
    assert.equal(half.strengthTopBand, false,
      '4.4 期行动值 500（不是 0）→ 不许算顶格档');
    assert.ok(Number(half.strengthScore) < 100, '非顶格档必须低于 100');
  });
}

// ---- ②-C 继承：高成本整包从更便宜的同角色整包借分 ----------------------------
{
  const rows = [
    // Low E0：两版都有成绩
    { cost: 4, actionValue: 300, tier: 'perfect', newestSeason: '4.4', members: member('Low', 0) },
    { cost: 4, actionValue: 0, tier: 'perfect', newestSeason: '4.5', members: member('Low', 0) },
    // Low E6：**只有 4.5 有成绩**（谁会上传 8 金的队去打已经能 0 行动值的关？）
    { cost: 8, actionValue: 400, tier: 'perfect', newestSeason: '4.5', members: member('Low', 6) },
    // Solo E6：同角色**连低配装都没有** → 继承不到，4.4 仍算 0
    { cost: 8, actionValue: 400, tier: 'perfect', newestSeason: '4.5', members: member('Solo', 6) },
  ];
  const seasons = ['4.4', '4.5'];
  const firstSeen = {
    characters: { Low: '4.0', Solo: '4.0' }, lightCones: {}, byMode: {},
  };
  const out = runPlight(rows, seasons, { '4.5': 1, '4.4': 1 }, {}, { firstSeen });

  const own45E6 = SCORING.strengthSecondBandCap * strengthPerf(400);
  const lowE0At44 = SCORING.strengthSecondBandCap * strengthPerf(300);
  const lowE0At45 = 100;

  check('⭐ 已登场却缺证据 + 同角色有更便宜且有成绩的整包 → 继承它的分', () => {
    const e6 = unitOfE(out, 'Low', 6);
    assert.ok(e6, 'Low E6 应进榜');
    const want = (own45E6 + lowE0At44) / 2;
    assert.ok(Math.abs(Number(e6.envs[0].envStrength) - want) < 1e-3,
      `4.4 期应从 E0 继承 ${lowE0At44.toFixed(2)}，整关应为 ${want.toFixed(4)}，`
      + `实际 ${e6.envs[0].envStrength}`);
    assert.ok(Number(e6.inheritedSeasons) >= 1, '要标出「这一关的分是继承来的」');
  });
  check('继承是**单向**的：低成本整包不会从更贵的整包借分', () => {
    const e0 = unitOfE(out, 'Low', 0);
    const want = (lowE0At45 + lowE0At44) / 2;
    assert.ok(Math.abs(Number(e0.envs[0].envStrength) - want) < 1e-3,
      `E0 两版都有自己的成绩，应为 ${want.toFixed(4)}，实际 ${e0.envs[0].envStrength}`);
    assert.equal(Number(e0.inheritedSeasons || 0), 0, 'E0 不该有任何继承');
  });
  check('同角色没有更便宜的整包 → 仍算 0 分（权重进分母）', () => {
    const e6 = unitOfE(out, 'Solo', 6);
    const want = own45E6 / 2;
    assert.ok(Math.abs(Number(e6.envs[0].envStrength) - want) < 1e-3,
      `Solo 的 4.4 该算 0（整关 ${want.toFixed(4)}），实际 ${e6.envs[0].envStrength}`);
    assert.equal(Number(e6.inheritedSeasons || 0), 0, '继承不到就不该记继承数');
  });
  check('继承来的分不会让「更贵的整包」超过「更便宜的」在同一关的成绩上限', () => {
    const e0 = unitOfE(out, 'Low', 0);
    const e6 = unitOfE(out, 'Low', 6);
    // E6 自己的 4.5 比 E0 差，所以整关低于 E0 是正常的；这里钉的是**不许被抬到 100**
    assert.ok(Number(e6.envs[0].envStrength) <= Number(e0.envs[0].envStrength) + 1e-6,
      '继承只借「更低成本版本的成绩」，不该把高成本档抬到超过低成本档');
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

check('⭐ 强度与成本无相关性：同角色里「更贵更高」与「更贵更低」两个方向都存在', () => {
  // 2026-10-14 的包络会让同角色四档拿到同一个数（实测真珠 E0/E1/E2/E6 全是 73.33）。
  // 2026-10-17 晚金数退出强度之后，更贵的那一档**可能更高**（它自己打出了 0 行动值），
  // 也**可能更低**（它自己的行动值更差）—— 两个方向都要有实例，才说明成本没有单向决定强度。
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
  assert.ok(higher > 0,
    `一条「更贵更高」都没有（实际 ${higher}）—— 成本不该单向决定强度`);
  assert.ok(lower > 0,
    '一条「更贵反而更低」都没有 —— 单调包络可能复活了（用户 2026-10-17 第 2 条）');
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
      // ⚠️ 「每一关都 100」只在**覆盖全部副本**时才等价于整包 100：分母是全部副本的
      //    权重和（缺副本按 0），所以只覆盖 3 关的整包上限就是 3/9 = 33.3。
      //    2026-10-17 晚金数退出强度之后，单关拿 100 变得常见（0 行动值就够），
      //    这条判据必须把「覆盖数」一起看，否则会把正常结果误判成 bug。
      if (every && envs.length >= 5) {
        allHundred += 1;
        assert.ok(Number(p.strengthTotal) >= 99.99,
          `每一关都是 100 且覆盖 ${envs.length} 关，整包强度却只有 ${p.strengthTotal}`);
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
