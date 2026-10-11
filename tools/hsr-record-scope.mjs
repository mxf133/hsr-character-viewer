// 官方战绩接口能给哪些「战斗记录」？——第一节的范围确认工具。
//
// 已知：`/hkrpg/api/challenge` 给混沌回忆（本期 12 层、每层上下半间的队伍与回合数）。
// 未知：虚构叙事 / 末日幻影 / 异相仲裁 有没有对应记录，以及它们是不是同一个
// `challenge` 端点换 `schedule_type` 就能拿到。
//
// 两个阶段：
//   （离线，默认）读本地缓存里的 challenge/rogue，打印结构 —— 不发任何请求。
//   （--live）  对线上做一轮**最小**探测：schedule_type 1..4 + 两个候选端点。
//               走 src/mihoyo/http.js 的 request()，所以自动受节流保护
//               （最小间隔 700ms、10 秒内最多 6 个），不会把账号打进 10041 风控。
//   （--save）  把成功响应的原始 JSON 落到 .snapref/record-scope/，便于离线看真实结构。
//
// 用法:
//   node tools/hsr-record-scope.mjs
//   node tools/hsr-record-scope.mjs --live
//   node tools/hsr-record-scope.mjs --live --save
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDS } from '../src/mihoyo/ds.js';
import { communityHeaders, request } from '../src/mihoyo/http.js';
import { APP_VERSION, ENDPOINTS } from '../src/mihoyo/constants.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SAVE_DIR = join(ROOT, '.snapref', 'record-scope');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

const accounts = JSON.parse(readFileSync(join(ROOT, 'data/accounts.json'), 'utf8'));
const account = Object.values(accounts.accounts || {})[0];
if (!account) {
  console.error('data/accounts.json 里没有账号，先扫码登录。');
  process.exit(2);
}
const snapshots = Object.values(account.snapshots || {});
const snap = snapshots.find((s) => s.game === 'hsr') || snapshots[0];
if (!snap) {
  console.error('账号里还没有任何战绩快照，先在界面上读取一次角色信息。');
  process.exit(2);
}
const uid = String(snap.uid);
const server = snap.server || 'prod_gf_cn';
const masked = `${uid.slice(0, 3)}****${uid.slice(-2)}`;

/** 只打印结构，不打印内容：几百 KB 的原始数据打出来没法看，还可能带敏感字段。 */
const shapeOf = (value, depth = 0) => {
  if (Array.isArray(value)) {
    return `Array(${value.length})${value.length ? `[0]=${shapeOf(value[0], depth + 1)}` : ''}`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (depth >= 2) return `{${keys.slice(0, 8).join(' ')}}`;
    return `{${keys.map((k) => `${k}:${Array.isArray(value[k]) ? `A(${value[k].length})` : typeof value[k]}`).join(' ')}}`;
  }
  if (typeof value === 'string') return `"${value.slice(0, 24)}"`;
  return String(value);
};

// ---------------------------------------------------------------- 阶段一（离线）
console.log(`\n=== 本地缓存里已有的战斗记录（UID ${masked}，抓取于 ${snap.fetchedAt}）===`);
const ch = snap.challenge || {};
console.log(`challenge 顶层: ${shapeOf(ch)}`);
for (const key of ['star_num', 'battle_num', 'extra_star_num', 'max_floor_id', 'schedule_id', 'has_data']) {
  if (ch[key] !== undefined) console.log(`  ${key} = ${JSON.stringify(ch[key])}`);
}
for (const g of ch.groups || []) {
  console.log(`  groups: schedule_id=${g.schedule_id} status=${g.status} name=${g.name_mi18n}`
    + ` 上=${g.begin_time?.month}/${g.begin_time?.day} 下=${g.end_time?.month}/${g.end_time?.day}`);
}
for (const f of (ch.all_floor_detail || []).slice(0, 3)) {
  console.log(`  floor ${f.name}: ${f.star_num}★ round=${f.round_num}`
    + ` is_chaos=${f.is_chaos} is_tierce=${f.is_tierce}`
    + ` node1=${(f.node_1?.avatars || []).length}人 node2=${(f.node_2?.avatars || []).length}人`
    + ` node3=${f.node_3 ? (f.node_3.avatars || []).length + '人' : '无'}`);
}
console.log(`  floor 字段: ${shapeOf((ch.all_floor_detail || [])[0])}`);
console.log(`  node_1 字段: ${shapeOf((ch.all_floor_detail || [])[0]?.node_1)}`);
if ((ch.all_floor_detail || [])[0]?.node_1?.avatars?.[0]) {
  console.log(`  avatar 字段: ${shapeOf(ch.all_floor_detail[0].node_1.avatars[0])}`);
}
console.log(`  上半第一人原始字段: ${JSON.stringify(ch.all_floor_detail?.[0]?.node_1?.avatars?.[0])}`);
console.log(`  max_floor_detail: ${shapeOf(ch.max_floor_detail)}`);
console.log(`rogue 顶层: ${shapeOf(snap.rogue)}`);
console.log(`  unlockSummary = ${JSON.stringify(snap.unlockSummary)}`);
console.log(`card.data = ${JSON.stringify(snap.card?.data)}`);

if (!has('--live')) {
  console.log('\n（未加 --live，跳过线上探测）');
  process.exit(0);
}

// ---------------------------------------------------------------- 阶段二（线上）
console.log(`\n\n=== 线上探测（UID ${masked}，schedule_type 1..4 + 两个候选端点）===`);
console.log('节流：最小间隔 700ms、10 秒内最多 6 个请求（见 src/mihoyo/http.js）\n');

if (has('--save')) mkdirSync(SAVE_DIR, { recursive: true });

const targets = [
  {
    label: 'challenge（混沌回忆，已知可用）',
    path: 'challenge',
    query: `role_id=${uid}&server=${server}&schedule_type=1&need_all=true`,
    file: 'challenge-1.json',
  },
  // 下面四个端点的名字是从**官方战绩页 bundle** 里读出来的（`snapref/sr-bundle/bundle.js`
  // 的 api 表），不是猜的：
  //   getChallenge      -> /hkrpg/api/challenge        忘却之庭（混沌回忆）
  //   getChallengeStory -> /hkrpg/api/challenge_story  疑似虚构叙事
  //   getChallengeBoss  -> /hkrpg/api/challenge_boss   疑似末日幻影（boss 战）
  //   getPeakChallenge  -> /hkrpg/api/challenge_peak   疑似异相仲裁（巅峰挑战）
  //   getChallengeBrief -> /hkrpg/api/challenge_brief  疑似各模式进度汇总
  // 注意 `grid_fight` 虽然名字像棋盘，但官方调用它的是 getCurrencyWars（货币战争），
  // 不是异相仲裁——别被名字骗了。
  { label: 'challenge_story（疑似虚构叙事）', path: 'challenge_story', query: `role_id=${uid}&server=${server}&schedule_type=1&need_all=true`, file: 'challenge_story.json' },
  { label: 'challenge_boss（疑似末日幻影）', path: 'challenge_boss', query: `role_id=${uid}&server=${server}&schedule_type=1&need_all=true`, file: 'challenge_boss.json' },
  { label: 'challenge_peak（疑似异相仲裁）', path: 'challenge_peak', query: `role_id=${uid}&server=${server}&schedule_type=1&need_all=true`, file: 'challenge_peak.json' },
  { label: 'challenge_brief（疑似进度汇总）', path: 'challenge_brief', query: `role_id=${uid}&server=${server}`, file: 'challenge_brief.json' },
];

const only = (args.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
const picked = only ? targets.filter((t) => t.path.includes(only) || t.label.includes(only)) : targets;
console.log(`  本次探测 ${picked.length} 个端点${only ? `（--only=${only}）` : ''}\n`);

for (const target of picked) {
  const url = `${ENDPOINTS.gameRecord}/${target.path}?${target.query}`;
  let line = '';
  try {
    const res = await request(url, {
      headers: communityHeaders({
        'x-rpc-page': `${APP_VERSION}_#/sr`,
        DS: createDS({ query: target.query }),
      }),
      cookie: account.cookie,
      deviceId: account.deviceId,
      deviceFp: account.fingerprint,
      origin: 'https://api-takumi-record.mihoyo.com',
    });
    if (res.status === 404) {
      line = '不存在（404）';
    } else if (!res.json) {
      line = `HTTP ${res.status}，非 JSON`;
    } else {
      const { retcode, message, data } = res.json;
      line = `retcode=${retcode} ${String(message || '').slice(0, 40)}`;
      if (retcode === 0 && data) {
        const groups = (data.groups || []).map((g) => `${g.name_mi18n}(${g.status})`).join(' / ');
        const floors = data.all_floor_detail || [];
        line += `\n       赛程: ${groups || '(无 groups)'}`
          + `\n       层数: ${floors.length}  star_num=${data.star_num ?? '-'}  battle_num=${data.battle_num ?? '-'}`
          + `\n       顶层字段: ${Object.keys(data).join(' ')}`
          + `\n       首层: ${floors[0] ? `${floors[0].name} round=${floors[0].round_num} is_chaos=${floors[0].is_chaos} is_tierce=${floors[0].is_tierce}` : '(无)'}`;
        if (has('--save')) {
          writeFileSync(join(SAVE_DIR, target.file), JSON.stringify(data, null, 1), 'utf8');
        }
      }
    }
  } catch (err) {
    line = `ERR ${err.message}`;
  }
  console.log(`  ${target.label}\n       ${line}`);
}

if (has('--save')) console.log(`\n原始响应已保存到 .snapref/record-scope/`);
console.log('\ndone');
