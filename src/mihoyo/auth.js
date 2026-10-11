// 米游社 QR login + cookie exchange.
//
// Flow (all steps verified against the live service):
//
//   1. POST /account/ma-cn-passport/web/createQRLogin
//        -> { url, ticket }        `url` is rendered as a QR code
//   2. POST /account/ma-cn-passport/web/queryQRLoginStatus  { ticket }
//        -> status: Created | Scanned | Confirmed
//        On `Confirmed` the response `Set-Cookie` headers carry the session
//        tokens (stoken/stoken_v2, ltoken/ltoken_v2, account ids, mid, ...).
//   3. The record API needs `cookie_token` + `account_id`, so:
//        - login_ticket -> GET /auth/api/getMultiTokenByLoginTicket
//        - stoken       -> GET /auth/api/getCookieAccountInfoBySToken (fallback)
//   4. GET /binding/api/getUserGameRolesByCookie?game_biz=hkrpg_cn
//        -> the Star Rail roles bound to the account.

import { randomUUID } from 'node:crypto';
import { APP_ID, ENDPOINTS, GAME_BIZ, APP_VERSION } from './constants.js';
import {
  communityHeaders, cookiesFromResponse, newDeviceId, parseCookieHeader, request,
  serializeCookies,
} from './http.js';
import { MihoyoError, unwrap } from './errors.js';

const PASSPORT_ORIGIN = 'https://passport-api.miyoushe.com';
const TAKUMI_ORIGIN = 'https://api-takumi.mihoyo.com';

/** In-memory QR login sessions, keyed by an opaque id handed to the browser. */
const sessions = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000;

const cleanup = () => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
};

/** Create a new QR login session and fetch a QR code from miHoYo. */
export const startQrLogin = async () => {
  cleanup();
  const deviceId = newDeviceId();
  const response = await request(ENDPOINTS.createQRLogin, {
    method: 'POST',
    headers: communityHeaders({ 'x-rpc-device_id': deviceId }),
    origin: 'https://user.mihoyo.com',
    body: {},
  });

  const data = unwrap(response, '生成登录二维码');
  if (!data?.url || !data?.ticket) {
    throw new MihoyoError('生成登录二维码失败：响应中没有二维码内容', { code: 'NO_QR' });
  }

  const id = randomUUID();
  const session = {
    id,
    deviceId,
    ticket: data.ticket,
    url: data.url,
    createdAt: Date.now(),
    status: 'Created',
    cookies: {},
    account: null,
  };
  sessions.set(id, session);

  return { id, url: data.url, expiresInMs: SESSION_TTL_MS };
};

export const getSession = (id) => sessions.get(id) || null;
export const dropSession = (id) => sessions.delete(id);

const pick = (cookies, names) => {
  for (const name of names) {
    if (cookies[name]) return cookies[name];
  }
  return undefined;
};

/**
 * Poll the QR status. Returns a small, browser-safe snapshot; when the login is
 * confirmed the session cookies are stored server-side and never sent out.
 *
 * A QR ticket is SINGLE-USE: once miHoYo reports `Confirmed`, any further poll
 * with the same ticket fails with -3501 ("已失效"). Because the browser polls on
 * a timer, a poll can land right after confirmation, so a -3501/-3505 must not
 * be reported as "expired" when this session already holds login material -
 * doing so was a real bug that surfaced as a false "二维码已失效" right after a
 * successful scan.
 */
export const pollQrLogin = async (id) => {
  const session = sessions.get(id);
  if (!session) {
    throw new MihoyoError('登录会话不存在或已过期，请重新获取二维码', { code: 'NO_SESSION' });
  }

  // Serialize polls for one session: concurrent timers must not both consume
  // the ticket, and the second one would otherwise poison the state.
  if (session.pending) return session.pending;

  session.pending = (async () => {
    // Already finished (confirmed earlier): just report success, no extra call.
    if (session.status === 'Confirmed') {
      return { status: 'Confirmed', account: session.publicAccount };
    }

    const response = await request(ENDPOINTS.queryQRLoginStatus, {
      method: 'POST',
      headers: communityHeaders({ 'x-rpc-device_id': session.deviceId }),
      origin: PASSPORT_ORIGIN,
      body: { ticket: session.ticket },
      collectCookies: session.cookies,
    });

    const retcode = response.json?.retcode;

    // Ignore a stale "expired/cancelled" answer once we already own tokens.
    if (retcode === -3501 || retcode === -3505) {
      if (hasLoginMaterial(session)) {
        const account = await finalizeLogin(session);
        return { status: 'Confirmed', account };
      }
      return retcode === -3501
        ? { status: 'Expired', message: '二维码已失效，请刷新后重新扫描' }
        : { status: 'Cancelled', message: '已取消扫码，请重新生成二维码' };
    }

    const data = unwrap(response, '查询扫码状态');
    const status = data?.status || 'Created';
    session.status = status;

    if (status !== 'Confirmed') {
      return { status };
    }

    // Some deployments deliver tokens through the JSON body instead of cookies.
    const bodyTokens = data?.tokens;
    if (Array.isArray(bodyTokens)) {
      for (const token of bodyTokens) {
        if (token?.name && token?.token) session.cookies[token.name] = token.token;
      }
    }

    session.account = data?.user_info || session.account;
    session.confirmedAt = Date.now();
    // The cookie set is complete at this instant; do not poll again.
    session.ticketConsumed = true;

    const account = await finalizeLogin(session);
    return { status: 'Confirmed', account };
  })();

  try {
    return await session.pending;
  } finally {
    session.pending = null;
  }
};

/** Do we already hold enough material to attempt the token exchange? */
const hasLoginMaterial = (session) => Boolean(
  session.recordCookie
  || session.publicAccount
  || session.cookies?.cookie_token
  || session.cookies?.cookie_token_v2
  || session.cookies?.login_ticket
  || session.cookies?.stoken
  || session.cookies?.stoken_v2,
);

/** Run the token exchange once, memoizing the result on the session. */
const finalizeLogin = async (session) => {
  if (session.publicAccount) return session.publicAccount;
  if (!session.finalizePromise) {
    session.finalizePromise = completeLogin(session)
      .then((account) => {
        session.publicAccount = account;
        return account;
      })
      .catch((err) => {
        session.finalizePromise = null;
        throw err;
      });
  }
  return session.finalizePromise;
};

/**
 * Finish the login: build the account cookie the record API expects.
 * @returns {Promise<{ accountId:string, cookieToken:string, mid?:string, nickname?:string }>}
 */
const completeLogin = async (session) => {
  const cookies = session.cookies;
  const accountId = pick(cookies, ['account_id_v2', 'account_id', 'ltuid_v2', 'ltuid']);
  const mid = pick(cookies, ['ltmid_v2', 'mid', 'account_id_v2']);
  let cookieToken = pick(cookies, ['cookie_token_v2', 'cookie_token']);
  const loginTicket = pick(cookies, ['login_ticket']);
  const stoken = pick(cookies, ['stoken_v2', 'stoken']);
  const stuid = pick(cookies, ['stuid', 'ltuid', 'ltuid_v2', 'account_id_v2', 'account_id']);

  // Preferred: exchange the short-lived login_ticket for a long-lived cookie.
  if (!cookieToken && loginTicket && accountId) {
    try {
      const data = await multiTokenByLoginTicket(loginTicket, accountId, session.deviceId);
      cookieToken = data?.cookie_token || data?.cookie_token_v2 || cookieToken;
      if (data?.ltoken) cookies.ltoken = data.ltoken;
      if (data?.ltoken_v2) cookies.ltoken_v2 = data.ltoken_v2;
    } catch (err) {
      session.exchangeError = err.message;
    }
  }

  // Fallback: derive cookie_token from the stoken.
  if (!cookieToken && stoken && stuid) {
    try {
      const data = await cookieAccountInfoByStoken(stoken, stuid, session.deviceId);
      cookieToken = data?.cookie_token || cookieToken;
    } catch (err) {
      session.exchangeError = session.exchangeError || err.message;
    }
  }

  if (!accountId) {
    throw new MihoyoError('登录成功但未获取到账号 ID，请重试', { code: 'NO_ACCOUNT_ID' });
  }
  // The passport QR flow issues the v2 cookie family, so accept either generation.
  const finalToken = pick(cookies, ['cookie_token', 'cookie_token_v2']) || extra.cookie_token;
  if (!finalToken) {
    throw new MihoyoError(
      '登录成功但未获取到 cookie_token，无法查询战绩。请重新扫码，或改用 Cookie 登录方式。',
      { code: 'NO_COOKIE_TOKEN' },
    );
  }

  // Assemble the cookie jar the record API wants. Both cookie generations are
  // sent when available: the QR flow only issues the v2 names, while parts of
  // the record API still key off the v1 names.
  const recordCookies = {};
  const put = (name, value) => {
    if (value !== undefined && value !== null && value !== '') recordCookies[name] = value;
  };
  put('cookie_token', cookies.cookie_token || finalToken);
  put('cookie_token_v2', cookies.cookie_token_v2);
  put('account_id', accountId);
  put('account_id_v2', cookies.account_id_v2);
  put('ltuid', cookies.ltuid);
  put('ltuid_v2', cookies.ltuid_v2);
  put('ltmid_v2', mid);
  put('mid', mid);
  put('account_mid_v2', cookies.account_mid_v2);
  put('ltoken', cookies.ltoken);
  put('ltoken_v2', cookies.ltoken_v2);
  put('stoken', cookies.stoken);
  put('stoken_v2', cookies.stoken_v2);

  session.recordCookie = recordCookies;
  session.status = 'Confirmed';
  return {
    accountId,
    cookieToken: finalToken,
    mid,
    nickname: session.account?.nickname || session.account?.nick_name || null,
  };
};

const multiTokenByLoginTicket = async (loginTicket, accountId, deviceId) => {
  const query = `login_ticket=${encodeURIComponent(loginTicket)}&token_types=3&uid=${encodeURIComponent(accountId)}`;
  const response = await request(`${ENDPOINTS.multiTokenByLoginTicket}?${query}`, {
    headers: communityHeaders({ 'x-rpc-device_id': deviceId }),
    origin: TAKUMI_ORIGIN,
  });
  const data = unwrap(response, '换取登录凭证');
  // The endpoint returns a list; merge the token entries.
  const list = Array.isArray(data?.list) ? data.list : [];
  return list.reduce((acc, item) => {
    if (item?.name && item?.token) acc[item.name] = item.token;
    return acc;
  }, { ...(data || {}) });
};

const cookieAccountInfoBySToken = async (stoken, stuid, deviceId) => {
  const query = `stoken=${encodeURIComponent(stoken)}&uid=${encodeURIComponent(stuid)}`;
  const response = await request(`${ENDPOINTS.cookieAccountInfoBySToken}?${query}`, {
    headers: communityHeaders({ 'x-rpc-device_id': deviceId }),
    origin: TAKUMI_ORIGIN,
  });
  return unwrap(response, '获取 cookie_token');
};

/** Fetch the game roles bound to a record cookie, for one or all games. */
export const fetchGameRoles = async (cookie, deviceId, gameBiz = GAME_BIZ) => {
  const query = `game_biz=${gameBiz}`;
  const response = await request(`${ENDPOINTS.gameRolesByCookie}?${query}`, {
    headers: communityHeaders({ 'x-rpc-device_id': deviceId }),
    origin: TAKUMI_ORIGIN,
    cookie,
  });
  const data = unwrap(response, '获取角色列表');
  return Array.isArray(data?.list) ? data.list : [];
};

/**
 * Fetch roles across every supported game in one go and tag each with its game.
 * A game the account does not play simply returns an empty list.
 */
export const fetchAllGameRoles = async (cookie, deviceId, gameBizList) => {
  const results = [];
  for (const gameBiz of gameBizList) {
    try {
      const roles = await fetchGameRoles(cookie, deviceId, gameBiz);
      for (const role of roles) {
        results.push({ ...role, game_biz: role.game_biz || gameBiz });
      }
    } catch (err) {
      // A missing game binding is normal; surface nothing for it.
      if (Number(err.retcode) !== 10101) {
        results.push({ __error: err.message, __gameBiz: gameBiz, __retcode: err.retcode });
      }
    }
  }
  return results;
};

/** Accept a manually pasted cookie string and keep only what the record API needs. */
export const normalizeManualCookie = (raw) => {
  const parsed = parseCookieHeader(String(raw || '').replace(/\r?\n/g, ''));
  const keep = [
    'cookie_token', 'cookie_token_v2', 'account_id', 'account_id_v2',
    'ltuid', 'ltuid_v2', 'ltmid_v2', 'mid', 'stuid', 'stoken', 'stoken_v2',
    'ltoken', 'ltoken_v2', 'login_ticket',
  ];
  const out = {};
  for (const name of keep) {
    if (parsed[name]) out[name] = parsed[name];
  }
  return out;
};

export { serializeCookies, cookiesFromResponse, APP_ID, APP_VERSION };
