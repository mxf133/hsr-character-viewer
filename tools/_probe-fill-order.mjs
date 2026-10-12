// 探针：补金顺序到底该按哪个尺子排 ——「性价比得分」(现在的做法) vs「每抽收益」(把光锥 67 抽/金
// 比角色 94 抽/金更便宜算进去)。两者只在不同 kind 之间比较时才会不一致。
//
//   node tools/_probe-fill-order.mjs --account=1
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, charCostOf, eidolonsOf, lightConeRanksOf, marginalCostOf, ownedCharacters,
  unitPullsOf, VERSION_WINDOW,
} from '../src/core/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (name, dflt) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return dflt;
};
const ROWS = Math.max(1, Number(arg('rows', '12')) || 12);
const ACC = Math.max(1, Number(arg('account', '1')) || 1);

const index = await archiveIndex();
const i18n = await loadI18n();
const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const account = accounts[ACC - 1];
const role = (account?.roles || [])[0];
const snapshot = await store.getSnapshot(account.id, role.uid);
const zhToEn = {}; const allNames = [];
for (const c of index.refs?.characters || []) {
  if (c.nameCn && c.name) zhToEn[c.nameCn] = c.name;
  if (c.nameCn) allNames.push(c.nameCn);
}
const coneZhToEn = {};
for (const c of index.refs?.lightCones || []) if (c.nameCn && c.name) coneZhToEn[c.nameCn] = c.name;
const acct = {
  owned: ownedCharacters(snapshot, zhToEn, allNames),
  eidolons: eidolonsOf(snapshot, zhToEn),
  cones: lightConeRanksOf(snapshot, coneZhToEn),
};
const availability = index.refs?.availability || {};
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const result = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});
const cn = (n) => zhName(i18n, 'characters', n) || zhName(i18n, 'lightCones', n) || n;
const cnCone = (n) => zhName(i18n, 'lightCones', n) || n;
const rosterKeyOf = (members) => members
  .map((m) => `${m.char}|E${m.eidolon}|${m.lc || '-'}|S${m.superimp}`).sort().join('~');

const byRoster = new Map();
for (const unit of result.frontierUnits) {
  const members = unit.envs?.[0]?.members || [];
  if (!members.length) continue;
  const key = rosterKeyOf(members);
  const cur = byRoster.get(key);
  if (!cur || unit.total > cur.total) byRoster.set(key, { members, total: unit.total });
}
const charScore = (name) => Math.max(0, ...result.frontierUnits
  .filter((u) => u.name === name).map((u) => u.total));

// 口径①：按「成员性价比得分」排（现在的做法）
// 口径②：按「分值 ÷ 期望抽数」排（把 67 抽/金 < 94 抽/金 算进去）
// 口径③：② 但**光锥必须先有载体**（角色本体排在它自己的光锥之前）
const teams = [...byRoster.values()].map((t) => {
  const mc = marginalCostOf(t.members, availability, acct);
  if (!mc.pulls) return null;
  const items = mc.items.map((it) => {
    const owner = it.carrier || it.name;
    const score = charScore(owner) || charScore(it.name);
    const pullsExpected = unitPullsOf(it.kind, it.pulls);
    return { ...it, owner, score, pullsExpected,
      effByScore: score,
      effByPull: score / Math.max(1, pullsExpected) };
  });
  return { ...t, gap: mc.pulls, items };
}).filter(Boolean);
console.log(`候选 ${teams.length} 支队伍 / 账号 ${ACC}：${role.nickname}`);

const orderA = (t) => [...t.items].sort((a, b) => b.effByScore - a.effByScore || b.pulls - a.pulls);
const orderB = (t) => [...t.items].sort((a, b) => b.effByPull - a.effByPull || b.pulls - a.pulls);
/** ③：先按每抽收益排，再把「角色本体/星魂」提到它自己的光锥之前（不能先买光锥没角色装）。 */
const orderC = (t) => {
  const list = orderB(t);
  const out = [];
  const rest = [...list];
  while (rest.length) {
    // 反复取「没有前置依赖」的那一项里每抽收益最高的
    const carriers = new Set(rest.map((it) => it.carrier).filter(Boolean));
    const pick = rest.find((it) => !(it.kind === 'cone' && !acct.owned.has(it.carrier)
      && rest.some((x) => x.name === it.carrier && (x.kind === 'char' || x.kind === 'eidolon'))));
    out.push(pick || rest.find((it) => !carriers.has(it.owner)) || rest[0]);
    rest.splice(rest.indexOf(out[out.length - 1]), 1);
  }
  return out;
};

const fmt = (t, o) => o(t).map((it) => {
  const kind = it.kind === 'cone' ? '锥' : (it.from < 0 || it.target === 0 ? '本体' : '星魂');
  return `${cn(it.carrier || it.name).slice(0, 6)}·${kind}[${Math.round(it.score)}/${it.pullsExpected}抽=${it.effByPull.toFixed(2)}]`;
}).join(' → ');

let diffAB = 0; let diffBC = 0;
for (const t of teams) {
  const a = orderA(t).map((i) => i.name + i.kind).join('|');
  const b = orderB(t).map((i) => i.name + i.kind).join('|');
  const c = orderC(t).map((i) => i.name + i.kind).join('|');
  if (a !== b) diffAB += 1;
  if (b !== c) diffBC += 1;
}
console.log(`\n口径①（按性价比）与口径②（按每抽收益）顺序不同的队伍：${diffAB} / ${teams.length}`);
console.log(`口径②（纯每抽收益）与口径③（光锥跟在载体之后）顺序不同的队伍：${diffBC} / ${teams.length}`);

console.log(`\n${'='.repeat(110)}\n前 ${ROWS} 名队伍在三种尺子下的补金顺序（锥 = 光锥，[] 内是 性价比/期望抽数=每抽收益）\n${'='.repeat(110)}`);
const sorted = [...teams].sort((a, b) => b.total - a.total);
for (const [i, t] of sorted.slice(0, ROWS).entries()) {
  console.log(`\n#${i + 1} ${t.members.map((m) => cn(m.char)).join('/')}　共 ${t.gap} 金`);
  console.log(`  ①按性价比：${fmt(t, orderA)}`);
  console.log(`  ②按每抽收益：${fmt(t, orderB)}`);
  if (diffBC) console.log(`  ③加依赖约束：${fmt(t, orderC)}`);
}
