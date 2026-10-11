// Drive the GUI over the DevTools Protocol to verify the 抽卡推荐 tab renders.
//
// Opens (or reuses) a page at the given URL, switches to the advice tab, waits
// for the ranking to appear and writes a screenshot plus a summary of what the
// page actually contains.
//
// Usage: node tools/gui-shot.mjs [--url http://127.0.0.1:8360/] [--out shot.png]
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const URL_TO_OPEN = arg('url', 'http://127.0.0.1:8360/');
const OUT = resolve(arg('out', join(HERE, '..', '.snapref', 'advice-shot.png')));
const PORT = Number(arg('port', '9222'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const origin = new URL(URL_TO_OPEN).origin;
// 先把「之前失败留下的错误页」标签关掉：chrome-error:// 的标签 URL 不再以
// origin 开头，会被当成不存在而新建；但同一 origin 的上一个标签如果停在错误页，
// 复用它就会截到「无法访问此网站」。所以凡是命中目标 origin 或停在错误页的都先关。
for (const tab of list) {
  if (tab.type !== 'page') continue;
  const broken = tab.url.startsWith('chrome-error://');
  if (!broken && !tab.url.startsWith(origin)) continue;
  await fetch(`http://127.0.0.1:${PORT}/json/close/${tab.id}`).catch(() => {});
}
let page = null;
if (!page) {
  page = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_TO_OPEN)}`,
    { method: 'PUT' }).then((r) => r.json());
  await sleep(2500);
}
console.log('target:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.error) slot.reject(new Error(msg.error.message));
  else slot.resolve(msg.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || 'evaluate failed');
  }
  return res.result.value;
};

await send('Page.enable');
await send('Runtime.enable');

// Collect console errors so a broken script is visible rather than silent.
const errors = [];
ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails?.exception?.description
      || msg.params.exceptionDetails?.text || 'exception');
  }
});

console.log('navigating…');
await send('Page.navigate', { url: URL_TO_OPEN });
await sleep(3500);

// Switch to the advice tab the same way a user would.
console.log('clicking 抽卡推荐…');
const clicked = await evaluate(`(() => {
  const tab = document.getElementById('tabAdvice');
  if (!tab) return 'no tab';
  tab.click();
  return 'clicked';
})()`);
console.log('  ->', clicked);
await sleep(4000);

// 可选：切到指定副本/关卡再看（不同模式的判据写法不同，都要能当面看到）。
// 副本与关卡合成一个选择器，值是 `副本|关卡`（单档副本的关卡是空串）。
const WANT_MODE = arg('mode', '');
const WANT_STAGE = arg('stage', '');
if (WANT_MODE) {
  const want = `${WANT_MODE}|${WANT_STAGE}`;
  const switched = await evaluate(`(() => {
    const mode = document.getElementById('adviceMode');
    if (!mode || ![...mode.options].some((o) => o.value === ${JSON.stringify(want)})) {
      return 'no such mode/stage';
    }
    mode.value = ${JSON.stringify(want)};
    mode.dispatchEvent(new Event('change'));
    return mode.value;
  })()`);
  console.log('  mode ->', switched);
  await sleep(3000);
}

const summary = await evaluate(`(() => {
  const q = (id) => document.getElementById(id);
  const chars = q('adviceChars');
  const units = q('adviceConclusionUnits');
  return {
    layoutAdviceHidden: q('layoutAdvice')?.hidden,
    layoutRecordsHidden: q('layoutRecords')?.hidden,
    emptyHidden: q('adviceEmpty')?.hidden,
    emptyText: (q('adviceEmpty')?.textContent || '').slice(0, 200),
    source: q('adviceSource')?.textContent || '',
    brief: (q('adviceBrief')?.textContent || '').slice(0, 300),
    charRows: chars ? chars.querySelectorAll('.advice-char-row').length : 0,
    firstChar: q('adviceChars')?.querySelector('.advice-char-meta')?.textContent || '',
    // ① 战斗记录：四个副本按钮 + 只显示最后一关
    recordMeta: q('recordMeta')?.textContent || '',
    recordNote: (q('recordNote')?.textContent || '').slice(0, 220),
    recordTabs: [...(q('recordTabs')?.querySelectorAll('.record-tab') || [])].map((n) => ({
      text: n.textContent, active: n.classList.contains('is-active'), mode: n.dataset.mode,
    })),
    recordModeBlocks: [...(q('recordModes')?.querySelectorAll('.record-mode-title') || [])]
      .map((n) => n.textContent),
    recordFloorHeads: [...(q('recordModes')?.querySelectorAll('.record-floor-head') || [])]
      .map((n) => n.textContent),
    recordNodeCount: q('recordModes')?.querySelectorAll('.record-node').length || 0,
    recordTeams: q('recordModes')?.querySelectorAll('.record-team').length || 0,
    recordChips: q('recordModes')?.querySelectorAll('.record-chip').length || 0,
    recordClickableChips: q('recordModes')?.querySelectorAll('.record-chip.is-clickable').length || 0,
    recordAvatarImages: q('recordModes')?.querySelectorAll('.record-chip-avatar:not(.is-fallback)').length || 0,
    recordEnemies: [...(q('recordModes')?.querySelectorAll('.record-enemy') || [])]
      .map((n) => n.textContent),
    recordEnemyIcons: q('recordModes')?.querySelectorAll('.record-enemy-icon').length || 0,
    recordCompares: [...(q('recordModes')?.querySelectorAll('.record-compare') || [])]
      .slice(0, 3).map((n) => n.textContent.slice(0, 150)),
    recordExtra: [...(q('recordExtra')?.querySelectorAll('.record-summary-card') || [])]
      .map((n) => n.textContent),
    // 跨模式综合结论（2026-10 改版：总榜 = 纯黑塔网口径，方案 = 按角色池的补强清单）
    conclusionHidden: q('adviceConclusion')?.hidden,
    conclusionMeta: q('adviceConclusionMeta')?.textContent || '',
    // 性价比总榜：行数、前三条、类型筛选器与它的计数提示
    unitRows: units ? units.querySelectorAll('.advice-unit').length : 0,
    unitMeta: q('adviceUnitMeta')?.textContent || '',
    unitFilters: [ ...(q('adviceUnitFilter')?.querySelectorAll('.advice-filter') || []) ]
      .map((n) => n.textContent),
    unitKinds: units ? [ ...units.querySelectorAll('.advice-unit') ]
      .slice(0, 60).map((n) => n.querySelector('.advice-unit-kind')?.textContent || '') : [],
    firstUnits: units ? [ ...units.querySelectorAll('.advice-unit') ].slice(0, 3).map((n) => n.textContent.slice(0, 160)) : [],
    // 副本权重：**两套**（用户 2026-10 要求总榜与方案相互独立），各五个输入框
    weights: [ ...(q('adviceFrontierWeightRow')?.querySelectorAll('input.advice-weight') || []) ]
      .map((i) => i.dataset.mode + '|' + i.dataset.stage + '=' + i.value),
    weightsMeta: q('adviceFrontierWeightsMeta')?.textContent || '',
    planWeights: [ ...(q('advicePlanWeightRow')?.querySelectorAll('input.advice-weight') || []) ]
      .map((i) => i.dataset.mode + '|' + i.dataset.stage + '=' + i.value),
    planWeightsMeta: q('advicePlanWeightsMeta')?.textContent || '',
    // 抽卡方案（答案：按角色池 + 预算的补强清单）
    budgetMeta: q('adviceBudgetMeta')?.textContent || '',
    budgetInput: (() => {
      const node = q('adviceBudget');
      return node ? (String(node.tagName) + ':' + String(node.type) + ':' + String(node.value)) : 'none';
    })(),
    unitIcons: q('adviceConclusionUnits')?.querySelectorAll('.advice-unit-icon').length || 0,
    budgetIcons: q('adviceBudgetAnswer')?.querySelectorAll('.advice-unit-icon').length || 0,
    budgetPicks: [ ...(q('adviceBudgetAnswer')?.querySelectorAll('.advice-budget-item') || []) ]
      .map((n) => n.querySelector('.advice-budget-head')?.textContent || ''),
    budgetWhy: [ ...(q('adviceBudgetAnswer')?.querySelectorAll('.advice-unit-why') || []) ]
      .slice(0, 3).map((n) => n.textContent.slice(0, 120)),
    budgetNote: (q('adviceBudgetAnswer')?.querySelector('p')?.textContent || '').slice(0, 140),
    // 按用户要求撤掉的两节（应当查不到）
    planSection: Boolean(q('advicePlan')),
    bandsSection: Boolean(q('adviceBands')),
    charNote: (q('adviceCharNote')?.textContent || '').slice(0, 160),
    mode: q('adviceMode')?.value,
    season: q('adviceSeason')?.value,
    modeOptions: [ ...(q('adviceMode')?.options || []) ].map((o) => o.textContent),
    seasonOptions: [ ...(q('adviceSeason')?.options || []) ].map((o) => o.textContent),
  };
})()`);
console.log('\n=== 页面内容 ===');
console.log(JSON.stringify(summary, null, 2));

if (errors.length) {
  console.log('\n=== 控制台异常 ===');
  for (const e of errors) console.log(' ', String(e).split('\n')[0]);
}

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  // The advice page is very tall; a full-page capture can exceed the 8192px
  // that most image readers accept. `--viewport` gets a normal-sized frame.
  captureBeyondViewport: !process.argv.includes('--viewport'),
});
await writeFile(OUT, Buffer.from(shot.data, 'base64'));
console.log(`\n截图: ${OUT}`);
ws.close();
