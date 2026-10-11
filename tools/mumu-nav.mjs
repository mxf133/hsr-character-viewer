// Drive the miHoYo app in the MuMu emulator to the Star Rail record page, then
// screenshot it - so we can see whether the OFFICIAL client shows the character
// list for this account.
//
// This is the one observation that separates "the account has no Star Rail
// record data" from "our client is missing something".
//
// Usage: node tools/mumu-nav.mjs [--step N]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ADB = 'C:\\Program Files\\Netease\\MuMu\\nx_device\\12.0\\shell\\adb.exe';
const DEV = '127.0.0.1:7555';
const OUT = 'C:\\mumudump';

const adb = (...args) => {
  try {
    return execFileSync(ADB, ['-s', DEV, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}` || String(err.message);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const shot = async (name) => {
  adb('shell', 'screencap -p /sdcard/_nav.png');
  const dst = `${OUT}\\${name}.png`;
  adb('pull', '/sdcard/_nav.png', dst);
  console.log(`  截图 -> ${dst}`);
};

/** Dump the current view hierarchy so we can find real tap targets. */
const dumpUi = async (name) => {
  adb('shell', 'uiautomator dump /sdcard/_ui.xml');
  const local = `${OUT}\\${name}.xml`;
  adb('pull', '/sdcard/_ui.xml', local);
  try {
    const xml = execFileSync('powershell', ['-NoProfile', '-Command', `Get-Content -Raw '${local}'`],
      { encoding: 'utf8' });
    writeFileSync(local, xml, 'utf8');
    return xml;
  } catch {
    return '';
  }
};

const tap = async (x, y, label) => {
  console.log(`  点击 ${label} @(${x},${y})`);
  adb('shell', `input tap ${x} ${y}`);
  await sleep(2500);
};

console.log('=== 回到 App 首页并截图 ===');
adb('shell', 'am start -n com.mihoyo.hyperion/.main.HyperionMainActivity');
await sleep(4000);
await shot('nav-00-home');

console.log('\n=== 拉取当前界面结构 ===');
const xml = await dumpUi('nav-ui');
// Show clickable nodes with their text so navigation is based on real UI.
const nodes = [...xml.matchAll(/<node[^>]*>/g)].map((m) => m[0]);
console.log(`  节点数: ${nodes.length}`);
let shown = 0;
for (const n of nodes) {
  const text = /text="([^"]*)"/.exec(n)?.[1] || '';
  const desc = /content-desc="([^"]*)"/.exec(n)?.[1] || '';
  const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n);
  if (!bounds || (!text && !desc)) continue;
  if (shown++ > 40) break;
  const [, x1, y1, x2, y2] = bounds;
  const cx = Math.round((+x1 + +x2) / 2);
  const cy = Math.round((+y1 + +y2) / 2);
  console.log(`  "${(text || desc).slice(0, 24)}"  @(${cx},${cy})`);
}

console.log('\n提示：用 --tap X Y 手动点击，例如 node tools/mumu-nav.mjs --tap 700 300');
const ti = process.argv.indexOf('--tap');
if (ti >= 0) {
  const x = Number(process.argv[ti + 1]);
  const y = Number(process.argv[ti + 2]);
  await tap(x, y, 'manual');
  await shot('nav-after-tap');
  const after = await dumpUi('nav-ui-after');
  console.log('\n=== 点击后界面上的文字 ===');
  const texts = [...after.matchAll(/text="([^"]{2,40})"/g)].map((m) => m[1]);
  console.log('  ' + [...new Set(texts)].slice(0, 40).join(' | '));
}
console.log('\ndone');
