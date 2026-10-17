// 探针：非顶格档（行动值 != 0）的 envStrength 分布 —— 验证「cap 把整列压到个位数」。
//
//   node tools/_probe-strength-cap.mjs
import {
  buildConclusion, VERSION_WINDOW,
} from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const index = await archiveIndex();
const { envs } = await conclusionEnvs(index, { window: VERSION_WINDOW });
const fa = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const c = buildConclusion(envs, {
  availability: index.refs?.availability || {},
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  frontier: Object.fromEntries(fa.map((f) => [f.env, f])),
});
const units = [];
for (const l of Object.values(c.frontierTiers || {})) units.push(...l);
const seen = new Set(); const all = [];
for (const u of units) {
  const k = `${u.name}|${u.eidolon}|${u.lc}|${u.superimp}`;
  if (seen.has(k)) continue;
  seen.add(k); all.push(u);
}

const stat = (a) => {
  if (!a.length) return '（无）';
  const s = a.slice().sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return `n=${String(s.length).padStart(5)} min=${s[0].toFixed(1).padStart(5)}`
    + ` p50=${q(0.5).toFixed(1).padStart(5)} p90=${q(0.9).toFixed(1).padStart(5)} max=${s[s.length - 1].toFixed(1).padStart(6)}`;
};

const byEnv = new Map();
for (const u of all) {
  for (const e of (u.envs || [])) {
    const key = e.envLabel;
    if (!byEnv.has(key)) byEnv.set(key, { zero: [], nonZero: [] });
    const box = byEnv.get(key);
    if (Number(e.avBest) === 0) box.zero.push(Number(e.envStrength) || 0);
    else box.nonZero.push(Number(e.envStrength) || 0);
  }
}
console.log('每个副本：行动值 == 0 的条目 vs 行动值 > 0 的条目，envStrength 分布');
for (const [k, v] of byEnv) {
  console.log(`\n[${k}]`);
  console.log(`  行动值 = 0 ：${stat(v.zero)}`);
  console.log(`  行动值 > 0 ：${stat(v.nonZero)}`);
}
