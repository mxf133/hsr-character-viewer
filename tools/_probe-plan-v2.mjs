// 抽卡方案 v2 的冒烟探针：跑一次 runPlan 并打印前几行的关键字段。
// 用法：node tools/_probe-plan-v2.mjs [envKey] [maxRows]
import { runPlan } from '../src/server/gacha-plan-run.js';

const envKey = process.argv[2] || 'aa|plight';
const maxRows = Number(process.argv[3]) || 5;
const t0 = performance.now();
const res = await runPlan({
  envKey,
  account: { owned: [], eidolons: {}, cones: {} },
  drawWeights: { strength: 1, cost: 1 },
  maxRows,
});
console.log('ms', Math.round(performance.now() - t0));
console.log('ok', res.ok, 'available', res.available, 'pool', res.pool,
  'lineups', res.lineups, 'poolRows', res.poolRows);
console.log('env', res.env, res.envLabel, res.kind, 'window', res.window);
console.log('draw', JSON.stringify(res.drawWeights), 'wc', res.wc);
for (const r of (res.rows || []).slice(0, maxRows)) {
  console.log('---', r.score, '| gap', r.gap, '| gold', r.gold, '| best', r.bestSeason,
    '| video', r.video ? r.video.slice(0, 42) : 'no');
  console.log('   members:', r.members.map((m) => `${m.charCn || m.char}E${m.eidolon}`).join(' / '));
  console.log('   fill:', (r.fill || []).map((f) => `${f.nameCn || f.name}(${f.kindCn})`).slice(0, 4).join(', '));
  console.log('   seasons:', (r.seasons || []).map((s) => `${s.season}:${Number(s.planScore).toFixed(2)}`).join(' '));
  console.log('   alts:', (r.alternatives || []).length, 'variants:', (r.variants || []).length);
  for (const v of (r.variants || []).slice(0, 3)) {
    console.log('     ~', v.score, 'gap', v.gap,
      v.members.map((m) => `${m.charCn || m.char}:${m.lcCn || m.lc}S${m.superimp}`).join(', '));
  }
}
