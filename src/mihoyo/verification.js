// 1034 (Geetest) verification flow.
//
// Some accounts must clear a Geetest challenge before the record API will serve
// character data. miHoYo answers `retcode 1034`, and the account gets a
// challenge to solve. This mirrors Snap Hutao's `CardClient` +
// `GeetestService.TryVerifyXrpcChallengeAsync`:
//
//   1. GET  card/wapi/createVerification?is_high=true   -> {gt, challenge}
//   2. solve the Geetest widget                          -> {validate, seccode}
//   3. POST card/wapi/verifyVerification                 -> {challenge}
//   4. retry the original endpoint with `x-rpc-challenge`
//
// Steps 1, 3 and 4 run here. Step 2 needs a real browser: Geetest's puzzle
// cannot be solved outside one, which is exactly why Snap Hutao embeds WebView2.
// We therefore render the official Geetest widget in the local GUI and hand the
// solved `validate` back to the server.

import { APP_VERSION } from './constants.js';
import { communityHeaders, request } from './http.js';
import { createDS } from './ds.js';
import { unwrap } from './errors.js';

const ORIGIN = 'https://api-takumi-record.mihoyo.com';
const CARD = `${ORIGIN}/game_record/card/wapi`;

const CHALLENGE_GAME = 6;
export const challengePathFor = (kind = 'list') => kind === 'detail'
  ? '/game_record/app/hkrpg/api/avatar/info'
  : '/game_record/app/hkrpg/api/index';

/** In-flight challenges, keyed by an opaque id handed to the browser. */
const pending = new Map();
const TTL_MS = 5 * 60 * 1000;

const sweep = () => {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (now - entry.createdAt > TTL_MS) pending.delete(id);
  }
};

const signed = (url, options = {}) => {
  const query = url.includes('?') ? url.split('?')[1] : '';
  const headers = communityHeaders({
    'x-rpc-page': options.page || `${APP_VERSION}_#/ys`,
    'x-rpc-challenge_game': String(options.challengeGame ?? CHALLENGE_GAME),
    'x-rpc-challenge_path': options.challengePath || '',
  });
  if (options.deviceId) headers['x-rpc-device_id'] = options.deviceId;
  headers.DS = createDS({ query, body: options.body });
  return request(url, {
    method: options.method || 'GET',
    headers,
    body: options.body,
    cookie: options.cookie,
    origin: ORIGIN,
    referer: 'https://webstatic.mihoyo.com/',
  });
};

/**
 * Step 1: ask miHoYo for a Geetest challenge.
 * @returns {Promise<{ id:string, gt:string, challenge:string, newCaptcha:boolean }>}
 */
export const createVerification = async (options) => {
  sweep();
  const response = await signed(`${CARD}/createVerification?is_high=true`, {
    challengeGame: CHALLENGE_GAME,
    challengePath: options.challengePath,
    deviceId: options.deviceId,
    cookie: options.cookie,
    page: options.page,
  });
  const data = unwrap(response, '创建验证');
  if (!data?.gt || !data?.challenge) {
    throw new Error('创建验证失败：未获取到验证参数');
  }
  const id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  pending.set(id, {
    id,
    gt: data.gt,
    challenge: data.challenge,
    newCaptcha: Boolean(data.new_captcha),
    challengeGame: options.challengeGame ?? CHALLENGE_GAME,
    challengePath: options.challengePath,
    deviceId: options.deviceId,
    cookie: options.cookie,
    page: options.page,
    createdAt: Date.now(),
  });
  return {
    id,
    gt: data.gt,
    challenge: data.challenge,
    newCaptcha: Boolean(data.new_captcha),
  };
};

export const getVerification = (id) => pending.get(id) || null;

/**
 * Step 3: exchange a solved Geetest result for the `x-rpc-challenge` token.
 * @param {string} id challenge id from createVerification
 * @param {{ validate:string, seccode?:string, challenge?:string }} solved
 * @returns {Promise<{ challenge:string }>}
 */
export const completeVerification = async (id, solved) => {
  const entry = pending.get(id);
  if (!entry) throw new Error('验证会话不存在或已过期，请重新发起');

  const body = {
    geetest_challenge: solved.challenge || entry.challenge,
    geetest_validate: solved.validate,
    geetest_seccode: solved.seccode || `${solved.validate}|jordan`,
  };
  const response = await signed(`${CARD}/verifyVerification`, {
    method: 'POST',
    body,
    challengeGame: entry.challengeGame,
    challengePath: entry.challengePath,
    deviceId: entry.deviceId,
    cookie: entry.cookie,
    page: entry.page,
  });
  const data = unwrap(response, '提交验证');
  const challenge = data?.challenge;
  if (!challenge) throw new Error('验证未通过：服务端未返回 challenge');

  pending.delete(id);
  return { challenge };
};

export const dropVerification = (id) => pending.delete(id);
