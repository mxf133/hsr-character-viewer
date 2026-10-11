// Independent QR decoder used ONLY by the test suite.
// It re-implements the read path (format info recovery, mask removal, zigzag
// de-placement, block de-interleaving, Reed-Solomon syndrome check) so that the
// encoder in src/qr/qrcode.js can be verified without any third-party library.

import { RS_BLOCK_TABLE, PATTERN_POSITION_TABLE } from './tables.js';

const GEXP = new Array(256).fill(0);
const GLOG = new Array(256).fill(0);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GEXP[i] = x;
    GLOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  GEXP[255] = GEXP[0];
})();
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : GEXP[(GLOG[a] + GLOG[b]) % 255]);

const EC_LEVEL_BY_BITS = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };
const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

const getBCHDigit = (data) => {
  let digit = 0;
  let v = data;
  while (v !== 0) { digit += 1; v >>>= 1; }
  return digit;
};

const hamming = (a, b) => {
  let x = (a ^ b) >>> 0;
  let count = 0;
  while (x !== 0) { count += x & 1; x >>>= 1; }
  return count;
};

const MASK_FNS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

const getRSBlocks = (version, level) => {
  const entry = RS_BLOCK_TABLE.find((r) => r[0] === version && r[1] === level);
  if (!entry) throw new Error(`no RS blocks for v${version} ${level}`);
  const groups = entry.slice(2);
  const blocks = [];
  for (let g = 0; g < groups.length; g += 3) {
    for (let i = 0; i < groups[g]; i += 1) {
      blocks.push({ totalCount: groups[g + 1], dataCount: groups[g + 2] });
    }
  }
  return blocks;
};

const readFormatInfo = (isDark, n) => {
  let bits = 0;
  for (let i = 0; i < 15; i += 1) {
    let row;
    let col;
    if (i < 6) { row = i; col = 8; } else if (i < 8) { row = i + 1; col = 8; } else { row = n - 15 + i; col = 8; }
    if (isDark(row, col)) bits |= 1 << i;
  }

  let best = null;
  for (let data = 0; data < 32; data += 1) {
    const expected = (() => {
      let d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) d ^= G15 << (getBCHDigit(d) - getBCHDigit(G15));
      return ((data << 10) | d) ^ G15_MASK;
    })();
    const dist = hamming(bits, expected);
    if (best === null || dist < best.dist) best = { dist, data };
  }
  if (best.dist !== 0) throw new Error(`format info had ${best.dist} bit error(s); expected pristine output`);
  return { level: EC_LEVEL_BY_BITS[(best.data >> 3) & 3], mask: best.data & 7 };
};

const readCodewords = (isDark, n, mask) => {
  const maskFn = MASK_FNS[mask];
  const bits = [];
  let inc = -1;
  let row = n - 1;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    while (true) {
      for (let c = 0; c < 2; c += 1) {
        const cc = col - c;
        // Only function-free modules carry data. Rebuild the reservation map
        // implicitly by re-checking against a "reserved" grid.
        if (!isReserved(row, cc, n)) {
          let dark = isDark(row, cc);
          if (maskFn(row, cc)) dark = !dark;
          bits.push(dark ? 1 : 0);
        }
      }
      row += inc;
      if (row < 0 || row >= n) { row -= inc; inc = -inc; break; }
    }
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k += 1) b = (b << 1) | bits[i + k];
    bytes.push(b);
  }
  return bytes;
};

// Function-pattern reservation map derived from the spec, independent of the
// encoder's null-phase logic. Note the timing patterns only occupy the interior
// span (8 .. n-9) - the corners belong to the finders and the format info.
const buildReserved = (version) => {
  const n = version * 4 + 17;
  const res = Array.from({ length: n }, () => new Array(n).fill(false));
  const markRect = (r0, c0, h, w) => {
    for (let r = r0; r < r0 + h; r += 1) {
      for (let c = c0; c < c0 + w; c += 1) {
        if (r >= 0 && r < n && c >= 0 && c < n) res[r][c] = true;
      }
    }
  };
  // finders + separators
  markRect(0, 0, 9, 9);
  markRect(0, n - 8, 9, 8);
  markRect(n - 8, 0, 8, 9);
  // timing patterns (interior only)
  markRect(6, 8, 1, n - 16);
  markRect(8, 6, n - 16, 1);
  // format info
  markRect(8, 0, 1, 9);
  markRect(0, 8, 9, 1);
  markRect(n - 8, 8, 8, 1);
  markRect(8, n - 8, 1, 8);
  // dark module
  res[n - 8][8] = true;
  // alignment patterns (skipped where they would collide with the finders)
  const pos = PATTERN_POSITION_TABLE[version - 1];
  for (const r of pos) {
    for (const c of pos) {
      const overlapsFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8);
      if (overlapsFinder) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) res[r + dr][c + dc] = true;
      }
    }
  }
  // version info (v >= 7)
  if (version >= 7) {
    markRect(0, n - 11, 6, 3);
    markRect(n - 11, 0, 3, 6);
  }
  return res;
};

const reservedCache = new Map();
const isReserved = (r, c, n) => {
  const version = (n - 17) / 4;
  if (!reservedCache.has(version)) reservedCache.set(version, buildReserved(version));
  return reservedCache.get(version)[r][c];
};

const decodePayload = (dataCodewords, version) => {
  const bits = [];
  for (const b of dataCodewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((b >> i) & 1);
  }
  let p = 0;
  const take = (len) => {
    let v = 0;
    for (let i = 0; i < len; i += 1) v = (v << 1) | bits[p + i];
    p += len;
    return v;
  };
  const mode = take(4);
  if (mode !== 4) throw new Error(`expected byte mode, got mode ${mode}`);
  const lenBits = version < 10 ? 8 : 16;
  const length = take(lenBits);
  const out = [];
  for (let i = 0; i < length; i += 1) out.push(take(8));
  return { mode, length, bytes: out };
};

// Verify EC: evaluate the full codeword polynomial at the generator roots.
const syndromes = (codeword, ecCount) => {
  const res = [];
  for (let i = 0; i < ecCount; i += 1) {
    let acc = 0;
    for (let k = 0; k < codeword.length; k += 1) {
      acc = gmul(acc, GEXP[i]) ^ codeword[k];
    }
    res.push(acc);
  }
  return res;
};

/**
 * Read the raw interleaved codeword bytes straight out of a module grid.
 * Exported for the test suite, which uses it to locate read-path divergences.
 * @param {boolean[][]} modules
 * @param {(r:number,c:number)=>boolean} isDark
 * @param {number} [level_] and mask override (defaults to the format-info values)
 */
export const readRawCodewords = (modules, isDark, override = {}) => {
  const n = modules.length;
  const version = (n - 17) / 4;
  const fmt = override.level && override.mask !== undefined
    ? { level: override.level, mask: override.mask }
    : readFormatInfo(isDark, n);
  return { version, ...fmt, raw: readCodewords(isDark, n, fmt.mask) };
};

/**
 * Decode a boolean module grid produced by the encoder.
 * @param {boolean[][]} modules
 * @param {(r:number,c:number)=>boolean} isDark
 */
export const decodeMatrix = (modules, isDark) => {
  const n = modules.length;
  if ((n - 17) % 4 !== 0) throw new Error(`invalid module count ${n}`);
  const version = (n - 17) / 4;
  const { level, mask } = readFormatInfo(isDark, n);
  const raw = readCodewords(isDark, n, mask);

  const blocks = getRSBlocks(version, level);
  const maxData = Math.max(...blocks.map((b) => b.dataCount));
  const maxEc = Math.max(...blocks.map((b) => b.totalCount - b.dataCount));
  const decoded = blocks.map(() => ({ data: [], ec: [] }));

  let p = 0;
  for (let i = 0; i < maxData; i += 1) {
    for (let b = 0; b < blocks.length; b += 1) {
      if (i < blocks[b].dataCount) decoded[b].data.push(raw[p++]);
    }
  }
  for (let i = 0; i < maxEc; i += 1) {
    for (let b = 0; b < blocks.length; b += 1) {
      if (i < blocks[b].totalCount - blocks[b].dataCount) decoded[b].ec.push(raw[p++]);
    }
  }
  if (p !== raw.length) throw new Error(`consumed ${p} of ${raw.length} codewords`);

  decoded.forEach((blk, idx) => {
    const syn = syndromes(blk.data.concat(blk.ec), blk.ec.length);
    if (syn.some((s) => s !== 0)) {
      throw new Error(`block ${idx} failed RS syndrome check: ${syn.join(',')}`);
    }
  });

  const dataCodewords = decoded.flatMap((b) => b.data);
  const payload = decodePayload(dataCodewords, version);
  return {
    version,
    level,
    mask,
    dataCodewords,
    payload,
    text: Buffer.from(payload.bytes).toString('utf8'),
  };
};
