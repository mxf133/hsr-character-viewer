// 探针：量化「金数项分母混档位」在榜面上的实际影响（只改分母，其余口径不动）。
//
// 做法：直接消费真实 buildConclusion 的 frontierUnits（内部未裁剪结果），
// 对每个「整包×副本」用它自己的 evidence（tier / cost / seasonMinCost / actionValue）
// 重算该副本分，只把金数项分母从「该版本全档最小」换成「该版本同档最小」（clamp ≤1），
// 再按同样的版本权重（服务端下发的 seasonWeights）与三态规则汇总，比较名次。
import { archiveIndex, archiveFrontier, archiveFrontierAll } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
import { buildConclusion, SCORING, VERSION_WINDOW, VERSION_WEIGHTS } from '../src/core/advice.js';

const clamp01 = (n) => Math.max(0, Math.min(1, n));

const index = await archiveIndex();
const firstSeen = index.refs?.firstSeen || { characters: {}, lightCones: {} };
const { envs } = await conclusionEnvs(index, {});
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const res = buildConclusion(envs, {
  availability: index.refs?.availability || {},
  firstSeen,
  account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  frontierWeights: Object.fromEntries(frontierAll.map((f) => [f.env, f.weight])),
});

// 每个副本：逐版本「同档最便宜金数」
const sameTierMin = new Map(); // envId -> Map(season -> Map(tier -> minCost))
for (const env of envs) {
  const f = await archiveFrontier(env.mode, { stage: env.stage || '' });
  const m = new Map();
  for (const r of f.frontierRows || []) {
    const s = r.season || '';
    if (!m.has(s)) m.set(s, new Map());
    const t = m.get(s);
    const cur = t.get(r.tier);
    if (cur === undefined || r.cost < cur) t.set(r.tier, r.cost);
  }
  sameTierMin.set(env.id, m);
}

const metaOf = (id) => (res.frontierEnvs || []).find((e) => e.id === id) || {};
const units = res.frontierUnits || [];

// 现状分（直接读 value）
const cur = units.map((u) => ({ u, total: u.total }));
// 修正分：重算每个副本的 envScore
const fixed = [];
for (const u of units) {
  let total = 0;
  let changed = 0;
  for (const e of u.envs || []) {
    const meta = metaOf(e.id);
    const w = Number(meta.weight) || 0;
    const curEnvScore = w > 0 ? (Number(e.value) || 0) / w : 0;
    // 金数项：现状 = seasonMinCost / cost（seasonMinCost 就是全档最小）
    const tierFactor = Number(SCORING.frontierTierWeight[e.tier]) || 0;
    const av = e.actionValue;
    const avLo = meta.avLo; const avHi = meta.avHi;
    const usable = av !== null && av !== undefined && avLo != null && avHi != null && avHi > avLo + 1e-9;
    const avScore = usable ? clamp01((avHi - av) / (avHi - avLo)) : null;
    const avFactor = avScore === null ? 1 : SCORING.frontierAvShare + (1 - SCORING.frontierAvShare) * avScore;
    const baseCur = SCORING.frontierPackScale * tierFactor * avFactor;
    const curCostFactor = baseCur > 0 && e.bestTeamGold > 0 ? e.seasonMinCost / e.bestTeamGold : null;
    const curBase = baseCur * (curCostFactor ?? 1);
    const seasonFactor = curBase > 0 ? curEnvScore / curBase : 1;

    // 修正：分母换成同档最小（clamp ≤1）
    const t = sameTierMin.get(e.id)?.get(String(e.evidenceSeason || ''));
    const sameMin = t?.get(e.tier);
    let newCostFactor = curCostFactor;
    if (sameMin !== undefined && e.bestTeamGold > 0) {
      newCostFactor = Math.min(1, sameMin / e.bestTeamGold);
    }
    if (newCostFactor !== null && curCostFactor !== null && Math.abs(newCostFactor - curCostFactor) > 1e-9) changed += 1;
    const newBase = baseCur * (newCostFactor ?? 1);
    total += w * newBase * (Number.isFinite(seasonFactor) ? seasonFactor : 1);
  }
  fixed.push({ u, total, changed });
}

const rankCur = new Map(cur.map((x, i) => [x.u.key, i + 1]));
const sortedFixed = [...fixed].sort((a, b) => b.total - a.total
  || String(a.u.name).localeCompare(String(b.u.name)));
const rankFixed = new Map(sortedFixed.map((x, i) => [x.u.key, i + 1]));

const withChange = fixed.filter((x) => x.changed > 0).length;
console.log(`榜面 ${units.length} 条整包；金数项分母被 target 档拉低（至少一个副本）的条目：${withChange}`);
console.log(`\n分值变化 top 12（现状 → 修正后）:`);
const deltas = fixed.map((x) => ({
  name: x.u.name, eid: x.u.eidolon, lc: x.u.lc,
  before: rankCur.get(x.u.key), after: rankFixed.get(x.u.key),
  bv: (cur.find((c) => c.u.key === x.u.key) || {}).total, av: x.total,
  d: x.total - ((cur.find((c) => c.u.key === x.u.key) || {}).total || 0),
})).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
for (const d of deltas.slice(0, 12)) {
  console.log(`   ${String(d.name).padEnd(24)} E${d.eid} ${String(d.lc || '—').padEnd(30)} `
    + `分 ${(d.bv || 0).toFixed(0).padStart(5)} → ${d.av.toFixed(0).padStart(5)}  `
    + `名次 #${d.before} → #${d.after}`);
}

// Spearman
const keys = [...rankCur.keys()].filter((k) => rankFixed.has(k));
const n2 = keys.length;
let d2 = 0;
for (const k of keys) d2 += (rankCur.get(k) - rankFixed.get(k)) ** 2;
const rho = 1 - (6 * d2) / (n2 * (n2 * n2 - 1));
const moved10 = keys.filter((k) => Math.abs(rankCur.get(k) - rankFixed.get(k)) >= 10).length;
console.log(`\nSpearman ρ = ${rho.toFixed(4)}；名次变动 ≥10 的条目 = ${moved10} / ${n2}`);
