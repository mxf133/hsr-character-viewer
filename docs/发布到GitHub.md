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
