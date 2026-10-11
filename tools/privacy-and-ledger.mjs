// 1. Show how the official record bundle uses `is_public` (to locate the flag).
// 2. Test the Honkai Star Rail Trailblaze Calendar (开拓月历) ledger endpoints for
//    a non-gated data source.
//
//   node tools/privacy-and-ledger.mjs <gameUid> <cookieFile>
import { readFileSync } from 'node:fs';
import { communityHeaders, request, parseCookieHeader } from '../src/mihoyo/http.js';
import { APP_VERSION } from '../src/mihoyo/constants.js';
import { createDS } from '../src/mihoyo/ds.js';

const uid = process.argv[2];
const cookieFile = process.argv[3];
const cookie = parseCookieHeader(readFileSync(cookieFile, 'utf8'));

console.log('===== 官方战绩页 bundle 中 is_public 的上下文 =====');
const base = 'https://webstatic.mihoyo.com/app/community-game-records/';
const page = await request(`${base}index.html?bbs_presentation_style=fullscreen&game_id=8#/sr`, {});
const bundle = (page.text.match(/bundle_[a-f0-9]+\.js/) || [])[0];
if (bundle) {
  const js = await request(`${base}${bundle}`, {});
  let from = 0;
  let shown = 0;
  while (shown < 5) {
    const idx = js.text.indexOf('is_public', from);
    if (idx < 0) break;
    console.log(`--- @${idx} ---`);
    console.log(js.text.slice(Math.max(0, idx - 320), idx + 220).replace(/\s+/g, ' '));
    from = idx + 1;
    shown += 1;
  }
}

console.log('\n===== 开拓月历（Trailblaze Calendar）接口探测 =====');
// The /tool endpoint advertises this page; its data API may not be gated by
// the battle-record public flag.
const ledgerCandidates = [
  ['act-nap-api style (sr)', 'https://act-api-takumi.mihoyo.com/event/rpg_srledger/v1/detail'],
  ['webstatic api host', 'https://api-takumi.mihoyo.com/event/rpg_srledger/v1/detail'],
  ['hkrpg record host', 'https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/ledger'],
];
for (const [label, url] of ledgerCandidates) {
  try {
    const res = await request(url, {
      method: 'GET',
      headers: communityHeaders({ 'x-rpc-page': `${APP_VERSION}_#/sr` }),
      cookie,
      origin: 'https://api-takumi-record.mihoyo.com',
    });
    console.log(`  ${label}: HTTP ${res.status} ${String(res.text).slice(0, 160).replace(/\s+/g, ' ')}`);
  } catch (err) {
    console.log(`  ${label}: ERR ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}

// The ledger page itself may accept query parameters for the role.
console.log('\n===== 月历页面 =====');
const ledgerPage = 'https://webstatic.mihoyo.com/sr/event/rpg-srledger/index.html?mhy_game_role_required=hkrpg_cn&mhy_presentation_style=fullscreen';
try {
  const res = await request(ledgerPage, {});
  console.log(`HTTP ${res.status} len=${res.text.length}`);
  const scripts = [...res.text.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
  console.log('scripts:', scripts.join('\n         '));
  for (const s of scripts.slice(0, 6)) {
    const u = s.startsWith('http') ? s : new URL(s, ledgerPage).href;
    try {
      const js = await request(u, {});
      const apis = [...new Set([...js.text.matchAll(/["'`](\/[a-z0-9_]+\/[a-z0-9_/]*(?:detail|ledger|info)[a-z0-9_/]*)["'`]/gi)].map((m) => m[1]))];
      if (apis.length) console.log(`  ${u.split('/').pop()} -> ${apis.slice(0, 12).join(' , ')}`);
    } catch { /* ignore */ }
  }
} catch (err) {
  console.log('ERR', err.message);
}

console.log(`\n(使用的 uid=${uid}，DS 版本 ${APP_VERSION})`);
void createDS;
