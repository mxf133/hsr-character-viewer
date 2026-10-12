// 核实一条结论：**逐档榜到底包不包含总榜**？并集是不是真的必要？
//
// 背景：`byTier` 的过滤是 `unit.eidolon !== tier`（**精确相等**，`EIDOLON_TIERS` = 0/1/2/6），
// 所以**星魂落在 E3/E4/E5 的整包理论上不在逐档榜里**。但「含队友名单的整包」与「进池的
// 队伍」是两件事，必须实测才能定论 —— 这个探针就是为了不让注释里写一句没验过的话。
//
//   node tools/_probe-tier-superset.mjs
import { createApp } from '../src/server/app.js';
import { SCORING, teamPlan } from '../src/core/advice.js';

const fakeStore = {
  load: async () => {}, listAccounts: async () => [], getAccount: async () => null,
  getSnapshot: async () => null, getBattleRecords: async () => null, setBattleRecords: async () => {},
};
const { server } = createApp({ store: fakeStore });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const res = await fetch(`http://127.0.0.1:${port}/api/archive/conclusion`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ account: [], window: 6 }),
  signal: AbortSignal.timeout(300000),
});
const payload = await res.json();
server.close();

const acct = { owned: new Set(), eidolons: new Map(), cones: new Map() };
const keep = SCORING.teamPlanMaxRows;
SCORING.teamPlanMaxRows = 100000; // ⚠️ 不抬起来只拿得到前 15 条（踩过）
const run = (obj) => teamPlan(obj, acct, { availability: payload.availability });
const tiersOnly = run({ ...payload, frontierUnits: [] });
const unitsOnly = run({ ...payload, frontierTiers: undefined });
const union = run(payload);
SCORING.teamPlanMaxRows = keep;

const tierKeys = new Set(tiersOnly.rows.map((r) => r.key));
const unitKeys = new Set(unitsOnly.rows.map((r) => r.key));
const unionKeys = new Set(union.rows.map((r) => r.key));
const missingFromTiers = [...unitKeys].filter((k) => !tierKeys.has(k));
const missingFromUnion = [...unitKeys].filter((k) => !unionKeys.has(k));

// 整包层面（不是队伍层面）：有多少个总榜整包在逐档榜里找不到（按 key 比）。
const tierUnitKeys = new Set(Object.values(payload.frontierTiers || {}).flat().map((u) => u.key));
const unitsMissing = (payload.frontierUnits || []).filter((u) => !tierUnitKeys.has(u.key));

console.log(`载荷 ${(Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(0)} KB`);
console.log(`总榜整包 ${payload.frontierUnits.length} 条`
  + ` / 逐档榜整包 ${Object.values(payload.frontierTiers || {}).flat().length} 条\n`);

console.log(`【整包层面】总榜有 ${unitsMissing.length} 条的 key 不在逐档榜里：`);
for (const u of unitsMissing) {
  console.log(`  · ${u.name} E${u.eidolon} + ${u.lc || '（无光锥）'}S${u.superimp}`
    + `（total ${Number(u.total).toFixed(0)}，档位 ${u.eidolon} ${[0, 1, 2, 6].includes(u.eidolon) ? '在档位表内' : '**不在档位表内**'}）`);
}

console.log(`\n【队伍层面】只取逐档榜时的池 ${tiersOnly.pool} 支｜只取总榜时的池 ${unitsOnly.pool} 支`
  + `｜并集 ${union.pool} 支`);
console.log(`总榜池里有 ${missingFromTiers.length} 支队伍不在「只取逐档榜」的池里：`);
for (const k of missingFromTiers) {
  const r = unitsOnly.rows.find((x) => x.key === k);
  console.log(`  · 补 ${r.gap} 金｜${k.split('~').map((s) => s.split('|')[0]).join('/')}`);
}
console.log(`并集把这些补齐了吗：${missingFromUnion.length === 0 ? '✓ 补齐了（0 支缺失）' : `✗ 还缺 ${missingFromUnion.length} 支`}`);
