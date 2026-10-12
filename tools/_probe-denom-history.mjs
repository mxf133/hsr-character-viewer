// 探针：**金数项的分母**在 v4.6.69 之前 / 之后两套设计上的实测对照。
//
// 这个探针回答什么问题（用户 2026-10-11 的原问题）
//   用户在性价比详情窗口看到末日幻影那行的金数项是 `7÷1（7.00）`，问：
//   「7÷1 的缺陷，**v4.6.69 之前是怎么设计的**？」
//
//   三行代码就是全部答案（`src/core/advice.js` 的 `buildConclusionInner`）：
//     算分式：score = SCORING.frontierPackScale(100) × perfFactorOf(…) × (分母 ÷ row.cost)
//     v4.6.69 起：分母 = denomCostOf(season) = minCostBySeasonBest = 该版本 **perfect 档**
//                 最小金数；该版本没有 perfect 档才退回 minCostBySeason（全档最小）。
//     v4.6.69 之前：分母 = minCostBySeason = 该版本 **全档**最小金数（不分档位）。
//   这两行就是 `docs/评分模型设计.md` 的 **v24 缺陷 2**（「金数项的分母混了档位」）
//   的「修」与「被修」；版本绑定见 `src/version.js` 的 v4.6.69 条目（② 缺陷 2）。
//   本探针用本机真实数据把两者的差别、代价、副作用各量一遍。
//
// ⚠️ 为什么必须从**真正参与算分的前沿池**（`archiveFrontier` 的 `frontierRows`）取数：
//   数据集里存档的 `season.frontier` 是**未截断**的那批 —— 建库时按「阵容+成本」去重后
//   整批留下；算分池则是它再按**成本升序取恰好 25%** 的截断结果（`archiveFrontier` 的
//   `keep = floor(n × 0.25)`，见那里的「缺陷 4 修」注释）。实测两者行数差 **3~4 倍**，
//   而**档位构成不一样**：截断按成本升序砍，而便宜的配置绝大多数只够到 target 档，
//   于是算分池里 target 行占比远高于存档池。用存档池统计，「金数项 > 1 的比例」与
//   「perfect 行拿不到 1.00 的比例」都会得到**另一个数**（见 B3 的逐副本对照：行数
//   恒为 **4.00 倍** —— 就是 25% 截断比例的倒数，五个副本逐一对齐）。
//   更硬的一条：旧口径的分母 `minCostBySeason` 本身就是在这同一批 `packRows` 上取的，
//   所以「旧分母」必须从 `frontierRows` 复算 —— 从全量投稿复算出来的不是当年那个数。
//   A 节末尾有一条**对生产内部 map 的直接核对**（`frontierEnvs[].minCostBySeason`），
//   用来证明这里的复算与当年那份分母逐版一致，而不是「看起来差不多」。
//
// 怎么用
//   node tools/_probe-denom-history.mjs              # 每段默认 12 行例子
//   node tools/_probe-denom-history.mjs --rows=30    # 表格/例子行数
//
// ⚠️ 必须从**仓库根目录**跑（数据集按 `process.cwd()/theherta` 定位）。只读
// `theherta/archive.json` 与 `theherta/i18n-zh.json`；不改任何生产代码，不进测试套件
// （`tools/_probe-*.mjs` 的约定，见 `tools/_probe-rank.mjs` 的文件头）。
import { archiveIndex, archiveFrontierAll, loadArchive, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
import {
  buildConclusion, frontierFactorsOf, perfFactorOf, SCORING, VERSION_WINDOW,
} from '../src/core/advice.js';

/** 取值支持 `--rows=6` 与 `--rows 6` 两种写法（照抄 _probe-rank.mjs）。 */
const arg = (name, dflt) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return dflt;
};
const ROWS = Math.max(1, Number(arg('rows', '12')) || 12);

// 对齐按**视觉宽度**算：这些表里几乎每一格都夹着中文，`String.padStart` 会把
// 「全档最小」当成 4 个字符，而终端里它占 8 格 —— 表格会散架。
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const visLen = (s) => { let n = 0; for (const ch of String(s)) n += WIDE.test(ch) ? 2 : 1; return n; };
const pad = (v, n) => { const s = String(v); return ' '.repeat(Math.max(0, n - visLen(s))) + s; };
const padE = (v, n) => { const s = String(v); return s + ' '.repeat(Math.max(0, n - visLen(s))); };
const num = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—');
const share = (a, b) => (b > 0 ? `${(100 * a / b).toFixed(1)}%` : '—');
const sec = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
/** 中位数（偶数个取中间两个的算术平均；空数组给 NaN）。 */
const median = (vals) => {
  if (!vals.length) return NaN;
  const s = [...vals].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** 「平均几倍」用**几何**平均 —— 倍数这类比值量纲，算术平均会被最极端的那条带偏。 */
const geoMean = (ratios) => (ratios.length
  ? Math.exp(ratios.reduce((s, r) => s + Math.log(r), 0) / ratios.length) : NaN);
/** 逐条累计最小值（undefined 视为没有）。 */
const setMin = (map, key, value) => {
  const cur = map.get(key);
  if (cur === undefined || value < cur) map.set(key, value);
};

// ---------------------------------------------------------------- 数据装载
// 环境选取与前沿表**复用生产那一份**（`conclusionEnvs` → `archiveFrontierAll` →
// `buildConclusion`），所以这里的分母、判据线、前沿池与界面/接口完全同源
// （见 `src/server/conclusion.js` 的 `conclusionEnvs` 注释）。
const index = await archiveIndex();
const i18n = await loadI18n();
const data = await loadArchive();
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
// 不传 `hiddenCosts` = 隐金一项都不减（`normalizeHiddenCosts(null)` 全 false），
// 于是 `frontierPackRowsOf` 里的 `cost` 恒等于 `frontierRows[].cost` —— 这是下面
// 「拿 frontierRows 复算分母」能成立的前提，A 节末尾的核对就是钉这一条。
const result = buildConclusion(envs, {
  availability: index.refs?.availability || {},
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  frontierWeights: Object.fromEntries(frontierAll.map((f) => [f.env, f.weight])),
});
const frontOf = (id) => frontierAll.find((f) => f.env === id) || null;
const metaOf = (id) => (result.frontierEnvs || []).find((e) => e.id === id) || null;
const cn = (n) => zhName(i18n, 'characters', n) || n;
/** 该副本窗口内升序的版本（`archiveFrontier` 给的 `seasons`，就是算分窗口那 7 版）。 */
const winSeasonsOf = (env) => (frontOf(env.id)?.seasons || []).map(String);
/** 算分池里 cost > 0 的行 —— 只有这些行会进算分（cost 为 0 时金数项无定义）。 */
const poolRowsOf = (env) => (frontOf(env.id)?.frontierRows || []).filter((r) => Number(r.cost) > 0);

// 数据集里「模式全名」的键（`data.modes` 用它），供 B3 读**未截断**的存档前沿。
const fullNameOf = new Map();
for (const m of index.modes || []) {
  for (const st of m.stages || []) fullNameOf.set(`${m.mode}|${st.stage}`, m.key);
}
const rawSeasonOf = (env, season) => {
  const full = fullNameOf.get(`${env.mode}|${env.stage}`);
  return data.modes?.[full]?.stages?.[env.stage]?.seasons?.[String(season)] || null;
};

/** 从一组 `{season, cost, tier}` 行里算出三代分母。**旧口径与新口径用的是同一批行**。 */
const denomTableOf = (rows) => {
  const all = new Map();   // 全档最小 → v4.6.69 **之前**的算分分母（minCostBySeason）
  const best = new Map();  // perfect 档最小 → v4.6.69 **起**的算分分母（minCostBySeasonBest）
  const tier = new Map();  // 逐档最小（target 单独看）
  let minCost = Infinity;
  for (const row of rows) {
    const s = String(row.season || '');
    const c = Number(row.cost);
    if (!(c > 0)) continue;
    if (c < minCost) minCost = c;
    setMin(all, s, c);
    if (row.tier === 'perfect') setMin(best, s, c);
    if (!tier.has(s)) tier.set(s, new Map());
    setMin(tier.get(s), row.tier, c);
  }
  return { all, best, tier, minCost: Number.isFinite(minCost) ? minCost : null };
};
/** 旧口径分母（全档最小，缺则退回副本级最小值 —— 与旧代码同一套兜底）。 */
const oldDenomOf = (t, s) => t.all.get(s) ?? t.minCost;
/** 新口径分母（perfect 档最小，缺则全档最小，再缺则副本级最小值 —— 与 denomCostOf 同构）。 */
const newDenomOf = (t, s) => t.best.get(s) ?? t.all.get(s) ?? t.minCost;

// 每个副本、每个版本的三代分母（A / B / C / D 四节共用这一份，避免各处重算分叉）。
const tables = new Map();
for (const env of envs) tables.set(env.id, denomTableOf(poolRowsOf(env)));

console.log(`数据集：${index.modes?.length || 0} 个模式 / 共 ${data.runCount ?? '?'} 条去重投稿`);
console.log(`环境：${envs.map((e) => `${e.id}（${e.label}）`).join('　')}`);
console.log(`算分窗口 VERSION_WINDOW = ${VERSION_WINDOW} 版　`
  + '前沿池 = 存档前沿按成本升序截断到恰好 25%（archiveFrontier 的 frontierRows）');

// ==================================================================== A
sec('A. 逐「副本 × 版本」的分母三代对照（真实数据，窗口内每一版）');
console.log('  三代 = 全档最小（**旧口径**：v4.6.69 之前算分用的分母）'
  + ' / perfect 档最小（**新口径**：v4.6.69 起算分用的分母） / target 档最小。');
console.log('  「两口径不同」= 旧分母 ≠ 新分母 ⇒ 该版本 target 档比 perfect 档更便宜，'
  + '旧口径把 perfect 档的行系统性压低（正是 v24 缺陷 2）。');
let aDiffTotal = 0; let aSeasonTotal = 0;
for (const env of envs) {
  const f = frontOf(env.id);
  const t = tables.get(env.id);
  const seasons = winSeasonsOf(env);
  console.log(`\n--- ${env.id}　${env.label}`
    + `　（算分池 ${poolRowsOf(env).length} 条 ← 未截断候选 ${f?.merged ?? '?'} 条）`);
  console.log(`    ${padE('版本', 7)}${pad('版本权重', 9)}${pad('全档最小', 9)}${pad('perfect最小', 14)}`
    + `${pad('target最小', 11)}${pad('新口径分母', 11)}  两口径是否不同`);
  for (const s of seasons) {
    const oldD = oldDenomOf(t, s);
    const bestD = t.best.get(s);
    const newD = newDenomOf(t, s);
    const targetD = t.tier.get(s)?.get('target');
    const diff = oldD !== undefined && newD !== undefined && oldD !== newD;
    if (diff) aDiffTotal += 1;
    aSeasonTotal += 1;
    console.log(`    ${padE(s, 7)}${pad(f?.seasonWeights?.[s] ?? 1, 9)}${pad(oldD ?? '—', 9)}`
      + `${pad(bestD ?? '—（无满分档）', 14)}${pad(targetD ?? '—', 11)}${pad(newD ?? '—', 11)}`
      + `  ${diff ? `**不同**：旧 ${oldD} → 新 ${newD}（差 ${newD - oldD} 金）` : '相同'}`);
  }
  const pulled = seasons.filter((s) => Number.isFinite(t.tier.get(s)?.get('target'))
    && Number.isFinite(t.best.get(s)) && t.tier.get(s).get('target') < t.best.get(s));
  console.log(`    → 两口径不同 ${pulled.length} / ${seasons.length} 个版本`
    + `（= target 档最小 < perfect 档最小：${pulled.length
      ? pulled.map((s) => `${s} target ${t.tier.get(s).get('target')} 金 vs perfect ${t.best.get(s)} 金`).join('，')
      : '无'}）`);
}
console.log(`\n  合计：全窗口 ${aSeasonTotal} 个「副本 × 版本」里，**${aDiffTotal} 个**两口径不同。`);

// A-核对：把复算出来的旧分母与**生产内部那份 map** 逐版比一遍。
// `buildConclusionInner` 把 `minCostBySeason`（旧口径的 map）随 `frontierEnvs` 一起返回，
// 它的键值就是当年算分用的分母。对不上说明本探针的取值路径与生产分叉了。
console.log('\n  A-核对：本探针复算的「全档最小」vs 生产 buildConclusion 内部下发的 minCostBySeason');
let aChecked = 0; let aMismatch = 0;
for (const env of envs) {
  const meta = metaOf(env.id);
  const prod = meta?.minCostBySeason || {};
  const t = tables.get(env.id);
  const seasons = new Set([...winSeasonsOf(env), ...Object.keys(prod)]);
  for (const s of seasons) {
    const mine = t.all.get(s);
    const theirs = prod[s] === undefined ? undefined : Number(prod[s]);
    if (mine === undefined && theirs === undefined) continue;
    aChecked += 1;
    if (mine !== theirs) {
      aMismatch += 1;
      console.log(`    ✗ ${env.id} ${s}：探针 ${mine} vs 生产 ${theirs}`);
    }
  }
  console.log(`    ${padE(env.id, 12)}生产 map 有 ${Object.keys(prod).length} 个版本，`
    + `逐版一致${aMismatch ? '（见上面的 ✗）' : ''}`);
}
console.log(`    → 核对 ${aChecked} 个「副本 × 版本」：不一致 **${aMismatch}** 个`
  + `${aMismatch === 0 ? '（复算路径与生产完全一致，A/B/C/D 的分母都是当年那个数）' : '（⚠️ 探针与生产已分叉，下面的数字不可用）'}`);

// ==================================================================== B
sec('B. 两套口径在**真正参与算分的前沿池**上的金数项分布（分母 ÷ row.cost）');
console.log('  旧口径 = 该版本全档最小做分母；新口径 = 该版本 perfect 档最小做分母'
  + '（缺 perfect 档退回全档最小，此时两口径相同）。');
console.log(`\n    ${padE('副本', 15)}${pad('行数', 6)}${padE('　口径', 9)}${pad('均值', 9)}${pad('中位', 9)}`
  + `${pad('min', 9)}${pad('max', 9)}${pad('>1.00', 8)}${pad('=1.00', 8)}`);
const bSummary = [];
for (const env of envs) {
  const t = tables.get(env.id);
  const rows = poolRowsOf(env);
  const oldF = []; const newF = [];
  let raised = 0; let lowered = 0; let same = 0;
  const raiseRatios = []; const lowerRatios = [];
  let maxRatio = 1;
  for (const row of rows) {
    const s = String(row.season || '');
    const cost = Number(row.cost);
    const of = oldDenomOf(t, s) / cost;
    const nf = newDenomOf(t, s) / cost;
    oldF.push(of); newF.push(nf);
    if (nf > of + 1e-12) {
      raised += 1; raiseRatios.push(nf / of);
      if (nf / of > maxRatio) maxRatio = nf / of;
    } else if (nf < of - 1e-12) { lowered += 1; lowerRatios.push(nf / of); } else same += 1;
  }
  const line = (label, vals) => console.log(`    ${padE(label === 'old' ? env.id : '', 15)}${pad(vals.length, 6)}`
    + `${padE(label === 'old' ? '旧 old' : '新 new', 9)}`
    + `${pad(num(vals.reduce((a, b) => a + b, 0) / (vals.length || 1), 4), 9)}`
    + `${pad(num(median(vals), 4), 9)}${pad(num(Math.min(...vals), 4), 9)}${pad(num(Math.max(...vals), 4), 9)}`
    + `${pad(vals.filter((v) => v > 1 + 1e-9).length, 8)}${pad(vals.filter((v) => Math.abs(v - 1) < 1e-9).length, 8)}`);
  line('old', oldF);
  line('new', newF);
  bSummary.push({
    env, rows: rows.length, raised, lowered, same, raiseRatios, lowerRatios, maxRatio, oldF, newF,
  });
}

console.log('\n  B2 同一批行的方向统计（比较新口径 − 旧口径，逐行）：');
console.log(`    ${padE('副本', 15)}${pad('行数', 6)}${pad('旧<新', 8)}${pad('旧>新', 8)}${pad('不变', 7)}`
  + `${pad('平均抬高', 10)}${pad('最大抬高', 10)}  说明`);
for (const b of bSummary) {
  console.log(`    ${padE(b.env.id, 15)}${pad(b.rows, 6)}${pad(b.raised, 8)}${pad(b.lowered, 8)}${pad(b.same, 7)}`
    + `${pad(num(geoMean(b.raiseRatios), 4), 10)}${pad(num(b.maxRatio, 4), 10)}`
    + `  ${b.raised ? `旧<新 = 旧口径下金数项 < 1 的行（占本副本 ${share(b.raised, b.rows)}）` : '两口径完全相同'}`);
}
console.log('    结构性结论：**「旧 > 新」恒为 0 条**。原因是一个不等式，不是数据巧合 ——');
console.log('      同一版本内 perfect 档最小 ≥ 全档最小（perfect 行是全档的子集），'
  + '而新分母 = perfect 最小、旧分母 = 全档最小，');
console.log('      所以对**任何一行**都有 新金数项 ≥ 旧金数项：新口径只可能抬高、不可能压低。');
console.log('      （B 表里旧口径那一行的 max 恒 = 1.0000，就是这条不等式的实测形态。）');
console.log('    ⇒ 所以「被新口径压低的行」= 0 条；v24 缺陷 2 修掉的是**反过来的那批** ——');
console.log('      旧口径下拿不到 1.00 的行（主要是 perfect 档），它们在新口径下被抬高，量级见 D 节。');

// B3：同一套统计改从**未截断的存档前沿**取数会得到什么 —— 用来证明口径选择不是细节。
//     存档池 = `data.modes[全名].stages[stage].seasons[s].frontier`，即建库时留下的全量
//     「阵容+成本」去重前沿（`archiveFrontier` 截断之前的那份）。
sec('B3 对照：若改成从**未截断的存档前沿**统计（错的做法），数字会差多少');
console.log('  存档池 = 数据集里的 season.frontier（未截断，同成本并列整批纳入）；'
  + '算分池 = 它按成本升序取恰好 25% 的截断结果，也是算分真正吃的那批。');
console.log(`    ${padE('副本', 15)}${pad('算分行数', 10)}${pad('存档行数', 10)}${pad('倍数', 7)}`
  + `${pad('算分池>1', 11)}${pad('存档池>1', 11)}`);
for (const env of envs) {
  const pool = poolRowsOf(env);
  const rawRows = [];
  for (const s of winSeasonsOf(env)) {
    for (const f of rawSeasonOf(env, s)?.frontier || []) {
      // 与 archiveFrontier 同一条筛选：t < 2（及格/线外）不进前沿；t 缺失按 perfect 计。
      if (f.t !== undefined && Number(f.t) < 2) continue;
      rawRows.push({ season: s, cost: Number(f.c) || 0, tier: Number(f.t) === 2 ? 'target' : 'perfect' });
    }
  }
  const tRaw = denomTableOf(rawRows);
  const tPool = tables.get(env.id);
  const overOf = (rows, t) => rows.filter((r) => {
    const c = Number(r.cost);
    return c > 0 && newDenomOf(t, String(r.season || '')) / c > 1 + 1e-9;
  }).length;
  const nPool = overOf(pool, tPool);
  const nRaw = overOf(rawRows, tRaw);
  console.log(`    ${padE(env.id, 15)}${pad(pool.length, 10)}${pad(rawRows.length, 10)}`
    + `${pad(num(rawRows.length / (pool.length || 1), 2), 7)}`
    + `${pad(`${nPool} / ${pool.length}`, 11)}${pad(`${nRaw} / ${rawRows.length}`, 11)}`
    + `  ${nPool === nRaw ? '条数相同' : '**口径不同则结论不同**'}`
    + `${share(nPool, pool.length) === share(nRaw, rawRows.length) ? '' : `（占比 ${share(nPool, pool.length)} vs ${share(nRaw, rawRows.length)}）`}`);
}
console.log('  ⇒ 行数差 4 倍、占比差 7 个百分点（末日幻影 26.7% vs 19.8%）：'
  + '拿存档池当算分池统计，会把「金数项 > 1 有多普遍」整体说小。');

// ==================================================================== C
sec('C. 用户截图那一行在两套口径下的结果（末日幻影 4.3 · target 档 · 行动值 150 · 1 金）');
const asEnv = envs.find((e) => e.mode === 'as') || null;
if (!asEnv) {
  console.log('  ⚠️ 本数据集里没有末日幻影（mode = as），本节跳过。');
} else {
  const t = tables.get(asEnv.id);
  const season = '4.3';
  const av = 150;   // 截图里的 3850 积分 = 内部行动值 4000 − 3850（数据集内部统一「越小越好」）
  const cost = 1;   // 该队伍 1 金
  const tier = 'target';
  const oldD = oldDenomOf(t, season);
  const newD = newDenomOf(t, season);
  const perf = perfFactorOf(av, asEnv.tierLines, false, tier);
  const scale = SCORING.frontierPackScale;
  const oldCf = oldD / cost;
  const newCf = newD / cost;
  console.log(`    判据线 ${JSON.stringify(asEnv.tierLines)}　lowerIsBetter=false（积分方向）`
    + '　内部行动值 = 4000 − 积分');
  console.log(`    该版本（${season}）三代分母：全档最小（旧）= ${oldD} 金`
    + `　perfect 档最小（新）= ${newD} 金　target 档最小 = ${t.tier.get(season)?.get('target')} 金`);
  console.log(`    表现分：perfFactorOf(${av}, 末日幻影的线, false, '${tier}') = ${num(perf, 6)}`
    + '（= 截图那一栏显示的 0.75）');
  console.log(`    旧口径：costFactor = ${oldD} ÷ ${cost} = ${num(oldCf, 4)}`
    + `　score = ${scale} × ${num(perf, 4)} × ${num(oldCf, 4)} = **${num(scale * perf * oldCf, 2)}**`);
  console.log(`    新口径：costFactor = ${newD} ÷ ${cost} = ${num(newCf, 4)}`
    + `　score = ${scale} × ${num(perf, 4)} × ${num(newCf, 4)} = **${num(scale * perf * newCf, 2)}**`);
  console.log(`    ⇒ **截图里的「7÷1」在旧口径下会变成「${oldD}÷${cost}」（${num(oldCf, 2)}）**：`
    + `同一行的单版本分从 ${num(scale * perf * newCf, 2)} 掉到 ${num(scale * perf * oldCf, 2)}`
    + `（差 ${num(scale * perf * (newCf - oldCf), 2)} 分，降到 1/${num(newCf / (oldCf || 1), 2)}）。`);
  // 复核：把这一行按真实数据找出来（同一版本、target 档、1 金的实际前沿行）。
  const hits = poolRowsOf(asEnv)
    .filter((r) => String(r.season) === season && r.tier === 'target' && Number(r.cost) === cost);
  console.log(`    真实数据复核：算分池里「${season} · target · ${cost} 金」的行有 ${hits.length} 条`);
  for (const h of hits.slice(0, ROWS)) {
    console.log(`      · 行动值 ${num(h.actionValue, 0)}（积分 ${4000 - Number(h.actionValue)}）`
      + `　队伍 ${h.members.map((m) => `${cn(m.char)}E${m.eidolon}`).join(' + ')}`);
  }
  // 与生产链路对齐：`frontierFactorsOf` 读的正是 `denomCostOf()` 逐条下发的 seasonMinCost。
  const probeEnv = {
    id: asEnv.id, tier, actionValue: av, bestTeamGold: cost, seasonMinCost: newD, score: 0, weight: 1,
  };
  const viaProd = frontierFactorsOf(probeEnv, metaOf(asEnv.id));
  console.log(`    生产链路交叉验证（frontierFactorsOf + seasonMinCost=${newD}）：`
    + `costFactor=${num(viaProd.costFactor, 6)}　base=${num(viaProd.base, 4)}`
    + `　（与上面新口径算出的 ${num(scale * perf * newCf, 4)} 一致）`);
  console.log('    ⚠️ 截图与本地快照不是同一份数据（见 docs v28 的说明），但「分母 ÷ 本队金数」'
    + '只取决于**版本分母**与**本队金数**两个数，与快照无关。');
  // 旧口径真正的病灶：**只打到达标**的 1 金队拿满 1.00，而**打到满分**的队被压到 0.14。
  const perfectSame = poolRowsOf(asEnv)
    .filter((r) => String(r.season) === season && r.tier === 'perfect')
    .map((r) => ({ r, old: oldDenomOf(t, season) / Number(r.cost), neu: newDenomOf(t, season) / Number(r.cost) }))
    .sort((a, b) => a.neu - b.neu);
  console.log('    同一版本的对照（旧口径真正的病灶）：');
  console.log(`      · target 档 ${cost} 金（只有达标）　旧金数项 ${num(oldCf, 4)}（拿满）`
    + `　新金数项 ${num(newCf, 4)}`);
  for (const p of perfectSame.slice(0, ROWS)) {
    console.log(`      · perfect 档 ${p.r.cost} 金（打到满分）旧金数项 ${num(p.old, 4)}`
      + `　新金数项 ${num(p.neu, 4)}　→ 旧口径下「达标队拿满、满分队被压」`
      + `　队伍 ${p.r.members.map((m) => `${cn(m.char)}E${m.eidolon}`).join(' + ')}`);
  }
}

// ==================================================================== D
sec('D. 旧口径的代价：v24 缺陷 2 那句话的实测复核（perfect 档被压到多少）');
console.log('  逐副本统计：① 有多少个版本的 target 档最小 **严格小于** perfect 档最小'
  + '（= 旧分母被 target 档拉低）；');
console.log('              ② 算分池里的 perfect 行在旧口径下的金数项分布'
  + '（旧口径下只有「本队金数 = 全档最小」的 perfect 行才能拿到 1.00）。');
console.log(`\n    ${padE('副本', 15)}${pad('版本数', 9)}${pad('被拉低', 9)}${pad('perfect行', 11)}`
  + `${pad('旧=1.00', 10)}${pad('旧<1.00', 10)}${pad('占比', 8)}${pad('旧均值', 9)}${pad('旧最低', 9)}`);
const dExamples = [];
for (const env of envs) {
  const t = tables.get(env.id);
  const seasons = winSeasonsOf(env);
  const pulled = seasons.filter((s) => Number.isFinite(t.tier.get(s)?.get('target'))
    && Number.isFinite(t.best.get(s)) && t.tier.get(s).get('target') < t.best.get(s));
  const perfect = poolRowsOf(env).filter((r) => r.tier === 'perfect');
  const factors = perfect.map((r) => oldDenomOf(t, String(r.season || '')) / Number(r.cost));
  const atOne = factors.filter((v) => Math.abs(v - 1) < 1e-9).length;
  const below = factors.filter((v) => v < 1 - 1e-9).length;
  console.log(`    ${padE(env.id, 15)}${pad(seasons.length, 9)}${pad(pulled.length, 9)}`
    + `${pad(perfect.length, 11)}${pad(atOne, 10)}${pad(below, 10)}${pad(share(below, perfect.length), 8)}`
    + `${pad(num(factors.reduce((a, b) => a + b, 0) / (factors.length || 1), 4), 9)}`
    + `${pad(num(Math.min(...factors), 4), 9)}`);
  for (const s of pulled) {
    const worst = perfect
      .filter((r) => String(r.season) === s)
      .map((r) => ({ r, f: oldDenomOf(t, s) / Number(r.cost) }))
      .sort((a, b) => a.f - b.f)[0];
    if (worst) {
      dExamples.push({
        env, season: s, allD: oldDenomOf(t, s), bestD: t.best.get(s),
        targetD: t.tier.get(s).get('target'), ...worst,
      });
    }
  }
}
console.log('\n  D2 具体的 perfect 档吃亏例子（旧口径下最差的 perfect 行，按吃亏程度排序取前若干）：');
dExamples.sort((a, b) => a.f - b.f);
for (const e of dExamples.slice(0, ROWS)) {
  console.log(`      · ${padE(e.env.id, 12)}${padE(e.season, 6)}target 档最小 ${e.targetD} 金`
    + ` < perfect 档最小 ${e.bestD} 金　旧分母 = 全档最小 ${e.allD} 金`);
  console.log(`        → 这条 perfect 行（${e.r.cost} 金，行动值 ${num(e.r.actionValue, 0)}）在旧口径下只拿到 `
    + `${e.allD}÷${e.r.cost} = ${num(e.f, 4)}，新口径下是 ${e.bestD}÷${e.r.cost} = ${num(e.bestD / e.r.cost, 4)}`
    + `　队伍 ${e.r.members.map((m) => `${cn(m.char)}E${m.eidolon}`).join(' + ')}`);
}
const perfectAll = [];
for (const env of envs) {
  const t = tables.get(env.id);
  for (const r of poolRowsOf(env)) {
    if (r.tier !== 'perfect') continue;
    perfectAll.push({
      env: env.id, season: String(r.season || ''), cost: Number(r.cost),
      old: oldDenomOf(t, String(r.season || '')) / Number(r.cost),
      neu: newDenomOf(t, String(r.season || '')) / Number(r.cost),
    });
  }
}
const pBelow = [...perfectAll].filter((p) => p.old < 1 - 1e-9).sort((a, b) => a.old - b.old);
const pMean = perfectAll.reduce((a, p) => a + p.old, 0) / (perfectAll.length || 1);
const pMeanNew = perfectAll.reduce((a, p) => a + p.neu, 0) / (perfectAll.length || 1);
const pAtOneNew = perfectAll.filter((p) => Math.abs(p.neu - 1) < 1e-9).length;
const pBelowNew = perfectAll.filter((p) => p.neu < 1 - 1e-9).length;
const pOverOneNew = perfectAll.filter((p) => p.neu > 1 + 1e-9).length;
console.log('\n  D3 汇总（全部 5 个副本的算分池，只看 perfect 行）：');
console.log(`      perfect 行 ${perfectAll.length} 条；旧口径下拿不到 1.00 的 **${pBelow.length} 条`
  + `（${share(pBelow.length, perfectAll.length)}）**，旧均值 ${num(pMean, 4)}`
  + `，最惨 ${num(pBelow[0]?.old, 4)}（${pBelow[0]?.env ?? '—'} ${pBelow[0]?.season ?? ''} ${pBelow[0]?.cost ?? ''} 金）`);
console.log(`      同一条数在新口径下：= 1.00 的 ${pAtOneNew} 条（就是每个「副本×版本」里最便宜的那条 perfect 行）`
  + `、< 1.00 的 ${pBelowNew} 条（但仍**逐条高于**旧口径）、> 1.00 的 **${pOverOneNew} 条**`
  + `，新均值 ${num(pMeanNew, 4)}`);
console.log('      ⚠️ 注意方向别写反：新口径下 **perfect 行不会 > 1.00**（perfect 档最小金数就是该档的下确界，'
  + '本队不可能比它更便宜），');
console.log('        能 > 1.00 的是 **target 行** —— 它不在「取 min」的那个集合里。旧口径同理：'
  + '全档最小是全档的下确界，所以旧口径下**任何行**都 > 不了 1.00。');
console.log(`      ⇒ v24 那句话（「target 档更便宜时把 perfect 档系统性压低」）在今天的算分池上`
  + `影响 **${pBelow.length} / ${perfectAll.length} = ${share(pBelow.length, perfectAll.length)}** 的 perfect 行，`
  + '不是边角个例。');

// ==================================================================== E
sec('E. 一句话小结');
const totalPool = bSummary.reduce((a, b) => a + b.rows, 0);
const totalRaised = bSummary.reduce((a, b) => a + b.raised, 0);
const totalLowered = bSummary.reduce((a, b) => a + b.lowered, 0);
const totalOldOver1 = bSummary.reduce((a, b) => a + b.oldF.filter((v) => v > 1 + 1e-9).length, 0);
const totalNewOver1 = bSummary.reduce((a, b) => a + b.newF.filter((v) => v > 1 + 1e-9).length, 0);
const maxNew = Math.max(...bSummary.map((b) => Math.max(...b.newF)));
console.log(`    旧口径（分母 = 该版本**全档**最小）：**任何行都不可能 > 1.00**`
  + `（分母就是全档的下确界；实测算分池 ${totalPool} 条里 > 1 的 ${totalOldOver1} 条，旧口径 max 恒 = 1.0000）。`
  + `代价是 **${pBelow.length} / ${perfectAll.length} = ${share(pBelow.length, perfectAll.length)} 的 perfect 行拿不到 1.00**`
  + `（均值 ${num(pMean, 4)}，最惨 ${num(pBelow[0]?.old, 4)}）—— 越贵的那一档越吃亏，`
  + '而 perfect 恰恰是「打到满分」的那一档：**只达标 1 金队拿满、打满分 7 金队拿 0.14**。');
console.log(`    新口径（分母 = 该版本 **perfect 档**最小）：**perfect 行不可能 > 1.00**`
  + `（分母是该档的下确界），每版最便宜的那条 perfect 行恰好 = 1.00（${pAtOneNew} 条）；`
  + `代价是 **target 行**可以 > 1.00 —— 实测算分池 ${totalPool} 条里 **${totalNewOver1} 条**`
  + `（${share(totalNewOver1, totalPool)}），最高 ×${num(maxNew, 2)}（就是截图那个 7÷1）。`);
console.log(`    两口径之间：被新口径**抬高** ${totalRaised} 条（${share(totalRaised, totalPool)}），`
  + `被新口径**压低** ${totalLowered} 条（结构性恒为 0，见 B2），其余 ${totalPool - totalRaised - totalLowered} 条不变。`);
console.log('    截图那个「7÷1」= 分子取**这一条配置自己**的金数（可能落在 target 档）、'
  + '分母只取 perfect 档最小 —— 跨档相除的产物；退回旧口径会变成「1÷1 = 1.00」，'
  + '该行单版本分 525.00 → 75.00（C 节）。');
console.log('\n探针结束（只读数据，未修改任何生产代码）。');
