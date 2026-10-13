// 手工探针（`_` 前缀）：最新版本（4.6）最便宜满分配置的**补金明细**（账号 1）。
//
//   node tools/_probe-costpressure-cheapfill.mjs
import { AccountStore } from '../src/server/store.js';
import {
  eidolonTierOf, marginalCostOf, ownedCharacters, eidolonsOf, lightConeRanksOf, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const cn = (n) => zhName(i18n, 'characters', n) || zhName(i18n, 'lightCones', n) || n;
const zhToEn = {};
for (const c of index.refs?.characters || []) if (c.nameCn && c.name) zhToEn[c.nameCn] = c.name;
const coneZhToEn = {};
for (const c of index.refs?.lightCones || []) if (c.nameCn && c.name) coneZhToEn[c.nameCn] = c.name;
const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const account = accounts[0];
const snapshot = await store.getSnapshot(account.id, (account.roles || [])[0].uid);
const allNames = (index.refs?.characters || []).map((c) => c.nameCn).filter(Boolean);
const acct = {
  owned: ownedCharacters(snapshot, zhToEn, allNames),
  eidolons: eidolonsOf(snapshot, zhToEn),
  cones: lightConeRanksOf(snapshot, coneZhToEn),
};
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const plight = frontierAll.find((f) => f.env === 'aa/plight');
const newest = [...(plight.seasons || [])].sort((a, b) => {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d;
  }
  return 0;
}).pop();
const rows = (plight.frontierRows || [])
  .filter((r) => r.season === newest && r.tier === 'perfect' && r.actionValue < 300)
  .sort((a, b) => a.cost - b.cost || a.actionValue - b.actionValue);
console.log(`最新版本 ${newest}：满分（行动值 <300）${rows.length} 条；最便宜 ${rows[0].cost} 金`);
for (const r of rows.slice(0, 4)) {
  console.log(`\n  ${r.cost} 金 / ${r.actionValue} AV：`
    + r.members.map((m) => `${cn(m.char)}E${eidolonTierOf(m.eidolon)}`
      + `${m.lc ? `+${cn(m.lc)}S${m.superimp}` : ''}`).join(' / '));
  const cost = marginalCostOf(r.members, availability, acct);
  console.log(`    账号 1 补金 ${cost.pulls} 金，逐笔：`);
  for (const it of cost.items || []) {
    console.log(`      ${it.kind === 'cone' ? '光锥' : '角色'} ${cn(it.name)}`
      + `${it.carrier ? `（载体 ${cn(it.carrier)}）` : ''}`
      + ` ${it.from ?? '—'} → ${it.target ?? '—'}｜${it.pulls} 金（约 ${it.pulls * (it.kind === 'cone' ? 67 : 94)} 抽）`);
  }
}
