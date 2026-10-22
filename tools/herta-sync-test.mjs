// 「同步黑塔网」这条链路的回归测试（需求 7：同步不了 / 耗时过长 / 旧数据不跳过）。
//
// 覆盖六件事：
//   (a) 缺 `.snapref` 参考表时，herta-availability.mjs **不能写坏数据**、
//       退出码必须是 0、并且要明确打印警告（旧版直接 exit 1 → 整条同步链断在第 ② 步）；
//   (b) herta-update.mjs 的跳过判据：用夹具 + 注入的「今天」，**完全不联网**，
//       断言「已结束的期跳过、每个副本最新的一期必抓、还在收投稿的期必抓」；
//   (c) plan 行的 `total / skipped / capped / combos` 四个数自洽
//       （`total + skipped + capped === combos`），且 `latest` 是真实的数字最大版本号；
//   (d) 聚合缩水时拒绝覆盖已提交的 archive.json；
//   (e) 宽限期与轮转清扫（2026-10-21 加）：期刚结束的仍要抓、最久没抓的定期补抓；
//   (f) 缩水护栏（2026-10-21 加）：抓取环节发现「线上条数比本地少」时不覆盖本地文件；
//   (g) 排期刷新（2026-10-21 加）：线上新增的版本必须能被增量同步看见；
//       排期接口挂掉时用本地排期继续、绝不中断同步。
//   (h) 站点撤掉整季（2026-10-22 加）：**沿用**现有 archive.json 里的那一季，
//       而不是整条拒绝覆盖 —— 后者会让同步永远失败（实测 4.5 混沌就是这么卡的）；
//   (i) 备份清理（2026-10-22 修）：只碰时间戳目录，不能把刚建好的那份备份删掉。
//
// 为什么用夹具而不是真数据集：判据的核心输入是 `submission_config.json` 里的
// `availableDate` / `expireDate`，而这些日期会随版本推进而变 —— 拿真数据集断言
// 「今天该抓 6 个」，过一个月就会假红。夹具把「今天」也一起注入（HERTA_TODAY），
// 于是判据是**可复现**的。
//
// 只用相对路径、只写 worktree 内的临时目录（放在 gitignore 掉的 theherta/backup/ 下），
// 跑完自己清理。用法：node tools/herta-sync-test.mjs
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const AVAIL = join(ROOT, 'theherta', 'unit-availability.json');

/** 临时夹具都放这里：theherta/backup/ 是 gitignore 掉的本地目录。 */
const SANDBOX = join(ROOT, 'theherta', 'backup', `sync-test-${process.pid}`);

let failures = 0;
let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ✓ ${label}`); };
const bad = (label, detail = '') => {
  checks += 1;
  failures += 1;
  console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
};
const assert = (cond, label, detail = '') => (cond ? ok(label) : bad(label, detail));

/** 跑一个脚本，抓 stdout / stderr / 退出码。 */
const run = (script, args, env, cwd = ROOT) => new Promise((resolvePromise) => {
  const child = spawn(process.execPath, [join(ROOT, 'tools', script), ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (err) => resolvePromise({ code: -1, stdout, stderr: String(err.message) }));
  child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
});

const sha = async (path) => createHash('sha256')
  .update(await readFile(path)).digest('hex');

/** 从 --json 的 stdout 里取指定 type 的那行 JSON；找不到就返回 null。 */
const jsonLineOf = (stdout, type) => {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const payload = JSON.parse(line);
      if (payload.type === type) return payload;
    } catch { /* 不是 JSON 行，跳过 */ }
  }
  return null;
};

/** 起一个一次性本地站点，替代 theherta.com（handler 返回要序列化的 JSON，抛错 = 500）。 */
const serve = (handler) => new Promise((done) => {
  const server = createServer(async (req, res) => {
    try {
      const body = await handler(new URL(req.url, 'http://local'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
  });
  server.listen(0, '127.0.0.1', () => done({
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  }));
});

// ------------------------------------------------------------------ fixtures

const MODES = ['Memory of Chaos', 'Pure Fiction'];

/**
 * 夹具排期。`today` 固定成 2026-06-15，好让每条分支都能被验证。
 *
 * 两个副本 × 四个期 = 8 个组合，每一个都对应一条判据分支：
 *
 *   2.0 MoC  排期里**没有**（该副本当时还没上线）+ 已同步 0 条
 *            → **必须跳过**（旧判据 `count <= 0` 会永远重抓它）
 *   2.0 PF   已排期、expireDate 已过、已同步 0 条 → **必须跳过**
 *   2.1 MoC  已排期、expireDate 已过、已同步 1 条 → **必须跳过**
 *   2.1 PF   排期里没有、本地**没有文件**（并集补出来的组合）
 *            → **必须抓一次**（reason=missing），抓到 0 条后下次就进跳过分支
 *   3.0 MoC  已排期、expireDate 已过，但它是 **MoC 的最新一期**
 *            → **必须抓**（版本号落后的副本不能被漏掉）
 *   3.0 PF   已排期、expireDate 2026-06-30 还没过 → **必须抓**（还在收投稿）
 *   3.1 MoC  排期里没有 + 已同步 0 条，**而且它就在全局最新的期里**
 *            → **必须跳过**（旧判据 `season === 最新版本` 会白白重抓它）
 *   3.1 PF   既是 PF 的最新一期、expireDate 也没过 → **必须抓**
 *
 * 期望：combos=8、total=4、skipped=4（latest=2 + live=1 + missing=1）。
 * ⚠️ 这组断言跑 `--grace=0 --sweep=0`：宽限期与清扫是**叠加**的判据，
 * 它们自己的行为在 (e) 用另一份夹具单独验证。
 */
const FIXTURE = {
  today: '2026-06-15',
  config: {
    categories: ['Clear'],
    modes: MODES,
    seasons: [
      { version: '2.0', modes: { 'Pure Fiction': { availableDate: '2026-01-01', expireDate: '2026-01-31' } } },
      {
        version: '2.1',
        modes: {
          'Memory of Chaos': { availableDate: '2025-12-01', expireDate: '2026-02-28' },
        },
      },
      {
        version: '3.0',
        modes: {
          'Memory of Chaos': { availableDate: '2026-05-01', expireDate: '2026-06-12' },
          'Pure Fiction': { availableDate: '2026-06-01', expireDate: '2026-06-30' },
        },
      },
      {
        version: '3.1',
        modes: {
          'Pure Fiction': { availableDate: '2026-06-16', expireDate: '2026-07-31' },
        },
      },
    ],
  },
  /**
   * 已经同步过的组合。注意 `2.1-Memory_of_Chaos` 刻意**不给文件**，
   * 用来验证「从未同步过 → 抓一次」。0 条的 `{items:[]}` 是**已同步**的合法状态。
   */
  synced: {
    '2.0-Memory_of_Chaos': { items: [] },
    '2.0-Pure_Fiction': { items: [] },
    '2.1-Memory_of_Chaos': { items: [{ id: 'r2' }] },
    '3.0-Memory_of_Chaos': { items: [{ id: 'r3' }] },
    '3.0-Pure_Fiction': { items: [{ id: 'r4' }] },
    '3.1-Memory_of_Chaos': { items: [] },
    '3.1-Pure_Fiction': { items: [{ id: 'r5' }] },
  },
  /** 期望被跳过 / 被抓住的组合，给断言用。 */
  expectTargets: [
    '3.0|Memory of Chaos', '3.0|Pure Fiction', '3.1|Pure Fiction', '2.1|Pure Fiction',
  ],
  expectSkipped: [
    '2.0|Memory of Chaos', '2.0|Pure Fiction', '2.1|Memory of Chaos', '3.1|Memory of Chaos',
  ],
};

const writeFixture = async () => {
  const dir = join(SANDBOX, 'fixture');
  await mkdir(join(dir, 'raw', 'submissions'), { recursive: true });
  await writeFile(join(dir, 'submission_config.json'), JSON.stringify(FIXTURE.config, null, 2), 'utf8');
  for (const [stem, payload] of Object.entries(FIXTURE.synced)) {
    await writeFile(join(dir, 'raw', 'submissions', `${stem}.json`), JSON.stringify(payload), 'utf8');
  }
  return dir;
};

/**
 * (e) 用的第二份夹具：专测宽限期与轮转清扫。today 同样是 2026-06-15
 * （宽限下限 = 2026-05-16）：
 *
 *   1.0 PF   已排期、04-01 结束（**超出宽限期**）、已同步 3 条 → 跳过（清扫候选）
 *   1.0 MoC  排期外空档、已同步 0 条 → 跳过（清扫候选）
 *   2.0 PF   06-01 结束（**宽限期内**）、已同步 5 条 → reason=grace
 *   2.0 MoC  排期外、没文件 → reason=missing
 *   3.0 PF   06-30 没结束，**且是 PF 的最新一期** → reason=latest
 *   3.0 MoC  06-01 结束（宽限期内），MoC 的最新一期是 4.0 → reason=grace（纯宽限）
 *   4.0 MoC  07-01 没结束、MoC 最新一期 → reason=latest
 *   4.0 PF   排期外、没文件 → reason=missing
 */
const GRACE_FIXTURE = {
  config: {
    categories: ['Clear'],
    modes: MODES,
    seasons: [
      { version: '1.0', modes: { 'Pure Fiction': { availableDate: '2026-03-01', expireDate: '2026-04-01' } } },
      { version: '2.0', modes: { 'Pure Fiction': { availableDate: '2026-05-01', expireDate: '2026-06-01' } } },
      {
        version: '3.0',
        modes: {
          'Memory of Chaos': { availableDate: '2026-05-01', expireDate: '2026-06-01' },
          'Pure Fiction': { availableDate: '2026-06-01', expireDate: '2026-06-30' },
        },
      },
      { version: '4.0', modes: { 'Memory of Chaos': { availableDate: '2026-06-10', expireDate: '2026-07-01' } } },
    ],
  },
  synced: {
    '1.0-Pure_Fiction': { items: [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }] },
    '1.0-Memory_of_Chaos': { items: [] },
    '2.0-Pure_Fiction': { items: [{ id: 'g4' }, { id: 'g5' }] },
    '3.0-Memory_of_Chaos': { items: [{ id: 'g6' }] },
  },
};

const writeGraceFixture = async () => {
  const dir = join(SANDBOX, 'grace');
  await mkdir(join(dir, 'raw', 'submissions'), { recursive: true });
  await writeFile(join(dir, 'submission_config.json'), JSON.stringify(GRACE_FIXTURE.config, null, 2), 'utf8');
  for (const [stem, payload] of Object.entries(GRACE_FIXTURE.synced)) {
    await writeFile(join(dir, 'raw', 'submissions', `${stem}.json`), JSON.stringify(payload), 'utf8');
  }
  // 清扫按「文件最旧」挑人：把两个候选的 mtime 钉死成已知先后。
  await utimes(join(dir, 'raw', 'submissions', '1.0-Memory_of_Chaos.json'),
    new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));
  await utimes(join(dir, 'raw', 'submissions', '1.0-Pure_Fiction.json'),
    new Date('2026-06-10T00:00:00Z'), new Date('2026-06-10T00:00:00Z'));
  return dir;
};

/** 跑一次 herta-update 的纯计划模式（--plan-only 不发任何请求、不写盘）。 */
const planOf = async (dataDir, extraArgs = []) => {
  const res = await run('herta-update.mjs', ['--json', '--plan-only', ...extraArgs], {
    HERTA_DATA_DIR: dataDir,
    HERTA_TODAY: FIXTURE.today,
    // 万一哪次忘了 --plan-only，也让它打不到真站点：
    HERTA_BASE: 'http://127.0.0.1:9',
  });
  return { res, plan: jsonLineOf(res.stdout, 'plan') };
};

// ----------------------------------------------------------------------- (a)

/**
 * (a) 参考表缺失时不写坏数据、退出码 0、有警告。
 *
 * `HERTA_REF_DIR` 指到一个不存在的目录，强制走降级分支 —— 不依赖本机
 * 到底有没有 `.snapref/`（有参考表的机器上也能跑这条断言）。
 */
const testAvailabilityDegrades = async () => {
  console.log('\n(a) 缺 .snapref 参考表时，单位表必须优雅降级');
  const before = await sha(AVAIL).catch(() => null);
  assert(before !== null, '前置：theherta/unit-availability.json 存在（成品已提交进仓库）');

  const res = await run('herta-availability.mjs', [], {
    HERTA_REF_DIR: join(SANDBOX, 'no-such-ref-dir'),
  });
  const output = `${res.stdout}${res.stderr}`;
  assert(res.code === 0, '退出码是 0（旧版是 1，整条同步链会断在这一步）',
    `实际退出码 ${res.code}；输出：${output.trim().slice(0, 300)}`);
  assert(/找不到 StarRailRes 参考表/.test(output), '打印了「找不到参考表」的警告',
    `输出：${output.trim().slice(0, 300)}`);
  assert(/沿用现有/.test(output), '明确说明沿用了现有成品');

  const after = await sha(AVAIL).catch(() => null);
  assert(after !== null && after === before, 'unit-availability.json 一个字节都没变',
    `before=${before} after=${after}`);

  // 降级后 herta-build.mjs 仍然拿得到输入（不能因为降级就把成品删了/写空）。
  const payload = JSON.parse(await readFile(AVAIL, 'utf8'));
  assert(Object.keys(payload.characters || {}).length > 0
    && Object.keys(payload.lightCones || {}).length > 0,
  '降级后成品里角色与光锥两张表都还在');
};

// ----------------------------------------------------------------------- (b)

/** (b) 跳过判据 + (c) plan 自洽，都用同一份夹具。 */
const testSkipCriterion = async (dataDir) => {
  console.log('\n(b) 跳过判据：已结束的期跳过、最新一期与进行中的期必抓');
  const { res, plan } = await planOf(dataDir, ['--grace=0', '--sweep=0']);
  if (!plan) {
    bad('拿到 plan 行', `退出码 ${res.code}；stdout：${res.stdout.slice(0, 300)}`);
    return;
  }
  ok('拿到 plan 行（--plan-only，完全没联网）');

  const targets = plan.targets.map((t) => t.replace(/\s*\/\s*/, '|'));
  assert(JSON.stringify([...targets].sort()) === JSON.stringify([...FIXTURE.expectTargets].sort()),
    '抓取集合正好是「该副本最新一期 + 未结束的期 + 从未同步过的期」',
    `期望 ${FIXTURE.expectTargets.join(', ')}；实际 ${targets.join(', ')}`);

  // 「旧数据不跳过」的正面证据：同步过、但期已结束 / 压根没排期的组合必须被跳过。
  for (const combo of FIXTURE.expectSkipped) {
    assert(!targets.includes(combo), `已结束（或没排期）的 ${combo.replace('|', ' / ')} 被跳过`);
  }
  // 「最新也不刷新」的正面证据：3.0 是 MoC 的最新一期，虽然 expireDate 已经过了也要抓。
  assert(targets.includes('3.0|Memory of Chaos'),
    'MoC 的最新一期（expireDate 已过）仍然重抓 —— 版本号落后的副本不会被漏掉');
  // 「进行中的期」：expireDate 未过 → 必须抓，这就是旧规则漏掉的那类。
  assert(targets.includes('3.0|Pure Fiction') && targets.includes('3.1|Pure Fiction'),
    'expireDate 还没过的期必抓（旧规则只认全局最新版本，会漏掉这些活跃期）');
  // 并集补出来的组合：本地没有文件 → 只抓这一次。
  assert(targets.includes('2.1|Pure Fiction') && plan.reasons.missing === 1,
    '排期里没有、本地也没有文件的组合抓一次（reason=missing）',
    `实际 missing=${plan.reasons.missing}`);

  assert(plan.reasons.latest === 2 && plan.reasons.live === 1,
    '原因归类正确：2 个「该副本最新一期」+ 1 个「未结束」+ 1 个「从未同步」',
    `实际 latest=${plan.reasons.latest} live=${plan.reasons.live} missing=${plan.reasons.missing}`);

  console.log('\n(c) plan 行的 total / skipped / capped / combos 自洽');
  assert(plan.combos === 8, 'combos = 4 个期 × 2 个副本 = 8', `实际 ${plan.combos}`);
  assert(plan.total === 4, 'total = 4', `实际 ${plan.total}`);
  assert(plan.skipped === 4, 'skipped = 4', `实际 ${plan.skipped}`);
  assert(plan.total + plan.skipped + (plan.capped || 0) === plan.combos,
    `total + skipped + capped === combos（${plan.total} + ${plan.skipped} + ${plan.capped || 0} === ${plan.combos}）`);
  assert(plan.capped === 0 && plan.planned === plan.total,
    '不带 --limit 时 capped 为 0、planned === total');
  assert(plan.latest === '3.1', 'latest 取数字最大的版本号（不是字典序）', `实际 ${plan.latest}`);
  assert(plan.latestByMode['Memory of Chaos'] === '3.0'
    && plan.latestByMode['Pure Fiction'] === '3.1',
  'latestByMode 按副本各算一份（MoC=3.0 落后于全局最新 3.1）',
  JSON.stringify(plan.latestByMode));
};

/** (c 续) --limit 只能收紧范围，不能改变判据本身。 */
const testLimitIsAdditiveOnly = async (dataDir) => {
  console.log('\n(c2) --limit 只截断抓取范围，不改判据');
  const { plan: full } = await planOf(dataDir, ['--grace=0', '--sweep=0']);
  const { plan: limited, res } = await planOf(dataDir, ['--grace=0', '--sweep=0', '--limit=2']);
  if (!limited) { bad('--limit=2 也能拿到 plan 行', `退出码 ${res.code}`); return; }
  assert(limited.skipped === full.skipped,
    `--limit 不影响跳过数（都是 ${full.skipped}）`, `实际 ${limited.skipped}`);
  assert(limited.planned === full.total, `planned 仍是完整计划 ${full.total}`, `实际 ${limited.planned}`);
  assert(limited.total === 2 && limited.capped === full.total - 2,
    `total=2、capped=${full.total - 2}`, `实际 total=${limited.total} capped=${limited.capped}`);
  assert(limited.total + limited.skipped + limited.capped === limited.combos,
    '带 --limit 时自洽关系依然成立');

  // 判据本身要能被 --all 关掉（它是显式的「我就是要全量」）。
  const { plan: all } = await planOf(dataDir, ['--all']);
  assert(all.total === all.combos && all.skipped === 0,
    '--all 时全部组合都进抓取集合、skipped 为 0',
    `实际 total=${all.total} skipped=${all.skipped} combos=${all.combos}`);
};

/** 默认参数不能被命令行弄松（`--limit=abc` 这类非法值要退回默认）。 */
const testBadArgsFallBackToDefaults = async (dataDir) => {
  console.log('\n(c3) 非法开关退回默认，默认行为不变松');
  const { plan } = await planOf(dataDir,
    ['--limit=abc', '--concurrency=0', '--timeout=-5', '--grace=0', '--sweep=0']);
  assert(plan && plan.total === 4 && plan.capped === 0,
    '--limit=abc 被忽略（退回「不限」），计划与不带参数时一致',
    `实际 total=${plan?.total} capped=${plan?.capped}`);
};

// ----------------------------------------------------------------------- (e)

/**
 * (e) 宽限期与轮转清扫（2026-10-21 加，动机见 tools/herta-update.mjs 文件头：
 * 站方收录滞后 ≥2 周，旧判据「过期即永久跳过」实测已丢 11 条）。
 */
const testGraceAndSweep = async (dataDir) => {
  console.log('\n(e) 宽限期与轮转清扫');

  // (e1) 默认宽限期：期刚结束的仍要抓。
  const { plan: withGrace } = await planOf(dataDir, ['--sweep=0']);
  assert(withGrace.graceDays === 30 && withGrace.graceLimit === '2026-05-16',
    'plan 行带上宽限参数（30 天 → 下限 2026-05-16）',
    `实际 graceDays=${withGrace.graceDays} graceLimit=${withGrace.graceLimit}`);
  assert(withGrace.reasons.grace === 2 && withGrace.total === 6,
    '宽限期内的 2 个期进抓取集合（total 4 → 6）',
    `实际 grace=${withGrace.reasons.grace} total=${withGrace.total} targets=${withGrace.targets.join('; ')}`);
  const gTargets = withGrace.targets.map((t) => t.replace(/\s*\/\s*/, '|'));
  assert(gTargets.includes('2.0|Pure Fiction') && gTargets.includes('3.0|Memory of Chaos'),
    '宽限期抓的是「期刚结束」的组合（含纯宽限的 3.0 MoC，它不是该副本最新一期）');

  // (e2) --grace=0 显式关掉：回到旧判据。
  const { plan: noGrace } = await planOf(dataDir, ['--grace=0', '--sweep=0']);
  assert(noGrace.reasons.grace === 0 && noGrace.total === 4,
    '--grace=0 时宽限期不生效（回到 4 个组合）',
    `实际 grace=${noGrace.reasons.grace} total=${noGrace.total}`);

  // (e3) 轮转清扫：每次补抓 1 个「文件最旧」的已结束组合。
  const { plan: swept } = await planOf(dataDir, ['--grace=0', '--sweep=1']);
  assert(swept.reasons.sweep === 1 && swept.total === 5,
    '--sweep=1 恰好把 1 个跳过组合转成清扫目标',
    `实际 sweep=${swept.reasons.sweep} total=${swept.total}`);
  const sTargets = swept.targets.map((t) => t.replace(/\s*\/\s*/, '|'));
  assert(sTargets.includes('1.0|Memory of Chaos') && !sTargets.includes('1.0|Pure Fiction'),
    '清扫挑的是 mtime 最旧的那个（1.0 MoC 06-01 < 1.0 PF 06-10）',
    `实际 targets=${sTargets.join('; ')}`);

  // (e4) --grace=abc 这类非法值退回默认 30（非负开关的「0」是显式关掉，不能混同）。
  const { plan: badGrace } = await planOf(dataDir, ['--grace=abc', '--sweep=0']);
  assert(badGrace.graceDays === 30 && badGrace.total === 6,
    '--grace=abc 退回默认 30 天',
    `实际 graceDays=${badGrace.graceDays} total=${badGrace.total}`);

  // (e5) --all 时清扫不重复挑人（全部组合本来就在抓取集合里）。
  const { plan: allPlan } = await planOf(dataDir, ['--all']);
  assert(allPlan.total === allPlan.combos && allPlan.skipped === 0
    && (allPlan.reasons.sweep || 0) === 0,
    '--all 时全部组合都进集合、清扫不额外挑人');
};

// ----------------------------------------------------------------------- (f)

/**
 * (f) 缩水护栏（2026-10-21 加）：抓取环节发现「线上条数比本地少」时不覆盖本地文件。
 * 场景：站点接口偶发的空/短响应会把整期清零，且该期从此被标成「已同步」永不重抓；
 * `theherta/raw/` 不进 git、留档也不含它。`herta-build.mjs` 的缩水护栏是**总量** 50%，
 * 单期清零只掉几个百分点，兜不住 —— 所以必须在写盘前拦住。
 */
const testShrinkGuard = async () => {
  console.log('\n(f) 缩水护栏：线上条数变少时不覆盖本地文件');
  const dir = join(SANDBOX, 'shrink');
  await mkdir(join(dir, 'raw', 'submissions'), { recursive: true });
  const cfg = {
    categories: ['Clear'],
    modes: ['Memory of Chaos'],
    seasons: [{
      version: '3.0',
      modes: { 'Memory of Chaos': { availableDate: '2026-06-01', expireDate: '2026-12-31' } },
    }],
  };
  await writeFile(join(dir, 'submission_config.json'), JSON.stringify(cfg), 'utf8');
  const local = { items: Array.from({ length: 5 }, (_, i) => ({ id: `r${i}` })), count: 5 };
  const localPath = join(dir, 'raw', 'submissions', '3.0-Memory_of_Chaos.json');
  await writeFile(localPath, JSON.stringify(local), 'utf8');
  const before = await sha(localPath);

  const remote = { items: local.items.slice(0, 3), count: 3 };
  const site = await serve((url) => (url.pathname === '/submission_config.json' ? cfg : remote));
  try {
    const res = await run('herta-update.mjs', ['--json'], { HERTA_DATA_DIR: dir, HERTA_BASE: site.base });
    const out = `${res.stdout}${res.stderr}`;
    assert(res.code === 0, '退出码 0（保留本地不算失败，下一轮还会再试）',
      `实际 ${res.code}；${out.slice(0, 200)}`);
    assert(/保留本地文件/.test(out), '明确说了「保留本地文件」', out.slice(0, 300));
    const doneLine = jsonLineOf(res.stdout, 'done');
    assert(doneLine && doneLine.shrunk?.length === 1
      && doneLine.shrunk[0].existing === 5 && doneLine.shrunk[0].count === 3,
    'done 行带 shrunk 明细（本地 5 → 线上 3）',
    JSON.stringify(doneLine?.shrunk));
    assert(await sha(localPath) === before, '本地文件一个字节都没变');

    // 显式 --allow-shrink 才允许覆盖（确认站点真的在删稿时的出口）。
    const forced = await run('herta-update.mjs', ['--json', '--allow-shrink'],
      { HERTA_DATA_DIR: dir, HERTA_BASE: site.base });
    const after = JSON.parse(await readFile(localPath, 'utf8'));
    assert(forced.code === 0 && after.items.length === 3,
      '--allow-shrink 时才真正覆盖（本地 5 → 3）', `实际 items=${after.items.length}`);
  } finally {
    await site.close();
  }
};

// ----------------------------------------------------------------------- (g)

/**
 * (g) 排期刷新（2026-10-21 加）：增量同步的一切判据都读本地 submission_config.json，
 * 而增量链此前从不拉它 —— 线上新增的版本（实测 4.7）对增量同步完全不可见。
 * 现在同步开头先刷排期：成功则落盘并让新版本进计划；失败则警告 + 用本地排期继续。
 */
const testConfigRefresh = async () => {
  console.log('\n(g) 排期刷新：线上新版本必须能被增量同步看见');
  const localCfg = {
    categories: ['Clear'],
    modes: ['Memory of Chaos'],
    seasons: [{
      version: '3.0',
      modes: { 'Memory of Chaos': { availableDate: '2026-06-01', expireDate: '2026-06-30' } },
    }],
  };
  const remoteCfg = {
    ...localCfg,
    seasons: [...localCfg.seasons, {
      version: '9.9',
      modes: { 'Memory of Chaos': { availableDate: '2026-12-01', expireDate: '2027-01-15' } },
    }],
  };

  // (g1) 成功路径：新版本落盘 + 进计划。
  const dir = join(SANDBOX, 'refresh');
  await mkdir(join(dir, 'raw', 'submissions'), { recursive: true });
  await writeFile(join(dir, 'submission_config.json'), JSON.stringify(localCfg), 'utf8');
  const site = await serve((url) => (url.pathname === '/submission_config.json' ? remoteCfg
    : { items: [], count: 0 }));
  try {
    const res = await run('herta-update.mjs', ['--json'], { HERTA_DATA_DIR: dir, HERTA_BASE: site.base });
    assert(res.code === 0, '退出码 0', `实际 ${res.code}；${res.stderr.slice(0, 200)}`);
    const onDisk = JSON.parse(await readFile(join(dir, 'submission_config.json'), 'utf8'));
    assert(onDisk.seasons.some((s) => s.version === '9.9'), '本地排期已被刷新出 9.9');
    const plan = jsonLineOf(res.stdout, 'plan');
    assert(plan && plan.targets.includes('9.9 / Memory of Chaos'),
      '计划里出现了新版本的组合（旧判据永远看不见它）',
      JSON.stringify(plan?.targets));
    assert(/排期已刷新/.test(res.stdout), '上报了「排期已刷新」');
  } finally {
    await site.close();
  }

  // (g2) 失败路径：排期接口 500 → 警告 + 用本地排期继续，绝不中断同步。
  const dir2 = join(SANDBOX, 'refresh-fail');
  await mkdir(join(dir2, 'raw', 'submissions'), { recursive: true });
  await writeFile(join(dir2, 'submission_config.json'), JSON.stringify(localCfg), 'utf8');
  const before = await sha(join(dir2, 'submission_config.json'));
  const site2 = await serve((url) => {
    if (url.pathname === '/submission_config.json') throw new Error('boom');
    return { items: [], count: 0 };
  });
  try {
    const res = await run('herta-update.mjs', ['--json'], { HERTA_DATA_DIR: dir2, HERTA_BASE: site2.base });
    const out = `${res.stdout}${res.stderr}`;
    assert(/排期刷新失败/.test(out), '打了「排期刷新失败」的警告', out.slice(0, 200));
    assert(jsonLineOf(res.stdout, 'plan') !== null, '照样给出了计划（没被排期失败打断）');
    assert(await sha(join(dir2, 'submission_config.json')) === before, '本地排期没被动过');
    assert(res.code === 0, '退出码仍是 0（警告不是失败）', `实际 ${res.code}`);
  } finally {
    await site2.close();
  }
};

// ----------------------------------------------------------------------- (d)

/**
 * (d) `archive.json`（22 MB、**提交进仓库**）不能被一次残缺的聚合写坏。
 *
 * 场景：新克隆的机器上 `theherta/raw/` 是空的（gitignore），或者这一趟只抓到了
 * 一小部分组合 —— 这时聚合出来的 archive 会小得可怜，直接覆盖就毁掉了整份可用数据集。
 * 断言：缩水超过一半时退出码非 0、**成品一个字节都不变**，而且报错要说清怎么救；
 * 显式加 `--allow-shrink` 才允许缩水。
 */
const testBuildRefusesToShrink = async () => {
  console.log('\n(d) 聚合缩水时拒绝覆盖已提交的 archive.json');
  const dir = join(SANDBOX, 'build');
  await mkdir(join(dir, 'raw', 'submissions'), { recursive: true });
  // 最小可用的输入：聚合要的那几个字典 + 一份「很大」的现有成品 + 一个很小的 raw
  for (const name of ['submission_config.json', 'characters_config.json',
    'character_paths.json', 'lightcone_paths.json', 'popular_lightcones.json']) {
    await writeFile(join(dir, name), await readFile(join(ROOT, 'theherta', name)), 'utf8');
  }
  for (const name of ['unit-availability.json']) {
    await writeFile(join(dir, name), await readFile(join(ROOT, 'theherta', name)), 'utf8');
  }
  const existing = { version: 2, runCount: 30000, counts: {}, refs: {}, modes: {}, characters: {} };
  await writeFile(join(dir, 'archive.json'), JSON.stringify(existing), 'utf8');
  const existingBefore = await sha(join(dir, 'archive.json'));

  // 只有一个组合、只有 2 条投稿 → runCount 远低于 30000 * 0.5
  await writeFile(join(dir, 'raw', 'submissions', '3.0-Memory_of_Chaos.json'), JSON.stringify({
    items: [
      {
        id: 'a', season: '3.0', mode: 'Memory of Chaos', boss_name: 'Boss', metric_value: 1,
        p1_char: 'Himeko', p1_eidolon: 0, p1_lc: 'Night on the Milky Way', p1_superimp: 1,
      },
      {
        id: 'b', season: '3.0', mode: 'Memory of Chaos', boss_name: 'Boss', metric_value: 2,
        p1_char: 'Himeko', p1_eidolon: 0, p1_lc: 'Night on the Milky Way', p1_superimp: 1,
      },
    ],
  }), 'utf8');

  const refused = await run('herta-build.mjs', [], { HERTA_DATA_DIR: dir });
  assert(refused.code !== 0, '缩水时退出码非 0', `实际 ${refused.code}`);
  assert(/拒绝覆盖/.test(refused.stderr), '报错说明了「拒绝覆盖」', refused.stderr.trim().slice(0, 200));
  assert(/--allow-shrink/.test(refused.stderr), '报错给出了补救办法（--allow-shrink）');
  assert(await sha(join(dir, 'archive.json')) === existingBefore,
    '现有 archive.json 一个字节都没变（这才是关键）');

  const forced = await run('herta-build.mjs', ['--allow-shrink'], { HERTA_DATA_DIR: dir });
  assert(forced.code === 0, '显式 --allow-shrink 时允许缩水写入', `实际 ${forced.code}`);
  const written = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
  assert(written.runCount === 2, '缩水写入的 runCount 是 2（确认拿到的是新内容）',
    `实际 ${written.runCount}`);
};

/** 空 raw 目录连聚合都不该开始（更早的一道闸）。 */
const testBuildRefusesEmptyRaw = async () => {
  console.log('\n(d2) raw 目录为空时直接拒绝（别写出一个空壳成品）');
  const dir = join(SANDBOX, 'build-empty');
  await mkdir(join(dir, 'raw', 'submissions'), { recursive: true });
  for (const name of ['submission_config.json', 'characters_config.json',
    'character_paths.json', 'lightcone_paths.json', 'popular_lightcones.json',
    'unit-availability.json']) {
    await writeFile(join(dir, name), await readFile(join(ROOT, 'theherta', name)), 'utf8');
  }
  await writeFile(join(dir, 'archive.json'), JSON.stringify({ runCount: 30000 }), 'utf8');
  const before = await sha(join(dir, 'archive.json'));
  const res = await run('herta-build.mjs', [], { HERTA_DATA_DIR: dir });
  assert(res.code !== 0, '退出码非 0', `实际 ${res.code}`);
  assert(/一个投稿文件都没有/.test(res.stderr), '报错说明 raw 里没有投稿文件', res.stderr.trim());
  assert(await sha(join(dir, 'archive.json')) === before, '现有 archive.json 没被动过');
};

// ----------------------------------------------------------------------- (h)

/**
 * (h) 站点撤掉整季时**沿用**现有 archive.json，而不是让整条同步永远失败。
 *
 * 真实事故（2026-10-22）：黑塔网把「4.5 混沌回忆」整季撤了（接口直接回
 * `{"items":[],"count":0}`），而入库的 archive.json 里那一季有 503 条真实投稿。
 * 第一版护栏选择「整条拒绝覆盖、退出码 1」⇒ 站点既然撤了，这一季就永远回不来，
 * 于是之后**每一次**同步都卡在聚合这一步，界面永远显示
 * 「失败：数据已抓取（新增 0 条、变化 61 条），但重新聚合失败」—— 护住了那一季，
 * 却把整条链路锁死了（抓到的变化一条也进不了成品）。
 *
 * 断言：
 *   ① 默认口径：退出码 0、那一季**原样**留在成品里、总投稿数把它算进去；
 *   ② `--allow-drop-season`：真的丢掉（用户确认要接受损失时的唯一出口）。
 */
const testSeasonDropKeepsPrevious = async () => {
  console.log('\n(h) 站点撤掉整季时沿用现有 archive.json（别把同步锁死）');
  const dir = join(SANDBOX, 'drop-season');
  await mkdir(join(dir, 'raw', 'submissions'), { recursive: true });
  for (const name of ['submission_config.json', 'characters_config.json',
    'character_paths.json', 'lightcone_paths.json', 'popular_lightcones.json',
    'unit-availability.json']) {
    await writeFile(join(dir, name), await readFile(join(ROOT, 'theherta', name)), 'utf8');
  }
  // raw 里 3.0 混沌有 3 条；4.5 混沌只剩站点回空时写下的那 22 字节空文件。
  const items = ['a', 'b', 'c'].map((id, i) => ({
    id, season: '3.0', mode: 'Memory of Chaos', boss_name: 'Boss', metric_value: i + 1,
    p1_char: 'Himeko', p1_eidolon: 0, p1_lc: 'Night on the Milky Way', p1_superimp: 1,
  }));
  await writeFile(join(dir, 'raw', 'submissions', '3.0-Memory_of_Chaos.json'),
    JSON.stringify({ items }), 'utf8');
  await writeFile(join(dir, 'raw', 'submissions', '4.5-Memory_of_Chaos.json'),
    '{"items":[],"count":0}', 'utf8');

  const season45 = {
    runCount: 200, totalTeams: 2, median: 1, lowerIsBetter: true, dist: null,
    lines: null, reliable: true, perfect: 2, target: 0, pass: 0, below: 0,
    frontier: [],
    teams: [{
      rosterKey: 'Himeko', roster: ['Himeko'], slots: ['Himeko'], count: 200,
      best: 1, bestAv: 100, avgAv: 100, bosses: [], subcategories: [],
      perfect: 2, target: 0, pass: 0, below: 0, tierTotal: 2, cost: 0, costMax: 0,
      over: [0, 0, 0, 0], coneOver: [0, 0, 0, 0], keyEidolon: 0, keyEidolonShare: 1,
      eidoDist: [200, 0, 0, 0, 0], sample: null,
    }],
  };
  const existing = {
    version: 2, runCount: 203, seasonCount: 1, counts: {}, refs: {}, characters: {},
    modes: {
      'Memory of Chaos': {
        stages: {
          '': { seasons: { '4.5': season45 }, runCount: 200, teamsSeen: 2, seasonList: ['4.5'] },
        },
      },
    },
  };
  await writeFile(join(dir, 'archive.json'), JSON.stringify(existing), 'utf8');

  const kept = await run('herta-build.mjs', [], { HERTA_DATA_DIR: dir });
  assert(kept.code === 0, '默认口径下退出码是 0（同步能完成）', `实际 ${kept.code}\n${kept.stderr.trim()}`);
  assert(/已沿用/.test(kept.stderr), '日志说明了「沿用现有 archive.json」', kept.stderr.trim().slice(0, 200));
  const written = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
  const stage = written.modes?.['Memory of Chaos']?.stages?.[''];
  assert(Number(stage?.seasons?.['4.5']?.runCount) === 200, '4.5 那一季原样留在成品里',
    `实际 ${stage?.seasons?.['4.5']?.runCount}`);
  assert(Number(stage?.seasons?.['4.5']?.totalTeams) === 2, '阵容数也是原样');
  assert((stage?.seasonList || []).join(',') === '3.0,4.5', 'seasonList 里新旧两季都在',
    `实际 ${(stage?.seasonList || []).join(',')}`);
  assert(written.runCount === 203, '总投稿数把沿用的那 200 条算进去了（3 + 200）',
    `实际 ${written.runCount}`);

  // --allow-drop-season 是唯一出口：确认损失后真的丢掉。
  // 同一次还要 --allow-shrink —— 丢掉 200 条后总量必然跌破 50%。
  const dropped = await run('herta-build.mjs', ['--allow-drop-season', '--allow-shrink'],
    { HERTA_DATA_DIR: dir });
  assert(dropped.code === 0, '--allow-drop-season 时退出码 0', `实际 ${dropped.code}`);
  assert(/已按 --allow-drop-season 丢弃/.test(dropped.stderr), '日志说明了丢弃了哪些期');
  const droppedArchive = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
  assert(!droppedArchive.modes?.['Memory of Chaos']?.stages?.['']?.seasons?.['4.5'],
    '加上 --allow-drop-season 后那一季真的从成品里消失了');
  assert(droppedArchive.runCount === 3, '总投稿数只剩新的 3 条', `实际 ${droppedArchive.runCount}`);
};

// ----------------------------------------------------------------------- (i)

/**
 * (i) 备份清理**不能吃掉刚建好的那份备份**。
 *
 * 真实事故（2026-10-22）：`pruneBackups` 把 `theherta/backup/` 下所有目录名排序后取
 * 尾部 5 个。备份名 `20261022-200234` 是数字开头、测试夹具 `sync-test-<pid>` 是字母开头，
 * 字典序里数字排在字母**前**面 ⇒ 刚建好的备份永远是最“早”的一个，同步一结束就被
 * 自己删掉。界面上那句「已留档 4 个文件到 theherta/backup/20261022-200234/」是空话
 * （去目录里一看根本没有），而且正好发生在聚合失败、最需要回滚的那一次。
 *
 * 断言：旧的按 keep 清掉、最新的留着、非时间戳目录（夹具 / 手工放的目录）不碰。
 */
const testPruneBackupsIgnoresNonStamp = async () => {
  console.log('\n(i) 备份清理只碰时间戳目录，不吃掉刚建的那份');
  const { backupPruneTargets, pruneBackups } = await import('../src/server/archive-update.js');
  // ⚠️ 断的是**纯函数选出来的名单**：UNC / 沙箱里 `rm` 会被安全删除钩子拦下
  //    （实测 `genie-trash` 失败 → 目录原地不动），对真实目录断「删没删掉」测的是
  //    环境而不是逻辑。名单对了、真删不炸，这条链就没问题。
  const names = ['20260101-010101', '20261022-200234', '20260102-010101',
    '20260103-010101', 'sync-test-123'];
  const targets = backupPruneTargets(names, 2);
  assert(!targets.includes('20261022-200234'),
    '刚建好的那份不在清理名单里（旧写法按字典序把它排在最前）', targets.join(','));
  assert(targets.join(',') === '20260101-010101,20260102-010101',
    '按名字（= 时间）从最旧的开始清，非时间戳目录不进名单', targets.join(','));
  assert(backupPruneTargets(names, 5).length === 0, '份数不足 keep 时一个都不删',
    backupPruneTargets(names, 5).join(','));

  const dir = join(SANDBOX, 'backup-prune');
  for (const name of names) await mkdir(join(dir, name), { recursive: true });
  let threw = null;
  await pruneBackups(2, dir).catch((err) => { threw = err.message; });
  assert(threw === null, 'pruneBackups 不因某个目录删不掉而抛错', threw || '');
  assert((await readdir(dir)).includes('20261022-200234'), '刚建好的那份仍在目录里');
};

// ---------------------------------------------------------------------- main

const main = async () => {
  console.log('同步黑塔网链路的回归测试（tools/herta-sync-test.mjs）');
  await mkdir(SANDBOX, { recursive: true });
  try {
    await testAvailabilityDegrades();
    const dataDir = await writeFixture();
    await testSkipCriterion(dataDir);
    await testLimitIsAdditiveOnly(dataDir);
    await testBadArgsFallBackToDefaults(dataDir);
    const graceDir = await writeGraceFixture();
    await testGraceAndSweep(graceDir);
    await testShrinkGuard();
    await testConfigRefresh();
    await testBuildRefusesToShrink();
    await testBuildRefusesEmptyRaw();
    await testSeasonDropKeepsPrevious();
    await testPruneBackupsIgnoresNonStamp();
  } finally {
    // 夹具目录在 gitignore 的 theherta/backup/ 下，跑完自己收拾干净。
    await rm(SANDBOX, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${failures === 0 ? '全部通过 ✓' : `${failures} 项失败`}（共 ${checks} 项断言）`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('测试自身崩了：', err);
  process.exit(1);
});
