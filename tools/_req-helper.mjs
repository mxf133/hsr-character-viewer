// How does the official page actually send createGeetest?
// `k.a` (module 7) is a request helper; a 405 means this call is a GET, so the
// body I sent was ignored. Inspect module 7 and 3 for the verb/param handling.
import { readFileSync } from 'node:fs';

const src = readFileSync('snapref/sr-bundle/bundle.js', 'utf8');

const dump = (needle, before = 200, after = 2600, limit = 2) => {
  console.log(`\n=================== ${needle} ===================`);
  let i = 0;
  let n = 0;
  while ((i = src.indexOf(needle, i)) >= 0 && n < limit) {
    console.log(`--- @${i} ---`);
    console.log(src.slice(Math.max(0, i - before), Math.min(src.length, i + after)));
    console.log('');
    i += needle.length;
    n += 1;
  }
  if (!n) console.log('(未找到)');
};

dump('7:function', 0, 1800, 1);
dump('3:function', 0, 1800, 1);

console.log('\n=== 页面里所有 {data:..., headers:...} 形式的调用 ===');
for (const m of src.matchAll(/\{data:[^}]{0,80}\}/g)) {
  console.log('  ' + m[0]);
}

console.log('\n=== createGeetest 附近（看调用上下文/动词）===');
const i = src.indexOf('/toolcomsrv/risk/createGeetest');
console.log(src.slice(Math.max(0, i - 1200), i + 600));
