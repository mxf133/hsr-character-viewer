// 探针：把「指数 q」与「刻度变换」两个旋钮一起扫一遍，给最终方案定值。
//   node tools/_probe-cost-final.mjs
// 输出：分位分布 / σ / 实际影响力 / 同成绩违反率 / 档位中位 / 与强度 Spearman
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
const rank = (arr) => { const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(arr.length); for (let i = 0; i < idx.length; i += 1) r[idx[i][1]] = i; return r; };
const pearson = (a, b) => { const ma = mean(a); const mb = mean(b);
  let sa = 0; let sb = 0; let sab = 0;
  for (let i = 0; i < a.length; i += 1) { const da = a[i] - ma; const db = b[i] - mb;
    sa += da * da; sb += db * db; sab += da * db; }
  return sa && sb ? sab / Math.sqrt(sa * sb) : NaN; };
const S = all.map((u) => num(u.strengthScore));
const V = all.map((u) => num(u.versatilityScore));
const RAW0 = all.map((u) => num(u.total) / (num(u.ownGoldFactor) || 1));
const minGold = new Map();
for (const u of all) { const g = Math.max(1, num(u.rawGold) || 0);
  const cur = minGold.get(u.name); if (cur === undefined || g < cur) minGold.set(u.name, g); }
const bandOf = (u) => (num(u.eidolon) === 6 ? 'E6' : `E${num(u.eidolon)}`);
const byChar = new Map();
for (const u of all) { const l = byChar.get(u.name) || []; l.push(u); byChar.set(u.name, l); }
const idxOf = new Map(all.map((u, i) => [u, i]));
const W = { s: 0.4, c: 0.4, v: 0.2 };

const build = (q, pow, clip) => {
  const raw = all.map((u, i) => {
    const ref = Math.max(1, (minGold.get(u.name) ?? num(u.rawGold)) || 1);
    const own = Math.max(1, num(u.rawGold) || 0);
    return RAW0[i] * Math.pow(ref / own, q);
  });
  const vals = raw.map((v) => Math.pow(Math.max(0, v), pow));
  const lo = clip ? pct(vals, clip[0]) : Math.min(...vals);
  const hi = clip ? pct(vals, clip[1]) : Math.max(...vals);
  const cs = vals.map((v) => 100 * Math.max(0, Math.min(1, (v - lo) / (hi - lo))));
  return { cs, raw };
};

console.log('q    刻度             p10   p50   p90    σ    影响力(强/性/泛)    同成绩违反  档位中位 E0/E1/E2/E6   与强度ρ');
console.log('-'.repeat(122));
for (const q of [0.5, 0.75, 1.0]) {
  for (const [label, pow, clip] of [
    ['线性', 1, null], ['x^0.5', 0.5, null], ['x^0.5+clip5/95', 0.5, [0.05, 0.95]],
    ['x^0.6', 0.6, null], ['x^0.4+clip5/95', 0.4, [0.05, 0.95]],
  ]) {
    const { cs } = build(q, pow, clip);
    const contrib = [W.s * std(S), W.c * std(cs), W.v * std(V)];
    const t = contrib.reduce((n, x) => n + x, 0);
    const sh = contrib.map((x) => x / t * 100).map((x) => x.toFixed(1)).join('/');
    let pairs = 0; let viol = 0;
    for (const [, list] of byChar) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i]; const b = list[j];
          if (num(a.rawGold) === num(b.rawGold)) continue;
          if (Math.abs(S[idxOf.get(a)] - S[idxOf.get(b)]) > 1) continue;
          pairs += 1;
          const [ch, de] = num(a.rawGold) < num(b.rawGold) ? [a, b] : [b, a];
          if (cs[idxOf.get(ch)] < cs[idxOf.get(de)] - 1e-6) viol += 1;
        }
      }
    }
    const med = ['E0', 'E1', 'E2', 'E6'].map((bd) => {
      const v = all.map((u, i) => (bandOf(u) === bd ? cs[i] : null)).filter((x) => x !== null);
      return v.length ? pct(v, 0.5).toFixed(1) : '—';
    }).join('/');
    console.log(`${q.toFixed(2)} ${label.padEnd(15)} ${pct(cs, 0.1).toFixed(1).padStart(4)} `
      + `${pct(cs, 0.5).toFixed(1).padStart(5)} ${pct(cs, 0.9).toFixed(1).padStart(5)} `
      + `${std(cs).toFixed(1).padStart(5)}  ${sh.padEnd(19)} ${(viol / Math.max(1, pairs) * 100).toFixed(1).padStart(5)}%    `
      + `${med.padEnd(18)} ${pearson(rank(cs), rank(S)).toFixed(3)}`);
  }
  console.log('');
}
