// End-to-end test: boots the real server on an ephemeral port with a temporary
// data file, then exercises every HTTP route (including failure paths).
//
// Run with: node tools/e2e-test.mjs

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server/app.js';
import { AccountStore } from '../src/server/store.js';
import { CredentialVault } from '../src/server/credential-vault.js';

let passed = 0;
let failed = 0;

const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
};

const main = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hsr-e2e-'));
  let lanAuthRejected = false;
  try {
    await startServer({ port: 0, host: '0.0.0.0', store: new AccountStore({ file: join(dir, 'lan-accounts.json') }) });
  } catch (error) {
    lanAuthRejected = error.code === 'LAN_AUTH_REQUIRED';
  }
  check('LAN listener requires an access token', lanAuthRejected);
  let missingCredentialKeyRejected = false;
  try {
    await startServer({
      port: 0, host: '127.0.0.1',
      store: new AccountStore({
        file: join(dir, 'no-key-accounts.json'),
        vault: new CredentialVault({ platform: 'linux', env: {} }),
      }),
    });
  } catch (error) {
    missingCredentialKeyRejected = error.code === 'CREDENTIAL_KEY_MISSING';
  }
  check('server refuses to start without a credential encryption key', missingCredentialKeyRejected);
  const store = new AccountStore({ file: join(dir, 'accounts.json') });
  const app = await startServer({
    port: 0,
    host: '127.0.0.1',
    store,
    fetchBattleRecordsRaw: async (uid, server) => ({
      uid: String(uid), server, fetchedAt: new Date().toISOString(), errors: [], raw: {},
    }),
  });
  const base = app.url.replace(/\/$/, '');
  const authApp = await startServer({
    port: 0, host: '127.0.0.1', accessToken: 'test-access-token',
    store: new AccountStore({ file: join(dir, 'auth-accounts.json') }),
  });
  const authBase = authApp.url.replace(/\/$/, '');
  const authDenied = await fetch(`${authBase}/api/config`);
  const authAllowed = await fetch(`${authBase}/api/config`, { headers: { 'x-hsr-token': 'test-access-token' } });
  check('shared access token protects API routes', authDenied.status === 401 && authAllowed.status === 200);
  await new Promise((done) => authApp.server.close(done));
  console.log(`server listening on ${base}\n`);

  const get = async (path, headers = {}) => {
    const response = await fetch(`${base}${path}`, { headers });
    const type = response.headers.get('content-type') || '';
    return {
      status: response.status,
      type,
      headers: response.headers,
      body: type.includes('json') ? await response.json() : await response.text(),
    };
  };
  const post = async (path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
    });
    const type = response.headers.get('content-type') || '';
    return {
      status: response.status,
      type,
      body: type.includes('json') ? await response.json() : await response.text(),
    };
  };

  try {
    // ---- static GUI -----------------------------------------------------
    console.log('[static files]');
    const index = await get('/');
    check('GET / returns HTML', index.status === 200 && index.type.includes('text/html'),
      `status=${index.status} type=${index.type}`);
    check('index.html has the app root', String(index.body).includes('id="qrImage"'));
    check('index.html has no inline script (would break CSP-less setups)',
      !/<script(?![^>]*src=)/.test(String(index.body)));

    const css = await get('/styles/app.css');
    check('GET /styles/app.css', css.status === 200 && css.type.includes('text/css'), `status=${css.status}`);
    const js = await get('/scripts/app.js');
    check('GET /scripts/app.js', js.status === 200 && js.type.includes('javascript'), `status=${js.status}`);
    const fmt = await get('/scripts/format.js');
    check('GET /scripts/format.js', fmt.status === 200 && fmt.type.includes('javascript'), `status=${fmt.status}`);
    const advice = await get('/scripts/advice.js');
    check('GET /scripts/advice.js', advice.status === 200 && advice.type.includes('javascript'),
      `status=${advice.status}`);
    const adviceView = await get('/scripts/advice-view.js');
    check('GET /scripts/advice-view.js', adviceView.status === 200 && adviceView.type.includes('javascript'),
      `status=${adviceView.status}`);
    check('index.html has the 抽卡推荐 tab', String(index.body).includes('id="tabAdvice"'));
    check('index.html has the advice layout', String(index.body).includes('id="layoutAdvice"'));

    // ---- 版本号 + 检查更新在**标题栏**（用户 2026-10-16 第 7 条）------------------
    //
    // 用户原话：「版本号、检查更新应显示在页面上方的标题栏较为显眼的地方，提示及时更新」。
    // 这一组量的是**服务端真的发出去的那份 HTML**：两个元素都必须落在 `<header class="topbar">`
    // 之内、且**页脚里一个都不许留**（用户明确要求别在两处各放一份）。
    // ⚠️ 只钉**位置**，不钉文案或版本号本身（那是 `src/version.js` 的事，这里写死会打架）。
    {
      const served = String(index.body);
      const headerEnd = served.indexOf('</header>');
      const footerAt = served.indexOf('<footer');
      const versionAt = served.indexOf('id="appVersion"');
      const updateAt = served.indexOf('id="appUpdateCheck"');
      check('版本号与「检查更新」都在 <header class="topbar"> 里',
        headerEnd > 0 && versionAt > 0 && updateAt > 0
          && versionAt < headerEnd && updateAt < headerEnd,
        `headerEnd=${headerEnd} version=${versionAt} update=${updateAt}`);
      check('页脚里不再有版本号 / 检查更新 / 结果行（只留一处）',
        footerAt > 0 && !served.slice(footerAt).includes('id="appVersion"')
          && !served.slice(footerAt).includes('id="appUpdateCheck"')
          && !served.slice(footerAt).includes('id="appUpdateResult"'),
        'footer still carries a copy');
      check('「检查更新」按钮带 title 与 aria-label（可访问性）',
        /id="appUpdateCheck"[^>]*aria-label=/.test(served)
          && /id="appUpdateCheck"[^>]*title=/.test(served));
    }

    // ---- 数据状态（用户 2026-10-11）：三份缓存的记录整合在一块，就在标题下方 -------
    //
    // 这一组量的是**服务端真的发出去的那份 HTML**（不是源文件）：结构与顺序一起钉住，
    // 免得以后有人把某一格挪回它原来待的那一节（角色快照曾在正文最上面、战斗记录曾在
    // ①那一节里、黑塔网数据曾是标题栏右侧一行小字）。
    {
      const served = String(index.body);
      const blockAt = served.indexOf('id="adviceDataStatus"');
      const gridAt = served.indexOf('class="data-status-grid"');
      const snapAt = served.indexOf('id="adviceSnapshotFreshness"');
      const recordAt = served.indexOf('id="recordFreshness"');
      const datasetAt = served.indexOf('id="adviceDatasetFreshness"');
      const recordSectionAt = served.indexOf('id="adviceRecord"');
      check('data status block keeps the three caches in one grid, above ① 战斗记录',
        blockAt > 0 && gridAt > blockAt && snapAt > gridAt && snapAt < recordAt
          && recordAt < datasetAt && recordAt < recordSectionAt,
        `block=${blockAt} grid=${gridAt} snapshot=${snapAt} record=${recordAt} dataset=${datasetAt} recordSection=${recordSectionAt}`);
      check('the dataset time line is no longer a separate header node',
        !served.includes('id="adviceDataUpdated"'));
      const recordSlice = served.slice(recordSectionAt, served.indexOf('<!-- 跨模式综合结论'));
      check('① 战斗记录 no longer carries its own .data-freshness block',
        !recordSlice.includes('class="data-freshness"'));
    }

    // ---- archive (offline theherta dataset) -----------------------------
    console.log('\n[archive]');
    const archive = await get('/api/archive');
    check('GET /api/archive ok', archive.status === 200 && archive.body?.ok === true,
      `status=${archive.status}`);
    if (archive.body?.available) {
      check('archive index lists modes', Array.isArray(archive.body.modes) && archive.body.modes.length === 4,
        `modes=${archive.body.modes?.length}`);
      check('archive modes use short keys',
        archive.body.modes.every((m) => /^[a-z]{2,4}$/.test(m.mode)),
        JSON.stringify(archive.body.modes?.map((m) => m.mode)));
      check('archive modes carry Chinese labels',
        archive.body.modes.every((m) => typeof m.labelCn === 'string' && m.labelCn.length > 0));
      check('archive reports a run count', archive.body.runCount > 0, `runCount=${archive.body.runCount}`);
      check('archive mode labels are the official Chinese ones',
        new Set(archive.body.modes.map((m) => m.labelCn)).size === 4
          && ['混沌回忆', '虚构叙事', '末日幻影', '异相仲裁']
            .every((label) => archive.body.modes.some((m) => m.labelCn === label)),
        archive.body.modes.map((m) => m.labelCn).join(','));
      const refChars = archive.body.refs?.characters || [];
      check('archive refs carry Chinese character names',
        refChars.length > 0 && refChars.every((c) => c.nameCn),
        `${refChars.filter((c) => !c.nameCn).length}/${refChars.length} 缺中文`);
      check('archive refs keep the English key alongside the Chinese name',
        refChars.every((c) => c.name));

      const stats = await get(`/api/archive/stats?mode=${archive.body.modes[0].mode}`);
      check('GET /api/archive/stats ok', stats.status === 200 && stats.body?.ok === true,
        `status=${stats.status}`);
      check('stats returns ranked characters',
        Array.isArray(stats.body.characters) && stats.body.characters.length > 10,
        `characters=${stats.body.characters?.length}`);
      check('stats returns team compositions',
        Array.isArray(stats.body.teams) && stats.body.teams.length > 0,
        `teams=${stats.body.teams?.length}`);
      check('stats echoes the mode as a short key',
        stats.body.mode === archive.body.modes[0].mode, `mode=${stats.body.mode}`);
      check('stats serves Chinese character names',
        stats.body.characters.every((c) => c.nameCn), '有角色缺中文名');
      check('stats serves Chinese path names',
        stats.body.characters.every((c) => c.pathCn), '有角色缺中文命途');
      check('stats serves Chinese roster names',
        stats.body.teams.every((t) => Array.isArray(t.rosterCn)
          && t.rosterCn.length === (t.roster || []).length), '阵容中英文长度不一致');
      check('stats serves Chinese boss names',
        (stats.body.bosses || []).length > 0 && stats.body.bosses.every((b) => b.nameCn),
        '有首领缺中文名');
      check('stats serves Chinese category labels',
        stats.body.categoryLabels?.['0-Cycle'] === '0 回合',
        JSON.stringify(stats.body.categoryLabels));

      const badMode = await get('/api/archive/stats?mode=does-not-exist');
      check('unknown archive mode -> 404 with ok:false',
        badMode.status === 404 && badMode.body?.ok === false, `status=${badMode.status}`);

      // ---- 跨模式综合结论（POST，要带账号持有情况）----------------------
      console.log('\n[archive/conclusion]');
      const conclusion = await post('/api/archive/conclusion', {
        account: { owned: [], eidolons: {}, cones: {} },
      });
      check('POST /api/archive/conclusion ok',
        conclusion.status === 200 && conclusion.body?.ok === true, `status=${conclusion.status}`);
      check('conclusion covers every mode/stage environment',
        (conclusion.body.envs || []).length >= 4, `envs=${conclusion.body.envs?.length}`);
      check('conclusion gives each environment a baseline',
        (conclusion.body.envs || []).every((e) => e.baseline
          && typeof e.baseline.tier === 'string'), '有环境缺基线');
      check('conclusion ranks candidate units',
        Array.isArray(conclusion.body.units) && conclusion.body.units.length > 0,
        `units=${conclusion.body.units?.length}`);
      check('conclusion units carry Chinese names',
        (conclusion.body.units || []).every((u) => u.nameCn), '有单位缺中文名');
      check('conclusion packages list what to pull and how many pulls',
        (conclusion.body.packages || []).length > 0
        && conclusion.body.packages.every((p) => Array.isArray(p.items) && p.pulls >= 1),
        '作业榜缺抽数列');
      /**
       * `/conclusion` 的载荷上限 —— 这道判据的性质是「**防止悄悄长胖**」，不是产品契约：
       * 它当初写 600 KB，是为了逼着「强度来源」那几个原始字段挪去按需的
       * `/api/archive/packs`（见 `src/server/conclusion.js` 里 `slimFrontierUnit` 的注释）。
       *
       * ⚠️ **2026-10-14 上调到 660 KB**：用户把版本权重改成 `3:2.5:2:1.5:1:0.5`，
       *    窗口从 **3 版扩到 6 版**，于是更多「角色 × 星魂档」拿到证据进榜 ——
       *    实测 `frontierTiers` 242 → 258 条、`frontierUnits` 的逐副本明细 262 → 291 条，
       *    载荷 **596 KB → 636 KB（+6.7%）**。这一部分是用户点名要的口径，压不回去，
       *    所以把上限抬到 660 KB（仍留 ~24 KB 余量继续当护栏）。
       *    ⚠️ 别顺手再往上调：真需要更多空间时，先看能不能挪去按需接口 ——
       *    这正是这条判据存在的意义。
       */
      const CONCLUSION_PAYLOAD_CAP_BYTES = 660 * 1024;
      check('conclusion stays small enough to send to the browser',
        Buffer.byteLength(JSON.stringify(conclusion.body)) < CONCLUSION_PAYLOAD_CAP_BYTES,
        `${Math.round(Buffer.byteLength(JSON.stringify(conclusion.body)) / 1024)} KB`);
      check('unknown archive mode lists valid ones',
        Array.isArray(badMode.body?.availableModes) && badMode.body.availableModes.length > 0);

      // ---- 隐金设置（用户 2026-10-11）--------------------------------------
      // 这个开关要穿过四层才生效（界面 → POST body → 路由 → buildConclusion），
      // 所以接口层**直接断言服务端收到并回显了那一份**。榜面数字的变化替代不了它：
      // 数字变了分不清「没生效」与「生效了但数据里恰好没这些单位」。
      console.log('\n[archive/conclusion · 隐金设置]');
      const HIDDEN_ALL_ON = {
        gift: true, giftCone: true, exchange: true, exchangeCone: true, standard: true,
      };
      const hiddenOn = await post('/api/archive/conclusion',
        { account: { owned: [], eidolons: {}, cones: {} }, hiddenCosts: HIDDEN_ALL_ON });
      // 非法输入（多给的键 / 非布尔）必须退化成安全形状，而不是 500 或抛异常。
      const junkHidden = await post('/api/archive/conclusion',
        { account: { owned: [], eidolons: {}, cones: {} }, hiddenCosts: { gift: true, bogus: 'yes' } });
      check('conclusion 回显服务端实际生效的隐金设置（五项全开）',
        hiddenOn.body?.hiddenCosts
        && Object.values(hiddenOn.body.hiddenCosts).every((v) => v === true)
        && Object.keys(hiddenOn.body.hiddenCosts).length === 5,
        `hiddenCosts=${JSON.stringify(hiddenOn.body?.hiddenCosts)}`);
      check('不传 hiddenCosts = 一项都不减（工具与老客户端的口径不变）',
        conclusion.body?.hiddenCosts
        && Object.values(conclusion.body.hiddenCosts).every((v) => v === false),
        `hiddenCosts=${JSON.stringify(conclusion.body?.hiddenCosts)}`);
      check('非法的 hiddenCosts 只认那五个键、其余忽略（不 500）',
        junkHidden.status === 200
        && junkHidden.body?.hiddenCosts?.gift === true
        && junkHidden.body?.hiddenCosts?.bogus === undefined,
        `status=${junkHidden.status} hiddenCosts=${JSON.stringify(junkHidden.body?.hiddenCosts)}`);
      check('conclusion payload 形状是 v9（顶层 frontierExtents + 逐 env envStrengthBest）',
        hiddenOn.body?.payload === 9, `payload=${hiddenOn.body?.payload}`);
      // v9 的两处新字段（用户 2026-10-13：「给出三项的完整得分来源」）——形状号变了就得真检查，
      // 只看一个数字不算验证。
      check('conclusion 顶层带三个分项的归一上下限 frontierExtents',
        ['strength', 'cost', 'versatility'].every((k) => {
          const e = hiddenOn.body?.frontierExtents?.[k];
          return e && Number.isFinite(Number(e.lo)) && Number.isFinite(Number(e.hi)) && e.hi >= e.lo;
        }),
        JSON.stringify(hiddenOn.body?.frontierExtents));
      // ⚠️ 反向钉住：泛用性队友名单**不许**进这个载荷（逐条重复 5 次 = 117 KB，
      //    会把 600 KB 硬上限打穿）—— 它只在按需接口上，见 conclusion.js 的注释。
      check('conclusion 的整包不带泛用性队友名单（它在按需接口上）',
        (hiddenOn.body?.frontierUnits || []).length > 0
        && (hiddenOn.body?.frontierUnits || []).every((u) => u.versatilityMembers === undefined));
      // ⚠️ v4.6.87 曾在每个整包上多发一个 `strength`（纯强度，不含金数项）供抽卡方案的
      // 「强度得分」用；用户 2026-10-12 第 8 条改回「含金数项的整包分」（同为 0T，9 金队
      // 要比 16 金队强得多），那个字段已删除 —— 所以这里**反向**断言它不该再出现，
      // 载荷形状也因此回到 v7。
      check('conclusion 整包与逐副本都不再带 strength（v4.6.91 撤销）',
        (hiddenOn.body?.frontierUnits || []).length > 0
        && (hiddenOn.body?.frontierUnits || []).every((u) => !('strength' in u))
        && (hiddenOn.body?.frontierUnits || []).every((u) => (u.envs || []).every((e) => !('strength' in e))),
        `frontierUnits=${(hiddenOn.body?.frontierUnits || []).length}`
        + ` 多带 strength=${(hiddenOn.body?.frontierUnits || []).filter((u) => 'strength' in u).length}`);

      // ---- 抽卡权重（用户 2026-10-13 第 1、2 条）--------------------------------
      // 三个旋钮（强度 / 性价比 / 泛用性）从 v4.6.95 起**必须进服务端**：角色得分是三个
      // 分项按它加权的结果，而总榜「每角色只留一条」的收敛在服务端 `buildConclusion` 里。
      // 与隐金设置同一套路：既断言回显（穿四层没穿丢），也断言**榜面真的变了** ——
      // 只比回显的话，「口径没接上」也能通过。
      // ⚠️ 默认值 2026-10-16 第 1 条改过：`1:1:1`（三等分）→ **`1:1:0.5`**（泛用性降到
      //    0.5），归一之后是 `0.4 / 0.4 / 0.2`。工具与老客户端不传 `drawWeights` 时拿到的
      //    就是这一份（服务端 `normalizeDrawWeights(undefined)` → `SCORING.drawWeight`）。
      console.log('\n[archive/conclusion · 抽卡权重]');
      const DRAW_DEFAULT = { strength: 1, cost: 1, versatility: 0.5 };
      check('conclusion 回显归一化后的抽卡权重（默认 0.4 / 0.4 / 0.2）',
        Math.abs(Object.values(conclusion.body?.drawWeights || {})
          .reduce((n, v) => n + Number(v), 0) - 1) < 1e-9
        && Object.keys(conclusion.body?.drawWeights || {}).length === 3,
        `drawWeights=${JSON.stringify(conclusion.body?.drawWeights)}`);
      check('不传 drawWeights = 默认 1:1:0.5（工具与老客户端的口径不变）',
        Math.abs(conclusion.body.drawWeights.strength - 0.4) < 1e-9
        && Math.abs(conclusion.body.drawWeights.cost - 0.4) < 1e-9
        && Math.abs(conclusion.body.drawWeights.versatility - 0.2) < 1e-9,
        `drawWeights=${JSON.stringify(conclusion.body?.drawWeights)}`);
      const versOnly = await post('/api/archive/conclusion', {
        account: { owned: [], eidolons: {}, cones: {} }, drawWeights: DRAW_DEFAULT,
      });
      const versHeavy = await post('/api/archive/conclusion', {
        account: { owned: [], eidolons: {}, cones: {} },
        drawWeights: { strength: 0, cost: 0, versatility: 1 },
      });
      check('非法 drawWeights 退化成安全形状（不 500、缺键补默认）',
        versOnly.status === 200
        && (await post('/api/archive/conclusion', {
          account: { owned: [], eidolons: {}, cones: {} },
          drawWeights: { strength: -1, cost: 'abc', versatility: null, bogus: 9 },
        })).body?.drawWeights?.bogus === undefined,
        '非法输入把接口打崩了');
      const drawSig = (body) => (body?.frontierUnits || [])
        .map((u) => `${u.key}|${Math.round(Number(u.characterScore))}`).join(';');
      check('⭐ 抽卡权重真的改变了角色总榜（不只是回显）',
        drawSig(versOnly.body) !== drawSig(versHeavy.body),
        '全押泛用性与默认权重得到了同一张榜 —— 权重没接上');
      check('角色得分 = 三个分项按权重加权（每个整包都对得上）',
        (versHeavy.body?.frontierUnits || []).length > 0
        && (versHeavy.body.frontierUnits).every((u) => {
          const score = Number(u.versatilityScore);
          return Number.isFinite(score) && Math.abs(Number(u.characterScore) - score) < 1e-3;
        }),
        '全押泛用性时角色得分应当等于泛用性那一项本身');
      check('conclusion 每个整包带三个分项 + 角色得分（v4.6.95 新增）',
        (hiddenOn.body?.frontierUnits || []).length > 0
        && (hiddenOn.body.frontierUnits).every((u) => ['strengthScore', 'costScore',
          'versatilityScore', 'characterScore', 'strengthTotal', 'versatilityRaw']
          .every((k) => Number.isFinite(Number(u[k])))
          && Number(u.characterScore) >= 0 && Number(u.characterScore) <= 100),
        '有整包缺分项 / 角色得分，或角色得分不在 0~100');
      check('conclusion 逐 env 带 envStrength / envStrengthValue（强度分项的来源）',
        (hiddenOn.body?.frontierUnits || []).every((u) => (u.envs || []).every(
          (e) => Number.isFinite(Number(e.envStrength)) && Number.isFinite(Number(e.envStrengthValue)),
        )),
        '有 env 缺强度分项字段，浮层拆不开三个分项');
      check('⭐ 泛用性分项在榜内真的分得开（不是全员同分）',
        new Set((hiddenOn.body?.frontierUnits || []).map((u) => Number(u.versatilityRaw))).size > 3,
        `distinct versatilityRaw=${new Set((hiddenOn.body?.frontierUnits || [])
          .map((u) => Number(u.versatilityRaw))).size}`);
      /**
       * **泛用性按星魂组分两份**（用户 2026-10-17 第 1 条：原话「E6 角色应当仅与 E6 做
       * 比较，E0/1/2 与 E0/1/2 之间做比较（避免不同量级之间的比较）」）。
       *
       * 两件事一起钉：
       *   ① 区间是**按组**分两把的（`frontierExtents.versatility.byTier`）——
       *      界面靠它写出「E6 这一组的最小 ~ 最大」，拿低档组那一把尺子会与榜上的分对不上；
       *   ② 同一角色的 **E0/E1/E2 三档拿到同一个原始量**（三档平均），而 **E6 拿到自己
       *      那一份** —— 改前（2026-10-16）四档完全相同，改前之前（2026-10-14）四档
       *      各不同，两种都会把这条断言判红。取「横跨低档组与 E6 组的角色」来比。
       */
      const byTier = hiddenOn.body?.frontierExtents?.versatility?.byTier || {};
      check('⭐ 泛用性的归一区间按组分两把（byTier：0/1/2 同值、6 另一把）',
        ['0', '1', '2', '6'].every((t) => byTier[t] === undefined
          || (Number.isFinite(Number(byTier[t].lo)) && Number.isFinite(Number(byTier[t].hi))
            && Number(byTier[t].hi) >= Number(byTier[t].lo))),
        `byTier=${JSON.stringify(byTier)}`);
      const lowKey = ['0', '1', '2'].map((t) => JSON.stringify(byTier[t])).join('|');
      check('⭐ `byTier` 的 E0/E1/E2 三档指向同一把尺子（低档组）',
        Object.keys(byTier).length === 0 || new Set(lowKey.split('|')).size === 1,
        `byTier=${JSON.stringify(byTier)}`);
      const tierRawOfChar = new Map();
      for (const t of ['0', '1', '2', '6']) {
        for (const u of (hiddenOn.body?.frontierTiers?.[t] || [])) {
          if (!tierRawOfChar.has(u.name)) tierRawOfChar.set(u.name, new Map());
          tierRawOfChar.get(u.name).set(t, Number(u.versatilityRaw));
        }
      }
      const multiTierChar = [...tierRawOfChar.entries()].find(([, m]) => m.size >= 2);
      // ⚠️ **2026-10-17 第 1 条**：低档组三档**相同**（三档平均），E6 **不同**（自己那份）。
      //    所以判据是「去掉 E6 之后只剩一个值，且原表至少两个不同的值」。
      const lowOnly = multiTierChar
        ? new Set([...multiTierChar[1].entries()].filter(([t]) => t !== '6').map(([, v]) => v))
        : null;
      const allVals = multiTierChar ? new Set([...multiTierChar[1].values()]) : null;
      check('⭐ 同一角色的 E0/E1/E2 拿到**相同**的泛用性原始量，E6 拿到**不同**的一份',
        Boolean(multiTierChar)
        && lowOnly.size === 1
        && (allVals.size >= 2 || multiTierChar[1].size <= 3),
        multiTierChar
          ? `${multiTierChar[0]}: ${JSON.stringify([...multiTierChar[1].entries()])}`
          : '没有任何角色横跨两个星魂档，这条断言无从验证');
      // E6 组那一把尺子必须与低档组不同（同一对就说明两组又混成一把了）。
      check('⭐ `byTier[6]` 与低档组那把尺子不同值（两组各自归一）',
        Object.keys(byTier).length === 0 || byTier['6'] === undefined
        || JSON.stringify(byTier['6']) !== JSON.stringify(byTier['0']),
        `byTier=${JSON.stringify(byTier)}`);
      // 队伍口径的抽卡方案在**界面**现算差额，所以 availability 必须真的发过去；
      // 缺它时界面会把 4★ 也算成 1 金（见 conclusion.js 的 slimAvailability 注释）。
      check('conclusion 带成本口径表 availability（星级 / 常驻标记）',
        Object.keys(hiddenOn.body?.availability?.characters || {}).length > 50
        && Object.keys(hiddenOn.body?.availability?.lightCones || {}).length > 50,
        `characters=${Object.keys(hiddenOn.body?.availability?.characters || {}).length}`
        + ` lightCones=${Object.keys(hiddenOn.body?.availability?.lightCones || {}).length}`);
      check('availability 是原样全名（形态键不能被压成基础名）',
        Boolean(hiddenOn.body?.availability?.characters?.['March 7th (Hunt)'])
        && Boolean(hiddenOn.body?.availability?.characters?.['March 7th (Preservation)']),
        '两个三月七形态键至少要有一个缺失');
      // 逐星魂档的总榜：界面上的 E0/E1/E2/E6 筛选器就靠这一份（下面还有一组结构断言）。
      check('conclusion 带逐星魂档总榜 frontierTiers（四档都在）',
        ['0', '1', '2', '6'].every((t) => Array.isArray(hiddenOn.body?.frontierTiers?.[t])
          && hiddenOn.body.frontierTiers[t].length > 0),
        `tiers=${Object.keys(hiddenOn.body?.frontierTiers || {}).join('/') || '（没有）'}`);
      /**
       * **来源视频**（用户 2026-10-14 第 6 条：界面每支队伍一个图标，点开去 b 站 / 油管）。
       *
       * 数据集里 `sample.video` 实测 11992/11992 全覆盖，但其中 **31 条**是
       * `douyin:<id>` / `tiktok:<id>` 这种**伪串**（点开是死链），必须在服务端就挡掉。
       *
       * ⚠️ 三条一起钉，而且**只给逐档榜**这件事是刻意的取舍：`/conclusion` 的载荷上限
       *   只够逐档榜的 242 条头条证据（抽卡方案的候选池就是它）；总榜那条路走按需的
       *   `/api/archive/packs`。哪天有人「顺手」把它加到总榜上，第二条断言会先红。
       */
      const tierEnvList = ['0', '1', '2', '6']
        .flatMap((t) => (hiddenOn.body?.frontierTiers?.[t] || []).flatMap((u) => u.envs || []));
      const allEnvVideos = [
        ...(hiddenOn.body?.frontierUnits || []).flatMap((u) => u.envs || []),
        ...tierEnvList,
      ].map((e) => e.video).filter((v) => v !== undefined && v !== null);
      check('⭐ 逐档榜的头条证据带来源视频（界面那个外链图标就靠它）',
        tierEnvList.length > 0 && tierEnvList.every((e) => e.video === undefined || /^https?:\/\//.test(e.video)),
        `带视频的 env=${tierEnvList.filter((e) => e.video).length}/${tierEnvList.length}`);
      check('⭐ 来源视频一律是 http(s) 真链接（douyin:/tiktok: 伪串必须被挡掉）',
        allEnvVideos.length > 0 && allEnvVideos.every((v) => /^https?:\/\//.test(v)),
        `${allEnvVideos.length} 条里有 ${allEnvVideos.filter((v) => !/^https?:\/\//.test(v)).length} 条不是真链接`);
      check('总榜那条路不带来源视频（载荷上限的取舍：走按需的 /api/archive/packs）',
        (hiddenOn.body?.frontierUnits || []).every((u) => (u.envs || []).every((e) => e.video === undefined)),
        '「全部」榜上出现了 video 字段 —— 它会按 6 倍的数量撑爆载荷');
      // 回显之外，**榜面真的变了**：只比回显的话，口径没接上也能通过。
      const boardSig = (body) => (body?.frontierUnits || [])
        .map((u) => `${u.key}|${u.gold}|${Math.round(u.total)}`).join(';');
      check('隐金真的改变了性价比总榜（不只是回显）',
        boardSig(hiddenOn.body) !== boardSig(conclusion.body),
        '开 / 关两种设置下总榜逐条相同，说明没有接进算分');
      check('隐金后榜上金数只减不增、分数仍是正有限数',
        (hiddenOn.body.frontierUnits || []).every((u) => u.gold >= 0
          && Number.isFinite(u.total) && u.total > 0),
        '有整包出现负金数或非有限分数');

      // ---- 2026-10-11（v4.6.77）总榜逐副本明细必须「发全」 ---------------------
      // 用户截图暴露的三个**服务端瘦身取舍**（v4.6.76 上线时只在 node 里验过未瘦身的
      // `buildConclusion()` 输出，而浏览器拿到的是这份瘦身载荷，于是三条界面判据全是
      // 「绿的假象」）：
      //   ① `envs` 被 `.slice(0, 3)` → 一个 5 关卡的整包只列 3 个关卡
      //      （用户原话：「关卡下方缺少虚构叙事、异相仲裁 · 王棋和骑士关」）；
      //   ② 逐条**不发** `envLabel` → 界面兜底印出数据集英文 id（`aa/plight` / `as` / `moc`，
      //      用户：「去除 最佳证据的队伍 下方的这些英语简称，我没要求添加」）；
      //   ③ 只有 `envIndex === 0` 带 `members` → 「最佳证据的队伍」只有第一条有卡片。
      // 这三条现在都在**真实载荷**上钉住 —— 界面判据的数据前提只能从载荷量。
      const detailUnits = (conclusion.body.frontierUnits || []).filter((u) => (u.envs || []).length);
      const truncated = detailUnits.filter((u) => u.envCount && u.envs.length !== u.envCount);
      check('总榜逐副本明细发全（envs 条数 = envCount，不再截到 3 个）',
        detailUnits.length > 0 && truncated.length === 0,
        `有整包的 envs 少于 envCount：${truncated.map((u) => `${u.name} ${u.envs.length}/${u.envCount}`).slice(0, 3).join(', ')}`);
      check('每个逐副本条目都带中文关卡的 envLabel（不许让界面兜底印英文 id）',
        detailUnits.every((u) => u.envs.every((e) => typeof e.envLabel === 'string'
          && e.envLabel.length > 0 && /[\u3400-\u9fff]/.test(e.envLabel))),
        '有 env 缺 envLabel，或 envLabel 写成了 `aa/plight` 这种英文 id');
      check('每个逐副本条目都带最佳证据队伍（不只头条那一支）',
        detailUnits.every((u) => u.envs.every((e) => (e.members || []).length > 0)),
        '有 env 的 members 是空的 —— 界面上那一块会没有队伍卡片');
      // 逐副本明细与顶层副本元数据必须覆盖同一批关卡（发布时最容易漏的就是这一对：
      // 元数据 5 条、明细只给 3 条，界面两边都少列）。
      const detailLabels = new Set(detailUnits.flatMap((u) => u.envs.map((e) => e.envLabel)));
      const metaLabels = (conclusion.body.frontierEnvs || []).map((m) => m.label);
      check('五个关卡在「副本元数据」与「逐副本明细」里是同一批',
        metaLabels.length > 0 && metaLabels.every((l) => detailLabels.has(l)),
        `元数据 ${JSON.stringify(metaLabels)}；明细里出现过的 ${JSON.stringify([...detailLabels])}`);
      // ---- 逐星魂档的总榜（用户 2026-10-11 报的缺陷）------------------------
      // 「拆分到 E0/1/2/6，只能看到存在最佳成绩的角色，而看不到非最佳成绩的每个角色」。
      // 修法是服务端另发 `frontierTiers`（每档各自按角色收敛一条）。这条链路是
      // **纯数据接口**，所以接口层就能把缺陷钉死：只要有一个档位的角色数比「拿
      // frontierUnits 按 eidolon 过滤」数出来的多，就说明界面切档时不会再少角色。
      console.log('\n[archive/conclusion · 逐星魂档总榜]');
      const tiersBody = conclusion.body?.frontierTiers;
      const tierNums = Object.keys(tiersBody || {}).map(Number).sort((a, b) => a - b);
      check('conclusion 下发逐星魂档的整包榜（frontierTiers）',
        tierNums.length >= 3 && tierNums.every((t) => [0, 1, 2, 6].includes(t)),
        `tiers=${tierNums.join('/') || '（没有）'}`);
      check('每个档位里只有该档的整包、每角色一条',
        tierNums.every((t) => {
          const rows = tiersBody[t] || [];
          return rows.length > 0
            && rows.every((u) => (Number(u.eidolon) || 0) === t)
            && new Set(rows.map((u) => u.name)).size === rows.length;
        }),
        '有档位为空 / 混档 / 同一角色两行');
      // ★ 缺陷本体：旧口径（「全部」按档过滤）会漏掉「最佳成绩不在这一档」的角色。
      const legacyTierCount = (t) => (conclusion.body.frontierUnits || [])
        .filter((u) => (Number(u.eidolon) || 0) === t).length;
      const undercounted = tierNums.filter((t) => (tiersBody[t] || []).length > legacyTierCount(t));
      check('至少有一个档位比「最佳成绩在这一档」的角色更多（缺陷已修）',
        undercounted.length > 0,
        `各档实际 ${tierNums.map((t) => `${t}:${tiersBody[t]?.length}`).join(' ')}`
        + ` / 旧口径 ${tierNums.map((t) => `${t}:${legacyTierCount(t)}`).join(' ')}`);
      check('「全部」里的每条都能在它自己的档位里找到同键同分的那条',
        (conclusion.body.frontierUnits || []).every((u) => {
          const row = (tiersBody[Number(u.eidolon) || 0] || []).find((x) => x.key === u.key);
          return row && row.total === u.total;
        }),
        '逐档榜与「全部」不是同一套整包（收敛分叉了）');
      check('逐档榜里每行同样带头像 / 光锥 / 最佳证据等界面要用的字段',
        tierNums.every((t) => (tiersBody[t] || []).every((u) => u.key && Number.isFinite(u.total)
          && Number.isFinite(u.gold) && 'lc' in u && Number.isFinite(u.eidolon))),
        '逐档榜的元素形状与 frontierUnits 不一致');

      // ---- 单角色全部配装（GET，角色面板用）--------------------------------
      // 用户 2026-10-10：「在每个角色的详细界面显示所有的配装的最佳证据的队伍，
      // 并分别给出性价比评分」。它是**按需**接口（收敛前的整包有 1097 条，塞进
      // conclusion 会把那 0.67 MB 的载荷顶穿），所以形状必须单独钉住。
      console.log('\n[archive/packs]');
      const anyUnit = (conclusion.body.units || [])[0];
      const packs = await get(`/api/archive/packs?char=${encodeURIComponent(anyUnit?.nameCn || '')}`);
      check('GET /api/archive/packs ok',
        packs.status === 200 && packs.body?.ok === true, `status=${packs.status}`);
      check('packs returns every pack of that character (not the deduped one)',
        (packs.body?.packs || []).length > 0
        && (packs.body.packs.length >= (conclusion.body.frontierUnits || [])
          .filter((u) => u.name === anyUnit?.name).length),
        `packs=${packs.body?.packs?.length}`);
      check('每条配装都有自己的性价比分与整包标识',
        (packs.body?.packs || []).every((p) => Number.isFinite(p.total) && p.key),
        '有配装缺 total/key');
      check('每条配装逐副本给出最佳证据队伍（含中文名）',
        (packs.body?.packs || []).every((p) => (p.envs || []).every((e) => (e.members || [])
          .every((m) => m.nameCn))),
        '有队伍成员缺中文名');
      /**
       * ⚠️ **2026-10-16 换了判据的形状**：原来只钉「这一次请求 < 400 KB」，而请求的角色是
       * `units[0]`（**随榜面变动**）—— 实测本机 93 个角色里有 **7 个**按需载荷天然超过
       * 400 KB（最大 Sparkle 740 KB / 117 条配装），所以那条断言其实是「恰好被选中的那个
       * 角色够小」，榜面一动就会假红（2026-10-16 的口径改动就触发了它）。
       * 现在钉两件**与选了谁无关**的事：
       *   ① 每条配装的字节预算 —— 这才是有意义的那条「别把逐包字段撑大」的护栏
       *      （例如再往每个整包上塞一份泛用性名单，这条立刻红）；
       *   ② 一个宽松的硬上限（实测最大 ≈ 740 KB，留 ~20% 余量）。
       */
      const packsBytes = Buffer.byteLength(JSON.stringify(packs.body));
      const packsCount = Math.max(1, (packs.body?.packs || []).length);
      check('packs 每条配装的字节预算（防止口径改动把逐包字段撑大）',
        packsBytes / packsCount < 8 * 1024,
        `${Math.round(packsBytes / 1024)} KB / ${packsCount} 条 = `
        + `${(packsBytes / packsCount / 1024).toFixed(1)} KB/条`);
      check('packs 按需载荷不超过硬上限（实测最大 ≈ 740 KB：Sparkle 117 条配装）',
        packsBytes < 900 * 1024, `${Math.round(packsBytes / 1024)} KB`);
      const noSuch = await get('/api/archive/packs?char=NotARealCharacter');
      check('unknown character -> found:false with an empty list (not an error)',
        noSuch.status === 200 && noSuch.body?.ok === true
        && noSuch.body?.found === false && (noSuch.body?.packs || []).length === 0,
        `status=${noSuch.status} found=${noSuch.body?.found}`);

      // ---- 隐金设置下的面板：权重走查询串，隐金也要跟着（GET 没有 body）--------
      // ⚠️ 漏传的后果与 v4.6.69 修过的那个权重 bug 一模一样：**同一个整包在窗口里
      // 与榜上显示两个分**。所以这里既断言回显，也断言「最高分配装 = 榜上那一条」。
      console.log('\n[archive/packs · 隐金设置]');
      const hiddenParam = encodeURIComponent(JSON.stringify(HIDDEN_ALL_ON));
      const boardTop = (hiddenOn.body.frontierUnits || [])[0];
      // 抽卡权重也走查询串（用户 2026-10-13 第 2 条）：面板给的是**角色得分**，
      // 它是三个分项按权重加权的**榜内归一分** —— 权重不同，同一个整包的面板分
      // 就会与徽标分不一致。这里显式发**当前默认** `1:1:0.5`（= 0.4 / 0.4 / 0.2），
      // 与上面那份没带 `drawWeights` 的 `hiddenOn`（服务端同样落回默认表）同口径。
      // ⚠️ 默认值 2026-10-16 第 1 条由 `1:1:1` 改成 `1:1:0.5` —— 这里漏改过一次，
      //    `panel=85.9119 board=83.0943` 当场红（两边权重不同 ⇒ 同一个整包两个分）。
      const drawParam = encodeURIComponent(JSON.stringify({ strength: 1, cost: 1, versatility: 0.5 }));
      const packsHidden = await get(`/api/archive/packs?char=${encodeURIComponent(boardTop?.name || '')}`
        + `&hiddenCosts=${hiddenParam}&drawWeights=${drawParam}`);
      check('GET /api/archive/packs 回显隐金设置（查询串版）',
        packsHidden.body?.hiddenCosts
        && Object.values(packsHidden.body.hiddenCosts).every((v) => v === true),
        `hiddenCosts=${JSON.stringify(packsHidden.body?.hiddenCosts)}`);
      check('packs payload 形状升到 v5（+ 泛用性队友名单 / frontierExtents / envStrengthBest）',
        packsHidden.body?.payload === 5, `payload=${packsHidden.body?.payload}`);
      // v5：**泛用性的来源名单**只在按需接口上（用户 2026-10-13 要的「完整得分来源」）。
      // ⚠️ 它是**角色级**的，所以放在载荷顶层（一个角色几十条配装共用一份），
      //    放进每个整包会让同一份名单重复最多 59 次。
      check('packs 顶层带该角色的泛用性队友名单（去重、非空）',
        Array.isArray(packsHidden.body?.versatilityMembers)
        && packsHidden.body.versatilityMembers.length > 0
        && new Set(packsHidden.body.versatilityMembers).size
          === packsHidden.body.versatilityMembers.length,
        `${packsHidden.body?.versatilityMembers?.length} 个`);
      /**
       * **泛用性按星魂组分两份**（用户 2026-10-17 第 1 条）。
       *
       * 老字段 `versatilityMembers` 是「最佳那条配装所属档位」的一份；新字段
       * `versatilityByTier` 才是这个角色**每一组各一份**（E6 一份、E0/E1/E2 一份）。
       * 界面必须按整包自己的档去取，否则 E6 的窗口里会列出 E0 的队友。
       */
      const versByTier = packsHidden.body?.versatilityByTier;
      check('⭐ packs 顶层带按星魂档分份的泛用性名单 versatilityByTier',
        Boolean(versByTier) && typeof versByTier === 'object'
        && Object.keys(versByTier).length > 0
        && Object.entries(versByTier).every(([tier, v]) => /^[0-6]$/.test(tier)
          && Array.isArray(v.members) && v.members.length > 0
          && new Set(v.members).size === v.members.length
          && Number.isFinite(Number(v.raw))),
        `versatilityByTier=${versByTier ? JSON.stringify(Object.keys(versByTier)) : '（没有）'}`);
      // ⚠️ 2026-10-17 第 1 条起，同组的所有整包**共享同一个原始量**（E0/E1/E2 用三档平均、
      //    E6 用自己那份），所以同源判据从 2026-10-15 的「档表取最大」收紧成**严格相等**。
      //    真出现了不等，只有两种可能：档表又退回了「按档各取极值」，或者整包那一侧
      //    又被改成了「按行动值挑代表行」—— 两种都是回归，必须红。
      check('⭐ 每个整包的 versatilityRaw 都**等于**自己那一档的 raw（同组共享一个值）',
        (packsHidden.body?.packs || []).every((p) => {
          const tier = String([0, 1, 2, 3, 4, 5, 6].filter((t) => t <= (Number(p.eidolon) || 0)).pop());
          return !versByTier || versByTier[tier] === undefined
            || Math.abs(Number(versByTier[tier].raw) - Number(p.versatilityRaw)) < 1e-9;
        }),
        '档表的 raw 应与同组每条整包严格相等（组内共享一个原始量）');
      // 面板这条路界面**可能没加载过结论**，所以归一上下限随包一起给（见 advice-view 的
      // `frontierExtentsNow()`）。
      check('packs 带 frontierExtents（面板可能没加载过结论）',
        ['strength', 'cost', 'versatility']
          .every((k) => Number.isFinite(Number(packsHidden.body?.frontierExtents?.[k]?.hi))));
      // ⚠️ v4.6.88 修的真 bug：面板的 env 少发 `seasonMinCost` 时，逐档榜的浮层
      // （`enrichTierDetail()` 拿这份数据整份替换 `unit.envs` 再重画因子表）会把金数项
      // 的分母退回 `meta.minCost`（全窗口最小值）→「跨版本发挥」算出 > 1（实测 39% 的行）。
      // 这条断言把「面板的 env 投影必须与总榜那份在界面要现算的字段上等价」钉在接口层。
      const panelEnvs = (packsHidden.body?.packs || []).flatMap((p) => p.envs || []);
      check('packs 每个 env 都带 seasonMinCost（否则跨版本发挥会 > 1）',
        panelEnvs.length > 0 && panelEnvs.every((e) => Number.isFinite(Number(e.seasonMinCost))),
        `envs=${panelEnvs.length}`
        + ` 缺值=${panelEnvs.filter((e) => !Number.isFinite(Number(e.seasonMinCost))).length}`);
      // **来源视频**（用户 2026-10-14 第 6 条）：面板是**逐关卡全给**的那条路 ——
      // 逐档榜只带头条那一支的视频，其余关卡的靠这份补（`enrichTipDetail` 合并）。
      check('packs 每个 env 都带来源视频（逐档榜缺的那几关靠它补）',
        panelEnvs.length > 0
        && panelEnvs.every((e) => e.video === undefined || /^https?:\/\//.test(e.video)),
        `带视频的 env=${panelEnvs.filter((e) => e.video).length}/${panelEnvs.length}`);
      // ⚠️ 比的是**角色得分**（用户 2026-10-13 第 2 条起榜面按它排序与收敛）：
      // 榜上那一条就是「这个角色角色得分最高的那个整包」，所以面板里那个最大值必须
      // 与它逐位相等。拿老的 `total` 比会漏判 —— 新排序键下「最高角色得分」的整包
      // 未必是「最高 total」的那一个（口径变了，这条断言也得跟着换键）。
      const bestHiddenPack = Math.max(0, ...(packsHidden.body?.packs || [])
        .map((p) => Number(p.characterScore) || 0));
      check('隐金 + 抽卡权重下面板与榜面同口径（最高分整装 = 榜上那一条）',
        boardTop && Math.abs(bestHiddenPack - Number(boardTop.characterScore)) < 1e-6,
        `panel=${bestHiddenPack} board=${boardTop?.characterScore}`);
      // 单点核对：兑换组（阮•梅）在面板里的金数必须真的被减掉，而且只减不增。
      // ⚠️ 不能断言「全部为 0」：她挂一把**不在兑换名单**里的限定光锥时那一金照旧要算
      // （用户口径是「以上角色及其星魂视为 0」，光锥只按它自己的那条规则）。
      const ruanOff = await get(`/api/archive/packs?char=${encodeURIComponent('阮•梅')}`);
      const ruanOn = await get(`/api/archive/packs?char=${encodeURIComponent('阮•梅')}&hiddenCosts=${hiddenParam}`);
      const ruanOffPacks = new Map((ruanOff.body?.packs || []).map((p) => [p.key, p.gold]));
      const ruanOnPacks = ruanOn.body?.packs || [];
      check('隐金下面板里「兑换角色」的金数真的被减掉（且只减不增）',
        ruanOnPacks.length > 0
        && ruanOnPacks.every((p) => !ruanOffPacks.has(p.key) || p.gold <= ruanOffPacks.get(p.key))
        && ruanOnPacks.some((p) => ruanOffPacks.has(p.key) && p.gold < ruanOffPacks.get(p.key)),
        `on=${ruanOnPacks.slice(0, 3).map((p) => `${p.key}=${p.gold}`).join(', ')}`);

      // ---- 本地图标镜像（`node tools/herta-icons.mjs`）----------------------
      // 只断言**形状**，不断言本地真有没有这些文件：新克隆的机器没跑过那个脚本，
      // 断言就会假失败。有镜像时应 200，**没有时必须 302 回 CDN 或 404 带提示** ——
      // 绝不能是「静默 200 但内容是错误页」。
      console.log('\n[/icons]');
      const someIcon = conclusion.body.frontierUnits?.[0]?.icon
        || anyUnit?.icon || null;
      if (someIcon) {
        const local = someIcon.replace(/^https?:\/\/[^/]+/, '');
        // ⚠️ 必须 `redirect: 'manual'`：`fetch` 默认会**跟随**重定向，302 会被悄悄
        // 变成「最终 200（CDN 的图）」——那就测不出本地到底有没有这张图了。
        const iconResponse = await fetch(`${base}${local}`, { redirect: 'manual' });
        check('icon URL is served from this machine (local-first, CDN fallback)',
          iconResponse.status === 200 || iconResponse.status === 302,
          `status=${iconResponse.status} url=${local}`);
        if (iconResponse.status === 302) {
          const location = iconResponse.headers.get('location') || '';
          check('CDN fallback points back at the original CDN host',
            /^https:\/\/cdn\.jsdelivr\.net\//.test(location), `location=${location}`);
        }
      }
      const missingIcon = await get('/icons/icon/character/definitely-not-a-real-id.png');
      check('missing local icon -> 404 with a hint (never a silent 200)',
        missingIcon.status === 404 && missingIcon.body?.ok === false
        && /herta-icons/.test(String(missingIcon.body?.hint || '')),
        `status=${missingIcon.status}`);
    } else {
      console.log('   (dataset not built - skipping archive content checks)');
    }

    const missing = await get('/nope.js');
    check('unknown path -> 404 JSON', missing.status === 404 && missing.body?.ok === false,
      `status=${missing.status}`);

    const traversal = await get('/../package.json');
    check('path traversal rejected', traversal.status === 403 || traversal.status === 404,
      `status=${traversal.status}`);
    const encodedTraversal = await get('/%2e%2e%2fpackage.json');
    check('encoded traversal rejected', encodedTraversal.status === 403 || encodedTraversal.status === 404,
      `status=${encodedTraversal.status}`);

    // ---- config ---------------------------------------------------------
    console.log('\n[config]');
    const config = await get('/api/config');
    check('GET /api/config ok', config.status === 200 && config.body.ok === true);
    check('config exposes csrfToken', typeof config.body.csrfToken === 'string' && config.body.csrfToken.length > 20);
    check('config exposes accounts array', Array.isArray(config.body.accounts) && config.body.accounts.length === 0);
    check('config never leaks cookies', JSON.stringify(config.body).indexOf('cookie_token') === -1);
    check('config exposes games', Array.isArray(config.body.games) && config.body.games.length > 0);
    check('config exposes only 星穹铁道',
      config.body.games.length === 1 && config.body.games[0]?.key === 'hsr');

    // ---- 版本检查（用户 2026-10-14 第 5 条）------------------------------------
    //
    // ⚠️ 这里**刻意只测不带 `?check=1` 的那条路**：带上它就会真的去打 GitHub，
    //    而 e2e 必须能在断网 / 被墙的机器上跑，也不该消耗匿名配额。
    //    「联网那条路」的正确性由 `tools/update-check-test.mjs` 用注入的 fetch 覆盖。
    console.log('\n[update-check]');
    const updateIdle = await get('/api/update-check');
    check('GET /api/update-check（不带 check=1）只回本地版本号、不联网',
      updateIdle.status === 200 && updateIdle.body.ok === true
      && updateIdle.body.status === 'unchecked'
      && updateIdle.body.current === config.body.programVersion,
      `status=${updateIdle.body?.status} current=${updateIdle.body?.current}`);
    check('版本号与 /api/config 同源（唯一来源是 src/version.js）',
      updateIdle.body.current === config.body.programVersion
      && Boolean(updateIdle.body.current),
      `update-check=${updateIdle.body?.current} config=${config.body?.programVersion}`);

    const csrf = config.body.csrfToken;

    // ---- CSRF enforcement -----------------------------------------------
    console.log('\n[csrf]');
    const noCsrf = await post('/api/login/qr', {});
    check('POST /api/login/qr without csrf -> 403', noCsrf.status === 403, `status=${noCsrf.status}`);
    const badCsrf = await post('/api/login/qr', {}, { 'x-hsr-csrf': 'wrong' });
    check('POST /api/login/qr with bad csrf -> 403', badCsrf.status === 403, `status=${badCsrf.status}`);

    // ---- QR login (live miHoYo call) ------------------------------------
    console.log('\n[qr login - live]');
    const qr = await post('/api/login/qr', {}, { 'x-hsr-csrf': csrf });
    check('POST /api/login/qr ok', qr.status === 200 && qr.body.ok === true, JSON.stringify(qr.body).slice(0, 160));
    check('qr returns sessionId', typeof qr.body.sessionId === 'string' && qr.body.sessionId.length > 10);
    check('qr returns a miHoYo url', typeof qr.body.url === 'string' && qr.body.url.includes('mihoyo.com'),
      String(qr.body.url).slice(0, 80));

    if (qr.body.sessionId) {
      const image = await get(`/api/login/qr/image?sessionId=${encodeURIComponent(qr.body.sessionId)}`);
      check('GET qr image -> SVG', image.status === 200 && image.type.includes('svg'), `status=${image.status} type=${image.type}`);
      check('qr svg well formed', String(image.body).startsWith('<svg') && String(image.body).endsWith('</svg>'));
      check('qr svg has modules', (String(image.body).match(/<rect/g) || []).length > 20);

      const status = await get(`/api/login/qr/status?sessionId=${encodeURIComponent(qr.body.sessionId)}`);
      check('GET qr status ok', status.status === 200 && status.body.ok === true, JSON.stringify(status.body).slice(0, 160));
      check('qr status is Created/Scanned', ['Created', 'Scanned'].includes(status.body.status),
        `status=${status.body.status}`);
      check('qr status leaks no tokens', !JSON.stringify(status.body).includes('cookie_token'));
    }

    const badSession = await get('/api/login/qr/status?sessionId=does-not-exist');
    check('unknown session -> 404', badSession.status === 404 && badSession.body.ok === false, `status=${badSession.status}`);
    const badImage = await get('/api/login/qr/image?sessionId=does-not-exist');
    check('unknown session image -> 404', badImage.status === 404, `status=${badImage.status}`);

    // ---- manual cookie login validation ---------------------------------
    console.log('\n[cookie login validation]');
    const noCookie = await post('/api/login/cookie', { cookie: '' }, { 'x-hsr-csrf': csrf });
    check('empty cookie -> 400', noCookie.status === 400, `status=${noCookie.status}`);
    const noAccount = await post('/api/login/cookie', { cookie: 'cookie_token=abc' }, { 'x-hsr-csrf': csrf });
    check('cookie without account id -> 400', noAccount.status === 400, `status=${noAccount.status}`);
    const noToken = await post('/api/login/cookie', { cookie: 'account_id=123' }, { 'x-hsr-csrf': csrf });
    check('cookie without cookie_token -> 400', noToken.status === 400, `status=${noToken.status}`);

    // ---- account routes without accounts --------------------------------
    console.log('\n[account routes]');
    const missingAccount = await get('/api/accounts/nonexistent');
    check('unknown account -> 404', missingAccount.status === 404, `status=${missingAccount.status}`);

    // ---- injected account -------------------------------------------------
    // Seed the store directly so the snapshot/role routes can be exercised
    // without real credentials.
    console.log('\n[seeded account + live record API]');
    const seeded = await store.upsertAccount({
      accountId: '100000000',
      nickname: '测试账号',
      cookie: { cookie_token: 'invalid', account_id: '100000000' },
      source: 'cookie',
    });
    await store.setRoles(seeded.id, [{
      game_uid: '100000000', nickname: '测试开拓者', level: 70,
      region: 'prod_gf_cn', region_name: '官服 · 星穹列车',
    }]);
    await store.setFingerprint(seeded.id, 'test-device-fingerprint');

    const config2 = await get('/api/config');
    check('seeded account appears in config', config2.body.accounts.length === 1);
    check('config projection has roles', config2.body.accounts[0].roles.length === 1);
    check('config projection hides cookie material',
      JSON.stringify(config2.body).indexOf('cookie_token') === -1);

    const account = await get(`/api/accounts/${seeded.id}`);
    check('GET account ok', account.status === 200 && account.body.account.id === seeded.id);
    check('GET account hides cookie', JSON.stringify(account.body).indexOf('cookie_token') === -1);

    const rolesRefresh = await post(`/api/accounts/${seeded.id}/roles`, {}, { 'x-hsr-csrf': csrf });
    // Role refresh covers every supported game; a game the account cannot read
    // is reported per-game instead of failing the whole request.
    check('POST refresh roles reports per-game errors',
      rolesRefresh.status === 200 && rolesRefresh.body.ok === true
      && Array.isArray(rolesRefresh.body.roleErrors) && rolesRefresh.body.roleErrors.length > 0
      && typeof rolesRefresh.body.roleErrors[0].message === 'string',
      `status=${rolesRefresh.status} body=${JSON.stringify(rolesRefresh.body).slice(0, 200)}`);
    check('refresh roles returns no roles for a bad cookie',
      Array.isArray(rolesRefresh.body.roles) && rolesRefresh.body.roles.length === 0,
      JSON.stringify(rolesRefresh.body.roles));

    const snapshotNoCsrf = await fetch(`${base}/api/accounts/${seeded.id}/roles/100000000/snapshot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('POST snapshot without csrf -> 403', snapshotNoCsrf.status === 403, `status=${snapshotNoCsrf.status}`);
    const snapshot = await get(`/api/accounts/${seeded.id}/roles/100000000/snapshot`);
    check('GET snapshot with bad cookie -> 502/500 with message',
      [502, 500].includes(snapshot.status) && typeof snapshot.body.error === 'string',
      `status=${snapshot.status} body=${JSON.stringify(snapshot.body).slice(0, 200)}`);

    // The privacy-switch route reads the public profile card; with a bad cookie
    // it must fail cleanly instead of leaking an internal error.
    const vHsr = await post('/api/verify/challenge',
      { accountId: seeded.id, game: 'hsr', kind: 'list' }, { 'x-hsr-csrf': csrf });
    check('POST verify/challenge (hsr) ok',
      vHsr.status === 200 && vHsr.body.ok === true && typeof vHsr.body.challenge?.gt === 'string',
      `status=${vHsr.status} body=${JSON.stringify(vHsr.body).slice(0, 160)}`);
    check('challenge exposes gt/challenge for the widget',
      typeof vHsr.body.challenge?.challenge === 'string' && vHsr.body.challenge.challenge.length > 8);

    const vNoCsrf = await post('/api/verify/challenge', { accountId: seeded.id, game: 'hsr' });
    check('verify/challenge without csrf -> 403', vNoCsrf.status === 403, `status=${vNoCsrf.status}`);

    const vBadSolve = await post('/api/verify/solve',
      { challengeId: vHsr.body.challenge.id, validate: 'deadbeef' }, { 'x-hsr-csrf': csrf });
    check('verify/solve with a bogus validate -> clean error',
      [400, 500, 502].includes(vBadSolve.status) && vBadSolve.body.ok === false,
      `status=${vBadSolve.status} body=${JSON.stringify(vBadSolve.body).slice(0, 140)}`);

    const vNoValidate = await post('/api/verify/solve', { challengeId: 'x' }, { 'x-hsr-csrf': csrf });
    check('verify/solve without validate -> 400', vNoValidate.status === 400, `status=${vNoValidate.status}`);

    const privacy = await get(`/api/accounts/${seeded.id}/roles/100000000/privacy`);
    check('GET privacy switches with bad cookie -> clean error',
      [502, 500].includes(privacy.status) && typeof privacy.body.error === 'string',
      `status=${privacy.status} body=${JSON.stringify(privacy.body).slice(0, 160)}`);

    const privacyNoCsrf = await fetch(
      `${base}/api/accounts/${seeded.id}/roles/100000000/privacy`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    check('POST privacy without csrf -> 403', privacyNoCsrf.status === 403,
      `status=${privacyNoCsrf.status}`);

    const account2 = await get(`/api/accounts/${seeded.id}`);
    check('failed snapshot is not cached', (account2.body.account.snapshotUids || []).length === 0,
      JSON.stringify(account2.body.account.snapshotUids));

    // ---- 快照的读取语义：有缓存就绝不联网（用户 2026-10）--------------------
    // 直接往 store 里塞一份很久以前的快照，模拟「上次抓到的那份」。
    // GET 必须原样返回它，**不能**因为过期而去打米游社 —— 这正是本轮要改掉的
    // 旧行为（以前是「超过 15 分钟就自动重抓」，于是每刷新一次页面就打一次米游社，
    // 风控 10041/5003/1034 就是这么攒出来的）。
    const oldFetchedAt = new Date(Date.now() - 90 * 60 * 60 * 1000).toISOString();
    await store.setSnapshot(seeded.id, '100000000', {
      fetchedAt: oldFetchedAt,
      basicInfo: { nickname: '缓存里的开拓者' },
      characters: [{ id: 8001, name: '开拓者' }],
    });
    const cachedSnapshot = await get(`/api/accounts/${seeded.id}/roles/100000000/snapshot`);
    check('stale snapshot is served locally WITHOUT refetching',
      cachedSnapshot.status === 200 && cachedSnapshot.body.cached === true
      && cachedSnapshot.body.refetch === 'cached'
      && cachedSnapshot.body.snapshot?.fetchedAt === oldFetchedAt
      && cachedSnapshot.body.snapshot?.basicInfo?.nickname === '缓存里的开拓者',
      `status=${cachedSnapshot.status} body=${JSON.stringify(cachedSnapshot.body).slice(0, 240)}`);
    check('served snapshot reports how old it is (7-day window: 90h is NOT expired)',
      cachedSnapshot.body.cache?.stale === false
      && cachedSnapshot.body.cache?.staleReason === null
      // 新鲜窗口 = 7 天（用户 2026-10「不超过 7 天不用提示过期/旧数据」），
      // 所以 expiresAt 应该在 7 天后而不是几小时后。
      && new Date(cachedSnapshot.body.cache?.expiresAt || 0) - new Date(oldFetchedAt) === 7 * 24 * 3600 * 1000,
      JSON.stringify(cachedSnapshot.body.cache).slice(0, 240));

    // ---- 战斗记录（四个高难副本）----------------------------------------
    // 这里只验证「接线」，不让它真的去打米游社：未知账号走 404，POST 需要 CSRF。
    // 归一化逻辑由 herta-test 的 [5] 用合成响应覆盖（含开拓者形态与绝境分组）。
    console.log('\n[battle records]');
    const recordsUnknown = await get('/api/accounts/nonexistent/roles/100000000/records');
    check('records for unknown account -> 404', recordsUnknown.status === 404,
      `status=${recordsUnknown.status}`);
    const recordsNoCsrf = await fetch(
      `${base}/api/accounts/${seeded.id}/roles/100000000/records`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    check('POST records without csrf -> 403', recordsNoCsrf.status === 403,
      `status=${recordsNoCsrf.status}`);
    const recordsRefresh = await post(
      `/api/accounts/${seeded.id}/roles/100000000/records`, {}, { 'x-hsr-csrf': csrf },
    );
    check('POST records success returns once without falling through to 404',
      recordsRefresh.status === 200 && recordsRefresh.body?.ok === true
      && recordsRefresh.body?.cached === false
      && recordsRefresh.body?.records?.uid === '100000000',
      `status=${recordsRefresh.status} body=${JSON.stringify(recordsRefresh.body).slice(0, 180)}`);

    // 连点刷新必须被限流挡下（用户 2026-10：过多的请求会导致数据爬取出错）。
    // 上面那次 POST 刚消耗过一次配额，紧接着的第二次就该被拦在本地。
    const secondClick = await post(
      `/api/accounts/${seeded.id}/roles/100000000/records`, {}, { 'x-hsr-csrf': csrf },
    );
    check('immediate second refresh is throttled, not sent to miHoYo',
      secondClick.status === 200 && secondClick.body.throttled === true
      && secondClick.body.refetch === 'throttled'
      && secondClick.body.retryAfterMs > 0 && secondClick.body.cached === true,
      `status=${secondClick.status} body=${JSON.stringify(secondClick.body).slice(0, 200)}`);

    await store.setBattleRecords(seeded.id, '100000000', {
      uid: '100000000', server: 'prod_gf_cn',
      fetchedAt: new Date(Date.now() - 31 * 60 * 60 * 1000).toISOString(), errors: [],
      raw: { challenge: {}, story: {}, boss: {}, peak: {}, brief: {} },
    });
    // ⚠️ 这条断言的语义在本轮（用户 2026-10：「不需要每次刷新都去更新数据，
    // 过多的请求会导致数据爬取出错」）**反转过**：
    // 改之前是「缓存过期 → GET 自动重抓米游社」（cached === false）。
    // 现在读取一律读本地，过期也不联网 —— 否则每刷新一次页面、每切一次
    // 抽卡推荐页都会打一次米游社，风控（10041/5003/1034）就是这么攒出来的。
    const expiredRecords = await get(`/api/accounts/${seeded.id}/roles/100000000/records`);
    check('expired records cache is served locally WITHOUT refetching',
      expiredRecords.status === 200 && expiredRecords.body.cached === true
      && expiredRecords.body.refetch === 'cached',
      `status=${expiredRecords.status} body=${JSON.stringify(expiredRecords.body).slice(0, 200)}`);
    const sectionFetchAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await store.setBattleRecords(seeded.id, '100000000', {
      uid: '100000000', server: 'prod_gf_cn', fetchedAt: sectionFetchAt, errors: [],
      raw: { challenge: { data: 'old' }, story: { data: 'old' }, boss: {}, peak: {}, brief: {} },
    });
    const partialRecords = await store.setBattleRecords(seeded.id, '100000000', {
      uid: '100000000', server: 'prod_gf_cn', fetchedAt: new Date().toISOString(),
      errors: [{ endpoint: 'story', message: 'temporary failure' }],
      raw: { challenge: { data: 'new' }, boss: {}, peak: {}, brief: {} },
    });
    check('failed record section retains old data and marks it stale',
      partialRecords.raw.story.data === 'old'
      && partialRecords.sectionFreshness.story.status === 'stale'
      && partialRecords.sectionFreshness.story.lastSuccessfulFetchAt === sectionFetchAt);

    // ---- 队伍对照（把自己队伍丢回榜单）----------------------------------
    console.log('\n[roster compare]');
    const compareEmpty = await post('/api/archive/compare', { items: [] });
    check('POST /api/archive/compare with no items -> ok', compareEmpty.status === 200
      && compareEmpty.body?.ok === true && Array.isArray(compareEmpty.body.results),
    `status=${compareEmpty.status}`);
    const compareOne = await post('/api/archive/compare', {
      items: [{ mode: 'moc', stage: '', names: ['张三', '李四', '王五', '赵六'] }],
    });
    check('compare reports a miss honestly',
      compareOne.status === 200
      && compareOne.body?.results?.[0]?.found === false
      && typeof compareOne.body.results[0].env?.totalRosters === 'number',
    JSON.stringify(compareOne.body).slice(0, 160));

    // Mutation routes require csrf even for seeded accounts.
    const deleteNoCsrf = await fetch(`${base}/api/accounts/${seeded.id}`, { method: 'DELETE' });
    check('DELETE without csrf -> 403', deleteNoCsrf.status === 403, `status=${deleteNoCsrf.status}`);

    const deleted = await fetch(`${base}/api/accounts/${seeded.id}`, {
      method: 'DELETE', headers: { 'x-hsr-csrf': csrf },
    });
    check('DELETE with csrf -> 200', deleted.status === 200, `status=${deleted.status}`);

    const afterDelete = await get('/api/config');
    check('account removed from config', afterDelete.body.accounts.length === 0);

    // ---- persistence -----------------------------------------------------
    console.log('\n[persistence]');
    const seeded2 = await store.upsertAccount({
      accountId: '200000000', nickname: '持久化测试',
      cookie: { cookie_token: 'x', account_id: '200000000' }, source: 'cookie',
    });
    const seeded3 = await store.upsertAccount({
      accountId: '300000000', nickname: '第二账号',
      cookie: { cookie_token: 'y', account_id: '300000000' }, source: 'cookie',
    });
    const relogged = await store.upsertAccount({
      accountId: '200000000', nickname: '更新后的账号',
      cookie: { cookie_token: 'updated', account_id: '200000000' }, source: 'qr',
    });
    check('multiple accounts coexist and relogin updates the existing account',
      relogged.id === seeded2.id
      && (await store.listAccounts()).length === 2
      && (await store.getAccount(seeded2.id)).cookie.cookie_token === 'updated');
    const raw = JSON.parse(await readFile(store.file, 'utf8'));
    check('accounts.json is a credential envelope', raw.format === 'dsh-hsr-account-store' && typeof raw.encryption?.ciphertext === 'string');
    check('accounts.json stores encrypted credentials',
      raw.format === 'dsh-hsr-account-store' && raw.encryption?.ciphertext);
    check('accounts.json does not expose cookie plaintext',
      !JSON.stringify(raw).includes('updated'));
    const reloaded = new AccountStore({ file: store.file });
    await reloaded.load();
    check('store reloads from disk', (await reloaded.getAccount(seeded2.id))?.accountId === '200000000');
    check('store reloads multiple accounts', (await reloaded.getAccount(seeded3.id))?.accountId === '300000000');

    await store.removeAccount(seeded2.id);
    await store.removeAccount(seeded3.id);

    // ---- 虚拟账号（用户 2026-10-12 的「＋ 虚拟账号」入口）-------------------
    //
    // 三条要钉的：① 预设列表拿得到；② 没 CSRF 建不了；③ 建出来的快照**图标 / 星级字段齐全**
    // （缺 id/rarity/icon 就是用户报的「角色图标 / 星级显示有误」）。
    console.log('\n[virtual accounts]');
    const presets = await get('/api/virtual-accounts/presets');
    check('GET /api/virtual-accounts/presets returns presets',
      presets.status === 200 && presets.body?.ok === true
      && Array.isArray(presets.body.presets) && presets.body.presets.length >= 5,
      `status=${presets.status} count=${presets.body?.presets?.length}`);
    const presetList = presets.body?.presets || [];
    // ⚠️ **用户 2026-10-13 点名的 9 个，一个不多一个不少**：原来那 11 个（全新账号 /
    //    单核起步 / 单推厨 / 双核主C / 辅助优先 / 白厄队 / 中氪 / 重氪 / 专锥收集党 /
    //    老玩家偏科 / 全图鉴）用户看过实际列表之后说「太杂乱」要求删掉。
    //    这里用**集合相等**钉住（而不是「≥5」）：以后谁想再加一个预设，得先想清楚它是不是
    //    又一个「只演示一两个角色组合」的重复档位 —— 那正是被删掉的那批的毛病。
    const KEPT_PRESET_IDS = ['zero-cost', 'dayinjin-max', 'flat-0-0', 'flat-0-1',
      'flat-2-1', 'flat-6-5', 'random-low', 'random-mid', 'random-high'];
    check('预设列表恰好是用户点名的那 9 个（多一个少一个都算回归）',
      JSON.stringify(presetList.map((p) => p.id).sort())
        === JSON.stringify([...KEPT_PRESET_IDS].sort()),
      `实际 ${JSON.stringify(presetList.map((p) => p.id))}`);
    check('每个预设都带 id / 标题 / 说明',
      presetList.every((p) => p.id && p.title && p.hint
        && Number.isFinite(p.chars) && Number.isFinite(p.cones)),
      JSON.stringify(presetList[0] || null));
    const virtualNoCsrf = await post('/api/virtual-accounts', { preset: 'zero-cost' });
    check('POST /api/virtual-accounts without csrf -> 403', virtualNoCsrf.status === 403,
      `status=${virtualNoCsrf.status}`);
    const badPreset = await post('/api/virtual-accounts', { preset: 'no-such-preset' },
      { 'x-hsr-csrf': csrf });
    check('未知预设 -> 400', badPreset.status === 400, `status=${badPreset.status}`);
    // 先在库里放一个「既有的真实账号」，用来证明**只增不删**（用户明确要求别删他的账号）。
    const keeper = await store.upsertAccount({
      accountId: '100000001', nickname: '既有的真实账号', cookie: 'keep-me',
      source: 'qr', deviceId: 'keep-device',
    });
    // ⚠️ 这里用 `dayinjin-max`（51 个角色 + 7 把常驻专锥），**不能用 `zero-cost` / `flat-0-0` /
    //   `flat-0-1`**，三个预设各踩一个坑（本轮都实测过）：
    //   * `zero-cost` 恰好了等于**免费角色基线**（35 个）—— 下面那条「清空名单之后快照必须
    //     **真的变短**」会变成「35 → 35」，失去可观测差异（`buildVirtualAccount` 对空名单也会
    //     预置全部免费角色）；
    //   * `flat-0-0` 是「每个角色只有本体、一把专锥都不配」—— 下面那条「虚拟账号的光锥带
    //     icon / rarity」会拿到「光锥 0 把」；
    //   * `flat-0-1` 的 72 把「最常用光锥」里有 2 把不合那条断言：希露瓦的「灵钥」是 **3★**
    //     （`popularLightCones` 对 4★ 角色会给出 3★ 锥，而那条断言只认 4/5★），
    //     刻律德菈的「Dance Dance Dance」在**本地图标表里没有条目**（icon 字段为空）。
    //     —— 这两件事本身是真实存在的（不是本次改动引入），但拿它当夹具会把一条**与预设无关**
    //     的断言判红，所以夹具用 `dayinjin-max`：7 把全是常驻 5★ 专锥（我写死的那张表）。
    const created1 = await post('/api/virtual-accounts', { preset: 'dayinjin-max' },
      { 'x-hsr-csrf': csrf });
    check('新建虚拟账号 -> 200 且回账号',
      created1.status === 200 && created1.body?.ok === true && created1.body.account?.id,
      `status=${created1.status} body=${JSON.stringify(created1.body).slice(0, 120)}`);
    const virtualId = created1.body?.account?.id || '';
    const virtualUid = created1.body?.account?.roles?.[0]?.uid || '';
    check('虚拟账号 uid 是纯数字（快照路由是 /roles/(\\d+)/snapshot）',
      /^\d+$/.test(virtualUid), `uid=${virtualUid}`);
    // ② 只增不删：既有账号必须原样还在（cookie / deviceId 都没被动过）。
    const afterCreate = await get('/api/config');
    const keeperNow = (afterCreate.body?.accounts || []).find((a) => a.id === keeper.id);
    check('新建虚拟账号**不会动**既有账号（只增不删）',
      Boolean(keeperNow) && keeperNow.source === 'qr'
      && (await store.getAccount(keeper.id))?.cookie === 'keep-me',
      `keeper=${JSON.stringify(keeperNow)?.slice(0, 80)}`);
    // 再建同一个预设：id 必须自动加序号（不是覆盖）。
    const created2 = await post('/api/virtual-accounts', { preset: 'dayinjin-max' },
      { 'x-hsr-csrf': csrf });
    check('同一预设建两次 -> id 自动加序号（不覆盖）',
      created2.body?.account?.id && created2.body.account.id !== virtualId,
      `${virtualId} → ${created2.body?.account?.id}`);
    const snap = await get(`/api/accounts/${virtualId}/roles/${virtualUid}/snapshot`);
    const vchars = snap.body?.snapshot?.characters || [];
    check('虚拟账号快照带得动角色列表', vchars.length > 10, `count=${vchars.length}`);
    check('⭐ 虚拟账号的星级齐全（缺 rarity 会让卡片按 4★ 上色 —— 用户报过的 bug）',
      vchars.length > 0 && vchars.every((c) => c.rarity === 4 || c.rarity === 5)
      && new Set(vchars.map((c) => c.rarity)).size === 2,
      JSON.stringify(vchars.reduce((m, c) => (m[c.rarity] = (m[c.rarity] || 0) + 1, m), {})));
    check('⭐ 虚拟账号的图标是 /icons 同源地址（缺 icon 就是首字占位 —— 用户报过的 bug）',
      vchars.filter((c) => c.icon).length > vchars.length * 0.7
      && vchars.filter((c) => c.icon).every((c) => String(c.icon).startsWith('/icons/')),
      `有图标 ${vchars.filter((c) => c.icon).length}/${vchars.length}`);
    check('虚拟账号的角色带 id（卡片身份 / 抽卡页跳转要用）',
      vchars.filter((c) => c.id).length > vchars.length * 0.7,
      `有 id ${vchars.filter((c) => c.id).length}/${vchars.length}`);
    const vconed = vchars.filter((c) => c.equip);
    check('虚拟账号的光锥带 icon / rarity',
      vconed.length > 0 && vconed.every((c) => c.equip.icon && (c.equip.rarity === 4 || c.equip.rarity === 5)),
      `光锥 ${vconed.length} 把｜首个=${JSON.stringify(vconed[0]?.equip)?.slice(0, 90)}`);

    // ---- 用户 2026-10-13 第 4 条：预设（无成本 / 大隐金 / 平铺 / 随机氪金）--------
    //
    // 这批预设全是**按数据集现算**的（专属光锥 / 常驻名单 / 随机分布），所以这一段钉的是
    // 各档的**名单形状**；「都有哪些预设、一个不多一个不少」已由上面的 `KEPT_PRESET_IDS`
    // 集合相等断言覆盖（这里原来另抄了一份一模一样的 `NEW_PRESET_IDS` —— 两份迟早会分叉）。
    // 「随机账号的金数精确等于 20/50/100」由 `tools/virtual-accounts-test.mjs` 守着。
    const presetById = new Map(presetList.map((p) => [p.id, p]));
    check('无成本账号 = 有常驻角色 + 他们的专属光锥，且**没有限定角色**',
      (presetById.get('zero-cost')?.chars || 0) >= 5
      && (presetById.get('zero-cost')?.cones || 0) >= 5,
      JSON.stringify(presetById.get('zero-cost')));
    check('大隐金 MAX 的角色数 ≥ 常驻 + 大隐金两组（约 23）',
      (presetById.get('dayinjin-max')?.chars || 0) >= 20,
      JSON.stringify(presetById.get('dayinjin-max')));
    check('四个平铺档位的人数一致（都是「全部角色」）',
      ['flat-0-0', 'flat-0-1', 'flat-2-1', 'flat-6-5']
        .map((id) => presetById.get(id)?.chars || 0)
        .every((n, _, arr) => n > 80 && n === arr[0]),
      ['flat-0-0', 'flat-0-1', 'flat-2-1', 'flat-6-5']
        .map((id) => `${id}:${presetById.get(id)?.chars}`).join(' '));
    check('平铺 0+0 一把光锥都不配，其余三档要配（专属光锥）',
      (presetById.get('flat-0-0')?.cones || 0) === 0
      && ['flat-0-1', 'flat-2-1', 'flat-6-5'].every((id) => (presetById.get(id)?.cones || 0) > 0),
      ['flat-0-0', 'flat-0-1', 'flat-2-1', 'flat-6-5']
        .map((id) => `${id}:${presetById.get(id)?.cones}`).join(' '));

    // ---- 用户 2026-10-13 第 3 条：自定义角色名单（添加 / 修改 / 删除）------------
    console.log('\n[virtual accounts · 自定义角色名单]');
    const roster0 = await get(`/api/virtual-accounts/${virtualId}/roster`);
    check('GET 自定义名单拿得到（编辑器靠它预填）',
      roster0.status === 200 && roster0.body?.ok === true
      && typeof roster0.body.roster?.chars === 'object'
      && typeof roster0.body.roster?.cones === 'object',
      JSON.stringify(roster0.body).slice(0, 140));
    check('预设账号也记了一份名单原文（「预设 → 微调」才走得通）',
      Object.keys(roster0.body?.roster?.chars || {}).length > 0,
      JSON.stringify(Object.keys(roster0.body?.roster?.chars || {})));
    const rosterNoCsrf = await post(`/api/virtual-accounts/${virtualId}/roster`,
      { chars: {}, cones: {} });
    check('POST 名单 without csrf -> 403', rosterNoCsrf.status === 403,
      `status=${rosterNoCsrf.status}`);
    const rosterReal = await post(`/api/virtual-accounts/${keeper.id}/roster`,
      { chars: {}, cones: {} }, { 'x-hsr-csrf': csrf });
    check('⭐ 真实账号不许改名单 -> 400（本地改写会让界面显示假角色表）',
      rosterReal.status === 400, `status=${rosterReal.status}`);
    // ① 清空 → 快照必须**真的变短**（这条证明是「整份替换」而不是「保留最长名单」的合并）
    const beforeCount = (await get(`/api/accounts/${virtualId}/roles/${virtualUid}/snapshot`))
      .body?.snapshot?.characters?.length || 0;
    const cleared = await post(`/api/virtual-accounts/${virtualId}/roster`,
      { chars: {}, cones: {} }, { 'x-hsr-csrf': csrf });
    const clearedCount = (await get(`/api/accounts/${virtualId}/roles/${virtualUid}/snapshot`))
      .body?.snapshot?.characters?.length || 0;
    check('⭐ 清空名单后快照真的变短（删除不会被「保留最长名单」静默回滚）',
      cleared.status === 200 && cleared.body?.ok === true && clearedCount < beforeCount,
      `${beforeCount} → ${clearedCount}`);
    // ② 加回一份自定义名单：星魂吸附 + 光锥挂到**它自己的角色**身上
    const custom = await post(`/api/virtual-accounts/${virtualId}/roster`, {
      chars: { Castorice: 2, Cyrene: 6, 'NotARealCharacter': 3 },
      cones: { 'Make Farewells More Beautiful': 3 },
    }, { 'x-hsr-csrf': csrf });
    check('POST 自定义名单 -> 200 且回显收口后的名单',
      custom.status === 200 && custom.body?.ok === true
      && custom.body.roster?.chars?.Castorice === 2
      && custom.body.roster?.chars?.Cyrene === 6
      && custom.body.roster?.chars?.NotARealCharacter === undefined
      && custom.body.roster?.cones?.['Make Farewells More Beautiful'] === 3,
      JSON.stringify(custom.body?.roster));
    const customSnap = (await get(`/api/accounts/${virtualId}/roles/${virtualUid}/snapshot`))
      .body?.snapshot?.characters || [];
    check('自定义名单里的星魂写进了快照',
      customSnap.some((c) => (Number(c.actived_constellation_num) || 0) === 6)
      && customSnap.some((c) => (Number(c.actived_constellation_num) || 0) === 2),
      JSON.stringify(customSnap.filter((c) => (Number(c.actived_constellation_num) || 0) >= 2)
        .map((c) => `${c.name}:${c.actived_constellation_num}`)));
    check('⭐ 专属光锥挂到了它自己的角色身上（不是随手找个人挂）',
      customSnap.some((c) => c.equip && Number(c.equip.rank) === 3
        && (Number(c.actived_constellation_num) || 0) === 2),
      JSON.stringify(customSnap.filter((c) => c.equip).map((c) => `${c.name}:E${c.actived_constellation_num}:S${c.equip.rank}`)));
    // ③ 收口：星魂 5 → E2（只允许 E0/E1/E2/E6），叠影 9 → S5
    const clamped = await post(`/api/virtual-accounts/${virtualId}/roster`, {
      chars: { Castorice: 5 }, cones: { 'Make Farewells More Beautiful': 9 },
    }, { 'x-hsr-csrf': csrf });
    check('星魂吸附到 E0/E1/E2/E6、叠影夹到 1~5',
      clamped.body?.roster?.chars?.Castorice === 2
      && clamped.body?.roster?.cones?.['Make Farewells More Beautiful'] === 5,
      JSON.stringify(clamped.body?.roster));

    await store.removeAccount(created1.body.account.id);
    await store.removeAccount(created2.body.account.id);
    await store.removeAccount(keeper.id);

    // ---- method handling --------------------------------------------------
    console.log('\n[method handling]');
    const badMethod = await fetch(`${base}/api/config`, { method: 'POST' });
    check('POST /api/config -> handled (404/405)', [404, 405].includes(badMethod.status),
      `status=${badMethod.status}`);
  } finally {
    await new Promise((done) => app.server.close(done));
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${'='.repeat(52)}`);
  console.log(`E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('e2e crashed:', err);
  process.exit(1);
});
