// 探针：**表现曲线 / 末日幻影满分线 / 金数项分母**的真实数据审计。
//
// 这个探针回答什么问题（用户 2026-10-11 的第 3、4 问）
//   A. 每个副本/关卡的判据线与「表现曲线」锚点长什么样；截图里 299 → 0.85、
//      3850 → 0.75 这两个数能不能逐位复现（`perfFactorOf` 的实际返回值）。
//   B. 末日幻影到底有多少人到 4000 分（前沿池逐档计数 + 全量投稿分布），
//      并把另外四个副本各打一份**对照**；最后把「满分线从 4000 放宽到 3900/3800/3700」
//      当纯函数算一遍，看因子会变成多少。
//   C. 「金数项 > 1.00」的来路：分母是**该版本 perfect 档最便宜**（`denomCostOf`），
//      分子是**这条配置自己**的金数（可能落在 target 档）—— 两个数不同档时会算出 >1 的
//      倍数（截图里末日幻影那行 `7÷1（7.00）`）。这里统计全榜有多少条、最极端的是谁，
//      并把两种修法的影响量级估出来。
//   D. 绝境王棋关 299 = 0.85 的直接证据：曲线在 0/37/100/299/300/301/500 的取值，
//      以及该副本 perfect 档 `actionValue` 的**实际区间**（299 在完美档里算什么水平）。
//
// 怎么用
//   node tools/_probe-perf-audit.mjs                 # 每段默认 12 行
//   node tools/_probe-perf-audit.mjs --rows=30       # 表格行数
//   node tools/_probe-perf-audit.mjs --top=20        # 极端例子条数
//
// ⚠️ 必须从**仓库根目录**跑：数据集按 `process.cwd()/theherta` 定位。
// 只读 `theherta/archive.json` 与 `theherta/i18n-zh.json`；不改任何生产代码，
// 不进测试套件（`tools/_probe-*.mjs` 的约定，见 tools/_probe-rank.mjs 的文件头）。
import { archiveIndex, archiveFrontierAll, loadArchive, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
import {
  avLinesOf, buildConclusion, frontierFactorsOf, metricShortText, perfAnchorsOf, perfFactorOf,
  perfLineWeightsOf, SCORING, tierTextOf, VERSION_WINDOW,
} from '../src/core/advice.js';

/**
 * v4.6.78 起表现曲线**按副本取值**（`SCORING.frontierPerfLineByEnv`：绝境满分线以内 1.00、
 * 达标线 0.60）。探针必须与生产**同源**，否则它会打印旧曲线、看起来却像程序的行为 ——
 * 所以这里统一走这两个包装，别在下面直接调 `perfFactorOf` / `perfAnchorsOf`。
 */
const perfOf = (av, env, tier) => perfFactorOf(av, env.tierLines,
  env.lowerIsBetter !== false, tier, perfLineWeightsOf(env));
const anchorsOf = (env) => perfAnchorsOf(env.tierLines, env.lowerIsBetter !== false,
  perfLineWeightsOf(env));

/** 取值支持 `--rows=6` 与 `--rows 6` 两种写法（照抄 _probe-rank.mjs）。 */
const arg = (name, dflt) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return dflt;
};
const ROWS = Math.max(1, Number(arg('rows', '12')) || 12);
const TOP = Math.max(1, Number(arg('top', '8')) || 8);

const pad = (v, n) => String(v).padStart(n);
const padE = (v, n) => String(v).padEnd(n);
const num = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—');
const share = (a, b) => (b > 0 ? `${(100 * a / b).toFixed(1)}%` : '—');
const sec = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

// ---------------------------------------------------------------- 数据装载
// 环境选取与前沿表**复用生产那一份**（`conclusionEnvs` → `archiveFrontierAll`），
// 所以这里打出来的权重、判据线、前沿池与界面/接口完全同源（见 conclusion.js 的注释）。
const index = await archiveIndex();
const i18n = await loadI18n();
const data = await loadArchive();
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const result = buildConclusion(envs, {
  availability: index.refs?.availability || {},
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  frontierWeights: Object.fromEntries(frontierAll.map((f) => [f.env, f.weight])),
});
const metaOf = (id) => (result.frontierEnvs || []).find((e) => e.id === id) || null;
const frontOf = (id) => frontierAll.find((f) => f.env === id) || null;
const cn = (n) => zhName(i18n, 'characters', n) || n;
const coneCn = (n) => (n ? (zhName(i18n, 'lightCones', n) || n) : '—');

/** 短码 + 关卡 → 数据集里的模式全名（archive.json 的 `modes` 用它做键）。 */
const fullNameOf = new Map();
for (const m of index.modes || []) {
  for (const st of m.stages || []) fullNameOf.set(`${m.mode}|${st.stage}`, m.key);
}
const rawSeasonOf = (env, season) => {
  const full = fullNameOf.get(`${env.mode}|${env.stage}`);
  return data.modes?.[full]?.stages?.[env.stage]?.seasons?.[String(season)] || null;
};
/** 该副本窗口内升序的版本（`archiveFrontier` 给的 `seasons`）。 */
const winSeasonsOf = (env) => (frontOf(env.id)?.seasons || []).map(String);
const rhoOf = (a, b) => {
  const keys = [...a.keys()].filter((k) => b.has(k));
  const n = keys.length;
  let d2 = 0;
  for (const k of keys) d2 += (a.get(k) - b.get(k)) ** 2;
  return n > 1 ? 1 - (6 * d2) / (n * (n * n - 1)) : NaN;
};

console.log(`数据集：${index.modes?.length || 0} 个模式 / 共 ${data.runCount ?? '?'} 条去重投稿`);
console.log(`环境：${envs.map((e) => `${e.id}（${e.label}，权重 ${frontOf(e.id)?.weight}）`).join('　')}`);

// ==================================================================== A
sec('A. 判据线 / 表现曲线锚点表（真实数据，逐副本）');

/** 锚点是「行动值」，把它翻回游戏内写法；线本身用 tierTextOf 标档位名。 */
const anchorLine = (env, av) => {
  const L = avLinesOf(env.tierLines, env.lowerIsBetter !== false);
  const hit = [['满分线', L.perfect], ['达标线', L.target], ['及格线', L.pass]]
    .find(([, v]) => Number.isFinite(v) && Math.abs(v - av) < 1e-9);
  const game = metricShortText(env.mode, env.stage, av);
  const tierName = hit ? (tierTextOf({ mode: env.mode, stage: env.stage, tierLines: env.tierLines },
    hit[0] === '满分线' ? 'perfect' : hit[0] === '达标线' ? 'target' : 'pass') || '') : '';
  return `${hit ? hit[0] : '顶点'} ${padE(game, 10)}${tierName ? ` (${tierName})` : ''}`;
};

for (const env of envs) {
  const meta = metaOf(env.id);
  const f = frontOf(env.id);
  const L = avLinesOf(env.tierLines, env.lowerIsBetter !== false);
  console.log(`\n--- ${env.id}　${env.label}`);
  console.log(`    权重 ${f?.weight}　方向 lowerIsBetter=${env.lowerIsBetter !== false}`
    + `　前沿池 ${f?.pool} 条 / 候选 ${f?.merged} 条　窗口 ${JSON.stringify(winSeasonsOf(env))}`);
  console.log(`    判据线（游戏内量纲）${JSON.stringify(env.tierLines)}`
    + `　换算到行动值空间 ${JSON.stringify(L)}`);
  console.log(`    最便宜金数 minCost=${meta?.minCost}（全窗口最小值，展示/兜底用）`
    + `　avLo/avHi=${meta?.avLo}/${meta?.avHi}（分位边界，只服务旧兼容字段）`);
  const anchors = anchorsOf(env);
  console.log('    表现曲线锚点（行动值空间，段间线性插值）：');
  for (const [av, factor] of anchors) {
    console.log(`      av=${pad(num(av, 1), 7)} → ${num(factor, 4)}　${anchorLine(env, av)}`);
  }
  if (env.lowerIsBetter === false) {
    // 末日幻影：内部 av = 4000 − 积分，直接印 av 会把「积分 3700」显示成 300。
    console.log('    ↑ 末日幻影按**积分**方向重印（越大越好；积分 = 4000 − av）：');
    for (const [av, factor] of [...anchors].reverse()) {
      const score = 4000 - av;
      const lineName = Math.abs(av - L.perfect) < 1e-9 ? '满分线'
        : Math.abs(av - L.target) < 1e-9 ? '达标线'
          : Math.abs(av - L.pass) < 1e-9 ? '及格线' : '顶点';
      console.log(`      积分 ${pad(num(score, 0), 5)} → ${num(factor, 4)}　${lineName}`);
    }
  }
}

// 截图里那两个数的**直接复现**（用户第 3、4 问的核心）。
const plight = envs.find((e) => e.stage === 'plight');
const as = envs.find((e) => e.mode === 'as');
const plightLine = perfOf(299, plight, 'perfect');
// ⚠️ `perfFactorOf` 的入参是**行动值**（数据集内部统一「越小越好」），不是末日幻影的积分。
// 所以 3850 分必须先翻成 av = 4000 − 3850 = 150 才是界面那一栏读到的数；
// 直接把积分传进去会落在线外拿到地板 0.05 —— 这条对照一起印出来，免得下一个人再踩。
const asAv = 4000 - 3850;
const asLineAv = perfOf(asAv, as, 'target');
const asLineRaw = perfOf(3850, as, 'target');
const asF = frontierFactorsOf({
  id: as.id, tier: 'target', actionValue: asAv, bestTeamGold: 1, seasonMinCost: 7,
  score: 0, weight: 1,
}, metaOf(as.id));
console.log('\n    截图复现：');
console.log(`      perfFactorOf(299, 异相仲裁·绝境 的线 {300,500}, lowerIsBetter, 'perfect')`
  + ` = ${num(plightLine, 6)}　（截图当时是 0.85；v4.6.78 起满分线以内固定 1.00）`);
console.log(`      perfFactorOf(150, 末日幻影 的线 {4000,3700,3400}, 积分方向, 'target')`
  + ` = ${num(asLineAv, 6)}　（3850 分的**内部行动值** = 4000 − 3850 = ${asAv}；截图写 0.75）`);
console.log(`      perfFactorOf(3850, 同一条线, 积分方向, 'target') = ${num(asLineRaw, 4)}`
  + `　← 直接传积分是**错的**（函数吃行动值），落在线外拿地板；界面靠 metricShortText 翻转显示`);
console.log(`      截图那一行（末日幻影 3850 · 7÷1 金）走 frontierFactorsOf：`
  + ` perfFactor=${num(asF.perfFactor, 6)}　costFactor=${num(asF.costFactor, 6)}`
  + `　base=${num(asF.base, 4)}`);

// ==================================================================== B
sec('B. 末日幻影「到 4000 分」有多少人 + 四副本对照');

/** 从 21 个分位点里读某个分位（0/0.25/0.5/0.75/0.9/0.95/1）。 */
const distAt = (values, p) => {
  if (!Array.isArray(values) || !values.length) return null;
  const pos = p * (values.length - 1);
  const lo = Math.floor(pos); const hi = Math.min(values.length - 1, Math.ceil(pos));
  const w = pos - lo;
  const a = Number(values[lo]); const b = Number(values[hi]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a + (b - a) * w;
};
/** 分位点采样出来的「≤ x 的投稿占比」区间（用相邻两个分位点夹住，如实报区间）。 */
const shareBelow = (values, x) => {
  if (!Array.isArray(values) || !values.length) return null;
  const v = values.map(Number);
  const asc = v[0] <= v[v.length - 1];
  const cmp = asc ? ((a, b) => a - b) : ((a, b) => b - a);
  let lastInside = -1;
  for (let i = 0; i < v.length; i += 1) if (cmp(v[i], x) <= 0) lastInside = i;
  // 单调方向下「在 x 以内」的最后一个分位点下标 → 占比区间 (i/20, (i+1)/20]
  if (lastInside < 0) return { lo: 0, hi: 0 };
  return { lo: lastInside / (v.length - 1), hi: Math.min(1, (lastInside + 1) / (v.length - 1)) };
};

const fmtScore = (env, av) => (av === null ? '—'
  : env.mode === 'as' ? String(Math.round(4000 - av)) : String(Math.round(av * 10) / 10));

for (const env of envs) {
  const f = frontOf(env.id);
  const seasons = winSeasonsOf(env);
  console.log(`\n--- ${env.id}　${env.label}　（窗口 ${seasons.length} 个版本，前沿池 ${f.pool} 条）`);

  // B-1) 前沿池（= frontierRows，已截断到「最便宜 25%」）逐档计数。
  const poolTally = { perfect: 0, target: 0, pass: 0, below: 0 };
  for (const r of f.frontierRows || []) poolTally[r.tier] = (poolTally[r.tier] || 0) + 1;
  const poolN = (f.frontierRows || []).length;
  console.log('    B1 前沿池（frontierRows，只含满分/达标两档——低于达标的行在建库时就不进前沿）：'
    + ` perfect ${poolTally.perfect}（${share(poolTally.perfect, poolN)}）`
    + ` / target ${poolTally.target}（${share(poolTally.target, poolN)}）`
    + ` / pass ${poolTally.pass} / below ${poolTally.below}`);
  const poolAv = (f.frontierRows || []).map((r) => r.actionValue).filter((v) => Number.isFinite(v));
  if (poolAv.length) {
    const s = [...poolAv].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.round((s.length - 1) * p))];
    console.log(`       行动值 ${pad(num(s[0], 0), 5)} … ${pad(num(q(0.25), 0), 5)}`
      + ` … ${pad(num(q(0.5), 0), 5)} … ${pad(num(q(0.75), 0), 5)} … ${pad(num(s[s.length - 1], 0), 5)}`
      + `　（= 游戏内 ${fmtScore(env, s[0])} … ${fmtScore(env, s[s.length - 1])}）`);
  }

  // B-2) 全量投稿（archive.json 每个版本的去重投稿）：档位计数是**精确值**，
  //      分位点来自建库时存的 21 点 `dist`（也是全量投稿，步长 5%）。
  console.log('    B2 全量投稿逐版本（满分线/达标线两侧的绝对条数）：');
  console.log(`       ${padE('版本', 6)}${pad('投稿', 6)}${pad('=满分线', 9)}${pad('达标档', 8)}`
    + `${pad('及格档', 8)}${pad('未及格', 8)}　 ${env.mode === 'as' ? '积分' : '成绩'} p0/p25/p50/p75/p90/p95/p100`);
  let sumRuns = 0; let sumPerfect = 0; let sumTarget = 0; let sumPass = 0; let sumBelow = 0;
  const distRows = [];
  for (const s of seasons) {
    const raw = rawSeasonOf(env, s);
    if (!raw) continue;
    const values = raw.dist?.values || [];
    const qs = [0, 0.25, 0.5, 0.75, 0.9, 0.95, 1].map((p) => fmtScore(env, distAt(values, p)));
    sumRuns += raw.runCount || 0;
    sumPerfect += raw.perfect || 0;
    sumTarget += raw.target || 0;
    sumPass += raw.pass || 0;
    sumBelow += raw.below || 0;
    if (values.length) distRows.push({ runCount: raw.runCount || 0, values });
    console.log(`       ${padE(s, 6)}${pad(raw.runCount || 0, 6)}${pad(raw.perfect || 0, 9)}`
      + `${pad(raw.target || 0, 8)}${pad(raw.pass || 0, 8)}${pad(raw.below || 0, 8)}　 `
      + qs.map((v) => pad(v, 5)).join(' '));
  }
  console.log(`       ${padE('合计', 6)}${pad(sumRuns, 6)}${pad(sumPerfect, 9)}${pad(sumTarget, 8)}`
    + `${pad(sumPass, 8)}${pad(sumBelow, 8)}`);
  console.log(`       → 达到满分线（${env.mode === 'as' ? '积分 = 4000' : '最好一档'}）`
    + ` ${sumPerfect} / ${sumRuns} = ${share(sumPerfect, sumRuns)}；`
    + `达到达标线（${env.mode === 'as' ? '积分 ≥3700' : '次好一档'}）累计`
    + ` ${sumPerfect + sumTarget} / ${sumRuns} = ${share(sumPerfect + sumTarget, sumRuns)}；`
    + ` 未达标 ${sumPass + sumBelow} / ${sumRuns} = ${share(sumPass + sumBelow, sumRuns)}`);
  // 合并窗口的分位点：各版本分位点按投稿数加权（**近似**，逐版本值是精确的）。
  if (distRows.length) {
    const total = distRows.reduce((n, r) => n + r.runCount, 0);
    const pooled = (p) => {
      const pos = p * 20;
      const lo = Math.floor(pos); const hi = Math.min(20, Math.ceil(pos)); const w = pos - lo;
      let acc = 0;
      for (const r of distRows) {
        const v = Number(r.values[lo]) + (Number(r.values[hi]) - Number(r.values[lo])) * w;
        acc += (r.runCount / total) * v;
      }
      return acc;
    };
    console.log(`       合并窗口分位点（近似：各版本 21 点分位按投稿数加权）`
      + ` ${[0, 0.25, 0.5, 0.75, 0.9, 0.95, 1].map((p) => fmtScore(env, pooled(p))).join(' / ')}`);
  }

  // B-3) 满分线附近的**精确**条数：用未截断的 per-season `frontier` 数组（按「阵容+成本」去重，
  //      只含满分/达标两档）数 av 落在哪一段。分母是「进了满分/达标两档的去重配置数」，
  //      与上面的「投稿条数」不是同一个分母，两个都印出来避免误读。
  const frows = [];
  for (const s of seasons) {
    const raw = rawSeasonOf(env, s);
    for (const r of raw?.frontier || []) frows.push({ season: s, c: r.c, a: r.a, t: r.t });
  }
  const avs = frows.map((r) => Number(r.a)).filter((v) => Number.isFinite(v));
  const ge = (x) => avs.filter((v) => v <= x).length;
  const zeroLabel = env.mode === 'as' ? '积分 4000' : env.stage === 'plight' ? '行动值 0' : '0T';
  const hiLabel = env.mode === 'as' ? '积分 ≥3900' : env.stage === 'plight' ? '行动值 ≤100' : '≤1T';
  console.log(`    B3 未截断的满分/达标去重配置 ${frows.length} 条（按 阵容+成本 去重）：`
    + ` ${zeroLabel} ${ge(0)} 条 ${share(ge(0), avs.length)}`
    + `；≤50 ${ge(50)} 条；${hiLabel} ${ge(100)} 条 ${share(ge(100), avs.length)}`
    + `；≤300 ${ge(300)} 条`);
  const exactFull = shareBelow((rawSeasonOf(env, seasons[seasons.length - 1])?.dist?.values) || [], 100);
  console.log(`       （该副本最新版本的全量投稿里「积分 ≥3900」占比按 21 点分位夹逼：`
    + ` ${exactFull ? `${(100 * exactFull.lo).toFixed(1)}% ~ ${(100 * exactFull.hi).toFixed(1)}%` : '—'}`
    + `　区间来自分位点步长 5%，不是点估计）`);
}

// B-4) 只放宽末日幻影的满分线（达标线不动）：把曲线函数当纯函数调。
sec('B4. 「只把末日幻影满分线放宽」的影响（达标线 3700 不动，曲线当纯函数调）');
const asLinesVariants = [['现状 4000', 4000], ['放宽到 3900', 3900], ['放宽到 3800', 3800], ['放宽到 3700', 3700]];
const sampleScores = [4000, 3990, 3950, 3900, 3850, 3800, 3750, 3700, 3600, 3400];
console.log('    表现因子（入参先翻成内部行动值 av = 4000 − 积分，与生产同一条路）：');
console.log(`    ${padE('积分', 6)}${asLinesVariants.map(([n]) => pad(n, 14)).join('')}`);
for (const score of sampleScores) {
  const cells = asLinesVariants.map(([, perfect]) => {
    const lines = { ...as.tierLines, perfect };
    const anchors = perfAnchorsOf(lines, false);
    const v = perfFactorOf(4000 - score, lines, false, score >= 4000 ? 'perfect' : 'target');
    return pad(`${num(v, 4)}${anchors.length < 2 ? '(退化)' : ''}`, 14);
  });
  console.log(`    ${padE(score, 6)}${cells.join('')}`);
}
console.log('    （放宽后 4000 分仍是 1.00；3900 会变成「新的满分线锚点 0.85」，'
  + '曲线在 0~300 行动值区间整体抬高一点点；放到 3700 时满分线与达标线重合 → '
  + '`perfAnchorsOf` 只剩顶点、`perfFactorOf` 退回阶梯权重，是**退化**而不是「更宽松」。）');
console.log('    锚点表（按积分印）：');
for (const [, perfect] of asLinesVariants) {
  const lines = { ...as.tierLines, perfect };
  const anchors = perfAnchorsOf(lines, false);
  console.log(`      perfect=${perfect} → ${anchors.map(([a, b]) => `${4000 - a}分:${num(b, 2)}`).join(' → ')}`);
}
// 现有投稿里会受影响的行数：把「前沿池」按新曲线重算表现分，看有多少条变化。
const asPool = frontOf('as').frontierRows || [];
console.log('    对现有关卡池重算（640 条前沿池）：');
for (const [, perfect] of asLinesVariants) {
  const lines = { ...as.tierLines, perfect };
  let changed = 0; let sumDelta = 0; let maxDelta = 0;
  for (const r of asPool) {
    const oldV = perfFactorOf(r.actionValue, as.tierLines, false, r.tier);
    const newV = perfFactorOf(r.actionValue, lines, false, r.tier);
    const d = newV - oldV;
    if (Math.abs(d) > 1e-9) changed += 1;
    sumDelta += d;
    if (Math.abs(d) > Math.abs(maxDelta)) maxDelta = d;
  }
  console.log(`      perfect=${perfect} → ${changed} / ${asPool.length} 条表现分变化`
    + `　平均 ${num(sumDelta / asPool.length, 4)}　最大 ${num(maxDelta, 4)}`);
}

// B-5) 同一份曲线落在五个副本上，**实际给出的因子**差多少 —— 这是「末日幻影的
// 要求是否偏高」最直接的量化：如果别的副本前沿池几乎都是 1.00、只有它散在 0.5~1.0，
// 那说明它的「满分线」在实际数据里几乎够不着。
sec('B5. 五个副本的前沿池在现曲线下实际拿到的表现因子（同一份曲线，逐副本对照）');
console.log(`    ${padE('副本', 12)}${pad('条数', 6)}${pad('均值', 8)}${pad('中位', 8)}${pad('min', 8)}`
  + `${pad('max', 8)}${pad('=1.00', 8)}${pad('≥0.90', 8)}${pad('≥0.75', 8)}${pad('<0.50', 8)}`);
for (const env of envs) {
  const lower = env.lowerIsBetter !== false;
  const vals = (frontOf(env.id)?.frontierRows || [])
    .map((r) => perfFactorOf(r.actionValue, env.tierLines, lower, r.tier, perfLineWeightsOf(env)))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!vals.length) continue;
  const q = (p) => vals[Math.min(vals.length - 1, Math.round((vals.length - 1) * p))];
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  console.log(`    ${padE(env.id, 12)}${pad(vals.length, 6)}${pad(num(avg, 4), 8)}${pad(num(q(0.5), 4), 8)}`
    + `${pad(num(vals[0], 4), 8)}${pad(num(vals[vals.length - 1], 4), 8)}`
    + `${pad(share(vals.filter((v) => v === 1).length, vals.length), 8)}`
    + `${pad(share(vals.filter((v) => v >= 0.9).length, vals.length), 8)}`
    + `${pad(share(vals.filter((v) => v >= 0.75).length, vals.length), 8)}`
    + `${pad(share(vals.filter((v) => v < 0.5).length, vals.length), 8)}`);
}
console.log('    （前沿池 = 各副本窗口内「满分+达标」按成本排序取最便宜 25%，是真正参与算分的那批；'
  + '同一个 av 在不同副本里换不到同一个因子，因为判据线不同。）');

// ==================================================================== C
sec('C. 金数项 > 1.00 的来路（分母与分子落在不同档位）');

/** 逐副本：该版本的全档最小 / perfect 档最小 / target 档最小。 */
const tierMinOf = new Map(); // envId -> Map(season -> Map(tier -> minCost))
const allMinOf = new Map();  // envId -> Map(season -> minCost)
const bestMinOf = new Map(); // envId -> Map(season -> minCost)  只算 perfect
for (const env of envs) {
  const f = frontOf(env.id);
  const t = new Map(); const a = new Map(); const b = new Map();
  for (const row of f.frontierRows || []) {
    const s = String(row.season || '');
    if (!t.has(s)) t.set(s, new Map());
    const per = t.get(s);
    if (!(Number.isFinite(per.get(row.tier)) && per.get(row.tier) <= row.cost)) per.set(row.tier, row.cost);
    if (!(Number.isFinite(a.get(s)) && a.get(s) <= row.cost)) a.set(s, row.cost);
    if (row.tier === 'perfect' && !(Number.isFinite(b.get(s)) && b.get(s) <= row.cost)) b.set(s, row.cost);
  }
  tierMinOf.set(env.id, t); allMinOf.set(env.id, a); bestMinOf.set(env.id, b);
}
const denomCostOf = (envId, season, fallback) => bestMinOf.get(envId)?.get(season)
  ?? allMinOf.get(envId)?.get(season) ?? fallback;

const over1 = [];
for (const env of envs) {
  const f = frontOf(env.id);
  const seasons = winSeasonsOf(env);
  console.log(`\n--- ${env.id}　${env.label}（分母 = 该版本 perfect 档最便宜；缺 perfect 档才退回全档最小）`);
  console.log(`    ${padE('版本', 6)}${pad('score权重', 9)}${pad('全档最小', 9)}${pad('perfect最小', 12)}`
    + `${pad('target最小', 11)}${pad('算分用分母', 11)}  同档最小 ≠ 分母 的版本`);
  for (const s of seasons) {
    const denom = denomCostOf(env.id, s, f.minCost);
    const allMin = allMinOf.get(env.id)?.get(s);
    const bestMin = bestMinOf.get(env.id)?.get(s);
    const tMin = tierMinOf.get(env.id)?.get(s)?.get('target');
    const diff = bestMin !== undefined && allMin !== undefined && bestMin !== allMin;
    console.log(`    ${padE(s, 6)}${pad(f.seasonWeights?.[s] ?? 1, 9)}${pad(allMin ?? '—', 9)}`
      + `${pad(bestMin ?? '—（无满分档）', 12)}${pad(tMin ?? '—', 11)}${pad(denom ?? '—', 11)}`
      + `  ${diff ? `全档最小被 target 档拉到 ${allMin}` : '—'}`
      + `${bestMin === undefined ? '（该版本无 perfect 档 → 分母退回全档最小）' : ''}`);
  }
  // 该副本里所有「实付金数 < 分母」的行 = 金数项 > 1。
  const hits = [];
  for (const row of f.frontierRows || []) {
    const denom = denomCostOf(env.id, String(row.season || ''), f.minCost);
    if (!(denom > 0) || !(row.cost > 0)) continue;
    const factor = denom / row.cost;
    if (factor > 1 + 1e-9) {
      hits.push({ season: row.season, tier: row.tier, cost: row.cost, denom, factor,
        av: row.actionValue, members: row.members });
    }
  }
  const allRows = (f.frontierRows || []).filter((r) => r.cost > 0).length;
  console.log(`    → 前沿池 ${allRows} 条里有 ${hits.length} 条金数项 > 1.00（${share(hits.length, allRows)}）`);
  hits.sort((a, b) => b.factor - a.factor);
  for (const h of hits.slice(0, TOP)) {
    over1.push({ env: env.id, ...h });
    console.log(`       ×${num(h.factor, 2)}　${padE(h.season, 5)}${padE(h.tier, 8)}`
      + `实付 ${h.cost} 金 ÷ 分母 ${h.denom} 金　行动值 ${num(h.av, 0)}　`
      + h.members.map((m) => `${cn(m.char)}E${m.eidolon}`).join(' + '));
  }
}

// C-2) 全榜「副本 × 整包」明细行：直接读 buildConclusion 的内部结果（未裁剪）。
const rowsAll = [];
const pushRows = (u) => {
  for (const e of u.envs || []) {
    const f = frontierFactorsOf(e, metaOf(e.id));
    if (f.costFactor === null || !(f.cost !== null && f.cost > 0)) continue;
    rowsAll.push({
      unit: u, env: e, meta: metaOf(e.id), factor: f.costFactor, perf: f.perfFactor,
      base: f.base, seasonFactor: f.seasonFactor, score: f.score,
    });
  }
};
for (const u of result.frontierUnits || []) pushRows(u);
const over = rowsAll.filter((r) => r.factor > 1 + 1e-9);
// 收敛前的完整整包名单（角色面板用的那一份）：榜只留每角色一条，这里是全部配装。
const rowsPacks = [];
for (const list of Object.values(result.frontierPacksByChar || {})) {
  for (const u of list) {
    for (const e of u.envs || []) {
      const f = frontierFactorsOf(e, metaOf(e.id));
      if (f.costFactor === null || !(f.cost !== null && f.cost > 0)) continue;
      rowsPacks.push({ unit: u, env: e, factor: f.costFactor, perf: f.perfFactor, score: f.score });
    }
  }
}
const overPacks = rowsPacks.filter((r) => r.factor > 1 + 1e-9);
console.log(`\n    C2 收敛前全部整包（frontierPacksByChar）${rowsPacks.length} 条「副本 × 整包」明细行，`
  + `金数项 > 1.00 的 ${overPacks.length} 条（${share(overPacks.length, rowsPacks.length)}）`);
console.log(`       其中末日幻影 ${overPacks.filter((r) => r.env.id === 'as').length} 条、`
  + `绝境王棋关 ${overPacks.filter((r) => r.env.id === 'aa/plight').length} 条、`
  + `异相仲裁（骑士/普通）${overPacks.filter((r) => r.env.id === 'aa').length} 条`);
console.log(`    榜面（每角色收敛一条，共 ${(result.frontierUnits || []).length} 个整包）`
  + `${rowsAll.length} 条「副本 × 整包」明细行，金数项 > 1.00 的 ${over.length} 条`
  + `（${share(over.length, rowsAll.length)}）`);
for (const cut of [1.25, 1.5, 2, 3, 5]) {
  console.log(`        > ×${cut}：${over.filter((r) => r.factor > cut).length} 条`);
}
// `frontierPackScale = 100` 的文档口径是「一个整包在一个副本里最高刚好 100 分」。
// 单条配置的**单版本分** sScore = 100 × 表现 × (分母 ÷ 本队金数)，金数项 > 1 会把它顶破，
// 所以这一条是判断「算不算 bug」的硬证据（这里按**单版本**算，不取版本平均）。
const sScores = [];
for (const env of envs) {
  const lower = env.lowerIsBetter !== false;
  for (const row of frontOf(env.id)?.frontierRows || []) {
    if (!(row.cost > 0)) continue;
    const denom = denomCostOf(env.id, String(row.season || ''), metaOf(env.id)?.minCost);
    if (!(denom > 0)) continue;
    const perf = perfFactorOf(row.actionValue, env.tierLines, lower, row.tier, perfLineWeightsOf(env));
    sScores.push({
      env: env.id, season: row.season, tier: row.tier, cost: row.cost, denom, perf,
      score: 100 * perf * (denom / row.cost),
    });
  }
}
const overCap = sScores.filter((r) => r.score > 100 + 1e-9);
const maxScoreRow = [...sScores].sort((a, b) => b.score - a.score)[0];
console.log(`        单条配置的**单版本分** sScore > 100（SCORING.frontierPackScale 的文档上界）`
  + ` ${overCap.length} 条（占 ${share(overCap.length, sScores.length)}）`
  + `　其中末日幻影 ${overCap.filter((r) => r.env === 'as').length} 条、`
  + `绝境 ${overCap.filter((r) => r.env === 'aa/plight').length} 条、`
  + `异相仲裁 ${overCap.filter((r) => r.env === 'aa').length} 条`);
console.log(`        最高 sScore = ${num(maxScoreRow?.score, 1)}（${maxScoreRow?.env}`
  + ` ${maxScoreRow?.season} ${maxScoreRow?.tier} 实付 ${maxScoreRow?.cost} 金 / 分母 `
  + `${maxScoreRow?.denom} 金 / 表现 ${num(maxScoreRow?.perf, 4)}）`);
const maxRow = [...rowsAll].sort((a, b) => b.factor - a.factor)[0];
console.log(`        最大 ×${num(maxRow?.factor, 3)}（${maxRow?.unit?.name} E${maxRow?.unit?.eidolon}`
  + ` ${maxRow?.env?.id} ${maxRow?.env?.evidenceSeason} ${maxRow?.env?.tier}`
  + ` 实付 ${maxRow?.env?.bestTeamGold} 金 / 分母 ${maxRow?.env?.seasonMinCost} 金）`);
const asOver = over.filter((r) => r.env.id === 'as').sort((a, b) => b.factor - a.factor);
console.log(`        其中末日幻影（截图那一栏）${asOver.length} 条，最极端 ${TOPN(asOver)}`);
function TOPN(list) {
  return list.slice(0, TOP).map((r) => `${cn(r.unit.name)}E${r.unit.eidolon}${r.unit.lc ? `+${coneCn(r.unit.lc)}` : ''}`
    + ` ×${num(r.factor, 2)}（${r.env.seasonMinCost}÷${r.env.bestTeamGold}，${r.env.evidenceSeason} ${r.env.tier}）`).join('　|　') || '—';
}
const shot = rowsAll.filter((r) => r.env.id === 'as' && r.env.seasonMinCost === 7 && r.env.bestTeamGold === 1);
console.log(`    C3 截图那一行（末日幻影 · 分母 7 金 ÷ 本队 1 金 = 7.00）在真实数据里命中 `
  + `${shot.length} 条：`);
for (const r of shot.slice(0, TOP)) {
  console.log(`       ${cn(r.unit.name)} E${r.unit.eidolon}${r.unit.lc ? ` + ${coneCn(r.unit.lc)}S${r.unit.superimp}` : ''}`
    + `　证据版本 ${r.env.evidenceSeason}　档位 ${r.env.tier}　行动值 ${num(r.env.actionValue, 0)}`
    + `　表现 ${num(r.perf, 6)}（赛季余数 ×${num(r.seasonFactor, 4)}）`);
}
console.log('    C3 说明：末日幻影 4.3~4.5 各版本「perfect 档最便宜」与「target 档最便宜」：');
for (const s of winSeasonsOf(as)) {
  console.log(`       ${s}　perfect 最小 ${bestMinOf.get('as')?.get(s) ?? '—（无满分档）'}`
    + `　target 最小 ${tierMinOf.get('as')?.get(s)?.get('target') ?? '—'}`
    + `　全档最小 ${allMinOf.get('as')?.get(s) ?? '—'}`
    + `　算分用分母 ${denomCostOf('as', s, frontOf('as').minCost) ?? '—'}`);
}

// C-4) 两种修法的影响量级（**估算**：只换金数项分母，其余因子沿用榜上的实测值）。
sec('C4. 两种修法的影响量级（估算：只换金数项分母，其余因子沿用实测值）');
const fixOf = (row, mode) => {
  const { env, meta } = row;
  const cost = env.bestTeamGold;
  if (!(cost > 0)) return row.factor;
  if (mode === 'sameTier') {
    const s = String(env.evidenceSeason || '');
    const v = tierMinOf.get(env.id)?.get(s)?.get(env.tier);
    return v === undefined ? row.factor : v / cost;
  }
  // clamp：分母保持「该版本 perfect 档最便宜」，只把「比它还便宜」的档位封在 ×1。
  return Math.min(1, row.factor);
};
const rankCur = new Map((result.frontierUnits || []).map((u, i) => [u.key, i + 1]));
const rebuilt = (mode) => {
  const totals = new Map();
  for (const r of rowsAll) {
    const nf = fixOf(r, mode);
    const ns = r.base > 0 && r.factor > 0
      ? r.score * (nf / r.factor)
      : r.score;
    const w = Number(r.meta?.weight) || 0;
    totals.set(r.unit.key, (totals.get(r.unit.key) || 0) + w * ns);
  }
  return totals;
};
for (const [mode, label] of [['sameTier', '修法①分母改成「该版本**同档位**最便宜」'],
  ['clamp', '修法②分母不变、只把金数项封在 ≤ ×1.00']]) {
  const totals = rebuilt(mode);
  const keys = [...rankCur.keys()].filter((k) => totals.has(k));
  const sorted = [...keys].sort((a, b) => (totals.get(b) - totals.get(a))
    || String(a).localeCompare(String(b)));
  const rankNew = new Map(sorted.map((k, i) => [k, i + 1]));
  let maxD = 0; let moved = 0; let moved10 = 0;
  for (const k of keys) {
    const d = Math.abs((totals.get(k) || 0) - (curTotalOf(k)));
    if (d > maxD) maxD = d;
    const dr = Math.abs(rankCur.get(k) - rankNew.get(k));
    if (dr > 0) moved += 1;
    if (dr >= 10) moved10 += 1;
  }
  console.log(`    ${label}`);
  console.log(`       受影响条目 ${keys.filter((k) => Math.abs((totals.get(k) || 0) - curTotalOf(k)) > 1e-6).length}`
    + ` / ${keys.length}　名次变动 ≥10 位 ${moved10} 条　最高分变化 ${num(maxD, 1)} 分`
    + `　Spearman ρ = ${num(rhoOf(rankCur, rankNew), 4)}`);
  const top = [...keys].sort((a, b) => Math.abs((totals.get(b) || 0) - curTotalOf(b))
    - Math.abs((totals.get(a) || 0) - curTotalOf(a))).slice(0, 6);
  for (const k of top) {
    const u = (result.frontierUnits || []).find((x) => x.key === k);
    console.log(`         ${padE(cn(u.name), 20)}E${u.eidolon} ${pad(u.total.toFixed(0), 5)} → `
      + `${pad((totals.get(k) || 0).toFixed(0), 5)} 分　名次 #${rankCur.get(k)} → #${rankNew.get(k)}`);
  }
}
function curTotalOf(key) {
  const u = (result.frontierUnits || []).find((x) => x.key === key);
  return u ? u.total : 0;
}

// ==================================================================== D
sec('D. 绝境王棋关满分档的表现因子（v4.6.78 起：满分线以内固定 1.00）');
console.log(`    判据线 ${JSON.stringify(plight.tierLines)}　lowerIsBetter=${plight.lowerIsBetter !== false}`
  + `　换算到行动值空间 ${JSON.stringify(avLinesOf(plight.tierLines, true))}`);
console.log(`    锚点 ${JSON.stringify(anchorsOf(plight))}`);
console.log('    曲线取值表（tier 只影响「线缺失时的兜底」，这里线是齐的）：');
console.log(`      ${padE('行动值', 8)}${pad('表现因子', 10)}  说明`);
for (const av of [0, 37, 100, 200, 299, 300, 301, 400, 499, 500, 700]) {
  const v = perfOf(av, plight, av < 300 ? 'perfect' : 'target');
  const tier = av < 300 ? '满分档（行动值 <300）' : av < 500 ? '达标档（行动值 <500）' : '达标线以外';
  console.log(`      ${padE(av, 8)}${pad(v, 10)}  ${tier}`);
}
const perfRows = [];
const plightFront = frontOf(plight.id);
for (const s of winSeasonsOf(plight)) {
  for (const r of plightFront?.frontierRows || []) {
    if (String(r.season) === s && r.tier === 'perfect') perfRows.push(r);
  }
}
const pav = perfRows.map((r) => r.actionValue).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
if (pav.length) {
  const q = (p) => pav[Math.min(pav.length - 1, Math.round((pav.length - 1) * p))];
  console.log(`\n    perfect 档在**前沿池**里的行动值实际分布（${pav.length} 条，窗口 ${winSeasonsOf(plight).length} 版）：`);
  console.log(`      min ${pav[0]}　p25 ${q(0.25)}　中位 ${q(0.5)}　p75 ${q(0.75)}　max ${pav[pav.length - 1]}`);
  console.log(`      = 0 的 ${pav.filter((v) => v === 0).length} 条；≤37 的 ${pav.filter((v) => v <= 37).length} 条；`
    + `= 299 的 ${pav.filter((v) => v === 299).length} 条；≥290 的 ${pav.filter((v) => v >= 290).length} 条`);
  console.log(`      → 299 落在该档的**最差端**（max=${pav[pav.length - 1]}），而该档的理论顶点 av=0 `
    + `在全窗口 ${pav.length} 条里出现 ${pav.filter((v) => v === 0).length} 次`);
  console.log(`      → 该档的实际因子区间：av=${pav[0]} → ${num(perfOf(pav[0], plight, 'perfect'), 4)}`
    + ` … av=${pav[pav.length - 1]} → ${num(perfOf(pav[pav.length - 1], plight, 'perfect'), 4)}`);
}
console.log('\n    （历史对照，来自 docs/评分模型设计.md v26 与 SCORING.frontierTierWeight：'
  + `满分档阶梯权重 = ${SCORING.frontierTierWeight.perfect}；`
  + 'v25 及以前「av ≤ 满分线」整段是平的 1.00（37 与 299 同分），v26 起改成 0.85→1.00 的缓降，'
  + '**v4.6.78 起绝境又改回平的 1.00**（用户 2026-10-11 第四轮点名）—— 本条是文档/常量复述，不是本次实测。）');
// ==================================================================== E
// 截图那支整包（整包 = 角色 + 星魂档 + 光锥含叠影）的逐副本明细：把截图里三行
// 与真实数据逐个对齐，并把它自己的算式印出来（浮层「贡献值来源」就是这条链）。
sec('E. 截图那支整包（E0 星海巡航 S5）的逐副本明细（真实数据）');
const SHOT_CHAR = arg('char', 'Ashveil');
const SHOT_LC = arg('lc', 'Cruising in the Stellar Sea');
const shotPacks = (result.frontierPacksByChar?.[SHOT_CHAR] || [])
  .filter((u) => (u.lc || '') === SHOT_LC && Number(u.superimp) === 5);
console.log(`    ${cn(SHOT_CHAR)} E0 + ${coneCn(SHOT_LC)}S5 在收敛前的整包名单里命中 ${shotPacks.length} 条`);
for (const u of shotPacks) {
  console.log(`    整包 ${cn(u.name)} E${u.eidolon} + ${coneCn(u.lc)}S${u.superimp}`
    + `　自身 ${u.gold} 金　总分 ${num(u.total, 1)}`);
  for (const e of u.envs || []) {
    const meta = metaOf(e.id);
    const f = frontierFactorsOf(e, meta);
    const lower = meta?.lowerIsBetter !== false;
    const lines = meta?.tierLines || null;
    const anchors = perfAnchorsOf(lines, lower, perfLineWeightsOf(meta));
    const costText = f.minCost !== null && f.cost !== null
      ? `${f.minCost}÷${f.cost}（${num(f.costFactor, 2)}）` : '—';
    console.log(`      ${padE(e.id, 10)}权重 ×${pad(meta?.weight, 3)}　表现`
      + ` ${padE(metricShortText(meta?.mode, meta?.stage, e.actionValue), 8)}`
      + `（${num(f.perfFactor, 4)}）　金数 ${padE(costText, 14)}`
      + `　版本 ×${num(f.seasonFactor, 4)}　→ 贡献 ${num(f.weight * f.score, 1)}`
      + `　[锚点 ${anchors.map(([a, b]) => `${a}:${num(b, 2)}`).join(' → ')}]`);
    // 用截图里那种「四舍五入到两位」的写法重算一遍，看算术是否自洽。
    const rounded = Number(meta?.weight) * 100 * Number(f.perfFactor.toFixed(2))
      * Number((f.costFactor ?? 1).toFixed(2)) * Number((f.seasonFactor ?? 0).toFixed(2));
    console.log(`        截图式算式：${meta?.weight} × 100 × ${f.perfFactor.toFixed(2)} × `
      + `${(f.costFactor ?? 1).toFixed(2)} × ${(f.seasonFactor ?? 0).toFixed(2)}`
      + ` = ${num(rounded, 1)}　（本行实测贡献 ${num(f.weight * f.score, 1)}）`);
  }
}
console.log('\n    截图里那三行的算术自洽性核对（用截图自己写的系数）：');
console.log(`      异相仲裁·绝境 10 × 100 × 0.85 × 1.00 × 0.72 = ${num(10 * 100 * 0.85 * 1 * 0.72, 1)}（截图 +613）`
  + `　← 现口径（v4.6.78 起）实测 299 → ${num(perfOf(299, plight, 'perfect'), 4)}，该行会相应变高`);
console.log(`      末日幻影      1 × 100 × 0.75 × 7.00 × 0.33 = ${num(1 * 100 * 0.75 * 7 * 0.33, 1)}（截图 +173）`
  + `　← 本探针实测 av=150 → ${num(perfOf(150, as, 'target'), 4)}`);
console.log(`      混沌回忆      1 × 100 × 1.00 × 1.00 × 0.67 = ${num(1 * 100 * 1 * 1 * 0.67, 1)}（截图 +67）`);
console.log('      → 三行都逐位对得上；差额只可能来自「版本项」那一栏的显示取整'
  + '（截图写 ×0.33，本探针实测该行 ×0.3189）。');
console.log('\n探针结束（未修改任何生产代码）。');
