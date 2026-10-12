// 手工探针（_ 前缀）：判定数据集里的 `c`（队伍金数）到底按哪种公式算出来的。
// 候选：星魂按「目标档」(0/1/2/6) 还是按「真实级数」；光锥叠影算不算金、算几金。
//
// 跑法：node tools/_probe-yinjin-cost-formula.mjs

import { charCostOf, coneCostOf, eidolonTierOf, VERSION_WINDOW } from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const index = await archiveIndex();
const availability = index.refs?.availability || {};
const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });

const body = (m) => charCostOf(m.char, availability);
const eidTier = (m) => (body(m) > 0 ? eidolonTierOf(m.eidolon) : 0);
const eidReal = (m) => (body(m) > 0 ? Math.max(0, Math.min(6, Math.round(Number(m.eidolon) || 0))) : 0);
const cone = (m) => (m.lc ? coneCostOf(m.lc, availability) : 0);
const sup = (m) => (cone(m) > 0 ? Math.max(0, (Number(m.superimp) || 1) - 1) : 0);

const formulas = {
  '本体+档位星魂+光锥本体': (m) => body(m) + eidTier(m) + cone(m),
  '本体+真实星魂+光锥本体': (m) => body(m) + eidReal(m) + cone(m),
  '本体+档位星魂+光锥本体+叠影增量': (m) => body(m) + eidTier(m) + cone(m) + sup(m),
  '本体+真实星魂+光锥本体+叠影增量': (m) => body(m) + eidReal(m) + cone(m) + sup(m),
  '本体+真实星魂+光锥×叠影': (m) => body(m) + eidReal(m) + cone(m) * Math.max(1, Number(m.superimp) || 1),
  '本体+档位星魂+光锥×叠影': (m) => body(m) + eidTier(m) + cone(m) * Math.max(1, Number(m.superimp) || 1),
};

const rows = frontierAll.flatMap((f) => f.frontierRows || []);
console.log(`前沿行 ${rows.length} 条\n`);
for (const [label, fn] of Object.entries(formulas)) {
  let ok = 0;
  const hist = new Map();
  for (const row of rows) {
    const sum = (row.members || []).reduce((n, m) => n + fn(m), 0);
    const diff = (Number(row.cost) || 0) - sum;
    if (diff === 0) ok += 1;
    else hist.set(diff, (hist.get(diff) || 0) + 1);
  }
  const detail = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([d, n]) => `${d > 0 ? '+' : ''}${d}×${n}`).join(' ');
  console.log(`${label.padEnd(28)} 完全一致 ${String(ok).padStart(4)}/${rows.length}  ${detail}`);
}
