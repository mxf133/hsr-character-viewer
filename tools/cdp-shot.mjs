// 用无头 Edge + CDP 把**真页面**拍成 PNG，供人（或模型）逐块看排版。
//
// 为什么需要它：`tools/check-advice-layout.mjs` 是判据式的（断言某个盒子多宽、某两行
// 差几像素），它回答「有没有破规矩」；但「这块留白是不是太空 / 这张卡是不是太长」
// 这类问题只能靠眼睛。2026-10-19 那一轮显示效果打磨就是靠这个工具量化出来的
// （整页 12823px → 10067px、单张方案卡 446 → 329）。
//
//   node tools/cdp-shot.mjs --url=http://127.0.0.1:8361/ --out=shot.png
//   node tools/cdp-shot.mjs --attach --port=9222 --url=... --scroll=1400 --height=1400
//
// 参数：
//   --url=<地址>        要拍的页面（默认 http://127.0.0.1:8361/，即 `cdp-serve.mjs` 的默认端口）
//   --out=<路径>        输出 PNG（目录不存在会自动建）
//   --width/--height    视口（默认 1600×1200；`deviceScaleFactor` 固定 2，截图是两倍图）
//   --wait=<ms>         导航后等多久（默认 3000）—— 抽卡推荐页要等 `conclusion` + `plan`
//                       两次 POST 回来，实测 6~9 秒才稳定
//   --click=<选择器>    **可重复**：进页面后点一下（用来切分页 / 展开 details），每次点完等 1.8s
//   --js=<表达式>       **可重复**：执行并打印结果，用来量尺寸（`--js` 不产出图也行，写 --out 忽略）
//   --scroll=<px>       先滚到指定位置再拍
//   --full              整页截图 —— ⚠️ 抽卡推荐页现在 1 万像素高，Chrome 的
//                       `captureBeyondViewport` 会拍出一张全白的图，改用 --scroll 分段拍
//   --attach            连**已经开着**的调试端口（不再是新拉一个浏览器）——
//                       后台起的浏览器在会话边界会被回收，用 --attach 时要保证它还在
//   --port=<n>          调试端口（默认 9331）
//   --profile=<dir>     用户数据目录（默认 `%TEMP%\edge-shot-<时间戳>`）
//
// 已知坑（都踩过）：
//   * 本机用户名是 `1` 而不是仓库目录名里的 `mxf13` —— 仓库在一台机器的 UNC 路径上，
//     浏览器跑在另一台。写死 `C:\Users\<user>\...` 会让 Edge 直接起不来（无输出、非零退出）。
//   * `--headless=new` 是必须的：沙箱里非 headless 的 Edge 会被 crashpad 自杀。
//   * 每次跑都会新建一个 profile 目录，几十次之后 `%TEMP%` 能堆到 3 GB ——
//     量完记得清（`node .workbuddy/_clean-tmp.mjs` 之类）。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const flag = (n) => process.argv.includes(`--${n}`);

const URL_OPEN = arg('url', 'http://127.0.0.1:8361/');
const OUT = resolve(arg('out', '.workbuddy/shots/page.png'));
const W = Number(arg('width', '1600'));
const H = Number(arg('height', '1200'));
const WAIT = Number(arg('wait', '3000'));
const PORT = Number(arg('port', '9331'));
const PROFILE = arg('profile', (process.env.TEMP || '/tmp') + '/edge-shot-' + Date.now());
const ATTACH = flag('attach');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = async (url) => (await fetch(url)).json();

const main = async () => {
  const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
  const proc = ATTACH ? null : spawn(edge || EDGE_CANDIDATES[0], [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${W},${H}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  let ver = null;
  for (let i = 0; i < 60; i += 1) {
    try { ver = await getJSON(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(250); }
  }
  if (!ver) {
    console.log('EDGE_START_FAIL（没装 Edge/Chrome，或 profile 路径不可写）');
    if (proc) proc.kill();
    process.exit(1);
  }

  const targets = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  let page = targets.find((t) => t.type === 'page');
  if (!page) {
    await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
    await sleep(500);
    page = (await getJSON(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page');
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    id += 1;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: false,
  });
  await send('Page.navigate', { url: URL_OPEN });
  await sleep(WAIT);

  const clicks = process.argv.filter((a) => a.startsWith('--click=')).map((a) => a.slice(8));
  for (const sel of clicks) {
    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return 'NO_EL';
        el.click();
        return 'CLICKED';
      })()`,
      returnByValue: true,
    });
    console.log('CLICK ' + sel + ' -> ' + (r.result?.value || '?'));
    await sleep(1800);
  }

  const exprs = process.argv.filter((a) => a.startsWith('--js=')).map((a) => a.slice(5));
  for (const ex of exprs) {
    const r = await send('Runtime.evaluate', {
      expression: ex, returnByValue: true, awaitPromise: true,
    });
    console.log('JS ' + JSON.stringify(r.result?.value ?? r.result?.description ?? null));
  }

  const scrollTo = Number(arg('scroll', '0'));
  if (scrollTo > 0) {
    await send('Runtime.evaluate', { expression: `window.scrollTo(0, ${scrollTo})` });
    await sleep(900);
  }

  // 字体就绪 + 图表 CSS 过渡收尾，再拍。
  await send('Runtime.evaluate', {
    expression: 'document.fonts ? document.fonts.ready.then(()=>1) : 1',
    awaitPromise: true,
  });
  await sleep(1200);

  if (!exprs.length) {
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: flag('full'),
      ...(flag('full') ? {
        clip: await (async () => {
          const m = await send('Page.getLayoutMetrics');
          const h = Math.ceil(m.cssContentSize?.height || m.contentSize.height);
          return { x: 0, y: 0, width: W, height: Math.min(h, 20000), scale: 1 };
        })(),
      } : {}),
    });
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log('SAVED ' + OUT);
  }

  ws.close();
  if (proc) proc.kill();
  await sleep(300);
  process.exit(0);
};

main().catch((e) => { console.log('FAIL ' + e.message); process.exit(1); });
