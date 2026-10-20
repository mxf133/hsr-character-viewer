// 抽卡方案的**服务端全量索引**（搜索 / 分页 / 缓存）—— 2026-10-20，v4.6.133。
//
//   node tools/plan-page-test.mjs
//
// 为什么单独一套：用户第 1~3 条要求「展示所有投稿、能搜到所有投稿、保证性能、支撑 10 万条」。
// 这件事的正确性全在几个纯函数上 —— 词元怎么拆、命中怎么算（AND / 次选）、页怎么切：
//   * `planTokensOf()`    —— 本队的可搜索词元（含折叠进来的其它配装）
//   * `altTokensOf()`     —— 次选配队词元，必须与 `alternativesOf()` 的**实际输出**一致
//   * `searchPlanIndex()` —— AND 语义、本队 / 次选两类命中、名次升序
//   * `planPageOf()`      —— 切片 / 页码夹紧 / 页大小上限
//   * `createPlanCache()` —— LRU（条目数 + 总行数双预算）
// 界面只是把它们的结果画出来，所以这里**不需要浏览器**。
//
// ⚠️ 这里**不读 `theherta/archive.json`**：夹具全是手写的合成阵容，所以数据集重建
//    不会让这套测试变红（真数据的行为由 `gacha-plan-test` / 探针盯）。
//
// ⚠️ 夹具分两池，故意的：
//   * `DISJOINT` —— 三支**互不共享任何角色**的队伍 ⇒ 谁也成不了谁的次选。
//     用它验「本队命中」与 AND 语义，结果不含任何次选噪声。
//   * `BRANCHED` —— 一号队与二号队共享 2 人、三号队彻底孤立 ⇒ 次选关系可控。
//     用它验「次选命中」与徽章不说谎。
import {
  PLAN_ALT_INDEX_MAX_LINEUPS, PLAN_PAGE_SIZE_MAX, altTokensOf, createPlanCache, hashOf,
  planPageOf, planTokensOf, searchPlanIndex, tokenIndexOf,
} from '../src/server/plan-index.js';
import { alternativesOf, buildPlanPool, materializePlanRow } from '../src/server/gacha-plan.js';

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`); }
  return Boolean(cond);
};
const eq = (name, actual, expect) => check(
  name,
  JSON.stringify(actual) === JSON.stringify(expect),
  `实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expect)}`,
);

// ------------------------------------------------------------------ 夹具
//
// 全部按「4★ 常驻」算 ⇒ 每个位置 0 金（`marginalCostOf` 的可加口径），
// 于是分数只由 `strengthPart` 决定，名次可预测。
const CHARS = [
  'Hero', 'Mage', 'Bard', 'Zed', 'Stan', 'Free',
  'Solo', 'Duo', 'Tri', 'Quad',
  'A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'C3', 'C4',
];
const AVAIL = {
  characters: Object.fromEntries(CHARS.map((name) => [name, { rarity: 4, limited: false }])),
  lightCones: {
    HeroLC: { rarity: 5, limited: true },
    FreeLC: { rarity: 4, limited: false },
  },
};

const ZH_CHAR = {
  Hero: '英雄', Mage: '法师', Bard: '诗人', Zed: '载德', Stan: '斯坦', Free: '免费',
  Solo: '单', Duo: '双', Tri: '三', Quad: '四',
  A1: '甲一', A2: '甲二', A3: '甲三', A4: '甲四',
  B1: '乙一', B2: '乙二', B3: '乙三', B4: '乙四',
  C1: '丙一', C2: '丙二', C3: '丙三', C4: '丙四',
};
const ZH_CONE = { HeroLC: '英雄专武' };
const nameOf = (kind, name) => (kind === 'cone' ? (ZH_CONE[name] || null) : (ZH_CHAR[name] || null));

/** 手写「已打分」的行：`buildPlanPool()` 只读这几个字段，不必过 `scoreEnvRows()`。 */
const row = (m, strengthPart, season = '4.6') => ({
  season, m, c: 0, a: 100, n: 1, strengthPart, baseline: 8, versionWeight: 1,
});

const DISJOINT = [
  row(['A1|0||0', 'A2|0||0', 'A3|0|HeroLC|1', 'A4|0||0'], 0.90),
  row(['B1|0||0', 'B2|0||0', 'B3|0||0', 'B4|0||0'], 0.80),
  row(['C1|0||0', 'C2|0||0', 'C3|0||0', 'C4|0||0'], 0.70),
];

const BRANCHED = [
  // ① 一号队（榜首）
  row(['Hero|0|HeroLC|1', 'Mage|0||0', 'Free|0||0', 'Stan|0||0'], 0.95),
  // ①b 同四人换光锥 ⇒ 折叠进 ① 的 `variants`
  row(['Hero|0|FreeLC|1', 'Mage|0||0', 'Free|0||0', 'Stan|0||0'], 0.90),
  // ② 与 ① 共享 Mage + Free ⇒ 会进 ① 的次选
  row(['Bard|0||0', 'Zed|0||0', 'Mage|0||0', 'Free|0||0'], 0.80),
  // ③ 与谁都不共享 ⇒ 任何人的次选里都不该有它
  row(['Solo|0||0', 'Duo|0||0', 'Tri|0||0', 'Quad|0||0'], 0.70),
];

const poolOf = (rows) => {
  const pool = buildPlanPool(rows, { availability: AVAIL, wc: 1 });
  return { ...pool, nameOf };
};

const FLAT = poolOf(DISJOINT);
const BRANCH = poolOf(BRANCHED);
const ranksOf = (result) => result.ids.map((id) => id + 1);
const charsAt = (pool, id) => pool.lineups[id].members.map((m) => m.char).sort().join('/');
const altsOf = (pool, id) => alternativesOf(pool.lineups[id], pool.pool, pool.rankOf, pool.byMember, 3);

console.log('\n[整池：同四人换光锥折成一栏]');
{
  eq('4 条投稿 → 3 个角色组合', BRANCH.lineups.length, 3);
  eq('整池仍保留 4 套整包（次选从全池找）', BRANCH.pool.length, 4);
  eq('榜首是强度最高的那套', charsAt(BRANCH, 0), 'Free/Hero/Mage/Stan');
  eq('孤立队排最后', charsAt(BRANCH, 2), 'Duo/Quad/Solo/Tri');
}

// ------------------------------------------------------------------ 词元
console.log('\n[可搜索词元]');
{
  const tokens = planTokensOf(BRANCH.lineups[0], nameOf);
  check('英文键进词元', tokens.includes('hero'));
  check('中文名进词元', tokens.includes('英雄'));
  check('光锥英文键进词元', tokens.includes('herolc'));
  check('光锥中文名进词元', tokens.includes('英雄专武'));
  check('折叠进来的其它配装的光锥也进词元', tokens.includes('freelc'), tokens.join(','));
  eq('同一行内不重复', tokens.length, new Set(tokens).size);
  check('全部小写', tokens.every((t) => t === t.toLowerCase()));
  eq('空行不炸', planTokensOf({}, nameOf), []);
}

// ------------------------------------------------------------------ 次选索引
console.log('\n[次选词元：必须与 alternativesOf() 实际输出一致]');
{
  const alts = altTokensOf(BRANCH);
  check('建得出来（池子远小于上限）', Array.isArray(alts) && alts.length === BRANCH.lineups.length);
  const topAlts = altsOf(BRANCH, 0);
  const altChars = new Set(topAlts.flatMap((a) => a.members.map((m) => m.char)));
  check('榜首确实有次选（② 共享 Mage + Free）', topAlts.length >= 1, String(topAlts.length));
  check(
    '次选里的每个角色都进了词元',
    [...altChars].every((c) => new Set(alts[0]).has(c.toLowerCase())),
    `次选 ${[...altChars].join(',')}`,
  );
  check('次选里没有的角色**不会**被塞进来（第一版就是在这里说谎的）', !new Set(alts[0]).has('tri'));
  eq('孤立队没有次选词元', alts[2], []);

  // 超限：伪造一个 4001 行的索引，`altTokensOf()` 必须直接放弃（不逐行算次选）。
  const big = { lineups: new Array(PLAN_ALT_INDEX_MAX_LINEUPS + 1).fill(null), nameOf };
  check('超过上限时不建次选索引', altTokensOf(big) === null);
  check('超限时不懒建次选倒排', tokenIndexOf(big, 'alt') === null);
}

// ------------------------------------------------------------------ 搜索（无次选干扰）
console.log('\n[搜索 · 互不共享的三支队伍：只认本队]');
{
  const all = searchPlanIndex(FLAT, '');
  eq('空词 = 整池', ranksOf(all), [1, 2, 3]);
  eq('空词没有次选命中', all.altOnly, 0);

  const a1 = searchPlanIndex(FLAT, '甲一');
  eq('中文名命中', ranksOf(a1), [1]);
  eq('孤立阵容没有次选命中', a1.altOnly, 0);

  eq('英文键、大小写不敏感', ranksOf(searchPlanIndex(FLAT, 'A1')), [1]);
  eq('首尾空格不影响', ranksOf(searchPlanIndex(FLAT, '  甲一   ')), [1]);

  eq('同一支队伍的第二个词也命中', ranksOf(searchPlanIndex(FLAT, '甲一 甲二')), [1]);
  eq('跨队伍的两个词 → 无结果（AND 不是 OR）', ranksOf(searchPlanIndex(FLAT, '甲一 乙一')), []);
  eq('光锥名能搜', ranksOf(searchPlanIndex(FLAT, '英雄专武')), [1]);
  eq('搜不到就是空', searchPlanIndex(FLAT, '查无此人').ids, []);
  eq('搜不到时页数也要有 1 页', planPageOf(searchPlanIndex(FLAT, '查无此人').ids, 1).pages, 1);
  eq('只记得中间一段也命中（子串，不是前缀）', ranksOf(searchPlanIndex(FLAT, '一')), [1, 2, 3]);
  eq('同一支队伍的四个词元都命中同一行', ranksOf(searchPlanIndex(FLAT, '甲四')), [1]);
}

// ------------------------------------------------------------------ 搜索（含次选）
console.log('\n[搜索 · 次选命中：算「搜到」，但单独计数]');
{
  const hero = searchPlanIndex(BRANCH, '英雄');
  eq('本队命中排在前面，次选命中的那支跟在后面', ranksOf(hero), [1, 2]);
  eq('其中 1 支是次选命中', hero.altOnly, 1);
  check('孤立队不会被误判成次选命中', !ranksOf(hero).includes(3), ranksOf(hero).join(','));
  eq('本队命中数不含次选', hero.ownCount, 1);

  const zed = searchPlanIndex(BRANCH, '载德');
  eq('只在次选里出现的角色也能搜到', ranksOf(zed), [1, 2]);
  eq('它算次选命中', zed.altOnly, 1);
  // 翻页就是「同一个词、另一页」——这一步必须命中 `lastQuery`，不重算。
  check('同一个词连续两次复用上一次的结果（翻页不重算）',
    searchPlanIndex(BRANCH, '载德') === zed);

  const both = searchPlanIndex(BRANCH, '英雄 载德');
  eq('A 在本队、B 在次选 → 命中并标次选', ranksOf(both), [1]);
  eq('全部算次选命中', both.altOnly, 1);

  const cone = searchPlanIndex(BRANCH, 'freelc');
  check('折叠进 variants 的光锥也能搜到（本队命中，不是靠次选）',
    cone.ids[0] === 0 && cone.ownCount >= 1, `ids ${ranksOf(cone)} own ${cone.ownCount}`);

  // 徽章不说谎：次选命中的那一行，它的次选里确实有该角色。
  const altHitRow = BRANCH.lineups[zed.altOnlyIds[0]];
  const altChars = altsOf(BRANCH, zed.altOnlyIds[0])
    .flatMap((a) => a.members.map((m) => m.char));
  check('次选命中那一行的本队里没有该角色', !altHitRow.members.some((m) => m.char === 'Zed'));
  check('而它的次选里确实有（徽章不是假话）', altChars.includes('Zed'), altChars.join(','));

  check('结果按名次升序', ranksOf(zed).join(',') === [...ranksOf(zed)].sort((a, b) => a - b).join(','));

  // 超限索引：没有次选索引时，`altSearch` 必须如实说 false。
  const big = {
    lineups: Array.from({ length: PLAN_ALT_INDEX_MAX_LINEUPS + 1 }, () => ({
      members: [{ char: 'Hero', lc: null }], variants: [],
    })),
    nameOf,
  };
  const bigHit = searchPlanIndex(big, '英雄');
  eq('池子过大时 altSearch = false', bigHit.altSearch, false);
  eq('池子过大时仍能按本队搜到', bigHit.ids.length, big.lineups.length);
  eq('池子过大时不会假装有次选命中', bigHit.altOnly, 0);
}

// ------------------------------------------------------------------ 分页
console.log('\n[分页：每页 20 / 页码夹紧 / 页大小上限]');
{
  const ids = Array.from({ length: 267 }, (_, i) => i);
  const first = planPageOf(ids, 1);
  eq('第 1 页 20 条', first.ids.length, 20);
  eq('267 条 = 14 页', first.pages, 14);
  eq('第 1 页从 0 开始', first.start, 0);

  const last = planPageOf(ids, 14);
  eq('最后一页 7 条', last.ids.length, 7);
  eq('最后一页起点 260', last.start, 260);
  eq('最后一页末条 = 全局第 267 条', last.ids[6], 266);

  eq('页码 0 夹到第 1 页', planPageOf(ids, 0).page, 1);
  eq('页码 99 夹到最后一页', planPageOf(ids, 99).page, 14);
  eq('页码是 NaN 回第 1 页', planPageOf(ids, Number.NaN).page, 1);
  eq('页大小夹到上限', planPageOf(ids, 1, 100000).pageSize, PLAN_PAGE_SIZE_MAX);
  eq('页大小 0 退回默认 20', planPageOf(ids, 1, 0).pageSize, 20);

  const empty = planPageOf([], 3);
  eq('空结果也是 1 页', empty.pages, 1);
  eq('空结果页码夹到 1', empty.page, 1);
  eq('空结果没有行', empty.ids, []);

  const stitched = [];
  for (let p = 1; p <= 14; p += 1) stitched.push(...planPageOf(ids, p).ids);
  check('14 页拼回来等于原列表（不重不漏）', stitched.length === 267 && stitched[266] === 266);
}

// ------------------------------------------------------------------ 缓存
console.log('\n[整池缓存：条目数 + 总行数双预算]');
{
  const cache = createPlanCache({ limit: 2, rowBudget: 1000 });
  cache.set('a', 1, 10);
  cache.set('b', 2, 10);
  cache.get('a');                 // a 变新
  cache.set('c', 3, 10);
  check('超过条目数时淘汰最旧的（b）', cache.get('b') === null);
  check('最近用过的还在（a）', cache.get('a') === 1);
  check('新进的在（c）', cache.get('c') === 3);

  const budget = createPlanCache({ limit: 8, rowBudget: 100 });
  budget.set('big1', 1, 60);
  budget.set('big2', 2, 60);
  check('总行数超预算时挤掉旧的大池子', budget.get('big1') === null);
  check('新的大池子保留', budget.get('big2') === 2);
  budget.set('huge', 3, 5000);
  check('单个超大档位也保留（至少留一档）', budget.get('huge') === 3);
  eq('行数统计跟着淘汰走', budget.rows, 5000);

  const simple = createPlanCache({ limit: 2 });
  simple.set('k', 'v');
  simple.delete('k');
  check('delete 之后查不到', simple.get('k') === null);
}

// ------------------------------------------------------------------ 哈希
console.log('\n[签名哈希]');
{
  check('同输入同输出', hashOf('abc') === hashOf('abc'));
  check('不同输入不同输出', hashOf('abc') !== hashOf('abd'));
  check('空值不炸', typeof hashOf(undefined) === 'string');
}

// ------------------------------------------------------------------ 物化
console.log('\n[物化：只给要下发的行跑补金明细]');
{
  const account = { owned: new Set(), eidolons: new Map(), cones: new Map() };
  const state = buildPlanPool(BRANCHED, { availability: AVAIL, wc: 1, account });
  const line = materializePlanRow(state.lineups[0], state);
  check('物化行带齐补金明细与逐版本成绩',
    Boolean(line.key) && Array.isArray(line.fill) && Array.isArray(line.seasons));
  check('物化不改写整池行（同一行物化两次结果一致）',
    JSON.stringify(materializePlanRow(state.lineups[0], state)) === JSON.stringify(line));
  check('整池行上没有 fill（明细不落缓存）', state.lineups[0].fill === undefined);
}

console.log(`\n合计 ${passed} 项通过，${failed} 项失败`);
process.exitCode = failed ? 1 : 0;
