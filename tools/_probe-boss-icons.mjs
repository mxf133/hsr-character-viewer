// 临时探针（2026-10-22）：校验「首领名 → BWiki 页面 → 头像」这条链。
// 用法：node tools/_probe-boss-icons.mjs [要试的条数]
import { bossPlanOf, mirrorBossIcons, bossIconMap } from '../src/server/icon-fetch.js';

const limit = Number(process.argv[2]) || 4;
const plan = await bossPlanOf();
console.log('首领总数', plan.length);
console.log(plan.slice(0, 8).map((p) => `${p.name} → ${p.zh} (base ${p.base}, key ${p.key})`).join('\n'));

if (process.argv[3] === '--fetch') {
  // 只跑前 N 条：临时把 plan 截断的等价做法 —— 直接调 mirror，但先看整体是否可控。
  const started = Date.now();
  const result = await mirrorBossIcons({
    onProgress: ({ done, skipped, total }) => process.stdout.write(`\r  ${done + skipped}/${total} `),
  });
  console.log('\nadded', result.added, 'skipped', result.skipped, 'failed', result.failed,
    'secs', ((Date.now() - started) / 1000).toFixed(1));
  for (const f of result.failures) console.log('  ✗', f.name, '|', f.zh, '|', f.message);
  const map = await bossIconMap();
  console.log('可用图标', map.size, [...map.entries()].slice(0, 5));
} else {
  console.log('（加 --fetch 实抓）', limit);
}
