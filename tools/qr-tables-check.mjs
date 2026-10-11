// Structural validation of src/qr/tables.js against the QR Code specification
// (ISO/IEC 18004). Self-contained: it re-derives the invariants that must hold
// for a correct RS block table rather than diffing against a vendored library.
//
//   * total codewords per version must be identical across all EC levels
//   * total codewords must equal the symbol's data capacity
//   * data + EC codewords must match each row's total
//   * the data capacity must grow strictly with the version
//   * the alignment-pattern table must match the spec formula
import { RS_BLOCK_TABLE, PATTERN_POSITION_TABLE } from '../src/qr/tables.js';

let bad = 0;
const fail = (message) => { bad += 1; console.log(`FAIL  ${message}`); };

// ---------------------------------------------------------------- shape
const levels = ['L', 'M', 'Q', 'H'];
const byVersion = new Map();
for (const row of RS_BLOCK_TABLE) {
  const [version, level, ...groups] = row;
  if (!Number.isInteger(version) || version < 1 || version > 40) fail(`bad version ${version}`);
  if (!levels.includes(level)) fail(`bad level ${level} v${version}`);
  if (groups.length === 0 || groups.length % 3 !== 0) fail(`bad group shape v${version}${level}: ${groups}`);
  let blocks = 0;
  let total = 0;
  let data = 0;
  for (let g = 0; g < groups.length; g += 3) {
    const [count, totalCount, dataCount] = [groups[g], groups[g + 1], groups[g + 2]];
    if (count < 1) fail(`block count < 1 v${version}${level}`);
    if (dataCount < 1 || dataCount >= totalCount) fail(`bad data/total v${version}${level}`);
    blocks += count;
    total += count * totalCount;
    data += count * dataCount;
  }
  if (!byVersion.has(version)) byVersion.set(version, {});
  byVersion.get(version)[level] = { blocks, total, data };
}
if (byVersion.size !== 40) fail(`expected 40 versions, got ${byVersion.size}`);

// ------------------------------------------------- per-version invariants
for (const [version, perLevel] of [...byVersion.entries()].sort((a, b) => a[0] - b[0])) {
  for (const level of levels) {
    if (!perLevel[level]) fail(`v${version} missing level ${level}`);
  }
  const totals = levels.map((l) => perLevel[l]?.total).filter((t) => t !== undefined);
  if (new Set(totals).size !== 1) {
    fail(`v${version} total codewords differ across levels: ${JSON.stringify(totals)}`);
  }
// Spec capacity: total codewords = floor((moduleCount^2 - functionModules) / 8),
// where function modules are the finders + separators, timing, alignment
// patterns, format information, the dark module and (v >= 7) version info.
const functionModuleCount = (version) => {
  const n = version * 4 + 17;
  const grid = Array.from({ length: n }, () => new Array(n).fill(false));
  const mark = (r0, c0, h, w) => {
    for (let r = r0; r < r0 + h; r += 1) {
      for (let c = c0; c < c0 + w; c += 1) if (r >= 0 && r < n && c >= 0 && c < n) grid[r][c] = true;
    }
  };
  mark(0, 0, 9, 9);
  mark(0, n - 8, 9, 8);
  mark(n - 8, 0, 8, 9);
  mark(6, 8, 1, n - 16);
  mark(8, 6, n - 16, 1);
  mark(8, 0, 1, 9);
  mark(0, 8, 9, 1);
  mark(n - 8, 8, 8, 1);
  mark(8, n - 8, 1, 8);
  grid[n - 8][8] = true;
  for (const r of PATTERN_POSITION_TABLE[version - 1]) {
    for (const c of PATTERN_POSITION_TABLE[version - 1]) {
      const overlapsFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8);
      if (overlapsFinder) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) grid[r + dr][c + dc] = true;
      }
    }
  }
  if (version >= 7) {
    mark(0, n - 11, 6, 3);
    mark(n - 11, 0, 3, 6);
  }
  let count = 0;
  for (const row of grid) for (const cell of row) if (cell) count += 1;
  return count;
};

for (const [version, perLevel] of [...byVersion.entries()].sort((a, b) => a[0] - b[0])) {
  const n = version * 4 + 17;
  const expected = Math.floor((n * n - functionModuleCount(version)) / 8);
  const actual = perLevel.L.total;
  if (actual !== expected) {
    fail(`v${version} capacity ${actual} != spec ${expected} (${n}x${n})`);
  }
}
}

// Capacity must be strictly increasing with version.
const capacities = [...byVersion.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([version, perLevel]) => [version, perLevel.L.total]);
for (let i = 1; i < capacities.length; i += 1) {
  if (capacities[i][1] <= capacities[i - 1][1]) {
    fail(`capacity not increasing at v${capacities[i][0]}`);
  }
}

// -------------------------------------------------------- alignment table
// Spec formula: the first centre is always 6 and the last is moduleCount - 7.
const specPositions = (version) => {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32
    ? 26
    : Math.ceil((size - 13) / (2 * count - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
};
if (PATTERN_POSITION_TABLE.length !== 40) fail('PATTERN_POSITION_TABLE must have 40 entries');
PATTERN_POSITION_TABLE.forEach((actual, index) => {
  const version = index + 1;
  const expected = specPositions(version);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`alignment v${version}: got [${actual}] expected [${expected}]`);
  }
});
if (JSON.stringify(PATTERN_POSITION_TABLE[0]) !== '[]') fail('v1 must have no alignment pattern');

// ---------------------------------------------------------------- summary
const sample = [1, 2, 5, 7, 10, 14, 22, 30, 40]
  .map((v) => `v${v}=${byVersion.get(v).L.total}`)
  .join(' ');
console.log(`total codewords: ${sample}`);
console.log(`versions: ${byVersion.size}, rows: ${RS_BLOCK_TABLE.length}`);
console.log(bad === 0 ? 'TABLES OK' : `${bad} TABLE PROBLEM(S)`);
process.exit(bad === 0 ? 0 : 1);
