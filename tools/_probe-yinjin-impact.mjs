// 手工探针（_ 前缀）：「隐金设置」的效果核对 —— 打开 / 关掉五组隐金，总榜到底动了多少。
//
// 为什么需要它：这个功能的全部价值就是「勾选以后榜变了」，而榜变了多少只有真数据能回答。
// 顺便量三件事：① 有多少条前沿行的队伍金数被减；② 有没有队伍被减到 0（那种走 1 金兜底）；
// ③ 头部换成了谁。跑一次约 5 秒。
//
//   node tools/_probe-yinjin-impact.mjs                 # 默认（全开）对比全关
//   node tools/_probe-yinjin-impact.mjs --rows 15
//   node tools/_probe-yinjin-impact.mjs --only exchange # 只开某一组（其余四组关）
//
// 口径与生产完全一致：环境选取走 `conclusionEnvs`，前沿走 `archiveFrontierAll`，
// 算分走 `buildConclusion`（与界面、服务端同一份代码）。
import {
  HIDDEN_COST_SETTINGS, NO_HIDDEN_COSTS, DEFAULT_HIDDEN_COSTS, buildConclusion, charCostOf,
  coneCostOf, eidolonGoldOf, hiddenReductionOf, packGoldOf, VERSION_WINDOW,
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
const ROWS = Math.max(1, Number(arg('rows', '12')) || 12);
const ONLY = arg('only', '');

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const frontier = Object.fromEntries(frontierAll.map((f) => [f.env, f]));

const settings = ONLY
  ? { ...NO_HIDDEN_COSTS, [ONLY]: true }
  : { ...DEFAULT_HIDDEN_COSTS };

const run = (hiddenCosts) => buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: { owned: new Set() },
  frontier,
  hiddenCosts,
});

// ---- ① 名单核对：用户点名的键在数据集里都存在吗（写错一个键 = 一条永不生效的规则）----
console.log('=== 五组名单 → 数据集键 / 现成本口径 ===');
for (const group of HIDDEN_COST_SETTINGS) {
  console.log(`\n[${group.group}]`);
  for (const row of group.rows) {
    console.log(`  ☑ ${row.label}（${row.units.length} 项 · ${row.effect}）`);
    for (const unit of row.units) {
      const zh = row.kind === 'char'
        ? zhName(i18n, 'characters', unit) : zhName(i18n, 'lightCones', unit);
      const info = row.kind === 'char'
        ? availability.characters?.[unit] : availability.lightCones?.[unit];
      const cost = row.kind === 'char' ? charCostOf(unit, availability) : coneCostOf(unit, availability);
      const flag = zh && info ? '' : '  ⚠️ 数据集里查不到';
      console.log(`      ${String(zh || unit).padEnd(12)} ${unit.padEnd(32)} cost=${cost}${flag}`);
    }
  }
}

// ---- ② 前沿池：有多少行的队伍金数被减、有没有被减到 0 ----
let rows = 0;
let touched = 0;
let floored = 0;
let cutSum = 0;
for (const f of frontierAll) {
  for (const row of f.frontierRows || []) {
    rows += 1;
    const members = (row.members || []).map((m) => ({ ...m, eidolon: m.eidolon ?? 0 }));
    const cut = hiddenReductionOf(members, availability, settings, 'dataset').team;
    const stored = Math.max(0, Math.round(Number(row.cost) || 0));
    if (cut > 0) { touched += 1; cutSum += Math.min(cut, stored); }
    if (stored > 0 && cut >= stored) floored += 1;
  }
}
console.log(`\n=== 前沿池（${rows} 条行）在「${ONLY || '全开'}」下 ===`);
console.log(`  金数被减的行：${touched}（${(touched / rows * 100).toFixed(1)}%）`
  + ` · 共减 ${cutSum} 金 · 被减到 0 走「1 金兜底」的：${floored}`);

// ---- ③ 榜面对比 ----
const off = run({ ...NO_HIDDEN_COSTS });
const on = run(settings);
const keyOf = (u) => `${u.name}|E${u.eidolon}|${u.lc || '-'}|S${u.superimp}`;
const offRank = new Map(off.frontierUnits.map((u, i) => [keyOf(u), { rank: i + 1, unit: u }]));
const onRank = new Map(on.frontierUnits.map((u, i) => [keyOf(u), { rank: i + 1, unit: u }]));

console.log(`\n=== 总榜条数：全关 ${off.frontierUnits.length} 条 → ${ONLY || '全开'} ${on.frontierUnits.length} 条 ===`);
console.log(`\n=== 「${ONLY || '全开'}」后的前 ${ROWS} 名（括号里是名次变化）===`);
for (const [i, u] of on.frontierUnits.slice(0, ROWS).entries()) {
  const before = offRank.get(keyOf(u));
  const delta = before ? `#${before.rank}→${i + 1}` : '新进榜';
  const zh = zhName(i18n, 'characters', u.name) || u.name;
  console.log(`  #${String(i + 1).padStart(3)} ${String(Math.round(u.total)).padStart(5)}  `
    + `${zh} E${u.eidolon}${u.lc ? ` + ${zhName(i18n, 'lightCones', u.lc) || u.lc}S${u.superimp}` : ''}`
    + `  整包 ${u.gold} 金（原始 ${u.rawGold ?? '—'}）  最佳证据队伍 ${u.bestTeamGold} 金  [${delta}]`);
}

// ---- ④ 点名单位的分数变化（用户最关心的那几个）----
const WATCH = ['Luocha', 'Ruan Mei', 'Huohuo', 'Robin', 'Seele', 'Yunli', 'Silver Wolf', 'Fu Xuan', 'Blade',
  'Dr. Ratio', 'Archer', 'Dan Heng • Permansor Terrae', 'Gilgamesh', 'Sparkle', 'Acheron', 'Aventurine',
  'Jing Yuan', 'Kafka', 'Jingliu'];
console.log(`\n=== 点名单位：全关 → ${ONLY || '全开'}（总分 / 整包金数 / 名次）===`);
for (const name of WATCH) {
  const pick = (res) => res.frontierUnits.find((u) => u.name === name) || null;
  const a = pick(off);
  const b = pick(on);
  if (!a && !b) { console.log(`  ${name.padEnd(30)} 两个口径都不在榜上`); continue; }
  const cmp = (x) => (x ? `${Math.round(x.total)} 分 / ${x.gold} 金 / #${off.frontierUnits.indexOf(x) + 1 || on.frontierUnits.indexOf(x) + 1}` : '不在榜');
  const zh = zhName(i18n, 'characters', name) || name;
  const rankOff = a ? off.frontierUnits.indexOf(a) + 1 : '—';
  const rankOn = b ? on.frontierUnits.indexOf(b) + 1 : '—';
  console.log(`  ${zh.padEnd(14)} ${name.padEnd(30)}`
    + ` #${String(rankOff).padStart(4)} ${a ? Math.round(a.total) : '—'} 分 ${a ? a.gold : '—'} 金`
    + `  →  #${String(rankOn).padStart(4)} ${b ? Math.round(b.total) : '—'} 分 ${b ? b.gold : '—'} 金`);
  void cmp;
}
