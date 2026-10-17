// HTTP server: JSON API + static GUI.
//
// Security posture:
//   * binds to 127.0.0.1 by default (override with HOST),
//   * cookie material never leaves the server,
//   * mutating endpoints require an unguessable per-process path token,
//   * optional shared-secret gate via DSH_HSR_TOKEN for LAN use.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { AccountStore } from './store.js';
import { CACHE_TTL_MS, REFETCH_MESSAGES, cacheMeta, createRefetchGate } from './cache-policy.js';
import { serveStatic } from './static.js';
import { createQRCode, toSVG } from '../qr/qrcode.js';
import {
  dropSession, fetchAllGameRoles, fetchGameRoles, getSession, normalizeManualCookie,
  pollQrLogin, startQrLogin,
} from '../mihoyo/auth.js';
import { fetchSnapshot, gameDescriptors, getPrivacySwitches, setPrivacySwitch } from '../mihoyo/games.js';
import { MihoyoError } from '../mihoyo/errors.js';
import { cachedFingerprint, fetchDeviceFingerprint } from '../mihoyo/devicefp.js';
import { archiveExists, archiveIndex, archiveStats, enemiesForRecords, loadI18n } from './archive.js';
import {
  TRAILBLAZER_AVATARS, VIRTUAL_PRESETS, buildVirtualAccount, customRosterPreset, nextVirtualUid,
  normalizeRoster, presetById, presetContext, presetContextRefs, signatureCones, withSignatureCones,
} from './virtual-accounts.js';
import { charCostOf, coneCostOf } from '../../public/scripts/advice.js';
import { archiveConclusion, archiveCharacterPacks } from './conclusion.js';
import { limitedCountOf } from './limited-count.js';
import { compareRosters } from './compare.js';
import { fetchBattleRecordsRaw, normalizeBattleRecords } from './records.js';
import { datasetStats, pruneBackups, updateArchive, updateInProgress } from './archive-update.js';
import { challengePathFor, completeVerification, createVerification, dropVerification } from '../mihoyo/verification.js';
import { APP_VERSION, enabledGames, gameByBiz, isGameEnabled, regionFromUid, regionName } from '../mihoyo/constants.js';
import { GAME_VERSION, PROGRAM_VERSION, VERSION_TEXT } from '../version.js';
import { checkForUpdate } from './update-check.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, '../../public');
// 本地图标镜像（`node tools/herta-icons.mjs` 拉下来的，可再生资源、不入 git）。
// 放在 public 之外：这些是**几十 MB 的二进制**，不该混进要部署的静态目录；
// 由下面那条 `/icons/*` 路由单独伺服。
const ICONS_DIR = resolve(here, '../../theherta/icons');

const MAX_BODY = 64 * 1024;

/**
 * 把**真实账号的一份快照**反解成虚拟账号的「名单原文」（用户 2026-10-14 第 5 条
 * 「新增与用户真实账号完全一致的虚拟账号」）。
 *
 * 口径：
 *   * 快照里的名字是**中文**（米游社给的），要按 `i18n` 反查数据集英文键 ——
 *     查不到的单位**跳过并计数**（`skipped`），不猜、不硬塞；
 *   * 星魂直接抄 `rank`/`actived_constellation_num`，**吸附到 E0/E1/E2/E6 交给
 *     `normalizeRoster`**（同一处口径，不在这里再写一遍）；
 *   * 光锥取 `equip`（米游社只返回**装备中**的那一把）：名字反查成英文键，
 *     叠影抄 `equip.rank`，并登记 `charCones[角色] = 光锥`；
 *   * 开拓者只记**头像 id**（8001..8010 合法时），命途行不进 `chars` —— 虚拟账号的
 *     开拓者按用户第 4 条只有一行（见 `buildVirtualAccount`）。
 */
const rosterFromSnapshot = (snapshot, i18n) => {
  const charByZh = new Map();
  for (const [en, zh] of Object.entries(i18n?.characters || {})) {
    if (zh && !charByZh.has(zh)) charByZh.set(zh, en);
  }
  const coneByZh = new Map();
  for (const [en, zh] of Object.entries(i18n?.lightCones || {})) {
    if (zh && !coneByZh.has(zh)) coneByZh.set(zh, en);
  }
  const chars = {};
  const cones = {};
  const charCones = {};
  let trailblazer = null;
  let skipped = 0;
  for (const row of snapshot?.characters || []) {
    const name = String(row?.name || '').trim();
    if (!name) continue;
    const id = Number(row?.id);
    // 开拓者：名字或头像 id 命中都算；只取一个合法头像 id，命途行不进 `chars`。
    if (/trailblazer|\{nickname\}|开拓者/i.test(name) || (id >= 8001 && id <= 8010)) {
      if (id >= 8001 && id <= 8010) trailblazer = { id };
      else if (!trailblazer) trailblazer = { id: 8001 };
      continue;
    }
    const key = charByZh.get(name);
    if (!key) { skipped += 1; continue; }
    chars[key] = Number(row?.rank ?? row?.actived_constellation_num ?? 0) || 0;
    const coneName = String(row?.equip?.name || '').trim();
    if (!coneName) continue;
    const coneKey = coneByZh.get(coneName);
    if (!coneKey) { skipped += 1; continue; }
    charCones[key] = coneKey;
    cones[coneKey] = Math.max(1, Number(row?.equip?.rank) || 1);
  }
  return { chars, cones, charCones, trailblazer, skipped };
};

const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

const readBody = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new MihoyoError('请求体过大', { code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new MihoyoError('请求体不是合法 JSON', { code: 'BAD_JSON' });
  }
};

const constantTimeEquals = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

const isLoopbackHost = (host) => {
  const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1'
    || value === '127.0.0.1' || value.startsWith('127.');
};

/**
 * @param {{ port?:number, host?:string, store?:AccountStore }} [options]
 */
/**
 * Refresh the role list for every supported game and tag each role with its game.
 * Runs the per-game calls sequentially (the HTTP layer additionally throttles).
 */
const refreshRoles = async (store, account) => {
  // Make sure a device fingerprint exists early: the role-list call itself does
  // not need one, but every record request that follows will.
  await ensureFingerprint(store, account);
  // Only ask about games we actually expose - a disabled game's button is
  // hidden, so fetching its roles would produce entries the GUI cannot show.
  const bizList = enabledGames().map((g) => g.gameBiz);
  const raw = await fetchAllGameRoles(account.cookie, account.deviceId, bizList);
  const roles = [];
  const errors = [];
  for (const r of raw) {
    if (r.__error) { errors.push({ gameBiz: r.__gameBiz, message: r.__error, retcode: r.__retcode }); continue; }
    const game = gameByBiz(r.game_biz);
    if (!game || !isGameEnabled(game.key)) continue;
    roles.push({ ...r, game: game.key });
  }
  await store.setRoles(account.id, roles);
  return { roles, errors };
};

/**
 * Ensure the account has a fresh `x-rpc-device_fp`, acquiring and caching one
 * when needed. Mirrors Snap Hutao's `UserFingerprintService.TryInitializeAsync`
 * (7-day reuse window). A missing fingerprint is never fatal - the record API
 * still answers without it - so failures degrade to `undefined`.
 */
const ensureFingerprint = async (store, account) => {
  const cached = cachedFingerprint(account);
  if (cached) return cached;
  const fp = await fetchDeviceFingerprint(account.deviceId, {
    existingFp: account.fingerprint || undefined,
  });
  if (fp) {
    await store.setFingerprint(account.id, fp);
    console.log(`[fp] 已获取设备指纹（账号 ${account.accountId}）`);
  }
  // Fall back to a stale value rather than sending nothing.
  return fp || account.fingerprint || undefined;
};

export const createApp = (options = {}) => {
  const store = options.store || new AccountStore();
  const loadBattleRecords = options.fetchBattleRecordsRaw || fetchBattleRecordsRaw;
  // 回源闸门：决定「这一次要不要真的去打米游社」。
  //
  // 用户 2026-10 明确要求「不需要每次刷新都去更新数据，过多的请求会导致数据爬取出错」。
  // 以前这里是「缓存超过 15/30 分钟就自动重抓」，于是每刷新一次页面、每切一次
  // 抽卡推荐页都会自动打一次米游社；风控（10041 / 5003 / 1034）按频率累计，
  // 请求一密就整片拒绝。现在**有本地数据时读取一律不联网**，只有显式刷新才走网络，
  // 且最小间隔由 `minIntervalMs` 限流。详见 src/server/cache-policy.js 的注释。
  const refetchGate = options.refetchGate || createRefetchGate({
    minIntervalMs: options.minRefetchIntervalMs,
  });
  // Per-process CSRF-ish token: the GUI fetches it from /api/config and echoes
  // it on mutating requests.
  const csrfToken = randomBytes(24).toString('hex');
  const sharedSecret = options.accessToken || process.env.DSH_HSR_TOKEN || '';

  const authorize = (req) => {
    if (!sharedSecret) return true;
    const provided = req.headers['x-hsr-token'];
    return typeof provided === 'string' && constantTimeEquals(provided, sharedSecret);
  };

  const requireCsrf = (req) => {
    const provided = req.headers['x-hsr-csrf'];
    return typeof provided === 'string' && constantTimeEquals(provided, csrfToken);
  };

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;

    try {
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          json(res, 405, { ok: false, error: '不支持的请求方法' });
          return;
        }
        // ---- 本地图标镜像（`node tools/herta-icons.mjs` 拉下来的）----
        //
        // 用户 2026-10-10：「这些图标是会完全重新到网上读取吗？能不能下载到本地」。
        //
        // 路由形状刻意与CDN 的**相对路径一致**（`/icons/icon/character/1224.png` 对应
        // `<CDN>/icon/character/1224.png`），于是前端只要把 base 从 CDN 换成 `/icons`
        // 即可，**图标表里的键一个都不用改**。
        //
        // ⚠️ 必须在**静态分支里**、且在 `serveStatic(PUBLIC_DIR)` **之前**：
        //   * `public/` 下没有这些文件，放到后面会被404 掉；
        //   * `serveStatic` 只认真`public` 下的路径，换个 root 就行不通了。
        // ⚠️ **不要**走 `authorize`：`<img src>` 不会带自定义请求头，带令牌检查就全挂。
        //    这里是本机回环服务的静态资源，与凭证无关（真要收紧就把 `/icons` 放进
        //    public，并改成从 public 里伺服）。
        //
        // 缺失的文件回落到 `?fallback=<完整 CDN 地址>`（302 出去）而不是直接 404：
        // 只跑了 `--only=icons` 时立绘 / 卡面本地没有，这是**预期**状态。
        if (path === '/icons/manifest.json' || path.startsWith('/icons/')) {
          const served = await serveStatic(req, res, ICONS_DIR,
            path === '/icons/manifest.json' ? '/manifest.json' : path.slice('/icons'.length),
            // 图标是不可变资源（文件名就是内容哈希式的 id），可以放心长缓存。
            // 清单会随重新拉取而变，所以给它短一点的。
            { cacheControl: path.endsWith('manifest.json')
              ? 'no-cache'
              : 'public, max-age=604800, immutable' });
          if (served) return;
          const fallback = url.searchParams.get('fallback');
          if (fallback && /^https:\/\/cdn\.jsdelivr\.net\//.test(fallback)) {
            // 302 而不是在本机代理：省掉再读一遍公网带子的开销，也让浏览器按 CDN 自己
            // 的缓存头（实测 `max-age=604800`）来处理。
            res.writeHead(302, { Location: fallback, 'Cache-Control': 'no-store' });
            res.end();
            return;
          }
          json(res, 404, {
            ok: false,
            error: `本地没有这张图：${path}`,
            hint: '运行 node tools/herta-icons.mjs 拉取图标到本地',
          });
          return;
        }
        const served = await serveStatic(req, res, PUBLIC_DIR, req.url || '/');
        if (!served) {
          json(res, 404, { ok: false, error: `未找到 ${path}` });
        }
        return;
      }

      if (!authorize(req)) {
        json(res, 401, { ok: false, error: '缺少或错误的访问令牌（x-hsr-token）' });
        return;
      }

      // ---- public config -------------------------------------------------
      if (path === '/api/config' && req.method === 'GET') {
        await store.load();
        json(res, 200, {
          ok: true,
          csrfToken,
          appVersion: APP_VERSION,
          // 本工具自己的版本（和游戏环境对齐），与上面的 appVersion
          // （米游社客户端版本，仅用于签名）不是一回事。
          programVersion: PROGRAM_VERSION,
          gameVersion: GAME_VERSION,
          versionText: VERSION_TEXT,
          games: gameDescriptors(),
          accounts: (await store.listAccounts()).map(AccountStore.toPublic),
        });
        return;
      }

      // ---- 和 GitHub 上的最新发布比一比（用户 2026-10-14 第 5 条）------------------
      //
      // ⚠️ **这是全程序唯一一条「点一下才出去」的额外外网出口**（另一条是「同步黑塔网
      //    数据」）。启动、开页面、切分页都**不会**走到这里 —— 用户原话要的就是「点击
      //    提示」，所以只有 `?check=1` 时才真的打 GitHub；不带参数只回本地版本号，
      //    这样界面可以先把版本号显示出来（用户第 5 条后半句：「显示此程序的版本号」）。
      //
      // 取不到时回 200 + `ok:false`（与上面几条 archive 路由同一种降级风格）：
      // 界面要区分「已是最新 / 有更新 / 没问成」三种结果，而 500 只会让它显示一句
      // 「请求失败」，真实原因（超时 / 限流 / 断网）就丢了。
      if (path === '/api/update-check' && req.method === 'GET') {
        if (url.searchParams.get('check') !== '1') {
          json(res, 200, {
            ok: true, status: 'unchecked', current: PROGRAM_VERSION, latest: null,
          });
          return;
        }
        // `?force=1` 跳过 10 分钟缓存（用户连点「检查更新」时用不上，留给探针/排障）。
        const result = await checkForUpdate({ force: url.searchParams.get('force') === '1' });
        json(res, 200, result);
        return;
      }

      // ---- theherta archive (offline dataset for the recommendation tab) --
      // Entirely local: these routes never touch the network, so the
      // recommendation page works even when miHoYo or theherta.com is blocked.
      // Any read failure (missing file, half-written dataset) degrades to the
      // same "not collected yet" payload rather than a 500, because the GUI can
      // act on that and cannot act on an internal error.
      if (path === '/api/archive' && req.method === 'GET') {
        const unavailable = {
          ok: true,
          available: false,
          hint: '尚未采集资料。请在项目目录运行：node tools/herta-fetch.mjs && node tools/herta-build.mjs',
        };
        try {
          if (!(await archiveExists())) { json(res, 200, unavailable); return; }
          json(res, 200, await archiveIndex());
        } catch (err) {
          console.warn('[archive] 读取索引失败：', err.message);
          json(res, 200, { ...unavailable, detail: err.message });
        }
        return;
      }

      if (path === '/api/archive/stats' && req.method === 'GET') {
        const unavailable = {
          ok: true,
          available: false,
          hint: '尚未采集资料。请在项目目录运行：node tools/herta-fetch.mjs && node tools/herta-build.mjs',
        };
        try {
          if (!(await archiveExists())) { json(res, 200, unavailable); return; }
          const mode = url.searchParams.get('mode') || 'moc';
          const season = url.searchParams.get('season') || '';
          const window = url.searchParams.get('window') || '6';
          const stage = url.searchParams.get('stage');
          const perBand = url.searchParams.get('perBand') || '8';
          const stats = await archiveStats(mode, season, {
            window, perBand, stage: stage === null ? undefined : stage,
          });
          json(res, stats.ok ? 200 : 404, stats);
        } catch (err) {
          console.warn('[archive] 读取统计失败：', err.message);
          json(res, 200, { ...unavailable, detail: err.message });
        }
        return;
      }

      // 跨模式综合结论：要同时看四个副本（异相仲裁还要拆档），所以必须由
      // 服务端汇总——把 5 个环境的完整阵容表（约 1.7 MB）发给浏览器再算，
      // 纯属浪费，而且很难保证两端口径一致。
      //
      // 用 POST 是因为要带上账号的持有情况（角色、星魂、光锥叠影）。这些是
      // 公开的战绩数据，不是凭证；但仍然只走本机回环地址。
      if (path === '/api/archive/conclusion' && (req.method === 'POST' || req.method === 'GET')) {
        const unavailable = {
          ok: true,
          available: false,
          hint: '尚未采集资料。请在项目目录运行：node tools/herta-fetch.mjs && node tools/herta-build.mjs',
        };
        try {
          if (!(await archiveExists())) { json(res, 200, unavailable); return; }
          const body = req.method === 'POST' ? await readBody(req) : {};
          const window = url.searchParams.get('window') || body.window || '6';
          const result = await archiveConclusion(body.account || body, {
            window,
            // 「可及的强阵」允许差几金（用户在界面上自己定）。
            gapMaxPulls: body.gapMaxPulls,
            // 用户自定义的副本权重：**两套**，互不影响（用户 2026-10 要求）。
            //   planWeights     → 抽卡方案（界面上「方案权重」那一行）
            //   frontierWeights → 性价比总榜（界面上「总榜权重」那一行）
            // 老客户端只发一个 `weights`：那就两套都用它，行为与改造前一致。
            planWeights: body.planWeights !== undefined ? body.planWeights : body.weights,
            frontierWeights: body.frontierWeights !== undefined
              ? body.frontierWeights : body.weights,
            // 「隐金设置」（用户 2026-10-11）：五个开关，键固定为
            // `gift / giftCone / exchange / exchangeCone / standard`（见 advice.js 的
            // `HIDDEN_COST_IDS`）。**不传 = 一项都不减**（工具与回归测试的历史口径不变）；
            // 界面一定会把五个布尔显式发过来（它自己的默认值是「全勾」）。
            // 这里不做校验：`normalizeHiddenCosts` 只认这五个键、缺的按 false，
            // 所以非法输入（字符串 / 数组 / 多给的键）都退化成安全的形状，不会 500。
            hiddenCosts: body.hiddenCosts,
            // **抽卡权重**（用户 2026-10-13 第 1、2 条）：三个键
            // `strength / cost / versatility`，只认**相对大小**。
            //
            // ⚠️ 它从 v4.6.95 起**必须进服务端**（v4.6.94 那版刻意只留在浏览器，
            // 因为它当时只服务抽卡方案）。现在它决定**角色总榜**的合成分，而总榜的
            // 「每角色只留一条」收敛就发生在服务端的 `buildConclusion` 里 ——
            // 只在浏览器里加权会让收敛选错代表整包。
            //
            // 与 `hiddenCosts` 同一套路：**不传 = 默认表**（`1 : 1 : 0.5` → 归一
            // `0.4 / 0.4 / 0.2`；2026-10-16 第 1 条把泛用性的默认权重降到 0.5，
            // 改前是三等分）；这里不做校验，`normalizeDrawWeights` 只认有限非负数、缺键补默认，
            // 所以非法输入（字符串 / 数组 / 多给的键）都退化成安全的形状，不会 500。
            drawWeights: body.drawWeights,
            // **版本权重**（用户 2026-10-16）：第 3 类权重 —— **N 个槽位的数组**
            // （下标 0 = 最新版，默认 `[3, 2.5, 2, 1.5, 1, 0.5]`；用户 2026-10-17 起界面上
            // 可以「加一版 / 删一版」，所以长度是 1~12 而不是恒 6），只有**相对大小**
            // 有意义（不做归一到 1，界面上要印用户敲的原值）。
            //
            // 它决定「跨版本加权」那一层：每个整包的分是**按版本加权**的（旧版本被稀释、
            // 权重 0 = 那一版不进窗口），所以它必须进服务端 —— `seasonWeights` 是按
            // 用户这张表现算的（见 `archiveFrontier`）。
            //
            // 与 `drawWeights` 同一套路：**不传 = 默认表**（工具与回归测试的历史口径不变）；
            // 这里不做校验，`normalizeVersionWeights` 只认有限非负数、缺槽位补默认、
            // 全 0 退回默认，所以非法输入（字符串 / 短数组 / 多给的键）都退化成安全的形状。
            versionWeights: body.versionWeights,
          });
          json(res, 200, result);
        } catch (err) {
          console.warn('[archive] 读取综合结论失败：', err.message);
          json(res, 200, { ...unavailable, detail: err.message });
        }
        return;
      }

      // ⚠️ 本地图标路由（`/icons/*`）的实现在**上面**的静态分支里，不在这里。
      // 它不是 `/api/*`，走不到 API 路由区 —— 曾经在这里又写了一份，静态分支先
      // `return` 了，那份永远执行不到（纯死代码，且会让人以为两处都要维护）。

      // 把自己队伍丢进榜单里比一比：只回传命中的那几行，不把整个池子发给浏览器。
      if (path === '/api/archive/compare' && (req.method === 'POST' || req.method === 'GET')) {
        const unavailable = {
          ok: true,
          available: false,
          hint: '尚未采集资料。请在项目目录运行：node tools/herta-fetch.mjs && node tools/herta-build.mjs',
        };
        try {
          if (!(await archiveExists())) { json(res, 200, unavailable); return; }
          const body = req.method === 'POST' ? await readBody(req) : {};
          const window = url.searchParams.get('window') || body.window || '6';
          json(res, 200, await compareRosters(body.items || [], { window }));
        } catch (err) {
          console.warn('[archive] 队伍对照失败：', err.message);
          json(res, 200, { ...unavailable, detail: err.message });
        }
        return;
      }

      // 角色面板用的「这个角色的**全部**压金配装」（用户 2026-10：「需要在每个角色的
      // 详细界面显示所有的配装的最佳证据的队伍，并分别给出性价比评分」）。
      //
      // **必须按需**而不是塞进 `/conclusion`：那份载荷已经 0.67 MB（e2e 有 600 KB 硬
      // 上限），而收敛前的整包有 1097 条 / 67 个角色 —— 全量带上等于为一个「点开才看」
      // 的面板把每次加载翻倍。这里一个角色一次，实测 30 条 ≈ 85 KB。
      //
      // 找不到角色**不算错**：没进过压金前沿的角色本来就该是空面板，返回
      // `found:false` + 空数组，界面据此写「这个角色没有压金配装记录」。
      //
      // ⚠️ **必须带上「总榜权重」**（用户 2026-10-11 报的 bug）：面板给的是每个整包
      // 的「性价比得分」，那个数与总榜徽标必须是**同一口径**（`archiveCharacterPacks`
      // 的注释写了这条）。但路由此前只传 `window`，于是面板永远按**默认权重**算，
      // 而总榜徽标用的是用户在界面上定的「总榜权重」—— 实测用户把绝境总榜权重调成
      // 5.5 后，同一支队伍（砂金·戏浪 E6S1 + 向浪花掷下盛夏S1，绝境 11 金 / 行动值 285）
      // 在浮层显示 +399、在面板显示 +725，比值 1.817 ≈ 10 ÷ 5.5 正好是权重之比。
      //
      // 权重从**查询串**读（GET，不能带 body）：前端 `fetchPacks` 把它序列化进
      // `?frontierWeights=…`。解析失败就当作没传（退回默认），不让它 500。
      if (path === '/api/archive/packs' && req.method === 'GET') {
        try {
          const char = url.searchParams.get('char') || '';
          if (!(await archiveExists())) {
            json(res, 200, { ok: true, available: false, found: false, name: char, packs: [],
              hint: '尚未采集资料。请在项目目录运行：node tools/herta-fetch.mjs && node tools/herta-build.mjs' });
            return;
          }
          // 总榜权重覆盖（键形状与 `envWeightOf` 一致：`${全名或短码}|${stage}`）。
          let frontierWeights;
          const rawWeights = url.searchParams.get('frontierWeights');
          if (rawWeights) {
            try {
              const parsed = JSON.parse(rawWeights);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                frontierWeights = parsed;
              }
            } catch {
              // 非法 JSON → 当作没传，退回默认口径（面板仍然可用）。
            }
          }
          // 隐金设置同样走查询串（GET 无 body）。⚠️ **必须与总榜那份一致**：
          // 这个面板给的是「性价比得分」，用的就是 `buildConclusion`，漏传的话面板会按
          // 「一项都不减」算，与徽标上的分对不上（v4.6.69 刚修过一次同类的权重不一致 bug）。
          let hiddenCosts;
          const rawHidden = url.searchParams.get('hiddenCosts');
          if (rawHidden) {
            try {
              const parsed = JSON.parse(rawHidden);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                hiddenCosts = parsed;
              }
            } catch {
              // 非法 JSON → 当作没传（= 不隐金），面板仍然可用。
            }
          }
          // 抽卡权重同样走查询串（GET 无 body）。⚠️ **必须与总榜那份一致**：
          // 面板给的是「角色得分」（三个分项按抽卡权重加权的**榜内归一分**），
          // 归一用的极值取自整张表 —— 权重不同，同一个整包的面板分就会与徽标分不一致
          // （v4.6.69 的「总榜权重没带过去」、v4.6.88 的「seasonMinCost 漏发」是同一类）。
          let drawWeights;
          const rawDraw = url.searchParams.get('drawWeights');
          if (rawDraw) {
            try {
              const parsed = JSON.parse(rawDraw);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                drawWeights = parsed;
              }
            } catch {
              // 非法 JSON → 当作没传，退回默认表（面板仍然可用）。
            }
          }
          // **版本权重**（用户 2026-10-16）：与 `drawWeights` 同一套写法 —— 查询串
          // 里是 JSON 数组（6 个槽位，下标 0 = 最新版）。
          //
          // ⚠️ 少了它，详情窗口里的「跨版本发挥」/来源表会按**默认表**算，而榜上是按
          // 用户设的表算的 —— 同一个整包在两个地方两个数（与 v4.6.69 修过的
          // 「总榜权重没带过去」是同一类 bug）。解析失败就当作没传，不让它 500。
          let versionWeights;
          const rawVersion = url.searchParams.get('versionWeights');
          if (rawVersion) {
            try {
              const parsed = JSON.parse(rawVersion);
              if (Array.isArray(parsed)) versionWeights = parsed;
              else if (parsed && typeof parsed === 'object') versionWeights = parsed;
            } catch {
              // 非法 JSON → 当作没传，退回默认版本权重表。
            }
          }
          json(res, 200, await archiveCharacterPacks(char, {
            window: url.searchParams.get('window'),
            ...(frontierWeights ? { frontierWeights } : {}),
            ...(hiddenCosts !== undefined ? { hiddenCosts } : {}),
            ...(drawWeights !== undefined ? { drawWeights } : {}),
            ...(versionWeights !== undefined ? { versionWeights } : {}),
          }));
        } catch (err) {
          console.warn('[archive] 读取角色配装失败：', err.message);
          json(res, 200, { ok: true, available: false, found: false, packs: [], detail: err.message });
        }
        return;
      }

      // 手动更新本地数据集（增量抓取 + 重新聚合），以 SSE 推进度。
      // 用 GET + EventSource 是因为浏览器原生支持，不需要额外依赖，进度能实时显示。
      if (path === '/api/archive/update' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          // 反向代理下不要缓冲事件流
          'x-accel-buffering': 'no',
        });
        const send = (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        if (updateInProgress()) {
          send('failed', { message: '已经有一个更新任务在跑，请等它结束。' });
          res.end();
          return;
        }
        const before = await datasetStats().catch(() => ({}));
        send('progress', { message: `当前数据集 ${Math.round((before.archiveBytes || 0) / 1048576 * 10) / 10} MB` });
        // 客户端断开时不要继续往已关闭的流里写。
        let closed = false;
        req.on('close', () => { closed = true; });
        const result = await updateArchive((message, kind = 'progress') => {
          if (!closed) send(kind, { message });
        });
        if (!closed) {
          if (result.ok) {
            const after = await datasetStats().catch(() => ({}));
            send('done', { ...result, stats: after });
          } else {
            send('failed', { message: result.errors?.[0]?.error || '更新失败', detail: result.errors });
          }
        }
        // 备份目录只留最近 5 份，避免无限增长
        await pruneBackups(5).catch(() => {});
        res.end();
        return;
      }

      // ---- QR login ------------------------------------------------------
      if (path === '/api/login/qr' && req.method === 'POST') {
        if (!requireCsrf(req)) { json(res, 403, { ok: false, error: '无效的 CSRF 令牌' }); return; }
        const session = await startQrLogin();
        json(res, 200, { ok: true, sessionId: session.id, url: session.url, expiresInMs: session.expiresInMs });
        return;
      }

      // The QR image is served as SVG so the GUI needs no QR library.
      if (path === '/api/login/qr/image' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') || '';
        const session = getSession(sessionId);
        if (!session) { json(res, 404, { ok: false, error: '登录会话不存在或已过期' }); return; }
        const svg = toSVG(createQRCode(session.url, { level: 'M' }), {
          scale: 6, margin: 4, dark: '#0b0f1a', light: '#ffffff',
        });
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(svg),
          'Cache-Control': 'no-store',
        });
        res.end(svg);
        return;
      }

      if (path === '/api/login/qr/status' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') || '';
        const result = await pollQrLogin(sessionId);
        if (result.status !== 'Confirmed') { json(res, 200, { ok: true, ...result }); return; }

        // Persist the freshly authorised account and return only public fields.
        const session = getSession(sessionId);
        const account = await store.upsertAccount({
          accountId: result.account.accountId,
          nickname: result.account.nickname,
          cookie: session.recordCookie,
          deviceId: session.deviceId,
          source: 'qr',
        });
        let roles = [];
        let roleError = null;
        let roleErrors = [];
        try {
          const refreshed = await refreshRoles(store, account);
          roles = refreshed.roles;
          roleErrors = refreshed.errors;
        } catch (err) {
          roleError = err.message;
        }
        dropSession(sessionId);
        json(res, 200, {
          ok: true,
          status: 'Confirmed',
          account: AccountStore.toPublic(await store.getAccount(account.id)),
          roles: (await store.getAccount(account.id)).roles,
          roleError,
          roleErrors,
        });
        return;
      }

      // ---- manual cookie login -------------------------------------------
      if (path === '/api/login/cookie' && req.method === 'POST') {
        if (!requireCsrf(req)) { json(res, 403, { ok: false, error: '无效的 CSRF 令牌' }); return; }
        const body = await readBody(req);
        const cookie = normalizeManualCookie(body.cookie);
        const accountId = cookie.account_id_v2 || cookie.account_id
          || cookie.ltuid_v2 || cookie.ltuid || cookie.stuid;
        if (!accountId) {
          json(res, 400, { ok: false, error: 'Cookie 中缺少 account_id / ltuid，无法识别账号' });
          return;
        }
        if (!cookie.cookie_token && !cookie.cookie_token_v2) {
          json(res, 400, { ok: false, error: 'Cookie 中缺少 cookie_token，无法查询战绩' });
          return;
        }
        const account = await store.upsertAccount({
          accountId, cookie, source: 'cookie', nickname: body.nickname || null,
        });
        let roles = [];
        let roleError = null;
        let roleErrors = [];
        try {
          const refreshed = await refreshRoles(store, account);
          roles = refreshed.roles;
          roleErrors = refreshed.errors;
        } catch (err) {
          roleError = err.message;
        }
        json(res, 200, {
          ok: true,
          account: AccountStore.toPublic(await store.getAccount(account.id)),
          roles: (await store.getAccount(account.id)).roles,
          roleError,
          roleErrors,
        });
        return;
      }

      // ---- 1034 Geetest verification --------------------------------------
      // Step 1: ask miHoYo for a challenge; the GUI solves it in the browser.
      if (path === '/api/verify/challenge' && req.method === 'POST') {
        if (!requireCsrf(req)) { json(res, 403, { ok: false, error: '无效的 CSRF 令牌' }); return; }
        const body = await readBody(req);
        const account = await store.getAccount(body.accountId);
        if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return; }
        const challenge = await createVerification({
          cookie: account.cookie,
          deviceId: account.deviceId,
          challengePath: challengePathFor(body.kind || 'list'),
          page: `${APP_VERSION}_#/sr`,
        });
        json(res, 200, { ok: true, challenge });
        return;
      }

      // Step 3: exchange the solved Geetest result for `x-rpc-challenge`.
      if (path === '/api/verify/solve' && req.method === 'POST') {
        if (!requireCsrf(req)) { json(res, 403, { ok: false, error: '无效的 CSRF 令牌' }); return; }
        const body = await readBody(req);
        const challengeId = body.challengeId || body.id;
        const solved = {
          validate: body.validate || body.geetest_validate,
          seccode: body.seccode || body.geetest_seccode,
          challenge: body.geetest_challenge || body.challenge,
        };
        if (!solved.validate) {
          json(res, 400, { ok: false, error: '缺少验证结果 validate' });
          return;
        }
        try {
          const result = await completeVerification(challengeId, solved);
          json(res, 200, { ok: true, challenge: result.challenge });
        } catch (err) {
          dropVerification(challengeId);
          throw err;
        }
        return;
      }

      // ---- 虚拟账号（用户 2026-10-12：账号与角色界面上的「新建虚拟账号」）---------
      //
      // ⚠️ 路径刻意**不放在 `/api/accounts/...` 下**：那条正则会把 `virtual` 当成账号 id，
      //    先一步 404 掉（`/api/accounts/([A-Za-z0-9-]+)`）。
      // ⚠️ 只增不删：真实账号（光明火柴）不受任何影响 —— 用户明确要求别删他的账号。
      if (path === '/api/virtual-accounts/presets' && req.method === 'GET') {
        try {
          if (!(await archiveExists())) { json(res, 200, { ok: true, presets: [] }); return; }
          const vindex = await withSignatureCones(await archiveIndex());
          const availability = vindex.refs?.availability || {};
          // ⚠️ 必须带上 `popularLightCones` / `lightConePaths` / `coneIcons` /
          // `signatureLightCones`（`presetContextRefs`）：2026-10-13 第 4 条新增的
          // 「平铺 / 大隐金」预设要用它们配专属光锥，2026-10-14 第 1 条起还要用
          // 「专属锥表」（`withSignatureCones`）—— **漏了它就静默退回「最常用光锥」**，
          // 也就是用户报的「平铺缺光锥（缇宝 / 花火）」。漏传不会报错，只会让名单退化。
          const ctx = presetContext({ availability, firstSeen: vindex.refs?.firstSeen?.characters,
            charCostOf, coneCostOf, ...presetContextRefs(vindex) });
          json(res, 200, {
            ok: true,
            presets: VIRTUAL_PRESETS.map((p) => {
              const s = p.spec(ctx) || {};
              // ⚠️ `chars` 里含 4★ 与开拓者，而界面原来把它一律写成「N 限定角色」——
              // 平铺档的 93 因此**名不副实**（用户 2026-10-14 第 1 条「不符合描述」的
              // 其中一条）。两个数都发下去，界面照实写。
              return {
                id: p.id, title: p.title, hint: p.hint,
                chars: Object.keys(s.chars || {}).length,
                cones: Object.keys(s.cones || {}).length,
                limitedChars: Object.keys(s.chars || {})
                  .filter((k) => charCostOf(k, availability) > 0).length,
                totalChars: Object.keys(availability.characters || {}).length,
              };
            }),
          });
        } catch (err) {
          json(res, 500, { ok: false, error: `读取预设失败：${err.message}` });
        }
        return;
      }
      if (path === '/api/virtual-accounts' && req.method === 'POST') {
        if (!requireCsrf(req)) { json(res, 403, { ok: false, error: '无效的 CSRF 令牌' }); return; }
        try {
          const body = await readBody(req);
          const preset = presetById(String(body?.preset || ''));
          if (!preset) { json(res, 400, { ok: false, error: '未知的虚拟账号预设' }); return; }
          if (!(await archiveExists())) {
            json(res, 200, { ok: false, error: '数据集还没采集：先在项目目录跑 node tools/herta-fetch.mjs && node tools/herta-build.mjs' });
            return;
          }
          const vindex = await archiveIndex();
          const vi18n = await loadI18n();
          const availability = vindex.refs?.availability || {};
          const existing = await store.listAccounts();
          // uid 必须是**纯数字**（快照路由 `/roles/(\d+)/snapshot`）；id 撞了就加序号。
          const uid = nextVirtualUid(existing.flatMap((a) => (a.roles || []).map((r) => r.uid)));
          let accountId = `virtual-${preset.id}`;
          for (let n = 2; existing.some((a) => a.id === accountId); n += 1) {
            accountId = `virtual-${preset.id}-${n}`;
          }
          const nickname = typeof body?.nickname === 'string' && body.nickname.trim()
            ? body.nickname.trim().slice(0, 40) : null;
          const account = buildVirtualAccount({
            preset, index: vindex, i18n: vi18n, availability,
            charCostOf, coneCostOf, uid, accountId, nickname,
          });
          await store.addAccount(account);
          json(res, 200, { ok: true, account: AccountStore.toPublic(account) });
        } catch (err) {
          json(res, 500, { ok: false, error: `新建虚拟账号失败：${err.message}` });
        }
        return;
      }

      // 虚拟账号的**自定义角色名单**（用户 2026-10-13 第 3 条：「用户可给这个虚拟账号
      // 自定义添加角色，并设置任意角色的星魂和光锥」）。
      //
      //   GET  → 取这份名单**原文**（`{chars, cones}`，数据集英文键）：编辑器打开时按它预填。
      //          快照反推不回用户的编辑（删掉的角色在快照里没有痕迹），所以必须存原文。
      //   POST → 存回，**整份替换**（见 `AccountStore.setVirtualRoster` 的注释：
      //          走 `setSnapshot` 的「保留最长名单」合并规则会让删除被静默回滚）。
      //
      // ⚠️ 与「新建虚拟账号」分成两条路径：那是「按预设造一个新号」，这是「改已有虚拟号的名单」。
      // ⚠️ 依旧刻意不放在 `/api/accounts/...` 下 —— 那条正则会把 `virtual-xxx` 当账号 id。
      const vRosterMatch = path.match(/^\/api\/virtual-accounts\/([A-Za-z0-9-]+)\/roster$/);
      if (vRosterMatch && (req.method === 'GET' || req.method === 'POST')) {
        try {
          const target = await store.getAccount(vRosterMatch[1]);
          if (!target) { json(res, 404, { ok: false, error: '账号不存在' }); return; }
          if (target.source !== 'virtual') {
            // 真实账号的快照来自米游社，本地改写会让界面显示一份服务器上不存在的角色表。
            json(res, 400, { ok: false, error: '只有虚拟账号可以自定义角色' });
            return;
          }
          if (req.method === 'GET') {
            // 「真正的专属光锥」表（限定 5★，见 `deriveSignatureCones`）：编辑器用它给
            // 下拉框标「（专属）」并把它排第一。**没有它**时编辑器会退回
            // `popularLightCones`（「最常用光锥」）—— 那正是用户报的「配的不是专武」。
            // 只有 58 条、约 2 KB，只在打开编辑器时取一次；数据集还没采集时退回空表
            //（编辑器仍可用，只是标不出「专属」）。
            let signatures = {};
            try {
              if (await archiveExists()) {
                const vindex = await archiveIndex();
                signatures = await signatureCones(vindex.refs?.availability || {});
              }
            } catch { signatures = {}; }
            json(res, 200, {
              ok: true,
              accountId: target.id,
              nickname: target.nickname || null,
              roster: {
                chars: { ...(target.virtualRoster?.chars || {}) },
                cones: { ...(target.virtualRoster?.cones || {}) },
                coneOwners: { ...(target.virtualRoster?.coneOwners || {}) },
                // 逐角色装备（权威，2026-10-14 第 1 条起）：老账号没这个字段，界面按
                // 「`coneOwners` 反推」处理（见 `virtual-roster.js` 的注释）。
                charCones: { ...(target.virtualRoster?.charCones || {}) },
                trailblazer: target.virtualRoster?.trailblazer
                  ? { ...target.virtualRoster.trailblazer } : null,
              },
              // 编辑器要按「命途 + 男/女」分组画头像选择器，而这些归属**只有服务端这张表
              // 知道**（实测依据见 `TRAILBLAZER_AVATARS` 的注释），所以随名单一起下发。
              trailblazerAvatars: TRAILBLAZER_AVATARS.map((a) => ({ ...a })),
              signatureLightCones: { ...signatures },
            });
            return;
          }
          if (!requireCsrf(req)) { json(res, 403, { ok: false, error: '无效的 CSRF 令牌' }); return; }
          if (!(await archiveExists())) {
            json(res, 200, {
              ok: false,
              error: '数据集还没采集：先在项目目录跑 node tools/herta-fetch.mjs && node tools/herta-build.mjs',
            });
            return;
          }
          const body = await readBody(req);
          const vindex = await withSignatureCones(await archiveIndex());
          const vi18n = await loadI18n();
          const availability = vindex.refs?.availability || {};
          // 收口（只认数据集里真有的键 / 星魂吸附到 E0·E1·E2·E6 / 叠影夹到 1~5 /
          // 光锥主人必须与它同命途）。⚠️ 传的是整个 `refs`：校验命途需要
          // `characterPaths` + `lightConePaths` 两张表。
          const roster = normalizeRoster(body, vindex.refs || {});
          const uid = String((target.roles || [])[0]?.uid || nextVirtualUid([]));
          // ⚠️ 复用 `buildVirtualAccount`（不另写一份构造）：图标 / 星级 / id / 光锥归属
          // 那一堆坑都在那里踩平了，两处各写一份必然长歪。
          const built = buildVirtualAccount({
            preset: customRosterPreset(roster, target.nickname),
            index: vindex, i18n: vi18n, availability, charCostOf, coneCostOf,
            uid, accountId: target.id, nickname: target.nickname,
          });
          const saved = await store.setVirtualRoster(target.id, uid, {
            snapshot: built.snapshots[uid],
            roster,
          });
          json(res, 200, { ok: true, account: AccountStore.toPublic(saved), roster });
        } catch (err) {
          json(res, 500, { ok: false, error: `保存角色名单失败：${err.message}` });
        }
        return;
      }

      // 虚拟账号**重命名**（用户 2026-10-14 第 5 条：「用户可以给已有的虚拟账号重命名」）。
      //
      // ⚠️ 只允许虚拟账号：真实账号的昵称来自米游社，本地改只会在下一次刷新时变回去。
      // ⚠️ 依旧刻意不放在 `/api/accounts/...` 下（理由同上面两条）。
      const vRenameMatch = path.match(/^\/api\/virtual-accounts\/([A-Za-z0-9-]+)\/rename$/);
      if (vRenameMatch && req.method === 'POST') {
        if (!requireCsrf(req)) { json(res, 403, { ok: false, error: '无效的 CSRF 令牌' }); return; }
        try {
          const body = await readBody(req);
          const target = await store.getAccount(vRenameMatch[1]);
          if (!target) { json(res, 404, { ok: false, error: '账号不存在' }); return; }
          const saved = await store.renameVirtualAccount(vRenameMatch[1], body?.nickname);
          json(res, 200, { ok: true, account: AccountStore.toPublic(saved) });
        } catch (err) {
          json(res, 400, { ok: false, error: `重命名失败：${err.message}` });
        }
        return;
      }

      // 「**新增同配置虚拟账号**」（用户 2026-10-14 第 5 条：「可点击按钮新增与用户真实账号
      // 完全一致的虚拟账号，该按钮位于此用户的真实账号的选项框内」）。
      //
      // 做法：把真实账号那一份快照**反解**成虚拟账号的名单原文（角色 / 星魂 / 逐角色光锥 /
      // 开拓者头像），再走 `buildVirtualAccount` —— 于是「完全一致」这件事只有一份实现，
      // 而且新账号打开角色编辑器还能继续改（`virtualRoster` 已经写好了）。
      // ⚠️ **绝不改动源账号**：全程只读它的快照。
      if (path === '/api/virtual-accounts/from-account' && req.method === 'POST') {
        if (!requireCsrf(req)) { json(res, 403, { ok: false, error: '无效的 CSRF 令牌' }); return; }
        try {
          const body = await readBody(req);
          const source = await store.getAccount(String(body?.accountId || ''));
          if (!source) { json(res, 404, { ok: false, error: '源账号不存在' }); return; }
          const uid = String(body?.uid || (source.roles || [])[0]?.uid || '');
          const snapshot = uid ? await store.getSnapshot(source.id, uid) : null;
          if (!snapshot) { json(res, 400, { ok: false, error: '该账号还没有角色数据，先「刷新角色」再试' }); return; }
          if (!(await archiveExists())) {
            json(res, 200, {
              ok: false,
              error: '数据集还没采集：先在项目目录跑 node tools/herta-fetch.mjs && node tools/herta-build.mjs',
            });
            return;
          }
          const vindex = await withSignatureCones(await archiveIndex());
          const vi18n = await loadI18n();
          const availability = vindex.refs?.availability || {};
          const raw = rosterFromSnapshot(snapshot, vi18n);
          // 与自定义名单走**同一条收口**（`normalizeRoster`）：非法键丢弃、星魂吸附到
          // E0/E1/E2/E6、光锥主人必须同命途、成本 > 0 的锥只留一个主人。
          const roster = normalizeRoster(raw, vindex.refs || {});
          const existing = await store.listAccounts();
          const newUid = nextVirtualUid(existing.flatMap((a) => (a.roles || []).map((r) => r.uid)));
          let accountId = `virtual-from-${source.id}`;
          for (let n = 2; existing.some((a) => a.id === accountId); n += 1) {
            accountId = `virtual-from-${source.id}-${n}`;
          }
          const nickname = typeof body?.nickname === 'string' && body.nickname.trim()
            ? body.nickname.trim().slice(0, 40)
            // ⚠️ 不加「虚拟·」前缀：虚拟账号的昵称本来就带它，加了会变成「虚拟·虚拟·…」；
            // 真实账号的昵称（如「光明火柴」）直接接「的同配置」即可。
            : `${source.nickname || source.id} 的同配置`;
          const account = buildVirtualAccount({
            preset: customRosterPreset(roster, nickname),
            index: vindex, i18n: vi18n, availability, charCostOf, coneCostOf,
            uid: newUid, accountId, nickname,
          });
          await store.addAccount(account);
          json(res, 200, {
            ok: true,
            account: AccountStore.toPublic(account),
            roster,
            // 反解时跳过了几个单位（名字在 i18n 里查不到 / 不是数据集里的键）——
            // 界面可以用它提示「有 N 个角色没能复制」，而不是静默少几个。
            skipped: raw.skipped,
          });
        } catch (err) {
          json(res, 500, { ok: false, error: `新增同配置虚拟账号失败：${err.message}` });
        }
        return;
      }

      // ---- accounts ------------------------------------------------------
      const accountMatch = path.match(/^\/api\/accounts\/([A-Za-z0-9-]+)(\/.*)?$/);
      if (accountMatch) {
        const accountId = accountMatch[1];
        const rest = accountMatch[2] || '';
        const account = await store.getAccount(accountId);
        if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return; }

        if (rest === '' && req.method === 'GET') {
          json(res, 200, { ok: true, account: AccountStore.toPublic(account) });
          return;
        }
        if (rest === '' && req.method === 'DELETE') {
          if (!requireCsrf(req)) { json(res, 403, { ok: false, error: '无效的 CSRF 令牌' }); return; }
          await store.removeAccount(accountId);
          json(res, 200, { ok: true });
          return;
        }
        if (rest === '/roles' && req.method === 'POST') {
          if (!requireCsrf(req)) { json(res, 403, { ok: false, error: '无效的 CSRF 令牌' }); return; }
          const refreshed = await refreshRoles(store, account);
          json(res, 200, {
            ok: true,
            roles: (await store.getAccount(accountId)).roles,
            roleErrors: refreshed.errors,
          });
          return;
        }
        // Snapshot for a role: /api/accounts/:id/roles/:uid/snapshot
        const snapMatch = rest.match(/^\/roles\/(\d+)\/snapshot$/);
        if (snapMatch && (req.method === 'GET' || req.method === 'POST')) {
          const uid = snapMatch[1];
          if (req.method === 'POST' && !requireCsrf(req)) {
            json(res, 403, { ok: false, error: '无效的 CSRF 令牌' });
            return;
          }
          const force = url.searchParams.get('refresh') === '1' || req.method === 'POST';
          const cached = await store.getSnapshot(accountId, uid);
          /**
           * 快照里的「限定角色 / 限定光锥」数量（用户 2026-10-18）。
           *
           * 为什么在**服务端**算：光锥的那份名单对两类账号来源不同 —— 虚拟账号的
           * **持有光锥**在账号上（`virtualRoster.cones`，快照只带「已装备」的那些），
           * 真实账号则只有快照里 `equip` 这一条路。浏览器手上没有 `virtualRoster`
           * （`toPublic()` 刻意不下发），所以只能在这里算好再发。
           * 数据集缺失 / 读取失败 → `null`，界面**不显示**这两张卡（不写 0 骗人）。
           */
          const limitedOf = async (snapshot) => {
            if (!snapshot) return null;
            try {
              if (!(await archiveExists())) return null;
              const index = await archiveIndex();
              const virtualCones = account.source === 'virtual'
                ? Object.keys(account.virtualRoster?.cones || {})
                : null;
              return limitedCountOf({
                snapshot,
                ownedCones: virtualCones && virtualCones.length ? virtualCones : null,
                // 虚拟账号光锥的叠影（算总成本用）；真实账号的叠影在快照 equip.rank 里。
                ownedConeRanks: account.source === 'virtual'
                  ? (account.virtualRoster?.cones || null)
                  : null,
                availability: index?.refs?.availability || {},
                i18n: await loadI18n(),
              });
            } catch (err) {
              console.warn(`[snapshot] 限定数量统计失败（${err.message}），界面不显示这两张卡`);
              return null;
            }
          };
          // 虚拟账号（用户 2026-10-12）：数据是**本地构造**的，没有 cookie、也永远不该去请求
          // 米游社 —— 直接回快照，别让界面挂一片「请重新扫码 / 拉取失败」的假故障。
          if (account.source === 'virtual' || cached?.source === 'virtual') {
            json(res, 200, {
              ok: true, cached: true, virtual: true,
              cache: cacheMeta(cached, CACHE_TTL_MS.snapshot, Date.now(),
                { kind: 'snapshot', stale: false, virtual: true }),
              snapshot: cached || null,
              limited: await limitedOf(cached),
            });
            return;
          }
          // 「要不要联网」由闸门说了算，不再看 TTL：
          // 有缓存且不是显式刷新 → 直接返回本地那份（本轮改动的核心）。
          const gate = refetchGate.decide(`${accountId}/${uid}/snapshot`, { cached, force });
          if (!gate.refetch) {
            // 限流命中、而本地又确实没有数据可退回（上一次抓取失败了）：
            // 不能回 200 + 空快照，那会让界面显示成「这个角色没有数据」，
            // 而真实原因是「刚请求过、太密了」。这里明确回 429 + 要等多久。
            if (!cached) {
              json(res, 429, {
                ok: false,
                error: `${REFETCH_MESSAGES.throttled}`
                  + `请 ${Math.ceil(gate.retryAfterMs / 1000)} 秒后再试。`,
                throttled: true,
                retryAfterMs: gate.retryAfterMs,
              });
              return;
            }
            json(res, 200, {
              ok: true,
              cached: true,
              // 限流与「读本地」都走这一条出口，用 refetch 字段告诉界面为什么没联网。
              refetch: gate.reason,
              throttled: gate.throttled,
              retryAfterMs: gate.retryAfterMs,
              message: REFETCH_MESSAGES[gate.reason],
              cache: cacheMeta(cached, CACHE_TTL_MS.snapshot, Date.now(), {
                kind: 'snapshot',
                cached: true,
                refetch: gate.reason,
                throttled: gate.throttled,
                retryAfterMs: gate.retryAfterMs,
                sectionFreshness: cached.sectionFreshness || {},
              }),
              snapshot: cached,
              limited: await limitedOf(cached),
            });
            return;
          }
          const known = (account.roles || []).find((r) => r.uid === uid);
          const game = 'hsr';
          const server = known?.region || regionFromUid(uid);
          const incomingChallenge = req.headers['x-hsr-challenge'];
          if (incomingChallenge) {
            console.log(`[verify] 使用 x-rpc-challenge 请求 ${game}/${uid}（单次有效，长度 ${String(incomingChallenge).length}）`);
          }
          const deviceFp = await ensureFingerprint(store, account);
          let snapshot;
          try {
            snapshot = await fetchSnapshot(uid, server, {
              cookie: account.cookie,
              deviceId: account.deviceId,
              deviceFp,
              // The public profile card is keyed by the miyoushe ACCOUNT id.
              accountId: account.accountId,
              // Present only after the user solved a 1034 Geetest challenge.
              challenge: incomingChallenge || undefined,
            });
            snapshot.game = game;
            snapshot.regionName = known?.regionName || regionName(server, game);
            snapshot.stale = false;
            // Merge (never clobber) so a partial failure keeps the roster.
            snapshot = await store.setSnapshot(accountId, uid, snapshot);
            json(res, 200, { ok: true, cached: false, cache: cacheMeta(snapshot, CACHE_TTL_MS.snapshot, Date.now(), { kind: 'snapshot', sectionFreshness: snapshot.sectionFreshness || {} }), snapshot, limited: await limitedOf(snapshot) });
            return;
          } catch (err) {
            // Snap Hutao shows previously synced characters when the record API
            // refuses (risk control, privacy gate). Do the same instead of
            // reporting an empty account.
            const fallback = await store.getSnapshot(accountId, uid);
            const hasData = fallback && (
              (Array.isArray(fallback.characters) && fallback.characters.length)
              || (Array.isArray(fallback.avatars) && fallback.avatars.length)
              || fallback.basicInfo
              || fallback.card
            );
            if (hasData) {
              console.log(`[snapshot] ${game}/${uid} 拉取失败（retcode=${err.retcode}），回退到本地缓存`);
              json(res, 200, {
                ok: true,
                cached: true,
                degraded: true,
                error: err.message,
                retcode: err.retcode,
                cache: cacheMeta(fallback, CACHE_TTL_MS.snapshot, Date.now(), { kind: 'snapshot', stale: true, staleReason: err.message, sectionFreshness: fallback.sectionFreshness || {} }),
                snapshot: { ...fallback, stale: true, staleReason: err.message },
                limited: await limitedOf(fallback),
              });
              return;
            }
            throw err;
          }
        }

        // 高难副本战斗记录：四个副本的队伍/回合/积分。
        //
        // 缓存里存的是**原始**响应（~56 KB），归一化在读取时做：改归一化逻辑不用
        // 重新打米游社，以后想多显示一个字段也不用重抓。
        //
        // GET 读本地；只有「本地一份都没有」时才自动抓一次（第一次打开抽卡推荐页
        // 就能看到东西，不用先点刷新）。POST / ?refresh=1 是显式刷新，要 CSRF。
        //
        // ⚠️ 与改造前的区别：以前是「缓存超过 30 分钟就自动重抓」，于是每切一次
        // 抽卡推荐页都可能打一次米游社。现在有缓存就一律读本地（用户 2026-10
        // 「不需要每次刷新都去更新数据，过多的请求会导致数据爬取出错」），
        // 并且显式刷新也受最小间隔限流。判定统一走 `refetchGate`。
        const recordsMatch = rest.match(/^\/roles\/(\d+)\/records$/);
        if (recordsMatch && (req.method === 'GET' || req.method === 'POST')) {
          const uid = recordsMatch[1];
          const force = req.method === 'POST' || url.searchParams.get('refresh') === '1';
          if (req.method === 'POST' && !requireCsrf(req)) {
            json(res, 403, { ok: false, error: '无效的 CSRF 令牌' });
            return;
          }
          const i18n = await loadI18n();
          const view = async (stored, extra = {}) => ({
            ok: true,
            ...extra,
            cache: cacheMeta(stored, CACHE_TTL_MS.records, Date.now(), { kind: 'records', cached: Boolean(extra.cached), degraded: Boolean(extra.degraded), partial: Boolean(stored?.errors?.length), sectionFreshness: stored?.sectionFreshness || {} }),
            records: normalizeBattleRecords({
              ...(stored?.raw || {}),
              uid,
              server: stored?.server,
              fetchedAt: stored?.fetchedAt,
              errors: stored?.errors || [],
              i18n,
              // 敌方名单来自黑塔网的赛程表（按档期对期），不是米游社给的：
              // 所以这里是**读的时候**现算——站点补了新一期不用重新打米游社。
              enemies: stored ? await enemiesForRecords(stored.raw) : {},
            }),
          });
          const cached = await store.getBattleRecords(accountId, uid);
          // 虚拟账号：本地构造、没有 cookie —— 战绩永远是空的，也不该去请求米游社
          // （否则界面会挂一串「请重新扫码」的假故障，用户会以为坏了）。
          if (account.source === 'virtual') {
            json(res, 200, {
              ok: true, virtual: true, cached: true,
              cache: cacheMeta(null, CACHE_TTL_MS.records, Date.now(),
                { kind: 'records', cached: true, virtual: true, sectionFreshness: {} }),
              records: normalizeBattleRecords({ uid, i18n, errors: [], enemies: {} }),
            });
            return;
          }
          const gate = refetchGate.decide(`${accountId}/${uid}/records`, { cached, force });
          if (!gate.refetch) {
            // 同 snapshot：限流命中且本地无数据可退回时，如实回 429，
            // 别用一份空记录冒充「读到了缓存」。
            if (!cached) {
              json(res, 429, {
                ok: false,
                error: `${REFETCH_MESSAGES.throttled}`
                  + `请 ${Math.ceil(gate.retryAfterMs / 1000)} 秒后再试。`,
                throttled: true,
                retryAfterMs: gate.retryAfterMs,
              });
              return;
            }
            json(res, 200, await view(cached, {
              cached: true,
              refetch: gate.reason,
              throttled: gate.throttled,
              retryAfterMs: gate.retryAfterMs,
              message: REFETCH_MESSAGES[gate.reason],
            }));
            return;
          }
          const known = (account.roles || []).find((r) => r.uid === uid);
          const server = known?.region || regionFromUid(uid, 'hsr');
          const deviceFp = await ensureFingerprint(store, account);
          try {
            const stored = await loadBattleRecords(uid, server, {
              cookie: account.cookie,
              deviceId: account.deviceId,
              deviceFp,
              // 只在用户刚过完验证码时带上（一次性，见 README 的说明）
              challenge: req.headers['x-hsr-challenge'] || undefined,
            });
            const saved = await store.setBattleRecords(accountId, uid, stored);
            json(res, 200, await view(saved || stored, { cached: false }));
            return;
          } catch (err) {
            if (err.code === 'CHALLENGE_REQUIRED') {
              // 1034 = 先过验证码。这不是错误，是要告诉界面去走验证流程。
              json(res, 200, {
                ok: true,
                challengeRequired: true,
                message: err.message,
                ...(cached ? await view(cached, { cached: true }) : { records: null }),
              });
              return;
            }
            if (cached) {
              // 风控/隐私拒绝时退回上一份，并把原因带出去。
              json(res, 200, await view(cached, {
                cached: true, degraded: true, error: err.message, retcode: err.retcode,
              }));
              return;
            }
            throw err;
          }
        }

        // Visibility switches from the record card, so the GUI can show the
        // exact state and offer to flip the "角色详情数据" switch.
        const switchesMatch = rest.match(/^\/roles\/(\d+)\/privacy$/);        if (switchesMatch && (req.method === 'GET' || req.method === 'POST')) {
          // Check CSRF *before* touching the upstream API.
          if (req.method === 'POST' && !requireCsrf(req)) {
            json(res, 403, { ok: false, error: '无效的 CSRF 令牌' });
            return;
          }
          if (req.method === 'POST') {
            const body = await readBody(req);
            await setPrivacySwitch(account.accountId, body.switchId, body.isPublic, {
              cookie: account.cookie, deviceId: account.deviceId,
            });
            const after = await getPrivacySwitches(account.accountId, {
              cookie: account.cookie, deviceId: account.deviceId,
            });
            json(res, 200, { ok: true, switches: after });
            return;
          }
          const switches = await getPrivacySwitches(account.accountId, {
            cookie: account.cookie, deviceId: account.deviceId,
          });
          json(res, 200, { ok: true, switches });
          return;
        }
        json(res, 404, { ok: false, error: `未找到 ${path}` });
        return;
      }

      json(res, 404, { ok: false, error: `未找到 ${path}` });
    } catch (err) {
      if (res.headersSent || res.writableEnded || res.destroyed) {
        console.error('[server] request failed after response was sent', err);
        return;
      }
      const isKnown = err instanceof MihoyoError;
      const isUpstream = err?.code === 'NO_DATA' && Array.isArray(err.warnings);
      let status = 500;
      if (isKnown && err.code === 'NO_SESSION') status = 404;
      else if (isUpstream) status = 502; // upstream answered, but refused / had no data
      const payload = {
        ok: false,
        error: err?.message || '服务器内部错误',
        code: err?.code ?? 'INTERNAL',
        retcode: err?.retcode,
      };
      if (isUpstream) payload.warnings = err.warnings;
      if (!isKnown && !isUpstream) console.error('[server]', err);
      json(res, status, payload);
    }
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error('[server] unhandled', err);
      if (!res.headersSent) json(res, 500, { ok: false, error: '服务器内部错误' });
      else res.end();
    });
  });

  return { server, store, csrfToken };
};

export const startServer = async (options = {}) => {
  const port = options.port ?? Number(process.env.PORT || 8360);
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const accessToken = options.accessToken || process.env.DSH_HSR_TOKEN || '';
  if (!isLoopbackHost(host) && !accessToken) {
    const error = new Error('监听局域网地址必须设置 DSH_HSR_TOKEN 或 accessToken，已拒绝启动以防止账号数据暴露');
    error.code = 'LAN_AUTH_REQUIRED';
    throw error;
  }
  const { server, store } = createApp({ ...options, accessToken });
  await store.load();
  store.vault?.assertAvailable?.();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    store,
    host,
    port: actualPort,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}/`,
  };
};
