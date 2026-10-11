// Browser auto-open self-test.
//
// start.bat starts bin/open-when-ready.ps1 in the background; that helper must
// (a) wait for the port to answer, (b) then hand the exact page URL to the
// browser, and (c) not wait forever when the server never comes up. This suite
// drives the helper against a fake HTTP server and checks all three, without
// opening a browser:
//
//   * DSH_HSR_OPEN_CMD is pointed at `cmd.exe /c echo %*>>"<log>"`, so the URL
//     that would have gone to the browser is captured in a file instead. That
//     file is written by the *opener* process, which the helper starts with
//     Start-Process and does not wait for, so it appears ~150-200ms after the
//     helper itself is already gone - and a delete in that window does not stop
//     the pending write. Each phase therefore captures into its own files and
//     polls them, instead of sharing one path and reading it once.
//   * DSH_HSR_OPEN_LOG records each launch attempt.
//
// It also pins the trap that bit this launcher once: Windows PowerShell 5.1
// reads a BOM-less .ps1 with the ANSI codepage, so a non-ASCII literal in the
// helper is a parse error at runtime (syntax checking alone does not catch it,
// because [ScriptBlock]::Create gets the text already decoded by Get-Content).
//
// Run: node tools/launcher-open-test.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HELPER = join(ROOT, 'bin', 'open-when-ready.ps1');
const PORT = 8397; // a quiet port so the suite never fights a real instance
const WORK = join(tmpdir(), `hsr-open-test-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The capture files are written by the opener process, which the helper leaves
// running: the helper exits first and the write lands ~150-200ms later, so a
// path shared between phases lets a late write from one phase land inside the
// next one (and an immediate read of it is a race). Every helper run gets its
// own pair of files instead.
let phase = 0;
const freshLogs = () => {
  phase += 1;
  return {
    outLog: join(WORK, `launched-${phase}.txt`),
    attemptLog: join(WORK, `attempts-${phase}.txt`),
  };
};

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`); process.exitCode = 1; }
};

const readTrimmed = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');

/** Read a capture file, giving the opener process time to have written it. */
const settleLog = async (file, { until = () => true, timeoutMs = 3000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = readTrimmed(file);
    if (until(text) || Date.now() >= deadline) return text;
    await sleep(50);
  }
};

/**
 * Start a minimal HTTP server that answers everything with 200.
 * @param {{delayMs?:number, status?:number}} [options]
 */
const startFakeServer = ({ delayMs = 0, status = 200 } = {}) => new Promise((resolve) => {
  setTimeout(() => {
    const server = createServer((req, res) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>fake</title>');
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  }, delayMs);
});

/** Run the helper and resolve with { code, out, url, logs }. */
const runHelper = ({ timeoutSec = 25, url = `http://127.0.0.1:${PORT}/`, logs, openerCmd, suppressBrowser = false } = {}) => {
  logs ??= freshLogs();
  const openCmd = openerCmd ?? `cmd.exe /c echo %*>>"${logs.outLog}"`;
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DSH_HSR_URL: url,
          DSH_HSR_HOSTV: '127.0.0.1',
          DSH_HSR_PORTV: String(PORT),
          DSH_HSR_OPEN_TIMEOUT: String(timeoutSec),
          DSH_HSR_OPEN_CMD: openCmd,
          DSH_HSR_OPEN_LOG: logs.attemptLog,
          DSH_HSR_TEST_NO_BROWSER: suppressBrowser ? '1' : '',
        },
      });
    } catch (err) {
      // On a confined host spawn fails synchronously (EPERM) instead of emitting
      // an 'error' event, so this must not escape as an uncaught exception.
      resolve({ code: -1, out: `spawn failed: ${err.message}`, url, logs });
      return;
    }
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out, url, logs }));
    child.on('error', (err) => resolve({ code: -1, out: `spawn error: ${err.message}`, url, logs }));
  });
};

console.log('\n▶ 浏览器自动打开自检');

// ---- 0. the helper must stay pure ASCII ------------------------------------
check('open-when-ready.ps1 存在', existsSync(HELPER));
if (existsSync(HELPER)) {
  const bytes = readFileSync(HELPER);
  const nonAscii = [...bytes].filter((b) => b > 127).length;
  check('open-when-ready.ps1 是纯 ASCII（PowerShell 5.1 按 ANSI 解析无 BOM 的 .ps1）',
    nonAscii === 0, `发现 ${nonAscii} 个非 ASCII 字节`);
}

// start.bat must hand the helper the three values it needs.
const bat = readFileSync(join(ROOT, 'start.bat'), 'utf8');
check('start.bat 传入 DSH_HSR_URL', bat.includes('set "DSH_HSR_URL=%URL%"'));
check('start.bat 传入探测主机 DSH_HSR_HOSTV', bat.includes('set "DSH_HSR_HOSTV=%PROBE_HOST%"'));
check('start.bat 在同一控制台运行等待器（start /b，错误可见）',
  bat.includes('start /b "" powershell') && !bat.includes('-WindowStyle Hidden -File'));
check('start.bat 支持 DSH_HSR_OPEN=0 关闭自动打开', bat.includes('if not "%DSH_HSR_OPEN%"=="0"'));

// The shell's http association is outside this program's control, so a broken
// one must not be the end of the road: browsers have to be tried by real path.
const helperSrc = readFileSync(HELPER, 'utf8');
check('open-when-ready.ps1 会按真实路径兜底启动已装的浏览器',
  helperSrc.includes('via-browser=') && /chrome\.exe/.test(helperSrc) && /msedge\.exe/.test(helperSrc));
check('open-when-ready.ps1 兜底前仍先走外壳关联', helperSrc.includes('via-cmd-start'));
check('bin/serve.mjs --open 同样有真实路径兜底',
  readFileSync(join(ROOT, 'bin', 'serve.mjs'), 'utf8').includes('knownBrowsers'));

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true, mode: 0o700 });
// Reference the capture directory once so it is definitely writable.
writeFileSync(join(WORK, 'probe.txt'), 'ok');

// ---- 1. server already up -> opens the exact URL ---------------------------
let server = await startFakeServer();
let r = await runHelper();
check('服务已在监听时退出码为 0', r.code === 0, r.out.trim().slice(0, 160));
let captured = await settleLog(r.logs.outLog, { until: (t) => t.includes(r.url) });
check('把准确的页面地址交给了浏览器', captured.includes(r.url), `收到 "${captured}"`);

// ---- 2. server starts late -> waits, then opens ----------------------------
// The delayed server must NOT be awaited before the helper starts, or the helper
// would find the port already answering and never have to wait at all.
server.close();
await sleep(200);
const started = Date.now();
const lateServer = startFakeServer({ delayMs: 4000 });
r = await runHelper({ timeoutSec: 30 });
const waitedMs = Date.now() - started;
server = await lateServer;
check('服务晚到时会等待后打开（等待 > 3s）', r.code === 0 && waitedMs > 3000,
  `code=${r.code} waited=${waitedMs}ms`);
captured = await settleLog(r.logs.outLog, { until: (t) => t.includes(r.url) });
check('晚到场景下地址同样准确', captured.includes(r.url), `收到 "${captured}"`);

// ---- 3. HTTP 401 (access token enabled) still counts as ready --------------
server.close();
await sleep(200);
server = await startFakeServer({ status: 401 });
r = await runHelper({ timeoutSec: 20 });
check('设置了访问令牌（/api/config 返回 401）时仍然算就绪并打开', r.code === 0,
  r.out.trim().slice(0, 160));

// ---- 4. nothing listening -> gives up, no browser, non-zero exit -----------
server.close();
await sleep(200);
const t0 = Date.now();
r = await runHelper({ timeoutSec: 2 });
const giveUpMs = Date.now() - t0;
check('无服务时非零退出', r.code !== 0, `code=${r.code}`);
// Give a would-be opener the time it would need to write its capture file
// before ruling that no browser was opened.
await sleep(1000);
check('无服务时不打开浏览器', !existsSync(r.logs.outLog), `收到 "${readTrimmed(r.logs.outLog)}"`);
check('无服务时按超时退出（不超过 ~8s）', giveUpMs < 8000, `took ${giveUpMs}ms`);

// ---- 5. a broken DSH_HSR_OPEN_CMD must reach fallback without opening UI ----
// Suppress the real browser launch while retaining a trace of the selected
// fallback, so running the test suite never creates a surprise browser tab.
server = await startFakeServer();
r = await runHelper({ timeoutSec: 20, openerCmd: 'Z:\\no-such-browser.exe', suppressBrowser: true });
const attempts = await settleLog(r.logs.attemptLog,
  { until: (t) => /test-fallback=/.test(t), timeoutMs: 4000 });
check('自定义打开程序失效时不再静默成功，仍会继续兜底', r.code === 0,
  `code=${r.code} attempts="${attempts}"`);
check('兜底分支被验证且测试不会启动真实浏览器',
  /test-fallback=(browser-candidate=.*\.exe|cmd-start)/.test(attempts),
  `attempts="${attempts}"`);

rmSync(WORK, { recursive: true, force: true });
console.log(`\n浏览器自动打开自检: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
