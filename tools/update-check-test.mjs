// 「和 GitHub 上的最新发布比一比」的回归测试（用户 2026-10-14 第 5 条）。
//
// ⚠️ **完全不联网**：`checkForUpdate()` 的 `fetchImpl` 是注入的，所以这套测试在断网 /
// 被墙的机器上照样跑，也不会消耗 GitHub 的匿名配额（60 次/小时/IP）。
// 真正联网的那条路只有「用户点「检查更新」」才会走，由 `e2e-test.mjs` 断言
// 「不带 `?check=1` 时它连碰都不碰网络」。
import assert from 'node:assert/strict';
import {
  CACHE_TTL_MS,
  compareVersions,
  checkForUpdate,
  normalizeVersion,
  resetUpdateCheckCache,
} from '../src/server/update-check.js';
import { PROGRAM_VERSION } from '../src/version.js';

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

// ---------------------------------------------------------------- 版本号比较
//
// 这一组是整条链的地基：比错了就会出现「已经是最新还提示更新」或者反过来。
console.log('\n[版本号归一与比较]');

check('归一：从 tag 里抓出版本号（带不带 v / 带不带前缀都认）', () => {
  assert.equal(normalizeVersion('v4.6.104'), '4.6.104');
  assert.equal(normalizeVersion('V4.6.104'), '4.6.104');
  assert.equal(normalizeVersion('4.6.104'), '4.6.104');
  assert.equal(normalizeVersion('  v4.6.104  '), '4.6.104');
  // ⚠️ 前缀 / 后缀都要能认出中间那段版本号：Release tag 是发布时手写的
  //    （`docs/发布到GitHub.md` 里就出现过 `v…-portable` 这种便携包命名）。
  assert.equal(normalizeVersion('hsr-4.6.104-portable'), '4.6.104');
  assert.equal(normalizeVersion('release 4.6 / hotfix 1'), '4.6');
  // 取不到数字段 → 空串（调用方判成 error，**不拿它去比版本**）。
  assert.equal(normalizeVersion('no tag here'), '');
  assert.equal(normalizeVersion(''), '');
  assert.equal(normalizeVersion(null), '');
});

check('⭐ 逐段数字比，不是字符串比：4.10 > 4.6', () => {
  // ⚠️ 这条是整个函数存在的理由：`'4.10' < '4.6'` 在字典序下为真，
  //    而游戏版本号迟早走到 4.10 —— 那时「已升到 4.10」会被判成「比 4.6 旧」。
  assert.equal(compareVersions('4.10', '4.6'), 1);
  assert.equal(compareVersions('4.6', '4.10'), -1);
  assert.equal(compareVersions('4.9.0', '4.10.0'), -1);
  assert.equal(compareVersions('4.6.104', '4.6.99'), 1);
});

check('相等：段数不同按补 0 处理', () => {
  assert.equal(compareVersions('4.6', '4.6.0'), 0);
  assert.equal(compareVersions('v4.6.104', '4.6.104'), 0);
  assert.equal(compareVersions('4.6.104', '4.6.104.0'), 0);
});

check('升 / 降两个方向都认得出来', () => {
  assert.equal(compareVersions('4.6.105', '4.6.104'), 1);
  assert.equal(compareVersions('4.6.103', '4.6.104'), -1);
  assert.equal(compareVersions('5.0', '4.99.99'), 1);
});

// ---------------------------------------------------------------- 取数与判定
console.log('\n[联网检查（fetch 注入，不真的出网）]');

/** 造一个只回 JSON 的假 fetch，并记录调用次数。 */
const fakeFetch = (payload, { status = 200 } = {}) => {
  const calls = { n: 0 };
  const impl = async () => {
    calls.n += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  };
  return { impl, calls };
};

await (async () => {
  resetUpdateCheckCache();
  const { impl, calls } = fakeFetch({
    tag_name: 'v9.9.9',
    html_url: 'https://github.com/mxf133/hsr-character-viewer/releases/tag/v9.9.9',
    published_at: '2026-10-14T00:00:00Z',
    name: 'v9.9.9',
  });
  const out = await checkForUpdate({ fetchImpl: impl, now: 1_000, force: true });
  assert.equal(calls.n, 1);
  assert.equal(out.ok, true);
  assert.equal(out.status, 'update');
  assert.equal(out.latest, '9.9.9');
  assert.equal(out.current, PROGRAM_VERSION);
  assert.match(out.url, /releases\/tag\/v9\.9\.9$/);
  passed += 1;
  console.log('  ✓ GitHub 更新 → status=update，并给出这条发布的地址');
})();

await (async () => {
  resetUpdateCheckCache();
  const { impl } = fakeFetch({ tag_name: `v${PROGRAM_VERSION}` });
  const out = await checkForUpdate({ fetchImpl: impl, now: 1_000, force: true });
  assert.equal(out.status, 'latest');
  assert.equal(out.latest, PROGRAM_VERSION);
  passed += 1;
  console.log('  ✓ 版本相同 → status=latest（界面提示「已是最新版本」）');
})();

await (async () => {
  resetUpdateCheckCache();
  // 本地比 GitHub 还新（开发分支 / 提前打包）：**不是错误**，要单独一档，
  // 否则界面会把它显示成「GitHub 上有个更新的版本」——那是反的。
  const { impl } = fakeFetch({ tag_name: '4.0.0' });
  const out = await checkForUpdate({ fetchImpl: impl, now: 1_000, force: true });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'ahead');
  passed += 1;
  console.log('  ✓ 本地比 GitHub 新 → status=ahead（不算错，也不算「有更新」）');
})();

await (async () => {
  resetUpdateCheckCache();
  // 仓库还没有任何 Release：GitHub 对 `releases/latest` 回 404。
  const { impl } = fakeFetch({}, { status: 404 });
  const out = await checkForUpdate({ fetchImpl: impl, now: 1_000, force: true });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'ahead');
  assert.equal(out.latest, null);
  passed += 1;
  console.log('  ✓ 还没有 Release（404）→ status=ahead + 一句能看懂的话，不报错');
})();

await (async () => {
  resetUpdateCheckCache();
  const { impl } = fakeFetch({}, { status: 403 });
  const out = await checkForUpdate({ fetchImpl: impl, now: 1_000, force: true });
  assert.equal(out.ok, false);
  assert.equal(out.status, 'error');
  assert.match(out.error, /403/);
  // 限流要给出「过一会儿再试」这一句 —— 否则用户只会以为程序坏了。
  assert.match(out.error, /次数限制/);
  passed += 1;
  console.log('  ✓ 限流（403/429）→ status=error 且提示「过一会儿再试」');
})();

await (async () => {
  resetUpdateCheckCache();
  const impl = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const out = await checkForUpdate({ fetchImpl: impl, now: 1_000, force: true });
  assert.equal(out.ok, false);
  assert.equal(out.status, 'error');
  assert.match(out.error, /连不上 GitHub/);
  passed += 1;
  console.log('  ✓ 断网 → status=error（永远 resolve，不抛异常）');
})();

await (async () => {
  resetUpdateCheckCache();
  const { impl } = fakeFetch({ name: 'no tag here' });
  const out = await checkForUpdate({ fetchImpl: impl, now: 1_000, force: true });
  assert.equal(out.status, 'error');
  assert.match(out.error, /没有版本号/);
  passed += 1;
  console.log('  ✓ tag_name 为空 → status=error（不拿名字猜版本）');
})();

await (async () => {
  resetUpdateCheckCache();
  const { impl, calls } = fakeFetch({ tag_name: 'v9.9.9' });
  const first = await checkForUpdate({ fetchImpl: impl, now: 1_000 });
  const second = await checkForUpdate({ fetchImpl: impl, now: 1_000 + CACHE_TTL_MS - 1 });
  assert.equal(calls.n, 1, '缓存窗口内不该再打一次 GitHub');
  assert.equal(first.status, second.status);
  assert.equal(second.cached, true);
  // 过了窗口就要重取；`force` 也跳过缓存（探针 / 排障用）。
  await checkForUpdate({ fetchImpl: impl, now: 1_000 + CACHE_TTL_MS + 1 });
  assert.equal(calls.n, 2, '缓存过期后应当重取');
  await checkForUpdate({ fetchImpl: impl, now: 1_000 + CACHE_TTL_MS + 2, force: true });
  assert.equal(calls.n, 3, 'force 应当跳过缓存');
  passed += 1;
  console.log('  ✓ 结果缓存 10 分钟：连点不会把匿名配额用光');
})();

await (async () => {
  resetUpdateCheckCache();
  // ⚠️ **失败也进缓存**：断网时每次都要等满超时（8 秒），连点会变成一直在转圈。
  const { impl, calls } = fakeFetch({}, { status: 500 });
  await checkForUpdate({ fetchImpl: impl, now: 1_000 });
  const second = await checkForUpdate({ fetchImpl: impl, now: 1_000 + 5_000 });
  assert.equal(calls.n, 1, '失败结果同样要缓存');
  assert.equal(second.status, 'error');
  passed += 1;
  console.log('  ✓ 失败也进缓存（断网时不会每次卡满 8 秒超时）');
})();

await (async () => {
  resetUpdateCheckCache();
  // 时钟 / 超时都是注入的：`AbortError` 必须被翻译成「超时」而不是「连不上」——
  // 两者的处置完全不同（一个是网络慢，一个是没网）。
  const impl = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  const out = await checkForUpdate({ fetchImpl: impl, now: 1_000, timeoutMs: 3000, force: true });
  assert.equal(out.status, 'error');
  assert.match(out.error, /超时（超过 3 秒）/);
  passed += 1;
  console.log('  ✓ 超时的措辞与「连不上」区分开（处置不同）');
})();

console.log(`\n版本检查测试: ${passed} passed, 0 failed`);
