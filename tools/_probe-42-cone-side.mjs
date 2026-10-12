// 手工探针：总榜行的光锥图标位置（用户 2026-10-10 第三轮「图标移到加号右侧、名称左侧」）。
//
// 为什么单独写：`check-advice-layout.mjs` 那套要跑三个视口 × 五个副本（约 3 分钟），
// 而这一处只关心「图标是不是夹在 + 与名称之间、名称有没有 S layer」。
// 用法：先 `node bin/serve.mjs --port 8360` 与桌面 `Chrome CDP.lnk`，再
//   node tools/_probe-42-cone-side.mjs
// 输出：前 6 行的几何（加号右缘 / 图标左缘 / 名字左缘）与逐行 PASS/FAIL。

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const APP = process.env.APP_URL || 'http://127.0.0.1:8360/?view=advice';

const j = await (await fetch(`${CDP}/json/list`)).json();
let target = j.find((t) => t.type === 'page' && t.url.startsWith(APP.split('?')[0]))
  || j.find((t) => t.type === 'page');
if (!target) throw new Error('没有可用的标签页');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pend = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id;
  pend.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Page.navigate', { url: APP });
// ⚠️ 结论是**服务端现算**的（POST /api/archive/conclusion 实测要 15~25 秒），
// 固定 sleep 会量到一个空榜（本次实测 15 秒时还是 0 行、20 秒才有 67 行）。
// 所以轮询等行出来，最多 60 秒。
let rows = 0;
for (let i = 0; i < 60; i += 1) {
  await sleep(1000);
  rows = await evaluate('document.querySelectorAll("#adviceConclusionUnits .advice-unit").length');
  if (rows > 0) break;
}
if (!rows) {
  const why = await evaluate('(document.getElementById("adviceConclusionUnits")||{}).textContent');
  console.error(`等不到榜单：${JSON.stringify(why)}`);
  process.exit(2);
}

const probe = await evaluate(`(() => {
  const rows = [ ...document.querySelectorAll('#adviceConclusionUnits .advice-unit') ];
  const info = rows.map((row, i) => {
    const cost = row.querySelector('.advice-unit-cost');
    const icon = row.querySelector('.advice-unit-cone');
    const plus = cost && cost.querySelector('.advice-unit-plus');
    const textNode = cost && cost.querySelector('.advice-unit-cone-text');
    const pr = plus && plus.getBoundingClientRect();
    const ir = icon && icon.getBoundingClientRect();
    const tr = textNode && textNode.getBoundingClientRect();
    return {
      i: i + 1,
      name: row.querySelector('.advice-unit-name')?.textContent || '?',
      cost: cost ? cost.textContent : null,
      inCost: Boolean(cost && icon && cost.contains(icon)),
      hasPlus: Boolean(plus),
      hasText: Boolean(textNode),
      text: textNode ? textNode.textContent : null,
      // 名称必须以 S1~S5 结尾（用户点名「名称必须带有叠影层数」）
      hasSuperimp: Boolean(textNode && / S[1-5]$/.test(textNode.textContent)),
      plusRight: pr ? Math.round(pr.right) : null,
      iconLeft: ir ? Math.round(ir.left) : null,
      textLeft: tr ? Math.round(tr.left) : null,
      afterPlus: Boolean(pr && ir) && ir.left >= pr.right - 1,
      beforeName: Boolean(tr && ir) && ir.right <= tr.left + 1,
    };
  });
  // 顺手复核两件**容易被这次改动波及**的事（都在 check-advice-layout.mjs 里）：
  //   * 花费格的 textContent 形状（图标插进去不能把「 · 」挤掉）；
  //   * 性价比徽标与花费格的间距（改 inline-flex 会让宽度变成内容宽）。
  const head = document.querySelector('#adviceConclusionUnits .advice-unit-head');
  const cost = head && head.querySelector('.advice-unit-cost');
  const wrap = head && head.querySelector('.advice-value-wrap');
  const gap = cost && wrap ? Math.round(wrap.getBoundingClientRect().left - cost.getBoundingClientRect().right) : null;
  const badShape = info.filter((r) => !/^(\\+ .+ · )?\\d+ 金$/.test(r.cost || ''));
  return { rows: rows.length, info, badShape: badShape.map((r) => r.cost), badgeGap: gap };
})()`);

console.log(`总榜 ${probe.rows} 行\n`);
const bad = probe.info.filter(
  (r) => !(r.inCost && r.hasPlus && r.hasText && r.afterPlus && r.beforeName && r.hasSuperimp));
for (const r of probe.info.slice(0, 6)) {
  console.log(`  #${r.i} ${r.name}\n      花费 ${JSON.stringify(r.cost)}`);
  console.log(`      加号右缘 ${r.plusRight} / 图标左缘 ${r.iconLeft} / 名字左缘 ${r.textLeft}`
    + `  在花费格里=${r.inCost}  在加号右=${r.afterPlus}  在名字左=${r.beforeName}`
    + `  带叠影=${r.hasSuperimp}`);
}
console.log(`\n${bad.length ? `✗ ${bad.length} 行不合格：`
  + bad.slice(0, 8).map((r) => `#${r.i}`).join(' ') : '✓ 每一行都是「+ [图标] 光锥名 S层 · N 金」'}`);
// 花费文字形状（`+ 光锥名 S5 · 3 金`）与徽标间距：check-advice-layout.mjs 里那两条
// 判据的本地复算 —— 图标插进花费格之后这两处最容易静默坏掉。
const shapeOk = probe.badShape.length === 0;
const gapOk = Number.isFinite(probe.badgeGap) && probe.badgeGap >= 0 && probe.badgeGap <= 24;
console.log(`${shapeOk ? '✓' : '✗'} 花费文字形状（应是「[+ 光锥… · ]N 金」）：`
  + (shapeOk ? '全部合格' : JSON.stringify(probe.badShape.slice(0, 3))));
console.log(`${gapOk ? '✓' : '✗'} 性价比徽标与花费的间距 = ${probe.badgeGap}px（判据 0~24px）`);
ws.close();
process.exit(bad.length || !shapeOk || !gapOk ? 1 : 0);
