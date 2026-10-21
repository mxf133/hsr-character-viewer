// 临时对拍（不入库）：确认「满分榜」与改之前完全一致（key 序列 + 分数序列）。
import { archiveFrontierAll, archiveIndex } from '../src/server/archive.js';
import { scoreEnvRows } from '../src/server/gacha-score.js';
import { buildPlanPool } from '../src/server/gacha-plan.js';
import { runPlan } from '../src/server/gacha-plan-run.js';

const toRow = (x) => ({
  season: x.season,
  c: Number(x.cost) || 0,
  a: x.actionValue === null ? null : Number(x.actionValue),
  n: Math.max(1, Number(x.submissions) || 1),
  m: (x.members || []).map((m) => `${m.char}|${m.eidolon}|${m.lc || '-'}|${m.superimp || 1}`),
  tier: x.tier,
});

const [f] = await archiveFrontierAll(
  [{ id: 'aa|plight', mode: 'aa', stage: 'plight' }],
  { window: 6, minTier: 3 },
);
const scored = scoreEnvRows(f.frontierRows.map(toRow), {
  mode: 'aa', stage: 'plight', ws: 1, wc: 0.5,
  versionWeightOf: (s) => Number(f.seasonWeights?.[s] ?? 1),
}).scored;
const index = await archiveIndex();
const pool = buildPlanPool(scored, { availability: index.refs?.availability || {}, wc: 0.5, ws: 0.5 });

const got = [];
for (let page = 1; page <= 3; page += 1) {
  const res = await runPlan({ envKey: 'aa|plight', account: { owned: [] }, page, pageSize: 200 });
  got.push(...res.rows.filter((r) => r.tier === 'perfect'));
  if (res.rows.length < 200) break;
}

console.log('只喂满分的池', pool.lineups.length, '｜接口回来的满分行', got.length);
const keys = pool.lineups.map((x) => x.key);
const keys2 = got.map((x) => x.key);
console.log('key 序列一致：', JSON.stringify(keys) === JSON.stringify(keys2));
const s1 = pool.lineups.map((x) => x.score.toFixed(6)).join();
const s2 = got.map((x) => Number(x.score).toFixed(6)).join();
console.log('分数序列一致：', s1 === s2);
const g1 = pool.lineups.map((x) => `${x.gap}/${x.gold}`).join();
const g2 = got.map((x) => `${x.gap}/${x.gold}`).join();
console.log('补金序列一致：', g1 === g2);

console.log('视频列：满分行', got.filter((x) => x.video).length, '/', got.length,
  '有视频；全为合法 URL 或空：',
  got.every((x) => x.video === null || /^https?:\/\//.test(x.video)));

