/**
 * 「0 行动值达成率」探针 —— 顶格档折价（v4.6.129）的唯一数据依据。
 *
 * 背景（用户 2026-10-18 报「老队伍角色的队伍强度过高」，丹恒•饮月那支队）：
 * 顶格档一直是「行动值 = 0 → 100 分」，但「0 行动值」在不同副本难度天差地别。
 * 本探针打印逐 (副本 × 版本) 的达成率，以及按公式算出的顶格上限。
 *
 *   顶格上限 = 100 × max(strengthTopBandFloor,
 *                         strengthTopBandRare + (1 − strengthTopBandRare) × (1 − rate))
 *
 * 用法：`node tools/_probe-zero-av-rate.mjs`
 * ⚠️ 复算本文档注释里的实测数字就跑这个；别手抄，达成率会随投稿数据变。
 */
import { archiveIndex, loadI18n } from '../src/server/archive.js';
import { archiveConclusion } from '../src/server/conclusion.js';
import { SCORING } from '../public/scripts/advice.js';
import { buildVirtualAccount, presetById } from '../src/server/virtual-accounts.js';

const index = await archiveIndex();
await loadI18n();
const account = buildVirtualAccount({
  preset: presetById('flat-2-1'), index, i18n: { characters: {} },
  availability: index.refs?.availability || {},
  charCostOf: () => 0, coneCostOf: () => 0, uid: '1', nickname: 'p',
});
void account;
const conclusion = await archiveConclusion({ owned: [], eidolons: {}, cones: {} },
  { includeAllTeams: true, hiddenCosts: {} });

const rate = conclusion.zeroAvRateByEnv;
if (!rate) {
  console.error('❌ zeroAvRateByEnv 没下发 —— 服务端 collectAllTeams 的返回或 projectConclusion 漏了');
  process.exit(1);
}

const { strengthTopBandRare: RARE, strengthTopBandFloor: FLOOR } = SCORING;
const capOf = (r) => 100 * Math.max(FLOOR, RARE + (1 - RARE) * (1 - Math.max(0, Math.min(1, r))));

const envs = conclusion.frontierEnvs || [];
const weightOf = new Map(envs.map((e) => [e.id, Number(e.weight) || 0]));

console.log(`折价参数 rare=${RARE} floor=${FLOOR}`);
console.log('副本'.padEnd(12), '版本'.padEnd(6), '权重'.padEnd(5), '0AV'.padStart(5), '/总数'.padStart(6),
  '达成率'.padStart(8), '顶格上限'.padStart(9));
console.log('-'.repeat(60));

const rows = [];
for (const [envId, bySeason] of Object.entries(rate)) {
  for (const [season, cell] of Object.entries(bySeason)) {
    rows.push({ envId, season, ...cell, cap: capOf(cell.rate) });
  }
}
rows.sort((a, b) => a.cap - b.cap);
for (const r of rows) {
  console.log(r.envId.padEnd(12), r.season.padEnd(6), String(weightOf.get(r.envId) ?? '?').padEnd(5),
    String(r.zero).padStart(5), `/${String(r.total).padStart(5)}`,
    `${(r.rate * 100).toFixed(1)}%`.padStart(8), r.cap.toFixed(1).padStart(9));
}

// 一致性断言：折价必须**不反超**（达成率越低顶格不该更低）。
// ⚠️ 不要断言严格单调：`floor` 会把「容易达成」的那一大片全部夹到同一个 35，
//    所以 rate 在 floor 以上的那段是平的，只有跨过 floor 时才应严格下降。
const sortedByRate = [...rows].sort((a, b) => a.rate - b.rate);
let monotone = true;
for (let i = 1; i < sortedByRate.length; i += 1) {
  if (sortedByRate[i].cap > sortedByRate[i - 1].cap + 1e-9) monotone = false;
}
const plight = rows.filter((r) => r.envId === 'aa/plight');
const easy = rows.filter((r) => r.envId === 'moc' || r.envId === 'aa');
console.log('-'.repeat(60));
console.log(`折价不反超（达成率越高顶格不该更高）：${monotone ? '✓' : '✗'}`);
console.log(`绝境顶格上限 ${[...new Set(plight.map((r) => r.cap.toFixed(1)))].sort().join(' / ')}`
  + ` · 容易达标的（moc/aa）顶格上限 ${[...new Set(easy.map((r) => r.cap.toFixed(1)))].join(' / ')}`);
const plightMax = Math.max(...plight.map((r) => r.cap));
const easyMin = Math.min(...easy.map((r) => r.cap));
console.log(`绝境顶格(${plightMax.toFixed(1)}) 必须高于 容易达标顶格(${easyMin.toFixed(1)})：`
  + `${plightMax > easyMin ? '✓' : '✗'}`);
if (!monotone || plightMax <= easyMin) {
  console.error('✗ 折价口径有问题（见上一行）');
  process.exit(1);
}
