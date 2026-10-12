// 探针：直接调**生产实现** `teamPlan()`（不再是探针里手抄一份口径），核对结果。
//
//   node tools/_probe-team-plan.mjs --account=1 --rows=12
//   node tools/_probe-team-plan.mjs --account=1 --strength=1 --cost=3   # 抽卡权重（相对大小）
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, eidolonsOf, lightConeRanksOf, normalizeDrawWeights, ownedCharacters, teamPlan,
  unitPullsOf, VERSION_WINDOW,
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
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const conclusion = buildConclusion(envs, {
  availability,
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});
const cn = (n) => zhName(i18n, 'characters', n) || zhName(i18n, 'lightCones', n) || n;
const cnCone = (n) => zhName(i18n, 'lightCones', n) || n;

const plan = teamPlan(conclusion, acct, { availability, drawWeights: draw });
console.log(`账号 ${ACC}：${role.nickname} · 已有 ${acct.owned.size} 角色 / ${acct.cones.size} 光锥`);
console.log(`抽卡权重：强度 ${(draw.strength * 100).toFixed(0)}% / 性价比 ${(draw.cost * 100).toFixed(0)}%`);
console.log(`候选池：总榜 ${conclusion.frontierUnits.length} 条 → 队伍 ${plan.poolAll} 支`
  + ` → 去掉补金 0 金后 ${plan.pool} 支；下发 ${plan.rows.length} 条（截断=${plan.truncated}）`);
console.log(`归一化上下限（现算）：强度 ${plan.strengthLo.toFixed(1)} ~ ${plan.strengthHi.toFixed(1)}`
  + `；总榜分 ${plan.scoreLo.toFixed(1)} ~ ${plan.scoreHi.toFixed(1)}`
  + `；差额封顶 ${plan.gapMax} 金 / 账面封顶 ${plan.goldMax} 金（性价比里差额占 ${plan.costMix}）`);

const stepText = (it) => (it.kind === 'cone'
  ? (Number(it.from) >= 1 ? `S${it.from}→S${it.target}` : `未见→S${it.target}`)
  : (Number(it.from) < 0 || Number(it.target) === 0 ? '本体' : `E${it.from}→E${it.target}`));

plan.rows.slice(0, ROWS).forEach((row, i) => {
  console.log('');
  console.log(`#${i + 1} 补金推荐分 ${row.total.toFixed(1)} = 强度 ${row.strengthPct.toFixed(1)}`
    + ` × ${draw.strength.toFixed(2)} + 性价比 ${row.costPct.toFixed(1)} × ${draw.cost.toFixed(2)}`
    + `（差额 ${row.gapPct.toFixed(1)} / 压金 ${row.goldPct.toFixed(1)}）`
    + `｜账面 ${row.gold} 金｜补金 ${row.gap} 金（约 ${row.pullsExpected} 抽）`
    + `｜队分 ${row.teamScore.toFixed(1)} / 强度 ${row.strength.toFixed(1)}`);
  console.log(`    队伍：${row.members.map((m) => `${cn(m.char)}[${m.owned ? '有' : '缺'}]E${m.eidolon}`
    + `${m.lc ? `+${cnCone(m.lc)}S${m.superimp}` : ''}`).join(' / ')}`);
  console.log(`    证据：${row.bestEnv?.label || '—'} ${row.bestEnv?.bestTeamGold ?? '—'} 金`
    + ` · ${row.bestEnv?.actionValue ?? '—'} 行动值`);
  console.log(`    补金顺序：${row.fill.map((it) => `${cn(it.carrier || it.name)}·${stepText(it)}`
    + `（${it.pulls}金/${it.pullsExpected}抽）`).join(' → ')}`);
});

// ---- 不变量自查（与 herta-test 里那几条同一批口径）----------------------------
const fails = [];
const ok = (cond, label) => { if (!cond) fails.push(label); };
ok(plan.rows.every((r) => r.gap > 0), '每一条的补金差额都必须 > 0');
ok(plan.rows.every((r) => r.total >= 0 && r.total <= 100), '总分必须落在 0~100');
ok(plan.rows.every((r, i, a) => i === 0 || a[i - 1].total >= r.total - 1e-9), '总分必须降序');
ok(plan.rows.every((r) => r.fill.reduce((n, it) => n + it.pulls, 0) === r.gap),
  '补金顺序各笔之和 = 差额');
ok(plan.rows.every((r) => Math.abs(r.total
  - (draw.strength * r.strengthPct + draw.cost * r.costPct)) < 1e-4),
  '总分 = 强度得分 × 强度权重 + 性价比得分 × 性价比权重');
ok(plan.rows.every((r) => Math.abs(r.costPct
  - (plan.costMix * r.gapPct + (1 - plan.costMix) * r.goldPct)) < 1e-4),
  '性价比得分 = 差额接近度 与 压金度 按 teamPlanCostMix 合成');
ok(plan.rows.every((r) => r.strength >= r.teamScore - 1e-6),
  '纯强度应当 ≥ 总榜分（金数项封顶 ×1，只有 0 金那一档的 1.2 会让它反过来）');
ok(plan.rows.every((r) => r.fill.every((it) => it.pullsExpected === unitPullsOf(it.kind, it.pulls))),
  '每笔的期望抽数与 unitPullsOf 同源');
ok(plan.rows.every((r) => r.fill.every((it, i, a) => i === 0
  || a[i - 1].perPull >= it.perPull - 1e-9
  || (it.kind === 'cone' && it.carrier && a.slice(0, i).some((x) => x.name === it.carrier)))),
  '补金顺序按每抽收益降序（被载体约束插队的除外）');
// 载体约束：光锥前面必须已经有它的载体（角色本体/星魂）
ok(plan.rows.every((r) => r.fill.every((it, i) => it.kind !== 'cone' || !it.carrier
  || !r.fill.slice(0, i).some((x) => x.name === it.carrier && Number(x.from) < 0)
  || acct.owned.has(it.carrier))), '光锥不会排在它自己尚未拥有的载体之前');
console.log(`\n不变量自查：${fails.length ? `✗ ${fails.length} 条不过 —— ${fails.join('；')}` : '✓ 全部通过'}`);
