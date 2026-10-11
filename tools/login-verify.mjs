// Full end-to-end login verification, in one process:
//   1. create a QR ticket and render it as a PNG for scanning
//   2. poll until Confirmed (single, serialized polling - no double consumer)
//   3. complete the token exchange and report every cookie received
//   4. verify the resulting cookie actually works against the record API
//   5. try which cookie variant the record API accepts
//
// Run: node tools/login-verify.mjs
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createQRCode } from '../src/qr/qrcode.js';
import { startQrLogin, pollQrLogin, getSession, fetchGameRoles } from '../src/mihoyo/auth.js';
import { getPlayerIndex, getRoleBasicInfo } from '../src/mihoyo/starrail.js';
import { serializeCookies } from '../src/mihoyo/http.js';
import { regionFromUid } from '../src/mihoyo/constants.js';

const writePng = (url, out) => {
  const qr = createQRCode(url, { level: 'M' });
  const scale = 9; const margin = 4; const n = qr.moduleCount;
  const size = (n + margin * 2) * scale;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y += 1) {
    raw[p++] = 0;
    for (let x = 0; x < size; x += 1) {
      const mx = Math.floor(x / scale) - margin;
      const my = Math.floor(y / scale) - margin;
      const dark = mx >= 0 && my >= 0 && mx < n && my < n ? qr.isDark(my, mx) : false;
      raw[p++] = dark ? 11 : 255; raw[p++] = dark ? 15 : 255; raw[p++] = dark ? 26 : 255;
    }
  }
  const table = (() => { const a = []; for (let k = 0; k < 256; k += 1) { let c = k; for (let i = 0; i < 8; i += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; a[k] = c >>> 0; } return a; })();
  const crc = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = table[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const T = Buffer.from(t, 'ascii'); const C = Buffer.alloc(4); C.writeUInt32BE(crc(Buffer.concat([T, d]))); return Buffer.concat([l, T, d, C]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(size, 0); ih.writeUInt32BE(size, 4); ih[8] = 8; ih[9] = 2;
  writeFileSync(out, Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
};

const { id, url } = await startQrLogin();
const session = getSession(id);
const png = join(tmpdir(), 'hsr-login-verify.png');
writePng(url, png);
console.log('='.repeat(72));
console.log('请用米游社 App 扫描并确认:');
console.log('   ', png);
console.log('='.repeat(72));
console.log('(等待扫码，最多 5 分钟；二维码约 2 分钟内需扫完)\n');

let confirmed = null;
const start = Date.now();
for (let i = 0; i < 200 && !confirmed; i += 1) {
  const t = ((Date.now() - start) / 1000).toFixed(0);
  try {
    const r = await pollQrLogin(id);
    if (r.status !== 'Created') console.log(`t=${t}s -> ${JSON.stringify(r)}`);
    if (r.status === 'Confirmed') confirmed = r;
    else if (r.status === 'Expired' || r.status === 'Cancelled') {
      console.log(`t=${t}s 失败: ${r.message}`);
      process.exit(1);
    }
  } catch (err) {
    console.log(`t=${t}s 异常: ${err.message} (retcode=${err.retcode})`);
    process.exit(1);
  }
  if (!confirmed) await new Promise((r) => setTimeout(r, 1500));
}

if (!confirmed) { console.log('超时，未扫码'); process.exit(1); }

console.log('\n=== 登录成功 ===');
console.log('account :', JSON.stringify(confirmed.account));
console.log('\n收到全部 cookie 名称:', Object.keys(session.cookies).sort().join(', '));
console.log('\nrecordCookie（将用于战绩接口）:');
console.log(JSON.stringify(
  Object.fromEntries(Object.entries(session.recordCookie || {}).map(([k, v]) => [k, String(v).slice(0, 12) + '…'])),
  null, 2,
));
console.log('exchangeError:', session.exchangeError || '(none)');

// ---- verify against the record API -------------------------------------
console.log('\n=== 验证战绩接口 ===');
let gameUid = null;
let server = 'prod_gf_cn';
try {
  const roles = await fetchGameRoles(session.recordCookie, session.deviceId);
  console.log(`角色列表: ${roles.length} 个`);
  for (const role of roles) {
    console.log(`  - ${role.nickname} UID=${role.game_uid} Lv.${role.level} region=${role.region}`);
  }
  gameUid = roles[0]?.game_uid ? String(roles[0].game_uid) : null;
  server = roles[0]?.region || server;
  if (gameUid) {
    // Persist the cookie so tools/record-probe.mjs can be run afterwards.
    const dump = join(tmpdir(), 'hsr-record-cookie.txt');
    writeFileSync(dump, serializeCookies(session.recordCookie), 'utf8');
    console.log(`\n(已保存 cookie 供后续探测: ${dump})`);
    console.log(`(游戏 UID = ${gameUid}  ≠  米游社 account_id = ${session.cookies.account_id})`);
  }
} catch (err) {
  console.log('角色列表失败:', err.message, `retcode=${err.retcode}`);
}

// The record API needs the GAME uid from the role list, never the account id.
if (gameUid) {
  for (const [label, fn] of [['role/basicInfo', getRoleBasicInfo], ['index', getPlayerIndex]]) {
    try {
      const data = await fn(gameUid, server, { cookie: session.recordCookie, deviceId: session.deviceId });
      console.log(`${label}: OK -> ${JSON.stringify(data).slice(0, 130)}`);
    } catch (err) {
      console.log(`${label}: ${err.message} (retcode=${err.retcode})`);
    }
  }
} else {
  console.log('\n(没有可用游戏 UID，跳过战绩接口验证)');
}

// ---- which cookie variant does the API accept? -------------------------
console.log('\n=== 探测战绩接口接受的 cookie 组合 ===');
const c = session.recordCookie || {};
const probeUid = gameUid || '100000000';
const variants = {
  '完整 recordCookie': c,
  '仅 v1 (cookie_token+account_id)': { cookie_token: c.cookie_token, account_id: c.account_id },
  '仅 v2': { cookie_token_v2: c.cookie_token_v2, account_id_v2: c.account_id_v2 },
  'v1 token + v2 account': { cookie_token: c.cookie_token, account_id_v2: c.account_id_v2 },
  'v2 token + v1 account': { cookie_token_v2: c.cookie_token_v2, account_id: c.account_id },
  'ltuid 体系': { cookie_token: c.cookie_token, ltuid: c.ltuid, ltmid_v2: c.ltmid_v2, cookie_token_v2: c.cookie_token_v2 },
};
for (const [label, cookie] of Object.entries(variants)) {
  const names = Object.keys(cookie).filter((k) => cookie[k]);
  if (names.length === 0) { console.log(`  ${label}: (缺少字段，跳过)`); continue; }
  try {
    await getRoleBasicInfo(probeUid, server, { cookie, deviceId: session.deviceId });
    console.log(`  ${label} [${names.join('+')}]: 接受 ✓`);
  } catch (err) {
    console.log(`  ${label} [${names.join('+')}]: retcode=${err.retcode} ${String(err.message).slice(0, 60)}`);
  }
  await new Promise((r) => setTimeout(r, 400));
}

console.log('\n=== cookie 总长度 ===');
console.log('recordCookie header 长度:', serializeCookies(session.recordCookie).length);
