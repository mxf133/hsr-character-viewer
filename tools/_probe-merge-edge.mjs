/**
 * 四个分支合进 main 之后的**边缘探针**（v4.6.119 × v4.6.120 的交互）。
 *
 * 为什么要单独写这一个：那四个分支是**并行**开发的 —— 强度只看行动值、泛用性分位夹逼、
 * 性价比开平方、版本权重可增删，各自在自己的分支上都测过，但没人测过它们凑到一起之后
 * 的**边角**：
 *   * 版本权重的档位数会同时进**三条链**（强度 / 泛用性 / 抽卡方案的窗口长度），
 *     而另外三个分支各自往载荷里加了字段 —— 12 档时载荷还塞得进 660 KB 吗？
 *     （它就是这么抓到 661.5 KB 顶穿护栏的，见 `e2e-test` 那条注释）
 *   * 泛用性的尺子换成分位之后，「组内没样本」「样本全相等」这两种退化形状在
 *     **档位数变化导致样本量变化**时更容易撞上（1 档时很多人拿不到证据）。
 *   * 三个分项都可能出现 `lo == hi` 的退化区间，谁也不许吐 NaN / Infinity。
 *
 * 用法：`node tools/_probe-merge-edge.mjs`（要读 23 MB 数据集，跑 ~1 分钟）
 */
import {
  VERSION_WEIGHT_MIN,
  VERSION_WEIGHT_MAX,
  VERSION_WINDOW,
  versionWeightRows,
  versionWeightDefaults,
  versionWeightValues,
  versionWeightCountOf,
  normalizeVersionWeights,
  versatilityExtentOf,
} from '../public/scripts/advice.js';
import { archiveConclusion, archiveCharacterPacks } from '../src/server/conclusion.js';

const KB = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const CAP = 660 * 1024;
const fin = (v) => Number.isFinite(Number(v));
/** 与 `advice.js` 里 `spanOf` 同形的归一（退化区间给 1）。 */
const spanOf = (lo, hi, v) => (hi === lo ? 1 : (v - lo) / (hi - lo));

let bad = 0;
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  【${detail}】` : ''}`);
  if (!cond) bad += 1;
};

// ===========================================================================
console.log('\n【A】版本权重的档位（v4.6.120）在边界上退化成安全形状');
// ===========================================================================
{
  const rows13 = versionWeightRows(13);
  ok(rows13.length === VERSION_WEIGHT_MAX, '13 档被钳到上限 12', `实得 ${rows13.length}`);
  ok(versionWeightRows(0).length === VERSION_WEIGHT_MIN, '0 档被钳到下限 1',
    `实得 ${versionWeightRows(0).length}`);
  ok(versionWeightRows(-5).length === VERSION_WEIGHT_MIN, '负档数被钳到下限 1',
    `实得 ${versionWeightRows(-5).length}`);
  const rowsNaN = versionWeightRows(Number.NaN).length;
  ok(rowsNaN === VERSION_WEIGHT_MIN || rowsNaN === VERSION_WINDOW,
    'NaN 档数退化成 1 或默认 6（不许抛异常）', `实得 ${rowsNaN}`);
  // 第 7 档起沿用 0.5，不归零 —— 归零等于「加了一版但它不参与」
  const d12 = versionWeightDefaults(12);
  ok(d12.length === 12 && d12.slice(6).every((w) => w === 0.5),
    '第 7 档起默认是 0.5 而不是 0', `第 7~12 档 = ${d12.slice(6).join('/')}`);
  ok(d12.slice(0, 6).join(',') === '3,2.5,2,1.5,1,0.5',
    '前 6 档仍是 3/2.5/2/1.5/1/0.5', `前 6 档 = ${d12.slice(0, 6).join('/')}`);
}
{
  // 读数保档位（v4.6.120 的核心 —— 短数组不许被补齐到 6，否则「删一版」等于没反应）
  const three = [3, 2, 1];
  ok(versionWeightCountOf(three) === 3, '3 档的档位数 = 3', `${versionWeightCountOf(three)}`);
  ok(versionWeightValues(three).length === 3, '读数保住 3 档（不补齐到 6）',
    `${versionWeightValues(three).length} 档`);
  ok(versionWeightValues(three).join(',') === '3,2,1', '保住档位的同时保住数值',
    versionWeightValues(three).join(','));
  ok(versionWeightValues(versionWeightDefaults(12)).length === 12, '读数保住 12 档',
    `${versionWeightValues(versionWeightDefaults(12)).length} 档`);
  // ⚠️ 读数是**原值**：0 是用户能敲出来的合法值（那一版不进窗口），不许被当成缺失。
  ok(versionWeightValues([0, 0, 0]).join(',') === '0,0,0',
    '读数保留 0（0 = 那一版不进窗口，是原值不是缺失）', versionWeightValues([0, 0, 0]).join(','));
  const norm3 = normalizeVersionWeights([0, 0, 0]);
  ok(norm3.join(',') === '3,2.5,2', '全 0 归一化退回默认表且保住 3 档', norm3.join(','));
  const norm12 = normalizeVersionWeights(new Array(12).fill(0));
  ok(norm12.length === 12 && norm12.slice(0, 6).join(',') === '3,2.5,2,1.5,1,0.5',
    '12 档全 0 归一化后仍是 12 档（不会塌回 6 档）', `${norm12.length} 档`);
  const junk = normalizeVersionWeights([3, 'x', Number.NaN, -1, null, undefined]);
  ok(junk.every((w) => fin(w) && w >= 0), '非法元素退化成有限非负数', JSON.stringify(junk));
  ok(normalizeVersionWeights('nonsense').length === VERSION_WINDOW,
    '非数组的输入退化成默认 6 档', `${normalizeVersionWeights('nonsense').length} 档`);
}

// ===========================================================================
console.log('\n【B】泛用性的尺子（v4.6.119）在退化样本上不许出 NaN');
// ===========================================================================
{
  const e0 = versatilityExtentOf([]);
  ok(e0.lo === 0 && e0.hi === 0, '空样本 → {lo:0,hi:0}', JSON.stringify(e0));
  ok(fin(e0.lo) && fin(e0.hi), '空样本不产生 NaN/Infinity', JSON.stringify(e0));
  // 样本 < 20（阈值）退回 min/max：单样本时 lo == hi，这是**退化区间**
  const one = versatilityExtentOf([4]);
  ok(one.lo === one.hi, '单样本 → lo == hi（退化区间）', JSON.stringify(one));
  ok(spanOf(one.lo, one.hi, 4) === 1, '退化区间归一 = 1（全体同分，不除零）',
    `${spanOf(one.lo, one.hi, 4)}`);
  // 阈值两侧：19 个样本走 min/max、20 个样本走分位
  const seq = (n) => Array.from({ length: n }, (_, i) => i + 1);
  const e19 = versatilityExtentOf(seq(19));
  const e20 = versatilityExtentOf(seq(20));
  ok(e19.lo === 1 && e19.hi === 19, '19 个样本（< 阈值 20）退回 min/max', JSON.stringify(e19));
  ok(e20.lo > 1 && e20.hi < 20, '20 个样本走 p5/p95 裁剪', JSON.stringify(e20));
  // 离群值不许当上界
  const eo = versatilityExtentOf([...seq(40).map((v) => v + 1), 10000]);
  ok(eo.hi < 100, '离群值 10000 没当上界', `hi = ${eo.hi}`);
  ok(eo.lo >= 2, '离群值没把下界拉走', `lo = ${eo.lo}`);
  // 全 0（「不用抽就有」的角色恒 0 —— 它们本该被跳过，但兜底路径要扛住）
  const ez = versatilityExtentOf(new Array(30).fill(0));
  ok(ez.lo === 0 && ez.hi === 0, '全 0 样本 → 区间退化且不 NaN', JSON.stringify(ez));
  ok(fin(spanOf(ez.lo, ez.hi, 0)), '全 0 区间归一不出 NaN', `${spanOf(ez.lo, ez.hi, 0)}`);
  // 混进 NaN / undefined：抽样那层已经 `|| 0`，这里验尺子自己不再制造 NaN
  const dirty = versatilityExtentOf([1, 2, Number.NaN, 3, undefined, ...seq(22).map((v) => v + 3)]);
  ok(fin(dirty.lo) && fin(dirty.hi), '样本里混 NaN/undefined 也只出有限值', JSON.stringify(dirty));
}

// ===========================================================================
console.log('\n【C】性价比的刻度（v4.6.119）在 0 / 负数 / 退化区间上');
// ===========================================================================
{
  // 与 `advice.js` 里 `costScaled` 同一条式子
  const power = 0.5;
  const costScaled = (v) => Math.pow(Math.max(0, Number(v) || 0), power);
  ok(costScaled(0) === 0, 'total = 0 → 0（不是 NaN）', `${costScaled(0)}`);
  ok(costScaled(-5) === 0, '负数 total 先夹到 0 再开平方', `${costScaled(-5)}`);
  ok(costScaled(Number.NaN) === 0, 'NaN total → 0', `${costScaled(Number.NaN)}`);
  ok(costScaled(undefined) === 0, 'undefined total → 0', `${costScaled(undefined)}`);
  ok(fin(costScaled(1e12)), '极端大的 total 仍是有限值', `${costScaled(1e12)}`);
  const same = [7, 7, 7, 7].map(costScaled);
  const lo = Math.min(...same);
  const hi = Math.max(...same);
  ok(spanOf(lo, hi, same[0]) === 1, '全同的 total → 归一 = 1（不除零）',
    `${spanOf(lo, hi, same[0])}`);
  ok(same.every((v) => fin(spanOf(lo, hi, v))), '全同时每个整包都不出 NaN', '✓');
  const zero = [0, 0, 0].map(costScaled);
  ok(fin(spanOf(0, 0, 0)), '全 0 的 total 不出 NaN', `${spanOf(0, 0, 0)}`);
}

// ===========================================================================
console.log('\n【D】档位数 × 载荷体积（v4.6.119 × v4.6.120 的交互）');
// ===========================================================================
console.log('  构建结论（每次都要读 23 MB 数据集，慢一点是正常的）…');
{
  const account = { owned: [], eidolons: {}, cones: {} };
  const rows = [];
  for (const n of [1, 3, 6, 9, 12]) {
    // eslint-disable-next-line no-await-in-loop
    const c = await archiveConclusion(account, { versionWeights: versionWeightDefaults(n) });
    const bytes = Buffer.byteLength(JSON.stringify(c));
    // ⚠️ 两个不同的名单：`units` 是抽卡方案的候选队、`frontierUnits` 是角色总榜的整包
    //    （三个分项的得分挂在后者身上）。载荷体积主要就是这两个 + 四个档位的名单。
    rows.push({
      n,
      kb: bytes / 1024,
      units: c?.units?.length ?? -1,
      frontierUnits: c?.frontierUnits?.length ?? -1,
      tiers: Object.values(c?.frontierTiers ?? {}).reduce((a, v) => a + (v?.length || 0), 0),
    });
  }
  console.log('\n  | 档位 | 载荷 | 抽卡方案候选(units) | 总榜整包(frontierUnits) | 四个档位合计(frontierTiers) |');
  console.log('  | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    console.log(`  | ${r.n} | ${KB(r.kb * 1024)} | ${r.units} | ${r.frontierUnits} | ${r.tiers} |`);
  }
  const kbOf = (n) => rows.find((r) => r.n === n).kb * 1024;
  ok(kbOf(12) < CAP, '12 档时载荷仍在 660 KB 以内', KB(kbOf(12)));
  ok(rows.every((r) => r.kb * 1024 < CAP), '1 / 3 / 6 / 9 / 12 档全部在上限内',
    rows.map((r) => `${r.n}档=${KB(r.kb * 1024)}`).join(' '));
  console.log(`  （6 档 → 12 档：${KB(kbOf(6))} → ${KB(kbOf(12))}，`
    + `增量 ${(((kbOf(12) / kbOf(6)) - 1) * 100).toFixed(1)}%）`);
  ok(rows.every((r, i) => i === 0 || r.kb >= rows[i - 1].kb - 0.5),
    '载荷随档位数单调不减（没有忽大忽小）',
    rows.map((r) => `${r.n}:${KB(r.kb * 1024)}`).join(' → '));
}

// ===========================================================================
console.log('\n【E】1 档（最极端的一档）下三条链都不许空掉');
// ===========================================================================
{
  const rangeOf = (c) => {
    const list = c?.frontierUnits ?? [];
    return {
      list,
      inRange: list.every((u) => u.strengthScore >= 0 && u.strengthScore <= 100
        && u.costScore >= 0 && u.costScore <= 100
        && u.versatilityScore >= 0 && u.versatilityScore <= 100),
      finite: list.every((u) => fin(u.characterScore)
        && fin(u.strengthScore) && fin(u.costScore) && fin(u.versatilityScore)),
      maxStrength: Math.max(...list.map((u) => Number(u.strengthScore) || 0)),
    };
  };
  const one = rangeOf(await archiveConclusion({ owned: [], eidolons: {}, cones: {} },
    { versionWeights: [1] }));
  ok(one.list.length > 0, '1 档时角色总榜仍有条目', `${one.list.length} 条`);
  ok(one.finite, '1 档时三项分项得分与角色得分都是有限数', `${one.list.length} 条`);
  ok(one.inRange, '1 档时三项得分都在 0~100 内（分位夹逼没把人顶出去）', `${one.list.length} 条`);
  const twelve = rangeOf(await archiveConclusion({ owned: [], eidolons: {}, cones: {} },
    { versionWeights: versionWeightDefaults(12) }));
  ok(twelve.list.length > 0, '12 档时角色总榜有条目', `${twelve.list.length} 条`);
  ok(twelve.inRange, '12 档时三项得分都在 0~100 内', `${twelve.list.length} 条`);
  ok(twelve.finite, '12 档时角色得分都是有限数', `${twelve.list.length} 条`);
  // 继承取的是「更便宜整包的最高分」，不许把高成本档抬过 100
  ok(one.maxStrength <= 100 && twelve.maxStrength <= 100,
    '强度分没有被继承抬过 100',
    `1 档 max=${one.maxStrength.toFixed(1)} / 12 档 max=${twelve.maxStrength.toFixed(1)}`);
  // 角色面板那条投影：v4.6.119 补的三件套在 12 档下也要在
  const packName = twelve.list[0]?.name;
  if (packName) {
    const packs = await archiveCharacterPacks(packName);
    ok((packs?.packs ?? []).every((p) => p.ownGold !== undefined
      && p.ownGoldFactor !== undefined && p.ownGoldRef !== undefined),
    '面板投影的 ownGold 三件套仍在', `角色 ${packName}`);
  }
}

console.log(`\n${bad === 0 ? '全部通过 ✓' : `${bad} 项未通过 ✗`}`);
process.exit(bad === 0 ? 0 : 1);
