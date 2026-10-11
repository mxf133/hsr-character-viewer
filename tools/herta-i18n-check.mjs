// Audit the Chinese name mapping used by the 抽卡推荐 page.
//
// Two independent checks:
//
//   1. GROUND TRUTH - the miHoYo record API returns characters with the game
//      client's own Chinese names. For every character id the user owns, resolve
//      the English name through Mar-7th/StarRailRes and compare the map's output
//      with what the game itself says. Mismatches here are real bugs.
//
//   2. COVERAGE - every character and light cone the archive actually shows must
//      resolve to a Chinese name, otherwise the page falls back to English for
//      that one row.
//
// Usage: node tools/herta-i18n-check.mjs
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(join(ROOT, rel), 'utf8').then(JSON.parse);

let failures = 0;
const fail = (msg) => { failures += 1; console.log(`  ✗ ${msg}`); };
const pass = (msg) => console.log(`  ✓ ${msg}`);

const i18n = await read('theherta/i18n-zh.json');

/** Same normalisation the builder uses, so lookups agree. */
const normalize = (name) => String(name)
  .toLowerCase()
  .replace(/[:\uFF1A]/g, '(')
  .replace(/[\u2022\u00B7\u30FB]/g, ' ')
  .replace(/[^a-z0-9\u4e00-\u9fff]/g, '');

/** Resolve an English name the way the runtime will: exact, then normalised. */
const zhFor = (table, name) => i18n[table]?.[name]
  || i18n.lookup?.[`${table}:${normalize(name)}`]
  || null;

// ---------------------------------------------------------------- 1. truth
console.log('[1] 与游戏内中文对照（miHoYo 战绩接口返回的真实中文名）');

const EN_CHARS = '.snapref/starrailres-en-characters.json';
const EN_CONES = '.snapref/starrailres-en-lightcones.json';

if (!existsSync(join(ROOT, EN_CHARS)) || !existsSync(join(ROOT, EN_CONES))) {
  console.log('  跳过：缺少英文字典缓存，先运行 tools/i18n-fetch-en.mjs');
} else {
  const [enChars, enCones, accounts] = await Promise.all([
    read(EN_CHARS), read(EN_CONES), read('data/accounts.json'),
  ]);

  // id -> the game's own Chinese name
  const truthChar = new Map();
  const truthCone = new Map();
  for (const account of accounts.accounts || []) {
    for (const snapshot of Object.values(account.snapshots || {})) {
      if (snapshot.game && snapshot.game !== 'hsr') continue;
      for (const c of snapshot.details || snapshot.characters || []) {
        if (c.id && c.name) truthChar.set(String(c.id), c.name);
        // NOTE: the light cone id lives on `equip.id`, not `equip.item_id`.
        if (c.equip?.id && c.equip?.name) truthCone.set(String(c.equip.id), c.equip.name);
      }
    }
  }

  if (!truthChar.size) {
    console.log('  跳过：账号快照里没有星铁角色（先扫码登录并读取角色信息）');
  } else {
    let checked = 0;
    let mismatch = 0;
    for (const [id, cn] of truthChar) {
      const en = enChars[id]?.name;
      if (!en) continue; // not in the dictionary; not the map's fault
      checked += 1;
      const mapped = zhFor('characters', en);
      if (mapped !== cn) {
        mismatch += 1;
        fail(`id=${id} EN='${en}'  游戏='${cn}'  映射='${mapped ?? '(缺)'}'`);
      }
    }
    if (mismatch === 0) pass(`角色 ${checked}/${checked} 个与游戏内中文一致`);
    else fail(`角色有 ${mismatch}/${checked} 个与游戏内中文不一致`);

    let cChecked = 0;
    let cMismatch = 0;
    for (const [id, cn] of truthCone) {
      const en = enCones[id]?.name;
      if (!en) continue;
      cChecked += 1;
      const mapped = zhFor('lightCones', en);
      if (mapped !== cn) {
        cMismatch += 1;
        fail(`光锥 id=${id} EN='${en}'  游戏='${cn}'  映射='${mapped ?? '(缺)'}'`);
      }
    }
    if (cChecked === 0) console.log('  · 快照里没有可对照的光锥（角色未装备光锥）');
    else if (cMismatch === 0) pass(`光锥 ${cChecked}/${cChecked} 个与游戏内中文一致`);
    else fail(`光锥有 ${cMismatch}/${cChecked} 个与游戏内中文不一致`);
  }
}

// ---------------------------------------------------------------- 2. coverage
console.log('\n[2] 覆盖率（archive.json 里出现的每个名字都要有中文）');

if (!existsSync(join(ROOT, 'theherta/archive.json'))) {
  console.log('  跳过：theherta/archive.json 不存在');
} else {
  const archive = await read('theherta/archive.json');

  const usedChars = new Set(Object.keys(archive.characters || {}));
  for (const name of Object.keys(archive.refs?.popularLightCones || {})) usedChars.add(name);

  const usedCones = new Set();
  // v2 数据模型：光锥偏好挂在 characters[name].topLightCones[mode]，
  // 阵容表在 modes[mode].stages[stage].seasons[season].teams。
  for (const entry of Object.values(archive.characters || {})) {
    for (const list of Object.values(entry?.topLightCones || {})) {
      for (const cone of list || []) usedCones.add(cone.name);
    }
  }
  for (const name of Object.values(archive.refs?.popularLightCones || {})) usedCones.add(name);

  /** 遍历所有 (关卡, 版本) 的阵容行。 */
  const eachTeam = (fn) => {
    for (const mode of Object.values(archive.modes || {})) {
      for (const stage of Object.values(mode.stages || {})) {
        for (const season of Object.values(stage.seasons || {})) {
          for (const team of season.teams || []) fn(team);
        }
      }
    }
  };
  // Team rosters reference characters too.
  eachTeam((team) => {
    for (const name of team.roster || []) usedChars.add(name);
  });

  const missingChars = [...usedChars].filter((n) => !zhFor('characters', n)).sort();
  const missingCones = [...usedCones].filter((n) => !zhFor('lightCones', n)).sort();

  // Bosses appear in each team's `bosses` list and in the season schedule.
  const usedBosses = new Set();
  eachTeam((team) => {
    for (const b of team.bosses || []) usedBosses.add(b.name);
  });
  for (const entry of archive.schedule || []) {
    for (const info of Object.values(entry.modes || {})) {
      for (const b of info.bosses || []) usedBosses.add(b.name);
    }
  }
  const missingBosses = [...usedBosses].filter((n) => !zhFor('bosses', n)).sort();

  // Boss labels the site uses that could NOT be matched to a Chinese in-game
  // name. They are paraphrases for multi-enemy stages (the wiki's enemy table has
  // no such encounter), so the UI deliberately shows the site's English label
  // with a （源名） marker instead of an invented translation.
  //
  // This list must stay SHORT and explicit: any name not on it that lacks a
  // Chinese form is a real gap and fails the check.
  //
  // Septimus used to be here; it is resolved now (神主日／神主日（绝境）), and the
  // check below asserts that explicitly so a regression cannot hide behind the
  // "known unresolved" list.
  const KNOWN_UNRESOLVED_BOSSES = new Set(['Puppets Trio']);
  const MUST_RESOLVE = {
    Septimus: '神主日',
    'Septimus: Plight': '神主日（绝境）',
  };
  // A variant ("Septimus: Plight") inherits its base name's status.
  const isKnownUnresolved = (name) => {
    if (KNOWN_UNRESOLVED_BOSSES.has(name)) return true;
    const base = String(name)
      .replace(/\s*[(（](?:Plight|K\d)[)）]\s*$/i, '')
      .replace(/:\s*Plight\s*$/i, '')
      .trim();
    return KNOWN_UNRESOLVED_BOSSES.has(base);
  };
  const unresolved = missingBosses.filter(isKnownUnresolved);
  const realGaps = missingBosses.filter((n) => !isKnownUnresolved(n));

  // Names that were previously unresolved and are now translated: assert the
  // exact string, because "Septimus" resolving to something else would be worse
  // than not resolving at all.
  const wrongNames = Object.entries(MUST_RESOLVE)
    .filter(([name, expected]) => usedBosses.has(name) && zhFor('bosses', name) !== expected)
    .map(([name, expected]) => `${name}: 期望「${expected}」实际「${zhFor('bosses', name) ?? '(缺)'}」`);
  // 后缀写法必须统一：站点对同一件事有 `X (Plight)` 与 `X: Plight` 两种写法，
  // 混用会出现「同一首领两种名字」。
  const plightForms = [...usedBosses]
    .filter((n) => /plight/i.test(n))
    .map((n) => [n, zhFor('bosses', n)])
    .filter(([, zh]) => zh && !zh.endsWith('（绝境）'));

  // Endgame mode names live in i18n.modes, keyed by the site's English name.
  // These are asserted by value because several were wrong first time round:
  // 虚构叙事 (not 纯虚构叙事), 异相仲裁 (not 异常仲裁), and 混沌回忆 (not
  // 忘却之庭, which is the umbrella mode that CONTAINS 混沌回忆).
  const EXPECTED_MODES = {
    'Memory of Chaos': '混沌回忆',
    'Pure Fiction': '虚构叙事',
    'Apocalyptic Shadow': '末日幻影',
    'Anomaly Arbitration': '异相仲裁',
  };
  const modeProblems = [];
  for (const [en, expected] of Object.entries(EXPECTED_MODES)) {
    const got = i18n.modes?.[en];
    if (got !== expected) modeProblems.push(`${en}: 期望「${expected}」实际「${got ?? '(缺)'}」`);
  }
  if (Object.keys(i18n.modeSlugs || {}).length !== 4) modeProblems.push('modeSlugs 应含 4 个短码');

  if (missingChars.length === 0) pass(`角色全部有中文（${usedChars.size} 个）`);
  else fail(`角色缺中文 ${missingChars.length}/${usedChars.size}：${missingChars.join(' / ')}`);

  if (missingCones.length === 0) pass(`光锥全部有中文（${usedCones.size} 个）`);
  else fail(`光锥缺中文 ${missingCones.length}/${usedCones.size}：${missingCones.join(' / ')}`);

  if (realGaps.length === 0) {
    const total = usedBosses.size;
    pass(`首领全部有中文（${total - unresolved.length}/${total}`
      + (unresolved.length ? `；${unresolved.length} 个明确标为未解决：${unresolved.join(' / ')}` : '') + '）');
  } else {
    fail(`首领缺中文 ${realGaps.length}/${usedBosses.size}：${realGaps.join(' / ')}`
      + `（未在已知未解决清单里：${[...KNOWN_UNRESOLVED_BOSSES].join(' / ')}）`);
  }

  if (wrongNames.length === 0) pass('神主日 / 神主日（绝境）译名正确');
  else fail(`译名有误：${wrongNames.join('；')}`);

  if (plightForms.length === 0) pass('所有「绝境」变体写法统一为（绝境）');
  else fail(`「绝境」后缀不统一：${plightForms.map(([n, zh]) => `${n}→${zh}`).join('；')}`);

  // paths + elements must cover whatever the dataset references
  const usedPaths = new Set(Object.values(archive.refs?.characterPaths || {}));
  for (const name of Object.values(archive.refs?.lightConePaths || {})) usedPaths.add(name);
  const missingPaths = [...usedPaths].filter((p) => !i18n.paths?.[p]).sort();
  if (missingPaths.length === 0) pass(`命途全部有中文（${usedPaths.size} 个）`);
  else fail(`命途缺中文：${missingPaths.join(' / ')}`);

  if (modeProblems.length === 0) pass('四个副本名都是官方简中（虚构叙事 / 异相仲裁）');
  else fail(`副本名有误：${modeProblems.join('；')}`);
}

console.log(`\n中文映射检查: ${failures === 0 ? '全部通过 ✓' : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
