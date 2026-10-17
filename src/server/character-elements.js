// `avatar_id → 属性`（`Ice` / `Fire` / …）——**数据集里没有这一项**，只能从游戏自己的表拿。
//
// ## 为什么需要它
//
// 用户 2026-10-18：「角色信息页的**命途和属性**需要显示图标……**虚拟账户也要这样显示**」。
//
// 命途有现成的来源（`theherta/character_paths.json`，虚拟快照直接带上 `path`）；
// 属性则只有**真实账号**才有 —— 米游社把 `element` 放在 `index.avatar_list` 每一项里，
// 而虚拟账号的快照是本地造的，没有那个数组，于是虚拟账号的角色卡一直**只有命途没有属性**。
// 快照里补 `element` 会影响已存的账号数据（老快照不会自己变），所以这张表在**下发时**兜底：
// `archive.js` 把它挂到 `refs.characterElements`，前端 `withCharacterMeta()` 按 id 查。
//
// ## 数据从哪来（不是猜的）
//
// `Mar-7th/StarRailRes` 的 `index_min/en/characters.json` 是**从游戏自己的文本/配置表
// 导出的**（同一份表也是各 wiki 角色页 `属性 / 命途` 两栏的来源），每个 id 带
// `path` 与 `element` 两个字段：
//
//   1001 → { name: 'March 7th', path: 'Knight', element: 'Ice' }
//   8009 → { name: '{NICKNAME}', path: 'Elation',  element: 'Thunder' }
//
// 这里的 93 条**就是** `theherta/unit-availability.json`（93 个角色）逐条按 id 投影出来的，
// 与 `i18n-zh.json` 的 `charactersById`（id → 名字）一一对上 —— 覆盖度由
// `tools/herta-test.mjs` 的「属性表覆盖全部角色」那条钉住：**少一个就红**，不会静默掉图标。
//
// ⚠️ 多形态角色的 id 不是猜的：三月七（存护 1001 / 巡猎 1224）与开拓者五形态
// （8001 毁灭 / 8003 存护 / 8005 同谐 / 8007 记忆 / 8009 欢愉）与
// `character-debut.js` 的 `FORM_AVATAR_ID`、`character-icon-ids.js` 的修正表同一套 id。
// ⚠️ 属性键沿用**米游社的英文写法**（`Thunder` 而不是 `Lightning`），因为真实快照里
// `index.avatar_list[].element` 就是这一套；前端 `ELEMENT_COLOR_KEYS` / `elementName()`
// 两种写法都认，不需要在这里先归一。

/** `{ avatar_id: 'Ice' | 'Fire' | 'Thunder' | 'Wind' | 'Quantum' | 'Imaginary' | 'Physical' }` */
export const ELEMENT_BY_AVATAR_ID = Object.freeze({
  1001: 'Ice', 1002: 'Wind', 1003: 'Fire', 1004: 'Imaginary',
  1005: 'Thunder', 1006: 'Quantum', 1008: 'Thunder', 1009: 'Fire',
  1013: 'Ice', 1014: 'Wind', 1015: 'Quantum', 1101: 'Wind',
  1102: 'Quantum', 1103: 'Thunder', 1104: 'Ice', 1105: 'Physical',
  1106: 'Ice', 1107: 'Physical', 1108: 'Wind', 1109: 'Fire',
  1110: 'Quantum', 1111: 'Physical', 1112: 'Fire', 1201: 'Quantum',
  1202: 'Thunder', 1203: 'Imaginary', 1204: 'Thunder', 1205: 'Wind',
  1206: 'Physical', 1207: 'Imaginary', 1208: 'Quantum', 1209: 'Ice',
  1210: 'Fire', 1211: 'Thunder', 1212: 'Ice', 1213: 'Imaginary',
  1214: 'Quantum', 1215: 'Physical', 1217: 'Wind', 1218: 'Fire',
  1220: 'Wind', 1221: 'Physical', 1222: 'Fire', 1223: 'Thunder',
  1224: 'Imaginary', 1225: 'Fire', 1301: 'Fire', 1302: 'Physical',
  1303: 'Ice', 1304: 'Imaginary', 1305: 'Imaginary', 1306: 'Quantum',
  1307: 'Wind', 1308: 'Thunder', 1309: 'Physical', 1310: 'Fire',
  1312: 'Ice', 1313: 'Imaginary', 1314: 'Quantum', 1315: 'Physical',
  1317: 'Imaginary', 1321: 'Fire', 1401: 'Ice', 1402: 'Thunder',
  1403: 'Quantum', 1404: 'Imaginary', 1405: 'Wind', 1406: 'Quantum',
  1407: 'Quantum', 1408: 'Physical', 1409: 'Wind', 1410: 'Physical',
  1412: 'Wind', 1413: 'Ice', 1414: 'Physical', 1415: 'Ice',
  1501: 'Fire', 1502: 'Physical', 1503: 'Ice', 1504: 'Thunder',
  1505: 'Physical', 1506: 'Imaginary', 1507: 'Fire', 1508: 'Quantum',
  1509: 'Thunder', 1510: 'Fire', 1512: 'Wind', 1513: 'Quantum',
  8001: 'Physical', 8003: 'Fire', 8005: 'Imaginary', 8007: 'Ice',
  8009: 'Thunder',
});

/**
 * 按 `avatar_id` 取属性；认不出（新角色还没进表 / id 缺失）返回 `null` ——
 * 界面据此**不画**那枚图标，而不是画一个错的。
 *
 * ⚠️ 开拓者的**偶数 id 是同一个形态的女主**（8002 = 毁灭·女主，8001 = 毁灭·男主）：
 * 游戏数据表里只登记了奇数那 5 个，而虚拟账号的头像是从 10 个里随机挑的 ——
 * 不归一的话「女主·毁灭」会没有属性图标。与 `app.js` 的 `pathByIdOf()` /
 * `character-debut.js` 的 `FORM_AVATAR_ID` 同一条规则：**只对 8001–8010 减一**，
 * 三月七的 1224-1 = 1223 是另一个人，不能乱套。
 */
export const elementOfAvatarId = (id) => {
  if (id === null || id === undefined || id === '') return null;
  const key = String(id);
  const hit = ELEMENT_BY_AVATAR_ID[key];
  if (hit) return hit;
  const num = Number(id);
  if (Number.isFinite(num) && num >= 8001 && num <= 8010 && num % 2 === 0) {
    return ELEMENT_BY_AVATAR_ID[String(num - 1)] || null;
  }
  return null;
};
