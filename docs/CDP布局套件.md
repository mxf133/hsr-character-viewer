# CDP 布局套件 · 上手与排障（`tools/check-advice-layout.mjs`）

> **给别的 agent 看的**：这是仓库里**唯一**用真浏览器跑的回归网，也是最容易因为
> **环境没搭对**而读出一排 `null`、看起来像「十几项布局回归」的套件。
> 本文把「从零把环境搭起来 → 跑 → 红了怎么定位」写成可以照抄的步骤。
>
> ⚠️ 它不是权威来源：冲突时以 `HANDOFF.md` **§5 / §5.1 / §6.3**、`AGENTS.md`
> 和**脚本自己的注释**为准（脚本里每一段判据都写了「为什么这么判」）。
> 本文负责**汇总与指路**，并记下 2026-10-13 这轮实测修掉的两个坑。

---

## 0. 30 秒版

```powershell
# ① 服务 —— 必须指向**你自己那份代码**（在 worktree 里改代码时尤其，见 §3.1）
#    没有真实米游社账号时用虚拟账号库起，见 §2.3
node tools/make-virtual-accounts.mjs --out=data/accounts-virtual.json
$env:DSH_HSR_DATA_FILE='accounts-virtual.json'
node bin/serve.mjs --port 8360 --host 127.0.0.1          # 另开一个窗口/后台任务

# ② 调试浏览器（桌面现成有一个，别自己起；见 §2.2）
Start-Process "$env:USERPROFILE\Desktop\Chrome CDP.lnk"
Invoke-WebRequest http://127.0.0.1:9222/json/version      # 返回 Chrome/xxx 就是就绪

# ③ 跑
node tools/check-advice-layout.mjs --url=http://127.0.0.1:8360/   # 只跑这一套（快）
$env:CHECK_ADVICE_URL='http://127.0.0.1:8360/'
node tools/run-tests.mjs                                          # 全套，含这一套
```

判据在最后一行：`… 通过 ✓` 且退出码 `0`。**`✗` 一条都算失败**，`–`（跳过）不算 —— 见 §6。

---

## 1. 它盯什么

只跑一个套件却覆盖了「抽卡推荐页 + 两处角色浮层 + 详情大窗口」，按脚本里的节次：

| 节 | 行号（约） | 盯的东西 |
| --- | --- | --- |
| 数据状态 | 398 | 三份缓存的记录（角色快照 / 战斗记录 / 黑塔网数据集）整合在标题下方，块在 ① ② 之上、宽屏同一行、不越出视口 |
| 角色面板浮层 · 入口一 | 551 | 「抽卡推荐页的战斗记录」点角色 → 面板；战斗记录 chip 外框**统一白色**、DOM 上不再挂 `is-fire` 之类属性 class |
| 角色面板浮层 · 入口二 | 633 | 「角色信息页」点角色卡 → **同一个界面**（结构一致、两张图真的加载、hero 顶部对齐、技能开关真的多出技能行） |
| 关卡权重 | 690 | 一套权重同时驱动角色总榜与抽卡方案的强度侧；存档写进 `hsr.advice.weights.frontier`；几何稳定性（副本框 top 不漂、不换行） |
| 清空输入按 0 计算 | 781 | 清空某个副本的权重输入框 → 按 **0** 保存，不整列 0 分 |
| 抽卡权重 | 808 | 强度 / 性价比 / 泛用性三框；改它**要重算角色总榜**；等式印 `× 0.75 / × 0.25`；存档 `hsr.advice.drawWeights`；「恢复默认」还原 1 : 1 : 1 |
| 总榜行 + 详情大窗口 | 928 | 每行角色头像 / 光锥图标 `naturalWidth > 0`；点徽标开**居中的大窗口**（不是旧的贴徽标小浮层）；**两张表**（角色得分分项 / 性价比来源）的列名、合计与逐关卡内容；文案（「关卡」不是「副本」、不许出现「赛季」） |
| 星魂档筛选 | 978 | 逐个点 E0/E1/E2/E6 chip，行数 = 计数、行内档位是它自己、切回「全部」还原 |
| 抽卡方案（队伍口径） | 2331 | 15 张卡的等式、补金顺序写法（已拥有的写 `E1→E2`）、脚注写清归一化上下限 |
| 逐档榜详情页 | 2576 | **必须显示全部关卡**（用户报过「只显示一种关卡」）；换账号后方案真的重算 |
| 视口稳定性循环 | 末尾 | 1920 / 1440 / 1280 三个宽度 × 五个副本：控件 top 的**最大偏差 ≤ 阈值**且不换行，每轮都打印 `副本框 top=…` |

> 改**排版/几何**、改**详情窗口结构**、改**权重输入框**、改**总榜行内容**，都应当跑它。
> 只改算法（`advice.js` / `conclusion.js`）时 `herta-test` + `team-plan-test` 是主力，
> 但**载荷字段变了要跑这一套**（它读的是渲染出来的 DOM）。

---

## 2. 把环境搭起来

### 2.1 服务

```powershell
node bin/serve.mjs --port 8360 --host 127.0.0.1
```

* **端口随便挑**，但必须与第 ③ 步的 URL 一致。仓库历史上有用 8360 / 8371 / 8372 / 8390 的。
* `bin/serve.mjs` 启动时要 DPAPI（`credential-vault.js` 会 `spawn powershell` 且用管道 stdio）。
  **受限沙箱里这一步会 `spawn EPERM`** —— 那不是程序坏了，是环境限制（HANDOFF §5）。
* 起来后先自检一次：`Invoke-WebRequest http://127.0.0.1:8360/` 返回 200；
  再确认数据集在：`/api/archive` 的 `refs.characters` 有 93 条（`refs.lightConePaths` 170 条）。

### 2.2 调试浏览器

| 事实 | 具体 |
| --- | --- |
| 首选 | 桌面快捷方式 **`Chrome CDP.lnk`** → `chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\ChromeCDP"`（**普通窗口、不是 headless**） |
| 起法 | `Start-Process "$env:USERPROFILE\Desktop\Chrome CDP.lnk"`，或请用户双击一下 |
| 就绪判据 | `http://127.0.0.1:9222/json/version` 返回 `Chrome/152`（版本号随机器） |
| ⚠️ 受限沙箱里**不要自己起** | crashpad 会 `OpenProcess: 拒绝访问 (0x5)` → `crash server failed to launch, self-terminating`，进程起来就自杀，看起来像「一直起不来」。别反复试、也别为此申请放宽权限（HANDOFF §5.1） |
| 沙箱较宽时自己起（实测可用） | `chrome.exe --remote-debugging-port=9222 --user-data-dir="$env:TEMP\hsr-cdp-profile" --no-first-run --no-default-browser-check --window-position=-32000,-32000 --window-size=1600,1000 "http://127.0.0.1:8360/?view=advice"`。用**临时 profile** 就不会碰用户日常那个浏览器 |
| ⚠️ 一次只连一个脚本 | 同一时间只让**一个**脚本连 9222（HANDOFF §6.1 第 10 条）：两个并发会让 `Runtime.evaluate` 全部超时 |
| ⚠️ 它可能是用户自己的浏览器 | 若用的是 `Chrome CDP.lnk`，那个 profile 是用户日常在用的（带他的标签页与扩展）。套件会**复用或新建**该 origin 的标签页并整页刷新它 —— 别去动别的标签 |

### 2.3 账号：为什么常常需要「虚拟账号库」

套件里**关卡权重 / 抽卡权重 / 抽卡方案（队伍口径）** 那几节要求页面上**有账号、有快照**：

* 没有账号时 `adviceOf()` 那一侧不会渲染权重输入框与总榜行，
  那一批断言会**全部读到 `null`**（历史上这被误当成「九项布局回归」）。
* 虚拟账号库能在**不登录米游社**的情况下把页面喂饱，而且「切账号重算」那条也能真跑：

```powershell
node tools/make-virtual-accounts.mjs --out=data/accounts-virtual.json   # 20 个预设账号
$env:DSH_HSR_DATA_FILE='accounts-virtual.json'                          # 相对 data/ 解析
node bin/serve.mjs --port 8360 --host 127.0.0.1
```

> `data/` 在**新建的 worktree / 全新 clone** 里不存在（它在 `.gitignore` 里、也不进 worktree）。
> 2026-10-13 之前 `make-virtual-accounts.mjs` 会直接 `ENOENT` 崩掉 —— **现已自己 `mkdirSync`**。

---

## 3. 三个必须记住的坑

### 3.1 `CHECK_ADVICE_URL` 不指路 = 在测 **main 的代码**

`check-advice-layout.mjs` 默认打 `http://127.0.0.1:8360/?view=advice` ——
那是 **`main` 的常驻服务**。在 worktree 里改了代码却在测 main，会**假绿**（或报一堆无关的错）。

* 直接跑那一套：用 `--url=`（它**不读** `CHECK_ADVICE_URL`，那个环境变量是 `run-tests.mjs` 消费的）。
* 跑 `run-tests.mjs`：必须 `$env:CHECK_ADVICE_URL='http://127.0.0.1:<你的端口>/'`。

### 3.2 URL 一定要落到**抽卡推荐页**（2026-10-13 已从代码里根治）

历史坑：套件的两次导航用的是 `URL_TO_OPEN`（调用方原样传进来的那个），
而只有第 246 / 950 行用 `ADVICE_URL`（补过 `?view=advice` 的那个）。于是
`--url=http://127.0.0.1:8360/`（**不带 `?view` 的裸地址**）会让那两次导航落在默认的
「角色信息」页上 → **抽卡推荐页的视图根本没挂载**（`#adviceConclusionUnits` 一行都没有、
权重输入框 0 个）→ 关卡权重 / 清空输入 / 抽卡权重那 **9 条**全读到 `null`，
看起来像九项布局回归，其实只是页面没切过去。

**修法**：`URL_TO_OPEN` 现在在解析参数时就规范化成一定带 `?view=advice`，
`ADVICE_URL` 与它同值 —— **传什么地址都会落到抽卡推荐页**。
另外那一段加了「榜面诊断」：一旦总榜第一条读不到，就把
`activeTab / adviceHidden / unitRows / drawInputs / 榜面文字` 一起印出来，
一眼能分清是「视图没挂载」「榜面在『正在计算…』」还是「接口报错」。

### 3.3 探针是**模板字符串**：注释里不能出现反引号

`evaluate(\`...\`)` 里的内容会被 Node 先当模板串解析。注释里写一个反引号（例如
`` `unit.total` ``）就会 `SyntaxError: Unexpected identifier`，整脚本起不来。
同理**不能嵌套模板串**（要用字符串拼接）。自检：

```powershell
node --check tools/check-advice-layout.mjs
awk 'NR>=736 && NR<=800' tools/check-advice-layout.mjs | grep -n '`'   # 应该只剩开/闭两处
```

（HANDOFF §6.1 第 16 条。**2026-10-13 我本人又踩了一次**，所以写进这里。）

---

## 4. 红了怎么定位

| 症状 | 根因 | 处理 |
| --- | --- | --- |
| 关卡权重 / 抽卡权重那一批全是 `null` | 抽卡推荐页没挂载（URL 落了「角色信息」页），或服务指的不是你这份代码 | 2026-10-13 起套件自己规范化 URL；仍红就看新加的**榜面诊断**行：`adviceHidden`/`unitRows`/`drawInputs` 会直接告诉你是哪一类 |
| `TypeError: fetch failed … ECONNREFUSED 127.0.0.1:9222` | 调试浏览器没起，**或者它的最后一个标签页被关掉后 Chrome 自己退出了**（实测踩过） | 起浏览器；跑的时候别手动关它的标签页 |
| `… 超时`（`Runtime.evaluate`） | 两个脚本同时在连 9222 | 一次只跑一个 |
| 图片断言红（`naturalWidth = 0`） | 页面被隐藏时 Chrome 不取懒加载的图；或漏了 `Emulation.setFocusEmulationEnabled` | 脚本开头已经开了；**不要改成 headless**，不要删那一行 |
| 只有「视口稳定性」那一节红、`副本框 top` 逐宽度递增 | 控件组换行 / 页面整体被顶下去 | 那是这**套件立身的那条 bug**（见脚本头注释），去看 `advice-weights` 那一块的 CSS |
| 断言全绿但结果可疑 | 没设 `CHECK_ADVICE_URL`，测的是 main | §3.1 |
| `SyntaxError: Unexpected identifier` | §3.3（探针注释里的反引号 / 嵌套模板串） | 去掉反引号、改字符串拼接 |
| `make-virtual-accounts.mjs` → `ENOENT … data\accounts-virtual.json` | 新 worktree 没有 `data/` | 2026-10-13 起工具自己建目录；老版本先 `mkdir data` |
| 独立跑红、`run-tests.mjs` 里绿（或反之） | 页面状态残留 / 接口节流的历史现象 | 先看榜面诊断；**别靠加长等待治**（HANDOFF §6.3 第 7 条已写死这条教训） |

---

## 5. 要加一条新判据时

脚本的风格是「**探针取数据 → Node 侧判定 → 打印自证**」，照抄这套就行：

1. **探针只取数据**（`evaluate` 返回纯 JSON），判定逻辑写在 Node 侧 —— 这样报错信息能自己组织。
2. **判据必须计入 `failures`**：只 `console.log` 不打红等于没加（HANDOFF §6.3 有专门一条）。
3. **打印要能自证**：把实际量到的值 / 数量 / 文案一并印出来，别只印「✗」。
4. **一个判据一个变量**，最后 `console.log(\`  ${ok ? '✓' : '✗'} …\`)` —— 红的时候一眼知道是哪条。
5. **别把「顺序」当契约**：用选择器 / 语义找节点，不要用 `nextSibling` 之类（HANDOFF §6.3 第 21 条）。
6. **该跳过的要显式跳过**：环境缺东西（没登录 / 没战绩 / 账号数不够）时打印
   `– …：跳过（原因）` 且**不计入 `failures`** —— 与「浏览器不在就跳过整节」同一条规矩。
7. 加完先 `node --check`，再**自己真跑一遍**（这一套的全部价值就在「真浏览器里真跑」）。

---

## 6. 已知的「跳过」与「不算失败」

| 情况 | 行为 |
| --- | --- |
| 9222 没有调试浏览器 | `run-tests.mjs` **跳过**这一套并打印原因（算通过）；直接跑该脚本则 ~1 秒内 `exit 1`（`ECONNREFUSED`），**不会挂住** |
| 没登录 / 没抓过战绩 | 战斗记录 chip 那两条带 `– 跳过`，不算失败 |
| 页面上账号数 < 2 | 「切账号重算」`– 跳过`（提示用 `tools/make-virtual-accounts.mjs` 起账号库） |
| 单副本（只有一行） | 详情窗口的「合计行」判据自动放宽（单副本本来就没有合计行） |

---

## 7. 相关文件

| 文件 | 作用 |
| --- | --- |
| `tools/check-advice-layout.mjs` | 本套件（约 2700 行，判据注释即文档） |
| `tools/run-tests.mjs` | 总入口；探测 9222 决定是否带上这一套；消费 `CHECK_ADVICE_URL` |
| `tools/make-virtual-accounts.mjs` | 造虚拟账号库（20 个预设），让套件在没有真账号时也能跑满 |
| `tools/gui-shot.mjs` | CDP 截图 + 页面内容摘要（人看界面时用它） |
| `HANDOFF.md` §5 / §5.1 / §6.3 | 测试命令、浏览器约定、历次踩坑 |
| `docs/评分模型设计.md` | 总榜 / 抽卡方案的口径（判据背后的业务语义） |
