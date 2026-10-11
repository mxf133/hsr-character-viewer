// 角色面板（属性 / 光锥 / 技能 / 遗器）。
//
// 这段渲染原来长在 app.js 里，只有「角色信息」页用。抽卡推荐页的战斗记录也要
// 「点角色看面板」，所以搬到独立模块：**两处共用同一份实现**，否则同一张卡在
// 两个分页长得不一样，早晚出对不上的数字。
//
// 数据全部来自角色快照（`/roles/:uid/snapshot`）：账号没开「展示角色详情」时
// 属性 / 遗器会是空的，这里如实写出来，不是渲染失败。
import {
  effectiveSubstatHits, elementName, lightConeOf, pathName, relicsOf, skillsOf, slotName,
  statValue, statsOf,
} from './format.js';

/** 一行「标签 / 值」。角色信息页与抽卡推荐页都用它，所以放在这里导出。 */
export const kv = (label, value) => {
  const row = document.createElement('div');
  row.className = 'kv';
  const a = document.createElement('span');
  a.textContent = label;
  const b = document.createElement('span');
  b.textContent = value;
  row.append(a, b);
  return row;
};

/**
 * 角色面板：立绘 + 属性 + 光锥 + 技能 + 遗器。
 *
 * `options.skills`（**默认 false**）控制技能等级那一块：15 行「普攻 Lv.6」属于噪音，
 * 两个入口都默认收起，需要时由浮层标题栏的「显示技能等级」按钮打开（见
 * character-modal.js）。这里保留参数而不是直接删掉，是因为「角色信息」页与
 * 抽卡推荐页共用同一个面板，开关必须由调用方一层决定。
 *
 * `options.art` 给立绘：`{ character, lightCone }`（数据集的 preview 地址）。
 * `options.snapshot` 给米游社那条快照（角色自己的 `image` 与光锥的 `icon`）——
 * 数据集缺图时（开拓者形态、三月七形态）用它兜底，比留空框强。
 */
export const characterPanel = (character, options = {}) => {
  const showSkills = options.skills === true;
  const wrap = document.createElement('div');
  wrap.className = 'char-detail';

  /**
   * 一张立绘（取不到就整块不渲染，不留空框）。
   *
   * `caption` 是图下面的说明（角色名 / 光锥名）：光锥卡面单独放一张图时，
   * 不写名字就看不出是哪一把（浮层里点的是角色，图里却有两张）。
   */
  const artBox = (label, url, cls, caption) => {
    if (!url) return null;
    const box = document.createElement('figure');
    box.className = `char-art ${cls}`;
    const img = document.createElement('img');
    img.src = url;
    img.loading = 'lazy';
    img.alt = label;
    // 图挂了（网络 / 缺图）就把这张收起来，不要让用户看到破图
    img.addEventListener('error', () => {
      const row = box.parentElement;
      box.remove();
      if (cls === 'is-character') row?.classList.add('is-text-only');
    }, { once: true });
    box.appendChild(img);
    if (caption) {
      const cap = document.createElement('figcaption');
      cap.textContent = caption;
      cap.title = label;
      box.appendChild(cap);
    }
    return box;
  };

  const art = options.art || {};
  const catalog = options.catalog || {};
  const propertyInfo = catalog.property_info || catalog.propertyInfo || {};
  const snapChar = options.snapshot || null;
  const cone = lightConeOf(character);
  // 数据集按英文名给图；快照是中文名且自带 image / equip.icon，所以两路都算一遍
  const charArt = art.character || snapChar?.image || snapChar?.icon || null;
  const coneArt = art.lightCone || snapChar?.equip?.icon || null;
  const artRow = document.createElement('div');
  artRow.className = 'char-art-row';
  const charFig = artBox(character?.name || '角色', charArt, 'is-character',
    character?.name || '角色立绘');
  const coneFig = artBox(cone?.name || '光锥', coneArt, 'is-cone',
    cone?.name ? `光锥 · ${cone.name}` : '当前光锥');
  if (charFig) artRow.appendChild(charFig);
  // 立绘右边的「一眼信息」：名字 + 稀有度 / 属性 / 命途 / 等级 / 星魂 + 光锥。
  //
  // 2026-10 排版重做（用户要求「图片与文本应该有更好的排版」）。改前是三个平级的
  // flex 子项、整行 `align-items: center`：全身立绘 350px 高，而名字 + 标签 + 光锥
  // 加起来只有 100px，于是文字被**垂直居中**到立绘腰上（实测 hero 的 top 比立绘低
  // 125px），光锥卡面也单独飘在中间 —— 一屏里三块内容各自为政。
  // 现在：立绘 | （文字列 + 光锥卡面）两栏 grid，顶部对齐；光锥卡面缩到文字右侧并紧邻描述，
  // 名字/标签/Lv/叠影贴着立绘上沿往下排。
  //
  // 名字与标签只在**拿到角色对象**时才排：快照没给图（开拓者早期形态等）时，
  // 至少还有名字、星级、属性、光锥这两行可看，不该整块消失。
  if (character) {
    const hero = document.createElement('div');
    hero.className = 'char-hero';
    const heroText = document.createElement('div');
    heroText.className = 'char-hero-text';
    const name = document.createElement('div');
    name.className = 'char-hero-name';
    name.textContent = character?.name || '角色';
    heroText.appendChild(name);
    const tags = [];
    if (character?.rarity) tags.push(`${character.rarity}★`);
    if (character?.element) tags.push(elementName(character.element));
    // 命途只在**拿到名字**时显示：快照里给的是数字 id（`base_type`），
    // `pathName(1)` 会原样返回「1」，挂在标签里就是一枚没意义的「1」（实测踩过）。
    const path = character?.path ? pathName(character.path) : '';
    if (path && path !== '未知' && !/^\d+$/.test(String(path))) tags.push(path);
    if (character?.level) tags.push(`Lv.${character.level}`);
    const rank = Number(character?.rank ?? character?.actived_constellation_num ?? 0);
    tags.push(rank > 0 ? `星魂 E${rank}` : '未解锁星魂');
    const tagRow = document.createElement('div');
    tagRow.className = 'char-hero-tags';
    for (const tag of tags) {
      const span = document.createElement('span');
      span.className = 'tag-cyan';
      span.textContent = tag;
      tagRow.appendChild(span);
    }
    heroText.appendChild(tagRow);
    if (cone) {
      const coneLine = document.createElement('div');
      coneLine.className = 'char-hero-cone';
      coneLine.textContent = `光锥 · ${cone.name}`
        + (cone.rank ? `（叠影 ${cone.rank}）` : '')
        + (cone.level ? ` · Lv.${cone.level}` : '');
      heroText.appendChild(coneLine);
    }
    hero.appendChild(heroText);
    // 光锥卡面挂在文字右侧并靠近描述；没有图（或上面那张已经挂掉被移除）时这一格自动塌掉
    if (coneFig) hero.appendChild(coneFig);
    // 没有立绘时这一行只剩 hero，让它独占整行（否则 grid 的 auto 列会把文字挤窄）
    if (!charFig) artRow.classList.add('is-text-only');
    artRow.appendChild(hero);
  }
  if (artRow.childElementCount) wrap.appendChild(artRow);

  // stats
  const stats = statsOf(character, propertyInfo);
  const rows = stats;
  const statsBlock = document.createElement('div');
  statsBlock.className = 'detail-block stats-block';
  const statsTitle = document.createElement('h4');
  statsTitle.textContent = '属性';
  statsBlock.appendChild(statsTitle);
  const renderStat = (row) => {
    const item = document.createElement('div');
    const addNumber = Number.parseFloat(String(row.add ?? '').replace('%', ''));
    const showBreakdown = ['1', '2', '3', '4'].includes(String(row.propertyType))
      && Number.isFinite(addNumber) && addNumber !== 0;
    item.className = `stat-row${showBreakdown ? ' has-breakdown' : ''}`;
    const label = document.createElement('span');
    label.className = 'stat-label';
    if (row.icon) {
      const icon = document.createElement('img');
      icon.src = row.icon;
      icon.alt = '';
      icon.loading = 'lazy';
      label.appendChild(icon);
    }
    const text = document.createElement('span');
    text.textContent = row.label || row.key;
    label.appendChild(text);
    item.appendChild(label);
    const values = document.createElement('span');
    values.className = 'stat-values';
    if (showBreakdown && row.base !== null && row.base !== '' && row.add !== null && row.add !== '') {
      const base = document.createElement('span');
      base.textContent = statValue(row.propertyType || row.key, row.base);
      const plus = document.createElement('span');
      plus.className = 'stat-add';
      plus.textContent = `+${statValue(row.propertyType || row.key, row.add)}`;
      const final = document.createElement('strong');
      final.textContent = statValue(row.propertyType || row.key, row.value);
      values.append(base, plus, final);
    } else {
      values.textContent = statValue(row.propertyType || row.key, row.value);
    }
    item.appendChild(values);
    return item;
  };
  const statGrid = (rowsToRender) => {
    const grid = document.createElement('div');
    grid.className = 'stat-grid';
    const split = Math.ceil(rowsToRender.length / 2);
    for (const column of [rowsToRender.slice(0, split), rowsToRender.slice(split)]) {
      const section = document.createElement('div');
      section.className = 'stat-column';
      for (const row of column) section.appendChild(renderStat(row));
      grid.appendChild(section);
    }
    return grid;
  };
  if (rows.length) {
    statsBlock.appendChild(statGrid(rows));
  } else {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = '该角色未公开详细属性（需在游戏内开启「展示角色详情」）。';
    statsBlock.appendChild(note);
  }
  wrap.appendChild(statsBlock);

  const servant = character?.servant_detail || character?.servant || character?.memory_spirit || null;
  const servantStats = statsOf(servant, propertyInfo, servant?.servant_properties || servant?.properties);
  if (servant?.servant_name && servantStats.length) {
    const servantBlock = document.createElement('div');
    servantBlock.className = 'detail-block servant-block';
    const servantTitle = document.createElement('h4');
    servantTitle.textContent = `忆灵 · ${servant.servant_name}`;
    if (servant.servant_icon) {
      const icon = document.createElement('img');
      icon.className = 'servant-icon';
      icon.src = servant.servant_icon;
      icon.alt = '';
      icon.loading = 'lazy';
      servantTitle.prepend(icon);
    }
    servantBlock.append(servantTitle, statGrid(servantStats));
    wrap.appendChild(servantBlock);
  }

  // light cone + skills
  const sideBlock = document.createElement('div');
  sideBlock.className = 'detail-block';
  const coneTitle = document.createElement('h4');
  coneTitle.textContent = '光锥';
  sideBlock.appendChild(coneTitle);
  if (cone) {
    sideBlock.appendChild(kv('名称', cone.name));
    sideBlock.appendChild(kv('稀有度', cone.rarity ? `${cone.rarity}★` : '—'));
    sideBlock.appendChild(kv('等级', cone.level !== null && cone.level !== undefined ? `Lv.${cone.level}` : '—'));
    sideBlock.appendChild(kv('叠影', cone.rank !== null && cone.rank !== undefined ? `叠影 ${cone.rank}` : '—'));
    if (cone.mainName) {
      sideBlock.appendChild(kv(cone.mainName, String(cone.mainValue ?? '—')));
    }
    if (cone.subName) {
      sideBlock.appendChild(kv(cone.subName, String(cone.subValue ?? '—')));
    }
  } else {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = '未公开光锥信息。';
    sideBlock.appendChild(note);
  }

  const skills = showSkills ? skillsOf(character) : [];
  if (skills.length) {
    const skillTitle = document.createElement('h4');
    skillTitle.textContent = '技能';
    skillTitle.style.marginTop = '14px';
    sideBlock.appendChild(skillTitle);
    for (const skill of skills) {
      sideBlock.appendChild(kv(skill.name, skill.level !== null && skill.level !== undefined ? `Lv.${skill.level}` : '—'));
    }
  }
  wrap.appendChild(sideBlock);

  // relics / artifacts
  const relicBlock = document.createElement('div');
  relicBlock.className = 'detail-block';
  const relicTitle = document.createElement('h4');
  relicBlock.appendChild(relicTitle);
  const relics = relicsOf(character, propertyInfo);
  const recommendation = catalog.recommend_property?.[String(character?.id)]
    || catalog.recommendProperty?.[String(character?.id)] || null;
  const effective = effectiveSubstatHits(character, recommendation, propertyInfo);
  relicTitle.textContent = `遗器${relics.length ? ` · ${relics.length}` : ''}`;
  if (effective.total) {
    const summary = document.createElement('div');
    summary.className = 'effective-summary';
    const heading = document.createElement('strong');
    heading.textContent = '有效副属性命中统计';
    const note = document.createElement('span');
    note.className = 'effective-note';
    note.textContent = recommendation?.is_custom_property_valid
      ? '有效副属性按自定义推荐属性计算'
      : '有效副属性按游戏内推荐副属性计算';
    const total = document.createElement('span');
    total.className = 'effective-total';
    total.textContent = `${effective.total} 次命中`;
    summary.append(heading, note, total);
    const hits = document.createElement('div');
    hits.className = 'effective-hits';
    for (const row of effective.rows) {
      const chip = document.createElement('span');
      chip.className = 'effective-hit';
      if (row.icon) {
        const icon = document.createElement('img');
        icon.src = row.icon;
        icon.alt = '';
        icon.loading = 'lazy';
        chip.appendChild(icon);
      }
      chip.append(`${row.name} ${row.count}`);
      hits.appendChild(chip);
    }
    summary.appendChild(hits);
    relicBlock.appendChild(summary);
  }
  if (relics.length) {
    const list = document.createElement('div');
    list.className = 'relic-list';
    for (const relic of relics) {
      const item = document.createElement('div');
      item.className = 'relic';
      if (relic.icon) {
        const icon = document.createElement('img');
        icon.className = 'relic-icon';
        icon.src = relic.icon;
        icon.alt = '';
        icon.loading = 'lazy';
        icon.addEventListener('error', () => icon.remove(), { once: true });
        item.appendChild(icon);
      }
      const content = document.createElement('div');
      content.className = 'relic-content';
      const head = document.createElement('div');
      head.className = 'relic-head';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'relic-name';
      nameSpan.textContent = relic.name;
      const slotSpan = document.createElement('span');
      slotSpan.className = 'relic-slot';
      // Genshin sends the official slot name (`pos_name`); fall back to the table.
      slotSpan.textContent = relic.slotName || slotName(relic.slot);
      head.append(nameSpan, slotSpan);
      content.appendChild(head);
      if (relic.level !== null && relic.level !== undefined) {
        const lvl = document.createElement('div');
        lvl.className = 'relic-slot';
        lvl.textContent = `+${relic.level}`;
        content.appendChild(lvl);
      }
      if (relic.mainName) {
        const main = document.createElement('div');
        main.className = 'relic-main';
        if (relic.mainIcon) {
          const mainIcon = document.createElement('img');
          mainIcon.src = relic.mainIcon;
          mainIcon.alt = '';
          mainIcon.loading = 'lazy';
          main.appendChild(mainIcon);
        }
        main.append(`${relic.mainName}${relic.mainValue !== null && relic.mainValue !== undefined ? ` +${relic.mainValue}` : ''}`);
        content.appendChild(main);
      }
      if (relic.subs.length) {
        const subs = document.createElement('div');
        subs.className = 'relic-subs';
        for (const sub of relic.subs) {
          const span = document.createElement('span');
          span.textContent = `${sub.name} +${sub.value}${sub.times ? ` ·${sub.times}` : ''}`;
          subs.appendChild(span);
        }
        content.appendChild(subs);
      }
      item.appendChild(content);
      list.appendChild(item);
    }
    relicBlock.appendChild(list);
  } else {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = '未公开遗器信息。';
    relicBlock.appendChild(note);
  }
  wrap.appendChild(relicBlock);

  return wrap;
};
