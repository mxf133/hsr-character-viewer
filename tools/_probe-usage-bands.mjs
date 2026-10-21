// 上场率（环境统计）现状探针：5 个副本 × 4 档的样本量 + 前 N 角色 + 口径核对。
//
// 核对：
//   ① 每档 `submissions`（环心印的「条投稿」）是**投稿数**还是**配装行数**
//      —— 看 `archiveUsage()` 映射 frontierRows 时有没有透传 `submissions`（建库侧 `n`）。
//   ② 四张饼是**嵌套**关系（0T ⊂ 通关），不是四分互斥。
//   ③ 各档与「通关」档的角色构成重合度 —— 用来判断哪几张图是信息冗余。
//
//   node tools/_probe-usage-bands.mjs [--window=6] [--top=5]
import { archiveFrontierAll, archiveIndex } from '../src/server/archive.js';
import { archiveUsage, conclusionEnvs } from '../src/server/conclusion.js';

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const WINDOW = Math.max(1, Number(arg('window', '6')) || 6);
const TOP = Math.max(1, Number(arg('top', '5')) || 5);

const t0 = Date.now();
const res = await archiveUsage({ window: WINDOW });
console.log(`archiveUsage(window=${WINDOW}) ok=${res.ok} 用时 ${Date.now() - t0}ms，window=${res.window}`);
console.log('');

for (const env of res.envs || []) {
  console.log(`## ${env.label}  kind=${env.kind} season=${env.season}`);
  for (const band of env.bands) {
    const subs = band.submissions ?? 0;
    const rows = band.entries ?? 0;
    // 「投稿 / 行」比值恒等 1 说明 `n` 在映射时丢了，全部按 1 记。
    const ratio = rows > 0 ? (subs / rows).toFixed(3) : '—';
    const top = band.items
      .filter((it) => !it.other)
      .slice(0, TOP)
      .map((it) => `${it.charCn || it.char} ${(it.share * 100).toFixed(1)}%`)
      .join(' / ');
    console.log(`  ${String(band.key).padEnd(6)} ${String(band.label).padEnd(16)} 样本=${String(subs).padStart(6)} 行=${String(rows).padStart(6)} 比值=${ratio}`);
    console.log(`         ${top}`);
  }
  console.log('');
}

// 口径核对：直接从 archiveFrontierAll 拿 frontierRows，对比 Σsubmissions 与行数。
console.log('=== 口径核对：frontierRows 的 submissions 总和 vs 行数 ===');
const index = await archiveIndex();
const { envs, window } = await conclusionEnvs(index, { window: WINDOW });
let totalRows = 0;
let totalSubs = 0;
for (const env of envs) {
  const [f] = await archiveFrontierAll([env], { window });
  if (!f?.ok) continue;
  const rows = f.frontierRows || [];
  const subs = rows.reduce((n, r) => n + (Number(r.submissions) || 0), 0);
  totalRows += rows.length;
  totalSubs += subs;
  console.log(`${env.label}: ${rows.length} 行 / Σsubmissions=${subs}（比值 ${(subs / Math.max(1, rows.length)).toFixed(3)}）`);
}
console.log(`合计：${totalRows} 行 / ${totalSubs} 条投稿（比值 ${(totalSubs / Math.max(1, totalRows)).toFixed(3)}）`);
console.log('');

// 与「通关」档的重合度：以 Top10 角色集合的 Jaccard 系数衡量信息冗余。
console.log('=== 各档与「通关」档的 Top10 重合度（Jaccard）===');
for (const env of res.envs || []) {
  const clear = env.bands.find((b) => b.key === 'clear');
  if (!clear) continue;
  const clearSet = new Set(clear.items.filter((i) => !i.other).map((i) => i.char));
  const parts = [];
  for (const band of env.bands) {
    if (band.key === 'clear') continue;
    const set = new Set(band.items.filter((i) => !i.other).map((i) => i.char));
    let inter = 0;
    for (const c of set) if (clearSet.has(c)) inter += 1;
    const uni = clearSet.size + set.size - inter;
    parts.push(`${band.key}=${(inter / Math.max(1, uni)).toFixed(2)}`);
  }
  console.log(`${env.label}: ${parts.join('  ')}`);
}
