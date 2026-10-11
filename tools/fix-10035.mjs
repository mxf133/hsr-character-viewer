// Investigate the 10035 contradiction: the official card reports the Star Rail
// record as public, but /game_record/app/hkrpg/api/index returns 10035.
//
// Tests, in order:
//   1. toggle 角色详情数据 off/on for Star Rail
//   2. re-test with several cookie identity variants
//   3. re-read the card to confirm the switch actually changed
//
//   node tools/fix-10035.mjs <cookieFile> [--apply]
import { readFileSync } from 'node:fs';
import { communityHeaders, request, parseCookieHeader, serializeCookies } from '../src/mihoyo/http.js';
import { APP_VERSION } from '../src/mihoyo/constants.js';
import { createDS } from '../src/mihoyo/ds.js';

const cookie = parseCookieHeader(readFileSync(process.argv[2], 'utf8'));
const APPLY = process.argv.includes('--apply');
const accountId = cookie.account_id || cookie.account_id_v2;
const SR_GAME_ID = 6;      // 崩坏：星穹铁道
const SR_UID = '100000000';
const ORIGIN = 'https://api-takumi-record.mihoyo.com';
const RECORD = `${ORIGIN}/game_record/app/hkrpg/api`;

const getCard = async () => {
  const res = await request(
    `${ORIGIN}/game_record/card/wapi/getGameRecordCard?uid=${accountId}`,
    { headers: communityHeaders({ 'x-rpc-page': `${APP_VERSION}_#/sr` }), cookie, origin: ORIGIN },
  );
  return (res.json?.data?.list || []).find((g) => g.game_id === SR_GAME_ID) || null;
};

const testIndex = async (label, testCookie) => {
  const query = `role_id=${SR_UID}&server=prod_gf_cn`;
  const res = await request(`${RECORD}/index?${query}`, {
    headers: communityHeaders({
      'x-rpc-page': `${APP_VERSION}_#/sr`,
      DS: createDS({ query }),
    }),
    cookie: testCookie,
    origin: ORIGIN,
  });
  const rc = res.json?.retcode;
  const ok = rc === 0;
  console.log(`  ${ok ? '★ 成功' : '·     '} ${label.padEnd(34)} retcode=${rc} ${String(res.json?.message || '').slice(0, 40)}`);
  return ok;
};

const setSwitch = async (switchId, isPublic) => {
  const res = await request(`${ORIGIN}/game_record/card/wapi/changeDataSwitch`, {
    method: 'POST',
    headers: communityHeaders({ 'x-rpc-page': `${APP_VERSION}_#/sr` }),
    body: { is_public: isPublic, switch_id: Number(switchId), game_id: SR_GAME_ID },
    cookie,
    origin: ORIGIN,
  });
  return { status: res.status, json: res.json };
};

console.log('===== 1. 星穹铁道 当前卡片状态 =====');
const before = await getCard();
if (!before) { console.log('未找到星穹铁道卡片'); process.exit(1); }
console.log('is_public:', before.is_public, '| 角色:', before.nickname, '| UID:', before.game_role_id);
for (const sw of before.data_switches || []) {
  console.log(`  switch_id=${sw.switch_id} ${sw.is_public ? '公开' : '未公开'}  "${sw.switch_name}"`);
}

console.log('\n===== 2. 当前接口状态 =====');
await testIndex('当前 recordCookie', cookie);
await testIndex('仅 v1 名字', { cookie_token: cookie.cookie_token, account_id: cookie.account_id });
await testIndex('account_id_v2 身份', { cookie_token: cookie.cookie_token, account_id: cookie.account_id_v2 });
await testIndex('ltuid 身份', { cookie_token: cookie.cookie_token, ltuid: cookie.ltuid });

if (!APPLY) {
  console.log('\n(只读。加 --apply 会尝试切换 switch_id=4 角色详情数据 关闭再打开)');
  process.exit(0);
}

console.log('\n===== 3. 切换 角色详情数据（关闭 → 重新打开） =====');
const roleSwitch = (before.data_switches || []).find((s) => s.switch_id === 4)
  || (before.data_switches || [])[1];
if (!roleSwitch) { console.log('未找到角色详情开关'); process.exit(1); }
console.log(`目标开关: switch_id=${roleSwitch.switch_id} "${roleSwitch.switch_name}"`);

for (const value of [false, true]) {
  const r = await setSwitch(roleSwitch.switch_id, value);
  console.log(`  changeDataSwitch is_public=${value} -> HTTP ${r.status} ${JSON.stringify(r.json)}`);
  await new Promise((res) => setTimeout(res, 800));
}

console.log('\n===== 4. 切换后卡片状态 =====');
const after = await getCard();
for (const sw of after?.data_switches || []) {
  console.log(`  switch_id=${sw.switch_id} ${sw.is_public ? '公开' : '未公开'}  "${sw.switch_name}"`);
}

console.log('\n===== 5. 切换后接口状态 =====');
let anyOk = false;
for (let i = 0; i < 3; i += 1) {
  process.stdout.write(`  第 ${i + 1} 次尝试: `);
  const ok = await testIndex('index', cookie);
  anyOk = anyOk || ok;
  if (ok) break;
  await new Promise((res) => setTimeout(res, 2000));
}
console.log(anyOk ? '\n>>> 公开开关生效了！' : '\n>>> 仍然 10035，说明该限制不由这个开关控制');
void serializeCookies;
