#!/usr/bin/env node
// Entry point: `node bin/serve.mjs [--port 8360] [--host 127.0.0.1] [--open]`

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:process';
import { startServer } from '../src/server/app.js';
import { watchParent } from '../src/server/watchdog.js';
import { VERSION_TEXT } from '../src/version.js';

const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') out.port = Number(argv[++i]);
    else if (arg === '--host' || arg === '-h') out.host = argv[++i];
    else if (arg === '--open') out.open = true;
    else if (arg === '--help') out.help = true;
  }
  return out;
};

/** Launch attempt that must never take the server down with it. */
const trySpawn = (command, args) => {
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    // A failed spawn (denied by the host, handler missing) emits 'error' on the
    // next tick; swallowing it here keeps "best effort" from becoming an
    // uncaught exception that takes the server down with it.
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
};

// Installed browsers, tried only after the shell association has been asked:
// the association lives in the registry and can be broken, in which case
// Windows answers with a dialog of its own instead of opening a page.
const knownBrowsers = () => {
  if (platform !== 'win32') return [];
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return [
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter((p) => p && existsSync(p));
};

const openBrowser = (url) => {
  if (platform === 'win32') {
    if (trySpawn('cmd', ['/c', 'start', '', url])) return;
    for (const browser of knownBrowsers()) {
      if (trySpawn(browser, [url])) return;
    }
    return;
  }
  trySpawn(platform === 'darwin' ? 'open' : 'xdg-open', [url]);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node bin/serve.mjs [--port 8360] [--host 127.0.0.1] [--open]');
    return;
  }

  const app = await startServer({ port: args.port, host: args.host });

  console.log('');
  console.log(`  崩坏：星穹铁道 抽卡推荐计算器   ${VERSION_TEXT}`);
  console.log('  ─────────────────────────────────────────');
  console.log(`  界面地址   ${app.url}`);
  console.log(`  监听地址   ${app.host}:${app.port}`);
  console.log(`  账号数据   ${app.store.file}`);
  if (process.env.DSH_HSR_TOKEN) {
    console.log('  访问令牌   已启用（请求需携带 x-hsr-token）');
  }
  console.log('');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');

  if (args.open) openBrowser(app.url);

  const shutdown = () => {
    console.log('\n正在停止服务…');
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Die with the window that launched us, even when it is killed abruptly
  // (closing a console normally already takes the child down, but a hard kill
  // would otherwise leave an orphan holding the port). Set
  // DSH_HSR_NO_WATCHDOG=1 to disable when supervising externally.
  if (process.env.DSH_HSR_NO_WATCHDOG !== '1') {
    watchParent({ onExit: shutdown });
  }
};

main().catch((err) => {
  console.error('启动失败：', err?.message || err);
  if (err?.code === 'EADDRINUSE') {
    console.error('端口已被占用，请使用 --port 指定其他端口。');
  }
  process.exit(1);
});
