// 临时探针（排查「为什么推荐了大量旧版本角色」，用户 2026-10-15）：
//   node tools/_probe-char-board-versions.mjs [--account=1] [--rows=15]
//
// 回答三件事：
//   Q1 角色总榜（characterScore 排序）前 N 名是谁，三个分项各贡献多少；
//   Q2 每条整包在「6 版窗口」与「1 版窗口（只吃最新版本）」下的逐副本分对比
//      —— 差值大 = 这条整包的榜分主要靠旧版本证据抬起来；
//   Q3 性价比归一区间（costExtent）随窗口的变化。
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, eidolonTierOf, eidolonsOf, lightConeRanksOf, normalizeDrawWeights,
  ownedCharacters,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (name, dflt) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return dflt;
};
const ROWS = Math.max(1, Number(arg('rows', '15')) || 15);
const ACC = Math.max(1, Number(arg('account', '1')) || 1);
const draw = normalizeDrawWeights({});

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
const cn = (n) => zhName(i18n, 'characters', n) || zhName(i18n, 'lightCones', n) || n;

const build = async (window) => {
  const { envs } = await conclusionEnvs(index, { window });
  const frontierAll = await archiveFrontierAll(envs, { window });
  return buildConclusion(envs, {
    availability,
    firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
    account: acct,
    frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  });
};

const c6 = await build(6);
const c1 = await build(1);

const board = (c) => [...(c.frontierUnits || [])]
  .sort((a, b) => (Number(b.characterScore) || 0) - (Number(a.characterScore) || 0));
const units6 = board(c6);
const units1 = board(c1);

console.log(`性价比归一区间：6 版窗口 lo=${c6.frontierExtents?.cost?.lo} hi=${c6.frontierExtents?.cost?.hi}`
  + ` ｜ 1 版窗口 lo=${c1.frontierExtents?.cost?.lo} hi=${c1.frontierExtents?.cost?.hi}`);
console.log(`池规模：6 版 = ${units6.length} 条｜1 版 = ${units1.length} 条\n`);

console.log(`角色总榜（6 版窗口）前 ${ROWS} 名 × 逐副本「6 版分 vs 1 版分」：`);
console.log('  名次  角色                档  角色得分  强度  性价比  泛用   逐副本: 副本(权重) 6版分→1版分 [证据版本/强度证据版本]');
for (const [i, u] of units6.slice(0, ROWS).entries()) {
  const key = u.key;
  const u1 = units1.find((x) => x.key === key);
  const envParts = (u.envs || []).map((e) => {
    const e1 = u1?.envs?.find((x) => x.id === e.id);
    const s6 = Number(e.score).toFixed(0);
    const s1 = e1 ? Number(e1.score).toFixed(0) : '—';
    const ev = e.evidenceSeason ?? '—';
    const st = e.strengthSeason ?? '—';
    return `${(e.envLabel || e.id).split('·').pop()?.trim().slice(0, 4) || '?'}(${e.weight}) ${s6}→${s1} [证${ev}/强${st}]`;
  }).join('  ');
  console.log(
    `  #${String(i + 1).padStart(2)} ${cn(u.name).padEnd(8)} E${eidolonTierOf(u.eidolon)}`
    + ` ${(Number(u.characterScore) || 0).toFixed(1).padStart(6)}`
    + ` ${(Number(u.strengthScore) || 0).toFixed(1).padStart(5)}`
    + ` ${(Number(u.costScore) || 0).toFixed(1).padStart(6)}`
    + ` ${(Number(u.versatilityScore) || 0).toFixed(1).padStart(5)}   ${envParts}`,
  );
}
console.log('\n注：「6版分→1版分」= 该副本的版本加权分（性价比原始分，未归一）。'
  + '1 版列是「—」表示这条整包在最新版本没有 0 分条目之外的存在（不在 1 版榜上）。'
  + '6 版分远高于 1 版分 = 分数主要靠旧版本证据。');
