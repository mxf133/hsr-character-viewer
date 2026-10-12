// 探针：把「性价比总榜 / 抽卡方案」在**真实数据 + 本机账号**上打出来，用于调参后肉眼核对。
//
// 为什么单独一支：`herta-test.mjs` 只钉不变量（哪些字段、单调性、权重生效），
// 而调口径时要看的是「榜上头部换成谁了、方案前 10 条是什么」。跑一次约 3 秒。
//
//   node tools/_probe-rank.mjs                 # 默认权重
//   node tools/_probe-rank.mjs --weights aa=9  # 把异相仲裁两档都调到 9（逗号分隔）
//   node tools/_probe-rank.mjs --rows 12       # 每段打印几条
//
// 账号从 data/accounts.json 的第一个角色读（没有账号时按空角色池跑）。
//
// ⚠️ 环境选取与 `firstSeen` **复用生产那一份**（`conclusionEnvs`，v4.6.48 修）：
// 这里以前各写一套（少了完整性回退、也不传 firstSeen），于是探针与界面成为两套口径。
import { readFile } from 'node:fs/promises';
import {
  buildConclusion, budgetPlan, eidolonsOf, envWeightOf, lightConeRanksOf, ownedCharacters,
  VERSION_WINDOW,
} from '../src/core/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

/** 取值支持两种写法：`--rows=6` 与 `--weights aa=9,pf=0.1`（空格分隔也认）。 */
const arg = (name, dflt) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return dflt;
};
const ROWS = Math.max(1, Number(arg('rows', '12')) || 12);

/** `--weights aa=9,pf=0.1` → `{ 'aa|': 9, 'aa|plight': 9, 'pf|': 0.1 }`（短码按关卡展开）。 */
const weightsArg = () => {
  const raw = arg('weights', '');
  if (!raw) return undefined;
  const stages = { aa: ['', 'plight'], moc: [''], pf: [''], as: [''] };
  const out = {};
  for (const part of String(raw).split(',')) {
    const [mode, value] = part.split('=');
    if (!mode || value === undefined) continue;
    for (const stage of stages[mode] ?? ['']) out[`${mode}|${stage}`] = Number(value);
  }
  return out;
};

const index = await archiveIndex();
const i18n = await loadI18n();

// ---- 本机账号（没有就按空角色池）---------------------------------------------
let owned = new Set();
let eidolons = new Map();
let cones = new Map();
try {
  const store = JSON.parse(await readFile('data/accounts.json', 'utf8'));
  const account = store.accounts?.[0];
  const role = account?.roles?.[0];
  const snapshot = account?.snapshots?.[role?.uid];
  if (snapshot) {
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
    owned = ownedCharacters(snapshot, zhToEn, allNames);
    eidolons = eidolonsOf(snapshot, zhToEn);
    cones = lightConeRanksOf(snapshot, coneZhToEn);
    console.log(`账号：${role.nickname || role.uid} · 拥有 ${owned.size} 个角色 / ${cones.size} 把光锥`);
  }
} catch {
  console.log('账号：读不到（按空角色池跑）');
}

// ---- 把 5 个环境的阵容表取齐：**直接复用生产那一份**（`conclusionEnvs`）---------
// 以前这里手写了一套「最新可靠赛季」的选取（少了 `listEnvs` 的完整性回退、也不传
// `firstSeen`），与 GUI 分叉成了两套口径 ——「探针说砂金 #3、界面是 #14」就是这么来的。
const { envs } = await conclusionEnvs(index);

const weights = weightsArg();
// `--weights` 是手工调参用的开关：**两个口径都按它来**（想让两块不一致时直接改代码），
// 真实界面是两个独立输入（见 public/scripts/advice-view.js）。
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW, weights });
const result = buildConclusion(envs, {
  availability: index.refs?.availability || {},
  // 登场版本（用户第 6 条）：生产一定会传（见 conclusion.js 的 archiveConclusion）。
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: { owned, eidolons, cones },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  weights,
  frontierWeights: weights,
});

const cn = (name, nameCn) => zhName(i18n, 'characters', name)
  || zhName(i18n, 'lightCones', name) || nameCn || name;
const KIND = { char: '角色', eidolon: '星魂', cone: '光锥' };
const costText = (u) => (u.kind === 'cone'
  ? (u.from >= 1 ? `叠影 SI${u.from}→SI${u.target}` : '光锥本体')
  : u.kind === 'eidolon' ? `E${u.from}→E${u.target}`
    : (u.target > 0 ? `角色本体+E${u.target}` : '角色本体'));
const TIER_CN = { perfect: '满分', target: '达标' };
/** 副本元数据由服务端单独发一份（只有 5 条），按 id 查标签与权重。 */
const frontierMeta = (id) => (result.frontierEnvs || []).find((e) => e.id === id) || null;

console.log('\n副本权重：' + (weights
  ? Object.entries(weights).map(([k, v]) => `${k}=${v}`).join(' ')
  : '默认 ' + envs.map((e) => `${e.mode}|${e.stage}=${envWeightOf(e.mode, e.stage)}`).join(' ')));

// 总榜（v4.6.45 起是**整包**口径：角色 + 星魂档 + 光锥绑成一条，
// 分子分母都只来自那支队伍）。要按角色点名查整包用 tools/_probe-pack.mjs。
console.log(`\n=== 性价比总榜（整包口径，共 ${result.frontierUnits.length} 条）===`);
for (const [index, u] of result.frontierUnits.slice(0, ROWS).entries()) {
  const best = u.envs[0];
  const bestLabel = best ? (frontierMeta(best.id)?.label || best.id) : '—';
  console.log(`  #${String(index + 1).padStart(3)} ${String(Math.round(u.total)).padStart(5)}  `
    + `整包${String(u.gold).padStart(2)}金  ${cn(u.name, u.nameCn)} E${u.eidolon}`
    + `${u.lc ? ` + ${cn(u.lc)}S${u.superimp}` : ''}`.padEnd(34)
    + ` 最佳 ${bestLabel} ${TIER_CN[u.bestTier] ?? '—'} ${u.bestTeamGold ?? '—'}金`
    + ` av=${u.bestActionValue ?? '—'}`);
}

console.log(`\n=== 抽卡方案（按本机账号，共 ${result.units.length} 个候选单位）===`);
const plan = budgetPlan({ units: result.units, envs: result.envs }, Number(arg('budget', '')) || null);
console.log(`预算 ${plan.budget ?? '不限'} → ${plan.picks.length} 条 / 共 ${plan.totalPulls} 金`
  + ` / 覆盖 ${plan.coveredCount} 个副本`);
for (const p of plan.picks.slice(0, ROWS)) {
  // ⚠️ `Number(null) === 0`：基线为 null（这一期没有可比成绩）时不能印成「0%」
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const why = p.envs.filter((e) => {
    if (!e.easy) return (num(e.pctAfter) ?? 0) - (num(e.pctBefore) ?? 0) >= 0.05 || num(e.pctBefore) === null;
    return num(e.costAfter) !== null && num(e.costBefore) !== null && num(e.costAfter) < num(e.costBefore);
  }).slice(0, 2).map((e) => {
    if (!e.easy) {
      const before = num(e.pctBefore);
      return before === null
        ? `${e.envLabel} 击败 ${e.pctAfter}%`
        : `${e.envLabel} 击败 ${before}%→${e.pctAfter}%`;
    }
    return `${e.envLabel} ${e.costBefore}→${e.costAfter} 金`;
  }).join('；');
  console.log(`  ${String(p.pulls).padStart(2)} 金  ${KIND[p.kind]} `
    + `${cn(p.name, p.nameCn).padEnd(16)} +${Math.round(p.value * 100)}   ${why}`);
}
console.log('\n构成：', JSON.stringify(result.counts));
