// 增量更新本地 theherta 数据集：只抓「缺的版本」和「各副本最新版本」。
//
// 为什么不整包重抓：3.0–4.5 那些已结束的期不会再变，重抓纯属浪费带宽和时间。
// 实测需要抓的组合只有二十几个（其中大半是该副本当时还没上线的永久空档），
// 而全量是 64 个组合、约 56 MB。
//
// 判定规则：
//   抓取集合 = { 本地文件不存在或 0 条 的 (版本, 副本) } ∪ { 每个副本的最新版本 }
//   跳过     = 已经有数据且不是最新版本的一切
//
// 输出：每完成一个组合就打一行 JSON 到 stdout，供服务端 SSE 转发给界面：
//   {"type":"plan","targets":[...]}      计划
//   {"type":"progress","done":n,"total":m,"message":"..."}
//   {"type":"done","added":x,"updated":y,"errors":[...]}
//
// 用法:
//   node tools/herta-update.mjs                    # 增量（推荐）
//   node tools/herta-update.mjs --all              # 忽略增量，抓全部组合
//   node tools/herta-update.mjs --json             # 只输出 JSON 行（服务端用）
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'theherta');
const RAW = join(OUT, 'raw', 'submissions');
const BASE = 'https://theherta.com';
const JSON_ONLY = process.argv.includes('--json');
const ALL = process.argv.includes('--all');

/** 人类可读日志；--json 时改成 JSON 行，避免污染事件流。 */
const emit = (payload, human) => {
  if (JSON_ONLY) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else if (human) console.log(human);
};

const fileFor = (season, mode) => join(RAW, `${season}-${mode.replace(/\s+/g, '_')}.json`);

const readCount = async (season, mode) => {
  try {
    const data = JSON.parse(await readFile(fileFor(season, mode), 'utf8'));
    return Array.isArray(data.items) ? data.items.length : 0;
  } catch {
    return -1; // 文件不存在
  }
};

const getJson = async (path) => {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      accept: 'application/json',
      // 站点没有 Cloudflare 门禁，但带上 UA 更稳妥。
      'user-agent': 'Mozilla/5.0 (compatible; hsr-character-viewer/1.0)',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const main = async () => {
  const config = JSON.parse(await readFile(join(OUT, 'submission_config.json'), 'utf8'));
  const seasons = (config.seasons || []).map((s) => s.version).filter(Boolean);
  const allModes = config.modes || [];
  if (!seasons.length || !allModes.length) {
    emit({ type: 'failed', message: 'submission_config.json 里没有版本或模式列表' });
    process.exitCode = 1;
    return;
  }
  // "最新版本"按数字比较，4.10 要排在 4.9 之后。
  const cmp = (a, b) => {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  const latest = [...seasons].sort(cmp).pop();

  // ---- 计划：哪些组合要抓
  const targets = [];
  const skipped = [];
  for (const season of seasons) {
    const scheduled = Object.keys(
      (config.seasons.find((s) => s.version === season) || {}).modes || {},
    );
    const modes = [...new Set([...scheduled, ...allModes])];
    for (const mode of modes) {
      const count = await readCount(season, mode);
      const isLatest = season === latest;
      if (ALL || count <= 0 || isLatest) {
        targets.push({ season, mode, existing: Math.max(0, count), reason: count <= 0 ? 'missing' : (isLatest ? 'latest' : 'forced') });
      } else {
        skipped.push({ season, mode, count });
      }
    }
  }

  emit({
    type: 'plan',
    latest,
    targets: targets.map((t) => `${t.season} / ${t.mode}`),
    total: targets.length,
    skipped: skipped.length,
  }, `增量计划：抓 ${targets.length} 个组合，跳过 ${skipped.length} 个已完成的旧版本`
    + `（最新版本 ${latest} 永远重抓）`);

  await mkdir(RAW, { recursive: true });
  const errors = [];
  let added = 0;
  let updated = 0;
  let done = 0;

  for (const target of targets) {
    const { season, mode, existing } = target;
    done += 1;
    const qs = new URLSearchParams({ season, mode });
    try {
      const data = await getJson(`/api/archive/submissions?${qs}`);
      const count = Array.isArray(data.items) ? data.items.length : 0;
      await writeFile(fileFor(season, mode), JSON.stringify(data), 'utf8');
      if (existing === 0 && count > 0) added += count;
      else if (count !== existing) updated += Math.abs(count - existing);
      emit({
        type: 'progress', done, total: targets.length,
        message: `${season} / ${mode}：${count} 条`
          + (existing > 0 ? `（原有 ${existing}，${count === existing ? '无变化' : `变为 ${count}`}）` : '（新增文件）'),
      }, `  [${done}/${targets.length}] ${season} / ${mode} → ${count} 条`);
    } catch (err) {
      errors.push({ season, mode, error: err.message });
      emit({
        type: 'progress', done, total: targets.length,
        message: `${season} / ${mode}：失败（${err.message}）`,
      }, `  [${done}/${targets.length}] ${season} / ${mode} → 失败：${err.message}`);
    }
  }

  // ---- 更新索引（只刷新这次动过的组合）
  try {
    const indexPath = join(OUT, 'raw', 'submissions-index.json');
    let index = { fetchedAt: null, combos: [], counts: {} };
    try { index = JSON.parse(await readFile(indexPath, 'utf8')); } catch { /* 首次 */ }
    const touched = new Set(targets.map((t) => `${t.season}|${t.mode}`));
    index.fetchedAt = new Date().toISOString();
    index.combos = (index.combos || []).filter((c) => !touched.has(`${c.season}|${c.mode}`));
    for (const target of targets) {
      const count = await readCount(target.season, target.mode);
      index.combos.push({
        season: target.season,
        mode: target.mode,
        count: Math.max(0, count),
        file: `raw/submissions/${target.season}-${target.mode.replace(/\s+/g, '_')}.json`,
      });
      index.counts[`${target.season}|${target.mode}`] = Math.max(0, count);
    }
    await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');
  } catch (err) {
    errors.push({ season: '-', mode: 'index', error: err.message });
  }

  emit({
    type: 'done', added, updated, errors, total: targets.length, skipped: skipped.length,
  }, `\n增量抓取完成：新增 ${added} 条、变化 ${updated} 条`
    + (errors.length ? `，${errors.length} 个组合失败` : ''));
  if (errors.length) process.exitCode = 1;
};

main().catch((err) => {
  emit({ type: 'failed', message: err.message }, `抓取失败：${err.message}`);
  process.exitCode = 1;
});
