// 抽卡方案「全量搜索 + 分页」的**真浏览器探针**（2026-10-20，v4.6.133）。
//
//   node tools/cdp-serve.mjs --port=8361 --accounts=1        # 另开一个窗口
//   msedge --remote-debugging-port=9222 --headless=new --user-data-dir=<临时目录> about:blank
//   node tools/_probe-plan-page-ui.mjs [--url=http://127.0.0.1:8361/] [--cdp=http://127.0.0.1:9222]
//
// 为什么要它：`check-advice-layout.mjs` 那一套盯的是 v4.6.130 重构**之前**的 DOM
// （它还在等 `#adviceMode` 这个早就删掉的下拉框，见 `index.html:403` 的注释），
// 所以在有浏览器的环境里它自己就先挂了 —— 不能拿它当这一轮的证据。
// 这一份只盯本轮改动的四件事，跑起来是秒级：
//
//   ① 首屏是**整池分页**：20 张卡 + 翻页条「第 1/N 页 · 共 M 支」，M 远大于 20；
//   ② 翻页不是假的：点第 2 页 → 首张卡名次 #21；点末页 → 张数 = 余数、名次连续；
//   ③ 搜索是**全池**的：搜一个只排在第 20 名之后的角色，能搜到它；
//   ④ 次选命中标记与状态行的计数一致（徽章不说谎）。
//
// ⚠️ 用 `--headless=new` 起浏览器：沙箱里非 headless 会 crashpad 自杀（踩过）。
// ⚠️ 服务必须是**你自己那份代码**（worktree 里用 `tools/cdp-serve.mjs`），
//    否则量的是 main 上的旧行为 —— `docs/CDP布局套件.md` §3.1 记的就是这个坑。

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const URL_BASE = arg('url', 'http://127.0.0.1:8361/');
const CDP_BASE = arg('cdp', 'http://127.0.0.1:9222');

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? `（${detail}）` : ''}`); }
  return Boolean(cond);
};

// ------------------------------------------------------------------ CDP 客户端
const targets = await (await fetch(`${CDP_BASE}/json/list`)).json().catch(() => null);
if (!targets) {
  console.error(`连不上调试端口 ${CDP_BASE} —— 先按 docs/CDP布局套件.md 起浏览器。`);
  process.exit(2);
}
const target = targets.find((t) => t.type === 'page');
if (!target) {
  console.error('调试端口上没有 page 目标。');
  process.exit(2);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const waiting = new Map();
const errors = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); return; }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails?.exception?.description
      || msg.params.exceptionDetails?.text || 'exception');
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  seq += 1;
  waiting.set(seq, resolve);
  ws.send(JSON.stringify({ id: seq, method, params }));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  const details = res.result?.exceptionDetails;
  if (details) throw new Error(details.exception?.description || details.text || 'evaluate failed');
  return res.result?.result?.value;
};
/** 等一个表达式变真（界面是异步渲染的，固定 sleep 早晚会在慢机器上假红）。 */
const waitFor = async (expression, { timeout = 15000, step = 150 } = {}) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await evaluate(expression)) return true;
    await sleep(step);
  }
  return false;
};

await new Promise((resolve) => ws.addEventListener('open', resolve));
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `${URL_BASE.replace(/\/$/, '')}/?view=advice` });
const loaded = await waitFor("document.querySelectorAll('#adviceTeamPlanBody .advice-plan-team').length > 0",
  { timeout: 30000 });
if (!loaded) {
  console.error('页面没有渲染出方案卡片 —— 先确认服务指向的是当前代码（见文件头注释）。');
  console.error('异常：', errors.slice(0, 3));
  process.exit(2);
}

const cardInfo = () => evaluate(`(() => {
  const cards = [...document.querySelectorAll('#adviceTeamPlanBody .advice-plan-team')];
  return {
    count: cards.length,
    ranks: cards.map((c) => Number((c.querySelector('.advice-unit-rank')?.textContent || '').replace('#', ''))),
    altMarks: cards.filter((c) => c.querySelector('.advice-plan-alt-hit')).length,
    meta: document.getElementById('adviceTeamPlanMeta')?.textContent || '',
    pager: document.getElementById('adviceTeamPlanPager')?.textContent || '',
    firstChars: [...(cards[0]?.querySelectorAll('.advice-plan-team-char') || [])].map((n) => n.textContent),
  };
})()`);
const clickPager = (label) => evaluate(`(() => {
  const host = document.getElementById('adviceTeamPlanPager');
  const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(label)});
  if (!btn) throw new Error('翻页条上找不到「' + ${JSON.stringify(label)} + '」');
  btn.click();
  return true;
})()`);
const typeQuery = (value) => evaluate(`(() => {
  const input = document.getElementById('adviceTeamPlanSearch');
  input.value = ${JSON.stringify(value)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

// ------------------------------------------------------------------ ① 首屏
const totalMatch = (meta) => Number((meta.match(/共 (\d+) 支/) || [])[1] || 0);
const pageMatch = (meta) => (meta.match(/第 (\d+)\/(\d+) 页/) || []).slice(1).map(Number);
const first = await cardInfo();
check('首屏 20 张卡', first.count === 20, `${first.count} 张`);
check('状态行印全池规模（远大于 20）', totalMatch(first.meta) > 20, first.meta);
check('状态行印投稿条数', /来自 \d+ 条投稿/.test(first.meta), first.meta);
const [page1, pages1] = pageMatch(first.meta);
check('翻页条有页数且不在第 1 页以外', page1 === 1 && pages1 > 1, `${page1}/${pages1}`);
check('卡片名次从 #1 起连续', first.ranks.every((r, i) => r === i + 1), first.ranks.join(','));

// ------------------------------------------------------------------ ② 翻页
await clickPager('2');
const paged = await waitFor("document.querySelector('#adviceTeamPlanBody .advice-unit-rank')?.textContent === '#21'");
const second = await cardInfo();
check('点第 2 页 → 首张卡是 #21', paged, second.ranks.join(','));
check('第 2 页仍是 20 张', second.count === 20, `${second.count} 张`);

await clickPager('»');
await waitFor(`(() => {
  const m = document.getElementById('adviceTeamPlanMeta')?.textContent || '';
  return /第 ${pages1}\\/${pages1} 页/.test(m);
})()`);
const lastPage = await cardInfo();
const expectedTail = totalMatch(lastPage.meta) % 20 || 20;
check('末页张数 = 余数', lastPage.count === expectedTail, `${lastPage.count} 张（期望 ${expectedTail}）`);
check('末页名次接着上一页继续（不重编号）',
  lastPage.ranks[0] > 20 && lastPage.ranks[lastPage.ranks.length - 1] === totalMatch(lastPage.meta),
  `${lastPage.ranks[0]}…${lastPage.ranks[lastPage.ranks.length - 1]}`);

// ------------------------------------------------------------------ ③ 全池搜索
//
// 挑一个「只在第 20 名之后出现」的角色：从末页某张卡上取第一个角色名。改之前
// 搜索只在这 20 条里找，这个角色必然搜不到 —— 那正是用户报的缺陷。
const deepChar = lastPage.firstChars[0];
await clickPager('«');
await waitFor("(document.getElementById('adviceTeamPlanPager')?.textContent || '').includes('第 1/')");
await typeQuery(deepChar);
const searched = await waitFor(`(() => {
  const m = document.getElementById('adviceTeamPlanMeta')?.textContent || '';
  return m.includes('搜索「') && !m.includes('正在查找');
})()`);
const hit = await cardInfo();
check(`能在全池里搜到只排在后段的角色「${deepChar}」`, searched && hit.count > 0,
  `${hit.count} 张 / ${hit.meta}`);
check('搜索命中的卡片名次都在第 20 名之后（说明不是只搜首屏）',
  hit.ranks.some((r) => r > 20), hit.ranks.join(','));
check('搜索是「只过滤不重排」（名次仍递增）',
  hit.ranks.every((r, i) => i === 0 || r > hit.ranks[i - 1]), hit.ranks.join(','));

// ------------------------------------------------------------------ ④ 次选命中
//
// ⚠️ 状态行里的「其中 N 支只在次选里」是**全池命中数**，而徽章只出现在当前页 ——
//    所以只有「命中全部装在一页里」时两者才该相等；多页时只能是「徽章数 ≤ 全池数」。
const altCountInMeta = Number((hit.meta.match(/其中 (\d+) 支只在次选里/) || [])[1] || 0);
const hitTotal = Number((hit.meta.match(/\/ (\d+) 支/) || [])[1] || 0);
const singlePage = hitTotal <= hit.count;
check(
  singlePage
    ? '次选命中数（单页搜索）与卡片徽章数一致'
    : '次选命中数（多页搜索）不少于本页徽章数',
  singlePage ? altCountInMeta === hit.altMarks : hit.altMarks <= altCountInMeta,
  `状态行 ${altCountInMeta} / 本页徽章 ${hit.altMarks} / 命中 ${hitTotal}`,
);
check('徽章只出现在「本队没有该词」的卡上',
  await evaluate(`(() => {
    const cards = [...document.querySelectorAll('#adviceTeamPlanBody .advice-plan-team')];
    return cards.filter((c) => c.querySelector('.advice-plan-alt-hit')).every((c) => !(
      c.textContent.includes(${JSON.stringify(deepChar)})
      && [...c.querySelectorAll('.advice-plan-team-char')].some((n) => n.textContent === ${JSON.stringify(deepChar)})
    ));
  })()`),
  '徽章与文案对不上');

// 清空搜索 → 回到整池第 1 页
await typeQuery('');
const cleared = await waitFor(
  `!(document.getElementById('adviceTeamPlanMeta')?.textContent || '').includes('搜索「')`,
);
const restored = await cardInfo();
check('清空搜索后回到整池', cleared && totalMatch(restored.meta) === totalMatch(first.meta),
  restored.meta);

check('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' | '));

console.log(`\n合计 ${passed} 项通过，${failed} 项失败`);
ws.close();
process.exitCode = failed ? 1 : 0;
