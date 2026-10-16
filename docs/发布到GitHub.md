# 发布到 GitHub（本仓库固定流程）

> 适用：把本地 `main` 推到 GitHub、打 tag、发 Release。
> **只推 `main` 与 tag**，别用 `git push --all`。示例代理端口是本机 v2rayN / sing-box 的 `127.0.0.1:10808`。

## 0. 隐私红线（每次发布前先过一遍）

| 绝对不能进仓库 | 为什么 | 怎么挡 |
| --- | --- | --- |
| `data/`（登录态、角色快照、账号存档） | 等同你的登录凭证 | `.gitignore` 已挡。**别**把 `tools/package.mjs` 的产物当公开附件 —— 它按设计打包 `data/data/accounts.json` |
| 带真实 **UID / 账号名 / 已解锁角色列表**的截图 | 个人游戏数据 | 截图一律用**虚拟账号实例**（`data/accounts-virtual.json`），页面自带「角色数据由本机构造」标注 |
| 本机绝对路径 `C:\Users\<你>\…` | 暴露用户名 | 文档里写 `$env:USERPROFILE` / `<仓库根>` |
| 本地分支 `internal-history` / `codex/*` / `fix/*` | 旧历史里可能有上面两类东西 | 只推 `main` 与 tag |

发布前自检（两条都该是空的或只有预期文件）：

```bash
git log --name-only --pretty=format: origin/main..HEAD | sort -u | grep -Ei '\.(png|jpg|zip)$|^data/'
git grep -n -I -E 'C:\\Users\\|ltoken=|cookie_token=|account_id=' HEAD -- . | head
```

## 1. 推送

```bash
# 直连（网络通时）
git push origin main && git push origin v4.6.102

# 走本机代理（GitHub 不可达时；只影响这一条命令，不改全局配置）
git -c http.proxy=http://127.0.0.1:10808 push origin main
git -c http.proxy=http://127.0.0.1:10808 push origin v4.6.102
```

## 2. 打公开包（用 `git archive`，天然不含 `data/`）

```bash
git archive --format=zip --prefix=hsr-character-viewer-<版本>/ \
  -o snapshots/hsr-character-viewer-v<版本>.zip HEAD
```

体检（`data/`、`.git` 条目必须是 **0**）：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead((Resolve-Path snapshots/hsr-character-viewer-v4.6.102.zip))
$z.Entries.FullName | Where-Object { $_ -match '/data/|/\.git/' }   # 应为空
$z.Dispose()
```

## 3. 发 Release

发布说明写在 `snapshots/RELEASE-v<版本>.md`（不在版本库里，属本地交付物）。

> ⚠️ **发布说明一律简略**（用户 2026-10 定）：每条 **2~4 行**、**面向用户**，只写
> 「改了什么 + 看得见的效果」（有实测数字就带上）；**不要**贴 commit 逐条列表、
> 文件清单或内部实现细节。规则同 `../HANDOFF.md` §9。

### 方式 A：网页（最稳）
1. GitHub → 仓库 → **Releases** → *Draft a new release*
2. Tag 选 `v4.6.102`，标题填 `v4.6.102`
3. 正文粘 `snapshots/RELEASE-v4.6.102.md`
4. 附件选 `snapshots/hsr-character-viewer-v4.6.102.zip`
5. **Publish release**

### 方式 B：gh CLI
```bash
gh auth login            # 只需一次
gh release create v4.6.102 "snapshots/hsr-character-viewer-v4.6.102.zip" \
  --title "v4.6.102" --notes-file snapshots/RELEASE-v4.6.102.md
```

### 方式 C：REST API（没装 gh 时；token 从本机 GCM 取，不写进文件）
```powershell
$tok = (("protocol=https`nhost=github.com`n`n" | git credential fill) -split "`n" |
        Where-Object { $_ -like 'password=*' }) -replace 'password=', ''
$h = @{ Authorization = "token $tok"; 'User-Agent' = 'hsr-character-viewer' }
$body = @{ tag_name = 'v4.6.102'; name = 'v4.6.102'
           body = (Get-Content snapshots/RELEASE-v4.6.102.md -Raw) } | ConvertTo-Json
$rel = Invoke-RestMethod -Method Post -Proxy http://127.0.0.1:10808 `
  -Uri https://api.github.com/repos/mxf133/hsr-character-viewer/releases `
  -Headers $h -ContentType 'application/json; charset=utf-8' `
  -Body ([Text.Encoding]::UTF8.GetBytes($body))
$up = ($rel.upload_url -replace '\{.*\}', '') + '?name=hsr-character-viewer-v4.6.102.zip'
Invoke-RestMethod -Method Post -Proxy http://127.0.0.1:10808 -Uri $up -Headers $h `
  -InFile snapshots/hsr-character-viewer-v4.6.102.zip -ContentType 'application/zip'
```

## 4. 如果历史里已经混进过隐私文件

只重写**未推送**的区间 → 推送仍是 fast-forward，**不需要 force push**：

```bash
git filter-branch -f --index-filter \
  'git rm --cached --ignore-unmatch -q <要删的路径>' -- origin/main..main
git log --name-only --pretty=format: origin/main..HEAD | sort -u   # 复核
```

> 2026-10-15 实例：`docs/screenshots/虚拟账号-入口.png`、`虚拟账号-抽卡方案.png` 曾带真实
> UID（100000000）与 66 个已解锁角色，就是用上面这条在未推送区间里整体摘除的。
> 摘除后记得删掉 `refs/original/refs/heads/main` 与临时备份分支，并把其它含该图的分支
> 重置到新 `main`（`git reset --mixed main` 不会动工作区里未提交的数据文件）。

## 5. 已发布记录

| 版本 | Release | 附件 |
| --- | --- | --- |
| v4.6.104 | <https://github.com/mxf133/hsr-character-viewer/releases/tag/v4.6.104> | `hsr-character-viewer-v4.6.104.zip`（4.18 MB，`git archive` 生成，不含 `data/`） |
| v4.6.103 | <https://github.com/mxf133/hsr-character-viewer/releases/tag/v4.6.103> | `hsr-character-viewer-v4.6.103.zip`（4.17 MB，`git archive` 生成，不含 `data/`） |
| v4.6.102 | <https://github.com/mxf133/hsr-character-viewer/releases/tag/v4.6.102> | `hsr-character-viewer-v4.6.102.zip`（4.15 MB，`git archive` 生成，不含 `data/`） |

### 踩过的坑

1. **REST API 发 Release 的编码**：中文 Windows 上 `Get-Content -Raw` 可能按 GBK 解码 →
   正文变乱码、GitHub 直接 422（`For 'properties/body' ... Invalid request`）。
   必须显式 UTF-8 读写：
   ```powershell
   $md = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
   [IO.File]::WriteAllText($json, ($payload), (New-Object Text.UTF8Encoding($false)))
   Invoke-RestMethod ... -ContentType 'application/json; charset=utf-8' -InFile $json
   ```
2. **GitHub 不可达时**：本机 v2rayN / sing-box 的混合端口在 `127.0.0.1:10808`，
   `git -c http.proxy=http://127.0.0.1:10808 push …` 与 `Invoke-RestMethod -Proxy …` 都可用；
   直连偶尔能通，所以脚本里按「直连 → http 代理 → socks5」依次尝试最稳。
3. **Release 用哪条凭据**：本机 Git Credential Manager 里已有 PAT，可直接
   `git credential fill` 取出来给 REST API 用，不必再登录 `gh`（**不要把 token 写进文件或命令行**）。
