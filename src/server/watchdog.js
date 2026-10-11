// Parent-process watchdog.
//
// Purpose: guarantee the app dies together with the window that launched it,
// even when that window is killed abruptly.
//
// Closing a console normally sends CTRL_CLOSE_EVENT to everyone attached to it,
// so the server stops by itself. That does NOT happen on a hard kill (Task
// Manager "End task", `taskkill /f`, a crash, a dropped RDP session): the console
// dies but the child is not signalled, leaving an orphan that keeps the port
// bound - which then looks like "port already in use" on the next launch.
//
// Implementation note: watching only `process.ppid` is unreliable on Windows
// because the OS reparents a process when its parent dies, so the "parent" we
// were told about at startup may already be gone by the time we ask. Instead we
// walk the CURRENT ancestor chain of our own PID from the process table and exit
// as soon as it becomes empty (i.e. we have been reparented to nothing).
//
// Usage (ESM):  import { watchParent } from './watchdog.js'; watchParent();

import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { platform } from 'node:process';

const IS_WIN = platform === 'win32';
const POLL_MS = 2000;

/**
 * Run one process-table reader, resolving to its stdout or null.
 *
 * The callback never throws and the promise never rejects: a missing `wmic`
 * (Windows 11 24H2+ removed it) or a denied `spawn` must degrade to "no table"
 * rather than escape as an unhandled rejection, which would kill the server a
 * couple of seconds after startup - long before anyone could open the UI.
 */
const runReader = (file, args) => new Promise((resolve) => {
  let child = null;
  try {
    child = execFile(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err || !stdout ? null : String(stdout)));
  } catch {
    // spawn can throw synchronously as well (EPERM under a confined sandbox).
    resolve(null);
    return;
  }
  child.on('error', () => resolve(null));
});

/** Read the process table as pid -> ppid for ALL processes (null when unavailable). */
const processTable = async () => {
  if (!IS_WIN) return null;
  // Walk the whole table, not just node.exe: the launcher chain runs through
  // cmd.exe/cmd.exe/... and stopping at the first non-node parent would cap the
  // chain at one link.
  const csv = await runReader('wmic', ['process', 'get', 'ProcessId,ParentProcessId', '/format:csv']);
  if (csv) return parsePairs(csv, true);
  const ps = await runReader('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }']);
  return ps ? parsePairs(ps, false) : null;
};

const parsePairs = (stdout, csv) => {
  const map = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const parts = line.split(',').map((s) => s.trim());
    if (csv) {
      // wmic csv: Node,ParentProcessId,ProcessId
      if (parts.length < 3) continue;
      const ppid = Number(parts[1]);
      const pid = Number(parts[2]);
      if (Number.isFinite(pid) && pid > 0) map.set(pid, ppid);
    } else {
      const [pid, ppid] = parts.map(Number);
      if (Number.isFinite(pid) && pid > 0) map.set(pid, ppid);
    }
  }
  return map;
};

/** Ancestor PIDs of `pid` within the node process tree, nearest first. */
const ancestorChain = (table, pid) => {
  const chain = [];
  const seen = new Set([pid]);
  let cur = pid;
  for (let i = 0; i < 24; i += 1) {
    const parent = table.get(cur);
    if (!parent || parent <= 0 || seen.has(parent)) break;
    chain.push(parent);
    seen.add(parent);
    cur = parent;
  }
  return chain;
};

/**
 * Start watching our ancestor chain.
 * @param {{ pollMs?:number, onExit?:() => void, log?:(m:string)=>void }} [options]
 * @returns {() => void} stop function
 */
export const watchParent = (options = {}) => {
  const log = options.log || ((m) => console.log(m));
  const pollMs = options.pollMs ?? POLL_MS;
  // Set DSH_HSR_WATCHDOG_DEBUG=<file> to trace what the watchdog observes.
  const debugFile = process.env.DSH_HSR_WATCHDOG_DEBUG || null;
  const trace = (msg) => {
    if (!debugFile) return;
    try {
      appendFileSync(debugFile, `${new Date().toISOString()} ${msg}\n`);
    } catch { /* tracing must never break the server */ }
  };
  let stopped = false;
  let chain = null;
  // PID of the shell that started us, captured before Windows can reparent us.
  const launchPpid = Number(process.ppid) > 0 ? Number(process.ppid) : 0;
  let warnedNoTable = false;

  /** POSIX-style liveness probe; EPERM means "exists but not ours". */
  const pidAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
  };

  const finish = (reason) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    trace(`FINISH: ${reason}`);
    log(`\n[watchdog] ${reason}，正在退出 ...`);
    if (typeof options.onExit === 'function') {
      try { options.onExit(); } catch { /* fall through to hard exit */ }
    }
    setTimeout(() => process.exit(0), 500).unref();
  };

  const timer = setInterval(async () => {
    if (stopped) return;

    if (!IS_WIN) {
      // POSIX: the parent PID is stable, so a simple liveness probe is enough.
      if (!chain) { chain = process.ppid ? [process.ppid] : []; return; }
      if (!chain.length) return;
      for (const pid of chain) {
        try { process.kill(pid, 0); } catch { finish(`父进程 ${pid} 已退出`); return; }
      }
      return;
    }

    const table = await processTable();
    if (!table || !table.size) {
      // wmic is gone (Windows 11 24H2+) and PowerShell could not be spawned, so
      // the ancestor chain cannot be walked. Fall back to a plain liveness probe
      // on the PID we were told about at startup: coarser, but it still catches
      // "the window that launched me is gone".
      trace('poll: no process table; falling back to ppid liveness');
      if (launchPpid && !pidAlive(launchPpid)) {
        finish(`启动它的窗口已关闭（父进程 ${launchPpid} 消失）`);
        return;
      }
      if (launchPpid && !warnedNoTable) {
        warnedNoTable = true;
        trace('watchdog degraded: process table unavailable');
      }
      return;
    }

    const now = ancestorChain(table, process.pid);
    if (!chain) {
      chain = now;
      trace(`baseline chain=[${chain.join(',')}]`);
      // A launcher chain always has at least the shell parent. If we see none we
      // were started detached, so there is nothing to watch.
      if (!chain.length) { stopped = true; clearInterval(timer); trace('no ancestors; watchdog idle'); }
      return;
    }

    // Exit when the chain loses a link (a launcher shell is gone), not merely
    // when it empties - a hard-killed parent may be replaced by a system process.
    const missing = chain.filter((pid) => !table.has(pid) && !now.includes(pid));
    trace(`poll: chain=[${now.join(',')}] baseline=[${chain.join(',')}] missing=[${missing.join(',')}]`);
    if (missing.length) {
      finish(`启动它的窗口已关闭（父进程 ${missing[0]} 消失）`);
    }
  }, pollMs);
  timer.unref?.(); // never keep the event loop alive just for the watchdog

  return () => { stopped = true; clearInterval(timer); };
};

export default watchParent;
