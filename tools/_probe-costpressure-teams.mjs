// 手工探针（`_` 前缀，不进测试套件）：**压金队伍 vs 当前首推队伍**的证据盘点。
//
//   node tools/_probe-costpressure-teams.mjs --account=1
//
// 回答三件事：
//   Q1 候选池里哪些队伍在**更低的账面金数**下打到与首推队伍相当/更好的成绩；
//   Q2 首推队伍的分数**逐版本**是从哪来的（含版本权重）；
//   Q3 最新版本的绝境王棋关里，最便宜的满分（行动值 <300）配置是几金。
//
// 口径全部复用生产实现：`archiveFrontierAll` 取原始前沿行、`buildConclusion` 出总榜、
// `teamPlan` 出当前首推、`perfFactorOf`/`frontierCostTermOf`/`packStrengthOf` 复算分。
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, eidolonTierOf, frontierCostTermOf, marginalCostOf, normalizeDrawWeights,
  ownedCharacters, eidolonsOf, lightConeRanksOf, packStrengthOf, perfFactorOf,
  perfLineWeightsOf, teamPlan, teamPoolUnits, versionWeightOf, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontier, archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (name, dflt) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return dflt;
};
const ACC = Math.max(1, Number(arg('account', '1')) || 1);
const COST_CAP = Number(arg('cap', '12')) || 12;

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const cn = (n) => zhName(i18n, 'characters', n) || zhName(i18n, 'lightCones', n) || n;
const cnCone = (n) => (n ? zhName(i18n, 'lightCones', n) || n : null);

// ---- 账号快照（与 tools/_probe-team-plan.mjs 同一读法）--------------------------
const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const account = accounts[ACC - 1];
const role = (account?.roles || [])[0];
const snapshot = await store.getSnapshot(account.id, role.uid);
const zhToEn = {}; const allNames = [];
for (const c of index.refs?.characters || []) {
  if (c.nameCn && c.name) zhToEn[c.nameCn] = c.name;
  if (c.nameCn) allNames.push(c.nameCn);
}
const coneZhToEn = {};
for (const c of index.refs?.lightCones || []) if (c.nameCn && c.name) coneZhToEn[c.nameCn] = c.name;
const acct = {
  owned: ownedCharacters(snapshot, zhToEn, allNames),
  eidolons: eidolonsOf(snapshot, zhToEn),
  cones: lightConeRanksOf(snapshot, coneZhToEn),
};

const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const frontier = Object.fromEntries(frontierAll.map((f) => [f.env, f]));
const conclusion = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier,
});
const plan = teamPlan(conclusion, acct, { availability, drawWeights: normalizeDrawWeights({}) });

const rosterKeyOf = (members) => members
  .map((m) => `${m.char}|E${eidolonTierOf(m.eidolon)}|${m.lc || '-'}|`
    + `S${Math.max(1, Math.round(Number(m.superimp) || 1))}`)
  .sort().join('~');
const teamText = (members) => members
  .map((m) => `${cn(m.char)}E${eidolonTierOf(m.eidolon)}${m.lc ? `+${cnCone(m.lc)}S${m.superimp}` : ''}`)
  .join(' / ');

// ---- 逐副本元数据（判据线 / 版本窗口）-----------------------------------------
const plight = frontierAll.find((f) => f.env === 'aa/plight');
const plightEnv = envs.find((e) => e.id === 'aa/plight');
const plightMeta = conclusion.frontierEnvs?.find((e) => e.id === 'aa/plight');
const perfW = perfLineWeightsOf(plightEnv || { mode: 'aa', stage: 'plight' });
const seasonWeights = plight.seasonWeights || {};
const seasonsAsc = [...(plight.seasons || [])].sort((a, b) => {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d;
  }
  return 0;
});
const seasonsDesc = [...seasonsAsc].reverse();
const weightOf = (s) => Number(seasonWeights[s] ?? versionWeightOf(seasonsDesc.indexOf(s)));

console.log(`=== 环境：异相仲裁 · 绝境王棋关（id=${plight.env}）===`);
console.log(`窗口内版本（新→旧）：${seasonsDesc.map((s) => `${s}(w${weightOf(s)})`).join('  ')}`);
console.log(`前沿行：${(plight.frontierRows || []).length} 行；判据线权重 ${JSON.stringify(perfW)}；`
  + `行动值区间 avLo=${plightMeta?.avLo} avHi=${plightMeta?.avHi}`);

// ---- 逐版本：行数 / 满分行数 / 最便宜满分金数（生产算分用的分母）----------------
const bySeason = new Map(seasonsAsc.map((s) => [s, []]));
for (const r of plight.frontierRows || []) {
  if (!bySeason.has(r.season)) bySeason.set(r.season, []);
  bySeason.get(r.season).push(r);
}
const denomOf = (s) => {
  const rows = bySeason.get(s) || [];
  const perfect = rows.filter((r) => r.tier === 'perfect').map((r) => Math.max(1, r.cost));
  const all = rows.map((r) => Math.max(1, r.cost));
  return perfect.length ? Math.min(...perfect) : (all.length ? Math.min(...all) : null);
};
console.log('\n=== 逐版本盘点（绝境）===');
console.log('  版本     权重  行数  满分行  达标行  最便宜满分  最便宜达标  分母(生产)');
for (const s of seasonsAsc) {
  const rows = bySeason.get(s) || [];
  const p = rows.filter((r) => r.tier === 'perfect');
  const t = rows.filter((r) => r.tier === 'target');
  const minP = p.length ? Math.min(...p.map((r) => r.cost)) : null;
  const minT = t.length ? Math.min(...t.map((r) => r.cost)) : null;
  console.log(`  ${String(s).padEnd(7)} ${String(weightOf(s)).padStart(4)}`
    + ` ${String(rows.length).padStart(5)} ${String(p.length).padStart(6)} ${String(t.length).padStart(6)}`
    + ` ${String(minP ?? '—').padStart(10)} ${String(minT ?? '—').padStart(10)}`
    + ` ${String(denomOf(s) ?? '—').padStart(9)}`);
}

// ---- 复算某一行的**单版本分**（与 buildConclusionInner 同一批原语）-------------
const scoreOfRow = (r) => {
  const perf = perfFactorOf(r.actionValue, plightEnv?.tierLines, true, r.tier, perfW);
  if (!(perf > 0)) return { perf, score: 0, strength: 0, costFactor: null };
  const cf = frontierCostTermOf(denomOf(r.season), r.cost);
  return { perf, score: 100 * perf * (cf ?? 1), strength: packStrengthOf(perf), costFactor: cf };
};

// ---- 首推队伍（teamPlan #1）----------------------------------------------------
const head = plan.rows[0];
const headKey = rosterKeyOf(head.members);
console.log(`\n=== 当前抽卡方案 #1（账面 ${head.gold} 金 / 补金 ${head.gap} 金 / 队分 ${head.teamScore.toFixed(1)}`
  + ` / 强度 ${head.strength.toFixed(1)}）===`);
console.log(`  ${teamText(head.members)}`);
console.log(`  证据：${head.bestEnv?.label} ${head.bestEnv?.bestTeamGold} 金 · ${head.bestEnv?.actionValue} 行动值`
  + ` · 版本 ${head.bestEnv?.season} · 档位 ${head.bestEnv?.tier}`);

// ---- Q2：首推队伍的逐版本证据 ---------------------------------------------------
const headRows = (plight.frontierRows || []).filter((r) => rosterKeyOf(r.members) === headKey);
const headBySeason = new Map();
for (const r of headRows) {
  const cur = headBySeason.get(r.season);
  if (!cur || r.actionValue < cur.actionValue) headBySeason.set(r.season, r);
}
console.log('\n=== Q2：这支队在绝境的逐版本证据（实测原始投稿）===');
console.log('  版本     权重  金数  行动值  档位     表现分   金数项   单版本分   纯强度');
let num = 0; let den = 0; let sNum = 0;
for (const s of seasonsDesc) {
  const r = headBySeason.get(s);
  const w = weightOf(s);
  if (!r) { console.log(`  ${String(s).padEnd(7)} ${String(w).padStart(4)}   —— 无该版本证据`); continue; }
  const { perf, score, strength, costFactor } = scoreOfRow(r);
  num += w * score; den += w; sNum += w * strength;
  console.log(`  ${String(s).padEnd(7)} ${String(w).padStart(4)} ${String(r.cost).padStart(5)}`
    + ` ${String(r.actionValue).padStart(7)}  ${String(r.tier).padEnd(8)}`
    + ` ${perf.toFixed(4).padStart(8)} ${String(costFactor === null ? '—' : costFactor.toFixed(3)).padStart(8)}`
    + ` ${score.toFixed(2).padStart(9)} ${strength.toFixed(2).padStart(9)}`);
}
console.log(`  版本加权平均：分 ${(num / den).toFixed(2)}（权重和 ${den}）｜纯强度 ${(sNum / den).toFixed(2)}`);
// 与生产总榜上那条整包的值对照（验证复算口径）
const headUnit = (conclusion.frontierUnits || []).find((u) => {
  const m = (u.envs || []).find((e) => (e.members || []).length);
  return m && rosterKeyOf(m.members) === headKey;
});
const headEnv = headUnit?.envs?.find((e) => e.id === 'aa/plight');
console.log(`  生产总榜同一整包的 aa/plight 条目：score ${headEnv?.score} · strength ${headEnv?.strength}`
  + `（整包 ${headUnit?.name} E${headUnit?.eidolon} 总榜分 ${headUnit?.total} 强度 ${headUnit?.strength}）`);

// ---- 队伍分索引：roster -> {strength,total,gold}（与 teamPlan 同一口径）---------
const units = teamPoolUnits(conclusion);
const bestByRoster = new Map();
for (const unit of units) {
  const ev = (unit.envs || []).find((e) => (e.members || []).length);
  if (!ev) continue;
  const key = rosterKeyOf(ev.members);
  const strength = Number.isFinite(Number(unit.strength)) ? Number(unit.strength) : Number(unit.total) || 0;
  const total = Number(unit.total) || 0;
  const prev = bestByRoster.get(key);
  if (prev && !(strength > prev.strength || (strength === prev.strength && total > prev.total))) continue;
  bestByRoster.set(key, { key, members: ev.members, strength, total, unit });
}

// ---- Q1：更低账面金数 + 相当或更好的成绩 ---------------------------------------
// 「相当或更好」= 同副本同档位（绝境）、满分档（行动值 <300）、行动值 ≤ 首推的 286。
const HEAD_AV = Number(head.bestEnv?.actionValue) || 286;
const HEAD_GOLD = Number(head.gold) || 16;
const rosterRows = new Map();
for (const r of plight.frontierRows || []) {
  const key = rosterKeyOf(r.members);
  if (!rosterRows.has(key)) rosterRows.set(key, []);
  rosterRows.get(key).push(r);
}
const cand = [];
for (const [key, rows] of rosterRows) {
  // 该队伍在窗口内**最新**的证据（先比版本新，再比行动值低）——「最新版本」优先。
  const sorted = [...rows].sort((a, b) => {
    const ia = seasonsDesc.indexOf(a.season); const ib = seasonsDesc.indexOf(b.season);
    return ia - ib || a.actionValue - b.actionValue;
  });
  const bestRecent = sorted[0];
  const bestAny = [...rows].sort((a, b) => a.actionValue - b.actionValue)[0];
  const gold = bestRecent.cost;
  if (!(gold < HEAD_GOLD)) continue;
  if (!(bestRecent.actionValue <= HEAD_AV + 1)) continue;
  if (bestRecent.tier !== 'perfect') continue;
  const score = bestByRoster.get(key) || null;
  cand.push({
    key, members: bestRecent.members, gold, av: bestRecent.actionValue, season: bestRecent.season,
    tier: bestRecent.tier, bestAny, score,
  });
}
cand.sort((a, b) => a.gold - b.gold || a.av - b.av);
console.log(`\n=== Q1：账面金数 < ${HEAD_GOLD} 且最新版本满分（行动值 ≤ ${HEAD_AV}）的队伍`
  + `（共 ${cand.length} 支，按金数升序）===`);
console.log('  #  金数  行动值  版本   强度分   总榜分   队伍');
cand.forEach((c, i) => {
  const sp = c.score ? c.score.strength.toFixed(1) : '—';
  const tp = c.score ? c.score.total.toFixed(1) : '—';
  console.log(`  ${String(i + 1).padStart(2)} ${String(c.gold).padStart(5)} ${String(c.av).padStart(7)}`
    + `  ${String(c.season).padEnd(6)} ${String(sp).padStart(7)} ${String(tp).padStart(8)}   ${teamText(c.members)}`);
});

// ---- Q1b：最新 3 个版本里的最便宜满分配置（不看账号）---------------------------
const recent3 = seasonsDesc.slice(0, 3);
const recentCand = [];
for (const [key, rows] of rosterRows) {
  const inRecent = rows.filter((r) => recent3.includes(r.season) && r.tier === 'perfect');
  if (!inRecent.length) continue;
  const best = [...inRecent].sort((a, b) => a.cost - b.cost || a.actionValue - b.actionValue)[0];
  recentCand.push({ key, ...best });
}
recentCand.sort((a, b) => a.cost - b.cost || a.actionValue - b.actionValue);
console.log(`\n=== Q1b：最近 3 版（${recent3.join('/')}）里的最便宜满分配置（共 ${recentCand.length} 支）===`);
console.log('  #  金数  行动值  版本   队伍');
recentCand.slice(0, 20).forEach((c, i) => {
  console.log(`  ${String(i + 1).padStart(2)} ${String(c.cost).padStart(5)} ${String(c.actionValue).padStart(7)}`
    + `  ${String(c.season).padEnd(6)} ${teamText(c.members)}`);
});

// ---- Q3：最新版本的绝境：最便宜的满分配置 --------------------------------------
const newest = seasonsAsc[seasonsAsc.length - 1];
const newestRows = (bySeason.get(newest) || []).filter((r) => r.tier === 'perfect' && r.actionValue < 300);
newestRows.sort((a, b) => a.cost - b.cost || a.actionValue - b.actionValue);
console.log(`\n=== Q3：最新版本 ${newest} 的绝境满分（行动值 <300）配置 ${newestRows.length} 条 ===`);
newestRows.slice(0, 8).forEach((r, i) => {
  console.log(`  ${String(i + 1).padStart(2)} ${String(r.cost).padStart(5)} 金 ${String(r.actionValue).padStart(5)} 行动值`
    + `  ${teamText(r.members)}`);
});
const cheapest = newestRows[0];
if (cheapest) {
  console.log(`  最便宜满分：${cheapest.cost} 金 · ${cheapest.actionValue} 行动值 · ${teamText(cheapest.members)}`);
  console.log(`  与首推队伍（${HEAD_GOLD} 金）差 ${HEAD_GOLD - cheapest.cost} 金`);
  console.log(`  账号 1 在这支最便宜配置上还缺：`
    + cheapest.members.map((m) => `${cn(m.char)}E${eidolonTierOf(m.eidolon)}`
      + `${m.lc ? `+${cnCone(m.lc)}S${m.superimp}` : ''}[${acct.owned.has(m.char) ? '有' : '缺'}]`).join(' / '));
  const cost = marginalCostOf(cheapest.members, availability, acct);
  console.log(`  账号 1 照抄它的补金差额：${cost.pulls} 金`);
}

// ---- 顺带：当前方案前 5 名（对照用）-------------------------------------------
console.log('\n=== 对照：当前抽卡方案前 5 ===');
plan.rows.slice(0, 5).forEach((row, i) => {
  console.log(`  #${i + 1} 总分 ${row.total.toFixed(1)}｜账面 ${row.gold} 金｜补金 ${row.gap} 金`
    + `｜强度分 ${row.strengthPct.toFixed(1)}｜队分 ${row.teamScore.toFixed(1)}｜${teamText(row.members)}`);
});
