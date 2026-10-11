// How does the official Star Rail page pass `app_key` to createVerification?
import { readFileSync } from 'node:fs';

const src = readFileSync('snapref/sr-bundle/bundle.js', 'utf8');

const needle = 'app_key';
let idx = 0;
let n = 0;
console.log('=== app_key 上下文 ===');
while ((idx = src.indexOf(needle, idx)) >= 0 && n < 6) {
  console.log(`\n--- @${idx} ---`);
  console.log(src.slice(Math.max(0, idx - 600), idx + 400));
  idx += needle.length;
  n += 1;
}
if (!n) console.log('(bundle 里没有 app_key，可能在别的 chunk)');

// Also find how createVerify is invoked.
console.log('\n\n=== createVerify 调用点 ===');
idx = 0;
n = 0;
while ((idx = src.indexOf('createVerify', idx)) >= 0 && n < 4) {
  console.log(`\n--- @${idx} ---`);
  console.log(src.slice(Math.max(0, idx - 700), idx + 500));
  idx += 'createVerify'.length;
  n += 1;
}
