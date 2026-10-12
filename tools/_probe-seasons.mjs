// 探针：总榜的「版本维度」实测（用户第 6、7 条的调参依据）。
//
// 打印每个副本、每个版本的：
//   · 前沿配置条数、最便宜金数、行动值区间
//   · 该版本里「每个整包的最好分」分布（用 advice.js 的同一套公式）
//   · 哪些角色在该版本有证据（用来判断新角色缺了哪些版本）
//
// 用法：node tools/_probe-seasons.mjs [--window=7]
import { archiveFrontier, archiveIndex } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
import { SCORING, envWeightOf, eidolonTierOf, charCostOf, coneCostOf, eidolonGoldOf } from '../src/core/advice.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const WINDOW = Number(arg('window', 7));

const index = await archiveIndex();
const avail = index.refs?.availability || {};

const packKeyOf = (m) => `${m.char}|E${eidolonTierOf(m.eidolon)}|${m.lc || '-'}|S${m.superimp}`;
const packGoldOf = (m) => {
  const cone = m.lc ? coneCostOf(m.lc, avail) : 0;
  const body = charCostOf(m.char, avail);
  if (body <= 0) return cone;
  return body + eidolonGoldOf(0, m.eidolon) + cone;
};
const quantile = (vals, p) => {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const at = (s.length - 1) * p;
  const lo = Math.floor(at); const hi = Math.ceil(at);
  return s[lo] + (s[hi] - s[lo]) * (at - lo);
};

// ⚠️ 版本选取**复用生产那一份**（`conclusionEnvs` → `listEnvs`，v4.6.48 修）。
// 这里以前抄了一整套「完整性回退」，等于把这个 bug 记成了设计。注意现在是**两个**
// 版本：`season`（主证据版本，会被回退）与 `frontierSeason`（前沿窗口锚点，不回退）。
const { envs } = await conclusionEnvs(index);

for (const env of envs) {
  // 前沿窗口的锚点用 `frontierSeason`（**不回退**的最新可靠版本），不是 `season`。
  const f = await archiveFrontier(env.mode, { season: env.frontierSeason ?? env.season, stage: env.stage, window: WINDOW });
  if (!f.ok) { console.log(env.id, '读取失败', f.error); continue; }
  console.log(`\n=== ${env.id}  ${env.label}  前沿锚点 ${env.frontierSeason ?? env.season}`
    + `（主证据版本 ${env.season}）  窗口 [${f.seasons.join(', ')}]  pool=${f.pool}/${f.merged} ===`);
  // 逐版本
  const bySeason = new Map();
  for (const row of f.frontierRows) {
    if (!bySeason.has(row.season)) bySeason.set(row.season, []);
    bySeason.get(row.season).push(row);
  }
  const newestFirst = [...f.seasons].reverse();
  for (const s of newestFirst) {
    const rows = bySeason.get(s) || [];
    const costs = rows.map((r) => r.cost);
    // 该版本自己的最便宜金数（用于观察版本间水位差）
    const localMin = costs.length ? Math.min(...costs) : null;
    // 全窗口 minCost（当前公式用的）
    const globalMin = f.frontierRows.length ? Math.min(...f.frontierRows.map((r) => r.cost)) : null;
    const chars = new Set();
    for (const r of rows) for (const m of r.members) chars.add(m.char);
    const idx = newestFirst.indexOf(s);
    console.log(`  [idx ${idx}] ${s}: ${rows.length} 条, 本地最低 ${localMin} 金, 全窗口最低 ${globalMin} 金, 角色 ${chars.size}`);
  }
  // 每个整包在每个版本上的最好分（用当前公式：全窗口 minCost）
  const globalMin = Math.min(...f.frontierRows.map((r) => r.cost));
  const avAll = f.frontierRows.map((r) => r.actionValue).filter((v) => v !== null);
  const avLo = quantile(avAll, 0.05); const avHi = quantile(avAll, 0.95);
  const avUsable = avLo !== null && avHi !== null && avHi > avLo + 1e-9;
  const scoreOf = (row) => {
    const tierW = Number(SCORING.frontierTierWeight[row.tier]) || 0;
    const avScore = avUsable ? Math.max(0, Math.min(1, (avHi - row.actionValue) / (avHi - avLo))) : null;
    const avTerm = avScore === null ? 1 : SCORING.frontierAvShare + (1 - SCORING.frontierAvShare) * avScore;
    return SCORING.frontierPackScale * tierW * avTerm * (globalMin / row.cost);
  };
  const perPack = new Map(); // packKey -> Map(season -> score)
  for (const row of f.frontierRows) {
    for (const m of row.members) {
      if (packGoldOf(m) <= 0) continue;
      const k = packKeyOf(m);
      if (!perPack.has(k)) perPack.set(k, new Map());
      const cur = perPack.get(k).get(row.season);
      const sc = scoreOf(row);
      if (cur === undefined || sc > cur) perPack.get(k).set(row.season, sc);
    }
  }
  // 每个整包覆盖了几个版本
  const coverHist = new Map();
  for (const [, m] of perPack) coverHist.set(m.size, (coverHist.get(m.size) || 0) + 1);
  console.log('  整包覆盖版本数分布（覆盖 N 个版本的整包有多少个）:', [...coverHist.entries()].sort((a, b) => a[0] - b[0]));
  // 每个版本的「场地水平」：该版本所有整包最好分的中位数 / p90
  const levelBySeason = new Map();
  for (const s of newestFirst) {
    const vals = [];
    for (const [, m] of perPack) if (m.has(s)) vals.push(m.get(s));
    levelBySeason.set(s, { n: vals.length, p50: quantile(vals, 0.5), p90: quantile(vals, 0.9), max: vals.length ? Math.max(...vals) : null });
  }
  console.log('  版本场地水平（该版本整包最好分）:');
  for (const s of newestFirst) {
    const L = levelBySeason.get(s);
    console.log(`    ${s}: n=${L.n} p50=${L.p50 === null ? '—' : L.p50.toFixed(1)} p90=${L.p90 === null ? '—' : L.p90.toFixed(1)} max=${L.max === null ? '—' : L.max.toFixed(1)}`);
  }
}
