// 探针（审计）：强度得分这条链的**内部一致性**与不变式。
//
// 检查项（都只看客观事实，不掺口径偏好）：
//   1. strengthScore ∈ [0, 100] 且有限；
//   2. 单调包络 + 第二档天花板：`min(自身, 90) ≤ strengthFloor ≤ max(自身, 90)`
//      —— ⚠️ **不是** `floor ≥ own`：`strengthTotal` 是逐关卡两档的加权平均，某一关
//      0 行动值、其余关不是，自身就可以落在 (90, 100)，而「没打出 0 行动值的队够不到
//      顶格那一档」是用户 2026-10-16 第 1 条的规则 ⇒ 非顶格档在整包层也封顶 90。
//      低过下界才是真 bug（包络在下压）。
//   3. 复算 strengthScore == 95 × (floor/100) + 5 × addOn（顶格档按 pinched、其余按 invest）；
//   4. 顶格档（strengthTotal ≥ 99.99）在**有数据的关卡**是否真的每一关 av 都是 0；
//   5. 「每关都有数据且都 0 行动值」的整包是否真的被判成顶格档（漏判 = 0 行动值登不了顶）；
//   6. 用户不变式 E6S5 ≥ E6S1 ≥ E2S1 ≥ E0S0（同角色、同锥档）的反例；
//   7. 强度来源表可对账：Σ(权重 × envStrength) / Σ全部权重 == strengthTotal；
//   8. 界面「投入加成」那一格的投入档与算分同源（v4.6.113 统一后应恒为 0 条不一致）。
//
//   node tools/_probe-strength-audit.mjs [--rows=15]
import {
  SCORING, buildConclusion, coneCostOf, eidolonTierOf, teamPoolUnits, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (name, dflt) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return dflt;
};
const ROWS = Math.max(1, Number(arg('rows', '15')) || 15);

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const cn = (n) => zhName(i18n, 'characters', n) || n;
const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const conclusion = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});
const units = teamPoolUnits(conclusion);
const envWeight = new Map((conclusion.frontierEnvs || []).map((e) => [e.id, Number(e.weight) || 0]));
const allEnvWeight = [...envWeight.values()].reduce((n, w) => n + w, 0);

const coneCostOfLocal = (lc) => {
  const meta = availability.lightCones?.[lc];
  if (!meta) return 1;
  return meta.limited === false ? 0 : 1;
};
const coneRank = (u) => (u.lc && coneCostOfLocal(u.lc) > 0
  ? Math.max(1, Math.round(Number(u.superimp) || 1)) : 0);
const investRank = (u) => eidolonTierOf(u.eidolon) + coneRank(u);

console.log(`榜内 ${units.length} 条整包｜关卡权重和 ${allEnvWeight}`
  + `｜investWeight ${SCORING.investWeight}｜第二档天花板 ${SCORING.strengthSecondBandCap}`);

// ---- 1 / 2 / 3 / 4 / 7 ------------------------------------------------------------
const bad = { range: [], envelope: [], formula: [], topBandEnv: [], table: [] };
const topBandUnits = [];
const allZeroMissed = [];
const cappedOwn = [];   // 自身落在 (天花板, 100) → 被第二档天花板压下来（合法，见下）
for (const u of units) {
  const score = Number(u.strengthScore);
  const own = Number(u.strengthTotal) || 0;
  const floor = Number(u.strengthFloor ?? own) || 0;
  if (!Number.isFinite(score) || score < -1e-9 || score > 100 + 1e-9) bad.range.push({ u, score });
  /**
   * ⚠️ 这一项 2026-10-16 晚**改过判据**（v4.6.113 查清）：包络只向上，但**非顶格档**
   * 还要过一道第二档天花板（90）—— 而 `strengthTotal` 是**逐关卡**两档的加权平均，
   * 某一关 0 行动值、其余关不是，自身就可以落在 (90, 100)。所以合法区间是
   *   `min(自身, 天花板) ≤ strengthFloor ≤ max(自身, 天花板)`
   * 而不是一开始写的 `floor ≥ own`。低过下界的才是真 bug（包络在下压）。
   */
  const cap = SCORING.strengthSecondBandCap;
  const topBand = own >= 99.99;
  const lo = topBand ? own : Math.min(own, cap);
  const hi = topBand ? own : Math.max(own, cap);
  if (floor + 1e-6 < lo) bad.envelope.push({ u, floor, own, lo });
  if (floor - 1e-6 > hi && floor - 1e-6 > own) bad.envelope.push({ u, floor, own, lo });
  if (!topBand && own > cap + 1e-6 && Math.abs(floor - cap) < 1e-6) cappedOwn.push({ u, own, floor });
  const invest = Math.max(0, Math.min(1, investRank(u) / SCORING.fullInvestRank));
  const top = own >= 99.99;
  const addOn = top ? Number(u.strengthPinched) || 0 : invest;
  const expect = (100 - SCORING.investWeight) * (floor / 100) + SCORING.investWeight * addOn;
  if (Math.abs(expect - score) > 0.01) bad.formula.push({ u, expect, score, floor, addOn, top });
  if (top) {
    topBandUnits.push(u);
    // 有数据的关卡里，是否每一关 av 都是 0（且不是「缺关卡」被算成 0 分）
    const missing = (conclusion.frontierEnvs || [])
      .filter((e) => !(u.envs || []).some((x) => x.id === e.id)).map((e) => e.id);
    const nonzero = (u.envs || []).filter((e) => Number(e.avBest) !== 0);
    if (nonzero.length || missing.length) bad.topBandEnv.push({ u, missing, nonzero });
  }
  // 7. 来源表对账
  const sum = (u.envs || []).reduce((n, e) => n + (Number(e.weight) || 0) * (Number(e.envStrength) || 0), 0);
  const recomputed = allEnvWeight > 0 ? sum / allEnvWeight : 0;
  if (Math.abs(recomputed - own) > 0.01) bad.table.push({ u, recomputed, own });
  // 5. 「每关都有数据且都 0 行动值」却被漏判
  const coveredAll = (u.envs || []).length === (conclusion.frontierEnvs || []).length
    && (u.envs || []).every((e) => Number(e.avBest) === 0);
  if (coveredAll && !top) allZeroMissed.push(u);
}
const dump = (label, list, fmt) => {
  console.log(`\n[${label}] ${list.length} 条`);
  for (const row of list.slice(0, ROWS)) console.log('  ' + fmt(row));
};
console.log('\n=== 客观一致性 ===');
dump('1 强度分越界 / 非数', bad.range, (r) => `${cn(r.u.name)} E${r.u.eidolon}=${r.score}`);
dump('2 包络越界（低于 min(自身, 天花板) 或高于 max(自身, 天花板)）', bad.envelope,
  (r) => `${cn(r.u.name)} E${r.u.eidolon} floor ${r.floor.toFixed(2)}｜own ${r.own.toFixed(2)}`
    + `（合法下界 ${r.lo.toFixed(2)}；own 落在 (90,100) 时被第二档天花板压到 90 是**规则本身**）`);
console.log(`\n被第二档天花板压下来的整包 ${cappedOwn.length} 条（own ∈ (90, 100)，属两档规则）：`);
for (const r of cappedOwn.slice(0, ROWS)) {
  console.log(`  ${cn(r.u.name).padEnd(8)} E${r.u.eidolon}${r.u.lc ? `S${r.u.superimp}` : '  '}`
    + ` own ${r.own.toFixed(2)} → floor ${r.floor.toFixed(2)}`);
}
dump('3 公式复算不符', bad.formula, (r) => `${cn(r.u.name)} E${r.u.eidolon}`
  + ` 期望 ${r.expect.toFixed(2)} 实际 ${r.score.toFixed(2)}（floor ${r.floor.toFixed(2)} addOn ${r.addOn.toFixed(3)} 顶格=${r.top}）`);
dump('4 顶格档但并非每关 0 行动值', bad.topBandEnv, (r) => `${cn(r.u.name)} E${r.u.eidolon}`
  + ` 缺关卡=${r.missing.join(',') || '无'} 非零行动值=${r.nonzero.map((e) => `${e.id}:${e.avBest}`).join(',') || '无'}`);
dump('5 每关 0 行动值却未判顶格', allZeroMissed, (r) => `${cn(r.u.name)} E${r.u.eidolon} 自身 ${Number(r.strengthTotal).toFixed(2)}`);
dump('7 来源表对不上 strengthTotal', bad.table,
  (r) => `${cn(r.u.name)} E${r.u.eidolon} 复算 ${r.recomputed.toFixed(2)} vs ${r.own.toFixed(2)}`);
console.log(`\n顶格档共 ${topBandUnits.length} 条：`);
for (const u of topBandUnits.slice(0, ROWS)) {
  console.log(`  ${cn(u.name).padEnd(8)} E${u.eidolon}${u.lc ? `S${u.superimp}` : '  '}`
    + ` 强度 ${Number(u.strengthScore).toFixed(2)}｜压金度 ${Number(u.strengthPinched ?? 0).toFixed(3)}`
    + `｜金数 ${u.gold}`);
}

// ---- 8. 界面「投入加成」小字 vs 算分用的投入档位 --------------------------------------
// ⚠️ 2026-10-16 晚（v4.6.113）界面已经改成与算分**同一把尺子**：
// `eidolonTierOf(E) + (要金的光锥 ? 叠影 : 0)`。这里按**同一个算式**复算一遍 ——
// 期望恒 0 条不一致；哪天界面又退回「有光锥就算叠影」，这一项会当场冒出来。
console.log('\n=== 8 界面「投入加成」小字与算分口径的差（应恒为 0）===');
const uiMismatch = [];
for (const u of units) {
  const uiRank = eidolonTierOf(u.eidolon) + (u.lc && coneCostOf(u.lc, availability) > 0
    ? Math.max(1, Math.round(Number(u.superimp) || 1)) : 0);
  const realRank = investRank(u);
  if (uiRank !== realRank) uiMismatch.push({ u, uiRank, realRank });
}
console.log(`不一致 ${uiMismatch.length} / ${units.length} 条整包`
  + '（对照：v4.6.112 之前的旧写法 · 有光锥就算叠影 · 实测 52 条不一致）');
for (const r of uiMismatch.slice(0, ROWS)) {
  console.log(`  ${cn(r.u.name).padEnd(8)} E${r.u.eidolon}`
    + `${r.u.lc ? `/${cn(r.u.lc)}S${r.u.superimp}` : '（无光锥）'}`
    + ` 界面 rank=${r.uiRank}（+${(5 * Math.min(1, r.uiRank / 11)).toFixed(2)} 分）`
    + ` vs 算分 rank=${r.realRank}（+${(5 * Math.min(1, r.realRank / 11)).toFixed(2)} 分）`
    + `｜顶格=${r.u.strengthTopBand ? 'Y' : 'N'}`);
}

// ---- 6. 用户不变式：同角色同锥档，投入档位单调 --------------------------------------
console.log('\n=== 6 不变式 E6S5 ≥ E6S1 ≥ E2S1 ≥ E0S0（同角色、同锥） ===');
const byChar = new Map();
for (const u of units) (byChar.get(u.name) || byChar.set(u.name, []).get(u.name)).push(u);
const violations = [];
for (const [name, list] of byChar) {
  // 同一把光锥（含叠影）下比不同星魂档；以及同一角色不同 (E,S) 投入档逐对比较
  for (const a of list) {
    for (const b of list) {
      if (a === b || (a.lc || null) !== (b.lc || null)) continue;
      if (Math.round(Number(a.superimp) || 1) !== Math.round(Number(b.superimp) || 1)) continue;
      if (investRank(a) >= investRank(b)) continue;
      // b 投入更高，强度不应更低
      if (Number(b.strengthScore) + 1e-6 < Number(a.strengthScore)) {
        violations.push({ name, a, b });
      }
    }
  }
}
console.log(`违反对：${violations.length}`);
for (const v of violations.slice(0, ROWS)) {
  console.log(`  ${cn(v.name)}：低投入 E${v.a.eidolon}${v.a.lc ? 'S' + v.a.superimp : ''}`
    + ` 强度 ${Number(v.a.strengthScore).toFixed(2)}（顶格=${v.a.strengthTopBand} 压金=${Number(v.a.strengthPinched ?? 0).toFixed(2)}）`
    + ` > 高投入 E${v.b.eidolon}${v.b.lc ? 'S' + v.b.superimp : ''}`
    + ` 强度 ${Number(v.b.strengthScore).toFixed(2)}（顶格=${v.b.strengthTopBand} 投入=${(investRank(v.b) / SCORING.fullInvestRank).toFixed(2)}）`);
}
