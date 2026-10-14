// 手工探针（`_` 前缀，不进测试套件）：候选池的**价格下界**与「压金覆盖缺口」。
//
//   node tools/_probe-costpressure-poolfloor.mjs --account=1
//
// 问题：抽卡方案的候选池 = 「每角色 × 每档最佳整包」的最佳证据队伍。数据集里最便宜的
// 满分配置是否真的在池里？池里最便宜的是几金？
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, charCostOf, coneCostOf, eidolonTierOf, marginalCostOf, normalizeDrawWeights,
  ownedCharacters, eidolonsOf, lightConeRanksOf, teamPlan, teamPoolUnits, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const ACC = 1;
const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const cn = (n) => zhName(i18n, 'characters', n) || zhName(i18n, 'lightCones', n) || n;
const cnCone = (n) => (n ? zhName(i18n, 'lightCones', n) || n : null);
const zhToEn = {};
for (const c of index.refs?.characters || []) if (c.nameCn && c.name) zhToEn[c.nameCn] = c.name;
const coneZhToEn = {};
for (const c of index.refs?.lightCones || []) if (c.nameCn && c.name) coneZhToEn[c.nameCn] = c.name;
const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const account = accounts[ACC - 1];
const role = (account?.roles || [])[0];
const snapshot = await store.getSnapshot(account.id, role.uid);
const allNames = (index.refs?.characters || []).map((c) => c.nameCn).filter(Boolean);
const acct = {
  owned: ownedCharacters(snapshot, zhToEn, allNames),
  eidolons: eidolonsOf(snapshot, zhToEn),
  cones: lightConeRanksOf(snapshot, coneZhToEn),
};
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const conclusion = buildConclusion(envs, {
  availability, firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct, frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});
const plan = teamPlan(conclusion, acct, { availability, drawWeights: normalizeDrawWeights({}) });

const rosterKeyOf = (members) => members
  .map((m) => `${m.char}|E${eidolonTierOf(m.eidolon)}|${m.lc || '-'}|`
    + `S${Math.max(1, Math.round(Number(m.superimp) || 1))}`)
  .sort().join('~');
const teamText = (members) => members
  .map((m) => `${cn(m.char)}E${eidolonTierOf(m.eidolon)}${m.lc ? `+${cnCone(m.lc)}S${m.superimp}` : ''}`)
  .join(' / ');
const datasetGoldOf = (m) => {
  const body = charCostOf(m.char, availability);
  const cone = m.lc ? coneCostOf(m.lc, availability) : 0;
  const eid = body > 0 ? Math.max(0, Math.round(Number(m.eidolon) || 0)) : 0;
  const si = m.lc ? Math.max(1, Math.round(Number(m.superimp) || 1)) : 0;
  return body + eid + cone * si;
};

const units = teamPoolUnits(conclusion);
const byRoster = new Map();
for (const unit of units) {
  const ev = (unit.envs || []).find((e) => (e.members || []).length) || null;
  if (!ev?.members?.length) continue;
  const key = rosterKeyOf(ev.members);
  // ⚠️ 【旧口径】① 在 2026-10-15 之前是角色总榜的整包分（`unit.total`，含金数项）；
//    **现在** ① = 该队成员整包在总榜上的**绝对强度分**（`strengthScore`，0~100，与角色总榜
//    那一列同源）。本探针复刻的是**旧口径**（留着它才能做「修前复算」），别当成现行规则。
//
// ⚠️ ① 就是角色总榜的整包分（`unit.total`，含金数项）：v4.6.87~v4.6.90 那个独立的
  // `unit.strength`（纯强度）已按用户 2026-10-12 第 8 条删除，所以这里直接按 `total` 收敛。
  const total = Number(unit.total) || 0;
  const prev = byRoster.get(key);
  if (prev && !(total > prev.total)) continue;
  byRoster.set(key, { key, members: ev.members, total });
}
const pool = [];
for (const t of byRoster.values()) {
  const cost = marginalCostOf(t.members, availability, acct);
  if (!(cost.pulls > 0)) continue;
  pool.push({ ...t, gap: cost.pulls, gold: t.members.reduce((n, m) => n + datasetGoldOf(m), 0) });
}
const golds = pool.map((t) => t.gold).sort((a, b) => a - b);
console.log(`候选池 ${pool.length} 支：账面金数 min=${golds[0]} p25=${golds[Math.floor(golds.length * 0.25)]} `
  + `p50=${golds[Math.floor(golds.length * 0.5)]} max=${golds[golds.length - 1]}`);

const plight = frontierAll.find((f) => f.env === 'aa/plight');
const seasonsDesc = [...(plight.seasons || [])].sort((a, b) => {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0); if (d) return -d;
  }
  return 0;
});
const rowsByRoster = new Map();
for (const r of plight.frontierRows || []) {
  const k = rosterKeyOf(r.members);
  if (!rowsByRoster.has(k)) rowsByRoster.set(k, []);
  rowsByRoster.get(k).push(r);
}
const bestOf = (key) => [...(rowsByRoster.get(key) || [])]
  .sort((a, b) => a.cost - b.cost || a.actionValue - b.actionValue)[0] || null;

console.log(`\n=== 池里最便宜的 12 支（及其绝境最便宜证据）===`);
console.log('  #  账面 补金  绝境最便宜证据(金/AV/档位/版本)  总榜分   队伍');
[...pool].sort((a, b) => a.gold - b.gold).slice(0, 12).forEach((t, i) => {
  const b = bestOf(t.key);
  console.log(`  ${String(i + 1).padStart(2)} ${String(t.gold).padStart(4)} ${String(t.gap).padStart(4)}`
    + `  ${b ? `${String(b.cost).padStart(2)}金/${String(b.actionValue).padStart(3)}AV/${b.tier.padEnd(7)}/${String(b.season).padEnd(4)}`
      : '—                        '}`
    + ` ${t.total.toFixed(0).padStart(6)}   ${teamText(t.members)}`);
});

console.log(`\n=== 「数据集最便宜的满分配置」是否有资格进池（逐条核对）===`);
const newest = seasonsDesc[0];
const cheapest = (plight.frontierRows || [])
  .filter((r) => r.season === newest && r.tier === 'perfect' && r.actionValue < 300)
  .sort((a, b) => a.cost - b.cost || a.actionValue - b.actionValue);
const seen = new Set();
let shown = 0;
for (const r of cheapest) {
  const k = rosterKeyOf(r.members);
  if (seen.has(k)) continue;
  seen.add(k);
  if (shown >= 8) break;
  shown += 1;
  const inPool = pool.find((t) => t.key === k);
  console.log(`  ${String(r.cost).padStart(2)}金/${String(r.actionValue).padStart(3)}AV  在候选池：`
    + `${inPool ? `是（账面 ${inPool.gold} / 总榜分 ${inPool.total.toFixed(0)}）` : '否'}`
    + `  ${teamText(r.members)}`);
}
const cheapestGold = cheapest.length ? cheapest[0].cost : null;
// 「进池」判据：池里存在**同一份四人名单**的条目。
const uniq = [...seen];
const inPoolCount = uniq.filter((k) => pool.some((t) => t.key === k)).length;
console.log(`\n  最新版本（${newest}）满分（AV<300）的不同四人名单共 ${uniq.length} 份；`
  + `其中在候选池里的 ${inPoolCount} 份（${(inPoolCount / uniq.length * 100).toFixed(1)}%）`);
console.log(`  最新版本最便宜的满分 = ${cheapestGold} 金；候选池里**有绝境满分证据**的最便宜 = `
  + `${Math.min(...pool.filter((t) => {
    const b = bestOf(t.key);
    return b && b.tier === 'perfect' && b.actionValue < 300;
  }).map((t) => t.gold))} 金`);
// ⚠️ 别再写死「16 金首推队伍」：v4.6.91 起 ① 含金数项，生产首推换成 11 金那支了（见 docs v43）。
console.log(`  生产首推队伍（${plan.rows[0].gold} 金）= 池内第 ${[...pool].sort((a, b) => b.gold - a.gold)
  .findIndex((t) => t.key === plan.rows[0].key) + 1} 贵（共 ${pool.length} 支）`);
