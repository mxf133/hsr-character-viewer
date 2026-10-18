// 抽卡推荐 v2 · 投稿评分（2026-10-18 起的新模型）。
//
// 为什么单独一套：这是重写的第一步，先把**纯算术**钉死（ `src/server/gacha-score.js`
// 不碰 IO，可以直接构造数据验证），后面的方案层 / UI 层才有可信的基础。
//
//   node tools/gacha-score-test.mjs
//
// 盯五件事：
//   ① 两个分量的公式本身（含需求文档里那两处会让「顺手写」的实现炸掉的地方）；
//   ② baseline 逐版本、**剔除 0 金队**；
//   ③ 强度分量的边界：≥500 夹到 0、成绩缺失给 0、轮次型 0T 拿满；
//   ④ 整包跨版本加权的**分母规则**（未上线不计分母 / 已上线无投稿记 0 分）；
//   ⑤ 上场率按 `n` 累加而不是按行数。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AV_CAP, aggregatePacks, baselineOf, costPartOf, eidolonTierOf, envKindOf,
  memberOf, packKeyOf, packOf, scoreEnvRows, scoreRow, strengthPartOf,
  usageByBand, USAGE_BANDS_OF,
} from '../src/server/gacha-score.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`); }
};
const eq = (name, actual, expect) => check(
  name,
  JSON.stringify(actual) === JSON.stringify(expect),
  `实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expect)}`,
);
const near = (name, actual, expect, tol = 1e-6) => check(
  name,
  Math.abs(actual - expect) <= tol,
  `实际 ${actual} ≠ 期望 ${expect}（容差 ${tol}）`,
);

// ---- ① 判据类型 -------------------------------------------------------------
console.log('[判据类型 — 谁按行动值，谁按轮次]');
eq('绝境（aa|plight）是行动值型', envKindOf('aa', 'plight'), 'av');
eq('末日幻影（as）是行动值型', envKindOf('as', ''), 'av');
eq('异相仲裁骑士关（aa）是轮次型', envKindOf('aa', ''), 'round');
eq('混沌回忆是轮次型', envKindOf('moc', ''), 'round');
eq('虚构叙事是轮次型', envKindOf('pf', ''), 'round');
check('光晕耍滑脱：未知关卡按轮次处理（兜底不炸）', envKindOf('unknown', '') === 'round');

// ---- ② 星魂档与整包键 -------------------------------------------------------
console.log('\n[星魂档与整包键]');
eq('E0', eidolonTierOf(0), 0);
eq('E1', eidolonTierOf(1), 1);
eq('E2', eidolonTierOf(2), 2);
eq('E3 归到 E2', eidolonTierOf(3), 2);
eq('E5 归到 E2', eidolonTierOf(5), 2);
eq('E6', eidolonTierOf(6), 6);
eq('负数归到 E0', eidolonTierOf(-1), 0);
eq('脏数据归到 E0', eidolonTierOf('abc'), 0);

eq('拆成员：字串 → 对象', memberOf('Evanescia|1|A Little Getaway|5'),
  { char: 'Evanescia', eidolon: 1, lc: 'A Little Getaway', superimp: 5 });
eq('缺光锥按 null、缺叠影按 0', memberOf('Evanescia|0||'),
  { char: 'Evanescia', eidolon: 0, lc: null, superimp: 0 });

const KEY = packKeyOf('Evanescia|2|A Little Getaway|5');
eq('整包键 = 角色|E档|光锥|S叠影', KEY, 'Evanescia|E2|A Little Getaway|S5');
eq('E3 与 E4 归并同一个整包', packKeyOf('Evanescia|3|X|1'), packKeyOf('Evanescia|4|X|1'));
eq('无光锥用 - 占位（保持四段结构）', packKeyOf('Evanescia|0||0'), 'Evanescia|E0|-|S0');
eq('整包键可反解', packOf(KEY), { char: 'Evanescia', eidolon: 2, lc: 'A Little Getaway', superimp: 5 });
eq('反解能把 - 还原成 null', packOf('Evanescia|E0|-|S0').lc, null);

// ---- ③ 基准最低金 baseline --------------------------------------------------
console.log('\n[baseline — 逐版本达标最低金，且必须剔除 0 金队]');
const AV_ROWS = [
  { c: 12, a: 120 }, { c: 5, a: 480 }, { c: 3, a: 600 }, { c: 9, a: 290 },
];
eq('行动值型：取 <500 的最便宜那队', baselineOf(AV_ROWS, 'av'), 5);
eq('轮次型：取 0T 的最便宜那队', baselineOf([
  { c: 8, a: 0 }, { c: 4, a: 1 }, { c: 2, a: 2 },
], 'round'), 8);
eq('没有达标行 → 0（调用方当「无基准」处理）', baselineOf([{ c: 4, a: 700 }], 'av'), 0);
eq('空数组 → 0', baselineOf([], 'av'), 0);

// ⚠️ 放开 tier 过滤之后混进来的全四星队（实测 19 行，混沌 7 / 末日 12）。
// 不剔除的话 baseline 会被拉到 0，所有队伍的性价比得分一起变 0 or Infinity。
eq('0 金队不进 baseline（否则它们会把基准拉到 0）',
  baselineOf([{ c: 0, a: 0 }, { c: 7, a: 100 }], 'av'), 7);
check('成本缺失的行也不会参与', baselineOf([{ c: null, a: 0 }, { c: 9, a: 10 }], 'av') === 9);
check('成绩缺失的行不会参与', baselineOf([{ c: 2, a: null }, { c: 9, a: 10 }], 'av') === 9);

// ---- ④ 两个分量 -------------------------------------------------------------
console.log('\n[强度分量]');
near('行动值型：AV=0 拿满 ws', strengthPartOf(0, 'av', 1), 1);
near('行动值型：AV=250 得一半', strengthPartOf(250, 'av', 1), 0.5);
near('行动值型：AV=500 归 0', strengthPartOf(AV_CAP, 'av', 1), 0);
check('行动值型：AV>500 夹到 0（不放开 tier 时不会出现，放开后必须夹）',
  strengthPartOf(900, 'av', 1) === 0);
near('强度权重是整数倍：ws=2 → 翻倍', strengthPartOf(250, 'av', 2), 1);
near('轮次型：0T 拿满 ws', strengthPartOf(0, 'round', 1), 1);
near('轮次型：1T 得一半', strengthPartOf(1, 'round', 1), 0.5);
near('轮次型：2T 得三分之一', strengthPartOf(2, 'round', 1), 1 / 3);
near('成绩缺失一律 0（不猜中位数）', strengthPartOf(null, 'av', 1), 0);
near('脏成绩一律 0', strengthPartOf('abc', 'round', 1), 0);

console.log('\n[性价比分量]');
near('比 baseline 贵一倍 → 0.5', costPartOf(10, 5), 0.5);
near('恰好是 baseline → 1（满分）', costPartOf(5, 5), 1);
near('比 baseline 便宜 → 夹到 1，不会 >1', costPartOf(2, 5), 1);
near('0 金队 → 满分 1（不是 Infinity）', costPartOf(0, 5), 1);
check('0 金队的结果必须是有限数', Number.isFinite(costPartOf(0, 5)));
near('该版本没有 baseline → 0', costPartOf(10, 0), 0);

console.log('\n[投稿得分]');
// 需求文档写法：强度项已含 ws，只有成本项乘 wc。不要「顺手对称化」。
near('投稿得分 = 强度 + wc × 性价比',
  scoreRow({ c: 10, a: 250 }, { kind: 'av', baseline: 5, ws: 1, wc: 1 }).score,
  0.5 + 1 * 0.5);
near('ws 只进强度项',
  scoreRow({ c: 10, a: 250 }, { kind: 'av', baseline: 5, ws: 3, wc: 1 }).score,
  1.5 + 0.5);
near('wc 只进成本项',
  scoreRow({ c: 10, a: 250 }, { kind: 'av', baseline: 5, ws: 1, wc: 4 }).score,
  0.5 + 4 * 0.5);
near('极端：0 金 + 0 行动值 = ws + wc（理论满分）',
  scoreRow({ c: 0, a: 0 }, { kind: 'av', baseline: 5, ws: 1, wc: 1 }).score, 2);

// ---- ⑤ 与真实数据集对拍 -----------------------------------------------------
// 这一组是从 `theherta/archive.json` 现算出来的，用来钉住「改用新过滤器之后
// 结论没被带偏」。表里的期望值取自重建前的实测（设计文档 §3.2）。
console.log('\n[真实数据集 — baseline 复核]');
const ARCHIVE = JSON.parse(readFileSync(
  join(HERE, '..', 'theherta', 'archive.json'), 'utf8',
));

/** 取某个关卡某版本的 frontier 原始行（**不做任何 tier 过滤**）。 */
const frontierOf = (mode, stage, season) => {
  const seasons = ARCHIVE.modes?.[mode]?.stages?.[stage]?.seasons || {};
  return (seasons[season]?.frontier || []).map((f) => ({ ...f, season }));
};

const baselineNow = (mode, stage, season) => {
  const rows = frontierOf(mode, stage, season);
  const { kind } = scoreEnvRows(rows, { mode, stage });
  return { kind, baseline: baselineOf(rows, kind), rows: rows.length };
};

const MOC = baselineNow('Memory of Chaos', '', '4.5');
eq('混沌回忆 4.5 = 轮次型', MOC.kind, 'round');
eq('混沌回忆 4.5 baseline（0T 最低金）= 2', MOC.baseline, 2);

const PLIGHT = baselineNow('Anomaly Arbitration', 'plight', '4.5');
eq('绝境 4.5 = 行动值型', PLIGHT.kind, 'av');
eq('绝境 4.5 baseline（<500 行动值最低金）= 9', PLIGHT.baseline, 9);

// 这一条是本次改动唯一受影响的：放开 tier 之后 0 金队混进来会把 baseline 拉到 0。
const AS = baselineNow('Apocalyptic Shadow', '', '4.4');
eq('末日幻影 4.4 baseline = 1（剔除 0 金队之后回到 1，而不是 0）', AS.baseline, 1);

check('重建后 frontier 覆盖率 100%：Σn == 投稿条数', (() => {
  let rows = 0; let submits = 0; let runs = 0;
  for (const mode of Object.keys(ARCHIVE.modes)) {
    for (const stage of Object.keys(ARCHIVE.modes[mode].stages)) {
      for (const [season, se] of Object.entries(ARCHIVE.modes[mode].stages[stage].seasons)) {
        const list = se.frontier || [];
        rows += list.length;
        submits += list.reduce((s, f) => s + (Number.isFinite(+f.n) ? +f.n : 0), 0);
        runs += se.runCount || 0;
        if (list.some((f) => !Number.isFinite(+f.n))) return false;
      }
    }
  }
  console.log(`         （frontier ${rows} 行 / Σn ${submits} 条 / runCount ${runs}）`);
  return submits === runs && rows > 0;
})());

check('行数 ≠ 投稿数（所以上场率必须按 n 累加）', (() => {
  let rows = 0; let submits = 0;
  for (const mode of Object.keys(ARCHIVE.modes)) {
    for (const stage of Object.keys(ARCHIVE.modes[mode].stages)) {
      for (const se of Object.values(ARCHIVE.modes[mode].stages[stage].seasons)) {
        for (const f of se.frontier || []) {
          rows += 1;
          submits += Number.isFinite(+f.n) ? +f.n : 0;
        }
      }
    }
  }
  return rows !== submits;
})());

// ---- ⑥ 整包跨版本加权的分母规则 ---------------------------------------------
console.log('\n[整包得分 — 跨版本加权与分母规则]');
const SEASONS = ['4.5', '4.4', '4.3'];
const flatWeight = () => 1;
const cmpVersion = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

const mkRow = (season, members, score, c = 5) => ({
  season, m: members, c, score, strengthPart: score, costPart: 0, versionWeight: 1,
});

// 三个版本各有 100 / 50 / 0 三条：第三个版本没投稿。
const rows = [
  mkRow('4.5', ['A|0|X|1'], 100),
  mkRow('4.4', ['A|0|X|1'], 50),
  mkRow('4.5', ['B|0|Y|1'], 80),
];
const alwaysOnline = () => null;
const packs = aggregatePacks(rows, {
  seasons: SEASONS, versionWeightOf: flatWeight, debutSeasonOf: alwaysOnline, versionCmp: cmpVersion,
});
const packA = packs.find((p) => p.key.startsWith('A|'));
const packB = packs.find((p) => p.key.startsWith('B|'));

near('A：三个版本都在线，第三版没投稿 → 分子记 0、分母仍计入', packA.score, (100 + 50 + 0) / 3);
eq('A 记录了缺失版本（UI 用得上）', packA.missingSeasons, ['4.3']);
eq('A 的权重和 = 3', packA.weightSum, 3);
near('B：只有一个版本有投稿，其余两版记 0', packB.score, 80 / 3);

// 未上线 ⇒ 分子分母都不计。让 A 在 4.4 才登场，那么只有 4.4/4.5 两个版本进分母。
const debut = (key) => (key.startsWith('A|') ? '4.4' : null);
const packs2 = aggregatePacks(rows, {
  seasons: SEASONS, versionWeightOf: flatWeight, debutSeasonOf: debut, versionCmp: cmpVersion,
});
const packA2 = packs2.find((p) => p.key.startsWith('A|'));
near('A 在 4.4 登场 → 分母只剩 4.5/4.4 两版（4.3 那一版的 0 分不该算进来）',
  packA2.score, (100 + 50) / 2);
eq('A 登场前那一版不计入 missingSeasons', packA2.missingSeasons.filter((s) => s === '4.3'), []);
eq('A 的权重和 = 2（4.3 没进分母）', packA2.weightSum, 2);
// 对照组：若不设登场版本，同一个人是 (100+50+0)/3 —— 这就是「未上线 vs 无投稿」的差别。
near('对照组：没有登场限制时同一份数据是除以 3', packA.score, (100 + 50 + 0) / 3);

// 版本权重生效
const packs3 = aggregatePacks(rows, {
  seasons: SEASONS,
  versionWeightOf: (s) => ({ '4.5': 6, '4.4': 5, '4.3': 4 }[s] ?? 1),
  debutSeasonOf: alwaysOnline,
  versionCmp: cmpVersion,
});
const packA3 = packs3.find((p) => p.key.startsWith('A|'));
near('版本权重参与加权平均（不是算术平均）', packA3.score, (100 * 6 + 50 * 5 + 0 * 4) / 15);

check('同一角色同一版本的多条投稿只取最高分', (() => {
  const list = [
    mkRow('4.5', ['A|0|X|1'], 30),
    mkRow('4.5', ['A|0|X|1'], 90),
    mkRow('4.5', ['A|0|X|1'], 10),
  ];
  const out = aggregatePacks(list, {
    seasons: ['4.5'], versionWeightOf: flatWeight, debutSeasonOf: alwaysOnline, versionCmp: cmpVersion,
  });
  return out.length === 1 && out[0].score === 90;
})());

check('E3 与 E4 归并后不稀释分数', (() => {
  const list = [mkRow('4.5', ['A|3|X|1'], 20), mkRow('4.5', ['A|4|X|1'], 30)];
  const out = aggregatePacks(list, {
    seasons: ['4.5'], versionWeightOf: flatWeight, debutSeasonOf: alwaysOnline, versionCmp: cmpVersion,
  });
  return out.length === 1 && out[0].score === 30;
})());

// ---- ⑦ 上场率 ---------------------------------------------------------------
console.log('\n[上场率 — 四类判据与按 n 累加]');
eq('行动值型四类', USAGE_BANDS_OF.av.map((b) => b.key), ['clear', 'lt300', 'av300', 'zero']);
eq('轮次型四类', USAGE_BANDS_OF.round.map((b) => b.key), ['clear', 'zero', 'r1', 'r2']);

const usageRows = [
  { m: ['A|0|X|1', 'B|0|Y|1'], a: 0, n: 10 },
  { m: ['A|0|X|1', 'C|0|Z|1'], a: 1, n: 4 },
  { m: ['B|0|Y|1', 'C|0|Z|1'], a: 2, n: 1 },
];
const clear = usageByBand(usageRows, USAGE_BANDS_OF.round[0]);
const byChar = Object.fromEntries(clear.map((r) => [r.char, r.count]));
eq('通关：按 n 累加（A 出现在两条里 = 10 + 4）', byChar.A, 14);
eq('通关：B = 10 + 1', byChar.B, 11);
eq('通关：C = 4 + 1', byChar.C, 5);

check('不是按行数累加（三条 → 不是统统 3）', !Object.values(byChar).every((v) => v === 3));
check('缺 n 的行按 1 计（老数据集没有 n 字段时不至于全 0）', (() => {
  const out = usageByBand([{ m: ['A|0|X|1'], a: 0 }], USAGE_BANDS_OF.round[0]);
  return out[0].count === 1;
})());

const zeroBand = usageByBand(usageRows, USAGE_BANDS_OF.round[1]);
eq('0T 只挑 a=0 的那条', zeroBand.map((r) => r.char).sort(), ['A', 'B']);
eq('0T 里 A = 10', zeroBand.find((r) => r.char === 'A').count, 10);

const r2 = usageByBand(usageRows, USAGE_BANDS_OF.round[3]);
eq('2T 及以上只挑 a>=2', r2.map((r) => r.char).sort(), ['B', 'C']);

check('share 相加 = 1', (() => {
  const total = clear.reduce((s, r) => s + r.share, 0);
  return Math.abs(total - 1) < 1e-9;
})());

check('同一行里出现两次的同一角色只数一次', (() => {
  const out = usageByBand([{ m: ['A|0|X|1', 'A|0|X|1'], a: 0, n: 5 }], USAGE_BANDS_OF.round[0]);
  return out.length === 1 && out[0].count === 5;
})());

// ---- 收尾 -------------------------------------------------------------------
console.log(`\n合计 ${passed} 项通过，${failed} 项失败`);
if (failed) process.exitCode = 1;
