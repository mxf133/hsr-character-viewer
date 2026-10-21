/**
 * 抽卡推荐 v2 · 投稿评分（服务端纯函数）
 *
 * 这一份是 §一「投稿得分」与「角色整包得分」的**唯一实现**，刻意不碰 IO：
 * 输入是一排 frontier 行（`{season, c, a, t, n, m}`），输出是带分的行 + 整包分。
 * 谁要算都走这里，浏览器端不再自己抄一遍公式。
 *
 * 公式（逐字按需求文档，见 `docs/抽卡推荐重构设计.md` §3）：
 *
 *   行动值型（绝境 / 末日幻影）
 *     强度得分 = 强度权重 × (1 − 行动值 / 500)
 *     性价比得分 = 该版本 <500 行动值的最低金 / 此配队使用金
 *   轮次型（混沌 / 虚构 / 异相仲裁骑士关）
 *     强度得分 = 强度权重 / (轮次 + 1)
 *     性价比得分 = 该版本 0T 的最低金 / 此配队使用金
 *   投稿得分 = 强度得分 + 性价比权重 × 性价比得分
 *
 * ⚠️ 强度项已经乘过 `ws`，投稿得分里**只**给成本项乘 `wc`。这是需求文档的写法，
 *    不要「顺手对称化」把它改成 `ws × 强度 + wc × 成本` —— 那是另一套模型。
 *
 * ⚠️ 两处必须防御的特殊值（0 金队与无基准），见 `baselineOf` 与 `costPartOf` 的注释。
 */

import {
  AV_CAP, baselineOf, costPartOf, envKindOf, finiteOf, strengthPartOf,
} from '../../public/scripts/v2-score.js';

// ------------------------------------------------------------------ 判据类型

// ⚠️ `AV_ENVS` / `envKindOf` / `finiteOf` / `AV_CAP` / `baselineOf` /
//    `strengthPartOf` / `costPartOf` 的**唯一实现**在
//    `public/scripts/v2-score.js` —— 角色总榜在浏览器端算（`advice.js`
//    的 `frontierBoard`）、抽卡方案在服务端算，两边必须同一份公式，
//    否则「两套跨版本聚合各写一遍、必然分叉」（v4.6.139 审计的真问题三）。
//    这里 re-export 只为保持既有导入路径（`tools/gacha-score-test.mjs` 等）不变。
export {
  AV_CAP, baselineOf, costPartOf, envKindOf, finiteOf, strengthPartOf,
};

// ------------------------------------------------------------------ 星魂档

/** 参与比较的四个星魂档（与旧版一致）。 */
export const EIDOLON_TIERS = Object.freeze([0, 1, 2, 6]);

/** 真实星魂级数 → 比较用的档。E3~E5 归到 E2（它们不构成独立的推荐目标）。 */
export const eidolonTierOf = (level) => {
  const n = Number(level);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 6) return 6;
  if (n >= 2) return 2;
  return 1;
};

// ------------------------------------------------------------------ 成员与整包

/**
 * `frontier.m[]` 的写法是 `"字符名|星魂|光锥|叠影"`。
 * 拆出一个结构化对象；`superimp` 缺省按 0（没装 = 没叠影，不是叠影 1）。
 */
export const memberOf = (text) => {
  const [char, eidolon, lc, superimp] = String(text || '').split('|');
  return {
    char: char || '',
    eidolon: Number.isFinite(Number(eidolon)) ? Number(eidolon) : 0,
    lc: lc || null,
    superimp: Number.isFinite(Number(superimp)) ? Number(superimp) : 0,
  };
};

/**
 * 「角色整包」= 角色 + 星魂档 + 光锥 + 叠影，**四样一起**才算一个可比较单位。
 *
 * 星魂要过 `eidolonTierOf` 归并：否则同为 E3 与 E4 的投稿会被当成两个不同整包，
 * 各自只有零星投稿，整包得分被人为稀释。
 */
export const packKeyOf = (member) => {
  const m = typeof member === 'string' ? memberOf(member) : member;
  return `${m.char}|E${eidolonTierOf(m.eidolon)}|${m.lc || '-'}|S${m.superimp}`;
};

/** 从整包键反解出结构（渲染要展示 E 几 / S 几）。 */
export const packOf = (key) => {
  const [char, eidolon, lc, superimp] = String(key).split('|');
  return {
    char,
    eidolon: Number(String(eidolon).replace(/^E/, '')) || 0,
    lc: lc === '-' ? null : lc,
    superimp: Number(String(superimp).replace(/^S/, '')) || 0,
  };
};

// ------------------------------------------------------------------ 打分

// ⚠️ 基准最低金（`baselineOf`）与两个分量（`strengthPartOf` / `costPartOf`）
//    已外迁到 `public/scripts/v2-score.js`（见文件头部 import 与 re-export），
//    这里只留「整批行打分」的入口。

/** 一条投稿的得分。 */
export const scoreRow = (row, ctx) => {
  const { kind, baseline, ws = 1, wc = 1 } = ctx;
  const strengthPart = strengthPartOf(row.a, kind, ws);
  const costPart = costPartOf(row.c, baseline);
  return { strengthPart, costPart, score: strengthPart + wc * costPart };
};

// ------------------------------------------------------------------ 逐版本打分

/**
 * baseline 是**逐版本**的（「投稿所在版本、且用户选择的模式的最低金」），
 * 所以打分前先按 season 分组。
 */
export const groupBySeason = (rows) => {
  const groups = new Map();
  for (const row of rows) {
    const key = row.season;
    let bucket = groups.get(key);
    if (!bucket) groups.set(key, (bucket = []));
    bucket.push(row);
  }
  return groups;
};

/**
 * 给一整个（关卡 × 版本窗口）的投稿打分，并带上版本权重。
 *
 * @param rows  `[{season, c, a, t, n, m, …}]`，同一关卡多版本混在一起
 * @param ctx   `{mode, stage, ws, wc, versionWeightOf(season)}`
 * @returns     排好 new→old 的 `{rows, baselines, seasons, rowsBySeason}`
 */
export const scoreEnvRows = (rows, ctx) => {
  const { mode, stage, ws = 1, wc = 1, versionWeightOf = () => 1 } = ctx;
  const kind = envKindOf(mode, stage);
  const groups = groupBySeason(rows);
  const baselines = new Map();
  const scored = [];

  for (const [season, list] of groups) {
    const baseline = baselineOf(list, kind);
    baselines.set(season, baseline);
    const weight = versionWeightOf(season) ?? 1;
    for (const row of list) {
      scored.push({
        ...row,
        season,
        kind,
        baseline,
        versionWeight: weight,
        ...scoreRow(row, { kind, baseline, ws, wc }),
      });
    }
  }
  return { kind, scored, baselines, seasons: [...groups.keys()] };
};

// ------------------------------------------------------------------ 角色整包得分

/**
 * §3.5 角色整包得分。
 *
 *   整包某版本得分 = 该版本投稿得分的**最高分** × 版本权重
 *   整包得分       = 所有版本投稿得分之和 / 版本权重之和
 *
 * **分母规则**（需求文档原话，两条缺一不可）：
 *   * 整包**未上线**（登场版本晚于该版本）→ 分子分母都**不计**
 *   * 整包**已上线但无投稿** → 分子记 **0**，分母**计入**
 *
 * 第二条是防止「只在最新一期露过脸的角色」白蹭高分：缺的分是 0，不是「不存在」。
 *
 * @param scored    `scoreEnvRows()` 的输出里的 scored 数组
 * @param ctx.seasons         窗口内的全部版本（new→old 或任意，但要全）
 * @param ctx.versionWeightOf (season) => number
 * @param ctx.debutSeasonOf    (packKey) => season | null；null = 查不到登场版本，视为一直在线
 * @param ctx.versionCmp       (a, b) => -1|0|1，版本先后
 *
 * ⚠️ **当前无生产调用点**（2026-10-21 审计结论）：角色总榜那条链真正生效的是
 *    `public/scripts/advice.js` 的 `frontierBoard()`（服务端 import 它来算），
 *    这一份是早期写的**备用实现**，只有 `tools/gacha-score-test.mjs` 在引用。
 *    留着它有两面：真要换聚合口径时有个现成参照；但两套「跨版本聚合」并存
 *    必然分叉 —— **改聚合口径时两处都要动，或干脆删掉这份**。别在生产代码里
 *    顺手 import 它而不看 `frontierBoard` 是否才是线上在用的那份。
 */
export const aggregatePacks = (scored, ctx) => {
  const {
    seasons = [],
    versionWeightOf = () => 1,
    debutSeasonOf = () => null,
    versionCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }),
  } = ctx;

  // 第一趟：每个整包在**每个版本**上只留最高分。
  const bestByPackSeason = new Map();
  const packMembers = new Map();
  for (const row of scored) {
    for (const text of row.m || []) {
      const key = packKeyOf(text);
      if (!packMembers.has(key)) packMembers.set(key, memberOf(text));
      let bucket = bestByPackSeason.get(key);
      if (!bucket) bestByPackSeason.set(key, (bucket = new Map()));
      const prev = bucket.get(row.season);
      const score = row.score ?? 0;
      if (prev === undefined || score > prev.score) bucket.set(row.season, { score, row });
    }
  }

  // 第二趟：跨版本加权。
  const packs = [];
  for (const [key, bySeason] of bestByPackSeason) {
    const debut = debutSeasonOf(key);
    let weighted = 0;
    let weightSum = 0;
    const missing = [];
    for (const season of seasons) {
      // 未上线 ⇒ 这一版既不加分子也不加分母。
      if (debut && versionCmp(season, debut) < 0) continue;
      const weight = versionWeightOf(season) ?? 1;
      if (!(weight > 0)) continue;
      weightSum += weight;
      const hit = bySeason.get(season);
      if (hit) weighted += hit.score * weight;
      else missing.push(season);
    }
    packs.push({
      key,
      ...packOf(key),
      score: weightSum > 0 ? weighted / weightSum : 0,
      weightSum,
      // 哪些在线版本没有投稿（分子记 0）。UI 上用来解释「为什么分低」。
      missingSeasons: missing,
      seasons: bySeason.size,
    });
  }
  return packs.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
};

// ------------------------------------------------------------------ 上场率分层

/**
 * §5.1 四类口径，**按关卡类型分两套判据**。
 *
 * 行动值型：`通关 / <300 行动值 / 300~500 行动值 / 0T`
 * 轮次型  ：`通关 / 0T / 1T / 2T 及以上`
 *
 * @returns `[{key, label, match(row, kind)}]`
 */
const isAv = (row) => finiteOf(row?.a);

export const USAGE_BANDS_OF = {
  av: [
    { key: 'clear', label: '通关', match: () => true },
    { key: 'lt300', label: '小于 300 行动值', match: (r) => { const a = isAv(r); return a !== null && a < 300; } },
    { key: 'av300', label: '300 ~ 500 行动值', match: (r) => { const a = isAv(r); return a !== null && a >= 300 && a < AV_CAP; } },
    { key: 'zero', label: '0 行动值', match: (r) => isAv(r) === 0 },
  ],
  round: [
    { key: 'clear', label: '通关', match: () => true },
    { key: 'zero', label: '0T', match: (r) => isAv(r) === 0 },
    { key: 'r1', label: '1T', match: (r) => isAv(r) === 1 },
    { key: 'r2', label: '2T 及以上', match: (r) => { const a = isAv(r); return a !== null && a >= 2; } },
  ],
};

/**
 * 某一档的样本规模 —— UI 必须在饼图旁边把它印出来。
 *
 * ⚠️ 为什么必须印：轮次型投稿的**自选择偏差极端**。混沌回忆 4.5 实测 0T 占 95.6%，
 * 而「1T」这一档只有 3 条投稿。不标样本量的话，饼图会被当成「大家都打得到 1T」，
 * 而实际上只是没人往「打通就好」那一档投稿。
 *
 * @returns `{ submissions, entries }` —— 投稿**条数**（按 `n` 累加）与 frontier **行数**
 */
export const bandSampleOf = (rows, band) => {
  let submissions = 0;
  let entries = 0;
  for (const row of rows) {
    if (!band.match(row)) continue;
    entries += 1;
    submissions += Math.max(1, finiteOf(row.n) ?? 1);
  }
  return { submissions, entries };
};

/**
 * §三 的完整上场率：四类口径各一份 Top N，最后塞一个「其它」把剩下的并成一圈。
 *
 * @param rows  某一（关卡 × 版本）的 frontier 行
 * @param kind  `envKindOf()` 的结果
 * @returns `[{ key, label, submissions, entries, items: [{char, count, share, other?}] }]`
 *
 * 三条口径：
 *   * `share` 的分母是**角色人次**（一支队伍 4 个位置，Σshare = 1），不是投稿数 ——
 *     见 `usageByBand` 里那段注释；
 *   * 「其它」永远占最后一位，`other: true` 供 UI 换个颜色；
 *   * Top N 之外没有剩余角色时**不生成**「其它」（免得画出一个 0% 的扇形）。
 */
export const usageSummaryOf = (rows, kind, options = {}) => {
  const { top = 10, otherLabel = '其它' } = options;
  const bands = USAGE_BANDS_OF[kind] || USAGE_BANDS_OF.round;
  // 先落到 `out`，下面统一补 `shareOfClear` 再返回。
  const out = bands.map((band) => {
    const counts = usageByBand(rows, band);
    const { submissions, entries } = bandSampleOf(rows, band);
    const head = counts.slice(0, top).map((it) => ({ ...it, other: false }));
    const rest = counts.slice(top);
    if (rest.length) {
      // 其余角色的份额从 `counts` 现加，与 Top N **同源**，所以整个 items 的 Σshare 仍是 1。
      head.push({
        char: otherLabel,
        count: rest.reduce((n, r) => n + r.count, 0),
        share: rest.reduce((n, r) => n + r.share, 0),
        other: true,
      });
    }
    return { key: band.key, label: band.label, submissions, entries, items: head };
  });
  // v4.6.136 起，非通关档各带一个 `shareOfClear`（该档投稿数 ÷ 通关档投稿数）。
  //
  // 为什么要有它：四档**不是四分互斥** —— 轮次型的「通关」被 0T / 1T / 2T 精确切分
  // （混沌回忆近 6 期实测 5259 = 5104 + 84 + 71），行动值型的「0 行动值」嵌在
  // 「<300 行动值」内部。四张 Σ=100% 的环形图并排，读者很容易读成互斥的四类；
  // UI 在卡片标题旁印「占通关 x%」就是把这层结构挑明。它还兼任「这两张饼是不是
  // 几乎一样」的提示 —— 末日幻影的 <300 占通关 99.8%，两张饼肉眼无法区分。
  // 「通关」档自己是分母，不设该字段（前端据此不印）。
  const clearSubs = out.find((b) => b.key === 'clear')?.submissions ?? 0;
  for (const band of out) {
    if (band.key === 'clear') continue;
    band.shareOfClear = clearSubs > 0 ? band.submissions / clearSubs : null;
  }
  return out;
};

/**
 * 某一档里面的角色人次。
 *
 * ⚠️ **按 `row.n`（真实投稿数）累加，不是按行数**。同一套阵容常被拆出十几种配装变体，
 * 按行数计出来的是「配装变体数」而不是「多少人在玩」—— 实测 27901 行 vs 30627 条投稿。
 *
 * @returns `Map<charName, submissions>` 降序排列的数组
 */
export const usageByBand = (rows, band) => {
  const counts = new Map();
  for (const row of rows) {
    if (!band.match(row)) continue;
    // 缺省按 1 条记（老数据集没有 n 字段时不至于把这些投稿整个丢掉）；
    // ⚠️ `null` 必须一并兜住 —— Number(null) === 0 会让该行凭空消失。
    const submits = Math.max(1, finiteOf(row.n) ?? 1);
    // 同一行里同一角色只数一次（开拓者的多个形态是不同的 char 名，故不受影响）。
    for (const text of new Set(row.m || [])) {
      const char = memberOf(text).char;
      counts.set(char, (counts.get(char) || 0) + submits);
    }
  }
  // share 的分母是**全部角色人次之和**（不是投稿数）：一支队伍有 4 个位置，
  // 一圈下来 4 个角色各得一次，所以 Σcount ≈ 4 × Σn。用 Σn 当分母会得到
  // Σshare ≈ 4，饼图就讲不通了。
  let total = 0;
  for (const count of counts.values()) total += count;
  return [...counts.entries()]
    .map(([char, count]) => ({ char, count, share: total > 0 ? count / total : 0 }))
    .sort((a, b) => b.count - a.count || a.char.localeCompare(b.char));
};
