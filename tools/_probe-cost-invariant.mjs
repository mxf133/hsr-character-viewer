// 探针：`docs/功能要求.md` §8 第 39 条的不变式到底成立多少？
//   同角色、**同成绩**，更贵的整包性价比必须更低。
//   node tools/_probe-cost-invariant.mjs
// 逐对比较，并按「强度差」分档统计 —— 强度差不多时还翻面，就是真违反。
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
const byChar = new Map();
for (const u of all) { const l = byChar.get(u.name) || []; l.push(u); byChar.set(u.name, l); }

const buckets = [['|Δ强度| ≤ 1', 1], ['|Δ强度| ≤ 3', 3], ['|Δ强度| ≤ 10', 10], ['全部', Infinity]];
console.log('=== 「同角色 + 更贵 → 性价比必须更低」的违反率（按成绩差分组）===');
for (const [label, lim] of buckets) {
  let pairs = 0; let viol = 0; const ex = [];
  for (const [name, list] of byChar) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]; const b = list[j];
        const ga = num(a.rawGold); const gb = num(b.rawGold);
        if (ga === gb) continue;
        if (Math.abs(num(a.strengthScore) - num(b.strengthScore)) > lim) continue;
        pairs += 1;
        const [cheap, dear] = ga < gb ? [a, b] : [b, a];
        if (num(cheap.costScore) < num(dear.costScore) - 1e-6) {
          viol += 1;
          if (ex.length < 3 && lim === 1) ex.push({ name, cheap, dear });
        }
      }
    }
  }
  console.log(`  ${label.padEnd(14)} 可比对 ${String(pairs).padStart(4)} 组，违反 ${String(viol).padStart(3)} 组`
    + `（${(viol / Math.max(1, pairs) * 100).toFixed(1)}%）`);
  for (const { name, cheap, dear } of ex) {
    console.log(`      ${cn(name).padEnd(10)} ${num(cheap.rawGold)}金 强度${num(cheap.strengthScore).toFixed(1)} 性价比${num(cheap.costScore).toFixed(1)}`
      + `  vs  ${num(dear.rawGold)}金 强度${num(dear.strengthScore).toFixed(1)} 性价比${num(dear.costScore).toFixed(1)}`);
  }
}

console.log('\n=== 若把 ownGoldFactorPower 加大，违反率会怎么变 ===');
console.log('  （系数 = (最便宜 ÷ 本整包)^q，rest = 现有 total ÷ 现有系数，再乘新系数）');
const pairsOf = () => {
  const out = [];
  for (const [name, list] of byChar) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]; const b = list[j];
        if (num(a.rawGold) === num(b.rawGold)) continue;
        if (Math.abs(num(a.strengthScore) - num(b.strengthScore)) > 1) continue;
        out.push({ name, a, b });
      }
    }
  }
  return out;
};
const P = pairsOf();
// 用原始量重算：rest = total / 旧系数
const restOf = (u) => {
  const f = num(u.ownGoldFactor) || 1;
  return num(u.total) / (f || 1);
};
// min-max 极值随 q 变，所以要整体重算
for (const q of [0, 0.5, 1, 1.5, 2]) {
  const minGold = new Map();
  for (const u of all) { const g = Math.max(1, num(u.rawGold) || 0);
    const cur = minGold.get(u.name); if (cur === undefined || g < cur) minGold.set(u.name, g); }
  const newTotal = new Map();
  for (const u of all) {
    const ref = Math.max(1, (minGold.get(u.name) ?? num(u.rawGold)) || 1);
    const own = Math.max(1, num(u.rawGold) || 0);
    newTotal.set(u, restOf(u) * Math.pow(ref / own, q));
  }
  const vals = [...newTotal.values()];
  const lo = Math.min(...vals); const hi = Math.max(...vals);
  const sc = (u) => 100 * (newTotal.get(u) - lo) / (hi - lo);
  let viol = 0;
  for (const { a, b } of P) {
    const [cheap, dear] = num(a.rawGold) < num(b.rawGold) ? [a, b] : [b, a];
    if (sc(cheap) < sc(dear) - 1e-6) viol += 1;
  }
  console.log(`  q=${q.toFixed(1)}  违反 ${String(viol).padStart(3)} / ${P.length} 组`
    + `（${(viol / P.length * 100).toFixed(1)}%）`);
}
