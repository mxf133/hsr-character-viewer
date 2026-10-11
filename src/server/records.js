// 米游社官方的「高难副本战斗记录」。
//
// 官方战绩页能看到的四个副本，接口各有一个端点（端点名从官方 bundle 的 api 表里
// 读出来的，见 src/mihoyo/starrail.js 的注释）：
//
//   混沌回忆  /hkrpg/api/challenge        12 层，每层 2 间（第 12 层星启模式 3 间）
//   虚构叙事  /hkrpg/api/challenge_story   4 层，每层 3 间，每间带 score 与 buff
//   末日幻影  /hkrpg/api/challenge_boss    4 档难度，每间带积分 score 与 boss_defeated
//   异相仲裁  /hkrpg/api/challenge_peak    骑士关 ×3 + 王棋关（含绝境），另一套结构
//   三个模式的进度汇总 /hkrpg/api/challenge_brief
//
// 这些接口给的是**成绩摘要 + 队伍**，不是逐回合的战斗日志——米游社自己也不展示
// 那种东西。所以这里如实把能拿到的都摆出来：每间的四人队伍（含星魂）、通关时刻、
// 该层回合数（或每间积分）、祝福名、首领名、星数。
//
// 归一化是**纯函数**（`normalizeBattleRecords`），网络在 `fetchBattleRecords` 里，
// 这样归一化逻辑可以脱网测试。
import {
  getChallenge, getChallengeBrief, getChallengeBoss, getChallengeStory, getPeakChallenge,
} from '../mihoyo/starrail.js';

/** 四个副本 → 数据集里的模式短码（跨模式对照要用同一套键）。 */
export const MODE_OF_TYPE = {
  Chasm: 'moc', // 混沌回忆
  Story: 'pf', // 虚构叙事
  Boss: 'as', // 末日幻影
  Peak: 'aa', // 异相仲裁（brief 里没有它，单独一个端点）
};

/** 游戏里的副本顺序（汇总卡与明细块都按它排）。 */
export const MODE_ORDER = ['moc', 'pf', 'as', 'aa'];

/**
 * 开拓者的命途形态。
 *
 * 游戏文本表里 8001–8009 这些 id 全叫 `{NICKNAME}`，命途不在名字里，所以只能按
 * 记录里带的 `element` 认。四种已确认的形态都在这儿；认不出就只显示「开拓者」，
 * 不猜（猜错比不认更糟）。黑塔网那边用的是英文名，所以两个名字都留着。
 */
export const TRAILBLAZER_FORMS = {
  physical: { en: 'Trailblazer (Destruction)', cn: '开拓者•毁灭' },
  fire: { en: 'Trailblazer (Preservation)', cn: '开拓者•存护' },
  imaginary: { en: 'Trailblazer (Harmony)', cn: '开拓者•同谐' },
  ice: { en: 'Trailblazer (Remembrance)', cn: '开拓者•记忆' },
  quantum: { en: 'Trailblazer (Elation)', cn: '开拓者•欢愉' },
};

/** 属性英文名 → 中文（记录里给的是 fire/ice 这种英文）。 */
const ELEMENT_CN = {
  physical: '物理', fire: '火', ice: '冰', lightning: '雷',
  wind: '风', quantum: '量子', imaginary: '虚数',
};

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** 记录里的时间戳是 {year,month,day,hour,minute}，拼成 ISO 便于前端本地化显示。 */
const timeOf = (t) => {
  if (!t || !t.year) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${t.year}-${p(t.month)}-${p(t.day)}T${p(t.hour ?? 0)}:${p(t.minute ?? 0)}:00`;
};

/** 一个队伍成员：id → 中英名（含开拓者形态）。 */
const memberOf = (avatar, i18n) => {
  const id = String(avatar.id ?? '');
  const element = avatar.element || null;
  let cn = i18n?.charactersById?.[id]?.cn || null;
  let en = i18n?.charactersById?.[id]?.en || null;
  if (/^8\d{3}$/.test(id)) {
    const form = TRAILBLAZER_FORMS[element] || null;
    cn = form ? form.cn : (cn || '开拓者');
    en = form ? form.en : en;
  }
  return {
    id,
    nameCn: cn || `角色 ${id}`,
    nameEn: en || null,
    level: num(avatar.level),
    // 记录里 `rank` 就是星魂等级（0–6），和角色详情里的字段同名同义。
    eidolon: num(avatar.rank) ?? 0,
    rarity: num(avatar.rarity),
    element,
    elementCn: element ? (ELEMENT_CN[element] || element) : null,
    assist: Boolean(avatar.is_return_assist),
    // 头像：米游社自己的 CDN，界面直接用（角色页的头像也是从这里来的）。
    icon: avatar.icon || null,
  };
};

/**
 * 敌方信息：优先用米游社**官方**给的首领（只有末日幻影与异相仲裁有，带图标），
 * 官方没有的就用黑塔网赛程表里对上的那一期（混沌回忆 / 虚构叙事，只有名字与血量）。
 * 两边的叫法不一样（官方是游戏内称号「雷奔云谲的恶狼主」，站点是「步离战首•呼雷」），
 * 所以社区口径的名字单独放在 `datasetName` 里，只在 tooltip 出现。
 */
const enemyOf = (official, dataset) => {
  if (official?.name) {
    return {
      name: official.name,
      nameCn: official.name,
      icon: official.icon || null,
      hp: dataset?.hp || null,
      datasetName: dataset?.nameCn || null,
      official: true,
      version: dataset?.version || null,
    };
  }
  if (dataset?.nameCn || dataset?.name) {
    return {
      name: dataset.nameCn || dataset.name,
      nameCn: dataset.nameCn || dataset.name,
      nameEn: dataset.name || null,
      icon: null,
      hp: dataset.hp || null,
      datasetName: null,
      official: false,
      version: dataset.version || null,
    };
  }
  return null;
};

/** 一间（node_1 / node_2 / node_3）→ 队伍 + 时刻 + 该间的积分/祝福 + 敌方。 */
const nodeOf = (node, index, i18n, official, dataset) => {
  if (!node) return null;
  const members = (node.avatars || []).map((a) => memberOf(a, i18n));
  if (!members.length) return null;
  return {
    index,
    time: timeOf(node.challenge_time),
    members,
    enemy: enemyOf(official?.[index - 1], dataset?.[index - 1]),
    score: num(node.score),
    trend: num(node.trend),
    bossDefeated: typeof node.boss_defeated === 'boolean' ? node.boss_defeated : null,
    buffName: node.buff?.name_mi18n || null,
    buffDesc: node.buff?.desc_mi18n || null,
    // 站点还给了一份「简短说明」，比完整描述短，留作 tooltip 备选
    buffShort: node.buff?.simple_desc_mi18m || null,
  };
};

const nodesOf = (floor, i18n, official, dataset) => ['node_1', 'node_2', 'node_3']
  .map((key, i) => nodeOf(floor[key], i + 1, i18n, official, dataset))
  .filter(Boolean);

/** 赛程（本期/上期）：起止时间 + 状态。 */
const seasonOf = (group) => (group ? {
  id: String(group.schedule_id ?? group.group_id ?? ''),
  name: group.name_mi18n || null,
  status: group.status || null,
  begin: timeOf(group.begin_time),
  end: timeOf(group.end_time),
  version: group.game_version || null,
} : null);

/** 混沌回忆 / 虚构叙事 / 末日幻影 都是同一套 all_floor_detail 结构。 */
const floorsOf = (data, i18n, official, dataset) => (data?.all_floor_detail || []).map((floor) => ({
  name: floor.name || null,
  stars: num(floor.star_num),
  // 末日幻影没有 round_num（它的成绩是每间的积分）。
  rounds: num(floor.round_num),
  extraStars: num(floor.extra_star_num),
  fast: Boolean(floor.is_fast),
  tierce: Boolean(floor.is_tierce),
  nodes: nodesOf(floor, i18n, official, dataset),
}));

/** 本期赛程（`Running` / `New` 那一条）。 */
const currentGroupOf = (groups) => (groups || []).find((g) => g.status === 'Running' || g.status === 'New')
  || (groups || [])[0] || null;

/** 末日幻影的官方首领：上半 / 下半 / 第三间，正好按间号对位。 */
const officialBossesOf = (data) => {
  const group = currentGroupOf(data?.groups);
  if (!group) return null;
  const list = [group.upper_boss, group.lower_boss, group.tierce_boss]
    .map((boss) => (boss?.name_mi18n ? { name: boss.name_mi18n, icon: boss.icon || null } : null));
  return list.some(Boolean) ? list : null;
};

const challengeLikeOf = (data, i18n, dataset) => {
  if (!data) return null;
  const groups = data.groups || [];
  const official = officialBossesOf(data);
  return {
    stars: num(data.star_num),
    runs: num(data.battle_num),
    extraStars: num(data.extra_star_num),
    hasData: Boolean(data.has_data),
    maxFloorId: num(data.max_floor_id),
    current: seasonOf(currentGroupOf(groups)),
    previous: seasonOf(groups.find((g) => g.status === 'End') || groups[1]),
    seasons: groups.map(seasonOf),
    // 敌方名单的来源：官方（末日幻影）还是黑塔网赛程表（混沌回忆 / 虚构叙事）；
    // `behind` 表示本地数据集还没收录这一期（界面据此提示去点「同步黑塔网数据」）
    enemySeason: dataset ? {
      version: dataset.version,
      source: dataset.source,
      window: dataset.window,
      sides: dataset.sides,
      behind: Boolean(dataset.behind),
    } : (official ? { source: 'mihoyo' } : null),
    floors: floorsOf(data, i18n, official, dataset?.list || null),
  };
};

/**
 * 异相仲裁：骑士关（mob）×3 + 王棋关（boss，含绝境），另一套结构。
 *
 * 这个端点按 `schedule_type` 分页，实测（本机账号）：
 *   schedule_type=1 → 当前赛程的**一条**记录（含骑士关 3 关 + 王棋关）
 *   schedule_type=2 → 同一赛程的更多场次
 *   schedule_type=3 → **跨赛程**的历史（4.6 / 4.5 / 4.4），并且**只有这一页出现过
 *                    `hard_mode: true`（绝境王棋关）**，而且这一页不给 best 汇总
 * 官方页面怎么翻我们没有证据（缓存里的 arbitration chunk 只有公共代码，没有调用点），
 * 所以这里如实按「第 1 页 + 第 3 页」抓，再按赛程合并 —— 只有第 1 页会漏掉绝境，
 * 只有第 3 页会漏掉当前赛程的汇总。
 *
 * 合并粒度是**赛程**（group_id）：同一赛程里骑士关三关只显示一次（取星数最高的那场），
 * 王棋关的「普通」与「绝境」各占一行——`boss_record.hard_mode` 就是判据。
 */
const peakOf = (data, i18n) => {
  if (!data) return null;
  const records = data.challenge_peak_records || [];
  const best = data.challenge_peak_best_record_brief || null;

  const recordOf = (entry) => {
    if (!entry || entry.has_challenge_record === false) return null;
    const members = (entry.avatars || []).map((a) => memberOf(a, i18n));
    if (!members.length) return null;
    return {
      time: timeOf(entry.challenge_time),
      rounds: num(entry.round_num),
      stars: num(entry.star_num),
      members,
      hard: Boolean(entry.hard_mode),
      rankIconType: entry.challenge_peak_rank_icon_type || null,
      medal: Boolean(entry.finish_color_medal),
    };
  };
  const better = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    const ka = (a.stars || 0) * 100 - (a.rounds ?? 99);
    const kb = (b.stars || 0) * 100 - (b.rounds ?? 99);
    return kb > ka ? b : a;
  };

  const byGroup = new Map();
  for (const rec of records) {
    const group = seasonOf(rec.group);
    const id = group?.id || String(rec.group?.group_id ?? '?');
    if (!byGroup.has(id)) {
      byGroup.set(id, {
        id,
        group,
        mobStars: num(rec.mob_stars),
        bossStars: num(rec.boss_stars),
        battles: num(rec.battle_num),
        mobs: [],
        boses: [],
      });
    }
    const slot = byGroup.get(id);
    // 同一个赛程会有多场记录：星数/次数取最好的，队伍取更好的那一场。
    slot.mobStars = Math.max(slot.mobStars ?? 0, num(rec.mob_stars) ?? 0) || null;
    slot.bossStars = Math.max(slot.bossStars ?? 0, num(rec.boss_stars) ?? 0) || null;
    slot.battles = Math.max(slot.battles ?? 0, num(rec.battle_num) ?? 0) || null;
    const mobRecords = rec.mob_records || [];
    (rec.mob_infos || []).forEach((mob, i) => {
      const record = recordOf(mobRecords[i]);
      if (!record) return;
      const name = mob.name || `骑士（${i + 1}）`;
      // 敌方就是这一关的首领本身，带官方图标
      const enemy = mob.monster_name ? {
        name: mob.monster_name,
        nameCn: mob.monster_name,
        icon: mob.monster_icon || null,
        hp: null,
        datasetName: null,
        official: true,
        version: null,
      } : null;
      const existing = slot.mobs.find((m) => m.name === name);
      if (existing) {
        existing.record = better(existing.record, record);
        existing.enemy = existing.enemy || enemy;
      } else {
        slot.mobs.push({ name, monster: mob.monster_name || null, enemy, record });
      }
    });
    const bossRecord = recordOf(rec.boss_record);
    if (rec.boss_info && bossRecord) {
      const entry = {
        hard: bossRecord.hard,
        name: rec.boss_info.name_mi18n || null,
        hardName: rec.boss_info.hard_mode_name_mi18n || null,
        enemy: rec.boss_info.name_mi18n ? {
          name: rec.boss_info.name_mi18n,
          nameCn: rec.boss_info.name_mi18n,
          icon: rec.boss_info.icon || null,
          hp: null,
          datasetName: null,
          official: true,
          version: null,
        } : null,
        record: bossRecord,
      };
      const existing = slot.boses.find((b) => b.hard === entry.hard);
      if (existing) existing.record = better(existing.record, entry.record);
      else slot.boses.push(entry);
    }
  }

  const groups = [...byGroup.values()]
    .map((slot) => ({
      ...slot,
      // 骑士关保持接口给的顺序（一 / 二 / 三）：按名字排会变成「二、三、一」，
      // 因为中文数字不在 `localeCompare` 的数值序里。
      mobs: slot.mobs,
      // 普通王棋关在前、绝境在后
      boses: slot.boses.sort((a, b) => Number(a.hard) - Number(b.hard)),
    }))
    // 赛程号大的在前（10 = 4.6、9 = 4.5、8 = 4.4，实测递增）。
    //
    // 别按 `status === 'Running'` 排：实测 4.6 那期是 End、4.5 那期反而是 Running
    // （大概是各期状态独立更新、并不代表「当前」），按它排会把 4.5 排到最前面，
    // 看起来像「本期是 4.5」。
    .sort((a, b) => (Number(b.group?.id || 0) - Number(a.group?.id || 0))
      || String(b.group?.version || '').localeCompare(String(a.group?.version || '')));

  return {
    hasData: groups.length > 0,
    hasMore: records.some((r) => r.has_challenge_record !== false) && Boolean(data.has_more_boss_record),
    best: best ? {
      battles: num(best.total_battle_num),
      mobStars: num(best.mob_stars),
      bossStars: num(best.boss_stars),
      rankIconType: best.challenge_peak_rank_icon_type || null,
      rankIcon: best.challenge_peak_rank_icon || null,
    } : null,
    groups,
  };
};

/** 三个忘却之庭模式的进度汇总（星数/层数/次数/上期），一次请求拿到。 */
const briefOf = (data) => (data?.list || []).map((row) => ({
  type: row.challenge_type || null,
  mode: MODE_OF_TYPE[row.challenge_type] || null,
  current: row.cur_schedule ? {
    name: row.cur_schedule.group_name || null,
    floorName: row.cur_schedule.finish_floor_name || null,
    stars: num(row.cur_schedule.finish_star_count),
    totalStars: num(row.cur_schedule.total_star_count),
    floors: num(row.cur_schedule.finish_floor_num),
    runs: num(row.cur_schedule.times),
    extraStars: num(row.cur_schedule.extra_star_count),
    // 注意：这是「这个副本**有**星启模式这一档」的内容属性，不是「玩家打过了」。
    hasTierce: Boolean(row.cur_schedule.has_tierce),
  } : null,
  previous: row.last_schedule ? {
    name: row.last_schedule.group_name || null,
    stars: num(row.last_schedule.finish_star_count),
    totalStars: num(row.last_schedule.total_star_count),
    floors: num(row.last_schedule.finish_floor_num),
    runs: num(row.last_schedule.times),
  } : null,
}));

/**
 * 五个响应 → 一个给界面用的结构。纯函数（可脱网测试）。
 *
 * @param {{ challenge?:any, story?:any, boss?:any, peak?:any, brief?:any,
 *           i18n?:any, uid?:string, server?:string, fetchedAt?:string,
 *           errors?:Array<{endpoint:string,message:string}>, stale?:boolean }} input
 */
export const normalizeBattleRecords = (input = {}) => {
  const { i18n = null, errors = [], enemies = {} } = input;
  const brief = briefOf(input.brief);
  const peak = peakOf(input.peak, i18n);

  // brief 只覆盖三个忘却之庭模式（Boss/Chasm/Story），异相仲裁要从它自己的端点拼。
  const summary = [...brief];
  const peakBest = peak?.best || null;
  const peakGroup = peak?.groups?.[0] || null;
  const peakHard = peakGroup?.boses?.find((b) => b.hard) || null;
  if (peak && (peak.groups?.length || peakBest)) {
    const mobStars = peakBest?.mobStars ?? peakGroup?.mobStars ?? null;
    const bossStars = peakBest?.bossStars ?? peakGroup?.bossStars ?? null;
    summary.push({
      type: 'Peak',
      mode: 'aa',
      current: {
        name: peakGroup?.group?.name || null,
        version: peakGroup?.group?.version || null,
        // 王棋关如果打过绝境就写绝境那个名字，否则写普通王棋关的首领名
        floorName: peakHard?.hardName || peakGroup?.boses?.[0]?.name || null,
        stars: mobStars != null || bossStars != null ? (mobStars || 0) + (bossStars || 0) : null,
        // 异相仲裁没有「满星」这种总数，骑士关 9★ + 王棋关 3★ 就是满分
        totalStars: (mobStars != null || bossStars != null) ? (mobStars || 0) + (bossStars || 0) : null,
        mobStars,
        bossStars,
        floors: (peakGroup?.mobs?.length || 0) + (peakGroup?.boses?.length || 0) || null,
        // 异相仲裁的 `battle_num` 是「这场记录打了几场」，不是赛程总次数；
        // 这里用 best 汇总里的累计战斗数（账号级），界面上标成「累计战斗 N 次」。
        runs: peakBest?.battles ?? peakGroup?.battles ?? null,
        runsLabel: '累计',
        extraStars: null,
        // 异相仲裁这里是真的「打过了绝境王棋关」（与 brief 的 hasTierce 不同，
        // 那个只是「这个副本有星启模式这一档」的内容属性）。
        clearedHard: Boolean(peakHard?.record),
        rankIconType: peakBest?.rankIconType || null,
        rankIcon: peakBest?.rankIcon || null,
      },
      previous: null,
    });
  }

  return {
    ok: true,
    uid: input.uid ? String(input.uid) : null,
    server: input.server || null,
    fetchedAt: input.fetchedAt || new Date().toISOString(),
    stale: Boolean(input.stale),
    partial: errors.length > 0,
    errors,
    // 汇总按游戏里的副本顺序排（brief 给的是 Boss/Chasm/Story，读起来别扭）。
    // 异相仲裁不在 brief 里，上面单独拼进 summary。
    summary: summary.sort((a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode)),
    modes: {
      moc: challengeLikeOf(input.challenge, i18n, enemies.moc || null),
      pf: challengeLikeOf(input.story, i18n, enemies.pf || null),
      as: challengeLikeOf(input.boss, i18n, enemies.as || null),
      aa: peak,
    },
    brief,
  };
};

/**
 * 合并异相仲裁的两页：按 `record_unique_key` 去重（缺这个字段时退化成
 * 「赛程 + 首领 + 时间」），best 汇总取有值的那一份。
 */
const mergePeakPages = (page1, page3) => {
  if (!page1 && !page3) return null;
  const records = [];
  const seen = new Set();
  const keyOfRecord = (rec) => {
    const boss = rec.boss_record || {};
    if (boss.record_unique_key) return boss.record_unique_key;
    const t = boss.challenge_time || {};
    return `${rec.group?.group_id ?? '?'}|${boss.maze_id ?? '?'}|${t.year}-${t.month}-${t.day}-${t.hour}-${t.minute}`;
  };
  for (const page of [page1, page3]) {
    for (const rec of page?.challenge_peak_records || []) {
      const key = keyOfRecord(rec);
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(rec);
    }
  }
  return {
    challenge_peak_records: records,
    has_more_boss_record: Boolean(page1?.has_more_boss_record || page3?.has_more_boss_record),
    challenge_peak_best_record_brief: page1?.challenge_peak_best_record_brief
      || page3?.challenge_peak_best_record_brief || null,
    role: page1?.role || page3?.role || null,
  };
};

/**
 * 真去米游社抓一份**原始**响应。各请求彼此独立：某个失败（10035/10041/超时）就记进
 * `errors` 并继续，界面照旧显示其它几个——不因为一个端点挂了就整块空白。
 *
 * 1034（需要先过验证码）会以 error.code = 'CHALLENGE_REQUIRED' 抛出，交给上层走
 * 验证流程，这一点与角色快照一致。
 *
 * 存的是原始 JSON 而不是归一化结果：原始数据一共只有 ~56 KB，而这样「归一化逻辑
 * 改了」不用重新打米游社（读缓存时现算即可），以后想多显示一个字段也不用重抓。
 *
 * 异相仲裁要抓两页：第 1 页是当前赛程（骑士关三关 + 王棋关，还有 best 汇总），
 * 第 3 页才是跨赛程的历史、也**只有它带 `hard_mode: true`（绝境王棋关）**。
 */
export const fetchBattleRecordsRaw = async (uid, server, options = {}) => {
  const shared = {
    cookie: options.cookie,
    deviceId: options.deviceId,
    deviceFp: options.deviceFp,
    challenge: options.challenge,
  };
  const targets = [
    ['challenge', () => getChallenge(uid, server, 1, shared)],
    ['story', () => getChallengeStory(uid, server, 1, shared)],
    ['boss', () => getChallengeBoss(uid, server, 1, shared)],
    ['peak', () => getPeakChallenge(uid, server, 1, shared)],
    ['peak3', () => getPeakChallenge(uid, server, 3, shared)],
    ['brief', () => getChallengeBrief(uid, server, shared)],
  ];
  const settled = await Promise.all(targets.map(async ([key, run]) => {
    try {
      return [key, await run(), null];
    } catch (err) {
      return [key, null, { endpoint: key, message: err?.message || String(err), retcode: err?.retcode ?? null }];
    }
  }));

  const raw = {};
  const errors = [];
  for (const [key, value, error] of settled) {
    if (error) {
      // 1034 是「先过验证码」，不是「没有数据」：必须让用户看到验证入口。
      if (Number(error.retcode) === 1034) {
        const wrapped = new Error(error.message);
        wrapped.code = 'CHALLENGE_REQUIRED';
        wrapped.retcode = 1034;
        throw wrapped;
      }
      errors.push(error);
      continue;
    }
    raw[key] = value;
  }
  raw.peak = mergePeakPages(raw.peak, raw.peak3);
  delete raw.peak3;

  return {
    uid: String(uid),
    server,
    fetchedAt: new Date().toISOString(),
    errors,
    raw,
  };
};

/** 抓一份并直接归一化（探针/测试用；服务端走 存原始 → 读时归一化 那条路）。 */
export const fetchBattleRecords = async (uid, server, options = {}) => {
  const stored = await fetchBattleRecordsRaw(uid, server, options);
  return normalizeBattleRecords({
    ...stored.raw,
    uid,
    server,
    fetchedAt: stored.fetchedAt,
    errors: stored.errors,
    i18n: options.i18n,
  });
};
