// 探针：总榜「星魂档」筛选的口径核对 —— 全部 / E0 / E1 / E2 / E6 各自有多少**角色**、
// 多少**整包**，以及「每角色每档留一条」的收敛结果会不会把载荷顶上去。
//
// 起因（用户 2026-10-11）：总榜「全部」没问题，但切到 E0/E1/E2/E6 只剩「最佳成绩就是那一档」
// 的角色 —— 一个角色如果 E2 最强，它的 E0 整包在 E0 页里根本看不到。这里量的是修之前
// 「收敛成一条」与修之后「每角色每档一条」的规模差。
//
//   node tools/_probe-tier-board.mjs            # 计数 + 估算载荷
//   node tools/_probe-tier-board.mjs --rows 12  # 每档再印前 N 名
import {
  buildConclusion, EIDOLON_TIERS, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (name, dflt) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return dflt;
};
const ROWS = Math.max(0, Number(arg('rows', '0')) || 0);

const index = await archiveIndex();
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const result = buildConclusion(envs, {
  availability: index.refs?.availability || {},
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});

const board = result.frontierUnits || [];
const byChar = result.frontierPacksByChar || {};
const allPacks = Object.values(byChar).flat();
const tiers = result.frontierTiers || null;
const kb = (v) => `${(Buffer.byteLength(JSON.stringify(v), 'utf8') / 1024).toFixed(1)} KB`;

console.log(`收敛后的榜（每角色一条）      ：${board.length} 条 / ${kb(board)}`);
console.log(`收敛前全部整包                ：${allPacks.length} 条 / ${kb(allPacks)}`);
console.log(`涉及角色                      ：${Object.keys(byChar).length} 个\n`);

// 「每角色每档留一条」= 修好筛选后服务端要发的那份。
// ⚠️ **优先读生产那份**（`frontierTiers`）：探针自己再算一遍就失去「验的是生产口径」的意义。
const perTier = new Map();
if (tiers) {
  for (const tier of EIDOLON_TIERS) perTier.set(tier, (tiers[tier] || []).map((u) => [u.name, u]));
} else {
  for (const tier of EIDOLON_TIERS) perTier.set(tier, new Map());
  for (const unit of allPacks) {
    const tier = Number(unit.eidolon) || 0;
    const bucket = perTier.get(tier);
    if (!bucket) continue;
    const prev = bucket.get(unit.name);
    if (!prev || unit.total > prev.total) bucket.set(unit.name, unit);
  }
}
const perTierRows = [];
for (const tier of EIDOLON_TIERS) {
  const rows = (tiers ? (tiers[tier] || []) : [...perTier.get(tier).values()])
    .slice().sort((a, b) => b.total - a.total);
  perTierRows.push(...rows);
  console.log(`  E${tier}：${String(rows.length).padStart(2)} 个角色 / `
    + `${String(allPacks.filter((u) => (Number(u.eidolon) || 0) === tier).length).padStart(3)} 个整包  `
    + `合起来 ${kb(rows)}`);
}
console.log(`\n每角色每档一条合计            ：${perTierRows.length} 条 / ${kb(perTierRows)}`);
console.log(`（当前「全部」那份是 ${board.length} 条 / ${kb(board)}）`);
console.log(`frontierTiers 是否存在        ：${tiers ? '是（生产口径）' : '否 —— 还是旧口径，筛选只能在「最佳成绩那一档」里挑'}`);

if (ROWS) {
  for (const tier of EIDOLON_TIERS) {
    const rows = (tiers ? (tiers[tier] || []) : [...perTier.get(tier).values()])
      .slice().sort((a, b) => b.total - a.total);
    console.log(`\n=== E${tier} 前 ${Math.min(ROWS, rows.length)} 名（每角色一条）===`);
    for (const [i, u] of rows.slice(0, ROWS).entries()) {
      console.log(`  #${String(i + 1).padStart(3)} ${String(Math.round(u.total)).padStart(5)}  `
        + `${u.name} E${u.eidolon}${u.lc ? ` + ${u.lc} S${u.superimp}` : ''}  ${u.gold} 金`);
    }
  }
  // 关键回归：找几个「整体最强不在 E0、但确实有 E0 整包」的角色，确认它们在 E0 页里出现。
  const best = new Map(board.map((u) => [u.name, Number(u.eidolon) || 0]));
  const hidden = [...perTier.get(0).values()].map((v) => (Array.isArray(v) ? v[1] : v))
    .filter((u) => best.get(u.name) !== 0)
    .sort((a, b) => b.total - a.total);
  console.log(`\n=== 旧口径下**在 E0 页看不到**的角色：${hidden.length} 个 ===`);
  for (const u of hidden.slice(0, ROWS)) {
    console.log(`  ${u.name}：E0 整包 ${Math.round(u.total)}，但它的最佳成绩是 E${best.get(u.name)}`);
  }
}
