// 探针：审计「角色性价比」这一列现在到底长什么样。
//
//   node tools/_probe-cost-audit.mjs
//
// 关注五件事（每一项都对应一个可疑的设计点）：
//   ① min-max 全榜归一之后，得分分布是不是被离群值压扁（大部分人挤在个位数）；
//   ② 同一角色不同星魂档的性价比分是不是**完全相同**（队伍口径的必然结果）；
//   ③ 金数项被封顶 ×1 的行占比（「更省金」不再有奖励的那一段有多长）；
//   ④ 0 金通关 ×1.2 与「最便宜/本队」不同源，能把单项分推到 100 以上多少条；
//   ⑤ 「已登场却无成绩算 0 分」把多少整包的性价比摊薄。
import {
  buildConclusion, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const cn = (n) => zhName(i18n, 'characters', n) || n;
const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const conclusion = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});

const units = [];
for (const list of Object.values(conclusion.frontierTiers || {})) units.push(...list);
const uniq = new Map();
for (const u of units) uniq.set(`${u.name}|${u.eidolon}|${u.lc}|${u.superimp}`, u);
const all = [...uniq.values()];

// ---- 原始量的刻度 ---------------------------------------------------------------
const ext = conclusion.frontierExtents?.cost || null;
const raws = all.map((u) => Number(u.total) || 0).sort((a, b) => a - b);
const q = (p) => raws[Math.min(raws.length - 1, Math.floor(p * (raws.length - 1)))];
const lo = ext ? Number(ext.lo) : raws[0];
const hi = ext ? Number(ext.hi) : raws[raws.length - 1];
console.log(`整包 ${all.length} 条｜性价比原始量刻度 lo=${lo.toFixed(2)} hi=${hi.toFixed(2)}`
  + `（跨度 ${(hi / Math.max(0.01, lo)).toFixed(0)} 倍）`);
console.log(`原始量分位：min=${raws[0].toFixed(2)} p25=${q(0.25).toFixed(2)} p50=${q(0.5).toFixed(2)}`
  + ` p75=${q(0.75).toFixed(2)} p90=${q(0.9).toFixed(2)} p99=${q(0.99).toFixed(2)} max=${raws[raws.length - 1].toFixed(2)}`);

// ---- ① min-max 之后的得分分布 ---------------------------------------------------
const score = (u) => Number(u.costScore) || 0;
const scores = all.map(score).sort((a, b) => b - a);
const sq = (p) => scores[Math.min(scores.length - 1, Math.floor(p * (scores.length - 1)))];
const below = (t) => scores.filter((s) => s < t).length;
console.log(`\n① 得分分布（0~100）：max=${scores[0].toFixed(1)} p99=${sq(0.01).toFixed(1)}`
  + ` p90=${sq(0.10).toFixed(1)} p50=${sq(0.50).toFixed(1)} p25=${sq(0.75).toFixed(1)} min=${scores[scores.length - 1].toFixed(1)}`);
console.log(`  得分 < 10 的 ${below(10)} 条（${(below(10) / scores.length * 100).toFixed(1)}%）`
  + `｜< 5 的 ${below(5)} 条｜≥ 50 的 ${scores.filter((s) => s >= 50).length} 条`
  + `｜≥ 90 的 ${scores.filter((s) => s >= 90).length} 条`);

// ---- ② 同一角色不同星魂档是否同分 -----------------------------------------------
const byChar = new Map();
for (const u of all) {
  const list = byChar.get(u.name) || [];
  list.push({ e: Number(u.eidolon), s: score(u), raw: Number(u.total) || 0, gold: u.gold, lc: u.lc });
  byChar.set(u.name, list);
}
let multi = 0; let identical = 0; let diff = 0;
const sameExamples = [];
for (const [name, list] of byChar) {
  if (list.length < 2) continue;
  multi += 1;
  const vals = list.map((x) => x.s.toFixed(6));
  if (new Set(vals).size === 1) {
    identical += 1;
    if (sameExamples.length < 4) sameExamples.push({ name, list });
  } else diff += 1;
}
console.log(`\n② 有 ≥2 个整包的角色 ${multi} 个：性价比得分**完全相同**的 ${identical} 个`
  + `（${(identical / Math.max(1, multi) * 100).toFixed(1)}%），有差异的 ${diff} 个`);
for (const { name, list } of sameExamples) {
  console.log(`   ${cn(name)}：` + list.map((x) => `E${x.e}(${x.lc || '无锥'}·${x.gold}金) 分${x.s.toFixed(1)}`).join(' / '));
}

// ---- ③ 金数项封顶占比（按逐行算）------------------------------------------------
let rowsSeen = 0; let cappedRows = 0; let zeroGoldRows = 0;
for (const f of frontierAll) {
  const meta = Object.fromEntries([['tierLines', f.tierLines], ['lowerIsBetter', f.lowerIsBetter]]);
  void meta;
  for (const r of f.frontierRows || []) {
    rowsSeen += 1;
    if (Number(r.cost) === 0) zeroGoldRows += 1;
  }
}
console.log(`\n③ 前沿行 ${rowsSeen} 条：0 金 ${zeroGoldRows} 条`
  + `（金数项拿固定 ×1.2，与「最便宜/本队」不同源）`);

// ---- ④ 单项分超过 100 的条目 ----------------------------------------------------
const over100 = all.filter((u) => {
  const envsOf = u.envs || [];
  return envsOf.some((e) => Number(e.score) > 100);
});
console.log(`\n④ 有 env.score > 100 的整包 ${over100.length} 个`
  + `（0 金队 ×1.2 × perf 1.00 可以到 120；性价比得分是 min-max 到 0~100，所以它只影响原始量）`);

// ---- ⑤ 「已登场却无成绩」的版本数 -----------------------------------------------
let withDropped = 0; let droppedSum = 0;
for (const u of all) {
  const d = (u.envs || []).reduce((n, e) => n + (Number(e.droppedSeasons) || 0), 0);
  if (d > 0) { withDropped += 1; droppedSum += d; }
}
console.log(`\n⑤ 有「已登场却无成绩」版本的整包 ${withDropped} / ${all.length}`
  + `（${(withDropped / all.length * 100).toFixed(1)}%），累计 ${droppedSum} 个版本槽被算 0 分`);

// ---- ⑥ 性价比与强度的相关性 -----------------------------------------------------
const str = all.map((u) => Number(u.strengthTotal) || 0);
const cst = all.map((u) => Number(u.total) || 0);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const ms = mean(str); const mc = mean(cst);
let num = 0; let ds = 0; let dc = 0;
for (let i = 0; i < all.length; i += 1) {
  num += (str[i] - ms) * (cst[i] - mc);
  ds += (str[i] - ms) ** 2;
  dc += (cst[i] - mc) ** 2;
}
const r = num / Math.sqrt(ds * dc);
console.log(`\n⑥ 强度原始量 vs 性价比原始量：Pearson r = ${r.toFixed(3)}`
  + `（|r| 越接近 1 说明两个分项越在量同一件事）`);
