/**
 * 探针：强度用的是「哪一行证据」—— 是**最快**的那行，还是**含金数项分最高**的那行？
 *   node tools/_probe-strength-row.mjs [--char=缇宝] [--env=aa/plight]
 */
import { eidolonTierOf } from '../public/scripts/advice.js';
import { archiveFrontierAll, archiveIndex, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const wantChar = arg('char', '缇宝');
const wantEnv = arg('env', 'aa/plight');

const index = await archiveIndex();
const i18n = await loadI18n();
const cn = (n) => zhName(i18n, 'characters', n) || n;
const zhToEn = {};
for (const c of index.refs?.characters || []) if (c.nameCn) zhToEn[c.nameCn] = c.name;
const charKey = zhToEn[wantChar] || wantChar;
const { envs } = await conclusionEnvs(index, { window: 6 });
const fa = await archiveFrontierAll(envs, { window: 6 });
const env = fa.find((f) => f.env === wantEnv);
const rows = env?.frontierRows || [];
const keyOf = (m) => `${m.char}|E${eidolonTierOf(m.eidolon)}|${m.lc || '-'}|S${Math.max(1, Math.round(Number(m.superimp) || 1))}`;
const wantPack = arg('pack', '');
const mine = rows.filter((r) => (r.members || []).some((m) => m.char === charKey && (!wantPack || keyOf(m).includes(wantPack))));
console.log(`${wantChar}（${charKey}）在 ${wantEnv}：${mine.length} 行`);
const bySeason = new Map();
for (const r of mine) {
  const s = String(r.season || '');
  (bySeason.get(s) || bySeason.set(s, []).get(s)).push(r);
}
for (const [s, list] of bySeason) {
  list.sort((a, b) => Number(a.actionValue) - Number(b.actionValue));
  console.log(`\n版本 ${s}：`);
  for (const r of list.slice(0, 6)) {
    const pack = r.members.find((m) => m.char === charKey);
    console.log(`  av ${String(r.actionValue).padStart(5)}｜队金 ${String(r.cost).padStart(2)}`
      + `｜该期最省 ${String(r.seasonMinCost ?? '—').padStart(2)}`
      + `｜档 ${r.tier}｜整包 ${keyOf(pack)}`
      + `｜队友 ${r.members.map((m) => cn(m.char)).join('/')}`);
  }
  if (list.length > 6) console.log(`  …共 ${list.length} 行`);
}
