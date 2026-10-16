// 角色**实装（首次登场）版本** —— 用户 2026-10-16 第 8 条。
//
// 用户原话：「角色信息-角色列表要按照该角色在**黑塔网首次登场**的版本排序，**最新的角色
// 在前，旧角色在后**（再老的角色排序顺序固定，请参考 wiki 的登场时间排序），且支持未来的
// 新角色登场后自动排序在前」。
//
// ## 为什么需要这张表（它补的是数据集的缺口）
//
// 用户在需求里写的是「按该角色在**黑塔网首次登场**的版本排序」—— 听起来主键就该是数据集
// 现算的 `refs.firstSeen.characters`（黑塔网投稿里该角色第一次出现的版本）。
//
// 但本机实测 **`firstSeen` 不是登场版本**，它是「第一次有人投稿这个角色」的版本，而数据集
// 从 **3.0** 才开始采集：一个角色没人投稿就一直不出现。于是 ——
//
//   * 51 个旧角色的 `firstSeen` 全挤在 `"3.0"`（数据集自身的起点）；
//   * 剩下的还带**噪声**：杰帕德 / 娜塔莎 / 桑博（都是 **1.0** 实装）记成 `"3.4"`
//     （因为他们第一次进投稿是在 3.4 的某支队伍里）、艾丝妲（1.0）记成 `"3.3"`；
//   * 连新角色也普遍**晚一版**：真珠（4.6 实装）记成 `"4.5"`、不死途（4.1）记成 `"4.0"`
//     —— 因为新角色要等到下一期副本才有人投稿。
//   * 93 个键里 **89 个**的 `firstSeen` 与真实实装版本不符。
//
// 拿它当主键会直接违背用户的验收条件「最新的角色在前，旧角色在后」：**1.0 的杰帕德会排在
// 2.1 的 Acheron 前面**（`"3.4"` > `"2.1"`）。所以主键换成这张 **wiki 真实实装版本** 表，
// `firstSeen` 只在②给「本表还没有登记的新角色」兜底 —— 那种角色必然是最新版本，于是
// 用户要的「未来新角色自动排在前」照样成立，且**不需要**维护任何代码。
//
// 这一轮因此变成：**主键 = wiki 实装版本，兜底 = firstSeen + avatar_id**，三层都不随数据
// 刷新变化 —— 用户点名的「再老的角色排序顺序固定」由此成立。
//
// ## 数据来源（不要凭记忆改，要重抓就照下面做）
//
// 来自 **BWiki（bilibili 星穹铁道 WIKI）「角色图鉴」** 页面里每张角色卡的
// `data-param4` 字段（= 该角色的**实装版本**）：
//
//   https://wiki.biligame.com/sr/角色图鉴
//   （页面里的 `div.divsort[data-param4]`，实装版本与角色名同在一张卡上）
//
// 抓取 / 校对办法（本机 2026-10-16 实测可用，页面 358 KB）：
//
//   curl -s "https://wiki.biligame.com/sr/%E8%A7%92%E8%89%B2%E5%9B%BE%E9%89%B4" -o bwiki.html
//   # 每张卡是 <div class="divsort" data-param4="4.6" ...> ... <div class="chara-name">真珠</div>
//
// 键是**数据集英文键**（`refs.characters` 里那 93 个，含 `March 7th (Hunt)` /
// `Trailblazer (Destruction)` 这类带命途的写法）；取值是中文 wiki 的实装版本号。
// 93/93 全部对得上，**没有一个靠猜**。
//
// ## 与 `refs.firstSeen` 的区别（别把两者混成一份）
//
//   * 本表 = 「这个角色在**游戏里实装**」的版本，是**静态**的（人工按 wiki 维护），
//     是排序的**主键**。
//   * `firstSeen` = 「这个角色第一次出现在**黑塔网投稿**里」的版本，随数据集刷新**现算**；
//     它只给本表**没登记的新角色**兜底编号（表外新角色必然最新 → 自动排最前）。
//
// ⚠️ **不要**把这张表并进 `theherta/i18n-zh.json`（硬规矩：那里只管中文名映射）。

/** 数据集英文键 → 该角色的**游戏实装版本**（`"主.次"`，如 `"4.6"`）。 */
export const CHARACTER_DEBUT_VERSION = Object.freeze({
  "Acheron": "2.1",
  "Aglaea": "3.0",
  "Anaxa": "3.2",
  "Archer": "3.4",
  "Argenti": "1.5",
  "Arlan": "1.0",
  "Ashveil": "4.1",
  "Asta": "1.0",
  "Aventurine": "2.1",
  "Aventurine • Waveflair": "4.5",
  "Bailu": "1.0",
  "Black Swan": "2.0",
  "Blade": "1.2",
  "Boothill": "2.2",
  "Bronya": "1.0",
  "Castorice": "3.2",
  "Cerydra": "3.5",
  "Cipher": "3.3",
  "Clara": "1.0",
  "Cyrene": "3.7",
  "Dan Heng": "1.0",
  "Dan Heng • Imbibitor Lunae": "1.3",
  "Dan Heng • Permansor Terrae": "3.6",
  "Dr. Ratio": "1.6",
  "Evanescia": "4.2",
  "Evernight": "3.6",
  "Feixiao": "2.5",
  "Firefly": "2.3",
  "Fu Xuan": "1.3",
  "Fugue": "2.7",
  "Gallagher": "2.1",
  "Gepard": "1.0",
  "Gilgamesh": "4.4",
  "Guinaifen": "1.4",
  "Hanya": "1.5",
  "Herta": "1.0",
  "Himeko": "1.0",
  "Himeko • Nova": "4.4",
  "Hook": "1.0",
  "Huohuo": "1.5",
  "Hyacine": "3.3",
  "Hysilens": "3.5",
  "Jade": "2.3",
  "Jiaoqiu": "2.4",
  "Jing Yuan": "1.0",
  "Jingliu": "1.4",
  "Kafka": "1.2",
  "Lingsha": "2.5",
  "Luka": "1.2",
  "Luocha": "1.1",
  "Lynx": "1.3",
  "March 7th (Hunt)": "2.4",
  "March 7th (Preservation)": "1.0",
  "Misha": "2.0",
  "Mortenax Blade": "4.3",
  "Moze": "2.5",
  "Mydei": "3.1",
  "Natasha": "1.0",
  "Pearl": "4.6",
  "Pela": "1.0",
  "Phainon": "3.4",
  "Qingque": "1.0",
  "Rappa": "2.6",
  "Rin Tohsaka": "4.4",
  "Robin": "2.2",
  "Robin • Summeretto": "4.5",
  "Ruan Mei": "1.6",
  "Saber": "3.4",
  "Sampo": "1.0",
  "Seele": "1.0",
  "Serval": "1.0",
  "Silver Wolf": "1.1",
  "Silver Wolf LV.999": "4.2",
  "Sparkle": "2.0",
  "Sparxie": "4.0",
  "Sunday": "2.7",
  "Sushang": "1.0",
  "The Dahlia": "3.8",
  "The Herta": "3.0",
  "Tingyun": "1.0",
  "Topaz & Numby": "1.4",
  "Trailblazer (Destruction)": "1.0",
  "Trailblazer (Elation)": "4.2",
  "Trailblazer (Harmony)": "2.2",
  "Trailblazer (Preservation)": "1.0",
  "Trailblazer (Remembrance)": "3.0",
  "Tribbie": "3.1",
  "Welt": "1.0",
  "Xueyi": "1.6",
  "Yanqing": "1.0",
  "Yao Guang": "4.0",
  "Yukong": "1.1",
  "Yunli": "2.4",
});

/**
 * 数据集分不清的多形态角色 → **排序兜底用的**权威头像 id。
 *
 * ⚠️ 这里**只给排序当最后一级兜底**（同 firstSeen、同登场版本时按 id 升序），
 * 不参与图标解析 —— 图标走 `character-icon-ids.js` 的 `applyCharacterIdOverrides()`
 * （只补三月七两个命途），本轮不动它，免得顺带改了卡片外观。
 *
 * 为什么需要它：`i18n.charactersById` 里 `1001` 与 `1224` 都写成 `March 7th`、
 * `8001..8010` 全部写成 `{NICKNAME}`，**没有命途信息**，所以这 7 个键反查不到 id。
 * id 取值依据与 `character-icon-ids.js` 一致（1001 = 存护 / 1224 = 巡猎）；
 * 开拓者同理是「奇数 id = 男主」的那一半（8001/8003/8005/8007/8009）。
 */
export const FORM_AVATAR_ID = Object.freeze({
  'March 7th (Preservation)': 1001,
  'March 7th (Hunt)': 1224,
  'Trailblazer (Destruction)': 8001,
  'Trailblazer (Preservation)': 8003,
  'Trailblazer (Harmony)': 8005,
  'Trailblazer (Remembrance)': 8007,
  'Trailblazer (Elation)': 8009,
});

/**
 * 「头像 id → 排序上等同于哪个数据集英文键」（`debutOrderById` 用）。
 *
 * 只有开拓者需要它，而这条是**必须的**：米游社快照里开拓者**只有一行**（用户 2026-10-14
 * 第 4 条），`id` 是当前命途那一个（8001~8010 里**任意一个**，男女与命途都可能变）。
 * 不把 10 个 id 收口到同一个键的话，开拓者会随玩家切命途在列表里**上下乱跳** ——
 * 而用户第 8 条要的是「再老的角色排序顺序固定」。
 *
 * 统一收到 `Trailblazer (Destruction)`（开拓者在游戏里 1.0 就登场了，五个命途里它最早），
 * 于是「开拓者」这一行永远落在旧角色那一段，不受当前命途影响。
 *
 * 三月七**不在这里**：她的存护 / 巡猎是两张**独立**的卡（1001 / 1224 同时存在），
 * 应当各按自己的登场版本（1.0 / 2.4）排序，不属于「一个 id 收口」的情形。
 */
export const DEBUT_ID_ALIASES = Object.freeze({
  8001: 'Trailblazer (Destruction)',
  8002: 'Trailblazer (Destruction)',
  8003: 'Trailblazer (Destruction)',
  8004: 'Trailblazer (Destruction)',
  8005: 'Trailblazer (Destruction)',
  8006: 'Trailblazer (Destruction)',
  8007: 'Trailblazer (Destruction)',
  8008: 'Trailblazer (Destruction)',
  8009: 'Trailblazer (Destruction)',
  8010: 'Trailblazer (Destruction)',
});

/**
 * 固定排序键：`{ 数据集英文键: 序号 }`，序号**越大越新**。
 *
 * 三层主次（与用户第 8 条一致）：
 *   ① **真实实装版本** = `CHARACTER_DEBUT_VERSION`（人工按 wiki 维护）—— 主键。
 *   ② `firstSeen`（黑塔网投稿里首次出现的版本）—— **只给 ① 里没有登记的角色**兜底，
 *      也就是「将来同步进来的新角色」；它们的 firstSeen 就是它们真实的登场版本。
 *   ③ avatar_id —— 同版本打平时用它，取不到 id 时按英文键字典序。
 *      两者都**不随数据刷新变化**（用户要求「再老的角色排序顺序固定」）。
 *
 * 返回值是「旧 → 新」递增编号，界面按序号**降序**排就是「最新的角色在前」。
 * 用**一个整数**而不是把版本号交给前端比较：前端只需要一次 `a - b`，
 * 不必在浏览器里再抄一份版本比较函数（版本比较在本仓库只允许有一份实现）。
 *
 * ## ⚠️ 为什么主键是 wiki 实装版本、而**不是** `firstSeen`（这一条是本轮最重要的判断）
 *
 * 用户原话是「按该角色在**黑塔网首次登场**的版本排序」，听起来主键就该是 `firstSeen`。
 * 但本机实测 `firstSeen` **不是**登场版本，而是「这个角色第一次出现在**黑塔网投稿**里」
 * —— 数据集从 **3.0** 才开始采集，一个角色只要没被玩家投稿过就一直不出现。于是：
 *
 *   * 51 个旧角色的 `firstSeen` 全挤在 `"3.0"`（数据集起点）；
 *   * 更麻烦的是那 51 个之外还有**噪声**：杰帕德 / 娜塔莎 / 桑博（都是 **1.0** 实装）
 *     被记成 `"3.4"`、艾丝妲（**1.0**）记成 `"3.3"`、白露（**1.0**）记成 `"3.5"`、
 *     虎克（**1.0**）记成 `"3.1"`；连新角色也普遍**晚一版**（真珠 4.6 实装记成 4.5、
 *     不死途 4.1 记成 4.0）。
 *   * 93 个键里 **89 个**的 `firstSeen` 与真实实装版本不符。
 *
 * 拿它当主键会直接违背用户的验收条件「最新的角色在前，旧角色在后」：**1.0 的杰帕德会排
 * 在 2.1 的 Acheron 前面**。所以主键换成 wiki 的真实实装版本，`firstSeen` 退回②只给
 * 「表里还没有的新角色」兜底 —— 那种角色必然是最新版本，于是「未来新角色自动排在前」
 * 这条要求照样成立，且**不需要**维护任何代码。
 *
 * ## 排序集合
 *
 * `本表 ∪ keys ∪ firstSeen`：本表是人工维护的静态表，将来同步进来的新角色可能还没登记；
 * 给它编号靠②。`keys` 一般传 {@link archiveIndex} 的 `refs.characters`（数据集**引用到**
 * 的角色），这样 `firstSeen` 里那些**别名写法**（实测有一个 `Trailblazer: Destruction`，
 * 冒号版本，不在 `refs.characters` 里）不会多占一个序号。
 *
 * @param {object} options
 * @param {Record<string,string>} [options.firstSeen]  `refs.firstSeen.characters`
 * @param {(en:string)=>number|null} [options.idOf]    英文键 → avatar_id（取不到返回 null）
 * @param {string[]} [options.keys]                    要编号的角色集合；缺省用 firstSeen 的键
 * @returns {Record<string,number>}
 */
export const buildDebutOrder = ({ firstSeen = {}, idOf = null, keys = null } = {}) => {
  const cmpVer = (a, b) => {
    const pa = String(a ?? '').split('.').map((n) => Number(n) || 0);
    const pb = String(b ?? '').split('.').map((n) => Number(n) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i += 1) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  const idOfKey = (key) => {
    const fallback = FORM_AVATAR_ID[key];
    const id = Number(idOf ? idOf(key) : NaN);
    if (Number.isFinite(id)) return id;
    const fb = Number(fallback);
    return Number.isFinite(fb) ? fb : Number.MAX_SAFE_INTEGER;
  };
  /** 主键值：wiki 表优先，表外（新角色）用 firstSeen，两者都缺当 '0.0'（最旧）。 */
  const debutOf = (key) => CHARACTER_DEBUT_VERSION[key] || firstSeen[key] || '0.0';
  const table = [...new Set([
    ...Object.keys(CHARACTER_DEBUT_VERSION),
    ...(Array.isArray(keys) ? keys : Object.keys(firstSeen || {})),
  ])];
  const sorted = table.sort((a, b) => {
    // ① 实装版本升序（旧在前）；缺失当 '0.0'，排在最旧的一头。
    const byDebut = cmpVer(debutOf(a), debutOf(b));
    if (byDebut !== 0) return byDebut;
    // ② avatar_id 升序（取不到就退化到稳定字典序，与数据刷新无关）。
    const byId = idOfKey(a) - idOfKey(b);
    if (byId !== 0) return byId;
    return a < b ? -1 : (a > b ? 1 : 0);
  });
  const order = {};
  sorted.forEach((key, i) => { order[key] = i; });
  return order;
};
