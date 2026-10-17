// 探针：把「内部 av 空间」和「游戏内数值空间」的换算关系逐副本钉死。
//
// 为什么要单独探：`tierLines` 在四个副本里**存的不是同一个方向的数** ——
// 混沌/虚构/王棋骑士是「越小越好」（0/2/4 轮），末日幻影是「越大越好」（4000/3700/3400 分）。
// 界面上写单位（`0T` / `积分 3864` / `行动值 240`）时到底该传哪一个值，
// 得先用真实数据确认，不能靠注释推断。
//
//   node tools/_probe-metric-units.mjs
import { archiveConclusion } from '../src/server/conclusion.js';
import {
  avUnitOf, formatAv, metricShortText, metricValueText, perfAnchorsOf, perfLineWeightsOf,
} from '../public/scripts/advice.js';

const conclusion = await archiveConclusion({ owned: [], eidolons: {}, cones: {} }, {
  includeAllTeams: true,
});
const envs = conclusion.frontierEnvs || [];
const allTeams = conclusion.allTeams || [];

for (const e of envs) {
  const lower = e.lowerIsBetter !== false;
  console.log(`\n=== ${e.label} (${e.id}) ===`);
  console.log(`  mode=${e.mode} stage=${e.stage || '-'} 单位=${avUnitOf(e.mode, e.stage)} `
    + `lowerIsBetter=${lower}`);
  console.log(`  tierLines(原始)=${JSON.stringify(e.tierLines)}`);
  console.log(`  内部 av 取值样本=${[...new Set(allTeams.flatMap((t) => (t.a || [])
    .filter((r) => r[0] === e.id).map((r) => r[1])))].slice(0, 12).join(', ')}`);
  // 内部 av 空间里「顶点」= 最好成绩应该是多少？
  const avs = allTeams.flatMap((t) => (t.a || []).filter((r) => r[0] === e.id)
    .map((r) => Number(r[1]))).filter(Number.isFinite);
  if (avs.length) {
    console.log(`  内部 av min=${Math.min(...avs)} max=${Math.max(...avs)} n=${avs.length}`);
  }
}
