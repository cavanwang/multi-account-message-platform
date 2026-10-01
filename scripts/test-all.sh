#!/usr/bin/env bash
# 集成测试总入口：顺序执行全部 HTTP/协议级集成脚本。
#
# 覆盖（每个脚本两轮验证过；这里按序各跑一轮）：
#   1. test-smoke.sh         部署冒烟（5 服务 / 权限 / 建群 / 投递 / Agent）
#   2. test-gateway-mock.sh  网关契约 + 故障注入（16 步）
#   3. test-group-job.sh     建群 job 全流程 + JOIN_TIMEOUT
#   4. test-auth-session.sh  B3 会话：轮换 / 复用作废 / logout
#   5. test-leave-all.sh     B2 全员退群（含 500 瞬时重试）
#   6. test-event-recovery.sh INV-4 停机恢复
#   7. test-ws-reconnect.sh  WebSocket 重连补发
#
# 不含 Playwright（需下载浏览器，单独运行 ./scripts/test-playwright.sh）。
# 前提：docker compose up -d。用法：./scripts/test-all.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SCRIPTS=(
  test-smoke.sh
  test-gateway-mock.sh
  test-group-job.sh
  test-auth-session.sh
  test-leave-all.sh
  test-event-recovery.sh
  test-ws-reconnect.sh
)

echo "集成测试总入口：${#SCRIPTS[@]} 个脚本，顺序执行（任一失败即中止）"
echo "============================================================"

for s in "${SCRIPTS[@]}"; do
  echo ""
  echo ">>> 开始：$s"
  if "$SCRIPT_DIR/$s"; then
    echo ">>> 完成：$s"
  else
    echo ">>> 失败：$s（总入口中止）" >&2
    exit 1
  fi
done

echo ""
echo "============================================================"
echo "PASS: 全部 ${#SCRIPTS[@]} 个集成脚本通过"
echo "============================================================"
