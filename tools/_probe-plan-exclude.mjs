// 临时探针（2026-10-22）：校验「不使用」清单的两种语义。
//   * 排除角色 → 含它的配队整条消失；
//   * 排除光锥 → 队伍仍在，用它的那几笔补金 +1（S1 → 0 = 视为没有）。
// 用法：node tools/_probe-plan-exclude.mjs
import { runPlan } from '../src/server/gacha-plan-run.js';

const base = {
  envKey: 'aa|plight',
  // 一个「有飞霄 E6 + 专锥」的账号，让排除光锥确实减到 0。
  account: {
    owned: ['Feixiao', 'Ashveil', 'Tribbie', 'Mortenax Blade'],
    eidolons: { Feixiao: 6, Ashveil: 6, Tribbie: 6, 'Mortenax Blade': 6 },
    cones: { 'I Venture Forth to Hunt': 1, 'The Finale of a Lie': 1, 'If Time Were a Flower': 1 },
  },
  drawWeights: { strength: 1, cost: 1 },
  query: '飞霄',
  pageSize: 5,
};

const run = async (label, extra) => {
  const res = await runPlan({ ...base, ...extra });
  console.log(`\n== ${label} ==  命中 ${res.total} 条 · 排除 ${JSON.stringify(res.exclude)}`);
  for (const row of res.rows || []) {
    console.log(`  #${row.rank} ${row.score.toFixed(2)} 补${row.gap}金 |`,
      row.members.map((m) => `${m.charCn}E${m.eidolon}`).join(' / '));
  }
};

await run('不排除', {});
await run('排除角色 飞霄', { exclude: { characters: ['Feixiao'] } });
await run('排除光锥 我将巡征追猎', { exclude: { lightCones: ['I Venture Forth to Hunt'] } });
await run('角色+光锥都排除', {
  exclude: { characters: ['Feixiao'], lightCones: ['I Venture Forth to Hunt'] },
});
