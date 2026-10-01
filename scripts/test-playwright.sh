#!/usr/bin/env bash
# Playwright UI 端到端测试（C3 选做，任务 5.26）。
#
# 与 bash e2e 互补：bash 脚本验证后端协议与状态机，本脚本验证"界面层"——
# 登录/权限渲染、viewer 无写按钮且接口 403、状态按钮按 FSM 显隐、退出与路由守卫。
#
# 前置：docker compose up -d（前端 5173、后端 3000 必须就绪）。
# 首次运行会自动 npm install 与下载 chromium（约 120MB，需出网）；
# 若浏览器启动报缺共享库，执行：sudo npx playwright install-deps chromium（在 frontend/）。
set -euo pipefail

BASE_URL="${PLAYWRIGHT_BASE_URL:-http://localhost:5173}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$SCRIPT_DIR/../frontend"

log() { echo "[$(date +%H:%M:%S)] $*"; }

# 1. 前端可达性检查
if ! curl -sf "$BASE_URL/health" >/dev/null 2>&1; then
  echo "FAIL: 前端不可达（$BASE_URL）。请先执行 docker compose up -d。" >&2
  exit 1
fi
log "前端可达：$BASE_URL"

cd "$FRONTEND_DIR"

# 2. npm 依赖（@playwright/test 通过 workspace 安装）
if [ ! -d node_modules/@playwright/test ] && [ ! -d ../node_modules/@playwright/test ]; then
  log "未检测到 @playwright/test，执行 npm install…"
  (cd "$SCRIPT_DIR/.." && npm install)
fi

# 3. chromium 浏览器（HEADLESS_SHELL 下载标记）
if ! ls "$HOME/.cache/ms-playwright"/chromium_headless_shell-* >/dev/null 2>&1; then
  log "未检测到 chromium，下载中（约 120MB）…"
  npx playwright install chromium
fi

# 4. 运行
log "运行 Playwright UI 测试…"
npx playwright test "$@"
