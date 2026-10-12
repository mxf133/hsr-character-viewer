// ⚠️ 口径变更：分项① 在 v4.6.87~v4.6.90 一度是**纯强度**（不含金数项）；v4.6.91 回到
// **总榜分含金数项**归一化（`rows[].strengthPct` 是池内位置，原始值 `rows[].teamScore`）。
//
// ① 量当前结论载荷的余量（e2e 的硬断言是 < 600 KB）；
// ② 在 **B 池**（每角色 × 每星魂档）上对照几种 ② 封顶规则，看哪一种既不压死强队、
//    又给便宜队机会。
//
//   node tools/_probe-cap-rules.mjs [--account=1]
import { createApp } from '../src/server/app.js';
import {
  buildConclusion, eidolonsOf, lightConeRanksOf, marginalCostOf, ownedCharacters,
  VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { AccountStore } from '../src/server/store.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

// ---- ① 载荷余量 -------------------------------------------------------------
{
  const fakeStore = {
    load: async () => {}, listAccounts: async () => [], getAccount: async () => null,
    getSnapshot: async () => null, getBattleRecords: async () => null, setBattleRecords: async () => {},
  };
  const { server } = createApp({ store: fakeStore });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/archive/conclusion`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: [], window: 6 }),
    signal: AbortSignal.timeout(300000),
  });
  const text = await res.text();
  const bytes = Buffer.byteLength(text);
  console.log(`【载荷余量】/conclusion 实测 ${(bytes / 1024).toFixed(0)} KB`
    + `（硬上限 600 KB，余量 ${((600 * 1024 - bytes) / 1024).toFixed(0)} KB）`);
  server.close();
}

const ACC = Math.max(1, Number(arg('account', '1')) || 1);
const index = await archiveIndex();
const i18n = await loadI18n();
const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const account = accounts[ACC - 1];
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
const nameOf = (ms) => ms.map((m) => cn(m.char)).join('/');

const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const concl = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});

const rosterKeyOf = (members) => members
  .map((m) => `${m.char}|E${Math.max(0, Math.min(6, Math.round(Number(m.eidolon) || 0)))}|`
    + `${m.lc || '-'}|S${Math.max(1, Math.round(Number(m.superimp) || 1))}`)
  .sort().join('~');

const teamsOf = (units) => {
  const by = new Map();
  for (const u of units) {
    const best = (u.envs || []).find((e) => (e.members || []).length);
    if (!best?.members?.length) continue;
    const key = rosterKeyOf(best.members);
    const total = Number(u.total) || 0;
    if (!by.has(key) || total > by.get(key).total) by.set(key, { key, members: best.members, total });
  }
  return [...by.values()];
};

const B = teamsOf(Object.values(concl.frontierTiers || {}).flat());
const rows = [];
for (const t of B) {
  const gap = Math.max(0, Number(marginalCostOf(t.members, availability, acct).pulls) || 0);
  if (gap <= 0) continue;
  rows.push({ ...t, gap });
}
const lo = Math.min(...rows.map((r) => r.total));
const hi = Math.max(...rows.map((r) => r.total));
const gaps = rows.map((r) => r.gap).sort((a, b) => a - b);
const quantile = (p) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
for (const r of rows) r.strengthPct = hi - lo < 1e-9 ? 100 : 100 * (r.total - lo) / (hi - lo);

/** 几种 ② 封顶规则。 */
const RULES = [
  ['池内 p50（现状规则）', quantile(0.5)],
  ['池内 p75', quantile(0.75)],
  ['池内 p90', quantile(0.9)],
  ['池内 max', gaps[gaps.length - 1]],
  ['绝对 8 金', 8],
  ['绝对 12 金', 12],
  ['反推：让第 15 名附近拿 50 分', null], // 下面单独算
];

console.log(`\n账号 ${ACC} ${role.nickname}｜B 池（每角色 × 每星魂档）`
  + `｜候选 ${rows.length} 支（已剔除补金 0）`);
console.log(`池内差额分位：min ${gaps[0]} / p25 ${quantile(0.25)} / p50 ${quantile(0.5)}`
  + ` / p75 ${quantile(0.75)} / p90 ${quantile(0.9)} / max ${gaps[gaps.length - 1]} 金`);

/** 反推规则：先按 p50 排一遍，取第 15 名的 gap，令它的 ② 为 50 分 ⇒ 封顶 = 2×gap。 */
const scoreWith = (cap) => rows.map((r) => {
  const gapPct = Math.max(0, Math.min(100, 100 * (1 - r.gap / cap)));
  // 等权 0.5/0.5 = 默认抽卡权重（1:1）；这里刻意不读 `plan.drawWeights`。
  return { ...r, gapPct, total_score: 0.5 * r.strengthPct + 0.5 * gapPct };
}).sort((a, b) => b.total_score - a.total_score);
const p50Sorted = scoreWith(quantile(0.5));
const midGap = p50Sorted[14]?.gap ?? 1;
RULES[RULES.length - 1][1] = Math.max(1, midGap * 2);

for (const [label, cap] of RULES) {
  const ranked = scoreWith(cap);
  const zero = ranked.filter((r) => r.gapPct === 0).length;
  console.log(`\n${'─'.repeat(92)}\n${label}：封顶 ${cap} 金`
    + `｜② 归 0 的 ${zero}/${ranked.length}（${(zero / ranked.length * 100).toFixed(0)}%）`
    + `\n${'─'.repeat(92)}`);
  ranked.slice(0, 10).forEach((r, i) => {
    console.log(`  #${String(i + 1).padStart(2)} ${r.total_score.toFixed(1)}`
      + ` = ①${r.strengthPct.toFixed(1).padStart(5)} + ②${r.gapPct.toFixed(1).padStart(5)}`
      + `｜补 ${String(r.gap).padStart(2)} 金｜${nameOf(r.members)}`);
  });
}
