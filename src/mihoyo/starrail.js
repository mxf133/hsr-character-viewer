// Honkai: Star Rail game-record API (/game_record/app/hkrpg/api/...).
//
// Every path below returned a live (non-404) response during development:
//   index            -> player summary + showcase avatars
//   role/basicInfo   -> role level / nickname / region
//   avatar/info      -> detailed character build (POST)
//   challenge        -> Forgotten Hall / Memory of Chaos
//   rogue            -> Simulated Universe
// Requests are signed with DS2 and sent with the community headers.

import { APP_VERSION, ENDPOINTS, USER_AGENT } from './constants.js';
import { communityHeaders, request } from './http.js';
import { createDS } from './ds.js';
import { unwrap } from './errors.js';

const RECORD_ORIGIN = 'https://api-takumi-record.mihoyo.com';

/**
 * Signed request against the Star Rail record API.
 *
 * `options.challenge` carries an `x-rpc-challenge` obtained from the 1034
 * verification flow (see src/mihoyo/verification.js). Star Rail can answer 1034
 * just like Genshin does, so every call accepts it.
 *
 * @param {string} path e.g. 'index' or 'avatar/info'
 * @param {{ cookie:Record<string,string>|string, query?:Record<string,string|number>,
 *           body?:unknown, method?:string, deviceId?:string, challenge?:string,
 *           page?:string }} options
 */
export const recordRequest = async (path, options) => {
  const entries = Object.entries(options.query || {});
  const query = entries.map(([k, v]) => `${k}=${v}`).join('&');
  const method = options.method || (options.body ? 'POST' : 'GET');
  const url = `${ENDPOINTS.gameRecord}/${path}${query ? `?${query}` : ''}`;

  const headers = communityHeaders({
    'x-rpc-page': options.page || `${APP_VERSION}_#/sr`,
    'x-rpc-device_id': options.deviceId || undefined,
    // Sent by Snap Hutao on every record call; see src/mihoyo/devicefp.js.
    'x-rpc-device_fp': options.deviceFp || undefined,
    'DS': createDS({ query, body: options.body }),
  });
  // Present only when the account has cleared a 1034 verification.
  if (options.challenge) headers['x-rpc-challenge'] = options.challenge;
  // Drop undefined optional headers so fetch does not stringify them.
  for (const key of Object.keys(headers)) {
    if (headers[key] === undefined) delete headers[key];
  }

  const response = await request(url, {
    method,
    headers,
    body: options.body,
    cookie: options.cookie,
    origin: RECORD_ORIGIN,
  });
  return response;
};

const recordGet = async (path, query, options) =>
  unwrap(await recordRequest(path, { ...options, query }), options.action || path);

/** Player summary: level, nickname, achievement counts, and showcase avatars. */
export const getPlayerIndex = (uid, server, options) =>
  recordGet('index', { role_id: uid, server }, { ...options, action: '获取开拓者总览' });

/** Role level / nickname / region. */
export const getRoleBasicInfo = (uid, server, options) =>
  recordGet('role/basicInfo', { role_id: uid, server }, { ...options, action: '获取角色基本信息' });

/**
 * Detailed character builds.
 * Note: verified against the live service - this endpoint accepts GET with query
 * parameters; a POST (as some older references suggest) returns HTTP 405.
 */
export const getAvatarInfo = (uid, server, options) =>
  recordGet('avatar/info', { role_id: uid, server }, { ...options, action: '获取角色详情' });

/** Forgotten Hall / Memory of Chaos. `scheduleType` is 1 (current) or 2 (previous). */
export const getChallenge = (uid, server, scheduleType = 1, options = {}) =>
  recordGet(
    'challenge',
    { role_id: uid, server, schedule_type: scheduleType, need_all: true },
    { ...options, action: '获取忘却之庭记录' },
  );

/**
 * 另外三个高难副本的战斗记录。
 *
 * 端点名不是猜的：官方战绩页的 bundle（`snapref/sr-bundle/bundle.js`）里有一张
 * api 表，逐个对应到接口：
 *
 *   getChallenge      -> /hkrpg/api/challenge        忘却之庭（混沌回忆，12 层）
 *   getChallengeStory -> /hkrpg/api/challenge_story  虚构叙事（4 层 × 3 间）
 *   getChallengeBoss  -> /hkrpg/api/challenge_boss   末日幻影（4 档难度 × 3 间，判据是积分）
 *   getPeakChallenge  -> /hkrpg/api/challenge_peak   异相仲裁（骑士关 ×3 + 王棋关，含绝境）
 *   getChallengeBrief -> /hkrpg/api/challenge_brief  三个忘却之庭模式的进度汇总
 *
 * 注意 `grid_fight` 虽然像「棋盘」，官方调用它的是 getCurrencyWars（货币战争），
 * 不是异相仲裁。
 *
 * 结构差异（实测）：
 *   * 混沌回忆：每层 `round_num` = 该层总回合；每间只有 `avatars` + `challenge_time`。
 *   * 虚构叙事：每层 `round_num`；每间额外有 `score`（满分 40000）与 `buff`。
 *   * 末日幻影：**没有 round_num**，成绩在每间的 `score`（积分）里，另有 `boss_defeated`。
 *   * 异相仲裁：完全不同的结构（`challenge_peak_records[]` + `boss_record`），
 *     王棋关靠 `boss_record.hard_mode` 区分绝境。
 */
const challengeVariant = (path, action) => (uid, server, scheduleType = 1, options = {}) =>
  recordGet(path, { role_id: uid, server, schedule_type: scheduleType, need_all: true },
    { ...options, action });

export const getChallengeStory = challengeVariant('challenge_story', '获取虚构叙事记录');
export const getChallengeBoss = challengeVariant('challenge_boss', '获取末日幻影记录');
export const getPeakChallenge = challengeVariant('challenge_peak', '获取异相仲裁记录');

/** 三个忘却之庭模式的进度汇总（一次请求拿到 星数/层数/次数/上期）。 */
export const getChallengeBrief = (uid, server, options = {}) =>
  recordGet('challenge_brief', { role_id: uid, server },
    { ...options, action: '获取高难副本进度汇总' });

/** Simulated Universe. */
export const getRogue = (uid, server, scheduleType = 1, options = {}) =>
  recordGet(
    'rogue',
    { role_id: uid, server, schedule_type: scheduleType },
    { ...options, action: '获取模拟宇宙记录' },
  );

/**
 * Game-record card ("个人主页卡片").
 *
 * Unlike `/hkrpg/api/index`, this endpoint is NOT gated by the battle-record
 * visibility switches - it returned real data (活跃天数/已解锁角色/成就数) for an
 * account whose `index` answered 10035. It takes the miyoushe ACCOUNT id as
 * `uid`, and the list contains one entry per bound game (game_id 6 = Star Rail).
 *
 * @param {string} accountId miyoushe account id (cookie account_id / ltuid)
 */
export const getGameRecordCard = async (accountId, options = {}) => {
  const query = `uid=${accountId}`;
  const url = `https://api-takumi-record.mihoyo.com/game_record/card/wapi/getGameRecordCard?${query}`;
  const response = await request(url, {
    headers: communityHeaders({
      'x-rpc-page': `${APP_VERSION}_#/sr`,
      DS: createDS({ query }),
      ...(options.deviceId ? { 'x-rpc-device_id': options.deviceId } : {}),
      ...(options.deviceFp ? { 'x-rpc-device_fp': options.deviceFp } : {}),
    }),
    cookie: options.cookie,
    origin: RECORD_ORIGIN,
  });
  const data = unwrap(response, options.action || '获取战绩卡片');
  return Array.isArray(data?.list) ? data.list : [];
};

/** Star Rail entry of the record card, or null. game_id 6 = 崩坏：星穹铁道. */
export const getStarRailCard = async (accountId, options = {}) => {
  const list = await getGameRecordCard(accountId, options);
  return list.find((entry) => Number(entry.game_id) === 6) || null;
};

/**
 * The visibility switches for a game, from the record card.
 * @returns {{ switchId:number, name:string, isPublic:boolean }[]}
 */
export const getPrivacySwitches = async (accountId, options = {}) => {
  const card = await getStarRailCard(accountId, options);
  return (card?.data_switches || []).map((sw) => ({
    switchId: sw.switch_id,
    name: sw.switch_name,
    isPublic: Boolean(sw.is_public),
  }));
};

/**
 * Flip one visibility switch. Used only by the optional "尝试打开公开" action.
 * @param {string} accountId
 * @param {number} switchId
 * @param {boolean} isPublic
 */
export const setPrivacySwitch = async (accountId, switchId, isPublic, options = {}) => {
  const url = 'https://api-takumi-record.mihoyo.com/game_record/card/wapi/changeDataSwitch';
  const body = { is_public: Boolean(isPublic), switch_id: Number(switchId), game_id: 6 };
  const response = await request(url, {
    method: 'POST',
    headers: communityHeaders({
      'x-rpc-page': `${APP_VERSION}_#/sr`,
      DS: createDS({ body }),
      ...(options.deviceId ? { 'x-rpc-device_id': options.deviceId } : {}),
      ...(options.deviceFp ? { 'x-rpc-device_fp': options.deviceFp } : {}),
    }),
    body,
    cookie: options.cookie,
    origin: RECORD_ORIGIN,
  });
  return unwrap(response, '设置战绩公开状态');
};

/**
 * Fetch a full, GUI-ready snapshot for one role.
 * Individual sub-requests degrade gracefully: a failure in an optional section
 * is reported as a `warnings` entry instead of failing the whole snapshot.
 */
export const getFullSnapshot = async (uid, server, options = {}) => {
  const warnings = [];
  const attempt = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      warnings.push({ section: label, message: err.message, retcode: err.retcode });
      return null;
    }
  };

  const [index, basicInfo, avatars, challenge, rogue, card] = await Promise.all([
    attempt('开拓者总览', () => getPlayerIndex(uid, server, options)),
    attempt('角色基本信息', () => getRoleBasicInfo(uid, server, options)),
    attempt('角色详情', () => getAvatarInfo(uid, server, options)),
    attempt('忘却之庭', () => getChallenge(uid, server, 1, options)),
    attempt('模拟宇宙', () => getRogue(uid, server, 1, options)),
    // Public profile card: available even when the record API is privacy-gated.
    attempt('公开卡片', () => getStarRailCard(options.accountId, options)),
  ]);

  // `character/list` is not the only way in: `index` also carries a showcase
  // roster under `avatar_list`. Prefer whichever actually returned characters so
  // the GUI has something to render when only one of the two is gated.
  let characters = avatars?.avatars || avatars?.avatar_list || [];
  let charactersSource = characters.length ? 'avatar/info' : null;
  if (!characters.length) {
    const fromIndex = index?.avatar_list || index?.avatars || [];
    if (fromIndex.length) {
      characters = fromIndex;
      charactersSource = 'index';
    }
  }

  if (!index && !basicInfo && !characters.length && !card) {
    const detail = warnings.map((w) => `${w.section}：${w.message}`).join('；');
    const error = new Error(
      warnings.length
        ? `未能获取该角色的战绩数据。${detail}`
        : '未获取到任何战绩数据',
    );
    error.warnings = warnings;
    error.code = 'NO_DATA';
    throw error;
  }

  // 10035 is the Star Rail record service declining to serve this role's data.
  // It is a per-role condition, so surface it as "no record yet" rather than as
  // a privacy problem the user can fix with a switch.
  const gated = warnings.some((w) => Number(w.retcode) === 10035);
  const unlockSummary = rogue
    ? {
      buffs: rogue.basic_info?.unlocked_buff_num ?? null,
      miracles: rogue.basic_info?.unlocked_miracle_num ?? null,
      skillPoints: rogue.basic_info?.unlocked_skill_points ?? null,
      score: rogue.current_record?.basic?.current_rogue_score ?? null,
    }
    : null;

  return {
    uid: String(uid),
    server,
    fetchedAt: new Date().toISOString(),
    recordPublic: !gated,
    // True when the record endpoints refused but we still produced a snapshot
    // from the endpoints that did answer.
    partial: warnings.length > 0,
    charactersSource,
    unlockSummary,
    index,
    basicInfo,
    avatars,
    characters,
    challenge,
    rogue,
    card,
    warnings,
  };
};

export { USER_AGENT };
