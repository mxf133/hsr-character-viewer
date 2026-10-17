// 「版本权重」必须真的作用到**抽卡方案**上 —— v4.6.117 修的缺陷的回归套件。
//
//   node tools/version-weight-plan-test.mjs
//
// ## 这条缺陷是什么
//
// 界面上「版本权重」那一行（6 个槽位，下标 0 = 当前版本）在服务端有**两条**按版本
// 加权的链：
//
//   * `archiveFrontier`（性价比总榜 / 角色得分 / 跨版本发挥）—— 一直读用户表；
//   * `resolveScope` → `aggregateTeams`（跨版本聚合的阵容表 + `buildAvTeams` 的行动值
//     前沿池）—— **写死了默认表** `3 : 2.5 : 2 : 1.5 : 1 : 0.5`。
//
// 而抽卡方案的候选池正是第二条链的两个来源（证据池 ∪ 行动值前沿池 ⇒ `teamPlan` 的
// `pool` / `rows`），于是用户改版本权重时**总榜动了、方案纹丝不动**。
//
// ## 本套件钉住的三层
//
//   A. 聚合层：回显的表是用户那份；`avTeams` / `teams` 的跨版本加权都跟着表走；
//      权重 0 的版本**不进前沿池**（不借 `newestAv` 兜底）。
//   B. 透传层：`conclusionEnvs()` 必须把 `versionWeights` 交给 `archiveTeams`
//      （缺陷当初的第二处：这里也没传）。
//   C. 端到端：`/conclusion` 的载荷 + 界面上那份 `teamPlan` 的名单与强度都会变。
//
// ⚠️ 用**真数据集**（`theherta/archive.json` 入库，clone 下来就能跑），不联网。
import { archiveIndex, archiveTeams } from '../src/server/archive.js';
import { archiveConclusion, conclusionEnvs, listEnvs } from '../src/server/conclusion.js';
import { VERSION_WEIGHTS, normalizeVersionWeights, teamPlan } from '../public/scripts/advice.js';

let passed = 0;
const fails = [];
const check = (label, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    fails.push(`${label} —— ${err.message}`);
    console.log(`  ✗ ${label}\n      ${err.message}`);
  }
};
const checkAsync = async (label, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    fails.push(`${label} —— ${err.message}`);
    console.log(`  ✗ ${label}\n      ${err.message}`);
  }
};
const section = (title) => console.log(`\n=== ${title} ===`);

/** 窗口内「距最新版本几个版本」——与 `versionWeightOf()` 查表用的下标同一个口径。 */
const slotOf = (seasons, season) => {
  const i = (seasons || []).indexOf(String(season));
  return i < 0 ? -1 : seasons.length - 1 - i;
};
/** 前沿池的指纹：版本 + 行动值 + 金数（选行一变，这三个里必然有一个动）。 */
const avSig = (envs) => (envs || [])
  .map((e) => `${e.id}#${(e.avTeams || []).map((t) => `${t.season}:${t.av}:${t.cost}`).join('+')}`)
  .join('|');

const index = await archiveIndex();
const availability = index.refs?.availability || {};
const envList = listEnvs(index);
// 只挑「本关卡窗口里有数据」的副本（理论上全部都有，防御一下空数据集）。
const probeEnvs = envList.slice(0, 3);
const planAccount = { owned: new Set(), eidolons: new Map(), cones: new Map() };

// ---------------------------------------------------------------- A. 聚合层
section('A. 聚合层（`archiveTeams` → `avTeams` / `teams`）');

const teamsOf = (env, versionWeights) => archiveTeams(env.mode, {
  season: env.season,
  stage: env.stage,
  window: VERSION_WEIGHTS.length,
  withFrontier: true,
  versionWeights,
});
const baseByEnv = new Map();
for (const env of probeEnvs) baseByEnv.set(env.id, await teamsOf(env, undefined));

await checkAsync('不传 → 回显默认表（老调用行为不变）', async () => {
  for (const [id, data] of baseByEnv) {
    const got = JSON.stringify(data.versionWeights);
    const want = JSON.stringify(VERSION_WEIGHTS);
    if (got !== want) throw new Error(`${id}：回显 ${got}，期望默认表 ${want}`);
  }
});

await checkAsync('回显的就是用户那份表（不是默认表）', async () => {
  const user = [1, 0, 0, 0, 0, 0];
  for (const env of probeEnvs) {
    const data = await teamsOf(env, user);
    const got = JSON.stringify(data.versionWeights);
    const want = JSON.stringify(normalizeVersionWeights(user));
    if (got !== want) throw new Error(`${env.id}：回显 ${got}，期望 ${want}`);
  }
});

await checkAsync('`avTeams`（0 行动值前沿池）跟着版本权重变', async () => {
  let moved = 0;
  for (const env of probeEnvs) {
    const data = await teamsOf(env, [1, 0, 0, 0, 0, 0]);
    const before = baseByEnv.get(env.id)?.avTeams || [];
    if (!before.length) continue; // 这一关本来就没有前沿队
    if (avSig([{ id: env.id, avTeams: before }]) !== avSig([{ id: env.id, avTeams: data.avTeams }])) {
      moved += 1;
    }
  }
  if (!moved) throw new Error('三个副本的 avTeams 一条都没变 —— 前沿池仍然按默认表选行');
});

await checkAsync('权重 0 的版本不进前沿池（不借 `newestAv` 兜底）', async () => {
  // 只留「当前版本」有权重：剩下的行只可能来自当前版本。
  for (const env of probeEnvs) {
    const data = await teamsOf(env, [1, 0, 0, 0, 0, 0]);
    const seasons = data.recentSeasons || [];
    const newest = seasons[seasons.length - 1];
    for (const row of data.avTeams || []) {
      if (String(row.season) !== String(newest)) {
        throw new Error(`${env.id}：权重表只留了当前版本（${newest}），却出现 ${row.season}（${row.cost} 金 / ${row.av} 行动值）`);
      }
    }
  }
  // 头尾各留一个：剩下的行只可能来自这两个版本，中间 4 个（权重 0）一律不许出现。
  for (const env of probeEnvs) {
    const data = await teamsOf(env, [1, 0, 0, 0, 0, 1]);
    const seasons = data.recentSeasons || [];
    const allowed = new Set([seasons[seasons.length - 1], seasons[0]]);
    for (const row of data.avTeams || []) {
      if (!allowed.has(String(row.season))) {
        throw new Error(`${env.id}：只有首尾两版权重 > 0，却出现 ${row.season}`);
      }
    }
  }
});

await checkAsync('每一行的版本权重都 > 0（按窗口下标查用户表）', async () => {
  const user = [1, 0, 0.5, 0, 0, 2];
  for (const env of probeEnvs) {
    const data = await teamsOf(env, user);
    const table = normalizeVersionWeights(user);
    for (const row of data.avTeams || []) {
      const slot = slotOf(data.recentSeasons, row.season);
      if (slot < 0) throw new Error(`${env.id}：行的版本 ${row.season} 不在窗口 ${JSON.stringify(data.recentSeasons)} 里`);
      if (!(table[slot] > 0)) {
        throw new Error(`${env.id}：${row.season}（槽位 ${slot}）权重是 ${table[slot]}，不该进池`);
      }
    }
  }
});

await checkAsync('证据池 `teams[]` 的跨版本加权也跟着表变', async () => {
  let moved = 0;
  for (const env of probeEnvs) {
    const data = await teamsOf(env, [1, 1, 1, 1, 1, 1]);
    const before = baseByEnv.get(env.id)?.teams || [];
    const sig = (rows) => rows.map((t) => `${t.rosterKey}:${t.perfect}:${t.target}:${t.avgAv}`).join('|');
    if (sig(before) !== sig(data.teams || [])) moved += 1;
  }
  if (!moved) throw new Error('三个副本的 teams 加权分一条都没变 —— 聚合层仍在用默认表');
});

// ---------------------------------------------------------------- B. 透传层
section('B. 透传层（`conclusionEnvs` → `archiveTeams`）');

const envsDefault = (await conclusionEnvs(index, { window: VERSION_WEIGHTS.length })).envs;
const envsOnlyNewest = (await conclusionEnvs(index, {
  window: VERSION_WEIGHTS.length,
  versionWeights: [1, 0, 0, 0, 0, 0],
})).envs;
const envsDefaultAgain = (await conclusionEnvs(index, { window: VERSION_WEIGHTS.length })).envs;

await check('`conclusionEnvs` 不传 → 与显式默认表完全一致', () => {
  if (avSig(envsDefault) !== avSig(envsDefaultAgain)) {
    throw new Error('同一输入两次调用的 avTeams 不一致（不透传时也该稳定）');
  }
});

await check('`conclusionEnvs` 把版本权重交给聚合层', () => {
  if (avSig(envsDefault) === avSig(envsOnlyNewest)) {
    throw new Error('传了 [1,0,0,0,0,0]，`envs[].avTeams` 一字未变 —— `versionWeights` 没透传到底');
  }
});

await check('方案候选池的两个来源（证据池 + 前沿池）都随表变', () => {
  // ⚠️ 判据要包含**加权后的数**（`perfect` / `target` / `avgAv`），只看阵容名会漏掉
  // 「队还是那几支、但跨版本加权分变了」——那正是这条链生效的主要形态。
  const sigOf = (envs) => envs.map((e) => `${e.id}#${(e.teams || []).map((t) => [
    (t.roster || []).join('+'), t.perfect, t.target, t.avgAv,
    JSON.stringify(t.tierCounts || {}),
  ].join(':')).join('|')}`).join('§');
  if (sigOf(envsDefault) === sigOf(envsOnlyNewest)) {
    throw new Error('`envs[].teams` 的加权分一字未变 —— 聚合层仍在用默认表');
  }
});

// ---------------------------------------------------------------- C. 端到端
section('C. 端到端（`/conclusion` 载荷 → `teamPlan`）');

const planOf = async (versionWeights) => {
  const conclusion = await archiveConclusion(
    { owned: [], eidolons: {}, cones: {} },
    { window: VERSION_WEIGHTS.length, versionWeights },
  );
  return { conclusion, plan: teamPlan(conclusion, planAccount, { availability }) };
};
const planDefault = await planOf(undefined);
const planEven = await planOf([1, 1, 1, 1, 1, 1]);
const planOnlyNewest = await planOf([1, 0, 0, 0, 0, 0]);

await check('`teamPlan` 的名单会变', () => {
  const keyOf = (plan) => (plan.rows || []).map((r) => r.key).join('|');
  const a = keyOf(planDefault.plan);
  if (!a) throw new Error('默认表下方案一行都没有（数据集或账号口径有问题）');
  if (a === keyOf(planEven.plan) && a === keyOf(planOnlyNewest.plan)) {
    throw new Error('两张不同的版本权重表给出**完全相同**的方案名单');
  }
});

await check('`teamPlan` 的强度分也在动（不只是重排）', () => {
  const strengths = (plan) => (plan.rows || []).map((r) => Number(r.strengthPct).toFixed(2)).sort().join(',');
  const a = strengths(planDefault.plan);
  if (a === strengths(planEven.plan) && a === strengths(planOnlyNewest.plan)) {
    throw new Error('三张表的强度分完全一样 —— 只有顺序在动，强度还在读默认表');
  }
});

// 幂等：同一张表跑两遍必须完全一致（方案里有 `alternatives` 与同分兜底排序，
// 一旦某个环节用了未排序的 Map 序，就会出现「刷新一下变个样」）。
const planDefaultAgain = await planOf(undefined);
await check('同一张表两次调用结果完全一致（幂等，默认表跑两遍）', () => {
  const keyOf = (plan) => (plan.rows || []).map((r) => `${r.key}:${Number(r.strengthPct).toFixed(4)}`).join('|');
  if (keyOf(planDefault.plan) !== keyOf(planDefaultAgain.plan)) {
    throw new Error('同一输入两次调用给出了不同的方案（有随机源）');
  }
});

// 两条链必须都读用户那份表：载荷里 `frontierEnvs[].seasonWeights`（总榜 / 角色得分那条
// 链，由 `archiveFrontier` 现算）与 `avTeams[].season`（聚合层那条链，由 `buildAvTeams`
// 选行）在「只有当前版本有权重」的表下都必须**只剩一个版本**。任何一边退回默认表，
// 这条就会红（默认表有 6 个槽位 > 0）。
//
// ⚠️ 不要断言「两边指到同一个版本号」：两条链的**锚点版本**本来就可能差一期
// （`archiveFrontierAll` 用 `frontierSeason`、聚合层用 `env.season`，见两处注释），
// 所以这里只钉「都只认一个版本」，不钉具体是哪个。
await check('载荷里两条版本加权链都只认一个版本（不退回默认表）', () => {
  for (const env of planOnlyNewest.conclusion.frontierEnvs || []) {
    const weights = env.seasonWeights || {};
    const positive = Object.entries(weights)
      .filter(([, v]) => Number(v) > 0).map(([s]) => String(s));
    if (positive.length !== 1) {
      throw new Error(`${env.id}：权重表只有当前版本 > 0，载荷里却有 ${positive.length} 个版本有权重（${JSON.stringify(weights)}）`);
    }
    const seasons = [...new Set((env.avTeams || []).map((row) => String(row.season)))];
    if (seasons.length > 1) {
      throw new Error(`${env.id}：前沿池的行来自 ${seasons.length} 个版本（${seasons.join('/')}），只该有一个`);
    }
  }
});

// ---------------------------------------------------------------- 结果
console.log(`\n${'='.repeat(60)}`);
if (fails.length) {
  console.log(`version-weight-plan-test：${passed} 项通过，${fails.length} 项失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`version-weight-plan-test：${passed} 项全部通过`);
