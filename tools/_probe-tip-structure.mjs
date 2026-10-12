// 探针：**详情窗口的 DOM 结构**（不需要浏览器）—— 队伍图标到底长在哪、旧块有没有残留。
//
// 为什么需要它：`check-advice-layout.mjs` 要在 **9222 上的调试浏览器**里量真实载荷，
// 本机没开那个浏览器时整套判据会被跳过（`run-tests.mjs` 的行为），于是「结构改错了」
// 只能等到用户点开窗口才发现。这个探针用最小 DOM shim 把 `frontierTip()` 直接跑一遍、
// **手动走树**核对结构，代价是几毫秒。
//
// 它盯的是用户 2026-10-11 第 5 条（「角色的图标都放进表格内」）那三条结构事实：
//   ① 表上方**没有**任何旧块残留（`.advice-team-caption` / `.advice-team-env` 都是 0 个）；
//   ② **每一个表体行的第一格**里都有 `.tip-label-cell` → `.advice-plan-team-slot`，
//      且槽上挂着 `__members`（这一关卡的最佳证据队伍）；
//   ③ 全窗口的槽数 == 表体行数 == `.tip-label-cell` 数（一个关卡一格一槽，不多不少）；
//   ④ 关卡名是**中文**（`meta.label → env.envLabel → env.id` 三级兜底；
//      只读 meta 时这里会印出 `aa/plight` —— v4.6.76 那个缺陷的同一类）。
//
// ⚠️ **它不验排版**（宽度 / 折行 / 行高 / 有没有横向滚动都要真浏览器），
// 也**不替代 CDP 判据**：那条判据是在真实 `/conclusion` 载荷上量的 —— 本仓库踩过
// 「拿未瘦身的 `buildConclusion()` 输出当载荷验，界面判据全绿而真机是坏的」这个坑
// （见 HANDOFF §4.2z 末尾）。这里的夹具是**手写的形状**，只用来验建树逻辑。
//
// 用法：`node tools/_probe-tip-structure.mjs`（退出码非 0 = 结构不对）
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- 最小 DOM shim ------------------------------------------------------------
// 只实现 `frontierTip()` 建树用到的那几个成员：createElement / appendChild /
// className / classList / dataset / textContent / Node（`tipTable` 靠 `instanceof Node`
// 决定「这一格是节点还是字符串」）。
class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.style = {};
    const self = this;
    this.classList = {
      add: (...names) => { self.className = [self.className, ...names].filter(Boolean).join(' '); },
      contains: (n) => self.className.split(/\s+/).includes(n),
    };
  }

  appendChild(child) { this.children.push(child); return child; }
  setAttribute() {}
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }

  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    return this._text !== undefined && !this.children.length
      ? this._text
      : this.children.map((c) => c.textContent ?? '').join('');
  }
}

globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  // advice-view.js 在模块顶层就把 el 映射建好了（`const el = { mode: $(...) }`），
  // 所以 getElementById 必须存在 —— 返回空元素即可，本探针只测建树那一半。
  getElementById: () => new FakeElement('div'),
  addEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
  documentElement: new FakeElement('html'),
  body: new FakeElement('body'),
};
globalThis.window = { addEventListener: () => {}, location: { href: 'http://localhost/' } };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.fetch = async () => { throw new Error('探针不发请求（建树不该联网）'); };

// `frontierTip()` 是模块内部的，没有导出 —— 复制一份、在结尾补一个导出再 import
// （临时文件放在 advice-view.js 旁边，它自己的相对 import 才解析得到）。
const SRC = join(ROOT, 'public/scripts/advice-view.js');
const TMP = join(ROOT, 'public/scripts/_tmp-view-export.mjs');
writeFileSync(TMP, `${readFileSync(SRC, 'utf8')}\nexport { frontierTip };\n`, 'utf8');
const { frontierTip } = await import(`file://${TMP.replace(/\\/g, '/')}`);

// 形状照抄真机那个头条条目（5 个关卡 × 4 人）。`envLabel` 用**数据里的原样**：
// 「异相仲裁」下的两个关卡带副本名前缀（`·` 分隔），其余三个副本没有前缀 ——
// 两条分支（有 `·` / 没有 `·`）都要走到。
const LABELS = {
  'aa/plight': '异相仲裁 · 绝境王棋关', as: '末日幻影', pf: '虚构叙事',
  moc: '混沌回忆', aa: '异相仲裁 · 王棋和骑士关',
};
const member = (char, eidolon, lc, superimp) => ({ char, eidolon, lc, superimp });
const unit = {
  key: 'probe', name: '砂金·戏浪', eidolon: 6, lc: 'Summer Rides the Surf', superimp: 1,
  gold: 11, total: 992,
  envs: ['aa/plight', 'as', 'pf', 'moc', 'aa'].map((id, i) => ({
    id,
    // ⚠️ 中文 `envLabel`：三级兜底里 `frontierEnvMeta()` 在本探针里查不到东西
    //    （顶层 `frontierEnvs` 没喂），所以这里量的正是第二级兜底。
    envLabel: LABELS[id],
    evidenceSeason: `${(4.5 - i * 0.1).toFixed(1)}`,
    tier: i ? 'target' : 'perfect',
    actionValue: [285, 3890, 0, 0, 0][i],
    bestTeamGold: [11, 9, 10, 8, 8][i],
    seasonMinCost: [10, 4, 3, 1, 1][i],
    seasonCount: 7,
    value: 905 - i * 200, score: 900 - i * 200, weight: i ? 1 : 10,
    members: [
      member('砂金·戏浪', 6, 'Summer Rides the Surf', 1),
      member('不死途', 0, null, 1),
      member('三月七（巡猎）', 6, null, 5),
      member('藿藿', 0, null, 5),
    ],
  })),
};

// ---- 走树 ---------------------------------------------------------------------
const tip = frontierTip(unit);
const find = (node, cls, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (String(node.className || '').split(/\s+/).includes(cls)) out.push(node);
  for (const c of node.children || []) find(c, cls, out);
  return out;
};

let bad = 0;
const captions = find(tip, 'advice-team-caption');
const envLines = find(tip, 'advice-team-env');
console.log(`① 表上方的旧块残留：标题 ${captions.length} 个、说明行 ${envLines.length} 个`
  + `${captions.length || envLines.length ? '  ← ✗ 应当都是 0（图标搬进表格后旧块必须删干净）' : ' ✓'}`);
if (captions.length || envLines.length) bad += 1;

const table = find(tip, 'advice-value-tip-table')[0];
const tbody = (table?.children || []).find((c) => c.tagName === 'TBODY');
const bodyRows = (tbody?.children || []).filter((tr) => !String(tr.className).includes('is-total'));
const cjk = /[\u3400-\u9fff]/;
let ok = 0;
console.log(`② 表体 ${bodyRows.length} 行（每行第一格：label-cell + 槽 + 4 名队友 + 中文关卡名）：`);
bodyRows.forEach((tr, i) => {
  const cell = tr.children[0];
  const label = find(cell, 'tip-label-cell')[0];
  const slot = find(cell, 'advice-plan-team-slot')[0];
  const title = find(cell, 'tip-label-title')[0];
  const stage = find(cell, 'tip-label-stage')[0]?.textContent || '';
  const season = find(cell, 'tip-label-season')[0]?.textContent || '';
  // 用户 2026-10-11 第 6 条「关卡、权重、表现等文字需要等高」：副本名与关卡名必须在
  // **同一个** `.tip-label-title` 里（否则又会分两行，第一列的标题行就比别人高一截）。
  const good = Boolean(label && slot && title && slot.__members?.length === 4 && cjk.test(stage));
  if (good) ok += 1;
  console.log(`   ${good ? '✓' : '✗'} 第 ${i + 1} 行：label-cell=${Boolean(label)}`
    + ` 一行标题=${Boolean(title)} 槽=${Boolean(slot)} 队友=${slot?.__members?.length ?? 0}`
    + `｜标题 ${JSON.stringify(title?.textContent ?? '')}｜版本 ${JSON.stringify(season)}`);
});
if (bodyRows.length === 0) { console.log('   ✗ 表体一行都没有'); bad += 1; }
if (ok !== bodyRows.length) bad += 1;

const allSlots = find(tip, 'advice-plan-team-slot');
const allCells = find(tip, 'tip-label-cell');
const countsOk = allSlots.length === bodyRows.length && allCells.length === bodyRows.length;
console.log(`③ 一个关卡一格一槽：槽 ${allSlots.length} 个 / label-cell ${allCells.length} 个`
  + ` / 表体 ${bodyRows.length} 行${countsOk ? ' ✓' : '  ← ✗ 三者应当相等'}`);
if (!countsOk) bad += 1;

unlinkSync(TMP);
if (bad) {
  console.log(`\n❌ 结构不对（${bad} 条）`);
  process.exit(1);
}
console.log('\n✅ 结构正确：队伍图标在表格第一格里，表上方没有旧块残留');
console.log('   ⚠️ 排版（折行 / 行高 / 横向滚动）仍需真浏览器：'
  + '`node tools/run-tests.mjs` 会在 9222 上量一次。');
