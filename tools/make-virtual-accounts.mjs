// 把「虚拟账号」批量写成一份**独立的账号库文件**，配合
// `DSH_HSR_DATA_FILE=accounts-virtual.json` 起第二个服务（另一个端口）就能在界面里选到它们。
//
// ⚠️ **绝不碰真实账号库**：默认写 `data/accounts-virtual.json`。真实数据 `data/accounts.json`
// 与本机其它服务完全不受影响。界面上的「＋ 虚拟账号」走的是另一条路（服务端 API，直接写进
// 当前账号库、**只增不删**）—— 两种用法各取所需：这个工具用来**批量**铺一套账号。
//
// 预设与快照构造**都来自服务端那一份**（`src/server/virtual-accounts.js`），
// 不再在这里另写一遍 —— 图标 / 星级显示错乱就是「两处各写一份」造成的。
//
//   node tools/make-virtual-accounts.mjs [--out=data/accounts-virtual.json] [--list]
//                                        [--preset=newbie,bai-e,full]
import fs from 'node:fs';
import { charCostOf, coneCostOf } from '../public/scripts/advice.js';
import { archiveIndex, loadI18n } from '../src/server/archive.js';
import { VIRTUAL_PRESETS, buildVirtualAccount, presetContext } from '../src/server/virtual-accounts.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const OUT = arg('out', 'data/accounts-virtual.json');
const LIST_ONLY = process.argv.includes('--list');
const ONLY = arg('preset', '').split(',').map((s) => s.trim()).filter(Boolean);

const index = await archiveIndex();
const i18n = await loadI18n();
const availability = index.refs?.availability || {};
const ctx = presetContext({ availability, firstSeen: index.refs?.firstSeen?.characters,
  charCostOf, coneCostOf });

const presets = VIRTUAL_PRESETS.filter((p) => !ONLY.length || ONLY.includes(p.id));
const accounts = presets.map((preset, i) => buildVirtualAccount({
  preset, index, i18n, availability, charCostOf, coneCostOf,
  // ⚠️ uid 必须是**纯数字**：快照路由是 `/roles/(\d+)/snapshot`（用 `9baiE` 会 404）。
  uid: String(900000 + i + 1),
  accountId: `virtual-${preset.id}`,
}));

const describe = (account) => {
  const snap = account.snapshots[Object.keys(account.snapshots)[0]];
  const chars = snap.characters || [];
  const limited = chars.filter((c) => charCostOf(
    Object.entries(i18n.characters).find(([, zh]) => zh === c.name)?.[0] || c.name, availability) > 0);
  return `角色 ${chars.length} 个（限定 ${limited.length}）｜光锥 ${chars.filter((c) => c.equip).length} 把`;
};

if (LIST_ONLY) {
  for (const [i, spec] of presets.entries()) {
    console.log(`${accounts[i].id}\n  ${spec.title}｜${describe(accounts[i])}\n  ${spec.hint}`);
  }
} else {
  fs.writeFileSync(OUT, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`);
  console.log(`已写入 ${OUT}：${accounts.length} 个虚拟账号`);
  console.log('启动沙箱界面（**不碰真实账号库**）：');
  // ⚠️ `DSH_HSR_DATA_FILE` 是**相对 `data/` 目录**解析的（`resolve(cwd, 'data', env)`），
  //    写 'data/accounts-virtual.json' 会变成 data/data/...（实测踩过）。
  console.log(`  $env:DSH_HSR_DATA_FILE='${OUT.replace(/^data[\\/]/, '')}'; node bin/serve.mjs --port 8372 --host 127.0.0.1`);
  console.log('');
  for (const [i, spec] of presets.entries()) {
    console.log(`  · ${spec.title} — ${describe(accounts[i])}`);
  }
}
