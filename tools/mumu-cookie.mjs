// Extract the full cookie values the miHoYo app's WebView holds for .mihoyo.com.
//
// The Cookies file is real SQLite, but a minimal page scanner is enough: each
// record stores host_key, name and value as consecutive length-prefixed
// strings. Values are contiguous printable text between the host and the next
// field, so anchor on the host and read forward.
import { readFileSync, writeFileSync } from 'node:fs';

const p = 'C:\\mumudump\\mhydump\\app_webview\\Default\\Cookies';
const text = readFileSync(p).toString('latin1');

/** Pull `name`'s value for an exact host_key. */
const valueFor = (host, name) => {
  const re = new RegExp(
    `${host.replace(/\./g, '\\.')}${name}([\\x20-\\x7e]{10,900})`,
    'g',
  );
  const m = re.exec(text);
  return m ? m[1] : null;
};

const NAMES = ['cookie_token_v2', 'ltoken_v2', 'cookie_token', 'ltoken', 'ltuid_v2', 'account_id_v2', 'ltmid_v2'];

console.log('=================== .mihoyo.com 域的值 ===================');
const jar = {};
for (const name of NAMES) {
  const v = valueFor('.mihoyo.com', name);
  if (v) {
    // Cookie values end at the first non-token character; the v2 format is
    // base64-ish plus a `.CAE=` suffix.
    const cleaned = v.match(/^v2_[A-Za-z0-9_\-+/=.]{20,400}/)?.[0]
      || v.match(/^[A-Za-z0-9_\-+/=.]{10,400}/)?.[0]
      || v;
    jar[name] = cleaned;
    console.log(`\n${name} (${cleaned.length} 字符):`);
    console.log(`  ${cleaned}`);
  }
}

console.log('\n=================== 数字类字段 ===================');
for (const name of ['ltuid_v2', 'account_id_v2', 'ltmid_v2']) {
  const v = valueFor('.mihoyo.com', name);
  if (v) console.log(`  ${name}: ${v.match(/^[0-9a-z_]{3,40}/)?.[0] || v.slice(0, 40)}`);
}

// Build a usable Cookie header in the shape the native app uses.
const header = ['cookie_token_v2', 'ltoken_v2', 'ltuid_v2', 'account_id_v2', 'ltmid_v2']
  .filter((n) => jar[n])
  .map((n) => `${n}=${jar[n]}`)
  .join('; ');

if (header) {
  writeFileSync('C:\\mumudump\\app-cookie.txt', header, 'utf8');
  console.log(`\n已写出 C:\\mumudump\\app-cookie.txt（${header.length} 字符）`);
  console.log(`开头: ${header.slice(0, 90)}…`);
} else {
  console.log('\n没有组装出 cookie，检查正则或文件名');
}
