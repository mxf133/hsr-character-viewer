// 留档打包：把「现有软件 + 现用数据」冻结成一个时间戳快照，并压成一个 zip。
//
// 为什么要冻结而不是直接压工作目录：工作目录里有 200 MB 的逆向参考资料
// （.snapref/、snapref/、chrome-profile）和临时截图，它们不是软件的一部分，
// 也不该进存档。所以这里用「白名单复制」：只有清单里列出的路径会被写进快照，
// 复制完再逐文件算 SHA-256 写进 MANIFEST.json，最后整目录压成 zip。
//
// 用法:
//   node tools/package.mjs                       # 快照 + zip
//   node tools/package.mjs --no-zip              # 只生成快照目录
//   node tools/package.mjs --full                # 连原始投稿与首领排期一起留档（约 56 MB）
//   node tools/package.mjs --note "加星魂建议前"   # 给快照写一句说明
//   node tools/package.mjs --version v4.6.1      # 标注版本号（写进 MANIFEST，并加在 zip 文件名上）
//   node tools/package.mjs --out D:\backup       # 换个产出目录
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAM_VERSION, VERSION_TEXT } from '../src/version.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * 快照内容。`app/` 是可运行的软件本体，`data/` 是它当前使用的数据。
 *
 * theherta/raw 与 theherta/boss-data 合计约 56 MB，是可以用
 * tools/herta-fetch.mjs 重新抓取的原始投稿，不进快照；聚合结果
 * theherta/archive.json 才是界面真正读的东西。
 */
const LAYOUT = [
  {
    dir: 'app',
    entries: [
      ['bin', 'dir'],
      ['public', 'dir'],
      ['src', 'dir'],
      ['tools', 'dir'],
      ['snapref', 'dir'],
      ['package.json', 'file'],
      ['start.bat', 'file'],
      ['README.md', 'file'],
      ['.gitignore', 'file'],
    ],
  },
  {
    dir: 'data',
    entries: [
      ['theherta', 'dir', ['raw', 'boss-data']],
      ['data', 'dir', [], ['accounts.json']],
    ],
  },
];

/**
 * `--full` 时额外留档的内容：原始投稿与首领排期是 theherta 采集的**源材料**
 * （约 56 MB），能用 herta-fetch.mjs 重抓，但重抓拿到的是「那次抓取时的站点状态」，
 * 不是现在这一份。要连源材料一起冻住时用 --full。
 */
const FULL_LAYOUT = [
  {
    dir: 'data-source',
    entries: [
      ['theherta/raw', 'dir'],
      ['theherta/boss-data', 'dir'],
    ],
  },
];

/** 要被排除的临时产物（目录名直接比对，避免压进上级目录的同名文件）。 */
const SKIP_NAMES = new Set([
  'node_modules', '.git', '__pycache__', '.DS_Store', 'Thumbs.db', 'desktop.ini',
]);

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const note = flag('--note', '');
const outRoot = resolve(flag('--out', join(ROOT, 'snapshots')));
/** 版本号：默认取代码里的 PROGRAM_VERSION，可用 --version 覆盖（例如留档旧版）。 */
const version = flag('--version', PROGRAM_VERSION);
// 比较前去掉前缀 `v`：`--version v4.6.2` 与 PROGRAM_VERSION `4.6.2` 是同一个版本，
// 不该因为这个前缀就丢掉「（对齐游戏 4.6）」那一段说明。
const bare = (v) => String(v).replace(/^v/i, '');
const versionText = bare(version) === bare(PROGRAM_VERSION)
  ? VERSION_TEXT : `v${bare(version)}`;

/** 2026-10-05 14:51 → 20261005-1451（本地时间，和文件时间一致，便于对照） */
const stampOf = (date) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}`;
};

const walk = async (dir, out = []) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * 写一个 zip（deflate 压缩）。
 *
 * 不用 Compress-Archive / .NET：这台机器上 pwsh 的 -Command 传参会把开关当
 * 命令解析，也不保证 System.IO.Compression 可用；Node 自带 zlib，自己写
 * 本地头 + 中央目录反而是最短且零依赖的路。
 */
const writeZip = (zipPath, root) => {
  const crcTable = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    return table;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };

  // 递归收集，目录项也写进去（许多解压工具靠它建空目录，且能保留结构）。
  const entries = [];
  const collect = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        entries.push({ name: `${name}/`, full: null });
        collect(full, name);
      } else if (entry.isFile()) {
        entries.push({ name, full });
      }
    }
  };
  collect(root, '');

  const chunks = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0; // 时间戳留 0：快照目录名已经带了采集时间。
  for (const entry of entries) {
    const isDir = entry.full === null;
    const raw = isDir ? Buffer.alloc(0) : readFileSync(entry.full);
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const deflated = isDir ? Buffer.alloc(0) : deflateRawSync(raw, { level: 9 });
    // 压不动的小文件直接存储，比 deflate 头还小。
    const useStore = isDir || deflated.length >= raw.length;
    const body = useStore ? raw : deflated;
    const method = useStore ? 0 : 8;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_TIME, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_TIME, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(isDir ? 0x10 : 0, 38); // 目录属性
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(zipPath, Buffer.concat([...chunks, centralBuf, end]));
  return entries.length;
};

const main = async () => {
  const now = new Date();
  const stamp = stampOf(now);
  const snapshotRoot = join(outRoot, stamp);
  const files = [];

  for (const group of [...LAYOUT, ...(has('--full') ? FULL_LAYOUT : [])]) {
    const groupDir = join(snapshotRoot, group.dir);
    for (const [rel, kind, exclude = [], include = null] of group.entries) {
      const source = join(ROOT, rel);
      if (!existsSync(source)) {
        console.warn(`跳过（不存在）：${rel}`);
        continue;
      }
      const target = join(groupDir, rel);
      if (kind === 'file') {
        await mkdir(dirname(target), { recursive: true });
        await cp(source, target);
        files.push(target);
      } else {
        await mkdir(dirname(target), { recursive: true });
        await cp(source, target, {
          recursive: true,
          // `include` 只取列出的名字（例如 data/ 只留 accounts.json，别把整个
          // 工作目录的 data/ 都搬进来）；`exclude` 按名字剔除。
          filter: (src) => {
            const name = src.split(sep).pop();
            if (include) return include.includes(name);
            return !exclude.includes(name);
          },
        });
        // fs.cp 在「过滤器把内容全挡掉」时不会创建目标目录，walk 会直接 ENOENT，
        // 所以复制后自己补一个（空目录也不会被 walk 列进清单）。
        await mkdir(target, { recursive: true });
        files.push(...await walk(target));
      }
    }
  }

  // 逐文件指纹：存档里哪个字节变了，用 MANIFEST 一比就知道。
  const manifestFiles = {};
  let total = 0;
  for (const file of files.sort()) {
    const buf = await readFile(file);
    total += buf.length;
    manifestFiles[relative(snapshotRoot, file).split(sep).join('/')] = {
      bytes: buf.length,
      sha256: sha256(buf),
    };
  }

  const manifest = {
    kind: 'hsr-character-viewer-snapshot',
    stamp,
    createdAt: now.toISOString(),
    version,
    versionText,
    note,
    source: ROOT,
    node: process.version,
    fileCount: files.length,
    totalBytes: total,
    full: has('--full'),
    // 哪些东西故意没进快照，免得以后对不上数。
    excluded: [
      '.snapref/（逆向参考与 Chrome 临时 profile，约 119 MB）',
      ...(has('--full')
        ? []
        : ['theherta/raw/、theherta/boss-data/（原始投稿，可用 --full 留档，或 herta-fetch.mjs 重抓）']),
      'node_modules/、*.log、临时截图',
    ],
    dirs: Object.fromEntries([...LAYOUT, ...(has('--full') ? FULL_LAYOUT : [])]
      .map((g) => [g.dir, g.entries.map(([rel]) => rel)])),
    files: manifestFiles,
  };
  await writeFile(join(snapshotRoot, 'MANIFEST.json'),
    `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`快照已生成：${snapshotRoot}`);
  console.log(`  版本 ${versionText}`);
  console.log(`  文件 ${files.length} 个，共 ${(total / 1024 / 1024).toFixed(2)} MB`);

  if (has('--no-zip')) return;

  // zip 名带版本号：留档目录按时间戳排，但人找的是「哪个版本」。
  const zipPath = join(outRoot, `hsr-character-viewer-${version}-${stamp}.zip`);
  await rm(zipPath, { force: true });
  const entryCount = writeZip(zipPath, snapshotRoot);
  const info = await stat(zipPath);
  const buf = await readFile(zipPath);
  console.log(`已打包：${zipPath}`);
  console.log(`  ${entryCount} 个条目，${(info.size / 1024 / 1024).toFixed(2)} MB，`
    + `sha256 ${sha256(buf).slice(0, 16)}…`);
};

main().catch((err) => {
  console.error('打包失败：', err);
  process.exitCode = 1;
});
