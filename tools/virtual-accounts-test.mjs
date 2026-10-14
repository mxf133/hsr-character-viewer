// 虚拟账号的**预设**与**自定义名单**（用户 2026-10-13 第 3、4 条）。
//
// 为什么单独一个套件（而不是塞进 `e2e-test.mjs`）：这里要**按金数口径加总**
// （「20/50/100 限定金」是用户点名的数字），而那需要 `charCostOf` / `coneCostOf`
// 与真实的资料表；HTTP 那一层只钉「接口通不通、收口对不对」，见 `e2e-test.mjs`
// 的「自定义角色名单」一节。
//
//   node tools/virtual-accounts-test.mjs
import assert from 'node:assert/strict';
import {
  HIDDEN_COST_SETTINGS, charCostOf, coneCostOf, eidolonsOf, ownedCharacters,
} from '../public/scripts/advice.js';
import { archiveIndex, loadI18n } from '../src/server/archive.js';
import {
  TRAILBLAZER_AVATARS, VIRTUAL_PRESETS, buildVirtualAccount, customRosterPreset, normalizeRoster,
  presetContext, presetContextRefs, withSignatureCones,
} from '../src/server/virtual-accounts.js';
// 编辑器的**决策逻辑**（哪些光锥可选 / 默认配哪把）：留在浏览器里那段没有回归
// （CDP 套件要真浏览器，本机跑不到），所以它被抽成纯函数在这条链上测。
import { coneChoicesFor, defaultConeFor } from '../public/scripts/virtual-roster.js';

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
};

// ⚠️ **必须过 `withSignatureCones()`**（用户 2026-10-14 第 1 条）：它把「真正的专属光锥」
// 表挂到 `refs` 上。少了这一步，`signatureConeOf` 会退回「最常用光锥」，于是平铺档
// 21 个角色没有光锥 —— 那正是这个套件要钉住的 bug，测试自己也必须走生产同一条路。
const index = await withSignatureCones(await archiveIndex());
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const ctx = presetContext({
  availability,
  firstSeen: index.refs?.firstSeen?.characters,
  charCostOf, coneCostOf,
  ...presetContextRefs(index),
});

const presetOf = (id) => {
  const preset = VIRTUAL_PRESETS.find((p) => p.id === id);
  assert.ok(preset, `缺预设 ${id}`);
  return preset;
};
/** 冻结**一次**抽样再构造账号：随机预设每次 `spec()` 都是一份新名单。 */
const buildFrozen = (id) => {
  const preset = presetOf(id);
  const spec = preset.spec(ctx);
  const account = buildVirtualAccount({
    preset: { ...preset, spec: () => spec },
    index, i18n, availability, charCostOf, coneCostOf,
    uid: '900001', accountId: `virtual-${id}`,
  });
  return { spec, rows: account.snapshots['900001'].characters || [] };
};

// 角色身份：优先用**数字 id**（快照行带着它，权威且不受译名重复影响），
// 退回「中文名 → 英文键」的反向表。
const idToEn = new Map();
for (const [id, v] of Object.entries(i18n.charactersById || {})) {
  if (v?.en) idToEn.set(Number(id), v.en);
}
const zhToEn = new Map(Object.entries(i18n.characters).map(([en, zh]) => [zh, en]));
const zhToEnCone = new Map(Object.entries(i18n.lightCones).map(([en, zh]) => [zh, en]));
/**
 * 快照行 → 数据集英文键（金数口径要用它）。
 *
 * ⚠️ **不能只按 id 反查**：三月七的两个命途在 `charactersById` 里**都写成
 * `March 7th`**（1001 与 1224 同名），于是按 id 解出来的键**不在**
 * `availability.characters` 里，而 `charCostOf(未知键)` 走的是「保守按限定算」
 * 那条兜底（实测返回 1）—— 两行会凭空各多 1 金。所以补两级：
 *   ① id 解出来的键**必须在资料表里**才认；
 *   ② 否则按「中文名 + 命途」在资料表里配对（`March 7th (Hunt)` 的 path 是 Rogue）。
 */
const charKeyOf = (row) => {
  const viaId = idToEn.get(Number(row.id));
  if (viaId && availability.characters?.[viaId]) return viaId;
  const viaName = zhToEn.get(row.name);
  if (viaName && availability.characters?.[viaName]) return viaName;
  const candidates = Object.keys(availability.characters || {})
    .filter((k) => i18n.characters?.[k] === row.name);
  if (candidates.length === 1) return candidates[0];
  const byPath = candidates.find((k) => index.refs?.characterPaths?.[k] === row.path);
  if (byPath) return byPath;
  return viaName || viaId || row.name;
};
const coneKeyOf = (row) => (row.equip
  ? (zhToEnCone.get(row.equip.name) || row.equip.name) : null);

/** 按**本仓库的金数口径**给名单加总：本体 + 星魂级数 + 光锥本体 × 叠影。 */
const goldOfRows = (rows) => rows.reduce((n, row) => {
  const body = charCostOf(charKeyOf(row), availability);
  const eid = Math.max(0, Number(row.actived_constellation_num) || 0);
  const cone = coneKeyOf(row);
  const coneGold = cone ? coneCostOf(cone, availability) * Math.max(1, row.equip.rank) : 0;
  return n + body + (body > 0 ? eid : 0) + coneGold;
}, 0);

/** 名单（spec）本身的金数：与上面同一条口径，用来证明「生成时就记对了账」。 */
const goldOfSpec = (spec) => {
  let n = 0;
  for (const [key, tier] of Object.entries(spec.chars || {})) {
    const body = charCostOf(key, availability);
    n += body + (body > 0 ? Math.max(0, Number(tier) || 0) : 0);
  }
  for (const [key, sup] of Object.entries(spec.cones || {})) {
    n += coneCostOf(key, availability) * Math.max(1, Math.round(Number(sup) || 1));
  }
  return n;
};

/**
 * **增量金数**：`spec` 相对 `base`（= 大隐金 MAX）新增了多少限定金。
 *
 * 为什么必须按增量算（用户 2026-10-14 第 2 条）：三个随机档的语义已经从
 * 「一共投 20/50/100 金」改成「**在大隐金 MAX 基础上再投 50/100/200 金**」——
 * 基底的 16 金（大隐金 16 人各 1 金本体）**不算**在内。
 * 口径细节：基底已经拥有的角色，**本体的 1 金已经付过**，只算星魂的差额
 *（`E0→E6` 是 6 金，不是 7 金）；锥按新增的那些算。
 */
const goldDeltaOfSpec = (spec, base) => {
  let n = 0;
  for (const [key, tier] of Object.entries(spec.chars || {})) {
    const body = charCostOf(key, availability);
    if (body <= 0) continue;
    const before = base.chars?.[key];
    const t = Math.max(0, Number(tier) || 0);
    const b = Math.max(0, Number(before) || 0);
    if (before !== undefined && before === tier) continue;
    n += (before === undefined ? 1 : 0) + (t - b);
  }
  for (const [key, sup] of Object.entries(spec.cones || {})) {
    if (base.cones?.[key] !== undefined) continue;
    n += coneCostOf(key, availability) * Math.max(1, Math.round(Number(sup) || 1));
  }
  return n;
};

const hiddenGroup = (id) => {
  for (const group of HIDDEN_COST_SETTINGS) {
    for (const row of group.rows) if (row.id === id) return row.units || [];
  }
  return [];
};

console.log('\n▶ 虚拟账号 · 数据集上下文');
check('常驻 5★ = 7 个，且都在资料表里标成「非限定」', () => {
  assert.equal(ctx.standardChars.length, 7, `实际 ${JSON.stringify(ctx.standardChars)}`);
  for (const c of ctx.standardChars) {
    assert.equal(availability.characters[c]?.rarity, 5, `${c} 星级不是 5`);
    assert.equal(availability.characters[c]?.limited, false, `${c} 在资料表里不是常驻`);
  }
});
check('⭐ 常驻的「专属光锥」是本人的专武，而不是「最常用光锥」那张表', () => {
  // 实测 `popularLightCones` 对常驻角色经常给非专武：姬子 → 谐乐静默之后、
  // 白露 → 一场术后对话（4★）、瓦尔特 → 决心如汗珠般闪耀（4★）。
  // 用户 2026-10-13 第 4 条要的是**专武**，所以这 7 对必须与 5★ 常驻光锥对得上。
  const expect = {
    Himeko: 'Night on the Milky Way',
    Welt: 'In the Name of the World',
    Bronya: 'But the Battle Isn\'t Over',
    Gepard: 'Moment of Victory',
    Clara: 'Something Irreplaceable',
    Bailu: 'Time Waits for No One',
    Yanqing: 'Sleep Like the Dead',
  };
  for (const [char, cone] of Object.entries(expect)) {
    assert.equal(ctx.signatureConeOf(char), cone, `${char} 的专属锥`);
    assert.equal(availability.lightCones[cone]?.rarity, 5, `${cone} 不是 5★`);
    // 命途必须一致（「同命途光锥」是用户第 3 条的硬约束）
    assert.equal(ctx.lightConePaths[cone], index.refs?.characterPaths?.[char],
      `${char} 与 ${cone} 命途不一致`);
  }
});
check('大隐金 = 隐金设置的「赠送 + 兑换」两组角色，且都在资料表里', () => {
  const gift = hiddenGroup('gift');
  const exchange = hiddenGroup('exchange');
  assert.ok(gift.length > 0 && exchange.length > 0, '两组名单取不到');
  for (const key of [...gift, ...exchange]) {
    assert.ok(availability.characters[key], `${key} 不在资料表里`);
  }
  assert.equal(new Set([...gift, ...exchange]).size, 16, '两组应当共 16 个互不重复的角色');
});
check('lightConePaths 覆盖全部光锥（自定义角色筛命途要用）', () => {
  const cones = Object.keys(availability.lightCones || {});
  const missing = cones.filter((c) => !ctx.lightConePaths[c]);
  assert.equal(missing.length, 0, `缺 ${missing.slice(0, 5).join(', ')}`);
});
check('每个角色都有合法的专属光锥（命途一致）', () => {
  const bad = [];
  for (const key of Object.keys(availability.characters || {})) {
    const cone = ctx.signatureConeOf(key);
    if (!cone) continue;
    if (ctx.lightConePaths[cone] !== index.refs?.characterPaths?.[key]) bad.push(`${key}→${cone}`);
  }
  assert.equal(bad.length, 0, `命途不一致：${bad.slice(0, 5).join(' / ')}`);
});

console.log('\n▶ 无成本账号 / 大隐金 MAX（用户 2026-10-13 第 4 条）');
check('无成本账号：限定金 0，常驻 E0 + 各自专锥 S1', () => {
  const { rows } = buildFrozen('zero-cost');
  const limited = rows.filter((r) => charCostOf(charKeyOf(r), availability) > 0);
  assert.equal(limited.length, 0, `不该有限定角色，实际 ${limited.map(charKeyOf).join(',')}`);
  const std = new Map(rows.map((r) => [charKeyOf(r), r]));
  for (const c of ctx.standardChars) {
    const row = std.get(c);
    assert.ok(row, `${c} 不在名单里`);
    assert.equal(Number(row.actived_constellation_num) || 0, 0, `${c} 不是 E0`);
    assert.equal(coneKeyOf(row), ctx.signatureConeOf(c), `${c} 的锥不是它的专武`);
    assert.equal(Number(row.equip?.rank), 1, `${c} 的锥叠影不是 S1`);
  }
  assert.equal(goldOfRows(rows), 0, '无成本账号的限定金必须为 0');
});
check('大隐金 MAX：常驻全 6+5、大隐金 16 人全部 E0 且不带光锥', () => {
  const { rows } = buildFrozen('dayinjin-max');
  const byKey = new Map(rows.map((r) => [charKeyOf(r), r]));
  for (const c of ctx.standardChars) {
    const row = byKey.get(c);
    assert.equal(Number(row?.actived_constellation_num) || 0, 6, `${c} 不是 E6`);
    assert.equal(coneKeyOf(row), ctx.signatureConeOf(c), `${c} 的锥不是它的专武`);
    assert.equal(Number(row?.equip?.rank), 5, `${c} 的锥不是 S5`);
  }
  for (const c of [...hiddenGroup('gift'), ...hiddenGroup('exchange')]) {
    const row = byKey.get(c);
    assert.ok(row, `大隐金 ${c} 不在名单里`);
    assert.equal(Number(row.actived_constellation_num) || 0, 0, `大隐金 ${c} 不是 E0`);
    assert.equal(row.equip, null, `大隐金 ${c} 不该带光锥（用户明确「不包含」）`);
  }
});

console.log('\n▶ 全角色平铺四档（用户 2026-10-13 第 4 条 + 2026-10-14 第 1 条修 bug）');
for (const [id, tier, sup] of [['flat-0-0', 0, 0], ['flat-0-1', 0, 1],
  ['flat-2-1', 2, 1], ['flat-6-5', 6, 5]]) {
  check(`${id}：全部角色 E${tier}、专属锥 S${sup}`, () => {
    const { rows } = buildFrozen(id);
    const all = Object.keys(availability.characters || {});
    // ⚠️ 快照里开拓者**只有一行**（用户 2026-10-14 第 4 条：「仅包含开拓者本体」），
    // 所以行数 = 全部角色 − 5 个命途键 + 1 行本体。
    const tbKeys = all.filter((k) => /trailblazer/i.test(k));
    assert.equal(rows.length, all.length - tbKeys.length + 1,
      `行数不对（全部 ${all.length} 个角色含 ${tbKeys.length} 个开拓者命途键，应当合成 1 行）`);
    assert.ok(rows.length >= 80, `角色太少：${rows.length}（应当是全部角色）`);
    for (const row of rows) {
      // ⚠️ 开拓者那一行**永远是 E6**（用户 2026-10-14 第 4 条：「视为所有开拓者的命途
      // 均拥有且**满星魂**」），它不属于「平铺到 E0/E2/E6」这件事 —— 所以这里跳过它，
      // 它的星魂由下面「开拓者」那一节单独钉住。
      if (/trailblazer|\{nickname\}|开拓者/i.test(String(row.name))) continue;
      assert.equal(Number(row.actived_constellation_num) || 0, tier,
        `${charKeyOf(row)} 的星魂不是 E${tier}`);
      if (sup === 0) {
        assert.equal(row.equip, null, `${charKeyOf(row)} 不该带光锥（0+0）`);
      } else if (row.equip) {
        assert.equal(Number(row.equip.rank), sup, `${charKeyOf(row)} 的叠影不是 S${sup}`);
      }
    }
  });
}
check('⭐ 平铺 0+1 / 2+1 / 6+5：**每个角色都有光锥**（用户 2026-10-14 第 1 条）', () => {
  // 这是用户报的那个 bug：「全角色平铺时缺了角色/光锥（**缇宝 / 花火缺少光锥**）」。
  // 改前 `signatureConeOf` 退回「最常用光锥」，辅助角色共用一把通用锥，去重后
  // 93 个角色只剩 **72** 把锥、**21 个角色没有光锥**（缇宝与花火都在里面）。
  for (const id of ['flat-0-1', 'flat-2-1', 'flat-6-5']) {
    const { rows } = buildFrozen(id);
    const noCone = rows.filter((r) => !r.equip);
    // 唯一允许没有光锥的是开拓者那一行（它是「本体」，不属于任何命途）。
    const named = noCone.filter((r) => !/trailblazer|\{nickname\}|开拓者/i.test(String(r.name)));
    assert.equal(named.length, 0,
      `${id} 还有 ${named.length} 个角色没光锥：${named.slice(0, 8).map(charKeyOf).join(', ')}`);
  }
});
check('⭐ 平铺：限定角色的锥就是**它自己的专武**（不是共用的「最常用锥」）', () => {
  const { rows } = buildFrozen('flat-0-1');
  // 用用户点名的两个角色做定点验证：缇宝 → 如果时间是一朵花、花火 → 游戏尘寰。
  const byKey = new Map(rows.map((r) => [charKeyOf(r), r]));
  assert.equal(coneKeyOf(byKey.get('Tribbie')), ctx.signatureConeOf('Tribbie'),
    '缇宝配的不是自己的专武');
  assert.equal(coneKeyOf(byKey.get('Sparkle')), ctx.signatureConeOf('Sparkle'),
    '花火配的不是自己的专武');
  assert.notEqual(coneKeyOf(byKey.get('Tribbie')), coneKeyOf(byKey.get('Sparkle')),
    '两个角色的锥不该是同一把（那正是「缺光锥」的成因）');
});
check('⭐ 平铺：限定锥**不重复挂**（金数口径不许被去重吃掉），免费锥允许重复', () => {
  const { rows } = buildFrozen('flat-0-1');
  const costly = new Map();
  for (const row of rows) {
    const cone = coneKeyOf(row);
    if (!cone || coneCostOf(cone, availability) <= 0) continue;
    costly.set(cone, (costly.get(cone) || 0) + 1);
  }
  const dup = [...costly].filter(([, n]) => n > 1);
  assert.equal(dup.length, 0, `限定锥被多人装备：${dup.map(([c, n]) => `${c}×${n}`).join(', ')}`);
});
check('⭐ 平铺 0+1 的金数 = 58 个限定本体 + 58 把限定锥（与改动前一致）', () => {
  const { rows } = buildFrozen('flat-0-1');
  const limitedRows = rows.filter((r) => charCostOf(charKeyOf(r), availability) > 0);
  const limitedCones = rows.filter((r) => coneKeyOf(r)
    && coneCostOf(coneKeyOf(r), availability) > 0);
  assert.equal(limitedRows.length, 58, `限定角色 ${limitedRows.length} 个`);
  assert.equal(limitedCones.length, 58, `限定锥 ${limitedCones.length} 把`);
  assert.equal(goldOfRows(rows), 116, `金数应当是 116，实际 ${goldOfRows(rows)}`);
});

check('⭐ 快照里没有重复的 `id`（卡片身份，抽卡页「点 chip 滚过去」靠它）', () => {
  // ⚠️ 这里钉的是 2026-10-14 挖出来的一个真问题：数据集的 `charactersById` 把
  // `1001` 与 `1224` **都写成「March 7th」**，而 `availability` 里是
  // `March 7th (Preservation)` / `March 7th (Hunt)` 两个键、图标表里只有一条
  // `March 7th → 1224.png`。于是「宽松匹配」把两行都指到 1224：两张卡的
  // `data-char-id` 撞车（点角色 chip 会滚到错的那张），而且服务端侧
  // `charCostOf('March 7th')` 走「未知键 → 保守按限定算」让平铺凭空多 2 金。
  // 修法见 `CHARACTER_ID_OVERRIDES`（1001 = 存护 / Knight、1224 = 巡猎 / Rogue，
  // 依据是 StarRailRes 的 path 字段 + 两张图标都能请求到）。
  for (const presetId of ['flat-0-1', 'dayinjin-max', 'random-mid']) {
    const { rows } = buildFrozen(presetId);
    const seen = new Map();
    for (const row of rows) {
      const id = Number(row.id);
      assert.ok(Number.isFinite(id) && id > 0, `${presetId}：${row.name} 没有合法 id`);
      if (seen.has(id)) {
        assert.fail(`${presetId}：id ${id} 被 ${seen.get(id)} 与 ${row.name} 共用`);
      }
      seen.set(id, row.name);
    }
  }
  // 定点：三月七两行必须是两个不同的 id
  const { rows } = buildFrozen('flat-0-1');
  const march = rows.filter((r) => /三月七/.test(String(r.name)));
  assert.equal(march.length, 2, `三月七应当有两行，实际 ${march.length}`);
  assert.notEqual(Number(march[0].id), Number(march[1].id), '两个命途的 id 撞车了');
});
check('⭐ 三月七（存护）与（巡猎）的图标指向各自的 id', () => {
  const { rows } = buildFrozen('flat-0-1');
  for (const row of rows.filter((r) => /三月七/.test(String(r.name)))) {
    assert.ok(String(row.icon).includes(`/${row.id}.png`),
      `${row.name} 的图标 ${row.icon} 与它的 id ${row.id} 不一致`);
  }
});

console.log('\n▶ 开拓者（用户 2026-10-14 第 4 条）');
check('⭐ 快照里开拓者**只有一行**：星魂 6、id ∈ 8001..8010、不带光锥', () => {
  for (const id of ['zero-cost', 'dayinjin-max', 'flat-0-1', 'random-mid']) {
    const { rows } = buildFrozen(id);
    const tb = rows.filter((r) => /trailblazer|\{nickname\}|开拓者/i.test(String(r.name)));
    assert.equal(tb.length, 1, `${id} 的开拓者行数是 ${tb.length}（应当只有 1 行）`);
    assert.equal(Number(tb[0].actived_constellation_num) || 0, 6, `${id} 的开拓者不是满星魂`);
    assert.ok(TRAILBLAZER_AVATARS.some((a) => a.id === Number(tb[0].id)),
      `${id} 的开拓者头像 id ${tb[0].id} 不在 8001..8010 里`);
    assert.equal(tb[0].equip, null, `${id} 的开拓者不该带光锥（它是「本体」一行）`);
  }
});
check('⭐ 单行开拓者 → `ownedCharacters` 全命途 + `eidolonsOf` 全命途 E6', () => {
  // 服务端只写一行，「全部命途都有且满星魂」是靠客户端两侧展开的：
  // `ownedCharacters` 早就有这条规则，`eidolonsOf` 是 v4.6.99 才补的
  //（改前单行开拓者的 5 个命途键在 `eidolonsOf` 里**全是 undefined**）。
  const zhToEn = {}; const allNames = [];
  for (const c of index.refs?.characters || []) {
    if (c.nameCn && c.name) zhToEn[c.nameCn] = c.name;
    if (c.nameCn) allNames.push(c.nameCn);
  }
  const tbKeys = Object.keys(availability.characters || {}).filter((k) => /trailblazer/i.test(k));
  assert.equal(tbKeys.length, 5, '开拓者命途键应当有 5 个');
  const snap = { characters: [{ id: 8001, name: '开拓者', rank: 6, actived_constellation_num: 6 }] };
  const owned = ownedCharacters(snap, zhToEn, allNames);
  const eid = eidolonsOf(snap, zhToEn);
  for (const key of tbKeys) {
    assert.ok(owned.has(key), `${key} 没被算成「已拥有」`);
    assert.equal(eid.get(key), 6, `${key} 的星魂不是 E6（实际 ${eid.get(key)}）`);
  }
});
check('⭐ 真实账号那种「多行开拓者」仍保留**逐命途**的星魂（不许被抬成同一个值）', () => {
  const zhToEn = {};
  for (const [en, zh] of Object.entries(i18n.characters || {})) zhToEn[zh] = en;
  const snap = { characters: [
    { id: 8001, name: i18n.characters['Trailblazer (Destruction)'], rank: 6 },
    { id: 8003, name: i18n.characters['Trailblazer (Preservation)'], rank: 2 },
  ] };
  const eid = eidolonsOf(snap, zhToEn);
  assert.equal(eid.get('Trailblazer (Destruction)'), 6);
  assert.equal(eid.get('Trailblazer (Preservation)'), 2,
    '多行时必须逐命途（否则会把 E2 抬成 E6，补金推荐跟着算错）');
});

console.log('\n▶ 随机低 / 中 / 高氪（大隐金 MAX + 50 / 100 / 200 限定金）');
const DAYINJIN_BASE = presetOf('dayinjin-max').spec(ctx);
for (const [id, budget] of [['random-low', 50], ['random-mid', 100], ['random-high', 200]]) {
  check(`${id}：**新增**金数精确等于 ${budget}（连抽 3 次都要对上）`, () => {
    for (let round = 0; round < 3; round += 1) {
      const { spec } = buildFrozen(id);
      const delta = goldDeltaOfSpec(spec, DAYINJIN_BASE);
      assert.equal(delta, budget, `第 ${round + 1} 次：新增金 ${delta}`);
      // 基底必须原样在里面（用户第 2 条：「在大隐金MAX基础上」）
      for (const [key, tier] of Object.entries(DAYINJIN_BASE.chars)) {
        assert.ok(spec.chars?.[key] !== undefined, `基底角色 ${key} 丢了`);
        assert.ok((Number(spec.chars[key]) || 0) >= (Number(tier) || 0),
          `基底角色 ${key} 的档位被降了（${spec.chars[key]} < ${tier}）`);
      }
      for (const [key, sup] of Object.entries(DAYINJIN_BASE.cones)) {
        assert.equal(Number(spec.cones?.[key]), Number(sup), `基底锥 ${key} 的叠影被改了`);
      }
    }
  });
  check(`${id}：星魂只停在 E0/E1/E2/E6、锥恒 S1 且都是本人专武`, () => {
    for (let round = 0; round < 3; round += 1) {
      const { rows } = buildFrozen(id);
      const limited = rows.filter((r) => charCostOf(charKeyOf(r), availability) > 0);
      assert.ok(limited.length > 0, '一个限定角色都没有');
      for (const row of limited) {
        const eid = Number(row.actived_constellation_num) || 0;
        assert.ok([0, 1, 2, 6].includes(eid), `${charKeyOf(row)} 的星魂是 E${eid}`);
        if (!row.equip) continue;
        // 基底那 7 把常驻专锥是 S5（成本 0），随机新增的才是 S1（成本 > 0）。
        const cone = coneKeyOf(row);
        const costly = coneCostOf(cone, availability) > 0;
        assert.equal(Number(row.equip.rank), costly ? 1 : 5,
          `${charKeyOf(row)} 的 ${cone} 叠影是 S${row.equip.rank}`);
        if (costly) {
          assert.equal(cone, ctx.signatureConeOf(charKeyOf(row)),
            `${charKeyOf(row)} 配的不是自己的专武`);
        }
      }
    }
  });
}
check('随机账号之间**互不相同**（「随机生成」这件事本身）', () => {
  const sig = () => JSON.stringify(buildFrozen('random-mid').rows.map((r) =>
    `${charKeyOf(r)}:${r.actived_constellation_num}:${r.equip?.name || '-'}`));
  assert.ok(new Set([sig(), sig(), sig(), sig()]).size > 1, '四次生成完全一样');
});

console.log('\n▶ 自定义名单（用户 2026-10-13 第 3 条）');
check('normalizeRoster：丢弃不存在的键、星魂吸附、叠影夹到 1~5', () => {
  const roster = normalizeRoster({
    chars: { Castorice: 5, Cyrene: 1, NotARealCharacter: 3, '': 2 },
    cones: { 'Make Farewells More Beautiful': 9, NotARealCone: 1 },
  }, index.refs || {});
  assert.deepEqual(roster.chars, { Castorice: 2, Cyrene: 1 });
  assert.deepEqual(roster.cones, { 'Make Farewells More Beautiful': 5 });
});
check('normalizeRoster：E3~E5 归到 E2、E0 保持 E0（与总榜的档位口径一致）', () => {
  const roster = normalizeRoster({ chars: { Castorice: 3, Cyrene: 0, Phainon: 6 } }, index.refs || {});
  assert.deepEqual(roster.chars, { Castorice: 2, Cyrene: 0, Phainon: 6 });
});
check('⭐ normalizeRoster：光锥的主人必须与这把锥**同命途**（用户第 3 条的硬约束）', () => {
  // 于夜色中是巡猎锥、无可取代的东西是毁灭锥（都取自数据集，不手抄命途名）。
  const hunt = 'In the Night';
  const destruction = 'Something Irreplaceable';
  assert.equal(ctx.lightConePaths[hunt], 'Rogue');
  const ok = normalizeRoster({
    chars: { Seele: 2 }, cones: { [hunt]: 1 }, coneOwners: { [hunt]: 'Seele' },
  }, index.refs || {});
  assert.deepEqual(ok.coneOwners, { [hunt]: 'Seele' }, '同命途应当收下');
  const bad = normalizeRoster({
    chars: { Seele: 2 }, cones: { [destruction]: 1 }, coneOwners: { [destruction]: 'Seele' },
  }, index.refs || {});
  assert.deepEqual(bad.coneOwners, {}, '不同命途必须丢掉主人（否则光锥会挂给错的人）');
  const ghost = normalizeRoster({
    chars: {}, cones: { [hunt]: 1 }, coneOwners: { [hunt]: 'Seele' },
  }, index.refs || {});
  assert.deepEqual(ghost.coneOwners, {}, '主人不在名单里时也不认');
});
check('⭐ 自定义名单里的专属锥挂在**它自己的角色**身上', () => {
  const roster = { chars: { Castorice: 2, Cyrene: 6 }, cones: { 'Make Farewells More Beautiful': 3 } };
  const preset = customRosterPreset(roster, '自定义');
  const account = buildVirtualAccount({
    preset, index, i18n, availability, charCostOf, coneCostOf,
    uid: '900001', accountId: 'virtual-custom',
  });
  const rows = account.snapshots['900001'].characters || [];
  const byKey = new Map(rows.map((r) => [charKeyOf(r), r]));
  assert.equal(Number(byKey.get('Castorice')?.actived_constellation_num), 2);
  assert.equal(Number(byKey.get('Cyrene')?.actived_constellation_num), 6);
  assert.equal(coneKeyOf(byKey.get('Castorice')), 'Make Farewells More Beautiful',
    '专锥必须挂在它自己的角色身上（改前按下标挂，会挂到别人身上）');
  assert.equal(byKey.get('Cyrene')?.equip, null, '昔涟没配锥');
  assert.equal(account.virtualRoster.chars.Castorice, 2, '账号要记下名单原文（编辑器预填用）');
});
check('自定义名单也不许出现数据集里没有的角色', () => {
  const roster = normalizeRoster({ chars: { Castorice: 2, 'No Such Char': 6 } }, index.refs || {});
  assert.deepEqual(Object.keys(roster.chars), ['Castorice']);
});
check('⭐ 同一命途但**非专属**的光锥，挂给谁由名单说了算（不是「专属锥的主人」）', () => {
  // 于夜色中 是希儿的专属锥，但这里把它显式配给**另一个巡猎**角色：
  // 服务端按 `coneOwners` 走，必须挂在指定的那个人身上（否则用户改了主人却看不出变化）。
  const roster = {
    chars: { Seele: 0, Yanqing: 0 },
    cones: { 'In the Night': 1 },
    coneOwners: { 'In the Night': 'Yanqing' },
  };
  const account = buildVirtualAccount({
    preset: customRosterPreset(roster, '自定义'), index, i18n, availability, charCostOf, coneCostOf,
    uid: '900001', accountId: 'virtual-custom-owner',
  });
  const rows = account.snapshots['900001'].characters || [];
  const byKey = new Map(rows.map((r) => [charKeyOf(r), r]));
  assert.equal(coneKeyOf(byKey.get('Yanqing')), 'In the Night', '应当挂在显式指定的主人身上');
  assert.equal(byKey.get('Seele')?.equip, null, '希儿不该拿到它（主人被显式改掉了）');
});

check('⭐ normalizeRoster：**E0 的角色**也能当光锥主人（用户第 3 条「无法更改光锥」的根因）', () => {
  // ⚠️ 这里钉的是一个**真 bug**（v4.6.99 修）：判据原来是 `!chars[ownerKey]`，
  // 而 **E0 的星魂值是 `0`，是假值** —— 「刚添加一个角色（默认 E0）+ 给它配光锥」
  // 这个最常见的操作会把光锥主人**静默丢掉**（锥还在 `cones` 里、主人没了 → 快照按
  // 「找空槽」把锥挂到别人身上，界面上就是「改了光锥但没生效」）。
  const hunt = 'In the Night';
  const e0 = normalizeRoster({
    chars: { Seele: 0 }, cones: { [hunt]: 1 }, coneOwners: { [hunt]: 'Seele' },
  }, index.refs || {});
  assert.deepEqual(e0.coneOwners, { [hunt]: 'Seele' }, 'E0 的主人必须被收下');
  assert.deepEqual(e0.charCones, { Seele: hunt }, '逐角色装备也要登记');
  // E0 的显式 `charCones` 同样要收（新形状，界面走的就是它）
  const e0b = normalizeRoster({
    chars: { Seele: 0 }, cones: { [hunt]: 1 }, charCones: { Seele: hunt },
  }, index.refs || {});
  assert.deepEqual(e0b.charCones, { Seele: hunt }, 'E0 的逐角色装备必须被收下');
});

check('⭐ 服务端下发的专武表**必须含常驻 7 个 5★**（界面「（专属）」标注用）', () => {
  // ⚠️ 这里钉的是一个实测踩到的缺口：`deriveSignatureCones()` 只覆盖**限定 5★**
  //（常驻 7 个不是限定角色），所以导出的表必须是
  // `{ ...STANDARD_SIGNATURE_CONES, ...derived }`。少了常驻那 7 条的话，界面上的
  // 「专属」标注会退回 `popularLightCones` —— 实测白露那一行显示成
  // 「一场术后对话（专属）」（4★），而她真正的专武是「时节不居」。
  const table = index.refs?.signatureLightCones || {};
  const expect = {
    Himeko: 'Night on the Milky Way',
    Welt: 'In the Name of the World',
    Bronya: 'But the Battle Isn\'t Over',
    Gepard: 'Moment of Victory',
    Clara: 'Something Irreplaceable',
    Bailu: 'Time Waits for No One',
    Yanqing: 'Sleep Like the Dead',
  };
  for (const [char, cone] of Object.entries(expect)) {
    assert.equal(table[char], cone, `${char} 不在下发的专武表里（或值不对）`);
  }
  // 限定角色也要在（推导出来的那一批 + 人工钉死的两条）
  assert.equal(table.Sparkle, ctx.signatureConeOf('Sparkle'), '花火的专武不在表里');
  assert.equal(table.Tribbie, ctx.signatureConeOf('Tribbie'), '缇宝的专武不在表里');
  assert.equal(table.Luocha, 'Echoes of the Coffin', '人工钉死的那条丢了');
  assert.equal(table.Lingsha, 'Scent Alone Stays True', '人工钉死的那条丢了');
  assert.ok(Object.keys(table).length >= 65,
    `专武表条目太少：${Object.keys(table).length}（常驻 7 + 限定 58）`);
});

console.log('\n▶ 逐角色装备 `charCones`（用户 2026-10-14 第 1 条：平铺每个角色都有光锥）');
check('⭐ 同一把**成本 0**的锥可以挂给多个角色（4★ 没有专属锥，不重复就漏人）', () => {
  const cone = 'Dance Dance Dance'; // 4★ 同谐锥，成本 0
  assert.equal(coneCostOf(cone, availability), 0, `${cone} 应当是成本 0`);
  const roster = normalizeRoster({
    chars: { Sparkle: 0, 'Ruan Mei': 0 },
    cones: { [cone]: 1 },
    charCones: { Sparkle: cone, 'Ruan Mei': cone },
  }, index.refs || {});
  assert.deepEqual(roster.charCones, { Sparkle: cone, 'Ruan Mei': cone },
    '免费锥必须允许重复（否则平铺会有角色没光锥）');
  assert.deepEqual(roster.coneOwners, { [cone]: 'Sparkle' },
    '旧形状 `coneOwners` 只能记第一个主人（它表达不了重复）');
});
check('⭐ 成本 > 0 的限定锥**只能有一个主人**（否则平铺把限定金数算少）', () => {
  const cone = ctx.signatureConeOf('Sparkle'); // 游戏尘寰（限定 5★）
  assert.ok(coneCostOf(cone, availability) > 0, `${cone} 应当是限定锥`);
  const roster = normalizeRoster({
    chars: { Sparkle: 0, 'Ruan Mei': 0 },
    cones: { [cone]: 1 },
    charCones: { Sparkle: cone, 'Ruan Mei': cone },
  }, index.refs || {});
  assert.deepEqual(roster.charCones, { Sparkle: cone },
    '限定锥只允许一个主人（`cones` 是去重的金数口径）');
});
check('⭐ `charCones` 也要过命途校验（不同命途的光锥不收）', () => {
  const destruction = 'Something Irreplaceable'; // 毁灭锥
  const roster = normalizeRoster({
    chars: { Seele: 0 }, cones: { [destruction]: 1 }, charCones: { Seele: destruction },
  }, index.refs || {});
  assert.deepEqual(roster.charCones, {}, '巡猎角色不该拿到毁灭锥');
});
check('⭐ `buildVirtualAccount` 认得 `charCones`（逐角色装备是权威）', () => {
  const cone = 'In the Night';
  const roster = normalizeRoster({
    chars: { Seele: 0, Yanqing: 0 }, cones: { [cone]: 1 }, charCones: { Yanqing: cone },
  }, index.refs || {});
  const account = buildVirtualAccount({
    preset: customRosterPreset(roster, '自定义'), index, i18n, availability, charCostOf, coneCostOf,
    uid: '900001', accountId: 'virtual-custom-charc',
  });
  const rows = account.snapshots['900001'].characters || [];
  const byKey = new Map(rows.map((r) => [charKeyOf(r), r]));
  assert.equal(coneKeyOf(byKey.get('Yanqing')), cone, '应当挂在显式指定的主人身上');
  assert.equal(byKey.get('Seele')?.equip, null, '希儿不该拿到它');
});

check('⭐ coneChoicesFor：**免费锥可共用**、限定锥仍独占（与 `coneCostOf` 同一条口径）', () => {
  // 编辑器不 import 评分模块，它把「要不要花金」这条规则**镜像**了一份
  //（`virtual-roster.js` 的 `coneIsCostly`）。镜子与本体一旦分叉，界面就会允许
  // 两个人共用一把限定锥（服务端再挡一道，但用户看到的是「选了却被丢掉」），
  // 或者反过来不让 4★ 共用免费锥（平铺档一保存就丢光锥）。
  const freeCone = Object.entries(availability.lightCones || {})
    .find(([, info]) => Number(info.rarity) <= 4)?.[0];
  assert.ok(freeCone, '数据集里应当有 4★ 光锥');
  assert.equal(coneCostOf(freeCone, availability), 0, `${freeCone} 应当免费`);
  const samePath = Object.keys(availability.characters)
    .filter((k) => index.refs?.characterPaths?.[k] === ctx.lightConePaths[freeCone]);
  assert.ok(samePath.length >= 2, `${freeCone} 的同命途角色不足两个`);
  const freeOwners = new Map([[freeCone, samePath[0]]]);
  assert.ok(coneChoicesFor({ charKey: samePath[1], refs: index.refs, owners: freeOwners })
    .includes(freeCone), '免费锥必须让第二个同命途角色也能选到');

  // 限定锥：别人拿着时不再列出（`cones` 是去重的金数口径）
  const costly = ctx.signatureConeOf('Sparkle');
  assert.ok(coneCostOf(costly, availability) > 0, `${costly} 应当是限定锥`);
  const costlyOwners = new Map([[costly, 'Ruan Mei']]);
  assert.ok(coneChoicesFor({ charKey: 'Ruan Mei', refs: index.refs, owners: costlyOwners })
    .includes(costly), '持有者自己要还能看到它');
  if (index.refs?.characterPaths?.Sparkle === index.refs?.characterPaths?.[costly]) {
    assert.ok(!coneChoicesFor({ charKey: 'Sparkle', refs: index.refs, owners: costlyOwners })
      .includes(costly), '限定锥被同命途的别人拿走后不该再列出');
  }
});

console.log('\n▶ 编辑器里的光锥候选（用户第 3 条：「同命途，专属优先」）');
check('⭐ coneChoicesFor：只列同命途，且专属那把排第一', () => {
  const owners = new Map();
  const list = coneChoicesFor({ charKey: 'Castorice', refs: index.refs, owners });
  assert.ok(list.length > 0, '一个候选都没有');
  for (const cone of list) {
    assert.equal(ctx.lightConePaths[cone], index.refs?.characterPaths?.Castorice,
      `${cone} 不是记忆命途`);
  }
  assert.equal(list[0], ctx.signatureConeOf('Castorice'),
    `专属锥必须排第一，实际第一是 ${list[0]}`);
});
check('⭐ coneChoicesFor：已被别人选走的光锥不再出现在候选里', () => {
  const owners = new Map([['In the Night', 'Seele']]);
  const forYanqing = coneChoicesFor({ charKey: 'Yanqing', refs: index.refs, owners });
  assert.ok(!forYanqing.includes('In the Night'), '被希儿选走的锥不该出现在彦卿的候选里');
  // 但希儿自己那边要还在（"自己已经拿着"不该让自己看不见它）
  const forSeele = coneChoicesFor({ charKey: 'Seele', refs: index.refs, owners });
  assert.ok(forSeele.includes('In the Night'), '自己的那把必须留在候选里');
});
check('defaultConeFor：默认配专属锥；专属锥被别人拿走后不再默认（不抢）', () => {
  assert.deepEqual(defaultConeFor({ charKey: 'Castorice', refs: index.refs, owners: new Map() }),
    { cone: ctx.signatureConeOf('Castorice'), sup: 1 });
  const sig = ctx.signatureConeOf('Castorice');
  assert.equal(defaultConeFor({
    charKey: 'Castorice', refs: index.refs, owners: new Map([[sig, 'SomeoneElse']]),
  }), null, '专属锥已被别人拿走时不该抢过来');
  assert.equal(defaultConeFor({
    charKey: 'Castorice', refs: index.refs, owners: new Map([[sig, 'Castorice']]),
  })?.cone, sig, '自己already拿着时可以保持');
});
check('新增角色的默认配锥：命途与专属都对得上（拿真实角色抽样）', () => {
  const owners = new Map();
  let checked = 0;
  let sharedFree = 0;
  for (const key of Object.keys(availability.characters || {})) {
    const pick = defaultConeFor({ charKey: key, refs: index.refs, owners });
    if (!pick) continue;
    // ⚠️ 「一把锥只能被默认配给一个人」这条**只对成本 > 0 的限定锥成立**
    //（2026-10-14 第 1 条）：4★ / 常驻的专属锥本身就是免费锥，多人共用是合法的
    // —— 平铺档「每个角色都有光锥」正是靠它（实测 5 个同谐 4★ 共用 Dance Dance Dance）。
    if (coneCostOf(pick.cone, availability) > 0) {
      assert.equal(owners.get(pick.cone), undefined, `${pick.cone} 是限定锥却被默认配了两次`);
    } else if (owners.has(pick.cone)) {
      sharedFree += 1;
    }
    owners.set(pick.cone, key);
    assert.equal(index.refs?.lightConePaths?.[pick.cone], index.refs?.characterPaths?.[key],
      `${key} 默认配的 ${pick.cone} 命途不符`);
    checked += 1;
  }
  assert.ok(checked > 50, `抽样太少：${checked}`);
  assert.ok(sharedFree > 0, '应当观察到「免费锥被多个角色共用」这个合法状态');
});

console.log(`\n虚拟账号测试: ${passed} passed, ${failures.length} failed`);if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`);
  process.exit(1);
}
