// 探针：某个整包在某个副本的**逐版本投稿覆盖**（为什么缺证据 / 有没有出现过）。
//
// 回答「为什么 XX 排名靠后」时最关键的一问往往是：它到底有没有出现在最新版本里？
// 本探针把该整包所在队伍在 `frontierRows` 里的**每一次出现**都列出来（版本 / 档位 /
// 行动值 / 金数 / 队伍成员），并标出哪些版本一条都没有。
//
// 用法：
//   node tools/_probe-evidence.mjs --find=遐蝶 --env=aa/plight
//   node tools/_probe-evidence.mjs --find=遐蝶 --all
import { archiveIndex, archiveFrontierAll, loadI18n, zhName } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';
import { buildConclusion, eidolonTierOf, VERSION_WINDOW } from '../src/core/advice.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const FIND = arg('find', '遐蝶');
const ONLY_ENV = arg('env', null);

const index = await archiveIndex();
const i18n = await loadI18n();
const cn = (n) => zhName(i18n, 'characters', n) || n;
const coneCn = (n) => (n ? (zhName(i18n, 'lightCones', n) || n) : '—');

const { envs } = await conclusionEnvs(index);
const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
const result = buildConclusion(envs, {
  availability: index.refs?.availability || {},
  firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
  account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
  frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
  frontierWeights: Object.fromEntries(frontierAll.map((f) => [f.env, f.weight])),
});

const target = result.frontierUnits.find((u) => cn(u.name).includes(FIND));
if (!target) { console.log(`榜上找不到「${FIND}」`); process.exit(1); }
console.log(`=== ${cn(target.name)} E${target.eidolon} + ${coneCn(target.lc)}S${target.superimp}`
  + `   总分 ${Math.round(target.total)} / 榜上 ${result.frontierUnits.length} 条\n`);

const targets = (target.envs || []).map((e) => e.id);
if (ONLY_ENV) targets.splice(targets.indexOf(ONLY_ENV), 1);

for (const id of targets) {
  const meta = result.frontierEnvs?.find((m) => m.id === id);
  const rows = frontierAll.find((f) => f.env === id)?.frontierRows || [];
  console.log(`--- ${meta?.envLabel || id}   窗口 ${JSON.stringify(meta?.seasons)}`);
  console.log(`    前沿共 ${rows.length} 条；该整包登场版本 ${target.bornSeason ?? '—'}`);

  // ① 这一整包（角色+光锥+叠影全同）出现在哪些投稿里
  const exact = rows.filter((r) => r.members.some((m) => m.char === target.name
    && eidolonTierOf(m.eidolon) === target.eidolon
    && (m.lc || null) === (target.lc || null)
    && Number(m.superimp) === Number(target.superimp)));
  // ② 放宽：只要这个**角色**在队里（星魂档 / 光锥不同也算）
  const withChar = rows.filter((r) => r.members.some((m) => m.char === target.name));
  // ③ 再放宽：角色本人在场（任何星魂档、任何光锥）
  const bySeasonExact = new Map();
  for (const r of exact) bySeasonExact.set(r.season, (bySeasonExact.get(r.season) || 0) + 1);
  const bySeasonChar = new Map();
  for (const r of withChar) bySeasonChar.set(r.season, (bySeasonChar.get(r.season) || 0) + 1);

  console.log('    版本   整包精确命中   角色在场（任意档/光锥）');
  for (const s of [...(meta?.seasons || [])].reverse()) {
    const a = bySeasonExact.get(s) || 0;
    const b = bySeasonChar.get(s) || 0;
    console.log(`    ${s}   ${String(a).padStart(10)}   ${String(b).padStart(20)}`
      + `${a ? '' : b ? '   ← 只是档位/光锥不同' : '   ← 该版本前沿里完全没有这个角色'}`);
  }
  if (exact.length) {
    console.log(`    该整包在前沿里的每一次出现：`);
    for (const r of exact) {
      console.log(`      ${r.season}  ${r.tier === 'perfect' ? '满分' : '达标'}`
        + `  av=${r.actionValue}  ${r.cost}金  `
        + r.members.map((m) => `${cn(m.char)}E${m.eidolon}`
          + `${m.lc ? `+${coneCn(m.lc)}S${m.superimp}` : ''}`).join(' + '));
    }
  }
  if (withChar.length > exact.length) {
    console.log(`    仅角色在场、但档位/光锥不匹配的那几条（所以没算到它头上）：`);
    for (const r of withChar.filter((x) => !exact.includes(x)).slice(0, 8)) {
      const mine = r.members.find((m) => m.char === target.name);
      console.log(`      ${r.season}  ${r.tier === 'perfect' ? '满分' : '达标'}`
        + `  av=${r.actionValue}  ${r.cost}金  ${cn(mine.char)}E${mine.eidolon}`
        + `${mine.lc ? `+${coneCn(mine.lc)}S${mine.superimp}` : '（无光锥）'}`
        + `   队伍 ${r.members.map((m) => cn(m.char)).join('+')}`);
    }
  }
  console.log('');
}
