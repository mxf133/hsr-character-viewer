// 探针：把 ownGoldFactorPower 从 0.5 调大，到底改善了什么、代价是什么？
//   node tools/_probe-cost-q.mjs
// 关心四件事：① 与强度的重复度（Spearman / R²）；② 同成绩下的违反率；
//             ③ 各星魂档的得分中位；④ 1 金 vs ≥4 金的组均值差。
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
const RAW0 = all.map((u) => num(u.total) / (num(u.ownGoldFactor) || 1)); // 去掉旧系数的原始量
const minGold = new Map();
for (const u of all) { const g = Math.max(1, num(u.rawGold) || 0);
  const cur = minGold.get(u.name); if (cur === undefined || g < cur) minGold.set(u.name, g); }
const bandOf = (u) => (num(u.eidolon) === 6 ? 'E6' : `E${num(u.eidolon)}`);
const byChar = new Map();
for (const u of all) { const l = byChar.get(u.name) || []; l.push(u); byChar.set(u.name, l); }

console.log('q     与强度 Spearman   R²(强度+金数)  同成绩违反率   档位中位(E0/E1/E2/E6)      1金 / ≥4金 均值');
console.log('-'.repeat(112));
for (const q of [0, 0.5, 0.75, 1.0, 1.5, 2.0]) {
  const raw = all.map((u, i) => {
    const ref = Math.max(1, (minGold.get(u.name) ?? num(u.rawGold)) || 1);
    const own = Math.max(1, num(u.rawGold) || 0);
    return RAW0[i] * Math.pow(ref / own, q);
  });
  const lo = Math.min(...raw); const hi = Math.max(...raw);
  const cs = raw.map((v) => 100 * (v - lo) / (hi - lo));
  // 同成绩违反率（|Δ强度| ≤ 1）
  const idxOf = new Map(all.map((u, i) => [u, i]));
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
  }).join(' / ');
  const g1 = mean(all.map((u, i) => (num(u.rawGold) <= 1 ? cs[i] : null)).filter((x) => x !== null));
  const g4 = mean(all.map((u, i) => (num(u.rawGold) >= 4 ? cs[i] : null)).filter((x) => x !== null));
  console.log(`${q.toFixed(2)}  ${pearson(rank(cs), rank(S)).toFixed(3).padStart(14)}`
    + `${pearson(cs, S).toFixed(3).padStart(14)}`
    + `${(viol / Math.max(1, pairs) * 100).toFixed(1).padStart(11)}%   ${med.padEnd(24)}`
    + `${g1.toFixed(1)} / ${g4.toFixed(1)}`);
}
