// 探针：行动值前沿（`avTeams`）那一池的真实数据体检 —— 0 行动值的队伍到底拿几分。
//
//   node tools/_probe-av-frontier.mjs [--rows=12]
import {
  SCORING, buildConclusion, eidolonTierOf, teamPoolUnits, VERSION_WINDOW,
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
const ROWS = Math.max(1, Number(arg('rows', '12')) || 12);

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const cn = (n) => zhName(i18n, 'characters', n) || zhName(i18n, 'lightCones', n) || n;
const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const conclusion = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});
const units = teamPoolUnits(conclusion);
const coneCost = (lc) => (availability.lightCones?.[lc]?.limited === false ? 0 : 1);
const coneRank = (m) => (m.lc && coneCost(m.lc) > 0
  ? Math.max(1, Math.round(Number(m.superimp) || 1)) : 0);

// 证据池里已有的阵容键（与 advice.js 的 `byRoster` 同一取法）
const boardKeys = new Set();
for (const u of units) {
  for (const env of u.envs || []) {
    const ms = env.members || [];
    if (!ms.length) continue;
    boardKeys.add(ms.map((m) => `${m.char}|E${eidolonTierOf(m.eidolon)}|${m.lc || '-'}`
      + `|S${Math.max(1, Math.round(Number(m.superimp) || 1))}`).sort().join('~'));
  }
}

const rosterKeyOf = (members) => members.map((m) => `${m.char}|E${eidolonTierOf(m.eidolon)}`
  + `|${m.lc || '-'}|S${Math.max(1, Math.round(Number(m.superimp) || 1))}`).sort().join('~');

const byRoster = new Map();
let rows = 0; let zeroRows = 0; let missingCost = 0; let missingMinCost = 0;
for (const env of conclusion.frontierEnvs || []) {
  const list = Array.isArray(env.avTeams) ? env.avTeams : [];
  const weight = Number(env.weight) || 0;
  for (const row of list) {
    rows += 1;
    const av = Number(row.av);
    if (av === 0) zeroRows += 1;
    if (!(Number(row.cost) > 0)) missingCost += 1;
    const mc = Number((env.minCostBySeason || {})[row.season]);
    if (!(mc > 0)) missingMinCost += 1;
    const key = rosterKeyOf(row.members || []);
    const prev = byRoster.get(key) || { members: row.members, hits: [] };
    prev.hits.push({ id: env.id, label: env.envLabel || env.id, weight, av, cost: Number(row.cost) || 0, minCost: mc, season: row.season, inBoard: boardKeys.has(key) });
    byRoster.set(key, prev);
  }
}
console.log(`avTeams 行 ${rows}（其中 0 行动值 ${zeroRows}）｜合并后阵容 ${byRoster.size}`
  + `｜缺 cost ${missingCost}｜缺 minCostBySeason ${missingMinCost}`);

const allEnvWeight = (conclusion.frontierEnvs || [])
  .reduce((n, e) => n + (Number(e.weight) || 0), 0);
const tierLinesOf = new Map((conclusion.frontierEnvs || []).map((e) => [e.id, e.tierLines || null]));

const scored = [];
for (const [key, av] of byRoster) {
  const ownEnvs = av.hits.filter((h) => Number.isFinite(h.av));
  if (!ownEnvs.length) continue;
  // 复刻 advice.js 的 avCandidates 那一段（判据线走 tierLines 分支）
  const withStrength = ownEnvs.map((h) => {
    const lines = tierLinesOf.get(h.id);
    let envStrength;
    if (lines) {
      // 只用于核对：两档规则
      const perf = Number(h.av) === 0 ? 1 : null;
      envStrength = h.av === 0 ? 100 : null;
      if (perf === null) envStrength = `需曲线(${h.id})`;
    } else {
      envStrength = h.av === 0 ? 100 : SCORING.strengthSecondBandCap;
    }
    return { ...h, envStrength };
  });
  const wSum = withStrength.reduce((n, h) => n + h.weight, 0);
  const zeroAll = withStrength.every((h) => h.av === 0);
  const pinched = withStrength.reduce((n, h) => n
    + (h.cost > 0 && h.minCost > 0 ? h.weight * Math.min(1, h.minCost / h.cost) : 0), 0) / wSum;
  const invest = Math.max(0, Math.min(1, (av.members || []).reduce(
    (n, m) => n + eidolonTierOf(m.eidolon) + coneRank(m), 0) / SCORING.fullInvestRank));
  scored.push({
    key,
    members: av.members,
    envs: withStrength.map((h) => `${h.label}:${h.av}`).join(' '),
    allZero: zeroAll,
    minAv: Math.min(...withStrength.map((h) => h.av)),
    inBoard: withStrength.some((h) => h.inBoard),
    pinched: Number(pinched.toFixed(3)),
    invest: Number(invest.toFixed(3)),
    cost: withStrength.map((h) => `${h.cost}/${h.minCost || '—'}`).join(' '),
    envCount: withStrength.length,
    weightSum: wSum,
    envWeightAll: allEnvWeight,
  });
}
const zeros = scored.filter((s) => s.allZero);
console.log(`\n全 0 行动值的队 ${zeros.length} 支（若计入包络前，强度 = 95 + 5×压金度）：`);
for (const s of zeros.slice(0, ROWS)) {
  console.log(`  强度 ${(95 + 5 * s.pinched).toFixed(2)}（压金度 ${s.pinched}）`
    + `｜投入 ${s.invest}｜金数/最便宜 ${s.cost}｜证据池已有=${s.inBoard ? 'Y' : 'N'}`);
  console.log(`     ${(s.members || []).map((m) => `${cn(m.char)}E${m.eidolon}${m.lc ? '/' + cn(m.lc) + 'S' + m.superimp : ''}`).join(' + ')}`);
}
console.log(`\n只在一个副本有数据的队 ${scored.filter((s) => s.envCount === 1).length} 支`
  + `（它们的「整包分母」只有自己那一关 ⇒ 单关 0 行动值也是顶格）`);
const singleZero = scored.filter((s) => s.envCount === 1 && s.minAv === 0);
console.log(`其中 0 行动值的 ${singleZero.length} 支：`);
for (const s of singleZero.slice(0, ROWS)) {
  console.log(`  强度 ${(95 + 5 * s.pinched).toFixed(2)}｜权限重 ${s.weightSum}/${s.envWeightAll}`
    + `｜${s.envs}｜证据池已有=${s.inBoard ? 'Y' : 'N'}`);
}
