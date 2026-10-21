// 一次性探针：手机宽度下页面有没有横向溢出？谁在溢出？
//
// 背景（2026-10-21，feat/android-client 调研「如何提供给安卓端用户」）：
//   390px 无头截图里顶栏右侧的「角色信息」页签和二维码卡片被切出屏幕右缘，
//   但 CSS 里 `.layout` 在 ≤1000px 明明已收成单列 —— 需要量化确认是哪一层在溢出。
//
// 做法：Node 22 自带 WebSocket（无需任何依赖），连无头浏览器的 CDP，
//   `Runtime.evaluate` 拿 scrollWidth 与「右缘超出视口的元素」清单。
//
// 用法：
//   1. 起服务： node bin/serve.mjs --port 8361
//   2. 起浏览器：
//      msedge.exe --headless=new --disable-gpu --remote-debugging-port=9224
//                 --user-data-dir=<临时目录> about:blank
//   3. node tools/_probe-mobile-viewport.mjs --width=390 [--url=http://127.0.0.1:8361/]

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const WIDTH = Number(arg('width', '390')) || 390;
const URL_BASE = arg('url', 'http://127.0.0.1:8361/');
const DEBUG_PORT = Number(arg('cdp', '9224')) || 9224;

const listTargets = async () => {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`);
  if (!res.ok) throw new Error(`调试端口 ${DEBUG_PORT} 应答 ${res.status}`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('调试端口里没有页面目标');
  return page.webSocketDebuggerUrl;
};

const cdpCall = (ws, method, params = {}) => new Promise((resolve, reject) => {
  const id = ws.__nextId += 1;
  const onMsg = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== id) return;
    ws.removeEventListener('message', onMsg);
    if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
    else resolve(msg.result);
  };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id, method, params }));
});

const main = async () => {
  const wsUrl = await listTargets();
  const ws = new WebSocket(wsUrl);
  ws.__nextId = 0;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });

  // Emulation.setDeviceMetricsOverride：真手机宽度 + DPR=2 + mobile 标志，
  // 比把窗口开成 390 更接近真机（真机还有 meta viewport 的缩放逻辑）。
  await cdpCall(ws, 'Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await cdpCall(ws, 'Page.enable');
  await cdpCall(ws, 'Page.navigate', { url: URL_BASE });
  // 等首屏稳定（fetch /api/archive + 渲染）。
  await new Promise((r) => setTimeout(r, 6000));

  const { result, exceptionDetails } = await cdpCall(ws, 'Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const vw = document.documentElement.clientWidth;
      const sw = document.documentElement.scrollWidth;
      const offenders = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 1) {
          offenders.push({
            tag: el.tagName.toLowerCase(),
            cls: String(el.className && el.className.baseVal === undefined ? el.className : '').slice(0, 60),
            right: Math.round(r.right), width: Math.round(r.width),
          });
        }
      }
      // 按right排序，只留最外层肇事的（有父元素也溢出的只留父级）
      const picked = offenders.filter((o, i) => !offenders.some((p, j) => j !== i && p.right >= o.right && p.width >= o.width * 0.95 && p.right - o.right < 40));
      return JSON.stringify({ vw, sw, overflow: sw - vw, offenders: picked.slice(0, 12) }, null, 1);
    })()`,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'evaluate failed');
  console.log(`viewport ${WIDTH}px →`, result.value);
  ws.close();
};

main().catch((err) => { console.error('探针失败：', err.message); process.exit(1); });
