// 手动更新本地 theherta 数据集：增量抓取 + 重新聚合，供界面按钮调用。
//
// 流程（每一步都会通过 `emit` 上报，界面用 SSE 实时显示）：
//   1. 先给现有数据留档（复制 theherta 数据文件到一个时间戳目录，不压缩）
//   2. node tools/herta-update.mjs --json   只抓缺的版本与各副本最新版本
//   3. node tools/herta-build.mjs           重新聚合出 archive.json
//   4. 让服务端丢掉缓存的 archive，下一次请求读到新数据
//
// 为什么只抓增量：3.0-4.5 已结束的期不会再变，全量是 64 个组合约 56 MB，
// 而增量实测只有 16 个组合（其中 12 个还是「该副本当时没上线」的永久空档）。
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

/** 跑一个 node 脚本，逐行回调 stdout；返回 { code, stderr }。 */
const runNode = (script, args, onLine) => new Promise((resolvePromise) => {
  const child = spawn(process.execPath, [join(ROOT, 'tools', script), ...args], {
    cwd: ROOT,
    // 注意：Node 的 piped stdio 在受限沙箱下会 EPERM；本机是全权限模式。
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) if (line.trim()) onLine(line);
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (err) => resolvePromise({ code: -1, stderr: String(err.message) }));
  child.on('close', (code) => {
    if (buffer.trim()) onLine(buffer);
    resolvePromise({ code, stderr });
  });
});

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
 * 返回 { ok, added, updated, errors }。
 */
export const updateArchive = async (emit = () => {}) => {
  if (running) return running;

  running = (async () => {
    const result = { ok: false, added: 0, updated: 0, errors: [], skipped: 0 };
    try {
      await backup(emit);
      const before = await readIndexCounts();

      emit('开始增量抓取（只抓缺的版本与各副本最新版本）…');
      let fetchFailed = null;
      const fetchRun = await runNode('herta-update.mjs', ['--json'], (line) => {
        let payload = null;
        try { payload = JSON.parse(line); } catch { emit(line); return; }
        if (payload.type === 'plan') {
          result.skipped = payload.skipped || 0;
          emit(`计划：抓 ${payload.total} 个组合、跳过 ${payload.skipped} 个已完成的旧版本`
            + `（最新版本 ${payload.latest} 永远重抓）`);
        } else if (payload.type === 'progress') {
          emit(`[${payload.done}/${payload.total}] ${payload.message}`);
        } else if (payload.type === 'done') {
          result.added = payload.added || 0;
          result.updated = payload.updated || 0;
          result.errors = payload.errors || [];
        } else if (payload.type === 'failed') {
          fetchFailed = payload.message;
        }
      });
      if (fetchFailed) throw new Error(`抓取失败：${fetchFailed}`);
      // spawn 的 code 为 null 表示被信号杀掉，当作失败。
      const fetchCode = fetchRun.code === null ? 1 : fetchRun.code;
      if (fetchCode !== 0 && !result.errors.length) {
        throw new Error(`抓取脚本退出码 ${fetchRun.code}`
          + `${fetchRun.stderr ? `：${fetchRun.stderr.trim().split('\n')[0]}` : ''}`);
      }
      emit(`抓取结束：新增 ${result.added} 条、变化 ${result.updated} 条`
        + (result.errors.length ? `，${result.errors.length} 个组合失败（不影响其余）` : ''));

      // ---- 重新生成单位表（星级/限定），再聚合
      emit('重新生成单位表（星级 / 限定）…');
      const avail = await runNode('herta-availability.mjs', [], (line) => emit(line));
      if (avail.code !== 0) throw new Error(`单位表生成失败：${avail.stderr.trim().split('\n')[0]}`);

      emit('重新聚合投稿数据（这一步最慢，约 1-2 分钟）…');
      const build = await runNode('herta-build.mjs', [], (line) => emit(line));
      if (build.code !== 0) {
        throw new Error(`聚合失败：${build.stderr.trim().split('\n')[0] || `退出码 ${build.code}`}`);
      }

      // 服务端缓存必须丢掉，否则界面还是旧数据。
      reloadArchive();
      const after = await readIndexCounts();
      let delta = 0;
      const touched = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const key of touched) delta += (after[key] || 0) - (before[key] || 0);
      result.ok = true;
      result.delta = delta;
      emit(`完成。投稿总数变化 ${delta >= 0 ? '+' : ''}${delta} 条`, 'done');
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
