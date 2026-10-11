// Dynamic Sign (DS) generation for the miHoYo community / game-record APIs.
//
// The record API uses the "DS2" scheme for `x-rpc-client_type: 5` (mobile web):
//
//   main = `salt=${salt}&t=${t}&r=${r}&b=${body}&q=${query}`
//   DS   = `${t},${r},${md5(main)}`
//
// where `body` is the JSON payload with keys sorted (empty for GET) and `query`
// is the URL query string with its parameters sorted.

import { createHash, randomInt } from 'node:crypto';
import { SALT_WEB } from './constants.js';

const md5 = (value) => createHash('md5').update(value, 'utf8').digest('hex');

/** Sort a URL query string by parameter name, as the DS algorithm requires. */
export const sortQuery = (query) => {
  if (!query) return '';
  const raw = String(query).replace(/^\?/, '');
  if (!raw) return '';
  return raw.split('&').filter(Boolean).sort().join('&');
};

/** Canonical JSON body: keys sorted, no whitespace. */
export const canonicalBody = (body) => {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') {
    if (!body) return '';
    try {
      return canonicalBody(JSON.parse(body));
    } catch {
      return body;
    }
  }
  const sortValue = (value) => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((acc, key) => {
        acc[key] = sortValue(value[key]);
        return acc;
      }, {});
    }
    return value;
  };
  return JSON.stringify(sortValue(body));
};

/**
 * Build a DS2 signature.
 * @param {{ salt?:string, query?:string, body?:unknown, timestamp?:number, nonce?:number }} [options]
 * @returns {string} `${t},${r},${hash}`
 */
export const createDS = (options = {}) => {
  const salt = options.salt || SALT_WEB;
  const t = options.timestamp ?? Math.floor(Date.now() / 1000);
  let r = options.nonce ?? randomInt(100000, 200001);
  // Historical quirk kept for compatibility with the reference implementations.
  if (r === 100000) r = 642367;
  const q = sortQuery(options.query);
  const b = canonicalBody(options.body);
  const main = `salt=${salt}&t=${t}&r=${r}&b=${b}&q=${q}`;
  return `${t},${r},${md5(main)}`;
};
