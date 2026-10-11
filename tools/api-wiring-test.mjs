// Verify the API/client wiring against the live services without credentials:
// correct signing yields "Please login" (retcode 10001); bad signing yields
// "invalid request" (retcode -10001).
import {
  getPlayerIndex, getRoleBasicInfo, getAvatarInfo, getChallenge, getRogue,
} from '../src/mihoyo/starrail.js';
import { fetchGameRoles, normalizeManualCookie } from '../src/mihoyo/auth.js';
import { createDS, sortQuery, canonicalBody } from '../src/mihoyo/ds.js';

const uid = '100000000';
const server = 'prod_gf_cn';
const cookie = { cookie_token: 'x', account_id: '1' };

const label = (result) => {
  if (result.ok) return 'RETURNED DATA';
  return `retcode=${result.retcode} message=${result.message}`;
};

const run = async (name, fn) => {
  try {
    const data = await fn();
    console.log(`ok    ${name}: ${label({ ok: true })} (${JSON.stringify(data).slice(0, 60)})`);
  } catch (err) {
    const retcode = err.retcode;
    const verdict = retcode === -10001 ? 'SIGNING BROKEN' : 'signed ok';
    console.log(`${retcode === -10001 ? 'FAIL' : 'ok  '} ${name}: retcode=${retcode} ${err.message} [${verdict}]`);
  }
};

console.log('--- DS helpers ---');
console.log('sortQuery:', sortQuery('server=prod_gf_cn&role_id=100000000'));
console.log('canonicalBody:', canonicalBody({ b: 1, a: { d: 2, c: 3 } }));
console.log('createDS GET :', createDS({ query: 'role_id=1&server=x', timestamp: 1700000000, nonce: 123456 }));
console.log('createDS POST:', createDS({ body: { role_id: '1', server: 'x', need_wiki: false }, timestamp: 1700000000, nonce: 123456 }));
console.log('');

console.log('--- live endpoint wiring (no credentials) ---');
await run('index', () => getPlayerIndex(uid, server, { cookie }));
await run('role/basicInfo', () => getRoleBasicInfo(uid, server, { cookie }));
await run('avatar/info', () => getAvatarInfo(uid, server, { cookie }));
await run('challenge', () => getChallenge(uid, server, 1, { cookie }));
await run('rogue', () => getRogue(uid, server, 1, { cookie }));
await run('getUserGameRolesByCookie', () => fetchGameRoles(cookie));

console.log('\n--- manual cookie parsing ---');
const raw = 'ltuid=123; ltmid_v2=abc; cookie_token=deadbeef; account_id=456; unused=zz';
console.log(JSON.stringify(normalizeManualCookie(raw)));
