// 探针：队级泛用性（补金推荐 ③）在「两组归一」之后的实际表现（用户 2026-10-17 第 1 条）。
//
// 关注一件事：`teamPlan()` 现在让每个成员先按**自己那一组**的尺子归一成 0~100 的组内
// 相对分，再按成本占比加权。若两组量级差仍被带进队级，E6 成员占比越高的队 ③ 就会越高。
//
// 输出三段：
//   ① 成员级 —— 两组的**原始量**差多少、**组内相对分**又差多少（量级差是否被抹掉）；
//   ② A/B 对照 —— 同一批 roster 变体在「旧口径 / 新口径·等权 / 新口径·成本加权」下的
//      偏差方向，并把换档成员的 raw→组内分摊开，用来归因；
//   ③ 按 ③ 排序的前 N 条。
//
//   node tools/_probe-team-vers.mjs [--account=1] [--rows=20]
import { AccountStore } from '../src/server/store.js';
import {
  buildConclusion, eidolonsOf, eidolonTierOf, lightConeRanksOf, ownedCharacters, packGoldOf,
  teamPlan, teamPoolUnits, VERSION_WINDOW,
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
const ROWS = Math.max(1, Number(arg('rows', '20')) || 20);
const ACC = Math.max(1, Number(arg('account', '1')) || 1);

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
const cn = (n) => zhName(i18n, 'characters', n) || n;
const plan = teamPlan(conclusion, acct, { availability });
const rows = plan.rows || [];
console.log(`账号 ${ACC}：候选池 ${plan.pool} 支，下发 ${rows.length} 条`);
console.log(`③ 队级泛用性原始量：min=${Math.min(...rows.map((r) => r.versatilityRaw)).toFixed(2)}`
  + ` max=${Math.max(...rows.map((r) => r.versatilityRaw)).toFixed(2)}`);

const bucket = (share) => rows.filter((r) => {
  const s = (r.members || []).filter((m) => eidolonTierOf(m.eidolon) === 6).length
    / Math.max(1, (r.members || []).length);
  return share === 'hi' ? s >= 0.5 : share === 'lo' ? s <= 0.25 : s > 0.25 && s < 0.5;
});
const mean = (a, k) => (a.length ? a.reduce((n, v) => n + v[k], 0) / a.length : NaN);
for (const [label, sel] of [['E6 成员 ≥ 一半', 'hi'], ['E6 成员 ≤ 1/4', 'lo'], ['其余', 'mid']]) {
  const a = bucket(sel);
  console.log(`  ${label.padEnd(14)} ${String(a.length).padStart(3)} 支｜③ 均值 ${mean(a, 'versatilityPct').toFixed(2)}`
    + `｜原始量均值 ${mean(a, 'versatilityRaw').toFixed(3)}`);
}
// ---- 决定性一问：同一支 roster 的 E0 变体与 E6 变体，③ 会不会只因星魂不同而变高？----
// 补金推荐的本质是「这一发抽下去值不值」，所以池里同一支队伍会按「补到哪一档」出现多个
// 变体。若 E6 变体的 ③ 系统性地高于 E0 变体，说明两组的量级差被带进了队级。
//
// 这里做 **A/B 对照**：把每一对拆成三种算法，看偏差出在哪一层。
//   old         = Σ(成员原始量 × 成本占比)               —— 2026-10-17 之前的旧口径
//   new(等权)    = Σ(成员组内相对分 × 1/N)              —— 只留「组间量级差」这一个变量
//   new(成本加权) = Σ(成员组内相对分 × 成本占比)          —— 现在的生产口径
// 若量级差真的被消掉了，`new(等权)` 不该再有系统性的向上偏；剩下的差只可能来自
// 「成本占比」（E6 配装更贵 → 话语权更大）与「成员本身分数不同」。
const units = teamPoolUnits(conclusion);
const rawOfTier = new Map();
for (const u of units) {
  const k = `${u.name}|E${eidolonTierOf(u.eidolon)}`;
  const v = Number(u.versatilityRaw) || 0;
  if (!rawOfTier.has(k) || v > rawOfTier.get(k)) rawOfTier.set(k, v);
}
const vExt = conclusion.frontierExtents?.versatility || null;
const extOf = (eido) => {
  const e = eidolonTierOf(eido) === 6 ? vExt?.byTier?.['6'] : vExt;
  if (!e || !(Number(e.hi) - Number(e.lo) > 1e-9)) return null;
  return { lo: Number(e.lo), hi: Number(e.hi) };
};
const scoreOf = (name, eido) => {
  const raw = rawOfTier.get(`${name}|E${eidolonTierOf(eido)}`);
  if (raw === undefined) return 0;
  const e = extOf(eido);
  return e ? 100 * Math.max(0, Math.min(1, (raw - e.lo) / (e.hi - e.lo))) : 100;
};
const goldOf = (m) => Math.max(0, Number(packGoldOf(m, availability)) || 0);
const combine = (members, pick, weights) => {
  const ws = weights || members.map(() => 1);
  const sum = members.reduce((n, m, i) => n + pick(m) * ws[i], 0);
  const wSum = ws.reduce((n, v) => n + v, 0);
  return wSum > 0 ? sum / wSum : 0;
};
// ---- 成员级对照：两组的**原始量**差多少，**组内相对分**又差多少？----
// ⚠️ 这里的取样集合是**下发的 15 支**（`rows`）的成员位，是**被总分挑过的子集**：
//    前排队伍的低档成员往往是高原始量的明星，E6 槽位则被「不用抽就有」的开拓者 /
//    瓦尔特 / 停云占满。所以这两行**不能**用来回答「组间量级差有没有被抹掉」——
//    总体层面的答案在 `_probe-vers-shape.mjs`（榜上全部 角色|E档 去重后：
//    低档组组内相对分均值 10.1、E6 组 10.7，持平）。
const split = (arr) => {
  const e6 = []; const low = [];
  for (const r of rows) for (const m of r.members || []) {
    (eidolonTierOf(m.eidolon) === 6 ? e6 : low).push(arr(m));
  }
  return { e6, low };
};
const meanOf = (a) => (a.length ? a.reduce((n, v) => n + v, 0) / a.length : NaN);
const rawSplit = split((m) => rawOfTier.get(`${m.char}|E${eidolonTierOf(m.eidolon)}`) ?? 0);
const scoreSplit = split((m) => scoreOf(m.char, m.eidolon));
console.log('\n成员级（候选池里全部 ' + (rawSplit.e6.length + rawSplit.low.length) + ' 个成员位）：');
console.log(`  原始量均值      E6 组 ${meanOf(rawSplit.e6).toFixed(2)}｜低档组 ${meanOf(rawSplit.low).toFixed(2)}`
  + `｜倍数 ${(meanOf(rawSplit.e6) / Math.max(1e-9, meanOf(rawSplit.low))).toFixed(2)}×   ← 组间量级差`);
console.log(`  组内相对分均值  E6 组 ${meanOf(scoreSplit.e6).toFixed(2)}｜低档组 ${meanOf(scoreSplit.low).toFixed(2)}`
  + `｜差 ${(meanOf(scoreSplit.e6) - meanOf(scoreSplit.low)).toFixed(2)} 分   ← 子集观感，非总体（见上一段注释）`);

const byRoster = new Map();
for (const r of rows) {
  const k = (r.members || []).map((m) => m.char).sort().join('/');
  if (!byRoster.has(k)) byRoster.set(k, []);
  byRoster.get(k).push(r);
}
const pairs = [];
for (const [, list] of byRoster) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]; const b = list[j];
      const ta = (a.members || []).map((m) => eidolonTierOf(m.eidolon)).join(',');
      const tb = (b.members || []).map((m) => eidolonTierOf(m.eidolon)).join(',');
      if (ta === tb) continue;
      const hi = ta.split(',').filter((t) => t === '6').length
        >= tb.split(',').filter((t) => t === '6').length ? a : b;
      const lo = hi === a ? b : a;
      const rawPick = (m) => rawOfTier.get(`${m.char}|E${eidolonTierOf(m.eidolon)}`) ?? 0;
      const scorePick = (m) => scoreOf(m.char, m.eidolon);
      pairs.push({
        hi, lo,
        old: combine(hi.members, rawPick, hi.members.map(goldOf))
          - combine(lo.members, rawPick, lo.members.map(goldOf)),
        newEq: combine(hi.members, scorePick) - combine(lo.members, scorePick),
        newGold: combine(hi.members, scorePick, hi.members.map(goldOf))
          - combine(lo.members, scorePick, lo.members.map(goldOf)),
      });
    }
  }
}
const stat = (key) => {
  const d = pairs.map((p) => p[key]);
  const up = d.filter((x) => x > 1e-9).length;
  const down = d.filter((x) => x < -1e-9).length;
  return `${up} 涨 / ${down} 跌 / ${d.length - up - down} 平｜平均 ${(d.reduce((n, v) => n + v, 0) / d.length).toFixed(3)}`;
};
if (pairs.length) {
  console.log(`\n同一 roster 的不同星魂变体：${pairs.length} 对（问：E6 更多那一版的 ③ 更高吗？）`);
  console.log(`  旧口径（原始量 × 成本加权）      ${stat('old')}`);
  console.log(`  新口径·等权（组内相对分）        ${stat('newEq')}   ← 只看组间量级差`);
  console.log(`  新口径·成本加权（= 生产）        ${stat('newGold')}  ← 剩下的差来自成本占比与成员本身`);
  pairs.slice(0, 8).forEach((p) => {
    // 把**每一个换档的成员**的 raw → 组内分都印出来：偏差若来自组间量级差，
    // 会看到「raw 涨了但组内分没涨」；现在看到的应当是组内分真的在动。
    const parts = p.hi.members.map((m, i) => {
      const lo = p.lo.members[i];
      if (eidolonTierOf(m.eidolon) === eidolonTierOf(lo.eidolon)) return null;
      const rawLo = rawOfTier.get(`${lo.char}|E${eidolonTierOf(lo.eidolon)}`) ?? 0;
      const rawHi = rawOfTier.get(`${m.char}|E${eidolonTierOf(m.eidolon)}`) ?? 0;
      return `${cn(m.char)} E${eidolonTierOf(lo.eidolon)}→E${eidolonTierOf(m.eidolon)}`
        + ` raw ${rawLo.toFixed(2)}→${rawHi.toFixed(2)}`
        + ` 分 ${scoreOf(lo.char, lo.eidolon).toFixed(0)}→${scoreOf(m.char, m.eidolon).toFixed(0)}`;
    }).filter(Boolean);
    console.log(`    等权 ${p.newEq >= 0 ? '+' : ''}${p.newEq.toFixed(2)}`
      + `｜成本加权 ${p.newGold >= 0 ? '+' : ''}${p.newGold.toFixed(2)}｜${parts.join('；')}`);
  });
} else {
  console.log('\n池里没有同一 roster 的不同星魂变体可比。');
}

console.log('\n按 ③ 排序的前 ' + Math.min(ROWS, rows.length) + ' 条（看 E6 占比）：');
rows.slice().sort((a, b) => b.versatilityPct - a.versatilityPct).slice(0, ROWS).forEach((r, i) => {
  const e6 = (r.members || []).filter((m) => eidolonTierOf(m.eidolon) === 6).length;
  console.log(`  #${i + 1} ③ ${r.versatilityPct.toFixed(1).padStart(5)}｜raw ${r.versatilityRaw.toFixed(2).padStart(6)}`
    + `｜E6 ${e6}/${(r.members || []).length}｜${(r.members || []).map((m) => cn(m.char)).join('/')}`);
});
