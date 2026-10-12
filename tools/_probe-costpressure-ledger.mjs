// 手工探针（`_` 前缀，不进测试套件）：**逐版本账本**——某支队伍的分到底来自哪些版本。
//
//   node tools/_probe-costpressure-ledger.mjs --account=1
//
// 复刻 `buildConclusionInner` 的整包逐版本口径（同一批原语：`perfFactorOf` /
// `frontierCostTermOf` / 各版本 perfect 档最便宜金数作分母 / 2:2:2:1:1:1:1 版本权重），
// 并把复算出来的版本加权平均与生产总榜同一条目的 `envs[].score` 对齐。
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, eidolonTierOf, frontierCostTermOf, normalizeDrawWeights, ownedCharacters,
  eidolonsOf, lightConeRanksOf, perfFactorOf, perfLineWeightsOf, packStrengthOf, teamPlan,
  VERSION_WINDOW, versionWeightOf,
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
const ACC = Math.max(1, Number(arg('account', '1')) || 1);
const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const cn = (n) => zhName(i18n, 'characters', n) || zhName(i18n, 'lightCones', n) || n;
const cnCone = (n) => (n ? zhName(i18n, 'lightCones', n) || n : null);
const zhToEn = {};
for (const c of index.refs?.characters || []) if (c.nameCn && c.name) zhToEn[c.nameCn] = c.name;
const coneZhToEn = {};
for (const c of index.refs?.lightCones || []) if (c.nameCn && c.name) coneZhToEn[c.nameCn] = c.name;

const store = new AccountStore();
await store.load();
const accounts = await store.listAccounts();
const account = accounts[ACC - 1];
const role = (account?.roles || [])[0];
const snapshot = await store.getSnapshot(account.id, role.uid);
const allNames = (index.refs?.characters || []).map((c) => c.nameCn).filter(Boolean);
const acct = {
  owned: ownedCharacters(snapshot, zhToEn, allNames),
  eidolons: eidolonsOf(snapshot, zhToEn),
  cones: lightConeRanksOf(snapshot, coneZhToEn),
};

const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const conclusion = buildConclusion(envs, {
  availability, firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: acct,
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
});
const plan = teamPlan(conclusion, acct, { availability, drawWeights: normalizeDrawWeights({}) });

const rosterKeyOf = (members) => members
  .map((m) => `${m.char}|E${eidolonTierOf(m.eidolon)}|${m.lc || '-'}|`
    + `S${Math.max(1, Math.round(Number(m.superimp) || 1))}`)
  .sort().join('~');
const teamText = (members) => members
  .map((m) => `${cn(m.char)}E${eidolonTierOf(m.eidolon)}${m.lc ? `+${cnCone(m.lc)}S${m.superimp}` : ''}`)
  .join(' / ');
const packKeyOf = (m) => `${m.char}|E${eidolonTierOf(m.eidolon)}|${m.lc || '-'}|`
  + `S${Math.max(1, Math.round(Number(m.superimp) || 1))}`;
/** 总榜条目（`frontierUnits` 的元素）用 `name` 而不是 `char`，键的形状完全一致。 */
const packKeyOfUnit = (u) => `${u.name}|E${eidolonTierOf(u.eidolon)}|${u.lc || '-'}|`
  + `S${Math.max(1, Math.round(Number(u.superimp) || 1))}`;

/** 版本比较（与 advice.js 的 `cmpVersion` 同一套数值分段口径）。 */
const cmpVersion = (a, b) => {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d;
  }
  return 0;
};

/** 逐环境还原：原始行 + 各版本 perfect 档最便宜金数（生产的分母）。 */
const envLedger = (envId) => {
  const f = frontierAll.find((x) => x.env === envId);
  const envDef = envs.find((e) => e.id === envId);
  const perfW = perfLineWeightsOf(envDef || { mode: f?.mode, stage: f?.stage });
  const seasonsDesc = [...(f.seasons || [])].sort((a, b) => -cmpVersion(a, b));
  const weightOf = (s) => Number(f.seasonWeights?.[s] ?? versionWeightOf(seasonsDesc.indexOf(s)));
  const rows = f.frontierRows || [];
  const denomOf = (s) => {
    const inSeason = rows.filter((r) => r.season === s);
    const perfect = inSeason.filter((r) => r.tier === 'perfect').map((r) => Math.max(1, r.cost));
    const all = inSeason.map((r) => Math.max(1, r.cost));
    const global = rows.map((r) => Math.max(1, r.cost));
    return perfect.length ? Math.min(...perfect)
      : (all.length ? Math.min(...all) : (global.length ? Math.min(...global) : null));
  };
  const scoreOfRow = (r) => {
    const perf = perfFactorOf(r.actionValue, envDef?.tierLines, envDef?.lowerIsBetter !== false, r.tier, perfW);
    const cf = frontierCostTermOf(denomOf(r.season), r.cost);
    return { perf, costFactor: cf, score: 100 * perf * (cf ?? 1), strength: packStrengthOf(perf) };
  };
  return { f, envDef, seasonsDesc, weightOf, rows, denomOf, scoreOfRow, perfW };
};

/** 某整包在该环境的逐版本账本（生产口径：每版本取分最高的一条）。 */
const packLedger = (led, packKey) => {
  const bySeason = new Map();
  for (const r of led.rows) {
    if (!r.members.some((m) => packKeyOf(m) === packKey)) continue;
    const s = led.scoreOfRow(r);
    const cur = bySeason.get(r.season);
    if (!cur || s.score > cur.s.score) bySeason.set(r.season, { r, s });
  }
  const [char, , coneRaw] = packKey.split('|');
  const cone = coneRaw === '-' ? null : coneRaw;
  const seen = index.refs?.firstSeen?.byMode?.['Anomaly Arbitration'] || index.refs?.firstSeen || {};
  const known = [seen?.characters?.[char] || null, cone ? (seen?.lightCones?.[cone] || null) : null]
    .filter(Boolean);
  const born = known.length
    ? known.reduce((a, b) => (cmpVersion(a, b) >= 0 ? a : b))
    : ([...bySeason.keys()].sort(cmpVersion)[0] || null);
  let num = 0; let den = 0; let sNum = 0; let dropped = 0; let absent = 0;
  const lines = [];
  for (const season of led.seasonsDesc) {
    const w = led.weightOf(season);
    const hit = bySeason.get(season);
    if (hit) {
      num += w * hit.s.score; sNum += w * hit.s.strength; den += w;
      lines.push({ season, w, hit }); continue;
    }
    if (born !== null && cmpVersion(season, born) < 0) {
      absent += 1; lines.push({ season, w, absent: true }); continue;
    }
    dropped += 1; den += w; lines.push({ season, w, dropped: true });
  }
  return {
    bySeason, born, lines, den, dropped, absent,
    score: den ? num / den : null, strength: den ? sNum / den : null,
  };
};

const printLedger = (title, envId, packKey, unitEnvScore) => {
  const led = envLedger(envId);
  const p = packLedger(led, packKey);
  console.log(`\n=== ${title} ===`);
  console.log(`  整包 ${packKey}｜登场版本 ${p.born}｜权重和 ${p.den}`
    + `（已登场无证据 ${p.dropped} 版 / 早于登场 ${p.absent} 版）`);
  console.log('  版本     权重  金数  行动值  档位     表现分  金数项  单版本分  纯强度   贡献占比');
  for (const l of p.lines) {
    if (!l.hit) {
      console.log(`  ${String(l.season).padEnd(7)} ${String(l.w).padStart(4)}   `
        + (l.absent ? '早于登场（不参与平均）' : '已登场无证据（算 0 分）'));
      continue;
    }
    const contrib = p.den ? (l.w / p.den * 100) : 0;
    console.log(`  ${String(l.season).padEnd(7)} ${String(l.w).padStart(4)} ${String(l.hit.r.cost).padStart(5)}`
      + ` ${String(l.hit.r.actionValue).padStart(7)}  ${String(l.hit.r.tier).padEnd(8)}`
      + ` ${l.hit.s.perf.toFixed(4).padStart(7)}`
      + ` ${String(l.hit.s.costFactor === null ? '—' : l.hit.s.costFactor.toFixed(3)).padStart(7)}`
      + ` ${l.hit.s.score.toFixed(2).padStart(9)} ${l.hit.s.strength.toFixed(2).padStart(8)}`
      + ` ${contrib.toFixed(1).padStart(8)}%`);
  }
  const ok = unitEnvScore && p.score !== null
    && Math.abs(Number(unitEnvScore.score) - p.score) < 0.01;
  console.log(`  复算版本加权平均：分 ${p.score === null ? '—' : p.score.toFixed(4)}`
    + `｜纯强度 ${p.strength === null ? '—' : p.strength.toFixed(4)}`);
  console.log(`  生产同一条目：${envId} score=${unitEnvScore?.score ?? '—'}`
    + `（本地复算${ok ? '一致 ✓' : '不一致 ✗'}）`);
};

// ---- 首推队伍：把它的代表整包拉出来 --------------------------------------------
const head = plan.rows[0];
const headUnit = (conclusion.frontierUnits || []).find((u) => {
  const ev = (u.envs || []).find((e) => (e.members || []).length);
  return ev && rosterKeyOf(ev.members) === rosterKeyOf(head.members);
});
const headPackKey = headUnit ? packKeyOfUnit(headUnit) : null;
console.log(`当前首推 #1（账面 ${head.gold} 金 / 补金 ${head.gap}）：${teamText(head.members)}`);
console.log(`  它在总榜上的代表整包：${headPackKey}（总榜分 ${headUnit?.total} / 强度 ${headUnit?.strength}）`);
const headEnvMap = new Map((headUnit?.envs || []).map((e) => [e.id, e]));

for (const envId of ['aa/plight', 'aa', 'as', 'moc', 'pf']) {
  printLedger(`首推整包 · ${envId}`, envId, headPackKey, headEnvMap.get(envId));
}

// 首推整包在绝境的**逐版本最佳配置**（整包口径：同一整包、队友可以不同）
{
  const led = envLedger('aa/plight');
  const p = packLedger(led, headPackKey);
  console.log('\n=== 首推整包的绝境逐版本最佳配置（整包 = 长夜月 E2 + 致长夜的星光 S1）===');
  for (const l of p.lines) {
    if (!l.hit) continue;
    console.log(`  ${l.season}（权重 ${l.w}）${l.hit.r.cost} 金 / ${l.hit.r.actionValue} AV / ${l.hit.r.tier}`
      + `  →  ${teamText(l.hit.r.members)}`);
  }
}

// ---- 对照：更便宜的队伍 --------------------------------------------------------
const refs = [
  { label: '对照 1：方案 #2（账面 11 金）', roster: plan.rows[1].members },
];
// 数据集里 4.6 最便宜的满分整包
const cheap = (() => {
  const f = frontierAll.find((x) => x.env === 'aa/plight');
  return (f.frontierRows || [])
    .filter((r) => r.season === '4.6' && r.tier === 'perfect' && r.actionValue < 300)
    .sort((a, b) => a.cost - b.cost || a.actionValue - b.actionValue)[0] || null;
})();
if (cheap) {
  refs.push({
    label: `对照 2：4.6 最便宜满分（${cheap.cost} 金 / ${cheap.actionValue}AV）`, roster: cheap.members,
  });
}
for (const ref of refs) {
  console.log(`\n\n######## ${ref.label} ########`);
  console.log(`  ${teamText(ref.roster)}`);
  const rowKeys = rosterKeyOf(ref.roster);
  const led = envLedger('aa/plight');
  const bySeason = new Map();
  for (const r of led.rows) {
    if (rosterKeyOf(r.members) !== rowKeys) continue;
    const cur = bySeason.get(r.season);
    if (!cur || r.actionValue < cur.actionValue) bySeason.set(r.season, r);
  }
  console.log('  [原始投稿] 版本 → 金数 / 行动值 / 档位');
  for (const s of led.seasonsDesc) {
    const r = bySeason.get(s);
    console.log(`  ${String(s).padEnd(10)} ${r
      ? `${String(r.cost).padStart(4)} 金 / ${String(r.actionValue).padStart(4)} AV / ${r.tier}`
      : '—— 无该版本证据'}`);
  }
  const u = (conclusion.frontierUnits || []).find((x) => {
    const ev = (x.envs || []).find((e) => (e.members || []).length);
    return ev && rosterKeyOf(ev.members) === rowKeys;
  });
  if (u) {
    const em = new Map((u.envs || []).map((e) => [e.id, e]));
    printLedger(`${ref.label} · 代表整包 ${packKeyOfUnit(u)}`, 'aa/plight',
      packKeyOfUnit(u), em.get('aa/plight'));
  } else {
    console.log('  ⚠️ 该四人组合不是任何整包在总榜上的「最佳证据队伍」→ 候选池里没有它。');
  }
}
