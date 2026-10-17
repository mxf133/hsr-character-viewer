// 中文译名体检：找**缺翻译**和**译错**的名字。
//
// 与既有 `herta-i18n-check.mjs` 的分工：
//
//   * `herta-i18n-check.mjs` —— 只盯**生成物** `theherta/i18n-zh.json`
//     （对游戏内中文、对 archive.json 的覆盖率）。
//   * 本套件 —— 盯**生成物的上游**：首领译名源表在不在、生成物能不能被源表复算出来、
//     以及 archive.json **之外**那些也会把名字显示给用户的数据源
//     （`characters_config` / `unit-availability` / `character_paths` /
//     `lightcone_paths` / `popular_lightcones` / `submission_config` /
//     `character-debut.js` / `character-icon-ids.js`）。
//
// 为什么需要第二段：2026-10-18 实测 `tools/data/hsr-bosses-zh.mjs` **根本没进版本库**，
// 于是 `node tools/herta-i18n.mjs` 直接 `ERR_MODULE_NOT_FOUND`；而 `herta-i18n-check.mjs`
// 只读生成物，照旧全绿 —— 「重建脚本坏了」这件事没人发现。首领译名因此只有一份
// 生成物副本，谁重建一次就掉一批。下面 [1] 就是钉这条的。
//
// 离线优先：官方语言表在 `.snapref/`（gitignore），有就多跑一段一致性，没有就**跳过**
// 而不是失败（跳过 ≠ 通过，见输出里的提示）。
//
// Usage: node tools/i18n-audit.mjs
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(join(ROOT, rel), 'utf8').then(JSON.parse);
const has = (rel) => existsSync(join(ROOT, rel));

let failures = 0;
const fail = (msg) => { failures += 1; console.log(`  ✗ ${msg}`); };
const pass = (msg) => console.log(`  ✓ ${msg}`);
const info = (msg) => console.log(`  · ${msg}`);

const i18n = await read('theherta/i18n-zh.json');

/** 与构建脚本同一套归一化，保证查表口径一致。 */
const normalize = (name) => String(name)
  .toLowerCase()
  .replace(/[:\uFF1A]/g, '(')
  .replace(/[\u2022\u00B7\u30FB]/g, ' ')
  .replace(/[^a-z0-9\u4e00-\u9fff]/g, '');

/** 运行时解析顺序：精确命中 → 归一化 fallback。 */
const zhFor = (table, name) => i18n[table]?.[name]
  || i18n.lookup?.[`${table}:${normalize(name)}`]
  || null;

const HAN = /[\u4e00-\u9fff]/;

// ---------------------------------------------------- [1] 生成物 ↔ 首领源表
//
// 首领名是**唯一一份手工维护**的译名表（角色/光锥都能从游戏文本表 id 配对自动来）。
// 源表一旦丢了，生成物还能读，但再也重建不出来 —— 所以这里不是「文件存在吗」，
// 而是「用源表把生成物重算一遍，能不能逐条对上」。
console.log('[1] 首领译名源表（tools/data/hsr-bosses-zh.mjs）↔ 生成物');

const BOSS_SRC = 'tools/data/hsr-bosses-zh.mjs';
if (!has(BOSS_SRC)) {
  fail(`${BOSS_SRC} 不存在 —— node tools/herta-i18n.mjs 会直接崩（ERR_MODULE_NOT_FOUND）`);
} else {
  // UNC 路径（\\host\share\...）不能直接拼 file:// URL，必须走 pathToFileURL。
  const mod = await import(pathToFileURL(join(ROOT, BOSS_SRC)).href);
  const { BOSSES_ZH, BOSS_VARIANTS } = mod;

  if (!BOSSES_ZH || !Array.isArray(BOSS_VARIANTS)) {
    fail('源表没有导出 BOSSES_ZH / BOSS_VARIANTS');
  } else {
    // 复制 herta-i18n.mjs 的 translateBoss：本表 → 变体 → 角色表。
    const translateBoss = (name) => {
      if (BOSSES_ZH[name]) return BOSSES_ZH[name];
      for (const [pattern, render] of BOSS_VARIANTS) {
        if (!name.match(pattern)) continue;
        const stem = BOSSES_ZH[name.replace(pattern, '')] || i18n.characters[name.replace(pattern, '')];
        return stem ? render(stem) : null;
      }
      return i18n.characters[name] || null;
    };

    const built = i18n.bosses || {};
    const drift = Object.entries(built)
      .filter(([en, zh]) => translateBoss(en) !== zh)
      .map(([en, zh]) => `${en}: 生成物「${zh}」源表算出「${translateBoss(en) ?? '(缺)'}」`);
    const inSrcOnly = Object.keys(BOSSES_ZH).filter((n) => !built[n]).sort();

    if (drift.length === 0) pass(`生成物 ${Object.keys(built).length} 条首领都能由源表复算出来`);
    else fail(`源表与生成物不一致 ${drift.length} 条：${drift.join('；')}`);
    // 源表里多出来的条目不是错误（数据集可能还没用到），但要知道。
    if (inSrcOnly.length) info(`源表里有 ${inSrcOnly.length} 条数据集当前用不到：${inSrcOnly.join(' / ')}`);
  }
}

// ---------------------------------------------------- [2] 官方简中一致性
//
// 只在这台机器已经缓存过游戏文本表时才跑（.snapref/ 是 gitignore 的）。
console.log('\n[2] 与官方简中文本表对照（id 配对，不看账号数据）');

const T = {
  enChars: '.snapref/starrailres-en-characters.json',
  cnChars: '.snapref/starrailres-cn-characters.json',
  enCones: '.snapref/starrailres-en-lightcones.json',
  cnCones: '.snapref/starrailres-cn-lightcones.json',
};
const cached = Object.values(T).every(has);

if (!cached) {
  info('跳过：.snapref/ 没有游戏文本表缓存（先跑 tools/i18n-fetch-en.mjs）');
  info('  注意：raw.githubusercontent.com 在本机会超时，可用 jsDelivr 镜像手抓');
} else {
  const [enChars, cnChars, enCones, cnCones] = await Promise.all(Object.values(T).map(read));

  // 这几个是 herta-i18n.mjs 里**有意**覆盖掉 id 配对的（开拓者形态、皮肤名、
  // 三月七双形态），它们不等于官方值是对的。
  const DELIBERATE = new Set([
    '{NICKNAME}', 'Trailblazer',
    'March 7th (Preservation)', 'March 7th (Hunt)',
  ]);
  const isDeliberate = (en) => DELIBERATE.has(en)
    || /^Trailblazer \(/.test(en)
    || /[•\u2022]/.test(en); // 皮肤 / 形态名：官方写法与站点写法不一样，人工核过

  for (const [label, enMap, cnMap, table] of [
    ['角色', enChars, cnChars, 'characters'],
    ['光锥', enCones, cnCones, 'lightCones'],
  ]) {
    const wrong = [];
    const gone = [];
    let checked = 0;
    for (const id of Object.keys(enMap)) {
      const en = enMap[id]?.name;
      const official = cnMap[id]?.name;
      if (!en || !official) continue;
      const got = zhFor(table, en);
      if (got === undefined || got === null) { gone.push(`${id} ${en}`); continue; }
      if (isDeliberate(en)) continue;
      checked += 1;
      if (got !== official) wrong.push(`${en}: 官方「${official}」映射「${got}」`);
    }
    if (wrong.length === 0) pass(`${label}译名与官方简中一致（${checked} 条逐条比对）`);
    else fail(`${label}有 ${wrong.length} 条与官方简中不一致：${wrong.join('；')}`);
    if (gone.length) fail(`${label}有 ${gone.length} 个 id 在官方表里有中文、映射里却没有：${gone.join(' / ')}`);
  }
}

// ---------------------------------------------------- [3] 全数据源覆盖
//
// `herta-i18n-check.mjs` 只覆盖 archive.json。但下面这些数据源里的名字**同样会
// 显示给用户**（角色列表、限定/常驻标签、光锥偏好、角色详情的命途），
// 缺一条就是界面上冒出一个英文名。
console.log('\n[3] 覆盖率（archive.json 之外的每个数据源都要有中文）');

const used = { characters: new Set(), lightCones: new Set() };
const add = (table, name) => { if (name) used[table].add(name); };

// ⚠️ 同一个字段名在不同文件里**类型不一样**：`characters` 在 characters_config 里是
// 字符串数组，在 unit-availability 里是 `{ 名字: {...} }`。一律按名字收，别假设是数组。
const addNames = (table, value) => {
  if (!value) return;
  if (Array.isArray(value)) value.forEach((n) => add(table, typeof n === 'string' ? n : n?.name));
  else if (typeof value === 'object') Object.keys(value).forEach((n) => add(table, n));
};

for (const rel of ['theherta/characters_config.json', 'theherta/character_paths.json',
  'theherta/lightcone_paths.json', 'theherta/popular_lightcones.json',
  'theherta/unit-availability.json', 'theherta/submission_config.json']) {
  if (!has(rel)) { info(`跳过：${rel} 不存在`); continue; }
  const j = await read(rel);
  const name = rel.split('/').pop();
  addNames('characters', j.characters);
  addNames('lightCones', j.lightcones);
  if (name === 'character_paths.json') addNames('characters', j);
  if (name === 'lightcone_paths.json') addNames('lightCones', j);
  for (const [k, v] of Object.entries(j.popularLightCones || j.popular_lightcones || {})) {
    add('characters', k); add('lightCones', v);
  }
  // submission_config 的副本名走 i18n.modes。
  for (const m of j.modes || []) {
    if (!i18n.modes?.[m]) fail(`副本名缺中文：${m}`);
  }
}

// 服务端两张硬编码表的键也是数据集英文键，写错就永远命中不到。
for (const rel of ['src/server/character-debut.js', 'src/server/character-icon-ids.js']) {
  if (!has(rel)) continue;
  const src = await readFile(join(ROOT, rel), 'utf8');
  for (const m of src.matchAll(/^\s{2}'([^']+)':/gm)) add('characters', m[1]);
}

for (const table of ['characters', 'lightCones']) {
  const missing = [...used[table]].filter((n) => !zhFor(table, n)).sort();
  const label = table === 'characters' ? '角色' : '光锥';
  if (missing.length === 0) pass(`${label}全部有中文（${used[table].size} 个）`);
  else fail(`${label}缺中文 ${missing.length}/${used[table].size}：${missing.join(' / ')}`);
}

// ---------------------------------------------------- [4] 译名体检
console.log('\n[4] 译名体检（漏翻 / 残留占位符 / 撞名）');

// 这两个在简中客户端就保留拉丁名（id 配对出来的值就是这个），不是漏翻。
const LATIN_OK = new Set(['Archer', 'Saber']);
const problems = [];
for (const table of ['characters', 'lightCones', 'bosses']) {
  for (const [en, zh] of Object.entries(i18n[table] || {})) {
    if (!HAN.test(zh) && !LATIN_OK.has(en)) problems.push(`${table}.${en} 没有汉字：「${zh}」`);
    if (/[{}\[\]]/.test(zh) && !/^「.*」$/.test(zh)) problems.push(`${table}.${en} 残留占位符：「${zh}」`);
    if (zh === en && !LATIN_OK.has(en)) problems.push(`${table}.${en} 值与英文键相同（疑似漏翻）`);
  }
}
if (problems.length === 0) pass('没有漏翻 / 占位符残留');
else problems.forEach((p) => fail(p));

// 撞名：不同的英文键渲染成同一个中文。多形态（三月七 / 开拓者 / 丹恒 / 皮肤）
// 是有意的，其余一般是「某个键回落到另一个键的名字」这种真错误。
// `{NICKNAME}` 是米游社战绩里开拓者占位符，`Trailblazer` 是同一实体的站点写法，
// 两者都指向「开拓者」，不是回落错误。
const SAME_ENTITY = new Set(['{NICKNAME}', 'Trailblazer']);
const MULTIFORM = /^三月七（|^开拓者[•\u2022]|•|（绝境）/;
for (const table of ['characters', 'bosses']) {
  const byZh = new Map();
  for (const [en, zh] of Object.entries(i18n[table] || {})) {
    if (MULTIFORM.test(zh)) continue;
    if (SAME_ENTITY.has(en)) continue;
    if (!byZh.has(zh)) byZh.set(zh, []);
    byZh.get(zh).push(en);
  }
  const dup = [...byZh.entries()].filter(([, list]) => list.length > 1);
  if (dup.length === 0) pass(`${table} 没有撞名`);
  else dup.forEach(([zh, list]) => fail(`${table} 撞名：「${zh}」被 ${list.join(' / ')} 共用`));
}

// ---------------------------------------------------- [5] 已知缺口
console.log('\n[5] 已知缺口（界面上会冒英文名，登在这里是为了不让它悄悄扩大）');

const KNOWN = ['Puppets Trio'];
const bossGaps = Object.keys(i18n.report?.missingBosses || {}).length
  ? [] : (i18n.report?.missingBosses || []);
const current = bossGaps.length ? bossGaps
  : ['Puppets Trio'].filter((n) => !zhFor('bosses', n));
const unexpected = current.filter((n) => !KNOWN.includes(n));
if (unexpected.length === 0) {
  info(`未翻译首领 ${current.length} 个（已在已知清单里）：${current.join(' / ')}`);
} else {
  fail(`出现新的未翻译首领：${unexpected.join(' / ')}`);
}

console.log(`\n译名体检: ${failures === 0 ? '全部通过 ✓' : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
