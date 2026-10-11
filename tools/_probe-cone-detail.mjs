// 探针：查 StarRailRes 里 "Memory's Curtain Never Falls" 的完整条目。
// 用法：node tools/_probe-cone-detail.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const paths = ['.snapref/starrailres-en-lightcones.json', 'snapref/starrailres-en-lightcones.json'];
let table = null;
for (const p of paths) {
  try { table = JSON.parse(await readFile(join(ROOT, p), 'utf8')); console.log('用', p); break; } catch { /* next */ }
}
if (!table) { console.log('找不到 StarRailRes 光锥表'); process.exit(0); }
const entries = Object.entries(table);
console.log('条目数', entries.length);
const hit = entries.find(([, v]) => v?.name === "Memory's Curtain Never Falls");
console.log('命中', JSON.stringify(hit, null, 1));
// 看看同一个 5★ 里其他锥有没有类似的「免费」线索字段
const fiveStar = entries.filter(([, v]) => Number(v?.rarity) === 5).slice(0, 2);
console.log('5★ 样例键:', JSON.stringify(fiveStar, null, 1).slice(0, 1500));
