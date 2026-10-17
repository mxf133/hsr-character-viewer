/**
 * 调查「E6 的强度为什么这么低」。
 *
 * 强度不是一个数，它是**乘法**叠出来的四层：
 *
 *   ① 该关该版本强度 envStrength_s =
 *        av == 0 ? 100 × 该期最省金 ÷ 本队金数                    ← 顶格档（按金数折）
 *                : min(90, 100 × 该期最省金 ÷ 该期最贵金) × 曲线    ← 第二档
 *   ② 该副本强度 = Σ(版本权重 × envStrength_s) / Σ(该副本**已登场**版本的权重)
 *                                            ↑ 分母含「已登场却没证据」的版本（记 0 分）
 *   ③ 整包强度 = Σ(副本权重 × 该副本强度) / Σ(**全部 5 个**副本的权重 = 9)
 *                                            ↑ 缺副本按 0，分母不减
 *   ④ 得分 = 单调包络 + 90 天花板
 *
 * 本探针把每一层都复刻出来，先自检「复刻的整包强度 == 真实输出」，再逐层做反事实。
 *
 * 用法：node tools/_probe-e6-strength.mjs
 */
import {
  buildConclusion, coneCostOf, eidolonTierOf, envWeightOf, frontierCostTermOf,
  hiddenReductionOf, packGoldOf, perfFactorOf, perfLineWeightsOf, videoUrlOf,
  SCORING, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const index = await archiveIndex();
const i18n = await loadI18n();
const cn = (n) => zhName(i18n, 'characters', n) || n;
const availability = index.refs?.availability || {};

const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const fa = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const frontierById = new Map(fa.map((f) => [f.env, f]));

const real = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  frontier: Object.fromEntries(fa.map((f) => [f.env, f])),
});

// ---- 与 advice.js 同口径的几条小工具 ----------------------------------------
const finiteOrNull = (v) => (v === null || v === undefined || v === ''
  || !Number.isFinite(Number(v)) ? null : Number(v));
const MODE_ALIASES = {
  moc: 'Memory of Chaos', pf: 'Pure Fiction', as: 'Apocalyptic Shadow', aa: 'Anomaly Arbitration',
};
const cmpVersion = (a, b) => {
  const pa = String(a ?? '').split('.').map((n) => Number(n) || 0);
  const pb = String(b ?? '').split('.').map((n) => Number(n) || 0);
  return (pa[0] || 0) - (pb[0] || 0) || (pa[1] || 0) - (pb[1] || 0);
};
const firstSeenRoot = index.refs?.firstSeen || {};
const packKeyOf = (m) => `${m.char}|E${eidolonTierOf(m.eidolon)}|`
  + `${m.lc || '-'}|S${Math.max(1, Math.round(Number(m.superimp) || 1))}`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const fmt = (v, n = 1) => (Number.isFinite(v) ? v.toFixed(n) : '—');
const quantile = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
};
const tierOfKey = (key) => Number(String(String(key).split('|')[1]).slice(1));
const bandOfKey = (key) => (tierOfKey(key) === 6 ? 'E6' : `E${tierOfKey(key)}`);

// ---- 复刻 frontierPackRowsOf（隐金后 cost + 原始 storedCost）------------------
const normalizeRows = (source) => (source || [])
  .map((row) => {
    const members = (row.members || []).map((m) => ({
      char: m.char,
      eidolon: eidolonTierOf(m.eidolon),
      lc: m.lc || null,
      superimp: Math.max(1, Math.round(Number(m.superimp) || 1)),
    })).filter((m) => m.char);
    const stored = Math.max(0, Math.round(Number(row.cost) || 0));
    const cut = hiddenReductionOf(members, availability, undefined, 'dataset').team;
    return {
      cost: stored > 0 ? Math.max(0, stored - cut) : 0,
      storedCost: stored,
      tier: row.tier === 'target' ? 'target' : 'perfect',
      actionValue: finiteOrNull(row.actionValue),
      season: String(row.newestSeason || row.season || ''),
      members,
      video: videoUrlOf(row.video),
    };
  })
  .filter((r) => r.storedCost > 0 && r.members.length);

// ---- 逐副本 × 逐版本 × 逐整包复刻 -------------------------------------------
const perEnvPack = new Map();
const envWeights = new Map();

for (const env of envs) {
  const f = frontierById.get(env.id);
  const source = f?.frontierRows?.length ? f.frontierRows : env.frontierRows;
  const rows = normalizeRows(source);
  if (!rows.length) continue;
  const weight = Number(envWeightOf(env.mode, env.stage)) || 0;
  envWeights.set(env.id, weight);
  const tierLines = env.tierLines || null;
  const lowerIsBetter = env.lowerIsBetter !== false;
  const perfWeights = perfLineWeightsOf({ mode: env.mode, stage: env.stage });
  const zeroAv = env.zeroAvGoldBySeason || {};
  const fEntry = f || {};
  const seasonOrder = [...(fEntry.seasons || Object.keys(zeroAv))].reverse();
  const observedSeasons = [...new Set(rows.map((r) => r.season).filter(Boolean))];
  const windowSeasons = seasonOrder.length
    ? [...seasonOrder, ...observedSeasons.filter((s) => !seasonOrder.includes(s))]
    : observedSeasons;
  const seasonWeights = fEntry.seasonWeights || {};

  // 金数分母：该版本 perfect 档最便宜（缺 perfect 档时退回全档最便宜）
  const minAll = new Map();
  const minPerfect = new Map();
  for (const r of rows) {
    const billable = Math.max(1, r.cost);
    if (!minAll.has(r.season) || billable < minAll.get(r.season)) minAll.set(r.season, billable);
    if (r.tier === 'perfect'
      && (!minPerfect.has(r.season) || billable < minPerfect.get(r.season))) {
      minPerfect.set(r.season, billable);
    }
  }
  const denomOf = (s) => minPerfect.get(s) ?? minAll.get(s) ?? 1;

  // 第一趟：逐行算分，按「整包 × 版本」留 score 最大（平局取限定光锥更多的）
  const bySeason = new Map();
  for (const r of rows) {
    const perf = perfFactorOf(r.actionValue, tierLines, lowerIsBetter, r.tier, perfWeights);
    if (!(perf > 0)) continue;
    const costFactor = frontierCostTermOf(denomOf(r.season), r.cost);
    const score = SCORING.frontierPackScale * perf * (costFactor ?? 1);
    const strengthPerf = perfFactorOf(r.actionValue, tierLines, lowerIsBetter, r.tier,
      SCORING.strengthLineWeights);
    const limitedCones = r.members.filter((m) => m.lc && coneCostOf(m.lc, availability) > 0).length;
    for (const m of r.members) {
      if (packGoldOf(m, availability) <= 0) continue;
      const key = packKeyOf(m);
      if (!bySeason.has(key)) bySeason.set(key, new Map());
      const per = bySeason.get(key);
      const cur = per.get(r.season);
      if (!cur || score > cur.score
        || (score === cur.score && limitedCones > cur.limitedCones)) {
        per.set(r.season, {
          score, av: r.actionValue, storedCost: r.storedCost, strengthPerf, season: r.season,
          limitedCones,
        });
      }
    }
  }

  // 第二趟：逐版本两档 + 权重覆盖
  const seenFor = firstSeenRoot.byMode?.[MODE_ALIASES[String(env.mode || '')]] || firstSeenRoot;
  for (const [key, per] of bySeason) {
    const parts = String(key).split('|');
    const charBorn = seenFor.characters?.[parts[0]] || null;
    const coneBorn = (parts[2] && parts[2] !== '-') ? (seenFor.lightCones?.[parts[2]] || null) : null;
    const known = [charBorn, coneBorn].filter(Boolean);
    const born = known.length
      ? known.reduce((a, b) => (cmpVersion(a, b) >= 0 ? a : b))
      : (per.size ? [...per.keys()].reduce((a, b) => (cmpVersion(a, b) < 0 ? a : b)) : null);

    const list = [];
    let wSum = 0;
    let acc = 0;
    let obsWeight = 0;
    let idealWeight = 0;
    let absentWeight = 0;
    let absent = 0;
    let dropped = 0;

    for (const s of windowSeasons) {
      const wRaw = seasonWeights[s];
      const w = Number.isFinite(Number(wRaw)) ? Number(wRaw) : 1;
      if (!(w > 0)) continue;
      idealWeight += w;
      const hit = per.get(s);
      if (!hit) {
        // 早于登场 → 不进分子也不进分母（无从判断）
        if (born !== null && cmpVersion(s, born) < 0) {
          absent += 1;
          absentWeight += w;
          continue;
        }
        // 已登场却没证据 → 算 0 分（权重进分母、分子不加）
        dropped += 1;
        wSum += w;
        continue;
      }
      wSum += w;
      obsWeight += w;
      const gold = Math.max(1, Number(hit.storedCost) || 0);
      const z = zeroAv[s] || null;
      const av = hit.av;
      const isTop = av === 0;
      let envStrength;
      let cap = null;
      if (isTop) {
        envStrength = z ? (100 * z.min) / gold : 100;
      } else {
        const zeroFloor = z ? (100 * z.min) / Math.max(1, z.max) : 0;
        cap = zeroFloor > 0
          ? Math.min(SCORING.strengthSecondBandCap, zeroFloor)
          : SCORING.strengthSecondBandCap;
        envStrength = cap * (Number(hit.strengthPerf) || 0);
      }
      acc += w * envStrength;
      list.push({
        season: s, w, av, gold, envStrength, isTop, cap,
        curve: Number(hit.strengthPerf) || 0,
        zeroMin: z ? z.min : null, zeroMax: z ? z.max : null,
      });
    }

    perEnvPack.set(`${env.id}|${key}`, {
      list,
      envStrength: wSum > 0 ? acc / wSum : 0,
      obsWeight,
      wSum,
      idealWeight,
      absentWeight,
      absent,
      dropped,
      cover: (idealWeight - absentWeight) > 0 ? obsWeight / (idealWeight - absentWeight) : 1,
    });
  }
}

const totalEnvWeight = [...envWeights.values()].reduce((a, b) => a + b, 0);

// ---- 自检：复刻的整包强度必须与真实输出一致 --------------------------------
const realUnits = new Map();
for (const list of Object.values(real.frontierTiers || {})) {
  for (const u of list) {
    realUnits.set(`${u.name}|E${eidolonTierOf(u.eidolon)}|${u.lc || '-'}`
      + `|S${Math.max(1, Math.round(Number(u.superimp) || 1))}`, u);
  }
}
// 只统计**榜上**的整包 —— 用户看到的就是这一批。全池（2300+ 个）里绝大多数只出现过
// 一两次，把它们算进均值会失真。
const packsAll = new Set(realUnits.keys());

const strengthOf = (key) => {
  let acc = 0;
  for (const [envId, w] of envWeights) {
    const e = perEnvPack.get(`${envId}|${key}`);
    if (e) acc += w * e.envStrength;
  }
  return totalEnvWeight > 0 ? acc / totalEnvWeight : 0;
};

let checked = 0;
let maxDiff = 0;
const diffs = [];
for (const key of packsAll) {
  const u = realUnits.get(key);
  const mine = strengthOf(key);
  const theirs = Number(u.strengthTotal) || 0;
  const d = Math.abs(mine - theirs);
  diffs.push({ key, mine, theirs, d });
  maxDiff = Math.max(maxDiff, d);
  checked += 1;
}
diffs.sort((a, b) => b.d - a.d);
for (const x of diffs.slice(0, 5)) {
  if (x.d < 0.01) break;
  console.log(`  偏差 ${x.d.toFixed(4)}  ${x.key}  复刻=${x.mine.toFixed(3)} 真实=${x.theirs.toFixed(3)}`);
}
console.log(`复刻自检：比对 ${checked} 个整包，强度原始量最大偏差 ${maxDiff.toFixed(4)}`
  + `${maxDiff < 0.01 ? '  ✓ 一致' : '  ✗ 不一致，后面的结论不可信'}`);
console.log(`副本 ${envs.length} 个｜强度分母（全部副本权重和）= ${totalEnvWeight}`
  + `｜逐版本证据 ${[...perEnvPack.values()].reduce((n, x) => n + x.list.length, 0)} 条`);

/** 反事实：一次只放开一层，看强度能涨回多少 */
const counterfactual = (key, opts = {}) => {
  let coveredWeight = 0;
  let coveredSum = 0;
  for (const [envId, w] of envWeights) {
    const e = perEnvPack.get(`${envId}|${key}`);
    if (!e) continue;
    let n = 0;
    let d = 0;
    for (const r of e.list) {
      n += r.w * ((opts.noTopPenalty && r.isTop) ? 100 : r.envStrength);
      d += r.w;
    }
    // 现状 = 有证据版本的平均 × 覆盖（cover = obsWeight / wSum）
    // B   = 直接把覆盖当成 1（「已登场却没证据」的版本不计入分母）
    const value = d > 0
      ? (n / d) * (opts.fullVersion || !(e.wSum > 0) ? 1 : e.obsWeight / e.wSum)
      : 0;
    coveredWeight += w;
    coveredSum += w * value;
  }
  if (!(totalEnvWeight > 0)) return 0;
  let value = coveredSum / totalEnvWeight;
  if (opts.fullDungeon) {
    // 缺的副本按「已覆盖副本的强度均值」补齐（不假设它比已覆盖的更强）
    const meanCovered = coveredWeight > 0 ? coveredSum / coveredWeight : 0;
    value += ((totalEnvWeight - coveredWeight) * meanCovered) / totalEnvWeight;
  }
  return value;
};

// ---- 一、四层各自的量级（按星魂档）------------------------------------------
console.log('\n=== 一、四层各自的量级（榜上整包，按星魂档）===');
console.log('档位 | 整包 | ③整包强度 | ②副本强度均值 | ②版本覆盖 | ①顶格占比 | ①顶格强度中位 | ①顶格金数比');
for (const band of ['E0', 'E1', 'E2', 'E6']) {
  const keys = [...packsAll].filter((k) => bandOfKey(k) === band);
  if (!keys.length) continue;
  const totals = keys.map((k) => Number(realUnits.get(k).strengthTotal) || 0);
  const envStrengthAll = [];
  const coverAll = [];
  let topN = 0;
  let allN = 0;
  const topS = [];
  const topRatio = [];
  for (const key of keys) {
    for (const [envId] of envWeights) {
      const e = perEnvPack.get(`${envId}|${key}`);
      if (!e) continue;
      envStrengthAll.push(e.envStrength);
      coverAll.push(e.cover);
      for (const r of e.list) {
        allN += 1;
        if (!r.isTop) continue;
        topN += 1;
        topS.push(r.envStrength);
        if (r.zeroMin) topRatio.push(r.gold / Math.max(1, r.zeroMin));
      }
    }
  }
  console.log(`${band.padEnd(4)} | ${String(keys.length).padStart(4)} | ${fmt(mean(totals), 2).padStart(10)}`
    + ` | ${fmt(mean(envStrengthAll), 2).padStart(13)}`
    + ` | ${(mean(coverAll) * 100).toFixed(0).padStart(9)}%`
    + ` | ${(topN / Math.max(1, allN) * 100).toFixed(0).padStart(8)}%`
    + ` | ${fmt(quantile(topS, 0.5), 1).padStart(13)} | ${fmt(mean(topRatio), 2).padStart(10)}×`);
}

// ---- 二、版本权重覆盖 ------------------------------------------------------
console.log('\n=== 二、② 版本权重覆盖（分母含「已登场却没证据」的版本）===');
for (const band of ['E0', 'E1', 'E2', 'E6']) {
  const keys = [...packsAll].filter((k) => bandOfKey(k) === band);
  if (!keys.length) continue;
  const covers = [];
  const envCount = [];
  const droppedSeasons = [];
  for (const key of keys) {
    let n = 0;
    for (const [envId] of envWeights) {
      const e = perEnvPack.get(`${envId}|${key}`);
      if (!e) continue;
      covers.push(e.cover);
      droppedSeasons.push(e.dropped);
      n += 1;
    }
    envCount.push(n);
  }
  console.log(`  ${band}：版本覆盖 中位 ${(quantile(covers, 0.5) * 100).toFixed(0)}%`
    + `｜p25 ${(quantile(covers, 0.25) * 100).toFixed(0)}% p75 ${(quantile(covers, 0.75) * 100).toFixed(0)}%`
    + `｜有数据的副本数均值 ${fmt(mean(envCount), 2)} / ${envWeights.size}`
    + `｜每个副本「已登场却无证据」版本数均值 ${fmt(mean(droppedSeasons), 2)}`);
}

// ---- 三、顶格档的金数折价 --------------------------------------------------
console.log('\n=== 三、① 顶格档 envStrength = 100 × 该期最省金 ÷ 本队金数 ===');
const topRows = [];
for (const [k, e] of perEnvPack) {
  const band = bandOfKey(k.split('|').slice(1).join('|'));
  for (const r of e.list) if (r.isTop && r.zeroMin) topRows.push({ band, ...r });
}
for (const band of ['E0', 'E1', 'E2', 'E6']) {
  const list = topRows.filter((r) => r.band === band);
  if (!list.length) continue;
  const s = list.map((r) => r.envStrength);
  console.log(`  ${band}：n=${String(list.length).padStart(4)}`
    + `｜envStrength 中位 ${fmt(quantile(s, 0.5), 1)}`
    + `｜≥60 分占 ${(s.filter((x) => x >= 60).length / s.length * 100).toFixed(0)}%`
    + `｜本队金数中位 ${fmt(quantile(list.map((r) => r.gold), 0.5), 0)}`
    + `｜本队÷该期最省 中位 ${fmt(quantile(list.map((r) => r.gold / Math.max(1, r.zeroMin)), 0.5), 2)}×`);
}

// ---- 四、反事实：每一层各扣多少 --------------------------------------------
console.log('\n=== 四、反事实：放开某一层，榜上强度均值能涨到多少 ===');
console.log('档位 | 现在 | A 顶格不折金 | B 版本覆盖满 | C 副本覆盖满 | A+B | A+B+C');
for (const band of ['E0', 'E1', 'E2', 'E6']) {
  const keys = [...packsAll].filter((k) => bandOfKey(k) === band);
  if (!keys.length) continue;
  const cur = keys.map((k) => Number(realUnits.get(k).strengthTotal) || 0);
  const a = keys.map((k) => counterfactual(k, { noTopPenalty: true }));
  const b = keys.map((k) => counterfactual(k, { fullVersion: true }));
  const c = keys.map((k) => counterfactual(k, { fullDungeon: true }));
  const ab = keys.map((k) => counterfactual(k, { noTopPenalty: true, fullVersion: true }));
  const abc = keys.map((k) => counterfactual(k, {
    noTopPenalty: true, fullVersion: true, fullDungeon: true,
  }));
  console.log(`${band.padEnd(4)} | ${fmt(mean(cur), 1).padStart(4)} | ${fmt(mean(a), 1).padStart(12)}`
    + ` | ${fmt(mean(b), 1).padStart(12)} | ${fmt(mean(c), 1).padStart(12)}`
    + ` | ${fmt(mean(ab), 1).padStart(4)} | ${fmt(mean(abc), 1).padStart(7)}`);
}

// ---- 五、逐副本 × 星魂档：E6 覆盖的是哪几关 --------------------------------
//
// ③ 的分母固定是 9，所以「覆盖哪几关」比「覆盖几关」更重要：
// aa/plight 一关就是 5 分权重，等于其余四关之和。
console.log('\n=== 五、逐副本 × 星魂档（副本权重 · 有数据整包数 · 该关强度均值）===');
const envIds = [...envWeights.keys()].sort((a, b) => envWeights.get(b) - envWeights.get(a));
console.log(`副本${' '.repeat(12)}权重 | ${['E0', 'E1', 'E2', 'E6'].map((b) => `${b} 覆盖/强度`).join(' | ')}`);
for (const envId of envIds) {
  const cells = [];
  for (const band of ['E0', 'E1', 'E2', 'E6']) {
    const keys = [...packsAll].filter((k) => bandOfKey(k) === band);
    const vals = [];
    for (const key of keys) {
      const e = perEnvPack.get(`${envId}|${key}`);
      if (e) vals.push(e.envStrength);
    }
    cells.push(`${String(vals.length).padStart(3)} / ${fmt(mean(vals), 1).padStart(5)}`);
  }
  console.log(`${envId.padEnd(20)}${String(envWeights.get(envId)).padStart(2)} | ${cells.join(' | ')}`);
}

// ---- 六、E6 强度最低的 6 个整包：逐层摊开 ----------------------------------
console.log('\n=== 五、E6 里强度最低的 6 个整包（逐副本 / 逐层）===');
const e6Ranked = [...packsAll].filter((k) => bandOfKey(k) === 'E6')
  .map((key) => ({ key, u: realUnits.get(key), strength: strengthOf(key) }))
  .sort((x, y) => (Number(x.u.strengthScore) || 0) - (Number(y.u.strengthScore) || 0))
  .slice(0, 6);

for (const { key, u, strength } of e6Ranked) {
  const [char, , lc, sup] = key.split('|');
  console.log(`  ${cn(char)} E6 ${lc === '-' ? '无锥' : cn(lc)} ${sup}｜整包金数 ${u.gold}`
    + `｜强度得分 ${fmt(Number(u.strengthScore) || 0, 2)}（原始量 ${fmt(strength, 2)}）`);
  const parts = [];
  for (const [envId, w] of envWeights) {
    const e = perEnvPack.get(`${envId}|${key}`);
    if (e) parts.push({ envId, w, ...e });
  }
  parts.sort((x, y) => y.w - x.w);
  for (const p of parts) {
    const top = p.list.filter((r) => r.isTop).length;
    console.log(`     ${p.envId.padEnd(10)} w=${p.w} 副本强度=${fmt(p.envStrength, 2)}`
      + `（版本覆盖 ${(p.cover * 100).toFixed(0)}%，${p.list.length} 条证据：`
      + `顶格 ${top} / 第二档 ${p.list.length - top}）`);
    for (const r of [...p.list].sort((a, b) => b.envStrength - a.envStrength).slice(0, 2)) {
      console.log(`        ${r.season} w=${r.w} 行动值=${r.av} 金=${r.gold}`
        + ` → ${fmt(r.envStrength, 2)}${r.isTop
          ? `（顶格：该期最省 ${r.zeroMin} 金）`
          : `（封顶 ${fmt(r.cap, 1)} × 曲线 ${fmt(r.curve, 3)}）`}`);
    }
  }
}
