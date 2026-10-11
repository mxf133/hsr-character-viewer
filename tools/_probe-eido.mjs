// 一次性：星魂条目三行探针（定性用）。
//
// 第 1、2 行：两个目标条目的现状（分支归因写在括号里）。
// 第 3 行：配对数据可用性——「建库产物」与「聚合后交给评分器的东西」各数一遍。
//
// 附带 A/B：同一份 envs 跑两遍 buildConclusion（带 eidoPerf = 改后，剥掉 = 改前），
// 用来确认改动只咬星魂条目、没有顺手动到别的东西。
import { readFileSync } from 'node:fs';
import { loadArchive, archiveIndex, archiveTeams } from '../src/server/archive.js';
import { buildConclusion } from '../public/scripts/advice.js';

// ---- 账号状态（与 GUI 同源：data/accounts.json 里的星铁快照）
const store = JSON.parse(readFileSync('data/accounts.json', 'utf8'));
const i18n = JSON.parse(readFileSync('theherta/i18n-zh.json', 'utf8'));
const z2e = {}; for (const [en, cn] of Object.entries(i18n.characters)) z2e[cn] = en;
const c2e = {}; for (const [en, cn] of Object.entries(i18n.lightCones)) c2e[cn] = en;

const ar = await loadArchive();
const dc = new Set(ar.refs.characters);
const dl = new Set(ar.refs.lightCones);
const account = { owned: new Set(), eidolons: new Map(), cones: new Map() };
for (const a of store.accounts || []) {
  const role = (a.roles || []).find((r) => (r.game || 'hsr') === 'hsr');
  if (!role) continue;
  const snap = a.snapshots?.[role.uid] || role.snapshot || a.snapshot;
  for (const c of snap?.characters || []) {
    const en = z2e[c.name] || c.name;
    if (!dc.has(en)) continue;
    account.owned.add(en);
    account.eidolons.set(en, Number(c.rank ?? 0));
    const ce = c2e[c.equip?.name] || c.equip?.name;
    if (ce && dl.has(ce)) account.cones.set(ce, Number(c.equip?.rank ?? 1) || 1);
  }
  break;
}

// ---- 取每个副本的可靠版本（与 src/server/conclusion.js 的 listEnvs 同一口径）
const index = await archiveIndex();
const MODE_ORDER = ['moc', 'pf', 'as', 'aa'];
const minRuns = index.minSeasonRuns ?? 20;
const envs = [];
for (const mode of [...(index.modes || [])].sort((a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode))) {
  for (const stage of mode.stages || []) {
    const seasons = [...(stage.seasons || [])];
    if (!seasons.length) continue;
    let season = seasons[seasons.length - 1];
    let reliable = (stage.seasonRuns?.[season] ?? 0) >= minRuns;
    for (let i = seasons.length - 1; i >= 0; i -= 1) {
      if ((stage.seasonRuns?.[seasons[i]] ?? 0) >= minRuns) { season = seasons[i]; reliable = true; break; }
    }
    const data = await archiveTeams(mode.mode, {
      season, stage: stage.stage, window: 6, withEidoPerf: true,
    });
    if (!data.ok) continue;
    envs.push({
      id: `${mode.mode}${stage.stage ? `/${stage.stage}` : ''}`,
      mode: mode.mode,
      stage: stage.stage || '',
      label: stage.labelCn ? `${mode.labelCn} · ${stage.labelCn}` : mode.labelCn,
      season: data.season, totalRuns: data.totalRuns, recentSeasons: data.recentSeasons,
      reliable: data.reliable, tierLines: data.tierLines,
      lowerIsBetter: data.lowerIsBetter !== false, dist: data.dist || null, teams: data.teams,
    });
  }
}
const availability = index.refs?.availability || {};
const run = (list, acct = account) => buildConclusion(list, { availability, account: acct, perEnvCandidates: 6 });
const after = run(envs);
const before = run(envs.map((e) => ({
  ...e, teams: (e.teams || []).map(({ eidoPerf, ...rest }) => rest),
})));

const row = (out, name) => {
  const idx = out.units.findIndex((u) => u.kind === 'eidolon' && u.name === name);
  return idx < 0 ? null : { rank: idx + 1, of: out.units.length, unit: out.units[idx] };
};
/** 分支归因：直接数该角色在聚合数据里「同一套阵容同时有 from 与 target 两档」的阵容。 */
const pairOf = (name, from, target) => envs.flatMap((e) => (e.teams || [])
  .filter((t) => t.eidoPerf?.[name]?.[from] && t.eidoPerf?.[name]?.[target])
  .map((t) => `${e.id}:${t.rosterKey}（E${from} ${t.eidoPerf[name][from].tier}/成本 ${t.eidoPerf[name][from].cost}`
    + ` → E${target} ${t.eidoPerf[name][target].tier}/成本 ${t.eidoPerf[name][target].cost}）`));
const describe = (out, name, from, target) => {
  const r = row(out, name);
  const pairs = pairOf(name, from, target);
  const branch = pairs.length ? `① 同阵容配对 ${pairs.length} 组` : '① 无配对证据 → 退路';
  const where = r ? r.unit.envs.map((e) => `${e.envLabel}${e.easy ? '·好打' : '·难打'} v=${e.value}`).join(' , ') : '榜上无（每个副本的贡献都是 0）';
  return `${r ? `第 ${r.rank}/${r.of} 名  总性价比 ${r.unit.total}` : '不在榜上'}`
    + `   E${from}→E${target}   [${branch}]   ${where}`;
};

console.log(`1) 花火 (Sparkle)    E2→E3（账号已 E${account.eidolons.get('Sparkle')}）:  ${describe(after, 'Sparkle', 2, 3)}`);
console.log(`2) 刻律德菈 (Cerydra) E0→E1（账号已 E${account.eidolons.get('Cerydra')}）:  ${describe(after, 'Cerydra', 0, 1)}`);

let raw = 0; let rawWith = 0;
for (const m of Object.values(ar.modes || {})) {
  for (const s of Object.values(m.stages || {})) {
    for (const sd of Object.values(s.seasons || {})) {
      for (const t of sd.teams || []) { raw += 1; if (t.eidoPerf && Object.keys(t.eidoPerf).length) rawWith += 1; }
    }
  }
}
const agg = envs.flatMap((e) => e.teams || []);
const aggWith = agg.filter((t) => t.eidoPerf && Object.keys(t.eidoPerf).length).length;
console.log(`3) 配对数据 eidoPerf：archive.json ${rawWith}/${raw} 条 → 聚合后交给评分器 ${aggWith}/${agg.length} 条`);

// ---- A/B：改动前后整个单位榜的差异（确认只咬星魂条目）
const listOf = (out) => out.units.map((u) => `${u.kind === 'eidolon' ? '星魂' : u.kind === 'cone' ? '光锥' : '角色'} ${u.name} ${u.from ?? ''}→${u.target ?? ''}`);
const beforeList = listOf(before);
const afterList = listOf(after);
console.log('\n— A/B（剥掉 eidoPerf = 改动前）：单位榜差异 —');
const byKind = (out) => {
  const n = { char: 0, eidolon: 0, cone: 0 };
  for (const u of out.units) n[u.kind] += 1;
  return `角色 ${n.char} / 星魂 ${n.eidolon} / 光锥 ${n.cone}`;
};
console.log(`  改动前 ${beforeList.length} 条（${byKind(before)}） / 改动后 ${afterList.length} 条（${byKind(after)}）`);
for (const line of beforeList) if (!afterList.includes(line)) console.log(`  - 消失  ${line}`);
for (const line of afterList) if (!beforeList.includes(line)) console.log(`  + 新增  ${line}`);
const eidoOf = (out) => out.units.filter((u) => u.kind === 'eidolon')
  .map((u) => `  第 ${out.units.indexOf(u) + 1} 名 ${u.name} E${u.from}→E${u.target} = ${u.total}`);
console.log('  改动前星魂条目：'); console.log(eidoOf(before).join('\n') || '   （无）');
console.log('  改动后星魂条目：'); console.log(eidoOf(after).join('\n') || '   （无）');

// ---- 连带影响：光锥的「自身贡献」也读同一张配对表（之前它是死代码，恒返回中性 1）
console.log('\n— A/B 里一起消失的光锥，逐个看证据 —');
const cones = beforeList.filter((l) => l.startsWith('光锥') && !afterList.includes(l))
  .map((l) => l.replace(/^光锥\s+/, '').replace(/\s+\d+→\d+$/, ''));
for (const cone of cones) {
  const hits = [];
  for (const e of envs) {
    for (const t of e.teams || []) {
      const carrier = (t.sample?.members || []).find((m) => m.lc === cone)?.char;
      if (!carrier) continue;
      const layered = t.eidoPerf?.[carrier];
      const tiers = layered ? Object.entries(layered).map(([lv, v]) => `E${lv}:${v.tier}/成本${v.cost}`) : [];
      hits.push(`${e.id} 载体 ${carrier} 阵容「${t.rosterKey}」档位画像 [${tiers.join(' ')}]`);
    }
  }
  console.log(`  ${cone}（${i18n.lightCones?.[cone] || cone}）：${hits.length} 处证据`);
  for (const h of hits.slice(0, 6)) console.log(`    · ${h}`);
}

// ---- 候选回归断言的取值（用「只有一个角色」的账号，避免依赖本机快照）
console.log('\n— 可直接写进测试的断言取值 —');
for (const [name, level] of [['Sparkle', 2], ['Cerydra', 0]]) {
  const out = run(envs, { owned: new Set([name]), eidolons: new Map([[name, level]]), cones: new Map() });
  const idx = out.units.findIndex((u) => u.kind === 'eidolon' && u.name === name);
  const cn = i18n.characters?.[name] || name;
  console.log(`  账号只有 ${name}（${cn}）E${level}：`
    + (idx < 0 ? '星魂条目**不在**榜上' : `星魂条目第 ${idx + 1}/${out.units.length} 名 total=${out.units[idx].total}`)
    + `；榜上共 ${out.units.length} 条（星魂 ${out.units.filter((u) => u.kind === 'eidolon').length} 条）`);
}
