// Read the full record-card state for the account, including every
// `data_switches` entry. The card is served even when the detailed record
// endpoints answer 10035, so it is the only window into the account's
// visibility configuration.
//
// Also asks the endpoint for the card of a public third-party UID for contrast,
// which shows what a genuinely public record looks like.
import { readFileSync } from 'node:fs';
import { createDS } from '../src/mihoyo/ds.js';
import { APP_VERSION } from '../src/mihoyo/constants.js';

const account = JSON.parse(readFileSync('data/accounts.json', 'utf8')).accounts[0];
const wait = (ms = 3500) => new Promise((r) => setTimeout(r, ms));

const cookieHeader = Object.entries(account.cookie)
  .filter(([k]) => ['cookie_token', 'ltoken', 'ltuid', 'account_id'].includes(k))
  .map(([k, v]) => `${k}=${v}`).join('; ');

const getCard = async (uid) => {
  const query = `uid=${uid}`;
  const headers = {
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/${APP_VERSION}`,
    Accept: 'application/json',
    'x-rpc-app_version': APP_VERSION,
    'x-rpc-client_type': '5',
    'x-rpc-device_id': account.deviceId,
    ...(account.fingerprint ? { 'x-rpc-device_fp': account.fingerprint } : {}),
    Referer: 'https://webstatic.mihoyo.com',
    'x-rpc-page': `${APP_VERSION}_#/rpg/roles`,
    Cookie: cookieHeader,
    DS: createDS({ query }),
  };
  const res = await fetch(
    `https://api-takumi-record.mihoyo.com/game_record/card/wapi/getGameRecordCard?${query}`,
    { headers },
  );
  return res.json();
};

console.log('=================== 自己的账号（account_id）===================');
const mine = await getCard(account.accountId);
console.log('retcode =', mine.retcode, mine.message);
for (const entry of mine.data?.list || []) {
  console.log(`\n--- ${entry.game_name} (game_id=${entry.game_id}) ---`);
  console.log(`  has_role   : ${entry.has_role}`);
  console.log(`  is_public  : ${entry.is_public}`);
  console.log(`  role_id    : ${entry.game_role_id}`);
  console.log(`  region     : ${entry.region}`);
  console.log(`  level      : ${entry.level}`);
  console.log('  data_switches:');
  for (const sw of entry.data_switches || []) {
    console.log(`     switch_id=${sw.switch_id}  ${sw.switch_name} = ${sw.is_public}`);
  }
  console.log('  h5_data_switches:');
  for (const sw of entry.h5_data_switches || []) {
    console.log(`     switch_id=${sw.switch_id}  ${sw.switch_name} = ${sw.is_public}`);
  }
  console.log(`  url        : ${entry.url}`);
}

console.log('\n=================== 对照：某个公开的第三方 UID ===================');
await wait();
const other = await getCard('100000001');
console.log('retcode =', other.retcode, other.message);
for (const entry of other.data?.list || []) {
  console.log(`  ${entry.game_name}  is_public=${entry.is_public}  ${entry.nickname}`);
}

console.log('\n=================== 用 getGameRecordCard 反推：能否查自己的其它 game_id ===================');
await wait();
console.log('（读取当前账号返回的星铁战绩开关）');
const g = await getCard(account.accountId);
for (const entry of g.data?.list || []) {
  console.log(`  game_id=${entry.game_id} ${entry.game_name}: is_public=${entry.is_public} switches=${(entry.data_switches || []).length}`);
}
console.log('done');
