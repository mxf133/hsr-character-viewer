// 探针：不开浏览器，验证「角色面板里的命途 / 属性图标」真的被画出来了。
//
// 为什么需要它：图标是**纯前端**的事，而本仓库的自动化测试只有 Node（没有 DOM）。
// `check-advice-layout.mjs` 走 CDP，需要一台开着 9222 的调试浏览器 —— CI / 无人值守时
// 整套跳过，「图标画没画」就等于没人验。这个探针用**最小 DOM 桩**跑真实的
// `characterPanel()`，直接数渲染结果里有没有那两张 `<img>`。
//
// 用法：node tools/_probe-character-panel-icons.mjs
//
// ⚠️ 桩只实现 `character-panel.js` 真正用到的那几个 API（createElement / createTextNode /
//    append / appendChild / prepend / remove / classList / dataset / textContent）。
//    它**不是** jsdom，也不该长成 jsdom —— 面板一用新 API，这里就抛错，正好提醒补桩。
import { characterPanel } from '../public/scripts/character-panel.js';

const node = (tagName) => {
  const el = {
    tagName,
    className: '',
    children: [],
    dataset: {},
    style: { setProperty() {} },
    parentElement: null,
    hidden: false,
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild(child) {
      child.parentElement = el;
      el.children.push(child);
      return child;
    },
    append(...kids) {
      for (const kid of kids) el.appendChild(kid);
    },
    prepend(child) {
      child.parentElement = el;
      el.children.unshift(child);
    },
    remove() {
      const parent = el.parentElement;
      if (!parent) return;
      parent.children = parent.children.filter((c) => c !== el);
      el.parentElement = null;
    },
    addEventListener() {},
    /** `character-panel.js` 用 `if (artRow.childElementCount)` 判断「这一行有没有内容」。 */
    get childElementCount() {
      return el.children.filter((c) => c.tagName).length;
    },
    set textContent(value) {
      el.children = [{ textContent: String(value) }];
    },
    get textContent() {
      return el.children.map((c) => c.textContent ?? '').join('');
    },
  };
  return el;
};

globalThis.document = {
  createElement: node,
  createTextNode: (text) => ({ textContent: String(text) }),
};

/** 深度优先收集整棵树（含文字节点）。 */
const walk = (root, out = []) => {
  out.push(root);
  for (const child of root.children || []) walk(child, out);
  return out;
};

const character = {
  id: 1205,
  name: '刃',
  // 快照风格：属性是米游社的英文键，命途是数据集键（真实账号由 `withCharacterMeta` 补齐，
  // 这里直接给齐，测的是**渲染**这一段）。
  element: 'Wind',
  path: 'Warrior',
  rarity: 5,
  level: 80,
  rank: 2,
  actived_constellation_num: 2,
  equip: { name: '到不了的彼岸', rarity: 5, rank: 1, level: 80 },
  properties: [],
};

const panel = characterPanel(character, { catalog: {} });
const all = walk(panel);
const imgs = all.filter((n) => n.tagName === 'img' && n.src).map((n) => n.src);
const tagText = all
  .filter((n) => String(n.className || '').includes('tag-cyan'))
  .map((n) => n.textContent.trim());

const checks = [
  ['命途图标（毁灭 = icon/path/Destruction.png）',
    imgs.some((s) => s.includes('/icons/icon/path/Destruction.png'))],
  ['属性图标（风 = icon/element/Wind.png）',
    imgs.some((s) => s.includes('/icons/icon/element/Wind.png'))],
  ['图标带 CDN 兜底参数（本地没镜像时 302 出去）',
    imgs.every((s) => s.includes('/icons/') ? s.includes('?fallback=') : true)],
  ['标签里同时有命途名与属性名', tagText.some((t) => t.includes('毁灭')) && tagText.some((t) => t.includes('风'))],
  ['图标排在文字之前（图标 + 文字，不是只有图标）',
    all.some((n) => n.tagName === 'img' && n.parentElement?.className?.includes('tag-cyan'))],
];

let failed = 0;
console.log('节点：', all.map((n) => `${n.tagName}.${n.className || ''}`).join(' , '));
console.log(`渲染出 ${all.length} 个节点、${imgs.length} 张图、${tagText.length} 个标签`);
console.log('标签：', tagText.join(' | '));
for (const [name, ok] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failed += 1;
}
process.exitCode = failed ? 1 : 0;
