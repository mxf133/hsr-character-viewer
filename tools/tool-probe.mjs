// Inspect the HSR endpoints that work without the public flag, and probe the
// privacy toggle. Usage: node tools/tool-probe.mjs <gameUid> <cookieFile>
import { readFileSync } from 'node:fs';
import { createDS } from '../src/mihoyo/ds.js';
import { communityHeaders, request, parseCookieHeader } from '../src/mihoyo/http.js';
import { APP_VERSION, ENDPOINTS } from '../src/mihoyo/constants.js';

const uid = process.argv[2];
const cookieFile = process.argv[3];
const cookie = parseCookieHeader(readFileSync(cookieFile, 'utf8'));
const server = 'prod_gf_cn';
const base = ENDPOINTS.gameRecord;
const origin = 'https://api-takumi-record.mihoyo.com';

const call = async (path, { method = 'GET', query, body } = {}) => {
  const q = query ?? `role_id=${uid}&server=${server}`;
  const url = `${base}/${path}${q ? `?${q}` : ''}`;
  const headers = communityHeaders({
    'x-rpc-page': `${APP_VERSION}_#/sr`,
    DS: createDS({ query: q, body }),
  });
  const res = await request(url, { method, headers, body, cookie, origin });
  return { status: res.status, json: res.json };
};

console.log('===== GET /tool =====');
try {
  const r = await call('tool');
  console.log(JSON.stringify(r.json, null, 2).slice(0, 1500));
} catch (e) { console.log('ERR', e.message); }

console.log('\n===== GET /role/basicInfo (完整) =====');
try {
  const r = await call('role/basicInfo');
  console.log(JSON.stringify(r.json, null, 2));
} catch (e) { console.log('ERR', e.message); }

console.log('\n===== GET /note =====');
try {
  const r = await call('note');
  console.log(JSON.stringify(r.json, null, 2).slice(0, 600));
} catch (e) { console.log('ERR', e.message); }

console.log('\n===== 尝试设置战绩公开（探测是否存在） =====');
// Guess at the visibility toggle. GET /index returned 10035, so try POSTs that
// mirror the Genshin "set_recommend_prop" style of write endpoints.
const toggles = [
  ['index', 'POST', { role_id: String(uid), server, is_public: true }],
  ['set_public', 'POST', { role_id: String(uid), server, is_public: true }],
  ['role/setPublic', 'POST', { role_id: String(uid), server, is_public: true }],
  ['privacy/set', 'POST', { role_id: String(uid), server, is_public: true }],
];
for (const [path, method, body] of toggles) {
  try {
    const r = await call(path, { method, body, query: '' });
    console.log(`  POST /${path} -> HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);
  } catch (e) {
    console.log(`  POST /${path} -> ERR ${e.message} retcode=${e.retcode}`);
  }
  await new Promise((r) => setTimeout(r, 400));
}

console.log('\n===== 官方战绩页是否提供公开开关 =====');
const page = await request('https://webstatic.mihoyo.com/app/community-game-records/index.html?bbs_presentation_style=fullscreen&bbs_auth_required=true&game_id=8#/sr', {});
console.log('page HTTP', page.status, 'len', page.text.length);
const bundleMatch = page.text.match(/bundle_[a-f0-9]+\.js/);
console.log('bundle:', bundleMatch ? bundleMatch[0] : '(none)');
if (bundleMatch) {
  const js = await request(`https://webstatic.mihoyo.com/app/community-game-records/${bundleMatch[0]}`, {});
  const terms = ['is_public', 'setPublic', 'public_record', '10035', '未公开', '展示设置', '公开'];
  for (const term of terms) {
    const idx = js.text.indexOf(term);
    console.log(`  ${term.padEnd(14)} ${idx >= 0 ? `出现 ${(js.text.match(new RegExp(term, 'g')) || []).length} 次` : '未出现'}`);
  }
}
