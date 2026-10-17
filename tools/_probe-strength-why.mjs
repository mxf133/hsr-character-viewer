/**
 * 探针：为什么某个角色「显示的强度」比它数据里的最好成绩低。
 *
 * 对指定角色（默认取整包里最强的那一个）逐副本、逐版本打印两行：
 *   A 现行：含金数项分（`score`）最高的那一行 —— 强度用的就是它
 *   B 最快：`strengthPerf` 最高的那一行（同一版本）
 * 并算出两把尺子下的「本副本强度」与整包强度。
 *
 *   node tools/_probe-strength-why.mjs [--char=银狼LV.999] [--pack=E6S5] [--rows=20]
 */
import {
  SCORING, VERSION_WINDOW, envWeightOf, frontierCostTermOf,
  perfFactorOf, perfLineWeightsOf,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const wantChar = arg('char', '银狼LV.999');
const wantPack = arg('pack', '');

const index = await archiveIndex();
const i18n = await loadI18n();
const cn = (n) => zhName(i18n, 'characters', n) || n;
const zhToEn = {};
for (const c of index.refs?.characters || []) if (c.nameCn) zhToEn[c.nameCn] = c.name;
const charKey = zhToEn[wantChar] || wantChar;

const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const fa = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const envById = new Map(envs.map((e) => [e.id, e]));
const eidolonTier = (e) => {
  const n = Math.max(0, Math.floor(Number(e) || 0));
  return n >= 6 ? 6 : n >= 2 ? 2 : n >= 1 ? 1 : 0;
};
const keyOf = (m) => `${m.char}|E${eidolonTier(m.eidolon)}|${m.lc || '-'}|S${Math.max(1, Math.round(Number(m.superimp) || 1))}`;
const envW = (f) => Number(envWeightOf(f.mode, f.stage || '', 'frontier')) || 0;
const totalW = fa.reduce((n, f) => n + envW(f), 0);

// 先看这个角色在榜上/整包里出现过哪些配装（按强度分挑出要解释的那一个）
const packs = new Map();
for (const f of fa) {
  for (const r of f.frontierRows || []) {
    for (const m of r.members || []) {
      if (m.char !== charKey) continue;
      const k = keyOf(m);
      packs.set(k, (packs.get(k) || 0) + 1);
    }
  }
}
console.log(`${wantChar}（${charKey}）出现过 ${packs.size} 个整包`);
const targets = wantPack
  ? [...packs.keys()].filter((k) => k.includes(wantPack))
  : [...packs.keys()];
if (!targets.length) { console.log('没有匹配的整包'); process.exit(0); }

for (const target of targets) {
  let sumA = 0; let sumB = 0;
  console.log(`\n======== ${target} ========`);
  for (const f of fa) {
    const rows = (f.frontierRows || []).filter((r) => r.members?.some((m) => keyOf(m) === target));
    if (!rows.length) continue;
    const line = envById.get(f.env) || {};
    const tiers = line.tierLines || null;
    const lower = line.lowerIsBetter !== false;
    const perfW = perfLineWeightsOf(line);
    const minAll = new Map(); const minPerfect = new Map();
    for (const r of f.frontierRows || []) {
      const s = String(r.season || ''); const c = Number(r.cost) || 0;
      if (c > 0) minAll.set(s, Math.min(minAll.get(s) ?? Infinity, c));
      if (r.tier === 'perfect' && c > 0) minPerfect.set(s, Math.min(minPerfect.get(s) ?? Infinity, c));
    }
    const denom = (s) => minPerfect.get(s) ?? minAll.get(s) ?? 0;
    const byS = new Map();
    for (const r of rows) {
      const s = String(r.season || '');
      const perf = perfFactorOf(r.actionValue, tiers, lower, r.tier, perfW);
      if (!(perf > 0)) continue;
      const sPerf = perfFactorOf(r.actionValue, tiers, lower, r.tier, SCORING.strengthLineWeights);
      const score = 100 * perf * (frontierCostTermOf(denom(s), Number(r.cost)) ?? 1);
      const cur = byS.get(s) || { bestScore: -1, bestPerf: -1 };
      if (score > cur.bestScore) { cur.bestScore = score; cur.scoreAv = r.actionValue; cur.scoreCost = r.cost; cur.scorePerf = sPerf; }
      if (sPerf > cur.bestPerf) { cur.bestPerf = sPerf; cur.fastAv = r.actionValue; cur.fastCost = r.cost; }
      byS.set(s, cur);
    }
    const wSum = Object.values(f.seasonWeights || {}).reduce((n, v) => n + (Number(v) > 0 ? Number(v) : 0), 0) || 1;
    let accA = 0; let accB = 0;
    const lines = [];
    for (const [s, c] of [...byS].sort((x, y) => String(y[0]).localeCompare(String(x[0])))) {
      const w = Number(f.seasonWeights?.[s]) || 0;
      if (!(w > 0)) continue;
      const sA = c.scoreAv === 0 ? 100 : SCORING.strengthSecondBandCap * c.scorePerf;
      const sB = c.fastAv === 0 ? 100 : SCORING.strengthSecondBandCap * c.bestPerf;
      accA += w * sA; accB += w * sB;
      lines.push(`    ${String(s).padEnd(4)} w${String(w).padStart(2)}｜现状 av ${String(c.scoreAv).padStart(5)} 队金 ${String(c.scoreCost).padStart(2)} → ${sA.toFixed(1).padStart(5)}`
        + `   ｜最快 av ${String(c.fastAv).padStart(5)} 队金 ${String(c.fastCost).padStart(2)} → ${sB.toFixed(1).padStart(5)}`);
    }
    const envA = accA / wSum; const envB = accB / wSum;
    sumA += envW(f) * envA / totalW; sumB += envW(f) * envB / totalW;
    console.log(`  ${f.envLabel || f.env}（权重 ${envW(f)}）：本关 ${envA.toFixed(1)} → ${envB.toFixed(1)}`);
    for (const l of lines) console.log(l);
  }
  console.log(`  整包：现状 ${sumA.toFixed(2)} → 用最快行 ${sumB.toFixed(2)}（+${(sumB - sumA).toFixed(2)}）`);
}
