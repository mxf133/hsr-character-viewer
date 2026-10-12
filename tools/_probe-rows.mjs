// 探针：某角色在某个副本前沿里的**全部投稿明细**（不限星魂档 / 光锥 / 叠影）。
//
// 回答「为什么 XX 排名靠后」时最朴素的一问：它在那个副本的压金前沿里到底出现过没有、
// 出现过的那几条分别是什么配置。前沿只取「达标/满分档 + 最便宜 25%」，强角如果
// 队友太贵或成绩不够极端，根本进不了这一小撮 —— 那它就不可能给总榜贡献分数。
//
// 用法：node tools/_probe-rows.mjs --find=遐蝶 --env=moc
import { archiveIndex, archiveFrontierAll, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
import { buildConclusion, VERSION_WINDOW } from '../public/scripts/advice.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const FIND = arg('find', '遐蝶');
const ONLY_ENV = arg('env', null);

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

const board = result.frontierUnits.find((u) => cn(u.name).includes(FIND));
if (!board) { console.log(`榜上找不到「${FIND}」`); process.exit(1); }
const key = board.name;
console.log(`=== ${cn(key)}（内部键 ${key}）  榜上 ${result.frontierUnits.length} 条里`
  + ` 有一条=${Math.round(board.total)}分  覆盖 ${board.envs.length} 个副本\n`);

const list = ONLY_ENV ? frontierAll.filter((f) => f.env === ONLY_ENV) : frontierAll;
for (const f of list) {
  const meta = result.frontierEnvs?.find((m) => m.id === f.env);
  const rows = f.frontierRows || [];
  const withChar = rows.filter((r) => r.members.some((m) => m.char === key));
  const onBoard = (board.envs || []).some((e) => e.id === f.env);
  console.log(`--- ${meta?.envLabel || f.env}   权重 ${meta?.weight}`
    + `   前沿 ${rows.length} 条   含该角色 ${withChar.length} 条`
    + `${onBoard ? '   ✓ 已进总榜这一节' : '   ✗ 没进总榜'}`);
  // ⚠️ 必须用 `r.cost`（不是 `r.c`）：`frontierRows` 里金数字段就叫 `cost`，
  // `r.c` 是建库侧原始字段、不在裁剪后的行上 —— 取它会得到一堆undefined，
  // 让 `Math.min` 变成 NaN，整行打印成 `NaN~NaN 金`。
  const costs = rows.map((r) => Number(r.cost)).filter(Number.isFinite);
  const charCosts = withChar.map((r) => Number(r.cost)).filter(Number.isFinite);
  console.log(`    前沿金数区间 ${costs.length ? `${Math.min(...costs)}~${Math.max(...costs)}` : '—'} 金`
    + `   该角色在前沿里的金数 ${charCosts.length
      ? `${Math.min(...charCosts)}~${Math.max(...charCosts)}` : '—'} 金`);
  for (const r of withChar.sort((a, b) => a.c - b.c || a.actionValue - b.actionValue)) {
    const mine = r.members.find((m) => m.char === key);
    console.log(`      ${r.season}  ${r.tier === 'perfect' ? '满分' : '达标'}`
      + `  av=${String(r.actionValue).padStart(4)}  ${String(r.cost).padStart(2)}金  `
      + `${cn(mine.char)}E${mine.eidolon}`
      + `${mine.lc ? `+${coneCn(mine.lc)}S${mine.superimp}` : '+（无光锥）'}`
      + `   队伍 ${r.members.map((m) => `${cn(m.char)}E${m.eidolon}`).join('+')}`);
  }
  console.log('');
}
