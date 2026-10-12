// 探针：走**服务端真实通路** `archiveConclusion`（与 GUI 的 `/api/archive/conclusion`
// 同一份输出），把它实际发给浏览器的性价比总榜打出来。
//
// 为什么必须有这一支：`tools/_probe-pack.mjs` / `_probe-rank.mjs` 各自手写了一套
// 「版本选取 + 构建环境」的逻辑，与 `src/server/conclusion.js` 分叉过 —— 于是出现过
// 「探针说砂金 #3、界面上是 #14」。这一个探针直接消费生产函数，不存在分叉。
//
//   node tools/_probe-server.mjs                 # 前 20 条 + 「砂金」的全部条目
//   node tools/_probe-server.mjs --rows 30
//   node tools/_probe-server.mjs --json=out.json # 顺便把整份载荷落盘（回归对比用）
import { readFile, writeFile } from 'node:fs/promises';
import { archiveConclusion } from '../src/server/conclusion.js';
import { archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { ownedCharacters, eidolonsOf, lightConeRanksOf } from '../src/core/advice.js';

const arg = (name, dflt) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return dflt;
};
const ROWS = Number(arg('rows', '20'));
const FINDS = process.argv.flatMap((a) => (a.startsWith('--find=') ? [a.slice(7)] : []));
const JSON_OUT = arg('json', null);

const index = await archiveIndex();
const i18n = await loadI18n();
const cn = (n) => zhName(i18n, 'characters', n) || n;
const cnCone = (n) => (n ? zhName(i18n, 'lightCones', n) || n : '—');

// ---- 本机账号（没有就按空角色池）：与 _probe-rank.mjs 同一套中英映射 ----
let owned = new Set();
let eidolons = new Map();
let cones = new Map();
try {
  const store = JSON.parse(await readFile('data/accounts.json', 'utf8'));
  const account = store.accounts?.[0];
  const role = account?.roles?.[0];
  const snapshot = account?.snapshots?.[role?.uid];
  if (snapshot) {
    const zhToEn = {};
    const allNames = [];
    for (const c of index.refs?.characters || []) {
      if (c.nameCn && c.name) zhToEn[c.nameCn] = c.name;
      if (c.nameCn) allNames.push(c.nameCn);
    }
    const coneZhToEn = {};
    for (const c of index.refs?.lightCones || []) {
      if (c.nameCn && c.name) coneZhToEn[c.nameCn] = c.name;
    }
    owned = ownedCharacters(snapshot, zhToEn, allNames);
    eidolons = eidolonsOf(snapshot, zhToEn);
    cones = lightConeRanksOf(snapshot, coneZhToEn);
    console.log(`账号：${role.nickname || role.uid} · 拥有 ${owned.size} 个角色 / ${cones.size} 把光锥`);
  }
} catch {
  console.log('账号：读不到（按空角色池跑）');
}

// 界面默认的「总榜权重」：绝境 10、其余 1（见 advice-view.js 的 ENV_WEIGHT_ROWS）。
const frontierWeights = { 'moc|': 1, 'pf|': 1, 'as|': 1, 'aa|': 1, 'aa|plight': 10 };

const res = await archiveConclusion(
  { owned: [...owned], eidolons: Object.fromEntries(eidolons), cones: Object.fromEntries(cones) },
  { frontierWeights },
);

if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify(res, null, 1), 'utf8');
  console.log(`完整载荷已写入 ${JSON_OUT}`);
}

console.log(`\npayload=${res.payload}  frontierUnits=${res.frontierUnits.length} 条  units=${res.units.length} 条`);
console.log(`\n=== GUI 实际拿到的性价比总榜（前 ${ROWS}）===`);
res.frontierUnits.slice(0, ROWS).forEach((u, i) => {
  console.log(`  #${String(i + 1).padStart(3)}  ${String(Math.round(u.total)).padStart(5)}  `
    + `${cn(u.name)} E${u.eidolon} · ${u.lc ? `${cnCone(u.lc)}S${u.superimp}` : '无光锥'}`
    + `   整包${u.gold}金  最佳证据 ${u.bestTier} ${u.bestTeamGold}金 av=${u.bestActionValue}  副本数=${u.envCount}`);
});

for (const frag of (FINDS.length ? FINDS : ['砂金'])) {
  console.log(`\n=== 「${frag}」在 GUI 载荷里的全部条目 ===`);
  let hit = 0;
  res.frontierUnits.forEach((u, i) => {
    if (!cn(u.name).includes(frag)) return;
    hit += 1;
    console.log(`  #${i + 1} / ${res.frontierUnits.length}   ${u.total}   `
      + `${cn(u.name)} E${u.eidolon} · ${cnCone(u.lc)}S${u.superimp}   整包${u.gold}金  副本数=${u.envCount}`);
    for (const e of u.envs) {
      console.log(`      ${e.id} 贡献=${Math.round(e.value)} ${e.tier} ${e.bestTeamGold}金 av=${e.actionValue} `
        + `证据版本=${e.evidenceSeason} 不参与${e.absentSeasons}/0分${e.droppedSeasons} born=${e.bornSeason}`);
    }
  });
  if (!hit) console.log('  （没有）');
}
