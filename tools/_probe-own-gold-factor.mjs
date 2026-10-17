// 探针：给「角色性价比」加「整包自身金数」因子之后，各星魂档的得分分布会变成什么样？
//
//   factor = (该角色榜上最便宜的整包金数 / 本整包金数) ^ q
//   新 total = 旧 total × factor
//
//   node tools/_probe-own-gold-factor.mjs
import {
  buildConclusion, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const index = await archiveIndex();
const i18n = await loadI18n();
const cn = (n) => zhName(i18n, 'characters', n) || n;
const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const fa = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const c = buildConclusion(envs, {
  availability: index.refs?.availability || {},
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  frontier: Object.fromEntries(fa.map((f) => [f.env, f])),
});
const units = [];
for (const l of Object.values(c.frontierTiers || {})) units.push(...l);
const seen = new Set(); const all = [];
for (const u of units) {
  const k = `${u.name}|${u.eidolon}|${u.lc}|${u.superimp}`;
  if (seen.has(k)) continue;
  seen.add(k); all.push(u);
}

// 该角色榜上最便宜的整包金数
const minGold = new Map();
for (const u of all) {
  const g = Number(u.gold) || 0;
  const cur = minGold.get(u.name);
  if (cur === undefined || g < cur) minGold.set(u.name, g);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const band = (u) => {
  const e = Number(u.eidolon) || 0;
  return e === 6 ? 'E6' : e >= 3 ? 'E2(含E3-5)' : `E${e}`;
};

console.log('各角色「最便宜整包金数」样本（前 6 个）：');
let n = 0;
for (const [name, g] of minGold) {
  if (n++ >= 6) break;
  const list = all.filter((u) => u.name === name);
  console.log(`  ${cn(name).padEnd(12)} 最低 ${g} 金｜该角色 ${list.length} 个整包：`
    + list.map((u) => `E${u.eidolon}S${u.superimp}(${u.gold}金)`).join(' '));
}

for (const q of [0.3, 0.5, 0.7, 1.0]) {
  const raw = all.map((u) => {
    const g = Number(u.gold) || 0;
    const ref = minGold.get(u.name) || g || 1;
    const f = Math.pow(Math.max(1, ref) / Math.max(1, g), q);
    return { u, v: (Number(u.total) || 0) * f, f };
  });
  const vals = raw.map((x) => x.v);
  const lo = Math.min(...vals); const hi = Math.max(...vals);
  const scoreOf = (v) => (hi - lo < 1e-9 ? 0 : 100 * (v - lo) / (hi - lo));
  const byBand = new Map();
  for (const x of raw) {
    const b = band(x.u);
    const l = byBand.get(b) || [];
    l.push(scoreOf(x.v));
    byBand.set(b, l);
  }
  console.log(`\n=== 指数 q = ${q} ===（得分范围 ${lo.toFixed(1)} ~ ${hi.toFixed(1)}）`);
  for (const b of ['E0', 'E1', 'E2(含E3-5)', 'E6']) {
    const l = byBand.get(b);
    if (!l) continue;
    const sorted = l.slice().sort((a, b2) => a - b2);
    console.log(`  ${b.padEnd(10)} n=${String(l.length).padStart(3)}｜均值 ${mean(l).toFixed(1).padStart(5)}`
      + `｜中位 ${sorted[sorted.length >> 1].toFixed(1).padStart(5)}`
      + `｜≥50 分 ${l.filter((v) => v >= 50).length} 条`);
  }
}

// 举一个角色的例子：E0 与 E6S5 的新旧对比
const demo = [...minGold.entries()].filter(([name]) => {
  const list = all.filter((u) => u.name === name);
  return list.some((u) => Number(u.eidolon) === 6 && Number(u.superimp) >= 5)
    && list.some((u) => Number(u.eidolon) === 0);
}).slice(0, 4);
console.log('\n同角色 E0 vs E6S5 的性价比得分（q = 0.5）：');
for (const [name] of demo) {
  const list = all.filter((u) => u.name === name);
  const ref = minGold.get(name);
  console.log(`  ${cn(name)}（最低配装 ${ref} 金）：`);
  for (const u of list) {
    const g = Number(u.gold) || 0;
    const f = Math.pow(Math.max(1, ref) / Math.max(1, g), 0.5);
    console.log(`    E${u.eidolon}S${u.superimp} ${g} 金｜旧 ${(Number(u.costScore) || 0).toFixed(1).padStart(5)}`
      + `｜系数 ×${f.toFixed(2)}｜旧原始量 ${(Number(u.total) || 0).toFixed(0)} → 新 ${((Number(u.total) || 0) * f).toFixed(0)}`);
  }
}
