// Trigger the Star Rail record page in the app and capture the TLS SNI hostnames
// it contacts, to discover which service performs the "账号异常" verification.
//
// The UI dump showed the app presenting:
//   战绩 |《崩坏：星穹铁道》
//   检测到账号可能存在异常，需要通过验证
//   请在下图依次点击：
// So the official client is ALSO blocked for this account and must complete a
// challenge. The record API answers retcode 10035 with an empty message, which
// is consistent with "challenge required but not requested".
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ADB = 'C:\\Program Files\\Netease\\MuMu\\nx_device\\12.0\\shell\\adb.exe';
const DEV = '127.0.0.1:7555';
const OUT = 'C:\\mumudump';

const adb = (...args) => {
  try {
    return execFileSync(ADB, ['-s', DEV, ...args], { encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}`;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('=== 启动 tcpdump（抓 443，最多 40 秒）===');
adb('shell', "su -c 'pkill tcpdump'");
await sleep(500);
// Run in background on the device so we can drive the UI meanwhile.
execFileSync(ADB, ['-s', DEV, 'shell',
  "su -c 'nohup tcpdump -i any -s 0 -w /sdcard/cap.pcap \"tcp port 443\" >/dev/null 2>&1 &'"],
  { stdio: 'ignore' });

await sleep(2000);
console.log('  抓包已开始');

console.log('\n=== 驱动 App 打开星铁战绩页 ===');
// Go to the profile tab, then the Star Rail game card (which opens the record page).
adb('shell', 'am start -n com.mihoyo.hyperion/.main.HyperionMainActivity');
await sleep(3000);
// Bottom nav "我的"
adb('shell', 'input tap 1260 2500');
await sleep(3500);
// The Star Rail card sits right of the Genshin card on the profile header.
adb('shell', 'input tap 1256 470');
await sleep(5000);
adb('shell', 'screencap -p /sdcard/rec1.png');
adb('pull', '/sdcard/rec1.png', `${OUT}\\rec1.png`);

console.log('  等待验证弹窗与相关请求 ...');
await sleep(12000);

adb('shell', 'screencap -p /sdcard/rec2.png');
adb('pull', '/sdcard/rec2.png', `${OUT}\\rec2.png`);

console.log('\n=== 停止抓包并取回 ===');
adb('shell', "su -c 'pkill tcpdump'");
await sleep(1500);
adb('shell', "su -c 'chmod 666 /sdcard/cap.pcap'");
adb('pull', '/sdcard/cap.pcap', `${OUT}\\cap.pcap`);
const pcap = `${OUT}\\cap.pcap`;
if (!existsSync(pcap)) {
  console.error('没有抓到 pcap');
  process.exit(1);
}
console.log(`  pcap: ${readFileSync(pcap).length} bytes`);

// ---- extract TLS SNI (server_name) from the ClientHello records --------------
const buf = readFileSync(pcap);
const hosts = new Map();
let offset = 24; // skip pcap global header
while (offset + 16 <= buf.length) {
  const inclLen = buf.readUInt32LE(offset + 8);
  const data = buf.subarray(offset + 16, offset + 16 + inclLen);
  offset += 16 + inclLen;
  if (data.length < 54) continue;

  // Walk the Ethernet -> IPv4 -> TCP chain (Linux "any" uses cooked headers).
  let ipOff = 14;
  const etherType = data.readUInt16BE(12);
  if (etherType !== 0x0800) {
    // Linux cooked capture (SLL) header is 16 bytes.
    ipOff = 16;
  }
  const ihl = (data[ipOff] & 0x0f) * 4;
  const tcpOff = ipOff + ihl;
  const sport = data.readUInt16BE(tcpOff);
  const dport = data.readUInt16BE(tcpOff + 2);
  const payloadOff = tcpOff + ((data[tcpOff + 12] >> 4) * 4);
  const payload = data.subarray(payloadOff);
  if (dport !== 443 && sport !== 443) continue;
  if (payload.length < 6 || payload[0] !== 0x16) continue;

  // ClientHello: find the SNI extension (type 0x0000).
  const i = payload.indexOf(Buffer.from([0x00, 0x00]));
  if (i < 0) continue;
  const chunk = payload.toString('latin1');
  const m = /([a-z0-9][a-z0-9.\-]{4,60}\.(?:com|cn|net|org))/.exec(chunk);
  if (m) hosts.set(m[1], (hosts.get(m[1]) || 0) + 1);
}

console.log('\n=================== 抓到的 TLS 域名 ===================');
for (const [h, n] of [...hosts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${h}`);
}
if (hosts.size === 0) console.log('  (没解析出域名，可能需要调整 pcap 解析)');
