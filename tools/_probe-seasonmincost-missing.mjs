// 一次性诊断：载荷里有多少行**缺 `seasonMinCost`**（那会让 `frontierFactorsOf` 退回
// `meta.minCost`＝全窗口最小值，base 因此偏小 —— 这是「跨版本发挥」唯一可能 > 1 的机制）。
//
//   node tools/_probe-seasonmincost-missing.mjs [--url=http://127.0.0.1:8371]
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const BASE = arg('url', 'http://127.0.0.1:8371');
const res = await fetch(`${BASE}/api/archive/conclusion`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    account: { owned: [], eidolons: {}, cones: {} },
    window: 6,
    frontierWeights: { 'aa|plight': 10, 'aa|': 1, 'as|': 1, 'moc|': 1, 'pf|': 1 },
    hiddenCosts: { gift: true, giftCone: true, exchange: true, exchangeCone: true, standard: true },
  }),
  signal: AbortSignal.timeout(240000),
});
const p = await res.json();
const all = [...(p.frontierUnits || []), ...Object.values(p.frontierTiers || {}).flat()];
let rows = 0; let missing = 0; let fallbackShrinks = 0;
const samples = [];
for (const u of all) {
  for (const e of u.envs || []) {
    rows += 1;
    const meta = (p.frontierEnvs || []).find((m) => m.id === e.id);
    if (e.seasonMinCost === null || e.seasonMinCost === undefined) {
      missing += 1;
      if (samples.length < 5) samples.push(`${u.name} / ${e.envLabel}`);
    } else if (Number(meta?.minCost) < Number(e.seasonMinCost)) {
      // meta.minCost 比这一版自己的分母更小 —— 一旦 seasonMinCost 丢了，base 就会被压低。
      fallbackShrinks += 1;
    }
  }
}
console.log(`明细 ${rows} 行｜缺 seasonMinCost 的 ${missing} 行`
  + `｜「全窗口 minCost 比本版分母更小」的 ${fallbackShrinks} 行`);
if (samples.length) console.log('缺值的例子：', samples.join(' / '));
