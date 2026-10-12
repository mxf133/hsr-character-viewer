// 量体积：三个候选池如果都要下发到界面，结论载荷会变多大。
//
// ⚠️ 约束：`tools/e2e-test.mjs` 有一条硬断言「结论载荷 < 600 KB」。
// `frontierPacksByChar` 现在**不在载荷里**（服务端只给 `/api/archive/packs` 按角色取用），
// 所以「全量池」要么改成服务端算队伍方案，要么必须先瘦身。
//
//   node tools/_probe-pool-size.mjs
import {
  buildConclusion, eidolonsOf, lightConeRanksOf, ownedCharacters, VERSION_WINDOW,
} from '../src/core/advice.js';
import { AccountStore } from '../src/server/store.js';
import { archiveFrontierAll, archiveIndex } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const index = await archiveIndex();
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
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const concl = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});

const kb = (v) => `${(Buffer.byteLength(JSON.stringify(v)) / 1024).toFixed(0)} KB`;
const tiers = concl.frontierTiers || {};
const packs = concl.frontierPacksByChar || {};
const packsFlat = Object.values(packs).flat();
const tierFlat = Object.values(tiers).flat();

console.log(`账号 ${role.nickname}\n`);
console.log(`frontierUnits        ${String(concl.frontierUnits.length).padStart(5)} 条  ${kb(concl.frontierUnits)}`);
console.log(`frontierTiers        ${String(tierFlat.length).padStart(5)} 条  ${kb(tiers)}`);
console.log(`frontierPacksByChar  ${String(packsFlat.length).padStart(5)} 条  ${kb(packs)}`);
console.log(`  按角色分组 ${Object.keys(packs).length} 组`);

/** 队伍方案只要「成员 + 队分」，其余字段（图标 / nameCn / envs 明细）都用不上。 */
const slim = (units) => [...new Map(units.map((u) => {
  const best = (u.envs || []).find((e) => (e.members || []).length);
  return [u.key ?? u.name, best?.members || []];
})).entries()].filter(([, m]) => m.length).map(([key, members]) => ({ key, members }));
console.log(`\n如果只下发队伍方案真正需要的两样（roster 键 + 成员名单）：`);
console.log(`  现在这批（84 条 → 79 支）      ${kb(slim(concl.frontierUnits))}`);
console.log(`  每档那批（266 条 → 249 支）    ${kb(slim(tierFlat))}`);
console.log(`  全量那批（2453 条 → 2179 支）  ${kb(slim(packsFlat))}`);
console.log(`\n（对照：e2e 的硬断言是「结论载荷 < 600 KB」；现有载荷里` +
  `总榜 84 条 + 逐档 266 条的**瘦身版**已经是这个量级的一部分。）`);
