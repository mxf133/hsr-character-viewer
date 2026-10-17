// 探针：性价比来源表标题行印的「最便宜 X 金 ÷ 本整包 Y 金」，与印出的系数能不能对账？
//   node tools/_probe-own-gold-print.mjs
//
// 系数算的是 **rawGold（隐金前）**，界面印的除数却是 **unit.gold（隐金后）** ——
// 一开隐金，这两处就不同源，读者按印出来的除法开平方得不到印出来的系数。
import { buildConclusion, SCORING, VERSION_WINDOW, HIDDEN_COST_IDS } from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
const index = await archiveIndex();
const i18n = await loadI18n();
const cn = (n) => zhName(i18n, 'characters', n) || n;
const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const fa = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const on = Object.fromEntries(HIDDEN_COST_IDS.map((id) => [id, true]));
const c = buildConclusion(envs, { availability: index.refs?.availability || {},
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  frontier: Object.fromEntries(fa.map((f) => [f.env, f])),
  hiddenCosts: on });
const all = []; const seen = new Set();
for (const u of [...(c.frontierUnits || []), ...Object.values(c.frontierTiers || {}).flat()]) {
  const k = `${u.name}|${u.eidolon}|${u.lc}|${u.superimp}`;
  if (seen.has(k)) continue; seen.add(k); all.push(u);
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
let cut = 0; let mismatch = 0; const ex = [];
for (const u of all) {
  if (num(u.hiddenCut) > 0) cut += 1;
  const f = num(u.ownGoldFactor) || 1;
  if (Math.abs(f - 1) < 1e-4) continue;
  // 界面印的除法：`ownGoldRef ÷ ownGold`（**隐金前**），再按 `ownGoldFactorPower` 还原。
  // ⚠️ 2026-10-17 之前这里写的是 `÷ unit.gold`（隐金后）—— 那正是被修掉的那个 bug，
  //    这一行是回归：改回 `gold` 会立刻报出几十条不一致。
  const div = num(u.ownGold);
  const shown = Math.pow(num(u.ownGoldRef) / Math.max(1, div), SCORING.ownGoldFactorPower);
  if (Math.abs(shown - f) > 1e-3) {
    mismatch += 1;
    if (ex.length < 8) ex.push({ u, f, shown });
  }
}
console.log(`整包 ${all.length}｜开满隐金后被减过的 ${cut} 条｜系数指数 q=${SCORING.ownGoldFactorPower}`);
console.log(`系数 ≠ 1 且「界面印的除法」还原不出系数的：${mismatch} 条`);
for (const { u, f, shown } of ex) {
  console.log(`  ${cn(u.name).padEnd(12)} E${u.eidolon}S${u.superimp}`
    + ` rawGold=${num(u.rawGold)} gold=${num(u.gold)} ownGold=${num(u.ownGold)} 分子=${num(u.ownGoldRef)}`
    + ` → 印「${num(u.ownGoldRef)} ÷ ${num(u.ownGold)}」= ${shown.toFixed(3)}，实际系数 ${f.toFixed(3)}`);
}
