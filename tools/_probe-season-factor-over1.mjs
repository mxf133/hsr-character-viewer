// 探针：扫**真载荷**（界面看到的那一份），找出「跨版本发挥 > 1」的整包，并给出诊断线索。
//
// 口径上这一栏是**余数**：`versionFactor = score ÷ (100 × 表现 × 金数项)`，而 score 是
// 各版本的加权平均、分母里还夹着「算 0 分」的版本 ⇒ 它**恒 ≤ 1**（advice.js 与
// `docs/评分模型设计.md` v29 都这么写）。所以 > 1 一定是某处的**口径不对齐**。
//
//   node tools/_probe-season-factor-over1.mjs [--url=http://127.0.0.1:8371] [--limit=20]
import { frontierFactorsOf } from '../public/scripts/advice.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const BASE = arg('url', 'http://127.0.0.1:8371');
const LIMIT = Math.max(1, Number(arg('limit', '20')) || 20);
// 界面的「隐金设置」默认是**五项全勾**（见 advice-view.js 的 state.hiddenCosts），
// 而接口默认是一项都不减 —— 所以要复现界面看到的数，必须显式带上它。
const HIDDEN = arg('hidden', 'false') !== 'false';
const HIDDEN_ALL = {
  gift: true, giftCone: true, exchange: true, exchangeCone: true, standard: true,
};

const res = await fetch(`${BASE}/api/archive/conclusion`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    account: { owned: [], eidolons: {}, cones: {} },
    window: 6,
    frontierWeights: { 'aa|plight': 10, 'aa|': 1, 'as|': 1, 'moc|': 1, 'pf|': 1 },
    ...(HIDDEN ? { hiddenCosts: HIDDEN_ALL } : {}),
  }),
  signal: AbortSignal.timeout(240000),
});
const payload = await res.json();
const metaOf = (id) => (payload.frontierEnvs || []).find((m) => m.id === id) || null;

const rows = [];
let total = 0;
const scan = (unit, where) => {
  for (const env of unit.envs || []) {
    const meta = metaOf(env.id);
    const f = frontierFactorsOf(env, meta);
    total += 1;
    rows.push({ unit, env, meta, f, where });
  }
};
for (const unit of payload.frontierUnits || []) scan(unit, '全部');
// ⚠️ 逐档榜（E0/E1/E2/E6）是**另一批对象**（`frontierTiers`，每档各自按角色收敛一条），
// 界面切到那些页签时看的是它们 —— 只扫总榜会漏掉一整套。
for (const [tier, list] of Object.entries(payload.frontierTiers || {})) {
  for (const unit of list || []) scan(unit, `E${tier}`);
}
const over = rows.filter((r) => Number(r.f.seasonFactor) > 1 + 1e-9)
  .sort((a, b) => b.f.seasonFactor - a.f.seasonFactor);

console.log(`载荷 payload=${payload.payload}｜总榜 ${(payload.frontierUnits || []).length} 条`
  + `｜逐档榜 ${Object.values(payload.frontierTiers || {}).reduce((n, l) => n + (l || []).length, 0)} 条`
  + `｜（整包 × 副本）明细 ${total} 行`);
console.log(`跨版本发挥 > 1 的：**${over.length} 行**`
  + `（占 ${(over.length / Math.max(1, total) * 100).toFixed(1)}%）`
  + `｜= 1 的 ${rows.filter((r) => Math.abs(r.f.seasonFactor - 1) < 1e-9).length} 行`
  + `｜< 1 的 ${rows.filter((r) => r.f.seasonFactor < 1 - 1e-9).length} 行`);
// ⚠️ 前几名的**超出量**必须单独打出来：`value` 在载荷里被 `toFixed(4)` 过，
// score = value ÷ weight 因此最多带 ~8e-6 的相对误差 —— 那足以让「本来正好等于 1」
// 的行变成 1.0000x，看起来像违反了不变量，实际是**载荷取整**。
console.log(`最大 ${over.length ? over[0].f.seasonFactor.toFixed(10) : '—'}`
  + `（超出 ${over.length ? (over[0].f.seasonFactor - 1).toExponential(2) : '—'}）`
  + `｜超过 1.0001 的：${over.filter((r) => r.f.seasonFactor > 1.0001).length} 行\n`);

const fmt = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—');
for (const r of over.slice(0, LIMIT)) {
  const { unit, env, meta, f } = r;
  console.log(`● [${r.where}] ${unit.name} E${unit.eidolon}${unit.lc ? ` + ${unit.lc} S${unit.superimp}` : ''}`
    + ` ｜${env.envLabel || env.id}`);
  console.log(`   跨版本发挥 ×${f.seasonFactor.toFixed(10)} = score ${f.score} ÷ base ${f.base}`);
  console.log(`   base 的因子：表现 ${fmt(f.perfFactor, 4)}｜金数项 ${f.costFactor === null ? '—' : fmt(f.costFactor, 4)}`
    + `（${fmt(f.minCost, 0)}/${fmt(f.cost, 0)}）｜scale ${fmt(f.packScale, 0)}`);
  console.log(`   载荷字段：tier ${env.tier}｜行动值 ${env.actionValue}｜bestTeamGold ${env.bestTeamGold}`
    + `｜seasonMinCost ${env.seasonMinCost}｜证据版本 ${env.evidenceSeason}`
    + `｜不参与 ${env.absentSeasons}｜无人使用 ${env.droppedSeasons}`);
  console.log(`   副本元数据：weight ${fmt(meta?.weight, 0)}｜minCost(全窗口) ${fmt(meta?.minCost, 0)}`
    + `｜窗口 ${JSON.stringify(meta?.seasons)}｜权重表 ${JSON.stringify(meta?.seasonWeights)}`);
  console.log(`   本条对总分的贡献 value ${fmt(env.value)}（副本权重 ${fmt(meta?.weight, 0)}`
    + ` ⇒ score = value ÷ weight = ${fmt((Number(env.value) || 0) / (Number(meta?.weight) || 1))}）`);
  console.log(`   ⚠️ 也就是说：**base 用的是「最佳证据那一版」的因子，而 score 是各版本的加权平均**；`
    + `base 比最佳证据那份分还小才会 > 1。`);
  console.log('');
}
