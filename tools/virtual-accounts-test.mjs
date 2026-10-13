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
  HIDDEN_COST_SETTINGS, charCostOf, coneCostOf,
} from '../public/scripts/advice.js';
import { archiveIndex, loadI18n } from '../src/server/archive.js';
import {
  VIRTUAL_PRESETS, buildVirtualAccount, customRosterPreset, normalizeRoster,
  presetContext, presetContextRefs,
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

const index = await archiveIndex();
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
const charKeyOf = (row) => idToEn.get(Number(row.id)) || zhToEn.get(row.name) || row.name;
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

console.log('\n▶ 全角色平铺四档（用户 2026-10-13 第 4 条）');
for (const [id, tier, sup] of [['flat-0-0', 0, 0], ['flat-0-1', 0, 1],
  ['flat-2-1', 2, 1], ['flat-6-5', 6, 5]]) {
  check(`${id}：全部角色 E${tier}、专属锥 S${sup}`, () => {
    const { rows } = buildFrozen(id);
    const all = Object.keys(availability.characters || {});
    assert.ok(rows.length >= 80, `角色太少：${rows.length}（应当是全部角色）`);
    assert.equal(rows.length, all.length - (all.length - rows.length), '');
    for (const row of rows) {
      assert.equal(Number(row.actived_constellation_num) || 0, tier,
        `${charKeyOf(row)} 的星魂不是 E${tier}`);
      if (sup === 0) {
        assert.equal(row.equip, null, `${charKeyOf(row)} 不该带光锥（0+0）`);
      } else if (row.equip) {
        assert.equal(coneKeyOf(row), ctx.signatureConeOf(charKeyOf(row)),
          `${charKeyOf(row)} 配的不是自己的专武`);
        assert.equal(Number(row.equip.rank), sup, `${charKeyOf(row)} 的叠影不是 S${sup}`);
      }
    }
  });
}

console.log('\n▶ 随机低 / 中 / 高氪（20 / 50 / 100 限定金）');
for (const [id, budget] of [['random-low', 20], ['random-mid', 50], ['random-high', 100]]) {
  check(`${id}：金数**精确**等于 ${budget} 限定金（连抽 3 次都要对上）`, () => {
    for (let round = 0; round < 3; round += 1) {
      const { spec, rows } = buildFrozen(id);
      assert.equal(goldOfSpec(spec), budget, `第 ${round + 1} 次：名单金 ${goldOfSpec(spec)}`);
      assert.equal(goldOfRows(rows), budget, `第 ${round + 1} 次：快照金 ${goldOfRows(rows)}`);
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
        assert.equal(Number(row.equip.rank), 1, `${charKeyOf(row)} 的锥不是 S1`);
        assert.ok(coneCostOf(coneKeyOf(row), availability) > 0,
          `${charKeyOf(row)} 配的是非限定锥 ${coneKeyOf(row)}`);
        assert.equal(coneKeyOf(row), ctx.signatureConeOf(charKeyOf(row)),
          `${charKeyOf(row)} 配的不是自己的专武`);
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
  for (const key of Object.keys(availability.characters || {})) {
    const pick = defaultConeFor({ charKey: key, refs: index.refs, owners });
    if (!pick) continue;
    // 一把锥只能被默认配给一个人：登记之后，同一把锥不能再默认给第二个角色。
    assert.equal(owners.get(pick.cone), undefined, `${pick.cone} 被默认配了两次`);
    owners.set(pick.cone, key);
    assert.equal(index.refs?.lightConePaths?.[pick.cone], index.refs?.characterPaths?.[key],
      `${key} 默认配的 ${pick.cone} 命途不符`);
    checked += 1;
  }
  assert.ok(checked > 50, `抽样太少：${checked}`);
});

console.log(`\n虚拟账号测试: ${passed} passed, ${failures.length} failed`);if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`);
  process.exit(1);
}
