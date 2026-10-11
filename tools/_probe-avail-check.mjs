// 探针：核对 24xxx 免费光锥的 limited 标记已被结构判据改掉（用户第 8 条）。
// 用法：node tools/_probe-avail-check.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const a = JSON.parse(await readFile(join(HERE, '..', 'theherta', 'unit-availability.json'), 'utf8'));
const names = [
  'Solitary Healing', 'Eternal Calculus', "Memory's Curtain Never Falls",
  'Elation Brimming With Blessings', 'On the Fall of an Aeon', 'Cruising in the Stellar Sea',
  'Texture of Memories', 'Night on the Milky Way', "But the Battle Isn't Over",
  "If Time Were a Flower", 'Welcome to the Galaxy City',
];
for (const n of names) console.log(`${n} => ${JSON.stringify(a.lightCones[n])}`);
console.log('version', a.version, '| freeConeIdPrefixes', JSON.stringify(a.freeConeIdPrefixes));
console.log('limited 光锥总数', Object.values(a.lightCones).filter((x) => x.limited === true).length);
const bad = Object.entries(a.lightCones)
  .filter(([, v]) => v.limited === true && String(v.id || '').startsWith('24'))
  .map(([k]) => k);
console.log('仍是限定、但 id 是 24xxx 的（应为空）:', bad);
