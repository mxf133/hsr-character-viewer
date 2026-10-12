// 探针：把「性价比总榜（整包口径）」在**真实数据**上打出来，用于肉眼核对与调参。
//
//   node tools/_probe-pack.mjs                      # 全部副本 + 副本权重
//   node tools/_probe-pack.mjs --rows 25
//   node tools/_probe-pack.mjs --find 银狼 --find 砂金
//   node tools/_probe-pack.mjs --mode aa --stage plight
//
// ⚠️ 它**直接消费 `buildConclusion().frontierUnits`**（与浏览器同一份输出），
// 不自己再算一套口径 —— 否则探针与实现会悄悄分叉，调参就没有意义了。
// 环境的选取（`conclusionEnvs`）与 `firstSeen` 同样复用生产那一份（v4.6.48 修：
// 这里以前各写一套，于是出现过「探针说砂金 #3、界面是 #14」）。
//
// 整包 = 角色 + 星魂目标档 + 光锥（含叠影）；分子与分母都只来自**队伍**：
//   score(整包, 副本) = 100 × 档位权重 × 行动值项 × (该副本最便宜金数 ÷ 该配置金数)
//   total(整包)       = Σ_副本 副本权重 × score
// 同一支队伍的成员必然同分 —— 那是口径本身的性质，不是 bug。
import { archiveIndex, archiveFrontierAll, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
import { buildConclusion, envWeightOf, VERSION_WINDOW } from '../public/scripts/advice.js';

const arg = (name, dflt) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return dflt;
};
/** `--find=银狼` 可重复：点名查某个角色的整包。 */
const FINDS = process.argv.flatMap((a) => (a.startsWith('--find=') ? [a.slice(7)] : []));
const ROWS = Number(arg('rows', '18'));
const ONLY_MODE = arg('mode', null);
const ONLY_STAGE = arg('stage', null);
// 前沿的版本窗口固定 `VERSION_WINDOW`（7）—— 生产 `archiveConclusion` 也是这么传的。
const WINDOW = Number(arg('window', String(VERSION_WINDOW)));

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const cnChar = (n) => zhName(i18n, 'characters', n) || n;
const cnCone = (n) => (n ? zhName(i18n, 'lightCones', n) || n : '—');
const TIER_CN = { perfect: '满分', target: '达标' };

// ⚠️ 环境（版本选取 + 阵容表）**直接复用生产那一份**（`conclusionEnvs`，见
// `src/server/conclusion.js`）。这里曾经手写「最新可靠赛季」的选取 —— 少了
// `listEnvs` 的完整性回退、也不传 `firstSeen`，于是探针与 GUI 变成两套口径。
const { envs: allEnvs } = await conclusionEnvs(index);
const envs = allEnvs.filter((env) => (!ONLY_MODE || env.mode === ONLY_MODE)
  && (ONLY_STAGE === null || env.stage === ONLY_STAGE));

// ⚠️ 必须按 **conclusion.js 的同一条通路**取前沿：`archiveFrontierAll` 才会做
// 「达标/满分档 + 该副本最便宜 25%」的裁剪，并给出总榜口径的副本权重。
// 少了它，实现会退回 `env.frontierRows`（未裁剪的全量前沿），榜面完全不同 ——
// 这个坑实测踩过一次（探针的头部与生产不一致）。
const frontierAll = await archiveFrontierAll(envs, { window: WINDOW });
const result = buildConclusion(envs, {
  availability,
  // 登场版本（用户第 6 条）：生产**一定**会传。探针以前不传，走的是「最早证据版本」
  // 的回退分支 —— 要复现「界面到底怎么算的」就必须带上。
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  frontierWeights: Object.fromEntries(frontierAll.map((f) => [f.env, f.weight])),
});

const packLabel = (u) => `${cnChar(u.name)} E${u.eidolon}`
  + ` · ${u.lc ? `${cnCone(u.lc)}S${u.superimp}` : '无光锥'}`;

console.log('副本权重（总榜口径）：'
  + envs.map((e) => `${e.id}=${envWeightOf(e.mode, e.stage, 'frontier')}`).join('  '));
console.log(`\n=== 性价比总榜（整包口径，共 ${result.frontierUnits.length} 条）===`);
console.log('（同分 = 同一支队伍的成员，口径使然；`=` 表示与上一行同分）');
let prev = null;
const ties = new Map();
for (const u of result.frontierUnits) {
  const key = Math.round(u.total);
  ties.set(key, (ties.get(key) ?? 0) + 1);
}
result.frontierUnits.slice(0, ROWS).forEach((u, i) => {
  const shown = Math.round(u.total);
  const mark = prev !== null && prev === shown ? '=' : ' ';
  prev = shown;
  const tied = ties.get(shown) ?? 1;
  console.log(`  #${String(i + 1).padStart(3)}${mark}${String(shown).padStart(6)}`
    + `  整包${String(u.gold).padStart(2)}金  ${packLabel(u).padEnd(34)}`
    + `最佳 ${u.envs[0]?.envLabel ?? '—'} ${TIER_CN[u.bestTier] ?? '—'} `
    + `${u.bestTeamGold ?? '—'}金 av=${u.bestActionValue ?? '—'} ${u.envs[0]?.evidenceSeason ?? '—'}`
    + `${tied > 1 ? `  (同分 ${tied} 条)` : ''}`);
});

if (FINDS.length) {
  for (const frag of FINDS) {
    console.log(`\n=== 「${frag}」的整包（按总分降序）===`);
    const hits = result.frontierUnits.filter((u) => cnChar(u.name).includes(frag))
      .sort((a, b) => b.total - a.total || a.gold - b.gold);
    if (!hits.length) { console.log('  （没有）'); continue; }
    for (const u of hits.slice(0, 12)) {
      const e = u.envs[0] || {};
      console.log(`  ${String(Math.round(u.total)).padStart(6)}  整包${String(u.gold).padStart(2)}金`
        + `  ${packLabel(u).padEnd(34)}`
        + `最佳 ${e.envLabel} ${TIER_CN[u.bestTier]} ${u.bestTeamGold}金 av=${u.bestActionValue} ${e.evidenceSeason}`);
      console.log(`          └ 队伍：${(e.members || [])
        .map((m) => `${cnChar(m.char)}E${m.eidolon}`).join(' + ')}`);
    }
  }
}

console.log('\n构成：', JSON.stringify(result.counts));
