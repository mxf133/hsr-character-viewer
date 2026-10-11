// Read (and optionally flip) the battle-record privacy switches using the
// account cookie. The official record page drives these through
// home/getGameRecordCard + home/changeDataSwitch.
//
//   node tools/datacard.mjs <cookieFile> [--set <switchId> <gameId> <true|false>]
import { readFileSync } from 'node:fs';
import { communityHeaders, request, parseCookieHeader } from '../src/mihoyo/http.js';
import { APP_VERSION } from '../src/mihoyo/constants.js';

const cookieFile = process.argv[2];
const cookie = parseCookieHeader(readFileSync(cookieFile, 'utf8'));
const args = process.argv.slice(3);
const setIndex = args.indexOf('--set');

const ORIGIN = 'https://api-takumi-record.mihoyo.com';
// This card endpoint takes the miyoushe ACCOUNT id as `uid`, not the game uid.
const accountId = cookie.account_id || cookie.account_id_v2 || cookie.ltuid || cookie.ltuid_v2;
const endpoints = [
  ['home/getGameRecordCard', `https://api-takumi-record.mihoyo.com/game_record/card/wapi/getGameRecordCard?uid=${accountId}`],
  ['home/getGameRecordCard (alt)', `https://api-takumi-record.mihoyo.com/game_record/card/api/getGameRecordCard?uid=${accountId}`],
];
console.log('account_id =', accountId);

const callApi = async (label, url, { method = 'GET', body } = {}) => {
  try {
    const res = await request(url, {
      method,
      headers: communityHeaders({ 'x-rpc-page': `${APP_VERSION}_#/sr` }),
      body,
      cookie,
      origin: ORIGIN,
    });
    console.log(`\n===== ${label} =====`);
    console.log(`HTTP ${res.status}`);
    const json = res.json;
    console.log(JSON.stringify(json, null, 2).slice(0, 4000));
    return json;
  } catch (err) {
    console.log(`\n===== ${label} ===== ERR ${err.message}`);
    return null;
  }
};

let card = null;
for (const [label, url] of endpoints) {
  const json = await callApi(label, url);
  if (json?.retcode === 0) { card = json; break; }
  await new Promise((r) => setTimeout(r, 400));
}

if (card?.data?.list) {
  console.log('\n########## 战绩模块开关状态 ##########');
  for (const game of card.data.list) {
    const name = game.game_name || game.game_id;
    const role = game.game_role || {};
    console.log(`\n【${name}】 角色: ${role.nickname || '?'} UID ${role.game_uid || '?'}`);
    const groups = [
      ['data_switches', game.data_switches],
      ['h5_data_switches', game.h5_data_switches],
    ];
    for (const [kind, list] of groups) {
      if (!Array.isArray(list) || list.length === 0) continue;
      console.log(`  ${kind}:`);
      for (const sw of list) {
        console.log(`    ${sw.is_public ? '公开 ✓' : '未公开 ✗'}  switch_id=${sw.switch_id}  ${sw.switch_name || ''}`);
      }
    }
  }
}

if (setIndex >= 0) {
  const [, switchId, gameId, value] = args.slice(setIndex);
  console.log(`\n=== 尝试设置 switch_id=${switchId} game_id=${gameId} is_public=${value} ===`);
  const url = 'https://api-takumi-record.mihoyo.com/game_record/card/wapi/changeDataSwitch';
  const res = await request(url, {
    method: 'POST',
    headers: communityHeaders({ 'x-rpc-page': `${APP_VERSION}_#/sr` }),
    body: { is_public: value === 'true', switch_id: Number(switchId), game_id: Number(gameId) },
    cookie,
    origin: ORIGIN,
  });
  console.log(`HTTP ${res.status}`, JSON.stringify(res.json));
} else {
  console.log('\n(只读模式。加 --set <switchId> <gameId> true 可尝试打开公开)');
}
