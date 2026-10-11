// 探针：复现并验证「总榜浮层分数」与「角色面板分数」对不上的 bug（用户 2026-10-11 截图）。
//
// 截图：砂金·戏浪 E6S1 + 向浪花掷下盛夏S1（异相仲裁·绝境，11 金，行动值 285）
//   * 总榜浮层：贡献 +399（表格里权重列写 ×5.5）
//   * 角色面板：性价比得分 +725
//   725 / 399 = 1.817 ≈ 10 / 5.5  → 两条链路用了不同的副本权重
//
// 根因：`/api/archive/packs` 路由只传 window、没传 frontierWeights；前端 fetchPacks
// 也没带 → 面板永远按**默认权重**算，而浮层用的是用户界面上定的「总榜权重」。
//
//   node tools/_probe-packs-weight.mjs
//
// ⚠️ 缺陷 3（档位/行动值合并）之后，截图里那条整包的分数已变，且它可能不再出现在
// 总榜收敛结果里 —— 所以这里改成**通用对照**：取榜上第一条，比较两条链路。
import { archiveConclusion, archiveCharacterPacks } from '../src/server/conclusion.js';

const WEIGHTS = { 'aa|plight': 5.5 };
const brief = (envs) => (envs || []).map((e) => ({
  id: e.id, weight: e.weight, value: Number((Number(e.value) || 0).toFixed(4)),
}));

console.log('=== ① 总榜接口，默认权重（模拟用户没改权重时的界面）===');
const c0 = await archiveConclusion({}, {});
const top0 = (c0.frontierUnits || [])[0];
console.log(`  榜首 ${top0.name} E${top0.eidolon} total=${top0.total.toFixed(4)}`);
for (const e of brief(top0.envs.map((e) => ({
  ...e, weight: (c0.frontierEnvs.find((x) => x.id === e.id) || {}).weight,
})))) console.log(`    ${e.id}: weight=${e.weight} value=${e.value}`);

console.log('\n=== ② 总榜接口，把绝境总榜权重设成 5.5（模拟用户在界面上改过）===');
const c1 = await archiveConclusion({}, { frontierWeights: WEIGHTS });
const top1 = (c1.frontierUnits || [])[0];
const boardVal = top1.total;
console.log(`  榜首 ${top1.name} E${top1.eidolon} total=${top1.total.toFixed(4)}   ← 浮层徽标上的数`);
for (const e of brief(top1.envs.map((e) => ({
  ...e, weight: (c1.frontierEnvs.find((x) => x.id === e.id) || {}).weight,
})))) console.log(`    ${e.id}: weight=${e.weight} value=${e.value}   ← 浮层表格权重列`);

console.log('\n=== ③ 角色面板接口（/api/archive/packs 走的函数）===');
console.log('  --- 不传 frontierWeights（**修复前**的行为：面板永远按默认权重）---');
const packsBefore = await archiveCharacterPacks(top1.name);
const b = (packsBefore.packs || []).find((p) => p.eidolon === top1.eidolon);
console.log(`  面板 total=${b?.total?.toFixed(4)}`);
console.log('  --- 传 frontierWeights（**修复后**的行为）---');
const packsAfter = await archiveCharacterPacks(top1.name, { frontierWeights: WEIGHTS });
const a = (packsAfter.packs || []).find((p) => p.eidolon === top1.eidolon);
console.log(`  面板 total=${a?.total?.toFixed(4)}`);

console.log('\n=== 结论 ===');
console.log(`  浮层（按用户权重 5.5）= ${boardVal.toFixed(4)}`);
console.log(`  面板（修复前，默认权重 10）= ${b?.total?.toFixed(4)}  ← 与浮层不一致（这就是截图 bug）`);
console.log(`  面板（修复后，跟随 5.5）= ${a?.total?.toFixed(4)}`);
const ok = Number.isFinite(a?.total) && Math.abs(a.total - boardVal) < 0.01;
console.log(`  ${ok ? '✓ 修复后面板与浮层一致' : '✗ 仍不一致'}`);
