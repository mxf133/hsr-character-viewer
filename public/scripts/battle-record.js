// 抽卡推荐页第一节：米游社官方的战斗记录。
//
// 数据来自 `/api/accounts/:id/roles/:uid/records`（服务端抓的是官方那几个端点，
// 见 src/server/records.js）。这一节只负责把服务端归一化好的结构摆出来：
//
//   四个副本各一个**按钮**（切换显示，不是四块堆在一起）
//   选中副本的汇总（本赛程 / 星数 / 层数 / 次数 / 上期）
//   **只显示最后一关**：这一关每一间的四人队伍（带头像与星魂）、敌方、通关时刻、祝福
//   模拟宇宙与公开主页卡片（来自既有的角色快照）
//
// 为什么不把每一层都列出来：混沌回忆有 12 层、异相仲裁有 3 个赛程 × 5 关，
// 全铺开是几十屏，而真正决定「我这套行不行」的只有最后一关。
//
// 角色 chip 可点：**在这一页直接弹出它的面板**（属性 / 立绘 / 光锥 / 遗器 / 技能），
// 浮层本身在 character-modal.js 里，与「角色信息」页共用同一份实现。
import { openCharacterPanel, wireCharacterPanel } from './character-modal.js';

const $ = (id) => document.getElementById(id);

const MODE_LABEL = { moc: '混沌回忆', pf: '虚构叙事', as: '末日幻影', aa: '异相仲裁' };

/** 按钮顺序 = 游戏里的副本顺序。 */
const MODE_ORDER = ['moc', 'pf', 'as', 'aa'];

/** 当前选中的副本（四个按钮切换）+ 渲染时带进来的回调。 */
const state = {
  mode: 'moc',
  onOpenCharacter: null,
  onResolveCharacter: null,
  /** 按成员取立绘（由打开这一节的那一方注入，见 advice-view.js）。 */
  artOf: null,
  records: null,
  snapshot: null,
  freshness: null,
};

/* ----------------------------------------------------------- 角色面板浮层 */
// 浮层的实现在 character-modal.js（两页共用），这里只保留旧名字的转发，
// 免得这一页里几十处 `openPanel(member)` 调用点全部要改。

const openPanel = (member) => {
  // 先把 member 解析成快照里的那个角色对象：**它自带的图**（`image` 全身立绘 /
  // `equip.icon` 光锥卡面）就是浮层要显示的两张图。
  //
  // ⚠️ 这里以前把 `state.snapshot`（**整份快照**）当 `snapshot` 传下去，于是
  // `characterPanel` 读 `snapshot.image` 永远是 undefined —— 浮层里两张图都不显示。
  // 传「这一个角色」的对象才对（app.js 的角色信息页走的是同一条路）；
  // 现在 character-modal.js 会自己拿解析出来的角色兜底，这里连传都不用传。
  openCharacterPanel(member, state.onResolveCharacter, {
    // 立绘：数据集按英文名给图，这里按角色名取（取不到就退回快照自带的图）
    art: state.artOf ? state.artOf(member) : null,
    catalog: state.snapshot?.avatars || {},
  });
};

const text = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = String(content);
  return node;
};

/** 通关时刻：只显示「月-日 时:分」，完整值放 title。 */
const timeText = (iso) => {
  if (!iso) return '—';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  return `${Number(m[2])}-${m[3]} ${m[4]}:${m[5]}`;
};

/** 成绩怎么写：轮次制 `2T`，末日幻影 `3753 分`。 */
const scoreText = (record, mode) => {
  if (mode === 'as') return record.score != null ? `${record.score} 分` : null;
  if (record.rounds != null) return `${record.rounds}T`;
  return null;
};

// ⚠️ 这里以前有一张 `ELEMENT_CLASS` 映射（fire → `is-fire` …），每张 chip 按角色属性给
// 边框上色，好「一眼看出队伍的元素构成」。**用户 2026-10-11 要求「战斗记录的角色的外框
// 颜色统一为白色」**，所以那张映射连同 app.css 里对应的七条 `.record-chip.is-*` 一起删了：
// 现在所有 chip 共用同一个白色边框（只有一处定义，见 app.css 的 `.record-chip`）。
// 属性信息**没丢** —— 它仍然写在 chip 的悬停提示里（下面 `chip.title` 的第一段之后）。
// 别再把这套属性配色搬回来。
/** 队伍：四张角色 chip（头像 + 名字 + E 星魂；属性只在悬停提示里）。 */
const teamRow = (members) => {
  const row = text('div', 'record-team');
  for (const member of members || []) {
    const chip = text('span', 'record-chip');
    // 头像：米游社自己的 CDN 图（记录里每个角色都带 icon）。加载失败就退回名字首字。
    if (member.icon) {
      const avatar = document.createElement('img');
      avatar.className = 'record-chip-avatar';
      avatar.loading = 'lazy';
      avatar.alt = '';
      avatar.src = member.icon;
      avatar.addEventListener('error', () => {
        avatar.replaceWith(text('span', 'record-chip-avatar is-fallback', (member.nameCn || '?').slice(0, 1)));
      });
      chip.appendChild(avatar);
    } else {
      chip.appendChild(text('span', 'record-chip-avatar is-fallback', (member.nameCn || '?').slice(0, 1)));
    }
    chip.appendChild(text('span', 'record-chip-name', member.nameCn));
    if (member.eidolon) chip.appendChild(text('span', 'record-chip-eidolon', `E${member.eidolon}`));
    if (member.level && member.level < 80) chip.appendChild(text('span', 'record-chip-level', `Lv${member.level}`));
    if (member.assist) chip.appendChild(text('span', 'record-chip-assist', '助战'));
    chip.title = [member.nameCn, member.elementCn, member.eidolon ? `E${member.eidolon}` : '', member.assist ? '助战角色' : '']
      .filter(Boolean).join(' · ');
    // 点一下在**本页**弹出这个角色的面板（不跳分页）
    if (state.onOpenCharacter) {
      chip.classList.add('is-clickable');
      chip.title += ' · 点击查看角色面板';
      chip.addEventListener('click', () => openPanel(member));
    }
    row.appendChild(chip);
  }
  // 注：这里曾经标过「这一队成本 N 金」，用户要求去掉：限定 / 常驻的划分会随版本
  // 更新变化（`unit-availability.json` 每次更新数据集都会重新生成），把绝对金数印在
  // 战绩旁边容易误导，而且战绩本身与成本无关。
  return row;
};

/**
 * 敌方：名字 +（有就带上）血量 +（官方来源带）图标。
 *
 * 两个来源：
 *   * **官方**（末日幻影 / 异相仲裁）：游戏内给的首领称号，**带图标**；
 *   * **黑塔网赛程表**（混沌回忆 / 虚构叙事）：米游社这两个副本压根不给敌方字段，
 *     只能按档期对上黑塔网登记的那一期。名字是玩家投稿时填的社区叫法——按用户
 *     要求不再挂标签，来源写在整节说明里；图标那个站点也没有可用的图床，
 *     所以这两个副本只有名字与血量。
 */
const enemyRow = (enemy) => {
  if (!enemy?.name) return null;
  const box = text('div', 'record-enemy');
  box.appendChild(text('span', 'record-enemy-label', '敌方'));
  if (enemy.icon) {
    const icon = document.createElement('img');
    icon.className = 'record-enemy-icon';
    icon.loading = 'lazy';
    icon.alt = '';
    icon.src = enemy.icon;
    box.appendChild(icon);
  }
  box.appendChild(text('span', 'record-enemy-name', enemy.name));
  if (enemy.hp) box.appendChild(text('span', 'record-enemy-hp', `HP ${enemy.hp}`));
  if (!enemy.official) {
    // 名字来自黑塔网投稿登记（米游社这两个副本不给敌方字段）。用户要求不挂标签，
    // 来源写在整节说明里；这里只在悬停时说明一句。
    box.title = '米游社不提供这个副本的敌方名，这里是黑塔网投稿里登记的首领名'
      + `${enemy.version ? `（${enemy.version} 那一期）` : ''}——玩家自己填的社区叫法，可能与游戏内称号不同。`;
  } else if (enemy.datasetName || enemy.hp) {
    box.title = `黑塔网登记：${[enemy.datasetName, enemy.hp ? `HP ${enemy.hp}` : ''].filter(Boolean).join(' · ')}`;
  }
  return box;
};

/**
 * 一间：`第N间 时刻 · 成绩 · 祝福` + 队伍 + 榜单对照。
 * `compare` 是 /api/archive/compare 里对应那一项（可能还没到，就不断言）。
 */
const nodeRow = (node, mode, compare, metricLabel) => {
  const row = text('div', 'record-node');
  const head = text('div', 'record-node-head');
  head.appendChild(text('span', 'record-node-index', `第 ${node.index} 间`));
  head.appendChild(text('span', 'muted small', timeText(node.time)));
  const score = scoreText(node, mode);
  if (score) head.appendChild(text('span', 'record-node-score', `${metricLabel} ${score}`));
  if (node.bossDefeated === false) head.appendChild(text('span', 'trend-down', '首领未击败'));
  if (node.buffName) {
    const buff = text('span', 'record-node-buff', `祝福「${node.buffName}」`);
    if (node.buffDesc) buff.title = node.buffDesc;
    head.appendChild(buff);
  }
  row.appendChild(head);
  // 祝福的详细效果单独一行写全（只放标题栏会被截断，也读不了）
  if (node.buffDesc) {
    row.appendChild(text('div', 'record-buff-desc muted small', `祝福「${node.buffName}」：${node.buffDesc}`));
  }
  const enemy = enemyRow(node.enemy);
  if (enemy) row.appendChild(enemy);
  row.appendChild(teamRow(node.members));
  return row;
};

/**
 * 最后一关：关卡名 + 星数 + 本关回合数 + 每一间的敌方与队伍。
 *
 * 这里不再用 `<details>` 折叠：界面上只有这一关（前面的层不展示），折叠没有意义。
 * 但会写明「共 N 层」，让人知道自己是站在哪一关上看的。
 */
const floorBlock = (floor, mode, totalFloors = 0) => {
  const box = text('div', 'record-floor is-last');
  const head = text('div', 'record-floor-head');
  if (totalFloors > 1) {
    head.appendChild(text('span', 'record-floor-scope', `最后一关 · 共 ${totalFloors} 层`));
  }
  head.appendChild(text('span', 'record-floor-name', floor.name || '（未命名）'));
  if (floor.stars != null) head.appendChild(text('span', 'record-floor-stars', `${floor.stars} ★`));
  if (floor.rounds != null) {
    head.appendChild(text('span', 'record-floor-rounds', `本关 ${floor.rounds}${mode === 'as' ? ' 分' : 'T'}`));
  }
  if (floor.extraStars) head.appendChild(text('span', 'muted small', `含额外星 ${floor.extraStars}`));
  // 关卡名里常常已经带了「星启模式」四个字（官方接口给的层名），别重复标一遍
  if (floor.tierce && !/星启/.test(floor.name || '')) {
    head.appendChild(text('span', 'record-tierce-badge', '星启模式'));
  }
  box.appendChild(head);

  const body = text('div', 'record-floor-body');
  const metricLabel = mode === 'as' ? '积分' : '回合';
  for (const node of floor.nodes || []) {
    body.appendChild(nodeRow(node, mode, null, metricLabel));
  }
  if (!(floor.nodes || []).length) {
    body.appendChild(text('p', 'muted small', '这一关没有记录到队伍。'));
  }
  box.appendChild(body);
  void open;
  return box;
};

/** 一个副本的明细：汇总行 + **只显示最后一关**那一关。 */
const modeBlock = (mode, data, summaryRow) => {
  const box = text('section', 'record-mode');
  const head = text('div', 'record-mode-head');
  head.appendChild(text('h4', 'record-mode-title', MODE_LABEL[mode] || mode));
  if (data.current?.name) head.appendChild(text('span', 'record-season', data.current.name));
  if (data.current?.version) head.appendChild(text('span', 'muted small', `v${data.current.version}`));
  if (data.stars != null) {
    head.appendChild(text('span', 'record-stars',
      summaryRow?.current?.totalStars != null
        ? `${data.stars} / ${summaryRow.current.totalStars} ★` : `${data.stars} ★`));
  }
  if (data.runs != null) head.appendChild(text('span', 'muted small', `${data.runs} 次战斗`));
  if (data.previous?.name) {
    head.appendChild(text('span', 'muted small',
      `上期 ${data.previous.name}${data.previous.runs != null ? ` · ${data.previous.runs} 次` : ''}`));
  }
  box.appendChild(head);

  // 换版本的第一道提示：本地数据集还没收录这一期（站点数据落后）时明说去哪儿更新，
  // 而不是静默地少一块信息。
  if (data.enemySeason?.behind) {
    box.appendChild(text('p', 'record-behind muted small',
      `这一期本地数据集还没收录：黑塔网最新一期是 ${(data.enemySeason.window || []).join(' → ')}。`
      + '点右上角「同步黑塔网数据」抓取这一期之后，这里就会补上敌方名单。'));
  }

  // 记录是按「难度从高到低」返回的（12 层在最前、第 1 层在最后），
  // 所以第一项就是最后一关。前面那些层不再往界面上放。
  const last = (data.floors || [])[0];
  if (!last) {
    box.appendChild(text('p', 'muted small', '还没有这个副本的记录。'));
    return box;
  }
  box.appendChild(floorBlock(last, mode, (data.floors || []).length));
  return box;
};

/**
 * 异相仲裁：只显示当前赛程的骑士关 + 王棋关（普通 / 绝境）。
 *
 * 两个额外处理：
 *   * 旧赛程不再铺开（3 个赛程 × 5 关是几十行）；
 *   * 但**绝境王棋关的记录常常在旧赛程里**（实测本机账号的绝境是 4.5 那期打的），
 *     所以如果当前赛程没有绝境记录，就把历史上最好的一次绝境单独补一行出来，
 *     并标明是哪一期——否则这一节会把「打过绝境」这件事整个漏掉。
 */
const peakBlock = (data) => {
  const box = text('section', 'record-mode');
  const groups = data.groups || [];
  const current = groups[0] || null;
  const head = text('div', 'record-mode-head');
  head.appendChild(text('h4', 'record-mode-title', '异相仲裁'));
  if (current?.group?.name) head.appendChild(text('span', 'record-season', current.group.name));
  if (current?.group?.version) head.appendChild(text('span', 'muted small', `v${current.group.version}`));
  if (current?.mobStars != null || current?.bossStars != null) {
    head.appendChild(text('span', 'record-stars',
      `骑士 ${current.mobStars ?? '—'}★ · 王棋 ${current.bossStars ?? '—'}★`));
  }
  if (data.best?.rankIconType) {
    const tier = String(data.best.rankIconType).replace('ChallengePeakRankIconType', '');
    head.appendChild(text('span', 'record-rank', `段位 ${tier}`));
  }
  if (data.best?.battles != null) head.appendChild(text('span', 'muted small', `累计战斗 ${data.best.battles} 次`));
  box.appendChild(head);

  if (!current) {
    box.appendChild(text('p', 'muted small', '还没有异相仲裁的记录。'));
    return box;
  }

  const body = text('div', 'record-floor-body');
  /** 一行：关卡名 + 首领 + 回合 + 队伍。 */
  const rowOf = (label, bossName, record, enemy, badge) => {
    const row = text('div', 'record-node');
    const nodeHead = text('div', 'record-node-head');
    nodeHead.appendChild(text('span', 'record-node-index', label));
    if (bossName) nodeHead.appendChild(text('span', 'record-node-boss', bossName));
    if (badge) nodeHead.appendChild(text('span', 'record-tierce-badge', badge));
    if (record) {
      nodeHead.appendChild(text('span', 'record-node-score', `${record.rounds ?? '—'}T`));
      nodeHead.appendChild(text('span', 'muted small', timeText(record.time)));
    }
    row.appendChild(nodeHead);
    // 异相仲裁的敌方就是这一关的首领本身，所以不再重复一行「敌方 某某」，
    // 只把官方给的图标插在关卡名旁边（与末日幻影那套视觉一致）。
    if (enemy?.icon) {
      const icon = document.createElement('img');
      icon.className = 'record-enemy-icon';
      icon.loading = 'lazy';
      icon.alt = '';
      icon.src = enemy.icon;
      nodeHead.insertBefore(icon, nodeHead.children[1] || null);
    }
    if (!record) {
      row.appendChild(text('p', 'muted small', '没有这一关的记录。'));
      return row;
    }
    row.appendChild(teamRow(record.members));
    return row;
  };

  for (const mob of current.mobs || []) {
    body.appendChild(rowOf(mob.name, mob.monster, mob.record, mob.enemy));
  }
  for (const boss of current.boses || []) {
    body.appendChild(rowOf(boss.hard ? '王棋关 · 绝境' : '王棋关', boss.name,
      boss.record, boss.enemy, boss.hard ? boss.hardName : null));
  }
  if (!(current.boses || []).some((b) => b.hard)) {
    // 当前赛程没打绝境：历史上有就打一行出来，标明是哪一期。
    const older = groups.slice(1)
      .map((g) => ({ g, hard: (g.boses || []).find((b) => b.hard && b.record) }))
      .find((x) => x.hard);
    if (older) {
      body.appendChild(rowOf(`王棋关 · 绝境（历史：${older.g.group?.name || '旧赛程'}）`,
        older.hard.name, older.hard.record, older.hard.enemy, older.hard.hardName));
    }
  }
  box.appendChild(body);
  return box;
};

/**
 * 四个副本按钮。按钮本身就带关键数字（星数），所以不再另铺一排汇总卡
 * ——那排卡占一整行，而内容与按钮重复。
 */
const modeFreshness = (mode, freshness) => {
  const keys = {
    moc: ['moc', 'challenge'],
    pf: ['pf', 'story'],
    as: ['as', 'boss'],
    aa: ['aa', 'peak'],
  }[mode] || [mode];
  return (freshness?.sections || []).find((section) => keys.includes(String(section.key))) || null;
};

const tabButton = (mode, row, freshness) => {
  const button = text('button', `record-tab${state.mode === mode ? ' is-active' : ''}`);
  button.type = 'button';
  button.dataset.mode = mode;
  button.appendChild(text('span', 'record-tab-name', MODE_LABEL[mode] || mode));
  const cur = row?.current || null;
  if (cur) {
    const bits = [];
    if (cur.stars != null) bits.push(`${cur.stars}★`);
    if (mode === 'aa') {
      if (cur.mobStars != null) bits.push(`骑士${cur.mobStars}★`);
      if (cur.bossStars != null) bits.push(`王棋${cur.bossStars}★`);
    } else if (cur.floors != null) {
      bits.push(`${cur.floors} 层`);
    }
    if (cur.clearedHard) bits.push('绝境');
    if (bits.length) button.appendChild(text('span', 'record-tab-stats', bits.join(' · ')));
  } else {
    button.appendChild(text('span', 'record-tab-stats', '无记录'));
  }
  // 按钮下面这行状态字**只在真出问题时才挂**（部分 / 失败 / 旧数据 / 未知）。
  //
  // ⚠️ 数据正常（`fresh`）时**一个字都不显示** —— 用户 2026-10-10 明确要求「把战斗
  // 记录的新鲜两字去掉」。理由与 v4.6.58 拿掉「分区：index·新鲜 …」那一行完全相同：
  // 数据是**整份一起抓**的，「新鲜」这个状态用户本来就用不上（想更新只有一个动作，
  // 就是点「刷新米游社战绩」），四个按钮下各挂一个绿字纯属噪音。
  // 但**异常状态必须留**：那时它是有用的信息（转成 `freshness-reason` 那类提示的反面，
  // 这里只是就近提示）。`unknown` 是「接口没声明该分区」，同样属于噪音，一并略过。
  //
  // 改动记录在案的坑：这里以前是 `status !== 'unknown'` 才画，于是四个按钮下各顶着
  // 一个「新鲜」；现在改成白名单式地**只画异常**，以后再加状态别把正常态又画回来。
  const section = modeFreshness(mode, freshness);
  if (section && section.status !== 'fresh' && section.status !== 'unknown') {
    const status = { partial: '部分', failed: '失败', stale: '旧数据' }[section.status] || '未知';
    button.appendChild(text('span', `record-tab-freshness is-${section.status}`, status));
  }
  if (cur?.name || section?.reason) {
    button.title = [
      cur?.name ? `${cur.name}${cur.version ? ` · v${cur.version}` : ''}` : '',
      section?.reason || '',
    ].filter(Boolean).join(' · ');
  }
  return button;
};

/** 模拟宇宙与公开主页卡片已按用户要求撤掉（与抽卡决策无关）。 */

/**
 * 渲染整节。
 *
 * @param {any} records  `/records` 返回的 `records`
 * @param {{ snapshot?:any, freshness?:any, onOpenCharacter?:Function, onResolveCharacter?:Function }} [extra]
 */
export const renderRecordSection = (root, records, extra = {}) => {
  if (!root) return;
  // 注意：容器（tabs/modes/extra）在 root **里面**，所以不能清 root 的
  // innerHTML —— 那会把容器本身删掉，之后 appendChild 加进去的节点全是游离的，
  // 页面上一片空白（踩过）。只清各自容器。
  const tabs = $('recordTabs');
  const modes = $('recordModes');
  if (tabs) tabs.innerHTML = '';
  if (modes) modes.innerHTML = '';

  state.records = records || null;
  state.snapshot = extra.snapshot || null;
  state.freshness = extra.freshness || null;
  state.onOpenCharacter = extra.onOpenCharacter || null;
  state.onResolveCharacter = extra.onResolveCharacter || null;
  state.artOf = extra.artOf || null;

  if (!records) {
    if (modes) {
      modes.appendChild(text('p', 'muted small',
        '还没有抓过战斗记录。点击「刷新米游社战绩」读取当前角色。'));
    }
    return;
  }

  // 四个副本按钮（按钮上直接带星数，不再另铺一排汇总卡）
  const byMode = new Map((records.summary || []).map((row) => [row.mode, row]));
  const available = MODE_ORDER.filter((mode) => records.modes?.[mode]);
  if (!available.includes(state.mode)) state.mode = available[0] || 'moc';
  for (const mode of available) {
    const button = tabButton(mode, byMode.get(mode), state.freshness);
    button.addEventListener('click', () => {
      if (state.mode === mode) return;
      state.mode = mode;
      // 只重画这一节：切按钮不该让整页重新请求。
      // ⚠️ 这里必须把 `artOf` 一起带回去：漏掉它之后 `state.artOf` 被清成 null，
      // 于是**切一次副本按钮，浮层里的立绘就没了**（同一份快照，第一次点有图、
      // 切过副本之后再点就没图）。
      renderRecordSection(root, state.records, {
        snapshot: state.snapshot,
        freshness: state.freshness,
        onOpenCharacter: state.onOpenCharacter,
        onResolveCharacter: state.onResolveCharacter,
        artOf: state.artOf,
      });
      $('recordTabs')?.querySelector(`.record-tab[data-mode="${mode}"]`)?.focus();
    });
    tabs?.appendChild(button);
  }

  // 只画选中的那一个副本，而且只画最后一关
  const row = byMode.get(state.mode);
  if (state.mode === 'aa') {
    if (records.modes.aa) modes?.appendChild(peakBlock(records.modes.aa));
  } else if (records.modes[state.mode]) {
    modes?.appendChild(modeBlock(state.mode, records.modes[state.mode], row));
  }
};

/**
 * 角色面板浮层的关闭接线（点背景 / ESC / 关闭按钮）。
 *
 * 现在这件事由 character-modal.js 自己在打开时接好（`wireOnce`）—— 两个分页都会
 * 生效。这个函数只保留给旧调用点，转发一下即可（重复调用是幂等的）。
 */
export const wireRecordPanel = () => {
  wireCharacterPanel();
};

// 榜单对照（`collectTeams` / `mapCompares` / `POST /api/archive/compare`）已经从这一节
// 撤掉了：用户说第一节不显示榜单信息。服务端那条链路还在（`src/server/compare.js`，
// 仍有测试覆盖），要放回第三节的配队视图随时能用。
