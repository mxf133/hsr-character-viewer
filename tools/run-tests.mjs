// Runs all test suites, or a selected subset, and reports a single summary.
// Run with: node tools/run-tests.mjs [--suite <file>]... [--list]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ⚠️ v4.6.85：界面整体重做中，原先那条「抽卡推荐界面布局 (CDP)」套件
// （`check-advice-layout.mjs` —— 靠 DevTools Protocol 在真浏览器里量几何）随旧界面一起
// 删除了，所以这里不再需要「9222 上有没有调试浏览器」那段探测（它当年只为让这一套在
// 没有浏览器时**跳过**而不是报红）。新界面落地后若要恢复几何回归，按新结构重写那一套
// 再把这层探测加回来 —— 别照抄旧 DOM id。

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
  ['中文名称映射 (对照游戏内中文)', 'herta-i18n-check.mjs'],
  ['端到端 HTTP / 静态资源 / 会话', 'e2e-test.mjs'],
  ['启动器 start.bat 自检', 'launcher-test.mjs'],
  ['启动后自动打开浏览器', 'launcher-open-test.mjs'],
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

const suitesToRun = requested.size
  ? suites.filter(([, file]) => requested.has(file))
  : suites;

const run = (file) => new Promise((resolve) => {
  const path = fileURLToPath(new URL(file, import.meta.url));
  const child = spawn(process.execPath, [path], { stdio: ['ignore', 'pipe', 'pipe'] });
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
