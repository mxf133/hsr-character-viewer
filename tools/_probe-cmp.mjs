// 探针：逐字段对比两份 GUI 载荷（`tools/_probe-server.mjs --json=...` 的产物）。
//
// 用途：改口径时证明「该变的变了、不该变的没变」。v4.6.48 修总榜版本窗口锚点时用它
// 确认了 `units` / `envs`（抽卡方案的输入）逐字节相同，而总榜与差距榜按预期变化。
//
//   node tools/_probe-server.mjs --json=before.json
//   # …改代码…
//   node tools/_probe-server.mjs --json=after.json
//   node tools/_probe-cmp.mjs before.json after.json
import { readFile } from 'node:fs/promises';
import { loadI18n, zhName } from '../src/server/archive.js';

const [beforePath, afterPath] = process.argv.slice(2);
const before = JSON.parse(await readFile(beforePath, 'utf8'));
const after = JSON.parse(await readFile(afterPath, 'utf8'));
const i18n = await loadI18n();
const cn = (n) => zhName(i18n, 'characters', n) || n;

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rankOf = (payload, frag) => {
  const i = (payload.frontierUnits || []).findIndex((u) => cn(u.name).includes(frag));
  return i < 0 ? { rank: null, unit: null } : { rank: i + 1, unit: payload.frontierUnits[i] };
};

console.log('总榜条数      before=%d  after=%d', (before.frontierUnits || []).length, (after.frontierUnits || []).length);
console.log('units 条数    before=%d  after=%d', (before.units || []).length, (after.units || []).length);
console.log('\n--- 不该变的部分（抽卡方案的输入）---');
console.log('  units 完全一致          :', eq(before.units, after.units));
console.log('  envs（基线/判据线）一致  :', eq(before.envs, after.envs));
console.log('  frontierEnvs 权重一致    :', eq(
  (before.frontierEnvs || []).map((e) => [e.id, e.weight]),
  (after.frontierEnvs || []).map((e) => [e.id, e.weight]),
));
console.log('  frontierEnvs 窗口(应变化):', JSON.stringify((before.frontierEnvs || []).map((e) => [e.id, e.seasons, e.versionWindow])) === JSON.stringify((after.frontierEnvs || []).map((e) => [e.id, e.seasons, e.versionWindow])));

console.log('\n--- 总榜前 10（before → after）---');
for (let i = 0; i < 10; i += 1) {
  const b = (before.frontierUnits || [])[i];
  const a = (after.frontierUnits || [])[i];
  const fmt = (u) => (u ? `${cn(u.name)}E${u.eidolon}=${Math.round(u.total)}` : '—');
  console.log(`  #${String(i + 1).padStart(2)}  ${fmt(b).padEnd(26)} → ${fmt(a)}`);
}

console.log('\n--- 点名角色 ---');
for (const frag of ['砂金•戏浪', '银狼LV.999', '真珠', '爻光']) {
  const b = rankOf(before, frag);
  const a = rankOf(after, frag);
  console.log(`  ${frag.padEnd(12)} #${b.rank ?? '—'}(${b.unit ? Math.round(b.unit.total) : '—'})`
    + `  →  #${a.rank ?? '—'}(${a.unit ? Math.round(a.unit.total) : '—'})`);
}
const sj = rankOf(after, '砂金•戏浪').unit;
if (sj) {
  console.log(`\n  砂金•戏浪 after 的证据：`);
  console.log(`    ${cn(sj.name)} E${sj.eidolon} 整包${sj.gold}金 副本数=${sj.envCount}`);
  for (const e of sj.envs) {
    console.log(`      ${e.id} 贡献=${Math.round(e.value)} ${e.tier} ${e.bestTeamGold}金 av=${e.actionValue} `
      + `证据版本=${e.evidenceSeason} 不参与${e.absentSeasons}/0分${e.droppedSeasons}`);
  }
}
