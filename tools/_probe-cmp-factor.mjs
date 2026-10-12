// 探针：把「为什么某个整包排名靠后」拆成**逐因子对比**（同一个副本里与榜上前列整包对齐）。
//
// 用途：用户问「为什么 XX 表现相对较差」时，答案不能靠印象 —— 要把每个因子
// （档位 / 行动值 / 金数 / 版本）并排列出来，指出是哪一项拖了后腿、拖了多少。
//
// 它**只读**：`frontierFactorsOf` 与 `buildConclusion` 都是生产那一份，不另算口径。
//
// 用法：
//   node tools/_probe-cmp-factor.mjs --find=遐蝶 --vs=真珠 --vs=千冶 --vs=砂金
import { archiveIndex, archiveFrontierAll, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
import { buildConclusion, frontierFactorsOf, VERSION_WINDOW } from '../public/scripts/advice.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TARGET = arg('find', '遐蝶');
const VERSUS = process.argv.flatMap((a) => (a.startsWith('--vs=') ? [a.slice(5)] : []));

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

const label = (u) => `${cn(u.name)} E${u.eidolon}+${coneCn(u.lc)}S${u.superimp}`;
const pick = (frag) => result.frontierUnits.find((u) => cn(u.name).includes(frag));

const target = pick(TARGET);
if (!target) { console.log(`榜上找不到「${TARGET}」`); process.exit(1); }
const rivals = VERSUS.map(pick).filter(Boolean);
if (!rivals.length) { console.log('没给可比的对照（--vs=）'); process.exit(1); }

console.log(`目标：${label(target)}   总分 ${Math.round(target.total)}`
  + `   榜上共 ${result.frontierUnits.length} 条，排名第 ${
    result.frontierUnits.indexOf(target) + 1}`);
console.log(`对照：${rivals.map((u) => `${label(u)} ${Math.round(u.total)}（#${
  result.frontierUnits.indexOf(u) + 1}）`).join('  |  ')}\n`);

const metaOf = (id) => result.frontierEnvs?.find((m) => m.id === id);
const rowsOf = (u) => u.envs || [];

// ①逐副本：贡献 = 权重 × 分，并列出每个因子
const envIds = [...new Set([...rowsOf(target), ...rivals.flatMap(rowsOf)].map((e) => e.id))];
for (const id of envIds) {
  const meta = metaOf(id);
  const all = [target, ...rivals];
  const cells = all.map((u) => {
    const env = rowsOf(u).find((e) => e.id === id);
    if (!env) return null;
    const f = frontierFactorsOf(env, meta);
    return { u, env, f, contrib: Number(env.value) || 0 };
  }).filter(Boolean);
  if (!cells.length) continue;
  const best = Math.max(...cells.map((c) => c.contrib));
  console.log(`=== ${meta?.envLabel || id}   副本权重 ${meta?.weight}`
    + `   该副本最便宜金数 ${meta?.minCost}`);
  console.log('    整包                队伍金数档位   行动值项   金数项版本项     实测分   贡献');
  for (const c of cells) {
    const mark = c.contrib === best ? ' ←最高' : '';
    console.log(`    ${label(c.u).padEnd(18)}`
      + `${String(c.env.bestTeamGold ?? '—').padStart(6)}金`
      + `${(c.env.tier === 'perfect' ? '满分' : '达标').padStart(4)}`
      + `  ${(c.f.avFactor ?? 1).toFixed(3).padStart(7)}`
      + `${(c.f.costFactor ?? 1).toFixed(3).padStart(8)}`
      + `${(c.f.seasonFactor ?? 1).toFixed(3).padStart(7)}`
      + `${c.f.score.toFixed(2).padStart(9)}`
      + `${c.contrib.toFixed(0).padStart(8)}${mark}`);
  }
  // 差距归因：把目标与该副本最高分者的差拆成「谁贡献了这块差距」
  const t = cells.find((c) => c.u === target);
  const b = cells.find((c) => c.contrib === best);
  if (t && b && t !== b) {
    const d = b.contrib - t.contrib;
    const parts = [];
    for (const [name, key] of [['档位', 'tierFactor'], ['行动值', 'avFactor'],
      ['金数', 'costFactor'], ['版本', 'seasonFactor']]) {
      const bt = b.f[key] ?? 1;
      const tt = t.f[key] ?? 1;
      parts.push(`${name} ${(tt / bt).toFixed(2)}`);
    }
    console.log(`    差距 ${d.toFixed(0)}：目标/最高 的因子比 —— ${parts.join('  ')}`);
    console.log(`    （金数项 =该副本最便宜 ${meta?.minCost} 金 ÷ 各自队伍金数；`
      + `队伍越贵这项越低）\n`);
  } else {
    console.log('');
  }
}

// ② 汇总：三个副本各自贡献了多少，以及「缺席的副本」
console.log('=== 汇总');
const sum = (u) => rowsOf(u).reduce((n, e) => n + (Number(e.value) || 0), 0);
console.log(`    ${label(target).padEnd(18)} 合计 ${Math.round(sum(target))}`
  + `   出现在 ${rowsOf(target).length}/${envIds.length} 个副本：`
  + `${rowsOf(target).map((e) => metaOf(e.id)?.envLabel || e.id).join(' / ')}`);
for (const u of rivals) {
  console.log(`    ${label(u).padEnd(18)} 合计 ${Math.round(sum(u))}`
    + `   出现在 ${rowsOf(u).length}/${envIds.length} 个副本：`
    + `${rowsOf(u).map((e) => metaOf(e.id)?.envLabel || e.id).join(' / ')}`);
}
