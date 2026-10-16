/**
 * 临时探针（2026-10-17 第 5 条）：量 `avTeams`（行动值前沿池）现在带不带视频。
 *
 * 改前的实测：抽卡方案 15 张卡只有 7 张有视频 —— 缺的全是这一池的队伍。
 * 走 `conclusionEnvs`（与生产同一条取数路径），不用浏览器。
 */
import { setArchiveDir, archiveIndex } from '../src/server/archive.js';
import { conclusionEnvs } from '../src/server/conclusion.js';

const dir = process.argv[2] || 'theherta';
setArchiveDir(dir);

const index = await archiveIndex();
const { envs, skipped } = await conclusionEnvs(index, { window: 6 });

let total = 0;
let withVideo = 0;
const perEnv = [];
const misses = [];

for (const env of envs) {
  const rows = env.avTeams || [];
  let hit = 0;
  for (const row of rows) {
    total += 1;
    if (row.video) { withVideo += 1; hit += 1; }
    else if (misses.length < 10) {
      misses.push({
        env: env.id,
        av: row.av,
        season: row.season,
        cost: row.cost,
        members: (row.members || []).map((m) => `${m.char}E${m.eidolon}`).join('+'),
      });
    }
  }
  perEnv.push({ 关卡: env.label || env.id, 前沿: rows.length, 有视频: hit });
}

console.log(JSON.stringify({
  目录: dir,
  关卡数: envs.length,
  跳过: skipped,
  前沿行总数: total,
  有视频: withVideo,
  无视频: total - withVideo,
  覆盖率: total ? `${((withVideo / total) * 100).toFixed(1)}%` : '—',
  逐关: perEnv,
  缺的例子: misses,
}, null, 2));
