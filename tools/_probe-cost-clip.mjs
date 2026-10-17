// 探针：用**分位裁剪**当锚点，能不能同时做到「分布可读」+「权重不随单个整包漂移」？
//   node tools/_probe-cost-clip.mjs
//
// 记法：clip(lo,hi) 表示 0 分锚点取原始量的 lo 分位、100 分锚点取 hi 分位，超出截断。
// 与幂/log 压缩对比：后者会抬 σ（→ 实际权重偏离名义），前者只是换锚点。
import { buildConclusion, VERSION_WINDOW } from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
const index = await archiveIndex();
const i18n = await loadI18n(); void i18n;
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

const mk = (loP, hiP, pow) => (list) => {
  const vals = list.map((x) => Math.pow(Math.max(0, x), pow));
  const lo = pct(vals, loP); const hi = pct(vals, hiP);
  if (hi - lo < 1e-9) return vals.map(() => 100);
  return vals.map((v) => 100 * Math.max(0, Math.min(1, (v - lo) / (hi - lo))));
};
const share = (cs, sub) => {
  const ss = sub ? sub.S : S; const vv = sub ? sub.V : V;
  const contrib = [W.s * std(ss), W.c * std(cs), W.v * std(vv)];
  const t = contrib.reduce((n, x) => n + x, 0);
  return contrib.map((x) => x / t * 100);
};

console.log('方案                        p10    p50    p90     σ    影响力(强/性/泛)      去掉最贵10条后');
console.log('-'.repeat(100));
const cases = [
  ['线性 min-max（现状）', mk(0, 1, 1)],
  ['clip p5/p95 + 线性', mk(0.05, 0.95, 1)],
  ['clip p2/p98 + 线性', mk(0.02, 0.98, 1)],
  ['clip p5/p95 + x^0.75', mk(0.05, 0.95, 0.75)],
  ['clip p5/p95 + x^0.5', mk(0.05, 0.95, 0.5)],
  ['clip p10/p90 + 线性', mk(0.10, 0.90, 1)],
];
const top10 = RAW.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(10).map((x) => x[1]);
const subRaw = top10.map((i) => RAW[i]);
const subObj = { S: top10.map((i) => S[i]), V: top10.map((i) => V[i]) };
for (const [label, f] of cases) {
  const cs = f(RAW);
  const sh = share(cs);
  const csSub = f(subRaw);
  const shSub = share(csSub, subObj);
  console.log(`${label.padEnd(24)} ${pct(cs, 0.1).toFixed(1).padStart(5)} ${pct(cs, 0.5).toFixed(1).padStart(6)} `
    + `${pct(cs, 0.9).toFixed(1).padStart(6)} ${std(cs).toFixed(1).padStart(6)}  `
    + `${sh.map((x) => x.toFixed(1)).join(' / ').padEnd(20)} ${shSub.map((x) => x.toFixed(1)).join(' / ')}`);
}
console.log('');
console.log('=== 各分位上的原始量（锚点候选）===');
for (const p of [0, 0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.98, 1]) {
  console.log(`  p${String(Math.round(p * 100)).padStart(3)} = ${pct(RAW, p).toFixed(1)}`);
}
