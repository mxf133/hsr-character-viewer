// 量「候选池」这道闸门有多大：**便宜但弱的队伍，有多少根本进不了池子**。
//
// 用户 2026-10-11：「任何队伍都应该有机会参与竞争，哪怕这支队伍本身实力不强，
// 但可以依靠差额接近度拉分，结果很有可能名列前茅。」
//
// 本轮修掉了「先按队分初选前 N 支」那道闸门（所有候选现在都会被算分）。但**候选池本身**
// 还有一道：池 = 「性价比总榜按队伍去重」= **每个角色只留分最高的那一个整包** ——
// 这条天然偏向强队。一支便宜但弱的队伍，只有在它恰好是某个角色的最佳整包时才进得来。
//
// 这个探针数三件事：
//   1. 窗口内**全部**前沿行里，一共有多少支**不同的队伍**（按 roster 去重）；
//   2. 其中有多少支进了候选池；
//   3. 被挡在池外的那批里，有多少是**便宜的**（补金 ≤ 2）—— 也就是用户最在意的那一类。
//
//   node tools/_probe-pool-gate.mjs
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, eidolonsOf, lightConeRanksOf, marginalCostOf, ownedCharacters,
  VERSION_WINDOW, teamPlan,
} from '../src/core/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const index = await archiveIndex();
const i18n = await loadI18n();
const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const account = accounts[0];
const role = (account.roles || [])[0];
const snap = await store.getSnapshot(account.id, role.uid);
const zh = {}; const all = [];
for (const c of index.refs?.characters || []) {
  if (c.nameCn && c.name) zh[c.nameCn] = c.name;
  if (c.nameCn) all.push(c.nameCn);
}
const cz = {};
for (const c of index.refs?.lightCones || []) if (c.nameCn && c.name) cz[c.nameCn] = c.name;
const acct = {
  owned: ownedCharacters(snap, zh, all),
  eidolons: eidolonsOf(snap, zh),
  cones: lightConeRanksOf(snap, cz),
};
const availability = index.refs?.availability || {};
const { envs } = await conclusionEnvs(index);
const cn = (n) => zhName(i18n, 'characters', n) || zhName(i18n, 'lightCones', n) || n;
const nameOf = (members) => members.map((m) => cn(m.char)).join('/');

const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const concl = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});

/** 与 `teamPlan` 内部的 roster 键同构（成员 + 档位 + 光锥 + 叠影，排序后拼接）。 */
const rosterKeyOf = (members) => members
  .map((m) => `${m.char}|E${Math.max(0, Math.min(6, Math.round(Number(m.eidolon) || 0)))}|`
    + `${m.lc || '-'}|S${Math.max(1, Math.round(Number(m.superimp) || 1))}`)
  .sort().join('~');

// ---- 1) 窗口内全部前沿行 → 去重成「全部队伍」 --------------------------------
const allTeams = new Map();
let rowCount = 0;
for (const f of frontierAll) {
  for (const row of f.frontierRows || []) {
    if (!row.members?.length) continue;
    rowCount += 1;
    const key = rosterKeyOf(row.members);
    if (!allTeams.has(key)) allTeams.set(key, { key, members: row.members, envs: new Set() });
    allTeams.get(key).envs.add(f.env);
  }
}

// ---- 2) 候选池 ---------------------------------------------------------------
const plan = teamPlan(concl, acct, { availability, maxRows: 100000 });
const poolKeys = new Set(plan.rows.map((r) => r.key));

console.log(`账号 ${role.nickname}｜默认总榜权重｜隐金不减`);
console.log(`窗口内前沿行 ${rowCount} 条（跨 ${frontierAll.length} 个副本）`);
console.log(`**全部不同的队伍 ${allTeams.size} 支**`);
console.log(`**候选池 ${plan.pool} 支**（总榜去重后 ${plan.poolAll}）`
  + ` → 被池挡在门外的 ${allTeams.size - poolKeys.size} 支`
  + `（${((1 - poolKeys.size / allTeams.size) * 100).toFixed(0)}%）`);

// ---- 3) 门外那批里，有多少是「便宜」的 ---------------------------------------
const outside = [...allTeams.values()].filter((t) => !poolKeys.has(t.key));
const withGap = outside.map((t) => ({
  ...t,
  gap: Math.max(0, Number(marginalCostOf(t.members, availability, acct).pulls) || 0),
}));
const byGap = new Map();
for (const t of withGap) byGap.set(t.gap, (byGap.get(t.gap) || 0) + 1);
console.log('\n门外那批的补金分布（补金 = 只算你缺的，与池内同口径）：');
const maxN = Math.max(...byGap.values());
for (const [g, n] of [...byGap].sort((a, b) => a[0] - b[0]).slice(0, 12)) {
  console.log(`  补 ${String(g).padStart(2)} 金 │ ${'█'.repeat(Math.max(1, Math.round(n / maxN * 40)))} ${n} 支`);
}
for (const th of [1, 2, 3, 5]) {
  const n = withGap.filter((t) => t.gap > 0 && t.gap <= th).length;
  console.log(`  其中「补金 ≤ ${th} 且 > 0」的：${n} 支`
    + `（池内同口径的是 ${plan.rows.filter((r) => r.gap > 0 && r.gap <= th).length} 支）`);
}
console.log('\n门外「补金 1~2 金」的样本（这些是**便宜但弱**那类，池子现在看不到）：');
for (const t of withGap.filter((x) => x.gap >= 1 && x.gap <= 2).slice(0, 12)) {
  console.log(`  · 补 ${t.gap} 金｜${nameOf(t.members)}｜跨 ${t.envs.size} 个副本`);
}
