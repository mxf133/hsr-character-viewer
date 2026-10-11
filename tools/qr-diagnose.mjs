// One-shot diagnostic: create a QR ticket, render it as a PNG, then poll the
// scan status verbosely while printing every raw response.
//
//   node tools/qr-diagnose.mjs
//
// Scan the PNG it writes, then read the console output.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQRCode } from '../src/qr/qrcode.js';
import { startQrLogin, pollQrLogin, getSession } from '../src/mihoyo/auth.js';
import { APP_VERSION, ENDPOINTS } from '../src/mihoyo/constants.js';
import { communityHeaders, request } from '../src/mihoyo/http.js';

const writePng = (url, out) => {
  const qr = createQRCode(url, { level: 'M' });
  const scale = 9;
  const margin = 4;
  const n = qr.moduleCount;
  const size = (n + margin * 2) * scale;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y += 1) {
    raw[p++] = 0;
    for (let x = 0; x < size; x += 1) {
      const mx = Math.floor(x / scale) - margin;
      const my = Math.floor(y / scale) - margin;
      const dark = mx >= 0 && my >= 0 && mx < n && my < n ? qr.isDark(my, mx) : false;
      raw[p++] = dark ? 11 : 255;
      raw[p++] = dark ? 15 : 255;
      raw[p++] = dark ? 26 : 255;
    }
  }
  const table = (() => {
    const a = [];
    for (let k = 0; k < 256; k += 1) {
      let c = k;
      for (let i = 0; i < 8; i += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      a[k] = c >>> 0;
    }
    return a;
  })();
  const crc = (buf) => {
    let c = 0xFFFFFFFF;
    for (const byte of buf) c = table[(c ^ byte) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(out, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
  return { size, version: qr.version };
};

const { id, url } = await startQrLogin();
const session = getSession(id);
const out = join(tmpdir(), 'hsr-scan-now.png');
const png = writePng(url, out);

console.log('='.repeat(70));
console.log('请用米游社 App 扫描这个二维码图片:');
console.log('   ', out);
console.log('='.repeat(70));
console.log('ticket      :', session.ticket);
console.log('expire(sec) :', new URL(url).searchParams.get('expire'));
console.log('now(sec)    :', Math.floor(Date.now() / 1000));
console.log('PNG         :', `${png.size}x${png.size} (QR v${png.version})`);
console.log('APP_VERSION :', APP_VERSION);
console.log('poll URL    :', ENDPOINTS.queryQRLoginStatus);
console.log('\n开始轮询，每 2 秒一次，最长 5 分钟…\n');

const start = Date.now();
for (let i = 0; i < 150; i += 1) {
  const t = ((Date.now() - start) / 1000).toFixed(0);
  try {
    const res = await request(ENDPOINTS.queryQRLoginStatus, {
      method: 'POST',
      headers: communityHeaders({ 'x-rpc-device_id': session.deviceId }),
      origin: 'https://passport-api.miyoushe.com',
      body: { ticket: session.ticket },
      collectCookies: session.cookies,
    });
    const j = res.json || {};
    const status = j.data?.status ?? '(none)';
    const cookieNames = Object.keys(session.cookies).sort().join(',') || '(none)';
    console.log(`t=${t}s retcode=${j.retcode} status=${status} msg="${j.message}" scanned_at=${j.data?.scanned_at ?? '-'} cookies=[${cookieNames}]`);

    if (j.retcode === -3501 || j.retcode === -3505) {
      console.log('\n>>> 失败返回体全文:');
      console.log(JSON.stringify(j, null, 2));
      console.log('\n>>> 已收集的 cookie:', JSON.stringify(session.cookies, null, 2));
      break;
    }
    if (status === 'Confirmed') {
      console.log('\n>>> 已确认扫码，尝试完成登录…');
      const result = await pollQrLogin(id);
      console.log(JSON.stringify(result, null, 2));
      console.log('\n>>> 全部 cookie 名称:', Object.keys(session.cookies).sort().join(', '));
      console.log('>>> recordCookie:', JSON.stringify(session.recordCookie || null, null, 2));
      console.log('>>> exchangeError:', session.exchangeError || '(none)');
      break;
    }
  } catch (err) {
    console.log(`t=${t}s THREW ${err.message} retcode=${err.retcode}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('\n轮询结束。');
