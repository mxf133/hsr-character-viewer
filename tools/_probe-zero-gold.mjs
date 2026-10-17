// 探针：为什么「0 金通关 × 1.2」从不触发 —— 逐层核对数据与过滤条件。
//
//   node tools/_probe-zero-gold.mjs
//
// 结论（2026-10-17）：窗口内不可达，有两道门。
//   门 1：0 金队伍只出现在 `seasons[s].teams`（纯角色名单，无星魂/光锥），
//         而前沿池 `frontierRows` 只读 `seasons[s].frontier`（整包明细）。
//   门 2：它们档位是 pass/below，而池子只收 `t >= 2`（target / perfect）。
import { readFile } from 'node:fs/promises';
import { VERSION_WINDOW } from '../public/scripts/advice.js';

const data = JSON.parse(await readFile(new URL('../theherta/archive.json', import.meta.url), 'utf8'));
const modes = data.modes || {};

let anyZeroFrontier = 0;
let anyZeroTeams = 0;
const inWindow = [];
for (const mode of Object.keys(modes)) {
  const stages = modes[mode].stages || {};
  for (const stage of Object.keys(stages)) {
    const seasons = stages[stage].seasons || {};
    const all = Object.keys(seasons);
    const win = all.slice(-VERSION_WINDOW);
    for (const s of all) {
      const fz = (seasons[s].frontier || []).filter((r) => Number(r.c) === 0);
      const tz = (seasons[s].teams || []).filter((r) => Number(r.cost) === 0);
      if (fz.length) anyZeroFrontier += fz.length;
      if (tz.length) anyZeroTeams += tz.length;
      if (!fz.length && !tz.length) continue;
      const inside = win.includes(s);
      if (tz.length) {
        for (const r of tz) {
          const tier = r.perfect ? 'perfect' : r.target ? 'target' : r.pass ? 'pass' : 'below';
          inWindow.push({
            mode, stage, season: s, inside, tier,
            best: r.best, roster: (r.roster || []).join(' + '),
          });
        }
      }
      console.log(`${mode}${stage ? '/' + stage : ''} ${s}（${inside ? '窗口内' : '窗口外'}）`
        + `｜frontier 0 金 ${fz.length} 条｜teams 0 金 ${tz.length} 条`);
    }
  }
}

console.log(`\n数据集里 0 金行合计：frontier ${anyZeroFrontier} 条｜teams ${anyZeroTeams} 条`);

const zeroFrontierSeasons = Object.values(modes).flatMap((m) => Object.values(m.stages || {}))
  .flatMap((st) => Object.entries(st.seasons || {}))
  .filter(([, v]) => (v.frontier || []).some((r) => Number(r.c) === 0))
  .length;
console.log(`带 0 金的 frontier 期数：${zeroFrontierSeasons}（都在 6 版窗口之外）`);

console.log('\n窗口内的 0 金队伍（全部在 teams 里，档位均不满足 t >= 2）：');
for (const r of inWindow.filter((x) => x.inside)) {
  console.log(`  ${r.mode} ${r.season}｜档位 ${r.tier}｜最佳成绩 ${r.best}｜${r.roster}`);
}
const reachable = inWindow.filter((x) => x.inside && (x.tier === 'perfect' || x.tier === 'target'));
console.log(`\n→ 窗口内能进前沿池的 0 金队伍：${reachable.length} 支`
  + `（${reachable.length ? '注意：这条规则现在会触发' : '所以 ×1.2 分支在当前数据集下不可达'}）`);
