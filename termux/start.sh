#!/usr/bin/env bash
# ===========================================================================
# 崩坏：星穹铁道 抽卡推荐计算器 —— Termux 一键启动（安卓独立运行）
#
# 用法（Termux 里）：
#   bash termux/start.sh
#
# 幂等：首次运行会自动装 Node.js、生成凭证加密密钥；之后每次直接起服务。
# 起来后用手机浏览器打开 http://127.0.0.1:8360/ ，菜单里「添加到主屏幕」
# 即可全屏运行（PWA，见 public/manifest.webmanifest）。
#
# 说明：
#   * 非 Windows 环境服务端要求 DSH_HSR_CREDENTIAL_KEY（AES-256-GCM 凭证加密），
#     首次运行自动生成随机密钥并保存到 ~/.dsh-hsr-env（0600）。删掉该文件 =
#     重置密钥，但旧账号存储将无法解密（等于清空账号）。
#   * Android 12+ 的 phantom process killer 会杀后台进程：本脚本自动申请
#     termux-wake-lock；仍被杀就在系统设置里给 Termux 关掉「电池优化」，
#     或在 Termux 里执行 `pkg install termux-services` 后用服务方式常驻。
#   * 数据集（theherta/）随仓库分发；更新数据集用界面里的「同步黑塔网数据」。
# ===========================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

# ---- 1. Node.js -----------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "[termux] 未检测到 Node.js，开始安装（首次约 1-2 分钟）..."
  pkg update -y
  pkg install -y nodejs-lts
fi
echo "[termux] Node $(node --version)"

# ---- 2. 凭证加密密钥（非 Windows 必需） ------------------------------------
KEY_FILE="$HOME/.dsh-hsr-env"
if [ ! -f "$KEY_FILE" ]; then
  KEY="k$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 44)"
  printf 'export DSH_HSR_CREDENTIAL_KEY="%s"\n' "$KEY" > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  echo "[termux] 已生成凭证加密密钥 → $KEY_FILE（删除 = 重置账号存储）"
fi
# shellcheck disable=SC1090
. "$KEY_FILE"
export DSH_HSR_CREDENTIAL_KEY

# ---- 3. 防后台查杀 ---------------------------------------------------------
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock 2>/dev/null || true
  echo "[termux] 已申请 wake-lock（屏幕关闭后保持运行）"
fi

# ---- 4. 起服务 -------------------------------------------------------------
PORT="${DSH_HSR_PORT:-8360}"
echo "[termux] 启动服务：http://127.0.0.1:${PORT}/"
echo "[termux] 手机浏览器打开后，菜单选「添加到主屏幕」即可像 App 一样全屏使用。"
echo "[termux] 停止：Ctrl+C，或通知栏结束 Termux 会话。"
echo ""
exec node bin/serve.mjs --host 127.0.0.1 --port "$PORT"
