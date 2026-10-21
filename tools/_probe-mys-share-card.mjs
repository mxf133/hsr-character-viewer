// 米游社「观星一览」分享长图的**结构实测探针**（2026-10-21，docs/米游社截图导入方案.md 的证据）。
//
// 用法：
//   node tools/_probe-mys-share-card.mjs <分享长图.jpg> [--out <输出目录>]
//
// 做什么（全部零依赖，node 内置 + 可选 jsqr/jpeg-js 做二维码与 JPEG 解码）：
//   1. 行投影找「卡片行带」（暗色像素密度）、列投影找三列 portrait 的 x 跨度；
//   2. 数出卡片数，与头部「在游戏中已与N名角色邂逅」对账；
//   3. 按实测偏移切「名字条」（portrait 底缘）与「Lv/星魂条」（白 panel 顶），
//      各拼成一张 montage 供人工核验 OCR 输入质量。
//
// 实测结论（样图 1264x7917，用户 2026-10-21 提供）：
//   * 21~22 个卡片行带 × 3 列 = 63~66 张卡，与头部宣称 66 对账（边界行依赖阈值）；
//   * 行 pitch ≈ 320、列 pitch ≈ 367，但 **5★(金底) 与 4★(紫底) 两区段的几何不同**
//     —— 生产实现必须用连通域找卡，不能写死 pitch；
//   * 名字条 = portrait 底缘（暗带结束线下方 ~50px 内），白字带描边、高对比；
//   * Lv/星魂条 = 白 panel 顶部，格式恒为 `Lv.NN ❖ N`；
//   * 底部二维码解码为 mhyurl.cn 短链 → 只跳战绩 H5（无数据参数、要登录态），
//     **不是数据捷径**；但解码出的 UID 可用于对账。

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const main = async () => {
  const input = process.argv[2];
  if (!input) { console.error('用法: node tools/_probe-mys-share-card.mjs <分享长图.jpg> [--out <目录>]'); process.exit(1); }
  const outDir = arg('out', '.tmp-mys-share');
  fs.mkdirSync(outDir, { recursive: true });

  // jpeg-js / jsqr 在仓库外临时安装（本探针只在调研时跑，不进生产依赖）：
  //   npm install --prefix <node_modules 目录> jpeg-js jsqr
  const mods = arg('modules', null);
  if (!mods) {
    console.error('需要 --modules=<含 jpeg-js 与 jsqr 的 node_modules 目录>（npm install --prefix 那里 jpeg-js jsqr）');
    process.exit(1);
  }
  const { createRequire } = await import('node:module');
  const require2 = createRequire(mods + '/x.js');
  const jpeg = require2('jpeg-js');
  let jsQR = null;
  try { jsQR = require2('jsqr'); } catch { console.warn('[warn] 没有 jsqr，跳过二维码解码'); }

  const img = jpeg.decode(fs.readFileSync(input), { useTArray: true, maxMemoryUsageInMB: 2048 });
  const W = img.width, H = img.height;
  console.log(`图片 ${W}x${H}`);

  const lum = (i) => 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
  const rowDark = new Float32Array(H);
  for (let y = 0; y < H; y++) { let c = 0; for (let x = 0; x < W; x += 2) if (lum(y * W + x) < 150) c++; rowDark[y] = c; }

  const bands = [];
  let start = -1;
  for (let y = 500; y < H; y++) {
    const on = rowDark[y] > 40;
    if (on && start < 0) start = y;
    if (!on && start >= 0) { if (y - start > 120) bands.push([start, y]); start = -1; }
  }
  if (start >= 0) bands.push([start, H]);
  const cardBands = bands.filter(([a, b]) => b - a > 150 && a > 600 && b < H - 60);
  console.log(`卡片行带 ${cardBands.length} 个（首 ${cardBands[0]}，末 ${cardBands[cardBands.length - 1]}）`);
  const pitches = cardBands.slice(1).map((b, i) => b[0] - cardBands[i][0]);
  console.log(`行 pitch min/med/max = ${Math.min(...pitches)}/${pitches.sort((a, b) => a - b)[pitches.length >> 1]}/${Math.max(...pitches)}`);

  // 列跨度：在中间一条带内做列投影
  const [by0, by1] = cardBands[(cardBands.length / 2) | 0];
  const colDark = new Float32Array(W);
  for (let x = 0; x < W; x++) { let c = 0; for (let y = by0; y < by1; y += 2) if (lum(y * W + x) < 150) c++; colDark[x] = c; }
  const cols = [];
  let cs = -1;
  for (let x = 0; x < W; x++) {
    const on = colDark[x] > 20;
    if (on && cs < 0) cs = x;
    if (!on && cs >= 0) { if (x - cs > 100) cols.push([cs, x]); cs = -1; }
  }
  if (cs >= 0) cols.push([cs, W]);
  console.log(`列跨度（中间行带实测）: ${JSON.stringify(cols)} → ${cols.length} 列`);
  console.log(`卡片总数 ≈ ${cardBands.length * cols.length}（与头部「已与N名角色邂逅」对账）`);

  if (jsQR) {
    const x0 = Math.floor(W * 0.5), y0 = Math.floor(H * 0.9);
    const cw = W - x0, ch = H - y0;
    const data = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const si = ((y0 + y) * W + (x0 + x)) * 4, di = (y * cw + x) * 4;
      data[di] = img.data[si]; data[di + 1] = img.data[si + 1]; data[di + 2] = img.data[si + 2]; data[di + 3] = 255;
    }
    const qr = jsQR(data, cw, ch);
    console.log(`底部二维码: ${qr ? qr.data : '未解出'}`);
  }

  // 名字条 / Lv 条 montage（供人工核验）
  const colX = cols.map(([a, b]) => [a - 15, b + 1]);
  const nameStrips = [], lvStrips = [];
  for (const [b0, b1] of cardBands) for (const [x0, x1] of colX) {
    nameStrips.push([x0, b1 - 14, x1 - x0, 60]);
    lvStrips.push([x1 + 10, b0 + 30, 150, 46]);
  }
  const encode = (buf, w, h, file) => fs.writeFileSync(file, jpeg.encode({ data: buf, width: w, height: h }, 92).data);
  const montage = (list, fh, file) => {
    const perRow = 6, gap = 6;
    const rowsN = Math.ceil(list.length / perRow);
    const cw = Math.max(...list.map((s) => s[2]));
    const OW = cw * perRow + gap * (perRow + 1), OH = rowsN * (fh + gap) + gap;
    const out = Buffer.alloc(OW * OH * 4, 255);
    list.forEach((s, i) => {
      const ox = gap + (i % perRow) * (cw + gap), oy = gap + ((i / perRow) | 0) * (fh + gap);
      for (let y = 0; y < fh && y < s[3]; y++) for (let x = 0; x < cw && x < s[2]; x++) {
        const si = ((s[1] + y) * W + (s[0] + x)) * 4, di = ((oy + y) * OW + (ox + x)) * 4;
        out[di] = img.data[si]; out[di + 1] = img.data[si + 1]; out[di + 2] = img.data[si + 2]; out[di + 3] = 255;
      }
    });
    encode(out, OW, OH, `${outDir}/${file}`);
    console.log(`已写 ${outDir}/${file}（${list.length} 条）`);
  };
  montage(nameStrips, 60, 'names.jpg');
  montage(lvStrips, 46, 'levels.jpg');
};

import fs from 'node:fs';
main().catch((err) => { console.error('探针失败：', err.message); process.exit(1); });
