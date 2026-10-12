// 探针：确认「队伍性价比得分吃的是哪一套权重」——回答用户第 6 条。
//
// 做法：同一份数据、同一个账号，跑三次：
//   A. 两套都用默认
//   B. 只改**方案权重**（把异相仲裁两个关卡改成 0.1）
//   C. 只改**总榜权重**（同上）
// 看 `frontierUnits`（总榜 / 队伍分的来源）与 `units`（旧抽卡方案）各自跟谁走。
//
//   node tools/_probe-weight-source.mjs
import { AccountStore } from '../src/server/store.js';
import { buildConclusion, VERSION_WINDOW } from '../src/core/advice.js';
import { archiveFrontierAll, archiveIndex } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const index = await archiveIndex();
const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const account = accounts[0];
const role = (account?.roles || [])[0];
const snap = await store.getSnapshot(account.id, role.uid);

// 账号持有：这里只需要一个稳定的非空角色池（不关心具体谁），直接用快照现建。
const { ownedCharacters, eidolonsOf, lightConeRanksOf } = await import('../src/core/advice.js');
const zhToEn = {}; const allNames = [];
for (const c of index.refs?.characters || []) {
  if (c.nameCn && c.name) zhToEn[c.nameCn] = c.name;
  if (c.nameCn) allNames.push(c.nameCn);
}
const coneZhToEn = {};
for (const c of index.refs?.lightCones || []) if (c.nameCn && c.name) coneZhToEn[c.nameCn] = c.name;
const acct = {
  owned: ownedCharacters(snap, zhToEn, allNames),
  eidolons: eidolonsOf(snap, zhToEn),
  cones: lightConeRanksOf(snap, coneZhToEn),
};

const { envs } = await conclusionEnvs(index);
const PLAN_ONLY = { 'aa|': 0.1, 'aa|plight': 0.1 };
const FRONTIER_ONLY = { 'aa|': 0.1, 'aa|plight': 0.1 };

const run = async (label, planWeights, frontierWeights) => {
  const frontierAll = await archiveFrontierAll(envs, {
    window: VERSION_WINDOW, ...(frontierWeights ? { weights: frontierWeights } : {}),
  });
  const result = buildConclusion(envs, {
    availability: index.refs?.availability || {},
    firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
    account: acct,
    frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
    weights: planWeights,
    frontierWeights,
  });
  const top = (result.frontierUnits || [])[0];
  const topUnit = (result.units || [])[0];
  console.log(`${label.padEnd(22)} 总榜 #1 ${String(top?.name || '—').padEnd(18)}`
    + ` ${String(Math.round(top?.total ?? 0)).padStart(5)}`
    + `　｜旧方案 #1 ${String(topUnit?.name || '—').padEnd(16)}`
    + ` ${String(Math.round(topUnit?.total ?? 0)).padStart(4)}`);
  return { frontierTop: top?.total ?? 0, unitTop: topUnit?.total ?? 0 };
};

const a = await run('① 两套默认', null, null);
const b = await run('② 只改方案权重', PLAN_ONLY, null);
const c = await run('③ 只改总榜权重', null, FRONTIER_ONLY);

console.log('');
console.log(`只改方案权重 → 总榜 ${a.frontierTop.toFixed(1)} → ${b.frontierTop.toFixed(1)}`
  + `｜旧方案 ${a.unitTop.toFixed(1)} → ${b.unitTop.toFixed(1)}`);
console.log(`只改总榜权重 → 总榜 ${a.frontierTop.toFixed(1)} → ${c.frontierTop.toFixed(1)}`
  + `｜旧方案 ${a.unitTop.toFixed(1)} → ${c.unitTop.toFixed(1)}`);
const frontierFollowsFrontier = Math.abs(a.frontierTop - b.frontierTop) < 1e-6
  && Math.abs(a.frontierTop - c.frontierTop) > 1e-6;
console.log(`\n结论：队伍性价比得分（frontierUnits）${frontierFollowsFrontier
  ? '只跟**总榜权重**走，与方案权重无关' : '不符合预期，需要复查'}`);
