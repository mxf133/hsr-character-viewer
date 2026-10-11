// Cache the game's text tables from Mar-7th/StarRailRes for the Chinese
// localisation of the 抽卡推荐 page.
//
// The repository publishes the game's own text tables per language under
// identical numeric ids in index_min/<lang>/. Joining en with cn therefore
// yields exact official English -> Chinese pairs rather than a guess.
//
// Both language sides are cached under .snapref/ so the localisation build can
// run offline after one successful fetch.
//
// Usage: node tools/i18n-fetch-en.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.snapref');

const BASE = 'https://raw.githubusercontent.com/Mar-7th/StarRailRes/master/index_min';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/** [remote path, local cache name] for every table the localisation needs. */
export const TABLES = [
  ['en/characters.json', 'starrailres-en-characters.json'],
  ['cn/characters.json', 'starrailres-cn-characters.json'],
  ['en/light_cones.json', 'starrailres-en-lightcones.json'],
  ['cn/light_cones.json', 'starrailres-cn-lightcones.json'],
  ['cn/paths.json', 'starrailres-cn-paths.json'],
  ['cn/elements.json', 'starrailres-cn-elements.json'],
];

const fetchWithRetry = async (url, attempts = 4) => {
  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      // Surface the underlying reason: a bare `fetch failed` hides DNS /
      // TLS / proxy errors that are the actual diagnosis.
      lastError = err.cause ? `${err.message} (${err.cause.message})` : err.message;
      if (i < attempts) await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
  throw new Error(`${url} -> ${lastError}`);
};

export const fetchTables = async (log = console.log) => {
  await mkdir(OUT, { recursive: true });
  for (const [remote, local] of TABLES) {
    const text = await fetchWithRetry(`${BASE}/${remote}`);
    await writeFile(join(OUT, local), text, 'utf8');
    log(`  ✓ ${local}  ${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`);
  }
  return OUT;
};

/** Read a cached table, or fetch it when the cache is cold. */
export const tablePath = (local) => join(OUT, local);
export const hasCache = () => TABLES.every(([, local]) => existsSync(join(OUT, local)));

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  console.log(`缓存游戏文本表到 .snapref/`);
  await fetchTables();
  console.log('完成');
}
