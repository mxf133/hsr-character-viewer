// Find `geetestApi` and the full risk endpoints the official Star Rail page uses.
//
// The official flow is NOT card/wapi/createVerification (that is Snap Hutao's
// Genshin path). It is:
//   POST ${geetestApi}/toolcomsrv/risk/createGeetest  {is_high:true, app_key:"hkrpg_game_record"}
//   POST ${geetestApi}/toolcomsrv/risk/verifyGeetest  {...getValidate(), app_key:"hkrpg_game_record"}
// with x-rpc-challenge_game / _path / _trace passed as HEADERS.
import { readFileSync } from 'node:fs';

const src = readFileSync('snapref/sr-bundle/bundle.js', 'utf8');

console.log('=== 所有 toolcomsrv 端点 ===');
for (const m of src.matchAll(/["'`][^"'`]*toolcomsrv[^"'`]*["'`]/g)) {
  console.log('  ' + m[0]);
}

console.log('\n=== geetestApi 的定义 ===');
let idx = 0;
let n = 0;
while ((idx = src.indexOf('geetestApi', idx)) >= 0 && n < 6) {
  console.log(`\n--- @${idx} ---`);
  console.log(src.slice(Math.max(0, idx - 400), idx + 300));
  idx += 'geetestApi'.length;
  n += 1;
}

console.log('\n=== 可能的 api 域名常量 ===');
const hosts = new Set();
for (const m of src.matchAll(/https?:\/\/[a-z0-9.\-]*(?:mihoyo|hoyolab|geetest)[a-z0-9.\-]*/gi)) hosts.add(m[0]);
for (const h of [...hosts].sort()) console.log('  ' + h);

console.log('\n=== apiBase / debugUrl 之类的配置 ===');
for (const key of ['apiBase', 'debugUrl', 'geetestApi', 'riskApi']) {
  const i = src.indexOf(`${key}:`);
  if (i >= 0) {
    console.log(`\n--- ${key} ---`);
    console.log(src.slice(Math.max(0, i - 200), i + 260));
  }
}
