// Extract how the OFFICIAL record page initialises Geetest.
//
// This page's own captcha flow is the authoritative usage - my hand-written page
// creates the v3 widget but leaves it display:none (empty box), so copy the real
// configuration instead of guessing.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const files = [
  'snapref/ys-bundle/bundle.js',
  'snapref/sr-bundle/bundle.js',
];

const ensure = (p) => {
  if (existsSync(p)) return true;
  console.log(`(缺少 ${p}，跳过)`);
  return false;
};

const show = (src, needle, before = 400, after = 1400, limit = 3) => {
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

for (const f of files) {
  if (!ensure(f)) continue;
  console.log(`\n\n############ ${f} ############`);
  const src = readFileSync(f, 'utf8');

  console.log('\n--- Geetest 相关脚本 URL ---');
  for (const m of src.matchAll(/https?:\/\/[^"'\s]*geetest[^"'\s]*/g)) {
    console.log('  ' + m[0]);
  }

  show(src, 'initGeetest', 500, 1500, 2);

  console.log('\n--- 是否出现 product/bind/appendTo 配置 ---');
  for (const key of ['appendTo', "product:", 'product:', 'bind', 'popup', 'showCaptcha', 'getValidate']) {
    const c = (src.match(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    console.log(`  ${key.padEnd(14)} ${c}`);
  }
}
