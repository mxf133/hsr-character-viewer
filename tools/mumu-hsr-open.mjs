// Drive the miHoYo app on the MuMu emulator to the Star Rail record page and
// capture its verification UI.
//
// Rationale: the user previously cleared this exact "账号可能存在异常" check by
// using the official app, so the app's WebView is the known-good path. A local
// web page keeps failing the Geetest click-sequence even when solved correctly,
// which points at the embedding context rather than the answer.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ADB = 'C:\\Program Files\\Netease\\MuMu\\nx_device\\12.0\\shell\\adb.exe';
const DEV = process.argv[2] || '127.0.0.1:7555';
const OUT = 'C:\\mumudump';

const adb = (...args) => {
  try {
    return execFileSync(ADB, ['-s', DEV, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}`;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const shot = async (name) => {
  adb('shell', 'screencap -p /sdcard/_s.png');
  adb('pull', '/sdcard/_s.png', `${OUT}\\${name}.png`);
  console.log(`   截图 -> ${OUT}\\${name}.png`);
};

const uiText = async (name) => {
  adb('shell', 'uiautomator dump /sdcard/_u.xml');
  const local = `${OUT}\\${name}.xml`;
  adb('pull', '/sdcard/_u.xml', local);
  return local;
};

console.log('设备:', DEV);
console.log(adb('devices').trim());

// The profile page shows the game cards; tapping the Star Rail card opens its
// record page, which is where the verification dialog appears.
console.log('\n[1] 回到 App 并进入「我的」页面');
adb('shell', 'am start -n com.mihoyo.hyperion/.main.HyperionMainActivity');
await sleep(3500);
adb('shell', 'input tap 1260 2500');            // bottom nav: 我的
await sleep(4000);
await shot('nav-1-profile');

console.log('\n[2] 读取页面上的可点击元素');
const xmlPath = await uiText('nav-1');
try {
  const xml = execFileSync('powershell', ['-NoProfile', '-Command', `Get-Content -Raw -Encoding UTF8 '${xmlPath}'`], { encoding: 'utf8' });
  const nodes = [...xml.matchAll(/<node[^>]*>/g)].map((m) => m[0]);
  let shown = 0;
  for (const n of nodes) {
    const text = /text="([^"]*)"/.exec(n)?.[1] || '';
    const desc = /content-desc="([^"]*)"/.exec(n)?.[1] || '';
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n);
    if (!bounds || (!text && !desc)) continue;
    if (shown++ > 35) break;
    const cx = Math.round((+bounds[1] + +bounds[3]) / 2);
    const cy = Math.round((+bounds[2] + +bounds[4]) / 2);
    console.log(`   "${(text || desc).slice(0, 22)}"  @(${cx},${cy})`);
  }
} catch (err) {
  console.log('   读取 UI 失败:', err.message);
}

console.log('\n[3] 尝试直接打开星铁战绩页（App 内 WebView）');
const url = 'https://webstatic.mihoyo.com/app/community-game-records/rpg/index.html'
  + '?mhy_presentation_style=fullscreen&game_id=6&user_id=288365607';
adb('shell', `am start -a android.intent.action.VIEW -d '${url}' -n com.mihoyo.hyperion/.main.HyperionMainActivity`);
await sleep(9000);
await shot('nav-2-record');

const xml2 = await uiText('nav-2');
try {
  const xml = execFileSync('powershell', ['-NoProfile', '-Command', `Get-Content -Raw -Encoding UTF8 '${xml2}'`], { encoding: 'utf8' });
  const texts = [...new Set([...xml.matchAll(/text="([^"]{2,60})"/g)].map((m) => m[1]))];
  console.log('   页面文字:');
  for (const t of texts.slice(0, 40)) console.log('     ' + t);
  const hasVerify = /异常|验证|依次点击/.test(xml);
  console.log(`   是否出现验证提示: ${hasVerify ? '是' : '否'}`);
} catch (err) {
  console.log('   读取 UI 失败:', err.message);
}

console.log('\n完成。');
