// 把黑塔网数据集用到的图标 / 立绘**镜像到本地**（一次性，之后完全离线可用）。
//
// 用户 2026-10-10 的原话：「这些图标是会完全重新到网上读取吗？能不能下载到本地，
// 方便以后读取，这样不容易出现渲染问题」。
// 2026-10-22 追加：「**已获取的所有图片保留在本地默认永不删除**，可点击按钮重新更新
// 并获取图片」—— 那个按钮（界面右上角「更新图片」）与服务端 `/icons/*` 的现抓落盘
// 都跑 `src/server/icon-fetch.js` 里**同一份实现**，本脚本现在只是它的 CLI 外壳。
//
// ⚠️ 为什么必须是外壳而不是各写一份：抄第二份的下场是「脚本能下全、按钮只下一半」，
//    而两边都叫「更新图片」。原来的下载 / 断点续传 / 清单生成逻辑已整体搬进
//    `src/server/icon-fetch.js`（`mirrorIcons()`），行为逐条保留。
//
// 为什么**不进 git**：`theherta/` 其余内容是入库的，但图标是**可再生的派生资源**
// （跑一次本脚本就有），70 MB 二进制塞进历史只是给所有人增加 clone 体积。所以
// `theherta/icons/` 进 `.gitignore`，由本脚本（或界面按钮）负责重建。
//
// 用法：
//   node tools/herta-icons.mjs                 # 全量（头像 + 光锥 + 命途 + 属性 + 立绘 + 卡面）
//   node tools/herta-icons.mjs --only=icons    # 只要头像 / 光锥 / 命途 / 属性（约 15 MB）
//   node tools/herta-icons.mjs --only=previews # 只要立绘 / 卡面
//   node tools/herta-icons.mjs --force         # 已存在也重下（CDN 换了图时用；**不会删任何文件**）
//   node tools/herta-icons.mjs --dry           # 只报计划与体积，不下载
//
// 断点续传：**已存在且非空就跳过**，所以中断后重跑不会白费。
import { iconPlanOf, mirrorIcons } from '../src/server/icon-fetch.js';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

const ONLY = arg('only', 'all');
const FORCE = has('force');
const DRY = has('dry');
const CONCURRENCY = Number(arg('concurrency', '8'));

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const { items } = await iconPlanOf(ONLY);
if (!items.length) {
  console.error('没有可镜像的条目 —— 先跑 node tools/herta-i18n.mjs 生成 theherta/i18n-zh.json');
  process.exit(1);
}

console.log(`图标本地化 · ${items.length} 个文件`);
const byGroup = new Map();
for (const item of items) byGroup.set(item.group, (byGroup.get(item.group) || 0) + 1);
for (const [label, count] of byGroup) console.log(`  ${label.padEnd(26)} ${count} 张`);
console.log('  目标目录：theherta/icons');
console.log(`  模式：${DRY ? '只报计划（--dry）' : FORCE ? '全部重下（--force）' : '跳过已存在的'}`
  + `${ONLY !== 'all' ? `  仅 ${ONLY}` : ''}`);
console.log('');

if (DRY) {
  // 只报体积：HEAD 拿 content-length（部分 CDN 对 HEAD 不友好，失败就略过）。
  let total = 0;
  let unknown = 0;
  for (const item of items) {
    try {
      const res = await fetch(item.url, { method: 'HEAD' });
      if (res.ok) total += Number(res.headers.get('content-length') || 0);
      else unknown += 1;
    } catch { unknown += 1; }
  }
  console.log(`预计体积：${mb(total)}（另有 ${unknown} 个拿不到 HEAD，按实际下载为准）`);
  process.exit(0);
}

const started = Date.now();
const result = await mirrorIcons({
  only: ONLY,
  force: FORCE,
  concurrency: CONCURRENCY,
  onProgress: ({ done, skipped, total }) => {
    process.stdout.write(`\r  新增 ${done}  跳过 ${skipped}  共 ${total}   `);
  },
});
process.stdout.write('\n\n');

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`完成：新增 ${result.added} 张（${mb(result.bytes)}），跳过 ${result.skipped} 张，用时 ${seconds}s`);
if (result.failures.length) {
  console.log(`⚠️ 失败 ${result.failed} 张（重跑本脚本即可续传）：`);
  for (const failure of result.failures.slice(0, 10)) console.log(`   ${failure.rel} — ${failure.message}`);
  if (result.failures.length > 10) console.log(`   …还有 ${result.failures.length - 10} 个`);
  process.exitCode = 1;
}
console.log(`清单：theherta/icons/manifest.json（${result.files} 个文件）`);
console.log('提示：图标**不入 git**（可再生资源），换机器后重跑一次本脚本即可。');
