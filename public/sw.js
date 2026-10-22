// Service Worker：安卓「添加到主屏幕」后离线壳与秒开缓存。
//
// 策略（2026-10-21，安卓端 PWA 化）：
//   * 静态壳（HTML/CSS/JS/manifest/图标）：stale-while-revalidate —— 秒开，后台刷新；
//   * 导航请求（页面本身）：network-first，离线时回落缓存壳（保持可打开，数据提示离线）；
//   * **绝不缓存** /api/*（数据必须实时，离线时让界面自然显示失败并提示）；
//   * /icons/*（角色头像镜像 + CDN 302 回落）不缓存 —— 资源太大且随数据集变动，
//     浏览器自己的 HTTP 缓存（immutable 长缓存）已经覆盖。
//
// 版本号 CACHE_VERSION 变更即全量换缓存（activate 清旧）。

// ⚠️ **发版时跟着改**（2026-10-22 起写具体版本号）。
//
// 静态资源是 stale-while-revalidate：先给缓存里的旧 JS、后台再刷新 —— 于是「服务端已经是
// 新版、页面这一趟跑的还是旧 JS」是**常态**，下一趟才对齐。v4.6.145 就撞上了：新 index.html
// （网络优先，立刻生效）配旧 advice-view.js（缓存）⇒「不使用」那一块是空的、每张卡也没有
// 「排除此配队」，而旧 JS 又不发 exclude 字段，服务端那条分支当场 ReferenceError，
// 整个抽卡方案页变成一句「尚未采集资料」。改版本号 = 全量换缓存，能一次性对齐。
const CACHE_VERSION = 'v4.6.150';
const CACHE_NAME = `hsr-advisor-shell-${CACHE_VERSION}`;
const SHELL = [
  '/',
  '/index.html',
  '/styles/app.css',
  '/styles/advice-tip-window.css',
  '/manifest.webmanifest',
  '/app-icon-192.png',
  '/app-icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL);
    // 不等待激活：装完即让 SW 进入 waiting 之外的状态也无妨，页面刷新会接管。
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // 数据接口与图标镜像：一律直连网络（失败时交给页面自己的错误处理）。
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/icons/')) return;
  if (url.origin !== self.location.origin) return; // CDN 立绘等交给 HTTP 缓存

  // 页面导航：network-first，离线回落壳。
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(event.request);
        const cache = await caches.open(CACHE_NAME);
        cache.put('/index.html', fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('/index.html')) || Response.error();
      }
    })());
    return;
  }

  // 其余同源静态：stale-while-revalidate。
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    const refresh = fetch(event.request).then((res) => {
      if (res && res.ok) cache.put(event.request, res.clone());
      return res;
    }).catch(() => undefined);
    return cached || (await refresh) || Response.error();
  })());
});
