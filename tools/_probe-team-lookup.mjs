// 探针：**查一支指定的队伍** —— 全池名次、两个分项、补金顺序，以及它在总榜上的整包。
//
// 为什么需要它：抽卡方案只显示前 15 名，用户问「某支队伍强度得分多少 / 为什么不推荐补某一笔」
// 时，`_probe-team-plan.mjs --rows=15` 看不到它。这里把**整个候选池**打出来，
// 并列出总榜里含这些角色的**全部整包**（原始 ① 值 = 整包分）。
//
//   node tools/_probe-team-lookup.mjs --chars=白厄,昔涟,刻律德菈 [--account=1] [--hidden]
import { AccountStore } from '../src/server/store.js';
import {
  DEFAULT_HIDDEN_COSTS, SCORING, buildConclusion, eidolonsOf, lightConeRanksOf,
  normalizeDrawWeights, ownedCharacters, teamPlan, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ACC = Math.max(1, Number(arg('account', '1')) || 1);
const HIDDEN = process.argv.includes('--hidden') ? DEFAULT_HIDDEN_COSTS : null;
const WANT = arg('chars', '白厄,昔涟,刻律德菈').split(/[,，]/).map((s) => s.trim()).filter(Boolean);

const index = await archiveIndex();
const i18n = await loadI18n();
const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const account = accounts[ACC - 1];
const role = (account?.roles || [])[0];
if (!role) { console.log(`账号 ${ACC} 没有角色`); process.exit(1); }
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
const cn = (n) => zhName(i18n, 'characters', n) || n;
const cnCone = (n) => (n ? (zhName(i18n, 'lightCones', n) || n) : '—');
const nameOf = (r) => r.members.map((m) => cn(m.char)).join('/');
// 用户可能用中文名或英文键来点角色，两种都认。
const keyOf = (s) => (i18n.characters[s] ? s : (zh[s] || s));
const WANT_KEYS = WANT.map(keyOf);
console.log(`账号 ${ACC}：${role.nickname}｜隐金=${HIDDEN ? '全勾' : '不减'}｜默认抽卡权重`);
console.log(`查的角色：${WANT.map((w, i) => `${w}(${WANT_KEYS[i]})`).join(' / ')}`);

const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const concl = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  ...(HIDDEN ? { hiddenCosts: HIDDEN } : {}),
});

// ---- A. 总榜里含这些角色的**全部整包**（原始 ① 值就是整包分）----------------------
const allUnits = [...(concl.frontierUnits || []),
  ...Object.values(concl.frontierTiers || {}).flat()];
const hasAll = (u, keys) => keys.every((k) => (u.envs?.[0]?.members || [])
  .some((m) => m.char === k));
const packs = allUnits.filter((u) => hasAll(u, WANT_KEYS));
console.log(`\n【A】总榜（含逐档榜）里同时含这几个角色的整包：${packs.length} 条`);
const dedup = new Map();
for (const u of packs) {
  const k = `${u.name}|E${u.eidolon}|${u.lc || '-'}|S${u.superimp}`;
  if (!dedup.has(k)) dedup.set(k, u);
}
for (const u of dedup.values()) {
  const team = (u.envs?.[0]?.members || []).map((m) => `${cn(m.char)}E${m.eidolon}`
    + `${m.lc ? `+${cnCone(m.lc)}S${m.superimp}` : ''}`).join(' / ');
  console.log(`  ${cn(u.name)} E${u.eidolon}${u.lc ? ` + ${cnCone(u.lc)}S${u.superimp}` : ''}`
    + `｜**整包分 ${Number(u.total).toFixed(1)}**｜账面 ${u.gold} 金`
    + `｜最佳证据 ${u.bestTeamGold ?? '—'} 金 · ${u.bestActionValue ?? '—'} 行动值`
    + `${u.bestTier ? `（${u.bestTier}）` : ''}`);
  console.log(`      那一版的队伍：${team}`);
}

// ---- B. 候选池（队伍口径）里的名次与两个分项 ------------------------------------
const keep = SCORING.teamPlanMaxRows;
SCORING.teamPlanMaxRows = 100000;
let planAll;
try {
  planAll = teamPlan(concl, acct, { availability, drawWeights: normalizeDrawWeights({}) });
} finally {
  SCORING.teamPlanMaxRows = keep;
}
console.log(`\n候选池 ${planAll.pool} 支（逐档榜 ∪ 总榜去重后 ${planAll.poolAll} 支）`
  + `｜① 刻度（整包分）${planAll.strengthLo.toFixed(1)} ~ ${planAll.strengthHi.toFixed(1)}`
  + `｜② 封顶 ${planAll.gapMax} 金`);
const rows = planAll.rows.filter((r) => WANT_KEYS.every((k) => r.members.some((m) => m.char === k)));
console.log(`\n【B】候选池里**同时含**这几个角色的队伍：${rows.length} 支`
  + `（下发上限 ${SCORING.teamPlanMaxRows} 条 ⇒ 名次 > ${SCORING.teamPlanMaxRows} 的都看不到）`);
for (const r of rows) {
  const idx = planAll.rows.indexOf(r) + 1;
  console.log(`\n  全池第 ${idx} 名｜补金推荐分 ${r.total.toFixed(1)}`
    + ` = ①强度得分 ${r.strengthPct.toFixed(1)}（整包分 ${r.teamScore.toFixed(1)}）`
    + ` × ${planAll.drawWeights.strength} + ②差额接近度 ${r.gapPct.toFixed(1)} × ${planAll.drawWeights.cost}`);
  console.log(`      账面 ${r.gold} 金｜补金 ${r.gap} 金`
    + `｜最佳证据 ${r.bestEnv?.label || '—'} ${r.bestEnv?.bestTeamGold ?? '—'} 金 · `
    + `${r.bestEnv?.actionValue ?? '—'} 行动值`);
  console.log(`      成员：${r.members.map((m) => `${cn(m.char)}[${m.owned ? '有' : '缺'}]E${m.eidolon}`
    + `${m.lc ? `+${cnCone(m.lc)}S${m.superimp}` : ''}`).join(' / ')}`);
  console.log(`      补金顺序：${r.fill.length
    ? r.fill.map((it) => `${cn(it.carrier || it.name)}·${it.kind === 'cone'
      ? (Number(it.from) >= 1 ? `S${it.from}→S${it.target}` : `未见→S${it.target}`)
      : (Number(it.from) < 0 || Number(it.target) === 0 ? '本体' : `E${it.from}→E${it.target}`)}`
      + `（${it.pulls}金/${it.pullsExpected}抽）`).join(' → ')
    : '（无）'}`);
}
