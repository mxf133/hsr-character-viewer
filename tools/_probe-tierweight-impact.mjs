// 探针（一次性）：如果把档位权重从算分里去掉，**榜面到底会怎么变**。
//
// 配套 `tools/_probe-target-only.mjs`（那个回答「哪些队伍只能达标」）。这个补上
// 「改掉之后影响多大」：档位权重是 `perfect ×1 / target ×0.5`，所以拿掉之后
// **只有达标档那部分贡献翻倍**，满分部分不动。
//
//   新分 = 满分部分 + 达标部分 × 2
//        = 现总分 + 达标部分
//
// 所以要回答的是：每条整包的分数里，有多少来自达标档证据。
//
// ⚠️ 这里是**按贡献拆**的预测（不是重跑一遍评分链）：达标行的 `env.value` 恰好
// 等于「去掉档位权重后那一行应有的值」（它就是被 ×0.5 的那一行），所以
// `新总分 = Σ(满分行的 value) + Σ(达标行的 value) × 2`。真正改完代码后用
// `node tools/_probe-rank.mjs` 核对 —— 两边应当逐条相等。
//
// 用法：
//   node tools/_probe-tierweight-impact.mjs --rows=20
import { archiveIndex, archiveFrontierAll, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
import { buildConclusion, VERSION_WINDOW } from '../src/core/advice.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TOP = Math.max(1, Number(arg('rows', 20)) || 20);

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const cn = (n) => zhName(i18n, 'characters', n) || n;
const coneCn = (n) => (n ? (zhName(i18n, 'lightCones', n) || n) : '—');

const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const result = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  frontierWeights: Object.fromEntries(frontierAll.map((f) => [f.env, f.weight])),
});

const units = result.frontierUnits || [];
const metaOf = (id) => (result.frontierEnvs || []).find((m) => m.id === id);
const label = (u) => `${cn(u.name)} E${u.eidolon}${u.lc ? ` + ${coneCn(u.lc)}S${u.superimp}` : ''}`;

// 逐条整包拆「满分部分 / 达标部分」，并算出改口径后的新总分与新名次。
const calc = units.map((u) => {
  let perfect = 0;
  let target = 0;
  for (const e of u.envs || []) {
    const v = Number(e.value) || 0;
    if (e.tier === 'perfect') perfect += v; else target += v;
  }
  const now = perfect + target;
  const next = perfect + target * 2;
  return { u, perfect, target, now, next, share: now > 0 ? target / now : 0 };
});
// 现状名次（按现分）与新名次（按新分）—— 都按同一套排序规则（总分降序）。
const rankNow = new Map([...calc]
  .sort((a, b) => b.now - a.now).map((c, i) => [c.u, i + 1]));
const rankNext = new Map([...calc]
  .sort((a, b) => b.next - a.next).map((c, i) => [c.u, i + 1]));

const moved = calc.filter((c) => rankNow.get(c.u) !== rankNext.get(c.u));
const untouched = calc.filter((c) => c.target === 0);
const allTarget = calc.filter((c) => c.perfect === 0 && c.target > 0);

console.log(`=== 总榜共 ${units.length} 条`);
console.log(`    分数完全不变的（证据里没有达标档）：${untouched.length} 条`);
console.log(`    分数会变的（至少有达标档证据）：${calc.length - untouched.length} 条`);
console.log(`    名次会变的：${moved.length} 条　｜　其中**整条证据都是达标档**（分数直接 ×2）：${allTarget.length} 条`);

const share = calc.filter((c) => c.now > 0);
const avg = share.reduce((n, c) => n + c.share, 0) / (share.length || 1);
const median = [...share].sort((a, b) => a.share - b.share)[Math.floor(share.length / 2)];
console.log(`    达标档贡献占比：平均 ${(avg * 100).toFixed(1)}%　中位 ${((median?.share || 0) * 100).toFixed(1)}%`
  + `　最高 ${((Math.max(...share.map((c) => c.share)) || 0) * 100).toFixed(1)}%`);

console.log(`\n=== 逐条明细（按现名次排序，前 ${TOP} 条）`);
console.log('    现名次 新名次 整包现分整包新分  达标贡献占比  逐副本档位');
for (const c of calc.slice(0, TOP)) {
  const tiers = (c.u.envs || []).map((e) => (e.tier === 'perfect' ? '满' : '达')).join('');
  const delta = rankNext.get(c.u) - rankNow.get(c.u);
  const arrow = delta === 0 ? ' =' : delta > 0 ? `↓${delta}` : `↑${-delta}`;
  console.log(`    ${String(rankNow.get(c.u)).padStart(4)}${String(rankNext.get(c.u)).padStart(6)}`
    + `${arrow.padStart(6)} ${label(c.u).padEnd(30)}`
    + `${String(Math.round(c.now)).padStart(6)}${String(Math.round(c.next)).padStart(7)}`
    + `   ${(c.share * 100).toFixed(1).padStart(5)}%${' '.repeat(2)}${tiers}`);
}

console.log('\n=== 名次变动最大的 12 条（按位移排序）');
const byMove = [...calc].sort((a, b) => {
  const da = rankNext.get(a.u) - rankNow.get(a.u);
  const db = rankNext.get(b.u) - rankNow.get(b.u);
  return Math.abs(db) - Math.abs(da);
});
for (const c of byMove.slice(0, 12)) {
  const delta = rankNext.get(c.u) - rankNow.get(c.u);
  const arrow = delta === 0 ? '不变' : delta > 0 ? `↓ ${delta}` : `↑ ${-delta}`;
  console.log(`    ${String(rankNow.get(c.u)).padStart(3)} → ${String(rankNext.get(c.u)).padStart(3)}`
    + `  ${arrow.padStart(6)}  ${label(c.u).padEnd(30)}`
    + `${String(Math.round(c.now)).padStart(6)} → ${String(Math.round(c.next)).padStart(6)}`
    + `   达标占 ${(c.share * 100).toFixed(1)}%`);
}

console.log('\n=== 现有榜首 / 前几名在改口径后的位置');
for (const c of calc.slice(0, 5)) {
  console.log(`    ${label(c.u).padEnd(34)} ${String(rankNow.get(c.u)).padStart(3)} → ${String(rankNext.get(c.u)).padStart(3)}`
    + `   ${Math.round(c.now)} → ${Math.round(c.next)}`);
}