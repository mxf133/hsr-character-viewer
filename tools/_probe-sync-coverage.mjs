// 只读探针：核对「增量同步会不会漏投稿」。
//
// 做三件事：
//   1. 按 tools/herta-update.mjs 的判据**重算**一遍计划（与脚本自己报的 total 交叉验证，
//      对得上才说明这份重算可信）；
//   2. 把线上 submission_config.json 与本地对比，找出「线上有、本地排期里没有」的期
//      （增量同步完全看不见这种期）；
//   3. 对每个「本轮被跳过」的组合，直接问线上 `/api/archive/submissions` 拿条数，
//      与本地文件条数对比 —— 差额就是**已经漏掉、且以后不会再补**的投稿。
//
// 全程不写盘（不覆盖 theherta/raw）。用法：
//   node tools/_probe-sync-coverage.mjs                 # 只核对被跳过的组合
//   node tools/_probe-sync-coverage.mjs --all           # 64 个组合全部核对
//   node tools/_probe-sync-coverage.mjs --only=4.5-Pure_Fiction,4.5-Memory_of_Chaos
//   node tools/_probe-sync-coverage.mjs --concurrency=3 --pause=200
//
// 在 worktree 里跑时 theherta/raw/ 是 gitignore 的、不存在，用 HERTA_DATA_DIR 指到主工作区：
//   HERTA_DATA_DIR=<repo>/theherta node tools/_probe-sync-coverage.mjs
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = process.env.HERTA_DATA_DIR ? resolve(process.env.HERTA_DATA_DIR) : join(ROOT, 'theherta');
const RAW = join(OUT, 'raw', 'submissions');
const BASE = process.env.HERTA_BASE || 'https://theherta.com';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ALL = process.argv.includes('--all');
const ONLY = arg('only', '');
const CONCURRENCY = Math.max(1, Number(arg('concurrency', '4')) || 4);
const PAUSE = Math.max(0, Number(arg('pause', '150')) || 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readJson = async (p, dflt = null) => {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return dflt; }
};
const fileFor = (season, mode) => join(RAW, `${season}-${mode.replace(/\s+/g, '_')}.json`);
const parseDay = (v) => (/^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? '')) || [])[0] || null;
const cmp = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};
const todayStr = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const getJson = async (path) => {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; hsr-sync-audit/1.0)' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/** 本地一个组合的条数 + 文件最后一次被写入的时间。 */
const localInfo = async (season, mode) => {
  const p = fileFor(season, mode);
  const data = await readJson(p);
  if (!data || !Array.isArray(data.items)) return { count: -1, mtime: null };
  const st = await stat(p).catch(() => null);
  return { count: data.items.length, mtime: st ? st.mtime : null };
};

const fmt = (d) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '—');

const main = async () => {
  const localCfg = await readJson(join(OUT, 'submission_config.json'));
  const remoteCfg = await getJson('/submission_config.json');
  if (!localCfg || !remoteCfg) throw new Error('读不到 submission_config.json');

  const now = todayStr();
  const localSeasons = (localCfg.seasons || []).map((s) => s.version).filter(Boolean);
  const remoteSeasons = (remoteCfg.seasons || []).map((s) => s.version).filter(Boolean);
  const localSet = new Set(localSeasons);
  const modes = localCfg.modes || [];
  const seasonEntry = (cfg, season) => cfg.seasons.find((s) => s.version === season) || {};

  // ---- 1. 重算计划（镜像 herta-update.mjs 的判据）
  const latestByMode = {};
  for (const season of localSeasons) {
    for (const mode of Object.keys(seasonEntry(localCfg, season).modes || {})) {
      if (!latestByMode[mode] || cmp(season, latestByMode[mode]) > 0) latestByMode[mode] = season;
    }
  }
  const rows = [];
  for (const season of localSeasons) {
    const scheduled = Object.keys(seasonEntry(localCfg, season).modes || {});
    const all = [...new Set([...scheduled, ...modes])];
    for (const mode of all) {
      const entry = seasonEntry(localCfg, season).modes?.[mode];
      const expire = parseDay(entry?.expireDate);
      const isLatest = latestByMode[mode] === season;
      const live = expire !== null && expire >= now;
      const local = await localInfo(season, mode);
      const neverSynced = local.count < 0;
      const target = neverSynced || isLatest || live;
      rows.push({
        season, mode, expire, live, isLatest, neverSynced, target,
        reason: neverSynced ? 'missing' : (isLatest ? 'latest' : (live ? 'live' : 'forced')),
        localCount: Math.max(0, local.count),
        localMtime: local.mtime,
      });
    }
  }

  // ---- 与脚本自己报的计划数交叉验证
  const plannedByScript = await new Promise((res) => {
    execFile(process.execPath, [join(ROOT, 'tools', 'herta-update.mjs'), '--plan-only', '--json'],
      { cwd: ROOT, env: { ...process.env, HERTA_DATA_DIR: OUT } }, (err, stdout) => {
        const line = String(stdout || '').split('\n').find((l) => l.includes('"type":"plan"'));
        let planned = null;
        try { planned = JSON.parse(line).total; } catch { /* 忽略 */ }
        res(planned);
      });
  });
  const mine = rows.filter((r) => r.target).length;
  console.log(`计划交叉验证：脚本 ${plannedByScript} / 本探针 ${mine} —— ${plannedByScript === mine ? '✓ 一致' : '✗ 不一致（判据可能已改）'}\n`);

  // ---- 2. 线上有、本地排期没有的期
  const onlyRemote = remoteSeasons.filter((v) => !localSet.has(v));
  console.log(`本地排期：${localSeasons.join(',')}`);
  console.log(`线上排期：${remoteSeasons.join(',')}`);
  if (onlyRemote.length) {
    for (const v of onlyRemote) {
      const m = Object.entries(seasonEntry(remoteCfg, v).modes || {})
        .map(([mode, x]) => `${mode} ${x.availableDate || '?'}~${x.expireDate || '?'}`);
      console.log(`  ⚠ 线上多出 ${v}：${m.join(' / ')} —— 本地排期里没有，增量同步永远抓不到`);
    }
  } else {
    console.log('  ✓ 线上没有本地排期之外的期');
  }
  // 排期日期漂移（同名期日期被改过）
  for (const v of localSeasons) {
    const a = seasonEntry(localCfg, v).modes || {};
    const b = seasonEntry(remoteCfg, v).modes || {};
    for (const mode of Object.keys(b)) {
      const x = a[mode] || {};
      if (x.availableDate !== b[mode].availableDate || x.expireDate !== b[mode].expireDate) {
        console.log(`  ⚠ ${v} ${mode} 排期漂移：本地 ${x.availableDate || '?'}~${x.expireDate || '?'} → 线上 ${b[mode].availableDate || '?'}~${b[mode].expireDate || '?'}`);
      }
    }
  }
  console.log('');

  // ---- 3. 逐组合对拍线上条数
  const onlySet = ONLY ? new Set(ONLY.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const pick = rows.filter((r) => {
    const key = `${r.season}-${r.mode.replace(/\s+/g, '_')}`;
    if (onlySet) return onlySet.has(key);
    return ALL || !r.target;
  });

  console.log(`对拍 ${pick.length} 个组合的线上条数（并发 ${CONCURRENCY}）…\n`);
  const queue = pick.slice();
  const results = [];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      let remoteCount = null;
      let error = null;
      try {
        const qs = new URLSearchParams({ season: row.season, mode: row.mode });
        const data = await getJson(`/api/archive/submissions?${qs}`);
        remoteCount = Array.isArray(data.items) ? data.items.length : 0;
      } catch (err) {
        error = err.message;
      }
      results.push({ ...row, remoteCount, error });
      await sleep(PAUSE);
    }
  });
  await Promise.all(workers);

  results.sort((a, b) => (b.remoteCount ?? -1) - (a.remoteCount ?? -1)
    || cmp(b.season, a.season) || a.mode.localeCompare(b.mode));

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('组合', 34)}${pad('本地', 7)}${pad('线上', 7)}${pad('差额', 7)}${pad('本轮', 8)}${pad('末次抓取', 12)}期结束`);
  let stale = 0;
  let staleSum = 0;
  for (const r of results) {
    const key = `${r.season} / ${r.mode}`;
    if (r.error) {
      console.log(`${pad(key, 34)}${pad(r.localCount, 7)}  (请求失败：${r.error})`);
      continue;
    }
    const delta = r.remoteCount - r.localCount;
    const flag = delta > 0 ? '  ⚠ 漏' : (delta < 0 ? '  ⚠ 本地比线上多' : '');
    const state = r.target ? (r.live ? '抓(live)' : '抓(latest)') : '跳过';
    console.log(`${pad(key, 34)}${pad(r.localCount, 7)}${pad(r.remoteCount, 7)}${pad(delta > 0 ? `+${delta}` : delta, 7)}${pad(state, 8)}${pad(fmt(r.localMtime), 12)}${r.expire || '无日期'}${flag}`);
    if (!r.target && delta > 0) { stale += 1; staleSum += delta; }
  }
  console.log(`\n被跳过却已经少数据的组合：${stale} 个，合计漏 ${staleSum} 条投稿（这些期已经结束，按现在的判据以后也不会再抓）。`);
};

main().catch((err) => { console.error('探针失败：', err.message); process.exitCode = 1; });
