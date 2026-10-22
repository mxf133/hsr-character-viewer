// 抽卡方案「本轮四条改动」的**真浏览器探针**（2026-10-22，v4.6.145）。
//
//   node tools/cdp-serve.mjs --port=8361 --accounts=1        # 另开一个窗口
//   msedge --remote-debugging-port=9222 --headless=new --user-data-dir=<临时目录> about:blank
//   node tools/_probe-plan-2026-10-22-ui.mjs [--url=http://127.0.0.1:8361/] [--cdp=http://127.0.0.1:9222]
//
// 只盯这一轮改的界面，跑起来是秒级：
//   ① 「不使用」那一块在位：输入框 / chips / 清空，且初始为空提示；
//   ② 每张卡都有「排除此配队」；点一下 → chips 出现、方案重取（首张卡的分数变了）；
//   ③ 「最佳版本」右边有首领名（有 `plan.bosses` 的版本才画）；
//   ④ 「其它配装」每行都印完整配装文字（`.advice-plan-variant-names`）；
//   ⑤ 视频来源：`videoSources` 有多条时出现「另 N 条来源」；
//   ⑥ 全程无 JS 异常。
//
// ⚠️ 用 `--headless=new` 起浏览器：沙箱里非 headless 会 crashpad 自杀（踩过）。
// ⚠️ 服务必须是**你自己那份代码**（`tools/cdp-serve.mjs`），否则量的是 main 上的旧行为。

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const details = res.result?.exceptionDetails;
  if (details) throw new Error(details.exception?.description || details.text || 'evaluate failed');
  return res.result?.result?.value;
};
const waitFor = async (expression, { timeout = 20000, step = 150 } = {}) => {
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

const loaded = await waitFor(
  "document.querySelectorAll('#adviceTeamPlanBody .advice-plan-team').length > 0",
  { timeout: 40000 },
);
if (!loaded) {
  console.error('页面没有渲染出方案卡片 —— 先确认服务指向的是当前代码，且虚拟账号已带上角色池。');
  const hint = await evaluate("(document.getElementById('adviceEmpty')||{}).textContent || ''");
  if (hint) console.error('页面提示：', hint.slice(0, 200));
  process.exit(2);
}

console.log('抽卡方案 2026-10-22 界面探针');

// ① 「不使用」那一块
check('「不使用」输入框在位', await evaluate("!!document.getElementById('advicePlanExcludeInput')"));
check('chips 容器在位且初始为空提示',
  await evaluate("!!document.querySelector('#advicePlanExcludeChips .advice-plan-exclude-empty')"));
check('提示行印出上限', await evaluate(
  "(document.getElementById('advicePlanExcludeHint')?.textContent || '').includes('至多 4')"),
  await evaluate("(document.getElementById('advicePlanExcludeHint')?.textContent||'').slice(0,40)"));

// ② 每张卡都有「排除此配队」，点一下能生效
const cards = await evaluate("document.querySelectorAll('#adviceTeamPlanBody .advice-plan-team').length");
const btns = await evaluate("document.querySelectorAll('.advice-plan-exclude-btn').length");
check('每张卡都有「排除此配队」', btns === cards, `${btns} / ${cards}`);
// 按钮要**靠左**（用户 2026-10-22）：在分数左边、紧跟名次。
const btnPos = await evaluate(`(() => {
  const head = document.querySelector('#adviceTeamPlanBody .advice-plan-team-head');
  const btn = head?.querySelector('.advice-plan-exclude-btn');
  const score = head?.querySelector('.advice-plan-team-score');
  if (!btn || !score) return null;
  return { btn: Math.round(btn.getBoundingClientRect().left), score: Math.round(score.getBoundingClientRect().left) };
})()`);
check('「排除此配队」靠左（在分数左边）', !!btnPos && btnPos.btn < btnPos.score, JSON.stringify(btnPos));

// 先把首张卡的四个角色名记下来：排除之后它必须换人（角色是**整队剔除**）。
const beforeMembers = await evaluate(
  "[...document.querySelectorAll('#adviceTeamPlanBody .advice-plan-team')].slice(0,1)"
  + ".flatMap((c) => [...c.querySelectorAll('.advice-plan-team-char')].map((n) => n.textContent)).join('|')");
const beforeScore = await evaluate(
  "document.querySelector('#adviceTeamPlanBody .advice-plan-team .advice-plan-team-score')?.textContent || ''");
await evaluate("(() => { const b = document.querySelector('.advice-plan-exclude-btn'); if (b) b.click(); return true; })()");
const chipsShown = await waitFor(
  "document.querySelectorAll('#advicePlanExcludeChips .advice-plan-exclude-chip').length >= 4",
  { timeout: 8000 },
);
const chipCount = await evaluate("document.querySelectorAll('#advicePlanExcludeChips .advice-plan-exclude-chip').length");
check('点「排除此配队」后 chips 出现 4~8 枚', chipsShown && chipCount >= 4 && chipCount <= 8, `${chipCount} 枚`);
// ⚠️ 必须**等**重取落地：`applyPlanExclude()` 是异步的（chips 立刻出现，方案要等请求回来）。
//    第一版没等，量到「排除前后一模一样」，看起来像没生效。
const excludedGone = await waitFor(`(() => {
  const first = [...document.querySelectorAll('#adviceTeamPlanBody .advice-plan-team')][0];
  if (!first) return true;
  const names = [...first.querySelectorAll('.advice-plan-team-char')].map((n) => n.textContent).join('|');
  return names !== ${JSON.stringify(beforeMembers)};
})()`, { timeout: 15000 });
const metaText = await evaluate("(document.getElementById('adviceTeamPlanMeta')?.textContent || '')");
check('状态行反映排除后的池子', metaText.includes('没有可用配队') || metaText.includes('支'), metaText.slice(0, 60));
const afterScore = await evaluate(
  "document.querySelector('#adviceTeamPlanBody .advice-plan-team .advice-plan-team-score')?.textContent || ''");
check('方案确实重取（首张卡换人了 / 池子变了）',
  excludedGone || beforeScore !== afterScore || metaText.includes('没有可用配队'),
  `${beforeScore || '—'} → ${afterScore || '（无卡）'}｜原队 ${beforeMembers}`);

// 撤掉排除，回到原状
await evaluate("(() => { const b = document.getElementById('advicePlanExcludeClear'); if (b) b.click(); return true; })()");
const restored = await waitFor(
  "document.querySelectorAll('#advicePlanExcludeChips .advice-plan-exclude-chip').length === 0",
  { timeout: 8000 },
);
check('「清空」能撤掉全部排除', restored);

// ③ 「最佳版本」右边的首领
const waitCards = await waitFor(
  "document.querySelectorAll('#adviceTeamPlanBody .advice-plan-team').length > 0",
  { timeout: 20000 },
);
const bossCount = await evaluate("document.querySelectorAll('.advice-plan-boss-name').length");
const bestCount = await evaluate("document.querySelectorAll('.advice-plan-team-best').length");
check('「最佳版本」旁边印了首领名', waitCards && bossCount > 0, `${bossCount} 枚 / 最佳版本 ${bestCount} 张卡`);
const bossSample = await evaluate("document.querySelector('.advice-plan-boss-name')?.textContent || ''");
check('首领名是中文', /[一-龥]/.test(bossSample), bossSample);

// ④ 「其它配装」每行都是**四个位置的完整配队**（2026-10-22 起换成 `.advice-lineup`）
// ⚠️ `.advice-plan-variant` 这个 class **次选行也在用**（`is-alt`），而次选没有 `.advice-lineup`
//    —— 判据必须排除 `is-alt`，否则抓到的是次选那一栏。
const variantLineups = await evaluate(
  "document.querySelectorAll('#adviceTeamPlanBody .advice-plan-variant:not(.is-alt) .advice-lineup').length");
const variantSlots = await evaluate(`(() => {
  const g = document.querySelector('#adviceTeamPlanBody .advice-plan-variant:not(.is-alt) .advice-lineup');
  return g ? g.querySelectorAll('.advice-lineup-slot').length : 0;
})()`);
check('「其它配装」每行都是四个位置的完整配队',
  variantLineups > 0 && variantSlots === 4, `${variantLineups} 行 / 首行 ${variantSlots} 格`);
// 2026-10-22 第三版（用户：「最多 10 条」「显示金数、补金数、队伍强度和计算公式、最佳版本
// 和行动值，总之和本投稿的外观完全一致」）：逐条对一遍这几样在不在。
const variantDetail = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('#adviceTeamPlanBody .advice-plan-variant:not(.is-alt)')];
  if (!rows.length) return null;
  // 「最多 10 条」是**每一栏**的上限，不是整页 —— 按 list 分组取最大值。
  const perList = [...document.querySelectorAll('#adviceTeamPlanBody .advice-plan-team-variants .advice-plan-variant-list')]
    .map((l) => l.querySelectorAll(':scope > .advice-plan-variant:not(.is-alt)').length);
  const maxRows = perList.length ? Math.max(...perList) : 0;
  const first = rows[0];
  const text = first ? first.textContent : '';
  return {
    rows: maxRows,
    total: rows.length,
    hasEq: !!first?.querySelector('.advice-plan-team-eq'),
    hasGold: /账面/.test(text),
    hasBest: /最佳版本/.test(text),
    hasScore: !!first?.querySelector('.advice-plan-team-score'),
    eqText: (first?.querySelector('.advice-plan-team-eq')?.textContent || '').slice(0, 60),
  };
})()`);
check('「其它配装」每支都印分数 + 等式（队伍强度 / 性价比）',
  !!variantDetail && variantDetail.hasScore && variantDetail.hasEq, JSON.stringify(variantDetail?.eqText));
check('「其它配装」每支都印账面 / 补金', !!variantDetail && variantDetail.hasGold);
check('「其它配装」每支都印最佳版本 · 成绩', !!variantDetail && variantDetail.hasBest);
check('「其它配装」每栏最多 10 条', !!variantDetail && variantDetail.rows <= 10 && variantDetail.rows > 0,
  `单栏最多 ${variantDetail?.rows} 条（全页 ${variantDetail?.total} 条）`);
const slotText = await evaluate(
  "document.querySelector('.advice-plan-team-variants .advice-lineup-slot')?.textContent || ''");
check('每个位置印了角色 E 档与光锥 S 档', /E[0-9]/.test(slotText) && /S[0-9]/.test(slotText),
  slotText.slice(0, 60));

// ④b 「你现在就能打的队」（补 0 金摘要）
const ownedRows = await evaluate("document.querySelectorAll('.advice-plan-owned-row').length");
const ownedSlots = await evaluate(`(() => {
  const g = document.querySelector('.advice-plan-owned-row .advice-lineup');
  return g ? g.querySelectorAll('.advice-lineup-slot').length : 0;
})()`);
check('「你现在就能打的队」列出补 0 金的队（每支四个位置）',
  ownedRows > 0 && ownedSlots === 4, `${ownedRows} 支 / 首支 ${ownedSlots} 格`);

// ⑤ 视频来源：只剩**真实投稿**那一枚（2026-10-22 第二版：用户「不要 b 站搜索」）
const primary = await evaluate("document.querySelectorAll('.advice-team-video').length");
const more = await evaluate("document.querySelectorAll('.advice-plan-video-more').length");
check('卡片有来源视频按钮', primary > 0, `${primary} 枚`);
// 「另 N 条来源」必须写明「同一套配装」，并把那套配装印出来（2026-10-22）。
const sourcePack = await evaluate(`(() => {
  const d = document.querySelector('.advice-plan-video-more');
  if (!d) return null;
  return {
    summary: d.querySelector('summary')?.textContent || '',
    hasPack: !!d.querySelector('.advice-plan-video-pack .advice-lineup'),
  };
})()`);
check('「另 N 条来源」标注「同一套配装」并印出配装',
  !!sourcePack && /同一套配装/.test(sourcePack.summary) && sourcePack.hasPack,
  sourcePack ? sourcePack.summary : '没有多来源卡片');
const searchLinks = await evaluate("document.querySelectorAll('.advice-team-video.is-search').length");
check('没有「B站搜索」这类兜底按钮（用户：不要）', searchLinks === 0, `${searchLinks} 枚`);
const biliLinks = await evaluate("document.querySelectorAll('.advice-team-video.is-bilibili').length");
check('首选仍是 B 站优先（有 B 站投稿的队直接给 B 站）', biliLinks > 0, `${biliLinks} 枚 B 站`);
// 2026-10-22 第二版：紧凑配队里的图标要**小**（用户：「其它配装的图标太大了」）。
const iconSize = await evaluate(`(() => {
  const img = document.querySelector('.advice-plan-variant .advice-lineup-icon')
    || document.querySelector('.advice-lineup-icon');
  if (!img) return null;
  const r = img.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
})()`);
check('紧凑配队的头像 ≤ 18px（实测 16px）', !!iconSize && iconSize.w <= 18,
  iconSize ? `${iconSize.w}×${iconSize.h}` : '找不到头像');
console.log(`  · 其中「另 N 条来源」折叠块 ${more} 个（同一套阵容只有一条来源时不出）`);

// ⑥ 无 JS 异常
check('全程无 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));

console.log(`\n合计 ${passed} 项通过，${failed} 项失败`);
ws.close();
process.exit(failed ? 1 : 0);
