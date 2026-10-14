// 手动更新本地 theherta 数据集：增量抓取 + 重新聚合，供界面按钮调用。
//
// 流程（每一步都会通过 `emit` 上报，界面用 SSE 实时显示）：
//   1. 先给现有数据留档（复制 theherta 数据文件到一个时间戳目录，不压缩）
//   2. node tools/herta-update.mjs --json   只抓没同步过的期 + 还在收投稿的期（有并发上限与单请求超时）
//   3. node tools/herta-availability.mjs   重新生成星级/限定表（参考表缺失时优雅降级，不会打断同步）
//   4. node tools/herta-build.mjs           重新聚合出 archive.json
//   5. 让服务端丢掉缓存的 archive，下一次请求读到新数据
//
// 为什么只抓增量：已结束的期不会再变，全量是 64 个组合、约 56 MB，
// 而增量实测只有 6 个组合（2026-10-14，见 tools/herta-update.mjs 的 planTargets 注释）。
import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reloadArchive } from './archive.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const OUT = join(ROOT, 'theherta');

/** 同一时刻只允许一个更新任务，避免两个抓取互相覆盖文件。 */
let running = null;

export const updateInProgress = () => running !== null;

/**
 * 把 stdout / stderr 按行喂给 handler；返回一个 flush()，用来处理残留的最后一行。
 * 单独抽出来是因为 stderr 也要逐行上报（见 `runNode` 的注释）。
 */
const attachLines = (stream, handler) => {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) if (line.trim()) handler(line);
  });
  return () => {
    if (buffer.trim()) handler(buffer);
    buffer = '';
  };
};

/**
 * 跑一个 node 脚本，逐行回调 stdout 与 stderr；返回 { code, stderr }。
 *
 * ⚠️ **`onErrLine` 是 2026-10-14 补的**：以前 stderr 只在「脚本非 0 退出」时才被
 * 拼进错误消息，于是**退出码 0 但打了警告**的子进程（例如 herta-availability.mjs
 * 找不到参考表而优雅降级）的提示全被吞掉 —— 界面上一句都看不到，用户只能看到
 * 「完成」，却不知道星级表没有重建、新角色按保守口径计了成本。
 *
 * 另外修掉一个双次 resolve：`error` 事件之后 `close` 还会来一次，旧写法会让
 * `close` 那次（带着真正的 stderr）被丢掉。
 */
const runNode = (script, args, onLine, onErrLine) => new Promise((resolvePromise) => {
  const child = spawn(process.execPath, [join(ROOT, 'tools', script), ...args], {
    cwd: ROOT,
    // 注意：Node 的 piped stdio 在受限沙箱下会 EPERM；本机是全权限模式。
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  const flushOut = attachLines(child.stdout, onLine);
  const flushErr = attachLines(child.stderr, (line) => {
    stderr += `${line}\n`;
    if (onErrLine) onErrLine(line);
  });
  let settled = false;
  const settle = (value) => { if (!settled) { settled = true; resolvePromise(value); } };
  child.on('error', (err) => {
    flushErr();
    settle({ code: -1, stderr: `${stderr}${err.message}` });
  });
  child.on('close', (code) => {
    flushOut();
    flushErr();
    settle({ code, stderr });
  });
});

/**
 * stderr 的可用摘要：取**最后两条**非空行。
 * 取尾部而不是首部 —— 真正的错误信息在最后一行（`herta-build.mjs` 的
 * `console.error('聚合失败:', err)` 会先打标题再打堆栈）。
 */
const stderrTail = (stderr, lines = 2) => {
  const parts = String(stderr || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? `：${parts.slice(-lines).join(' / ')}` : '';
};

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/**
 * 更新前留档。只复制会被改写的东西（archive.json 与 unit-availability.json）
 * 以及投稿索引，不复制 raw/（几十 MB，且这次抓取只会新增/覆盖其中的少量文件，
 * 被覆盖的那几个在留档目录里单独保存）。
 */
const backup = async (emit) => {
  const target = join(OUT, 'backup', stamp());
  await mkdir(target, { recursive: true });
  const files = ['archive.json', 'unit-availability.json', 'manifest.json'];
  let n = 0;
  for (const name of files) {
    const src = join(OUT, name);
    if (!existsSync(src)) continue;
    await cp(src, join(target, name));
    n += 1;
  }
  emit(`已留档 ${n} 个文件到 theherta/backup/${target.split(/[\\/]/).pop()}/`);
  return target;
};

/**
 * 读取上次抓取的投稿数索引，用于回报「新增/变化多少条」。
 */
const readIndexCounts = async () => {
  try {
    const index = JSON.parse(await readFile(join(OUT, 'raw', 'submissions-index.json'), 'utf8'));
    return index.counts || {};
  } catch {
    return {};
  }
};

/**
 * 执行更新。`emit(message, kind)` 逐条上报，kind 为 'progress' | 'done' | 'failed'。
 * 返回 { ok, added, updated, errors, skipped, stage, partial?, delta? }。
 *
 * ⚠️ 界面端（public/scripts/advice-view.js）只认 `progress` / `done` / `failed`
 * 三种事件，所以**警告一律走 `progress`**（前缀 ⚠），不要另起事件名 —— 起了也没人收。
 */
export const updateArchive = async (emit = () => {}) => {
  if (running) return running;

  running = (async () => {
    const result = { ok: false, added: 0, updated: 0, errors: [], skipped: 0, stage: 'backup' };
    try {
      await backup(emit);
      const before = await readIndexCounts();

      result.stage = 'fetch';
      emit('开始增量抓取（只抓还没同步过的期与还在收投稿的期）…');
      let fetchFailed = null;
      let planned = 0;
      const fetchRun = await runNode('herta-update.mjs', ['--json'], (line) => {
        let payload = null;
        try { payload = JSON.parse(line); } catch { emit(line); return; }
        if (payload.type === 'plan') {
          result.skipped = payload.skipped || 0;
          planned = payload.total || 0;
          emit(`计划：抓 ${payload.total} 个组合、跳过 ${payload.skipped} 个已结束的期`
            + `（每个副本最新的一期永远重抓）`);
        } else if (payload.type === 'progress') {
          emit(`[${payload.done}/${payload.total}] ${payload.message}`);
        } else if (payload.type === 'done') {
          result.added = payload.added || 0;
          result.updated = payload.updated || 0;
          result.errors = payload.errors || [];
        } else if (payload.type === 'failed') {
          fetchFailed = payload.message;
        }
      }, (line) => emit(`⚠ ${line}`));
      if (fetchFailed) throw new Error(`抓取失败：${fetchFailed}`);
      // spawn 的 code 为 null 表示被信号杀掉，当作失败。
      const fetchCode = fetchRun.code === null ? 1 : fetchRun.code;
      // 只把「组合级」的失败算进来：索引写入失败（mode === 'index'）不是抓取失败。
      const comboErrors = result.errors.filter((e) => e.mode !== 'index');
      if (!comboErrors.length && fetchCode !== 0) {
        throw new Error(`抓取脚本退出码 ${fetchRun.code}${stderrTail(fetchRun.stderr)}`);
      }
      if (comboErrors.length) {
        // ⚠️ 旧写法是 `if (fetchCode !== 0 && !result.errors.length) throw`——
        // 只要有组合失败，`result.errors` 就非空、退出码 1 被**静默吞掉**，
        // 界面最后显示的是「完成」。这里改成明确上报，并且把原因逐条打出来。
        result.partial = true;
        if (planned > 0 && comboErrors.length >= planned) {
          throw new Error(`抓取全部失败（${comboErrors.length}/${planned}）：`
            + `${comboErrors[0].season} / ${comboErrors[0].mode} ${comboErrors[0].error}`);
        }
        emit(`⚠ 抓取有 ${comboErrors.length}/${planned} 个组合失败（不影响其余，下面列出原因）：`);
        for (const err of comboErrors.slice(0, 8)) {
          emit(`⚠   ${err.season} / ${err.mode}：${err.error}`);
        }
        if (comboErrors.length > 8) emit(`⚠   …还有 ${comboErrors.length - 8} 个，详见日志`);
      }
      emit(`抓取结束：新增 ${result.added} 条、变化 ${result.updated} 条`
        + (comboErrors.length ? `，${comboErrors.length} 个组合失败（不影响其余）` : ''));

      // ---- 重新生成单位表（星级/限定），再聚合
      // 参考表（.snapref/，gitignore）缺失时这一步会优雅降级并打印警告，退出码 0。
      result.stage = 'availability';
      emit('重新生成单位表（星级 / 限定）…');
      const avail = await runNode('herta-availability.mjs', [], (line) => emit(line),
        (line) => emit(`⚠ ${line}`));
      if (avail.code !== 0) {
        throw new Error(`单位表生成失败（退出码 ${avail.code}）${stderrTail(avail.stderr)}`);
      }

      result.stage = 'build';
      // ⚠️ 旧文案写「这一步最慢，约 1-2 分钟」是错的：实测聚合只要 ~1.4 秒
      // （64 个原始文件、30602 条投稿）。真正慢的是抓取那一段串行请求，
      // 别再把锅甩给聚合 —— 不然调优会盯错地方。
      emit('重新聚合投稿数据（只读本地原始数据，实测约 2 秒）…');
      const build = await runNode('herta-build.mjs', [], (line) => emit(line),
        (line) => emit(`⚠ ${line}`));
      if (build.code !== 0) {
        // 抓取已经落盘，所以这两件事分开说 —— 用户重试时抓取那一段会被跳过判据跳过，
        // 不会再白花一次网络时间。这个区分就是「抓取成功但聚合失败」。
        result.fetchOk = true;
        throw new Error(`数据已抓取（新增 ${result.added} 条、变化 ${result.updated} 条），`
          + `但重新聚合失败（退出码 ${build.code}）${stderrTail(build.stderr)}`);
      }

      // 服务端缓存必须丢掉，否则界面还是旧数据。
      reloadArchive();
      result.stage = 'done';
      const after = await readIndexCounts();
      let delta = 0;
      const touched = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const key of touched) delta += (after[key] || 0) - (before[key] || 0);
      result.ok = true;
      result.delta = delta;
      emit(`完成。投稿总数变化 ${delta >= 0 ? '+' : ''}${delta} 条`
        + (result.partial ? `（注意：有 ${result.errors.filter((e) => e.mode !== 'index').length} 个组合没抓到，数据可能不全）` : ''),
      'done');
      return result;
    } catch (err) {
      result.errors.push({ error: err.message });
      emit(err.message, 'failed');
      return result;
    } finally {
      running = null;
    }
  })();

  return running;
};

/** 数据集目录的大小与文件数，供界面显示「当前数据规模」。 */
export const datasetStats = async () => {
  try {
    const info = await stat(join(OUT, 'archive.json'));
    const raw = await readdir(join(OUT, 'raw', 'submissions')).catch(() => []);
    return { archiveBytes: info.size, submissionFiles: raw.length };
  } catch {
    return { archiveBytes: 0, submissionFiles: 0 };
  }
};

/** 清掉备份目录里最早的若干份，避免无限增长。 */
export const pruneBackups = async (keep = 5) => {
  const dir = join(OUT, 'backup');
  try {
    const entries = (await readdir(dir)).sort();
    for (const name of entries.slice(0, Math.max(0, entries.length - keep))) {
      await rm(join(dir, name), { recursive: true, force: true });
    }
  } catch { /* 没有备份目录就算了 */ }
};
