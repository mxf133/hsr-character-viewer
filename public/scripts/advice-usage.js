/**
 * 环境统计 · 上场率：**5 个副本全展开，每个副本一组四张环形图**（2026-10-18 重构 §5）。
 *
 * 需求文档原话：「统计不同关卡、不同版本的 通关 / 0T / 500-300 行动值 / 小于300 行动值
 * 的投稿所包含的角色数量，提供饼图展示前 10 角色 + 其它角色的百分比，要有合适的动态
 * 效果，创造性界面设计」；后续澄清「分关卡情况」= 5 个副本全展开。
 *
 * 设计要点：
 *   * **环形图而不是实心饼**：中间那个洞能放「样本量」，读者一眼知道这块饼有多可信
 *     （绝境 0 行动值只有 50 条投稿，与混沌 5259 条不是同一个量级 —— 这正是 v4.6.129 那条
 *     「0 行动值达成率折价」的由来）。
 *   * **`stroke-dasharray` 画弧**，不用 canvas / SVG path 计算：每一步只是一段
 *     `dash` + `offset` 的算术，DOM 里能直接读到数值，也方便做 CSS 过渡。
 *   * **动画用 CSS `stroke-dashoffset` 过渡**（不是 `<animate>`）：后者在部分浏览器里
 *     与 `prefers-reduced-motion` 不对付，而 CSS 媒体查询天然能关掉。
 *   * 颜色用固定的 12 色环（前 10 + 其它），**按名次分配**而不是按角色分配 ——
 *     同一个角色在不同副本里名次不同，颜色跟着名次走反而更好读（每张图内部一致）。
 */

/**
 * 建一个带类名的元素，文案走 `textContent`。
 *
 * ⚠️ 与 `advice-view.js` 里那个同名函数**故意各留一份**：那边是模块私有的 `const`
 * （没导出），这边也不想为了一个三行函数去改那边的导出面 —— 而且这一份**不做**
 * `**加粗**` 的富文本解析：上场率里所有文案都是纯数据（角色名 / 百分比），
 * 角色名里若真出现 `**` 也只该原样显示。
 */
const text = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = String(content);
  return node;
};

/** 12 色环：前 10 个角色 + 「其它」。刻意避开红绿相邻（色盲友好）。
 *
 * 2026-10-20（外观精修）：换掉原来那套。原来的 `#9b6b3f`（棕）/`#8b93a7`（石板灰）/
 * `#d4574e`（暗红）在深空底上明显发闷，而 `#00b8a9` 与 `#00a3c4` 两个青色挨得太近、
 * 小扇区几乎分不开。新的 11 色统一取「300~400 档」的明度（HSL 明度 60~70%），
 * 在 #12182b 上对比度都在 4.5:1 以上；色相仍按蓝 → 紫 → 绿 → 金 → 粉 → 青 → 橙 →
 * 靛 → 珊瑚 拉开，相邻两项至少差 40°。
 * ⚠️ 分配方式**没有变**：仍按名次（不是按角色）—— 见文件头那条设计说明。 */
const USAGE_COLORS = [
  '#6ea8fe', '#a78bfa', '#34d399', '#fbbf24', '#f472b6',
  '#22d3ee', '#fb923c', '#818cf8', '#f87171', '#94a3b8',
  // 「其它」用中性灰：它不是某个角色，不该抢眼。
  '#b6bdcc',
];

/** 环形图的几何参数（viewBox 100×100，半径 38 + 线宽 16 → 外径 92）。 */
const DONUT = { size: 100, radius: 38, width: 16 };

/** 把 `items`（含 share 0~1）切成 SVG 弧段。 */
const donutArcs = (items) => {
  const { radius } = DONUT;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return items.map((item, index) => {
    const share = Math.max(0, Number(item.share) || 0);
    const length = share * circumference;
    const arc = {
      index,
      item,
      // `dasharray` = 「这段弧长 + 剩下的一整圈」，`dashoffset` 把起点往后挪。
      dash: `${length} ${circumference}`,
      offset: -offset,
      color: item.other ? USAGE_COLORS[USAGE_COLORS.length - 1]
        : USAGE_COLORS[index % (USAGE_COLORS.length - 1)],
    };
    offset += length;
    return arc;
  });
};

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

/**
 * 画一张环形图（含中心样本量 + 图例）。
 *
 * @param {object} band `usageSummaryOf()` 的一项：`{key, label, submissions, entries, items}`
 */
const renderDonut = (band, envLabel) => {
  const card = document.createElement('div');
  card.className = 'usage-donut-card';

  const head = document.createElement('div');
  head.className = 'usage-donut-head';
  head.appendChild(text('span', 'usage-donut-title', band.label));
  // 「占通关 x%」：四档**不是四分互斥** —— 轮次型的通关被 0T/1T/2T 精确切分，
  // 行动值型的「0 行动值」嵌在「<300 行动值」内部（见 gacha-score.js 里
  // `shareOfClear` 那段）。并排的 Σ=100% 环形图极易被读成互斥的四类，这个角标
  // 把分母挑明；顺带提示「这两张饼几乎一样」（末日幻影的 <300 占通关 99.8%）。
  // 通关档自己是分母（服务端不设该字段），所以不印。
  if (band.shareOfClear != null) {
    const pct = band.shareOfClear * 100;
    const shown = pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
    head.appendChild(text('span', 'usage-donut-share', `占通关 ${shown}`));
  }
  // ⚠️ 2026-10-19：样本量**只在环心写一次**。原来右上也印「4844 条投稿」，与环心重复；
  // 而环心当时印的是 `items.length`（恒为 11 = 前 10 + 其它），那个数字没有任何信息量
  // —— 读者既不知道这 11 是什么，也看不出这块饼可不可信。现在环心给投稿数，右上留空。
  card.appendChild(head);

  const { size, radius, width } = DONUT;
  const mid = size / 2;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${size} ${size}`,
    class: 'usage-donut',
    role: 'img',
    'aria-label': `${envLabel} ${band.label}：${band.items.map((it) => `${it.charCn || it.char} ${(it.share * 100).toFixed(1)}%`).join('，')}`,
  });
  // 底环：没有数据时也要有个圈，否则整块会「缺一角」。
  svg.appendChild(svgEl('circle', {
    cx: mid, cy: mid, r: radius,
    fill: 'none', stroke: 'var(--line, #2a2f3a)', 'stroke-width': width,
  }));

  const arcs = donutArcs(band.items);
  for (const arc of arcs) {
    const circle = svgEl('circle', {
      cx: mid, cy: mid, r: radius,
      fill: 'none',
      stroke: arc.color,
      'stroke-width': width,
      'stroke-dasharray': arc.dash,
      'stroke-dashoffset': arc.offset,
      // 弧段之间留一条极细的缝，不然同色大扇区会糊成一片。
      'stroke-linecap': 'butt',
      class: 'usage-arc',
      'data-item': arc.index,
      transform: `rotate(-90 ${mid} ${mid})`,
    });
    // 入场动画：从「整圈空白」长到自己的弧长。`--arc-delay` 让 11 段依次展开。
    circle.style.setProperty('--arc-delay', `${arc.index * 45}ms`);
    svg.appendChild(circle);
  }

  // 环心：**投稿数**（不是角色数）。这是判断「这块饼有多可信」的唯一线索 ——
  // 末日幻影的「300~500 行动值」只有 5 条投稿、而「通关」有 2491 条，
  // 两者的百分比不该被同等看待。（这两个数是 v4.6.136 修完 n 透传后的**真实投稿数**；
  // 之前这里印的 4 条 / 4844 条是配装行数，还把混沌的数安到了末日头上。）
  const centerValue = svgEl('text', {
    x: mid, y: mid - 2, 'text-anchor': 'middle', class: 'usage-donut-total',
  });
  centerValue.textContent = String(band.submissions ?? 0);
  const centerHint = svgEl('text', {
    x: mid, y: mid + 11, 'text-anchor': 'middle', class: 'usage-donut-hint',
  });
  centerHint.textContent = '条投稿';
  svg.appendChild(centerValue);
  svg.appendChild(centerHint);
  card.appendChild(svg);

  // 图例：**百分比一律写出来**（需求文档要求），5% 以下按一位小数省空间。
  // 卡片宽度只够两列，长名字（「开拓者·记忆」6 字）必然被截成省略号 —— CSS 里给了
  // `text-overflow: ellipsis`，这里再补一个 `title`，鼠标停上去能看全名。
  const legend = text('ol', 'usage-legend');
  band.items.forEach((item, index) => {
    const li = text('li', `usage-legend-item${item.other ? ' is-other' : ''}`);
    const dot = text('span', 'usage-legend-dot');
    dot.style.background = item.other ? USAGE_COLORS[USAGE_COLORS.length - 1]
      : USAGE_COLORS[index % (USAGE_COLORS.length - 1)];
    li.appendChild(dot);
    const name = item.charCn || item.char;
    const nameEl = text('span', 'usage-legend-name', name);
    nameEl.title = `${name} · ${(item.share * 100).toFixed(1)}%`;
    li.appendChild(nameEl);
    li.appendChild(text('span', 'usage-legend-share', `${(item.share * 100).toFixed(1)}%`));
    legend.appendChild(li);
  });
  card.appendChild(legend);
  return card;
};

/**
 * 画整块「环境统计 · 上场率」：**5 个副本各一组**（用户选「5 个副本全展开」）。
 *
 * @param {Array} envs `/api/archive/usage` 返回的 `envs`
 */
export const renderUsage = (container, envs) => {
  if (!container) return;
  container.innerHTML = '';
  if (!Array.isArray(envs) || !envs.length) return;

  for (const env of envs) {
    const group = text('section', 'usage-group');
    const head = text('div', 'usage-group-head');
    head.appendChild(text('h4', 'usage-group-title', env.label || env.id));
    head.appendChild(text('span', 'muted small',
      `${env.kind === 'av' ? '行动值口径' : '轮次口径'} · ${env.season || '—'}`));
    group.appendChild(head);

    const grid = text('div', 'usage-donut-grid');
    for (const band of env.bands) grid.appendChild(renderDonut(band, env.label || env.id));
    group.appendChild(grid);
    container.appendChild(group);
  }
};
