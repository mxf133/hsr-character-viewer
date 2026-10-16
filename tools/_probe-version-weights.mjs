// 探针：版本权重能不能自己设（2026-10-16 第 3 条）。
//   node tools/_probe-version-weights.mjs
import { archiveFrontierAll, archiveIndex } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
const index = await archiveIndex();
const { envs } = await conclusionEnvs(index, { window: 6 });
const show = async (label, versionWeights) => {
  const all = await archiveFrontierAll(envs, { window: 6, versionWeights });
  console.log(`\n【${label}】`);
  for (const f of all.slice(0, 3)) {
    console.log(`  ${f.mode}${f.stage ? '/' + f.stage : ''}  窗口 ${(f.seasons || []).join(',')}`
      + `  seasonWeights=${JSON.stringify(f.seasonWeights)}  weightedRows=${(f.frontierRows || []).filter((r) => r.w > 0).length}/${(f.frontierRows || []).length}`);
  }
};
await show('默认表 3:2.5:2:1.5:1:0.5', undefined);
await show('只要最新版 [1,0,0,0,0,0]', [1, 0, 0, 0, 0, 0]);
await show('最近两版等权 [1,1,0,0,0,0]', [1, 1, 0, 0, 0, 0]);
await show('非法输入 ["x",-1,,]（应按默认补齐）', ['x', -1, '', 1.5, 1, 0.5]);
await show('全 0（应退回默认表）', [0, 0, 0, 0, 0, 0]);
