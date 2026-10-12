import { readFileSync } from 'node:fs';
import { loadI18n } from '../src/server/archive.js';
import { budgetPlan } from '../src/core/advice.js';

const i18n = await loadI18n();
const zc = new Map(Object.entries(i18n.characters).map(([en, zh]) => [zh, en]));
const zl = new Map(Object.entries(i18n.lightCones).map(([en, zh]) => [zh, en]));
const j = JSON.parse(readFileSync('data/accounts.json', 'utf8'));
let s = null;
for (const x of Object.values(j.accounts[0].snapshots || {})) if ((x.characters || []).some((c) => c.equip !== undefined)) s = x;
const owned = new Set(); const eid = {}; const cones = {};
for (const c of s.characters || []) {
  const en = zc.get(c.name); if (!en) continue;
  owned.add(en); eid[en] = Math.max(eid[en] ?? 0, Number(c.rank) || 0);
  const k = zl.get(c.equip?.name); if (k) cones[k] = Math.max(cones[k] ?? 0, Number(c.equip.rank) || 1);
}
const out = await (await fetch('http://127.0.0.1:8399/api/archive/conclusion', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: { owned: [...owned], eidolons: eid, cones }, window: 6, gapMaxPulls: 5 }),
})).json();
console.log('packages:', out.packages.length);
console.log('gapUnits:', out.gapUnits.length, ' units:', out.units.length, ' eidolonUnits:', out.eidolonUnits.length);

for (const budget of [null, 3, 6, 12, 24]) {
  const p = budgetPlan(out, budget);
  console.log(`\n=== budget=${budget} → mode=${p.mode} picks=${p.picks.length} spend=${p.totalPulls} ===`);
  p.picks.slice(0, 12).forEach((pk, i) => {
    const units = (pk.units || []).map((u) => u.nameCn || u.name).join('、');
    console.log(`  ${i + 1}. [${pk.envLabel || pk.env}] ${pk.pulls}金 ${units ? `补: ${units}` : ''}`);
  });
}
console.log('\npackages 里前 5 套（看 env 分布）:');
const byEnv = {};
for (const pk of out.packages) byEnv[pk.env] = (byEnv[pk.env] || 0) + 1;
console.log('  按 env 计数:', JSON.stringify(byEnv));
out.packages.slice(0, 5).forEach((pk) => console.log(`   env=${pk.env} pulls=${pk.pulls} gain=${pk.gain} value=${pk.value}`));
