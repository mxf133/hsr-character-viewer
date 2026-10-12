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
    // ---- 占位页（v4.6.85 起界面整体重做中）--------------------------------
    //
    // 旧界面（index.html 版面 + /scripts/*.js + /styles/app.css）已于 v4.6.85 删除，
    // 现在 `/` 只发一页「程序还在更新中，敬请期待」。这一组断言因此改成钉**占位页**
    // 那几条性质：真的发出来了、没有任何脚本、不引旧资源、且明确写着「敬请期待」。
    // 重做界面时这一组要跟着换回真界面的断言。
    console.log('[static files]');
    const index = await get('/');
    check('GET / returns HTML', index.status === 200 && index.type.includes('text/html'),
      `status=${index.status} type=${index.type}`);
    check('index.html is the 开发中 placeholder',
      String(index.body).includes('程序还在更新中') && String(index.body).includes('敬请期待'));
    check('index.html loads no scripts at all (placeholder is deliberately inert)',
      !/<script/i.test(String(index.body)));
    check('index.html does not reference the removed UI assets',
      !/\/scripts\/(app|advice|advice-view|battle-record|character-panel|character-modal)\.js/.test(String(index.body))
      && !/\/styles\/app\.css/.test(String(index.body)));

    const css = await get('/styles/placeholder.css');
    check('GET /styles/placeholder.css', css.status === 200 && css.type.includes('text/css'),
      `status=${css.status}`);
    // 旧界面的静态资源必须真的没了（不是留在仓库里没人引）——否则「删掉界面」只是句口号。
    for (const gone of ['/scripts/app.js', '/scripts/advice-view.js', '/scripts/format.js', '/styles/app.css']) {
      const res = await get(gone);
      check(`removed UI asset ${gone} is not served`, res.status === 404, `status=${res.status}`);
    }
    // 算分核心搬进 src/core/ 之后**不再**作为浏览器脚本下发（服务端 import 它）。
    const movedCore = await get('/scripts/advice.js');
    check('advice.js is no longer served as a browser script', movedCore.status === 404,
      `status=${movedCore.status}`);

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
      check('conclusion stays small enough to send to the browser',
        Buffer.byteLength(JSON.stringify(conclusion.body)) < 600 * 1024,
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
      check('conclusion payload 形状升到 v7（hiddenCosts 回显 + availability + frontierTiers）',
        hiddenOn.body?.payload === 7, `payload=${hiddenOn.body?.payload}`);
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
      check('packs stays small enough to send on demand',
        Buffer.byteLength(JSON.stringify(packs.body)) < 400 * 1024,
        `${Math.round(Buffer.byteLength(JSON.stringify(packs.body)) / 1024)} KB`);
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
      const packsHidden = await get(`/api/archive/packs?char=${encodeURIComponent(boardTop?.name || '')}`
        + `&hiddenCosts=${hiddenParam}`);
      check('GET /api/archive/packs 回显隐金设置（查询串版）',
        packsHidden.body?.hiddenCosts
        && Object.values(packsHidden.body.hiddenCosts).every((v) => v === true),
        `hiddenCosts=${JSON.stringify(packsHidden.body?.hiddenCosts)}`);
      check('packs payload 形状升到 v2（多出 hiddenCosts 回显）',
        packsHidden.body?.payload === 2, `payload=${packsHidden.body?.payload}`);
      const bestHiddenPack = Math.max(0, ...(packsHidden.body?.packs || []).map((p) => p.total));
      check('隐金下面板与榜面同口径（最高分配装的分 = 榜上那一条的分）',
        boardTop && Math.abs(bestHiddenPack - boardTop.total) < 1e-6,
        `panel=${bestHiddenPack} board=${boardTop?.total}`);
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
