// Probe which HSR record endpoints work WITHOUT the "public battle record"
// flag (retcode 10035), using a real cookie. Endpoints that do not exist on
// this host answer "404 page not found"; endpoints that exist but need auth
// answer 10001 "Please login"; endpoints that exist and accept the cookie
// either return data or 10035 (needs the public flag).
//
//   node tools/endpoint-matrix.mjs <gameUid> <cookieFile>
import { readFileSync } from 'node:fs';
import { createDS } from '../src/mihoyo/ds.js';
import { communityHeaders, request, parseCookieHeader } from '../src/mihoyo/http.js';
import { APP_VERSION, ENDPOINTS } from '../src/mihoyo/constants.js';

const uid = process.argv[2];
const cookieFile = process.argv[3];
if (!uid || !cookieFile) {
  console.error('用法: node tools/endpoint-matrix.mjs <gameUid> <cookieFile>');
  process.exit(2);
}
const cookie = parseCookieHeader(readFileSync(cookieFile, 'utf8'));
const server = 'prod_gf_cn';

// Candidate paths: verified ones plus plausible alternatives to discover what
// else exists. Both GET and POST are tried where the verb is unclear.
const candidates = [
  ['index', 'GET'],
  ['role/basicInfo', 'GET'],
  ['avatar/info', 'GET'],
  ['avatar/info', 'POST'],
  ['challenge', 'GET'],
  ['rogue', 'GET'],
  ['dailyNote', 'GET'],
  ['daily_note', 'GET'],
  ['note', 'GET'],
  ['role', 'GET'],
  ['avatar', 'GET'],
  ['achievement', 'GET'],
  ['activities', 'GET'],
  ['act_calendar', 'GET'],
  ['hard_challenge', 'GET'],
  ['role_combat', 'GET'],
  ['tps', 'GET'],
  ['tool', 'GET'],
  ['abyss', 'GET'],
  ['character', 'GET'],
  ['character/list', 'POST'],
  ['character/detail', 'POST'],
];

const base = ENDPOINTS.gameRecord;
const results = [];

for (const [path, method] of candidates) {
  const query = `role_id=${uid}&server=${server}`;
  const url = `${base}/${path}?${query}`;
  const headers = communityHeaders({
    'x-rpc-page': `${APP_VERSION}_#/sr`,
    DS: createDS({ query }),
  });
  let line;
  try {
    const res = await request(url, {
      method, headers, cookie, origin: 'https://api-takumi-record.mihoyo.com',
    });
    if (res.status === 404) {
      line = '不存在 (404)';
    } else if (res.json) {
      const rc = res.json.retcode;
      const msg = String(res.json.message || '').slice(0, 26);
      line = `retcode=${rc} ${msg}`;
    } else {
      line = `HTTP ${res.status} 非 JSON`;
    }
  } catch (err) {
    line = `ERR ${err.message}`;
  }
  results.push([`${method} /${path}`, line]);
  console.log(`${(method + ' /' + path).padEnd(28)} ${line}`);
  await new Promise((r) => setTimeout(r, 350));
}

console.log('\n===== 汇总 =====');
const exists = results.filter(([, l]) => !l.startsWith('不存在'));
console.log(`存在的端点: ${exists.length}/${results.length}`);
for (const [name, line] of exists) {
  const tag = line.includes('10035') ? '需公开战绩'
    : line.includes('10001') ? '签名可用/需登录'
      : line.startsWith('retcode=0') ? '★ 可用'
        : '存在';
  console.log(`  ${name.padEnd(28)} ${tag}  (${line})`);
}
