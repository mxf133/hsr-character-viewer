// 「同步黑塔网」这条链路的回归测试（需求 7：同步不了 / 耗时过长 / 旧数据不跳过）。
//
// 覆盖三件事：
//   (a) 缺 `.snapref` 参考表时，herta-availability.mjs **不能写坏数据**、
//       退出码必须是 0、并且要明确打印警告（旧版直接 exit 1 → 整条同步链断在第 ② 步）；
//   (b) herta-update.mjs 的跳过判据：用夹具 + 注入的「今天」，**完全不联网**，
//       断言「已结束的期跳过、每个副本最新的一期必抓、还在收投稿的期必抓」；
//   (c) plan 行的 `total / skipped / capped / combos` 四个数自洽
//       （`total + skipped + capped === combos`），且 `latest` 是真实的数字最大版本号。
//
// 为什么用夹具而不是真数据集：判据的核心输入是 `submission_config.json` 里的
// `availableDate` / `expireDate`，而这些日期会随版本推进而变 —— 拿真数据集断言
// 「今天该抓 6 个」，过一个月就会假红。夹具把「今天」也一起注入（HERTA_TODAY），
// 于是判据是**可复现**的。
//
// 只用相对路径、只写 worktree 内的临时目录（放在 gitignore 掉的 theherta/backup/ 下），
// 跑完自己清理。用法：node tools/herta-sync-test.mjs
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

/** 从 --json 的 stdout 里取那行 plan；找不到就返回 null。 */
const planLineOf = (stdout) => {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const payload = JSON.parse(line);
      if (payload.type === 'plan') return payload;
    } catch { /* 不是 JSON 行，跳过 */ }
  }
  return null;
};

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

/** 跑一次 herta-update 的纯计划模式（--plan-only 不发任何请求、不写盘）。 */
const planOf = async (dataDir, extraArgs = []) => {
  const res = await run('herta-update.mjs', ['--json', '--plan-only', ...extraArgs], {
    HERTA_DATA_DIR: dataDir,
    HERTA_TODAY: FIXTURE.today,
    // 万一哪次忘了 --plan-only，也让它打不到真站点：
    HERTA_BASE: 'http://127.0.0.1:9',
  });
  return { res, plan: planLineOf(res.stdout) };
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
  const { res, plan } = await planOf(dataDir);
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
  const { plan: full } = await planOf(dataDir);
  const { plan: limited, res } = await planOf(dataDir, ['--limit=2']);
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
  const { plan } = await planOf(dataDir, ['--limit=abc', '--concurrency=0', '--timeout=-5']);
  assert(plan && plan.total === 4 && plan.capped === 0,
    '--limit=abc 被忽略（退回「不限」），计划与不带参数时一致',
    `实际 total=${plan?.total} capped=${plan?.capped}`);
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
    await testBuildRefusesToShrink();
    await testBuildRefusesEmptyRaw();
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
