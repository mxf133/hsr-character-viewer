// 探针：archive.json 的 refs（图标 / 预览图）与本地可用性（用户第 2、3 条要图片）。
// 用法：node tools/_probe-refs.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const a = JSON.parse(await readFile(join(HERE, '..', 'theherta', 'archive.json'), 'utf8'));
console.log('refs 键:', Object.keys(a.refs || {}));
for (const [k, v] of Object.entries(a.refs || {})) {
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    console.log(`  ${k}: ${keys.length} 项，样例 ${JSON.stringify(v[keys[0]])}`);
    console.log(`     样例键: ${keys.slice(0, 5).join(', ')}`);
  } else {
    console.log(`  ${k}: ${JSON.stringify(v)}`);
  }
}
// 找一张角色图和一个光锥图的实际 URL
const pick = (obj, names) => names.map((n) => [n, obj?.[n]]).filter(([, v]) => v);
console.log('\n角色图样例:', JSON.stringify(pick(a.refs?.icons?.characters, ['Silver Wolf LV.999', 'Cyrene', 'Tribbie'])));
console.log('光锥图样例:', JSON.stringify(pick(a.refs?.icons?.previews, ['Welcome to the Galaxy City', "If Time Were a Flower", 'Dance Dance Dance'])));
console.log('光锥 icon 样例:', JSON.stringify(pick(a.refs?.icons?.lightCones, ['Welcome to the Galaxy City', "If Time Were a Flower"])));
console.log('\nrefs 全量结构:', JSON.stringify(a.refs, null, 1).slice(0, 1200));
