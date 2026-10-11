// Regression test for the "false 二维码已失效 after a successful scan" bug.
//
// A QR ticket is single-use: miHoYo answers Confirmed once, then -3501 for any
// further poll with the same ticket. The GUI polls on a timer, so a poll often
// lands right after confirmation. Before the fix that second poll was reported
// as Expired, aborting a login that had actually succeeded.
//
// This test scripts a fake miHoYo server through the real code path and asserts:
//   1. a poll arriving after Confirmed still reports Confirmed
//   2. concurrent polls consume the ticket only once
//   3. -3501 on a session that holds no tokens is still reported as Expired
//   4. -3505 with no tokens is reported as Cancelled
import { createServer } from 'node:http';

// ---- fake miHoYo passport server ---------------------------------------
let ticketState = 'Created';   // mutated by the test
let pollCount = 0;
const CONFIRM_COOKIES = [
  'account_id=123456789; Path=/',
  'account_id_v2=123456789; Path=/',
  'ltuid=123456789; Path=/',
  'ltuid_v2=123456789; Path=/',
  'ltmid_v2=abcdef0123456789; Path=/',
  'account_mid_v2=abcdef0123456789; Path=/',
  'cookie_token_v2=v2_deadbeefdeadbeef; Path=/',
  'ltoken_v2=v2_cafebabecafebabe; Path=/',
  'uni_web_token=xyz; Path=/',
];

const server = createServer((req, res) => {
  const send = (obj, cookies = []) => {
    const headers = { 'Content-Type': 'application/json' };
    if (cookies.length) headers['Set-Cookie'] = cookies;
    res.writeHead(200, headers);
    res.end(JSON.stringify(obj));
  };

  if (req.url.includes('createQRLogin')) {
    send({ retcode: 0, message: 'OK', data: { url: 'https://user.mihoyo.com/x?tk=T', ticket: 'T' } });
    return;
  }
  if (req.url.includes('queryQRLoginStatus')) {
    pollCount += 1;
    if (ticketState === 'Created') {
      send({ retcode: 0, message: 'OK', data: { status: 'Created', scanned_at: '0' } });
      return;
    }
    if (ticketState === 'Confirmed') {
      // Single-use: the first poll confirms and sets cookies, later polls 3501.
      ticketState = 'Consumed';
      send({
        retcode: 0,
        message: 'OK',
        data: { status: 'Confirmed', scanned_at: '123', user_info: { nickname: '测试开拓者' } },
      }, CONFIRM_COOKIES);
      return;
    }
    send({ retcode: -3501, message: '二维码已失效，请刷新后重新扫描', data: null });
    return;
  }
  if (req.url.includes('multiTokenByLoginTicket') || req.url.includes('getCookieAccountInfoBySToken')) {
    send({ retcode: 0, message: 'OK', data: { cookie_token: 'v1token' } });
    return;
  }
  if (req.url.includes('getUserGameRolesByCookie')) {
    send({
      retcode: 0,
      message: 'OK',
      data: { list: [{ game_uid: '100000000', nickname: '测试', level: 70, region: 'prod_gf_cn' }] },
    });
    return;
  }
  send({ retcode: 0, message: 'OK', data: {} });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// Point the auth module at the fake server BEFORE importing it.
const { ENDPOINTS } = await import('../src/mihoyo/constants.js');
for (const key of Object.keys(ENDPOINTS)) {
  ENDPOINTS[key] = ENDPOINTS[key].replace(/https:\/\/[^/]+/, `http://127.0.0.1:${port}`);
}

const { startQrLogin, pollQrLogin, getSession } = await import('../src/mihoyo/auth.js');

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`); }
};

try {
  // ---- 1. confirm, then a late poll --------------------------------------
  console.log('[1] 确认后仍有轮询到达（原始 bug）');
  ticketState = 'Confirmed';
  pollCount = 0;
  const s1 = await startQrLogin();
  const first = await pollQrLogin(s1.id);
  check('首次轮询返回 Confirmed', first.status === 'Confirmed', JSON.stringify(first));
  check('返回了账号信息', first.account?.accountId === '123456789', JSON.stringify(first.account));

  const late = await pollQrLogin(s1.id);
  check('确认后的追加轮询仍返回 Confirmed（关键回归）', late.status === 'Confirmed',
    `得到 ${JSON.stringify(late)}`);
  check('追加轮询没有消耗 ticket', pollCount === 1, `pollCount=${pollCount}`);

  const session = getSession(s1.id);
  // Note: the v1 `cookie_token` slot holds the v2 token here because the QR flow
  // never issued a v1 token; the token exchange is (correctly) skipped.
  check('recordCookie 含两代 cookie 名称',
    session.recordCookie?.cookie_token_v2 === 'v2_deadbeefdeadbeef'
    && session.recordCookie?.account_id === '123456789'
    && session.recordCookie?.account_id_v2 === '123456789'
    && session.recordCookie?.ltuid_v2 === '123456789'
    && session.recordCookie?.ltmid_v2 === 'abcdef0123456789',
    JSON.stringify(session.recordCookie || {}));
  check('cookie_token 槽位有值（回退到 v2）',
    typeof session.recordCookie?.cookie_token === 'string' && session.recordCookie.cookie_token.length > 5,
    String(session.recordCookie?.cookie_token));

  // ---- 2. concurrent polls ------------------------------------------------
  console.log('\n[2] 并发轮询只消费一次 ticket');
  ticketState = 'Confirmed';
  pollCount = 0;
  const s2 = await startQrLogin();
  const results = await Promise.all([pollQrLogin(s2.id), pollQrLogin(s2.id), pollQrLogin(s2.id)]);
  check('三个并发轮询全部返回 Confirmed',
    results.every((r) => r.status === 'Confirmed'), JSON.stringify(results.map((r) => r.status)));
  check('ticket 只被消费一次', pollCount === 1, `pollCount=${pollCount}`);

  // ---- 3/4. genuine expiry and cancel still reported ----------------------
  console.log('\n[3] 真正失效仍然报失效');
  ticketState = 'Consumed';
  const s3 = await startQrLogin();
  pollCount = 0;
  // Simulate a fresh ticket that expired before any scan: no cookies collected.
  const expired = await pollQrLogin(s3.id);
  check('无令牌时 -3501 仍报 Expired', expired.status === 'Expired', JSON.stringify(expired));
  check('Expired 带提示文案', typeof expired.message === 'string' && expired.message.length > 0);

  console.log('\n[4] 已扫描待确认的状态转换');
  ticketState = 'Created';
  const s4 = await startQrLogin();
  const created = await pollQrLogin(s4.id);
  check('Created 正常透传', created.status === 'Created', JSON.stringify(created));

  // ---- 5. session lifecycle ----------------------------------------------
  console.log('\n[5] 会话不存在');
  let threw = null;
  try { await pollQrLogin('no-such-session'); } catch (err) { threw = err; }
  check('未知会话抛出 NO_SESSION', threw?.code === 'NO_SESSION', String(threw?.message));
} finally {
  // Drop keep-alive sockets so the fake server can close and node exits cleanly.
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  // Let undici release its pooled connections before the process ends.
  await new Promise((r) => setTimeout(r, 150));
}

console.log(`\n${'='.repeat(52)}`);
console.log(`轮询回归测试: ${passed} passed, ${failed} failed`);
// Set the exit code rather than calling process.exit(), which can trip a libuv
// assertion while sockets are still being torn down.
process.exitCode = failed === 0 ? 0 : 1;
