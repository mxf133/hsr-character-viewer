// Launcher self-test.
//
// Verifies the pieces start.bat depends on, without leaving anything running:
//   1. start.bat and its helper exist, stay ASCII-only, and really show a version
//   2. bin/serve.mjs starts, serves /api/config, and stops on SIGTERM
//   3. the server's watchdog is wired up correctly
//   4. bin/open-when-ready.ps1 is syntactically valid
//
// Run: node tools/launcher-test.mjs
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8391; // a quiet port so the test never fights the real instance
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`); process.exitCode = 1; }
};

const portOpen = (port) => new Promise((resolve) => {
  const sock = createConnection({ port, host: '127.0.0.1' }, () => { sock.destroy(); resolve(true); });
  sock.on('error', () => resolve(false));
  sock.setTimeout(800, () => { sock.destroy(); resolve(false); });
});

console.log('\n▶ 启动器自检');

// ---- 1. launcher assets exist and are well-formed --------------------------
const batPath = `${ROOT}start.bat`;
check('start.bat 存在', existsSync(batPath));
if (existsSync(batPath)) {
  const bytes = readFileSync(batPath);
  const nonAscii = [...bytes].filter((b) => b > 127).length;
  // cmd.exe parses .bat/.cmd with the OEM codepage, so non-ASCII breaks it.
  check('start.bat 是纯 ASCII（cmd 按 GBK 解析，非 ASCII 会破坏脚本）', nonAscii === 0,
    `发现 ${nonAscii} 个非 ASCII 字节`);
  // No BOM either: cmd.exe would try to execute the leftover bytes as a command.
  check('start.bat 没有 BOM', !(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF));

  const bat = bytes.toString('utf8');
  // The window title is what the user sees while the console sits behind other
  // windows, so the version has to reach it - a banner alone is not enough.
  check('start.bat 把版本号写进窗口标题', /^title .*%VERSION%/m.test(bat));
  // Banner line: <name>   v<version>.
  check('start.bat 在启动横幅里显示版本号', /^echo\s+.*v%VERSION%/m.test(bat));
  // The silent-failure trap this pins: a launcher that keeps a hard-coded number
  // still compiles, still starts, and only starts lying after the next release.
  check('start.bat 的版本号来自 bin\\version.mjs（不许写死）',
    /node\s+bin\\version\.mjs/.test(bat));
}

// bin/version.mjs is the single point where the launcher asks for the version.
const versionScriptPath = `${ROOT}bin/version.mjs`;
check('bin/version.mjs 存在', existsSync(versionScriptPath));
if (existsSync(versionScriptPath)) {
  const src = readFileSync(versionScriptPath, 'utf8');
  check('bin/version.mjs 从 src/version.js 取 PROGRAM_VERSION（唯一来源）',
    src.includes("from '../src/version.js'") && src.includes('PROGRAM_VERSION'));
  // `for /f` hands the first line straight to `set "VERSION=..."`, so anything
  // but the bare number (a prefix, a second line) lands in the window title.
  // The exact-output check below is the real guard; this one catches a second
  // print being added on purpose.
  check('bin/version.mjs 只打印一次（没有第二处输出）',
    (src.match(/process\.stdout\.write/g) || []).length === 1);
  // Run it and compare with src/version.js itself, not with a literal: bumping
  // PROGRAM_VERSION must not require editing this test.
  // pathToFileURL, not the bare path: import() rejects "C:\..." with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME (a Windows absolute path is not a URL).
  const expected = (await import(pathToFileURL(`${ROOT}src/version.js`).href)).PROGRAM_VERSION;
  try {
    const printed = execFileSync(process.execPath, [versionScriptPath], { encoding: 'utf8' });
    check('node bin/version.mjs 恰好打印一行当前版本号',
      printed === `${expected}\n`, `得到 ${JSON.stringify(printed)}`);
    check('打印的版本号与 src/version.js 的 PROGRAM_VERSION 一致',
      printed.trim() === expected, `${printed.trim()} != ${expected}`);
  } catch (err) {
    check('node bin/version.mjs 能跑起来', false, String(err.stderr || err.message).slice(0, 120));
  }
}

const psPath = `${ROOT}bin/open-when-ready.ps1`;
check('open-when-ready.ps1 存在', existsSync(psPath));
if (existsSync(psPath)) {
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `$null = [ScriptBlock]::Create((Get-Content -Raw '${psPath.replace(/'/g, "''")}'))`],
    { stdio: 'pipe' });
    check('open-when-ready.ps1 语法有效', true);
  } catch (err) {
    check('open-when-ready.ps1 语法有效', false, String(err.stderr || err.message).slice(0, 120));
  }
}

// ---- 2. the server actually serves ----------------------------------------
const servePath = `${ROOT}bin/serve.mjs`;
const server = spawn(process.execPath, [servePath, '--port', String(PORT), '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HSR_NO_WATCHDOG: '1' },
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

let up = false;
for (let i = 0; i < 40 && !up; i += 1) { await sleep(250); up = await portOpen(PORT); }
check('serve.mjs 能启动并监听端口', up, serverOut.slice(0, 200));

if (up) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/config`);
    const body = await res.text();
    check('/api/config 返回 200', res.status === 200);
    const games = JSON.parse(body).games;
    check('/api/config 仅开放星铁', games.length === 1 && games[0]?.key === 'hsr');
  } catch (err) {
    check('/api/config 可访问', false, err.message);
  }

  // SIGTERM must shut it down (this is what Ctrl+C in the window sends).
  server.kill('SIGTERM');
  let down = false;
  for (let i = 0; i < 20 && !down; i += 1) { await sleep(250); down = !(await portOpen(PORT)); }
  check('收到 SIGTERM 后停止监听（Ctrl+C 路径）', down);
}

// ---- 3. watchdog wiring ----------------------------------------------------
const watchdog = readFileSync(`${ROOT}src/server/watchdog.js`, 'utf8');
check('watchdog 遍历整个进程表（而非只看 node.exe）',
  watchdog.includes('processTable') && !/nodeTable/.test(watchdog));
check('serve.mjs 默认启用看门狗', readFileSync(servePath, 'utf8').includes('watchParent'));
check('serve.mjs 支持 DSH_HSR_NO_WATCHDOG 关闭看门狗',
  readFileSync(servePath, 'utf8').includes('DSH_HSR_NO_WATCHDOG'));

if (!server.killed) server.kill('SIGKILL');
console.log(`\n启动器自检: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
