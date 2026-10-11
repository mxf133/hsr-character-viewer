// Print the environment module (webpack module 21) verbatim so `geetestApi` is
// readable in full.
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('snapref/sr-bundle/bundle.js', 'utf8');

const marker = 'r.d(t,"geetestApi"';
const i = src.indexOf(marker);
console.log(`geetestApi export @${i}`);
const start = src.lastIndexOf('21:function', i) >= 0 ? src.lastIndexOf('21:function', i) : Math.max(0, i - 1500);
const chunk = src.slice(start, start + 2600);
console.log('\n=== 环境模块原文 ===');
console.log(chunk);

// Pull out every "name"="value" pair from that module.
console.log('\n=== 解析出的常量 ===');
for (const m of chunk.matchAll(/var\s+([a-zA-Z])\s*=\s*"([^"]+)"/g)) {
  console.log(`  ${m[1]} = ${m[2]}`);
}

writeFileSync('snapref/sr-env-module.txt', chunk, 'utf8');
console.log('\n已写入 snapref/sr-env-module.txt');
