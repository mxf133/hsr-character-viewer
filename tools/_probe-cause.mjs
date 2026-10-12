// 归因探针：砂金•戏浪 在 GUI（服务端通路）里掉到 #14 的因果链。
//
// 假设：`listEnvs` 的「完整性回退」把 异相仲裁 的版本从 4.6 退回 4.5，
//       而 `archiveFrontier` / `resolveScope` 的版本窗口是**锚定在选定版本**上的
//       （seasons.slice(idx-window+1, idx+1)）—— 回退把 4.6 **整个删出窗口**，
//       于是 砂金•戏浪 在 4.6 的最便宜证据（9 金队）根本进不了计算。
import { archiveFrontier, archiveFrontierAll, archiveIndex, archiveTeams, loadI18n, zhName } from '../src/server/archive.js';
import { buildConclusion, VERSION_WINDOW } from '../public/scripts/advice.js';

const index = await archiveIndex();
const i18n = await loadI18n();
const cn = (n) => zhName(i18n, 'characters', n) || n;
const frontierWeights = { 'moc|': 1, 'pf|': 1, 'as|': 1, 'aa|': 1, 'aa|plight': 10 };

// ---------- ① 直接看 archiveFrontier 的窗口锚定 ----------
for (const season of ['4.6', '4.5']) {
  const f = await archiveFrontier('aa', { season, stage: 'plight', window: VERSION_WINDOW });
  console.log(`\n=== archiveFrontier(aa / plight, season=${season}) ===`);
  console.log(`  窗口内版本(升序) : ${f.seasons.join('  ')}`);
  console.log(`  版本权重          : ${JSON.stringify(f.seasonWeights)}`);
  console.log(`  池=${f.pool}/${f.merged}（v4.6.78 起 = 窗口内全部成绩，不再截断）`);
  // 砂金 的每条前沿证据：看每个版本里它能压到几金
  const rows = f.frontierRows.filter((r) => (r.members || []).some((m) => cn(m.char).includes('砂金')));
  const bySeason = new Map();
  for (const r of rows) {
    const cur = bySeason.get(r.season);
    if (!cur || r.cost < cur.cost) bySeason.set(r.season, r);
  }
  for (const [s, r] of [...bySeason].sort()) {
    console.log(`    ${s}  最便宜 ${r.cost} 金  av=${r.actionValue}  t=${r.t}  `
      + `队伍=${(r.members || []).map((m) => `${cn(m.char)}E${m.eidolon}`).join('+')}`);
  }
  console.log(`    → 窗口里有砂金证据的版本: ${[...bySeason.keys()].sort().join(',') || '（无）'}`);
}

// ---------- ② 隔离：只改「异相仲裁两档」的锚定版本，其余完全走服务端口径 ----------
const build = async (aaSeason, plightSeason, label) => {
  const spec = [
    { id: 'moc', mode: 'moc', stage: '', season: '4.4' },
    { id: 'pf', mode: 'pf', stage: '', season: '4.4' },
    { id: 'as', mode: 'as', stage: '', season: '4.5' },
    { id: 'aa', mode: 'aa', stage: '', season: aaSeason },
    { id: 'aa/plight', mode: 'aa', stage: 'plight', season: plightSeason },
  ];
  const envs = [];
  for (const env of spec) {
    const data = await archiveTeams(env.mode, { season: env.season, stage: env.stage, window: 6, withEidoPerf: true, withFrontier: true });
    if (!data.ok) continue;
    envs.push({ ...env, season: data.season, totalRuns: data.totalRuns, reliable: data.reliable, tierLines: data.tierLines, lowerIsBetter: data.lowerIsBetter !== false, dist: data.dist || null, teams: data.teams, frontierRows: data.frontierRows });
  }
  const all = await archiveFrontierAll(envs, { window: VERSION_WINDOW, weights: frontierWeights });
  const r = buildConclusion(envs, {
    availability: index.refs?.availability || {},
    firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
    account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
    frontier: Object.fromEntries(all.map((f) => [f.env, f])),
    frontierWeights,
  });
  const idx = r.frontierUnits.findIndex((u) => cn(u.name).includes('砂金•戏浪'));
  console.log(`\n--- ${label} ---`);
  console.log(`   top3: ${r.frontierUnits.slice(0, 3).map((u) => `${cn(u.name)}E${u.eidolon}=${Math.round(u.total)}`).join('   ')}`);
  if (idx < 0) { console.log('   砂金•戏浪 不在榜'); return; }
  const u = r.frontierUnits[idx];
  console.log(`   砂金•戏浪 #${idx + 1} / ${r.frontierUnits.length}   总分 ${Math.round(u.total)}   `
    + `E${u.eidolon}·${u.lc}S${u.superimp}  整包${u.gold}金  证据副本数=${u.envCount}`);
  for (const e of u.envs) {
    console.log(`      ${e.id}  贡献=${Math.round(e.value)}  ${e.tier}  ${e.bestTeamGold}金  av=${e.actionValue}  `
      + `证据版本=${e.evidenceSeason}  不参与${e.absentSeasons}/0分${e.droppedSeasons}`);
  }
};

await build('4.5', '4.5', 'A 服务端口径（listEnvs 回退后：绝境锚在 4.5）＝ GUI 现状');
await build('4.6', '4.6', 'B 只把绝境的锚定版本改成 4.6（窗口随之上移，4.6 进入计算）');
