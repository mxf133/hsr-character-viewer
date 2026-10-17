// 探针：抽卡方案卡片「最佳证据」那一行**最终会印出什么**（逐字）。
//
// 用户 2026-10-18 连报四个显示 bug：
//   ① 很多队伍没显示视频图标；
//   ② 末日幻影的积分和行动值重复了，就写具体积分；
//   ③ 混沌回忆 / 虚构叙事 / 异相仲裁·王棋和骑士关不存在行动值记录，不用写 0 行动值；
//   ④ （截图）很多队伍会再写个「0 金」，这一行不要显示。
//
// 这里直接调**生产实现** `teamPlan()`，并按界面那一句的拼法逐副本打印，
// 用来确认「哪个副本在撒谎 / 重复 / 多印」。
//
//   node tools/_probe-plan-display.mjs [--rows=4]
import { archiveConclusion } from '../src/server/conclusion.js';
import { metricValueTextOf, teamPlan, VERSION_WEIGHTS } from '../public/scripts/advice.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ROWS = Math.max(1, Number(arg('rows', '4')) || 4);

const t0 = Date.now();
const conclusion = await archiveConclusion({ owned: [], eidolons: {}, cones: {} }, {
  includeAllTeams: true,
});
const ms = Date.now() - t0;
const envs = conclusion.frontierEnvs || [];
const allTeams = conclusion.allTeams || [];
const videos = conclusion.allTeamVideos || [];

console.log(`载荷 ${(JSON.stringify(conclusion).length / 1024).toFixed(0)} KB · `
  + `全部队伍 ${allTeams.length} 支 · 视频字典 ${videos.length} 条 · 耗时 ${ms} ms\n`);

// ---- 判空 / 量纲助手（与 advice-view.js 逐字同源，改一处要同步改两处）------
const hasNumber = (v) => (typeof v === 'number' ? Number.isFinite(v)
  : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))));

const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

const tierLabelOf = (meta, tier) => {
  const lines = meta?.tierLines || {};
  if (!Number.isFinite(lines?.perfect) && !Number.isFinite(lines?.target)) return null;
  const two = Number.isFinite(lines?.target) ? lines.target : lines.perfect;
  if (meta?.stage === 'plight') {
    return tier === 'perfect' ? `行动值 <${fmt(lines.perfect)}` : `行动值 <${fmt(two)}`;
  }
  if (meta?.mode === 'as') {
    if (tier === 'perfect') return Number.isFinite(lines.perfect) ? `积分 ${fmt(lines.perfect)}` : null;
    const l = tier === 'target' ? lines.target : lines.pass;
    return Number.isFinite(l) ? `积分 ≥${fmt(l)}` : null;
  }
  if (tier === 'perfect') return Number.isFinite(lines.perfect) ? `${fmt(lines.perfect)}T` : null;
  const l = tier === 'target' ? lines.target : lines.pass;
  return Number.isFinite(l) ? `≤${fmt(l)}T` : null;
};

const scoreTextOf = (mode, stage, av, tierLabel) => {
  const n = Number.isFinite(Number(av)) ? Number(av) : null;
  if (n !== null) return metricValueTextOf(mode, stage, n);
  return tierLabel || '';
};

// ---- 逐副本抽样本，按界面那一句的拼法打印 --------------------------------
console.log('=== 逐副本：卡片「最佳证据」那一句 ===');
const samples = new Map();
for (const team of allTeams) {
  for (const rec of team.a || []) {
    const [envId, av, season, tier, videoIdx] = rec;
    if (!samples.has(envId)) samples.set(envId, []);
    const bucket = samples.get(envId);
    if (bucket.length < ROWS) bucket.push({ av, season, tier, videoIdx });
  }
}
for (const e of envs) {
  const bucket = samples.get(e.id) || [];
  console.log(`\n【${e.label}】 mode=${e.mode} stage=${e.stage || '-'}`);
  if (!bucket.length) { console.log('  （无样本）'); continue; }
  for (const s of bucket) {
    const tier = tierLabelOf(e, s.tier);
    const score = scoreTextOf(e.mode, e.stage, s.av, tier);
    const video = hasNumber(s.videoIdx) ? '[有视频图标]' : '[无视频图标]';
    console.log(`  最佳证据：${e.label} · ${score}`
      + `${s.season ? ` · ${s.season} 版本` : ''} ${video}`
      + `\n      （档位原写作「${tier ?? '—'}」/ 内部 av=${s.av}）`);
  }
}

// ---- 走生产 teamPlan，统计真实行里「0 金」与视频图标的分布 ---------------
console.log('\n=== 生产 teamPlan 输出（空账号） ===');
const plan = teamPlan(conclusion, {}, { versionWeights: VERSION_WEIGHTS });
const rows = plan.rows || [];
let zeroGold = 0;
let noGold = 0;
let noGoldButNotAllTeams = 0;
let withVideo = 0;
let fromAllTeams = 0;
for (const row of rows) {
  const b = row.bestEnv;
  if (row.allTeamsSource) fromAllTeams += 1;
  if (!b) continue;
  if (!hasNumber(b.bestTeamGold)) {
    noGold += 1;
    // allTeams 本来就没有 cost，它没有金数是**正常**的；
    // 其它池没有金数就说明数据链路掉了，要查。
    if (!row.allTeamsSource) noGoldButNotAllTeams += 1;
  } else if (Number(b.bestTeamGold) === 0) zeroGold += 1;
  if (b.video) withVideo += 1;
}
console.log(`  下发 ${rows.length} 支（其中 allTeams 来源 ${fromAllTeams} 支）`);
console.log(`  印出「0 金」${zeroGold} 支（**应为 0**）`);
console.log(`  没有金数（正常省略）${noGold} 支 · 其中**不该缺**的 ${noGoldButNotAllTeams} 支（**应为 0**）`);
console.log(`  最佳证据带视频地址：${withVideo} 支`
  + `（${rows.length ? ((withVideo / rows.length) * 100).toFixed(0) : 0}%）`);
console.log('\n注：allTeams 这一池本来就不带 `cost`，它的行**一律不写金数**；');
console.log('    逐档榜 / 行动值前沿那两池有真实金数，照常显示。');
