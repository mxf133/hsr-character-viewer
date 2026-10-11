// 一次性：星魂条目现状（花火 E3 是否被算掉）。看完即删。
import { readFileSync } from 'node:fs';
const B = 'http://127.0.0.1:8360';
const cfg = await (await fetch(`${B}/api/config`)).json();
const a = cfg.accounts[0];
const r = (a.roles || []).find((x) => (x.game || 'hsr') === 'hsr');
const s = (await (await fetch(`${B}/api/accounts/${a.id}/roles/${r.uid}/snapshot`)).json()).snapshot;
const ar = JSON.parse(readFileSync('theherta/archive.json', 'utf8'));
const i18n = JSON.parse(readFileSync('theherta/i18n-zh.json', 'utf8'));
const z2e = {}; for (const [en, cn] of Object.entries(i18n.characters)) z2e[cn] = en;
const c2e = {}; for (const [en, cn] of Object.entries(i18n.lightCones)) c2e[cn] = en;
const dc = new Set(ar.refs.characters); const dl = new Set(ar.refs.lightCones);
const owned = []; const eid = {}; const cones = {};
for (const c of (s.characters || [])) {
  const en = z2e[c.name] || c.name;
  if (dc.has(en)) { owned.push(en); eid[en] = Number(c.rank ?? 0); }
  const ce = c2e[c.equip?.name] || c.equip?.name;
  if (ce && dl.has(ce)) cones[ce] = Number(c.equip.rank ?? 1) || 1;
}
const concl = await (await fetch(`${B}/api/archive/conclusion`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ account: { owned, eidolons: eid, cones }, window: '6' }),
})).json();
console.log(`单位 ${concl.units.length} 个 | 星魂条目：`);
concl.units.forEach((u, i) => {
  if (u.kind !== 'eidolon') return;
  console.log(`  第 ${i + 1} 名  ${(u.nameCn || u.name).padEnd(12)} E${u.from} → E${u.target}  性价比 ${(u.total * 100).toFixed(0)}`);
});
