// 探针：核对「强度得分 = 100」的成因（用户 2026-10-14 报的那张卡）。
//
//   node tools/_probe-strength-100.mjs --scan                     # 遍历账号库，找那张卡
//   node tools/_probe-strength-100.mjs --account=3 --rows=12      # 单账号：池内刻度 + 前排
//
// 目的（回答「为什么这支队的强度得分是 100，不应该还有成本更高的队伍吗」）：
//   1. 强度得分是**候选池内的 min-max**，池内第一必然正好 100 分；
//   2. 底层那个 `total` 含**金数项**（`min(1, 该版本最便宜金数 ÷ 本队金数)`），
//      所以成本更高的队伍 `total` 反而更低 —— 需要拿真实数字证明。
// 这里把池内前排一起印出来，方便对账。
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, eidolonTierOf, eidolonsOf, lightConeRanksOf, normalizeDrawWeights,
  ownedCharacters, teamPlan, teamPoolUnits, VERSION_WINDOW,
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
const has = (name) => process.argv.includes(`--${name}`);
const ROWS = Math.max(1, Number(arg('rows', '12')) || 12);
const SCAN = has('scan');
const ONLY = arg('account', null);
const draw = normalizeDrawWeights({
  strength: arg('strength', undefined),
  cost: arg('cost', undefined),
  versatility: arg('versatility', undefined),
});

const index = await archiveIndex();
const i18n = await loadI18n();
const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const zhToEn = {}; const allNames = [];
for (const c of index.refs?.characters || []) {
  if (c.nameCn && c.name) zhToEn[c.nameCn] = c.name;
  if (c.nameCn) allNames.push(c.nameCn);
}
const coneZhToEn = {};
for (const c of index.refs?.lightCones || []) if (c.nameCn && c.name) coneZhToEn[c.nameCn] = c.name;
const availability = index.refs?.availability || {};
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const cn = (n) => zhName(i18n, 'characters', n) || zhName(i18n, 'lightCones', n) || n;

/** 用户截图里那张卡的四位成员（顺序无关）。 */
const TARGET = new Set(['姬子•启行', '千冶•刃', '缇宝', '瓦尔特']);
const isTarget = (row) => {
  const names = row.members.map((m) => cn(m.char));
  return names.length === TARGET.size && names.every((n) => TARGET.has(n));
};

const analyse = async (account, role) => {
  const snapshot = await store.getSnapshot(account.id, role.uid);
  const acct = {
    owned: ownedCharacters(snapshot, zhToEn, allNames),
    eidolons: eidolonsOf(snapshot, zhToEn),
    cones: lightConeRanksOf(snapshot, coneZhToEn),
  };
  const conclusion = buildConclusion(envs, {
    availability,
    firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
    account: acct,
    frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  });
  const plan = teamPlan(conclusion, acct, { availability, drawWeights: draw });
  /**
   * 角色总榜上那个**新口径的绝对强度分**（2026-10-14 v4.6.101：围绕行动值 + 投入单调，
   * 0~100 绝对刻度）。抽卡方案现在**没有**用它 —— ① 读的是老口径 `unit.total`
   * （含金数项、池内 min-max）。这里把两个数并排印出来对账用。
   */
  const packKey = (name, eidolon, lc, superimp) => `${name}|E${eidolonTierOf(eidolon)}`
    + `|${lc || '-'}|S${Math.max(1, Math.round(Number(superimp) || 1))}`;
  const strengthOf = new Map();
  for (const unit of teamPoolUnits(conclusion)) {
    const key = packKey(unit.name, unit.eidolon, unit.lc, unit.superimp);
    strengthOf.set(key, Math.max(strengthOf.get(key) ?? 0, Number(unit.strengthScore) || 0));
  }
  for (const row of plan.rows) {
    row.absoluteStrength = Math.max(0, ...row.members.map((m) => strengthOf
      .get(packKey(m.char, m.eidolon, m.lc, m.superimp)) ?? 0));
  }
  /** 候选池里所有整包的**新口径绝对强度**分布 —— 判断「换成绝对刻度会不会太扁」。 */
  const dist = [...strengthOf.values()].sort((a, b) => a - b);
  const q = (p) => (dist.length ? dist[Math.min(dist.length - 1, Math.floor(dist.length * p))] : 0);
  const strengthDist = dist.length
    ? { n: dist.length, min: dist[0], p25: q(0.25), p50: q(0.5), p75: q(0.75), max: dist[dist.length - 1] }
    : null;
  return { conclusion, plan, acct, hit: plan.rows.findIndex(isTarget), strengthDist };
};

const fmtRow = (row, i) => `#${i + 1} 总分 ${row.total.toFixed(1)} = 强度 ${row.strengthPct.toFixed(1)}`
  + ` × ${draw.strength.toFixed(2)} + 差额 ${row.gapPct.toFixed(1)} × ${draw.cost.toFixed(2)}`
  + ` + 泛用 ${row.versatilityPct.toFixed(1)} × ${draw.versatility.toFixed(2)}`
  + `｜账面 ${row.gold} 金｜补金 ${row.gap} 金｜队分 ${row.teamScore.toFixed(1)}`
  + `｜新口径绝对强度 ${row.absoluteStrength.toFixed(2)}`
  + `｜证据 ${row.bestEnv?.label || '—'} ${row.bestEnv?.bestTeamGold ?? '—'} 金`
  + ` · ${row.bestEnv?.actionValue ?? '—'} 行动值`
  + `\n     队伍：${row.members.map((m) => `${cn(m.char)}[${m.owned ? '有' : '缺'}]E${m.eidolon}`).join(' / ')}`;

console.log(`账号库：${accounts.length} 个；抽卡权重 强度 ${draw.strength} / 性价比 ${draw.cost}`
  + ` / 泛用性 ${draw.versatility}`);

const picked = ONLY ? [accounts[Number(ONLY) - 1]].filter(Boolean) : accounts;
for (const account of picked) {
  for (const role of account.roles || []) {
    const label = `${account.nickname || account.id} · ${role.nickname} (${account.source || 'login'})`;
    const { conclusion, plan, acct, hit, strengthDist } = await analyse(account, role);
    console.log(`\n=== ${label}｜已有 ${acct.owned.size} 角色 / ${acct.cones.size} 光锥`);
    console.log(`候选池：总榜 ${conclusion.frontierUnits.length} 条 → 队伍 ${plan.poolAll} 支`
      + ` → 去掉补金 0 金后 ${plan.pool} 支；下发 ${plan.rows.length} 条`);
    console.log(`刻度：强度 = 绝对强度分（常量）${plan.strengthLo.toFixed(1)} ~ ${plan.strengthHi.toFixed(1)}`
      + `；差额封顶 ${plan.gapMax} 金；泛用性 = ${plan.versatilityLo} ~ ${plan.versatilityHi}`);
    if (strengthDist) {
      console.log(`新口径绝对强度分布（池内 ${strengthDist.n} 个整包）：`
        + `min ${strengthDist.min.toFixed(2)} / p25 ${strengthDist.p25.toFixed(2)}`
        + ` / p50 ${strengthDist.p50.toFixed(2)} / p75 ${strengthDist.p75.toFixed(2)}`
        + ` / max ${strengthDist.max.toFixed(2)}`);
    }
    const rows = SCAN ? plan.rows.slice(0, 1) : plan.rows.slice(0, ROWS);
    rows.forEach((row, i) => console.log(fmtRow(row, i)));
    console.log(hit >= 0
      ? `★ 截图那张卡 = #${hit + 1}（强度 ${plan.rows[hit].strengthPct.toFixed(1)}）`
      : '★ 截图那张卡不在下发批次里');
  }
}
