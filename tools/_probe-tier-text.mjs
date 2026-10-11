// 探针（一次性，用户 2026-10-10 需求专用）：**界面上还写不写「满分 / 达标」？**
//
// 需求原话：「把网页上显示的『满分』『达标』改为具体的行动值」。
// 这个探针不看源码（源码由 `herta-test.mjs` 那条护栏管），只**量真实渲染出来的 DOM**：
//   ① 总榜行的「最佳证据」那一行写的是什么；
//   ② 点开徽标后的详情窗口：来源表「档位」列每一格、以及每一条脚注；
//   ③ 任何一个节点只要含 `满分|达标|及格` 就报出来（含 title / 属性）。
//
// 用法（CDP 浏览器需已在 9222；服务自己起在 8371，跑完就杀）：
//   node tools/_probe-tier-text.mjs --url=http://127.0.0.1:8371/
import { spawn } from 'node:child_process';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const RAW_URL = arg('url', 'http://127.0.0.1:8371/');
// 深链 `?view=advice` 才会落到抽卡推荐页（与 `check-advice-layout.mjs` 同一条规矩）。
const URL_ = /view=/.test(RAW_URL) ? RAW_URL
  : `${RAW_URL}${RAW_URL.includes('?') ? '&' : '?'}view=advice`;
// 调试端口可调（默认桌面那个 Chrome CDP.lnk 的 9222；沙箱里自己起时可以换）。
const CDP = arg('cdp', 'http://127.0.0.1:9222');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const res = await fetch(`${CDP}/json/version`).catch(() => null);
if (!res?.ok) {
  console.error('✗ 连不上 127.0.0.1:9224（先双击桌面的 Chrome CDP.lnk）');
  process.exit(1);
}
const { webSocketDebuggerUrl } = await res.json();

// 复用 / 新建该 origin 的标签页（与 check-advice-layout.mjs 同一套做法）。
const list = await (await fetch(`${CDP}/json/list`)).json();
const origin = new globalThis.URL(URL_).origin;
let page = list.find((t) => t.type === 'page' && String(t.url).startsWith(origin));
if (!page) {
  page = await (await fetch(`${CDP}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' })).json();
} else {
  await fetch(`${CDP}/json/activate/${page.id}`);
}
const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  seq += 1;
  pending.set(seq, { resolve, reject });
  ws.send(JSON.stringify({ id: seq, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate 抛错');
  return r.result.value;
};

await send('Page.enable');
await send('Page.navigate', { url: URL_ });
await sleep(6000);
// 等总榜渲染出来
for (let i = 0; i < 40; i += 1) {
  const n = await evaluate(`document.querySelectorAll('#adviceConclusionUnits .advice-unit').length`);
  if (n > 0) break;
  await sleep(1500);
}

const banned = /及格|达标|满分/;
const scan = `(() => {
  const hit = [];
  for (const n of document.querySelectorAll('#adviceConclusion *, #adviceUnitNote')) {
    if (n.children.length) continue;           // 只看叶子节点
    const t = n.textContent || '';
    if (${banned}.test(t)) hit.push(n.className + ': ' + t.slice(0, 120));
  }
  const bestLines = [ ...document.querySelectorAll('.advice-unit-best') ]
    .slice(0, 8).map((n) => n.textContent);
  const chips = [ ...document.querySelectorAll('.advice-unit-env') ]
    .slice(0, 6).map((n) => n.title || n.textContent);
  const note = document.getElementById('adviceUnitNote')?.textContent || '';
  return { bestLines, chips, note: note.replace(/\\s+/g, ' ').trim().slice(0, 260), leaves: hit };
})()`;

const page1 = await evaluate(scan);
console.log('\n=== 总榜行「最佳证据」（前 8 行）===');
for (const l of page1.bestLines) console.log('  ', l);
console.log('\n=== 副本 chip 的 title（前 6 个）===');
for (const l of page1.chips) console.log('  ', l);
console.log('\n=== 总榜说明段 ===');
console.log('  ', page1.note);
console.log('\n=== 含「满分/达标/及格」的叶子节点（应为 0）===');
console.log('  ', page1.leaves.length ? page1.leaves : '无 ✓');

// ---- 点开第一个徽标，量大窗口里的档位列与脚注 ----
await evaluate(`(() => {
  const wrap = document.querySelector('#adviceConclusionUnits .advice-value-wrap');
  if (wrap) wrap.click();
  return Boolean(wrap);
})()`);
await sleep(4000);
for (let i = 0; i < 20; i += 1) {
  const ok = await evaluate(`Boolean(document.querySelector('.advice-tip-modal')
    && !document.querySelector('.advice-tip-modal').hidden
    && document.querySelector('.advice-packs-item'))`);
  if (ok) break;
  await sleep(1000);
}
const tip = await evaluate(`(() => {
  const modal = document.querySelector('.advice-tip-modal');
  const tip = modal?.querySelector('.advice-value-tip');
  if (!modal || modal.hidden || !tip) return null;
  const table = tip.querySelector('.advice-value-tip-table');
  const head = [ ...(table?.querySelectorAll('thead th') || []) ].map((t) => t.textContent);
  const rows = [ ...(table?.querySelectorAll('tbody tr') || []) ]
    .map((tr) => [ ...tr.children ].map((td) => td.textContent));
  const notes = [ ...tip.querySelectorAll('.advice-value-tip-note') ].map((n) => n.textContent);
  const packs = [ ...tip.querySelectorAll('.advice-packs-env-tier') ].map((n) => n.textContent);
  const leaves = [];
  for (const n of tip.querySelectorAll('*')) {
    if (n.children.length) continue;
    const t = n.textContent || '';
    if (${banned}.test(t)) leaves.push((n.className || n.tagName) + ': ' + t.slice(0, 100));
  }
  const titles = [ ...tip.querySelectorAll('[title]') ]
    .map((n) => n.getAttribute('title')).filter((t) => ${banned}.test(t));
  return { head, rows, notes, packs, leaves, titles };
})()`);
console.log('\n=== 详情窗口 ===');
if (!tip) {
  console.log('  ⚠️ 窗口没开（或内容没出来）');
} else {
  console.log('  表头:', JSON.stringify(tip.head));
  const tierCol = tip.head.indexOf('档位');
  console.log(`  「档位」列（第 ${tierCol + 1} 列）逐行:`);
  for (const r of tip.rows) console.log('    ', JSON.stringify(r[tierCol]), '| 整行:', JSON.stringify(r));
  console.log('  该角色全部配队的档位标签（前 10）:', JSON.stringify(tip.packs.slice(0, 10)));
  console.log('  脚注:');
  for (const n of tip.notes) console.log('    ', n);
  console.log('  含禁词的叶子节点（应为 0）:', tip.leaves.length ? tip.leaves : '无 ✓');
  console.log('  含禁词的 title 属性（应为 0）:', tip.titles.length ? tip.titles : '无 ✓');
}
ws.close();
