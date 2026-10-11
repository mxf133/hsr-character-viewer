// 探针：检查这些光锥在 unit-availability.json 里的限定标记（用户第 8 条）。
// 用法：node tools/_probe-cones.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const a = JSON.parse(await readFile(join(HERE, '..', 'theherta', 'unit-availability.json'), 'utf8'));
const names = [
  'Dance Dance Dance', 'Memories of the Past', 'Resolution Shines As Pearls of Sweat',
  'Solitary Healing', 'Carve the Moon, Weave the Clouds', 'A Secret Vow',
  'Eyes of the Prey', 'Cruising in the Stellar Sea', "For Tomorrow's Journey",
  'Today Is Another Peaceful Day', "Memory's Curtain Never Falls",
];
for (const n of names) console.log(n, '=>', JSON.stringify(a.lightCones?.[n] ?? null));
console.log('--- lightCones 总数', Object.keys(a.lightCones || {}).length);
console.log('--- limited=true 的个数', Object.values(a.lightCones || {}).filter((x) => x.limited === true).length);
