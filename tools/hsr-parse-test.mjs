// Regression test for Star Rail character parsing, against a REAL captured
// `index` payload (.snapref/_hsr-index.json).
//
// Why this test exists: Star Rail returns its roster under `avatar_list`, not
// `avatars`, and `avatar/basic` also uses `avatar_list`. A reader that only
// looks at `avatars` silently renders zero characters even on a retcode-0
// response.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { charactersOf, statsOf, lightConeOf, elementName, pathName } from '../src/core/format.js';

// Resolve against the repo root, not the caller's cwd, so the sample is found
// no matter which directory the suite is launched from.
const SAMPLE = resolve(import.meta.dirname, '..', '.snapref', '_hsr-index.json');
if (!existsSync(SAMPLE)) {
  console.log(`跳过：缺少实测样本 ${SAMPLE}`);
  process.exit(0);
}

const data = JSON.parse(readFileSync(SAMPLE, 'utf8'));
const avatars = data.avatar_list || [];

let passed = 0;
let failed = 0;
const check = (label, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${label}: ${err.message}`);
    process.exitCode = 1;
  }
};

console.log(`\n▶ 星铁角色解析（实测样本：${avatars.length} 个角色）`);

check('样本携带 avatar_list（不是 avatars）', () => {
  assert.ok(Array.isArray(avatars) && avatars.length > 0);
});

check('charactersOf 能从 index.avatar_list 取到角色', () => {
  const list = charactersOf({ index: { avatar_list: avatars } });
  assert.equal(list.length, avatars.length);
});

check('charactersOf 也能从顶层 characters 取到', () => {
  const list = charactersOf({ characters: avatars });
  assert.equal(list.length, avatars.length);
});

check('每个角色都有名字与等级', () => {
  for (const a of avatars) {
    assert.ok(a.name, `角色 ${a.id} 没有名字`);
    assert.ok(Number.isFinite(Number(a.level)), `角色 ${a.name} 等级异常: ${a.level}`);
  }
});

check('稀有度与星魂字段存在', () => {
  for (const a of avatars) {
    assert.ok(Number(a.rarity) >= 4, `${a.name} 稀有度异常: ${a.rarity}`);
    assert.ok(a.rank !== undefined, `${a.name} 缺少 rank`);
  }
});

check('元素被解析为中文', () => {
  const el = elementName(avatars[0].element);
  assert.ok(el && el !== '未知' && !/^[a-z]/.test(el), `元素未本地化: ${avatars[0].element} -> ${el}`);
});

check('光锥（equip）可解析出名称与叠影', () => {
  const withCone = avatars.filter((a) => a.equip && a.equip.name);
  assert.ok(withCone.length > 0, '没有任何角色带光锥');
  const cone = lightConeOf(withCone[0]);
  assert.ok(cone && cone.name, 'lightConeOf 没有解出名称');
  assert.equal(cone.name, withCone[0].equip.name);
  assert.ok(cone.rank !== null && cone.rank !== undefined, '光锥缺少叠影等级');
});

check('statsOf 不因星铁结构抛错', () => {
  const rows = statsOf(avatars[0]);
  assert.ok(Array.isArray(rows));
});

check('pathName 对未知命途不崩', () => {
  assert.equal(typeof pathName(undefined), 'string');
  assert.equal(typeof pathName('Warrior'), 'string');
});

console.log('\n  角色预览:');
for (const a of avatars.slice(0, 6)) {
  console.log(`    ${String(a.name).padEnd(12)} Lv.${String(a.level).padEnd(3)} ${a.rarity}★ `
    + `星魂${a.rank}  ${elementName(a.element)}  光锥=${a.equip?.name ?? '—'}`);
}
console.log(`\n星铁解析测试: ${passed} passed, ${failed} failed`);
