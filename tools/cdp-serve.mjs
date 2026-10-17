// **给 CDP 布局套件用的替身服务**：起一个真 HTTP 服务（`createApp`）、喂一批**内存里的
// 虚拟账号**，**完全不碰 DPAPI 凭证库**。
//
// 为什么需要它：`bin/serve.mjs` 启动时 `AccountStore.load()` 会解密账号库 —— Windows 上
// 走 DPAPI，实现是 `spawn` 一个系统命令行进程。某些环境（受限沙箱、CI、以及本机
// 2026-10-18 的实测环境）**不允许那个 spawn**，于是启动直接死在
// `启动失败： spawn UNKNOWN`，CDP 套件也就无从跑起（见 `docs/CDP布局套件.md` §2.1）。
//
// 这个工具绕开的只是「账号库的持久化」这一层：
//   * 账号来自 `src/server/virtual-accounts.js`（与界面上的「虚拟账号」、与
//     `make-virtual-accounts.mjs` **同一份构造**，不另写一套）；
//   * 存到 `AccountStore` 的一个内存子类里：`load()` / `save()` / `persist()` 都被
//     改成空操作 ⇒ 既不读盘也不写盘，自然不会碰 DPAPI；
//   * 其余路由（静态资源 / `/api/archive` / `/api/archive/conclusion` / 快照）**全是
//     生产代码**，不做任何 mock —— 套件看到的就是真页面。
//
//   node tools/cdp-serve.mjs [--port=8361] [--accounts=4] [--preset=a,b]
//
// 起来之后：
//   node tools/check-advice-layout.mjs --url=http://127.0.0.1:8361/
import { createApp } from '../src/server/app.js';
import { archiveIndex, loadI18n } from '../src/server/archive.js';
import { AccountStore } from '../src/server/store.js';
import { VIRTUAL_PRESETS, buildVirtualAccount, withSignatureCones } from '../src/server/virtual-accounts.js';
import { charCostOf, coneCostOf } from '../public/scripts/advice.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const PORT = Math.max(1, Number(arg('port', '8361')) || 8361);
const HOST = arg('host', '127.0.0.1');
const COUNT = Math.max(1, Number(arg('accounts', '4')) || 4);
const ONLY = arg('preset', '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * `AccountStore` 的**内存子类**。
 *
 * 只覆盖三个落盘相关的钩子；`listAccounts` / `getSnapshot` / `setSnapshot` /
 * `toPublic` 等全部沿用父类 —— 界面用到的字段形状因此与生产完全一致
 * （自己手写一个 duck-typed store 很容易漏字段，那是 `_probe-*.mjs` 反复踩过的坑）。
 */
class MemoryAccountStore extends AccountStore {
  constructor(accounts) {
    // `file` 给个占位路径即可（永不读写）；`vault` 不给也可以 —— 父类会造一个，
    // 但只要不调 `encrypt` / `decrypt` 就不会 spawn 那个系统命令行进程。
    super({ file: 'memory://accounts' });
    for (const account of accounts) this.accounts.set(account.id, account);
    // ⚠️ 必须直接置 `loaded = true`：父类的 `load()` 是「幂等 + 只跑一次」，默认实现
    //    会去 `readFile(this.file)`。这里连调用机会都不给，避免任何 IO。
    this.loaded = true;
  }

  async load() { this.loaded = true; }

  async persist() {}

  save() { return Promise.resolve(); }
}

// ⚠️ `withSignatureCones` 不能省：它把「真正的专属光锥表」（限定 5★，从 `archive.json`
//    的 `characters[].topLightCones` 现算）挂到 refs 上。少了这一步，虚拟账号的配装会
//    静默退回「最常用光锥」—— 正是用户 2026-10-14 第 1 条报的「全角色平铺缺光锥」。
const index = await withSignatureCones(await archiveIndex());
const i18n = await loadI18n();
const availability = index.refs?.availability || {};

const presets = VIRTUAL_PRESETS.filter((p) => !ONLY.length || ONLY.includes(p.id)).slice(0, COUNT);
if (!presets.length) {
  console.error(`没有匹配的预设（可用：${VIRTUAL_PRESETS.map((p) => p.id).join(' / ')}）`);
  process.exit(1);
}

const accounts = presets.map((preset, i) => buildVirtualAccount({
  preset, index, i18n, availability, charCostOf, coneCostOf,
  // uid 必须是纯数字：快照路由是 `/roles/(\d+)/snapshot`。
  uid: String(900000 + i + 1),
  accountId: `virtual-${preset.id}`,
}));

const store = new MemoryAccountStore(accounts);
const { server } = createApp({ store });
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, HOST, resolve);
});

const url = `http://${HOST}:${PORT}`;
console.log(`替身服务已启动：${url}/?view=advice（不碰 DPAPI，账号是内存里的虚拟账号）`);
for (const [i, preset] of presets.entries()) {
  const snap = accounts[i].snapshots?.[Object.keys(accounts[i].snapshots || {})[0]];
  const chars = snap?.characters?.length || 0;
  console.log(`  · ${preset.title}｜角色 ${chars} 个｜uid ${accounts[i].roles?.[0]?.uid || '?'}`);
}
console.log(`CDP 套件：node tools/check-advice-layout.mjs --url=${url}/`);

const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
