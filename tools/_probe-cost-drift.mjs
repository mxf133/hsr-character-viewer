// 探针：名义抽卡权重 40/40/20，在「数据换一版」之后还是 40/40/20 吗？
//   node tools/_probe-cost-drift.mjs
// 强度是绝对刻度（a=1），性价比是**榜内** min-max（a = 100/(hi−lo)），
// 所以性价比的有效影响力 = wc × a × σ(raw)。它跟着 hi 走 —— 也就是跟着**某一个**
// 离群整包走。本探针把「去掉最贵的 K 条」重算一遍，看权重的漂移幅度。
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
const W = { s: 0.4, c: 0.4, v: 0.2 };

const report = (label, list, ext) => {
  // 用给定的刻度把性价比重算成 0~100，再算 σ
  const cs = list.map((u) => 100 * (num(u.total) - ext.lo) / (ext.hi - ext.lo));
  const ss = list.map((u) => num(u.strengthScore));
  const vs = list.map((u) => num(u.versatilityScore));
  const contrib = [['强度', W.s * std(ss)], ['性价比', W.c * std(cs)], ['泛用性', W.v * std(vs)]];
  const tot = contrib.reduce((n, [, x]) => n + x, 0);
  console.log(`  ${label.padEnd(22)} 刻度 hi=${ext.hi.toFixed(1).padStart(7)}  `
    + contrib.map(([k, x]) => `${k} ${(x / tot * 100).toFixed(1)}%`).join(' / '));
};

const costHi = num(c.frontierExtents?.cost?.hi);
const costLo = num(c.frontierExtents?.cost?.lo);
console.log(`整包 ${all.length} 条，现状刻度 [${costLo.toFixed(2)}, ${costHi.toFixed(1)}]`);
console.log('');
console.log('=== 去掉最贵的 K 条整包后（重取 min-max 极值），三个分项的实际影响力 ===');
report('现状（K=0）', all, { lo: costLo, hi: costHi });
for (const K of [1, 2, 3, 5, 10]) {
  const g = [...all].sort((a, b) => num(b.total) - num(a.total)).slice(K);
  const tot = g.map((u) => num(u.total));
  const ext = { lo: Math.min(...tot), hi: Math.max(...tot) };
  report(`去掉最贵 K=${K} 条`, g, ext);
}
console.log('');
console.log('=== 反过来：若只用榜面 81 条取极值 ===');
const board = c.frontierUnits || [];
const bt = board.map((u) => num(u.total));
report('仅总榜 81 条取刻度', board, { lo: Math.min(...bt), hi: Math.max(...bt) });
