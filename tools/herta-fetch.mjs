// Collect the complete public dataset of https://theherta.com/archive into
// ./theherta so the GUI can serve it offline.
//
// Why a script instead of curl: the site is a Next.js app behind Cloudflare's
// "Quick human check". Static JSON and the /api/public + /api/archive read
// endpoints answer plain requests fine (verified), so this uses node's global
// fetch. If the site ever starts challenging them, the `--cdp` mode drives the
// already-running Chrome over the DevTools Protocol instead, which carries the
// cleared Cloudflare clearance cookie.
//
// Usage:
//   node tools/herta-fetch.mjs                 # everything, plain fetch
//   node tools/herta-fetch.mjs --skip-bossdata # skip the ~22 MB schedule files
//   node tools/herta-fetch.mjs --only=stats    # just one group
//   node tools/herta-fetch.mjs --cdp           # fetch through Chrome (port 9222)
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'theherta');
const RAW = join(OUT, 'raw');

const BASE = process.env.HERTA_BASE || 'https://theherta.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const PAUSE_MS = Number(process.env.HERTA_PAUSE_MS || 350);
const CDP_PORT = Number(process.env.HERTA_CDP_PORT || 9222);

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const ONLY = arg('only', null);
const USE_CDP = flag('cdp');
const SKIP_BOSS = flag('skip-bossdata');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);

// ---------------------------------------------------------------- CDP bridge
//
// Minimal DevTools Protocol client: "/json/new" opens a page on the site so the
// origin is right, then every request is issued from inside that page with
// Runtime.evaluate, so Chrome attaches the Cloudflare clearance cookie itself.
let cdp = null;
const openCdp = async () => {
  const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
  let page = list.find((t) => t.type === 'page' && t.url.startsWith(BASE));
  if (!page) {
    page = await fetch(
      `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(`${BASE}/archive`)}`,
      { method: 'PUT' },
    ).then((r) => r.json());
    await sleep(6000);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message));
    else slot.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  log(`CDP: 使用页面 ${page.url}`);
  return { send, close: () => ws.close() };
};

const cdpEval = async (expression) => {
  const res = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || 'evaluate failed');
  }
  return res.result.value;
};

// ---------------------------------------------------------------- fetch layer

/** Fetch a path as text. Returns { status, text }. */
const grab = async (path) => {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  if (USE_CDP) {
    const out = await cdpEval(`(async () => {
      const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
      return { status: r.status, text: await r.text() };
    })()`);
    return out;
  }
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
    },
  });
  return { status: res.status, text: await res.text() };
};

const saved = [];
const saveJson = async (relPath, text, note = '') => {
  const full = join(OUT, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, text, 'utf8');
  let pretty = text;
  try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
  if (pretty !== text) await writeFile(full, pretty, 'utf8');
  const kb = (Buffer.byteLength(pretty) / 1024).toFixed(1);
  saved.push({ path: relPath, bytes: Buffer.byteLength(pretty) });
  log(`  ✓ ${relPath}  ${kb} KB${note ? `  ${note}` : ''}`);
  return JSON.parse(pretty);
};

const getJson = async (path, relPath, note = '') => {
  const { status, text } = await grab(path);
  if (status !== 200) throw new Error(`${path} -> HTTP ${status}: ${text.slice(0, 160)}`);
  const data = await saveJson(relPath, text, note);
  await sleep(PAUSE_MS);
  return data;
};

// ---------------------------------------------------------------- groups

const STATIC_FILES = [
  ['/characters_config.json', 'characters_config.json'],
  ['/character_paths.json', 'character_paths.json'],
  ['/lightcone_paths.json', 'lightcone_paths.json'],
  ['/popular_lightcones.json', 'popular_lightcones.json'],
  ['/submission_config.json', 'submission_config.json'],
];

const BOSS_FILES = [
  ['/boss-data/moc-schedule.json', 'boss-data/moc-schedule.json'],
  ['/boss-data/pf-schedule.json', 'boss-data/pf-schedule.json'],
  ['/boss-data/apoc-schedule.json', 'boss-data/apoc-schedule.json'],
  ['/boss-data/anom-schedule.json', 'boss-data/anom-schedule.json'],
];

const STATS_MODES = ['moc', 'pf', 'as', 'aa'];

const fetchStatic = async () => {
  log('\n[1/5] 静态字典');
  for (const [path, rel] of STATIC_FILES) await getJson(path, rel);
};

const fetchStats = async () => {
  log('\n[2/5] 各模式可用角色 (/api/public/stats/trends)');
  for (const mode of STATS_MODES) {
    await getJson(
      `/api/public/stats/trends?mode=${mode}`,
      join('raw', `stats-${mode}.json`),
    );
  }
};

const fetchDistinct = async () => {
  log('\n[3/5] 版本/模式/首领索引');
  const keys = await getJson('/api/archive/distinct-keys', join('raw', 'distinct-keys.json'));
  const articles = await getJson('/api/archive/articles', join('raw', 'articles.json'));
  return { keys, articles };
};

/**
 * Seasons and modes come from submission_config.json because it is the
 * authoritative schedule - distinct-keys only lists pairs that already have at
 * least one accepted run, so it would silently skip an empty mode.
 */
const fetchSubmissions = async (config) => {
  const seasons = (config.seasons || []).map((s) => s.version).filter(Boolean);
  const allModes = config.modes || [];
  log(`\n[4/5] 投稿战绩：${seasons.length} 个版本 × 最多 ${allModes.length} 个模式`);

  const index = { fetchedAt: new Date().toISOString(), combos: [], counts: {} };
  let total = 0;
  for (const season of seasons) {
    const modesForSeason = Object.keys(
      (config.seasons.find((s) => s.version === season) || {}).modes || {},
    );
    // Union: schedule says which modes ran; distinct-keys may know a few more.
    const modes = [...new Set([...modesForSeason, ...allModes])];
    for (const mode of modes) {
      const qs = new URLSearchParams({ season, mode });
      const rel = join('raw', 'submissions', `${season}-${mode.replace(/\s+/g, '_')}.json`);
      let data;
      try {
        data = await getJson(`/api/archive/submissions?${qs}`, rel);
      } catch (err) {
        warn(`  ✗ ${season} / ${mode}: ${err.message}`);
        index.combos.push({ season, mode, count: 0, error: err.message });
        continue;
      }
      const count = Array.isArray(data.items) ? data.items.length : 0;
      index.combos.push({ season, mode, count, file: rel.replace(/\\/g, '/') });
      index.counts[`${season}|${mode}`] = count;
      total += count;
      if (count === 0) {
        // Nothing to keep for an empty combination; drop the stub file.
        await writeFile(join(OUT, rel), '{"items":[]}', 'utf8');
      }
    }
  }
  await saveJson(join('raw', 'submissions-index.json'), JSON.stringify(index, null, 2));
  log(`  合计 ${total} 条战绩记录`);
  return { index, total };
};

const fetchBossData = async () => {
  log('\n[5/5] 首领排期（体积较大）');
  for (const [path, rel] of BOSS_FILES) {
    const full = join(OUT, rel);
    try {
      await access(full);
      log(`  · ${rel} 已存在，跳过`);
      continue;
    } catch { /* fetch it */ }
    const { status, text } = await grab(path);
    if (status !== 200) { warn(`  ✗ ${rel} -> HTTP ${status}`); continue; }
    await saveJson(rel, text);
    await sleep(PAUSE_MS);
  }
};

// ---------------------------------------------------------------- main

const main = async () => {
  await mkdir(RAW, { recursive: true });
  if (USE_CDP) cdp = await openCdp();
  const started = Date.now();
  log(`数据源: ${BASE}   输出: ${OUT}   模式: ${USE_CDP ? 'CDP' : 'plain fetch'}`);

  const want = (name) => !ONLY || ONLY === name;

  if (want('static')) await fetchStatic();
  if (want('stats')) await fetchStats();
  else if (!ONLY) await fetchStats();

  let keys = null;
  if (want('distinct') || want('submissions')) keys = await fetchDistinct();
  else if (!ONLY) keys = await fetchDistinct();

  if (want('submissions') || !ONLY) {
    const config = JSON.parse(await readFile(join(OUT, 'submission_config.json'), 'utf8'));
    await fetchSubmissions(config);
  }

  if ((want('bossdata') || !ONLY) && !SKIP_BOSS) await fetchBossData();

  // Manifest so the GUI (and a human) can tell what is on disk and when.
  const manifest = {
    source: BASE,
    fetchedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    files: saved,
    distinctKeyCount: keys?.keys?.items?.length ?? null,
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  log(`\n完成：${saved.length} 个文件，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  log(`清单：theherta/manifest.json`);
  cdp?.close();
};

main().catch((err) => {
  console.error('\n抓取失败:', err.message);
  process.exitCode = 1;
});
