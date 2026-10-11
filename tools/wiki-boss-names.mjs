// Probe the Chinese HSR wiki (biligame) for the official names of every boss the
// theherta dataset references, so the mapping in tools/data/hsr-bosses-zh.mjs can
// be transcribed from a source rather than guessed.
//
// Usage: node tools/wiki-boss-names.mjs            # search every dataset boss
//        node tools/wiki-boss-names.mjs <term>     # search one term
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const API = 'https://wiki.biligame.com/sr/api.php';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const search = async (term, retries = 3) => {
  for (let i = 1; i <= retries; i += 1) {
    try {
      const qs = new URLSearchParams({
        format: 'json', action: 'query', list: 'search', srsearch: term, srlimit: '8',
      });
      const res = await fetch(`${API}?${qs}`, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return (data.query?.search || []).map((h) => h.title);
    } catch (err) {
      if (i === retries) return [`(失败: ${err.message})`];
      await sleep(300 * i);
    }
  }
  return [];
};

/** The boss names the dataset actually uses, gathered from archive.json. */
const datasetBosses = async () => {
  if (!existsSync('theherta/archive.json')) return [];
  const archive = JSON.parse(await readFile('theherta/archive.json', 'utf8'));
  const used = new Set();
  for (const mode of Object.values(archive.modes || {})) {
    for (const season of Object.values(mode.seasons || {})) {
      for (const team of season.teams || []) {
        for (const b of team.bosses || []) used.add(b.name);
      }
    }
  }
  for (const entry of archive.schedule || []) {
    for (const info of Object.values(entry.modes || {})) {
      for (const b of info.bosses || []) used.add(b.name);
    }
  }
  return [...used].sort();
};

const one = process.argv[2];
if (one) {
  console.log(`搜索 "${one}":`);
  for (const t of await search(one)) console.log(`  ${t}`);
  process.exit(0);
}

const names = await datasetBosses();
console.log(`数据集里共 ${names.length} 个首领名，逐个查询中文 wiki：\n`);
for (const name of names) {
  // Strip the site's own variant suffixes before searching.
  const stem = name.replace(/\s*[(（](?:Plight|K\d)[)）]\s*$/i, '')
    .replace(/:\s*Plight\s*$/i, '')
    .trim();
  const hits = await search(stem);
  console.log(`${name}`);
  console.log(`  -> ${hits.slice(0, 5).join(' | ')}`);
  await sleep(180);
}
