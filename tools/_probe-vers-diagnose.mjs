// 探针：诊断角色泛用性（③）在真实数据上的分布与「原始量为 0」的成因。
//
// 背景：_probe-vers-shape.mjs 显示组内相对分 p25=0、中位个位数，
// 怀疑是尺子（min-max）被离群值撑坏的**形状问题**，也可能是原始量本身
// 大面积等于 0 的**数据问题**。这个探针把两者分开量。
//
//   node tools/_probe-vers-diagnose.mjs
import {
  buildConclusion, eidolonTierOf, teamPoolUnits, VERSION_WINDOW,
  isVersatilityIgnored,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

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

const q = (arr, p) => {
  const v = arr.slice().sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
};
const stat = (arr) => {
  if (!arr.length) return '（无）';
  return `n=${arr.length} min=${Math.min(...arr).toFixed(3)} p10=${q(arr, 0.1).toFixed(3)} p25=${q(arr, 0.25).toFixed(3)} 中位=${q(arr, 0.5).toFixed(3)} p75=${q(arr, 0.75).toFixed(3)} p90=${q(arr, 0.9).toFixed(3)} max=${Math.max(...arr).toFixed(3)} 均值=${(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3)}`;
};

// ---- 0. 原始素材：每个「角色|E档」一行（与榜上单位同源） --------------------------
const byCharTier = new Map();
for (const u of units) {
  const tier = eidolonTierOf(u.eidolon);
  const k = `${u.name}|${tier}`;
  const cur = byCharTier.get(k) || { name: u.name, tier, raws: [], scores: [], envs: [] };
  cur.raws.push(Number(u.versatilityRaw) || 0);
  cur.scores.push(Number(u.versatilityScore) || 0);
  cur.envs = u.envs || [];
  byCharTier.set(k, cur);
}

const groupOf = (tier) => (tier === 6 ? 'e6' : 'low');
const rows = [...byCharTier.values()].map((r) => ({
  ...r,
  raw: r.raws[0],
  group: groupOf(r.tier),
  ignored: isVersatilityIgnored(r.name, availability),
}));

console.log('== 1. 原始量分布（按「角色|E档」去重） ==');
for (const g of ['low', 'e6']) {
  const list = rows.filter((r) => r.group === g && !r.ignored).map((r) => r.raw);
  console.log(`  ${g === 'low' ? '低档组(E0/1/2)' : 'E6 组       '}  ${stat(list)}`);
}
console.log(`  不入尺子样本（不用抽就有）: ${rows.filter((r) => r.ignored).length} 行`);

console.log('\n== 2. 原始量 = 0 的行，按成因分组 ==');
const zeros = rows.filter((r) => r.raw === 0);
const zeroIgnored = zeros.filter((r) => r.ignored);
const zeroLimited = zeros.filter((r) => !r.ignored);
console.log(`  共 ${zeros.length} 行（占比 ${(100 * zeros.length / rows.length).toFixed(1)}%）`);
console.log(`    ① 不用抽就有（设计如此）：${zeroIgnored.length} 行`);
console.log(`    ② 限定角色却 0（可疑）  ：${zeroLimited.length} 行`);
for (const g of ['low', 'e6']) {
  const l = zeroLimited.filter((r) => r.group === g);
  console.log(`       ${g}: ${l.length} 行 —— ${l.slice(0, 14).map((r) => `${cn(r.name)}E${r.tier}`).join(' / ')}`);
}

console.log('\n== 3. 限定角色的逐副本贡献（原始量为 0 的，看是「缺副本」还是真没队友） ==');
const envContrib = (r) => {
  const per = (r.envs || []).map((e) => ({
    env: e.id ?? e.env ?? e.name ?? '?',
    w: Number(e.weight) || 0,
    v: Number(e.envVersatility) || 0,
    score: Number(e.score) || 0,
  }));
  return per;
};
for (const r of zeroLimited.slice(0, 10)) {
  const per = envContrib(r);
  console.log(`  ${cn(r.name)}E${r.tier}: ${per.map((p) => `${p.env}(w=${p.w},v=${p.v.toFixed(2)})`).join(' ')}`);
}

console.log('\n== 4. 非 0 角色的逐副本构成（看是否被「缺副本按 0」拉低） ==');
for (const r of rows.filter((x) => !x.ignored && x.raw > 0).slice(0, 8)) {
  const per = envContrib(r);
  console.log(`  ${cn(r.name)}E${r.tier} raw=${r.raw}: ${per.map((p) => `${p.env}(w=${p.w},v=${p.v.toFixed(2)})`).join(' ')}`);
}

console.log('\n== 5. 星魂档覆盖：一个角色有几档有整包 ==');
const tiersByChar = new Map();
for (const r of rows) {
  const s = tiersByChar.get(r.name) || new Set();
  s.add(r.tier);
  tiersByChar.set(r.name, s);
}
const coverHist = new Map();
for (const [name, s] of tiersByChar) {
  const key = [...s].sort().join(',');
  coverHist.set(key, (coverHist.get(key) || 0) + 1);
}
for (const [k, v] of [...coverHist.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  档位=${k || '（空）'} → ${v} 个角色`);
}

console.log('\n== 6. 归一后得分分布（现状尺子） ==');
for (const g of ['low', 'e6']) {
  const list = rows.filter((r) => r.group === g).map((r) => r.scores[0]);
  console.log(`  ${g === 'low' ? '低档组' : 'E6 组 '}  ${stat(list)}`);
  const bins = new Array(10).fill(0);
  for (const v of list) bins[Math.min(9, Math.max(0, Math.floor(v / 10)))] += 1;
  console.log(`         分桶 0-10:${bins[0]} 10-20:${bins[1]} 20-30:${bins[2]} 30-40:${bins[3]} 40-50:${bins[4]} 50-60:${bins[5]} 60-70:${bins[6]} 70-80:${bins[7]} 80-90:${bins[8]} 90-100:${bins[9]}`);
}

console.log('\n== 7. 尺子（组内 lo/hi） ==');
const ext = conclusion.frontierExtents?.versatility;
console.log(`  low: lo=${ext?.lo} hi=${ext?.hi}`);
for (const [k, v] of Object.entries(ext?.byTier || {})) console.log(`  byTier[${k}]: lo=${v.lo} hi=${v.hi}`);

console.log('\n== 9. 四种尺子的得分分布对比（样本 = 两组各自全部行，含 ignored 角色以还原真实榜面） ==');
const pct = (arr, p) => {
  const v = arr.slice().sort((a, b) => a - b);
  if (!v.length) return 0;
  return v[Math.min(v.length - 1, Math.max(0, Math.floor(p * (v.length - 1))))];
};
/** 现状尺子：组内全量 min-max（ignored 角色不参与取极值，但仍按公式算分并被夹到 0）。 */
const scoreMinMax = (raw, lo, hi) => (hi - lo < 1e-9
  ? 100 : Math.max(0, Math.min(1, (raw - lo) / (hi - lo))) * 100);
/** 分位尺子：lo=p5、hi=p95，超出夹到两端。 */
const scoreQuantile = (raw, p5, p95) => (p95 - p5 < 1e-9
  ? 100 : Math.max(0, Math.min(1, (raw - p5) / (p95 - p5))) * 100);
/** 对数尺子：log1p 之后在全量区间上线性摊。计数型右偏数据的常用变换。 */
const scoreLog = (raw, lo, hi) => {
  const a = Math.log1p(lo);
  const b = Math.log1p(hi);
  return b - a < 1e-9 ? 100 : Math.max(0, Math.min(1, (Math.log1p(raw) - a) / (b - a))) * 100;
};
/** 秩次尺子：组内按原始量排名，直接换算成百分位（0~100）。 */
const scoreRank = (raw, sorted) => {
  if (sorted.length < 2) return 100;
  let pos = 0;
  for (let i = 0; i < sorted.length; i += 1) if (sorted[i] <= raw) pos = i;
  return 100 * pos / (sorted.length - 1);
};
for (const g of ['low', 'e6']) {
  const all = rows.filter((r) => r.group === g);
  const sample = all.filter((r) => !r.ignored).map((r) => r.raw).sort((a, b) => a - b);
  const lo = sample[0] ?? 0;
  const hi = sample[sample.length - 1] ?? 0;
  const p5 = pct(sample, 0.05);
  const p95 = pct(sample, 0.95);
  const buckets = (list) => {
    const bins = new Array(10).fill(0);
    for (const v of list) bins[Math.min(9, Math.max(0, Math.floor(v / 10)))] += 1;
    return bins.map((n) => String(n).padStart(3)).join('');
  };
  console.log(`\n  [${g === 'low' ? '低档组 E0/E1/E2' : 'E6 组'}] 尺子样本 n=${sample.length} lo=${lo.toFixed(3)} p5=${p5.toFixed(3)} p95=${p95.toFixed(3)} max=${hi.toFixed(3)}`);
  const variants = [
    ['现状 min-max', (r) => scoreMinMax(r, lo, hi)],
    ['分位 p5~p95', (r) => scoreQuantile(r, p5, p95)],
    ['对数 log1p ', (r) => scoreLog(r, lo, hi)],
    ['秩次百分位  ', (r) => scoreRank(r, sample)],
  ];
  for (const [label, fn] of variants) {
    const vals = all.map((r) => fn(r.raw));
    console.log(`    ${label}  均值=${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)} 中位=${q(vals, 0.5).toFixed(1)} p75=${q(vals, 0.75).toFixed(1)} p90=${q(vals, 0.9).toFixed(1)} max=${Math.max(...vals).toFixed(1)}  |0-10%桶 ${(100 * buckets(vals).slice(0, 2)).toFixed(0)}%|`);
    console.log(`                 分桶(每 10 分) ${buckets(vals)}`);
  }
}

console.log('\n== 10. 低档组「三档平均」的失真：raw 与「只取 E0」差多少 ==');
// `frontierTiers` 是四个星魂档视图（每角色每档一条最佳配装）。用它取每档的
// `versatilityPerTier`（逐配装的本档值），就能还原「三档平均」这一步到底摊掉了多少。
const tiers = conclusion.frontierTiers || {};
const perTierOfChar = new Map();   // 角色 → Map(档 → {sum,n})
for (const [view, list] of Object.entries(tiers)) {
  for (const u of list || []) {
    const tier = eidolonTierOf(u.eidolon);
    let m = perTierOfChar.get(u.name);
    if (!m) { m = new Map(); perTierOfChar.set(u.name, m); }
    const e = m.get(tier) || { sum: 0, n: 0 };
    e.sum += Number(u.versatilityPerTier) || 0;
    e.n += 1;
    m.set(tier, e);
  }
}
const tierMean = (m, t) => (m?.get(t) ? m.get(t).sum / m.get(t).n : null);
const ratioList = [];
let onlyLow = 0;
let threeTiers = 0;
for (const [name, m] of perTierOfChar) {
  const e0 = tierMean(m, 0);
  const e1 = tierMean(m, 1);
  const e2 = tierMean(m, 2);
  const have = [0, 1, 2].filter((t) => tierMean(m, t) !== null);
  if (have.length === 3) threeTiers += 1;
  if (have.length === 1 && have[0] === 0) onlyLow += 1;
  const raw = rows.find((r) => r.name === name && r.group === 'low')?.raw;
  if (!(raw > 0) || !(e0 > 0)) continue;
  ratioList.push({ name, raw, e0, ratio: raw / e0, have: have.length });
}
ratioList.sort((a, b) => a.ratio - b.ratio);
console.log(`  三档齐全的角色 ${threeTiers} 个；只有 E0 一档的 ${onlyLow} 个`);
console.log(`  raw ÷ E0本档值 的分布：${stat(ratioList.map((x) => x.ratio))}`);
console.log('  最被摊薄（raw 只有 E0 的三分之一以下）的前 10 个：');
for (const x of ratioList.slice(0, 10)) {
  console.log(`    ${cn(x.name)} raw=${x.raw.toFixed(3)} E0本档=${x.e0.toFixed(3)} 比=${x.ratio.toFixed(2)} 有数据的低档数=${x.have}`);
}
console.log('  比最高的 6 个（这些角色的 E0 值本来就接近最终 raw）：');
for (const x of ratioList.slice(-6)) {
  console.log(`    ${cn(x.name)} raw=${x.raw.toFixed(3)} E0本档=${x.e0.toFixed(3)} 比=${x.ratio.toFixed(2)} 有数据的低档数=${x.have}`);
}


for (const g of ['low', 'e6']) {
  const list = rows.filter((r) => r.group === g && !r.ignored).map((r) => r.raw).sort((a, b) => a - b);
  const hi = list[list.length - 1] || 0;
  const t = list.slice(0, Math.max(1, Math.ceil(list.length * 0.95)));
  const hiT = t[t.length - 1];
  const norm = (v, h) => (h > 1e-9 ? 100 * v / h : 100);
  console.log(`  ${g}: 全量尺子 中位=${norm(q(list, 0.5), hi).toFixed(1)} 分；去掉 top5% 后 中位=${norm(q(list, 0.5), hiT).toFixed(1)} 分`);
}

console.log('\n== 11. 「缺副本按 0」的影响：有数据的副本数 vs 原始量 ==');
// `versatilityPerTier` 的分母是**全部副本**的权重和，缺的副本按 0 计。
// 若投稿只覆盖 2 个副本，它天然只能拿到 2/9 的分数上限 —— 这是「证据缺失」还是
// 「确实不百搭」？用数据分开看：按 env 覆盖数分组比较原始量。
const byEnvCount = new Map();
for (const r of rows) {
  if (r.ignored) continue;
  const n = (r.envs || []).length;
  const list = byEnvCount.get(n) || [];
  list.push(r.raw);
  byEnvCount.set(n, list);
}
for (const [n, list] of [...byEnvCount.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  有数据副本数=${n} → ${list.length} 行，raw 中位=${q(list, 0.5).toFixed(3)} 均值=${(list.reduce((a, b) => a + b, 0) / list.length).toFixed(3)}`);
}
