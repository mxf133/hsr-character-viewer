// 抽卡推荐页的**搜索 / 分页**纯逻辑（用户 2026-10-18 第 1、2 条）。
//
// 为什么这一套能离线跑：`public/scripts/advice-paging.js` 里只有「匹配一串名字、按页
// 切行、算翻页条页码」这些算术，**不碰 DOM、不碰评分、不读数据集**。所以它不需要
// 真浏览器，也不需要 DPAPI 凭证 —— 而那两样在本机沙箱里都起不来
// （见 `docs/CDP布局套件.md` §2.1：服务启动要 spawn PowerShell）。
//
//   node tools/paging-test.mjs
//
// 盯四件事：
//   ① 搜索：中文名 / 英文键 / 光锥名 都能命中，大小写与首尾空格不敏感，**不做前缀限定**；
//   ② 分页：284 条 → 每页 20 → 15 页、最后一页 4 条，且**每一行都不重不漏**；
//   ③ 页码越界要夹回（搜索把结果缩短后不能停在空页上）；
//   ④ 翻页条窗口：首末页恒在、当前页 ±2、跳段用省略号，格子数不随池子长大。
import {
  clampPage, matchesQuery, pageCountOf, pageSliceOf, pageWindowOf, queryOf, queryTermsOf,
  searchTextOf, withRealRank,
} from '../public/scripts/advice-paging.js';

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`); }
};
const eq = (name, actual, expect) => check(
  name,
  JSON.stringify(actual) === JSON.stringify(expect),
  `实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expect)}`,
);

// ---- ① 搜索词归一化 / 可搜索文本 -------------------------------------------
console.log('[搜索 — 归一化与匹配]');
eq('去首尾空格 + 转小写', queryOf('  FireFly '), 'firefly');
eq('空值归一成空串', queryOf(null), '');
eq('全空格归一成空串', queryOf('   '), '');

eq('中文名与英文键都在同一串里', searchTextOf(['流萤', 'Firefly']), '流萤 firefly');
eq('空值 / 非字符串被丢掉', searchTextOf(['流萤', null, '', undefined, 3]), '流萤');
// ⚠️ 用空格分隔的**理由**：直接拼接会造出跨名字的假子串（"流萤Firefly" 里搜 "萤F"）。
check('名字之间不会拼出假子串', !searchTextOf(['流萤', 'Firefly']).includes('萤f'));

const row = searchTextOf(['流萤', '流萤', 'Firefly', '梦应归于何处']);
check('中文名子串命中', matchesQuery(row, queryOf('流萤')));
check('英文键小写命中', matchesQuery(row, queryOf('firefly')));
check('光锥中文名命中', matchesQuery(row, queryOf('梦应')));
check('只记得中间一段也命中（不是前缀限定）', matchesQuery(row, queryOf('应归')));
check('不相关词不命中', !matchesQuery(row, queryOf('白厄')));
check('空搜索词 = 全部命中', matchesQuery(row, ''));
check('空搜索词对空文本也命中', matchesQuery('', ''));

// ---- ② 分页：284 条 / 每页 20 = 15 页 ---------------------------------------
// 284 是本机实测的候选池规模（`_probe-team-plan-perf.mjs`：账号 1 = 284 支），
// 拿它当样本才验得到「最后一页装不满」这种情况。
console.log('\n[分页 — 284 条 × 每页 20]');
const POOL = Array.from({ length: 284 }, (_, i) => ({ n: i + 1 }));
eq('总页数 = 15', pageCountOf(284, 20), 15);
eq('整除时不多出一页', pageCountOf(280, 20), 14);
eq('空列表也算 1 页（翻页条要能印「第 1/1 页」）', pageCountOf(0, 20), 1);
eq('只有 1 条也是 1 页', pageCountOf(1, 20), 1);

const first = pageSliceOf(POOL, 1, 20);
check('第 1 页 20 条', first.rows.length === 20, String(first.rows.length));
check('第 1 页从全局第 1 条开始', first.start === 0 && first.rows[0].n === 1);
check('第 1 页到最后一条是第 20 条（顺序不变）', first.rows[19].n === 20);
const last = pageSliceOf(POOL, 15, 20);
check('最后一页 4 条（284 = 14×20 + 4）', last.rows.length === 4, String(last.rows.length));
check('最后一页从全局第 281 条开始', last.start === 280 && last.rows[0].n === 281);
check('最后一页的全局序号能对上名次', last.start + last.rows.length === 284);

// 不重不漏：把 15 页拼起来必须恰好等于原列表。
const joined = [];
for (let p = 1; p <= pageCountOf(POOL.length, 20); p += 1) joined.push(...pageSliceOf(POOL, p, 20).rows);
check('15 页拼回来 = 原列表（不重不漏）',
  joined.length === POOL.length && joined.every((row2, i) => row2.n === i + 1),
  `${joined.length} 条`);

// ---- ③ 页码越界 -------------------------------------------------------------
console.log('\n[页码越界]');
check('页码 0 夹到第 1 页', pageSliceOf(POOL, 0, 20).page === 1);
check('页码 −3 夹到第 1 页', pageSliceOf(POOL, -3, 20).page === 1);
check('页码 99 夹到最后一页', pageSliceOf(POOL, 99, 20).page === 15);
check('页码是字符串也认', pageSliceOf(POOL, '3', 20).page === 3);
check('页码是 NaN 时回第 1 页', pageSliceOf(POOL, Number.NaN, 20).page === 1);
// 搜索把结果缩短到 3 条（1 页）时，停在第 12 页的用户不该看到空页。
check('结果变短后夹回第 1 页', pageSliceOf(POOL.slice(0, 3), 12, 20).page === 1
  && pageSliceOf(POOL.slice(0, 3), 12, 20).rows.length === 3);
eq('clampPage 单独可用', [clampPage(0, 15), clampPage(15, 15), clampPage(16, 15)], [1, 15, 15]);

// ---- ④ 翻页条窗口 -----------------------------------------------------------
console.log('\n[翻页条窗口]');
eq('前 3 页：首末页 + 1~5', pageWindowOf(1, 15), [1, 2, 3, '…', 15]);
eq('中间页：当前 ±2 且跳段用省略号', pageWindowOf(8, 15), [1, '…', 6, 7, 8, 9, 10, '…', 15]);
eq('末段：11~15 收尾', pageWindowOf(15, 15), [1, '…', 13, 14, 15]);
eq('只有 1 页时窗口只有 1', pageWindowOf(1, 1), [1]);
eq('2 页全列', pageWindowOf(2, 2), [1, 2]);
eq('5 页时不出现省略号', pageWindowOf(3, 5), [1, 2, 3, 4, 5]);
check('窗口里的页码恒在合法区间',
  pageWindowOf(8, 15).filter((p) => p !== '…').every((p) => p >= 1 && p <= 15));
check('窗口大小有上界（不随池子长大）', pageWindowOf(50, 100).length <= 9,
  `实际 ${pageWindowOf(50, 100).length} 个格子`);
check('页码越界时窗口也夹回来', JSON.stringify(pageWindowOf(99, 15)) === JSON.stringify(pageWindowOf(15, 15)));

// ---- ⑤ 搜索结果的名次 = 完整榜里的真实名次（用户 2026-10-18）------------------
console.log('\n[真实名次]');
const BOARD = Array.from({ length: 40 }, (_, i) => ({ key: `c${i + 1}` }));
const picked = [BOARD[7], BOARD[19], BOARD[20], BOARD[33]];
const ranked = withRealRank(BOARD, picked, (r) => r.key);
eq('命中的四行标出它们在完整榜里的名次',
  ranked.map((x) => x.rank), [8, 20, 21, 34]);
check('名次严格递增（与榜面顺序一致）',
  ranked.every((x, i) => i === 0 || ranked[i - 1].rank < x.rank));
// ⚠️ 这条是本节的核心：**不是** 1 起重新编号（那等于说「它在榜上排第 1」）。
check('第一行不是 #1（没有重新编号）', ranked[0].rank !== 1, `实测 ${ranked[0].rank}`);
// 不传 keyOf（两个数组引用同一批对象）也要能用 —— 那是视图里的常见形状。
eq('不传 keyOf 时按对象身份匹配',
  withRealRank(BOARD, picked).map((x) => x.rank), [8, 20, 21, 34]);
// 同一页里被截断/翻页切出来的片段，名次同样要落在完整榜里。
const pageSlice = pageSliceOf(picked, 2, 2);
eq('翻页后再标名次仍然对得上',
  withRealRank(BOARD, pageSlice.rows, (r) => r.key).map((x) => x.rank), [21, 34]);
// 未知行 → 0（保留而不是丢弃，便于排查「列表对不上」）。
eq('不在完整列表里的行给 0', withRealRank(BOARD, [{ key: 'nope' }], (r) => r.key)[0].rank, 0);
eq('空结果不炸', withRealRank(BOARD, [], (r) => r.key), []);

// ---- ⑥ 多关键词 AND 搜索（用户 2026-10-18）------------------------------------
//
// 用户原话：「搜索框应当支持多个关键词或者多个角色/光锥的搜索，给出同时包含这些词的
// 搜索结果」。关键是「**同时包含**」= AND，不是 OR。
console.log('\n[多关键词 — AND]');
const TEAM = searchTextOf(['流萤', 'Firefly', '银狼', 'SilverWolf', '银狼专锥']);
eq('空格分隔 → 两个词', queryTermsOf('流萤 银狼'), ['流萤', '银狼']);
eq('半角逗号分隔', queryTermsOf('流萤,银狼'), ['流萤', '银狼']);
eq('全角逗号分隔', queryTermsOf('流萤，银狼'), ['流萤', '银狼']);
eq('顿号分隔', queryTermsOf('流萤、银狼'), ['流萤', '银狼']);
eq('加号分隔', queryTermsOf('流萤+银狼'), ['流萤', '银狼']);
eq('混合分隔符 + 多余空白', queryTermsOf(' 流萤 ， 银狼、  '), ['流萤', '银狼']);
eq('英文大小写归一', queryTermsOf('Firefly silverwolf'), ['firefly', 'silverwolf']);
eq('只有分隔符 → 空数组（= 不过滤）', queryTermsOf('  , 、 '), []);

check('两个词都在 → 命中', matchesQuery(TEAM, '流萤 银狼'));
check('AND：只中一个词 → 不命中（不是 OR）', !matchesQuery(TEAM, '流萤 黄泉'));
check('AND：顺序无关', matchesQuery(TEAM, '银狼 流萤'));
check('角色 + 光锥可以混着搜', matchesQuery(TEAM, '流萤 银狼专锥'));
check('中英混写（大小写无关）', matchesQuery(TEAM, 'Firefly SilverWolf'));
check('三个词全中', matchesQuery(TEAM, '流萤 firefly 银狼'));
check('数组形式等价于字符串形式',
  matchesQuery(TEAM, ['流萤', '银狼']) === matchesQuery(TEAM, '流萤 银狼'));
check('空搜索词 = 全部命中', matchesQuery(TEAM, '') && matchesQuery(TEAM, '   '));
// 「同时包含」必须是**逐词**判据，不是「整串连续出现」：这条最容易被写成 includes(整串)。
check('两个词不必相邻（逐词各命中即可）',
  matchesQuery(searchTextOf(['流萤', '银狼', '黄泉']), '流萤 黄泉'));

// ---- 汇总 -------------------------------------------------------------------
console.log(`\n分页与搜索检查: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
