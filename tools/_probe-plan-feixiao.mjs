// 临时探针（2026-10-22）：查「飞霄」在 4.4 绝境方案里的行、成绩与来源视频。
// 用法：node tools/_probe-plan-feixiao.mjs [查询词]
import { runPlan } from '../src/server/gacha-plan-run.js';

const q = process.argv[2] || '飞霄';
const res = await runPlan({
  envKey: 'aa|plight',
  account: { owned: [], eidolons: {}, cones: {} },
  drawWeights: { strength: 1, cost: 1 },
  query: q,
  pageSize: 20,
});
console.log('query', JSON.stringify(res.query), 'total', res.total, 'lineups', res.lineups);
for (const r of res.rows || []) {
  console.log('#', r.rank, r.score.toFixed(2), '|', r.members.map((m) => `${m.charCn}E${m.eidolon}`).join(' / '));
  console.log('    bestSeason', r.bestSeason, 'bestScore', r.bestScore, 'tier', r.tier, 'gap', r.gap);
  console.log('    seasons', (r.seasons || []).map((s) => `${s.season}:${Number(s.planScore).toFixed(2)}(a=${s.score},n=${s.submissions})`).join(' '));
  console.log('    video', r.video);
  console.log('    variants', (r.variants || []).length, 'alts', (r.alternatives || []).length);
}

