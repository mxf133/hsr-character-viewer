// 探针：把某个整包的「跨版本发挥」那一栏**逐版本**拆开，回答「×0.75 是怎么来的」。
//
// 它复用生产的同一条通路（`conclusionEnvs` → `archiveFrontierAll` → `buildConclusion`），
// 然后照 `advice.js` 那一段逐版本加权的**同一套公式**独立重算一遍：
//   score(整包, 副本) = Σ_版本 w(版本) × [该版本最好分] ÷ Σ_版本 w(版本)
//   跨版本发挥          = score ÷ 100 × 表现 × 金数项      （恒 ≤ 1，v4.6.78）
// ⚠️ 池 = 窗口内**全部**达标/满分行（v4.6.78 起不再取最便宜 25%），所以每个有成绩的
//    版本都直接进平均，没有「有人用但没进池」那一态、也没有估算。
// ⚠️ 刻意**不复用** `frontierFactorsOf().seasonFactor`（那是界面拿到的余数）：
//    独立重算一遍再和它对比，对得上才说明这一栏可以被这样解释。
//
// 用法：node tools/_probe-version-factor.mjs --find=真珠 --env=aa
import { archiveIndex, archiveFrontierAll, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
import {
  buildConclusion, VERSION_WINDOW, frontierFactorsOf, perfFactorOf,
  eidolonTierOf,
} from '../src/core/advice.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const FIND = arg('find', '真珠');
const ONLY_ENV = arg('env', null);

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const cn = (n) => zhName(i18n, 'characters', n) || n;
const coneCn = (n) => (n ? (zhName(i18n, 'lightCones', n) || n) : '—');

const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const result = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  frontierWeights: Object.fromEntries(frontierAll.map((f) => [f.env, f.weight])),
});

const cands = result.frontierUnits.filter((u) => cn(u.name).includes(FIND));
if (!cands.length) { console.log(`榜上找不到「${FIND}」`); process.exit(1); }
const unit = cands[0];
console.log(`=== ${cn(unit.name)} E${unit.eidolon} + ${coneCn(unit.lc)}S${unit.superimp}`
  + `  总分 ${Math.round(unit.total)}  （榜上匹配 ${cands.length} 个，取第一个）`);
console.log(`    整包自身 ${unit.gold} 金 / 期望抽数口径见 docs/评分模型设计.md\n`);

const cmpVersion = (a, b) => String(a || '').localeCompare(String(b || ''), undefined,
  { numeric: true, sensitivity: 'base' });
const quantile = (vals, p) => {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const at = (s.length - 1) * p;
  const lo = Math.floor(at); const hi = Math.ceil(at);
  return s[lo] + (s[hi] - s[lo]) * (at - lo);
};

for (const env of unit.envs) {
  if (ONLY_ENV && env.id !== ONLY_ENV) continue;
  const meta = result.frontierEnvs?.find((m) => m.id === env.id);
  const f = frontierFactorsOf(env, meta);
  console.log(`--- ${env.envLabel}`);
  console.log(`    窗口 ${JSON.stringify(meta?.seasons)}`);
  console.log(`    逐版本权重 ${JSON.stringify(meta?.seasonWeights)}`);
  console.log(`    证据版本 ${env.evidenceSeason}  登场版本 ${env.bornSeason}`
    + `  不参与 ${env.absentSeasons ?? 0} 个`
    // 用户 2026-10-10：已登场却缺证据的版本**算 0 分**（权重仍进分母）。
    + `  无人使用 ${env.droppedSeasons ?? 0} 个`);

  // ---- 独立重算：逐版本找这个整包的最好分
  const front = meta?.frontierRows || frontierAll.find((x) => x.env === env.id)?.frontierRows || [];
  const minCost = Number(meta?.minCost);
  // ⚠️ 金数项的分母是**该版本「最好一档」（perfect）的最便宜金数**，缺 perfect 档时才退回
  // 该版本全档最小 —— 与 `advice.js` 的 `denomCostOf()` 同一口径（用户 2026-10-11 缺陷 2）。
  // 不按同一口径重算就会与生产对不上（表现为「✗ 不一致」，实测踩过两次）。
  const minAllBySeason = new Map();
  const minPerfectBySeason = new Map();
  for (const row of front) {
    const s = row.season || '';
    const c = Number(row.cost);
    if (!(c > 0)) continue;
    if (minAllBySeason.get(s) === undefined || c < minAllBySeason.get(s)) minAllBySeason.set(s, c);
    if (row.tier === 'perfect'
      && (minPerfectBySeason.get(s) === undefined || c < minPerfectBySeason.get(s))) {
      minPerfectBySeason.set(s, c);
    }
  }
  const denomOf = (s) => minPerfectBySeason.get(s) ?? minAllBySeason.get(s) ?? minCost ?? 0;
  const lowerIsBetter = meta?.lowerIsBetter !== false;
  const rowScore = (row) => {
    // ⚠️ 表现分走**生产同一个函数** `perfFactorOf`：档位与行动值自 v4.6.72 起已合并成
    // 一条连续曲线，这里再按 `frontierTierWeight × avTerm` 相乘就会只有生产的一半
    // （旧写法实测打出「✗ 不一致」，2026-10-11 修）。
    const perf = perfFactorOf(row.actionValue, meta?.tierLines, lowerIsBetter, row.tier);
    if (!(perf > 0)) return null;
    const seasonMin = denomOf(row.season || '');
    if (!(seasonMin > 0)) return null;
    const cost = Number(row.cost) || 0;
    if (!(cost > 0)) return null;
    return {
      score: 100 * perf * (seasonMin / cost),
      tier: row.tier, av: row.actionValue, cost, seasonMinCost: seasonMin,
    };
  };
  // 这个整包 = (char, E档, 光锥, 叠影)
  const want = (m) => m.char === unit.name && eidolonTierOf(m.eidolon) === unit.eidolon
    && (m.lc || null) === (unit.lc || null) && Number(m.superimp) === Number(unit.superimp);
  const bySeason = new Map();
  for (const row of front) {
    if (!row.members.some(want)) continue;
    const hit = rowScore(row);
    if (!hit) continue;
    const cur = bySeason.get(row.season);
    if (!cur || hit.score > cur.score) bySeason.set(row.season, hit);
  }
  // （「场地水平中位数」整段随「按场地水平放大」一起废除 —— 那条口径已在 v4.6.60 删掉，
  //   见 advice.js 第二趟的三态注释。这里留着只会让人以为还有放大逻辑。）

  const born = env.bornSeason || null;
  const refSeason = env.evidenceSeason;

  console.log(`\n    版本逐条：最佳证据在 ${refSeason}（这个整包的**登场版本**是 ${born || '未知'}）`);
  console.log('    版本   权重  本版最好分  处理                      加权贡献');
  let acc = 0; let wSum = 0;
  const desc = [...(meta?.seasons || [])].reverse();
  for (const s of desc) {
    const w = Number(meta?.seasonWeights?.[s] ?? 1);
    if (!(w > 0)) continue;
    const hit = bySeason.get(s);
    if (hit) {
      wSum += w; acc += w * hit.score;
      console.log(`    ${s}    ${w}    ${hit.score.toFixed(2).padStart(9)}  实测                     ${(w * hit.score).toFixed(2).padStart(9)}`);
      continue;
    }
    // 缺证据 → 按登场版本分两态（用户 2026-10-10 两轮确认的口径）：
    //   早于登场 → **不参与平均**（不进分子也不进分母）；不参与 ≠ 罚。
    //   已登场   → **算 0 分**（权重进分母、分子不加）；「完全无人使用」是明确的差。
    // ⚠️ 这两条与 `advice.js` 第二趟的三态**必须一致**，否则这里会打出「✗ 不一致」。
    const older = born && cmpVersion(s, born) < 0;
    if (older) {
      console.log(`    ${s}    ${w}    ${'—'.padStart(9)}  不参与(早于登场 ${born})      ${'不计'.padStart(9)}`);
      continue;
    }
    wSum += w;
    console.log(`    ${s}    ${w}    ${'0.00'.padStart(9)}  算0分(已登场无人使用)      ${'0.00'.padStart(9)}`);
  }
  // 分母 = 实测 + 算 0 分那些版本的权重（早于登场的不进分母，这是本轮口径的核心）。
  const score = wSum > 0 ? acc / wSum : 0;
  console.log(`    ${'合计'.padEnd(8)}${wSum.toFixed(0).padStart(4)}`
    + `${acc.toFixed(2).padStart(20)}${''.padStart(11)}  ${'Σ权重×分 ÷ Σ权重'.padEnd(26)}`
    + `  = ${score.toFixed(2)}`);

  // ⚠️ 表现项用 f.perfFactor（档位与行动值已合并）；旧写法 `tierFactor × avFactor` 会把
  // 表现算成一半，于是这里必然打「✗ 不一致」（2026-10-11 修）。
  const base = 100 * f.perfFactor * (f.costFactor ?? 1);
  console.log(`\n    界面那一栏：score ${score.toFixed(2)} ÷ base ${base.toFixed(2)}`
    + ` = ${(score / base).toFixed(4)}  →  显示 ×${(score / base).toFixed(2)}`);
  console.log(`    浮层的余数（另一条路算的）：×${(f.seasonFactor ?? 0).toFixed(4)}`
    + `   ${Math.abs(score / base - (f.seasonFactor ?? 0)) < 1e-6 ? '✓ 一致' : '✗ 不一致'}`);
  console.log('');
}