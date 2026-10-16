// 探针：量 `/api/archive/packs`（按需载荷）每个角色多少 KB，找最大的几个。
import { archiveCharacterPacks } from '../src/server/conclusion.js';
import { archiveIndex } from '../src/server/archive.js';

const index = await archiveIndex();
const list = (index.refs?.characters || []).map((c) => (c && typeof c === 'object' ? (c.name || c.key) : c));
const rows = [];
for (const c of list) {
  if (!c) continue;
  const r = await archiveCharacterPacks(c);
  const bytes = Buffer.byteLength(JSON.stringify(r));
  rows.push({
    c,
    kb: Math.round(bytes / 1024),
    n: (r.packs || []).length,
    names: Buffer.byteLength(JSON.stringify(r.versatilityMembers || [])),
    byTier: Buffer.byteLength(JSON.stringify(r.versatilityByTier || null)),
  });
}
rows.sort((a, b) => b.kb - a.kb);
for (const r of rows.slice(0, 12)) {
  console.log(`${String(r.c).padEnd(28)} ${String(r.kb).padStart(4)} KB｜packs ${String(r.n).padStart(2)}`
    + `｜名单 ${r.names}B｜byTier ${r.byTier}B｜泛用性字段合计 ${((r.names + r.byTier) / 1024).toFixed(1)} KB`);
}
console.log('≥400 KB 的角色数:', rows.filter((r) => r.kb >= 400).length, '/', rows.length);
