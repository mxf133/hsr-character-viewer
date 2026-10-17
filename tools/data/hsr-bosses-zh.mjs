// 黑塔网（theherta）首领名的**官方简中**对照表。
//
// ## 为什么这个文件必须存在
//
// `tools/herta-i18n.mjs` 从这里 `import { BOSSES_ZH, BOSS_VARIANTS }`，
// 再用它生成 `theherta/i18n-zh.json` 的 `bosses` 段。
//
// ⚠️ 本文件一度**没有进版本库**（`git log --all -- tools/data/*` 是空的），
// 于是 `node tools/herta-i18n.mjs` 直接 `ERR_MODULE_NOT_FOUND` 崩掉 —— 而
// `herta-i18n-check.mjs` 只读**生成物** `i18n-zh.json`，跑得全绿，
// 所以「重建脚本坏了」这件事一直没人发现。后果是：首领译名只有一份生成物副本，
// 谁重建一次，49 条首领名就只剩能回落到角色表的那几条。
//
// 2026-10-18 按 `i18n-zh.json` 的生成物**反向还原**回来，并补上
// `tools/i18n-audit.mjs` 的「生成物 ↔ 本表」一致性断言，防止再丢一次。
//
// ## 三条来源（按优先级）
//
// 1. **本表** `BOSSES_ZH`：手工核过、且**不能**从角色表推出来的敌人名。
// 2. **角色表回落**：不少首领就是可玩角色（卡芙卡 / 布洛妮娅 / 银枝 / 砂金 /
//    杰帕德 / 飞霄），`herta-i18n.mjs` 用 `characters[name]` 直接命中，
//    这里**不要重复登记**（重复会把「角色表改名了但首领没改」这类漂移掩盖掉）。
// 3. **变体派生** `BOSS_VARIANTS`：`X (Plight)` / `X: Plight` / `X (K1)` 统一
//    渲染成 `X（绝境）`，只登记基础名。
//
// 本表 33 条 = 生成物 49 条 − 角色表回落 − 变体派生。
//
// ## 核对办法（改之前先看这里）
//
// 官方敌人名在 BWiki 的 `{{敌人}}` 模板里（`|名称=` / `|系列=` 字段），
// 检索接口（限流很凶，两次之间要隔 1~2 秒，被拦会返回 HTML 而不是 JSON）：
//
//   https://wiki.biligame.com/sr/api.php?format=json&action=query&list=search&srsearch=<名字>
//   https://wiki.biligame.com/sr/api.php?format=json&action=query&prop=revisions&rvprop=content&titles=<页面>
//
// 2026-10-18 逐条核过一遍，结论：
//   * **Pollux 原名 `波吕克斯` 是错的** —— 官方是「玻吕刻斯」：
//     遐蝶（Castorice）的忆灵写作`死龙 • 玻吕刻斯`，敌人页是
//     `冥魂渡者，死龙残躯，玻吕刻斯`（实装 3.2 / 剧情BOSS / 泰坦眷属）。
//     `波吕克斯` 是双子座神话里 Pollux 的另一种音译，游戏里**没有**这个写法。
//   * 其余 32 条在 wiki 上都能检索到同名条目。

/** `{ 黑塔网的英文首领名: 官方简中 }`——只列角色表推不出来、又不是变体的那些。 */
export const BOSSES_ZH = {
  // ⚠️ 黑塔网写的是「5 TVs」（5 台电视），译名只给了单个敌人名，数量被丢了。
  // 保留原样是因为界面那一格只放得下一个名字，但这是**已知的信息损失**，不是笔误。
  '5 TVs': '惊梦剧团的圆幕先生',
  'Abundant Ebon Deer': '丰饶玄鹿',
  'Anti-Creator, Hatred Inundate': '反造物主，流溢之恨',
  Aquila: '至高，至阳，天空的化身',
  'Aurumaton Spectral Envoy': '金人勾魂使',
  // 组合首领：两个敌人同场，中间用半角 `+` 连起来（与黑塔网的写法一致）。
  'Cocolia + Bronya': '可可利亚+布洛妮娅',
  Cocolia: '可可利亚',
  'Doomsday Beast': '末日兽',
  'Flame Reaver': '至黑之剑，盗火行者',
  'God-Devourer Offspring': '吞神子嗣',
  Gryphon: '正阳狮鹫',
  'Harbinger of Death': '忆域迷因「何物朝向死亡」',
  'Hellcharred Shadow General': '业火焚心的影将军',
  Hoolay: '步离战首•呼雷',
  'Ichor Memosprite': '金血忆灵',
  'Illwish Archlotus': '极乐颠倒•邪愿莲华主',
  'King Pom-Pom': '合金机铠•帕姆王',
  'Murata Graphia, Founding Artist': '始作画者，无量塔绘世',
  Nikador: '蛮神，疯王，纷争的化身',
  Phantylia: '不死神实•幻胧',
  // 见文件头：官方「玻吕刻斯」，不是「波吕克斯」。
  Pollux: '冥魂渡者，死龙残躯，玻吕刻斯',
  'Rocking Rebel': '摇滚狂徒',
  Sam: '萨姆',
  // ⚠️ 官方全称是「齐响诗班」神主日（BWiki `{{敌人}}` 的 `|名称=`）。
  // 这里只写「神主日」是**有意的短名**（界面那一格放不下全称），
  // `herta-i18n-check.mjs` 的 MUST_RESOLVE 按这个值断言，改了要同步改断言。
  Septimus: '神主日',
  Skaracabaz: '碎星王虫•斯喀拉卡巴兹',
  Sleepie: '睡蕉小猴',
  // 与可玩角色「火花」(Sparxie) 同名不同译：首领形态官方叫「火花大会@Official」。
  // ⚠️ `i18n-zh.json` 的 `aliases.SparxiConOfficial` 是「斯帕克西（官方演示）」，
  // 那是早期猜的译名，和官方对不上；`herta-i18n.mjs` 只把它写进 `aliases` 段，
  // 没有任何代码读它 —— 属于**死条目**，别拿它当依据。
  SparxiConOfficial: '火花大会@Official',
  'Stellaron Hunter: Sam': '「星核猎手」萨姆',
  Svarog: '史瓦罗',
  // ⚠️ 「The Ascended」这一半在 wiki 上检索不到（`insource:"The Ascended"` 无结果），
  // 它和 `Skaracabaz` 目前共用同一个中文名，于是两个不同的英文键会渲染成**同一个名字**。
  // 待核，改之前先确认黑塔网这一条到底指哪个形态。
  'The Ascended + Cyclonic Swarm Mother': '碎星王虫•斯喀拉卡巴兹+遮天蔽日的噬星蠹',
  'True Sting': '虫群•真蛰虫',
  Yabuli: '堕神之血•亚婆离',
  Zandar: '第一位天才，隐德来希，赞达尔',
};

/**
 * 变体后缀 → 渲染规则。`herta-i18n.mjs` 的解析顺序：
 *
 *   `name.match(pattern)` → `base = name.replace(pattern, '')`
 *   → `stem = BOSSES_ZH[base] || characters[base]` → `render(stem, ...groups)`
 *
 * 黑塔网对同一件事有 `X (Plight)`、`X: Plight`、`X (K1)` 三种写法，
 * 所以两条正则都要有，且**渲染结果必须统一是 `X（绝境）`**——
 * 混用会出现「同一个首领两种名字」。
 */
export const BOSS_VARIANTS = [
  [/\s*[(（](?:Plight|K\d)[)）]\s*$/i, (stem) => `${stem}（绝境）`],
  [/:\s*Plight\s*$/i, (stem) => `${stem}（绝境）`],
];
