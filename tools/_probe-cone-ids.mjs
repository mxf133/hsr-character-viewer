// 探针：光锥 id 前缀与「限定跃迁」的关系（用户第 8 条的结构性判据）。
// 星穹铁道里 23xxx = 跃迁 5★，24xxx = 免费/商店/活动 5★，21xxx = 4★，20xxx/22xxx = 3★。
// 用法：node tools/_probe-cone-ids.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const table = JSON.parse(await readFile(join(ROOT, '.snapref/starrailres-en-lightcones.json'), 'utf8'));
const avail = JSON.parse(await readFile(join(ROOT, 'theherta/unit-availability.json'), 'utf8'));

const rows = Object.entries(table).map(([id, v]) => ({
  id, name: v.name, rarity: Number(v.rarity), prefix: String(id).slice(0, 2),
  limited: avail.lightCones?.[v.name]?.limited,
}));
const byPrefix = new Map();
for (const r of rows) {
  const k = `${r.prefix} (rarity ${r.rarity})`;
  if (!byPrefix.has(k)) byPrefix.set(k, []);
  byPrefix.get(k).push(r);
}
for (const [k, list] of [...byPrefix.entries()].sort()) {
  const lim = list.filter((r) => r.limited === true).length;
  console.log(`${k}: ${list.length} 个，其中标记限定 ${lim}`);
}
console.log('\n24xxx 全部（免费/商店/活动 5★）：');
for (const r of rows.filter((x) => x.prefix === '24').sort((a, b) => a.id.localeCompare(b.id))) {
  console.log(' ', r.id, r.name, '| rarity', r.rarity, '| limited=', r.limited);
}
console.log('\n被标为限定的非 23xxx：');
for (const r of rows.filter((x) => x.limited === true && x.prefix !== '23')) {
  console.log(' ', r.id, r.name, '| rarity', r.rarity);
}
console.log('\n23xxx 里被标为非限定：');
for (const r of rows.filter((x) => x.prefix === '23' && x.limited !== true)) {
  console.log(' ', r.id, r.name, '| rarity', r.rarity, '| limited=', r.limited);
}
