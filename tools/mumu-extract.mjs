// Parse the miHoYo app WebView's Cookies SQLite file and pull the values the
// app actually sends.
//
// Context: the app's H5 SDK stores its own request headers under the
// Local Storage key MIHOYO_H5LOG_production_plat_account_web_sdk_cn, which
// revealed an `x-rpc-app_id` (cwk gxatrexhc) different from the web one
// (bll8iq97cem8) this project had been using.
//
// Usage: node tools/mumu-extract.mjs [dumpDir]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || 'C:\\mumudump\\mhydump';
const cookiesPath = join(dir, 'app_webview', 'Default', 'Cookies');

if (!existsSync(cookiesPath)) {
  console.error(`找不到 Cookies 文件: ${cookiesPath}`);
  process.exit(1);
}

const buf = readFileSync(cookiesPath);
console.log(`Cookies 文件 ${buf.length} bytes\n`);

/**
 * Chromium's cookie DB is an SQLite file, but rather than depend on a SQLite
 * driver we scan for the plaintext records: host_key / name / value appear as
 * NUL-separated strings inside each row. This is read-only forensics on a file
 * the user owns, not a general-purpose parser.
 */
const text = buf.toString('latin1');

// Every row starts with the host key; capture the triples we care about.
const names = ['cookie_token', 'ltoken', 'ltuid', 'account_id', 'ltmid'];
const found = new Map();

for (const name of names) {
  const re = new RegExp(`${name}\\x00([\\x20-\\x7e]{8,700}?)\\x00`, 'g');
  let m;
  let n = 0;
  while ((m = re.exec(text)) !== null && n < 6) {
    const value = m[1];
    if (!value || value.length < 8) continue;
    if (!found.has(name)) found.set(name, []);
    found.get(name).push(value);
    n += 1;
  }
}

console.log('=================== WebView 里的 cookie 值 ===================');
for (const [name, values] of found) {
  console.log(`\n${name}:`);
  for (const v of values) console.log(`   ${v.slice(0, 90)}${v.length > 90 ? '…' : ''}`);
}

// Hosts present, to confirm which domains the app is logged in on.
console.log('\n=================== 出现的域名 ===================');
const hosts = new Set();
for (const m of text.matchAll(/[a-z0-9.\-]{4,40}\.mihoyo\.com/g)) hosts.add(m[0]);
for (const h of [...hosts].sort()) console.log(`  ${h}`);

// Which WebView profile directory holds the record page cache?
console.log('\n=================== Local Storage 里的 SDK 头 ===================');
const lsPath = join(dir, 'app_webview', 'Default', 'Local Storage', 'leveldb', '000003.log');
if (existsSync(lsPath)) {
  const ls = readFileSync(lsPath, 'utf8');
  const i = ls.indexOf('x-rpc-device_fp');
  if (i >= 0) {
    console.log(ls.slice(Math.max(0, i - 1200), i + 900).replace(/\\/g, ''));
  } else {
    console.log('(未找到 x-rpc-device_fp)');
  }
} else {
  console.log('(无 Local Storage)');
}
