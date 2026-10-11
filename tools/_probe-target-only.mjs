// 探针（一次性，用户 2026-10-09 提问专用）：**哪些队伍只能达标？**
//
// 用户问「目前有哪些队伍是只能达标的」——这是决定「能不能把档位权重从算分里拿掉」
// 的关键前提：档位权重是 `perfect ×1 / target ×0.5`，拿掉之后**只有达标档的队伍**
// 分数翻倍。所以要先看清：
//
//   ① 每个副本的前沿里，达标档 / 满分档各占多少条；
//   ② 有多少支队伍**只出现过达标档**（从来没打出过满分）—— 这些就是会被翻倍的那批；
//   ③ 这些队伍在总榜上现在排多少名、去掉档位权重后会排到多少名（影响面有多大）。
//
// 它**只读**：`archiveFrontier` / `buildConclusion` 都是生产那一份，不另算口径。
// 「假设去掉档位权重」的那一列是用同一批 `env.value` 与同一个 `tierFactor` 现算的
// 比例关系（`target` 行 ×2），不是重跑一遍评分链 —— 真正改代码后再跑
// `node tools/_probe-rank.mjs` 核对。
//
// 用法：
//   node tools/_probe-target-only.mjs
//   node tools/_probe-target-only.mjs --rows=15
import { archiveIndex, archiveFrontierAll, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
import { buildConclusion, VERSION_WINDOW } from '../public/scripts/advice.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TOP = Math.max(1, Number(arg('rows', 12)) || 12);

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const cn = (n) => zhName(i18n, 'characters', n) || n;
const coneCn = (n) => (n ? (zhName(i18n, 'lightCones', n) || n) : '—');

const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const frontier = Object.fromEntries(frontierAll.map((f) => [f.env, f]));

// ---- ① 逐副本：达标 / 满分 各占多少条 -------------------------------------
console.log('=== ① 逐副本：前沿里的档位分布（只看进入前沿的记录）');
console.log('    副本                          池子达标条数   满分  条数   达标占比');
const tierStats = [];
for (const f of frontierAll) {
  const rows = frontier[f.env]?.frontierRows || [];
  const target = rows.filter((r) => r.tier === 'target').length;
  const perfect = rows.filter((r) => r.tier === 'perfect').length;
  const total = target + perfect;
  tierStats.push({ id: f.env, label: f.label, target, perfect, total });
  console.log(`    ${(f.label || f.env).padEnd(28)}`
    + `${String(total).padStart(6)}${String(target).padStart(8)}`
    + `${String(perfect).padStart(7)}${String(total).padStart(7)}`
    + `   ${total ? ((target / total) * 100).toFixed(1) : '—'}%`);
}
const gTarget = tierStats.reduce((n, s) => n + s.target, 0);
const gPerfect = tierStats.reduce((n, s) => n + s.perfect, 0);
console.log(`    ${'合计'.padEnd(28)}${String(gTarget + gPerfect).padStart(6)}${String(gTarget).padStart(8)}`
  + `${String(gPerfect).padStart(7)}${String(gTarget + gPerfect).padStart(7)}`
  + `   ${gTarget + gPerfect ? ((gTarget / (gTarget + gPerfect)) * 100).toFixed(1) : '—'}%\n`);

// ---- ② 哪些队伍只出现过达标档 --------------------------------------------
// 队伍身份 = 同一套阵容（角色+星魂+光锥+叠影 完全一致）。跨副本合并。
const rosterTier = new Map();
for (const f of frontierAll) {
  for (const row of frontier[f.env]?.frontierRows || []) {
    const key = row.members
      .map((m) => `${m.char}|${m.eidolon}|${m.lc || ''}|${m.superimp ?? ''}`)
      .sort()
      .join(' + ');
    if (!key) continue;
    if (!rosterTier.has(key)) {
      rosterTier.set(key, {
        key, perfect: false, target: false, envs: new Set(), members: row.members,
        bestGold: Infinity, seasons: new Set(),
      });
    }
    const hit = rosterTier.get(key);
    if (row.tier === 'perfect') hit.perfect = true;
    else hit.target = true;
    hit.envs.add(f.label || f.env);
    hit.seasons.add(row.season);
    if (Number(row.cost) > 0) hit.bestGold = Math.min(hit.bestGold, Number(row.cost));
  }
}
const rosters = [...rosterTier.values()];
const targetOnly = rosters.filter((r) => r.target && !r.perfect);
const hasPerfect = rosters.filter((r) => r.perfect);
console.log('=== ② 队伍档位覆盖（队伍 = 配装完全一致的那一套，跨副本合并）');
console.log(`    前沿里出现过的队伍共 ${rosters.length} 支`);
console.log(`    其中打出过满分的：${hasPerfect.length} 支`
  + `　｜　**只能达标**（从没满分）：${targetOnly.length} 支`
  + `　→ 只有这 ${targetOnly.length} 支的分数会被「去掉档位权重」翻倍`);
console.log(`    两档都出现过的：${rosters.filter((r) => r.perfect && r.target).length} 支\n`);

// ---- ③ 影响面：这些队伍在总榜上的位置 -------------------------------------
const result = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
  frontier,
  frontierWeights: Object.fromEntries(frontierAll.map((f) => [f.env, f.weight])),
});
const units = result.frontierUnits || [];
const rankOf = (u) => units.indexOf(u) + 1;
const label = (u) => `${cn(u.name)} E${u.eidolon}${u.lc ? ` + ${coneCn(u.lc)}S${u.superimp}` : ''}`;
// 一支「只能达标」的队伍 → 它整包里的角色。只认总榜上真的出现过的整包。
const rosterChar = (r) => new Set(r.members.map((m) => `${m.char}|${m.eidolon}|${m.lc || ''}`));
const affected = [];
for (const r of targetOnly) {
  const chars = rosterChar(r);
  for (const u of units) {
    if (!chars.has(`${u.name}|${u.eidolon}|${u.lc || ''}`)) continue;
    const dup = affected.find((a) => a.unit === u);
    if (dup) { dup.rosters.push(r); continue; }
    affected.push({ unit: u, rosters: [r] });
  }
}
console.log('=== ③ 总榜上受影响的整包（去掉档位权重后这些条目分数 ×2 的那一部分）');
if (!affected.length) {
  console.log('    榜面上**没有任何条目**的证据是「只能达标」——');
  console.log('    也就是说当前这批数据里，前沿队伍几乎都打出过满分档，');
  console.log('    去掉档位权重对榜面排序几乎不会有影响。');
} else {
  console.log('    整包                              现总分  现名次  只达标证据  涉及副本');
  for (const a of affected.sort((x, y) => rankOf(x.unit) - rankOf(y.unit)).slice(0, TOP)) {
    const envsHit = [...new Set(a.rosters.flatMap((r) => [...r.envs]))].join(' / ');
    console.log(`    ${label(a.unit).padEnd(32)}`
      + `${String(Math.round(a.unit.total)).padStart(7)}`
      + `${String(rankOf(a.unit)).padStart(8)}`
      + `${String(a.rosters.length).padStart(11)}  ${envsHit}`);
  }
  console.log(`\n    受影响整包共 ${affected.length} 条 / 榜面共 ${units.length} 条`
    + `　（前 ${TOP} 条已列出，按现名次排序）`);
}

// ---- ④ 顺带看一眼：榜面前列有没有「只能达标」的 ----------------------------
console.log('\n=== ④ 榜面前 10 名各自的证据档位（对照看）');
for (const u of units.slice(0, 10)) {
  const tiers = (u.envs || []).map((e) => (e.tier === 'perfect' ? '满分' : '达标'));
  console.log(`    ${String(rankOf(u)).padStart(3)}. ${label(u).padEnd(34)}`
    + `${String(Math.round(u.total)).padStart(6)}   ${tiers.join(' / ')}`);
}