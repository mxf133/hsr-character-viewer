// 探针：性价比这一列到底在量什么？
//   node tools/_probe-cost-decomp.mjs
// 把 `costScore` 对「强度」「整包金数」做回归，看方差归属 —— 如果金数解释掉大头，
// 这一列其实是「谁便宜谁高」，而不是「同等成绩下谁更省」。
import { buildConclusion, VERSION_WINDOW } from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
const index = await archiveIndex();
const i18n = await loadI18n();
const cn = (n) => zhName(i18n, 'characters', n) || n;
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
const rank = (arr) => { const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(arr.length); for (let i = 0; i < idx.length; i += 1) r[idx[i][1]] = i; return r; };
const pearson = (a, b) => { const ma = mean(a); const mb = mean(b);
  let sa = 0; let sb = 0; let sab = 0;
  for (let i = 0; i < a.length; i += 1) { const da = a[i] - ma; const db = b[i] - mb; sa += da * da; sb += db * db; sab += da * db; }
  return sa && sb ? sab / Math.sqrt(sa * sb) : NaN; };
const spearman = (a, b) => pearson(rank(a), rank(b));
// 多元线性回归（两个自变量）的 R²
const r2 = (y, xs) => {
  const n = y.length; const k = xs.length;
  const my = mean(y);
  const sst = y.reduce((s, v) => s + (v - my) ** 2, 0);
  // 正规方程：用 Gram 矩阵求解
  const A = []; const b = [];
  for (let i = 0; i <= k; i += 1) {
    A.push([]);
    for (let j = 0; j <= k; j += 1) {
      if (i === 0 && j === 0) A[i].push(n);
      else if (i === 0) A[i].push(xs[j - 1].reduce((s, v) => s + v, 0));
      else if (j === 0) A[i].push(xs[i - 1].reduce((s, v) => s + v, 0));
      else A[i].push(xs[i - 1].reduce((s, v, t) => s + v * xs[j - 1][t], 0));
    }
    b.push(i === 0 ? y.reduce((s, v) => s + v, 0)
      : xs[i - 1].reduce((s, v, t) => s + v * y[t], 0));
  }
  // 高斯消元
  for (let i = 0; i <= k; i += 1) {
    let p = i; for (let r = i + 1; r <= k; r += 1) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = 0; r <= k; r += 1) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      for (let cc = i; cc <= k; cc += 1) A[r][cc] -= f * A[i][cc];
      b[r] -= f * b[i];
    }
  }
  const coef = [];
  for (let i = 0; i <= k; i += 1) coef.push(b[i] / A[i][i]);
  let sse = 0;
  for (let t = 0; t < n; t += 1) {
    let pred = coef[0];
    for (let i = 0; i < k; i += 1) pred += coef[i + 1] * xs[i][t];
    sse += (y[t] - pred) ** 2;
  }
  return { R2: 1 - sse / sst, coef };
};

const C = all.map((u) => num(u.costScore));
const S = all.map((u) => num(u.strengthScore));
const G = all.map((u) => num(u.rawGold));
const T = all.map((u) => num(u.total));
const Gt = all.map((u) => num(u.bestTeamGold));

console.log(`n = ${all.length}`);
console.log('=== ① 性价比与各个量单独的相关性 ===');
for (const [label, arr] of [['强度得分', S], ['整包 rawGold', G], ['最佳证据队伍金数', Gt],
  ['整包自身金数系数', all.map((u) => num(u.ownGoldFactor) || 1)], ['原始量 total', T]]) {
  console.log(`  ${label.padEnd(18)} Pearson=${pearson(C, arr).toFixed(3).padStart(7)}  Spearman=${spearman(C, arr).toFixed(3).padStart(7)}`);
}
console.log('');
console.log('=== ② costScore 的方差归属（多元回归 R²）===');
console.log(`  只用强度得分           R² = ${r2(C, [S]).R2.toFixed(3)}`);
console.log(`  只用整包金数           R² = ${r2(C, [G]).R2.toFixed(3)}`);
console.log(`  只用 bestTeamGold      R² = ${r2(C, [Gt]).R2.toFixed(3)}`);
console.log(`  强度 + 整包金数        R² = ${r2(C, [S, G]).R2.toFixed(3)}`);
console.log(`  强度 + 是1金(E0)哑变量 R² = ${r2(C, [S, G.map((g) => (g <= 1 ? 1 : 0))]).R2.toFixed(3)}`);
console.log('');
console.log('=== ③ 原始量 total 的方差归属 ===');
console.log(`  只用强度               R² = ${r2(T, [S]).R2.toFixed(3)}`);
console.log(`  强度 + 整包金数        R² = ${r2(T, [S, G]).R2.toFixed(3)}`);
console.log(`  强度 + bestTeamGold    R² = ${r2(T, [S, Gt]).R2.toFixed(3)}`);
console.log('');
console.log('=== ④ 「1 金」与「非 1 金」两组的分值对比 ===');
for (const [label, pred] of [['1 金整包', (u) => num(u.rawGold) <= 1], ['2~3 金', (u) => num(u.rawGold) >= 2 && num(u.rawGold) <= 3], ['≥4 金', (u) => num(u.rawGold) >= 4]]) {
  const g = all.filter(pred);
  if (!g.length) continue;
  const cs = g.map((u) => num(u.costScore));
  const ss = g.map((u) => num(u.strengthScore));
  console.log(`  ${label.padEnd(10)} n=${String(g.length).padStart(3)}  性价比均值=${mean(cs).toFixed(1).padStart(5)}  强度均值=${mean(ss).toFixed(1).padStart(5)}`);
}
console.log('');
console.log('=== ⑤ 每档内部：性价比的极差 ===');
const bandOf = (u) => (num(u.eidolon) === 6 ? 'E6' : `E${num(u.eidolon)}`);
for (const b of ['E0', 'E1', 'E2', 'E6']) {
  const g = all.filter((u) => bandOf(u) === b);
  if (!g.length) continue;
  const cs = g.map((u) => num(u.costScore)).sort((a, x) => a - x);
  console.log(`  ${b}  n=${String(g.length).padStart(3)}  性价比 ${cs[0].toFixed(1)} ~ ${cs[cs.length - 1].toFixed(1)}`);
}
