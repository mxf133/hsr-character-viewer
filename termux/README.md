# Termux 一键启动（安卓独立运行）

不装任何 App、不用 PC：手机上跑服务端，浏览器/PWA 全屏使用。

## 首次安装

1. 安装 [Termux](https://github.com/termux/termux-app/releases)（F-Droid 或 GitHub Releases 版，
   **不要用 Play 商店的过期版**）。
2. 把本仓库放到手机存储（`git clone` 或下载 zip 解压），Termux 里授权存储访问：
   `termux-setup-storage`。
3. 进入仓库目录执行：

   ```bash
   bash termux/start.sh
   ```

   首次会自动 `pkg install nodejs-lts`（约 1-2 分钟）并生成凭证加密密钥
   （存 `~/.dsh-hsr-env`，0600；删除 = 重置账号存储）。

## 日常使用

```bash
bash termux/start.sh          # 起服务（自动申请 wake-lock 防后台查杀）
```

浏览器打开 <http://127.0.0.1:8360/> → 菜单「**添加到主屏幕**」→
之后从桌面图标全屏启动（PWA 壳，见 `public/manifest.webmanifest`）。

## 说明

* **凭证安全**：米游社 cookie 只存本机，用 AES-256-GCM 加密（密钥在 `~/.dsh-hsr-env`）。
  没有密钥的备份文件无法解密。
* **后台被杀**：脚本已自动 `termux-wake-lock`；若仍被杀，给 Termux 关掉系统「电池优化」，
  或 `pkg install termux-services` 改成服务常驻。
* **更新数据集**：界面里点「同步黑塔网数据」；更新程序本身用 `git pull`。
* **给同一 WiFi 的其他设备用**：`DSH_HSR_HOST=0.0.0.0 DSH_HSR_TOKEN=<随机串> node bin/serve.mjs`，
  其他设备浏览器开 `http://<手机IP>:8360/#token=<同一个串>`（令牌必填，服务端强制）。
* 首次运行若提示数据集缺失，先在界面点一次「同步黑塔网数据」。
