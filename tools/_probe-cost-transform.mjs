// 探针：性价比原始量跨 1623 倍，榜内线性 min-max 会把 57.5% 的整包压到 10 分以下。
// 本探针比较几种单调压缩变换，看它们对「分布」「有效权重」「抗离群稳定性」的影响。
//   node tools/_probe-cost-transform.mjs
//
// 评价标准（三条，别只看一条）：
//   ① 中位数要能读 —— 现在线性 min-max 的 p50 只有 7.3 / 100；
//   ② 名义权重 40/40/20 要接近实际影响力（w×σ 占比）；
//   ③ 去掉最贵 10 条之后，实际影响力不能大幅漂移。
import { buildConclusion, VERSION_WINDOW } from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
const index = await archiveIndex();
const i18n = await loadI18n();
void i18n;
const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const fa = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const c = buildConclusion(envs, { availability: index.refs?.availability || {},
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  frontier: Object.fromEntries(fa.map((f) => [f.env, f])) });
const all = []; const seen = new Set();
for (const u of [...(c.frontierUnits || []), ...Object.values(c.frontierTiers || {}).flat()]) {
  const k = `${u.name}|${u.eidolon}|${u.lc}|${u.superimp}`;
  if (seen.has(k)) continue; seen.add(k); all.push(u);
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]; };
const W = { s: 0.4, c: 0.4, v: 0.2 };
const S = all.map((u) => num(u.strengthScore));
const V = all.map((u) => num(u.versatilityScore));
const RAW = all.map((u) => num(u.total));

const transforms = {
  '线性（现状）': (x) => x,
  'x^0.7': (x) => Math.pow(x, 0.7),
  'x^0.6': (x) => Math.pow(x, 0.6),
  'x^0.5': (x) => Math.pow(x, 0.5),
  'x^0.4': (x) => Math.pow(x, 0.4),
  'x^0.3': (x) => Math.pow(x, 0.3),
  'log1p': (x) => Math.log1p(x),
};

const scoreOf = (f, list) => {
  const vals = list.map(f);
  const lo = Math.min(...vals); const hi = Math.max(...vals);
  return vals.map((v) => 100 * (v - lo) / (hi - lo));
};
const weightShare = (cs) => {
  const contrib = [W.s * std(S), W.c * std(cs), W.v * std(V)];
  const t = contrib.reduce((n, x) => n + x, 0);
  return contrib.map((x) => x / t * 100);
};

console.log('变换               p10    p50    p90     σ     实际影响力 强度/性价比/泛用性    去掉最贵10条后');
console.log('-'.repeat(104));
for (const [label, f] of Object.entries(transforms)) {
  const cs = scoreOf(f, RAW);
  const sh = weightShare(cs);
  // 稳定性：去掉最贵 10 条
  const idx = RAW.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(10).map((x) => x[1]);
  const sub = idx.map((i) => RAW[i]);
  const subS = idx.map((i) => S[i]); const subV = idx.map((i) => V[i]);
  const csSub = scoreOf(f, sub);
  const contrib = [W.s * std(subS), W.c * std(csSub), W.v * std(subV)];
  const t = contrib.reduce((n, x) => n + x, 0);
  const shSub = contrib.map((x) => x / t * 100);
  console.log(`${label.padEnd(16)} ${pct(cs, 0.1).toFixed(1).padStart(5)} ${pct(cs, 0.5).toFixed(1).padStart(6)} `
    + `${pct(cs, 0.9).toFixed(1).padStart(6)} ${std(cs).toFixed(1).padStart(6)}   `
    + `${sh.map((x) => x.toFixed(1)).join(' / ').padEnd(22)} `
    + `${shSub.map((x) => x.toFixed(1)).join(' / ')}`);
}
console.log('');
console.log(`（强度自身的 σ = ${std(S).toFixed(2)}，泛用性 σ = ${std(V).toFixed(2)}；名义 40 / 40 / 20）`);
console.log('');
console.log('=== 原始量分位（用于判断尾巴有多重）===');
console.log(`  p0=${pct(RAW, 0).toFixed(2)} p5=${pct(RAW, 0.05).toFixed(2)} p25=${pct(RAW, 0.25).toFixed(1)}`
  + ` p50=${pct(RAW, 0.5).toFixed(1)} p75=${pct(RAW, 0.75).toFixed(1)} p90=${pct(RAW, 0.9).toFixed(1)}`
  + ` p95=${pct(RAW, 0.95).toFixed(1)} p99=${pct(RAW, 0.99).toFixed(1)} max=${pct(RAW, 1).toFixed(1)}`);
