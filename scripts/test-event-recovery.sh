#!/usr/bin/env bash
# 集成测试：停机 5 秒 → 恢复 → 事件全被处理（INV-4）
#
# 验证点（规划 03 §6）：
#   - 停机期间注入 10 条事件 → 恢复后全部处理，时间线 10 条、无重复
#
# 前提：
#   - docker compose 已启动（db / backend / gateway-mock 健康）
#   - 脚本只调用容器服务，不直接连数据库
#
# 用法：./scripts/test-event-recovery.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3100}"
DB_CONTAINER="${DB_CONTAINER:-multi-account-message-platform-db-1}"
ACCOUNT_ID="acct-1"
GROUP_ID=""
PLATFORM_USER_ID=""

log() { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# 等待 HTTP 200
wait_http() {
  local url="$1" name="$2" timeout="${3:-30}"
  for i in $(seq 1 "$timeout"); do
    if curl -sf "$url" >/dev/null 2>&1; then
      log "$name 就绪"
      return 0
    fi
    sleep 1
  done
  fail "$name 等待超时（${timeout}s）"
}

# 在 db 容器内执行 SQL
psql_exec() {
  docker exec "$DB_CONTAINER" psql -U app -d app -t -A -c "$1"
}

log "=== 步骤 0：前置检查 ==="
wait_http "$BACKEND_URL/api/health" "backend"
wait_http "$GATEWAY_URL/_mock/state" "gateway-mock"

# 重置 mock 状态（清历史事件）
log "重置 gateway-mock 状态"
curl -sf -X POST "$GATEWAY_URL/_mock/reset" \
  -H 'content-type: application/json' \
  -d '{"resetEventCounter":true}' >/dev/null || fail "mock reset 失败"

# 清空 backend 事件相关表，隔离历史运行的残留（毒药消息会干扰断言）
psql_exec "TRUNCATE events_inbox, messages, web_events" >/dev/null
psql_exec "UPDATE events_cursor SET last_seen_event_id = 0 WHERE id = 1" >/dev/null
log "DB：events_inbox / messages / web_events 已清空，游标归零"

log "=== 步骤 1：准备数据 ==="
# 1) gateway-mock：connect 账号 → 建群 → 加入
PLATFORM_USER_ID=$(curl -sf -X POST "$GATEWAY_URL/accounts/$ACCOUNT_ID/connect" | grep -o '"platformUserId":"[^"]*"' | cut -d'"' -f4)
[ -n "$PLATFORM_USER_ID" ] || fail "connect 未返回 platformUserId"
log "账号已 connect，platformUserId=$PLATFORM_USER_ID"

GROUP_ID=$(curl -sf -X POST "$GATEWAY_URL/groups" \
  -H 'content-type: application/json' \
  -d "{\"creatorAccountId\":\"$ACCOUNT_ID\"}" | grep -o '"groupId":"[^"]*"' | cut -d'"' -f4)
[ -n "$GROUP_ID" ] || fail "建群未返回 groupId"
log "群已创建，groupId=$GROUP_ID（creator 已自动为 owner，无需 join）"

# 2) backend DB：账号置 online + platform_user_id；插入 groups + group_members
psql_exec "UPDATE accounts SET status='online', platform_user_id='$PLATFORM_USER_ID' WHERE account_id='$ACCOUNT_ID'" >/dev/null
log "DB：账号已置 online，platform_user_id=$PLATFORM_USER_ID"

# psql RETURNING 会附带命令标签行（如 INSERT 0 1），只取首行
GROUP_UUID=$(psql_exec "INSERT INTO groups (gateway_group_id, creator_account_id) VALUES ('$GROUP_ID', (SELECT id FROM accounts WHERE account_id='$ACCOUNT_ID')) RETURNING id" | head -n1)
[ -n "$GROUP_UUID" ] || fail "DB 建群失败"
log "DB：群已插入，id=$GROUP_UUID"

psql_exec "INSERT INTO group_members (group_id, account_id, platform_user_id, role) VALUES ('$GROUP_UUID', (SELECT id FROM accounts WHERE account_id='$ACCOUNT_ID'), '$PLATFORM_USER_ID', 'creator')" >/dev/null
log "DB：成员已插入"

log "=== 步骤 2：停 backend，注入 10 条事件 ==="
docker compose stop backend >/dev/null 2>&1 || fail "停 backend 失败"
log "backend 已停止"

for i in $(seq 1 10); do
  # 秒字段必须两位（printf %02d），否则 i=10 生成 ...:010.000Z 非法时间戳
  SEC=$(printf '%02d' "$i")
  curl -sf -X POST "$GATEWAY_URL/_mock/messages/inject" \
    -H 'content-type: application/json' \
    -d "[{\"groupId\":\"$GROUP_ID\",\"senderPlatformUserId\":\"$PLATFORM_USER_ID\",\"text\":\"recovery-test-$i\",\"sentAt\":\"2026-01-01T00:00:${SEC}.000Z\"}]" >/dev/null || fail "注入第 $i 条消息失败"
done
log "10 条消息已注入 mock"

log "=== 步骤 3：等 5 秒，恢复 backend ==="
sleep 5
docker compose start backend >/dev/null 2>&1 || fail "启动 backend 失败"
log "backend 已启动"

wait_http "$BACKEND_URL/api/health" "backend" 60

log "=== 步骤 4：轮询断言（超时 30s） ==="
DEADLINE=$((SECONDS + 30))
while [ $SECONDS -lt $DEADLINE ]; do
  # 时间线 10 条、无重复
  MSG_COUNT=$(psql_exec "SELECT COUNT(*) FROM messages WHERE group_id='$GROUP_UUID'")
  DISTINCT_COUNT=$(psql_exec "SELECT COUNT(DISTINCT msg_id) FROM messages WHERE group_id='$GROUP_UUID'")
  # events_inbox 全部已处理
  UNPROCESSED=$(psql_exec "SELECT COUNT(*) FROM events_inbox WHERE processed_at IS NULL")

  if [ "$MSG_COUNT" = "10" ] && [ "$DISTINCT_COUNT" = "10" ] && [ "$UNPROCESSED" = "0" ]; then
    log "✓ 时间线 10 条、无重复，inbox 全部已处理"
    break
  fi
  log "  等待中... messages=$MSG_COUNT distinct=$DISTINCT_COUNT unprocessed=$UNPROCESSED"
  sleep 1
done

if [ "$MSG_COUNT" != "10" ] || [ "$DISTINCT_COUNT" != "10" ] || [ "$UNPROCESSED" != "0" ]; then
  log "断言失败："
  psql_exec "SELECT msg_id, text, is_own FROM messages WHERE group_id='$GROUP_UUID' ORDER BY msg_id"
  psql_exec "SELECT event_id, type, processed_at, attempts, last_error FROM events_inbox ORDER BY event_id"
  fail "INV-4 验证失败"
fi

log "=== 步骤 5：清理 ==="
psql_exec "DELETE FROM groups WHERE id='$GROUP_UUID'" >/dev/null
curl -sf -X POST "$GATEWAY_URL/_mock/reset" >/dev/null
log "清理完成"

echo ""
echo "========================================"
echo "PASS: 停机 5 秒 → 恢复 → 10 条事件全处理"
echo "========================================"
