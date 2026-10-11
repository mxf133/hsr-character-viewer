// 角色面板浮层（点角色头像 / 角色卡弹出的那个框）。
//
// 为什么单独一个模块：**两个分页都用它** —— 抽卡推荐页的战斗记录（点队伍里的
// 角色 chip）和「角色信息」页（点角色卡）。原来这段长在 battle-record.js 里，
// 只能靠 `state.onResolveCharacter` 回调给「角色信息」页用；现在把浮层抽出来，
// 两处共用同一份实现，和 character-panel.js 同一条理由：同一张卡在两个分页
// 长得不一样的话，早晚出对不上的数字。
//
// 用户 2026-10 的要求：「角色信息界面，点击角色能看到和点击战斗记录-角色头像
// 弹出的界面**相同的界面**」。所以两个入口的差别只剩「谁去解析出那个角色对象」，
// 面板本身（标题、副标题、立绘排版、属性/光锥/遗器、技能开关）由这里统一决定：
//
//   * 关闭 / 点背景 / ESC 的接线**放在本模块**（`wireOnce`）—— 以前只有
//     抽卡推荐页的 mountAdviceView 调 wireRecordPanel()，于是「角色信息」页
//     弹出来的框**关不掉**（那是这个浮层最早的一个 bug）。
//   * 「显示技能等级」按钮也在本模块接线，默认收起（见 character-panel.js）。
//
// 浮层容器（#charPanelModal / #charPanelBody）在 index.html 里，两页共用同一个 DOM 节点。

import { characterPanel } from './character-panel.js';

const $ = (id) => document.getElementById(id);
const panelEl = () => $('charPanelModal');

let onKey = null;
/** 当前打开的那一份（技能开关要按同一份数据重画，所以得记住参数）。 */
let current = null;
/** 技能等级默认**收起**：15 行「普攻 Lv.6」在推荐页纯属噪音（用户 2026-10 定过）。 */
let showSkills = false;
/** 关闭 / 背景 / ESC / 技能开关只接一次。 */
let wired = false;

/** 关掉浮层（ESC / 背景 / 关闭按钮都走这里）。 */
export const closeCharacterPanel = () => {
  const modal = panelEl();
  if (!modal) return;
  modal.hidden = true;
  const body = $('charPanelBody');
  if (body) body.innerHTML = '';
  current = null;
  if (onKey) {
    document.removeEventListener('keydown', onKey);
    onKey = null;
  }
};

/** 把当前这一份画进浮层（打开时、切换技能开关时都走它）。 */
const paint = () => {
  const body = $('charPanelBody');
  if (!body) return;
  body.innerHTML = '';
  if (!current) return;
  const { character, options } = current;
  if (character) {
    body.appendChild(characterPanel(character, {
      skills: showSkills,
      art: options.art || null,
      catalog: options.catalog || {},
      // 快照：数据集缺立绘时（开拓者形态等）用它自带的 image / equip.icon 兜底。
      // 调用方没单独给就用**解析出来的这个角色**——两页因此拿到同一份兜底图。
      snapshot: options.snapshot || character,
    }));
  } else {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = current.member?.assist
      ? '这个角色是助战角色（不在你自己的角色列表里），所以没有它的面板数据。'
      : '这个角色不在当前角色列表里（可能不是你这个账号的角色），没有面板数据。';
    body.appendChild(note);
  }
  const toggle = $('charPanelToggle');
  if (toggle) {
    // 没有面板数据时（助战 / 别的账号）技能开关没有意义，收起来而不是给一个死按钮。
    toggle.hidden = !character;
    toggle.textContent = showSkills ? '隐藏技能等级' : '显示技能等级';
    toggle.setAttribute('aria-pressed', String(showSkills));
  }
};

/** 关闭 / 点背景 / ESC / 技能开关：**只接一次**，两个分页谁来打开都生效。 */
const wireOnce = () => {
  if (wired) return;
  const modal = panelEl();
  if (!modal) return;
  wired = true;
  $('charPanelClose')?.addEventListener('click', closeCharacterPanel);
  // 点浮层背景（.modal 自身，而不是卡片）也关掉
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeCharacterPanel();
  });
  $('charPanelToggle')?.addEventListener('click', () => {
    showSkills = !showSkills;
    paint();
  });
};

/** 显式接线（旧调用点 `wireRecordPanel` 转发到这里；打开浮层时也会自动接）。 */
export const wireCharacterPanel = () => wireOnce();

/**
 * 在**本页**弹出角色面板。
 *
 * @param {{ id?:any, nameCn?:string, elementCn?:string, eidolon?:number, assist?:boolean }} member
 *   队伍里的那一条（id/名字/星魂/是否助战）——用来找角色与写副标题
 * @param {(member:any) => any} [resolve]  把 member 解析成快照里的角色对象
 * @param {{ skills?:boolean, art?:object, snapshot?:object, catalog?:object }} [options]
 * @returns {boolean} 是否找到了角色（没找到也照实说明，不给空面板）
 */
export const openCharacterPanel = (member, resolve = null, options = {}) => {
  const modal = panelEl();
  if (!modal) return false;
  const character = typeof resolve === 'function' ? resolve(member) : null;
  // 技能开关是**会话级**的偏好：在「角色信息」页打开过，切到抽卡推荐页再点角色
  // 仍然是打开的 —— 两个入口的默认状态因此永远一致（用户要的是「相同的界面」）。
  if (options.skills === true) showSkills = true;
  else if (options.skills === false) showSkills = false;
  const title = $('charPanelTitle');
  const subtitle = $('charPanelSubtitle');
  if (title) title.textContent = member?.nameCn || member?.name || '角色面板';
  if (subtitle) {
    subtitle.textContent = [
      character ? (character.rarity ? `${character.rarity}★` : '') : '',
      member?.elementCn || '',
      member?.eidolon ? `星魂 E${member.eidolon}` : '',
      member?.assist ? '助战角色' : '',
    ].filter(Boolean).join(' · ');
  }
  current = { member, character, options };
  wireOnce();
  paint();
  modal.hidden = false;
  if (!onKey) {
    onKey = (event) => { if (event.key === 'Escape') closeCharacterPanel(); };
    document.addEventListener('keydown', onKey);
  }
  return Boolean(character);
};

export const characterPanelOpen = () => {
  const modal = panelEl();
  return Boolean(modal) && !modal.hidden;
};
