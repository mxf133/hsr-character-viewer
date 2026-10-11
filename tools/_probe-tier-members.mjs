// 关键可行性检查：**真实载荷**里的 `frontierTiers` 有多少条带队友名单（`envs[].members`）？
//
// 后端 `slimFrontierUnit(unit, index)` 只给前 `FRONTIER_DETAIL_ROWS = 200` 条发逐副本明细
// （明细里才有 `members`）。所以「客户端用 `frontierTiers` 当候选池」能不能覆盖全，
// 取决于有多少条 tier 单元的 index < 200。
//
//   node tools/_probe-tier-members.mjs
import { createApp } from '../src/server/app.js';

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
const text = await res.text();
const j = JSON.parse(text);
server.close();

const withMembers = (u) => (u.envs || []).some((e) => (e.members || []).length);
const tiers = j.frontierTiers || {};
const tierFlat = Object.values(tiers).flat();

console.log(`载荷 ${(Buffer.byteLength(text) / 1024).toFixed(0)} KB（硬上限 600 KB）\n`);
console.log(`frontierUnits      ${String(j.frontierUnits.length).padStart(4)} 条`
  + `，带队友名单的 ${j.frontierUnits.filter(withMembers).length} 条`);
console.log(`frontierTiers      ${String(tierFlat.length).padStart(4)} 条`
  + `，带队友名单的 ${tierFlat.filter(withMembers).length} 条`);
for (const [tier, rows] of Object.entries(tiers)) {
  console.log(`  档位 ${String(tier).padStart(2)}：${String(rows.length).padStart(3)} 条`
    + `，带名单 ${rows.filter(withMembers).length} 条`);
}
const missing = tierFlat.filter((u) => !withMembers(u));
console.log(`\n带不上名单的 ${missing.length} 条（客户端拿它们建不出队伍）：`);
const names = [...new Set(missing.map((u) => u.name))];
console.log(`  涉及 ${names.length} 个角色：${names.slice(0, 20).join('、')}${names.length > 20 ? ' …' : ''}`);
console.log(`  这些条目的 total 范围：${Math.min(...missing.map((u) => u.total)).toFixed(0)}`
  + ` ~ ${Math.max(...missing.map((u) => u.total)).toFixed(0)}`
  + `（带名单那批是 ${Math.min(...tierFlat.filter(withMembers).map((u) => u.total)).toFixed(0)}`
  + ` ~ ${Math.max(...tierFlat.filter(withMembers).map((u) => u.total)).toFixed(0)}）`);
