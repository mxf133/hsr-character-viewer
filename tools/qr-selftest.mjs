// Self-check for the QR encoder: encode -> decode -> compare.
// Run with: node tools/qr-selftest.mjs
import { createQRCode, toSVG } from '../src/qr/qrcode.js';
import { decodeMatrix } from '../src/qr/decode.js';

const payloads = [
  'HELLO',
  'https://user.mihoyo.com/login-platform/mobile.html?expire=1791132093&tk=718a7665-1998-4702-9883-3e570a988814&token_types=4#/login/qr',
  'https://user.mihoyo.com/qr_code_in_game.html?app_id=8&app_name=%E5%B4%A9%E5%9D%8F%3A%E6%98%9F%E7%A9%B9%E9%93%81%E9%81%93&bbs=true&biz_key=hkrpg_cn&expire=1791563965&ticket=6ac2813d258a48325f592ef2',
  'a'.repeat(200),
  '星穹铁道 Q R 码 测试 · スターレイル',
  JSON.stringify({ t: Date.now(), s: 'x'.repeat(80) }),
];

let failures = 0;
for (const text of payloads) {
  for (const level of ['L', 'M', 'Q', 'H']) {
    let qr;
    let decoded;
    try {
      qr = createQRCode(text, { level });
      decoded = decodeMatrix(qr.modules, qr.isDark);
    } catch (err) {
      failures += 1;
      console.log(`FAIL level=${level} len=${text.length} :: ${err.message}`);
      continue;
    }
    const ok = decoded.text === text
      && decoded.version === qr.version
      && decoded.level === qr.level
      && decoded.mask === qr.maskPattern;
    if (!ok) {
      failures += 1;
      console.log(`FAIL level=${level} len=${text.length} :: mismatch`
        + ` text=${decoded.text === text} v=${decoded.version}/${qr.version}`
        + ` lvl=${decoded.level}/${qr.level} mask=${decoded.mask}/${qr.maskPattern}`);
    } else {
      console.log(`ok   level=${level} v${qr.version} mask${qr.maskPattern} ${qr.moduleCount}x${qr.moduleCount} bytes=${new TextEncoder().encode(text).length}`);
    }
  }
}

// Also exercise the SVG renderer for obvious structural problems.
const qr = createQRCode(payloads[1], { level: 'M' });
const svg = toSVG(qr, { scale: 6, margin: 4 });
const rects = (svg.match(/<rect/g) || []).length;
const expectedSize = (qr.moduleCount + 8) * 6;
if (!svg.startsWith('<svg') || !svg.endsWith('</svg>')) { failures += 1; console.log('FAIL svg structure'); }
if (!svg.includes(`width="${expectedSize}"`)) { failures += 1; console.log('FAIL svg size'); }
console.log(`svg ok: rects=${rects} size=${expectedSize}`);

console.log(failures === 0 ? '\nALL QR SELF-TESTS PASSED' : `\n${failures} QR SELF-TEST FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
