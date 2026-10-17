// 探针：**版本权重那一行界面**（不需要浏览器）—— 用户 2026-10-16 第 3 条的第三类权重。
//
// 为什么需要它：`check-advice-layout.mjs` 要在 **9222 上的调试浏览器**里量真实载荷
// （本机没开那个浏览器时整套判据会被跳过），而版本权重这条接线有四处容易漏：
// 输入框有没有画、读数边界对不对、存档三种形状认不认、请求体里带没带。
// 这个探针用最小 DOM shim 真的跑一遍 `mountAdviceView()`（含真实 input 事件冒泡 +
// 防抖），代价是几百毫秒 —— 与 `_probe-tip-structure.mjs` 同一条路数。
//
// 它把 `advice-view.js` 里那几个内部函数临时导出、用最小 DOM shim 跑一遍：
//   * renderVersionWeightRow()  六个输入框的 DOM（标签、键、值、title）
//   * readVersionWeights(grid)  六种输入 → 数组（含空串 / 非法值）
//   * loadVersionWeights()      localStorage 存档的五种形状（数组 / 对象 / 短数组 / 垃圾 / 全 0）
//   * versionWeightsSignature() 缓存签名（全 0 与默认表应同签名、改了必须变）
//   * mountAdviceView()         接线（事件 → state → 存档 → 请求体 → 「恢复默认」）
//
// ⚠️ 不验排版（宽度 / 折行要真浏览器），只验**建树与读数**这条接线。
// 用法：`node tools/_probe-ui-version-weights.mjs`（退出码非 0 = 有问题）
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- 最小 DOM shim -----------------------------------------------------------
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
  /**
   * 派发一个事件。⚠️ **要冒泡**：真浏览器里 `input` 事件从输入框冒到网格，
   * 而 `advice-view.js` 的处理器挂在**网格**上（`grid.addEventListener('input', …)`）
   * —— 不冒泡的话探针会以为「接线没挂上」（本轮第一次跑就是这么被骗的）。
   */
  dispatch(type) {
    for (let node = this; node; node = node.parent) {
      for (const fn of node._on?.[type] || []) fn({ type, target: this });
    }
  }
  contains() { return false; }
  querySelector() { return null; }
  querySelectorAll(sel) {
    // 只实现本探针用到的那一条选择器（`input.advice-version-weight`）。
    const want = String(sel || '');
    if (want !== 'input.advice-version-weight') return [];
    const out = [];
    const walk = (n) => {
      if (String(n.className || '').split(/\s+/).includes('advice-version-weight')) out.push(n);
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
for (const id of ['adviceVersionWeightRow', 'adviceVersionWeightsMeta',
  'adviceFrontierWeightRow', 'adviceFrontierWeightsMeta', 'adviceDrawWeightRow',
  'adviceDrawWeightsMeta', 'adviceConclusionUnits', 'adviceTeamPlanBody',
  // 版本权重的「加一版 / 删一版」两个按钮 + 版数标签（用户 2026-10-17）。
  // ⚠️ 它们缺了不会 TypeError（`el.x?.` 都带可选链），但 ⑥ 的判据会直接红 ——
  // 那正是我们要的：界面少画一个按钮，这里就该报出来。
  'adviceVersionWeightAdd', 'adviceVersionWeightRemove', 'adviceVersionWeightCount',
  // `mountAdviceView()` 会直接对这几个节点调 addEventListener（缺了会 TypeError）
  'adviceMode', 'adviceSeason', 'adviceReload', 'adviceUpdate',
  'adviceFrontierWeightsReset']) makeEl(id);

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
// 记录 `/api/archive/conclusion` 的请求体（④ 要验「版本权重真的发出去了」）。
const SENT = [];
globalThis.fetch = async (url, opts = {}) => {
  SENT.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, available: true, frontierUnits: [], counts: {} }),
  };
};

// ---- 把内部函数临时导出 -----------------------------------------------------
const SRC = join(ROOT, 'public/scripts/advice-view.js');
const TMP = join(ROOT, 'public/scripts/_tmp-vw-export.mjs');
writeFileSync(TMP, `${readFileSync(SRC, 'utf8')}\n`
  + '// ⚠️ `mountAdviceView` 本来就是导出的，别再导一次（会 Duplicate export）。\n'
  + 'export { state, readVersionWeights, loadVersionWeights,'
  + ' renderVersionWeightRow, renderVersionWeightsMeta, versionWeightsSignature, conclusionKey };\n',
'utf8');
const V = await import(`file://${TMP.replace(/\\/g, '/')}`);
unlinkSync(TMP);

const { state, VERSION_WEIGHT_ROWS, versionWeightDefaults } = {
  state: V.state,
  mountAdviceView: V.mountAdviceView,
  ...(await import(`file://${join(ROOT, 'public/scripts/advice.js').replace(/\\/g, '/')}`)),
};

let bad = 0;
const check = (label, ok, detail = '') => {
  if (!ok) bad += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const findInputs = (grid) => grid.querySelectorAll('input.advice-version-weight');

// ---- ① 画出来的六个输入框 -----------------------------------------------------
console.log('\n▶ ① renderVersionWeightRow() 建树');
V.renderVersionWeightRow();
const grid = REGISTRY.get('adviceVersionWeightRow');
const inputs = findInputs(grid);
check('六个输入框', inputs.length === 6, `实际 ${inputs.length}`);
check('槽位键 = 0..5', inputs.map((i) => i.dataset.key).join(',') === '0,1,2,3,4,5',
  inputs.map((i) => i.dataset.key).join(','));
check('默认值 = 3,2.5,2,1.5,1,0.5',
  inputs.map((i) => i.value).join(',') === '3,2.5,2,1.5,1,0.5',
  inputs.map((i) => i.value).join(','));
check('标签来自 VERSION_WEIGHT_ROWS（不抄第二份）',
  inputs.every((inp, i) => {
    const labelSpan = grid.children[i]?.children?.[0];
    return labelSpan?.textContent === VERSION_WEIGHT_ROWS[i].label;
  }), grid.children.map((l) => l.children[0]?.textContent).join(' / '));
check('title 写明「距该副本当前版本」',
  inputs.every((i) => String(i.title ?? i.attrs.title ?? '').includes('该副本')),
  inputs[0]?.title ?? inputs[0]?.attrs.title);
check('class 是 advice-version-weight（读数按它选）',
  inputs.every((i) => i.className.includes('advice-version-weight')));
check('meta 印出逐个槽位的实际值（槽位名：当前版本 / 前N个版本）',
  /当前版本 3 : 前1个版本 2\.5 : 前2个版本 2 : 前3个版本 1\.5 : 前4个版本 1 : 前5个版本 0\.5/.test(
    REGISTRY.get('adviceVersionWeightsMeta').textContent),
  REGISTRY.get('adviceVersionWeightsMeta').textContent);

// ---- ② readVersionWeights：原值 / 空串 / 非法 ---------------------------------
console.log('\n▶ ② readVersionWeights() 读数');
const writeInputs = (values) => inputs.forEach((inp, i) => { inp.value = String(values[i]); });
writeInputs([1, 0, '', 2, 'x', 0.5]);
const read1 = V.readVersionWeights(grid);
check('空串 = 0', read1[2] === 0, JSON.stringify(read1));
check('非法值退回默认（槽位 4 默认 1）', read1[4] === 1, String(read1[4]));
check('合法原值原样收下', read1[0] === 1 && read1[1] === 0 && read1[3] === 2 && read1[5] === 0.5,
  JSON.stringify(read1));
check('返回**数组**（长度 6）', Array.isArray(read1) && read1.length === 6,
  `${Array.isArray(read1)} / ${read1.length}`);
check('无 grid 时退回默认表',
  JSON.stringify(V.readVersionWeights(null)) === JSON.stringify(versionWeightDefaults()));

// ---- ③ loadVersionWeights：三种存档形状 ---------------------------------------
console.log('\n▶ ③ loadVersionWeights() 存档形状');
STORE = new Map();
check('没存档 → 默认表',
  JSON.stringify(V.loadVersionWeights()) === JSON.stringify(versionWeightDefaults()));
STORE.set('hsr.advice.versionWeights', JSON.stringify([1, 1, 0, 0, 0, 0]));
check('数组存档原样读回（只算最新两版）',
  V.loadVersionWeights().join(',') === '1,1,0,0,0,0', V.loadVersionWeights().join(','));
STORE.set('hsr.advice.versionWeights', JSON.stringify({ 0: 5, 1: 1 }));
check('对象形状（老存档）也认',
  V.loadVersionWeights().join(',') === '5,1,2,1.5,1,0.5', V.loadVersionWeights().join(','));
STORE.set('hsr.advice.versionWeights', JSON.stringify([1, -1]));
check('短数组：长度**就是**档位数（负数退回该档默认）',
  V.loadVersionWeights().join(',') === '1,2.5',
  `${V.loadVersionWeights().join(',')} —— 用户 2026-10-17 起「删一版」存的就是短数组，`
    + '补齐到 6 档等于那个按钮按了没反应');
STORE.set('hsr.advice.versionWeights', '"垃圾"');
check('垃圾存档 → 默认表',
  JSON.stringify(V.loadVersionWeights()) === JSON.stringify(versionWeightDefaults()));
STORE.set('hsr.advice.versionWeights', JSON.stringify([0, 0, 0, 0, 0, 0]));
check('全 0 存档 → 归一化后退回默认表（与算分同一条约定）',
  JSON.stringify(V.loadVersionWeights()) === JSON.stringify([0, 0, 0, 0, 0, 0])
    && JSON.stringify(V.versionWeightsSignature()) === JSON.stringify(
      versionWeightDefaults().map((v) => Number(v).toFixed(4)).join(',')),
  '⚠️ 存档保留原值（界面上仍是 6 个 0，用户能看到自己敲的），生效值由 normalize 兜底');

// ---- ④ 缓存签名：改了必须变、全 0 与默认同签名 --------------------------------
console.log('\n▶ ④ versionWeightsSignature()（进 conclusionKey / packsCache / 请求）');
state.versionWeights = versionWeightDefaults();
const sigDefault = V.versionWeightsSignature();
const keyDefault = V.conclusionKey();
state.versionWeights = [1, 0, 0, 0, 0, 0];
const sigOnlyLatest = V.versionWeightsSignature();
const keyOnlyLatest = V.conclusionKey();
state.versionWeights = [0, 0, 0, 0, 0, 0];
const sigZero = V.versionWeightsSignature();
check('改版本权重 → 签名变', sigDefault !== sigOnlyLatest, `${sigDefault} → ${sigOnlyLatest}`);
check('改版本权重 → conclusionKey 变（缓存键含它）', keyDefault !== keyOnlyLatest);
check('全 0 与默认表同签名（都生效为默认表）', sigZero === sigDefault, `${sigZero}`);
check('签名里带 ver[...] 段', keyDefault.includes(`ver[${sigDefault}]`));
state.versionWeights = versionWeightDefaults();

// ---- ⑤ 接线：真实 input 事件 → localStorage → 请求体 → 「恢复默认」 -----------------
//
// 这一段跑的是**真的 `mountAdviceView()`**（不是手搓调用），所以钉的是接线本身：
// 事件有没有挂上、防抖后有没有请服务端、请求体里带没带 `versionWeights`、
// 重置按钮有没有把三组一起清回去。
console.log('\n▶ ⑤ 接线（mountAdviceView → input 事件 → localStorage → 请求体）');
V.mountAdviceView({});
// ⚠️ 请求那一步有 `if (state.index)` 这道闸（没加载索引就不必算结论）——
// 探针要验请求体，就得先让它以为索引已经加载过（形状只用到 `generatedAt`）。
state.index = { generatedAt: 'probe' };const grid2 = REGISTRY.get('adviceVersionWeightRow');
const inputs2 = findInputs(grid2);
check('mount 之后输入框仍在（renderWeightRows 一起画的）', inputs2.length === 6, String(inputs2.length));
STORE = new Map();
SENT.length = 0;
inputs2.forEach((inp, i) => { inp.value = String([1, 0, 0, 0, 0, 0][i]); });
inputs2[0].dispatch('input');
check('input 事件后 state.versionWeights 更新',
  state.versionWeights.join(',') === '1,0,0,0,0,0', state.versionWeights.join(','));
check('存档写进 hsr.advice.versionWeights',
  STORE.get('hsr.advice.versionWeights') === JSON.stringify([1, 0, 0, 0, 0, 0]),
  STORE.get('hsr.advice.versionWeights'));
check('meta 立刻重画（不等服务端）',
  REGISTRY.get('adviceVersionWeightsMeta').textContent.includes('当前版本 1'),
  REGISTRY.get('adviceVersionWeightsMeta').textContent);
// 防抖 450ms：等够再确认请求发出去了。
await new Promise((r) => setTimeout(r, 700));
const conclusionReq = SENT.find((s) => s.url.includes('/api/archive/conclusion'));
check('防抖后请了服务端重算', Boolean(conclusionReq), SENT.map((s) => s.url).join(' / '));
check('请求体带 versionWeights（数组）',
  JSON.stringify(conclusionReq?.body?.versionWeights) === JSON.stringify([1, 0, 0, 0, 0, 0]),
  JSON.stringify(conclusionReq?.body?.versionWeights));
check('请求体同时带另外两组（三组一起发）',
  conclusionReq?.body?.drawWeights !== undefined
    && conclusionReq?.body?.frontierWeights !== undefined,
  `drawWeights=${JSON.stringify(conclusionReq?.body?.drawWeights)}`
    + ` frontierWeights=${JSON.stringify(conclusionReq?.body?.frontierWeights)}`);

// 「恢复默认」必须把三组一起还原（含版本权重）。
STORE = new Map();
state.versionWeights = [1, 0, 0, 0, 0, 0];
REGISTRY.get('adviceFrontierWeightsReset').dispatch('click');
await new Promise((r) => setTimeout(r, 100));
check('恢复默认把版本权重还原成默认表',
  state.versionWeights.join(',') === '3,2.5,2,1.5,1,0.5', state.versionWeights.join(','));
check('恢复默认也清回 localStorage',
  STORE.get('hsr.advice.versionWeights') === JSON.stringify([6, 5, 4, 3, 2, 1]),
  STORE.get('hsr.advice.versionWeights'));
check('恢复默认后输入框也回到默认值',
  findInputs(REGISTRY.get('adviceVersionWeightRow')).map((i) => i.value).join(',')
    === '3,2.5,2,1.5,1,0.5',
  findInputs(REGISTRY.get('adviceVersionWeightRow')).map((i) => i.value).join(','));

// ---- ⑥ 加一版 / 删一版（用户 2026-10-17） ------------------------------------
//
// 用户原话：「添加两个按钮，让用户可以点击按钮添加更多的版本权重，或者点击删除最后一个
// 版本，这样会有更多或者更少的版本权重」。
//
// 这一段跑的是**真的按钮节点 + 真的 click 事件**（那两个按钮是按 id 建的空节点，
// `mountAdviceView()` 已经把处理器挂上去了），钉四件事：
//   ① 事件真的挂上了（节点 / id 改名 → 处理器静默失效，界面看着有按钮但点不动）；
//   ② 加档**保住已有档位的数值**（整张重置 = 把用户调过的权重全抹掉）；
//   ③ 请求体跟着档位数变（不然界面上多一个框、榜单纹丝不动）；
//   ④ 上下限（12 / 1）真的封住了。
console.log('\n▶ ⑥ 加一版 / 删一版（2026-10-17）');
const addBtn = REGISTRY.get('adviceVersionWeightAdd');
const rmBtn = REGISTRY.get('adviceVersionWeightRemove');
check('两个按钮都挂了处理器（缺了 = 界面没画或 id 改了）', Boolean(addBtn && rmBtn));

STORE = new Map();
SENT.length = 0;
state.versionWeights = [1, 0, 0, 0, 0, 0];
V.renderVersionWeightRow();
addBtn.dispatch('click');
await new Promise((r) => setTimeout(r, 80));
const afterAdd = findInputs(REGISTRY.get('adviceVersionWeightRow'));
check('点「加一版」→ 7 个输入框', afterAdd.length === 7, String(afterAdd.length));
check('已有档位的数值没被抹掉', afterAdd.map((i) => i.value).join(',') === '1,0,0,0,0,0,0.5',
  afterAdd.map((i) => i.value).join(','));
check('新档默认 0.5（沿用最后一档，不归零）', afterAdd[6]?.value === '0.5', afterAdd[6]?.value);
check('state 与 localStorage 都是 7 档',
  state.versionWeights.length === 7
    && JSON.parse(STORE.get('hsr.advice.versionWeights') || '[]').length === 7,
  `${state.versionWeights.length} / ${STORE.get('hsr.advice.versionWeights')}`);
check('版数标签跟到「7 版」', REGISTRY.get('adviceVersionWeightCount').textContent === '7 版',
  REGISTRY.get('adviceVersionWeightCount').textContent);
const addReq = SENT.find((s) => s.url.includes('/api/archive/conclusion'));
check('加档后立刻重算，请求体是 7 档',
  JSON.stringify(addReq?.body?.versionWeights) === JSON.stringify([1, 0, 0, 0, 0, 0, 0.5]),
  JSON.stringify(addReq?.body?.versionWeights));

rmBtn.dispatch('click');
await new Promise((r) => setTimeout(r, 80));
check('点「删一版」→ 回到 6 档',
  findInputs(REGISTRY.get('adviceVersionWeightRow')).length === 6,
  String(findInputs(REGISTRY.get('adviceVersionWeightRow')).length));

// 上限 12：按钮靠 `disabled` 封住，处理器里另有一道 return（直接改 state 也突不破）。
for (let i = 0; i < 10; i += 1) addBtn.dispatch('click');
await new Promise((r) => setTimeout(r, 150));
check('最多 12 档（多点的几次被吃掉）', state.versionWeights.length === 12,
  String(state.versionWeights.length));
check('到上限后「加一版」是 disabled', addBtn.disabled === true, String(addBtn.disabled));
check('12 档时「删一版」仍可点', rmBtn.disabled === false, String(rmBtn.disabled));

state.versionWeights = [2];
V.renderVersionWeightRow();
rmBtn.dispatch('click');
await new Promise((r) => setTimeout(r, 80));
check('至少留 1 档（删到只剩一版就不动了）', state.versionWeights.length === 1,
  JSON.stringify(state.versionWeights));
check('到下限后「删一版」是 disabled', rmBtn.disabled === true, String(rmBtn.disabled));

console.log(`\n${bad === 0 ? '全部通过' : `${bad} 条不通过`}`);
process.exit(bad === 0 ? 0 : 1);
