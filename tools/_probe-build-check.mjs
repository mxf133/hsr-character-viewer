// 探针：核对重建后的 archive.json —— 成本下限修正的规模与前沿成本分布（用户第 8 条）。
// 用法：node tools/_probe-build-check.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const a = JSON.parse(await readFile(join(HERE, '..', 'theherta', 'archive.json'), 'utf8'));
console.log('counts', JSON.stringify(a.counts));
console.log('availability 里 24xxx 仍标限定的:',
  Object.entries(a.refs.availability.lightCones)
    .filter(([, v]) => v.limited === true && String(v.id || '').startsWith('24')).map(([k]) => k));
// teams 里 cost 的分布（3.1 混沌回忆，正是光锥缺失最严重的版本）
const moc = a.modes['Memory of Chaos'].stages[''].seasons;
for (const s of ['3.1', '3.2', '3.3', '4.4']) {
  const sd = moc[s];
  if (!sd) continue;
  const costs = (sd.teams || []).map((t) => t.sample?.cost ?? t.cost).filter((x) => Number.isFinite(x));
  const min = costs.length ? Math.min(...costs) : null;
  console.log(`${s}: 阵容 ${(sd.teams || []).length} 套, sample 成本最低 ${min}`);
}
