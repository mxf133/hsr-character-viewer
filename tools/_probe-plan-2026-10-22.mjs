// 临时探针（2026-10-22）：一次性校验本轮四条改动在**载荷层**的表现。
//   * 首领：`plan.bosses[最佳版本]` 有中文名 + 图标路由；
//   * 视频：`row.video` 是 B 站、`row.videoSources` 有多条；
//   * 排除：角色剔除 / 光锥叠影 -1 都生效，且 `exclude` 原样回显；
//   * 变体：`row.variants` 全部下发（前端不再截断）。
import { runPlan } from '../src/server/gacha-plan-run.js';

const base = {
  envKey: 'aa|plight',
  account: {
    owned: ['Feixiao', 'Ashveil', 'Tribbie', 'Mortenax Blade'],
    eidolons: { Feixiao: 6, Ashveil: 6, Tribbie: 6, 'Mortenax Blade': 6 },
    cones: { 'I Venture Forth to Hunt': 1 },
  },
  drawWeights: { strength: 1, cost: 1 },
  query: '飞霄',
  pageSize: 3,
};

const res = await runPlan(base);
console.log('== 首领（按版本）==');
for (const [season, list] of Object.entries(res.bosses || {})) {
  console.log(' ', season, list.map((b) => `${b.nameCn || b.name}${b.icon ? ' ⟨icon⟩' : ' ⟨无图标⟩'}`).join(' | '));
}
console.log('== 行 ==');
for (const row of res.rows || []) {
  console.log(`#${row.rank} ${row.score.toFixed(2)} 最佳 ${row.bestSeason} 补${row.gap}金`);
  console.log('  video:', row.video);
  console.log('  sources:', (row.videoSources || []).length, (row.videoSources || []).slice(0, 3).map((s) => `${s.av ?? '-'} ${s.url.slice(0, 34)}`));
  console.log('  variants:', (row.variants || []).length);
  const boss = (res.bosses || {})[row.bestSeason] || [];
  console.log('  该版本首领:', boss.map((b) => b.nameCn).join('、') || '（无）');
}
console.log('== 排除 ==');
const noFeixiao = await runPlan({ ...base, exclude: { characters: ['Feixiao'] } });
console.log('  排除飞霄 → 命中', noFeixiao.total, '回显', JSON.stringify(noFeixiao.exclude));
const noCone = await runPlan({ ...base, exclude: { lightCones: ['I Venture Forth to Hunt'] } });
const first = (noCone.rows || [])[0];
console.log('  排除专锥 → 首行补金', first?.gap, first?.members.map((m) => `${m.charCn}`).join('/'));
