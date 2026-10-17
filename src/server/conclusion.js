// 跨模式综合结论：这个账号该抽哪些角色 / 星魂 / 光锥更划算。
//
// 为什么单独一个模块而不是塞进 archive.js：它要**同时**看四个副本（异相仲裁
// 还要拆成骑士关/绝境两档），而 archive.js 的职责是「一个副本一个版本」的读数。
// 两个模块共用同一套聚合口径（archive.js 的 archiveTeams）和同一套算法
// （public/scripts/advice.js 的 buildConclusion），所以两边给出的
// 「这套作业要几发」「这套阵容什么档」永远一致。
//
// 算法本身写在 advice.js 里（纯函数，浏览器与服务端共用），这里只负责
// 「按副本把数据取齐 + 把中文名补上」。
import { archiveFrontierAll, archiveIndex, archiveTeams, loadI18n, zhName } from './archive.js';
import {
  buildConclusion, EIDOLON_TIERS, eidolonTierOf, normalizeDrawWeights, normalizeHiddenCosts,
  normalizeVersionWeights, VERSION_WEIGHT_MAX,
} from '../../public/scripts/advice.js';

/** 结论覆盖的副本顺序（按游戏解锁顺序）。 */
const MODE_ORDER = ['moc', 'pf', 'as', 'aa'];

/**
 * 每个「环境」= 副本 × 关卡。异相仲裁把三种难度混在同一版本里（骑士关与普通
 * 王棋关看轮次，绝境王棋关看行动值），所以拆成两档分别计入结论。
 *
 * 版本取「该关卡最新的**可靠**版本」：末日幻影 4.6 刚开时只有 7 条投稿，
 * 拿它当基线等于用 7 个人的成绩给整个账号下结论——这条规则在别处已经立过
 * （样本 < minSeasonRuns 的版本不参与强度计算），这里必须一致。
 *
 * ⚠️ 这里回**两个**版本（v4.6.48 修）：`season` 是「主证据版本」（会被完整性回退，
 * 服务基线 / 抽卡方案 / 差距榜），`frontierSeason` 是压金前沿窗口的锚点（只受
 * `minSeasonRuns` 约束、**不回退**，服务性价比总榜）。分开的原因见下面
 * `newestReliable` 那一段的注释 —— 合在一起时，「为了基线稳妥而回退一版」会顺带
 * 把更新版本从总榜的版本窗口里整个删掉。
 */
export const listEnvs = (index) => {
  const modes = [...(index.modes || [])].sort(
    (a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode),
  );
  const minRuns = index.minSeasonRuns ?? 20;
  const out = [];
  for (const mode of modes) {
    for (const stage of mode.stages || []) {
      const seasons = [...(stage.seasons || [])];
      if (!seasons.length) continue;
      const runs = stage.seasonRuns || {};
      // 选择最近一个**完整且可靠**的赛季。新赛季刚开放时，黑塔网可能只收集到
      // 上一赛季一半左右的投稿；如果直接把它当主证据，旧角色的历史高分与新角色
      // 的少量样本会一起被放大。完整性只看数据量相对上一可靠赛季的比例，不写角色
      // 名单，也不依赖社区手工标注。
      const reliable = seasons
        .map((value, index) => ({ value, index, runs: Number(runs[value] ?? 0) }))
        .filter((entry) => entry.runs >= minRuns);
      // ⚠️ **两个版本必须分开算**（v4.6.48 修）—— 它们服务两件不同的事：
      //
      //   `season`         主证据版本 → 基线 / 达标成本 / 抽卡方案 / 差距榜。
      //                    新赛季刚开、只收到一半投稿时确实不该当主证据，所以它吃
      //                    下面那段「完整性回退」。
      //   `frontierSeason` 压金前沿（性价比总榜）的**版本窗口锚点** → 只受可靠性
      //                    下限 `minSeasonRuns` 约束，**绝不回退**。
      //
      // 为什么总榜不能跟着回退：`archiveFrontier` 的窗口是
      // `seasons.slice(idx - window + 1, idx + 1)` —— 锚点一回退，**比它更新的版本
      // 就整个掉出窗口**（不是降权，是删掉）。实测：4.6 的异相仲裁有 591 / 230 条
      // 投稿（远超下限 20），却因为「只有 4.5 的 48%」被回退，4.6 的分区数据一条都
      // 没进总榜 —— 砂金•戏浪在 4.6 的最便宜满分证据（9 金）被 4.5 的 11 金证据顶替，
      // 该副本贡献 887 → 661，名次 #2 → #14。
      // 总榜本来就是**跨版本加权**（2:2:2:1:1:1:1）的，缺证据的版本有既定的推算
      // 分支，没有理由把最新版本整段排除。
      const newestReliable = reliable[reliable.length - 1] || {
        value: seasons[seasons.length - 1], index: seasons.length - 1,
        runs: Number(runs[seasons[seasons.length - 1]] ?? 0),
      };
      let selected = newestReliable;
      if (reliable.length >= 2) {
        const previous = reliable[reliable.length - 2];
        const completeness = previous.runs > 0 ? selected.runs / previous.runs : 1;
        if (completeness < 0.60) selected = previous;
      }
      const season = selected.value;
      const reliableFlag = selected.runs >= minRuns;
      const label = stage.labelCn
        ? `${mode.labelCn} · ${stage.labelCn}`
        : mode.labelCn;
      out.push({
        id: `${mode.mode}${stage.stage ? `/${stage.stage}` : ''}`,
        mode: mode.mode,
        stage: stage.stage || '',
        label,
        // 该关卡自己的最新有数据版本：不同副本的最新版本并不一致。
        season,
        // 压金前沿窗口的锚点：**不回退**的最新可靠版本（见上）。总榜只吃这一个。
        frontierSeason: newestReliable.value,
        reliable: reliableFlag,
      });
    }
  }
  return out;
};

/**
 * 把「环境」取齐成 `buildConclusion` 要的形状（`listEnvs` → 逐副本 `archiveTeams`）。
 *
 * ⚠️ `archiveConclusion` 与 `tools/` 里的探针**共用这一段**（v4.6.48 起）。以前探针
 * 各自手写了一套「版本选取 + 取阵容表」，于是与生产分叉成了两套口径 ——「探针说砂金
 * #3、界面上是 #14」正是这么来的。要改口径就改这里，**不要再抄第二份**。
 */
export const conclusionEnvs = async (index, options = {}) => {
  // 版本窗口：**跟着用户「版本权重」的档位数走**（用户 2026-10-17 起可以加删档位），
  // 不再写死 6。上限仍是 `VERSION_WEIGHT_MAX`（12）—— 与 `normalizeVersionWeights()`
  // 收档位数的那一处同一个常量，两处各写一个数迟早对不上。
  const window = Math.max(1, Math.min(
    Number(options.window) || normalizeVersionWeights(options.versionWeights).length,
    VERSION_WEIGHT_MAX,
  ));
  const envs = [];
  const skipped = [];
  for (const env of listEnvs(index)) {
    const data = await archiveTeams(env.mode, {
      season: env.season,
      stage: env.stage,
      window,
      // 星魂的边际收益要按**同一套阵容**配对量（见 buildConclusion 的修正②）。
      // 聚合层默认不带这张表，所以这里必须显式要。
      withEidoPerf: true,
      // 绝境行动值必须与实际投稿的配装绑定，不能把 roster 的 bestAv 配到另一条 sample 上。
      withFrontier: true,
      /**
       * 版本权重（用户 2026-10-16 第 3 条 / v4.6.117 修的缺陷）。
       *
       * ⚠️ **必须透传**：聚合层用它算两样东西 ——
       *   * `teams[]` 的跨版本加权（满分率 / 平均行动值 → 抽卡方案的强度与候选池）；
       *   * `avTeams`（行动值前沿池）的选行：`avRowFor` 取「**权重最高的有数据版本**
       *     的那一次成绩」，权重 0 的版本不进窗口（见 `buildAvTeams`）。
       * 漏了这一层，用户改版本权重时抽卡方案完全不动 —— 因为这条链从
       * `archiveTeams` 起就拿不到用户表（`resolveScope` 只认 `options.versionWeights`）。
       * 与 `archiveFrontierAll`（总榜那条链）用的必须是同一份表，否则同一个界面里
       * 「总榜按用户表、方案按默认表」，两个口径分叉。
       */
      versionWeights: options.versionWeights,
    });
    if (!data.ok) {
      skipped.push({ env: env.id, reason: data.error || '读取失败' });
      continue;
    }
    envs.push({
      ...env,
      season: data.season,
      totalRuns: data.totalRuns,
      recentSeasons: data.recentSeasons,
      reliable: data.reliable,
      tierLines: data.tierLines,
      // 末日幻影的判据线是积分线（越大越好），其余是行动值线（越小越好）。
      // 结论里要把两者换算到同一个方向，所以这个标记必须传下去。
      lowerIsBetter: data.lowerIsBetter !== false,
      // 该期成绩分布分位数：把「提升」换算成「击败比例」用（见 advice.js 的 percentileOf）
      dist: data.dist || null,
      teams: data.teams,
      frontierRows: data.frontierRows,
      // 逐版本的「0 行动值」金数区间（用户 2026-10-17 第 2、3 条：强度新口径的基准）。
      // 建库侧按原始 `frontier` 行算好，`advice.js` 的 `frontierBoard` 与 `teamPlan`
      // **共用同一份** —— 两个榜的强度口径不许分叉。
      zeroAvGoldBySeason: data.zeroAvGoldBySeason || null,
      // 「行动值前沿」：本关卡最近一版行动值最好的几支队伍（用户 2026-10-16 第 2 条）——
      // 抽卡推荐的候选池要靠它把「各种 0 行动值队伍」补进去（见 archive.js 的
      // `buildAvTeams` 注释：实测候选池里一支都没有）。
      avTeams: data.avTeams || [],
    });
  }
  return { envs, skipped, window };
};

/**
 * 补齐中文名。角色与光锥是两张表，所以按 `kind` 分开取，不能一把梭。
 * （generic 遍历会把光锥名拿去角色表里查，得到 null 再被覆盖，读起来很迷惑。）
 */
const localizeItem = (item, i18n) => {
  if (!item || typeof item.name !== 'string') return item;
  item.nameCn = zhName(i18n, item.kind === 'cone' ? 'lightCones' : 'characters', item.name) || null;
  return item;
};

const localizeConclusion = (result, i18n) => {
  for (const row of result.envs) {
    if (row.baseline?.roster) {
      row.baseline.rosterCn = row.baseline.roster.map((n) => zhName(i18n, 'characters', n));
    }
    for (const cand of row.candidates) {
      (cand.items || []).forEach((item) => localizeItem(item, i18n));
    }
  }
  for (const unit of result.units) {
    localizeItem(unit, i18n);
    // 图标：总榜与抽卡方案都要带角色/光锥图标（官方高清图，来源见 tools/herta-i18n.mjs）
    unit.icon = i18n?.icons?.characters?.[unit.name]
      || i18n?.icons?.lightCones?.[unit.name]
      || null;
    for (const env of unit.envs) {
      for (const item of env.companions || []) localizeItem(item, i18n);
    }
  }
  // 性价比总榜（**纯黑塔网数据口径**，不依赖角色池）：角色 / 星魂 / 光锥混排，
  // 同样要中文名与图标，否则界面只能显示英文键。
  for (const unit of result.frontierUnits || []) {
    localizeItem(unit, i18n);
    unit.icon = i18n?.icons?.characters?.[unit.name]
      || i18n?.icons?.lightCones?.[unit.name]
      || null;
  }
  // 逐星魂档的总榜：与 `frontierUnits` 共用同一批对象（`byTier` 是 `sorted` 的过滤
  // 结果，不是拷贝），所以上面那轮**已经**把它们补过了。这里仍然显式走一遍 ——
  // 将来谁把 `byTier` 改成深拷贝，界面不会突然退回英文键（`slimFrontierUnit` 不
  // 下发 nameCn / icon，所以这只影响服务端返回值与探针）。
  for (const rows of Object.values(result.frontierTiers || {})) {
    for (const unit of rows || []) {
      localizeItem(unit, i18n);
      unit.icon = i18n?.icons?.characters?.[unit.name]
        || i18n?.icons?.lightCones?.[unit.name]
        || null;
    }
  }
  // 「和主流强阵的差距」榜同样要中文名与图标，否则界面只能显示英文键
  for (const unit of result.gapUnits || []) {
    localizeItem(unit, i18n);
    unit.icon = i18n?.icons?.characters?.[unit.name]
      || i18n?.icons?.lightCones?.[unit.name]
      || null;
    for (const t of unit.targets || []) {
      for (const item of t.companions || []) localizeItem(item, i18n);
    }
  }
  // 星魂全局榜（同阵容配对的「能压到几金」）
  for (const unit of result.eidolonUnits || []) {
    localizeItem(unit, i18n);
    unit.icon = i18n?.icons?.characters?.[unit.name] || null;
  }
  for (const pack of result.packages) {
    for (const item of pack.items || []) localizeItem(item, i18n);
    // 抽卡方案里要显示图标，所以作业里的每个单位也带上官方高清图
    for (const item of pack.items || []) {
      item.icon = i18n?.icons?.characters?.[item.name]
        || i18n?.icons?.lightCones?.[item.name]
        || null;
    }
  }
  return result;
};

/**
 * 发给浏览器的载荷瘦身（2026-10）。
 *
 * 为什么要做：`buildConclusion` 的返回是给**算法**用的（每个候选都带整套配装
 * `sample`、打包组合、每个单位的期望抽数表…），原样丢给浏览器实测 689 KB，
 * 而界面真正读的字段不到三分之一 —— 同一份数据还被重复带了三遍：
 * 环境表里有 `candidates`、`units` 里每个环境又带一次 `companions`、`best` 再
 * 带一次同一份环境条目。
 *
 * 这里按「界面实际用到什么」投影一遍：`public/scripts/advice-view.js` 只读
 * `envs[].{id,mode,stage,label,season,reliable,tierLines,baseline.tier}`、
 * `frontierUnits`、`units`（抽卡方案）与 `counts`。差距榜 / 星魂榜 / 作业榜
 * （`gapUnits` / `eidolonUnits` / `packages`）目前界面不渲染，但它们是公开 API
 * 的一部分（README 有文档、e2e 有断言），所以**保留形状、只截断并去掉配装明细**。
 */
const slimEnvEntry = (env) => ({
  id: env.id,
  envLabel: env.envLabel,
  gain: env.gain,
  value: env.value,
  pulls: env.pulls,
  ownPulls: env.ownPulls,
  from: env.from,
  target: env.target,
  tier: env.tier ?? null,
  easy: Boolean(env.easy),
  // 权重：两条链上的字段名不一样（个人口径内部叫 `envWeight`，总榜叫 `weight`），
  // 界面只认 `weight` —— 不在这里归一的话，抽卡方案浮层里的「权重」列恒显示「×—」
  // （实测：这一列一直是空的，因为投影时把它整个丢掉了）。
  weight: env.weight ?? env.envWeight ?? null,
  costBefore: env.costBefore ?? null,
  costAfter: env.costAfter ?? null,
  pctBefore: env.pctBefore ?? null,
  pctAfter: env.pctAfter ?? null,
  eidolonStep: env.eidolonStep ?? null,
  evidence: env.evidence || null,
  count: env.count ?? null,
  season: env.season ?? null,
  inferred: Boolean(env.inferred),
  lowTierShare: env.lowTierShare ?? null,
  baseSupport: env.baseSupport === true,
});

const slimUnit = (unit) => ({
  key: unit.key,
  kind: unit.kind,
  name: unit.name,
  nameCn: unit.nameCn || null,
  icon: unit.icon || null,
  pulls: unit.pulls,
  pullsExpected: unit.pullsExpected ?? null,
  from: unit.from,
  target: unit.target,
  uncertain: Boolean(unit.uncertain),
  total: unit.total,
  personalTotal: unit.personalTotal,
  envCount: unit.envCount,
  allEnvCount: unit.allEnvCount,
  // 抽卡方案的「为什么」按这前几个副本写，再多也没人看（界面只列 3 条）
  envs: (unit.envs || []).slice(0, 4).map(slimEnvEntry),
  // 「补齐后可照抄」与证据：界面用 best.rosterCn / companions / count / evidence
  best: unit.best ? {
    ...slimEnvEntry(unit.best),
    rosterCn: unit.best.rosterCn || null,
    companions: (unit.best.companions || []).map((c) => ({
      kind: c.kind, name: c.name, nameCn: c.nameCn || null, pulls: c.pulls, from: c.from, target: c.target,
    })),
  } : null,
});

/**
 * 总榜单位 = **整包**：角色 + 星魂目标档 + 光锥（含叠影）绑成一条。
 *
 * 用户 2026-10 口径：不再拆成「角色 / 星魂 / 光锥」三行，也不算某个星魂自己的造价；
 * 分子（档位 × 行动值）与分母（该配置的金数）都只来自**队伍**，所以整包自己的金数
 * 只用于展示，不参与排序。
 *
 * ⚠️ **逐副本明细只发给前 `FRONTIER_DETAIL_ROWS` 条** —— 这不是审美问题：整包口径下
 * 条目数比旧的节点榜多一倍（实测 1101 条），`tools/e2e-test.mjs` 有一条**硬上限
 * 600 KB**（响应要能安稳送到浏览器）。名次靠后的条目仍然带「最佳证据」
 * （`bestTeamGold` / `bestTier` / `bestActionValue` 每条都发），只是不再逐副本展开。
 *
 * ⚠️ **2026-10-11（v4.6.77）改过这里的两个「省载荷」取舍**，改的原因都是用户看出来的
 * 界面缺陷，不是审美：
 *   ① **逐副本明细以前 `.slice(0, 3)`** —— 一个整包最多有 5 个关卡（混沌 / 虚构 / 末日 /
 *      异相仲裁 / 绝境），于是窗口里只列 3 个关卡，用户在界面上报「缺少虚构叙事、
 *      异相仲裁·王棋和骑士关」。现在**全给**（实测 62 条共 137 → 167 个逐副本条目）。
 *   ② **`envLabel` 以前不发**（想着「界面按 `id` 去顶层 `frontierEnvs` 查 `label`」）——
 *      总榜那张表确实是那么查的，但 v4.6.76 新加的「逐关卡最佳证据队伍」说明行直接读了
 *      `env.envLabel`，于是界面上印出的是**数据集英文 id**（`aa/plight` / `as` / `moc`）。
 *      现在每条都带 `envLabel`（与顶层 `label` 同一个字符串）。
 *   ③ **队友名单以前只给 `envIndex === 0`**（= 贡献最高的那一个关卡）—— 用户要的是
 *      「最佳证据的队伍显示**所有**关卡的队伍」，所以现在**每个关卡都带**。
 *      实测载荷 187.8 KB → **232.9 KB**（上限 600 KB，仍有余量；那条硬上限断言在
 *      `tools/e2e-test.mjs`，形状断言也在那里 —— 这三条取舍各自对应一条）。
 */
const FRONTIER_DETAIL_ROWS = 200;

/**
 * 图标地址的**四级兜底**解析（`resolveIcon`）。
 *
 * 为什么不能直接用 `i18n.icons[table][name]`（原以为够用，实测配装块 112 张图里
 * **15 张没有 src**）：缺图是常态，不是异常。三类差异现在就在数据里——
 *   * 形态变体：数据集写 `March 7th (Hunt)`，图标表登记 `March 7th`；
 *   * 开拓者：数据集写 `Trailblazer (Destruction)`，图标表登记 `{NICKNAME}`；
 *   * 标点差异：数据集写 `Dance Dance Dance`，图标表写 `Dance! Dance! Dance!`，
 *     以及光锥 `To Say Goodbye` vs `Make Farewells More Beautiful` 这类**译名不同**。
 *
 * ⚠️ 与 `public/scripts/advice-view.js` 的 `iconUrlOf()` **同一套规则**（那边是给总榜行
 * 与浮层配队用的，那边早就发现过这三类差异）。这里另写一份是因为角色面板在**另一个
 * 分页**、拿不到 advice-view 的模块级状态；改一处两边都改的成本低于接一个跨模块依赖。
 * ⚠️ **不要在这里自己拼 CDN URL**：图标表里没有的键就是真的没有，拼出来的地址只 404。
 */
const looseKeyOf = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const baseFormKeyOf = (name) => {
  const raw = String(name || '');
  if (/^Trailblazer\b/i.test(raw)) return '{NICKNAME}';
  return raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
};

/**
 * 建一张「两种索引」的图标表：精确键 + 去标点小写键。
 * 顺带把**中文名**也收进精确索引 —— 译名不同（`To Say Goodbye` /
 * `Make Farewells More Beautiful`）时，中文名往往能对上，而面板手上就有中文名。
 */
const iconResolver = (i18n) => {
  const build = (table, cnTable) => {
    const exact = new Map();
    const loose = new Map();
    for (const [key, url] of Object.entries(table || {})) {
      if (!url) continue;
      if (!exact.has(key)) exact.set(key, url);
      const cn = cnTable?.[key];
      if (cn && !exact.has(cn)) exact.set(cn, url);
      const folded = looseKeyOf(key);
      if (folded && !loose.has(folded)) loose.set(folded, url);
    }
    return { exact, loose };
  };
  const icons = i18n?.icons || {};
  return {
    char: build(icons.characters, i18n?.characters),
    cone: build(icons.lightCones, i18n?.lightCones),
  };
};

/** 英文键**或**中文名** → 图标地址；查不到返回 null。 */
const resolveIcon = (maps, kind, name) => {
  if (!name) return null;
  const m = maps[kind === 'cone' ? 'cone' : 'char'];
  return m.exact.get(name)
    || m.exact.get(baseFormKeyOf(name))
    || m.loose.get(looseKeyOf(name))
    || m.loose.get(looseKeyOf(baseFormKeyOf(name)))
    || null;
};

/**
 * @param {any} unit
 * @param {number} index  它在所属榜单里的名次（只有前 `FRONTIER_DETAIL_ROWS` 条带逐副本明细）。
 * @param {number|null} maxEnvs  逐副本明细的条数上限。
 * @param {boolean} withVideo  是否给头条那一支带上**来源视频**（见 env 投影里那段注释：
 *   只有逐档榜需要它，总榜那条路的队伍卡片走按需的 `/api/archive/packs`）。
 */
const slimFrontierUnit = (unit, index = 0, maxEnvs = null, withVideo = false) => ({
  key: unit.key,
  kind: 'pack',
  name: unit.name,
  // ⚠️ 不发 `nameCn` / `icon`：总榜单位从来不带这些（界面按英文键走 i18n 解析中文名），
  // 1100 条 × 2 个恒为 null 的键纯属浪费载荷。
  // 整包的两个附加维度（另一个是角色本身）：界面写成「银狼LV.999 E2 · 欢迎来到银河城S1」
  eidolon: Number(unit.eidolon) || 0,
  lc: unit.lc || null,
  superimp: Number(unit.superimp) || 1,
  // 整包自己的金数：**2026-10-17 起进公式了**（配装口径的 `ownGoldFactor`，见下面那个字段）。
  gold: Number(unit.gold ?? unit.pulls) || 0,
  // ⚠️ **系数的分母是「隐金前」的金数**（`rawGold`），而 `gold` 是隐金后的。
  //    2026-10-17 第二轮修：界面原来拿 `gold` 去写「最便宜 X 金 ÷ 本整包 Y 金」，
  //    一开隐金就对不上（开满隐金实测 67/261 条还原不出印出的系数，还出现「1 ÷ 0」）。
  //    所以原始金数必须**单独下发** —— 这一格就是教读者验算的那个分母。
  ownGold: Number(unit.ownGold ?? unit.rawGold ?? unit.gold ?? unit.pulls) || 0,
  total: unit.total,
  // 配装口径的「整包自身金数」系数（用户 2026-10-17「走 A + D」）：
  //   `total` 已经乘过它，界面要在性价比来源表的标题行把它印出来，
  //   否则「Σ逐关卡贡献 × 系数 = 合计」这条验算链就断了。
  // `ownGoldRef` = 该角色榜上最便宜的整包金数（系数的分子），用于写出「1 金 ÷ 7 金」。
  ownGoldFactor: unit.ownGoldFactor ?? 1,
  ownGoldRef: unit.ownGoldRef ?? null,
  // ---- 三个分项 + 合成后的「角色得分」（用户 2026-10-13 第 1、2 条）------------------
  //
  // 用户第 2 条把「性价比得分」改名「**角色得分**」：榜上那个数不再是「含金数项总分」
  // 一个量，而是三个分项按**抽卡权重**加权的结果（三个分项各自在榜内归一到 0~100）：
  //
  //   角色得分 = ws × 强度得分 + wc × 性价比得分 + wv × 泛用性得分
  //
  // ⚠️ `total` **照旧下发**，它是「性价比」那一项的**原始分**（量纲与 v4.6.94 一致）：
  // 抽卡方案的 ① 强度得分吃的就是它，浮层也要靠它对上「合计」那一行。
  // ⚠️ 抽不到 `characterScore` 的是**合成夹具 / 老服务端**（它们直接手搓 `frontierUnits`）：
  // 这里如实给 `null`，由界面退回 `total`（见 `advice-view.js` 的 `unitRoleScore`）。
  characterScore: unit.characterScore ?? null,
  strengthScore: unit.strengthScore ?? null,
  costScore: unit.costScore ?? null,
  versatilityScore: unit.versatilityScore ?? null,
  // 两个**原始量**（浮层要写清「那 100 分是怎么归一出来的」，就得给原始值）：
  //   * `strengthTotal` —— 强度分项的原始累计（100 × 表现 × 版本加权 × 副本权重，**不含金数项**）；
  //   * `versatilityRaw` —— 泛用性原始分（2026-10-15 起为**双重加权**的「加权队友数」：
  //     每副本按版本权重、跨副本按关卡权重；不再是整数并集，名单走按需接口）。
  strengthTotal: unit.strengthTotal ?? null,
  // 「投入越高强度不可能更低」的**单调兜底值**（0~100，用户 2026-10-14 的不变式）：
  // 该角色在「星魂 ≤、叠影 ≤」范围内达到过的最好行动值表现。强度分 = 95% × 它 + 5% × 投入。
  // ⚠️ 界面必须能看到它：`strengthTotal` 是**本档自己**打出来的原始平均分（稀疏投稿时会
  // 低于低投入档位），两者不同时详情窗口要写出「为什么榜上是这个数」（否则读者会以为算错了）。
  strengthFloor: unit.strengthFloor ?? null,
  versatilityRaw: unit.versatilityRaw ?? null,
  // ⚠️ **泛用性的来源名单（`versatilityMembers`）刻意不在这里投影**（用户 2026-10-13 要求
  //    「给出泛用性的完整得分来源」，但名单走的是**按需**那条路）：
  //    它是角色级的，而一个角色在榜单里最多出现 5 次（总榜 1 + 四个星魂档各 1），
  //    逐条带就是同一份名单重复 5 次 —— 实测 319 条共 **117 KB**，把 `/conclusion`
  //    从 564 KB 顶到 **730 KB**，直接打穿 e2e 的 600 KB 硬上限。
  //    改由 `/api/archive/packs?char=…` 那份载荷带**这一个角色**的名单（见 `slimCharacterPack`），
  //    界面点开详情时按需取 —— 与「全部配队」「逐档榜补明细」共用同一个缓存请求。
  // ⚠️ 归一上下限同理：它是**整榜一份**，挂在顶层 `frontierExtents`（见下面 `/conclusion`
  //    的投影），逐条带一份会白花 33 KB。
  // ⚠️ 抽卡方案的「强度得分」用的**就是**上面那个 `total`（用户 2026-10-12 第 8 条：
  //    同为 0T，9 金队要比 16 金队强得多）。v4.6.87 曾在这里多发一个 `strength`
  //    （纯强度，不含金数项），v4.6.91 已删除 —— 载荷形状回到 **v7**。
  envCount: unit.envCount,
  // 并列分组键：同分 = 同一支队伍的成员（口径使然），界面据此标注并列。
  bestTeamGold: unit.bestTeamGold ?? null,
  bestTier: unit.bestTier ?? null,
  bestActionValue: unit.bestActionValue ?? null,
  // 逐副本明细：**全部下发**（2026-10-11 v4.6.77 起；改前 `.slice(0, 3)`，用户看到
  // 「关卡下方缺少虚构叙事、异相仲裁·王棋和骑士关」）。一个整包最多 5 个关卡
  // （混沌 / 虚构 / 末日 / 异相仲裁 / 绝境），窗口那张表与「最佳证据的队伍」都按它渲染
  // —— 截断 3 个会让两处同时少列关卡，而且 `envCount` 还写着 5，自相矛盾。
  // ⚠️ `envLabel` **必须发**（2026-10-11 v4.6.77）：总榜那张表是用 `id` 去顶层
  // `frontierEnvs` 查 `label` 的，但「逐关卡最佳证据队伍」的说明行读 `env.envLabel`
  // —— 不发它，界面上就会印出数据集英文 id（`aa/plight` / `as` / `moc`）。
  // 每个关卡的**队友名单也全发**（改前只给 `envIndex === 0`）：用户要的是
  // 「最佳证据的队伍显示**所有**关卡的情况和贡献」，只给一支队伍等于没做到。
  // ⚠️ `maxEnvs` 只有传了**有限数**才截断。别把默认值写成 `Infinity` 之类再直接
  // `.slice(0, maxEnvs)`：`Array.map(slimFrontierUnit)` 会把**第三个参数（整个数组）**
  // 传进来，`slice(0, 数组)` 得到的是空数组 —— 实测总榜 84 条的逐副本明细会被整片抹掉。
  envs: index < FRONTIER_DETAIL_ROWS
    ? (unit.envs || []).slice(0, Number.isFinite(maxEnvs) ? maxEnvs : undefined).map((env, envIndex) => ({
      id: env.id,
      envLabel: env.envLabel ?? null,
      // 该整包在这一副本里的贡献（Σ = total）。`score` = value ÷ 副本权重，界面自己算。
      value: env.value,
      // 强度那一档的同一批数字（用户 2026-10-13 第 2 条 + 2026-10-14 新口径）：
      // `envStrength` 是本副本的**强度**（0~100，由行动值定；0 行动值那一档内按金数扣分）、
      // `envStrengthValue` 是它乘上副本权重后的贡献。浮层要解释「强度分项从哪来」就得有它。
      // ⚠️ 键名**不是** `strength`：那是 v4.6.87 被撤销的字段名，回归测试盯着它别复活。
      envStrength: env.envStrength ?? null,
      envStrengthValue: env.envStrengthValue ?? null,
      // 该副本里**最好的那一版**的表现分（0~100）。⚠️ 新口径下强度**不再跨版本平均**，
      // 所以它不再是「跨版本发挥」的分母；留着只为兼容旧载荷的消费方。
      envStrengthBest: env.envStrengthBest ?? null,
      // ⚠️ 2026-10-18：环境级继承行（这一关自己没投稿、借了更便宜同角色的分）。
      //    它的 `value`/`score` 恒 0（继承只进强度列），界面与测试都靠这个标记跳过
      //    「因子还原」那条性价比链。只在 true 时下发，不占体积。
      ...(env.inheritedEnv === true ? { inheritedEnv: true } : {}),
      // ⚠️ **新强度口径的那几个原始字段（avBest / strengthGold / isPerfect / perfectLine /
      // weight）刻意不在这一份载荷里** —— 它们只在按需的 `/api/archive/packs` 上（见
      // `slimCharacterPack`）。理由：逐条带会让 `/conclusion` 从 597 KB 顶到 **614 KB**，
      // 超过 `e2e-test.mjs` 的 600 KB 硬上限（实测判红一次）。而详情窗口打开时本来就会
      // 取那份按需载荷并**整份替换 `unit.envs`**（`enrichTipDetail`），强度来源表读到的
      // 就是带齐字段的那一份；权重还能从顶层 `frontierEnvs[].weight` 回退（见界面的
      // `frontierEnvMeta`）。
      // 最佳证据那条**队伍**配置：界面写「7 金 · 满分 · 行动值 295 · 4.2 赛季」。
      bestTeamGold: env.bestTeamGold ?? null,
      // **最佳证据所在版本**的最便宜金数 —— 金数项的分母（用户 2026-10-10 第 5 轮：
      // 按版本归一）。浮层拆「贡献来源」必须用它，用顶层 `frontierEnvs[].minCost`
      // （全窗口最小值）会算得比榜上的分低。**不能省**：它是逐条值，不能从副本元数据推。
      seasonMinCost: env.seasonMinCost ?? null,
      tier: env.tier ?? null,
      actionValue: env.actionValue ?? null,
      evidenceSeason: env.evidenceSeason ?? null,
      // 证据广度：只展示，不参与排序。
      configCount: env.configCount ?? null,
      seasonCount: env.seasonCount ?? null,
      // 用户 2026-10-10（第二轮）：**早于登场**、不参与平均的版本数（不奖不罚）。
      absentSeasons: env.absentSeasons ?? 0,
      // 用户 2026-10-10（第一轮）：已登场却**没有任何成绩**、算 0 分的版本数。
      // ⚠️ 与 `absentSeasons` 含义**相反**（「还没轮到它」vs「明确的差」），界面必须分开报。
      // （v4.6.78 删掉了 `unrankedSeasons`：池 = 全部成绩后「有人用但没进池」不存在。）
      droppedSeasons: env.droppedSeasons ?? 0,
      // ⚠️ 逐副本的 `inheritedSeasons` **不下发**：界面那句说明只读整包级的那个数
      //    （`unit.inheritedSeasons`），而 397 个 (整包×副本) 组合各带一个字段要多吃
      //    ~10 KB，把 660 KB 硬上限顶破（实测 661 KB）。要按关卡解释继承时再加回来。
      // 这个整包最早可能存在的版本（角色与光锥里较晚登场的那个）。
      bornSeason: env.bornSeason ?? null,
      //
      // ⚠️ **队友名单（`members`）只给头条那一支**（2026-10-17，v4.6.120）。
      //
      //    改前是**每个副本都带**一份（总榜 81 条 × 5 关 × 4 人 = **87.8 KB**，占整份
      //    载荷的 13%）。四个分支合进 main 之后载荷到了 **661.5 KB**，正好顶穿 e2e 那道
      //    660 KB 护栏（12 档时 713.7 KB），所以得从这条投影上把它削下来。
      //
      //    **只削「非头条那 4 关」**，头条那一支必须留 —— 理由是抽卡方案的候选池
      //    （`advice.js` 的 `teamPoolUnits`）靠它建队伍：它按 `envs[].members` 找第一支
      //    带名单的队伍、再用阵容键去重。**整条删掉会让补金推荐整个空掉**
      //    （实测 `team-plan-test` / `version-weight-plan-test` 当场红）。
      //    而「按阵容去重」只需要**一支**代表队伍，多给的 4 份是纯重复。
      //
      //    剩下那 4 关的名单由 `/api/archive/packs` 补（它逐关卡全给、且不截
      //    `FRONTIER_DETAIL_ROWS`）：详情窗口打开时本来就要取一次，`enrichTipDetail` 的
      //    `needEnvs` 判据已经加上「缺 `members` 也要去取」这一条 —— 与逐档榜那份
      //    「只带 1 个 env」是同一条老路子。
      ...(envIndex === 0 ? {
        members: (env.members || []).map((m) => ({
          char: m.char, eidolon: m.eidolon, lc: m.lc || null, superimp: m.superimp,
        })),
      } : {}),
      // **来源视频**（用户 2026-10-14 第 6 条）：这一行的队伍对应的 b 站 / 油管投稿地址。
      // 界面在队伍卡片上画一个外链图标，点击 `target="_blank"` 打开（不内嵌播放器）。
      //
      // ⚠️ **只有逐档榜（`frontierTiers`）带它，而且只给头条那一支（`envIndex === 0`）**。
      //    原因是 `/conclusion` 那道 **600 KB 硬上限只剩 ~18 KB 余量**（见上面那段注释：
      //    强度那几个原始字段就是为此挪去 `/api/archive/packs` 的）。逐条带 504 个 env 的
      //    地址实测把载荷顶到 **622 KB**；只给头条、只给逐档榜的 242 个整包是 **13 KB**。
      //    为什么「只给逐档榜」就够：抽卡方案的候选池 = `teamPoolUnits()` = 逐档榜 ∪ 总榜，
      //    实测**总榜那 77 条全部已被逐档榜覆盖**（并集就是那 242 条），所以方案卡片要用的
      //    代表整包一定在这份里。总榜自己的队伍卡片走**按需**的 `/api/archive/packs`
      //    （`enrichTipDetail` 会把视频合并回现有 envs，见 `advice-view.js`）。
      ...(withVideo && envIndex === 0 ? { video: env.video ?? null } : {}),
    }))
    : [],
});

/**
 * 角色面板用的**单角色全部配装**投影（`archiveCharacterPacks` 的输出形状）。
 *
 * 与 `slimFrontierUnit` 的差别，也是这里必须另写一份而不能复用它的原因：
 *
 *   1. **逐副本明细全给**，不截 `FRONTIER_DETAIL_ROWS`（那是给总榜的：名次靠后的
 *      条目省掉明细是为了压 `/conclusion` 的 600 KB 硬上限）。面板是**按需**取一个
 *      角色，实测最多 59 条 —— 全给也只有几十 KB。
 *   2. **每一副本都给队友名单**（总榜只给头条那一支，否则载荷会顶到 685 KB）。
 *      用户要的就是「每个配装的最佳证据的队伍」—— 每一支队伍都得看得见是谁。
 *   3. **发中文名与图标**：面板是给人看的，而且它是全站唯一会在同屏列出 4~16 个
 *      角色头像 + 光锥图标的地方（`i18n.icons`）。
 */
const slimCharacterPack = (unit, i18n, maps) => ({
  key: unit.key,
  name: unit.name,
  nameCn: zhName(i18n, 'characters', unit.name) || null,
  icon: resolveIcon(maps, 'char', unit.name),
  eidolon: Number(unit.eidolon) || 0,
  lc: unit.lc || null,
  lcCn: unit.lc ? (zhName(i18n, 'lightCones', unit.lc) || null) : null,
  lcIcon: unit.lc ? resolveIcon(maps, 'cone', unit.lc) : null,
  superimp: Number(unit.superimp) || 1,
  gold: Number(unit.gold ?? unit.pulls) || 0,
  // ⚠️ 与 `slimFrontierUnit` 逐字段等价（见那边注释）：这个面板的浮层要自己验算
  //    「Σ逐关卡贡献 × 整包系数 = 合计」，缺 `ownGoldFactor` 就静默当成 1、
  //    缺 `ownGold` 就印出与系数对不上的除法。v4.6.118 只补了总榜那一路，面板漏了。
  ownGold: Number(unit.ownGold ?? unit.rawGold ?? unit.gold ?? unit.pulls) || 0,
  ownGoldFactor: unit.ownGoldFactor ?? 1,
  ownGoldRef: unit.ownGoldRef ?? null,
  total: unit.total,
  // 三个分项 + 合成后的「角色得分」——与 `slimFrontierUnit` **必须逐字段等价**：
  // 逐档榜的浮层会拿面板这份数据整份替换 `unit.envs` 再重画，少一个字段就会静默显示
  // 与榜上对不上的数（v4.6.88 的 `seasonMinCost` 就是这么炸过一次）。
  // 见 `slimFrontierUnit` 里那段注释对三个分项的定义。
  characterScore: unit.characterScore ?? null,
  strengthScore: unit.strengthScore ?? null,
  costScore: unit.costScore ?? null,
  versatilityScore: unit.versatilityScore ?? null,
  strengthTotal: unit.strengthTotal ?? null,
  // 单调兜底值（与 `slimFrontierUnit` 同字段同义，见那边的注释）——强度来源表要写出
  // 「为什么榜上的分比本档自己打出来的高」。
  strengthFloor: unit.strengthFloor ?? null,
  versatilityRaw: unit.versatilityRaw ?? null,
  // ⚠️ 泛用性的**来源名单不在这里**：它是**角色级**的，同一个角色的几十个整包共用一份。
  //    逐包带就是同一份名单重复最多 59 次（实测一个角色能到 59 条配装）——
  //    放在这个载荷的**顶层** `versatilityMembers` 上（见 `archiveCharacterPacks` 的返回）。
  envCount: unit.envCount,
  bestTeamGold: unit.bestTeamGold ?? null,
  bestTier: unit.bestTier ?? null,
  bestActionValue: unit.bestActionValue ?? null,
  limitedCones: unit.limitedCones ?? 0,
  absentSeasons: unit.absentSeasons ?? 0,
  droppedSeasons: unit.droppedSeasons ?? 0,
  // 用户 2026-10-17 晚：已登场却缺证据、但继承了更便宜同角色整包的分 —— 版本数。
  // ⚠️ 只在 >0 时下发（660 KB 硬上限）。
  ...(unit.inheritedSeasons > 0 ? { inheritedSeasons: unit.inheritedSeasons } : {}),
  envs: (unit.envs || []).map((env) => ({
    id: env.id,
    envLabel: env.envLabel,
    weight: env.weight,
    value: env.value,
    score: env.score,
    // 强度分项（不含金数项）——与 `slimFrontierUnit` 的 env 投影等价，见那边的注释。
    // ⚠️ 键名不是 `strength`（那是被撤销的 v4.6.87 字段名）。
    envStrength: env.envStrength ?? null,
    envStrengthValue: env.envStrengthValue ?? null,
    // 这一关的分是**整关继承**来的（2026-10-18）：界面把行动值那格写成「继承」。
    ...(env.inheritedEnv === true ? { inheritedEnv: true } : {}),
    // 与 `slimFrontierUnit` 的 env 投影**等价**（面板这条路上界面的「来源」表也是现算的，
    // 少一个字段不会报错、只会静默少一列或算出 > 1 的因子 —— 见下面 `seasonMinCost` 那段）。
    envStrengthBest: env.envStrengthBest ?? null,
    // 新强度口径（2026-10-14）要的同一批字段 —— 与 `slimFrontierUnit` 的 env 投影**必须
    // 逐字段等价**（那两条接口会互相整份替换 `unit.envs` 再重画强度来源表）。
    weight: env.weight ?? null,
    avBest: env.avBest ?? null,
    // 强度那一档**自己的**行动值（2026-10-18）：与 `avBest`（卡片 / 金数那一行）
    // 可能不是同一支队伍 —— 强度按打得最快挑、卡片按最划算挑。强度来源表读它。
    strengthAv: env.strengthAv ?? null,
    strengthGold: env.strengthGold ?? null,
    isPerfect: env.isPerfect === true,
    perfectLine: env.perfectLine ?? null,
    bestTeamGold: env.bestTeamGold ?? null,
    // ⚠️ **`seasonMinCost` 必须发**（v4.6.88 修的真 bug）：界面的「贡献值来源」表是用
    // `frontierFactorsOf(env, meta)` **现算**的，而金数项的分母是「**该版本**最便宜」
    // ——少了这个字段它就只能退回 `meta.minCost`（**全窗口**最小值，比本版分母更小），
    // 于是余数（跨版本发挥 = score ÷ base）会**超过 1**。
    // 为什么这条只在**面板**这条路上炸：逐档榜的浮层只随结论载荷带 1 个 env，
    // `enrichTierDetail()` 会拿面板这份数据**整份替换** `unit.envs` 再重画因子表
    // （实测 305 行里 **119 行（39%）> 1**、最大 **×5.76**）。
    // 教训：**面板的 env 投影必须与 `slimFrontierUnit()` 的 env 投影在「界面要现算的字段」
    // 上等价** —— 少一个字段不会报错，只会静默算出一个不可能的数。
    seasonMinCost: env.seasonMinCost ?? null,
    tier: env.tier ?? null,
    actionValue: env.actionValue ?? null,
    evidenceSeason: env.evidenceSeason ?? null,
    limitedCones: env.limitedCones ?? null,
    configCount: env.configCount ?? null,
    seasonCount: env.seasonCount ?? null,
    absentSeasons: env.absentSeasons ?? 0,
    droppedSeasons: env.droppedSeasons ?? 0,
    // ⚠️ 逐副本的 `inheritedSeasons` **不下发**（理由见 `slimFrontierUnit` 那处：
    //    397 个组合 × 25 字节会把 660 KB 硬上限顶破）。整包级那个数照常下发。

    bornSeason: env.bornSeason ?? null,
    // 最佳证据那支**完整队伍**（含每位队友的星魂档与光锥）—— 用户要的就是这个。
    members: (env.members || []).map((m) => ({
      char: m.char,
      nameCn: zhName(i18n, 'characters', m.char) || null,
      icon: resolveIcon(maps, 'char', m.char),
      eidolon: Number(m.eidolon) || 0,
      lc: m.lc || null,
      lcCn: m.lc ? (zhName(i18n, 'lightCones', m.lc) || null) : null,
      lcIcon: m.lc ? resolveIcon(maps, 'cone', m.lc) : null,
      superimp: Number(m.superimp) || 1,
    })),
    // **来源视频**（用户 2026-10-14 第 6 条）：这条按需链**逐关卡全给** —— 它是按需取
    // 一个角色（最多 59 条配装），没有 `/conclusion` 那道 600 KB 硬上限；而逐档榜那份
    // 载荷只给头条那一支，其余关卡的来源视频就靠这里带回去（`enrichTipDetail` 合并）。
    // 只有 URL，没有作者昵称：界面那个图标只需要「点开就能看」，平台由 host 现判
    // （`bilibili` / `YouTube`），多存一个昵称只是让两个接口的文案各说一套。
    video: env.video ?? null,
  })),
});

/**
 * 一个角色的**全部压金配装**（用户 2026-10：「需要在每个角色的详细界面显示所有的
 * 配装的最佳证据的队伍，并分别给出性价比评分」）。
 *
 * 为什么是按需接口而不是塞进 `/conclusion`：那份载荷已经是 0.67 MB（`e2e-test.mjs`
 * 有 600 KB 硬上限），而收敛前的整包有 1097 条 / 67 个角色（实测最多一个角色 59 条）。
 * 全量带上等于为一个「点开才看」的面板把每次加载的载荷翻倍。
 *
 * `name` 是**角色标识**，英文数据集键或中文名都认：
 *   * 抽卡推荐页的战斗记录有 `nameEn`（英文键）；
 *   * 「角色信息」页只有米游社给的**中文名**（见 `src/server/records.js` 与
 *     快照本身），而压金数据是按英文键建的 —— 两边不通，所以这里多认一次中文名。
 *   中文名走 `i18n.charactersById` / `zhName` 的反向表；认不出就返回
 * `found:false` + 空数组，**不报错** —— 一个不在压金前沿里的角色本来就该是空面板。
 *
 * ⚠️ 口径与 `/conclusion` 完全一致：同一个 `buildConclusion`、同一份
 * `frontierWeights`、同一份 **`drawWeights`** 和同一份 `hiddenCosts`。两边跑不同的
 * 权重 / 隐金设置会让「总榜显示的名次」与「面板显示的分数」对不上。
 *
 * ⚠️ **`drawWeights` 也必须带**（用户 2026-10-13 第 2 条之后）：角色得分是三个分项
 * 按抽卡权重加权的**榜内归一分**，而归一用的极值取自整张 `all` 表 —— 面板这条链
 * 用不同的权重算，同一个整包的「角色得分」就会与榜上不一致（这类「权重没带过去」
 * 的 bug 在 v4.6.69 / v4.6.88 各炸过一次）。
 *
 * @param {string} name 角色英文数据集键**或**中文名
 * @param {{window?:string, frontierWeights?:object, hiddenCosts?:object,
 *          drawWeights?:object, versionWeights?:number[]}} options
 */
export const archiveCharacterPacks = async (name, options = {}) => {
  const raw = String(name || '').trim();
  if (!raw) return { ok: true, available: false, found: false, name: raw, packs: [], reason: '没有指定角色' };
  const index = await archiveIndex();
  if (!index?.modes?.length) {
    return { ok: true, available: false, found: false, name: raw, packs: [], reason: '本地还没有数据集' };
  }
  const i18n = await loadI18n();
  // 中文名 → 英文数据集键。反向表从 `i18n.characters`（英文键 → 中文名）现建：
  //
  // ⚠️ **不要用 `i18n.charactersById`** —— 它的键是米游社的数字 id（1407 这种），
  // 不是英文名。当成「英文→中文」来反查会拿数字 id 去查整包表，结果恒为空
  // （实测「遐蝶」被解析成 "1407"，found=false）。踩过一次。
  const cnToEn = new Map();
  for (const [en, cn] of Object.entries(i18n?.characters || {})) {
    if (typeof cn === 'string' && cn) cnToEn.set(cn.trim(), en);
  }
  const key = cnToEn.get(raw) || raw;
  // ⚠️ `conclusionEnvs` 返回 `{ envs, skipped, window }` —— 解构取 `envs`，
  // 直接把整个对象传下去会让 `archiveFrontierAll` 拿到非数组而抛
  // 「(envs || []) is not iterable」。
  // 版本权重（用户 2026-10-16）：聚合层同样要吃它 —— 面板的 `envs[]` 与总榜同源，
  // 否则「跨版本发挥」那一列背后的阵容聚合会按默认表算（v4.6.117）。
  const { envs } = await conclusionEnvs(index, {
    window: options.window,
    versionWeights: options.versionWeights,
  });
  const frontierAll = await archiveFrontierAll(envs, {
    // 窗口同样跟着用户表的档位数走（2026-10-17 起档位可增删）。
    window: normalizeVersionWeights(options.versionWeights).length,
    ...(options.frontierWeights ? { weights: options.frontierWeights } : {}),
    // 版本权重（用户 2026-10-16）：面板与总榜**必须同一份** —— 否则同一个整包在
    // 详情窗口里印的「跨版本发挥」与榜上那个对不上（与 frontierWeights / hiddenCosts
    // / drawWeights 同一类坑，v4.6.69 修过一次）。
    versionWeights: options.versionWeights,
  });
  const result = buildConclusion(envs, {
    availability: index.refs?.availability || {},
    firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
    // 面板展示的是**纯数据集口径**（与角色池无关），所以账号持有情况传空 ——
    // 与 `/conclusion` 里的 `frontierUnits` 同一口径，换账号分数不变。
    account: { owned: new Set(), eidolons: new Map(), cones: new Map() },
    frontier: Object.fromEntries(frontierAll.map((f) => [f.env, f])),
    frontierWeights: options.frontierWeights
      || Object.fromEntries(frontierAll.map((f) => [f.env, f.weight])),
    // 隐金设置（用户 2026-10-11）：面板与总榜必须同一份，否则同一个整包在窗口里与榜上
    // 会显示两个分（v4.6.69 修的正是同一类「权重没带过去」的 bug）。
    hiddenCosts: options.hiddenCosts,
    // 抽卡权重（用户 2026-10-13 第 2 条）：角色得分 = 三个分项按它加权，所以面板
    // **必须**与总榜用同一份，否则同一个整包在两个地方显示两个「角色得分」。
    drawWeights: options.drawWeights,
    // 版本权重（2026-10-16）：同上，夹具路也吃它。
    versionWeights: options.versionWeights,
  });
  // ⚠️ 键不区分大小写地兜一次：形态角色（开拓者各形态、丹恒•腾荒这类）在两边
  // 的大小写/空格写法可能不一致。
  const table = result.frontierPacksByChar || {};
  const hit = table[key] || Object.entries(table)
    .find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1] || [];
  const maps = iconResolver(i18n);
  return {
    ok: true,
    available: true,
    found: hit.length > 0,
    name: key,
    nameCn: zhName(i18n, 'characters', key) || null,
    // 图标表按角色/光锥维度建一次，这一整个请求里共用（下面每个整包、每个队友都要查）。
    // 图标表按角色/光锥维度建一次，这一整个请求里共用（下面每个整包、每个队友都要查）。
    packs: hit.map((unit) => slimCharacterPack(unit, i18n, maps)),
    // 泛用性的**来源名单**（用户 2026-10-13：「给出泛用性**完整得分来源**」里唯一那个
    // 集合型来源：这个角色能通关的队伍里出现过的不同队友）。
    // ⚠️ 放在**顶层**而不是每个整包里：一个角色的几十条配装共用同一批名单，
    //    逐包带就是同一份名单重复最多 59 次。
    // ⚠️ 也**不上 `/conclusion` 的载荷**：那条路上一个角色会出现 5 次（总榜 + 四个星魂档），
    //    逐条带实测 117 KB，会把载荷硬上限打穿 —— 所以界面点开详情时按需来取这里。
    //
    // ⚠️ **2026-10-14 起它按「星魂档」分份**（用户第 1 条：「泛用性需要关联到具体的星魂，
    //    一个角色的 E0 的泛用性和 E6 的泛用性其实关系不大」）：一个角色最多 4 份名单，
    //    按目标档索引。界面拿**当前那个整包自己的档**去取（`versatilitySourceBlock`），
    //    否则 E6 的窗口里会列出 E0 的队友。
    //
    // `versatilityMembers`（老字段）**保留**，取 `hit[0]` 那一档的名单 —— 它是这条接口
    // 从 v4.6.97 起的公开形状，`tools/e2e-test.mjs` 与老前端都在读它；语义退化成
    // 「最佳那条配装所属档位的名单」，而新前端一律走 `versatilityByTier`。
    // ⚠️ **2026-10-17 第 1 条起按「星魂组」分两份**（用户原话：「E6 角色应当仅与 E6 做
    //    比较，E0/1/2 与 E0/1/2 之间做比较」—— 避免不同量级之间的比较）：
    //    - E6 档索引到 **E6 自己那一份**（E6 配装见过的队友）；
    //    - E0/E1/E2 三档索引到**同一份**：三档配装队友的**并集**，与算分用的低档组原始量同源。
    //    这与 `advice.js` 里 `unit.versatilityMembers` / `unit.versatilityRaw` 的口径严格一致
    //    （那边也是「E6 取自己那份、低档组取三档并集」），否则详情窗口会印出一份与得分
    //    对不上的名单。
    //    （2026-10-14~15 按档各一份；2026-10-16 全局一份；两条都已被 2026-10-17 第 1 条推翻。）
    //
    // `versatilityMembers`（老字段）**保留**，取 `hit[0]` 那条的名单 —— 它是这条接口
    // 从 v4.6.97 起的公开形状，`tools/e2e-test.mjs` 与老前端都在读它；语义是
    // 「最佳那条配装所属档位的名单」，新前端一律走 `versatilityByTier`。
    versatilityMembers: hit[0]?.versatilityMembers ?? null,
    versatilityByTier: (() => {
      const byTier = {};
      for (const tier of EIDOLON_TIERS) {
        // 按档各取一份：**同一档**的整包之间 `versatilityRaw` / `versatilityMembers` 是相同的
        // （同档同角色同光锥只有一份原始量），所以取该档第一条带名单的就够了。
        const unit = hit.find(
          (u) => Array.isArray(u.versatilityMembers) && eidolonTierOf(u.eidolon) === tier,
        ) || null;
        if (!unit) continue;
        byTier[String(tier)] = {
          raw: Number(unit.versatilityRaw) || 0,
          members: unit.versatilityMembers,
        };
      }
      return Object.keys(byTier).length ? byTier : null;
    })(),
    // 三个分项的归一上下限：面板浮层也要写「得分 = 100 ×（原始量 − 最小）÷（最大 − 最小）」，
    // 而面板这条路上界面**可能根本没有加载过结论**（用户直接在「角色信息」页点开的）。
    // 它只有一个对象（~110 字节），随包带一份最省事，也省掉「结论没加载就没有刻度」的缺口。
    frontierExtents: result.frontierExtents || null,
    // 副本元数据随包一起给：面板要写副本中文名与权重，单独再发一份不划算。
    envs: frontierAll.map((f) => {
      const meta = result.frontierEnvs?.find((e) => e.id === f.env);
      return {
        id: f.env,
        label: meta?.envLabel || f.env,
        weight: Number(f.weight) || 0,
        minCost: f.minCost ?? null,
        // 档位在界面上的写法要**游戏内实际的量**（`0T` / `行动值 <300`，用户 2026-10-10：
        // 「把网页上显示的『满分』『达标』改为具体的行动值」），而 `tierTextOf()` 需要
        // `mode` / `stage` / `tierLines` 三个字段才能把内部档位键翻出来 —— 这三条判据线
        // 只存在数据集里，必须随包下发（少一个就退回「最好一档」这种没信息量的兜底）。
        mode: meta?.mode ?? null,
        stage: meta?.stage ?? '',
        tierLines: meta?.tierLines ?? null,
        // 行动值项的区间边界：面板要按算分用的同一条尺子复现贡献值来源，
        // 拿 `minAction` / `maxAction`（最值）算会和榜上的分对不上。
        avLo: meta?.avLo ?? null,
        avHi: meta?.avHi ?? null,
        lowerIsBetter: meta?.lowerIsBetter !== false,
        versionWindow: meta?.versionWindow ?? null,
      };
    }),
    // 隐金设置：**回显服务端实际生效的那一份**（归一化后的五个布尔）。
    // 为什么值得多带这 90 字节（载荷形状因此升到 v2）：隐金要穿过四层才生效
    // （界面 → POST/查询串 → 路由 → buildConclusion），任何一层漏传都表现为
    // 「勾了没反应」，而榜面数字的变化很难分辨是「没生效」还是「生效了但数据里
    // 恰好没这些单位」。e2e 直接断言这个回显，就能把「漏传」钉死在接口层。
    hiddenCosts: normalizeHiddenCosts(options.hiddenCosts),
    // ⚠️ 本接口（角色面板）**不发** availability：面板是渲染服务端算好的数，
    // 不像 `/conclusion` 那样要在浏览器里现算队伍差额。
    // v2 = 新增 `hiddenCosts` 回显（用户 2026-10-11 的「隐金设置」）。
    // v3 = 每个 env 新增 `seasonMinCost`（金数项的分母）：逐档榜的浮层会拿面板这份数据
    //      整份替换 `unit.envs` 再重画「贡献值来源」表，缺它就会让「跨版本发挥」算出 > 1
    //      （实测 39% 的行、最大 ×5.76）。见 `slimCharacterPack()` 里的注释。
    // v4 = 三个分项 + 合成后的「角色得分」与逐 env 的 `envStrength` / `envStrengthValue`
    //      （用户 2026-10-13 第 1、2 条），且请求侧新增 `drawWeights`。
    // v5 = 逐 env 新增 `envStrengthBest`（强度来源表的「跨版本发挥」列的分母）——
    //      用户 2026-10-13「需要给出强度、性价比、泛用性的完整得分来源」。
    payload: 5,
  };
};

const slimPack = (pack) => ({
  env: pack.env,
  envLabel: pack.envLabel,
  season: pack.season ?? null,
  tier: pack.tier ?? null,
  gain: pack.gain,
  value: pack.value,
  pulls: pack.pulls,
  count: pack.count ?? null,
  evidence: pack.evidence || null,
  easy: Boolean(pack.easy),
  costBefore: pack.costBefore ?? null,
  costAfter: pack.costAfter ?? null,
  pctBefore: pack.pctBefore ?? null,
  pctAfter: pack.pctAfter ?? null,
  rosterCn: pack.rosterCn || null,
  items: (pack.items || []).map((item) => ({
    kind: item.kind,
    name: item.name,
    nameCn: item.nameCn || null,
    pulls: item.pulls,
    from: item.from,
    target: item.target,
  })),
});

/**
 * 成本口径表（星级 / 限定标记）的**瘦身投影**。
 *
 * 为什么必须随结论一起下发（2026-10-11 第 10 轮）：新的「抽卡方案」是**队伍口径**，
 * 差额由界面现算（`teamPlan()` 在浏览器里跑，服务端不下发队伍方案）。而
 * `marginalCostOf` 的第 1 步就是 `charCostOf(name, availability)` —— 缺这张表时
 * 它按「星级/限定未知 → 宁可高估」的政策把 4★ 也算成 1 金，于是同一支队伍在
 * 服务端与界面会算出两个不同的差额（实测砂金•戏浪那支队会凭空多出 2 金）。
 *
 * 只发星级与「是否常驻」两个字段：实测 93 + 170 条，净增约 6 KB
 * （`limited: true` 是绝大多数，省略它本身就是压缩）。
 *
 * ⚠️ 键必须是**原样全名**，不能用 `baseFormKeyOf()`：那个函数会把
 * `Dan Heng • Imbibitor Lunae` 压成 `Dan Heng`（换行符分隔的形态名也一起吃掉），
 * 两条记录的键会互相覆盖。读取侧本来就会先试全名、再试基础名，所以放全名最准。
 */
const slimAvailability = (availability) => {
  const pick = (table) => {
    const out = {};
    for (const [name, info] of Object.entries(table || {})) {
      if (!name) continue;
      const rarity = Number.isFinite(Number(info?.rarity)) ? Number(info.rarity) : null;
      out[name] = info?.limited === true
        ? (rarity ? { rarity } : {})
        : { rarity, limited: false };
    }
    return out;
  };
  return {
    characters: pick(availability?.characters),
    lightCones: pick(availability?.lightCones),
  };
};

/** @param {any} result buildConclusion 的返回 */
const projectConclusion = (result) => ({
  envs: result.envs.map((env) => ({
    id: env.id,
    mode: env.mode,
    stage: env.stage,
    label: env.label,
    season: env.season,
    totalRuns: env.totalRuns,
    recentSeasons: env.recentSeasons,
    reliable: env.reliable,
    // 判据线与「你现在在哪一档」：界面写「≤2T → 0T」要用
    tierLines: env.tierLines,
    lowerIsBetter: env.lowerIsBetter,
    baseline: { tier: env.baseline?.tier || null },
    candidateCount: env.candidateCount,
  })),
  units: (result.units || []).slice(0, 60).map(slimUnit),
  // 总榜每个副本的元数据（标签 / 权重 / 最便宜金数）：只有 5 条，界面拿它补齐
  // 每个整包的环境名与权重，避免在 1000+ 条整包里逐条重复这些常量。
  frontierEnvs: (result.frontierEnvs || []).map((env) => ({
    id: env.id,
    label: env.label,
    mode: env.mode,
    stage: env.stage,
    weight: env.weight,
    pool: env.pool,
    // 判据线（`0T` / `积分 4000` / `行动值 <300` 那三条）：界面用它把内部档位键翻成
    // **游戏内实际的量**（用户 2026-10-10：「把『满分』『达标』改为具体的行动值」）。
    // ⚠️ **不能省** —— 界面手上只有 `tierLines` 这一处来源，缺了就退回
    // 「最好一档 / 次好一档」的兜底写法（那些词读起来不比「满分」有用）。
    // 只有 5 个副本，三条线加起来几十字节。
    tierLines: env.tierLines || null,
    /**
     * 逐版本的「0 行动值」金数区间（用户 2026-10-17 第 2、3 条：强度新口径的基准）。
     *
     * `{ [版本]: { min, max } }`。⚠️ **不能省**：`teamPlan`（抽卡方案的队伍强度）
     * 只读这一层投影后的 `frontierEnvs`，`frontierBoard` 读的是 `envs[]` 上同一份 ——
     * 这里漏一层，那一侧就静默退回「没有顶格档」，两个榜的强度口径还会因此分叉。
     * 只有 5 个副本、每副本最多 7 期，几十字节。
     */
    zeroAvGoldBySeason: env.zeroAvGoldBySeason || null,
    // `minCost`（全窗口最小值）保留仅供展示/兜底：**算分用的是逐条下发的
    // `unit.envs[].seasonMinCost`**（用户 2026-10-10 第 5 轮：金数项按版本归一，
    // 不拿全窗口最小值当所有版本的分母 —— 那会罚「环境本身就难压金」的版本）。
    minCost: env.minCost,
    // 逐版本的最便宜金数（`版本 -> 金数`）：界面解释金数项、排查时用得上。
    minCostBySeason: env.minCostBySeason || {},
    maxCost: env.maxCost,
    minAction: env.minAction,
    maxAction: env.maxAction,
    // 行动值项的区间边界与方向（5%~95% 分位，见 advice.js 的 `avTerm`）：
    // 界面把一条贡献拆成「来源」时要按算分用的同一条尺子复现，所以必须下发 ——
    // `minAction` / `maxAction` 是最值，拿它们算会和榜上的分对不上。
    // 只有 5 个副本，多这两个数可以忽略不计。
    avLo: env.avLo ?? null,
    avHi: env.avHi ?? null,
    lowerIsBetter: env.lowerIsBetter !== false,
    // 版本维度（用户第 7 条）：窗口内的版本数与每个版本的权重（2:2:2:1:1:1:1）。
    // 只有 5 个副本，带上它界面才能写清「按 N 个版本加权、缺证据的版本怎么补」，
    // 而不必自己再抄一遍权重表。`seasons` **新的在前**（与内部权重表同序；刻意不按
    // 字典序排 —— 版本号迟早出现 4.10，字典序会把它排到 4.2 前面）。
    versionWindow: env.versionWindow ?? null,
    seasons: env.seasons || [],
    seasonWeights: env.seasonWeights || {},
    // 「行动值前沿」（用户 2026-10-16 第 2 条）：本关卡最近一版行动值最好的几支队伍。
    // 抽卡推荐的候选池靠它把「各种 0 行动值队伍」补进来（见 `buildAvTeams` 注释：
    // 实测那些队永远不会成为谁的性价比证据队）。每关 8 支 × 5 关 ≈ 40 条、每条
    // 只带 roster 与标量，实测 **+15 KB**（40 行 15374 字节）。
    avTeams: env.avTeams || [],
  })),
  // 总榜的口径标记：**只发一份**（每条整包都带一份会把载荷白涨 28 KB —— 实测）。
  frontierBasis: 'team-gold-frontier-pack',
  // 总榜的过滤器按完整结果计数；截断会让 200 名以后的整包永远无法查询/显示。
  frontierUnits: (result.frontierUnits || []).map((unit, i) => slimFrontierUnit(unit, i)),
  // 逐星魂档的总榜（用户 2026-10-11 报的缺陷）：`{ "0": […], "1": […], "2": […], "6": […] }`，
  // 每档**各自按角色收敛一条**。界面上的 E0/E1/E2/E6 筛选就切到这一份。
  //
  // 为什么不能省：`frontierUnits` 每角色只有一条（总分最高的整包），界面拿它过滤
  // 就只剩「最佳成绩落在这一档」的角色 —— 实测 51 个有 E0 整包的角色里有 33 个
  // 在 E0 页里看不到。四档合计 156 条（全量未收敛是 960 条 / 1.7 MB），
  // 实测让 `/conclusion` 从 ~189 KB 涨到 ~330 KB，仍在 e2e 的 600 KB 硬上限内。
  //
  // ⚠️ 键与元素都走 `slimFrontierUnit`，与 `frontierUnits` 完全同构 —— 界面因此
  // 可以拿同一套渲染函数吃两份数据。
  //
  // ⚠️ **逐档榜只带「最好的那一个关卡」的明细**（`maxEnvs = 1`）：它是「这个角色抽到
  // 这一档值多少分」的索引，逐关卡的完整拆解以「全部」那一页为准。收尾合并时才加的
  // 这一刀 —— 池改成「全部成绩」之后四档合计 266 条，每条都带 5 个关卡的明细会让
  // `/conclusion` 冲到 **872 KB**、顶穿 e2e 的 600 KB 硬上限；只留最好一关之后回到
  // ~410 KB。`envCount` 仍照发，界面照旧写「等 N 个副本」。
  // ⚠️ **四个参数都要给全**：`withVideo = true` 是这份榜单**独有**的（抽卡方案的候选池
  // 就是它，方案的队伍卡片需要来源视频图标；总榜那条路走按需的 `/api/archive/packs`）。
  frontierTiers: Object.fromEntries(Object.entries(result.frontierTiers || {})
    .map(([tier, rows]) => [tier, (rows || []).map((unit, i) => slimFrontierUnit(unit, i, 1, true))])),
  // 三个分项的**归一上下限**（用户 2026-10-13：「给出强度、性价比、泛用性的完整得分来源」）。
  // ⚠️ 它是**整榜一份**的对象（~110 字节），必须放在这里 —— 逐条挂到整包上会重复 319 次、
  //    白花 33 KB（实测能把载荷顶到 598 KB，硬上限是 600 KB）。界面从
  //    `state.conclusion.frontierExtents` 读。
  frontierExtents: result.frontierExtents || null,
  gapUnits: (result.gapUnits || []).slice(0, 30).map((u) => ({
    key: u.key, kind: u.kind, name: u.name, nameCn: u.nameCn || null, icon: u.icon || null,
    total: u.total, gap: u.gap, pulls: u.pulls, from: u.from, target: u.target,
    envCount: u.envCount, gapTarget: u.gapTarget || null,
  })),
  eidolonUnits: (result.eidolonUnits || []).slice(0, 40).map((u) => ({
    key: u.key, kind: u.kind, name: u.name, nameCn: u.nameCn || null, icon: u.icon || null,
    from: u.from, target: u.target, pulls: u.pulls, minCost: u.minCost, floorCost: u.floorCost,
    gapToFloor: u.gapToFloor, isFloor: u.isFloor, sampleCount: u.sampleCount, envId: u.envId,
    score: u.score,
  })),
  packages: (result.packages || []).slice(0, 24).map(slimPack),
  counts: result.counts,
});

/**
 * @param {{owned?:Set<string>|string[], eidolons?:Map<string,number>|object,
 *          cones?:Map<string,number>|object}} account  账号持有情况（英文数据集键）
 */
export const archiveConclusion = async (account = {}, options = {}) => {
  const index = await archiveIndex();
  const i18n = await loadI18n();
  // 环境（版本选取 + 阵容表）由 `conclusionEnvs` 统一提供，探针与生产共用同一份。
  // ⚠️ `versionWeights` 必须一起传（v4.6.117 修的缺陷）：聚合层的跨版本加权与
  // `avTeams` 的选行都按这张表算，漏了它 = 抽卡方案永远按默认表（6:5:4:3:2:1）。
  const { envs, skipped, window } = await conclusionEnvs(index, {
    window: options.window,
    versionWeights: options.versionWeights,
  });

  // 账号状态在浏览器里是一组中英混合的键，客户端已经过滤成数据集英文键，
  // 这里只做「Map / 普通对象都收」的兼容，不再猜名字。
  const asMap = (value) => {
    if (value instanceof Map) return value;
    if (value && typeof value === 'object') return new Map(Object.entries(value));
    return new Map();
  };
  const asSet = (value) => {
    if (value instanceof Set) return value;
    if (Array.isArray(value)) return value;
    return [];
  };

  // 压金出分前沿强度（用户 2026-10 的口径）：每个副本各自汇总，带副本权重。
  // 这是推荐排序的主键来源 ——「绝境王棋压金出分榜单里经常出现的角色十分强力」。
  // 读失败不让整页挂掉：没有它排序会退回旧的「档位 × 质量」口径。
  let frontier = {};
  try {
    // 前沿表带的是**总榜口径**的权重（界面上「总榜权重」那一行）：
    // 它只服务性价比总榜与「和主流强阵的差距」这两处展示，与抽卡方案各自独立。
    //
    // ⚠️ 前沿的版本窗口**跟着用户「版本权重」的档位数走**（2026-10-17 起档位可加删），
    // 不吃请求里的 `window`：这里要的是「用户那张表有几档就覆盖几版」—— 写死 6 会让
    // 用户点「加一版」之后总榜纹丝不动（`archiveFrontier` 的窗口 = 表长，与这里同源）。
    // 上面聚合层的 `window` 仍然按请求走 —— 它服务抽卡方案的阵容表，改它会连带改方案的口径。
    const all = await archiveFrontierAll(envs, {
      // 用上面 `conclusionEnvs()` 已经定下的那一份窗口（= 用户表的档位数，已收敛到上限）。
      window, weights: options.frontierWeights,
      // 用户自定义的版本权重（2026-10-16）：只影响「按版本加权」那一层
      // （`seasonWeights` 现算 + 客户端跨版本加权）。不传 = 默认 `VERSION_WEIGHTS`。
      versionWeights: options.versionWeights,
    });
    frontier = Object.fromEntries(all.map((f) => [f.env, f]));
  } catch (err) {
    console.warn('[frontier] 读取压金前沿失败：', err.message);
  }

  const result = buildConclusion(envs, {
    availability: index.refs?.availability || {},
    // 角色 / 光锥首次登场版本（用户第 6 条）：总榜只对「早于登场」的旧版本做放大推算。
    firstSeen: index.refs?.firstSeen || { characters: {}, lightCones: {} },
    account: {
      owned: new Set(asSet(account.owned)),
      eidolons: asMap(account.eidolons),
      cones: asMap(account.cones),
    },
    perEnvCandidates: options.perEnvCandidates,
    frontier,
    // 「够得着的强阵」允许差几金（用户在界面上自己定，见 advice-view 的「可及预算」）
    gapMaxPulls: options.gapMaxPulls,
    // 用户自定义的版本权重（2026-10-16）：没有服务端前沿表的夹具路也吃它。
    versionWeights: options.versionWeights,
    // 用户自定义的副本权重：**两套**（用户 2026-10 要求相互独立）。
    //   planWeights     → 抽卡方案 / 差距榜 / 星魂榜
    //   frontierWeights → 性价比总榜
    weights: options.planWeights,
    frontierWeights: options.frontierWeights,
    // 「隐金设置」（用户 2026-10-11）：五个开关，只影响性价比总榜那条链
    // （抽卡方案 / 差距榜 / 星魂榜不受影响，用户明确选了「只影响总榜」）。
    // 不传 = 一项都不减（工具与回归测试的历史口径不变，见 `DEFAULT_HIDDEN_COSTS`）。
    hiddenCosts: options.hiddenCosts,
    // 抽卡权重（用户 2026-10-13 第 1、2 条）：**角色总榜**的三个分项按它加权，
    // 而总榜的收敛（每角色留一条）就发生在 `buildConclusion` 里 —— 所以这个旋钮
    // 必须**进服务端**，不能像 v4.6.94 那样只留在浏览器（那时它只服务抽卡方案）。
    // 不传 = `SCORING.drawWeight`（默认 `4 : 5 : 1` → `0.4 / 0.5 / 0.1`；
    // 2026-10-18 的新默认，上一版是 `1 : 1 : 0.5` → `0.4 / 0.4 / 0.2`），
    // 工具与探针的历史口径因此不变。
    drawWeights: options.drawWeights,
  });
  localizeConclusion(result, i18n);

  return {
    ok: true,
    available: true,
    window,
    minSeasonRuns: index.minSeasonRuns,
    latestSeason: index.latestSeason,
    // 只把界面真正要用的字段发给浏览器（见 `projectConclusion` 的注释）。
    // 版本：v4 = 总榜改成「整包」口径（角色 + 星魂档 + 光锥一条），
    // 客户端可据此识别返回形状（v3 及以前是角色/星魂/光锥三行）。
    // v5 = 新增 `hiddenCosts` 回显（用户 2026-10-11 的「隐金设置」）。
    // v6 = 新增 `availability`（星级 / 常驻标记）：**队伍抽卡方案**改成由界面现算
    //      差额（用户 2026-10-11 第 10 轮），缺这张表界面会把 4★ 也算成 1 金。
    // v7 = 新增 `frontierTiers`（总榜按 E0/E1/E2/E6 分档，每档各自按角色收敛一条）。
    //      ⚠️ 两支并行分支各自把载荷写成 v6（一支加 `availability`、一支加 `frontierTiers`），
    //      合并后两份都在，所以形状号必须是 **7** —— 别再改回 6。
    // ⚠️ **没有 v8**：v4.6.87 曾把形状写成 8（总榜每个整包多一个 `strength`，纯强度），
    //    v4.6.91 按用户 2026-10-12 第 8 条撤销了那个字段，形状**回到 7**。
    // v8 = 新增三个分项与合成后的「角色得分」（`characterScore` / `strengthScore` /
    //      `costScore` / `versatilityScore` / `strengthTotal` / `versatilityRaw`，
    //      逐 env 另加 `envStrength` / `envStrengthValue`），以及请求侧的 `drawWeights` 回显
    //      —— 用户 2026-10-13 第 1、2 条（「性价比得分」改名「角色得分」）。
    //      ⚠️ **8 曾被用过又撤掉**（见上一条），所以这里曾是**第一次真正生效的 v8**。
    //      ⚠️ 上面那行原先把逐 env 的字段写成 `strength` / `strengthValue` —— 那是**错的**，
    //      实际下发的是 `envStrength` / `envStrengthValue`（刻意避开被撤销的字段名）。
    // v9 = 前 `FRONTIER_DETAIL_ROWS` 条新增 `versatilityMembers`（泛用性来源名单）与
    //      `extents`（三个分项的榜内归一上下限），逐 env 新增 `envStrengthBest`
    //      —— 用户 2026-10-13：「角色得分页面需要给出强度、性价比、泛用性的**完整得分来源**」。
    payload: 9,
    // 隐金设置：**回显服务端实际生效的那一份**（归一化后的五个布尔）。
    // 为什么值得多带这 ~90 字节（载荷形状因此升到 v5）：隐金要穿过四层才生效
    // （界面 → POST body → 路由 → buildConclusion），任何一层漏传都表现为
    // 「勾了没反应」，而榜面数字的变化很难分辨是「没生效」还是「生效了但数据里
    // 恰好没有这些单位」。e2e 直接断言这个回显，就能把「漏传」钉死在接口层。
    hiddenCosts: normalizeHiddenCosts(options.hiddenCosts),
    // 抽卡权重：**回显服务端实际生效的那一份**（归一化后和为 1 的三个键）。
    // 与 `hiddenCosts` 同一条理由 —— 它要穿过四层才生效（界面 → POST body → 路由 →
    // buildConclusion），任何一层漏传都表现为「拖了权重榜没动」。e2e 直接断言这个
    // 回显，就能把「漏传」钉死在接口层（用户 2026-10-13 第 2 条）。
    drawWeights: normalizeDrawWeights(options.drawWeights),
    // 成本口径表：`charCostOf` / `coneCostOf` 的输入（见 `slimAvailability`）。
    availability: slimAvailability(index.refs?.availability),
    ...projectConclusion(result),
    skipped,
  };
};
