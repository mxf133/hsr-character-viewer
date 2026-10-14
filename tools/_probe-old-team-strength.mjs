// 探针：查「老队伍的强度得分过高」（用户 2026-10-15 报，同一天修完 —— 这支出是**改前改后
// 都能跑**的对账工具，留着当下一次回归）。
//
//   node tools/_probe-old-team-strength.mjs --account=1 [--rows=20]
//
// 它回答三件事：
//   Q1 ① 在候选池里是不是**扎堆**（多少支 ≥95 / ≥90，分位数）—— 扎堆说明刻度失去分辨力；
//   Q2 前排那些队的强度证据来自**哪个版本**（`envs[].strengthSeason`）—— 集中在旧版本
//      就是「靠两三个版本前的旧 0 行动值拿满分」；
//   Q3 四条口径并排（修完后 A 与 B **必须相等**，那是这条修复的自检）：
//        A 现状          = 该队**代表整包**（`total` 最高那一条）自己的 `strengthScore`
//        B 代表整包复算   = 探针自己按同一条规则复算的 `strengthScore`（A≠B 就是又漂了）
//        C 去掉最旧一版   = 版本窗口收到 2 版后重算的 A
//        D 只吃最新版本   = 版本窗口收到 1 版后重算的 A（`—` = 这条队伍不在那个池里）
//
// 实测（账号 1、强度权重拉满，2026-10-15）：
//   修前：池 219 支，① p50 **92.5**、≥95 **77 支**、17 支并列 98.18，前 20 名里 14 支是
//         「借了队内某个 E6 成员在**别的队伍**里打出的成绩」（例：云璃E1/千冶•刃E2/花火E2/
//         昔涟E6 显示 98.18，它自己承载的证据只有 **13.28**）；
//   修后：池 221 支，① p50 **46.0**、≥95 **9 支**、≥98 只 2 支，A 与 B 逐条相等。
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, SCORING, eidolonTierOf, eidolonsOf, lightConeRanksOf, normalizeDrawWeights,
  ownedCharacters, teamPlan, teamPoolUnits, VERSION_WINDOW,
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
const ACC = Math.max(1, Number(arg('account', '1')) || 1);
const draw = normalizeDrawWeights({
  strength: arg('strength', undefined),
  cost: arg('cost', undefined),
  versatility: arg('versatility', undefined),
});

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

const packKey = (name, eidolon, lc, superimp) => `${name}|E${eidolonTierOf(eidolon)}`
  + `|${lc || '-'}|S${Math.max(1, Math.round(Number(superimp) || 1))}`;
/** 整包键 → 该整包**自己的**强度分（B 口径），以及它的逐副本证据。 */
const packInfo = (conclusion) => {
  const map = new Map();
  for (const unit of teamPoolUnits(conclusion)) {
    map.set(packKey(unit.name, unit.eidolon, unit.lc, unit.superimp), {
      strengthScore: Number(unit.strengthScore) || 0,
      total: Number(unit.total) || 0,
      name: unit.name,
      envs: (unit.envs || []).map((e) => ({
        label: e.envLabel || e.id,
        weight: Number(e.weight) || 0,
        avBest: e.avBest ?? null,
        season: e.strengthSeason ?? null,
        envStrength: Number(e.envStrength) || 0,
        isPerfect: Boolean(e.isPerfect),
      })),
    });
  }
  return map;
};
/** 榜单里这条 roster 的**头条整包**（老口径：`total` 最高的那一条）。 */
const headlineOf = (conclusion) => {
  const byRoster = new Map();
  const rosterKeyOf = (members) => members
    .map((m) => packKey(m.char, m.eidolon, m.lc, m.superimp)).sort().join('~');
  for (const unit of teamPoolUnits(conclusion)) {
    const best = (unit.envs || []).find((env) => (env.members || []).length) || null;
    const members = best?.members || [];
    if (!members.length) continue;
    const key = rosterKeyOf(members);
    const total = Number(unit.total) || 0;
    const prev = byRoster.get(key);
    if (prev && !(total > prev.total)) continue;
    byRoster.set(key, { total, unit });
  }
  return byRoster;
};

const c3 = await build(VERSION_WINDOW);
const c2 = await build(2);
const c1 = await build(1);
const info3 = packInfo(c3);
const info2 = packInfo(c2);
const info1 = packInfo(c1);
const head3 = headlineOf(c3);

const strengthOfMembers = (info, row) => Math.max(0, ...row.members
  .map((m) => info.get(packKey(m.char, m.eidolon, m.lc, m.superimp))?.strengthScore ?? 0));

// ⚠️ `teamPlan` 默认只下发前 15 条（`SCORING.teamPlanMaxRows`），量池内分布必须抬开它。
const keepRows = SCORING.teamPlanMaxRows;
SCORING.teamPlanMaxRows = 100000;
let plan3; let plan2; let plan1;
try {
  plan3 = teamPlan(c3, acct, { availability, drawWeights: draw });
  plan2 = teamPlan(c2, acct, { availability, drawWeights: draw });
  plan1 = teamPlan(c1, acct, { availability, drawWeights: draw });
} finally {
  SCORING.teamPlanMaxRows = keepRows;
}
const row2 = new Map(plan2.rows.map((r) => [r.key, r]));
const row1 = new Map(plan1.rows.map((r) => [r.key, r]));

console.log(`账号 ${ACC}：${role.nickname}｜抽卡权重 强度 ${draw.strength} / 性价比 ${draw.cost}`
  + ` / 泛用性 ${draw.versatility}`);
console.log(`版本窗口：${VERSION_WINDOW} 版（生产） vs 2 版 vs 1 版（只吃最新版本）`);
console.log(`池规模：${VERSION_WINDOW} 版 = ${plan3.pool} 支｜2 版 = ${plan2.pool} 支｜1 版 = ${plan1.pool} 支`);

// ---- Q1：① 在池内扎堆吗 -----------------------------------------------------
const all1 = plan3.rows.map((r) => Number(r.strengthPct)).sort((a, b) => a - b);
const q = (f) => all1[Math.min(all1.length - 1, Math.floor(all1.length * f))];
const ge = (v) => all1.filter((x) => x >= v).length;
console.log(`\n【Q1】候选池 ${all1.length} 支的 ① 分布：min ${all1[0].toFixed(1)}`
  + ` / p25 ${q(0.25).toFixed(1)} / p50 ${q(0.5).toFixed(1)} / p75 ${q(0.75).toFixed(1)}`
  + ` / p90 ${q(0.9).toFixed(1)} / max ${all1[all1.length - 1].toFixed(1)}`);
console.log(`       ① ≥ 95 有 ${ge(95)} 支（${(ge(95) / all1.length * 100).toFixed(1)}%）；`
  + `≥ 90 有 ${ge(90)} 支（${(ge(90) / all1.length * 100).toFixed(1)}%）；`
  + `≥ 98 有 ${ge(98)} 支`);

// ---- Q2/Q3：前排逐条对账 ---------------------------------------------------
const newest = (() => {
  const seasons = new Set();
  for (const info of info3.values()) for (const e of info.envs) if (e.season) seasons.add(e.season);
  return [...seasons].sort().pop() || null;
})();
const ageOf = (s) => (s && newest ? Math.round((Number(newest) - Number(s)) * 10) / 10 : null);
const topByStrength = [...plan3.rows].sort((a, b) => b.strengthPct - a.strengthPct);

console.log(`\n【Q2/Q3】按 ① 排的前 ${ROWS} 名：A 现状｜B 只看头条整包｜C 去掉最旧一版｜D 只吃最新版`);
console.log('  名次  A现状   B头条   C去旧   D最新   证据版本        队伍');
for (const [i, row] of topByStrength.slice(0, ROWS).entries()) {
  const head = head3.get(row.key)?.unit || null;
  const headStrength = head ? Number(head.strengthScore) || 0 : 0;
  const c2Strength = row2.has(row.key) ? Number(row2.get(row.key).strengthPct) : null;
  const c1Strength = row1.has(row.key) ? Number(row1.get(row.key).strengthPct) : null;
  const envs = head ? (info3.get(packKey(head.name, head.eidolon, head.lc, head.superimp))?.envs || []) : [];
  const ages = envs.map((e) => e.season).filter(Boolean).map(ageOf).filter((x) => x !== null);
  const newestSeason = envs.map((e) => e.season).filter(Boolean).sort().pop() || '—';
  const team = row.members.map((m) => `${cn(m.char)}E${m.eidolon}`).join('/');
  console.log(`  #${String(i + 1).padStart(2)} ${Number(row.strengthPct).toFixed(2).padStart(6)}`
    + ` ${headStrength.toFixed(2).padStart(6)}`
    + ` ${(c2Strength === null ? '—' : c2Strength.toFixed(2)).padStart(6)}`
    + ` ${(c1Strength === null ? '—' : c1Strength.toFixed(2)).padStart(6)}`
    + `   ${String(newestSeason).padEnd(6)}（最老 ${ages.length ? Math.max(...ages) : '—'} 版前）  ${team}`);
}
console.log('\n注：A 与 B **必须逐条相等**（① 就是代表整包自己的强度分）—— 不等就是「借用」又回来了。');
console.log('    C / D 是「版本窗口收窄」后的 A：`—` = 这条队伍在那个池里根本不存在。');
