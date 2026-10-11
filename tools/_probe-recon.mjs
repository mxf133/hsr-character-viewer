// 一次性：数据侦察（配对键 eidoPerf 到底在不在、账号快照长什么样）。看完即删。
import { readFileSync } from 'node:fs';

const ar = JSON.parse(readFileSync('theherta/archive.json', 'utf8'));
const i18n = JSON.parse(readFileSync('theherta/i18n-zh.json', 'utf8'));

// 1) i18n 里哪些英文名对应「花火」「刻律德菈」
const targets = ['花火', '刻律德菈'];
for (const t of targets) {
  const hits = Object.entries(i18n.characters || {}).filter(([, cn]) => cn === t);
  console.log(`i18n ${JSON.stringify(t)} -> ${JSON.stringify(hits.map(([en]) => en))}`);
}
// 模糊：包含「花」「刻」的角色中文名
console.log('含「花」的中文名:', JSON.stringify(
  [...new Set(Object.values(i18n.characters || {}))].filter((cn) => String(cn).includes('花')),
));
console.log('含「刻」的中文名:', JSON.stringify(
  [...new Set(Object.values(i18n.characters || {}))].filter((cn) => String(cn).includes('刻')),
));

// 2) 数据集里有没有 eidoPerf（建库侧按阵容分层的星魂画像）
let teams = 0; let withEidoPerf = 0; const samples = [];
for (const [mode, m] of Object.entries(ar.modes || {})) {
  for (const [stage, s] of Object.entries(m.stages || {})) {
    for (const [season, sd] of Object.entries(s.seasons || {})) {
      for (const t of sd.teams || []) {
        teams += 1;
        if (t.eidoPerf) { withEidoPerf += 1; if (samples.length < 2) samples.push({ mode, stage, season, rosterKey: t.rosterKey, eidoPerf: t.eidoPerf }); }
      }
    }
  }
}
console.log(`数据集阵容 ${teams} 条，带 eidoPerf 的 ${withEidoPerf} 条`);
console.log('样例:', JSON.stringify(samples, null, 1).slice(0, 1200));

// 3) 账号快照
const acc = JSON.parse(readFileSync('data/accounts.json', 'utf8'));
console.log('accounts.json 顶层键:', JSON.stringify(Array.isArray(acc) ? `array(${acc.length})` : Object.keys(acc)));
const list = Array.isArray(acc) ? acc : (acc.accounts || []);
for (const a of list) {
  const roles = a.roles || [];
  for (const r of roles) {
    const snap = a.snapshots?.[r.uid] || r.snapshot;
    const chars = snap?.characters || [];
    console.log(`账号 ${JSON.stringify(a.nickname ?? a.id)} 角色 ${r.uid} game=${r.game} 快照角色数=${chars.length}`);
  }
}
