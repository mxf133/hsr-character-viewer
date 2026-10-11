// Tap the Star Rail game card on the app's profile page to open its record page,
// then report whether the "账号可能存在异常" verification appears.
//
// Tapping the card is the in-app route to the record page (the deep link
// android.intent.action.VIEW did not navigate).
//
// Usage: node tools/mumu-tap-card.mjs [x] [y]
import { execFileSync } from 'node:child_process';

const ADB = 'C:\\Program Files\\Netease\\MuMu\\nx_device\\12.0\\shell\\adb.exe';
const DEV = '127.0.0.1:7555';
const X = process.argv[2] || '1401';
const Y = process.argv[3] || '656';
const OUT = 'C:\\mumudump';

const adb = (...args) => {
  try {
    return execFileSync(ADB, ['-s', DEV, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}`;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dumpText = async (name) => {
  adb('shell', 'uiautomator dump /sdcard/_u2.xml');
  const local = `${OUT}\\${name}.xml`;
  adb('pull', '/sdcard/_u2.xml', local);
  try {
    const xml = execFileSync('powershell', ['-NoProfile', '-Command', `Get-Content -Raw -Encoding UTF8 '${local}'`], { encoding: 'utf8' });
    return [...new Set([...xml.matchAll(/text="([^"]{2,70})"/g)].map((m) => m[1]))];
  } catch {
    return [];
  }
};

console.log(`点击星铁卡片 @(${X},${Y})`);
adb('shell', `input tap ${X} ${Y}`);
await sleep(6000);

adb('shell', 'screencap -p /sdcard/_c.png');
adb('pull', '/sdcard/_c.png', `${OUT}\\card-tap.png`);
console.log(`截图 -> ${OUT}\\card-tap.png`);

const texts = await dumpText('card-tap');
console.log('\n页面文字:');
for (const t of texts.slice(0, 45)) console.log('  ' + t);

const joined = texts.join(' ');
console.log('\n判读:');
console.log('  出现「异常/验证/依次点击」:', /异常|验证|依次点击/.test(joined) ? '是 —— 需要完成验证' : '否');
console.log('  出现角色/战绩字样      :', /角色|战绩|活跃天数|已解锁/.test(joined) ? '是' : '否');
console.log('  当前 Activity         :', adb('shell', 'dumpsys activity activities | grep topResumedActivity').trim().slice(0, 120));
