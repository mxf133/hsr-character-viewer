// Constants for the miHoYo / 米游社 (Chinese mainland) endpoints used here.
//
// Every value below was verified against the live services while building this
// project. Behaviour can change without notice, so each constant is overridable
// through environment variables where that is useful for repair.

import { env } from 'node:process';

/** miHoYo community app id for the web login flow. */
export const APP_ID = env.DSH_HSR_APP_ID || 'bll8iq97cem8';

/** miHoYo community app version - must match the salt below. */
export const APP_VERSION = env.DSH_HSR_APP_VERSION || '2.109.0';

/**
 * DS salt for `x-rpc-client_type: 5` (mobile web).
 * Verified working against the live record API: a wrong salt yields
 * retcode -10001 "invalid request", while this one yields retcode 10001
 * "Please login" when unauthenticated.
 */
export const SALT_WEB = env.DSH_HSR_SALT || 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs';

/** `x-rpc-client_type` for the mobile web client. */
export const CLIENT_TYPE_WEB = '5';

export const ENDPOINTS = {
  /** Create a QR code for scanning in the miHoYo community app. */
  createQRLogin: 'https://passport-api.miyoushe.com/account/ma-cn-passport/web/createQRLogin',
  /** Poll the scan state of a QR code. */
  queryQRLoginStatus: 'https://passport-api.miyoushe.com/account/ma-cn-passport/web/queryQRLoginStatus',
  /** Exchange a login_ticket for ltoken/cookie_token. */
  multiTokenByLoginTicket: 'https://api-takumi.mihoyo.com/auth/api/getMultiTokenByLoginTicket',
  /** Derive cookie_token from an stoken. */
  cookieAccountInfoBySToken: 'https://api-takumi.mihoyo.com/auth/api/getCookieAccountInfoBySToken',
  /** List the game roles bound to the account cookie. */
  gameRolesByCookie: 'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie',
  /** Game record API (Star Rail lives under /hkrpg/). */
  gameRecord: 'https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api',
};

/** Star Rail game biz identifier for the China mainland server. */
export const GAME_BIZ = 'hkrpg_cn';

export const GAMES = {
  hsr: {
    key: 'hsr',
    label: '崩坏：星穹铁道',
    shortLabel: '星穹铁道',
    gameBiz: GAME_BIZ,
    gameId: 6,
    recordPrefix: 'hkrpg',
    avatarListField: 'avatar_list',
    regions: {
      prod_gf_cn: '官服 · 星穹列车',
      prod_qd_cn: 'B服 · 星穹列车',
    },
    defaultRegion: 'prod_gf_cn',
  },
};

export const enabledGames = () => [GAMES.hsr];
export const isGameEnabled = (key) => key === 'hsr';
export const gameByKey = () => GAMES.hsr;
export const gameByBiz = (gameBiz) => gameBiz === GAME_BIZ ? GAMES.hsr : null;

/** Extract the region (`server` query parameter) from a Star Rail UID. */
export const regionFromUid = (uid) => {
  const value = String(uid).trim();
  if (value.startsWith('5')) return 'prod_qd_cn';
  return 'prod_gf_cn';
};

export const regionName = (server) => GAMES.hsr.regions[server] || server || '未知';

/**
 * User-Agent sent with every request.
 *
 * Copied verbatim from Snap Hutao's `HoyolabOptions.UserAgent`, which is what
 * `HttpClientConfiguration.XRpc` installs for `GameRecordClient`:
 *   `Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/{CNVersion}`
 * The community API treats a browser-looking UA differently from the official
 * client UA, so this is intentionally not the Android/Chrome string.
 */
export const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/${APP_VERSION}`;
