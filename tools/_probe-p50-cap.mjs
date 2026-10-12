// ⚠️ 口径变更：① 在 v4.6.87~v4.6.90 一度是**纯强度**（不含金数项）；v4.6.91 回到
// **总榜分含金数项**归一化（`rows[].strengthPct` 是池内位置，原始值 `rows[].teamScore`）。
//
// 落地「线性 / p50 封顶」前先量一件事：封顶之后有多少队伍会被压到 ②=0。
//
//   node tools/_probe-p50-cap.mjs
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, eidolonsOf, lightConeRanksOf, SCORING, teamPlan, ownedCharacters, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const index = await archiveIndex();
const i18n = await loadI18n();
const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const availability = index.refs?.availability || {};
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });

for (const [i, account] of accounts.entries()) {
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
  const concl = buildConclusion(envs, {
    availability,
    firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
    account: acct,
    frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  });
  const plan = teamPlan(concl, acct, { availability });
  const gaps = plan.rows.map((r) => r.gap).sort((a, b) => a - b);
  const med = gaps.length % 2
    ? gaps[(gaps.length - 1) / 2]
    : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
  const zero = gaps.filter((g) => g >= med).length;

  console.log(`\n账号 ${i + 1}　${role.nickname}`);
  console.log(`  下发 ${gaps.length} 支 · 差额 ${gaps[0]}~${gaps[gaps.length - 1]} 金`
    + ` · **中位（= p50 封顶值）${med} 金**`);
  console.log(`  p50 封顶后 ②=0 的队伍：${zero} 支（${(zero / gaps.length * 100).toFixed(0)}%）`
    + `，②>0 的：${gaps.length - zero} 支`);
  console.log(`  差额 < 中位的那些值：${[...new Set(gaps.filter((g) => g < med))].join(', ')} 金`);
  console.log(`  这些是「② 有分」的队伍：`);
  for (const g of gaps.filter((x) => x < med)) {
    console.log(`    ${g} 金 → ② ${(100 * (1 - g / med)).toFixed(1)}`
      + `　（${gaps.filter((x) => x === g).length} 支）`);
  }
  // 前 10 名在 p50 封顶下的分项
  const rows = plan.rows.map((r) => ({
    ...r,
    // ⚠️ 「新」那一列要跟生产同口径（含曲线指数），否则这条对照从 v4.6.92 起就是假的。
gapPctNew: 100 * Math.max(0, Math.min(1, 1 - r.gap / med)) ** (Number(SCORING.teamPlanGapPower) || 1),
  })).map((r) => ({
    ...r,
    // 等权 0.5/0.5 = 默认抽卡权重（1:1）；这里刻意不读 `plan.drawWeights`。
    totalNew: 0.5 * r.strengthPct + 0.5 * r.gapPctNew,
  }))
    .sort((a, b) => b.totalNew - a.totalNew);
  console.log('  前 10 名（按新总分）：');
  for (const [j, r] of rows.slice(0, 10).entries()) {
    console.log(`    #${String(j + 1).padStart(2)} 总分 ${r.totalNew.toFixed(1).padStart(5)}`
      + `　① ${r.strengthPct.toFixed(1).padStart(5)}　② ${r.gapPctNew.toFixed(1).padStart(5)}`
      + `（${String(r.gap).padStart(2)} 金）　`
      + r.members.map((m) => zhName(i18n, 'characters', m.char) || m.char).join('/'));
  }
  const span = rows[0].totalNew - rows[9].totalNew;
  console.log(`  前 10 名总分跨度 = ${span.toFixed(1)}`);
}
