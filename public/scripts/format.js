// Formatting helpers for the Star Rail snapshot payloads.
// All functions are defensive: the record API omits fields depending on the
// player's privacy settings, so every accessor tolerates missing data.

export const STAT_LABELS = {
  hp: '生命值',
  attack: '攻击力',
  defence: '防御力',
  def: '防御力',
  speed: '速度',
  critical_chance: '暴击率',
  critical_damage: '暴击伤害',
  effect_hit: '效果命中',
  effect_res: '效果抵抗',
  status_probability: '效果命中',
  status_resistance: '效果抵抗',
  break_damage: '击破特攻',
  sp_rate: '能量恢复效率',
  heal_rate: '治疗量加成',
  speed_delta: '速度',
};

const PROPERTY_LABELS = {
  1: '生命值', 2: '攻击力', 3: '防御力', 4: '速度', 5: '暴击率', 6: '暴击伤害',
  7: '治疗量加成', 9: '能量恢复效率', 10: '效果命中', 11: '效果抵抗',
  12: '物理属性伤害提高', 14: '火属性伤害提高', 16: '冰属性伤害提高',
  18: '雷属性伤害提高', 20: '风属性伤害提高', 22: '量子属性伤害提高',
  24: '虚数属性伤害提高', 26: '基础生命值', 27: '生命值', 28: '基础攻击力',
  29: '攻击力', 30: '基础防御力', 31: '防御力', 32: '生命值', 33: '攻击力',
  34: '防御力', 35: '速度', 51: '速度', 52: '暴击率', 53: '暴击伤害',
  54: '能量恢复效率', 55: '治疗量加成', 56: '效果命中', 57: '效果抵抗',
  58: '击破特攻', 59: '击破特攻', 71: '欢愉度', 72: '欢愉度',
};

const propertyTypeOf = (property) => {
  const value = property?.property_type ?? property?.propertyType;
  return value === null || value === undefined ? null : String(value);
};

const propertyMetaOf = (propertyType, propertyInfo) =>
  propertyType === null ? null : propertyInfo?.[propertyType] || null;

const propertyLabelOf = (propertyType, propertyInfo, fallback = '') =>
  propertyMetaOf(propertyType, propertyInfo)?.property_name_relic
    || propertyMetaOf(propertyType, propertyInfo)?.name
    || PROPERTY_LABELS[propertyType]
    || fallback;

const displayableStatValue = (value) => num(value) !== null
  || (typeof value === 'string' && /^\s*[-+]?\d+(?:\.\d+)?%\s*$/.test(value));

const PATH_LABELS = {
  Warrior: '毁灭',
  Rogue: '巡猎',
  Mage: '智识',
  Shaman: '同谐',
  Warlock: '虚无',
  Knight: '存护',
  Priest: '丰饶',
  Memory: '记忆',
  // 欢愉（4.6 起的新命途，开拓者•欢愉 / 真珠）。这张表原来漏了它，于是角色面板与
  // 抽卡页会把 `Elation` 原样印出来 —— 权威那份是服务端 `refs.pathLabels`，这里只是兜底。
  Elation: '欢愉',
  // The API sometimes returns the icons' English keys with different casing.
  warrior: '毁灭',
  rogue: '巡猎',
  mage: '智识',
  shaman: '同谐',
  warlock: '虚无',
  knight: '存护',
  priest: '丰饶',
  memory: '记忆',
  elation: '欢愉',
};

const ELEMENT_LABELS = {
  // Star Rail style
  Fire: '火', Ice: '冰', Wind: '风', Thunder: '雷', Lightning: '雷',
  Physical: '物理', Quantum: '量子', Imaginary: '虚数',
  fire: '火', ice: '冰', wind: '风', thunder: '雷', lightning: '雷',
  physical: '物理', quantum: '量子', imaginary: '虚数',
};

export const pathName = (path) => PATH_LABELS[path] || path || '未知';
export const elementName = (element) => ELEMENT_LABELS[element] || element || '未知';

/** Coerce numeric-ish values; returns null when the value is unusable. */
export const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Percentage-style stats are transmitted as decimals (0.325 -> 32.5%). */
export const percent = (value, digits = 1) => {
  const n = num(value);
  if (n === null) return '—';
  return `${(n * 100).toFixed(digits)}%`;
};

export const integer = (value) => {
  const n = num(value);
  return n === null ? '—' : n.toLocaleString('zh-CN');
};

export const statValue = (key, value) => {
  if (typeof value === 'string' && /^\s*[-+]?\d+(?:\.\d+)?%\s*$/.test(value)) {
    return value.trim();
  }
  const n = num(value);
  if (n === null) return '—';
  const k = String(key).toLowerCase();
  const isRatio = k.includes('critical') || k.includes('effect') || k.includes('status')
    || k.includes('break_damage') || k.includes('sp_rate') || k.includes('heal_rate');
  const numericRatio = new Set(['5', '6', '7', '9', '10', '11', '12', '14', '16', '18', '20', '22', '24', '32', '33', '34', '52', '53', '54', '55', '56', '57', '58', '59']);
  if (isRatio || numericRatio.has(k)) {
    // The record API mixes two encodings: fractional (0.732 = 73.2%) and
    // already-scaled (184.2 = 184.2%). Realistic values never exceed 500%, so
    // anything above 5 is treated as already scaled.
    return n <= 5 ? `${(n * 100).toFixed(1)}%` : `${n.toFixed(1)}%`;
  }
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
};

/**
 * Resolve a stat key to a display name.
 *
 * Star Rail sends string keys such as `critical_damage`.
 */
export const statName = (key) => {
  const lower = String(key).toLowerCase();
  if (STAT_LABELS[lower]) return STAT_LABELS[lower];
  return String(key);
};

/** Rarity drives the card accent colour. */
export const rarityColor = (rarity) => {
  switch (num(rarity)) {
    case 5: return 'var(--r5)';
    case 4: return 'var(--r4)';
    default: return 'var(--r3)';
  }
};

export const rankLabel = (rank) => {
  const n = num(rank);
  if (n === null || n <= 0) return '未解锁星魂';
  return `星魂 ${n}`;
};

/** The API stores the trailblazer's name as a placeholder. */
export const displayName = (name) => {
  if (!name || name === '{NICKNAME}' || name === '{nickname}') return '开拓者';
  return name;
};

export const formatDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
};

/**
 * Relic/equipment slot names.
 *
 * Star Rail relic positions use 1-6 for the four relics and two planar ornaments.
 */
export const slotName = (slot) => {
  if (!slot) return '遗器';
  const key = String(slot);
  const starRail = {
    1: '头部', 2: '手部', 3: '躯干', 4: '脚部', 5: '位面球', 6: '连结绳',
    Head: '头部', Hands: '手部', Body: '躯干', Feet: '脚部',
    PlanarSphere: '位面球', LinkRope: '连结绳',
  };
  return starRail[key] || key;
};

/**
 * Extract the relic/equipment list from a character entry.
 *
 * @param {object} character
 */
export const relicsOf = (character, propertyInfo = {}) => {
  const raw = character?.relics || character?.relic_list || [];
  // 星铁的遗器分两段：`relics` 是四件套（`pos` 1-4：头/手/躯干/脚），`ornaments`
  // 是两件位面饰品（`pos` 5 位面球 / 6 连结绳）。
  const ornaments = Array.isArray(character?.ornaments) ? character.ornaments : [];
  const list = [...(Array.isArray(raw) ? raw : []), ...ornaments];
  if (!list.length) return [];
  return list.map((relic) => {
    const mainProp = relic?.main_property || relic?.mainProp || relic?.mainProperty || {};
    const subProps = relic?.sub_property_list || relic?.appendProp
      || relic?.subPropertyList || relic?.properties || [];
    return {
      id: relic?.id ?? relic?.tid ?? null,
      slot: relic?.pos ?? relic?.type ?? relic?.slot ?? null,
      slotName: slotName(
        relic?.pos ?? relic?.type ?? relic?.slot,
      ),
      name: relic?.name || '未知遗器',
      setName: relic?.set_name || relic?.setName || null,
      icon: relic?.icon || null,
      rarity: relic?.rarity ?? null,
      level: relic?.level ?? null,
      mainName: relic?.main_property_name || mainProp?.name
        || propertyLabelOf(propertyTypeOf(mainProp), propertyInfo, '') || null,
      mainPropertyType: propertyTypeOf(mainProp),
      mainIcon: propertyMetaOf(propertyTypeOf(mainProp), propertyInfo)?.icon || null,
      mainValue: mainProp?.value ?? mainProp?.final ?? relic?.main_property_value ?? null,
      subs: (Array.isArray(subProps) ? subProps : []).map((sub) => ({
        propertyType: propertyTypeOf(sub),
        name: sub?.name || propertyLabelOf(propertyTypeOf(sub), propertyInfo, '未知属性'),
        icon: propertyMetaOf(propertyTypeOf(sub), propertyInfo)?.icon || null,
        value: sub?.value ?? sub?.property_value ?? null,
        times: Math.max(0, num(sub?.times) ?? 0),
      })),
    };
  });
};

/** Extract light cone / weapon info. */
export const lightConeOf = (character) => {
  const cone = character?.equip || character?.light_cone || character?.lightCone || null;
  if (!cone) return null;
  return {
    name: cone.name || '未知光锥',
    rarity: cone.rarity ?? null,
    rank: cone.rank ?? cone.rank_level ?? null,
    level: cone.level ?? null,
    promotion: cone.promotion ?? cone.ascension ?? null,
  };
};

/** Extract skill levels. */
export const skillsOf = (character) => {
  const raw = character?.skills || character?.skill_list || character?.behavior_list || [];
  if (!Array.isArray(raw)) return [];
  return raw.map((skill, index) => ({
    name: skill?.name || skill?.point_name || skill?.skill_name || `技能 ${index + 1}`,
    level: skill?.level ?? skill?.point_level ?? skill?.skill_level ?? null,
    maxLevel: skill?.max_level ?? null,
    type: skill?.skill_type ?? skill?.type ?? null,
  }));
};

/** Character stats from the avatar/info `property_type/base/add/final` payload. */
export const statsOf = (character, propertyInfo = {}, properties = null) => {
  const props = properties || character?.properties || character?.base_properties || [];
  if (!Array.isArray(props)) return [];
  return props.map((prop) => {
    const propertyType = propertyTypeOf(prop);
    const meta = propertyMetaOf(propertyType, propertyInfo);
    const key = prop?.field || prop?.name || propertyType;
    return {
      key,
      propertyType,
      label: prop?.name || meta?.name || PROPERTY_LABELS[propertyType] || statName(prop?.field),
      icon: meta?.icon || null,
      base: prop?.base ?? null,
      add: prop?.add ?? null,
      value: prop?.final ?? prop?.value ?? null,
    };
  }).filter((row) => row.key !== null && row.key !== undefined && displayableStatValue(row.value));
};

/** Effective relic hits use the game's recommended substats and each roll's `times`. */
export const effectiveSubstatHits = (character, recommendation = {}, propertyInfo = {}) => {
  const targetTypes = Array.isArray(recommendation)
    ? recommendation
    : (recommendation?.is_custom_property_valid && recommendation.custom_relic_properties?.length
      ? recommendation.custom_relic_properties
      : recommendation?.recommend_relic_properties || []);
  const targets = new Set(targetTypes.map(String));
  if (!targets.size) return { total: 0, rows: [] };

  const counts = new Map();
  const relics = [
    ...(Array.isArray(character?.relics) ? character.relics : []),
    ...(Array.isArray(character?.ornaments) ? character.ornaments : []),
  ];
  for (const relic of relics) {
    const properties = relic?.sub_property_list || relic?.properties || [];
    if (!Array.isArray(properties)) continue;
    for (const property of properties) {
      const type = propertyTypeOf(property);
      if (!targets.has(type)) continue;
      const hits = Math.max(0, num(property?.times) ?? 0);
      if (hits) counts.set(type, (counts.get(type) || 0) + hits);
    }
  }
  const rows = [...counts].map(([type, count]) => ({
    propertyType: type,
    name: propertyLabelOf(type, propertyInfo, '未知属性'),
    icon: propertyMetaOf(type, propertyInfo)?.icon || null,
    count,
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
  return { total: rows.reduce((sum, row) => sum + row.count, 0), rows };
};

/**
 * Pick the character list out of the various snapshot shapes.
 *
 * Star Rail: index.avatar_list / avatars.avatars
 */
export const charactersOf = (snapshot) => {
  const candidates = [
    snapshot?.characters,
    snapshot?.avatars?.avatars,
    snapshot?.avatars?.avatar_list,
    snapshot?.index?.avatar_list,
    snapshot?.index?.avatars,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
  }
  return [];
};

/**
 * Challenge / Forgotten Hall summary rows.
 *
 * 真实字段叫 `all_floor_detail`（早期版本找的是 `floors` / `challenge_floor_list`，
 * 两个都不存在），所以「本期层数」这一行一直没有显示出来——数据其实一直在。
 * 记录里的层是**按难度从高到低**返回的，所以第一项就是最高一层；`max_floor`
 * 是层名（例如「来生泅渡其十二」）而不是数字，早先按数字解析也被丢掉了。
 * （完整的逐层队伍在抽卡推荐页的第一节，这里只给摘要。）
 */
export const challengeSummary = (snapshot) => {
  const data = snapshot?.challenge;
  if (!data) return null;
  const rows = [];
  const raw = data.all_floor_detail || data.floors || data.challenge_floor_list;
  const floors = Array.isArray(raw) ? raw : [];
  if (floors.length) rows.push({ label: '本期层数', value: `${floors.length} 层` });
  const stars = num(data.star_num ?? data.total_star);
  if (stars !== null) rows.push({ label: '本期星数', value: `${stars} ★` });
  const top = floors[0];
  const topName = top?.name || (typeof data.max_floor === 'string' ? data.max_floor : null);
  if (topName) rows.push({ label: '最高一层', value: topName });
  if (Number.isFinite(top?.round_num)) {
    rows.push({ label: '该层回合数', value: `${top.round_num}T` });
  }
  const battles = num(data.battle_num);
  if (battles !== null) rows.push({ label: '本期战斗', value: `${battles} 次` });
  return rows.length ? rows : null;
};

/**
 * Public profile-card stats ("个人主页卡片").
 *
 * The record card is NOT gated by the battle-record visibility switches, so when
 * the detailed endpoints answer 10035 these rows are still available:
 *   data: [{name:'活跃天数', value:'1206'}, {name:'已解锁角色', value:'66'}, ...]
 */
export const cardStats = (snapshot) => {
  const card = snapshot?.card;
  if (!card || !Array.isArray(card.data)) return null;
  const rows = card.data
    .filter((row) => row && row.name !== undefined && row.value !== undefined)
    .map((row) => ({ label: String(row.name), value: String(row.value) }));
  return rows.length ? rows : null;
};

/**
 * Player identity as the record API actually returns it.
 * `index` nests the role under `role`; `role/basicInfo` returns it at the top
 * level (verified live: {avatar, nickname, region, level}); the public card
 * carries nickname/level as a last resort.
 */
export const playerInfoOf = (snapshot) => {
  const candidates = [
    snapshot?.index?.role,
    snapshot?.basicInfo,
    snapshot?.card,
    snapshot?.index,
  ];
  for (const candidate of candidates) {
    if (candidate && (candidate.nickname || candidate.level !== undefined)) return candidate;
  }
  return {};
};

/**
 * Simulated Universe summary from the live shape:
 *   { role, basic_info:{unlocked_buff_num,unlocked_miracle_num,unlocked_skill_points},
 *     current_record:{ basic:{current_rogue_score,max_rogue_score,finish_cnt,id},
 *                      records:[], has_data }, last_record, latest_record }
 */
export const rogueSummary = (snapshot) => {
  const data = snapshot?.rogue;
  if (!data || typeof data !== 'object') return null;
  const rows = [];
  const basicInfo = data.basic_info || {};
  const record = data.current_record || {};
  const basic = record.basic || {};

  if (basic.id !== undefined) rows.push({ label: '本期期数', value: `第 ${basic.id} 期` });
  if (basic.current_rogue_score !== undefined) {
    rows.push({
      label: '本期积分',
      value: `${integer(basic.current_rogue_score)}${basic.max_rogue_score !== undefined ? ` / ${integer(basic.max_rogue_score)}` : ''}`,
    });
  }
  if (basic.finish_cnt !== undefined) rows.push({ label: '本期通关', value: `${basic.finish_cnt} 次` });
  if (basicInfo.unlocked_buff_num !== undefined) rows.push({ label: '已解锁祝福', value: integer(basicInfo.unlocked_buff_num) });
  if (basicInfo.unlocked_miracle_num !== undefined) rows.push({ label: '已解锁奇物', value: integer(basicInfo.unlocked_miracle_num) });
  if (basicInfo.unlocked_skill_points !== undefined) rows.push({ label: '已解锁技能点', value: integer(basicInfo.unlocked_skill_points) });

  const records = Array.isArray(record.records) ? record.records : [];
  if (records.length) rows.push({ label: '本期记录数', value: `${records.length} 条` });
  return rows.length ? rows : null;
};
