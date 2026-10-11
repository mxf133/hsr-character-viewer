// 探针：统计黑塔网原始投稿里「角色有、叠影字段缺失」的比例。
// 用途：验证「叠影缺失是读取缺陷」这个判断（用户第 8 条）。
// 用法：node tools/_probe-superimp.mjs
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'theherta', 'raw', 'submissions');

const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'));
let totalChar = 0;
let noField = 0;
let isNull = 0;
let isZero = 0;
const samples = [];
const perFile = [];
for (const f of files) {
  let j;
  try { j = JSON.parse(await readFile(join(DIR, f), 'utf8')); } catch { continue; }
  const items = j.items || [];
  let n = 0; let miss = 0;
  for (const r of items) {
    for (let i = 1; i <= 4; i += 1) {
      const c = r[`p${i}_char`];
      if (typeof c !== 'string' || !c.trim()) continue;
      totalChar += 1; n += 1;
      const key = `p${i}_superimp`;
      const has = Object.prototype.hasOwnProperty.call(r, key);
      const v = r[key];
      if (!has) { noField += 1; miss += 1; if (samples.length < 5) samples.push({ f, id: r.id, i, why: 'no-field' }); } else if (v === null || v === undefined || v === '') { isNull += 1; miss += 1; if (samples.length < 5) samples.push({ f, id: r.id, i, why: 'null' }); } else if (Number(v) === 0) { isZero += 1; }
    }
  }
  if (miss) perFile.push(`${f}: ${miss}/${n}`);
}
console.log(JSON.stringify({ totalChar, noField, isNull, isZero, perFile, samples }, null, 1));
