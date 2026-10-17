// 探针：抽卡方案的两类「得分 / 显示」体检 —— 2026-10-18 用户报的两条都靠它复现。
//
//   node tools/_probe-plan-audit.mjs [--preset=flat-2-1] [--rows=20] [--find=Welt,Sparkle]
//
// ① **全队金数印两遍**：卡片第一行印「账面 N 金｜补金 M 金」，紧接着的「最佳证据」那句
//    又印一次证据金数 —— 而两者本来就是同一个数（目标档位 = 投稿档位）。这里逐行比
//    `displayGold`（印出来的账面）与 `bestEnv.bestTeamGold`，统计「会印出两个相同金数」
//    的卡片有多少张。修法见 `advice-view.js` 里「同一个金数只印一次」那一段。
//
// ② **老队伍的强度异常**：行动值前沿 ∪ 全队伍表这两池的强度原来不进版本加权
//    （v4.6.125 只给逐档榜那条链接了 `Σ(版本权重 × 该版本强度) ÷ Σ(版本权重)`），
//    于是只有 4.4 期成绩的队也能拿 92.7、只有 4.1 期 0 行动值的老队能拿满分挤进前排。
//    这里打「强度 vs 最佳证据版本」的分布，并逐关列出抽查那支队的证据行。
//    修法见 `advice.js` 里 `versionFactorOf()` 那一段。
//
// 账号用「虚拟账号预设」构造（`--preset=` 取 `VIRTUAL_PRESETS` 的 id），
// 所以不碰 DPAPI、也不联网。
import { archiveIndex, loadI18n } from '../src/server/archive.js';
import { archiveConclusion } from '../src/server/conclusion.js';
import {
  teamPlan, ownedCharacters, eidolonsOf, lightConeRanksOf, charCostOf, coneCostOf,
} from '../public/scripts/advice.js';
import { buildVirtualAccount, presetById } from '../src/server/virtual-accounts.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const PRESET = arg('preset', 'flat-2-1');
const ROWS = Math.max(0, Number(arg('rows', '20')) || 20);
const FIND = String(arg('find', '')).split(',').map((s) => s.trim()).filter(Boolean);

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const preset = presetById(PRESET);
if (!preset) {
  console.error(`没有这个预设：${PRESET}`);
  process.exit(1);
}
const account = buildVirtualAccount({
  preset, index, i18n, availability, charCostOf, coneCostOf,
  uid: '100000001', nickname: PRESET,
});
const snapshot = account.snapshots?.['100000001'] || Object.values(account.snapshots || {})[0];

const zhToEn = {};
const allNames = [];
for (const c of index.refs?.characters || []) {
  if (c.nameCn && c.name) zhToEn[c.nameCn] = c.name;
  if (c.nameCn) allNames.push(c.nameCn);
}
const coneZhToEn = {};
for (const c of index.refs?.lightCones || []) {
  if (c.nameCn && c.name) coneZhToEn[c.nameCn] = c.name;
}
const owned = ownedCharacters(snapshot, zhToEn, allNames);
const eidolons = eidolonsOf(snapshot, zhToEn);
const cones = lightConeRanksOf(snapshot, coneZhToEn);

const conclusion = await archiveConclusion(
  { owned: [...owned], eidolons: Object.fromEntries(eidolons), cones: Object.fromEntries(cones) },
  { includeAllTeams: true },
);
const plan = teamPlan(conclusion, { owned, eidolons, cones }, { availability });
const rows = plan.rows;
const zh = (k) => i18n.characters?.[k] || k;
const zhCone = (k) => i18n.lightCones?.[k] || k;
const memberText = (r) => r.members
  .map((m) => `${zh(m.char)}E${m.eidolon}${m.lc ? `+${zhCone(m.lc)}S${m.superimp}` : ''}`)
  .join(' / ');

console.log(`预设 ${PRESET} · 持有 ${owned.size} 角色 / ${cones.size} 光锥`);
console.log(`候选 ${plan.pool} 支（全池 ${plan.poolAll}）· 下发 ${rows.length} 支`
  + ` · 封顶 ${plan.gapMax} 金`);

// ---- ① 金数重复 -------------------------------------------------------------
let dup = 0;
const dupRows = [];
for (const r of rows) {
  const shown = Number(r.displayGold ?? r.gold);
  const ev = Number(r.bestEnv?.bestTeamGold);
  if (!Number.isFinite(ev)) continue;
  if (ev === shown) { dup += 1; dupRows.push(r); }
}
console.log('\n=== ① 「账面」与「最佳证据」金数相同（= 会印两遍）的卡片 ===');
console.log(`  ${dup} / ${rows.length} 支`);
for (const r of dupRows.slice(0, Math.min(6, ROWS))) {
  console.log(`  #${rows.indexOf(r) + 1} 账面 ${r.displayGold ?? r.gold} 金`
    + `（隐金减免 ${r.hiddenCut}）｜最佳证据 ${r.bestEnv?.label} ${r.bestEnv?.season}`
    + ` ${r.bestEnv?.bestTeamGold} 金 ｜${memberText(r)}`);
}

// ---- ② 强度 vs 证据版本 ------------------------------------------------------
const seasonNum = (s) => {
  const m = /(\d+)\.(\d+)/.exec(String(s || ''));
  return m ? Number(m[1]) * 10 + Number(m[2]) : null;
};
const current = Math.max(...rows.map((r) => seasonNum(r.bestEnv?.season) || 0));
console.log(`\n=== ② 强度 vs 最佳证据版本（当前 ${current / 10}）===`);
for (const [i, r] of rows.slice(0, ROWS).entries()) {
  const s = seasonNum(r.bestEnv?.season);
  const behind = s === null ? null : current - s;
  const flag = behind !== null && behind >= 2 && r.strengthPct >= 70 ? '  ← 老证据高分' : '';
  console.log(`  #${String(i + 1).padStart(2)} 分 ${r.total.toFixed(1).padStart(5)}`
    + ` ｜强度 ${r.strengthPct.toFixed(1).padStart(5)}`
    + ` ｜性价比 ${r.gapPct.toFixed(1).padStart(6)}`
    + ` ｜泛用 ${r.versatilityPct.toFixed(1).padStart(5)}`
    + ` ｜补 ${String(r.gap).padStart(2)} 金 ｜${r.avSource ? 'AV ' : r.allTeamsSource ? 'ALL' : 'Tier'}`
    + ` ｜证据 ${r.bestEnv?.season || '—'} ${r.bestEnv?.label || '—'}`
    + ` ｜${r.members.map((m) => zh(m.char)).join('/')}${flag}`);
}
const stale = rows.filter((r) => {
  const s = seasonNum(r.bestEnv?.season);
  return s !== null && current - s >= 2 && r.strengthPct >= 70;
});
console.log(`  → 证据落后 ≥2 版却 ≥70 分的行：${stale.length} / ${rows.length}`);

// ---- ③ 按名字找一支队，逐关列出它的证据行 -----------------------------------
if (FIND.length) {
  console.log(`\n=== ③ 含 [${FIND.join(', ')}] 的行 ===`);
  const hits = rows.filter((r) => FIND.every((n) => r.members.some((m) => m.char === n)));
  if (!hits.length) console.log('  （这一页里没有）');
  for (const r of hits.slice(0, 6)) {
    console.log(`\n  ${memberText(r)}`);
    console.log(`    分 ${r.total.toFixed(1)} ｜强度 ${r.strengthPct.toFixed(1)}`
      + ` ｜性价比 ${r.gapPct.toFixed(1)} ｜补 ${r.gap} 金`
      + ` ｜${r.avSource ? 'AV' : r.allTeamsSource ? 'ALL' : 'Tier'}`
      + ` ｜证据 ${r.bestEnv?.label} ${r.bestEnv?.season} av=${r.bestEnv?.actionValue}`);
    const tierFlat = Object.values(conclusion.frontierTiers || {}).flat();
    const unit = tierFlat.find((u) => u.name === r.members[0].char
      && u.eidolon === r.members[0].eidolon && (u.lc || null) === (r.members[0].lc || null));
    if (!unit) { console.log('    （代表整包不在逐档榜里）'); continue; }
    console.log(`    代表整包 strengthScore ${unit.strengthScore} · env ${unit.envCount}`);
    for (const e of unit.envs || []) {
      console.log(`      ${e.id} 关卡权重 ${e.weight} ｜强度 ${e.envStrength}`
        + ` ｜强度行 av=${e.strengthAv} 版本 ${e.strengthSeason}`
        + ` ｜卡片行 av=${e.actionValue} 版本 ${e.evidenceSeason} 金 ${e.bestTeamGold}`
        + `${e.inheritedEnv ? ' ｜继承' : ''}`);
    }
  }
}
