// Build English → official Simplified-Chinese name maps for the theherta
// dataset, so the 抽卡推荐 page can show 星穹铁道's real in-game wording instead
// of the site's English locale.
//
// Source of truth: Mar-7th/StarRailRes, which publishes the game's own text
// tables per language under identical numeric ids. Joining index_min/en with
// index_min/cn therefore yields an exact official pair rather than a guess:
//
//   en/characters.json  "1001": { "name": "March 7th" }
//   cn/characters.json  "1001": { "name": "三月七" }
//
// Naming differences the join cannot cover on its own are handled explicitly:
//   * the site writes path variants in parentheses  ("March 7th (Preservation)")
//     while the game keeps them as separate ids,
//   * the site's Trailblazer rows are "Trailblazer (Destruction)" etc., which
//     the game calls 开拓者 with the path NOT in the name,
//   * a handful of community aliases ("SparxiConOfficial").
//
// Output: theherta/i18n-zh.json
// Usage : node tools/herta-i18n.mjs
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchTables, tablePath } from './i18n-fetch-en.mjs';
import { BOSSES_ZH, BOSS_VARIANTS } from './data/hsr-bosses-zh.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'theherta');

/**
 * 图标的绝对地址前缀。StarRailRes 的表里 `icon` / `preview` / `portrait` 都是仓库内
 * 相对路径，实测这些目录都能取到官方高清图，所以直接拼出来给界面用。
 *
 * ⚠️ **不要改回 `raw.githubusercontent.com`。** 那个域名在本机（以及用户的网络下）
 * 直接超时 —— 结果是**全站的头像和光锥图标都是空白**（用户 2026-10 的截图就是这么来的）。
 * 实测可用的镜像有两个，取 jsDelivr：
 *   `cdn.jsdelivr.net/gh/Mar-7th/StarRailRes@master`  → HTTP 200
 *   `gcore.jsdelivr.net/gh/Mar-7th/StarRailRes@master` → HTTP 200
 *   `raw.githubusercontent.com/...`                    → 超时
 *   `cdn.statically.io/gh/...`                         → 超时
 */
const ICON_BASE = 'https://cdn.jsdelivr.net/gh/Mar-7th/StarRailRes@master';

const TABLES = {
  enChars: 'starrailres-en-characters.json',
  cnChars: 'starrailres-cn-characters.json',
  enCones: 'starrailres-en-lightcones.json',
  cnCones: 'starrailres-cn-lightcones.json',
  cnPaths: 'starrailres-cn-paths.json',
  cnElements: 'starrailres-cn-elements.json',
};

/**
 * Read the game's text tables, preferring the .snapref cache so this build runs
 * offline and cannot be broken by a flaky network. A cold cache fetches once.
 */
const loadTables = async () => {
  const missing = Object.values(TABLES).filter((f) => !existsSync(tablePath(f)));
  if (missing.length) {
    console.log(`缓存缺失 ${missing.length} 个文本表，正在下载…`);
    await fetchTables((line) => console.log(line));
  }
  const out = {};
  for (const [key, file] of Object.entries(TABLES)) {
    out[key] = JSON.parse(await readFile(tablePath(file), 'utf8'));
  }
  return out;
};

// ---- name normalisation ---------------------------------------------------
//
// The site and the game disagree on punctuation, and the site is not even
// internally consistent: it writes both "Trailblazer (Destruction)" and
// "Trailblazer: Destruction" for the same character, and drops the exclamation
// marks from "Dance! Dance! Dance!". Rather than enumerate every such case, the
// built file carries an extra `lookup` map keyed by a normalised form so the
// runtime can match punctuation-insensitively.
const normalize = (name) => String(name)
  .toLowerCase()
  // Unify every separator the writers use for a variant suffix.
  .replace(/[:\uFF1A]/g, '(')
  .replace(/[\u2022\u00B7\u30FB]/g, ' ')
  // Drop punctuation and spacing entirely: "Dance! Dance! Dance!" -> "dancedancedance".
  .replace(/[^a-z0-9\u4e00-\u9fff]/g, '');

/** Every punctuation variant of a name that should resolve to the same entry. */
const variantsOf = (name) => {
  const out = new Set([name]);
  // "X (Y)" <-> "X: Y"
  const paren = name.match(/^(.*?)\s*[(\uFF08]([^)\uFF09]+)[)\uFF09]\s*$/);
  if (paren) {
    out.add(`${paren[1]}: ${paren[2]}`);
    out.add(`${paren[1]}\uFF1A${paren[2]}`);
    out.add(`${paren[1]} ${paren[2]}`);
  }
  return [...out];
};

// ---- join two language files on their shared numeric id ---------------------
const pair = (enMap, cnMap) => {
  const out = new Map();
  const missing = [];
  for (const [id, en] of Object.entries(enMap)) {
    const cn = cnMap[id];
    if (!cn || !cn.name) { missing.push(`${id}:${en.name}`); continue; }
    out.set(en.name, cn.name);
  }
  return { map: out, missing };
};

const main = async () => {
  const { enChars, cnChars, enCones, cnCones, cnPaths, cnElements } = await loadTables();

  // The built dataset drives both the boss table and the coverage report, so it
  // is read once up front. Missing (not built yet) is fine: the name maps are
  // still useful and the report simply stays null.
  let archive = null;
  try {
    archive = JSON.parse(await readFile(join(OUT, 'archive.json'), 'utf8'));
  } catch { /* not built yet */ }

  const usedBosses = new Set();
  // v2 数据模型：阵容表在 modes[mode].stages[stage].seasons[season]，
  // 不是早期版本的 modes[mode].seasons。
  const eachTeam = (fn) => {
    for (const mode of Object.values(archive?.modes || {})) {
      for (const stage of Object.values(mode.stages || {})) {
        for (const season of Object.values(stage.seasons || {})) {
          for (const team of season.teams || []) fn(team);
        }
      }
    }
  };
  eachTeam((team) => {
    for (const b of team.bosses || []) usedBosses.add(b.name);
  });
  for (const entry of archive?.schedule || []) {
    for (const info of Object.values(entry.modes || {})) {
      for (const b of info.bosses || []) usedBosses.add(b.name);
    }
  }

  const chars = pair(enChars, cnChars);
  const cones = pair(enCones, cnCones);

  // Paths come back keyed by the English identifier already ("Knight"), which
  // is exactly what the site's character_paths.json uses.
  const paths = {};
  for (const [key, value] of Object.entries(cnPaths)) {
    paths[key] = value.name;
    if (value.text && value.text !== key) paths[value.text] = value.name;
  }

  const elements = {};
  for (const value of Object.values(cnElements)) elements[value.id] = value.name;

  // ---- endgame mode names ---------------------------------------------------
  //
  // These belong here rather than hard-coded in the server so ALL game
  // vocabulary lives in one reviewed file. The English side is what theherta
  // uses as its dataset key; the Chinese side is the official client wording.
  //
  // Two of these are easy to get wrong and were corrected after review:
  //   * Pure Fiction is 虚构叙事, NOT 纯虚构叙事.
  //   * Anomaly Arbitration is 异相仲裁, NOT 异常仲裁.
  // And one is a genuine trap: 忘却之庭 is the UMBRELLA mode (Forgotten Hall),
  // which the game text splits into 回忆 (progression floors) and 混沌回忆 (the
  // rotating 12-floor endgame). The rotating endgame that theherta calls
  // "Memory of Chaos" is therefore 混沌回忆, not 忘却之庭.
  const modes = {
    'Memory of Chaos': '混沌回忆',
    'Pure Fiction': '虚构叙事',
    'Apocalyptic Shadow': '末日幻影',
    'Anomaly Arbitration': '异相仲裁',
  };
  // Short slugs used by the API and the GUI.
  const modeSlugs = {
    moc: 'Memory of Chaos',
    pf: 'Pure Fiction',
    as: 'Apocalyptic Shadow',
    aa: 'Anomaly Arbitration',
  };

  const characters = Object.fromEntries([...chars.map.entries()].sort());
  const lightCones = Object.fromEntries([...cones.map.entries()].sort());

  // ---- explicit cases the id join cannot express ---------------------------
  // Trailblazer: one game entity, but the site lists a row per path.
  for (const [pathEn, pathCn] of Object.entries({
    Destruction: '毁灭', Preservation: '存护', Harmony: '同谐',
    Remembrance: '记忆', Elation: '欢愉',
  })) {
    characters[`Trailblazer (${pathEn})`] = `开拓者•${pathCn}`;
  }
  // "Trailblazer" with no path (the site uses it in some modes).
  characters.Trailblazer = '开拓者';

  // Site-only aliases and community shorthand.
  Object.assign(characters, {
    'Aventurine • Waveflair': '砂金•浪花',
    'Himeko • Nova': '姬子•新星',
    'Dan Heng • Imbibitor Lunae': '丹恒•饮月',
    'Dan Heng • Permansor Terrae': '丹恒•腾荒',
    'Silver Wolf LV.999': '银狼LV.999',
    'March 7th (Preservation)': '三月七（存护）',
    'March 7th (Hunt)': '三月七（巡猎）',
    'Topaz & Numby': '托帕&账账',
  });

  // ---- verified against the game client's own Chinese -----------------------
  //
  // Checked against the Chinese names the miHoYo record API returns for
  // characters the user actually owns, so these are ground truth rather than a
  // best guess:
  //   * the Trailblazer arrives as the "{NICKNAME}" placeholder,
  //   * the site's "Summeretto" skin is 晴歌 in the Chinese client, not a
  //     literal reading of "Summeretto",
  //   * Archer and Saber keep their Latin names even in the Chinese client, so
  //     the id join's value is already correct and must NOT be overridden.
  characters['{NICKNAME}'] = '开拓者';
  characters['Robin • Summeretto'] = '知更鸟•晴歌';
  // 用户按国内米游社 / wiki 的官方名纠正的两个（id join 给的是旧译名）：
  //   Himeko • Nova       官方是「姬子•启行」，不是逐字直译的「姬子•新星」
  //   Aventurine • Waveflair 官方是「砂金•戏浪」，不是「砂金•浪花」
  characters['Himeko • Nova'] = '姬子•启行';
  characters['Aventurine • Waveflair'] = '砂金•戏浪';

  // ---- bosses ---------------------------------------------------------------
  //
  // Bosses come in three flavours (see tools/data/hsr-bosses-zh.mjs). Resolve in
  // order: explicit enemy table -> character table (many bosses ARE playable
  // characters) -> the dataset's English. Variant suffixes are stripped first so
  // "Zandar: Plight" reuses the "Zandar" entry.
  const bosses = {};
  const translateBoss = (name) => {
    // The BOSS table wins over the character table. Several bosses share a name
    // with a playable character (Kafka, Bronya, Zandar, SparxiConOfficial), but
    // the boss form can have a different official name - e.g. SparxiConOfficial
    // is 火花大会@Official as a boss while the character table calls it
    // something else. Only when the boss table has no entry do we fall back to
    // the character table, which covers the plain playable-character bosses.
    if (BOSSES_ZH[name]) return BOSSES_ZH[name];
    for (const [pattern, render] of BOSS_VARIANTS) {
      const match = name.match(pattern);
      if (!match) continue;
      const base = name.replace(pattern, '');
      const stem = BOSSES_ZH[base] || characters[base];
      if (!stem) return null;
      return render(stem, ...match.slice(1));
    }
    return characters[name] || null;
  };
  for (const name of usedBosses) {
    const zh = translateBoss(name);
    if (zh) bosses[name] = zh;
  }

  // ---- lookup index with punctuation-insensitive keys ----------------------
  // Built AFTER every explicit override (and after `bosses`) so an override
  // always wins over the id join.
  const lookup = {};
  for (const [table, source] of [
    ['characters', characters], ['lightCones', lightCones], ['bosses', bosses],
  ]) {
    for (const [en, cn] of Object.entries(source)) {
      for (const variant of variantsOf(en)) {
        lookup[`${table}:${normalize(variant)}`] = cn;
      }
    }
  }

  // ---- coverage report against what the dataset actually contains ----------
  // Runs last because it consults `lookup`.
  let report = null;
  if (archive) {
    const usedChars = new Set(Object.keys(archive.characters || {}));
    const usedCones = new Set();
    // 光锥偏好挂在 characters[name].topLightCones[mode]（v2）。
    // 注意不要用 `Object.values(byMode)` 一层层遍历：v2 里 characters 的同一个
    // 对象上混着 rarity / limited 这些**可能是 null** 的标量字段，
    // `Object.values(null)` 会直接抛 TypeError——这里踩过一次。
    for (const entry of Object.values(archive.characters || {})) {
      for (const list of Object.values(entry?.topLightCones || {})) {
        for (const cone of list || []) usedCones.add(cone.name);
      }
    }
    eachTeam((team) => {
      for (const c of team.roster || []) usedChars.add(c);
    });
    for (const c of Object.keys(archive.refs?.popularLightCones || {})) usedChars.add(c);
    for (const c of Object.values(archive.refs?.popularLightCones || {})) usedCones.add(c);

    const missingChars = [...usedChars]
      .filter((n) => !characters[n] && !lookup[`characters:${normalize(n)}`]).sort();
    const missingCones = [...usedCones]
      .filter((n) => !lightCones[n] && !lookup[`lightCones:${normalize(n)}`]).sort();
    const missingBosses = [...usedBosses].filter((n) => !bosses[n]).sort();
    report = {
      usedCharacters: usedChars.size,
      translatedCharacters: usedChars.size - missingChars.length,
      usedLightCones: usedCones.size,
      translatedLightCones: usedCones.size - missingCones.length,
      usedBosses: usedBosses.size,
      translatedBosses: usedBosses.size - missingBosses.length,
      missingChars,
      missingCones,
      missingBosses,
    };
  }

  // ---- 数字 id → 名字 --------------------------------------------------------
  //
  // 米游社的「战斗记录」里只有数字 id（`avatars: [{id: 1310, ...}]`），没有名字，
  // 所以界面要显示「流萤」就必须有这张表。它同时也是跨数据集的桥：记录给 id，
  // 黑塔网给英文名，两边靠 { id → en } + { en → cn } 对上。
  //
  // 注意开拓者：8001–8009 这些 id 在游戏文本表里**全叫 `{NICKNAME}`**，命途不在
  // 名字里。所以这里只能给到「开拓者」，具体形态由服务端按 `element` 补
  // （见 src/server/records.js 的 TRAILBLAZER_FORMS）。
  const charactersById = {};
  for (const [id, en] of Object.entries(enChars)) {
    const cn = characters[en.name] || cnChars[id]?.name || null;
    if (cn) charactersById[id] = { en: en.name, cn };
  }

  const payload = {
    version: 1,
    source: 'https://github.com/Mar-7th/StarRailRes (index_min/en + index_min/cn)',
    generatedAt: new Date().toISOString(),
    // Community aliases the id join cannot produce.
    aliases: {
      SparxiConOfficial: '斯帕克西（官方演示）',
    },
    // Exact-match tables (human readable, and what the GUI prefers).
    characters,
    lightCones,
    bosses,
    paths,
    elements,
    modes,
    modeSlugs,
    // 数字 id → { en, cn }：战斗记录只有 id，靠它显示名字、并桥到黑塔网的英文名。
    charactersById,
    // 官方高清图标（用户要求界面给角色/光锥配图标）。键是数据集用的英文名。
    //
    // 同时给出 `previews` 与 `portraits`：角色面板要显示**全身立绘 / 光锥卡面**
    // （用户 2026-10 的截图要求），只有 128px 的方图标填不满那两个框。
    // 实测尺寸：character_portrait 2048×2048、character_preview 376×512、
    // light_cone_preview 348×408、light_cone_portrait 亦可用。
    icons: {
      base: ICON_BASE,
      characters: Object.fromEntries(Object.values(enChars)
        .filter((c) => c?.name && c?.icon)
        .map((c) => [c.name, `${ICON_BASE}/${c.icon}`])),
      lightCones: Object.fromEntries(Object.values(enCones)
        .filter((c) => c?.name && c?.icon)
        .map((c) => [c.name, `${ICON_BASE}/${c.icon}`])),
      // 立绘（面板左侧那个大框）。取 preview：376×512 够清晰，又不至于
      // 像 portrait 那样一张 3.4 MB（面板里一次只显示一张，但首屏点击会等）。
      previews: {
        characters: Object.fromEntries(Object.values(enChars)
          .filter((c) => c?.name && c?.preview)
          .map((c) => [c.name, `${ICON_BASE}/${c.preview}`])),
        lightCones: Object.fromEntries(Object.values(enCones)
          .filter((c) => c?.name && c?.preview)
          .map((c) => [c.name, `${ICON_BASE}/${c.preview}`])),
      },
      // 超大立绘（2048×2048）：留给需要放大的场合，界面默认不用。
      portraits: {
        characters: Object.fromEntries(Object.values(enChars)
          .filter((c) => c?.name && c?.portrait)
          .map((c) => [c.name, `${ICON_BASE}/${c.portrait}`])),
        lightCones: Object.fromEntries(Object.values(enCones)
          .filter((c) => c?.name && c?.portrait)
          .map((c) => [c.name, `${ICON_BASE}/${c.portrait}`])),
      },
    },
    // Normalised fallback keys: `${table}:${normalize(name)}` -> Chinese name.
    lookup,
    report,
  };

  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, 'i18n-zh.json'), JSON.stringify(payload, null, 2), 'utf8');

  console.log(`已写出 theherta/i18n-zh.json`);
  console.log(`  角色 ${Object.keys(characters).length} 条  (来自 id 配对 ${chars.map.size}，补 ${Object.keys(characters).length - chars.map.size})`);
  console.log(`  光锥 ${Object.keys(lightCones).length} 条  (来自 id 配对 ${cones.map.size}，补 ${Object.keys(lightCones).length - cones.map.size})`);
  console.log(`  数字 id ${Object.keys(charactersById).length} 条（战斗记录只有 id，靠它显示名字）`);
  console.log(`  命途 ${Object.keys(paths).length} 条，属性 ${Object.keys(elements).length} 条`);
  if (chars.missing.length) console.log(`  英文字典缺中文的 id: ${chars.missing.length}`);
  if (cones.missing.length) console.log(`  光锥英文字典缺中文的 id: ${cones.missing.length}`);

  if (report) {
    console.log(`\n对 archive.json 的覆盖率：`);
    console.log(`  角色 ${report.translatedCharacters}/${report.usedCharacters}`);
    console.log(`  光锥 ${report.translatedLightCones}/${report.usedLightCones}`);
    console.log(`  首领 ${report.translatedBosses}/${report.usedBosses}`);
    if (report.missingChars.length) {
      console.log(`  未翻译角色（${report.missingChars.length}）：`);
      console.log(`    ${report.missingChars.join(' / ')}`);
    }
    if (report.missingCones.length) {
      console.log(`  未翻译光锥（${report.missingCones.length}）：`);
      console.log(`    ${report.missingCones.join(' / ')}`);
    }
    if (report.missingBosses.length) {
      console.log(`  未翻译首领（${report.missingBosses.length}）：`);
      console.log(`    ${report.missingBosses.join(' / ')}`);
    }
  }
};

main().catch((err) => {
  // 打印完整堆栈：只印 message 的话，「Cannot convert undefined or null to
  // object」这种没有上下文的消息根本定位不到是哪一行（踩过）。
  console.error('生成失败:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
