// 探针：统计「角色本体与它自己的光锥同时缺」的队伍数 —— 决定补金顺序是否必须先加
// 「角色在光锥之前」的依赖约束。
//   node tools/_probe-fill-dep.mjs --account=1
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, eidolonsOf, lightConeRanksOf, marginalCostOf, ownedCharacters, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const ACC = Number((process.argv.find((a) => a.startsWith('--account=')) || '').slice(10)) || 1;
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
let withCharMissing = 0; let bothMissing = 0;
const samples = [];
for (const t of byRoster.values()) {
  const mc = marginalCostOf(t.members, availability, acct);
  if (!mc.pulls) continue;
  const missingChars = new Set(mc.items
    .filter((i) => i.kind === 'char' || i.kind === 'eidolon')
    .filter((i) => i.from < 0).map((i) => i.name));
  if (!missingChars.size) continue;
  withCharMissing += 1;
  const coneForMissing = mc.items.filter((i) => i.kind === 'cone' && missingChars.has(i.carrier));
  if (coneForMissing.length) {
    bothMissing += 1;
    if (samples.length < 5) {
      samples.push(`${t.members.map((m) => cn(m.char)).join('/')}：缺角色本体 ${[...missingChars].map(cn).join('、')}`
        + `，同时缺它的光锥 ${coneForMissing.map((c) => cn(c.name)).join('、')}`);
    }
  }
}
console.log(`账号 ${ACC}（${role.nickname}）`);
console.log(`候选队伍里有「缺角色本体」的：${withCharMissing} 支`);
console.log(`其中「角色本体与它自己的光锥同时缺」（必须先买角色）：${bothMissing} 支`);
samples.forEach((s) => console.log(`  · ${s}`));
