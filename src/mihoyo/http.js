// Low-level HTTP + cookie helpers for the miHoYo APIs.

import { createHash, randomUUID } from 'node:crypto';
import {
  APP_ID, APP_VERSION, CLIENT_TYPE_WEB, USER_AGENT,
} from './constants.js';

// --------------------------------------------------------------------------
// Request throttling.
//
// miHoYo applies risk control to rapid bursts: hammering the record API can
// trip retcode 10041 ("当前账号存在风险，暂时无法访问"), which temporarily locks
// the ACCOUNT out of battle-record features. Because this app acts on the
// user's real account, every outgoing request is paced and capped here.
// --------------------------------------------------------------------------

const MIN_INTERVAL_MS = Number(process.env.DSH_HSR_MIN_INTERVAL_MS ?? 700);
const MAX_BURST = Number(process.env.DSH_HSR_MAX_BURST ?? 6);
const BURST_WINDOW_MS = Number(process.env.DSH_HSR_BURST_WINDOW_MS ?? 10000);

let lastGlobalRequestAt = 0;
let globalChain = Promise.resolve();
let globalRecent = [];
const identityQueues = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stableIdentityCookieNames = [
  'account_id_v2', 'account_id', 'ltuid_v2', 'ltuid', 'stuid', 'ltmid_v2', 'mid',
];

const requestIdentityKey = (cookie, deviceId) => {
  const entries = (typeof cookie === 'string'
    ? Object.entries(parseCookieHeader(cookie))
    : Object.entries(cookie || {}))
    .filter(([name, value]) => name && value !== undefined && value !== null && String(value) !== '')
    .map(([name, value]) => [String(name).trim().toLowerCase(), String(value).trim()]);
  const cookies = new Map(entries);
  const stableIds = stableIdentityCookieNames
    .map((name) => cookies.get(name))
    .filter(Boolean);

  if (stableIds.length) {
    return `account:${createHash('sha256').update([...new Set(stableIds)].sort().join('|')).digest('hex')}`;
  }
  if (entries.length) {
    const canonical = entries.sort(([a], [b]) => a.localeCompare(b));
    return `cookie:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
  }
  if (deviceId) {
    return `device:${createHash('sha256').update(String(deviceId)).digest('hex')}`;
  }
  return 'anonymous';
};

const queueForIdentity = (key) => {
  let queue = identityQueues.get(key);
  if (!queue) {
    queue = { chain: Promise.resolve(), recent: [] };
    identityQueues.set(key, queue);
  }
  return queue;
};

/** Reserve a globally paced send slot while keeping identity queues independent. */
const reserveGlobalSlot = (identityQueue) => {
  const run = async () => {
    const delay = MIN_INTERVAL_MS - (Date.now() - lastGlobalRequestAt);
    if (delay > 0) await sleep(delay);
    const stamp = Date.now();
    lastGlobalRequestAt = stamp;
    identityQueue.recent.push(stamp);
    globalRecent.push(stamp);
  };
  globalChain = globalChain.then(run, run);
  return globalChain;
};

/** Pace one identity independently, while retaining a process-wide minimum gap. */
const pace = (identityKey) => {
  const identityQueue = queueForIdentity(identityKey);
  const run = async () => {
    identityQueue.recent = identityQueue.recent.filter((stamp) => stamp > Date.now() - BURST_WINDOW_MS);
    if (identityQueue.recent.length >= MAX_BURST) {
      const delay = identityQueue.recent[0] + BURST_WINDOW_MS - Date.now();
      if (delay > 0) await sleep(delay);
      identityQueue.recent = identityQueue.recent.filter((stamp) => stamp > Date.now() - BURST_WINDOW_MS);
    }
    await reserveGlobalSlot(identityQueue);
  };
  identityQueue.chain = identityQueue.chain.then(run, run);
  return identityQueue.chain;
};

/** Current pacing statistics, exposed for diagnostics. */
export const throttleStats = () => {
  globalRecent = globalRecent.filter((stamp) => stamp > Date.now() - BURST_WINDOW_MS);
  return {
    minIntervalMs: MIN_INTERVAL_MS,
    maxBurst: MAX_BURST,
    recentCount: globalRecent.length,
  };
};

/** Parse a `Cookie` request/response header into a plain object. */
export const parseCookieHeader = (header) => {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return out;
};

/** Collect `Set-Cookie` headers from a fetch Response into a plain object. */
export const cookiesFromResponse = (response, into = {}) => {
  const list = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  for (const raw of list) {
    const first = String(raw).split(';')[0];
    const idx = first.indexOf('=');
    if (idx <= 0) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (name && !name.startsWith('aliyun')) into[name] = value;
  }
  return into;
};

export const serializeCookies = (cookies) => Object.entries(cookies)
  .filter(([, value]) => value !== undefined && value !== null && value !== '')
  .map(([name, value]) => `${name}=${value}`)
  .join('; ');

const DEFAULT_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Content-Type': 'application/json',
};

/**
 * Perform a JSON request against a miHoYo endpoint.
 * @param {string} url
 * @param {{ method?:string, body?:unknown, headers?:Record<string,string>,
 *           cookie?:Record<string,string>|string, origin?:string, referer?:string,
 *           timeoutMs?:number, collectCookies?:Record<string,string> }} [options]
 * @returns {Promise<{ status:number, json:any, text:string, cookies:Record<string,string>, headers:Headers }>}
 */
export const request = async (url, options = {}) => {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { ...DEFAULT_HEADERS, ...(options.headers || {}) };

  if (options.origin) {
    headers.Origin = options.origin;
    headers.Referer = options.referer || `${options.origin}/`;
  }
  if (options.cookie) {
    headers.Cookie = typeof options.cookie === 'string'
      ? options.cookie
      : serializeCookies(options.cookie);
  }
  // The device id ties the login flow together; callers can pin it per session.
  if (options.deviceId) headers['x-rpc-device_id'] = options.deviceId;
  // `x-rpc-device_fp` is sent by Snap Hutao on every signed record request
  // (`SetUserCookieAndFpHeader`). See src/mihoyo/devicefp.js.
  if (options.deviceFp) headers['x-rpc-device_fp'] = options.deviceFp;

  const cookieForIdentity = options.cookie
    ?? Object.entries(headers).find(([name]) => name.toLowerCase() === 'cookie')?.[1];
  const deviceIdForIdentity = options.deviceId
    || Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-rpc-device_id')?.[1];
  const identityKey = requestIdentityKey(cookieForIdentity, deviceIdForIdentity);

  const init = { method, headers, redirect: 'follow' };
  if (method !== 'GET' && method !== 'HEAD' && options.body !== undefined && options.body !== null) {
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  let response;
  try {
    // Pace every outgoing request before sending it.
    await pace(identityKey);
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    clearTimeout(timeout);
    const reason = err?.name === 'AbortError' ? '请求超时' : (err?.cause?.code || err?.message || '网络错误');
    const error = new Error(`网络请求失败：${reason}`);
    error.code = 'NETWORK';
    throw error;
  }
  clearTimeout(timeout);

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON responses (HTML error pages) are surfaced through `text`.
  }

  const cookies = options.collectCookies || {};
  cookiesFromResponse(response, cookies);

  return {
    status: response.status, json, text, cookies, headers: response.headers,
  };
};

/** Headers shared by every community/logged-in API call. */
export const communityHeaders = (extra = {}) => ({
  'x-rpc-app_version': APP_VERSION,
  'x-rpc-client_type': CLIENT_TYPE_WEB,
  'x-rpc-app_id': APP_ID,
  'X-Requested-With': 'com.mihoyo.hyperion',
  ...extra,
});

export const newDeviceId = () => randomUUID();
