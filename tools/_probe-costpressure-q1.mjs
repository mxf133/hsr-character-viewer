// 手工探针（`_` 前缀，不进测试套件）：**Q1 证据表**——更低账面金数、成绩相当或更好的队伍。
//
//   node tools/_probe-costpressure-q1.mjs --account=1
//
// 两张表：
//   A 表：**候选池内**的队伍（总榜有对应条目 → 有生产口径的强度分/总榜分），
//         条件 = 账面金数 < 生产首推那支、绝境满分（行动值 <300）、行动值 ≤ 首推的行动值；
//   B 表：**数据集原始投稿**里最近 3 版最便宜的满分配置（含不在候选池的那些），
//         附账号补金差额、是否在候选池（总榜分 + ① 强度得分）。
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, charCostOf, coneCostOf, eidolonTierOf, marginalCostOf, normalizeDrawWeights,
  ownedCharacters, eidolonsOf, lightConeRanksOf, perfFactorOf,
  perfLineWeightsOf, teamPlan, teamPoolUnits, VERSION_WINDOW,
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
const ACC = Math.max(1, Number(arg('account', '1')) || 1);
const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const cn = (n) => zhName(i18n, 'characters', n) || zhName(i18n, 'lightCones', n) || n;
const cnCone = (n) => (n ? zhName(i18n, 'lightCones', n) || n : null);
const zhToEn = {};
for (const c of index.refs?.characters || []) if (c.nameCn && c.name) zhToEn[c.nameCn] = c.name;
const coneZhToEn = {};
for (const c of index.refs?.lightCones || []) if (c.nameCn && c.name) coneZhToEn[c.nameCn] = c.name;

const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const account = accounts[ACC - 1];
const role = (account?.roles || [])[0];
const snapshot = await store.getSnapshot(account.id, role.uid);
const allNames = (index.refs?.characters || []).map((c) => c.nameCn).filter(Boolean);
const acct = {
  owned: ownedCharacters(snapshot, zhToEn, allNames),
  eidolons: eidolonsOf(snapshot, zhToEn),
  cones: lightConeRanksOf(snapshot, coneZhToEn),
};
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const conclusion = buildConclusion(envs, {
  availability, firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});
const plan = teamPlan(conclusion, acct, { availability, drawWeights: normalizeDrawWeights({}) });
const head = plan.rows[0];

const rosterKeyOf = (members) => members
  .map((m) => `${m.char}|E${eidolonTierOf(m.eidolon)}|${m.lc || '-'}|`
    + `S${Math.max(1, Math.round(Number(m.superimp) || 1))}`)
  .sort().join('~');
const teamText = (members) => members
  .map((m) => `${cn(m.char)}E${eidolonTierOf(m.eidolon)}${m.lc ? `+${cnCone(m.lc)}S${m.superimp}` : ''}`)
  .join(' / ');
const headKey = rosterKeyOf(head.members);
const datasetGoldOf = (m) => {
  const body = charCostOf(m.char, availability);
  const cone = m.lc ? coneCostOf(m.lc, availability) : 0;
  const eid = body > 0 ? Math.max(0, Math.round(Number(m.eidolon) || 0)) : 0;
  const si = m.lc ? Math.max(1, Math.round(Number(m.superimp) || 1)) : 0;
  return body + eid + cone * si;
};
const cmpVersion = (a, b) => {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d;
  }
  return 0;
};

// ---- 逐环境：行 + 版本权重 + 判据线 --------------------------------------------
const envInfo = new Map();
for (const f of frontierAll) {
  const def = envs.find((e) => e.id === f.env);
  const seasonsDesc = [...(f.seasons || [])].sort((a, b) => -cmpVersion(a, b));
  const perfW = perfLineWeightsOf(def || { mode: f.mode, stage: f.stage });
  const rowsByRoster = new Map();
  const perfOf = (r) => perfFactorOf(r.actionValue, def?.tierLines, def?.lowerIsBetter !== false, r.tier, perfW);
  for (const r of f.frontierRows || []) {
    const k = rosterKeyOf(r.members);
    if (!rowsByRoster.has(k)) rowsByRoster.set(k, []);
    const hit = { ...r, perf: perfOf(r) };
    rowsByRoster.get(k).push(hit);
  }
  envInfo.set(f.env, {
    env: f.env, label: def?.label || f.env, weight: Number(f.weight) || 1,
    seasonsDesc, weightOf: (s) => Number(f.seasonWeights?.[s] ?? 0), rowsByRoster,
  });
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const units = teamPoolUnits(conclusion);
const byRoster = new Map();
for (const unit of units) {
  const ev = (unit.envs || []).find((e) => (e.members || []).length) || null;
  if (!ev?.members?.length) continue;
  const key = rosterKeyOf(ev.members);
  // ⚠️ ① 就是角色总榜的整包分（`unit.total`，含金数项）：v4.6.87~v4.6.90 那个独立的
  // `unit.strength`（纯强度）已按用户 2026-10-12 第 8 条删除，所以这里直接按 `total` 收敛。
  const total = Number(unit.total) || 0;
  const prev = byRoster.get(key);
  if (prev && !(total > prev.total)) continue;
  byRoster.set(key, { key, members: ev.members, total, unit });
}
const pool = [];
for (const t of byRoster.values()) {
  const cost = marginalCostOf(t.members, availability, acct);
  if (!(cost.pulls > 0)) continue;
  pool.push({ ...t, gap: cost.pulls, gold: t.members.reduce((n, m) => n + datasetGoldOf(m), 0) });
}
const strengthLo = Math.min(...pool.map((t) => t.total));
const strengthHi = Math.max(...pool.map((t) => t.total));
const gapSorted = [...pool.map((t) => t.gap)].sort((a, b) => a - b);
const gapCap = pct(gapSorted, 0.75);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
for (const t of pool) {
  t.strengthPct = 100 * clamp01(strengthHi - strengthLo < 1e-9
    ? 1 : (t.total - strengthLo) / (strengthHi - strengthLo));
  t.gapPct = 100 * clamp01(1 - (gapCap > 0 ? t.gap / gapCap : 0));
  t.score = 0.5 * t.strengthPct + 0.5 * t.gapPct;
}
const poolByKey = new Map(pool.map((t) => [t.key, t]));
console.log(`账号 ${ACC}：${role.nickname}｜首推 #1 账面 ${head.gold} 金 / 补金 ${head.gap} / `
  + `强度分 ${head.strengthPct} / 队分 ${head.teamScore}｜证据 ${head.bestEnv?.bestTeamGold} 金 · `
  + `${head.bestEnv?.actionValue} AV · ${head.bestEnv?.season}`);

const recent3 = [...envInfo.get('aa/plight').seasonsDesc].slice(0, 3);

// ---- A 表：候选池内、更便宜、成绩相当或更好的队伍 ------------------------------
const plight = envInfo.get('aa/plight');
const HEAD_AV = Number(head.bestEnv?.actionValue) || 286;
const HEAD_GOLD = Number(head.gold) || 16;
const rowsA = [];
for (const t of pool) {
  if (!(t.gold < HEAD_GOLD)) continue;
  const rows = (plight.rowsByRoster.get(t.key) || [])
    .filter((r) => r.tier === 'perfect' && r.actionValue <= HEAD_AV + 1);
  if (!rows.length) continue;
  const best = [...rows].sort((a, b) => plight.seasonsDesc.indexOf(a.season) - plight.seasonsDesc.indexOf(b.season)
    || a.actionValue - b.actionValue)[0];
  rowsA.push({ ...t, ev: best });
}
rowsA.sort((a, b) => b.score - a.score);
/** 该名单在绝境有**满分**（行动值 <300）证据的版本集合（新→旧）。 */
const perfectSeasonsOf = (key) => [...new Set((plight.rowsByRoster.get(key) || [])
  .filter((r) => r.tier === 'perfect' && r.actionValue < 300).map((r) => r.season))]
  .sort((a, b) => plight.seasonsDesc.indexOf(a) - plight.seasonsDesc.indexOf(b));
console.log(`\n=== A 表：候选池内「账面 < ${HEAD_GOLD} 金 + 绝境满分 + 行动值 ≤ ${HEAD_AV}」`
  + `（共 ${rowsA.length} 支，按当前总分降序）===`);
console.log('  #  当前总分  账面  补金  最佳证据(金/AV/版本)  满分版本集合        强度分   总榜分    队伍');
rowsA.forEach((t, i) => {
  const ps = perfectSeasonsOf(t.key);
  console.log(`  ${String(i + 1).padStart(2)} ${t.score.toFixed(1).padStart(7)}  ${String(t.gold).padStart(4)}`
    + `  ${String(t.gap).padStart(4)}  ${String(t.ev.cost).padStart(2)}金/${String(t.ev.actionValue).padStart(3)}AV/${String(t.ev.season).padEnd(4)}`
    + `  ${ps.join(',').padEnd(16)} ${t.strengthPct.toFixed(1).padStart(6)} ${t.total.toFixed(1).padStart(8)}   ${teamText(t.members)}`);
});
console.log(`  对照·首推那支队：满分版本 ${perfectSeasonsOf(head.key).join(',') || '（该四人名单口径）'}`
  + `；它的代表整包（长夜月 E2S1）在绝境全部 7 个版本都有满分证据（4.6 需 20 金）`);

// ---- B 表：最近 3 版最便宜的满分配置（不限候选池）------------------------------
const cands = [];
for (const [key, rows] of plight.rowsByRoster) {
  const inRecent = rows.filter((r) => recent3.includes(r.season) && r.tier === 'perfect'
    && r.actionValue < 300);
  if (!inRecent.length) continue;
  const best = [...inRecent].sort((a, b) => a.cost - b.cost || a.actionValue - b.actionValue)[0];
  const cost = marginalCostOf(best.members, availability, acct);
  cands.push({
    key, members: best.members, cost: best.cost, av: best.actionValue, season: best.season,
    gap: cost.pulls, inPool: poolByKey.get(key) || null,
  });
}
cands.sort((a, b) => a.cost - b.cost || a.av - b.av);
console.log(`\n=== B 表：最近 3 版（${recent3.join('/')}）最便宜满分配置（共 ${cands.length} 支，金数升序前 14）===`);
console.log('  #  证据金  AV   版本  账号补金  在候选池(总榜分/强度分)  队伍');
cands.slice(0, 14).forEach((c, i) => {
  const poolText = c.inPool ? `是（${c.inPool.total.toFixed(0)}/${c.inPool.strengthPct.toFixed(1)}）` : '否';
  console.log(`  ${String(i + 1).padStart(2)} ${String(c.cost).padStart(6)} ${String(c.av).padStart(4)}`
    + `  ${String(c.season).padEnd(5)} ${String(c.gap).padStart(7)}  ${poolText.padEnd(22)}`
    + ` ${teamText(c.members)}`);
});
console.log('\n  对照：首推那支队（四人名单口径）');
console.log(`    绝境原始投稿：${(plight.rowsByRoster.get(headKey) || [])
  .sort((a, b) => plight.seasonsDesc.indexOf(a.season) - plight.seasonsDesc.indexOf(b.season)
    || a.actionValue - b.actionValue)
  .map((r) => `${r.season}:${r.cost}金/${r.actionValue}AV/${r.tier}`).join('  ') || '—'}`);
console.log(`    在候选池：${poolByKey.has(headKey) ? '是' : '否'}`);
console.log(`    生产口径（代表整包 Evernight E2S1 = 长夜月 E2 + 致长夜的星光 S1）：`
  + `队分（= 总榜分）${head.teamScore}`);
