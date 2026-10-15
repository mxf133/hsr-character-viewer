// Runs all test suites, or a selected subset, and reports a single summary.
// Run with: node tools/run-tests.mjs [--suite <file>]... [--list]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The layout suite drives a real browser over the DevTools Protocol, so it only
// runs when one is already listening on the debug port. Without it the suite
// reports the skip instead of failing, because a missing browser is an
// environment fact rather than a defect in the page.
const cdpAvailable = async (port = 9222) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
};

const suites = [
  ['凭证加密与明文迁移', 'credential-vault-test.mjs'],
  ['联网策略与新鲜窗口', 'cache-policy-test.mjs'],
  ['按账号隔离的请求节流', 'request-throttle-test.mjs'],
  ['QR 规格表校验 (ISO/IEC 18004)', 'qr-tables-check.mjs'],
  ['QR 编解码往返 + RS 校验', 'qr-selftest.mjs'],
  ['米游社接口签名与连通性 (实时)', 'api-wiring-test.mjs'],
  ['扫码轮询竞态回归', 'qr-poll-regression.mjs'],
  ['设备指纹接线 (x-rpc-device_fp)', 'devicefp-test.mjs'],
  ['星铁角色解析 (实测 payload)', 'hsr-parse-test.mjs'],
  ['字段格式 (实测 payload)', 'format-shapes-test.mjs'],
  ['抽卡推荐算法', 'herta-test.mjs'],
  // 队伍口径的抽卡方案（用户 2026-10-11 第 10 轮）：合成夹具 + 真数据真服务两面。
  // ⚠️ 它自己起一个注入假 store 的 HTTP 服务，**不需要** DPAPI 凭证，所以任何环境都能跑。
  ['队伍抽卡方案（两指标 / 补金顺序 / availability）', 'team-plan-test.mjs'],
  // 虚拟账号的预设与自定义名单（用户 2026-10-13 第 3、4 条）：直接读真实数据集，
  // 不碰 DPAPI 凭证、也不起 HTTP 服务（接口那一层由 `e2e-test.mjs` 钉）。
  ['虚拟账号预设与自定义名单', 'virtual-accounts-test.mjs'],
  // 「同步黑塔网」的跳过判据 / 参考表降级 / 聚合缩水保护（用户 2026-10-14 第 7 条）。
  // ⚠️ **完全不联网**：夹具在 `theherta/backup/sync-test-<pid>/`（gitignore）里自造自清，
  // 「今天」由 `HERTA_TODAY` 注入，所以判据可复现、不会过一个月就假红。
  ['同步黑塔网（跳过判据 / 降级 / 缩水保护）', 'herta-sync-test.mjs'],
  // 用户 2026-10-14 点名的两条不变式：强度对投入单调（E6S5 > E6S1 > E2S1 > E0S0）、
  // 以及成本账（限定 E6S5 不算隐金 = 12 金）。离线，样本角色，实测 638 组可比档位。
  ['强度口径不变式（投入单调 / E6S5=12 金）', 'strength-invariant-test.mjs'],
  ['中文名称映射 (对照游戏内中文)', 'herta-i18n-check.mjs'],
  // 「和 GitHub 上的最新发布比一比」（用户 2026-10-14 第 5 条）。**完全不联网**：
  // `fetchImpl` 是注入的，所以断网 / 被墙的机器照样跑，也不消耗 GitHub 匿名配额。
  ['版本检查（GitHub 最新发布比对）', 'update-check-test.mjs'],
  ['端到端 HTTP / 静态资源 / 会话', 'e2e-test.mjs'],
  ['启动器 start.bat 自检', 'launcher-test.mjs'],
  ['启动后自动打开浏览器', 'launcher-open-test.mjs'],
  ['抽卡推荐界面布局 (CDP)', 'check-advice-layout.mjs'],
];

const usage = `Usage: node tools/run-tests.mjs [options]

Options:
  --list                 List test suite filenames
  --suite <filename>     Run only this suite; may be repeated
  --help                 Show this help`;

const selectedFiles = [];
let listOnly = false;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--help' || arg === '-h') {
    console.log(usage);
    process.exit(0);
  }
  if (arg === '--list') {
    listOnly = true;
    continue;
  }
  if (arg === '--suite') {
    const file = process.argv[i + 1];
    if (!file || file.startsWith('--')) {
      console.error('--suite requires a test filename.\n');
      console.error(usage);
      process.exit(2);
    }
    selectedFiles.push(file);
    i += 1;
    continue;
  }
  console.error(`Unknown option: ${arg}\n`);
  console.error(usage);
  process.exit(2);
}

if (listOnly) {
  for (const [, file] of suites) console.log(file);
  process.exit(0);
}

const requested = new Set(selectedFiles);
const unknownFiles = [...requested].filter((file) => !suites.some(([, suiteFile]) => suiteFile === file));
if (unknownFiles.length) {
  console.error(`Unknown test suite${unknownFiles.length > 1 ? 's' : ''}: ${unknownFiles.join(', ')}`);
  console.error('Use --list to see available filenames.');
  process.exit(2);
}

let suitesToRun;
if (requested.size) {
  suitesToRun = suites.filter(([, file]) => requested.has(file));
} else {
  suitesToRun = suites.filter(([, file]) => file !== 'check-advice-layout.mjs');
  if (await cdpAvailable()) {
    suitesToRun.push(suites.find(([, file]) => file === 'check-advice-layout.mjs'));
  } else {
    console.log('\n▶ 抽卡推荐界面布局 (CDP)\n   跳过：9222 端口没有可用的调试浏览器');
  }
}

/**
 * 让 CDP 套件能指向**别的端口**（在 worktree 里验证自己的改动时必须这样）。
 *
 * 背景：`check-advice-layout.mjs` 默认打 `http://127.0.0.1:8360/?view=advice` ——
 * 那是 `main` 的常驻服务。在 worktree 里跑全套时，如果不指路，测的其实是 **main 的代码**，
 * 要么假绿、要么报一堆与本次改动无关的错。
 *
 * ⚠️ 两个坑（都实测踩过）：
 *   1. URL **必须带 `?view=advice`**（套件默认值里就带着）。传裸 `http://…:8390/` 的话
 *      抽卡推荐页根本不会打开，`#adviceConclusionUnits` / 权重输入框 / 队伍方案全是空的 ——
 *      看起来像「4 项布局回归」，其实只是页面没切过去；
 *   2. 换个端口就是换个 **origin**，localStorage 里的权重存档是空的。想复现 main 上的
 *      表现，得先把那边 `hsr.*` 的键搬过来（`tools/_probe-seed-localstorage.mjs`）。
 *
 *   CHECK_ADVICE_URL='http://127.0.0.1:8390/?view=advice' node tools/run-tests.mjs
 */
const ADVICE_URL = process.env.CHECK_ADVICE_URL || '';

const run = (file) => new Promise((resolve) => {
  const path = fileURLToPath(new URL(file, import.meta.url));
  const args = [path];
  if (ADVICE_URL && file === 'check-advice-layout.mjs') args.push(`--url=${ADVICE_URL}`);
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  child.on('close', (code) => resolve({ code, output }));
});

const results = [];
if (requested.size) {
  console.log(`\n运行所选测试套件（${suitesToRun.length}/${suites.length}）`);
}
for (const [title, file] of suitesToRun) {
  process.stdout.write(`\n▶ ${title}\n`);
  const { code, output } = await run(file);
  const lines = output.trimEnd().split('\n');
  // Print only the tail plus any failure lines to keep the summary readable.
  const failures = lines.filter((l) => /\bFAIL\b|失败|Error:/.test(l));
  for (const line of failures.slice(0, 12)) console.log(`   ${line.trim()}`);
  console.log(`   ${lines[lines.length - 1] || '(no output)'}`);
  results.push({ title, code });
}

console.log(`\n${'='.repeat(58)}`);
let failed = 0;
for (const { title, code } of results) {
  const ok = code === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? '通过' : '失败'}  ${title}`);
}
console.log(`${'='.repeat(58)}`);
console.log(failed === 0
  ? (requested.size ? '所选测试套件全部通过 ✓' : '全部测试通过 ✓')
  : `${failed} 个测试套件失败`);
process.exit(failed === 0 ? 0 : 1);
