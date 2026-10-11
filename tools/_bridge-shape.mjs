// Extract how the official Star Rail page talks to the miHoYo app WebView
// bridge, so a faithful shim can be injected via Chrome DevTools Protocol.
//
// The page bails out (and issues ZERO requests) unless `$bbsApp.appVersion` is
// truthy, so stubbing the bridge is the only way to run the real page in a
// normal browser.
import { readFileSync } from 'node:fs';

const src = readFileSync('snapref/sr-bundle/bundle.js', 'utf8');

const around = (needle, before = 500, after = 700, limit = 3) => {
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
  if (!n) console.log('(no match)');
};

around('$postMessage2App("getHTTPRequestHeaders"', 700, 900, 2);
around('$postMessage2App("getDS2"', 800, 500, 2);

console.log('\n=================== 桥对象的初始化/默认实现 ===================');
for (const m of src.matchAll(/prototype\.\$bbsApp\s*=\s*[^;]{0,200}/g)) {
  console.log(`  ${m[0].slice(0, 200)}\n`);
}

console.log('\n=================== onScreenshot / 其他默认实现 ===================');
for (const name of ['onScreenshot', 'getStatusBarHeight', 'isIOS', 'toLogin', 'getCookieToken']) {
  const i = src.indexOf(`$bbsApp.${name}`);
  if (i >= 0) {
    console.log(`--- ${name} @${i} ---`);
    console.log(src.slice(Math.max(0, i - 160), i + 260));
    console.log('');
  }
}
