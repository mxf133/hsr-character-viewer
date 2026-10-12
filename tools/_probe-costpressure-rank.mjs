// 手工探针（`_` 前缀，不进测试套件）：**抽卡方案的候选池复刻 + 候选改法的前 5 名**。
//
//   node tools/_probe-costpressure-rank.mjs --account=1
//
// A 段先复刻 `teamPlan()` 的候选池与排序，并与生产 `teamPlan()` 的前 15 名逐条对齐
// （不对齐就说明复刻跑偏了，下面的改法结论都不可信）。
// B 段列出「账面金数更低、成绩相当或更好」的候选（含总榜分 / 当前总分）。
// C 段按几种候选改法重排，打印各自的新前 5 名。
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, charCostOf, coneCostOf, eidolonTierOf, marginalCostOf, normalizeDrawWeights,
  ownedCharacters, eidolonsOf, lightConeRanksOf, SCORING, teamPlan, teamPoolUnits, VERSION_WINDOW,
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
const firstSeen = index.refs?.firstSeen || { characters: {}, lightCones: {} };

/** 数据集那条 `c` 的金数口径（与 advice.js 的 `datasetGoldOf` 同一条，未导出，这里复刻）。 */
const datasetGoldOf = (m) => {
  const body = charCostOf(m.char, availability);
  const cone = m.lc ? coneCostOf(m.lc, availability) : 0;
  const eidolon = body > 0 ? Math.max(0, Math.round(Number(m.eidolon) || 0)) : 0;
  const superimp = m.lc ? Math.max(1, Math.round(Number(m.superimp) || 1)) : 0;
  return body + eidolon + cone * superimp;
};

const rosterKeyOf = (members) => members
  .map((m) => `${m.char}|E${eidolonTierOf(m.eidolon)}|${m.lc || '-'}|`
    + `S${Math.max(1, Math.round(Number(m.superimp) || 1))}`)
  .sort().join('~');
const teamText = (members) => members
  .map((m) => `${cn(m.char)}E${eidolonTierOf(m.eidolon)}${m.lc ? `+${cnCone(m.lc)}S${m.superimp}` : ''}`)
  .join(' / ');

/** 用给定的前沿重算一次结论 + 方案。 */
const run = async (frontierAll, drawWeights) => {
  const conclusion = buildConclusion(envs, {
    availability, firstSeen, account: acct,
    frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
    frontierWeights: Object.fromEntries(frontierAll.map((f) => [f.env, f.weight])),
  });
  return { frontierAll, conclusion, plan: teamPlan(conclusion, acct, { availability, drawWeights }) };
};

const base = await run(await archiveFrontierAll(envs, { window: VERSION_WINDOW }), normalizeDrawWeights({}));
const prod = base.plan;

// ---- A. 复刻候选池 --------------------------------------------------------------
const units = teamPoolUnits(base.conclusion);
const byRoster = new Map();
for (const unit of units) {
  const ev = (unit.envs || []).find((e) => (e.members || []).length) || null;
  const members = ev?.members || [];
  if (!members.length) continue;
  const key = rosterKeyOf(members);
  // ⚠️ ① 就是角色总榜的整包分（`unit.total`，含金数项）：v4.6.87~v4.6.90 那个独立的
  // `unit.strength`（纯强度）已按用户 2026-10-12 第 8 条删除，所以这里直接按 `total` 收敛。
  const total = Number(unit.total) || 0;
  const prev = byRoster.get(key);
  if (prev && !(total > prev.total)) continue;
  byRoster.set(key, { key, members, total, unit, best: ev });
}
const pool = [];
for (const t of byRoster.values()) {
  const cost = marginalCostOf(t.members, availability, acct);
  if (!(cost.pulls > 0)) continue;
  pool.push({ ...t, gap: cost.pulls, gold: t.members.reduce((n, m) => n + datasetGoldOf(m), 0) });
}
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const totalLo = Math.min(...pool.map((t) => t.total));
const totalHi = Math.max(...pool.map((t) => t.total));
const gapSorted = [...pool.map((t) => t.gap)].sort((a, b) => a - b);
const goldSorted = [...pool.map((t) => t.gold)].sort((a, b) => a - b);
const gapCap = pct(gapSorted, 0.75);
const goldCap = pct(goldSorted, 0.75);
console.log(`=== A. 候选池复刻（对照生产 teamPlan）===`);
console.log(`  生产：poolAll ${prod.poolAll} / 候选 ${prod.pool} / ① 刻度（总榜分）${prod.strengthLo}~${prod.strengthHi}`
  + ` / 差额封顶 ${prod.gapMax}（p${prod.gapCapPct * 100}）`);
console.log(`  复刻：poolAll ${byRoster.size} / 候选 ${pool.length} / ① 刻度（总榜分）${totalLo.toFixed(1)}~${totalHi.toFixed(1)}`
  + ` / 差额封顶 ${gapCap}`
  + `；账面金数 p50=${pct(goldSorted, 0.5)} p75=${goldCap} max=${goldSorted[goldSorted.length - 1]}`);

/**
 * 通用打分：① 只有**一个**口径（角色总榜整包分 `unit.total`，含金数项），
 * ② 的刻度轴二选一（gap 或 gold）。
 * ⚠️ v4.6.91 撤销「纯强度」之后，① 那第二根轴没有了 —— 调用点传的 `axisA` 已不起作用。
 */
const scorePool = (opts) => {
  const {
    axisB = 'gap', weights = { strength: 0.5, cost: 0.5 },
    strengthWeightCap = null,
  } = opts;
  const aLo = totalLo;
  const aHi = totalHi;
  const bCap = axisB === 'gap' ? (opts.gapCapOverride ?? gapCap) : (opts.goldCapOverride ?? goldCap);
  const span = (v, lo, hi) => (hi - lo < 1e-9 ? 1 : (v - lo) / (hi - lo));
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  for (const t of pool) {
    const a = t.total;
    const b = axisB === 'gap' ? t.gap : t.gold;
    t.aPct = 100 * clamp01(span(a, aLo, aHi));
    // ⚠️ ② 的曲线指数必须跟着生产走（v4.6.92 起 = 1.5）：少了它这条「与生产完全一致」的
    //    自检会当场 ✗ —— 那是**本探针**的错，不是生产的。
    t.bPct = 100 * clamp01(1 - span(b, 0, bCap)) ** (Number(SCORING.teamPlanGapPower) || 1);
    let wA = weights.strength;
    // 「封顶」类改法：强度只在金数不超过阈值时全额计分。
    if (strengthWeightCap !== null) {
      wA = t.gold <= strengthWeightCap.lo ? weights.strength
        : (t.gold <= strengthWeightCap.hi ? weights.strength * strengthWeightCap.mid : 0);
    }
    t.score = wA * t.aPct + weights.cost * t.bPct;
  }
  return [...pool].sort((a, b) => b.score - a.score || b.aPct - a.aPct || a.gap - b.gap
    || String(a.key).localeCompare(String(b.key)));
};
const show = (title, ranked, n = 5) => {
  console.log(`\n--- ${title} ---`);
  ranked.slice(0, n).forEach((t, i) => {
    console.log(`  #${i + 1} 分 ${t.score.toFixed(1)}｜账面 ${t.gold} 金｜补金 ${t.gap} 金`
      + `｜① ${t.aPct.toFixed(1)}（总榜分 ${t.total.toFixed(1)}）`
      + `｜② ${t.bPct.toFixed(1)}｜${teamText(t.members)}`);
  });
};

// 与生产逐条对齐（同一把尺子：① 总榜分 + 差额）
const replica = scorePool({ axisB: 'gap' });
const prodRows = prod.rows.map((r) => r.key);
const repRows = replica.slice(0, prodRows.length).map((t) => t.key);
const same = prodRows.every((k, i) => k === repRows[i]);
console.log(`  前 ${prodRows.length} 名顺序与生产完全一致：${same ? '是 ✓' : '否 ✗'}`);
if (!same) {
  prodRows.forEach((k, i) => {
    if (k !== repRows[i]) console.log(`    #${i + 1} 生产 ${k}\n         复刻 ${repRows[i]}`);
  });
}

// ---- B. 更便宜、成绩相当或更好的候选池队伍 --------------------------------------
const plight = base.frontierAll.find((f) => f.env === 'aa/plight');
const seasonsDesc = [...(plight.seasons || [])].sort((a, b) => {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0); if (d) return -d;
  }
  return 0;
});
const rowsByRoster = new Map();
for (const r of plight.frontierRows || []) {
  const k = rosterKeyOf(r.members);
  if (!rowsByRoster.has(k)) rowsByRoster.set(k, []);
  rowsByRoster.get(k).push(r);
}
const HEAD_GOLD = prod.rows[0].gold;
const HEAD_AV = Number(prod.rows[0].bestEnv?.actionValue) || 286;
console.log(`\n=== B. 候选池里「账面金数 < ${HEAD_GOLD} 且绝境满分、行动值 ≤ ${HEAD_AV}」的队伍 ===`);
const cheaper = [];
for (const t of pool) {
  if (!(t.gold < HEAD_GOLD)) continue;
  const rows = rowsByRoster.get(t.key) || [];
  const perfect = rows.filter((r) => r.tier === 'perfect' && r.actionValue <= HEAD_AV + 1);
  if (!perfect.length) continue;
  // 最新版本优先，再比行动值
  const best = [...perfect].sort((a, b) => seasonsDesc.indexOf(a.season) - seasonsDesc.indexOf(b.season)
    || a.actionValue - b.actionValue)[0];
  cheaper.push({ ...t, evCost: best.cost, evAv: best.actionValue, evSeason: best.season, evTier: best.tier });
}
const rankedCheaper = scorePool({ axisB: 'gap' })
  .filter((t) => cheaper.some((c) => c.key === t.key));
rankedCheaper.forEach((t) => {
  const c = cheaper.find((x) => x.key === t.key);
  t.evCost = c.evCost; t.evAv = c.evAv; t.evSeason = c.evSeason;
});
console.log(`  共 ${cheaper.length} 支；按当前总分降序前 15：`);
console.log('  #  分     金数 补金  证据(金/行动值/版本)     ① 分    总榜分   队伍');
rankedCheaper.slice(0, 15).forEach((t, i) => {
  console.log(`  ${String(i + 1).padStart(2)} ${t.score.toFixed(1).padStart(5)} ${String(t.gold).padStart(5)}`
    + ` ${String(t.gap).padStart(4)}  ${String(t.evCost).padStart(2)}金/${String(t.evAv).padStart(3)}AV/${String(t.evSeason).padEnd(4)}`
    + ` ${t.aPct.toFixed(1).padStart(6)} ${t.total.toFixed(1).padStart(8)}`
    + `   ${teamText(t.members)}`);
});
const cheaperByGold = [...cheaper].sort((a, b) => a.evCost - b.evCost || a.evAv - b.evAv).slice(0, 10);
console.log('\n  同集合按「证据金数」升序前 10（最压金的一批）：');
cheaperByGold.forEach((t, i) => {
  console.log(`  ${String(i + 1).padStart(2)} 证据 ${String(t.evCost).padStart(2)}金/${String(t.evAv).padStart(3)}AV/${String(t.evSeason).padEnd(4)}`
    + `｜账面 ${t.gold}金 补金 ${t.gap}｜① ${t.aPct.toFixed(1)} 总榜分 ${t.total.toFixed(1)}｜${teamText(t.members)}`);
});

// ---- C. 候选改法 ---------------------------------------------------------------
console.log('\n\n=== C. 候选改法下的新前 5 名 ===');
show('C0 现状（① 总榜分 + ② 补金差额，50/50）', replica);

// 改法 A：① 换成「含金数项的总榜分」—— ⚠️ v4.6.91 起这**就是**现状（C0），
// 所以这一段与 C0 逐条相同，留着只为对照。
show('A ① 换成总榜分（含金数项）—— 已是现状，与 C0 相同', scorePool({ axisB: 'gap' }));

// 改法 B：② 的刻度轴从补金差额换成账面金数
show('B ② 换成账面金数接近度（1 − 金数/p75金数）', scorePool({ axisB: 'gold' }));

// 改法 C：② 同时看差额与账面金数（各半）
const rankC = (() => {
  const span = (v, lo, hi) => (hi - lo < 1e-9 ? 1 : (v - lo) / (hi - lo));
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  for (const t of pool) {
    t.aPct = 100 * clamp01(span(t.total, totalLo, totalHi));
    t.gapPct = 100 * clamp01(1 - span(t.gap, 0, gapCap)) ** (Number(SCORING.teamPlanGapPower) || 1);
    t.goldPct = 100 * clamp01(1 - span(t.gold, 0, goldCap));
    t.bPct = (t.gapPct + t.goldPct) / 2;
    t.score = 0.5 * t.aPct + 0.5 * t.bPct;
  }
  return [...pool].sort((a, b) => b.score - a.score);
})();
show('C ② = (差额接近度 + 账面金数接近度)/2', rankC);

// 改法 D：只取最近 3 个版本（窗口收窄到权重全为 2 的那三档）
const window3 = await run(await archiveFrontierAll(envs, { window: 3 }), normalizeDrawWeights({}));
console.log(`\n--- D 只取最近 3 个版本（window=3；poolAll ${window3.plan.poolAll} / 候选 ${window3.plan.pool}）---`);
window3.plan.rows.slice(0, 5).forEach((row, i) => {
  console.log(`  #${i + 1} 分 ${row.total.toFixed(1)}｜账面 ${row.gold} 金｜补金 ${row.gap} 金`
    + `｜① ${row.strengthPct.toFixed(1)}（总榜分 ${row.teamScore.toFixed(1)}）`
    + `｜证据 ${row.bestEnv?.label} ${row.bestEnv?.bestTeamGold}金/${row.bestEnv?.actionValue}AV/${row.bestEnv?.season}`
    + `｜${teamText(row.members)}`);
});
console.log('  window=3 的生产前 5（对照 window=7）：');
prod.rows.slice(0, 5).forEach((row, i) => {
  console.log(`  #${i + 1} 分 ${row.total.toFixed(1)}｜账面 ${row.gold} 金｜补金 ${row.gap} 金`
    + `｜证据 ${row.bestEnv?.bestTeamGold}金/${row.bestEnv?.actionValue}AV/${row.bestEnv?.season}`
    + `｜${teamText(row.members)}`);
});

// 改法 E：权重旋钮（不改算法，只把默认权重改成偏性价比）
for (const [s, c] of [[1, 2], [1, 3], [0, 1]]) {
  const p = teamPlan(base.conclusion, acct, { availability, drawWeights: { strength: s, cost: c } });
  console.log(`\n--- E 抽卡权重 强度${s}:性价比${c}（生产 teamPlan）---`);
  p.rows.slice(0, 5).forEach((row, i) => {
    console.log(`  #${i + 1} 分 ${row.total.toFixed(1)}｜账面 ${row.gold} 金｜补金 ${row.gap} 金`
      + `｜强度分 ${row.strengthPct.toFixed(1)}｜② ${row.gapPct.toFixed(1)}｜${teamText(row.members)}`);
  });
}

// 改法 F：**放宽候选池** —— 把「最近 3 版里绝境满分的四人配置」直接并入候选池。
//
// ⚠️ 这是**我的复刻口径**，生产里没有这条路径：新并入的队伍没有自己的总榜条目，
// 所以总榜分取「它四个成员各自整包中最好的那一条」（teamPoolUnits 里按
// 角色 × 档位收敛后的整包分），与 teamPlan 对池内队伍的做法同源但不等价。
{
  const packKeyOfMember = (m) => `${m.char}|E${eidolonTierOf(m.eidolon)}|${m.lc || '-'}|`
    + `S${Math.max(1, Math.round(Number(m.superimp) || 1))}`;
  const unitByPack = new Map();
  for (const unit of units) {
    const k = packKeyOfMember({ char: unit.name, eidolon: unit.eidolon, lc: unit.lc, superimp: unit.superimp });
    // ⚠️ ① 就是总榜分（`unit.total`），不再单独收敛一份纯强度（v4.6.91 已删除）。
    const t = Number(unit.total) || 0;
    const prev = unitByPack.get(k);
    if (prev && !(t > prev.total)) continue;
    unitByPack.set(k, { total: t });
  }
  const recent3 = seasonsDesc.slice(0, 3);
  const known = new Set(pool.map((t) => t.key));
  const added = [];
  for (const [key, rows] of rowsByRoster) {
    if (known.has(key)) continue;
    const inRecent = rows.filter((r) => recent3.includes(r.season) && r.tier === 'perfect'
      && r.actionValue < 300);
    if (!inRecent.length) continue;
    const members = inRecent[0].members;
    let total = null;
    for (const m of members) {
      const u = unitByPack.get(packKeyOfMember(m));
      if (!u) continue;
      if (total === null || u.total > total) total = u.total;
    }
    if (total === null) continue;
    const cost = marginalCostOf(members, availability, acct);
    if (!(cost.pulls > 0)) continue;
    added.push({
      key, members, total, gap: cost.pulls,
      gold: members.reduce((n, m) => n + datasetGoldOf(m), 0),
      added: true, best: inRecent[0],
    });
  }
  const poolF = [...pool, ...added];
  const sLo = Math.min(...poolF.map((t) => t.total));
  const sHi = Math.max(...poolF.map((t) => t.total));
  const gSorted = [...poolF.map((t) => t.gap)].sort((a, b) => a - b);
  const gCap = gSorted[Math.min(gSorted.length - 1, Math.floor(gSorted.length * 0.75))];
  const gdSorted = [...poolF.map((t) => t.gold)].sort((a, b) => a - b);
  const gdCap = gdSorted[Math.min(gdSorted.length - 1, Math.floor(gdSorted.length * 0.75))];
  const span = (v, lo, hi) => (hi - lo < 1e-9 ? 1 : (v - lo) / (hi - lo));
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  console.log(`\n--- F 放宽候选池：并入「最近 3 版绝境满分」的四人配置 ${added.length} 支`
    + `（池 ${pool.length} → ${poolF.length}）---`);
  const variants = [
    ['F1 池放宽 + 现状打分', (t) => 0.5 * (100 * clamp01(span(t.total, sLo, sHi)))
      + 0.5 * (100 * clamp01(1 - span(t.gap, 0, gCap)))],
    ['F2 池放宽 + ② 含账面金数', (t) => 0.5 * (100 * clamp01(span(t.total, sLo, sHi)))
      + 0.5 * (0.5 * (100 * clamp01(1 - span(t.gap, 0, gCap)))
        + 0.5 * (100 * clamp01(1 - span(t.gold, 0, gdCap))))],
    // ⚠️ F3 与 F1 现在是同一条（① 只有一个口径）；「① 用总榜分」这个画面 v4.6.91 起已经落地。
    ['F3 池放宽 + ① 用总榜分（与 F1 相同）',
      (t) => 0.5 * (100 * clamp01(span(t.total, Math.min(...poolF.map((x) => x.total)),
        Math.max(...poolF.map((x) => x.total)))))
        + 0.5 * (100 * clamp01(1 - span(t.gap, 0, gCap)))],
  ];
  for (const [title, fn] of variants) {
    const ranked = poolF.map((t) => ({ ...t, score: fn(t) }))
      .sort((a, b) => b.score - a.score);
    console.log(`\n  --- ${title} ---`);
    ranked.slice(0, 5).forEach((t, i) => {
      console.log(`    #${i + 1} 分 ${t.score.toFixed(1)}｜账面 ${t.gold} 金｜补金 ${t.gap} 金`
        + `｜① ${(100 * clamp01(span(t.total, sLo, sHi))).toFixed(1)}`
        + `（总榜分 ${t.total.toFixed(1)}）`
        + `${t.added ? '｜【新并入池】' : ''}｜${teamText(t.members)}`);
    });
    const idx = ranked.findIndex((t) => t.key === prod.rows[0].key);
    // ⚠️ 这里跟的是**生产首推那一支**，不是固定的某支队（v4.6.91 起首推是 11 金那支）。
    console.log(`    生产首推队伍（${prod.rows[0].gold} 金）名次 #${idx + 1}`);
  }
}

// 顺带：改法 A / B 下当前首推队伍的名次
for (const [title, ranked] of [['现状', replica],
  ['A 总榜分', scorePool({ axisB: 'gap' })],
  ['B 账面金数', scorePool({ axisB: 'gold' })],
  ['C 差额+金数', rankC]]) {
  const headKey = prod.rows[0].key;
  const idx = ranked.findIndex((t) => t.key === headKey);
  const alt = ranked.findIndex((t) => t.gold <= 12 && t.gap <= 6);
  console.log(`  [${title}] 生产首推队伍（${prod.rows[0].gold} 金）名次 #${idx + 1}；`
    + `首个「账面 ≤12 金且补金 ≤6」的候选名次 #${alt + 1}`);
}
