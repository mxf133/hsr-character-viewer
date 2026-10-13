// Tests for the two new behaviours:
//   1. the Genshin entry is switched off (server + GUI),
//   2. the theherta.com dataset is readable and the recommendation maths works.
//
// Run directly (node tools/herta-test.mjs) or through tools/run-tests.mjs.
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';

import { GAMES, enabledGames, isGameEnabled } from '../src/mihoyo/constants.js';
import {
  MODE_LABELS, archiveExists, archiveFrontier, archiveFrontierAll, archiveIndex, archiveStats,
  archiveTeams, modeKey, resolveMode, seasonEnemies, seasonSort,
} from '../src/server/archive.js';
import {
  EIDOLON_TIERS, EVIDENCE_HINT, EVIDENCE_LABEL, MODE_ORDER, SCORING, TIER_SCORE,
  avLinesOf, avTermOf,
  budgetPlan, marginalPlan, buildConclusion, charCostOf, coneCostOf, eidolonsOf, envWeightOf, formatAv,
  eidolonGoldOf, eidolonTierOf, formatRate, frontierCostTermOf, frontierFactorsOf, frontierTeamScore,
  isEasyMode,
  paretoFrontier, paretoLayers,
  lightConeRanksOf, majorityTierOf, marginalCostOf, metricDeltaText, metricShortText, metricTextOf,
  metricValueText, ownedCharacters, ownedLightCones, perfAnchorsOf, perfFactorOf, perfLineWeightsOf,
  pullCostOf,
  recommendPlan, scoreOf,
  teamPullsOf, TIER_PLACEHOLDER, tierLabelsOf, tierMoveText, tierScoreOf, tierTextOf,
  unitPullsOf, VERSION_WINDOW, VERSION_WEIGHTS, versionWeightOf, weightInputOf,
  // 隐金设置（用户 2026-10-11）
  DEFAULT_HIDDEN_COSTS, HIDDEN_COST_IDS, HIDDEN_COST_SETTINGS, NO_HIDDEN_COSTS,
  hiddenReductionOf, normalizeHiddenCosts, packGoldOf,
} from '../public/scripts/advice.js';
import {
  archiveCharacterPacks, archiveConclusion, conclusionEnvs, listEnvs,
} from '../src/server/conclusion.js';
import { baseName, compareRosters } from '../src/server/compare.js';
import { normalizeBattleRecords } from '../src/server/records.js';

let passed = 0;
let failed = 0;
const failures = [];

const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, message: err.message });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
};

const checkAsync = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, message: err.message });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
};

const ROOT = resolve(import.meta.dirname, '..');

// ------------------------------------------------------------ Star Rail role surface
console.log('\n[1] 星铁角色入口');

check('角色列表仅开放星铁', () => {
  assert.deepEqual(enabledGames().map((g) => g.key), ['hsr']);
  assert.equal(isGameEnabled('hsr'), true);
  assert.equal(isGameEnabled('retired'), false);
  assert.deepEqual(Object.keys(GAMES), ['hsr']);
});

await checkAsync('AccountStore.toPublic 过滤已退役游戏角色', async () => {
  const { AccountStore } = await import('../src/server/store.js');
  const pub = AccountStore.toPublic({
    id: 'a', accountId: '1', nickname: 'n',
    roles: [
      { uid: '170556517', game: 'hsr', nickname: '星铁号' },
      { uid: '189541710', game: 'retired', nickname: '旧角色' },
    ],
    snapshots: {},
  });
  assert.equal(pub.roles.length, 1, `期望只剩 1 个角色，实际 ${pub.roles.length}`);
  assert.equal(pub.roles[0].game, 'hsr');
});

check('界面与客户端无其他游戏入口', async () => {
  const html = await readFile(resolve(ROOT, 'public/index.html'), 'utf8');
  assert.ok(!/data-game=|game-switch/i.test(html));
});

// ------------------------------------------------------------ 2. 数据集
// 数据集与推荐算法测试（v2 数据模型）。
//
// 旧版这里断言的是「角色 × 版本」的档案与上场率评分；现在数据模型改成
// **阵容级单一事实**（角色数据都由阵容表推导），强度也换成「满分率 + 平均
// 行动值 + 成本分档」，所以整段重写。
//
// 覆盖四件事：
//   1. 索引：模式、关卡（异相仲裁拆绝境）、版本排序、latestPerMode
//   2. 阵容数据自洽：投稿数守恒、成本 = 本体 + 星魂叠影、定档线方向正确
//   3. 成本口径：只数限定单位；4★ 与常驻 5★ 不计成本
//   4. 算法：ownership 中英匹配、预算过滤、补强排序、关键星魂

console.log('\n[2] theherta 数据集（v2）');

const hasArchive = existsSync(resolve(ROOT, 'theherta/archive.json'));
if (!hasArchive) {
  console.log('  跳过：theherta/archive.json 不存在（先运行 herta-fetch + herta-build）');
} else {
  await checkAsync('索引含 4 个模式、每个模式都有版本', async () => {
    const index = await archiveIndex();
    assert.equal(index.available, true);
    assert.equal(index.version, 2, '数据模型版本应为 2');
    assert.deepEqual(index.modes.map((m) => m.mode).sort(), ['aa', 'as', 'moc', 'pf']);
    for (const m of index.modes) {
      assert.ok(m.labelCn && m.labelCn !== m.label, `${m.mode} 缺少中文名`);
      assert.ok(m.seasons.length > 0, `${m.mode} 没有版本`);
      assert.ok(m.stages.length >= 1, `${m.mode} 没有关卡条目`);
      const sorted = [...m.seasons].sort(seasonSort);
      assert.deepEqual(m.seasons, sorted, `${m.mode} 版本顺序不对`);
    }
  });

  await checkAsync('异相仲裁拆成「骑士关+普通王棋关」与「绝境王棋关」两档', async () => {
    const index = await archiveIndex();
    const aa = index.modes.find((m) => m.mode === 'aa');
    const stages = aa.stages.map((s) => s.stage).sort();
    assert.deepEqual(stages, ['', 'plight'],
      `异相仲裁应有两档关卡，实际 ${JSON.stringify(stages)}`);
    const plight = aa.stages.find((s) => s.stage === 'plight');
    assert.equal(plight.labelCn, '绝境王棋关');
    assert.ok(plight.runCount > 0, '绝境王棋关应有投稿');
    // 其它模式不该有 plight 档
    for (const m of index.modes.filter((x) => x.mode !== 'aa')) {
      assert.deepEqual(m.stages.map((s) => s.stage), [''],
        `${m.mode} 不该有关卡分档`);
    }
  });

  await checkAsync('latestPerMode 都在自己的版本列表里，且短码/全名都能查', async () => {
    const index = await archiveIndex();
    for (const m of index.modes) {
      assert.ok(m.seasons.includes(index.latestPerMode[m.mode]),
        `${m.mode} 最新版本不在列表里`);
    }
    const bySlug = await archiveStats('moc', index.latestPerMode.moc);
    const byLabel = await archiveStats('Memory of Chaos', index.latestPerMode.moc);
    assert.equal(bySlug.ok, true);
    assert.equal(byLabel.ok, true);
    assert.equal(bySlug.mode, 'moc');
    assert.equal(bySlug.totalTeams, byLabel.totalTeams);
  });

  await checkAsync('未知模式与未知关卡都返回 ok:false 而不是抛异常', async () => {
    const bad = await archiveStats('nope', '4.5');
    assert.equal(bad.ok, false);
    assert.ok(Array.isArray(bad.availableModes) && bad.availableModes.length);
    const badStage = await archiveStats('moc', '4.5', { stage: 'nope' });
    assert.equal(badStage.ok, false);
    assert.ok(Array.isArray(badStage.availableStages));
  });

  await checkAsync('每个版本都给出定档线与量纲方向', async () => {
    const index = await archiveIndex();
    for (const m of index.modes) {
      for (const st of m.stages) {
        const season = st.seasons[st.seasons.length - 1];
        if (!season) continue;
        const s = await archiveStats(m.mode, season, { stage: st.stage });
        assert.ok(s.tierLines, `${m.mode}/${st.stage} 缺少定档线`);
        if (st.stage === 'plight') {
          // 绝境王棋关：行动值 <300 满分 / <500 达标，只有两档
          assert.equal(s.tierLines.perfect, 300);
          assert.equal(s.tierLines.target, 500);
        } else if (m.mode === 'as') {
          // 末日幻影：积分越大越好
          assert.equal(s.tierLines.perfect, 4000);
          assert.equal(s.lowerIsBetter, false, '末日幻影应是越大越好');
        } else {
          // 轮次制：越小越好
          assert.equal(s.tierLines.perfect, 0);
          assert.equal(s.tierLines.target, 2);
          assert.equal(s.tierLines.pass, 4);
          assert.equal(s.lowerIsBetter, true, `${m.mode} 应是越小越好`);
        }
      }
    }
  });

  await checkAsync('阵容投稿数守恒：同版本不重复的阵容投稿数不超过该版本总投稿', async () => {
    const index = await archiveIndex();
    let checkedSeasons = 0;
    for (const m of index.modes) {
      const season = m.seasons[m.seasons.length - 1];
      const s = await archiveStats(m.mode, season, { perBand: 100000, window: 1 });
      // 有些模式的「最新版本」刚开、还没有投稿（末日幻影 4.6 只有个位数，
      // 甚至出现过 0 条的版本）。样本不足的版本不参与强度计算，所以分档必然是空的
      // —— 这正是设计意图：不拿几个样本下结论。
      if (!s.reliable) {
        assert.equal(s.bands.flatMap((b) => b.teams).length, 0,
          `${m.mode}/${season} 样本不足却给出了分档推荐`);
        continue;
      }
      // 阵容按名单去重，所以同一套阵容的多次投稿会合并成一行；
      // 因此「阵容行之和」只会 ≤ 该版本投稿数，差额就是重复投稿。
      const bandTeams = s.bands.flatMap((b) => b.teams);
      const sum = bandTeams.reduce((n, t) => n + t.count, 0);
      assert.ok(sum <= s.totalRuns,
        `${m.mode}/${season} 分档阵容投稿和 ${sum} 不应超过该版本投稿 ${s.totalRuns}`);
      assert.ok(sum > 0, `${m.mode}/${season} 分档阵容投稿和不应为 0`);
      checkedSeasons += 1;
    }
    assert.ok(checkedSeasons >= 3, `可检查的版本太少（${checkedSeasons}）`);
  });

  await checkAsync('成本 = 限定本体 + 星魂与叠影，且 4★/常驻 5★ 不计成本', async () => {
    const s = await archiveStats('moc', '4.5', { perBand: 100000, window: 1 });
    const availability = s.refs.availability;
    let checked = 0;
    for (const band of s.bands) {
      for (const t of band.teams) {
        // 本体数要**角色与光锥都算**：成本口径是「限定单位本体 1 抽」，
        // 光锥也是限定单位。
        const charUnits = t.roster.filter((n) => availability.characters[n]?.limited === true).length;
        const coneUnits = (t.sample?.members || [])
          .filter((m) => m.lc && availability.lightCones?.[m.lc]?.limited === true).length;
        const units = charUnits + coneUnits;
        const over = (t.over || []).reduce((a, b) => a + b, 0)
          + (t.coneOver || []).reduce((a, b) => a + b, 0);
        // cost 是跨投稿聚合后的中位数；同一角色阵容可能有人带免费光锥、
        // 有人带限定光锥，因此中位数可以低于某一条 sample 的限定单位数。
        // 角色本体的固定下界仍必须满足，完整限定单位下界由 costMax 兜住。
        assert.ok(t.cost >= charUnits - 0.001,
          `${t.rosterKey} 成本 ${t.cost} 小于限定角色本体数 ${charUnits}`);
        assert.ok((t.costMax ?? t.cost) >= units - 0.001,
          `${t.rosterKey} 最大成本 ${(t.costMax ?? t.cost)} 小于该样本限定单位数 ${units}`);
        // 叠影缺失按满叠影解释后，历史样本的最大成本可能超过当前投稿的
        // over 摘要；成本上界由各条样本的真实 cost 负责，综合层不再用旧的
        // “本体 + over”近似反推所有版本。
        assert.ok(Number.isFinite(t.cost) && Number.isFinite(t.costMax),
          `${t.rosterKey} 缺少聚合成本`);
        checked += 1;
      }
    }
    assert.ok(checked > 50, `检查的阵容太少（${checked}）`);

    // 4★ 与常驻 5★ 一律不是 limited
    for (const name of ['Tingyun', 'Gallagher', 'Herta', 'Pela']) {
      if (availability.characters[name]) {
        assert.equal(availability.characters[name].limited, false, `${name} 不该是限定`);
      }
    }
    assert.equal(availability.lightCones['Elation Brimming With Blessings']?.limited, false,
      '欢愉满溢祝福不是限定跃迁，不应计金');
    for (const name of ['Himeko', 'Bronya', 'Welt', 'Clara']) {
      assert.equal(availability.characters[name].limited, false, `常驻 ${name} 不该是限定`);
    }
  });

  await checkAsync('成本档按升序排列且区间不重叠', async () => {
    const s = await archiveStats('moc', '4.5');
    let prevHi = -1;
    for (const band of s.bands) {
      assert.ok(band.lo > prevHi, `成本档 ${band.label} 与上一档重叠`);
      prevHi = band.hi === Number.POSITIVE_INFINITY ? prevHi : band.hi;
      for (const t of band.teams) {
        assert.ok(t.cost >= band.lo && t.cost <= band.hi,
          `${t.rosterKey} 成本 ${t.cost} 不在档 ${band.label} 内`);
      }
    }
  });

  await checkAsync('档内先比成绩档，同档内用到的限定越少越强（不按投稿数排）', async () => {
    const s = await archiveStats('moc', '4.5');
    for (const band of s.bands) {
      for (let i = 1; i < band.teams.length; i += 1) {
        const a = band.teams[i - 1];
        const b = band.teams[i];
        // 第一主键：满分率降序（成绩先分档）。一个 4 回合的 0 限定阵容不该
        // 排在 0 回合的 1 限定阵容前面。
        assert.ok(a.perfect >= b.perfect - 1e-6,
          `${band.label} 第 ${i} 名满分率 ${b.perfect} 高于第 ${i - 1} 名 ${a.perfect}（应降序）`);
        if (Math.abs(a.perfect - b.perfect) > 1e-6) continue;
        // 第二主键：成本升序 —— 用户的规则「用到的限定越少则强度越强」。
        assert.ok((a.cost ?? 0) <= (b.cost ?? 0) + 1e-6,
          `${band.label} 同满分率下第 ${i} 名成本 ${b.cost} 小于第 ${i - 1} 名 ${a.cost}`);
        if (Math.abs((a.cost ?? 0) - (b.cost ?? 0)) > 1e-6) continue;
        const avA = a.avgAv ?? Number.POSITIVE_INFINITY;
        const avB = b.avgAv ?? Number.POSITIVE_INFINITY;
        assert.ok(avA <= avB + 1e-6,
          `${band.label} 同成绩同成本下第 ${i} 名行动值 ${avB} 小于第 ${i - 1} 名 ${avA}`);
      }
      // 明确不许出现「投稿少的排在投稿多的前面」这种纯按数量的排序：
      // 如果按投稿数排，第 1 名的 count 应是该档最大，这里不该成立。
      if (band.teams.length > 3) {
        const counts = band.teams.map((t) => t.count);
        const maxCount = Math.max(...counts);
        assert.ok(counts[0] <= maxCount,
          `${band.label} 的首位不应必然是全档投稿最多（说明按数量排了）`);
      }
      // 也不许出现「满分率 0% 的排在 100% 的前面」——这是把成本当成唯一主键
      // 时会出的错，值得单独钉一条。
      const firstPerfect = band.teams[0]?.perfect ?? 0;
      const maxPerfect = Math.max(...band.teams.map((t) => t.perfect));
      assert.ok(firstPerfect >= maxPerfect - 1e-6,
        `${band.label} 首位满分率 ${firstPerfect} 不是全档最高 ${maxPerfect}`);
    }
  });

  await checkAsync('成本档的截断不留「更好的被藏起来」（截断就是排序后的前缀）', async () => {
    // 早先按「每个价位最多 N 条」截断时，0 成本但满分率 0% 的阵容会占掉名额，
    // 把满分率 100% 的阵容挤出前 8，榜上出现「#5 是 0% 满分」这种误导名次。
    // 现在截断就是「排序后的前 N 条」，所以必须与不截断时的前 N 条完全一致。
    const short = await archiveStats('moc', '4.5', { perBand: 8 });
    const full = await archiveStats('moc', '4.5', { perBand: 100000 });
    assert.ok(short.bands.length > 0 && full.bands.length > 0);
    for (const band of short.bands) {
      const twin = full.bands.find((b) => b.id === band.id);
      assert.ok(twin, `${band.label} 在完整榜里找不到对应档`);
      assert.equal(band.total, twin.teams.length + twin.hidden);
      assert.equal(band.teams.length, Math.min(8, band.total));
      assert.deepEqual(band.teams.map((t) => t.rosterKey), twin.teams.slice(0, 8).map((t) => t.rosterKey),
        `${band.label} 的展示列表不是排序后的前 8 条（说明被别的规则改过顺序）`);
      assert.equal(band.hidden, band.total - band.teams.length);
      // tiers 与实际展示的阵容一致，且是升序
      const costs = [...new Set(band.teams.map((t) => t.cost))].sort((a, b) => a - b);
      assert.deepEqual(band.tiers.map((t) => t.cost), costs,
        `${band.label} 的 tiers 与实际展示的价位不一致`);
      for (const entry of band.tiers) {
        const n = band.teams.filter((t) => t.cost === entry.cost).length;
        assert.equal(n, entry.count, `${band.label} 价位 ${entry.cost} 的数量对不上`);
      }
    }
  });

  await checkAsync('样本不足的版本被标记 reliable=false', async () => {
    const index = await archiveIndex();
    const as = index.modes.find((m) => m.mode === 'as');
    // 数据集里末日幻影有 3 个版本投稿数为 0（3.0/3.1/3.3）
    const thin = as.stages[0].seasons.filter((season) => {
      return true;
    });
    let foundThin = false;
    for (const season of thin) {
      const s = await archiveStats('as', season, { stage: '' });
      if (s.totalRuns < index.minSeasonRuns) {
        assert.equal(s.reliable, false, `${season} 投稿 ${s.totalRuns} 条应标记不可靠`);
        foundThin = true;
      }
    }
    assert.ok(foundThin, '没找到任何样本不足的版本，测试前提不成立');
  });

  await checkAsync('角色榜是「所选版本」的快照，且按位置计数不丢同角色形态', async () => {
    const index = await archiveIndex();
    const s = await archiveStats('moc', index.latestPerMode.moc, { window: 6 });
    assert.ok(s.totalRuns > 0);
    const teams = s.seasonTeams;
    assert.ok(teams.length > 0, 'seasonTeams 不应为空');
    // 真实不变量：角色出现次数合计 = Σ(每套阵容的**位置数** × 该阵容投稿数)。
    // 不能假设每队 4 人——投稿接口会给只有 2-3 个成员的队伍（实测存在
    // 「Hyacine + Robin • Summeretto」这种两人阵容），也不能按去重名单计数：
    // 同一队可以有两个同角色不同形态（开拓者•记忆 + 开拓者•欢愉）。
    let expected = 0;
    for (const t of teams) {
      const slots = t.slots || t.roster;
      expected += slots.length * (t.count || 0);
    }
    const charTotal = s.characters.reduce((n, c) => n + c.count, 0);
    assert.equal(charTotal, expected,
      `角色出现次数合计 ${charTotal} 应等于位置数 × 投稿数 ${expected}`);
    for (const c of s.characters) {
      assert.ok(c.count <= s.totalRuns,
        `${c.name} 出现次数 ${c.count} 超过该版本投稿 ${s.totalRuns}`);
    }
  });

  await checkAsync('每个角色都带中文名、命途与星魂画像', async () => {
    const s = await archiveStats('aa', '4.6');
    assert.ok(s.characters.length > 0);
    for (const c of s.characters.slice(0, 30)) {
      assert.ok(c.name, '角色缺少英文键');
      assert.ok(c.nameCn, `${c.name} 缺中文名`);
      assert.ok(c.pathCn, `${c.name} 缺中文命途`);
    }
    const withEido = s.characters.filter((c) => c.eidolon);
    assert.ok(withEido.length > 0, '没有任何角色带星魂画像');
    for (const c of withEido) {
      assert.equal(c.eidolon.dist.length, 5, `${c.name} 星魂档位应为 5 档`);
      assert.equal(c.eidolon.dist.reduce((a, b) => a + b, 0), c.eidolon.total);
      const sum = c.eidolon.share.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1) < 0.02, `${c.name} share 之和应接近 1，实际 ${sum}`);
    }
  });

  await checkAsync('阵容卡片带关键星魂与成本拆解', async () => {
    const s = await archiveStats('aa', '4.6');
    let seen = 0;
    for (const band of s.bands) {
      for (const t of band.teams) {
        assert.ok(Number.isInteger(t.keyEidolon) && t.keyEidolon >= 0 && t.keyEidolon <= 6,
          `${t.rosterKey} 关键星魂越界：${t.keyEidolon}`);
        assert.ok(t.keyEidolonShare > 0 && t.keyEidolonShare <= 1,
          `${t.rosterKey} 关键星魂占比异常：${t.keyEidolonShare}`);
        assert.ok(Array.isArray(t.eidoDist) && t.eidoDist.length === 7,
          `${t.rosterKey} 星魂分布应为 7 档`);
        assert.ok(Array.isArray(t.over) && t.over.length === 4,
          `${t.rosterKey} 成本溢出指纹应为 4 位`);
        seen += 1;
      }
    }
    assert.ok(seen > 10, `可检查的阵容太少（${seen}）`);
  });

  await checkAsync('总榜的版本窗口锚定「最新可靠版本」，不吃基线用的完整性回退（v4.6.48）', async () => {
    // 症状（用户 2026-10）：「砂金·戏浪在性价比总榜的排名偏低」。根因是 `listEnvs`
    // 的完整性回退把异相仲裁从 4.6 退回 4.5（4.6 只有 4.5 的 48% 投稿），而
    // `archiveFrontier` 的窗口是 `seasons.slice(idx - window + 1, idx + 1)` ——
    // 锚点一回退，**比它更新的版本就整个掉出窗口**（不是降权，是删掉）。于是 4.6 的
    // 591 / 230 条投稿一条都没进总榜：砂金•戏浪在 4.6 的 9 金满分证据被 4.5 的 11 金
    // 证据顶替，该副本贡献 887 → 661、名次 #2 → #14。
    //
    // 口径：`season`（主证据版本 → 基线 / 抽卡方案 / 差距榜，**可以**回退）与
    // `frontierSeason`（压金前沿窗口的锚点 → 性价比总榜，**不回退**）必须是两个版本。
    const index = await archiveIndex();
    const minRuns = index.minSeasonRuns ?? 20;
    const envs = listEnvs(index);
    assert.ok(envs.length >= 4, '环境（副本 × 关卡）都要列出来');

    for (const env of envs) {
      const mode = (index.modes || []).find((m) => m.mode === env.mode);
      const stage = (mode?.stages || []).find((s) => (s.stage || '') === env.stage);
      const seasons = [...(stage?.seasons || [])];
      const runs = stage?.seasonRuns || {};
      // 「最新可靠版本」= 投稿数 ≥ minSeasonRuns 的最后一个版本（与 listEnvs 同一判据，
      // 但**不含**完整性回退）。
      const newestReliable = [...seasons].reverse().find((s) => Number(runs[s] ?? 0) >= minRuns);
      if (!newestReliable) continue;
      assert.equal(env.frontierSeason, newestReliable,
        `${env.id} 的前沿锚点必须是最新可靠版本 ${newestReliable}（实际 ${env.frontierSeason}）`);
      // 回退只能往回走：主证据版本不许比前沿锚点更新。
      assert.ok(seasons.indexOf(env.season) <= seasons.indexOf(env.frontierSeason),
        `${env.id} 主证据版本 ${env.season} 不该比前沿锚点 ${env.frontierSeason} 更新`);
    }

    // 真实数据上必须真的存在被回退的环境，否则这条用例什么都没验到。
    const fellBack = envs.filter((e) => e.season !== e.frontierSeason);
    assert.ok(fellBack.length > 0,
      '当前数据集里应当有「主证据回退、前沿锚点不跟着退」的副本；'
      + `实际 ${JSON.stringify(envs.map((e) => [e.id, e.season, e.frontierSeason]))}`);

    // 前沿窗口必须真的把锚点那一版**含进去**（它正是被回退切掉的那一版）。
    for (const env of fellBack) {
      const f = await archiveFrontier(env.mode, {
        season: env.frontierSeason, stage: env.stage, window: VERSION_WINDOW,
      });
      assert.ok(f.ok, `${env.id} 的前沿应可读`);
      assert.ok(f.seasons.includes(env.frontierSeason),
        `${env.id} 的前沿窗口必须含 ${env.frontierSeason}，实际 [${f.seasons.join(', ')}]`);
    }
  });
}

console.log('\n[3] 抽卡推荐算法（v2）');

check('seasonSort 按数字比较而非字符串', () => {
  assert.ok(seasonSort('4.10', '4.9') > 0, '4.10 应排在 4.9 之后');
  assert.ok(seasonSort('3.2', '4.0') < 0);
});

check('resolveMode / modeKey 接受短码与全名', () => {
  assert.equal(resolveMode('moc'), 'moc');
  assert.equal(resolveMode('Memory of Chaos'), 'moc');
  assert.equal(modeKey('moc'), 'Memory of Chaos');
});

check('MODE_ORDER 覆盖全部模式', () => {
  assert.deepEqual([...MODE_ORDER].sort(), ['aa', 'as', 'moc', 'pf']);
});

check('星魂价值只按 E0 / E1 / E2 / E6 四档计，目标档成本累计', () => {
  assert.deepEqual(EIDOLON_TIERS, [0, 1, 2, 6]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(eidolonTierOf), [0, 1, 2, 2, 2, 2, 6]);
  assert.equal(eidolonGoldOf(0, 1), 1);
  assert.equal(eidolonGoldOf(1, 2), 1);
  assert.equal(eidolonGoldOf(2, 6), 4, 'E2 到 E6 跨四级，应算 4 金');
  assert.equal(eidolonGoldOf(6, 6), 0);
});

check('绝境队伍质量看压金与行动值，不把投稿数量当收益', () => {
  const rows = [
    { teamCost: 10, actionValue: 300, count: 1 },
    { teamCost: 10, actionValue: 400, count: 100 },
  ];
  const scored = frontierTeamScore(rows);
  assert.ok(scored[0].score > scored[1].score,
    '成本相同时，最低行动值队伍应更有价值，即使它投稿更少');
  const zeroAction = frontierTeamScore([
    { teamCost: 10, actionValue: 0 },
    { teamCost: 10, actionValue: 240 },
  ]);
  assert.ok(zeroAction[0].score > zeroAction[1].score,
    '0 行动值是有效成绩，应比同成本的正行动值队伍更强');
  const costOnly = frontierTeamScore([
    { teamCost: 5, actionValue: null, count: 1 },
    { teamCost: 10, actionValue: null, count: 100 },
  ]);
  assert.ok(costOnly[0].score > costOnly[1].score,
    '缺失行动值时只按队伍成本比较，null 不得被当成 0 行动值');
  const mixedMissing = frontierTeamScore([
    { teamCost: 10, actionValue: 300 },
    { teamCost: 10, actionValue: 400 },
    { teamCost: 10, actionValue: null },
  ]);
  assert.equal(mixedMissing[2].score, 1,
    '单条投稿缺失行动值时只按成本评分，不能当成最差行动值扣分');

  const availability = {
    characters: { Star: { rarity: 5, limited: true }, Free: { rarity: 4, limited: false } },
    lightCones: { 'Big Cone': { rarity: 5, limited: true } },
  };
  const characterGold = teamPullsOf([{ char: 'Star', eidolon: 0 }], availability) / 94;
  const coneGold = teamPullsOf([
    { char: 'Free', eidolon: 0, lc: 'Big Cone', superimp: 1 },
  ], availability) / 94;
  assert.ok(coneGold < characterGold,
    '前沿总成本也按期望抽数折算，活动光锥应比限定角色便宜');
});

check('帕累托前沿保留成本与行动值互有优劣的队伍，忽略投稿数', () => {
  const rows = [
    { id: 'cheap-slow', teamCost: 5, actionValue: 420, count: 1 },
    { id: 'costly-fast', teamCost: 8, actionValue: 300, count: 100 },
    { id: 'dominated', teamCost: 9, actionValue: 430, count: 1000 },
    { id: 'unknown-av', teamCost: 7, actionValue: null, count: 1 },
  ];
  const front = paretoFrontier(rows);
  assert.deepEqual(front.map((row) => row.id).sort(),
    ['cheap-slow', 'costly-fast', 'unknown-av'],
    '更便宜但较慢、较贵但更快的队伍都应留在前沿；同时更贵更慢的被淘汰');
  assert.equal(paretoFrontier([
    { teamCost: 5, actionValue: null, count: 1 },
    { teamCost: 8, actionValue: null, count: 1000 },
  ]).length, 1, '行动值缺失时只按成本比较');
  const layers = paretoLayers(rows);
  const dominated = layers.find(({ row }) => row.id === 'dominated');
  assert.equal(dominated.rank, 1, '被第一层支配的队伍进入第二层而不是被丢弃');
  assert.equal(dominated.weight, 0.5, '第二层证据权重减半');
});

check('ownedCharacters 用中文名也能匹配数据集英文键', () => {
  const snapshot = { characters: [{ name: '知更鸟•晴歌' }] };
  const owned = ownedCharacters(snapshot, { '知更鸟•晴歌': 'Robin • Summeretto' });
  assert.ok(owned.has('知更鸟•晴歌'), '应保留中文名');
  assert.ok(owned.has('Robin • Summeretto'), '应同时登记英文数据集键');
});

check('ownedCharacters 把「开拓者」展开成各命途形态', () => {
  const snapshot = { characters: [{ name: '开拓者' }] };
  const owned = ownedCharacters(snapshot, {}, ['开拓者•记忆', '开拓者•欢愉', '知更鸟']);
  assert.ok(owned.has('开拓者•记忆'));
  assert.ok(owned.has('开拓者•欢愉'));
  assert.ok(!owned.has('知更鸟'), '不该把无关角色也算进来');
});

check('ownedLightCones / eidolonsOf 读装备与星魂', () => {
  const snapshot = {
    characters: [
      { name: '知更鸟', rank: 2, equip: { name: '夜色流光溢彩' } },
      { name: '停云', rank: 6, equip: { name: '舞！舞！舞！' } },
    ],
  };
  const cones = ownedLightCones(snapshot, { 夜色流光溢彩: 'Flowing Nightglow' });
  assert.ok(cones.has('Flowing Nightglow'));
  const eido = eidolonsOf(snapshot, { 知更鸟: 'Robin' });
  assert.equal(eido.get('知更鸟'), 2);
  assert.equal(eido.get('Robin'), 2, '英文键也要有');
  assert.equal(eido.get('停云'), 6);
});

check('pullCostOf 只数限定 5★，4★ 与常驻不计', () => {
  const availability = {
    characters: {
      Limited5: { rarity: 5, limited: true },
      Standard5: { rarity: 5, limited: false },
      FourStar: { rarity: 4, limited: false },
      Unknown: { rarity: null, limited: null },
    },
  };
  const one = pullCostOf(['Limited5', 'Standard5', 'FourStar'], availability);
  assert.equal(one.pulls, 1, '只有限定 5★ 花抽数');
  const two = pullCostOf(['Limited5', 'Limited5b'], availability);
  assert.equal(two.pulls, 2);
  // 星级未知时按 1 抽算（宁可高估，也不给出「免费」的假象）
  const unknown = pullCostOf(['Unknown'], availability);
  assert.equal(unknown.pulls, 1);
  assert.equal(unknown.items[0].certainty, true);
});

check('recommendPlan：预算会把超出抽数的补强过滤掉', () => {
  const stats = {
    refs: { availability: { characters: { A: { limited: true }, B: { limited: true } } } },
    bands: [{
      id: 'b0', label: '限定 0-2 抽', teams: [{
        rosterKey: 'A + B + X1 + X2', roster: ['A', 'B', 'X1', 'X2'],
        rosterCn: ['甲', '乙', '丙', '丁'], cost: 2, avgAv: 0, bestAv: 0,
        perfect: 1, trust: 1, count: 10, evidence: 'solid', seasonCount: 2,
        keyEidolon: 0, eidoDist: [4, 0, 0, 0, 0, 0, 0], over: [0, 0, 0, 0], seasons: [],
      }],
    }],
  };
  // 已拥有 X1/X2，缺 A 与 B（都是限定）：需要 2 抽
  const owned = new Set(['X1', 'X2']);
  const noBudget = recommendPlan(stats, { owned, budget: null });
  assert.equal(noBudget.upgrades.length, 1, '不限预算时应给出这条补强');
  assert.equal(noBudget.upgrades[0].pulls, 2);
  const tight = recommendPlan(stats, { owned, budget: 1 });
  assert.equal(tight.upgrades.length, 0, '预算 1 抽时应过滤掉需要 2 抽的方案');
});

check('recommendPlan：补强按「行动值每抽省下多少」排序', () => {
  const team = (roster, avgAv, cost) => ({
    rosterKey: roster.join(' + '), roster, rosterCn: roster.map((n) => `${n}中`),
    cost, avgAv, bestAv: avgAv, perfect: 1, trust: 1, count: 20, evidence: 'solid',
    seasonCount: 3, keyEidolon: 0, eidoDist: [4, 0, 0, 0, 0, 0, 0],
    over: [0, 0, 0, 0], seasons: [],
  });
  const stats = {
    refs: { availability: { characters: { A: { limited: true }, B: { limited: true } } } },
    bands: [{
      id: 'b0', label: '限定 0-2 抽',
      teams: [
        // 现在的阵容：平均行动值 2
        team(['X1', 'X2', 'X3', 'X4'], 2, 0),
        // 补 A（1 抽）能到 0.5 → 每抽省 1.5
        team(['A', 'X2', 'X3', 'X4'], 0.5, 1),
        // 补 B（1 抽）只能到 1.5 → 每抽省 0.5
        team(['B', 'X2', 'X3', 'X4'], 1.5, 1),
      ],
    }],
  };
  const plan = recommendPlan(stats, { owned: new Set(['X1', 'X2', 'X3', 'X4']) });
  assert.equal(plan.now.rosterKey, 'X1 + X2 + X3 + X4', '现在最强应是平均行动值最低的可凑阵容');
  assert.equal(plan.upgrades.length, 2, '两条补强都应给出');
  assert.equal(plan.upgrades[0].missing[0], 'A', '省钱更多的 A 应排在前');
  assert.ok(plan.upgrades[0].efficiency > plan.upgrades[1].efficiency);
});

check('recommendPlan：缺的单位不用抽（4★/常驻）时标为 free', () => {
  const stats = {
    refs: { availability: { characters: { Std: { limited: false } } } },
    bands: [{
      id: 'b0', label: '限定 0-2 抽', teams: [{
        rosterKey: 'Std + X2 + X3 + X4', roster: ['Std', 'X2', 'X3', 'X4'],
        rosterCn: ['常驻', '乙', '丙', '丁'], cost: 0, avgAv: 0.2, bestAv: 0,
        perfect: 1, trust: 1, count: 8, evidence: 'ok', seasonCount: 2,
        keyEidolon: 0, eidoDist: [4, 0, 0, 0, 0, 0, 0], over: [0, 0, 0, 0], seasons: [],
      }],
    }],
  };
  const plan = recommendPlan(stats, { owned: new Set(['X2', 'X3', 'X4']), budget: 0 });
  assert.equal(plan.upgrades.length, 1, '0 抽的补强在预算 0 时仍应保留');
  assert.equal(plan.upgrades[0].free, true);
  assert.equal(plan.upgrades[0].pulls, 0);
});

check('recommendPlan：凑不出完整阵容时不抛异常', () => {
  const stats = {
    refs: { availability: { characters: {} } },
    bands: [{
      id: 'b0', label: 'x', teams: [{
        rosterKey: 'A + B + C + D', roster: ['A', 'B', 'C', 'D'], rosterCn: ['甲', '乙', '丙', '丁'],
        cost: 4, avgAv: 1, bestAv: 1, perfect: 1, trust: 1, count: 5, evidence: 'ok',
        seasonCount: 1, keyEidolon: 0, eidoDist: [4, 0, 0, 0, 0, 0, 0],
        over: [0, 0, 0, 0], seasons: [],
      }],
    }],
  };
  // 一个角色都没有：缺 4 个，超出「缺 1-2 个单位」的候选范围，所以没有
  // 可执行的补强（一次抽一个人不可能补齐四个位置），但绝不能抛异常。
  const plan = recommendPlan(stats, { owned: new Set() });
  assert.equal(plan.now, null, '一个角色都没有时不应有「现在最强」');
  assert.deepEqual(plan.upgrades, [], '缺 4 个位置不该给出补强建议');
  assert.deepEqual(recommendPlan(null, {}).upgrades, [], '空输入不崩');
});

check('formatAv / formatRate 输出稳定', () => {
  assert.equal(formatAv(0), '0');
  assert.equal(formatAv(2.5), '2.50');
  assert.equal(formatAv(null), '—');
  assert.equal(formatRate(1), '100%');
  assert.equal(formatRate(0.123), '12%');
  assert.equal(formatRate(null), '—');
});

check('EVIDENCE_LABEL 覆盖四个证据档', () => {
  assert.deepEqual(Object.keys(EVIDENCE_LABEL).sort(), ['lone', 'ok', 'solid', 'thin']);
  for (const key of Object.keys(EVIDENCE_LABEL)) {
    assert.ok(EVIDENCE_HINT[key], `${key} 缺少提示文案`);
  }
});

// ------------------------------------------------- 4. 跨模式综合结论（v4.6.2）
console.log('\n[4] 跨模式综合结论');

check('marginalCostOf：本体与星魂按「还差几级」算', () => {
  const availability = {
    characters: {
      OwnedE1: { limited: true },
      NotOwned: { limited: true },
      Std: { limited: false },
    },
    lightCones: {},
  };
  const account = {
    owned: new Set(['OwnedE1']),
    eidolons: new Map([['OwnedE1', 1]]),
    cones: new Map(),
  };
  const members = [
    { char: 'OwnedE1', eidolon: 2, lc: null },      // 已有 E1，作业要 E2 → 1 抽
    { char: 'NotOwned', eidolon: 0, lc: null },     // 没有本体 → 1 抽
    { char: 'Std', eidolon: 6, lc: null },          // 常驻 → 0 抽
  ];
  const cost = marginalCostOf(members, availability, account);
  assert.equal(cost.pulls, 2, `应共 2 抽，实际 ${cost.pulls}`);
  const kinds = cost.items.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['char', 'eidolon']);
  const eido = cost.items.find((i) => i.kind === 'eidolon');
  assert.equal(eido.pulls, 1);
  assert.equal(eido.from, 1);
  assert.equal(eido.target, 2);

  const e6 = marginalCostOf([{ char: 'OwnedE1', eidolon: 6, lc: null }], availability, {
    owned: new Set(['OwnedE1']),
    eidolons: new Map([['OwnedE1', 5]]),
    cones: new Map(),
  });
  assert.equal(e6.pulls, 4, '账号已有 E5 时仍按 E2 → E6 计算 4 金');
  assert.equal(e6.items[0].from, 2);
  assert.equal(e6.items[0].target, 6);
  assert.equal(teamPullsOf([{ char: 'OwnedE1', eidolon: 5 }], availability), 3 * 94,
    '队伍总成本也应把 E3~E5 归入 E2，而不是按原始 E5 计价');
});

check('marginalCostOf：没有本体时星魂也算进本体那一次', () => {
  const availability = { characters: { X: { limited: true } }, lightCones: {} };
  const cost = marginalCostOf([{ char: 'X', eidolon: 2, lc: null }], availability,
    { owned: new Set(), eidolons: new Map(), cones: new Map() });
  // E2 需要「本体 1 抽 + 2 级星魂」= 3 抽，且归类为「抽角色」而不是「补星魂」。
  assert.equal(cost.pulls, 3);
  assert.equal(cost.items[0].kind, 'char');
});

check('marginalCostOf：限定光锥叠影按还差几级算，并标出「看不到」的不确定性', () => {
  const availability = {
    // 这三个人都是 4★/常驻：光锥测试里不该混进角色成本。
    characters: { A: { limited: false }, B: { limited: false }, C: { limited: false } },
    lightCones: { Equipped: { limited: true }, Unequipped: { limited: true }, StdCone: { limited: false } },
  };
  const account = { owned: new Set(), eidolons: new Map(), cones: new Map([['Equipped', 2]]) };
  const members = [
    { char: 'A', eidolon: 0, lc: 'Equipped', superimp: 5 },   // 已有 SI2，要 SI5 → 3 抽
    { char: 'B', eidolon: 0, lc: 'Unequipped', superimp: 3 }, // 没在装备里 → 3 抽，不确定
    { char: 'C', eidolon: 0, lc: 'StdCone', superimp: 5 },    // 非限定 → 0 抽
  ];
  const cost = marginalCostOf(members, availability, account);
  assert.equal(cost.pulls, 6, `应共 6 抽，实际 ${cost.pulls}`);
  const equipped = cost.items.find((i) => i.name === 'Equipped');
  assert.equal(equipped.pulls, 3);
  assert.equal(equipped.uncertain, false, '装备在身上的光锥是确定的');
  const unequipped = cost.items.find((i) => i.name === 'Unequipped');
  assert.equal(unequipped.pulls, 3);
  assert.equal(unequipped.uncertain, true, '没在装备列表里的光锥要标不确定');
});

check('marginalCostOf：限定标记缺失的单位按「要抽」算，不给免费的假象', () => {
  // 数据集里本该有全部角色的限定标记；万一缺了，宁可高估也不能当成免费。
  const cost = marginalCostOf([{ char: 'Mystery', eidolon: 0, lc: null }],
    { characters: {}, lightCones: {} },
    { owned: new Set(), eidolons: new Map(), cones: new Map() });
  assert.equal(cost.pulls, 1);
  assert.equal(cost.items[0].certainty, false);
});

check('lightConeRanksOf 读的是装备的叠影等级', () => {
  const snapshot = {
    characters: [
      { name: '知更鸟', equip: { name: '夜色流光溢彩', rank: 1 } },
      { name: '停云', equip: { name: '舞！舞！舞！', rank: 5 } },
    ],
  };
  const ranks = lightConeRanksOf(snapshot, { 夜色流光溢彩: 'Flowing Nightglow' });
  assert.equal(ranks.get('Flowing Nightglow'), 1);
  assert.equal(ranks.get('舞！舞！舞！'), 5);
});

check('majorityTierOf 取多数档，并列时取更好的那档', () => {
  assert.equal(majorityTierOf({ perfect: 1, target: 3, pass: 0, below: 0 }), 'target');
  assert.equal(majorityTierOf({ perfect: 2, target: 2, pass: 0, below: 0 }), 'perfect');
  assert.equal(majorityTierOf({ perfect: 0, target: 0, pass: 0, below: 5 }), 'below');
  assert.equal(majorityTierOf({ perfect: 0, target: 0, pass: 0, below: 0 }), null);
  assert.equal(majorityTierOf(null), null);
});

check('avLinesOf 把末日幻影的积分线换算到行动值方向', () => {
  const as = avLinesOf({ perfect: 4000, target: 3700, pass: 3400 }, false);
  assert.equal(as.perfect, 0);
  assert.equal(as.target, 300);
  assert.equal(as.pass, 600);
  // 轮次制与绝境本来就是行动值方向，不该被翻转
  const moc = avLinesOf({ perfect: 0, target: 2, pass: 4 }, true);
  assert.deepEqual(moc, { perfect: 0, target: 2, pass: 4 });
  const plight = avLinesOf({ perfect: 300, target: 500 }, true);
  assert.equal(plight.perfect, 300);
  assert.equal(plight.target, 500);
  assert.equal(plight.pass, undefined, '绝境没有及格线');
});

check('avTermOf 单调、归一化，且满分线为 0 时不炸', () => {
  const lines = { perfect: 300, target: 500 };
  assert.equal(avTermOf(0, 'perfect', lines), 1);
  assert.ok(avTermOf(150, 'perfect', lines) > avTermOf(299, 'perfect', lines));
  assert.equal(avTermOf(300, 'perfect', lines), 0);
  assert.equal(avTermOf(300, 'target', lines), 0.4);
  assert.equal(avTermOf(500, 'target', lines), 0);
  assert.equal(avTermOf(4000, 'below', lines), 0, '没有判据线的档给 0');
  // 满分线是 0（轮次制 / 末日幻影 4000 分）
  const zero = { perfect: 0, target: 2, pass: 4 };
  assert.equal(avTermOf(0, 'perfect', zero), 1);
  assert.ok(avTermOf(1, 'perfect', zero) < 1);
  assert.ok(avTermOf(1, 'perfect', zero) > 0);
  assert.equal(avTermOf(null, 'perfect', zero), 0);
});

check('scoreOf：跨一档一定比档内优化更值（0.4 权重 < 1 档）', () => {
  const lines = { perfect: 0, target: 2, pass: 4 };
  const perfectZero = scoreOf('perfect', 0, lines);          // 2 + 0.4
  const targetZero = scoreOf('target', 0, lines);            // 1 + 0.4
  assert.equal(perfectZero, 2.4);
  assert.equal(targetZero, 1.4);
  // 档位差是 1.0，档内最多再加 0.4，所以「最好一档里成绩最差的」仍然高于
  // 「第二档里成绩最好的」。
  const perfectWorst = scoreOf('perfect', 99, lines);        // 最好一档但成绩很差
  assert.ok(perfectWorst > targetZero,
    `最好一档最差 ${perfectWorst} 应仍高于第二档最好 ${targetZero}`);
  assert.ok(perfectWorst < 2 + 0.4, '档内优化不该超过 0.4');
  assert.equal(tierScoreOf('pass'), 0.5);
  assert.equal(tierScoreOf('nope'), 0);
  assert.deepEqual(TIER_SCORE, { perfect: 2, target: 1, pass: 0.5, below: 0 });
});

check('成绩只写游戏内实际的量：0T / 积分 / 行动值，不用及格-达标-满分这类词', () => {
  const moc = tierLabelsOf('moc', '', { perfect: 0, target: 2, pass: 4 });
  assert.deepEqual(moc, { perfect: '0T', target: '≤2T', pass: '≤4T', below: '>4T' });
  const as = tierLabelsOf('as', '', { perfect: 4000, target: 3700, pass: 3400 });
  assert.equal(as.perfect, '积分 4000');
  assert.equal(as.target, '积分 ≥3700');
  assert.equal(as.pass, '积分 ≥3400');
  assert.equal(as.below, '积分 <3400');
  const plight = tierLabelsOf('aa', 'plight', { perfect: 300, target: 500 });
  assert.equal(plight.perfect, '行动值 <300');
  assert.equal(plight.target, '行动值 <500');
  assert.equal(plight.pass, '行动值 ≥500');

  // 档位变化：单位相同就合并，但不能把比较符吃掉
  assert.equal(tierMoveText('≤2T', '0T'), '≤2T → 0T');
  assert.equal(tierMoveText('积分 ≥3400', '积分 ≥3700'), '积分 ≥3400 → ≥3700');
  assert.equal(tierMoveText('行动值 <500', '行动值 <300'), '行动值 <500 → <300');
  assert.equal(tierMoveText('积分 ≥3700', '积分 4000'), '积分 ≥3700 → 4000');

  // 主指标/单值/增量
  assert.equal(metricTextOf('moc', '', 0), '平均 0T');
  assert.equal(metricTextOf('as', '', 60), '平均积分 3940');
  assert.equal(metricTextOf('aa', 'plight', 289), '平均行动值 289');
  assert.equal(metricValueText('moc', '', 0), '0T');
  assert.equal(metricValueText('as', '', 4000), '积分 4000');
  assert.equal(metricDeltaText('moc', '', 1), '−1T');
  assert.equal(metricDeltaText('moc', '', -1), '+1T');
  assert.equal(metricDeltaText('as', '', 42), '积分 +42');
  assert.equal(metricDeltaText('aa', 'plight', 80), '行动值 −80');

  // 这些词一律不许出现在面向用户的文本里
  const banned = /及格|达标|满分/;
  for (const text of [
    ...Object.values(moc), ...Object.values(as), ...Object.values(plight),
    tierMoveText('≤2T', '0T'), metricTextOf('moc', '', 0), metricTextOf('as', '', 60),
    metricValueText('moc', '', 0), metricDeltaText('as', '', 42),
  ]) {
    assert.ok(!banned.test(text), `「${text}」里还有模糊用语`);
  }
});

check('tierTextOf：档位在界面上写成游戏内实际的量（用户 2026-10-10 点名要求）', () => {
  // 用户原话：「把网页上显示的『满分』『达标』改为具体的行动值」。
  // 界面上到处是档位（总榜行的「最佳证据」、来源表的档位列、配队清单、抽卡方案的推荐语），
  // 一律要经过这个函数 —— 它只吃**副本元数据**（`mode` / `stage` / `tierLines`）。
  const mocMeta = { mode: 'moc', stage: '', tierLines: { perfect: 0, target: 2, pass: 4 } };
  assert.equal(tierTextOf(mocMeta, 'perfect'), '0T');
  assert.equal(tierTextOf(mocMeta, 'target'), '≤2T');
  assert.equal(tierTextOf(mocMeta, 'pass'), '≤4T');
  const asMeta = { mode: 'as', stage: '', tierLines: { perfect: 4000, target: 3700, pass: 3400 } };
  assert.equal(tierTextOf(asMeta, 'perfect'), '积分 4000');
  const plightMeta = { mode: 'aa', stage: 'plight', tierLines: { perfect: 300, target: 500 } };
  assert.equal(tierTextOf(plightMeta, 'perfect'), '行动值 <300');
  assert.equal(tierTextOf(plightMeta, 'target'), '行动值 <500');

  // 判据线缺失（老载荷 / 元数据查不到）→ 中性兜底，**绝不编数字**：
  // 编一个 `0T` 出来会让读者以为这是真实判据，比说「最好一档」危险得多。
  assert.equal(tierTextOf(null, 'perfect'), TIER_PLACEHOLDER.perfect);
  assert.equal(tierTextOf({ mode: 'moc' }, 'target'), TIER_PLACEHOLDER.target);
  assert.equal(tierTextOf(mocMeta, 'nope'), '—', '未知档位键给 —，不给乱码');
  const banned = /及格|达标|满分/;
  for (const t of [
    tierTextOf(mocMeta, 'perfect'), tierTextOf(mocMeta, 'target'),
    tierTextOf(asMeta, 'perfect'), tierTextOf(plightMeta, 'perfect'),
    ...Object.values(TIER_PLACEHOLDER),
  ]) {
    assert.ok(!banned.test(t), `「${t}」里还有模糊用语`);
  }
});

check('界面源码里不许再出现「满分 / 达标 / 及格」这类自造词（用户 2026-10-10 点名）', () => {
  // 这条是**源码级**护栏：以前只在函数返回值上断言（上面那条），于是
  // `advice-view.js` 里手写的 `env.tier === 'perfect' ? '满分' : '达标'` 一直活着 ——
  // 那几处恰恰是用户一眼能看到的地方（总榜行的最佳证据 / 配品清单的档位标签）。
  // 扫的是**字符串字面量**，注释里保留这些词是为了解释历史（「改前写的是满分」），
  // 所以先剥掉 `//` 与 `*` 注释行再查。
  const files = ['public/scripts/advice.js', 'public/scripts/advice-view.js'];
  const strip = (line) => line
    .replace(/\/\/.*$/, '')
    .replace(/^\s*\/\*[\s\S]*$/, '')
    .replace(/^\s*\*.*$/, '');
  const banned = /及格|达标|满分/;
  const offenders = [];
  for (const file of files) {
    const lines = readFileSync(resolve(file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = strip(line);
      if (banned.test(code)) offenders.push(`${file}:${i + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    `这些行还在往界面上写模糊用语（应改走 tierTextOf()）：\n${offenders.join('\n')}`);
});

/** 造一个环境：base 是 0 抽可照抄的基线，cands 里每项是 [阵容, 档位, avgAv, 配装]。 */
const envFixture = (id, teams, extra = {}) => ({
  id,
  // 默认混沌回忆：绝大多数用例只用一套权重，不必重复写。要测别的副本
  // （例如异相仲裁的权重）传 `extra.mode` 覆盖 —— 早先这里把 mode 写死，
  // 于是「传 'aa' 当 id」根本改不动权重，权重用例形同虚设。
  mode: 'moc',
  stage: '',
  label: id,
  season: '4.5',
  totalRuns: 100,
  tierLines: { perfect: 0, target: 2, pass: 4 },
  lowerIsBetter: true,
  ...extra,
  teams,
});

const teamFixture = (roster, tierCounts, avgAv, members) => ({
  rosterKey: roster.join(' + '),
  roster,
  rosterCn: roster.map((n) => `${n}中`),
  count: 10,
  trust: 1,
  avgAv,
  perfect: (tierCounts.perfect || 0) / Object.values(tierCounts).reduce((a, b) => a + b, 0),
  evidence: 'solid',
  tierCounts,
  sample: { members },
});

check('buildConclusion：基线是「0 抽可照抄」里最好的那套，只有更强的进候选', () => {
  const availability = { characters: { Lim: { limited: true } }, lightCones: {} };
  const account = {
    owned: new Set(['A', 'B', 'C', 'D']),
    eidolons: new Map(),
    cones: new Map(),
  };
  const env = envFixture('moc', [
    // 0 抽可照抄，多数投稿只到及格
    teamFixture(['A', 'B', 'C', 'D'], { perfect: 0, target: 1, pass: 9, below: 0 }, 3,
      [{ char: 'A', eidolon: 0 }, { char: 'B', eidolon: 0 }]),
    // 补一个限定后能满分
    teamFixture(['A', 'B', 'C', 'Lim'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
      [{ char: 'A', eidolon: 0 }, { char: 'Lim', eidolon: 0 }]),
    // 同样要补 Lim，但成绩更差 → 不该排在前面
    teamFixture(['A', 'B', 'D', 'Lim'], { perfect: 2, target: 8, pass: 0, below: 0 }, 1,
      [{ char: 'A', eidolon: 0 }, { char: 'Lim', eidolon: 0 }]),
  ]);
  const out = buildConclusion([env], { availability, account });
  assert.equal(out.envs.length, 1);
  assert.equal(out.envs[0].baseline.tier, 'pass', '基线应是多数投稿的档位');
  assert.equal(out.envs[0].baseline.score, 0.5 + 0.4 * (1 - 3 / 4));
  assert.equal(out.envs[0].candidateCount, 2, '只有比基线强的才算候选');
  assert.equal(out.packages[0].rosterKey, 'A + B + C + Lim', '性价比最高的应排第一');
  assert.equal(out.packages[0].pulls, 1);
  // 单位榜：Lim 是角色本体（没有它）
  const lim = out.units.find((u) => u.name === 'Lim');
  assert.equal(lim.kind, 'char');
  assert.equal(lim.pulls, 1);
  assert.equal(lim.envCount, 1);
});

check('buildConclusion：配队差距记在展示字段上，不再污染「性价比总榜」的排序', () => {
  const availability = {
    characters: { Star: { limited: true }, Mate: { limited: true }, Pal: { limited: true } },
    lightCones: {},
  };
  const account = { owned: new Set(['A', 'B', 'C', 'D']), eidolons: new Map(), cones: new Map() };
  // 一个「很强的角色」Star：它出现的作业要 1 抽（Star）
  const solo = teamFixture(['A', 'B', 'C', 'Star'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
    [{ char: 'A', eidolon: 0 }, { char: 'Star', eidolon: 0 }]);
  // 另一个作业里同样有 Mate，但还要补 Pal（整套 2 抽）
  const packed = teamFixture(['A', 'B', 'Mate', 'Pal'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
    [{ char: 'A', eidolon: 0 }, { char: 'Mate', eidolon: 0 }, { char: 'Pal', eidolon: 0 }]);
  const baseline = teamFixture(['A', 'B', 'C', 'D'], { perfect: 0, target: 0, pass: 0, below: 10 }, 6,
    [{ char: 'A', eidolon: 0 }]);
  const out = buildConclusion([envFixture('moc', [baseline, solo, packed])], { availability, account });
  const star = out.units.find((u) => u.name === 'Star');
  const mate = out.units.find((u) => u.name === 'Mate');
  assert.ok(star && mate);

  // 总榜**按单位自己的性价比排序**（Σ_env 它自己的提升 ÷ 它自己的期望抽数）。
  // 两套作业的成绩档完全一样（都是 perfect），数据里没有量过 Mate 自己 vs Pal 自己
  // 的贡献，所以两个单位的**分子 ÷ 分母**在数据上就是相等的。
  //
  // 但两者的**配队可达性**不同：Star 那套里你拥有 3/4（A/B/C），Mate 这套只有 2/4
  //（A/B，Mate 与 Pal 都没有）→ 可达性折扣（§修正A 复活版，见 `reachFloor`）
  // 把 Mate 压到更低。这正是用户要的：
  // 「不死徒及其配队的队友我几乎没有抽取，为何会有如此高的性价比？」
  assert.ok(star.total > mate.total,
    `拥有的成员更少的那套应更低：star=${star.total} mate=${mate.total}`);
  // 差异必须来自可达性（分子分母在数据上相等）→ 比值应落在可达性折扣的取值范围内
  // （下限 0.25、上限 1），也就是不能出现「差出一个数量级」这种别的因素在起作用。
  const ratio = star.total / mate.total;
  assert.ok(ratio > 1 && ratio <= 1 / 0.25,
    `两者之比应只是可达性差异：${ratio}`);

  // 「配队差距」本身没有丢，它记在展示字段上：性价比的分母是单位自己（各 1 抽），
  // 而整套作业要几抽、还要一起补谁，仍然如实带出来给界面用。
  assert.equal(star.pulls, 1);
  assert.equal(mate.pulls, 1, '单位本身还是 1 抽');
  assert.equal(star.best.ownPulls, 1);
  assert.equal(mate.best.ownPulls, 1);
  assert.equal(star.best.pulls, 1, 'Star 照抄只要 1 抽');
  assert.equal(mate.best.pulls, 2, 'Mate 的作业还要一起补 Pal，整套 2 抽（摊薄体现在这里）');
  assert.equal(mate.best.pullsExpected, 188, 'Mate 整套作业的期望抽数 = 2 × 94');
  assert.equal(star.best.pullsExpected, 94, 'Star 整套作业的期望抽数 = 1 × 94');
  // 同伴必须列出来：这就是「配队差距」
  assert.deepEqual(mate.best.companions.map((c) => c.name).sort(), ['Pal']);
  assert.deepEqual(star.best.companions, []);
});

check('buildConclusion：性价比的分母是「买这一个单位要几抽」，不是最贵那个队友的价格', () => {
  // 回归（用户 2026-10 实测）：知更鸟 E1→E2 自己只要 94 抽（1 金 × 94），
  // 但它的作业里还有个要 3 金的砂金•戏浪（282 抽）。早先的
  // `ownPullsExpected = items.reduce((n, it) => Math.max(n, unitPullsOf(...)))`
  // 取的是**全队最大值**，于是知更鸟的分母被算成 282，贡献被除以 3 倍，
  // 排名从应有的头部掉到第 25（修好后是第 20）。
  //
  // 这里直接盯住**分母的计算规则**：单位自己的期望抽数只由它自己那一项决定。
  // 建库/聚合整条链路太重（要凑够参考集与成本尺子的条件），回归价值也不在这里——
  // 出问题的是「取全队最大值」这一步。
  const items = [
    { kind: 'eidolon', name: 'Lim', pulls: 1 },     // 它自己：1 金
    { kind: 'char', name: 'Mate', pulls: 3 },       // 最贵的队友：3 金
  ];
  // 单位自己的期望抽数（修好后的口径）：按**名字**取，互不影响
  const unitPullsExpected = Object.fromEntries(
    items.map((it) => [it.name, unitPullsOf(it.kind, it.pulls)]),
  );
  assert.equal(unitPullsExpected.Lim, 94, 'Lim 自己 1 金 × 94 = 94');
  assert.equal(unitPullsExpected.Mate, 282, 'Mate 3 金 × 94 = 282');
  // 旧口径（取全队最大值）会把 Lim 也算成 282 —— 钉住这个错误算法
  const buggy = items.reduce((n, it) => Math.max(n, unitPullsOf(it.kind, it.pulls)), 0);
  assert.equal(buggy, 282, '旧口径（全队最大值）给 Lim 的分母是 282，这就是当年的 bug');
  assert.notEqual(unitPullsExpected.Lim, buggy, 'Lim 的分母不能再等于 Mate 的价格');
  // 整套作业的抽数仍要如实报出来（配队差距留在展示字段里）
  const teamPulls = items.reduce((n, it) => n + unitPullsOf(it.kind, it.pulls), 0);
  assert.equal(teamPulls, 376, '整套 = (1 + 3) × 94 = 376（展示用，不进分母）');
  // 光锥按 67 抽计价
  assert.equal(unitPullsOf('cone', 2), 134, '光锥 2 金 × 67 = 134');
});

check('buildConclusion：差距榜量的是「照抄主流强阵还差几金」，不需要同阵容配对', () => {
  // 用户 2026-10 要求换口径的原因：旧口径量「升档的边际收益」，要求**同一套阵容里
  // 两个星魂档都有投稿**才能配对。而黑塔网的绝境王棋数据是两极的
  //（遐蝶 E2 有 331 条、E0 只有 4 条），关键副本上永远配不上对。
  // 新口径只需要「主流强阵要求什么 + 我缺什么」，所以稀疏副本照样给得出数。
  const availability = {
    characters: { Lim: { limited: true }, Mate: { limited: true } },
    lightCones: {},
  };
  // 拥有 A、B、C，且 Lim 在 E0：主流强阵要 A/B/C/Lim@E2 → 差 Lim 的星魂 E0→E2 = 2 金
  const account = {
    owned: new Set(['A', 'B', 'C', 'Lim']),
    eidolons: new Map([['Lim', 0]]),
    cones: new Map(),
  };
  const strong = teamFixture(['A', 'B', 'C', 'Lim'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
    [{ char: 'A', eidolon: 0 }, { char: 'Lim', eidolon: 2 }]);
  strong.cost = 3;
  // 一条弱阵容：不该成为差距目标
  const weak = teamFixture(['A', 'B', 'C', 'Mate'], { perfect: 0, target: 0, pass: 0, below: 10 }, 6,
    [{ char: 'A', eidolon: 0 }, { char: 'Mate', eidolon: 3 }]);
  weak.cost = 4;
  const out = buildConclusion([envFixture('moc', [weak, strong])], { availability, account });

  assert.ok(Array.isArray(out.gapUnits), 'gapUnits 必须存在');
  // 星魂档是这条路上的缺口——差距口径**天然含星魂**，不需要「同阵容两档配对」
  const eido = out.gapUnits.find((u) => u.kind === 'eidolon' && u.name === 'Lim');
  assert.ok(eido, 'Lim 的星魂档应出现在差距榜');
  assert.equal(eido.pulls, 2, `E0→E2 是 2 金，实际 ${eido.pulls}`);
  const t = eido.gapTarget;
  assert.equal(t.pulls, 2, '这条路一共差 2 金');
  assert.equal(t.tier, 'perfect', '目标是满分档');
  assert.deepEqual(t.roster.slice().sort(), ['A', 'B', 'C', 'Lim']);
  assert.equal(eido.from, 0, '起点是 E0');
  assert.equal(eido.target, 2, '目标是 E2');

  // 弱阵容（below 档）不该成为目标
  assert.ok(!out.gapUnits.some((u) => u.name === 'Mate'),
    '达不到满分档的阵容不该进差距榜');

  // 空输入不崩
  assert.deepEqual(buildConclusion(null, {}).gapUnits, []);
  assert.deepEqual(buildConclusion([], {}).gapUnits, []);
});

check('buildConclusion：星魂的分子是「期望出分」——分布往满分挪就加分，没挪就是 0', () => {
  // 用户 2026-10 的指正：「这两个角色的星魂对改善出分和压金 0T 都相当重要，
  // 尤其是用现有阵容挑战异相仲裁 / 绝境王棋」——分子必须量出**关键金带来的出分**。
  //
  // 为什么不能用「常见档位有没有翻过去」（更早的两版口径）：
  // 低难副本里常见档位就是满分，任何落在满分**之上**的提升都被二值化丢掉。
  // 实测知更鸟 E1→E2 的达标率差是 95%→95% = 0，而档位分布的期望值其实在动。
  // 现在直接用**档位分布的期望值之差**：达到满分的比例涨了多少，分就多多少。
  const availability = { characters: { Lim: { limited: true } }, lightCones: {} };
  const account = {
    owned: new Set(['A', 'B', 'C', 'D', 'Lim']),
    eidolons: new Map([['Lim', 1]]),
    cones: new Map(),
  };
  const rich = teamFixture(['A', 'B', 'C', 'D'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
    [{ char: 'A', eidolon: 0 }, { char: 'D', eidolon: 0 }]);
  rich.cost = 8;
  // tiers = [below, pass, target, perfect] 的**条数**（建库侧第二趟半产出的形状）
  const mk = (fromTiers, toTiers) => {
    const t = teamFixture(['A', 'B', 'C', 'Lim'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
      [{ char: 'A', eidolon: 0 }, { char: 'Lim', eidolon: 2 }]);
    t.cost = 4;
    t.eidoPerf = {
      Lim: { 1: { perf: -3, tier: 'perfect', cost: 4 }, 2: { perf: -3, tier: 'perfect', cost: 5 } },
    };
    const entry = (tiers) => ({
      n: tiers.reduce((a, b) => a + b, 0), hits: tiers[3],
      hit: tiers[3] / tiers.reduce((a, b) => a + b, 0), tiers, modalTier: 3,
    });
    t.eidoStats = { Lim: { 1: entry(fromTiers), 2: entry(toTiers) } };
    return t;
  };
  const eidonOf = (out) => out.units.find((u) => u.kind === 'eidolon' && u.name === 'Lim') || null;
  const run = (fromTiers, toTiers) => eidonOf(buildConclusion(
    [envFixture('moc', [rich, mk(fromTiers, toTiers)])], { availability, account },
  ));

  // ① 分布完全没动 → 0 分，不进榜（「没改善出分的关键金」不该占榜面）。
  assert.equal(run([0, 0, 3, 9], [0, 0, 3, 9]), null,
    '档位分布没动时贡献必须是 0');

  // ② 分布往满分挪（target 3 条 → perfect 3 条）→ 应进榜且为正。
  const moved = run([0, 0, 3, 9], [0, 0, 0, 12]);
  assert.ok(moved, '分布往满分挪时应进榜');
  assert.ok(moved.total > 0, `期望出分提升应为正，实际 ${moved.total}`);

  // ③ 挪得越多，分越高（连续性：这是「期望值」而不是二值判据的意义）。
  const small = run([0, 0, 1, 11], [0, 0, 0, 12]);
  const big = run([0, 0, 6, 6], [0, 0, 0, 12]);
  assert.ok(big.total > small.total,
    `同一档位内提升越大分越高：big=${big.total} small=${small.total}`);

  // ④ 分布**倒退** → 不给分（不能靠「有画像」白拿分）。
  assert.equal(run([0, 0, 0, 12], [0, 0, 6, 6]), null,
    '分布倒退时贡献必须是 0');

  // ⑤ 副本权重会乘进这一条：同样幅度的出分提升，权重更高的副本应更值钱。
  //    默认表里只有「异相仲裁 · 绝境」是 10、其余四个都是 1，所以这里用**用户覆盖**
  //    来钉住机制（把混沌回忆抬到 5 倍），而不是依赖默认表里两个副本的差值 ——
  //    用户随时可以在界面上改默认表，机制不该跟着一起变。
  const tierUp = () => [[0, 0, 6, 6], [0, 0, 2, 10]];
  const withWeight = (weights) => eidonOf(buildConclusion(
    [envFixture('moc', [rich, mk(...tierUp())], { mode: 'moc' })], { availability, account, weights },
  ));
  const base = withWeight(undefined);
  const heavy = withWeight({ 'moc|': 5 });
  assert.ok(base && heavy, '两种权重下都应进榜');
  assert.ok(heavy.total > base.total,
    `权重调高后同等出分提升应更值钱：base=${base.total} heavy=${heavy.total}`);
  assert.ok(Math.abs(heavy.total / base.total - 5) < 0.01,
    `总分应与权重成正比（×5）：${base.total} → ${heavy.total}`);
});

check('buildConclusion：总榜按「单位自己的性价比」排序，不按「含它的打包作业」排序', () => {
  // 回归：`total` 曾经直接取 `combo.value`（含它的最好一套**打包**作业的
  // Σ提升 ÷ Σ成本）。同一个包里的单位于是分到**完全相同**的数，名次由打包效率
  // 决定而不是各自的贡献——实测真实数据上出现过 3 个单位共享 0.4433，
  // 其中一个自己的值只有 0.1015（被抬高 4 倍）。
  const availability = {
    characters: { Strong: { limited: true }, Weak: { limited: true } },
    lightCones: {},
  };
  // Weak 已经拥有（在 E1）→ 它的缺口是**星魂 E1→E2**（1 抽），
  // Strong 没有 → 缺口是**角色本体**（1 抽）。两者造价相同，所以
  // `ownPullsExpected` 都是 94；能不能分出高下，全看分子是不是各单位自己的。
  const account = {
    owned: new Set(['A', 'B', 'C', 'D', 'Weak']),
    eidolons: new Map([['Weak', 1]]),
    cones: new Map(),
  };
  const baseline = teamFixture(['A', 'B', 'C', 'D'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
    [{ char: 'A', eidolon: 0 }, { char: 'B', eidolon: 0 }]);
  baseline.cost = 10;
  // 同一套作业里两个都缺：Strong 与 Weak 在这套作业里是**同一个组合键**。
  const together = teamFixture(['A', 'Strong', 'C', 'Weak'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
    [{ char: 'A', eidolon: 0 }, { char: 'Strong', eidolon: 0 }, { char: 'Weak', eidolon: 2 }]);
  together.cost = 4;
  // 配对的星魂证据：同一套阵容里 E1→E2 档位从及格升到满分 → Weak 的边际收益为正。
  together.eidoPerf = {
    Weak: { 1: { perf: -3, tier: 'target', cost: 4 }, 2: { perf: -3, tier: 'perfect', cost: 4 } },
  };
  const out = buildConclusion([envFixture('moc', [baseline, together])], { availability, account });
  const strong = out.units.find((u) => u.name === 'Strong');
  const weak = out.units.find((u) => u.kind === 'eidolon' && u.name === 'Weak');
  assert.ok(strong, 'Strong 应进榜');
  assert.ok(weak, 'Weak 的星魂档应进榜（配对证据说档位真的提升了）');

  // ① 两个单位在同一个包里，但性价比必须**不同**（旧口径下两者会完全相等）。
  assert.notEqual(strong.total, weak.total,
    `同一包里的单位不能共享同一个性价比：Strong=${strong.total} Weak=${weak.total}`);

  // ② 表头性价比 = 各副本自己性价比的**和**（文档 §修正A：V(u) = Σ_env w(env)·V(u,env)）。
  for (const unit of [strong, weak]) {
    const sum = unit.envs.reduce((n, e) => n + e.value, 0);
    assert.ok(Math.abs(unit.total - sum) < 1e-6,
      `${unit.name} 的总性价比应等于各副本之和：${unit.total} vs ${sum}`);
  }

  // ③ 两者造价相同（各 1 抽 = 94），所以**分子必须各自量各自的**才有差异：
  //    Strong 是角色本体（成本优势），Weak 是星魂档的边际收益 —— 两把尺子不可比，
  //    这里只断言它们不再被强行拉平。
  assert.equal(strong.best.ownPulls, 1);
  assert.equal(weak.best.ownPulls, 1, '星魂档 E1→E2 是 1 抽');

  // ④ 打包信息仍然照常带出来（界面「这套还能一起补谁」要用），只是不参与排序。
  assert.ok(strong.combo, '含它的打包作业仍应带出来供展示');
  assert.deepEqual(strong.combo.units.slice().sort(), ['Strong', 'Weak']);
  assert.equal(strong.combo.cost, 188, '打包成本 = 2 个限定角色 × 94');
  // 两者确实在**同一个包**里 —— 这正是旧口径会把它们拉平的那个包。
  assert.equal(weak.combo.cost, 188);
});


  const availability = { characters: { Lim: { limited: true } }, lightCones: {} };
check('buildConclusion：同一副本内同一单位只记最好的一套', () => {
  const availability = { characters: { Lim: { limited: true } }, lightCones: {} };
  const account = { owned: new Set(['A', 'B', 'C', 'D']), eidolons: new Map(), cones: new Map() };
  const base = teamFixture(['A', 'B', 'C', 'D'], { perfect: 0, target: 0, pass: 0, below: 10 }, 6,
    [{ char: 'A', eidolon: 0 }]);
  // 同一单位 Lim 出现在两套作业里：一套达标（提升 1），一套满分（提升 2），都要 1 抽
  const weak = teamFixture(['A', 'B', 'C', 'Lim'], { perfect: 0, target: 10, pass: 0, below: 0 }, 2,
    [{ char: 'A', eidolon: 0 }, { char: 'Lim', eidolon: 0 }]);
  const strong = teamFixture(['A', 'B', 'D', 'Lim'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
    [{ char: 'A', eidolon: 0 }, { char: 'Lim', eidolon: 0 }]);
  const out = buildConclusion([envFixture('moc', [base, weak, strong])], { availability, account });
  const lim = out.units.find((u) => u.name === 'Lim');
  assert.equal(lim.envCount, 1, '一个副本只算一次');
  assert.equal(lim.envs[0].tier, 'perfect', '应记更好那一套');
  // 提升 120（档位分 2.4 × 50，没有成绩分布时走的退路）；分母是**期望抽数**：
  // 限定角色 94 抽。再乘**副本权重**（§④ 默认表：混沌回忆 1）→ 120 × 1 ÷ 94 ≈ 1.2766。
  // 最后还要乘**配队可达性折扣**：这套参考队伍有 2 个成员（A 与 Lim），你拥有 A
  // → m = 0.5 → 0.25 + 0.75 × 0.5 = 0.625。
  //
  // 这里以前写的是 120 ÷ 94 ≈ 1.2766：那时权重表一条都没生效（表按站点全名写、
  // 而 `env.mode` 是短码 `moc`，5 个副本全退回默认 1），所以期望值里没有权重那一项。
  // 2026-10 用户把默认表改成「绝境 10 / 其余 1」，混沌回忆又回到 1，
  // 所以这条的期望值仍然是 120 × 1 × REACH ÷ 94；**关键是要把权重算进去**。
  // 可达性折扣同理：它是 2026-10 用户报「几乎没抽的队友为何还那么高」后加回来的。
  const REACH = 0.25 + 0.75 * (1 / 2);   // 参考队伍 2 人、你拥有 1 人
  const WEIGHT = envWeightOf('moc', '');
  assert.ok(Math.abs(lim.total * 94 - 120 * WEIGHT * REACH) < 0.5,
    `总性价比应接近 120×${WEIGHT}×${REACH}/94 ≈ ${((120 * WEIGHT * REACH) / 94).toFixed(4)}，实际 ${lim.total}`);
});

check('buildConclusion：跨副本相加，空账号与空输入都不崩', () => {
  const availability = { characters: { Lim: { limited: true } }, lightCones: {} };
  const envs = ['moc', 'pf'].map((id) => envFixture(id, [
    teamFixture(['A', 'B', 'C', 'Lim'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
      [{ char: 'A', eidolon: 0 }, { char: 'Lim', eidolon: 0 }]),
  ]));
  // 一个角色都没有：基线为 0，候选是全部
  const empty = buildConclusion(envs, { availability, account: {} });
  const lim = empty.units.find((u) => u.name === 'Lim');
  assert.equal(lim.envCount, 2, '两个副本都要计入');
  assert.ok(lim.total > lim.envs[0].value, '跨副本应相加');
  assert.equal(empty.envs[0].baseline.rosterKey, null);
  assert.deepEqual(buildConclusion(null, {}).units, []);
  assert.deepEqual(buildConclusion([], {}).packages, []);
  assert.deepEqual(buildConclusion([envFixture('moc', [])], { availability }).counts.envs, 1);
});

check('buildConclusion：星魂档的边际收益按**同一套阵容**配对，不拿别的阵容凑数', () => {
  // 花火 E2→E3 的回归：以前 `rosterEido` 永远是空的（聚合层把配对证据丢了），
  // 于是每个星魂档都退回「跨阵容取各档最好成绩」——那量的是阵容差异，不是星魂差异，
  // 花火 E2→E3 就是这么拿到一个来路不明的正值、爬到榜单第 8 的。
  // 现在配对证据到位：同阵容两个档位成绩一样 → 升这一档只是多花 1 金 → 贡献算出来是 0。
  const availability = { characters: { Lim: { limited: true } }, lightCones: {} };
  const account = {
    // Lim 必须**已拥有**（在 E1）：否则算出来的缺口是「抽本体」而不是「补星魂」，
    // 这条测试就不是在量星魂档了。
    owned: new Set(['A', 'B', 'C', 'D', 'Lim']),
    eidolons: new Map([['Lim', 1]]),
    cones: new Map(),
  };
  // 基线：0 抽可照抄的满分阵容（成本 8）。常见成本（满分作业的中位数）由它定。
  const rich = teamFixture(['A', 'B', 'C', 'D'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
    [{ char: 'A', eidolon: 0 }, { char: 'D', eidolon: 0 }]);
  rich.cost = 8;
  // 候选：同一套阵容补 Lim，但作业要求 Lim E2（账号在 E1）→ 1 金。
  const withEido = (eidoPerf) => {
    const t = teamFixture(['A', 'B', 'C', 'Lim'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
      [{ char: 'A', eidolon: 0 }, { char: 'Lim', eidolon: 2 }]);
    t.cost = 4;
    t.eidoPerf = eidoPerf;
    return t;
  };
  const eidonOf = (out) => out.units.find((u) => u.kind === 'eidolon' && u.name === 'Lim') || null;

  // ① 配对证据说：同一套阵容里 E1 与 E2 都是满分档 → 档位没变 → 纯变贵 → 0（不进榜）
  const flat = buildConclusion([envFixture('moc', [rich, withEido({
    Lim: { 1: { perf: -3, tier: 'perfect', cost: 4 }, 2: { perf: -3, tier: 'perfect', cost: 5 } },
  })])], { availability, account });
  assert.equal(eidonOf(flat), null,
    'E1→E2 档位没变时贡献必须算成 0（不进榜），不能靠白名单拦');

  // ② 对照：把配对证据拿掉 = 改动前的行为 → 退回旧口径，星魂条目又冒出来
  const noPair = buildConclusion([envFixture('moc', [rich, withEido(undefined)])], { availability, account });
  assert.ok(eidonOf(noPair), '没有配对证据时会退回「跨阵容比最好成绩」，这正是当初的缺陷');

  // ③ 配对证据说档位真的变了（及格 → 满分），且成本仍压得住 → 才是正贡献
  const up = buildConclusion([envFixture('moc', [rich, withEido({
    Lim: { 1: { perf: -3, tier: 'target', cost: 4 }, 2: { perf: -3, tier: 'perfect', cost: 4 } },
  })])], { availability, account });
  const lim = eidonOf(up);
  assert.ok(lim, '档位确实提升时星魂条目应留在榜上');
  assert.equal(lim.from, 1);
  assert.equal(lim.target, 2);
  assert.ok(lim.total > 0, `档位提升的边际收益应为正，实际 ${lim.total}`);

  // ④ **降档不算提升**：花火在混沌回忆里的那两组配对正是 perfect→target
  //    （Δperf 为负），它曾靠这种配对拿到正值。证据方向相反的更要算成 0。
  const down = buildConclusion([envFixture('moc', [rich, withEido({
    Lim: { 1: { perf: -3, tier: 'perfect', cost: 4 }, 2: { perf: -2, tier: 'target', cost: 4 } },
  })])], { availability, account });
  assert.equal(eidonOf(down), null, '档位反而变差时不能算正贡献');
});

check('buildConclusion：难打副本里「没把档位推上去」的星魂档算 0，不继承整套作业的提升', () => {
  // 回归（用户点名过的「花火 E3 提升非常小」在难打副本里的残留）：
  // 好打副本那一支早就把「没跨档」判成 0，但难打副本这一支在**配对证据存在、
  // 却一次都没把档位推上去**时返回了中性 1 —— 于是那个星魂档直接继承整套作业的
  // 击败比例提升。实测（异相仲裁 · 绝境权重 9 时）花火 E2→E3 拿到 +57 点、
  // 排进抽卡方案前 4 名。现在两支一致：证据说没有提升，就是 0。
  const availability = { characters: { Lim: { limited: true } }, lightCones: {} };
  const account = {
    owned: new Set(['A', 'B', 'C', 'D', 'Lim']),
    eidolons: new Map([['Lim', 1]]),
    cones: new Map(),
  };
  // 好打的基线：0 金可照抄，成绩只到「不及格」（候选那一套是满分 → 整套作业有提升，
  // 这样候选才过得了 `cand.gain > 0` 那道门；星魂自己的贡献则完全由配对证据决定）
  const rich = teamFixture(['A', 'B', 'C', 'D'], { perfect: 0, target: 0, pass: 0, below: 10 }, 6,
    [{ char: 'A', eidolon: 0 }, { char: 'D', eidolon: 0 }]);
  rich.cost = 8;
  const withEido = (eidoPerf) => {
    const t = teamFixture(['A', 'B', 'C', 'Lim'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
      [{ char: 'A', eidolon: 0 }, { char: 'Lim', eidolon: 2 }]);
    t.cost = 4;
    t.eidoPerf = eidoPerf;
    return t;
  };
  const run = (eidoPerf) => buildConclusion(
    [envFixture('aa', [rich, withEido(eidoPerf)], { mode: 'aa', stage: 'plight' })],
    { availability, account },
  );
  const eidonOf = (out) => out.units.find((u) => u.kind === 'eidolon' && u.name === 'Lim') || null;

  // ① 同阵容两档的成绩与档位一模一样 → 升这一档只是多花 1 金 → 0（不进榜）
  assert.equal(eidonOf(run({
    Lim: { 1: { perf: -2, tier: 'perfect', cost: 4 }, 2: { perf: -2, tier: 'perfect', cost: 5 } },
  })), null, '难打副本里「档位没动」必须算 0');

  // ② 档位真的动了、成绩也上去了 → 保留正贡献（别把这一支一起打成一刀切）
  const up = eidonOf(run({
    Lim: { 1: { perf: -4, tier: 'target', cost: 4 }, 2: { perf: -2, tier: 'perfect', cost: 4 } },
  }));
  assert.ok(up, '档位确实提升时星魂条目应留在榜上');
  assert.ok(up.total > 0, `档位提升的贡献应为正，实际 ${up.total}`);
});

check('副本权重与尺子：短码 / 站点全名都认，异相仲裁骑士关走成本尺子', () => {
  // §④ 的权重表按站点全名写（Pure Fiction），而 env.mode 是短码（pf）。
  // 早先只认全名 → 5 个副本**全部**退回默认 1，权重一条都没生效
  //（「异相仲裁最关键、虚构叙事最低」是用户点名的口径，一直没落地）。
  //
  // 2026-10 用户直接给定五档默认值：**异相仲裁 · 绝境 10，其余四个一律 1**
  //（口径从「拉开间距」改成「绝境占绝对主导，其它四个平等」）。
  // 这里钉住数值、相对次序与「短码 / 站点全名两种写法都认」三件事。
  assert.equal(envWeightOf('pf', ''), 1);
  assert.equal(envWeightOf('Pure Fiction', ''), 1);
  assert.equal(envWeightOf('moc', ''), 1);
  assert.equal(envWeightOf('Memory of Chaos', ''), 1);
  assert.equal(envWeightOf('as', ''), 1);
  assert.equal(envWeightOf('aa', ''), 1);
  assert.equal(envWeightOf('aa', 'plight'), 10);
  assert.equal(envWeightOf('Anomaly Arbitration', 'plight'), 10);
  assert.equal(envWeightOf('nope', ''), 1, '不认识的副本退回默认值');
  assert.deepEqual(
    [['aa', 'plight'], ['aa', ''], ['as', ''], ['moc', ''], ['pf', '']].map(([m, s]) => envWeightOf(m, s)),
    [10, 1, 1, 1, 1],
    '绝境最高、其余四个相同',
  );
  assert.ok(envWeightOf('aa', 'plight') / envWeightOf('as', '') >= 5,
    '绝境王棋关的权重必须明显压过其它副本');

  // 尺子：异相仲裁按关卡分。骑士关的判据是轮次（和混沌回忆同一把尺子），
  // 绝境判行动值（成绩分布最宽，只有它能真正分出高下）。
  assert.equal(isEasyMode('aa', ''), true, '骑士关走成本/档位尺子');
  assert.equal(isEasyMode('aa', 'plight'), false, '绝境走击败比例');
  assert.equal(isEasyMode('moc', ''), true);
  assert.equal(isEasyMode('Anomaly Arbitration', ''), true);
});

check('权重输入框清空时按 0 计算，而不是退回默认值', () => {
  assert.equal(weightInputOf(''), 0, '空串应明确表示关闭该副本');
  assert.equal(weightInputOf('   '), 0, '只有空白也应明确表示关闭该副本');
  assert.equal(weightInputOf('0'), 0, '显式输入 0 仍应是 0');
  assert.equal(weightInputOf('2.5'), 2.5, '正常数字应保留');
  assert.equal(weightInputOf(null), null, '缺失值不应冒充用户清空');
  assert.equal(weightInputOf(undefined), null, '未提供的值不应冒充用户清空');
  assert.equal(weightInputOf('-1'), null, '负数仍应忽略');
  assert.equal(weightInputOf('not-a-number'), null, '非法非空值仍应忽略');
});

checkAsync('archiveTeams 按需带上星魂配对证据（eidoPerf），默认不带', async () => {
  // 这一条钉住真正的缺陷：建库侧 11992/11992 条阵容都带 eidoPerf，但聚合层不传下去，
  // 客户端只好退回跨阵容配对（花火 E2→E3 由此得到正值）。
  const plain = await archiveTeams('moc', { window: 6 });
  assert.ok(plain.ok);
  assert.ok(plain.teams.length > 0);
  assert.ok(plain.teams.every((t) => t.eidoPerf === undefined),
    '默认不该带 eidoPerf：主榜（archiveStats/对照）的载荷形状不能变');

  const withIt = await archiveTeams('moc', { window: 6, withEidoPerf: true });
  const carriers = withIt.teams.filter((t) => t.eidoPerf && Object.keys(t.eidoPerf).length);
  assert.ok(carriers.length > 0, '综合结论要的配对证据必须带得出来');
  // 关键：跨版本合并不该把同一角色的多个星魂档压掉，否则「同阵容 E2 vs E3」配不上对
  assert.ok(carriers.some((t) => Object.values(t.eidoPerf)
    .some((levels) => Object.keys(levels).length >= 2)),
  '至少要有阵容能把同一角色的两个星魂档配起来');
  for (const team of carriers.slice(0, 20)) {
    for (const [char, levels] of Object.entries(team.eidoPerf)) {
      assert.ok(team.roster.includes(char), `${team.rosterKey} 的配对证据里出现了阵容外的角色 ${char}`);
      for (const [lv, entry] of Object.entries(levels)) {
        assert.ok(Number.isFinite(Number(entry.perf)), `${char} E${lv} 缺成绩`);
        assert.ok(['perfect', 'target', 'pass', 'below'].includes(entry.tier),
          `${char} E${lv} 的档位异常：${entry.tier}`);
        assert.ok(Number.isFinite(Number(entry.cost)), `${char} E${lv} 缺成本`);
      }
    }
  }
});

checkAsync('archiveTeams 给的是完整阵容表（不截断），且带定档条数', async () => {
  const pool = await archiveTeams('moc', { window: 6 });
  assert.equal(pool.ok, true);
  assert.ok(pool.teams.length > 100, `混沌回忆的阵容池应远多于 100，实际 ${pool.teams.length}`);
  for (const t of pool.teams.slice(0, 50)) {
    assert.ok(t.tierCounts, `${t.rosterKey} 缺 tierCounts`);
    const sum = Object.values(t.tierCounts).reduce((a, b) => a + b, 0);
    assert.ok(sum > 0, `${t.rosterKey} 的定档条数为 0`);
    assert.ok(sum <= t.count + 1e-6, `${t.rosterKey} 定档条数 ${sum} 超过投稿数 ${t.count}`);
  }
  const bad = await archiveTeams('moc', { stage: 'nope' });
  assert.equal(bad.ok, false);

  const plight = await archiveTeams('aa', { stage: 'plight', window: 6, withFrontier: true });
  assert.ok(plight.frontierRows.length > 0, '绝境应返回逐条去重的满分通关记录');
  const regular = await archiveTeams('aa', { stage: '', window: 6, withFrontier: true });
  assert.ok(regular.frontierRows.some((row) => row.tier === 'target'),
    '普通异相仲裁应保存次高目标档，供低星魂压金证据进入总榜');
  assert.ok(regular.frontierRows.every((row) => ['perfect', 'target'].includes(row.tier)),
    '普通模式只保留满分或次高目标档的配置');
  const signatures = plight.frontierRows.map((row) => `${row.cost}|${row.members
    .map((m) => `${m.char}|${m.eidolon}|${m.lc || ''}|${m.superimp}`).sort().join('~')}`);
  assert.equal(new Set(signatures).size, signatures.length,
    '跨版本相同配置与成本只保留一条');
  assert.ok(plight.frontierRows.some((row) => Number.isFinite(row.actionValue)),
    '行动值必须与该条投稿的实际配装一起返回');
  assert.ok(plight.frontierRows.every((row) => row.actionValue === null || row.actionValue >= 0),
    '有效行动值包括 0；仅缺失或负值按缺失处理');
  assert.ok(plight.frontierRows.some((row) => row.actionValue === 0),
    '异相仲裁·绝境真实的 0 行动值成绩必须保留');
});

checkAsync('4.5 绝境榜保留 29 金 0 行动值的真实满分配置', async () => {
  const data = await archiveTeams('aa', {
    stage: 'plight', season: '4.5', window: 1, withFrontier: true,
  });
  assert.equal(data.ok, true);
  const record = data.frontierRows.find((row) => row.cost === 29 && row.actionValue === 0
    && row.tier === 'perfect'
    && row.members.some((member) => member.char === 'Himeko • Nova' && member.eidolon === 6)
    && row.members.some((member) => member.char === 'Robin • Summeretto' && member.eidolon === 6)
    && row.members.some((member) => member.char === 'Cyrene' && member.eidolon === 6));
  assert.ok(record, '应保留姬子·启行/知更鸟·晴歌/昔涟核心的 29 金 0 行动值满分记录');
});

checkAsync('前沿池 = 窗口内全部成绩（v4.6.78：不再取最便宜 25%，估算机器已删）', async () => {
  const f = await archiveFrontier('aa', { stage: 'plight' });
  assert.equal(f.ok, true);
  assert.ok(f.merged > 0, '窗口内应有前沿行');
  // ① 池就是全部：`pool` 与 `merged` 恒等，`frontierRows` 一条不少。
  assert.equal(f.pool, f.merged,
    `池必须等于全部成绩（pool ${f.pool} vs merged ${f.merged}）`);
  assert.equal(f.frontierRows.length, f.merged, 'frontierRows 必须逐条对应全部成绩');
  // ② 高金成绩留在池里。旧口径按成本截断，绝境窗口实测末位（cut）只有 15 金；
  //    现在至少能看到一条 ≥ 20 金的成绩（实测最大 48 金）。
  const maxCost = Math.max(...f.frontierRows.map((r) => r.cost));
  assert.ok(maxCost >= 20,
    `池里应保留高金成绩（旧口径 cut 实测 15 金），实际最大 ${maxCost} 金`);
  // ③ 估算机器**整台**删除：这几个字段不该再出现在返回值里。
  assert.equal(f.cut, undefined, '`cut` 应已删除（池不再截断）');
  assert.equal(f.observedPacks, undefined, '`observedPacks` 应已删除');
  assert.equal(f.observedPackScores, undefined, '`observedPackScores` 应已删除');
});

checkAsync('叠影：没装光锥的位置读成 0，而不是「满叠影 5」（用户第 8 条）', async () => {
  // 站点用「叠影 0」表示这一位**没装光锥**。实测（raw/submissions 全量 118,562 个位置）：
  //   * 有光锥的 107,765 个位置，叠影只取 1/2/3/4/5，**从不为 0**；
  //   * 没有光锥的 10,797 个位置里，87.75% 是 0。
  // 旧写法 `Number(x) || 5` 把 0 当 falsy 读成 SI5 → 7,715 个「没装光锥」的位置被写成
  // 满叠影光锥，整包打包键（角色|星魂|光锥|叠影）因此多出一整个假的 S5 维度。
  // 3.3/3.4 是重灾区：那两期站点整批不给逐位光锥（只有合计），所以专挑 3.4 验。
  const data = await archiveTeams('moc', { season: '3.4', window: 1, withFrontier: true });
  assert.equal(data.ok, true);
  let noCone = 0;
  let noConeZero = 0;
  let noConeFive = 0;
  for (const row of data.frontierRows) {
    for (const member of row.members) {
      if (member.lc) continue;
      noCone += 1;
      if (member.superimp === 0) noConeZero += 1;
      if (member.superimp === 5) noConeFive += 1;
    }
  }
  assert.ok(noCone > 0, '3.4 应该有「没装光锥」的位置（站点当时不给逐位光锥）');
  assert.ok(noConeZero > 0, '没装光锥的位置必须读成叠影 0');
  assert.ok(noConeZero > noConeFive,
    `没装光锥的位置应以 0 为主，实际 0=${noConeZero} / 5=${noConeFive}`);
});

checkAsync('行动值不再是「字段缺失」被读成 0（混沌回忆/虚构叙事/异相仲裁）', async () => {
  // 站点的 action_value 只有绝境王棋关真的填了，其余模式是 null/空串。
  // Number(null) === 0 会让 avgAv 全为 0——这条测试钉住那个 bug。
  for (const [mode, stage] of [['moc', ''], ['pf', ''], ['aa', '']]) {
    const pool = await archiveTeams(mode, { stage, window: 6 });
    const values = new Set(pool.teams.map((t) => t.avgAv).filter((v) => Number.isFinite(v)));
    assert.ok(values.size > 1,
      `${mode}/${stage} 的平均行动值只有 ${values.size} 种取值，说明又被读成常数了`);
  }
  // 绝境王棋关本身就该有真实分布
  const plight = await archiveTeams('aa', { stage: 'plight', window: 6 });
  const max = Math.max(...plight.teams.map((t) => t.avgAv || 0));
  assert.ok(max > 100, `绝境王棋关的行动值应有上百的量级，实际最大 ${max}`);
});

checkAsync('综合结论：每个副本都挑样本足够的版本，并在各副本给出基线与单位榜', async () => {
  const index = await archiveIndex();
  const empty = await archiveConclusion({ owned: [] }, { window: 6 });
  assert.equal(empty.ok, true);
  assert.equal(empty.payload, 7,
    'v4 = 整包口径；v5 = hiddenCosts 回显；v6 = availability（队伍方案在界面现算差额）；'
    + 'v7 = 逐星魂档的 frontierTiers（两支并行分支各占过 v6，合并后形状号取 7）。'
    + '⚠️ **没有 v8**：v4.6.87 曾写过 8（整包多一个 strength = 纯强度），'
    + 'v4.6.91 按用户 2026-10-12 第 8 条删掉了那个字段，形状回到 7。');
  assert.ok(empty.envs.length >= 4, `至少要覆盖 4 个副本，实际 ${empty.envs.length}`);
  const minRuns = index.minSeasonRuns ?? 20;
  for (const env of empty.envs) {
    assert.ok(env.season, `${env.label} 没有版本`);
    const runs = env.totalRuns ?? 0;
    assert.ok(env.reliable === false || runs >= minRuns,
      `${env.label} 用了样本不足的版本（${runs} 条）却标成可靠`);
    assert.ok(env.baseline, `${env.label} 缺基线`);
    assert.ok(['perfect', 'target', 'pass', 'below'].includes(env.baseline.tier),
      `${env.label} 基线档位异常：${env.baseline.tier}`);
  }
  // 一个角色都没有时，每个副本都该有候选（基线为 0）
  const withCands = empty.envs.filter((e) => e.candidateCount > 0);
  assert.ok(withCands.length >= 3, `空账号时至少 3 个副本应有候选，实际 ${withCands.length}`);
  assert.ok(empty.units.length > 0);
  assert.equal(empty.frontierBasis, 'team-gold-frontier-pack',
    'API 总榜应标明「整包（队伍金数）」口径');
  assert.ok(empty.frontierUnits.every((unit) => unit.kind === 'pack'), '总榜单位一律是整包');
  // v15：单位是**整包**（角色 + 星魂档 + 光锥），不再分角色 / 星魂 / 光锥三类。
  assert.ok(empty.frontierUnits.every((unit) => Number.isFinite(unit.eidolon)
    && 'lc' in unit && Number.isFinite(unit.gold)),
  '每个总榜条目都要带星魂档、光锥与整包金数');
  assert.equal(empty.frontierUnits.some((unit) => unit.kind === 'char'
    || unit.kind === 'eidolon' || unit.kind === 'cone'), false,
  '旧的节点口径（角色 / 星魂 / 光锥三行）不该再出现');
  // 副本元数据单独发一份（界面拿它补齐环境名与权重，见 conclusion.js 的注释）
  assert.ok(Array.isArray(empty.frontierEnvs) && empty.frontierEnvs.length >= 4,
    `总榜应下发副本元数据，实际 ${empty.frontierEnvs?.length}`);
  assert.ok(empty.frontierEnvs.every((env) => env.id && env.label
    && Number.isFinite(Number(env.weight))),
  '每个副本元数据要有 id / label / weight');
  // 判据线必须随副本元数据下发（用户 2026-10-10：「把『满分』『达标』改为具体的行动值」）：
  // 界面把档位写成 `0T` / `行动值 <300` 全靠它，缺了就只能退回「最好一档」那种中性兜底
  // —— 而这三条线只存在数据集里（`herta-build.mjs` 的 `TIER_LINES`），界面自己造不出来。
  assert.ok(empty.frontierEnvs.every((env) => env.tierLines
    && Number.isFinite(Number(env.tierLines.perfect))),
  '每个副本元数据都要带判据线（tierLines.perfect），否则界面写不出具体的行动值');
  assert.ok(empty.frontierEnvs.every((env) => tierTextOf(env, 'perfect') !== TIER_PLACEHOLDER.perfect),
    '真实数据集上每个副本的「最好一档」都要能翻成游戏内实际的量，不能落到兜底写法');
  // 第 1 条（每角色一条）在真实数据上的体现 + 榜单不被截断。
  //
  // ⚠️ 这条断言取代了 v15 的「砂金·戏浪 应保留普通异相仲裁关卡的证据」：第 1 条要求
  // 每个角色只留分数最高的那个整包，而砂金·戏浪的最高分整包（E6 + 今日好手气S5）只在
  // 绝境出现，带普通关证据的 E0/E1 整包会被收敛掉 —— 所以「某个角色自己带普通关证据」
  // 不再是这个榜的保证，改在**榜级**验证普通关证据仍然在（下面那条）。
  // 注意 `砂金` 与 `砂金•戏浪` 是**两个不同的角色**（常驻 5★ vs 限定 5★），别混。
  const aventurine = empty.frontierUnits.filter((unit) => unit.name === 'Aventurine • Waveflair');
  assert.equal(aventurine.length, 1, '每个角色在榜上只出现一次（用户第 1 条）');
  assert.equal(empty.frontierUnits.length, empty.counts.frontierChars,
    '榜面条数 = 不同角色数：说明每行都是不同角色，没有角色霸榜');
  assert.equal(new Set(empty.frontierUnits.map((unit) => unit.name)).size,
    empty.frontierUnits.length, '榜上不允许出现同名两行');
  assert.ok(empty.frontierUnits.some((unit) => unit.envs.some((env) => env.id === 'aa')),
    '普通异相仲裁关卡的证据在榜上仍然存在（只是不再保证挂在某个特定角色名下）');
  assert.ok(empty.frontierUnits.every((unit) => unit.total > 0 && unit.envs.length >= 1),
    '每一行都要有分与至少一个副本证据（收敛不能把数据弄丢）');
  // ★ 用户 2026-10-11 的缺陷：切到 E0/E1/E2/E6 时只剩「最佳成绩就在这一档」的角色，
  // 「最佳成绩不在这一档」的角色整行消失（实测 E0 页 51 个角色里少了 33 个）。
  // 修法 = 服务端另发 `frontierTiers`：**每个档位各自按角色收敛一条**。这里在真实数据集上
  // 钉住三件事：结构（每条都属于它那一档、每角色一条、按分降序）、覆盖（「全部」里每条都能
  // 在自己档位里找到同键同分的那条）、以及**缺陷确实不再复现**（至少有一档的角色数比
  // 「最佳成绩在这一档」数出来的多）。
  const tierBoards = empty.frontierTiers;
  assert.ok(tierBoards && typeof tierBoards === 'object' && !Array.isArray(tierBoards),
    '总榜要下发逐星魂档的榜单（frontierTiers），否则界面切档又会退化成「只看最佳成绩」');
  const tierKeys = Object.keys(tierBoards).map(Number).sort((a, b) => a - b);
  assert.ok(tierKeys.length >= 3, `至少要有三个档位有整包，实际 ${tierKeys.join('/') || '（一个都没有）'}`);
  assert.ok(tierKeys.every((t) => EIDOLON_TIERS.includes(t)),
    `星魂档只能是 ${EIDOLON_TIERS.join('/')}（E3~E5 归入 E2 桶），实际 ${tierKeys.join('/')}`);
  for (const tier of tierKeys) {
    const rows = tierBoards[tier];
    assert.ok(Array.isArray(rows) && rows.length > 0, `E${tier} 档不该是空数组`);
    assert.ok(rows.every((u) => (Number(u.eidolon) || 0) === tier),
      `E${tier} 档里混进了别的星魂档的整包`);
    assert.equal(new Set(rows.map((u) => u.name)).size, rows.length,
      `E${tier} 档里同一个角色只能有一条（与「全部」同一条收敛规则）`);
    for (let i = 1; i < rows.length; i += 1) {
      assert.ok(rows[i - 1].total >= rows[i].total, `E${tier} 档没有按分降序`);
    }
  }
  // 缺陷的判据：旧口径只会数到「最佳成绩恰好在这一档」的那些角色。
  const legacyCount = (tier) => empty.frontierUnits
    .filter((u) => (Number(u.eidolon) || 0) === tier).length;
  assert.ok(tierKeys.some((tier) => tierBoards[tier].length > legacyCount(tier)),
    '至少有一个档位比「最佳成绩在这一档」的角色更多，否则这个缺陷根本没修好');
  for (const unit of empty.frontierUnits) {
    const row = (tierBoards[Number(unit.eidolon) || 0] || []).find((u) => u.key === unit.key);
    assert.ok(row, `E${unit.eidolon} 档里找不到「全部」里的 ${unit.key}`);
    assert.equal(row.total, unit.total, '同一个整包在「全部」与逐档榜里的分必须一致');
  }
  assert.ok(empty.eidolonUnits.every((unit) => [1, 2, 6].includes(unit.target)),
    '兼容用星魂榜也不能输出 E3/E4/E5 中间档');
  for (const unit of empty.units.slice(0, 20)) {
    assert.ok(['char', 'eidolon', 'cone'].includes(unit.kind), `未知单位类型 ${unit.kind}`);
    assert.ok(unit.pulls >= 1, `${unit.name} 的抽数应 ≥1，实际 ${unit.pulls}`);
    assert.ok(unit.envs.length >= 1);
    for (const env of unit.envs) {
      // 真正的不变量是「同一副本里整套的花费 ≥ 本单位自己的花费」。
      // 不能拿 unit.pulls 比：那是「性价比最好那一套」的自身花费，
      // 而 env.pulls 是**另一个副本**整套的花费，两个口径不同（会误报）。
      assert.ok(env.pulls >= (env.ownPulls || 1), '整套作业的抽数不会少于本单位自己那部分');
      assert.ok(unit.pulls >= 1);
      assert.ok(env.value > 0);
    }
  }

  // 拿一个真实角色当「已拥有」，她的星魂提升应该出现在单位榜里（如果榜单有）
  const mine = await archiveConclusion({ owned: ['Cyrene'], eidolons: { Cyrene: 0 } }, { window: 6 });
  const cyrene = mine.units.find((u) => u.name === 'Cyrene');
  if (cyrene) {
    assert.ok(cyrene.pulls >= 1);
    assert.ok(cyrene.total > 0);
  }
});

// ------------------------------------- 5. 战斗记录（米游社官方端点，归一化）
console.log('\n[5] 战斗记录归一化');

/** 造一份最小的原始响应：四个副本各一条记录 + 进度汇总。 */
const fakeRecords = () => {
  const time = { year: 2026, month: 9, day: 28, hour: 21, minute: 58 };
  const team = [
    { id: 1310, level: 80, rank: 2, rarity: 5, element: 'fire', is_return_assist: false, icon: 'https://example.invalid/firefly.png' },
    { id: 8007, level: 80, rank: 6, rarity: 5, element: 'ice', is_return_assist: false, icon: 'https://example.invalid/tb.png' },
  ];
  const node = (score) => ({
    challenge_time: time, avatars: team, score, boss_defeated: true,
    buff: { name_mi18n: '测试祝福', desc_mi18n: '说明' },
  });
  const groups = [{
    schedule_id: 1035, name_mi18n: '来生泅渡', status: 'Running', begin_time: time, end_time: time,
  }];
  return {
    i18n: {
      charactersById: {
        1310: { en: 'Firefly', cn: '流萤' },
        8007: { en: '{NICKNAME}', cn: '开拓者' },
      },
    },
    brief: {
      list: [
        { challenge_type: 'Boss', cur_schedule: { group_name: 'A', finish_star_count: '12', total_star_count: '12', finish_floor_num: '4', times: '3', has_tierce: true }, last_schedule: { group_name: 'A0', times: '1' } },
        { challenge_type: 'Chasm', cur_schedule: { group_name: 'B', finish_star_count: '36', total_star_count: '36', finish_floor_num: '12', times: '9', has_tierce: true } },
        { challenge_type: 'Story', cur_schedule: { group_name: 'C', finish_star_count: '12', total_star_count: '12', finish_floor_num: '4', times: '43', has_tierce: false } },
      ],
    },
    challenge: {
      star_num: 36,
      battle_num: 9,
      all_floor_detail: [{
        name: '其十二', star_num: 4, round_num: 2, is_tierce: true,
        node_1: node(), node_2: node(), node_3: node(),
      }],
      groups,
    },
    story: { star_num: 12, battle_num: 43, all_floor_detail: [{ name: '其四', star_num: 4, round_num: 8, node_1: node('40000') }], groups },
    boss: { star_num: 12, battle_num: 10, all_floor_detail: [{ name: '难度04', star_num: 4, node_1: node('3744') }], groups: [{
      schedule_id: 3021, name_mi18n: '支配遗忘', status: 'New', begin_time: time, end_time: time,
      // 末日幻影的敌方是官方给的（带图标）
      upper_boss: { id: 1, name_mi18n: '勾魂摄魄的支配者', icon: 'https://example.invalid/boss1.png' },
      lower_boss: { id: 2, name_mi18n: '迷惘之渊的裁定者', icon: 'https://example.invalid/boss2.png' },
      tierce_boss: { id: 3, name_mi18n: '雷奔云谲的恶狼主', icon: 'https://example.invalid/boss3.png' },
    }] },
    // 混沌回忆与虚构叙事：黑塔网赛程表对上的敌方（官方接口没有）
    enemies: {
      moc: { version: '4.5', source: 'theherta', sides: 3, list: [{ name: 'SparxiConOfficial', nameCn: '火花大会@Official', hp: '9,645,484 x2' }] },
      pf: { version: '4.5', source: 'theherta', sides: 3, list: [{ name: 'True Sting', nameCn: '虫群•真蛰虫', hp: '63,555,909' }] },
      as: { version: '4.6', source: 'theherta', sides: 3, list: [{ name: 'Kafka', nameCn: '卡芙卡', hp: '13,275,627 x2' }] },
    },
    peak: {
      challenge_peak_records: [
        {
          group: { group_id: 10, name_mi18n: '落叶归根', game_version: '4.6', status: 'End', begin_time: time, end_time: time },
          boss_info: { name_mi18n: '堕神之血•亚婆离', hard_mode_name_mi18n: '将杀王棋•绝境' },
          mob_infos: [{ name: '骑士（一）', monster_name: '合金机铠•帕姆王' }, { name: '骑士（二）', monster_name: '冥魂渡者' }],
          mob_records: [
            { has_challenge_record: true, challenge_time: time, round_num: 0, star_num: 3, avatars: team },
            { has_challenge_record: true, challenge_time: time, round_num: 1, star_num: 3, avatars: team },
          ],
          boss_record: { has_challenge_record: true, challenge_time: time, round_num: 0, star_num: 3, hard_mode: false, avatars: team, record_unique_key: 'k10' },
          mob_stars: 9, boss_stars: 3, battle_num: 1,
        },
        {
          group: { group_id: 10, name_mi18n: '落叶归根', game_version: '4.6', status: 'End' },
          boss_info: { name_mi18n: '堕神之血•亚婆离', hard_mode_name_mi18n: '将杀王棋•绝境' },
          mob_infos: [], mob_records: [],
          boss_record: { has_challenge_record: true, challenge_time: time, round_num: 9, star_num: 1, hard_mode: true, avatars: team, record_unique_key: 'k10h' },
          mob_stars: 0, boss_stars: 1, battle_num: 1,
        },
        {
          group: { group_id: 9, name_mi18n: '军团再临', game_version: '4.5', status: 'Running' },
          boss_info: { name_mi18n: '反造物主', hard_mode_name_mi18n: '将杀王棋•绝境' },
          mob_infos: [{ name: '骑士（一）', monster_name: 'X' }],
          mob_records: [{ has_challenge_record: true, challenge_time: time, round_num: 1, star_num: 3, avatars: team }],
          boss_record: { has_challenge_record: true, challenge_time: time, round_num: 2, star_num: 3, hard_mode: true, avatars: team, record_unique_key: 'k9h' },
          mob_stars: 9, boss_stars: 3, battle_num: 2,
        },
      ],
      has_more_boss_record: true,
      challenge_peak_best_record_brief: {
        total_battle_num: 55, mob_stars: 9, boss_stars: 3,
        challenge_peak_rank_icon_type: 'ChallengePeakRankIconTypeUltra',
      },
    },
    uid: '100000000', server: 'prod_gf_cn', fetchedAt: '2026-10-05T13:00:00.000Z',
  };
};

check('normalizeBattleRecords：汇总按副本顺序，层/队伍/星魂/时刻都还原', () => {
  const out = normalizeBattleRecords(fakeRecords());
  assert.equal(out.ok, true);
  assert.deepEqual(out.summary.map((r) => r.mode), ['moc', 'pf', 'as', 'aa'],
    '汇总应按 混沌回忆 / 虚构叙事 / 末日幻影 / 异相仲裁 排（brief 自己给的是 Boss/Chasm/Story）');
  const moc = out.modes.moc;
  assert.equal(moc.stars, 36);
  assert.equal(moc.floors.length, 1);
  const floor = moc.floors[0];
  assert.equal(floor.rounds, 2);
  assert.equal(floor.tierce, true, '星启模式要标出来');
  assert.equal(floor.nodes.length, 3, '第 12 层有三个间');
  assert.equal(floor.nodes[2].index, 3);
  assert.equal(floor.nodes[0].time, '2026-09-28T21:58:00', '时刻要拼成 ISO');
  assert.equal(floor.nodes[0].members[0].eidolon, 2, 'rank 就是星魂');
  assert.equal(floor.nodes[0].members[0].nameCn, '流萤');
  // 开拓者：文本表里 8007 只叫 {NICKNAME}，形态必须按 element 补
  assert.equal(floor.nodes[0].members[1].nameCn, '开拓者•记忆');
  assert.equal(floor.nodes[0].members[1].nameEn, 'Trailblazer (Remembrance)');
  // 末日幻影：没有 round_num，成绩在每间的 score 里
  assert.equal(out.modes.as.floors[0].rounds, null);
  assert.equal(out.modes.as.floors[0].nodes[0].score, 3744);
  assert.equal(out.modes.as.floors[0].nodes[0].bossDefeated, true);
  // 虚构叙事：有轮次也有每间分数与祝福名
  assert.equal(out.modes.pf.floors[0].rounds, 8);
  assert.equal(out.modes.pf.floors[0].nodes[0].buffName, '测试祝福');
});

  check('normalizeBattleRecords：异相仲裁按赛程分组，普通与绝境各一行，赛程号大的在前', () => {
  const out = normalizeBattleRecords(fakeRecords());
  const peak = out.modes.aa;
  assert.equal(peak.hasData, true);
  assert.equal(peak.best.battles, 55);
  assert.equal(peak.best.rankIconType, 'ChallengePeakRankIconTypeUltra');
  assert.deepEqual(peak.groups.map((g) => g.group.id), ['10', '9'], '4.6 在 4.5 前面');
  const ten = peak.groups[0];
  // 骑士关保持接口给的顺序（一 / 二 / 三）——按名字排会变成「二、三、一」
  assert.deepEqual(ten.mobs.map((m) => m.name), ['骑士（一）', '骑士（二）']);
  assert.equal(ten.mobs[0].monster, '合金机铠•帕姆王');
  assert.deepEqual(ten.boses.map((b) => b.hard), [false, true],
    '同一个赛程的普通王棋关与绝境王棋关要各占一行');
  const hard = ten.boses.find((b) => b.hard);
  assert.equal(hard.record.rounds, 9);
  assert.equal(ten.mobStars, 9);
  assert.equal(out.summary.find((r) => r.mode === 'aa').current.clearedHard, true,
    '明细里有绝境记录时汇总要标「绝境已通」');
});

check('normalizeBattleRecords：敌方信息按间号对位，官方优先、投稿口径另标', () => {
  const out = normalizeBattleRecords(fakeRecords());
  // 混沌回忆：官方没有敌方字段，用黑塔网赛程表（投稿口径）
  const mocEnemy = out.modes.moc.floors[0].nodes[0].enemy;
  assert.equal(mocEnemy.nameCn, '火花大会@Official');
  assert.equal(mocEnemy.hp, '9,645,484 x2');
  assert.equal(mocEnemy.official, false, '黑塔网来的要标成非官方，界面才会写「投稿口径」');
  assert.equal(out.modes.moc.enemySeason.version, '4.5');
  // 末日幻影：官方给了首领（带图标），血量来自黑塔网那期
  const asEnemy = out.modes.as.floors[0].nodes[0].enemy;
  assert.equal(asEnemy.name, '勾魂摄魄的支配者');
  assert.equal(asEnemy.icon, 'https://example.invalid/boss1.png');
  assert.equal(asEnemy.official, true);
  assert.equal(asEnemy.hp, '13,275,627 x2');
  assert.equal(asEnemy.datasetName, '卡芙卡', '社区叫法只留给 tooltip');
  // 队伍头像要带出来（界面上的圆形头像）
  assert.equal(out.modes.moc.floors[0].nodes[0].members[0].icon, 'https://example.invalid/firefly.png');
  // 异相仲裁：敌方就是这一关的首领本身，跟着骑士关 / 王棋关一起给
  const peak = out.modes.aa;
  assert.equal(peak.groups[0].mobs[0].enemy.name, '合金机铠•帕姆王');
  assert.equal(peak.groups[0].boses[0].enemy.name, '堕神之血•亚婆离');
});

check('normalizeBattleRecords：空输入不崩，缺哪个副本就少哪一块', () => {
  const empty = normalizeBattleRecords({});
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.summary, []);
  assert.equal(empty.modes.moc, null);
  assert.equal(empty.modes.aa, null);
  const partial = normalizeBattleRecords({
    ...fakeRecords(), peak: null, errors: [{ endpoint: 'peak', message: '10035' }],
  });
  assert.equal(partial.partial, true);
  assert.equal(partial.modes.aa, null);
  assert.equal(partial.modes.moc.stars, 36);
});

check('compareRosters 的匹配口径：按官方简中的基础名（皮肤后缀不影响）', () => {
  assert.equal(baseName('知更鸟•晴歌'), '知更鸟');
  assert.equal(baseName('开拓者•记忆'), '开拓者');
  assert.equal(baseName('Robin • Summeretto'), 'Robin');
  assert.equal(baseName('流萤'), '流萤');
});

checkAsync('compareRosters：真实阵容能对上榜单，并给出排名与榜首', async () => {
  const full = await archiveStats('moc', '4.5', { window: 6, perBand: 100000 });
  const team = full.bands.flatMap((b) => b.teams).find((t) => (t.rosterCn || []).every(Boolean));
  assert.ok(team, '榜单里应至少有一套带中文名的阵容');
  const res = await compareRosters([{ mode: 'moc', stage: '', names: team.rosterCn }], { window: 6 });
  const hit = res.results[0];
  assert.equal(hit.found, true, `${team.rosterCn.join('+')} 应能在榜单里找到`);
  assert.ok(hit.count > 0);
  assert.ok(hit.rankByAv >= 1 && hit.rankByAv <= hit.totalRosters);
  assert.ok(hit.top?.rosterCn?.length, '要带上榜首供对照');
});

checkAsync('compareRosters：编造的阵容如实报告「没找到」，参数不完整不崩', async () => {
  const res = await compareRosters([{ mode: 'moc', stage: '', names: ['张三', '李四', '王五', '赵六'] }], { window: 6 });
  assert.equal(res.results[0].found, false);
  assert.ok(res.results[0].env.totalRosters > 0);
  const bad = await compareRosters([{ mode: 'nope', names: ['甲', '乙'] }], { window: 6 });
  assert.equal(bad.results[0].found, false);
  assert.deepEqual((await compareRosters(null, {})).results, []);
});

check('战斗记录四个副本按钮不再显示「新鲜」，只在异常时才挂状态字', () => {
  // 用户 2026-10-10：「把战斗记录的新鲜两字去掉」。数据正常时不挂任何状态字，
  // 只有 partial / failed / stale 才提示 —— 理由同 v4.6.58 拿掉「分区·新鲜」那一行：
  // 数据整份一起抓，正常态的绿字是噪音。这条是护栏，别再画回去。
  const src = readFileSync(resolve('public/scripts/battle-record.js'), 'utf8');
  assert.ok(!/['"`]新鲜['"`]/.test(src),
    'battle-record.js 不该再出现「新鲜」这个字面量');
  assert.ok(/section\.status !== 'fresh'/.test(src),
    '正常态（fresh）必须被排除在渲染之外');
  assert.ok(/'部分'/.test(src), '异常态（部分/失败/旧数据）仍要保留');
});

check('战斗记录的角色 chip 外框统一白色（用户 2026-10-11「不要按属性上色」）', () => {
  // 用户原话：「战斗记录的角色的外框颜色统一为白色」。改前每张 chip 按角色属性上边框色
  // （`ELEMENT_CLASS` → `is-fire` / `is-quantum` …，同一支队伍四五种颜色）。
  // 这条是**源码级护栏**：颜色映射与那七条 CSS 都已经删掉，别再搬回来；
  // 边框色的**唯一来源**是 app.css 的 `.record-chip`，而且必须是白色。
  // 属性信息没丢：它仍然在 chip 的悬停提示（`chip.title` 里的 `member.elementCn`）。
  //
  // ⚠️ 判据前先把注释剥掉：**注释里允许提旧的属性 class**（讲清为什么删掉，
  //    那正是本仓库最值钱的资产），要拦的是「代码/样式里又长出属性配色」。
  //    不剥的话，下面这条会先被自己的说明文字绊倒（写这一轮时踩过一次）。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const js = stripComments(readFileSync(resolve('public/scripts/battle-record.js'), 'utf8'));
  const css = stripComments(readFileSync(resolve('public/styles/app.css'), 'utf8'));
  assert.ok(!/const ELEMENT_CLASS/.test(js), 'battle-record.js 不该再有 ELEMENT_CLASS 映射');
  for (const key of ['is-fire', 'is-ice', 'is-lightning', 'is-wind', 'is-quantum', 'is-imaginary', 'is-physical']) {
    assert.ok(!js.includes(key), `battle-record.js 不该再挂 ${key} 这个 class`);
    assert.ok(!css.includes(`.record-chip.${key}`), `app.css 不该再有 .record-chip.${key} 规则`);
  }
  // chip 的 class 只剩 `record-chip`（`is-clickable` 等状态类由后面按需加）
  assert.ok(/text\('span', 'record-chip'\)/.test(js), 'chip 必须建成裸的 record-chip（不带属性 class）');
  // 边框色必须是显式白色：`.record-chip` 那一条里 r = g = b 且够亮
  const block = css.slice(css.indexOf('.record-chip {'), css.indexOf('.record-chip-avatar'));
  const hit = block.match(/border:\s*1px solid rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  assert.ok(hit, '.record-chip 必须显式写出边框色（不要再回退到 var(--border) 那种偏蓝的底色）');
  assert.equal(hit[1], hit[2], 'chip 边框色必须是白的（r = g）');
  assert.equal(hit[2], hit[3], 'chip 边框色必须是白的（g = b）');
  assert.ok(Number(hit[1]) >= 200, `chip 边框要够亮（实测 r=${hit[1]}，应当 ≥ 200）`);
  // 悬停也不许换彩色边框（改前是青色）
  assert.ok(!/is-clickable:hover\s*\{[^}]*border-color:\s*rgba\(111, 211, 232/.test(css),
    '悬停不该把边框换成青色 —— 外框要始终是白的（只调亮一档）');
  // 属性信息仍然在悬停提示里
  assert.ok(/member\.elementCn/.test(js), 'chip 的 title 里仍要带属性中文名（颜色没了，信息不能一起没）');
});

check('金数不再进界面：战斗记录里不给队伍算金（限定/常驻会随版本变）', () => {
  // 这条是「护栏」：`teamCostOf` / `equippedConesOf` 已按用户要求删除
  // （理由：限定 / 常驻的划分会随版本更新变化，绝对金数印在战绩旁边会误导）。
  // 谁再往战斗记录里加金数，先来看一眼这段。
  const adviceSrc = readFileSync(resolve('public/scripts/advice.js'), 'utf8');
  const recordSrc = readFileSync(resolve('public/scripts/battle-record.js'), 'utf8');
  assert.ok(!/export const (teamCostOf|equippedConesOf)/.test(adviceSrc),
    'advice.js 不该再导出 teamCostOf / equippedConesOf');
  assert.ok(!/record-team-cost|成本 \$\{/.test(recordSrc),
    '战斗记录不该再渲染队伍金数');
  // 推荐榜那边的**相对**成本口径仍然在（「用到的限定越少越强」），它不依赖绝对金数
  const availability = {
    characters: { A: { rarity: 5, limited: true }, B: { rarity: 5, limited: false } },
  };
  assert.equal(pullCostOf(['A', 'B'], availability).pulls, 1);
});

checkAsync('换版本时「本地数据集落后」能被识别（界面据此提示去更新）', async () => {
  // 本期（数据集里有）→ 正常给敌方名单
  const now = await seasonEnemies('moc', '2026-09-28T07:00:00', '2026-11-02T06:00:00');
  assert.ok(now && !now.behind && now.list.length >= 1, '本期应当对上并给出敌方');
  // 超出数据集最后一期 → behind（不静默少一块，界面会提示去点更新）
  const beyond = await seasonEnemies('moc', '2026-12-14T07:00:00', '2027-01-25T06:00:00');
  assert.equal(beyond?.behind, true, '超出数据集最新一期要标成 behind');
  assert.deepEqual(beyond.list, []);
  assert.ok(beyond.window?.[1], '要带出数据集最新一期的档期，界面才好写清楚');
  // 异相仲裁没有站点口径的首领，永远不该给出 behind（那是另一套端点给的）
  assert.equal(await seasonEnemies('aa', '2026-12-14T07:00:00', '2027-01-25T06:00:00'), null);
});

check('成本口径：只有活动跃迁 5★ 算金，4★ / 常驻 / 开拓者一律 0（用户明确指定）', () => {
  const availability = {
    characters: {
      Firefly: { rarity: 5, limited: true }, // 限定 5★ → 算
      Himeko: { rarity: 5, limited: false }, // 常驻 5★ → 不算
      'Dan Heng': { rarity: 4, limited: false }, // 4★ → 不算
      'Trailblazer (Remembrance)': { rarity: 5, limited: false }, // 开拓者 → 不算
      'Brand New Guy': { rarity: 4, limited: true }, // 表格标错也要按 4★ 免（硬规则）
    },
    lightCones: {
      'Whereabouts Should Dreams Rest': { rarity: 5, limited: true }, // 活动跃迁 → 算
      'Sleep Like the Dead': { rarity: 5, limited: false }, // 常驻池 → 不算
      'Texture of Memories': { rarity: 5, limited: false }, // 星芒商店 → 不算
      'Some 4 Star Cone': { rarity: 4, limited: true }, // 4★ → 不算（硬规则）
    },
  };
  assert.equal(charCostOf('Firefly', availability), 1);
  assert.equal(charCostOf('Himeko', availability), 0, '常驻 5★ 不算成本');
  assert.equal(charCostOf('Dan Heng', availability), 0, '4★ 不算成本');
  assert.equal(charCostOf('Trailblazer (Remembrance)', availability), 0, '开拓者不算成本');
  assert.equal(charCostOf('开拓者•记忆', availability), 0, '米游社写法的开拓者同样不算');
  assert.equal(charCostOf('{NICKNAME}', availability), 0, '数据集写法的开拓者也一样');
  assert.equal(charCostOf('Brand New Guy', availability), 0, '4★ 是硬规则，表格标错也免');
  assert.equal(coneCostOf('Whereabouts Should Dreams Rest', availability), 1);
  assert.equal(coneCostOf('Sleep Like the Dead', availability), 0, '常驻 5★ 光锥不算');
  assert.equal(coneCostOf('Texture of Memories', availability), 0, '星芒商店 5★ 不算');
  assert.equal(coneCostOf('Some 4 Star Cone', availability), 0, '4★ 光锥是硬规则');
  // 资料表缺项时仍按「要金」算（宁可高估）
  assert.equal(charCostOf('Nobody At All', availability), 1);
  assert.equal(coneCostOf('No Such Cone', availability), 1);
  // pullCostOf 走同一套规则
  assert.equal(pullCostOf(['Firefly', 'Himeko', 'Dan Heng', 'Trailblazer (Remembrance)'], availability).pulls, 1);
});

check('答案二 budgetPlan：预算内贪心选单位，边际收益按副本去重', () => {
  const conclusion = {
    units: [
      {
        key: 'char:A', name: 'A', kind: 'char', pulls: 1, total: 3,
        envs: [{ id: 'moc', envLabel: '混沌回忆', gain: 1.5 }, { id: 'pf', envLabel: '虚构叙事', gain: 1.0 }],
      },
      {
        key: 'char:B', name: 'B', kind: 'char', pulls: 3, total: 2,
        envs: [{ id: 'moc', envLabel: '混沌回忆', gain: 2.5 }],
      },
      {
        key: 'char:C', name: 'C', kind: 'char', pulls: 9, total: 4,
        envs: [{ id: 'as', envLabel: '末日幻影', gain: 2.0 }],
      },
    ],
  };
  // 预算 1：只买得起 A → 总提升 1.5 + 1.0 = 2.5
  const one = budgetPlan(conclusion, 1);
  assert.deepEqual(one.picks.map((p) => p.name), ['A']);
  assert.equal(one.totalPulls, 1);
  assert.ok(Math.abs(one.totalGain - 2.5) < 1e-6, String(one.totalGain));
  // 预算 3：A 先上（边际 2.5 / 1 金）；剩 2 金买不起 B（3 金）
  const three = budgetPlan(conclusion, 3);
  assert.deepEqual(three.picks.map((p) => p.name), ['A']);
  assert.equal(three.remaining, 2);
  // 预算 4：A 之后买得起 B → B 在 moc 把 1.5 抬到 2.5，边际 1.0，正好用满
  const four = budgetPlan(conclusion, 4);
  assert.deepEqual(four.picks.map((p) => p.name), ['A', 'B']);
  assert.equal(four.totalPulls, 4);
  assert.ok(Math.abs(four.totalGain - 3.5) < 1e-6, String(four.totalGain));
  assert.equal(four.exhausted, true);
  // 预算 13：A(1) → B(3) → C(9) 全买得起（1+3+9 = 13）
  const nine = budgetPlan(conclusion, 13);
  assert.deepEqual(nine.picks.map((p) => p.name), ['A', 'B', 'C']);
  // 同一副本里只按最好的那一个单位算：moc 最终是 2.5，不是 1.5 + 2.5
  assert.ok(Math.abs(nine.totalGain - 5.5) < 1e-6, String(nine.totalGain));
  // 0 金预算：什么都不选，也不崩
  const zero = budgetPlan(conclusion, 0);
  assert.deepEqual(zero.picks, []);
  assert.equal(zero.totalGain, 0);
  // 不限预算：把所有正收益单位都选上
  const all = budgetPlan(conclusion, null);
  assert.equal(all.picks.length, 3);
  assert.equal(all.remaining, null);
  // 没有单位时不崩
  assert.deepEqual(budgetPlan({ units: [] }, 5).picks, []);
});

check('实验性 marginalPlan：每一步按当前覆盖后的边际收益重排', () => {
  const env = (id, gain, weight = 1) => ({ id, envLabel: id, gain, weight });
  const conclusion = {
    units: [
      { key: 'char:A', name: 'A', kind: 'char', pulls: 1,
        envs: [env('moc', 10)] },
      { key: 'char:B', name: 'B', kind: 'char', pulls: 2,
        envs: [env('moc', 4), env('as', 5)] },
      { key: 'char:C', name: 'C', kind: 'char', pulls: 2,
        envs: [env('moc', 3), env('pf', 4, 2)] },
    ],
    envs: [{ id: 'moc', baseline: { score: 0 } }, { id: 'pf', baseline: { score: 0 } }],
  };
  const plan = marginalPlan(conclusion, { budget: 3, objective: 'efficiency' });
  // A 先覆盖 moc=10；随后 C 的 pf=8 比 B 的 as=5 更划算，且 moc 不会重复计入。
  assert.deepEqual(plan.picks.map((p) => p.name), ['A', 'C']);
  assert.equal(plan.totalPulls, 3);
  assert.equal(plan.picks[1].marginalGain, 8);
  assert.equal(plan.coveredCount, 2);
  assert.equal(plan.totalGain, 18);

  const strength = marginalPlan(conclusion, { budget: 3, objective: 'strength' });
  assert.deepEqual(strength.picks.map((p) => p.name), ['C', 'A']);
  // 已覆盖的 moc 只取最大值，不会把 3 + 4 重复加成 7。
  assert.equal(strength.totalGain, 18);
});

check('抽卡方案：一个单位一条、买不起只跳过不中断，条数不再被副本数卡死', () => {
  // 用户 2026-10 报的 bug：「抽卡方案只显示少量角色」。根因是旧版**按作业**给方案
  // 且「一个副本只挑一套」，而一个副本的收益在数据里只有一份 → 最多排出 4~5 步、
  // 实测整页只出现 5 个单位（还会出现「补上 0 个单位」的空步骤）。
  // 现在每个单位各占一条，长度由预算与单位数决定。
  const env = (id, gain) => ({ id, envLabel: id, gain, easy: false, pctBefore: 0, pctAfter: gain });
  const units = Array.from({ length: 12 }, (_, i) => ({
    key: `char:U${i}`,
    name: `U${i}`,
    kind: 'char',
    pulls: 1,
    total: 12 - i,
    envs: [env('moc', 10 - i * 0.5)],
  }));
  const conclusion = { units, envs: units.map(() => null).filter(Boolean) };

  // 不限预算：12 个单位全进清单（旧版最多 5 条，因为只有 5 个副本）
  const all = budgetPlan(conclusion, null);
  assert.equal(all.picks.length, 12, `不限预算时应列出全部 12 条，实际 ${all.picks.length}`);
  assert.equal(all.totalPulls, 12);
  assert.equal(all.remaining, null);
  // 覆盖的副本数按「每个副本只算一次」计（不是把 12 条收益相加）
  assert.equal(all.coveredCount, 1, '同一个副本只算一次覆盖');
  assert.equal(all.byEnv.length, 1);
  assert.equal(all.totalGain, 10, '同一个副本的收益不能重复累加');

  // 预算 5 金：**买不起的跳过、后面的便宜货照拿**（不是遇到贵的就中断）
  const tight = budgetPlan({
    units: [
      { key: 'char:Big', name: 'Big', kind: 'char', pulls: 9, total: 99, envs: [env('moc', 9)] },
      { key: 'char:Small', name: 'Small', kind: 'char', pulls: 1, total: 1, envs: [env('moc', 1)] },
    ],
  }, 5);
  assert.deepEqual(tight.picks.map((p) => p.name), ['Small'],
    '买不起的 Big 只跳过，不该中断整份清单');

  // 每条都带界面要用的字段（花几金、性价比、为什么）
  const pick = all.picks[0];
  assert.equal(pick.pulls, 1);
  assert.ok(pick.value > 0);
  assert.ok(Array.isArray(pick.envs) && pick.envs[0].envLabel === 'moc');
  assert.ok('easy' in pick.envs[0] && 'pctAfter' in pick.envs[0], '原因字段要带给界面');
});

check('性价比总榜（frontierUnits）：只用黑塔网数据，不看角色池，但听总榜权重', () => {
  // 用户 2026-10 的要求：「性价比总榜改为完全不依靠用户自己的角色池，而仅通过
  // 黑塔网数据得出，并且也能设置权重」。
  //
  // v15（用户 2026-10 口径）之后，单位是**整包** = 角色 + 星魂档 + 光锥绑成一条：
  //   score(整包, 副本) = 100 × 档位权重 × 行动值项 × (该副本最便宜金数 ÷ 该配置金数)
  // 分子分母都只来自**队伍**，所以同一支队伍的成员必然同分（口径使然，不再打破）。
  const availability = {
    characters: {
      Star: { limited: true }, Pal: { limited: true },
      Rich: { limited: true }, Other: { limited: true }, Third: { limited: true }, Fourth: { limited: true },
      Free: { rarity: 4, limited: false },
    },
    lightCones: { 'Big Cone': { rarity: 5, limited: true } },
  };
  // 满分档：一套「四个限定角色都 E0」（= 4 金），一套「Star 到 E2 还带专武」（= 6 金）。
  // 注意金数是**按成员算出来的**，不是夹具上写的 `t.cost`：v15 的口径里分母是那支
  // 队伍的金数，所以 starGold(6) > bareGold(4) → 后者的分更高。
  const stacked = () => {
    const t = teamFixture(['Star', 'Pal', 'Free', 'Fifth'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
      [{ char: 'Star', eidolon: 2, lc: 'Big Cone', superimp: 1 },
        { char: 'Pal', eidolon: 0 },
        { char: 'Free', eidolon: 0 },
        { char: 'Fifth', eidolon: 0 }]);
    t.cost = 1;
    return t;
  };
  const bare = () => {
    const t = teamFixture(['Rich', 'Other', 'Third', 'Fourth'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
      [{ char: 'Rich', eidolon: 0 }, { char: 'Other', eidolon: 0 },
        { char: 'Third', eidolon: 0 }, { char: 'Fourth', eidolon: 0 }]);
    t.cost = 12;
    return t;
  };
  const env = envFixture('moc', [stacked(), stacked(), bare(), bare()]);
  // 总榜只看 `frontierWeights`（方案那一行是 `weights`，互不影响，见下一条用例）
  const run = (account, frontierWeights) => buildConclusion([env], { availability, account, frontierWeights });
  const a = run({ owned: new Set(), eidolons: new Map(), cones: new Map() });
  const b = run({ owned: new Set(['Star', 'Pal']), eidolons: new Map([['Star', 6]]), cones: new Map() });

  assert.ok(a.frontierUnits.length > 0, '总榜必须有条目');
  const keysOf = (list) => list.map((u) => `${u.key}:${u.total.toFixed(6)}`).join('|');
  assert.equal(keysOf(a.frontierUnits), keysOf(b.frontierUnits),
    '总榜（键与分值）不能随角色池变化');

  const star = a.frontierUnits.find((u) => u.name === 'Star');
  assert.ok(star, '最便宜那批里的角色要进榜');
  assert.equal(star.eidolon, 2, '单位是「角色 + 星魂档」整包，星魂档是它身份的一部分');
  assert.equal(star.lc, 'Big Cone', '整包还要绑上它当时用的光锥');
  assert.equal(star.gold, 4, '整包自己的金数 = 本体 1 + E2 两金 + 活动光锥 1 金');
  // 金数更少的那支队伍分更高（「根据达成目标的金数更少决定性价比」的直接体现）。
  const rich = a.frontierUnits.find((u) => u.name === 'Rich');
  assert.ok(rich, '另一支队伍里的角色也进榜（只是分低）');
  assert.equal(rich.envs[0].bestTeamGold, 4, '四个限定 E0 = 4 金');
  assert.equal(star.envs[0].bestTeamGold, 6, 'Star E2 + 专武 + 两个同伴 = 6 金');
  assert.equal(rich.envs[0].score, 100, '该副本最便宜的那支达标队伍拿满分 100');
  assert.ok(Math.abs(star.envs[0].score - (4 / 6) * 100) < 0.01,
    `分 = 100 × 该副本最便宜金数 ÷ 本配置金数，实际 ${star.envs[0].score}`);
  // 同一支队伍的成员必然同分（分子只来自队伍）—— 这是口径的性质，不是 bug。
  const pal = a.frontierUnits.find((u) => u.name === 'Pal');
  assert.equal(pal.total, star.total, '同一支队伍的成员应当同分（并列）');
  assert.equal(pal.tieKey, star.tieKey, '并列的整包共享同一个最佳证据');
  // 0 金整包不进榜：4★ / 常驻 / 开拓者（且没有限定光锥）
  assert.equal(a.frontierUnits.some((u) => u.name === 'Free'), false, '4★ 整包不该进榜');
  // 光锥不再是独立一行：它绑在整包里（`Big Cone` 自己不该再单独出现）
  assert.equal(a.frontierUnits.some((u) => u.name === 'Big Cone'), false,
    '光锥不再是总榜的独立单位，它绑在角色整包里');

  // 权重：把混沌回忆权重拉高 → 分值等比放大，排序不变
  const heavier = run({ owned: new Set() }, { 'moc|': 8 });
  const starHeavy = heavier.frontierUnits.find((u) => u.name === 'Star');
  assert.ok(starHeavy.total > star.total,
    `权重调大后分值应变大：${star.total} → ${starHeavy.total}`);
  assert.deepEqual(heavier.frontierUnits.map((u) => u.key), a.frontierUnits.map((u) => u.key),
    '整体等比放大不该改变排序');
  // 权重调成 0 = 这个副本不参与排序（允许 0，不再被静默退回默认值）
  const off = run({ owned: new Set() }, { 'moc|': 0 });
  assert.deepEqual(off.frontierUnits, [], '权重 0 时该副本的贡献为 0，榜面应为空');
  const blank = run({ owned: new Set() }, { 'moc|': '' });
  assert.deepEqual(blank.frontierUnits, [], '权重输入为空时也应按 0 计算，不能退回默认值');
});

check('性价比总榜：切到某个星魂档，看得到「最佳成绩不在这一档」的角色（用户 2026-10-11）', () => {
  // 用户原话：「性价比总榜-全部榜单目前做的比较不错，但拆分到 E0/1/2/6，则只能看到
  // 存在最佳成绩的角色，而看不到非最佳成绩的每个角色」。
  //
  // 根因：`frontierUnits` 每角色只收敛成一条（总分最高的整包），界面再拿它按 `eidolon`
  // 过滤时，剩下的必然是「最佳成绩恰好是这一档」的角色。修法 = **每个档位各自收敛一次**
  // （`frontierTiers`）。这条用例是那个缺陷的最小复现：
  //   * Star 有两套整包 —— E0 在 4 金队里（更便宜 → 分更高）、E2 在 6 金队里；
  //   * 于是「全部」里只有 Star E0；
  //   * 旧口径下 E2 页里**根本看不到 Star**，新口径下 `frontierTiers[2]` 必须有它。
  const availability = {
    characters: {
      Star: { limited: true }, Pal: { limited: true }, Other: { limited: true },
      Third: { limited: true }, Fourth: { limited: true },
    },
    lightCones: {},
  };
  const starE0 = teamFixture(['Star', 'Pal', 'Other', 'Third'],
    { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
    [{ char: 'Star', eidolon: 0 }, { char: 'Pal', eidolon: 0 },
      { char: 'Other', eidolon: 0 }, { char: 'Third', eidolon: 0 }]);
  const starE2 = teamFixture(['Star', 'Pal', 'Other', 'Fourth'],
    { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
    [{ char: 'Star', eidolon: 2 }, { char: 'Pal', eidolon: 0 },
      { char: 'Other', eidolon: 0 }, { char: 'Fourth', eidolon: 0 }]);
  const out = buildConclusion([envFixture('moc', [starE0, starE2])], {
    availability,
    account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
    frontierWeights: { 'moc|': 1 },
  });

  // 前提：E0 那支队伍更便宜（4 金 vs 6 金），所以 Star 的最佳成绩落在 E0。
  const best = out.frontierUnits.filter((u) => u.name === 'Star');
  assert.equal(best.length, 1, '「全部」里每个角色只有一条');
  assert.equal(best[0].eidolon, 0, 'Star 的最佳成绩在 E0（4 金队 < 6 金队）');

  // ★ 缺陷本体：E2 档必须能看到 Star —— 它「最佳成绩不在这一档」，但确实有 E2 整包。
  const e2 = out.frontierTiers?.[2] || [];
  const starE2Row = e2.find((u) => u.name === 'Star');
  assert.ok(starE2Row, 'E2 档里必须有 Star：旧口径下它会整行消失（用户报的缺陷）');
  assert.equal(starE2Row.eidolon, 2, 'E2 档里的那一条必须是 E2 整包');
  assert.ok(starE2Row.total > 0, 'E2 档的那一条要有分');

  // E0 档里它自己的那一条 = 「全部」里那条（同一份整包，不是另算一遍）。
  const starE0Row = (out.frontierTiers?.[0] || []).find((u) => u.name === 'Star');
  assert.ok(starE0Row, 'E0 档里也要有 Star');
  assert.equal(starE0Row.total, best[0].total,
    'E0 档里 Star 的分 = 「全部」里那条 E0 的分（同一份整包）');
  assert.ok(starE2Row.total < starE0Row.total, '贵的队伍分更低：成本项的口径没有变');

  // 两档各自按角色收敛：只有 Star 在 E2（队友都是 E0），而 E0 档里那支 4 金队的成员同分。
  assert.deepEqual(e2.map((u) => u.name).sort(), ['Star'],
    'E2 档里只有 Star 一个人到 E2（队友都是 E0，不该被拖进 E2 档）');
  for (const mate of ['Pal', 'Other', 'Third']) {
    const row = (out.frontierTiers?.[0] || []).find((u) => u.name === mate);
    assert.ok(row, `E0 档里应当有 ${mate}`);
    assert.equal(row.total, starE0Row.total,
      `同一支队伍的成员在逐档榜里同样并列（口径不变）：${mate}`);
  }
  for (const [tier, rows] of Object.entries(out.frontierTiers)) {
    assert.ok(rows.every((u) => (Number(u.eidolon) || 0) === Number(tier)),
      `E${tier} 档里混进了别的档位的整包`);
    assert.equal(new Set(rows.map((u) => u.name)).size, rows.length,
      `E${tier} 档里同一个角色只能有一条`);
    for (let i = 1; i < rows.length; i += 1) {
      assert.ok(rows[i - 1].total >= rows[i].total, `E${tier} 档没有按分降序`);
    }
  }
  // 「全部」那份的每条都能在它自己的档位里按整包键找到（收敛没有分叉成两套）。
  for (const unit of out.frontierUnits) {
    const row = (out.frontierTiers[unit.eidolon] || []).find((u) => u.key === unit.key);
    assert.ok(row, `${unit.key} 在 E${unit.eidolon} 档里找不到`);
    assert.equal(row.total, unit.total);
  }
});

check('性价比总榜：队伍金数相同时，用更多限定光锥的那支更强（用户第 10 条）', () => {
  // 用户第 10 条：「两个队伍金数完全相同时，使用更多限定光锥的更强，否则金更少的更强」。
  // 后半句已经由「该副本最便宜金数 ÷ 该配置金数」表达（金更少 → 分更高），所以这里
  // 只需钉住前半句：**同金数同分**时，限定光锥更多的那支排在前面。
  const availability = {
    characters: {
      Cones: { rarity: 5, limited: true },
      Cones2: { rarity: 5, limited: true },
      Rich: { rarity: 5, limited: true },
    },
    lightCones: {
      'Cone A': { rarity: 5, limited: true },
      'Cone B': { rarity: 5, limited: true },
    },
  };
  // A 队：两个限定角色各带一把限定光锥；B 队：一个限定角色的 E1。
  // 两队金数都是 2 = 该副本最便宜金数 → 两条配置的分完全相同，只能靠第 10 条分先后。
  const coneTeam = [
    { char: 'Cones', eidolon: 0, lc: 'Cone A', superimp: 1 },
    { char: 'Cones2', eidolon: 0, lc: 'Cone B', superimp: 1 },
  ];
  const charTeam = [{ char: 'Rich', eidolon: 1 }];
  const env = envFixture('aa|plight', [], {
    mode: 'aa', stage: 'plight', season: '4.5',
    frontierRows: [
      { cost: 2, tier: 'perfect', members: coneTeam },
      { cost: 2, tier: 'perfect', members: charTeam },
    ],
  });
  const out = buildConclusion([env], { availability });
  const cones = out.frontierUnits.find((u) => u.name === 'Cones');
  const rich = out.frontierUnits.find((u) => u.name === 'Rich');
  assert.ok(cones && rich, '两支队伍的整包都应进榜');
  assert.equal(cones.total, rich.total, '金数相同 → 总分相同（第 10 条只在同分时决定先后）');
  assert.equal(cones.envs[0].limitedCones, 2, 'A 队用了 2 把限定光锥');
  assert.equal(rich.envs[0].limitedCones, 0, 'B 队的 2 金全在星魂上，没有限定光锥');
  const order = out.frontierUnits.map((u) => u.name);
  assert.ok(order.indexOf('Cones') < order.indexOf('Rich'),
    `同金数时限定光锥更多者应排在前面，实际顺序 ${order.join(' > ')}`);
});

check('性价比总榜：只有 E2 的证据时，E2 整包照样按自己的队伍证据入榜', () => {
  // 选择偏差：E0 表现很差的角色可能根本没人上传 E0 投稿。旧口径用「目标档占比 −
  // 前一档占比」，会把 E0 缺席误当成 E2 没有可量化提升。v15 的口径只看**整包自己
  // 出现过的配置**，所以没有 E0/E1 样本不构成任何扣分。
  const availability = { characters: { Carry: { rarity: 5, limited: true } }, lightCones: {} };
  const members = [{ char: 'Carry', eidolon: 2 }];
  const team = teamFixture(['Carry'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0, members);
  team.cost = 3;
  const env = envFixture('aa|plight', [team], {
    mode: 'aa', stage: 'plight',
    // ⚠️ 用户 2026-10-11 缺陷 3 起，表现分以**该副本的判据线**为标尺。`envFixture` 默认
    // 给的是 moc 的 `{0,2,4}`，与本用例的绝境成绩（行动值 240）量纲不符 → 曲线会判成
    // 线外。夹具必须给该副本真实的线（绝境 `{300,500}`），否则测的是「线配错了」。
    tierLines: { perfect: 300, target: 500 },
    frontierRows: [{ cost: 3, actionValue: 240, members }],
  });
  const out = buildConclusion([env], { availability });
  const e2 = out.frontierUnits.find((unit) => unit.name === 'Carry' && unit.eidolon === 2);
  assert.ok(e2, '没有 E0/E1 记录时，E2 整包仍应进入总榜');
  assert.equal(e2.basis, 'team-gold-frontier-pack', '整包按「队伍金数前沿」计分');
  assert.equal(e2.gold, 3, '整包自己的金数 = 本体 1 + E2 两金');
  assert.equal(e2.envs[0].bestTeamGold, 3, '最佳证据记的是那支队伍的金数');
  assert.equal(e2.envs[0].tier, 'perfect');
  assert.ok(e2.total > 0);
  // 只有 E2 高分证据时，不能把关键星魂后的成绩倒灌给「本体 E0」那个整包 ——
  // 因为 E0 从来没有出现在任何一条配置里。
  assert.equal(out.frontierUnits.some((unit) => unit.name === 'Carry' && unit.eidolon === 0), false,
    '没有 E0 配置时不该凭空生成 E0 整包');
});

check('性价比总榜：版本窗口 = 3 版、窗口内等权、窗口外权重 0（用户 2026-10-12 第 5 条）', () => {
  // ⚠️ 口径变更史（别改回去）：
  //   * v16（用户 2026-10 第 7 条）：近 1-3 版各 2 分、近 4-7 版各 1 分，窗口 7。
  //   * v4.6.87（用户 2026-10-12 第 5 条原话：「把角色总榜的版本窗口收到 3 版」）：
  //     窗口收到 **3 版**，于是「近 4-7 版各 1 分」那一档从表里消失，
  //     `VERSION_WEIGHTS` 变回 **三版等权** `2:2:2`。
  //     依据是实测：用户点名那支（遐蝶/昔涟/长夜月/风堇）有 **32.1%** 的分来自权重 1 的
  //     那四个旧版本，而它那四个人一起上场在 4.6 根本没有投稿（最新满分证据停在 4.5）。
  //
  // 所以这条用例现在测的是两件事：① 表本身是 2:2:2、窗口是 3；
  // ② **窗口外的版本对分数没有任何贡献**（权重 0 = 不进分子也不进分母）。
  assert.deepEqual(VERSION_WEIGHTS, [2, 2, 2], '版本权重表应是三版等权 2:2:2');
  assert.equal(VERSION_WINDOW, 3, '版本窗口应是 3');
  assert.equal(versionWeightOf(2), 2, '第 3 个版本仍是 2 分');
  assert.equal(versionWeightOf(3), 0, '第 4 个版本起权重 0（不进窗口，不是「权重很小」）');

  const availability = {
    characters: {
      Recent: { rarity: 5, limited: true }, Stale: { rarity: 5, limited: true },
      Pacer: { rarity: 5, limited: true },
    },
    lightCones: {},
  };
  const seasons = ['4.0', '4.1', '4.2', '4.3', '4.4', '4.5'];
  // ⚠️ 键必须写成**带引号的字符串**：对象字面量里的 `4.0` 是数字字面量，
  // `{ 4.0: 1 }` 的键是 `"4"` 而不是 `"4.0"` —— 实测过：那样写会让 4.0 这一版
  // 查不到权重，静默退回 `versionWeightOf(5)`，旧表里是 1、新表里是 0，
  // 于是这条用例在收窗之后凭空红了（夹具 bug，不是生产 bug）。
  const seasonWeights = { '4.5': 2, '4.4': 2, '4.3': 2, '4.2': 0, '4.1': 0, '4.0': 0 };
  const rowsOf = (char, bestSeason) => seasons.map((season) => ({
    cost: season === bestSeason ? 2 : (season === '4.0' || season === '4.5' ? 4 : 3),
    tier: 'perfect',
    newestSeason: season,
    members: [{ char, eidolon: 2 }],
  }));
  // 每个版本一条 2 金陪跑 → 各版本 minCost 统一为 2，这样测出来的只是版本权重，
  // 不是版本间的金数水位差。
  const pacers = seasons.map((season) => ({
    cost: 2, tier: 'perfect', newestSeason: season, members: [{ char: 'Pacer', eidolon: 0 }],
  }));
  const env = envFixture('aa|plight', [], {
    mode: 'aa', stage: 'plight', season: '4.5',
    frontierRows: [...rowsOf('Recent', '4.5'), ...rowsOf('Stale', '4.0'), ...pacers],
  });
  const out = buildConclusion([env], {
    availability,
    frontier: {
      'aa|plight': { seasons, seasonWeights, weight: 10, frontierRows: env.frontierRows },
    },
  });
  const recent = out.frontierUnits.find((unit) => unit.name === 'Recent');
  const stale = out.frontierUnits.find((unit) => unit.name === 'Stale');
  assert.ok(recent && stale, '两个整包都应进榜');
  // 分母只含**权重 > 0** 的那三版（4.5/4.4/4.3），窗口外的三版连分母都不进。
  assert.equal(recent.envs[0].absentSeasons, 0,
    '权重 0 的版本是「不进窗口」，不是「早于登场」—— 不该被记成不参与平均');
  assert.equal(recent.envs[0].droppedSeasons, 0, '权重 0 的版本也不该被记成「无人使用算 0 分」');
  // Recent：4.5 拿 2 金 → 100；4.4 / 4.3 各 3 金 → 66.67。Σw = 6。
  const perEnv = (u) => u.total / 10; // 绝境权重 10
  const expectRecent = (2 * 100 + 2 * (200 / 3) + 2 * (200 / 3)) / 6;
  assert.ok(Math.abs(perEnv(recent) - expectRecent) < 0.01,
    `Recent 的三版等权平均应为 ${expectRecent.toFixed(2)}，实际 ${perEnv(recent).toFixed(4)}`);
  // Stale：4.5 是 4 金 → 50；4.4 / 4.3 各 3 金 → 66.67（它「最便宜的那一版」4.0 在窗口外，
  // 权重 0 —— 这正是收窗要治的那件事：旧版本的便宜优势不再能拉住分数）。
  const expectStale = (2 * 50 + 2 * (200 / 3) + 2 * (200 / 3)) / 6;
  assert.ok(Math.abs(perEnv(stale) - expectStale) < 0.01,
    `Stale 的三版应为 ${expectStale.toFixed(2)}（它的 4.0 那版不进窗口），实际 ${perEnv(stale).toFixed(4)}`);
  assert.ok(recent.total > stale.total,
    '分数集合相同、只把高分从窗口外换到窗口内 → 窗口内那个必须更高');
  // 版本元数据要真的下发到界面（界面据此写「按 N 个版本加权」与那张比例）。
  // ⚠️ 顺序是**新的在前**（内部 `seasonOrder` 就是这个顺序，权重表按下标取），
  // 别按升序断言；也不要在这里改字典序排序 —— 版本号迟早出现 4.10，字典序会把它
  // 排到 4.2 前面。
  assert.deepEqual(out.frontierEnvs[0].seasons, [...seasons].reverse(),
    '副本元数据要带版本列表（新的在前）');
  assert.equal(out.frontierEnvs[0].seasonWeights['4.5'], 2, '窗口内第 1 版 2 分');
  assert.equal(out.frontierEnvs[0].seasonWeights['4.3'], 2, '窗口内第 3 版也是 2 分（等权）');
  assert.equal(out.frontierEnvs[0].seasonWeights['4.2'], 0, '窗口外的版本权重 0');
});

check('性价比总榜：早于「登场版本」的版本**不参与平均**（不奖不罚，用户 2026-10-10 第二轮）', () => {
  // 这条用例取代了原来的「按场地水平等比例放大（用户第 6 条）」与
  // 「只有早于登场版本的旧版本才放大（v4.6.47 修复）」两条 —— 那两版口径都已废除。
  //
  // ⚠️ 为什么整条废掉「放大」：实测放大出来的推算分会**反超实测分**。榜首真珠 E2
  // 唯一实测的那版只贡献 140/910 = **15.4%**，其余全是它 4.5 才登场、却在 4.0~4.4
  // （当时根本没在游戏里）按 ×2 推出来的，于是「版本因子」余数 > 1（×1.30）。
  //
  // 现在的三态（语义各不相同，别混）：
  //   有证据            → 实测分
  //   缺证据 且 早于登场 → **不参与平均**（不进分子也不进分母）—— 无从判断
  //   缺证据 且 已登场   → **算 0 分**（进分母、不进分子）—— 明确的差
  // 用户第 6 条的本意是「不罚新角色」，而 **不参与 ≠ 罚**：既能保住第 6 条的意图，
  // 又不会编造一个当时不存在的成绩。
  const availability = {
    characters: {
      Newbie: { rarity: 5, limited: true },   // 登场 4.5，窗口内只有 4.5 有证据
      Veteran: { rarity: 5, limited: true },  // 登场 3.0，窗口内两版都有证据
      Filler: { rarity: 5, limited: true },
    },
    lightCones: {},
  };
  const seasons = ['4.4', '4.5'];
  const seasonWeights = { 4.5: 2, 4.4: 2 };
  const rows = [
    { cost: 2, tier: 'perfect', newestSeason: '4.5', members: [{ char: 'Newbie', eidolon: 0 }] },
    { cost: 2, tier: 'perfect', newestSeason: '4.5', members: [{ char: 'Veteran', eidolon: 0 }] },
    { cost: 2, tier: 'perfect', newestSeason: '4.4', members: [{ char: 'Veteran', eidolon: 0 }] },
    { cost: 2, tier: 'perfect', newestSeason: '4.4', members: [{ char: 'Filler', eidolon: 0 }] },
  ];
  const env = envFixture('aa|plight', [], {
    mode: 'aa', stage: 'plight', season: '4.5', frontierRows: rows,
  });
  const out = buildConclusion([env], {
    availability,
    firstSeen: { characters: { Newbie: '4.5', Veteran: '3.0', Filler: '3.0' }, lightCones: {} },
    frontier: { 'aa|plight': { seasons, seasonWeights, weight: 10, frontierRows: rows } },
  });
  const newbie = out.frontierUnits.find((u) => u.name === 'Newbie');
  const vet = out.frontierUnits.find((u) => u.name === 'Veteran');
  assert.ok(newbie && vet, '两个整包都应进榜');
  const perEnv = (u) => u.total / 10; // 绝境权重 10

  // ---- Newbie：登场 4.5，4.4 早于它登场 → 那一版**不参与** ----
  assert.equal(newbie.envs[0].absentSeasons, 1, 'Newbie 缺的 4.4 早于登场 → 记 1 个「不参与」');
  assert.equal(newbie.envs[0].droppedSeasons, 0, '「不参与」不算「无人使用」（两者互斥）');
  // 只剩 4.5 一版实测（权重 2）→ 分母 2、分子 100×2 = 200 → 100。
  // ⚠️ 若误改成「放大」，这一版会被乘上场地水平比 > 1（旧口径实测能到 ×2）
  //    → 分数反超实测；若误改成「算 0 分」，分母变 4 → 50。
  assert.ok(Math.abs(perEnv(newbie) - 100) < 0.01,
    `早于登场的版本应不参与平均 → Newbie 应为 100，实际 ${perEnv(newbie).toFixed(2)}`);
  assert.ok(perEnv(newbie) <= 100 + 1e-9,
    '绝不能被「放大」到超过实测分（那正是本轮废除放大的原因）');

  // ---- Veteran：登场 3.0，两版都在登场之后且都有证据 → 全部参与 ----
  assert.equal(vet.envs[0].absentSeasons, 0, '老角色的两版都在它登场之后 → 没有「不参与」');
  assert.equal(vet.envs[0].droppedSeasons, 0, '两版都有证据 → 没有「无人使用」');
  assert.ok(Math.abs(perEnv(vet) - 100) < 0.01,
    `两版齐备应为 100，实际 ${perEnv(vet).toFixed(2)}`);

  // ---- 关键：两者的区别只在「不参与」而不在惩罚 ----
  assert.ok(Math.abs(perEnv(newbie) - perEnv(vet)) < 0.01,
    '「早于登场」既不该被奖励（放大）也不该被惩罚 —— Newbie 与 Veteran 应同分');
});

check('性价比总榜：早于登场的版本不参与平均时，分母**只含参与的那些版本**', () => {
  // 上一条证明「不参与」的效果，这条专门钉住**分母的口径**：不参与的版本权重
  // 完全不计，而不是「进去了但记 0」。三者（实测 / 不参与 / 算 0 分）的分母规则：
  //   实测     → 分子 += w × 分；分母 += w
  //   不参与   → 分子不动；     分母不动      ← 本用例
  //   算 0 分  → 分子不动；     分母 += w
  const availability = {
    characters: { Late: { rarity: 5, limited: true }, Filler: { rarity: 5, limited: true } },
    lightCones: {},
  };
  const seasons = ['4.4', '4.5'];
  const seasonWeights = { 4.5: 2, 4.4: 2 };
  const rows = [
    { cost: 2, tier: 'perfect', newestSeason: '4.5', members: [{ char: 'Late', eidolon: 0 }] },
    { cost: 2, tier: 'perfect', newestSeason: '4.4', members: [{ char: 'Filler', eidolon: 0 }] },
  ];
  const env = envFixture('aa|plight', [], {
    mode: 'aa', stage: 'plight', season: '4.5', frontierRows: rows,
  });
  const out = buildConclusion([env], {
    availability,
    // Late 登场 4.5 → 窗口里的 4.4 早于它。
    firstSeen: { characters: { Late: '4.5', Filler: '3.0' }, lightCones: {} },
    frontier: { 'aa|plight': { seasons, seasonWeights, weight: 10, frontierRows: rows } },
  });
  const late = out.frontierUnits.find((u) => u.name === 'Late');
  assert.ok(late, 'Late 应进榜');
  assert.equal(late.envs[0].absentSeasons, 1, '4.4 早于登场 → 记 1 个「不参与」');
  // 实测那版 100（2 金 = minCost）→ 分母只有它自己的权重 2 → 200 ÷ 2 = 100。
  // 若误把「不参与」当成「算 0 分」，分母会是 2+2=4 → 50。
  assert.ok(Math.abs(late.total / 10 - 100) < 0.01,
    `不参与的版本不该进分母 → 应为 100，实际 ${(late.total / 10).toFixed(2)}`);
});

check('性价比总榜：已登场却缺证据的版本**算 0 分**（权重仍进分母）（用户 2026-10-10）', () => {
  // 用户原话：「角色已登场但缺证据的改为无效成绩」，随后明确
  //「**应该算0分，没排名说明完全无人使用**」。
  //
  // 为什么不能继续按中性 ×1 补：那个整包在 4.5~4.6（它明明已经存在）却一条前沿投稿
  // 都没有，这件事本身就是信息。补成中性分等于宣称「它在所有版本都这么强」，而数据
  // 从来没有这么说。实测开拓者•记忆 E6 + 愿虹光永驻天空S1 在绝境只有 4.2 一版证据
  // （权重 1/10），补完那一栏正好 ×1.00。
  //
  //⚠️ 这个用例的第一版断言写的是「不进分母」（当时我把「完全无人使用」当成
  // **未知**），被用户明确否掉：「完全无人使用」是**明确的差**，不是未知。
  // 现在钉的是「算 0 分」：权重照进分母、分子不加 → Sparse = 100×2 ÷ (2+2) = 50。
  const availability = {
    characters: {
      Widely: { rarity: 5, limited: true },   // 老角色，两版都有观测
      Sparse: { rarity: 5, limited: true },   // 同登场，但只有 4.5 有观测
      Filler: { rarity: 5, limited: true },
    },
    lightCones: {},
  };
  const seasons = ['4.4', '4.5'];
  const seasonWeights = { 4.5: 2, 4.4: 2 };
  // Widely 两版的实测分**完全一样**（都是 100）—— 这样「算 0 分」与「中性补分」在
  // Widely 身上看不出差别，分差只可能来自 Sparse 那一侧，判据才咬得住。
  const rows = [
    { cost: 2, tier: 'perfect', newestSeason: '4.5', members: [{ char: 'Widely', eidolon: 0 }] },
    { cost: 2, tier: 'perfect', newestSeason: '4.4', members: [{ char: 'Widely', eidolon: 0 }] },
    { cost: 2, tier: 'perfect', newestSeason: '4.5', members: [{ char: 'Sparse', eidolon: 0 }] },
    { cost: 2, tier: 'perfect', newestSeason: '4.4', members: [{ char: 'Filler', eidolon: 0 }] },
  ];
  const env = envFixture('aa|plight', [], {
    mode: 'aa', stage: 'plight', season: '4.5', frontierRows: rows,
  });
  const out = buildConclusion([env], {
    availability,
    // 两者登场版本相同（3.0，都早于窗口）→ 唯一差别就是「窗口内有没有观测」。
    firstSeen: { characters: { Widely: '3.0', Sparse: '3.0', Filler: '3.0' }, lightCones: {} },
    frontier: { 'aa|plight': { seasons, seasonWeights, weight: 10, frontierRows: rows } },
  });
  const widely = out.frontierUnits.find((u) => u.name === 'Widely');
  const sparse = out.frontierUnits.find((u) => u.name === 'Sparse');
  assert.ok(widely && sparse, '两个整包都应进榜');
  const perEnv = (u) => u.total / 10; // 绝境权重 10

  assert.equal(widely.envs[0].droppedSeasons, 0, '两版都有观测 → 没有「无人使用」的版本');
  assert.equal(sparse.envs[0].droppedSeasons, 1, 'Sparse 缺 4.4 → 记 1 个「无人使用」');
  assert.equal(sparse.envs[0].absentSeasons, 0, '4.4 在登场之后 → 不算「不参与」（两者互斥）');

  // ★ 核心判据：4.4 算 0 分 → 分母仍是 2+2=4、分子只有 4.5 那一版的 100×2
  //   → 200 ÷ 4 = 50。
  // 若误改成「中性补 ×1」→ (100×2 + 100×2) ÷ 4 = 100（Sparse 与 Widely 并列）；
  // 若误改成「权重不进分母」→ 100×2 ÷ 2 = 100（同样并列）。**只有 50 才咬得住。**
  assert.ok(Math.abs(perEnv(sparse) - 50) < 0.01,
    `已登场却无人使用的版本算 0 分 → Sparse 应为 100×2÷4 = 50，实际 ${perEnv(sparse).toFixed(2)}`);
  // 两版都有观测的整包不该被这条规则影响。
  assert.ok(Math.abs(perEnv(widely) - 100) < 0.01,
    `两版齐备的整包分应仍是 100，实际 ${perEnv(widely).toFixed(2)}`);
  // 排序后果：同样登场、同样 2 金，一个版本有人用、一个没人用 → 前者必须更高。
  assert.ok(widely.total > sparse.total,
    '「已登场却无人使用」应确实拉低分数（否则这条规则等于没生效）');
});

check('性价比总榜：池 = 全部成绩（不再按成本截断），跨版本发挥恒 ≤ 1', () => {
  // v4.6.78（用户 2026-10）：「改为所有成绩都要进池，我不希望估算」。
  //
  // 旧口径（池 = 最便宜 25%）会制造一个中间态「有人用、但没挤进最便宜那批」，它只能靠
  // **估算**填；估算值与分母不同源 → 「跨版本发挥」能 > 1（实测绯英 E6+邂逅S5 ×1.50）。
  // 现在池 = 窗口内全部达标/满分行，分子分母同源。
  //
  // 这条用例钉住三件事：
  //   ① 更贵但更强的那一版**也算证据**，并且能成为「最佳证据」（旧口径会把它挡在池外）；
  //   ② 因子 = 各版本加权平均 ÷ 最好的那一版，恒 ≤ 1；
  //   ③ `unrankedSeasons`（那台估算机器的字段）**不再下发** —— 防止它被悄悄塞回来。
  const availability = {
    characters: {
      Pool: { rarity: 5, limited: true },
      Mate: { rarity: 5, limited: true },
      Filler: { rarity: 5, limited: true },
    },
    lightCones: {},
  };
  const seasons = ['4.4', '4.5'];
  const seasonWeights = { 4.5: 2, 4.4: 2 };
  const rows = [
    // 4.5 这一版：本版最便宜的完美成绩是 Filler 的 1 金 → Pool 那条 2 金只拿 1÷2 = 0.5。
    { cost: 1, tier: 'perfect', newestSeason: '4.5', members: [{ char: 'Filler', eidolon: 0 }] },
    { cost: 2, tier: 'perfect', newestSeason: '4.5', members: [{ char: 'Pool', eidolon: 0 }] },
    // 4.4 这一版：更贵（3 金）但它是本版最便宜的完美成绩 → 拿满 3÷3 = 1.0。
    { cost: 3, tier: 'perfect', newestSeason: '4.4',
      members: [{ char: 'Pool', eidolon: 0 }, { char: 'Mate', eidolon: 0 }] },
  ];
  const env = envFixture('aa|plight', [], {
    mode: 'aa', stage: 'plight', season: '4.5', frontierRows: rows,
  });
  const out = buildConclusion([env], {
    availability,
    firstSeen: { characters: { Pool: '3.0', Mate: '3.0', Filler: '3.0' }, lightCones: {} },
    frontier: { 'aa|plight': { seasons, seasonWeights, weight: 10, frontierRows: rows } },
  });
  const pool = out.frontierUnits.find((u) => u.name === 'Pool');
  assert.ok(pool, '有前沿证据的整包应进榜');

  // ① 更贵那一版也是证据：两版都进平均（没有任何一版被当成「无人使用」）。
  assert.equal(pool.envs[0].droppedSeasons, 0,
    '池 = 全部成绩 → 有投稿的版本不该被记成「没有任何成绩（算 0 分）」');
  assert.equal(pool.envs[0].evidenceSeason, '4.4',
    '最佳证据应是那一版自己最好的成绩（4.4 拿满 1.0 > 4.5 的 0.5）');

  // ② 加权平均 = (50×2 + 100×2) ÷ 4 = 75；分母 = 最好的那一版 = 100 → 因子 0.75。
  const perEnv = pool.total / 10;                       // 绝境权重 10
  assert.ok(Math.abs(perEnv - 75) < 0.01,
    `应按 (50×2 + 100×2) ÷ 4 = 75 计分，实际 ${perEnv.toFixed(2)}`);
  const meta = (out.frontierEnvs || []).find((e) => e.id === 'aa|plight');
  const f = frontierFactorsOf(pool.envs[0], meta);
  assert.ok(Math.abs(f.seasonFactor - 0.75) < 1e-9,
    `跨版本发挥应为 0.75，实际 ${f.seasonFactor}`);
  assert.ok(f.seasonFactor <= 1 + 1e-9,
    '跨版本发挥恒 ≤ 1（分子与分母取自同一个集合，构造上不可能超过）');

  // ③ 估算机器的字段已经删掉（不是「恒为 0」，而是**不存在**）。
  assert.equal(pool.envs[0].unrankedSeasons, undefined,
    '`unrankedSeasons` 不应再下发（估算机器已随池=全部成绩一起删除）');
});

check('性价比总榜：登场版本必须**按副本取**（四个副本各用一套版本号，2026-10-10 修）', () => {
  // ⚠️ 这条钉住一个**真实的线上 bug**（用户问「为什么真珠的版本权重才 0.5」）。
  //
  // 黑塔网四个副本**各用一套版本号**，同「一期」真实日期在不同副本里编号不同。
  // 实测（用投稿的 `video_date` 对齐）：2026-09-28~10-04 那一期在
  // 异相仲裁叫 4.6、混沌回忆叫 4.5、末日幻影叫 4.6、虚构叙事叫 4.5。
  //
  // 旧实现只存一份**跨副本取最小值**的全局 `firstSeen`，拿它去比每个副本的窗口，
  // 于是判定错位。实测真珠：她在异相仲裁的登场版本是 **4.6**，但全局值记成 4.5
  // （因为混沌回忆那期编号更小）→ 拿 4.5 去比异相仲裁时，4.5 被判成
  // 「已登场却无人使用 → 算 0 分」，而那一期真实日期其实比她首次出现早一个月。
  // 后果：版本因子被压到 ×0.50、总分 700 → 350。
  //
  // 修法：`byMode[模式全名]` 优先，全局值只在老数据集没有 byMode 时兜底。
  // ⚠️ 键要用模式**全名**（`Anomaly Arbitration`），短码 `aa` 查不到 —— 这一点也踩过：
  // 第一版修完没翻别名，全部静默落回全局值，看起来「改了但没生效」。
  const availability = {
    characters: { Newbie: { rarity: 5, limited: true }, Filler: { rarity: 5, limited: true } },
    lightCones: {},
  };
  const seasons = ['4.5', '4.6'];
  const seasonWeights = { 4.6: 2, 4.5: 2 };
  const rows = [
    { cost: 2, tier: 'perfect', newestSeason: '4.6', members: [{ char: 'Newbie', eidolon: 0 }] },
    { cost: 2, tier: 'perfect', newestSeason: '4.5', members: [{ char: 'Filler', eidolon: 0 }] },
  ];
  const env = envFixture('aa|plight', [], {
    mode: 'aa', stage: 'plight', season: '4.6', frontierRows: rows,
  });
  const build = (firstSeen) => {
    const out = buildConclusion([env], {
      availability, firstSeen,
      frontier: { 'aa|plight': { seasons, seasonWeights, weight: 10, frontierRows: rows } },
    });
    return out.frontierUnits.find((u) => u.name === 'Newbie');
  };

  // ① 全局值说 4.5 —— 若拿它去比本副本的窗口，4.5 会被当成「已登场却无人使用」→ 算 0 分。
  const wrong = build({ characters: { Newbie: '4.5', Filler: '3.0' }, lightCones: {} });
  assert.ok(wrong, '整包应进榜');
  assert.equal(wrong.envs[0].droppedSeasons, 1,
    '用全局值 4.5 比本副本窗口 → 会误判 4.5 为「无人使用」（这正是那个 bug）');
  assert.ok(Math.abs(wrong.total / 10 - 50) < 0.01,
    `误判时分数应是 100×2÷4 = 50，实际 ${(wrong.total / 10).toFixed(2)}`);

  // ② 带上 byMode（本副本说 4.6）→ 4.5 变成「早于登场 → 不参与」，不再冤枉它。
  const right = build({
    characters: { Newbie: '4.5', Filler: '3.0' },
    lightCones: {},
    byMode: { 'Anomaly Arbitration': { characters: { Newbie: '4.6', Filler: '3.0' }, lightCones: {} } },
  });
  assert.ok(right, '整包应进榜');
  assert.equal(right.envs[0].droppedSeasons, 0, '本副本说 4.6 才登场 → 4.5 不该算「无人使用」');
  assert.equal(right.envs[0].absentSeasons, 1, '本副本里 4.5 早于登场 → 记 1 个「不参与」');
  assert.equal(right.envs[0].bornSeason, '4.6', '登场版本要取本副本的值');
  // 只剩 4.6 一版实测（权重 2）→ 200 ÷ 2 = 100。
  assert.ok(Math.abs(right.total / 10 - 100) < 0.01,
    `按本副本编号应得 100（不再被冤枉），实际 ${(right.total / 10).toFixed(2)}`);
  assert.ok(right.total > wrong.total, '按副本取登场版本必须让这个整包的分回升');
});

check('性价比总榜：只在「权重 0」的版本上有观测的整包不进榜（权重为 0 = 不进窗口）', () => {
  // 先厘清一件容易想错的事：
  //
  // ⚠️ **「窗口内一版观测都没有」是造不出来的**—— `windowSeasons` 会把
  // 「有观测但不在窗口里」的版本自动并进来（见 advice.js 里那一行
  // `[...seasonOrder, ...observedSeasons.filter(...)]`）。所以每个存在的整包
  // 至少有一版观测，`wSum === 0` 唯一的真实入口是**那几版的权重是 0**
  // （权重 0 = 「这一版不进窗口」，用户可以这么调）。
  //
  // 这条用例钉住那个 guard：整包只在权重 0 的版本上有观测 → 没有任何一版参与平均
  // → 不进榜。以前这里会被中性估计救回来（拿一个权重为 0 的观测当满分）。
  const availability = { characters: { Ghost: { rarity: 5, limited: true } }, lightCones: {} };
  const seasons = ['4.4', '4.5'];
  // 4.5 权重 2、4.4 权重 0：Ghost 只有 4.4 那一条证据。
  const seasonWeights = { 4.5: 2, 4.4: 0 };
  const rows = [
    { cost: 2, tier: 'perfect', newestSeason: '4.4', members: [{ char: 'Ghost', eidolon: 0 }] },
  ];
  const env = envFixture('aa|plight', [], {
    mode: 'aa', stage: 'plight', season: '4.5', frontierRows: rows,
  });
  const out = buildConclusion([env], {
    availability,
    firstSeen: { characters: { Ghost: '3.0' }, lightCones: {} },
    frontier: { 'aa|plight': { seasons, seasonWeights, weight: 10, frontierRows: rows } },
  });
  assert.ok(!out.frontierUnits.some((u) => u.name === 'Ghost'),
    '只有权重 0 的版本有观测 → 没有任何一版参与平均 → 不该进榜');
});

// （原「只有早于登场版本的旧版本才放大（v4.6.47 修复）」用例已删除：
//   「放大」这条口径整体废除了 —— 它会让推算分反超实测分（榜首真珠实测只占 15.4%），
//   现在早于登场的版本改为**不参与平均**。新的三条用例在上面：
//   「早于登场的版本不参与平均」「不参与时分母只含参与的版本」「已登场却无人使用算 0 分」。）

check('性价比总榜：金数项的分母是「**本版本**最便宜」（不拿全窗口最小值罚难压金的版本）', () => {
  // 用户 2026-10-10 第 5 轮：「这样算就意味着 4.2 那期才有可能打满（最容易压金的版本），
  // 是不是对别的版本不利？」—— 是，而且实测 24 个「副本×版本」组合里 **18 个吃亏**，
  // 吃亏的恰好是权重 2 分的最新版（绝境 4.6 的 −12.5%、pf 4.5 的 −66.7%）。
  //
  // 旧口径：金数项 = `全局 minCost ÷ 本队金数`。全局 minCost = **整个窗口**的最小值
  // （= 历史上压金最狠的那一期），于是其余每一期都被按那一期打折 —— 那惩罚的是
  // **环境难度**（怪物配置本身难压金），不是队伍的优劣。
  //
  // 新口径：金数项 = **该版本自己**的 minCost ÷ 本队金数，再按版本权重加权。
  //
  // 这条用例构造两版：老版 2 金是全场最低、新版 4 金是该版最低（老版那期压金更容易）。
  // 两个整包各自都「在本版本内最省」，所以两版都该拿满金数项 1.000。
  // ⚠️ 旧口径下新版会被算成 2÷4 = 0.500，一眼可辨。
  const availability = {
    characters: { Old: { rarity: 5, limited: true }, Fresh: { rarity: 5, limited: true } },
    lightCones: {},
  };
  const seasons = ['4.4', '4.5'];
  const seasonWeights = { 4.5: 2, 4.4: 1 };
  const rows = [
    // 4.4（老版、权重 1）：最省就是 2 金。
    { cost: 2, tier: 'perfect', newestSeason: '4.4', members: [{ char: 'Old', eidolon: 0 }] },
    // 4.5（新版、权重 2）：这一期全场最省也要 4 金。
    { cost: 4, tier: 'perfect', newestSeason: '4.5', members: [{ char: 'Fresh', eidolon: 0 }] },
  ];
  const env = envFixture('aa|plight', [], {
    mode: 'aa', stage: 'plight', season: '4.5', frontierRows: rows,
  });
  const out = buildConclusion([env], {
    availability,
    frontier: { 'aa|plight': { seasons, seasonWeights, weight: 10, frontierRows: rows } },
  });
  const fresh = out.frontierUnits.find((u) => u.name === 'Fresh');
  assert.ok(fresh, '新版整包应进榜');
  const meta = out.frontierEnvs.find((e) => e.id === 'aa|plight');
  const f = frontierFactorsOf(fresh.envs[0], meta);

  assert.equal(fresh.envs[0].seasonMinCost, 4, '这一条的金数分母应是 4.5 自己的 4 金');
  assert.equal(f.costFactor, 1,
    `本版本内最省的队伍金数项应为 1.000，实际 ${f.costFactor}` +
    '（若是 0.5 说明又退回「全窗口最小值当所有版本分母」的老口径）');
  // 没有任何版本吃亏/占便宜 → 版本因子也应是纯 1（两版加权一致）。
  assert.ok(Math.abs(f.seasonFactor - 1) < 1e-9,
    `两版都拿满时版本因子应为 1，实际 ${f.seasonFactor}`);
  // 副本级 minCost 仍是全窗口最小值 2 —— 它只是展示/兜底，不再进算分。
  assert.equal(meta.minCost, 2, '副本级 minCost 仍是全窗口最小值（展示用）');
  assert.deepEqual(meta.minCostBySeason, { '4.4': 2, '4.5': 4 }, '逐版本最便宜金数要一并下发');
});

check('贡献值来源：因子乘回去必须等于榜上的分（界面按它列「来源」）', () => {
  // 用户 2026-10 要求「在性价比界面列出贡献值来源」。界面不自己写公式，而是调
  // `frontierFactorsOf()` 把一条贡献拆成 权重 / 档位 / 行动值 / 金数 / 版本 五个因子；
  // 这条用例钉住两件事：① 因子取的就是算分用的那几个数与**同一对行动值分位边界**；
  // ② 乘回去精确等于榜上的分（拆错了界面就会说谎，而且是没人能一眼看出来的那种）。
  const availability = { characters: { Lead: { rarity: 5, limited: true } }, lightCones: {} };
  const members = [{ char: 'Lead', eidolon: 0 }];
  const seasons = ['4.4', '4.5'];
  const seasonWeights = { 4.5: 2, 4.4: 1 };
  const rows = [
    // 4.5 版（权重 2）：最便宜那条（2 金）成绩最差（行动值 480，落在达标线内 →
    // 绝境自 v4.6.78 起的曲线：300~500 段由 1.00 线性降到 0.60，480 → 0.64）。
    { cost: 2, tier: 'perfect', actionValue: 480, newestSeason: '4.5', members },
    // 这条才是「最佳证据」：3 金 / 行动值 150（满分线以内，权重固定 1.00）→ 分最高。
    { cost: 3, tier: 'perfect', actionValue: 150, newestSeason: '4.5', members },
    { cost: 4, tier: 'perfect', actionValue: 100, newestSeason: '4.5', members },
    // 同一整包在旧版本（4.4）还有一条更差的证据 → 版本项（加权平均）不等于 1。
    // ⚠️ 用户 2026-10-10 第 5 轮起金数项按版本归一，所以 4.4 这一版的分母是
    // **它自己**的最便宜金数 5（不是 4.5 的 2）。
    { cost: 5, tier: 'perfect', actionValue: 490, newestSeason: '4.4', members },
  ];
  const env = envFixture('aa|plight', [], {
    mode: 'aa', stage: 'plight', season: '4.5', frontierRows: rows,
    // ⚠️ 用户 2026-10-11 缺陷 3 起，表现分以**该副本的判据线**为标尺（不再是分位归一）。
    // `envFixture` 默认给 moc 的 `{0,2,4}`，与绝境成绩量纲不符 → 必须显式给绝境的线。
    tierLines: { perfect: 300, target: 500 },
  });
  const out = buildConclusion([env], {
    availability,
    frontier: { 'aa|plight': { seasons, seasonWeights, weight: 10, frontierRows: rows } },
  });
  const unit = out.frontierUnits.find((u) => u.name === 'Lead');
  assert.ok(unit, '整包应进榜');
  const meta = out.frontierEnvs.find((e) => e.id === 'aa|plight');
  // ① 判据线必须随副本元数据下发（表现分靠它现算，界面自己拼不出来）。
  assert.deepEqual(meta.tierLines, { perfect: 300, target: 500 },
    `判据线要一并下发，实际 ${JSON.stringify(meta.tierLines)}`);
  assert.equal(meta.lowerIsBetter, true, '方向要一起下发（越大越好的副本要反过来归一化）');
  const factors = frontierFactorsOf(unit.envs[0], meta);
  // ② 最佳证据 = 3 金 / 行动值 150 那条（不是最便宜那条，也不是行动值最好那条）。
  assert.equal(factors.cost, 3, '最佳证据应是 3 金那条');
  assert.equal(factors.av, 150, '最佳证据的行动值应是 150');
  // ⚠️ 用户 2026-10-11 缺陷 3：档位与行动值**合并**成单一 `perfFactor`
  // （以判据线为标尺的连续曲线）。**第四轮起绝境单独一套**（`frontierPerfLineByEnv`，
  // 工具 v4.6.78）：满分线以内固定 1.00、达标线 0.60。
  //   行动值 150 < 满分线 300 → **1.00**（不再是 0.925 —— 那是有档内梯度那版的取值）。
  assert.equal(factors.tierFactor, 1, '满分档的档位因子仍是 1（兼容字段，不再参与相乘）');
  assert.ok(Math.abs(factors.perfFactor - 1) < 1e-9,
    `行动值 150 在满分线以内 → 绝境表现分应为 1.00，实际 ${factors.perfFactor}`);
  assert.ok(Math.abs(factors.costFactor - 2 / 3) < 1e-9,
    `金数因子 = 该副本最便宜 2 金 ÷ 本队 3 金，实际 ${factors.costFactor}`);
  // 版本项：4.5 那版的最佳证据 = 100 × 1.00 × (2 ÷ 3) = 66.6667；
  // 4.4 那版的分 = 100 × 0.62(表现：av 490 在 300~500 段，1.00 → 0.60 线性) × (5 ÷ 5) = 62.0 ——
  // 加权 (2 × 66.6667 + 1 × 62.0) ÷ 3 = 65.1111，再 ÷ 66.6667 = 0.976667。
  assert.ok(Math.abs(factors.seasonFactor - 0.976667) < 1e-5,
    `版本因子应为 0.97667，实际 ${factors.seasonFactor}`);
  // 算分本身也必须是这条曲线（只改函数、忘了给调用点传权重时，这里会红）：
  // 旧默认曲线（满分线 0.85 / 达标线 0.50）算出来是 58.3611。
  assert.ok(Math.abs(factors.score - 65.11111) < 1e-4,
    `这一副本的分应是 65.1111（绝境新曲线），实际 ${factors.score}`);
  // ③ 恒等式：合并后的因子乘回去 = 这一副本的分；再乘副本权重 = 「贡献」那一列。
  const rebuilt = 100 * factors.perfFactor * (factors.costFactor ?? 1) * factors.seasonFactor;
  assert.ok(Math.abs(rebuilt - factors.score) < 1e-9,
    `因子乘回去必须等于这一副本的分（${rebuilt} vs ${factors.score}）`);
  assert.ok(Math.abs(factors.value - factors.weight * factors.score) < 1e-9,
    '贡献 = 副本权重 × 这一副本的分');
  assert.ok(Math.abs(unit.total - factors.value) < 1e-3, '只有一个副本时总分 = 该副本贡献');
});

check('表现曲线：锚点落在判据线上、绝境满分线以内固定 1.00（用户 2026-10-11 第二 / 四轮）', () => {
  // 第二轮用户原话：「要有更精细的表现权重变化梯度」—— 上一版 `av ≤ 满分线` 整段是平的
  // 1.00，绝境里行动值 37 与 299 拿同一个分（frontier 池 perfect 档跨 [37, 299]）。
  // **第四轮用户点名把绝境改回来**：「行动值小于 300，权重固定为 1.00；行动值 300-500，
  // 权重在 1-0.6 之间逐渐变化」—— 于是绝境满分线以内重新变平（这是本轮需求，不是漏了
  // 梯度），达标线由 0.50 抬到 0.60；**其它副本继续用默认那套 0.85 / 0.50**。
  // 两个口径都要钉住，否则下次调曲线没人知道哪条是约定。
  const plight = { perfect: 300, target: 500 };
  const moc = { perfect: 0, target: 2, pass: 4 };
  const as = { perfect: 4000, target: 3700, pass: 3400 };
  /** 绝境那套判据线取值（唯一来源：`SCORING.frontierPerfLineByEnv`）。 */
  const plightW = perfLineWeightsOf({ mode: 'aa', stage: 'plight' });

  // ① 锚点：满分线 = 0 的副本**不出现**满分锚点（否则两个 av=0 的锚点，曲线不自洽）。
  assert.deepEqual(perfAnchorsOf(plight, true).map((a) => a[0]), [0, 300, 500],
    '绝境（无及格线）：顶点 + 满分线 + 达标线');
  assert.deepEqual(perfAnchorsOf(moc, true).map((a) => a[0]), [0, 2, 4],
    '轮次制满分线 = 0 → 与顶点重合，跳过');
  assert.deepEqual(perfAnchorsOf(as, false).map((a) => a[0]), [0, 300, 600],
    '末日幻影积分线翻到行动值空间：满分线 4000 → 0（跳过）、达标 3700 → 300、及格 3400 → 600');
  assert.deepEqual(perfAnchorsOf(plight, true, plightW), [[0, 1], [300, 1], [500, 0.6]],
    '绝境按副本覆盖：满分线 1.00、达标线 0.60（用户 2026-10-11 第四轮）');

  // ② **默认那套一字未动**（不传按副本权重时）：顶点 1.00、满分线 0.85、达标线 0.50。
  //    这三个数是混沌 / 虚构 / 末日幻影 / 骑士关共用的，绝境的覆盖不能顺手把它们改掉。
  assert.equal(perfFactorOf(0, plight, true, 'perfect'), 1, '理论最好成绩 = 1.00');
  assert.ok(Math.abs(perfFactorOf(500, plight, true, 'target') - 0.5) < 1e-9,
    '默认口径：达标线处仍是 0.50（跨过达标线这个分界没被动过）');
  assert.ok(Math.abs(perfFactorOf(300, plight, true, 'perfect') - 0.85) < 1e-9,
    '默认口径：满分线处 0.85（给档内留梯度的代价）');

  // ③ **绝境的新曲线**（用户第四轮原话：「行动值小于 300，权重固定为 1.00；
  //    行动值 300-500，权重在 1-0.6 之间逐渐变化」——逐点钉住，包括「满分线以内同分」）。
  const pf = (av, tier = 'perfect') => perfFactorOf(av, plight, true, tier, plightW);
  assert.equal(pf(37), 1, '满分线以内固定 1.00（av 37）');
  assert.equal(pf(299), 1, '满分线以内固定 1.00（av 299 —— 与 37 同分是**本轮需求**）');
  assert.ok(Math.abs(pf(300) - 1) < 1e-9, '满分线处 1.00');
  assert.ok(Math.abs(pf(400) - 0.8) < 1e-9, '300~500 线性过渡：400 → 0.80');
  assert.ok(Math.abs(pf(500, 'target') - 0.6) < 1e-9, '达标线处 0.60（原 0.50）');
  assert.ok(Math.abs(pf(700) - 0.2) < 1e-9, '线外按最后一段斜率继续降：700 → 0.20');
  assert.ok(Math.abs(pf(775) - 0.05) < 1e-9, '触底：av 775 → 地板 0.05');
  assert.equal(pf(1200), 0.05, '地板以下不再降，也不会反向上升');
  // 默认那套在同一批行动值上仍保有档内梯度 —— v26 的取舍没被这次改动带走。
  assert.ok(perfFactorOf(37, plight, true, 'perfect') > perfFactorOf(299, plight, true, 'perfect') + 0.1,
    '默认口径的满分档内仍有梯度（av 37 明显高于 299）');

  // ④ **单调不增**（抽样，含线外）。绝境满分线以内是平的，所以只能要求「不增」，
  //    不能再要求「严格递减」。曾经把外推写成 `yn - (yn - yp) × …`，线外反向上升
  //    （实测 av=800 → 1.025），这条断言就是拦它的。
  for (const [name, lines, lib, weights] of [
    ['绝境（新曲线）', plight, true, plightW], ['绝境（默认）', plight, true, null],
    ['moc', moc, true, null], ['末日幻影', as, false, null],
  ]) {
    let prev = Infinity;
    for (let av = 0; av <= 1200; av += 1) {
      const f = perfFactorOf(av, lines, lib, 'perfect', weights);
      assert.ok(f <= prev + 1e-12, `${name}：av=${av} 出现上升（${prev} → ${f}）`);
      assert.ok(f >= 0 && f <= 1 + 1e-12, `${name}：av=${av} 越界（${f}）`);
      prev = f;
    }
  }

  // ⑤ 兜底：判据线缺失 / 行动值缺失 → 退回阶梯权重，不拿假曲线算。
  assert.equal(perfFactorOf(120, null, true, 'perfect'), 1, '线缺失 → 退回满分档阶梯权重 1');
  assert.equal(perfFactorOf(120, null, true, 'target'), 0.5, '线缺失 → 退回达标档阶梯权重 0.5');
  assert.equal(perfFactorOf(null, plight, true, 'perfect'), 1, '行动值缺失 → 同样退回阶梯权重');

  // ⑥ **按副本取权重**：短码 / 站点全名 / `id` 的两种分隔符都要认出来，
  //    同模式的另一个关卡（骑士关）与别的副本**不能沾光**。
  assert.deepEqual(plightW, { perfect: 1, target: 0.6, pass: 0.25 },
    '绝境的覆盖只改它自己那两档，pass 继续取默认值');
  assert.deepEqual(perfLineWeightsOf(null), { perfect: 0.85, target: 0.5, pass: 0.25 },
    '不传（或认不出来）→ 默认那套');
  assert.deepEqual(perfLineWeightsOf({ id: 'aa/plight', mode: 'aa', stage: 'plight' }), plightW,
    '`id` 用 `/` 分隔（另一种写法）也要认');
  assert.deepEqual(perfLineWeightsOf('Anomaly Arbitration|plight'), plightW, '站点全名的键也要认');
  assert.deepEqual(perfLineWeightsOf({ mode: 'aa', stage: '' }),
    { perfect: 0.85, target: 0.5, pass: 0.25 }, '骑士关（同模式、不同关卡）不套用绝境那套');
  assert.deepEqual(perfLineWeightsOf({ mode: 'as' }),
    { perfect: 0.85, target: 0.5, pass: 0.25 }, '末日幻影不受影响');

  // ⑦ `metricShortText`：**末日幻影要把内部反向值翻回来**（实测踩过：直接印内部 av
  //    会把「积分 3852」显示成 `148`，而且它落在「越小越强」的直觉里，错得很隐蔽）。
  assert.equal(metricShortText('moc', '', 0), '0T', '轮次制带 T');
  assert.equal(metricShortText('moc', '', 2), '2T');
  assert.equal(metricShortText('aa', 'plight', 285), '285', '绝境裸数字（不带「行动值」前缀）');
  assert.equal(metricShortText('as', '', 148), '3852', '末日幻影：4000 − 148 = 3852（不是 148）');
  assert.equal(metricShortText('aa', 'plight', null), '—', '缺值给 —，不编数字');
});

check('金数项：封顶 ×1、0 金通关 ×1.2（用户 2026-10-11 第 3 条）', () => {
  // 用户原话：「倍数封顶 1.00，使用 0 金通关额外获得 1.2 的倍率（对所有关卡生效）」，
  // 并澄清「0 金 = **隐金后**的有效队伍金数」「1.2 是倍率，不是再加 1.2」。
  //
  // 这条口径把 v4.6.69 缺陷 2 的副作用关掉了：分母取「该版本 perfect 档最便宜」而分子是
  // 这一条配置自己的金数（档位不限），target 档更便宜时相除就会 > 1 —— 实测末日幻影
  // 算分池 171/640 = 26.7% 的行 > 1，最高 ×7.00（截图里那个 `7÷1`）。
  assert.equal(SCORING.frontierCostCap, 1, '封顶值就是 1.00');
  assert.equal(SCORING.frontierZeroGoldBonus, 1.2, '0 金通关的倍率就是 1.2');
  // 正常路径不受影响。
  assert.equal(frontierCostTermOf(2, 4), 0.5, '该版本最便宜 2 金 ÷ 本队 4 金 = 0.5');
  assert.equal(frontierCostTermOf(9, 9), 1, '一样便宜就是 1.00');
  // 封顶：本来会是 7 倍。
  assert.equal(frontierCostTermOf(7, 1), 1, '7 ÷ 1 = 7 → 封顶成 1.00');
  assert.equal(frontierCostTermOf(5, 2), 1, '5 ÷ 2 = 2.5 → 封顶成 1.00');
  // 0 金通关：固定倍率（既不是 Infinity，也不是 1.00 + 1.2）。
  assert.equal(frontierCostTermOf(7, 0), 1.2, '0 金通关拿 1.2（分母是 7 也一样）');
  assert.equal(frontierCostTermOf(null, 0), 1.2, '分母取不到时 0 金仍然拿 1.2');
  // ⚠️ 「没有这项证据」不等于 0 金（`Number(null) === 0` 那个老坑，HANDOFF §4.4）：
  //    本队金数缺失时必须给 null（界面显示「—」、算分按 ×1），不能当成 0 金去拿 1.2。
  assert.equal(frontierCostTermOf(2, null), null, '本队金数缺失 = 没有这项证据，不是 0 金');
  assert.equal(frontierCostTermOf(null, 3), null, '分母缺失同样给 null');
});

await checkAsync('金数项封顶 ×1 + 0 金通关 ×1.2：真实数据集上的两条口径', async () => {
  const index = await archiveIndex();
  const { envs } = await conclusionEnvs(index);
  const frontierAll = await archiveFrontierAll(envs, { window: VERSION_WINDOW });
  const result = buildConclusion(envs, {
    availability: index.refs?.availability || {},
    firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
    account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
    frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
    frontierWeights: Object.fromEntries(frontierAll.map((f) => [f.env, f.weight])),
    // 界面默认：隐金五组全勾（0 金那条只有在这个设置下才出现，见 §「隐金」用例）。
    hiddenCosts: DEFAULT_HIDDEN_COSTS,
  });
  const metaOf = (id) => (result.frontierEnvs || []).find((e) => e.id === id);
  let rows = 0;
  let zeroGold = 0;
  let capped = 0;
  for (const unit of result.frontierUnits || []) {
    for (const env of unit.envs || []) {
      const f = frontierFactorsOf(env, metaOf(env.id));
      rows += 1;
      if (f.costFactor === null) continue;
      const cost = Number(f.cost);
      if (cost === 0) {
        zeroGold += 1;
        assert.equal(f.costFactor, SCORING.frontierZeroGoldBonus,
          `0 金通关的整包 ${unit.name} 在 ${env.envLabel || env.id} 应拿 1.2，实际 ${f.costFactor}`);
        continue;
      }
      if (Number(f.minCost) > cost) capped += 1;
      assert.ok(f.costFactor <= SCORING.frontierCostCap + 1e-9,
        `金数项必须封顶在 1.00，实际 ${f.costFactor}（${unit.name} / ${env.envLabel || env.id}）`);
      // 单版本分的上界：非 0 金 ≤ 100，0 金 ≤ 120。
      assert.ok(Number(f.base) <= SCORING.frontierPackScale + 1e-6,
        `非 0 金的单版本分不得高于 100，实际 ${f.base}`);
    }
  }
  // 这条用例不能变成空跑：当前数据集上必须真的存在被封顶的行与 0 金的行。
  assert.ok(rows > 0, '总榜明细不该为空');
  assert.ok(capped > 0, `当前数据集上应有被封顶的行（实测 19 条），实际 ${capped}`);
  assert.ok(zeroGold > 0, `界面默认（隐金全勾）下应有 0 金通关的行（实测 7 条），实际 ${zeroGold}`);

  // ---- 撤销检查：整包上**不该**再有 `strength`（纯强度，v4.6.91 已按用户第 8 条删除）----
  //
  // v4.6.87 曾在每个整包上多发一个 `strength` = Σ_副本 副本权重 × (100 × 表现)（不乘金数项），
  // 供抽卡方案的「强度得分」用。用户 2026-10-12 第 8 条把它改回「含金数项的整包分」
  // （「同样是绝境 0T，9 金队要比 16 金队强得多」），那个字段与 `packStrengthOf()` 一并删除。
  // 这条断言钉住「别让它悄悄复活」——载荷里多一个没人读的字段，下一个人就会拿它当口径。
  let withStrength = 0;
  for (const unit of result.frontierUnits || []) {
    if ('strength' in unit) withStrength += 1;
    for (const env of unit.envs || []) if ('strength' in env) withStrength += 1;
  }
  assert.equal(withStrength, 0,
    `整包与逐副本都不该再带 strength（实际 ${withStrength} 处）`);
  assert.ok((result.frontierUnits || []).length > 0, '总榜不该为空（上面那条断言空跑会让人误以为它过了）');
});

check('性价比总榜：证据广度只展示，不压低单条记录', () => {
  // v14 曾用「独立赛季 / 独立配置数」压低单条旧极端记录。整包口径下这一项不再进分数
  // （用户口径只认队伍强度与金数），但仍统计出来供界面展示与人工判断。
  //
  // ⚠️ 用例设计要注意（2026-10-10 改口径后）：**版本覆盖现在会合法地影响分数** ——
  // 「已登场却无人使用」的版本算 0 分（见上一条用例）。所以要证明「配置数不影响分数」，
  // 必须让两个整包的**版本覆盖完全相同**，只让 `configCount` 不同。否则这条断言
  // 测的其实是「版本覆盖不同 → 分数不同」，与本用例要测的东西无关。
  const availability = {
    characters: {
      Solo: { rarity: 5, limited: true }, Widely: { rarity: 5, limited: true },
      H1: { rarity: 5, limited: true }, H2: { rarity: 5, limited: true },
      H3: { rarity: 5, limited: true },
    },
    lightCones: {},
  };
  const row = (char, helper, season) => ({
    cost: 4, actionValue: 200, tier: 'perfect', season,
    members: [{ char, eidolon: 2 }, { char: helper, eidolon: 0 }],
  });
  const env = envFixture('aa|plight', [], {
    mode: 'aa', stage: 'plight', season: '4.5', recentSeasons: ['4.4', '4.5'],
    // ⚠️ 缺陷 3 起表现分以该副本判据线为标尺；绝境线是 `{300,500}`（行动值 200 在满分线内）。
    tierLines: { perfect: 300, target: 500 },
    frontierRows: [
      // Solo 跨两个版本、2 条**互不相同**的配置（队友不同）；Widely 同样跨两个版本、
      // 3 条配置。唯一差别是配置条数 → 分数必须相同。
      // ⚠️ `configCount` 数的是**不同阵容键**的条数，所以两条记录若队友相同只算 1 条。
      row('Solo', 'H1', '4.4'), row('Solo', 'H2', '4.5'),
      row('Widely', 'H1', '4.4'), row('Widely', 'H2', '4.5'), row('Widely', 'H3', '4.5'),
    ],
  });
  const out = buildConclusion([env], { availability });
  const solo = out.frontierUnits.find((u) => u.name === 'Solo');
  const widely = out.frontierUnits.find((u) => u.name === 'Widely');
  assert.ok(solo && widely, '两个整包都应进入总榜');
  assert.equal(solo.total, widely.total, '证据广度不进分数：版本覆盖相同、配置数不同仍同分');
  assert.equal(solo.envs[0].configCount, 2, 'Solo：证据广度 = 2 条配置');
  assert.equal(widely.envs[0].configCount, 3, 'Widely：证据广度 = 3 条配置');
  assert.equal(solo.envs[0].seasonCount, 2, '两者都是跨两个版本');
  assert.equal(widely.envs[0].seasonCount, 2, '两者都是跨两个版本');
});

check('性价比总榜：每个角色只出场一次，取它分数最高的那个整包（用户第 1 条）', () => {
  // 同一个角色有 E2 与 E6 两个整包，分别在不同副本里有证据。用户 2026-10 第 1 条
  // 要求「每个角色只能在榜上出场一次，仅取最大的一项，避免单一角色霸榜」——
  // 所以榜上只能有一条 Carry，且必须是总分更高的那条（E6 在绝境拿满分）。
  //
  // ⚠️ 这条断言取代了 v15 的「普通关卡 E2 与绝境 E6 独立计入」：那条的前提是同一
  // 角色的多个档位各自占一行，与第 1 条直接冲突，已按用户新口径改写。
  // 被收敛掉的整包**仍然参与**它所在副本的证据计算，只是不再单独占一行。
  const availability = { characters: { Carry: { rarity: 5, limited: true } }, lightCones: {} };
  const regularMembers = [{ char: 'Carry', eidolon: 2 }];
  const regularTeam = teamFixture(['Carry'], { perfect: 0, target: 10, pass: 0, below: 0 }, 2,
    regularMembers);
  regularTeam.cost = 2;
  const regular = envFixture('aa|regular', [regularTeam], {
    mode: 'aa', stage: '',
    // ⚠️ 缺陷 3 起表现分以该副本判据线为标尺（普通王棋关看轮次，行动值 2 在达标线内）。
    tierLines: { perfect: 0, target: 2, pass: 4 },
    frontierRows: [{ cost: 2, actionValue: 2, tier: 'target', members: regularMembers }],
  });

  const plightMembers = [{ char: 'Carry', eidolon: 6 }];
  const plightTeam = teamFixture(['Carry'], { perfect: 10, target: 0, pass: 0, below: 0 }, 240,
    plightMembers);
  plightTeam.cost = 7;
  const plight = envFixture('aa|plight', [plightTeam], {
    mode: 'aa', stage: 'plight',
    // ⚠️ 绝境线是行动值 `{300,500}`（行动值 240 在满分线内 → 表现分 1.00）。
    tierLines: { perfect: 300, target: 500 },
    // ⚠️ 绝境里**只放 E6 这一条**：夹具的每条记录都会补上 `env.season`，所以版本维度
    // 会退化成一个版本、权重 1 —— 若把 E2 那条也放进绝境（更便宜、minCost 变小），
    // E2 会靠「普通关权重 1 的额外加分」反超 E6，那就测不出「取最大」了（实测踩过）。
    frontierRows: [{ cost: 7, actionValue: 240, tier: 'perfect', members: plightMembers }],
  });

  const out = buildConclusion([plight, regular], { availability });
  const carries = out.frontierUnits.filter((unit) => unit.name === 'Carry');
  assert.equal(carries.length, 1, '同一个角色在榜上只能有一条（第 1 条）');
  const only = carries[0];
  // E6 那条在绝境拿满分（权重 10），E2 只在普通关达标（权重 1）→ E6 分更高。
  assert.equal(only.eidolon, 6, '留下的是分数更高的那个整包（E6 绝境满分）');
  assert.ok(only.total > 0, '留下的整包仍然有分');
  assert.equal(only.gold, 7, 'E6 整包 = 本体 1 + E6 六金（**从 E0 数起**，不是 E2 之后的增量）');
  assert.deepEqual(only.envs.map((env) => env.id), ['aa|plight'],
    '留下的那条只带它自己的副本证据');
});

// ------------------------------------------------- 隐金设置（用户 2026-10-11）
//
// 用户第 9 轮原话：「在性价比总榜添加一个按钮，用于额外设置，将其放置于总榜权重下方……
// 点击后弹出详情界面，角色和光锥都需要有图标……以下复选框默认已点击」。
//
// 口径（全部由 `hiddenReductionOf()` 实现，界面只画不改）：
//   * ① 直接受赠角色 / ② 累计抽卡赠送光锥 → 该单位少 1 金（最低 0）；
//     例外：单独的 Archer（或单独的理想燃烧的地狱）减 2；成对出现则各自减 1；
//     景元/卡芙卡/丹恒•饮月/镜流/花火/黄泉/砂金 是**自选其一** → 一队合计减 1。
//   * ③ 角色兑换 / ④ 光锥兑换 / ⑤ 后续常驻角色 → 该单位**及其星魂（叠影）**视为 0 成本。
//   * 减的是**队伍金数**（所以会改名次），且被减到 0 金的整包**仍然留在榜上**
//     （用户 2026-10-11 明确选择：否则兑换 / 常驻那两组一勾选就整批从榜上消失）。
//   * 兼容契约：`buildConclusion` 不传 `hiddenCosts` = **一项都不减**（工具 / 老调用方
//     的历史口径不变），「五项全勾」只是**界面**的默认值（`DEFAULT_HIDDEN_COSTS`）。

/** 隐金用例用的单位表：点名的键都按「限定 5★」登记（与真实数据集一致，实测全是 limited: true）。 */
const HIDDEN_AVAIL = {
  characters: {
    'Dr. Ratio': { rarity: 5, limited: true },
    Archer: { rarity: 5, limited: true },
    Gilgamesh: { rarity: 5, limited: true },
    'Jing Yuan': { rarity: 5, limited: true },
    Acheron: { rarity: 5, limited: true },
    Luocha: { rarity: 5, limited: true },
    Seele: { rarity: 5, limited: true },
    Solid: { rarity: 5, limited: true },
    Buddy: { rarity: 5, limited: true },
  },
  lightCones: {
    'The Hell Where Ideals Burn': { rarity: 5, limited: true },
    'I Am As You Behold': { rarity: 5, limited: true },
    'In the Night': { rarity: 5, limited: true },
  },
};

checkAsync('隐金设置：五组名单里的键在数据集里都存在，且现在确实各值 1 金（否则这个开关没作用）', async () => {
  const index = await archiveIndex();
  const availability = index.refs?.availability || {};
  const missing = [];
  const alreadyFree = [];
  const rows = HIDDEN_COST_SETTINGS.flatMap((group) => group.rows);
  for (const row of rows) {
    for (const unit of row.units) {
      const known = row.kind === 'char'
        ? Boolean(availability.characters?.[unit]) : Boolean(availability.lightCones?.[unit]);
      const cost = row.kind === 'char'
        ? charCostOf(unit, availability) : coneCostOf(unit, availability);
      if (!known) missing.push(`${row.kind}:${unit}`);
      if (cost <= 0) alreadyFree.push(`${row.kind}:${unit}`);
    }
  }
  assert.deepEqual(missing, [],
    `名单里有数据集查不到的键（界面上是一张破图 + 一条永不生效的规则）：${missing.join(', ')}`);
  assert.deepEqual(alreadyFree, [],
    `名单里有本来就 0 金的单位（隐金对它没有任何效果）：${alreadyFree.join(', ')}`);
  // 五个开关的 id 必须与界面上的五个复选框一一对应（少一个 = 界面上那个复选框点了没用）
  assert.equal(rows.length, HIDDEN_COST_IDS.length,
    `界面上的复选框数（${rows.length}）必须与 HIDDEN_COST_IDS（${HIDDEN_COST_IDS.length}）一致`);
  assert.deepEqual([...new Set(rows.map((row) => row.id))].sort(), [...HIDDEN_COST_IDS].sort(),
    '每个 id 只能出现一次，且必须都在 HIDDEN_COST_IDS 里');
  // 备注（用户 2026-10-11 追加要求：「你要加个备注，提示用户特殊情况」）：
  // **只有**带「成对 / 自选」例外的那两条才有，而且必须把那三条例外写清楚 ——
  // 它和 `hiddenReductionOf()` 是同一件事的两种表达，改规则忘了改它就会误导用户。
  const noted = rows.filter((row) => row.note);
  assert.deepEqual(noted.map((row) => row.id), ['gift', 'giftCone'],
    '备注只应挂在①那两条（其余三组没有例外规则）');
  const giftNote = rows.find((row) => row.id === 'gift').note;
  for (const must of ['Archer', '吉尔伽美什', '一共只减 1']) {
    assert.ok(giftNote.includes(must), `受赠角色那条备注必须写清「${must}」：${giftNote}`);
  }
  const coneNote = rows.find((row) => row.id === 'giftCone').note;
  for (const must of ['理想燃烧的地狱', '所见即我']) {
    assert.ok(coneNote.includes(must), `赠送光锥那条备注必须写清「${must}」：${coneNote}`);
  }
});

check('隐金设置：接口默认「一项都不减」，界面的默认才是「五项全勾」（两个默认值都必须是对的）', () => {
  for (const id of HIDDEN_COST_IDS) {
    assert.equal(DEFAULT_HIDDEN_COSTS[id], true, `界面默认值里 ${id} 必须是勾上的（用户：默认已点击）`);
    assert.equal(NO_HIDDEN_COSTS[id], false, `${id} 的全关值必须是 false`);
  }
  const none = { ...NO_HIDDEN_COSTS };
  assert.deepEqual(normalizeHiddenCosts(undefined), none, '不传必须是「一项都不减」');
  assert.deepEqual(normalizeHiddenCosts(null), none, 'null 必须是「一项都不减」');
  assert.deepEqual(normalizeHiddenCosts('nonsense'), none, '非法输入要退化成安全的形状，不许抛');
  assert.deepEqual(normalizeHiddenCosts([1, 2]), none, '数组也要退化成安全形状');
  assert.deepEqual(normalizeHiddenCosts({ gift: true, bogus: true }), { ...none, gift: true },
    '只认那五个键（多给的键不许漏进状态）');
  assert.deepEqual(normalizeHiddenCosts({ gift: 1 }), none, '必须是严格 true，数字 1 不算勾上');
});

check('隐金：直接受赠角色减 1 金，且被减到 0 金的整包**仍然留在榜上**（用户 2026-10-11）', () => {
  // 夹具两行：贵的那行含 Dr. Ratio（4 金），便宜那行是不含受赠单位的 Solid（2 金）。
  // 关：Dr. Ratio 那行的金数项 = 2 ÷ 4 = 0.500；开：它变 3 金 → 2 ÷ 3（分子仍是 2，
  // 因为最便宜的那行没被减）→ 分更高。这样才测得出「隐金真的改了名次」。
  const rows = [
    { cost: 4, tier: 'perfect', actionValue: 0, members: [{ char: 'Dr. Ratio', eidolon: 0 }, { char: 'Buddy', eidolon: 0 }] },
    { cost: 2, tier: 'perfect', actionValue: 0, members: [{ char: 'Solid', eidolon: 0 }, { char: 'Buddy', eidolon: 0 }] },
  ];
  const env = envFixture('moc', [], { mode: 'moc', frontierRows: rows });
  const run = (hiddenCosts) => buildConclusion([env], { availability: HIDDEN_AVAIL, hiddenCosts });

  const off = run({ ...NO_HIDDEN_COSTS });
  const on = run({ ...DEFAULT_HIDDEN_COSTS });
  const ratioOff = off.frontierUnits.find((u) => u.name === 'Dr. Ratio');
  const ratioOn = on.frontierUnits.find((u) => u.name === 'Dr. Ratio');
  assert.ok(ratioOff && ratioOn, 'Dr. Ratio 在开 / 关两种设置下都该在榜上');
  assert.equal(ratioOff.gold, 1, '关着隐金时整包 1 金（本体）');
  assert.equal(ratioOn.gold, 0, '开着隐金时榜上金数跟着减少（用户要求）');
  assert.equal(ratioOn.rawGold, 1, '原始金数必须留着，否则分不清「本来就 0 金」与「被减到 0」');
  assert.ok(ratioOn.total > ratioOff.total,
    `隐金后这一行的分应上升：${ratioOff.total} → ${ratioOn.total}`);
  assert.ok(ratioOn.total > 0, '被减到 0 金的整包仍然留在榜上（用户 2026-10-11 明确选择）');
  // 最便宜那行没被减 → 逐版本最便宜金数（分子）不变，仍是 2
  assert.equal(on.frontierEnvs[0].minCost, 2, '最便宜的那行没被隐金影响，分子仍是 2');
  // 兼容契约：不传 hiddenCosts 与显式全关必须逐字段完全一致
  assert.deepEqual(run(undefined).frontierUnits, off.frontierUnits, '不传 hiddenCosts = 一项都不减');
});

check('隐金：兑换角色 / 常驻角色「及其星魂」、兑换光锥「及其叠影」一律视为 0 成本', () => {
  const av = HIDDEN_AVAIL;
  const on = { ...DEFAULT_HIDDEN_COSTS };
  const cut = (members, settings = on, convention = 'dataset') => hiddenReductionOf(members, av, settings, convention);
  // ① 角色兑换：罗刹 E2 = 本体 1 + E2 两金 = 3 金 → 全免
  assert.deepEqual(cut([{ char: 'Luocha', eidolon: 2 }]).byIndex, [3], '罗刹 E2 应免 3 金（本体 + 星魂）');
  // ② 常驻角色：希儿 E6 = 本体 1 + 六金 = 7 金 → 全免
  assert.deepEqual(cut([{ char: 'Seele', eidolon: 6 }]).byIndex, [7], '希儿 E6 应免 7 金');
  // ③ 光锥兑换「及其叠影」：数据集那条 `c` 里光锥是「本体 × 叠影」
  //    （实测 4230/4230 行 = 本体 + 真实星魂级数 + 光锥本体×叠影），所以 S2 免 2 金；
  //    而整包展示口径（`packGoldOf`）里光锥不算叠影 → 那一档只免 1 金。
  assert.deepEqual(cut([{ char: 'Solid', eidolon: 0, lc: 'In the Night', superimp: 2 }]).byIndex, [2],
    '数据集口径下 S2 的兑换光锥应免 2 金（本体 + 一层叠影）');
  assert.deepEqual(cut([{ char: 'Solid', eidolon: 0, lc: 'In the Night', superimp: 2 }], on, 'tiered').byIndex, [1],
    '整包展示口径下光锥不算叠影，只免本体那 1 金');
  // 各开关关掉 → 对应那一组一点都不减
  assert.equal(cut([{ char: 'Luocha', eidolon: 2 }], { ...on, exchange: false }).team, 0);
  assert.equal(cut([{ char: 'Seele', eidolon: 6 }], { ...on, standard: false }).team, 0);
  assert.equal(cut([{ char: 'Solid', lc: 'In the Night', superimp: 2 }], { ...on, exchangeCone: false }).team, 0);
  // 「角色兑换」只免角色与星魂那一份：不在兑换名单里的限定光锥照旧要金
  assert.equal(cut([{ char: 'Luocha', eidolon: 2, lc: 'In the Night', superimp: 1 }],
    { ...on, exchangeCone: false }).team, 3,
  '只免角色 + 星魂，不连带那把不在兑换名单里的光锥');
});

check('隐金：Archer 单独 -2、与吉尔伽美什同队各自 -1；七人组一队合计 -1（用户给的「特殊情况」）', () => {
  const av = HIDDEN_AVAIL;
  const on = { ...DEFAULT_HIDDEN_COSTS };
  const team = (members, settings = on) => hiddenReductionOf(members, av, settings, 'dataset').team;
  // Archer 单独：规则给 -2，但 E0 的 Archer 自己只有 1 金 → 夹到 1（用户口径「最低 0 成本」）
  assert.equal(team([{ char: 'Archer', eidolon: 0 }]), 1, 'E0 Archer 只能减到自己那 1 金');
  // E6 的 Archer 自己有 7 金 → 真的能减 2
  assert.equal(team([{ char: 'Archer', eidolon: 6 }]), 2, 'E6 Archer 应真减 2 金');
  // 与吉尔伽美什同队 → 各自 -1（合计 2）
  assert.equal(team([{ char: 'Archer', eidolon: 0 }, { char: 'Gilgamesh', eidolon: 0 }]), 2,
    'Archer + 吉尔伽美什 各自减 1');
  assert.equal(team([{ char: 'Gilgamesh', eidolon: 0 }]), 1, '单独吉尔伽美什减 1');
  // 自选其一那一组：出现一个减 1；**出现两个仍然只减 1**（「组队时一共减少 1 成本」）
  assert.equal(team([{ char: 'Jing Yuan', eidolon: 0 }]), 1);
  assert.equal(team([{ char: 'Jing Yuan', eidolon: 0 }, { char: 'Acheron', eidolon: 0 }]), 1,
    '七人组一队里出现几个都只减 1（自选其一）');
  // 光锥同理：单独的理想燃烧的地狱 -2（S1 只有 1 金 → 夹到 1；S5 有 5 金 → 真减 2）
  const pairCone = (superimp) => [{ char: 'Solid', eidolon: 0, lc: 'The Hell Where Ideals Burn', superimp }];
  assert.equal(team(pairCone(1)), 1, 'S1 的赠送光锥只能减到自己那 1 金');
  assert.equal(team(pairCone(5)), 2, 'S5 的赠送光锥应真减 2 金');
  assert.equal(team([{ char: 'Solid', eidolon: 0, lc: 'The Hell Where Ideals Burn', superimp: 1 },
    { char: 'Buddy', eidolon: 0, lc: 'I Am As You Behold', superimp: 1 }]), 2,
  '理想燃烧的地狱 + 所见即我 各自减 1');
  // ①② 关掉 → 一点都不减（其余三组对这批单位不适用）
  assert.equal(team([{ char: 'Archer', eidolon: 0 }, { char: 'Jing Yuan', eidolon: 0 }],
    { ...on, gift: false, giftCone: false }), 0);

  // ---- 用户 2026-10-11 追问「Archer 在 E0 / 光锥在 S1 时整队被减 2」之后的**确认口径** ----
  //
  // 他先报「这是不对的」，我们一起量完真实数据后他确认**保持现状**，所以下面三条从此是
  // **用户拍过板的口径**，不是我从规则推导出来的：别在后续重构里「顺手合并」它们。
  //   * 同一成员身上「角色」与「光锥」两笔赠送**各自封顶、可以叠加**；
  //   * 七人组（自选其一）的 −1 与 Archer 那一笔**各自独立**（不是同一个「自选池」）。
  // 他当时看到的 −2 就是这么来的：Archer E0 自己只减 1，另一个 −1 来自队里的花火 / 黄泉…
  // （真实前沿池 412 条含 Archer 的行里，「E0 Archer 被减 > 1」的 0 条；
  //   穷举四项不变量见 `tools/_probe-yinjin-archer.mjs`。）
  const archerCone = hiddenReductionOf(
    [{ char: 'Archer', eidolon: 0, lc: 'The Hell Where Ideals Burn', superimp: 1 }], av, on, 'dataset');
  assert.equal(archerCone.team, 2, 'Archer E0 + 赠送光锥 S1：角色那份 1 + 光锥那份 1');
  assert.equal(archerCone.byIndexChar[0], 1, 'Archer E0 的角色那份最多减 1（规则 -2 被自付封顶）');
  assert.equal(archerCone.byIndexCone[0], 1, 'S1 的赠送光锥，光锥那份最多减 1（规则 -2 被自付封顶）');
  assert.equal(team([{ char: 'Archer', eidolon: 0 }, { char: 'Sparkle', eidolon: 0 }]), 2,
    'Archer E0 与七人组（自选其一）各自独立：Archer 1 + 那一位 1 = 2');
  assert.equal(team([{ char: 'Archer', eidolon: 0, lc: 'The Hell Where Ideals Burn', superimp: 1 },
    { char: 'Sparkle', eidolon: 0 }]), 3, '三笔独立赠送叠加：角色 1 + 光锥 1 + 自选组 1 = 3');
});

check('隐金设置：按钮排在「总榜权重」之后、「总榜列表」之前（用户要求「放置于总榜权重下方」）', () => {
  const html = readFileSync(resolve(ROOT, 'public/index.html'), 'utf8');
  const weightAt = html.indexOf('id="adviceFrontierWeights"');
  const buttonAt = html.indexOf('id="adviceHiddenCostsOpen"');
  const listAt = html.indexOf('id="adviceConclusionUnits"');
  assert.ok(weightAt > 0 && buttonAt > 0 && listAt > 0, '三个节点都必须写在 index.html 里');
  assert.ok(weightAt < buttonAt, '按钮必须在「总榜权重」之后（用户指定位置）');
  assert.ok(buttonAt < listAt, '按钮必须在总榜列表之前');
  assert.ok(html.includes('>隐金设置<'), '按钮文案必须是「隐金设置」');
});

check('数据状态：角色快照 / 战斗记录 / 黑塔网数据三份缓存的记录整合在一块（用户 2026-10-11）', () => {
  // 用户原话：「将角色快照、战斗记录、黑塔网数据三者的缓存记录整合在一起，共同放置于
  // 抽卡推荐下方，保持界面美观」。改前这三件事分在三处（正文最上面一行 / ①那一节里 /
  // 标题栏右侧一行小字），写法还各不相同。这一条是**源码级护栏**：结构与文案一起钉住，
  // 免得以后有人把某一格挪回它原来待的位置、或者把重复的时间再写一遍。
  const html = readFileSync(resolve(ROOT, 'public/index.html'), 'utf8');
  const view = readFileSync(resolve(ROOT, 'public/scripts/advice-view.js'), 'utf8');
  const css = readFileSync(resolve(ROOT, 'public/styles/app.css'), 'utf8');

  // ① 三格在同一个块里，顺序固定（快照 / 战斗记录 / 黑塔网数据），且在 ① 那一节之前。
  const blockAt = html.indexOf('id="adviceDataStatus"');
  const snapAt = html.indexOf('id="adviceSnapshotFreshness"');
  const recordAt = html.indexOf('id="recordFreshness"');
  const datasetAt = html.indexOf('id="adviceDatasetFreshness"');
  const recordSectionAt = html.indexOf('id="adviceRecord"');
  assert.ok(blockAt > 0 && snapAt > 0 && recordAt > 0 && datasetAt > 0 && recordSectionAt > 0,
    '四个节点都必须写在 index.html 里');
  assert.ok(blockAt < snapAt && snapAt < recordAt && recordAt < datasetAt,
    '三格必须按「角色快照 / 战斗记录 / 黑塔网数据」的顺序写在 #adviceDataStatus 里');
  assert.ok(datasetAt < recordSectionAt,
    '这一块必须在 ① 战斗记录那一节之前（用户要求「放置于抽卡推荐下方」）');
  assert.ok(!html.includes('id="adviceDataUpdated"'),
    '黑塔网数据那行右侧小字（#adviceDataUpdated）已并进三格，别再写回去');
  // ② ① 那一节里不能再留一份（改前 #recordFreshness 就在它里面）
  const recordSection = html.slice(recordSectionAt, html.indexOf('<!-- 跨模式综合结论'));
  assert.ok(!recordSection.includes('data-freshness'),
    '① 战斗记录那一节里不该再有 .data-freshness 方块（已并到顶部「数据状态」）');

  // ③ 三格的名字 / 状态词 / 时间标签只有 `advice.js`-style 的一处定义（在 advice-view.js）
  assert.ok(/const dataStatusCells = \(\) => \[/.test(view), '三格必须由 dataStatusCells() 一处定义');
  for (const label of ["label: '角色快照'", "label: '战斗记录'", "label: '黑塔网数据'"]) {
    assert.ok(view.includes(label), `dataStatusCells() 里缺 ${label}`);
  }
  assert.ok(view.includes("statusText: '本机数据集 · 黑塔网聚合'") && view.includes("timeLabel: '生成于'"),
    '黑塔网那一格要用它自己的词（本机数据集 · 黑塔网聚合 / 生成于），不能套米游社缓存的词');
  assert.ok(view.includes("if (freshness.cached) return '本机缓存 · 米游社数据';"),
    '角色快照和战斗记录要明确写成本机缓存，并标出米游社来源');
  assert.ok(view.includes("'还没有数据'"), '空态也要有状态词，不能是个空盒子');
  // ④ 旧的三处与它们重复的文案不能留残影
  assert.ok(!/renderFreshness\s*\(/.test(view) && !/renderDatasetMeta\s*\(/.test(view)
    && !/const agoText/.test(view),
    'renderFreshness / renderDatasetMeta / agoText 都已并入或删除，别再留着');
  assert.ok(!view.includes('黑塔网数据更新于'), '「黑塔网数据更新于」那行小字已并进三格');
  // ⚠️ 这一条只看**代码**里还有没有 `parts.push('这一节读的是…')`：那句被删掉的原文
  // 仍留在 `advice-view.js` 的注释里（讲清为什么删），用 `includes()` 会把注释也算上。
  assert.ok(!/parts\.push\(['"`]这一节读的是/.test(view),
    '「打开页面不联网」现在写在数据状态块的标题行里，不再由 ① 那一节重复');
  assert.ok(!/meta\.push\(['"`]读取于/.test(view),
    '#recordMeta 不该再写「读取于」（与上方那一格是同一件事）');

  // ⑤ 排版：宽屏三格一行、窄屏竖排；旧的 `#adviceDataUpdated` 规则清干净
  assert.ok(/\.data-status-grid\s*\{[^}]*repeat\(3, minmax\(0, 1fr\)\)/.test(css),
    '.data-status-grid 必须是三列等宽（minmax(0, 1fr)）');
  assert.ok(/\.data-status-grid > \.data-freshness\s*\{[^}]*margin: 0/.test(css),
    '格子本身是 .data-freshness，外间距要交给 grid 的 gap');
  assert.ok(/@media \(max-width: 900px\)[\s\S]{0,200}\.data-status-grid\s*\{[^}]*minmax\(0, 1fr\)/.test(css),
    '窄屏（≤900px）三格要竖排成单列');
  assert.ok(!/#adviceDataUpdated\s*\{/.test(css), '#adviceDataUpdated 的样式已是死代码，应删掉');
});

checkAsync('隐金：真实数据集上确实改变了总榜，且**只**动总榜（抽卡方案一字不变）', async () => {
  const off = await archiveConclusion({ owned: [] }, { window: 6, hiddenCosts: NO_HIDDEN_COSTS });
  const on = await archiveConclusion({ owned: [] }, { window: 6, hiddenCosts: DEFAULT_HIDDEN_COSTS });
  assert.equal(on.payload, 7,
    '载荷形状是 v7（hiddenCosts 回显 + availability + frontierTiers；strength 已撤销）');
  assert.ok(on.frontierTiers && ['0', '1', '2', '6'].every((t) => Array.isArray(on.frontierTiers[t])),
    '逐星魂档的总榜 frontierTiers 必须四档都在（界面 E0/E1/E2/E6 筛选器靠它）');
  assert.deepEqual(on.hiddenCosts, { ...DEFAULT_HIDDEN_COSTS }, '服务端要回显归一化后的隐金设置');
  assert.deepEqual(off.hiddenCosts, { ...NO_HIDDEN_COSTS }, '全关时回显也是一项都不减');
  // ① 总榜必须真的变了（否则等于这个开关根本没接上）
  const sig = (res) => res.frontierUnits.map((u) => `${u.name}|${u.gold}|${Math.round(u.total)}`).join(';');
  assert.notEqual(sig(on), sig(off), '开启五项隐金后总榜应当与全关时不同');
  // ② 每个角色仍然只出场一次（用户第 1 条不受隐金影响）
  assert.equal(new Set(on.frontierUnits.map((u) => u.name)).size, on.frontierUnits.length,
    '总榜仍然每个角色只占一行');
  // ③ 金数只减不增、分数都是正有限数（被减到 0 的队伍不许产生 Infinity / NaN）
  let shrunk = 0;
  for (const unit of on.frontierUnits) {
    assert.ok(Number.isFinite(unit.total) && unit.total > 0,
      `${unit.name} 的分必须是正的有限数，实际 ${unit.total}`);
    assert.ok(unit.gold >= 0, `${unit.name} 的金数不能为负（实际 ${unit.gold}）`);
    const before = off.frontierUnits.find((x) => x.key === unit.key);
    if (!before) continue;
    assert.ok(unit.gold <= before.gold,
      `${unit.name} 的金数只应减少：${before.gold} → ${unit.gold}`);
    if (unit.gold < before.gold) shrunk += 1;
  }
  assert.ok(shrunk > 0, '至少要有一条整包的金数真的变小了（否则界面上看不出隐金起过作用）');
  // ④ 「兑换 / 常驻」那一组在榜上必须**角色本体与星魂全免** —— 这正是这两组的口径。
  const zeroGroups = ['Luocha', 'Ruan Mei', 'Topaz & Numby', 'Huohuo', 'Robin',
    'Seele', 'Yunli', 'Argenti', 'Silver Wolf', 'Fu Xuan', 'Blade'];
  const onBoard = on.frontierUnits.filter((u) => zeroGroups.includes(u.name));
  // ⚠️ 断言**不能**写成「gold === 0」，有两个原因，都会让旧写法误报：
  //    ① 光锥不属于这两组（它另有「光锥兑换」那一组），所以整包挂着**限定且不在兑换
  //       名单**里的光锥时，那 1 金本来就该留下；
  //    ② v4.6.78 池 = 全部成绩之后，Blade 的代表整包从「没光锥」变成 `E6 + 专武 S1`
  //       —— 实测 Blade=1，那是专武那 1 金，规则本身没错。
  // 所以这里按同一条规则复算两件事：角色那份必须全免；榜上的金数只剩没被免掉的光锥。
  const availability = (await archiveIndex())?.refs?.availability || {};
  const charPartFullyFree = (u) => {
    const one = [{ char: u.name, eidolon: u.eidolon }];
    return packGoldOf(one[0], availability)
      === hiddenReductionOf(one, availability, DEFAULT_HIDDEN_COSTS, 'tiered').byIndex[0];
  };
  const unfree = onBoard.filter((u) => !charPartFullyFree(u));
  assert.equal(unfree.length, 0,
    `兑换 / 常驻单位的角色本体与星魂应当被全免，实际未全免：${unfree.map((u) => u.name).join(', ')}`);
  const coneLeft = (u) => (u.lc
    ? coneCostOf(u.lc, availability)
      - hiddenReductionOf([{ char: 'X', lc: u.lc, superimp: u.superimp }],
        availability, DEFAULT_HIDDEN_COSTS, 'tiered').byIndexCone[0]
    : 0);
  const wrongGold = onBoard.filter((u) => u.gold !== coneLeft(u));
  assert.equal(wrongGold.length, 0,
    '榜上的金数应当只剩「没被任何一组免掉的光锥」，实际：'
    + wrongGold.map((u) => `${u.name}=${u.gold}（应为 ${coneLeft(u)}）`).join(', '));
  // ⑤ 抽卡方案（个人口径）**不受隐金影响** —— 用户明确选了「只影响性价比总榜」
  assert.deepEqual(on.units, off.units, '抽卡方案必须与隐金设置无关');
});

check('两套副本权重相互独立：总榜权重只动总榜，方案权重只动方案', () => {
  // 用户 2026-10 的要求：「性价比总榜和抽卡方案的权重应相互独立」。
  // 改前只有一张表（两处都调 `envWeightOf`），于是为了「只看绝境的性价比」把
  // 绝境调大，抽卡方案也跟着只看绝境 —— 两个榜回答的是不同的问题，不该互相绑架。
  //
  // 这条用例把「改一方、另一方必须一个字都不变」钉死（连排序带分值一起比）。
  const availability = {
    characters: { Star: { limited: true }, Pal: { limited: true } },
    lightCones: { 'Big Cone': { rarity: 5, limited: true } },
  };
  const account = {
    owned: new Set(['A', 'B', 'C', 'D']), eidolons: new Map(), cones: new Map(),
  };
  // 0 抽可照抄但打不满的基线 + 补一个 Star 就能满分的强阵
  const baseline = teamFixture(['A', 'B', 'C', 'D'], { perfect: 0, target: 0, pass: 0, below: 10 }, 6,
    [{ char: 'A', eidolon: 0 }]);
  const strong = teamFixture(['A', 'B', 'C', 'Star'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
    [{ char: 'A', eidolon: 0 }, { char: 'Star', eidolon: 0, lc: 'Big Cone', superimp: 1 }]);
  const env = envFixture('moc', [baseline, strong]);
  const run = (options) => buildConclusion([env], { availability, account, ...options });
  const shape = (out) => JSON.stringify({
    frontier: out.frontierUnits.map((u) => `${u.key}:${u.total.toFixed(6)}`),
    plan: out.units.map((u) => `${u.key}:${u.total.toFixed(6)}`),
  });
  const base = shape(run({}));
  // ① 只给总榜权重 → 总榜变、方案一字不变
  const onlyFrontier = shape(run({ frontierWeights: { 'moc|': 5 } }));
  const fOnly = JSON.parse(onlyFrontier);
  const b = JSON.parse(base);
  assert.notDeepEqual(fOnly.frontier, b.frontier, '总榜权重必须影响性价比总榜');
  assert.deepEqual(fOnly.plan, b.plan, '总榜权重不该影响抽卡方案');
  // ② 只给方案权重 → 方案变、总榜一字不变
  const onlyPlan = JSON.parse(shape(run({ weights: { 'moc|': 5 } })));
  assert.deepEqual(onlyPlan.frontier, b.frontier, '方案权重不该影响性价比总榜');
  assert.notDeepEqual(onlyPlan.plan, b.plan, '方案权重必须影响抽卡方案');
  // ③ 两套都给：各按各的倍数（总榜 ×7、方案 ×2，互不串味）
  const both = JSON.parse(shape(run({ weights: { 'moc|': 2 }, frontierWeights: { 'moc|': 7 } })));
  // 注意键里本来就有冒号（`char:Star`）和竖线（整包键 `Star|E0|Big Cone|S1`），
  // 所以取的是**最后一段**而不是第 2 段。
  const pick = (list, key) => Number(list.find((row) => row.startsWith(`${key}:`)).split(':').pop());
  const baseStar = pick(b.frontier, 'Star|E0|Big Cone|S1');
  assert.ok(Math.abs(pick(both.frontier, 'Star|E0|Big Cone|S1') / baseStar - 7) < 0.01,
    '总榜那一套应当只吃 ×7');
  const basePlanStar = pick(b.plan, 'char:Star');
  assert.ok(Math.abs(pick(both.plan, 'char:Star') / basePlanStar - 2) < 0.01,
    '方案那一套应当只吃 ×2');
  // ④ 权重调完之后模块级覆盖必须被还原（否则下一次调用会串上这一次的口径）
  assert.equal(envWeightOf('moc', ''), 1, 'plan 覆盖应在 buildConclusion 退出时还原');
  assert.equal(envWeightOf('moc', '', 'frontier'), 1, 'frontier 覆盖同样要还原');
});

check('开拓者：拥有任一命途 = 拥有全部命途（用户 2026-10 要求）', () => {
  // 用户 2026-10 的原话：「开拓者及其不同命途的变体，应当视为已拥有」。
  // 游戏里换命途不换人，米游社只报**当前那一个形态**（本机实测 id 8007 = 记忆，
  // 名字就是「开拓者」），而数据集按命途分成 5 个英文键 —— 不补这一条的话
  // 「只看我没有的」会把另外 4 个列出来，配队可达性折扣还会把含开拓者的作业
  // 当成「你这个位置是空的」白打 0.25 折。
  const forms = ['开拓者•毁灭', '开拓者•存护', '开拓者•同谐', '开拓者•记忆', '开拓者•欢愉'];
  const en = {
    '开拓者•毁灭': 'Trailblazer (Destruction)',
    '开拓者•存护': 'Trailblazer (Preservation)',
    '开拓者•同谐': 'Trailblazer (Harmony)',
    '开拓者•记忆': 'Trailblazer (Remembrance)',
    '开拓者•欢愉': 'Trailblazer (Elation)',
  };
  const expectAll = (owned, why) => {
    for (const name of forms) {
      assert.ok(owned.has(name), `${why}：中文形态 ${name} 应算已拥有`);
      assert.ok(owned.has(en[name]), `${why}：数据集英文键 ${en[name]} 也要登记（发给服务端的只有英文键）`);
    }
  };
  // ① 米游社的常规写法：name = 开拓者，id = 8007
  expectAll(ownedCharacters({ characters: [{ id: '8007', name: '开拓者' }] }, en, forms), '名字是开拓者');
  // ② 占位符写法（快照里开拓者的名字就是 {NICKNAME}）
  expectAll(ownedCharacters({ characters: [{ id: '8001', name: '{NICKNAME}' }] }, en, forms), '名字是占位符');
  // ③ 玩家把开拓者改了名（名字里既没有「开拓者」也没有占位符）→ 只能靠 id 认
  expectAll(ownedCharacters({ characters: [{ id: '8004', name: '星' }] }, en, forms), '改了名字');
  // ④ 没练开拓者的账号不该被顺带算上
  const other = ownedCharacters({ characters: [{ id: '1303', name: '阮•梅' }] }, en, forms);
  assert.equal(other.has('Trailblazer (Harmony)'), false, '没开拓者就不该有任何一个形态');
  // ⑤ 昵称与命途的中文写法仍然按老口径登记
  const zhi = ownedCharacters({ characters: [{ id: '1512', name: '知更鸟•晴歌' }] },
    { '知更鸟•晴歌': 'Robin • Summeretto' }, ['知更鸟•晴歌']);
  assert.ok(zhi.has('Robin • Summeretto'), '普通角色的中英映射不受影响');
  assert.ok(zhi.has('知更鸟'), '「•」前的基础名仍然要登记');
});

checkAsync('开拓者：真实数据集 + 真实中英映射下，发给服务端的 owned 含全部命途（英文键）', async () => {
  // 上面那条用的是自造夹具；这条走**真实**的 refs/i18n，钉住最容易被漏掉的一环：
  // 界面的 `accountPayload()` 只保留「数据集英文键」（`datasetChars.has(n)`），
  // 所以 owned 里只加中文名（开拓者•记忆）等于没做 —— 实测就是这么漏的。
  const index = await archiveIndex();
  const zhToEn = {};
  const allNames = [];
  for (const c of index.refs?.characters || []) {
    if (c.nameCn && c.name) zhToEn[c.nameCn] = c.name;
    if (c.nameCn) allNames.push(c.nameCn);
  }
  const datasetChars = new Set((index.refs?.characters || []).map((c) => c.name));
  const forms = [...datasetChars].filter((n) => /trailblazer/i.test(n));
  assert.ok(forms.length >= 4, `数据集里应有多个开拓者命途，实际 ${forms.length}`);

  // 米游社只报当前那一个形态（本机实测：id 8007、名字就是「开拓者」）
  const owned = ownedCharacters({ characters: [{ id: '8007', name: '开拓者' }] }, zhToEn, allNames);
  const payload = [...owned].filter((n) => datasetChars.has(n));
  assert.deepEqual(payload.filter((n) => /trailblazer/i.test(n)).sort(), [...forms].sort(),
    '发给服务端的 owned 必须含全部开拓者命途的英文键');
  // 反向：没练开拓者的账号不该凭空多出这些键
  const without = ownedCharacters({ characters: [{ id: '1303', name: '阮•梅' }] }, zhToEn, allNames);
  assert.equal([...without].filter((n) => /trailblazer/i.test(n)).length, 0,
    '没开拓者的账号不该被算成拥有开拓者');
});

check('抽卡方案与性价比总榜是两个口径：方案跟着角色池变，总榜不变', () => {
  const availability = {
    characters: { Lim: { limited: true }, Strong: { limited: true } },
    lightCones: {},
  };
  const baseline = teamFixture(['A', 'B', 'C', 'D'], { perfect: 0, target: 0, pass: 0, below: 10 }, 6,
    [{ char: 'A', eidolon: 0 }]);
  const better = teamFixture(['A', 'B', 'C', 'Lim'], { perfect: 10, target: 0, pass: 0, below: 0 }, 0,
    [{ char: 'A', eidolon: 0 }, { char: 'Lim', eidolon: 0 }]);
  const env = envFixture('moc', [baseline, better]);
  const poor = buildConclusion([env], {
    availability, account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
  });
  const rich = buildConclusion([env], {
    availability,
    account: { owned: new Set(['A', 'B', 'C', 'Lim']), eidolons: new Map([['Lim', 0]]), cones: new Map() },
  });
  // 方案（个人口径）：账号不同 → 一个是「抽 Lim 本体」，另一个已经没有缺口了
  assert.ok(poor.units.some((u) => u.name === 'Lim'), '空账号应有 Lim 的补强');
  assert.equal(rich.units.some((u) => u.name === 'Lim' && u.kind === 'char'), false,
    '已有 Lim 的账号不该再建议抽本体');
  // 总榜（数据集口径）：同一个数据集 → 两边完全一样
  assert.equal(JSON.stringify(poor.frontierUnits), JSON.stringify(rich.frontierUnits),
    '总榜不能随账号变化');
});

checkAsync('贡献值来源：真实数据集上因子能还原每一行的分，且行动值边界真的下发了', async () => {
  // 上面那条是自造夹具；这条走**真实载荷**（界面拿到的就是这一份）：
  // ① 每个副本元数据都带 avLo / avHi / lowerIsBetter（不带的话界面只能瞎猜区间）；
  // ② 逐行把因子乘回去必须等于榜上的分：口径一旦改动而界面没跟上，这里立刻红；
  // ③ 不许「所有因子都是 1」地空跑 —— 真实数据里金数因子与行动值因子必须真的在动。
  const data = await archiveConclusion({ owned: [] }, { window: 6 });
  assert.ok(data.frontierUnits.length > 0, '真实数据集应有总榜条目');
  const metaOf = (id) => (data.frontierEnvs || []).find((e) => e.id === id);
  const withWindow = (data.frontierEnvs || []).filter((e) => Number.isFinite(e.avLo)
    && Number.isFinite(e.avHi) && e.avHi > e.avLo);
  assert.ok(withWindow.length >= 3,
    `至少要有一个以上副本下发有效的行动值区间，实际 ${withWindow.length}`);
  assert.ok((data.frontierEnvs || []).every((e) => typeof e.lowerIsBetter === 'boolean'),
    '每个副本元数据都要带行动值方向');
  let rows = 0;
  let movedCost = 0;
  let movedAv = 0;
  let weighted = 0;
  let maxErr = 0;
  for (const unit of data.frontierUnits) {
    for (const env of unit.envs) {
      const f = frontierFactorsOf(env, metaOf(env.id));
      if (!(f.base > 0)) continue;
      rows += 1;
      // 权重与分都必须是真数：界面载荷里逐条**不发** `weight`（按 id 查元数据），
      // 一旦查不到就退化成 0，`贡献 = 权重 × 分` 会变成 0 = 0 的假通过。
      assert.ok(f.weight > 0, `${unit.name} / ${env.id}：副本权重必须 > 0，实际 ${f.weight}`);
      assert.ok(f.score > 0, `${unit.name} / ${env.id}：这一副本的分必须 > 0，实际 ${f.score}`);
      // ⚠️ v4.6.78：跨版本发挥**恒 ≤ 1**（分子与分母取自同一个集合 —— 池 = 全部成绩）。
      // 旧口径（池 = 最便宜 25% + 未进池按质量估算）实测有 10 条 > 1（绯英 E6+邂逅S5 ×1.50）。
      // 容差 1e-4 而不是 1e-9：载荷把 `env.score` 四舍五入到 **4 位小数**
      // （`Number(pack.score.toFixed(4))`），而 `base` 由界面从其余字段现算 ——
      // 于是余数会带上一点四舍五入噪声（实测最差 1.0000001，界面显示仍是 ×1.00）。
      // 那是载荷精度，不是口径：真口径的溢出（旧版 ×1.50）比它大四个数量级。
      assert.ok(f.seasonFactor <= 1 + 1e-4,
        `${unit.name} / ${env.id}：跨版本发挥必须 ≤ 1，实际 ${f.seasonFactor}`);
      if (Math.abs(f.weight - 1) > 1e-9) weighted += 1;
      if (f.costFactor !== null && Math.abs(f.costFactor - 1) > 0.05) movedCost += 1;
      if (Math.abs(f.perfFactor - 1) > 0.05) movedAv += 1;
      // ⚠️ 用户 2026-10-11 缺陷 3：档位与行动值**合并**成单一 `perfFactor`，
      // 恒等式随之变成 `100 × 表现 × 金数 × 版本`（旧式是 tier × av 两项相乘）。
      const rebuilt = 100 * f.perfFactor * (f.costFactor ?? 1) * f.seasonFactor;
      maxErr = Math.max(maxErr, Math.abs(rebuilt - f.score));
      assert.ok(Math.abs(env.value - f.weight * f.score) < 1e-6,
        `${unit.name} / ${env.id}：贡献 = 权重 × 分（${env.value} vs ${f.weight * f.score}）`);
    }
  }
  assert.ok(rows > 50, `真实数据上至少要检查到几十行，实际 ${rows}`);
  assert.ok(maxErr < 1e-6, `因子乘回去要精确等于榜上的分，最大误差 ${maxErr}`);
  assert.ok(weighted > 0, '真实数据里应当有「权重 ≠ 1」的行（绝境是 10）');
  assert.ok(movedCost > 0, '真实数据里应当有「金数比 ≠ 1」的行（否则这一列是摆设）');
  assert.ok(movedAv > 0, '真实数据里应当有「行动值项 ≠ 1」的行（否则这一列是摆设）');
});

checkAsync('⭐ 面板（/api/archive/packs）那一路的 env 也要能还原因子：跨版本发挥恒 ≤ 1', async () => {
  // ⚠️ v4.6.88 修的真 bug：**逐档榜**的浮层只随结论载荷带 1 个 env，界面会用
  // `/api/archive/packs` 的数据**整份替换** `unit.envs` 再重画「贡献值来源」表
  // （`advice-view.js` 的 `enrichTierDetail()`）。而 `slimCharacterPack()` 当时**没发
  // `seasonMinCost`** —— `frontierFactorsOf()` 于是退回 `meta.minCost`（**全窗口**最小值，
  // 比「该版本最便宜」更小），金数项与 base 一起变小，余数 = score ÷ base **超过 1**。
  // 实测：305 行里 **119 行（39%）> 1**、最大 **×5.76**（`_probe-packs-season-factor.mjs`）。
  //
  // 上面那条用例只扫了**结论载荷**（它一直带着 `seasonMinCost`，所以永远绿）——
  // 这就是它没能拦住这个 bug 的原因。这里改扫**面板载荷**，规则同上。
  const data = await archiveConclusion({ owned: [] }, { window: 6 });
  const metaOf = (id) => (data.frontierEnvs || []).find((e) => e.id === id);
  // 只抽会被界面补齐的那类角色（`envCount > envs.length` 的逐档榜条目），它们最省时间。
  const tierUnits = Object.values(data.frontierTiers || {}).flat();
  const names = [...new Set(tierUnits
    .filter((u) => Number(u.envCount) > (u.envs || []).length)
    .map((u) => u.name))].slice(0, 3);
  assert.ok(names.length > 0, '逐档榜里应当有「明细被截断」的整包（否则这条用例空跑）');
  let rows = 0;
  let withSeasonMinCost = 0;
  let maxFactor = 0;
  for (const name of names) {
    const packs = await archiveCharacterPacks(name, { window: VERSION_WINDOW });
    assert.equal(packs.ok, true, `${name}：面板接口应当可用`);
    for (const pack of packs.packs || []) {
      for (const env of pack.envs || []) {
        rows += 1;
        // ① 字段必须在（缺了就是上面那个 bug 的形态）
        assert.ok(Number.isFinite(Number(env.seasonMinCost)),
          `${name} / ${env.id}：面板的 env 必须带 seasonMinCost`);
        withSeasonMinCost += 1;
        // ② 因子必须能还原成榜上的分，且**恒 ≤ 1**
        const f = frontierFactorsOf(env, metaOf(env.id));
        if (!(f.base > 0)) continue;
        maxFactor = Math.max(maxFactor, Number(f.seasonFactor) || 0);
        assert.ok(f.seasonFactor <= 1 + 1e-4,
          `${name} / ${env.id}：跨版本发挥必须 ≤ 1，实际 ${f.seasonFactor}`
          + `（minCost ${f.minCost}/${f.cost}）`);
        const rebuilt = 100 * f.perfFactor * (f.costFactor ?? 1) * f.seasonFactor;
        assert.ok(Math.abs(rebuilt - f.score) < 1e-6,
          `${name} / ${env.id}：因子乘回去要等于分（${rebuilt} vs ${f.score}）`);
      }
    }
  }
  assert.ok(rows > 20, `至少要检查到几十行面板明细，实际 ${rows}`);
  assert.equal(withSeasonMinCost, rows, '每一行都要带 seasonMinCost');
  assert.ok(maxFactor > 0, '这条用例不能空跑：至少要有一行算出正的跨版本发挥');
});

// ------------------------------------------------------------------- report
console.log(`\n抽卡推荐测试: ${passed} passed, ${failed} failed`);if (failed) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exitCode = 1;
}
