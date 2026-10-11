// 探针：核对「光锥/叠影整条缺失」的投稿，本地副本与黑塔网实时接口是否一致（用户第 8 条）。
//
// 本地 3.1 等版本里有大量投稿的 p*_lc 全是 null（连叠影一起丢），导致我们算出来的
// 队伍金数偏低。这里直接问一次线上接口，看是「站点当时就没记」还是「我们读漏了」。
//
// 用法：node tools/_probe-live-lc.mjs [--season=3.1] [--mode=Memory of Chaos]
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const SEASON = arg('season', '3.1');
const MODE = arg('mode', 'Memory of Chaos');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const localPath = join(ROOT, 'theherta', 'raw', 'submissions', `${SEASON}-${MODE.replace(/\s+/g, '_')}.json`);
const local = JSON.parse(await readFile(localPath, 'utf8'));
const localById = new Map((local.items || []).map((r) => [r.id, r]));

const url = `https://theherta.com/api/archive/submissions?season=${encodeURIComponent(SEASON)}&mode=${encodeURIComponent(MODE)}`;
const res = await fetch(url, {
  headers: {
    'User-Agent': UA,
    Accept: 'application/json,text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
  },
});
console.log('HTTP', res.status, url);
const live = await res.json();
const liveItems = live.items || [];
console.log('本地条数', local.items?.length, '线上条数', liveItems.length);

const lcOf = (r) => [1, 2, 3, 4].map((i) => r[`p${i}_lc`]).filter((x) => x !== null && x !== undefined && x !== '');
const localEmpty = (local.items || []).filter((r) => lcOf(r).length === 0).length;
const liveEmpty = liveItems.filter((r) => lcOf(r).length === 0).length;
console.log('本地「一个光锥都没有」的条数', localEmpty, '/ 线上', liveEmpty);

// 同一条投稿逐字段比对：线上有光锥、本地没有 → 我们的副本是旧的/读漏了
let fixed = 0;
const samples = [];
for (const r of liveItems) {
  const mine = localById.get(r.id);
  if (!mine) continue;
  const a = lcOf(mine).length;
  const b = lcOf(r).length;
  if (b > a) {
    fixed += 1;
    if (samples.length < 6) {
      samples.push({
        id: r.id,
        local: [1, 2, 3, 4].map((i) => [mine[`p${i}_char`], mine[`p${i}_lc`], mine[`p${i}_superimp`]]).filter((x) => x[0]),
        live: [1, 2, 3, 4].map((i) => [r[`p${i}_char`], r[`p${i}_lc`], r[`p${i}_superimp`]]).filter((x) => x[0]),
      });
    }
  }
}
console.log('线上比本地多出光锥的条数', fixed);
console.log(JSON.stringify(samples, null, 1));
