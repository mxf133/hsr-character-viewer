// 生成 theherta/unit-availability.json：每个角色/光锥的星级与「是否限定」。
//
// 为什么需要它：抽卡推荐的成本必须只数**限定**单位（用户明确要求）。
// theherta 的数据里没有星级也没有卡池归属，站点给的
// total_limited_5star_count 又不能直接用——实测 87% 的投稿里
// 「限五 + 常驻五 > 4」，说明那个字段把光锥也算进去了，无法拆出角色与光锥。
// 所以这里自己建表：星级取自本地 StarRailRes 副本，限定与否由常驻池名单判定。
//
// 判定规则：
//   限定 = 星级为 5 且 不在常驻池名单里 且 id 不是 24xxx（免费 / 商店 / 活动那批）
//   4★ / 3★ 一律不算限定（4★ 的星魂是抽卡副产品，见 README「星魂怎么判断」）
//
// 常驻池名单是本文件里唯一需要人工维护的部分。两者都是游戏内固定的常驻内容，
// 不随版本变化，所以写死比猜可靠；名单不对时改下面两个 Set 即可。
// 「哪些 5★ 是免费/商店/活动」**不再只靠名单**：见 FREE_CONE_ID_PREFIXES 的 id 判据。
//
// 用法: node tools/herta-availability.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeName } from '../src/server/archive.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** StarRailRes 副本可能的位置（英文表用词与 theherta 一致）。 */
const CHAR_SOURCES = ['.snapref/starrailres-en-characters.json', 'snapref/starrailres-en-characters.json'];
const CONE_SOURCES = ['.snapref/starrailres-en-lightcones.json', 'snapref/starrailres-en-lightcones.json'];

/**
 * 常驻角色池（星轨通票可出）：这 7 位 + 开拓者各命途形态不算限定。
 * 开拓者由主线赠送，任何形态都不需要抽。
 */
export const STANDARD_CHARACTERS = new Set([
  'Bailu', 'Bronya', 'Clara', 'Gepard', 'Himeko', 'Welt', 'Yanqing',
  'Trailblazer (Destruction)', 'Trailblazer (Preservation)', 'Trailblazer (Harmony)',
  'Trailblazer (Remembrance)', 'Trailblazer (Elation)',
]);

/**
 * 不算成本的 5★ 光锥（用户口径：**只有活动跃迁光锥算成本，其他都不算**）。
 *
 * 两类：
 *   1. 常驻跃迁（星轨通票）能出的 5★——就是 7 个常驻 5★ 角色的专武：
 *      银河铁道之夜 / 以世界之名 / 无可取代的东西 / 但战斗还未结束 /
 *      制胜的瞬间 / 如泥酣眠 / 时节不居；
 *   2. 不需要抽的：星芒商店换的（记忆的质料 / 星海巡航 / 记一位星神的陨落）。
 *
 * 4★ 与 3★ 不用列在这里——`rarity <= 4` 一律不计成本（见 build 时的判定）。
 * 新出的 5★ 默认按「活动跃迁」算成本，所以这张表只需要维护「免费」的那几个。
 *
 * ⚠️ **这张人工名单是不够的**（用户第 8 条踩到的就是这个）：24003 Solitary Healing /
 * 24004 Eternal Calculus / 24005 Memory's Curtain Never Falls 三把都不在名单里，
 * 于是被按「要金」算；而它们的叠影在投稿里几乎都是 SI5，一条队伍就凭空多出
 * **5 金**（1 本体 + 4 叠影）。用站点自己的 `total_limited_5star_count` 交叉验证：
 * 修正前只有 22076/29769 = **74.2%** 的投稿对得上，修正后 27929/29769 = **93.8%**
 * （探针 `tools/_probe-superimp6.mjs`、`tools/_probe-superimp9.mjs`）。
 *
 * 所以下面补一条**结构判据**（见 `FREE_CONE_ID_PREFIXES`），不再只靠人工名单。
 */
export const STANDARD_LIGHT_CONES = new Set([
  // 常驻跃迁能出的 7 把（与 7 个常驻 5★ 角色一一对应）
  'Night on the Milky Way',
  'In the Name of the World',
  'Something Irreplaceable',
  "But the Battle Isn't Over",
  'Moment of Victory',
  'Sleep Like the Dead',
  'Time Waits for No One',
  // 星芒商店（不需要跃迁）
  'Texture of Memories',
  'Cruising in the Stellar Sea',
  'On the Fall of an Aeon',
  // 异相仲裁/欢愉玩法提供的 5★ 光锥，不属于限定跃迁；按用户口径不计金。
  'Elation Brimming With Blessings',
]);

/**
 * **结构判据**：5★ 光锥的 id 前缀决定它是不是「跃迁」来的（比人工名单可靠）。
 *
 * StarRailRes 的编号是有规律的，实测本地表 170 把全部符合：
 *
 *   20xxx / 22xxx  3★
 *   21xxx          4★
 *   23xxx          5★ **跃迁**（限定 + 常驻池那 7 把）
 *   24xxx          5★ **免费 / 星芒商店 / 活动赠送** —— 一律不需要抽
 *
 * 24xxx 实测只有 7 把，全部不是限定跃迁：
 *   24000 On the Fall of an Aeon        24001 Cruising in the Stellar Sea
 *   24002 Texture of Memories           24003 Solitary Healing
 *   24004 Eternal Calculus              24005 Memory's Curtain Never Falls
 *   24006 Elation Brimming With Blessings
 *
 * 注意 23xxx **不能**一律算限定：那 7 把常驻池专武的 id 也是 23xxx
 * （23000/23002/23003/23004/23005/23012/23013），仍由 `STANDARD_LIGHT_CONES` 认。
 */
export const FREE_CONE_ID_PREFIXES = ['24'];

const readFirst = async (paths) => {
  for (const rel of paths) {
    try {
      return JSON.parse(await readFile(join(ROOT, rel), 'utf8'));
    } catch {
      /* 试下一个 */
    }
  }
  return null;
};

/** 英文名 → 星级；同名取较高的星级（开拓者等有多条记录）。 */
const rarityIndex = (table) => {
  const exact = new Map();
  const loose = new Map();
  for (const v of Object.values(table || {})) {
    const name = v?.name;
    const rarity = Number(v?.rarity);
    if (!name || !Number.isFinite(rarity)) continue;
    exact.set(name, Math.max(exact.get(name) ?? 0, rarity));
    const key = normalizeName(name);
    loose.set(key, Math.max(loose.get(key) ?? 0, rarity));
  }
  return { exact, loose };
};

/**
 * 英文名 → StarRailRes 的 id（字符串）。
 *
 * 只用来判断「这把 5★ 是不是 24xxx 那批免费的」，所以精确名 + 归一化名两级就够；
 * 查不到就返回 null，调用方按「不是免费的」处理（宁可高估成本，不给免费的假象）。
 */
const idIndex = (table) => {
  const exact = new Map();
  const loose = new Map();
  for (const [id, v] of Object.entries(table || {})) {
    const name = v?.name;
    if (!name || !id) continue;
    if (!exact.has(name)) exact.set(name, String(id));
    const key = normalizeName(name);
    if (!loose.has(key)) loose.set(key, String(id));
  }
  return { exact, loose };
};

const lookupId = (index, name) => {
  const direct = index.exact.get(name);
  if (direct) return direct;
  const viaLoose = index.loose.get(normalizeName(name));
  if (viaLoose) return viaLoose;
  const base = String(name).split(/[（(•·:：\uFF1A]/)[0].trim();
  if (base && base !== name) return index.loose.get(normalizeName(base)) || null;
  return null;
};

const lookupRarity = (index, name) => {
  const direct = index.exact.get(name);
  if (Number.isFinite(direct)) return direct;
  const viaLoose = index.loose.get(normalizeName(name));
  if (Number.isFinite(viaLoose)) return viaLoose;
  // 数据集把命途写成后缀（开拓者•记忆 / March 7th (Hunt)），退回基名再试。
  const base = String(name).split(/[（(•·:：\uFF1A]/)[0].trim();
  if (base && base !== name) {
    const viaBase = index.loose.get(normalizeName(base));
    if (Number.isFinite(viaBase)) return viaBase;
  }
  return null;
};

const main = async () => {
  const [charTable, coneTable] = await Promise.all([
    readFirst(CHAR_SOURCES),
    readFirst(CONE_SOURCES),
  ]);
  if (!charTable || !coneTable) {
    console.error('找不到 StarRailRes 副本（.snapref/starrailres-en-characters.json 等）。');
    console.error('可用 node tools/i18n-fetch-en.mjs 或 tools/bundle-extract.mjs 重新获取。');
    process.exitCode = 1;
    return;
  }
  const charIndex = rarityIndex(charTable);
  const coneIndex = rarityIndex(coneTable);
  const coneIds = idIndex(coneTable);

  const config = JSON.parse(
    await readFile(join(ROOT, 'theherta', 'characters_config.json'), 'utf8'),
  );
  const datasetChars = config.characters || [];
  const datasetCones = config.lightcones || [];

  const missingChars = [];
  const characters = {};
  for (const name of datasetChars) {
    // 开拓者在 StarRailRes 里是 8001-8010 这批「无星级」的玩家角色记录，
    // 星级字段缺失。它是主线赠送的 5★，任何命途形态都不需要抽，
    // 所以这里补一条只针对基名的兜底：星级 5、非限定。
    const isTrailblazer = String(name).split(/[（(•·:：]/)[0].trim() === 'Trailblazer';
    const rarity = lookupRarity(charIndex, name) ?? (isTrailblazer ? 5 : null);
    if (rarity === null) missingChars.push(name);
    characters[name] = {
      rarity,
      // 限定 = 5★ 且不在常驻池。星级缺失时留 null，调用方按「不确定」处理。
      limited: rarity === null ? null : rarity === 5 && !STANDARD_CHARACTERS.has(name),
    };
  }

  const missingCones = [];
  const lightCones = {};
  for (const name of datasetCones) {
    const rarity = lookupRarity(coneIndex, name);
    if (rarity === null) missingCones.push(name);
    // id 前缀判据（见 FREE_CONE_ID_PREFIXES）：24xxx 一律不是限定跃迁。
    // 拿不到 id 时按「不是免费的」处理 —— 新出的 5★ 绝大多数确实是活动跃迁，
    // 默认「要金」比默认「免费」安全（会高估成本，不会白送）。
    const id = lookupId(coneIds, name);
    const freeBySeries = id !== null
      && FREE_CONE_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
    lightCones[name] = {
      id: id || null,
      rarity,
      limited: rarity === null ? null
        : (rarity === 5 && !freeBySeries && !STANDARD_LIGHT_CONES.has(name)),
    };
  }

  const limitedChars = Object.values(characters).filter((v) => v.limited).length;
  const limitedCones = Object.values(lightCones).filter((v) => v.limited).length;
  const payload = {
    version: 2,
    source: 'Mar-7th/StarRailRes index_min/en（本地副本）+ 常驻池名单 + 24xxx 免费光锥 id 判据',
    generatedAt: new Date().toISOString(),
    counts: {
      characters: datasetChars.length,
      lightCones: datasetCones.length,
      limitedCharacters: limitedChars,
      limitedLightCones: limitedCones,
      resolvedCharacters: datasetChars.length - missingChars.length,
      resolvedLightCones: datasetCones.length - missingCones.length,
    },
    missing: { characters: missingChars, lightCones: missingCones },
    standardCharacters: [...STANDARD_CHARACTERS].sort(),
    standardLightCones: [...STANDARD_LIGHT_CONES].sort(),
    freeConeIdPrefixes: [...FREE_CONE_ID_PREFIXES],
    characters,
    lightCones,
  };
  await writeFile(join(ROOT, 'theherta', 'unit-availability.json'),
    `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log('已写出 theherta/unit-availability.json');
  console.log(`  角色 ${datasetChars.length} 个（解析 ${payload.counts.resolvedCharacters}，`
    + `其中限定 ${limitedChars}）`);
  console.log(`  光锥 ${datasetCones.length} 个（解析 ${payload.counts.resolvedLightCones}，`
    + `其中限定 ${limitedCones}）`);
  if (missingChars.length) console.log(`  未匹配角色 ${missingChars.length}: ${missingChars.join('、')}`);
  if (missingCones.length) console.log(`  未匹配光锥 ${missingCones.length}: ${missingCones.join('、')}`);
};

main().catch((err) => {
  console.error('生成单位表失败：', err);
  process.exitCode = 1;
});
