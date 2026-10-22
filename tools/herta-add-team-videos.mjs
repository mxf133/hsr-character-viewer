// 给**已有的** `theherta/archive.json` 补上 `teams[].videos[]`（该阵容的全部投稿视频），
// **不动任何统计量**（runCount / frontier / 分数 / 名次全都不重算）。
//
// ## 为什么需要这个脚本，而不是直接 `herta-build.mjs`
//
// `archive.json` 是**入库的成品**，`herta-build.mjs` 是全量重算。而站点会**撤掉**赛季：
// 实测 2026-10-22，`/api/archive/submissions?season=4.5&mode=Memory of Chaos` 直接回
// `{"items":[],"count":0}`，`theherta/raw/submissions/4.5-Memory_of_Chaos.json` 也因此是空的
// —— 拿当前 raw 重建，混沌 4.5 的 **503 条投稿、225 套阵容**会整季消失（`v2 评分内核`
// 套件正是靠这些数字做判据，一重建就红）。
//
// 那种情况下唯一正确的做法是**别重建**：把新字段补进现有成品。这个脚本就是那条路。
// 反过来，如果 raw 是完整的，直接用 `herta-build.mjs` 重建即可（那时不需要它）。
//
// 用法：
//   node tools/herta-add-team-videos.mjs                          # 就地补 archive.json
//   node tools/herta-add-team-videos.mjs --from=<另一份 archive>   # 以那份为底、产出 archive.json
//   node tools/herta-add-team-videos.mjs --dry                    # 只报计划
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = process.env.HERTA_DATA_DIR ? resolve(process.env.HERTA_DATA_DIR) : join(ROOT, 'theherta');
const RAW = join(OUT, 'raw', 'submissions');
const TARGET = join(OUT, 'archive.json');

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => String(a).startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const DRY = process.argv.includes('--dry');
const FROM = arg('from', TARGET);

/** 站点用「叠影 0」表示这一位没装光锥（与 herta-build 的 superimpOf 同口径）。 */
const membersOf = (run) => {
  const out = [];
  for (let i = 1; i <= 4; i += 1) {
    const char = run[`p${i}_char`];
    if (typeof char !== 'string' || !char.trim()) continue;
    out.push(String(char).trim());
  }
  return out;
};

/** 存档的键是 `<模式英文名>|<关卡>|<版本>`，与 `archive.modes` 同源。 */
const stageOf = (mode, boss) => (mode === 'Anomaly Arbitration' && /plight/i.test(String(boss || ''))
  ? 'plight' : '');

const archive = JSON.parse(await readFile(FROM, 'utf8'));
console.log(`底稿：${FROM}（${(JSON.stringify(archive).length / 1024 / 1024).toFixed(1)} MB 量级）`);

// ---- 一、从 raw 汇总「每个赛季 × 每套阵容」的全部视频 ---------------------------
/** `${mode}|${stage}|${season}|${roster}` → `[{url, author, date, av, sub}]` */
const byTeam = new Map();
let rawFiles = [];
try {
  rawFiles = (await readdir(RAW)).filter((f) => f.endsWith('.json'));
} catch {
  console.error(`读不到 ${RAW}`);
  process.exit(1);
}

for (const file of rawFiles) {
  let payload;
  try {
    payload = JSON.parse(await readFile(join(RAW, file), 'utf8'));
  } catch { continue; }
  for (const run of payload?.items || []) {
    const url = typeof run.video_url === 'string' && /^https?:\/\//i.test(run.video_url.trim())
      ? run.video_url.trim() : null;
    if (!url) continue;
    const members = membersOf(run);
    if (!members.length) continue;
    const season = String(run.season || '');
    const mode = String(run.mode || '');
    const stage = stageOf(mode, run.boss_name);
    const roster = members.slice().sort().join(' + ');
    const key = `${mode}|${stage}|${season}|${roster}`;
    let list = byTeam.get(key);
    if (!list) byTeam.set(key, (list = []));
    if (list.some((v) => v.url === url)) continue;
    const av = Number(run.action_value);
    list.push({
      url,
      author: run.author_name ?? null,
      date: run.video_date ?? null,
      av: Number.isFinite(av) ? av : null,
      sub: run.subcategory ?? null,
    });
  }
}
console.log(`raw 里汇总出 ${byTeam.size} 套「赛季 × 阵容」的视频清单`);

// ---- 二、把这些视频贴到存档里的每套阵容上 -------------------------------------
let teams = 0;
let filled = 0;
let videos = 0;
const missing = [];
for (const [mode, modeEntry] of Object.entries(archive.modes || {})) {
  for (const [stage, stageEntry] of Object.entries(modeEntry.stages || {})) {
    for (const [season, seasonEntry] of Object.entries(stageEntry.seasons || {})) {
      for (const team of seasonEntry.teams || []) {
        teams += 1;
        const roster = (team.roster || []).map(String).sort().join(' + ');
        const list = byTeam.get(`${mode}|${stage}|${season}|${roster}`);
        if (!list?.length) {
          // 站点已撤掉这个赛季（4.5 混沌就是），如实记下来，不编、不借别的赛季。
          if (missing.length < 5) missing.push(`${mode}|${stage}|${season}| ${roster}`);
          continue;
        }
        team.videos = list;
        filled += 1;
        videos += list.length;
      }
    }
  }
}

console.log(`阵容 ${teams} 套：补上视频 ${filled} 套（共 ${videos} 条），没有视频来源 ${teams - filled} 套`);
if (missing.length) console.log(`（其中样例：${missing.join(' ／ ')}）`);
if (DRY) {
  console.log('--dry：不写盘');
  process.exit(0);
}

// ---- 三、原子写回（UNC 共享盘不支持 rename 覆盖已存在文件）----------------------
const text = JSON.stringify(archive);
const tmp = `${TARGET}.tmp`;
await writeFile(tmp, text, 'utf8');
try {
  await rename(tmp, TARGET);
} catch (error) {
  if (error?.code !== 'EPERM' && error?.code !== 'EACCES' && error?.code !== 'EEXIST') throw error;
  // ⚠️ 让位的名字必须**唯一**：`${TARGET}.old` 在第二次替换时已经存在，
  //    `rename` 覆盖已存在文件在 UNC 上照样 EPERM（第一次能过、第二次静默失败）。
  const aside = `${TARGET}.old-${Date.now()}`;
  await rename(TARGET, aside).catch(() => {});
  await rename(tmp, TARGET);
  await unlink(aside).catch(() => {});
}
console.log(`已写出 ${TARGET}  ${(Buffer.byteLength(text) / 1024 / 1024).toFixed(2)} MB`);
