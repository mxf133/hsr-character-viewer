// 缓存与回源策略的回归测试。
//
// 本轮（用户 2026-10：「不需要每次刷新都去更新数据」）改的是**语义**：
// GET 不再因为 TTL 过期就自动去打米游社。所以这里钉的不只是数值，
// 还要钉住「有缓存 + 非强制 → 一定不联网」这条硬规矩 —— 它一旦被改回去，
// 用户看到的症状就是米游社风控（10041/5003），很难第一时间联想到是这里。
import assert from 'node:assert/strict';
import {
  CACHE_TTL_MS,
  FRESH_WINDOW_MS,
  REFETCH_MESSAGES,
  cacheMeta,
  createRefetchGate,
} from '../src/server/cache-policy.js';

// ---- cacheMeta：仍然只描述新鲜度，不决定要不要联网 ----------------------
const fetchedAt = new Date(1_000_000).toISOString();
const snapshot = { fetchedAt };
assert.equal(cacheMeta(snapshot, CACHE_TTL_MS.snapshot, 1_000_000).stale, false);
assert.equal(cacheMeta(snapshot, CACHE_TTL_MS.snapshot, 1_000_000 + CACHE_TTL_MS.snapshot).stale, true);
assert.equal(cacheMeta({}, CACHE_TTL_MS.records, 1_000_000).stale, true);
assert.equal(cacheMeta(snapshot, CACHE_TTL_MS.snapshot, 1_000_000, { stale: true }).stale, true);
// 过期的理由要说清「不会自动更新」，否则界面上等于在骗用户说点一下就能变新。
assert.match(
  cacheMeta(snapshot, CACHE_TTL_MS.snapshot, 1_000_000 + CACHE_TTL_MS.snapshot).staleReason,
  /不会自动联网更新/,
);
// 展示用的时间窗 = 7 天（用户 2026-10：「不超过 7 天不用提示过期/旧数据」）。
// 演进：15/30 分钟（自动重抓时代）→ 6 小时（v4.6.52 改读本地时放宽）→ 7 天。
// 改成读本地之后数据只在手动刷新时变新，按分钟/按小时划线只会让「过期/旧数据」
// 那块提示一直亮着，变成噪音。
assert.equal(FRESH_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
assert.equal(CACHE_TTL_MS.snapshot, FRESH_WINDOW_MS);
assert.equal(CACHE_TTL_MS.records, FRESH_WINDOW_MS);
// 6 天 23 小时仍**不算**过期（用户要的是「不超过 7 天」）；
// 越过 7 天才算。这条钉住边界，免得有人把窗口又改回小时级。
const sixDays = 6 * 24 * 60 * 60 * 1000;
assert.equal(cacheMeta(snapshot, CACHE_TTL_MS.snapshot, 1_000_000 + sixDays).stale, false,
  '不到 7 天不该提示过期/旧数据');
assert.equal(cacheMeta(snapshot, CACHE_TTL_MS.snapshot, 1_000_000 + FRESH_WINDOW_MS).stale, true,
  '过了 7 天才提示过期');
// 截图里那条「已于 … 过期」正是这个 stale 驱动的，窗口放宽后 11 小时的数据
// 不会再顶着一句过期提示（那正是用户要修的）。

// ---- 核心：有缓存 + 非强制 → 永远读本地，哪怕早就过了时间窗 --------------
{
  const gate = createRefetchGate({ minIntervalMs: 0 });
  const ancient = { fetchedAt: new Date(0).toISOString() }; // 1970 年，足够旧
  const decided = gate.decide('a/1/snapshot', { cached: ancient, force: false });
  assert.equal(decided.refetch, false, '过期缓存也必须读本地，不能自动回源');
  assert.equal(decided.reason, 'cached');
  assert.equal(decided.throttled, false);
  assert.deepEqual(gate.attempts(), {}, '读本地不应该记一次真实请求');
}

// ---- 没有缓存时仍然要抓一次（首次使用不能空白）---------------------------
{
  const gate = createRefetchGate({ minIntervalMs: 0 });
  const decided = gate.decide('a/1/snapshot', { cached: null, force: false });
  assert.equal(decided.refetch, true);
  assert.equal(decided.reason, 'no-cache');
}

// ---- 显式刷新：放行，且理由是 forced ------------------------------------
{
  const gate = createRefetchGate({ minIntervalMs: 0 });
  const decided = gate.decide('a/1/snapshot', { cached: { fetchedAt }, force: true });
  assert.equal(decided.refetch, true);
  assert.equal(decided.reason, 'forced');
}

// ---- 限流：连点按钮不会变成连打米游社 ------------------------------------
{
  const gate = createRefetchGate({ minIntervalMs: 60_000 });
  const t0 = 1_000_000;
  assert.equal(gate.decide('a/1/records', { cached: null, force: true, now: t0 }).refetch, true);

  // 3 秒后再点一次 → 限流，并且要告诉界面还要等多久。
  const second = gate.decide('a/1/records', { cached: { fetchedAt }, force: true, now: t0 + 3_000 });
  assert.equal(second.refetch, false, '最小间隔内的第二次刷新必须被挡下');
  assert.equal(second.reason, 'throttled');
  assert.equal(second.throttled, true);
  assert.equal(second.retryAfterMs, 57_000, 'retryAfterMs 要能直接显示给用户');

  // 过了间隔 → 放行。
  assert.equal(
    gate.decide('a/1/records', { cached: { fetchedAt }, force: true, now: t0 + 60_001 }).refetch,
    true,
  );
  // 读本地不受限流影响：限流只管真实请求，读本地应该永远放行。
  assert.equal(
    gate.decide('a/1/records', { cached: { fetchedAt }, force: false, now: t0 + 60_002 }).refetch,
    false,
  );
}

// ---- 限流按 key 隔离：不同角色互不影响 ----------------------------------
{
  const gate = createRefetchGate({ minIntervalMs: 60_000 });
  const t0 = 1_000_000;
  gate.decide('a/1/snapshot', { cached: null, force: true, now: t0 });
  assert.equal(gate.decide('a/2/snapshot', { cached: null, force: true, now: t0 + 1 }).refetch, true,
    '另一个角色不应该被上一个角色的限流挡住');
  assert.equal(gate.decide('a/1/records', { cached: null, force: true, now: t0 + 1 }).refetch, true,
    '同一角色的 snapshot 与 records 是两份配额');
  assert.equal(gate.decide('a/1/snapshot', { cached: null, force: true, now: t0 + 1 }).refetch, false,
    '同一角色的同一份资源仍然要被挡下');
}

// ---- 失败也算消耗过一次配额 ---------------------------------------------
// 风控不因为我们失败就少算一次请求，所以尝试时间记在「决定联网」那一刻。
{
  const gate = createRefetchGate({ minIntervalMs: 60_000 });
  const t0 = 1_000_000;
  gate.decide('a/1/snapshot', { cached: null, force: true, now: t0 });
  assert.equal(gate.decide('a/1/snapshot', { cached: null, force: true, now: t0 + 500 }).refetch, false);
}

// ---- 四种理由都要有中文文案（服务端与界面共用同一份）--------------------
for (const reason of ['cached', 'throttled', 'no-cache', 'forced']) {
  assert.equal(typeof REFETCH_MESSAGES[reason], 'string', `${reason} 缺少文案`);
  assert.ok(REFETCH_MESSAGES[reason].length > 0);
}
assert.match(REFETCH_MESSAGES.cached, /不会自动联网更新/);
assert.match(REFETCH_MESSAGES.throttled, /风控/);

console.log('cache policy tests passed：读本地不联网 / 首次放行 / 显式刷新限流 / 文案齐备');