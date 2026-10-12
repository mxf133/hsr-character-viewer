// 探针：**金数项封顶 ×1 + 0 金通关 ×1.2** 这条口径（用户 2026-10-11 第 3 条）
// 在本机当前数据集上到底命中多少、把榜面改了多少。
//
// 它回答三个问题：
//   ① 前沿池里有多少行是「隐金后有效金数 = 0」（＝拿 1.2 的那批）——按副本拆开看；
//   ② 榜面（`frontierUnits` 每条整包的每个关卡）里，有多少条拿 1.2、有多少条被**封顶**
//      （判据：`frontierFactorsOf()` 返回的 `minCost > cost > 0` ⇒ 封顶前它会是 > 1 的倍数）；
//   ③ 封顶前后单版本分的上界：封顶后应 ≤ 100，只有 0 金那条能到 120（= 100 × 1.2）。
//
// ⚠️ 为什么必须用**生产那两个函数**（`frontierFactorsOf` / `hiddenReductionOf`）而不是
// 自己照抄公式：这两条规则本来就写在 `frontierCostTermOf()` 里一处，探针再抄一份，
// 哪天口径再动就会出现「探针说命中 N 条、榜上却另有其数」——本仓库踩过同一类坑
// （见 HANDOFF §4.4「不要让界面抄第二份公式」）。
//
// 用法：
//   node tools/_probe-costcap-impact.mjs            # 界面默认（隐金五组全勾）
//   node tools/_probe-costcap-impact.mjs --no-hidden  # 接口默认（一项都不减）
//   node tools/_probe-costcap-impact.mjs --rows=8     # 明细样例条数
import { archiveIndex, archiveFrontierAll } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
import {
  buildConclusion, frontierFactorsOf, hiddenReductionOf, setHiddenCosts,
  DEFAULT_HIDDEN_COSTS, NO_HIDDEN_COSTS, VERSION_WINDOW, SCORING,
} from '../public/scripts/advice.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const [k, v] = hit.split('=');
  return v === undefined ? true : v;
};
const NO_HIDDEN = arg('no-hidden', false) === true;
const ROWS = Math.max(0, Number(arg('rows', 6)) || 0);
const hidden = NO_HIDDEN ? NO_HIDDEN_COSTS : DEFAULT_HIDDEN_COSTS;

const index = await archiveIndex();
const availability = index.refs?.availability || {};
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const result = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  frontierWeights: Object.fromEntries(frontierAll.map((f) => [f.env, f.weight])),
  hiddenCosts: hidden,
});

console.log(`金数项口径：封顶 ×${SCORING.frontierCostCap}｜0 金通关 ×${SCORING.frontierZeroGoldBonus}`);
console.log(`隐金设置：${NO_HIDDEN ? '**一项都不减**（接口默认）' : '五组全勾（界面默认）'}`);

// ---- ① 前沿池里「隐金后有效金数 = 0」的行 -------------------------------------
setHiddenCosts(hidden);
const perEnv = new Map();
let poolRows = 0;
let poolZero = 0;
const zeroSamples = [];
for (const f of frontierAll) {
  const label = f.label || f.env;
  for (const row of f.frontierRows || []) {
    const stored = Math.max(0, Math.round(Number(row.cost) || 0));
    if (stored <= 0) continue;                       // 原始 0 金不进池（口径如此）
    const members = (row.members || []).map((m) => ({
      char: m.char, eidolon: m.eidolon, lc: m.lc || null, superimp: m.superimp,
    })).filter((m) => m.char);
    const cut = hiddenReductionOf(members, availability, undefined, 'dataset').team;
    const eff = Math.max(0, stored - cut);           // ← 与 `adjustedCost()` 同一条规则
    poolRows += 1;
    const stat = perEnv.get(label) || { rows: 0, zero: 0 };
    stat.rows += 1;
    if (eff === 0) {
      poolZero += 1;
      stat.zero += 1;
      if (zeroSamples.length < ROWS) {
        zeroSamples.push(`${label} · ${row.season} · 原始 ${stored} 金 − 减免 ${cut} = 0 金 · `
          + members.map((m) => m.char).join(' + '));
      }
    }
    perEnv.set(label, stat);
  }
}
console.log(`\n① 算分前沿池 ${poolRows} 行：隐金后 0 金的 **${poolZero} 行**（拿 ×${SCORING.frontierZeroGoldBonus}）`);
for (const [label, s] of perEnv) {
  console.log(`   ${label.padEnd(24)} 行 ${String(s.rows).padStart(5)}　0 金 ${String(s.zero).padStart(4)}`);
}
for (const line of zeroSamples) console.log(`     · ${line}`);

// ---- ②③ 榜面：拿 1.2 的、被封顶的、单版本分上界 --------------------------------
const units = result.frontierUnits || [];
const metaOf = (id) => (result.frontierEnvs || []).find((e) => e.id === id);
let rows = 0;
let zeroGold = 0;
let capped = 0;
let maxBase = 0;
let maxBaseZero = 0;
let over1 = 0;
const zeroRows = [];
for (const u of units) {
  for (const env of u.envs || []) {
    const f = frontierFactorsOf(env, metaOf(env.id));
    rows += 1;
    const cost = Number(f.cost);
    if (cost === 0) {
      zeroGold += 1;
      maxBaseZero = Math.max(maxBaseZero, Number(f.base) || 0);
      if (zeroRows.length < ROWS) {
        zeroRows.push(`${u.name} E${u.eidolon}${u.lc ? ` + ${u.lc}` : ''} 的 ${env.envLabel || env.id}`
          + `：0 金 → 金数项 ×${Number(f.costFactor).toFixed(2)}，单版本分 ${Number(f.base).toFixed(1)}`);
      }
    }
    if (f.costFactor !== null && cost > 0 && Number(f.minCost) > cost) {
      capped += 1;
      over1 += Number(f.minCost) / cost;   // 封顶前它会是这个倍数
    }
    maxBase = Math.max(maxBase, Number(f.base) || 0);
  }
}
console.log(`\n② 榜面 ${units.length} 条整包 / ${rows} 个「整包×关卡」明细：`
  + `拿 ×${SCORING.frontierZeroGoldBonus} 的 **${zeroGold} 条**；被**封顶**的 ${capped} 条`
  + `（封顶前合计 ×${over1.toFixed(2)}，平均 ×${(over1 / (capped || 1)).toFixed(2)}）`);
for (const line of zeroRows) console.log(`     · ${line}`);
console.log(`\n③ 单版本分上界：全部明细最高 ${maxBase.toFixed(1)}`
  + `（封顶后应 ≤ ${SCORING.frontierPackScale}；0 金那条最高 ${maxBaseZero.toFixed(1)}`
  + `，上界 = ${SCORING.frontierPackScale} × ${SCORING.frontierZeroGoldBonus} = `
  + `${SCORING.frontierPackScale * SCORING.frontierZeroGoldBonus}）`);
