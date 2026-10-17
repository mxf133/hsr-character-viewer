// 探针：性价比这一列的两个「结构性缺口」
//   node tools/_probe-cost-gaps.mjs
//  ① E3/E4/E5 整包：`eidolonTierOf` 把它们折进 E2，但 `byTier` 的过滤用的是
//     `Number(unit.eidolon) !== tier` —— 折了还是没折？
//  ②「该角色最便宜整包」分母：有多少角色的分母不是 1 金（= 它的低价档被
//     `total > 0` 过滤掉了），这些角色是不是被系统性抬高了性价比。
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

const all = [];
const seen = new Set();
for (const u of [...(c.frontierUnits || []), ...Object.values(c.frontierTiers || {}).flat()]) {
  const k = `${u.name}|${u.eidolon}|${u.lc}|${u.superimp}`;
  if (seen.has(k)) continue;
  seen.add(k); all.push(u);
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

console.log(`整包 ${all.length} 条｜总榜 ${c.frontierUnits.length} 条｜各档视图条数 `
  + Object.entries(c.frontierTiers || {}).map(([k, v]) => `${k}:${v.length}`).join(' '));

console.log('\n=== ① 星魂档视图是否漏掉 E3/E4/E5 ===');
const eidoHist = new Map();
for (const u of all) eidoHist.set(num(u.eidolon), (eidoHist.get(num(u.eidolon)) || 0) + 1);
console.log('  eidolon 直方图：' + [...eidoHist.entries()].sort((a, b) => a[0] - b[0])
  .map(([e, n]) => `E${e}:${n}`).join(' '));
const tierIds = new Set(Object.values(c.frontierTiers || {}).flat()
  .map((u) => `${u.name}|${u.eidolon}|${u.lc}|${u.superimp}`));
const missing = all.filter((u) => !tierIds.has(`${u.name}|${u.eidolon}|${u.lc}|${u.superimp}`));
console.log(`  四个档位视图都没收的整包：${missing.length} 条`);
for (const u of missing.slice(0, 12)) {
  console.log(`     ${cn(u.name).padEnd(12)} E${u.eidolon}S${u.superimp} ${num(u.rawGold)}金`
    + ` 性价比=${num(u.costScore).toFixed(1)} 角色得分=${num(u.characterScore).toFixed(1)}`);
}
const tiersE3plus = all.filter((u) => [3, 4, 5].includes(num(u.eidolon)));
console.log(`  eidolon ∈ {3,4,5} 的整包：${tiersE3plus.length} 条`);

console.log('\n=== ②「该角色最便宜整包」分母 ===');
const minGold = new Map();
for (const u of all) {
  const g = Math.max(1, num(u.rawGold) || 0);
  const cur = minGold.get(u.name);
  if (cur === undefined || g < cur) minGold.set(u.name, g);
}
const hist = new Map();
for (const [, g] of minGold) hist.set(g, (hist.get(g) || 0) + 1);
console.log(`  角色 ${minGold.size} 个：` + [...hist.entries()].sort((a, b) => a[0] - b[0])
  .map(([g, n]) => `分母${g}金:${n}个`).join(' '));
const inflated = [...minGold.entries()].filter(([, g]) => g > 1);
console.log(`  ⚠️ 分母 > 1 金的角色 ${inflated.length} 个（它们的低价档没有成绩被过滤掉了，`
  + `系数因此偏高）：`);
for (const [name, g] of inflated) {
  const list = all.filter((u) => u.name === name).sort((a, b) => num(a.rawGold) - num(b.rawGold));
  console.log(`     ${cn(name).padEnd(12)} 分母${g}金，整包：`
    + list.map((u) => `E${u.eidolon}S${u.superimp}(${num(u.rawGold)}金,系数${num(u.ownGoldFactor).toFixed(2)},分${num(u.costScore).toFixed(1)})`).join(' '));
}

console.log('\n=== ③ 同一角色内部：更贵的整包性价比是否恒更低 ===');
const byChar = new Map();
for (const u of all) {
  const l = byChar.get(u.name) || [];
  l.push(u); byChar.set(u.name, l);
}
let pairs = 0; let viol = 0;
const violEx = [];
for (const [name, list] of byChar) {
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]; const b = list[j];
      const ga = num(a.rawGold); const gb = num(b.rawGold);
      if (ga === gb) continue;
      pairs += 1;
      const [cheap, dear] = ga < gb ? [a, b] : [b, a];
      if (num(cheap.costScore) < num(dear.costScore) - 1e-6) {
        viol += 1;
        if (violEx.length < 6) violEx.push({ name, cheap, dear });
      }
    }
  }
}
console.log(`  同角色不同金数的可比对 ${pairs} 组：更贵的整包性价比反而更高的 ${viol} 组`
  + `（${(viol / Math.max(1, pairs) * 100).toFixed(1)}%）`);
for (const { name, cheap, dear } of violEx) {
  console.log(`     ${cn(name).padEnd(12)} ${num(cheap.rawGold)}金 分${num(cheap.costScore).toFixed(1)}`
    + `  vs  ${num(dear.rawGold)}金 分${num(dear.costScore).toFixed(1)}`);
}
