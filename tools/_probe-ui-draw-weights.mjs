// 探针：**抽卡权重那一行界面**（不需要浏览器）—— 用户 2026-10-16 第 1 条
// 「泛用性调整为默认 0.5」的边缘用例。
//
// 为什么需要它：`check-advice-layout.mjs` 要在 **9222 上的调试浏览器**里量真实载荷
// （本机没开那个浏览器时整套判据会被跳过），而「默认值 / 恢复默认 / 存档优先」这三件事
// 恰恰是**改默认值时最容易漏**的地方。这个探针用最小 DOM shim 真的跑一遍
// `advice-view.js` 的那几个内部函数（与 `_probe-ui-version-weights.mjs` 同一条路数）。
//
// 覆盖（对应 docs/功能要求.md §8 的第 1~6 条）：
//   * renderDrawWeightRow()  三个输入框的 DOM（键、原值 = 1 / 1 / 0.5、标签）
//   * renderDrawWeightsMeta() 归一后的比例串（40% / 50% / 10% + 「（默认）」）
//   * loadDrawWeights()       localStorage 的五种形状（**老存档 1:1:1 不许被默认覆盖**）
//   * readDrawWeights(grid)  空串 = 0 / 非法值退回默认
//   * 「恢复默认」按钮        三个框与 state 都回到 1 / 1 / 0.5
//
// ⚠️ 不验排版（宽度 / 折行要真浏览器），只验**建树与读数**这条接线。
// 用法：`node tools/_probe-ui-draw-weights.mjs`（退出码非 0 = 有问题）
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- 最小 DOM shim（与 `_probe-ui-version-weights.mjs` 同一套）------------------
class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.value = '';
    this.attrs = {};
    const self = this;
    this.classList = {
      add: (...names) => { self.className = [self.className, ...names].filter(Boolean).join(' '); },
      remove: () => {},
      contains: (n) => self.className.split(/\s+/).includes(n),
      toggle: () => {},
    };
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this._on ||= {})[type] = [...(this._on[type] || []), fn]; }
  removeEventListener() {}
  /** 与真浏览器一致：事件**冒泡**（`advice-view.js` 的处理器挂在网格上）。 */
  dispatch(type) {
    for (let node = this; node; node = node.parent) {
      for (const fn of node._on?.[type] || []) fn({ type, target: this });
    }
  }
  click() { this.dispatch('click'); }
  contains() { return false; }
  querySelector() { return null; }
  querySelectorAll(sel) {
    // 只实现本探针用到的那一条选择器。
    const want = String(sel || '');
    if (want !== 'input.advice-draw-weight') return [];
    const out = [];
    const walk = (n) => {
      if (String(n.className || '').split(/\s+/).includes('advice-draw-weight')) out.push(n);
      for (const c of n.children || []) walk(c);
    };
    for (const c of this.children) walk(c);
    return out;
  }
  set innerHTML(v) { if (v === '') this.children = []; }
  get innerHTML() { return ''; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    return this._text !== undefined && !this.children.length
      ? this._text
      : this.children.map((c) => c.textContent ?? '').join('');
  }
}

const REGISTRY = new Map();
const makeEl = (id) => { const e = new FakeElement('div'); e.id = id; REGISTRY.set(id, e); return e; };
for (const id of ['adviceDrawWeightRow', 'adviceDrawWeightsMeta',
  // `mountAdviceView()` 会直接对这几个节点调 addEventListener（缺了会 TypeError）
  'adviceFrontierWeightRow', 'adviceFrontierWeightsMeta', 'adviceFrontierWeightsReset',
  'adviceVersionWeightRow', 'adviceVersionWeightsMeta',
  'adviceMode', 'adviceSeason', 'adviceReload', 'adviceUpdate', 'adviceConclusionUnits',
  'adviceTeamPlanBody', 'adviceDrawWeightsReset']) makeEl(id);

globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  getElementById: (id) => REGISTRY.get(id) || null,
  addEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
  documentElement: new FakeElement('html'),
  body: new FakeElement('body'),
};
globalThis.window = { addEventListener: () => {}, location: { href: 'http://localhost/' } };
let STORE = new Map();
globalThis.localStorage = {
  getItem: (k) => (STORE.has(k) ? STORE.get(k) : null),
  setItem: (k, v) => STORE.set(k, String(v)),
  removeItem: (k) => STORE.delete(k),
};
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, available: true, frontierUnits: [], counts: {} }),
});

// ---- 把内部函数临时导出 -----------------------------------------------------
const SRC = join(ROOT, 'public/scripts/advice-view.js');
const TMP = join(ROOT, 'public/scripts/_tmp-dw-export.mjs');
writeFileSync(TMP, `${readFileSync(SRC, 'utf8')}\n`
  + 'export { state, readDrawWeights, loadDrawWeights, renderDrawWeightRow,'
  + ' renderDrawWeightsMeta };\n', 'utf8');
const V = await import(`file://${TMP.replace(/\\/g, '/')}`);
unlinkSync(TMP);

const { state, DRAW_WEIGHT_ROWS, drawWeightDefaults, normalizeDrawWeights } = {
  state: V.state,
  ...(await import(`file://${join(ROOT, 'public/scripts/advice.js').replace(/\\/g, '/')}`)),
};

let bad = 0;
const check = (label, ok, detail = '') => {
  if (!ok) bad += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const inputsOf = (grid) => grid.querySelectorAll('input.advice-draw-weight');
const DRAW_KEY = 'hsr.advice.drawWeights';

// ---- ① 默认值：三个框是 1 / 1 / 0.5 -----------------------------------------
console.log('\n▶ ① 默认值（用户 2026-10-16 第 1 条：泛用性 0.5）');
STORE = new Map();
state.drawWeights = { ...drawWeightDefaults() };
V.renderDrawWeightRow();
const row = REGISTRY.get('adviceDrawWeightRow');
const inputs = inputsOf(row);
check('三个输入框', inputs.length === 3, `实际 ${inputs.length}`);
check('键 = strength, cost, versatility',
  inputs.map((i) => i.dataset.key).join(',') === 'strength,cost,versatility',
  inputs.map((i) => i.dataset.key).join(','));
check('默认原值 = 4, 5, 1（用户 2026-10-18）',
  inputs.map((i) => i.value).join(',') === '4,5,1', inputs.map((i) => i.value).join(','));
check('标签来自 DRAW_WEIGHT_ROWS（不抄第二份）',
  inputs.every((inp, i) => row.children[i]?.children?.[0]?.textContent === DRAW_WEIGHT_ROWS[i].label),
  row.children.map((l) => l.children[0]?.textContent).join(' / '));
check('aria-label 写明「（抽卡权重）」',
  inputs.every((i) => String(i.attrs['aria-label'] || '').includes('抽卡权重')));
V.renderDrawWeightsMeta();
const meta0 = REGISTRY.get('adviceDrawWeightsMeta').textContent;
check('摘要印归一后的比例 40% / 50% / 10%',
  meta0.includes('强度 40%') && meta0.includes('性价比 50%') && meta0.includes('泛用性 10%'), meta0);
check('默认态带「（默认）」（不再写「默认三等分」）',
  meta0.includes('（默认）') && !meta0.includes('三等分'), meta0);
check('摘要说明两个榜共用这三个系数',
  meta0.includes('角色得分') && meta0.includes('补金推荐分'), meta0);

// ---- ② 读数边界：空串 = 0 / 非法值退回默认 -----------------------------------
console.log('\n▶ ② readDrawWeights() 读数边界');
const writeInputs = (values) => inputs.forEach((inp, i) => { inp.value = String(values[i]); });
writeInputs([2, '', 'x']);
const read1 = V.readDrawWeights(row);
check('空串 = 0', read1.cost === 0, JSON.stringify(read1));
check('非法值退回默认（泛用性默认 1）', read1.versatility === 1, JSON.stringify(read1));
check('合法原值原样收下', read1.strength === 2, JSON.stringify(read1));

// ---- ③ 存档：老存档 1:1:1 不许被新默认覆盖 -----------------------------------
console.log('\n▶ ③ loadDrawWeights()：存档优先于默认值');
STORE = new Map();
check('没有存档 → 默认 4 / 5 / 1',
  JSON.stringify(V.loadDrawWeights()) === JSON.stringify({ strength: 4, cost: 5, versatility: 1 }),
  JSON.stringify(V.loadDrawWeights()));
STORE = new Map([[DRAW_KEY, JSON.stringify({ strength: 1, cost: 1, versatility: 1 })]]);
check('⭐ 老存档 1:1:1 **保持原样**（改默认值不会悄悄改掉用户存过的偏好）',
  JSON.stringify(V.loadDrawWeights()) === JSON.stringify({ strength: 1, cost: 1, versatility: 1 }),
  JSON.stringify(V.loadDrawWeights()));
STORE = new Map([[DRAW_KEY, JSON.stringify({ strength: 3, cost: 1 })]]);
check('缺键的老存档 → 缺的那个按新默认补（泛用性 1）',
  JSON.stringify(V.loadDrawWeights()) === JSON.stringify({ strength: 3, cost: 1, versatility: 1 }),
  JSON.stringify(V.loadDrawWeights()));
STORE = new Map([[DRAW_KEY, 'not-json']]);
check('存档是垃圾 → 退回默认',
  JSON.stringify(V.loadDrawWeights()) === JSON.stringify({ strength: 4, cost: 5, versatility: 1 }),
  JSON.stringify(V.loadDrawWeights()));
STORE = new Map([[DRAW_KEY, JSON.stringify({ strength: -1, cost: 'abc', versatility: null })]]);
check('存档里非法值 → 忽略（保留默认），不写进 state',
  JSON.stringify(V.loadDrawWeights()) === JSON.stringify({ strength: 4, cost: 5, versatility: 1 }),
  JSON.stringify(V.loadDrawWeights()));

// ---- ④ 归一：三项全 0 退回默认比例 -------------------------------------------
console.log('\n▶ ④ normalizeDrawWeights() 的边界（与 team-plan-test 同一套判据）');
check('三项全 0 → 退回默认比例 0.4 / 0.5 / 0.1',
  JSON.stringify(normalizeDrawWeights({ strength: 0, cost: 0, versatility: 0 }))
  === JSON.stringify({ strength: 0.4, cost: 0.5, versatility: 0.1 }),
  JSON.stringify(normalizeDrawWeights({ strength: 0, cost: 0, versatility: 0 })));
check('不传 → 默认比例',
  JSON.stringify(normalizeDrawWeights(undefined))
  === JSON.stringify({ strength: 0.4, cost: 0.5, versatility: 0.1 }),
  JSON.stringify(normalizeDrawWeights(undefined)));

// ---- ⑤ 「恢复默认」按钮 -------------------------------------------------------
console.log('\n▶ ⑤ 恢复默认：三个框与 state 都回到 4 / 5 / 1');
STORE = new Map();
V.mountAdviceView();
state.drawWeights = { strength: 3, cost: 1, versatility: 1 };
V.renderDrawWeightRow();
V.renderDrawWeightsMeta();
const before = inputsOf(REGISTRY.get('adviceDrawWeightRow')).map((i) => i.value).join(',');
REGISTRY.get('adviceFrontierWeightsReset').click();
const after = inputsOf(REGISTRY.get('adviceDrawWeightRow')).map((i) => i.value).join(',');
const metaAfter = REGISTRY.get('adviceDrawWeightsMeta').textContent;
check('点击前是用户改过的值', before === '3,1,1', before);
check('点击后三个框回到 4,5,1', after === '4,5,1', after);
check('state 同步回默认', JSON.stringify(state.drawWeights)
  === JSON.stringify({ strength: 4, cost: 5, versatility: 1 }), JSON.stringify(state.drawWeights));
check('摘要跟着回到 40% / 50% / 10%（默认）',
  metaAfter.includes('强度 40%') && metaAfter.includes('性价比 50%') && metaAfter.includes('（默认）'),
  metaAfter);
check('存档也写回默认值',
  STORE.get(DRAW_KEY) === JSON.stringify({ strength: 4, cost: 5, versatility: 1 }),
  STORE.get(DRAW_KEY));

console.log(`\n抽卡权重界面探针：${bad === 0 ? '全部通过 ✓' : `${bad} 项失败 ✗`}`);
if (bad) process.exitCode = 1;
