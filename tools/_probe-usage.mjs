import { archiveUsage } from '../src/server/conclusion.js';

const t0 = Date.now();
const r = await archiveUsage({});
console.log('耗时', Date.now() - t0, 'ms | 副本数', r.envs.length, '| window', r.window);
for (const env of r.envs) {
  console.log(`\n## ${env.id} (${env.kind}) season=${env.season}`);
  for (const band of env.bands) {
    const top = band.items.slice(0, 3)
      .map((it) => `${it.char} ${(it.share * 100).toFixed(1)}%`).join(' / ');
    const sum = band.items.reduce((n, it) => n + it.share, 0);
    console.log(`  ${band.label.padEnd(14)} 投稿 ${String(band.submissions).padStart(4)} 行 ${String(band.entries).padStart(4)} | ${top} | 项数 ${band.items.length} Σshare=${sum.toFixed(4)}`);
  }
}
