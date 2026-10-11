// Minimal, dependency-free QR Code encoder (ISO/IEC 18004).
// Only what a QR-login flow needs: 8-bit byte mode, EC level M by default,
// automatic version selection and mask evaluation, rendered as inline SVG.
//
// Deliberately self-contained so the project has zero third-party dependencies.

import { RS_BLOCK_TABLE, PATTERN_POSITION_TABLE } from './tables.js';

export const EC_LEVEL = { L: 1, M: 0, Q: 3, H: 2 };

const MODE_8BIT_BYTE = 4;
const PAD0 = 0xec;
const PAD1 = 0x11;

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

const getBCHDigit = (data) => {
  let digit = 0;
  let value = data;
  while (value !== 0) {
    digit += 1;
    value >>>= 1;
  }
  return digit;
};

const getBCHTypeInfo = (data) => {
  let d = data << 10;
  while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
    d ^= G15 << (getBCHDigit(d) - getBCHDigit(G15));
  }
  return ((data << 10) | d) ^ G15_MASK;
};

const getBCHTypeNumber = (data) => {
  let d = data << 12;
  while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
    d ^= G18 << (getBCHDigit(d) - getBCHDigit(G18));
  }
  return (data << 12) | d;
};

const getPatternPosition = (version) => PATTERN_POSITION_TABLE[version - 1];

// Byte mode character-count indicator width, by version band.
const getLengthInBits = (version) => {
  if (version >= 1 && version < 10) return 8;
  if (version < 27) return 16;
  return 16;
};

const getMaskFn = (maskPattern) => {
  switch (maskPattern) {
    case 0: return (i, j) => (i + j) % 2 === 0;
    case 1: return (i) => i % 2 === 0;
    case 2: return (_i, j) => j % 3 === 0;
    case 3: return (i, j) => (i + j) % 3 === 0;
    case 4: return (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7: return (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
    default: throw new Error(`unknown mask pattern ${maskPattern}`);
  }
};

// Expand the compact spec table into concrete RS blocks for a version/level.
// A table row may declare two groups, e.g. [2, 33, 11, 2, 34, 12]:
// 2 blocks of 33/11 followed by 2 blocks of 34/12.
const getRSBlocks = (version, level) => {
  const entry = RS_BLOCK_TABLE.find((row) => row[0] === version && row[1] === level);
  if (!entry) throw new Error(`no RS block data for version ${version} level ${level}`);
  const groups = entry.slice(2);
  if (groups.length === 0 || groups.length % 3 !== 0) {
    throw new Error(`malformed RS block row for version ${version} level ${level}`);
  }
  const blocks = [];
  for (let g = 0; g < groups.length; g += 3) {
    const [count, totalCount, dataCount] = [groups[g], groups[g + 1], groups[g + 2]];
    for (let i = 0; i < count; i += 1) blocks.push({ totalCount, dataCount });
  }
  return blocks;
};

const getTotalDataCount = (version, level) =>
  getRSBlocks(version, level).reduce((sum, b) => sum + b.dataCount, 0);

// Galois-field helpers for Reed-Solomon error correction over GF(256).
const GLOG = new Array(256).fill(0);
const GEXP = new Array(256).fill(0);
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

const gexp = (n) => {
  let v = n;
  while (v < 0) v += 255;
  while (v >= 256) v -= 255;
  return GEXP[v];
};

const gmul = (a, b) => {
  if (a === 0 || b === 0) return 0;
  return GEXP[(GLOG[a] + GLOG[b]) % 255];
};

// Polynomial remainder over GF(256). Both operands use ascending coefficient
// order. The dividend must be pre-padded with `divisor.length - 1` zero slots
// (see createCodewords); each pass cancels the leading coefficient and shifts
// one slot off, so the loop always terminates.
const polyMod = (dividend, divisor) => {
  let num = dividend.slice();
  while (num.length - divisor.length >= 0) {
    const ratio = num[0];
    if (ratio !== 0) {
      for (let i = 0; i < divisor.length; i += 1) {
        num[i] ^= gmul(divisor[i], ratio);
      }
    }
    num = num.slice(1);
  }
  return num;
};

// Generator polynomial of degree `errorCorrectLength`.
// Coefficients are ASCENDING (index i holds the coefficient of x^i) - the same
// orientation polyMod below works in, so the two stay consistent.
const getErrorCorrectPolynomial = (errorCorrectLength) => {
  let a = [1];
  for (let i = 0; i < errorCorrectLength; i += 1) {
    const next = new Array(a.length + 1).fill(0);
    for (let k = 0; k < a.length; k += 1) {
      next[k] ^= a[k];
      next[k + 1] ^= gmul(a[k], gexp(i));
    }
    a = next;
  }
  return a;
};

const createData = (version, totalDataCount, bytes) => {
  const buffer = [];
  let bitLength = 0;
  const put = (num, length) => {
    for (let i = length - 1; i >= 0; i -= 1) {
      buffer[bitLength >>> 3] = buffer[bitLength >>> 3] || 0;
      buffer[bitLength >>> 3] |= ((num >>> i) & 1) << (7 - (bitLength & 7));
      bitLength += 1;
    }
  };

  put(MODE_8BIT_BYTE, 4);
  put(bytes.length, getLengthInBits(version));
  for (let i = 0; i < bytes.length; i += 1) put(bytes[i], 8);

  // Terminator, then pad to a byte boundary, then alternate pad codewords.
  if (bitLength + 4 <= totalDataCount * 8) put(0, 4);
  while (bitLength % 8 !== 0) {
    if (bitLength >= totalDataCount * 8) break;
    put(0, 1);
  }
  while (true) {
    if (bitLength >= totalDataCount * 8) break;
    put(PAD0, 8);
    if (bitLength >= totalDataCount * 8) break;
    put(PAD1, 8);
  }
  return buffer;
};

const createBytes = (data) => {
  const bytes = [];
  const encoded = new TextEncoder().encode(data);
  for (let i = 0; i < encoded.length; i += 1) bytes.push(encoded[i] & 0xff);
  return bytes;
};

/**
 * Build the data codeword sequence for byte-mode payload `text` at a given
 * version/EC level (mode indicator + length + bytes + terminator + padding).
 * Exported for the test suite.
 */
export const buildDataCodewords = (text, version, level) => {
  const totalDataCount = getTotalDataCount(version, level);
  const bytes = createBytes(text);
  return createData(version, totalDataCount, bytes);
};

const createDataCodewords = (version, level, data) => {
  const codewords = buildDataCodewords(data, version, level);
  return { codewords, totalDataCount: codewords.length };
};

// Build the final interleaved codeword sequence with ECC appended per block.
const createCodewords = (version, level, dataCodewords) => {
  const rsBlocks = getRSBlocks(version, level);

  let offset = 0;
  let maxDcCount = 0;
  let maxEcCount = 0;
  const dcdata = [];
  const ecdata = [];

  for (let r = 0; r < rsBlocks.length; r += 1) {
    const dcCount = rsBlocks[r].dataCount;
    const ecCount = rsBlocks[r].totalCount - dcCount;
    maxDcCount = Math.max(maxDcCount, dcCount);
    maxEcCount = Math.max(maxEcCount, ecCount);
    dcdata[r] = [];
    for (let i = 0; i < dcCount; i += 1) dcdata[r][i] = 0xff & dataCodewords[i + offset];
    offset += dcCount;

    const rsPoly = getErrorCorrectPolynomial(ecCount);
    const rawPoly = dcdata[r].concat(new Array(rsPoly.length - 1).fill(0));
    const modPoly = polyMod(rawPoly, rsPoly);
    ecdata[r] = new Array(rsPoly.length - 1).fill(0);
    for (let i = 0; i < ecdata[r].length; i += 1) {
      const modIndex = i + modPoly.length - ecdata[r].length;
      ecdata[r][i] = modIndex >= 0 ? modPoly[modIndex] : 0;
    }
  }

  const totalCodeCount = rsBlocks.reduce((s, b) => s + b.totalCount, 0);
  const out = [];
  for (let i = 0; i < maxDcCount; i += 1) {
    for (let r = 0; r < rsBlocks.length; r += 1) {
      if (i < dcdata[r].length) out.push(dcdata[r][i]);
    }
  }
  for (let i = 0; i < maxEcCount; i += 1) {
    for (let r = 0; r < rsBlocks.length; r += 1) {
      if (i < ecdata[r].length) out.push(ecdata[r][i]);
    }
  }
  if (out.length !== totalCodeCount) {
    throw new Error(`codeword count mismatch: ${out.length} != ${totalCodeCount}`);
  }
  return out;
};

class BitBuffer {
  constructor() { this.buffer = []; this.length = 0; }
  getBuffer() { return this.buffer; }
  getLengthInBits() { return this.length; }
  put(num, length) {
    for (let i = 0; i < length; i += 1) {
      this.putBit(((num >>> (length - i - 1)) & 1) === 1);
    }
  }
  putBit(bit) {
    const bufIndex = Math.floor(this.length / 8);
    if (this.buffer.length <= bufIndex) this.buffer.push(0);
    if (bit) this.buffer[bufIndex] |= 0x80 >>> (this.length % 8);
    this.length += 1;
  }
}

// Matrix construction.
//
// `grid` holds booleans for function patterns and `null` for modules that carry
// data. Explicit `reserved` marks every function module (including the
// format/version areas, the timing band and the alignment patterns) so that the
// data walk and any external reader agree on exactly which modules are data.
class QRMatrix {
  constructor(version, level, dataCodewords) {
    this.version = version;
    this.level = level;
    this.moduleCount = version * 4 + 17;
    const n = this.moduleCount;
    this.grid = Array.from({ length: n }, () => new Array(n).fill(null));
    this.reserved = Array.from({ length: n }, () => new Array(n).fill(false));
    this.dataCache = createCodewords(version, level, dataCodewords);

    this.setupPositionProbePattern(0, 0);
    this.setupPositionProbePattern(n - 7, 0);
    this.setupPositionProbePattern(0, n - 7);
    this.setupPositionAdjustPattern();
    this.setupTimingPattern();
    this.setupTypeInfo();
    if (version >= 7) this.setupTypeNumber();

    // Keep them disjoint by construction.
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) {
        if (this.reserved[r][c] && this.grid[r][c] === null) {
          throw new Error(`reserved module (${r},${c}) was not written`);
        }
      }
    }
  }

  isDark(row, col) {
    if (row < 0 || this.moduleCount <= row || col < 0 || this.moduleCount <= col) {
      throw new Error(`(${row},${col}) out of range`);
    }
    return this.grid[row][col];
  }

  isDark(row, col) {
    if (row < 0 || this.moduleCount <= row || col < 0 || this.moduleCount <= col) {
      throw new Error(`(${row},${col}) out of range`);
    }
    return this.grid[row][col];
  }

  setupPositionProbePattern(row, col) {
    for (let r = -1; r <= 7; r += 1) {
      if (row + r <= -1 || this.moduleCount <= row + r) continue;
      for (let c = -1; c <= 7; c += 1) {
        if (col + c <= -1 || this.moduleCount <= col + c) continue;
        this.grid[row + r][col + c] = (r >= 0 && r <= 6 && (c === 0 || c === 6))
          || (c >= 0 && c <= 6 && (r === 0 || r === 6))
          || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        this.reserved[row + r][col + c] = true;
      }
    }
  }

  setupTimingPattern() {
    for (let r = 8; r < this.moduleCount - 8; r += 1) {
      if (this.reserved[r][6]) continue;
      this.grid[r][6] = r % 2 === 0;
      this.reserved[r][6] = true;
    }
    for (let c = 8; c < this.moduleCount - 8; c += 1) {
      if (this.reserved[6][c]) continue;
      this.grid[6][c] = c % 2 === 0;
      this.reserved[6][c] = true;
    }
  }

  setupPositionAdjustPattern() {
    const pos = getPatternPosition(this.version);
    for (const row of pos) {
      for (const col of pos) {
        if (this.reserved[row][col]) continue;
        for (let r = -2; r <= 2; r += 1) {
          for (let c = -2; c <= 2; c += 1) {
            this.grid[row + r][col + c] =
              r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
            this.reserved[row + r][col + c] = true;
          }
        }
      }
    }
  }

  setupTypeNumber() {
    const bits = getBCHTypeNumber(this.version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >> i) & 1) === 1;
      const r1 = Math.floor(i / 3);
      const c1 = (i % 3) + this.moduleCount - 11;
      const r2 = (i % 3) + this.moduleCount - 11;
      const c2 = Math.floor(i / 3);
      this.grid[r1][c1] = dark;
      this.reserved[r1][c1] = true;
      this.grid[r2][c2] = dark;
      this.reserved[r2][c2] = true;
    }
  }

  // Reserve the format-information modules; setupTypeInfo() writes the real bits
  // once the mask pattern is known.
  setupTypeInfo() {
    for (let i = 0; i < 15; i += 1) {
      // vertical strip next to the top-left finder
      if (i < 6) this.markReserved(i, 8);
      else if (i < 8) this.markReserved(i + 1, 8);
      else this.markReserved(this.moduleCount - 15 + i, 8);
      // horizontal strip
      if (i < 8) this.markReserved(8, this.moduleCount - i - 1);
      else if (i < 9) this.markReserved(8, 15 - i);
      else this.markReserved(8, 15 - i - 1);
    }
    // Fixed dark module.
    this.markReserved(this.moduleCount - 8, 8);
  }

  markReserved(row, col) {
    this.reserved[row][col] = true;
    if (this.grid[row][col] === null) this.grid[row][col] = false;
  }

  writeTypeInfo(maskPattern) {
    const data = (EC_LEVEL[this.level] << 3) | maskPattern;
    const bits = getBCHTypeInfo(data);
    for (let i = 0; i < 15; i += 1) {
      const dark = ((bits >> i) & 1) === 1;
      if (i < 6) this.grid[i][8] = dark;
      else if (i < 8) this.grid[i + 1][8] = dark;
      else this.grid[this.moduleCount - 15 + i][8] = dark;
      if (i < 8) this.grid[8][this.moduleCount - i - 1] = dark;
      else if (i < 9) this.grid[8][15 - i] = dark;
      else this.grid[8][15 - i - 1] = dark;
    }
    this.grid[this.moduleCount - 8][8] = true;
  }

  mapData(data, maskPattern) {
    let inc = -1;
    let row = this.moduleCount - 1;
    let bitIndex = 7;
    let byteIndex = 0;
    const maskFunc = getMaskFn(maskPattern);

    for (let col = this.moduleCount - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1;
      while (true) {
        for (let c = 0; c < 2; c += 1) {
          const rr = row;
          const cc = col - c;
          if (!this.reserved[rr][cc]) {
            let dark = false;
            if (byteIndex < data.length) {
              dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
            }
            if (maskFunc(rr, cc)) dark = !dark;
            this.grid[rr][cc] = dark;
            bitIndex -= 1;
            if (bitIndex === -1) { byteIndex += 1; bitIndex = 7; }
          }
        }
        row += inc;
        if (row < 0 || this.moduleCount <= row) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
  }
}

const getLostPoint = (qr) => {
  const moduleCount = qr.moduleCount;
  let lostPoint = 0;

  // Rule 1: adjacent modules of the same colour.
  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      let sameCount = 0;
      const dark = qr.isDark(row, col);
      for (let r = -1; r <= 1; r += 1) {
        if (row + r < 0 || moduleCount <= row + r) continue;
        for (let c = -1; c <= 1; c += 1) {
          if (col + c < 0 || moduleCount <= col + c) continue;
          if (r === 0 && c === 0) continue;
          if (dark === qr.isDark(row + r, col + c)) sameCount += 1;
        }
      }
      if (sameCount > 5) lostPoint += 3 + sameCount - 5;
    }
  }

  // Rule 2: 2x2 blocks of the same colour.
  for (let row = 0; row < moduleCount - 1; row += 1) {
    for (let col = 0; col < moduleCount - 1; col += 1) {
      let count = 0;
      if (qr.isDark(row, col)) count += 1;
      if (qr.isDark(row + 1, col)) count += 1;
      if (qr.isDark(row, col + 1)) count += 1;
      if (qr.isDark(row + 1, col + 1)) count += 1;
      if (count === 0 || count === 4) lostPoint += 3;
    }
  }

  // Rule 3: 1:1:3:1:1 finder-like patterns.
  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount - 6; col += 1) {
      if (qr.isDark(row, col)
        && !qr.isDark(row, col + 1)
        && qr.isDark(row, col + 2)
        && qr.isDark(row, col + 3)
        && qr.isDark(row, col + 4)
        && !qr.isDark(row, col + 5)
        && qr.isDark(row, col + 6)) {
        lostPoint += 40;
      }
    }
  }
  for (let col = 0; col < moduleCount; col += 1) {
    for (let row = 0; row < moduleCount - 6; row += 1) {
      if (qr.isDark(row, col)
        && !qr.isDark(row + 1, col)
        && qr.isDark(row + 2, col)
        && qr.isDark(row + 3, col)
        && qr.isDark(row + 4, col)
        && !qr.isDark(row + 5, col)
        && qr.isDark(row + 6, col)) {
        lostPoint += 40;
      }
    }
  }

  // Rule 4: dark module balance.
  let darkCount = 0;
  for (let col = 0; col < moduleCount; col += 1) {
    for (let row = 0; row < moduleCount; row += 1) {
      if (qr.isDark(row, col)) darkCount += 1;
    }
  }
  const ratio = Math.abs((100 * darkCount) / moduleCount / moduleCount - 50) / 5;
  lostPoint += ratio * 10;

  return lostPoint;
};

const chooseVersion = (byteLength, level) => {
  for (let version = 1; version <= 40; version += 1) {
    const capacity = getTotalDataCount(version, level) * 8;
    const need = 4 + getLengthInBits(version) + byteLength * 8;
    if (need <= capacity) return version;
  }
  throw new Error('data too long for any QR version');
};

/**
 * Build a QR code model.
 * @param {string} text payload
 * @param {{ level?: 'L'|'M'|'Q'|'H' }} [options]
 * @returns {{ moduleCount:number, version:number, level:string,
 *             modules:boolean[][], isDark:(r:number,c:number)=>boolean }}
 */
export const createQRCode = (text, options = {}) => {
  const level = options.level || 'M';
  if (!(level in EC_LEVEL)) throw new Error(`invalid EC level ${level}`);
  const bytes = createBytes(text);
  const version = chooseVersion(bytes.length, level);
  const { codewords, totalDataCount } = createDataCodewords(version, level, text);
  if (codewords.length !== totalDataCount) {
    throw new Error(`data codeword count mismatch: ${codewords.length} != ${totalDataCount}`);
  }

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const qr = new QRMatrix(version, level, codewords);
    qr.mapData(qr.dataCache, mask);
    qr.writeTypeInfo(mask);
    const lost = getLostPoint(qr);
    if (best === null || lost < best.lost) best = { lost, mask, qr };
  }
  if (!best) throw new Error('failed to select a mask pattern');

  const grid = [];
  for (let r = 0; r < best.qr.moduleCount; r += 1) {
    grid[r] = [];
    for (let c = 0; c < best.qr.moduleCount; c += 1) grid[r][c] = best.qr.isDark(r, c);
  }

  return {
    moduleCount: best.qr.moduleCount,
    version,
    level,
    maskPattern: best.mask,
    modules: grid,
    codewords: best.qr.dataCache,
    isDark: (r, c) => grid[r][c],
  };
};

/**
 * Render a QR model as a self-contained SVG string with a quiet zone.
 * @param {ReturnType<typeof createQRCode>} qr
 * @param {{ scale?:number, margin?:number, dark?:string, light?:string, radius?:number }} [options]
 */
export const toSVG = (qr, options = {}) => {
  const scale = options.scale || 8;
  const margin = options.margin === undefined ? 4 : options.margin;
  const dark = options.dark || '#0b0f1a';
  const light = options.light || '#ffffff';
  const count = qr.moduleCount;
  const size = (count + margin * 2) * scale;

  // Merge horizontally adjacent dark modules into one rect to keep the SVG small.
  const rects = [];
  for (let r = 0; r < count; r += 1) {
    let c = 0;
    while (c < count) {
      if (!qr.isDark(r, c)) { c += 1; continue; }
      let run = 1;
      while (c + run < count && qr.isDark(r, c + run)) run += 1;
      rects.push(
        `<rect x="${(c + margin) * scale}" y="${(r + margin) * scale}" width="${run * scale}" height="${scale}"/>`,
      );
      c += run;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="${light}"/>`
    + `<g fill="${dark}">${rects.join('')}</g>`
    + '</svg>';
};

/** Convenience helper: encode text and return SVG directly. */
export const textToSVG = (text, options = {}) => toSVG(createQRCode(text, options), options);
