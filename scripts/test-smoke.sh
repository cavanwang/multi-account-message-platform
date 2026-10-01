#!/usr/bin/env bash
# 部署可用性冒烟测试（一键部署后执行）。
#
# 端到端覆盖一条完整主链路，验证 docker compose 部署实际可用：
#   1. 5 个服务全部可达（backend schemaVersion、frontend、gateway、agent-mock、db）
#   2. admin/viewer 均可登录；viewer 写操作 403
#   3. 连接账号 → 建群 job finished，成员角色正确
#   4. 发消息 → outbox 投递到 sent，时间线可查
#   5. 开启 agent → 注入外部消息 → agent run finished
#
# 前提：docker compose up -d 已完成。
# 用法：./scripts/test-smoke.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3100}"
AGENT_MOCK_URL="${AGENT_MOCK_URL:-http://localhost:3200}"
FRONTEND_URL="${FRONTEND_URL:-http://localhost:5173}"
DB_CONTAINER="${DB_CONTAINER:-multi-account-message-platform-db-1}"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo ""; log "=== $* ==="; }

http_code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }

wait_url() { # <url> <name> [timeout]
  local url="$1" name="$2" timeout="${3:-60}"
  for _ in $(seq 1 "$timeout"); do
    if curl -sf "$url" >/dev/null 2>&1; then
      log "$name 就绪"
      return 0
    fi
    sleep 1
  done
  fail "$name 等待超时（${timeout}s）"
}

# 轮询：curl 命令（除 URL 外其余参数透传）输出 == 期望值
poll_eq() { # <timeoutSec> <expected> <description> <curlArgs...>
  local timeout="$1" expected="$2" desc="$3"; shift 3
  local deadline=$((SECONDS + timeout))
  while [ $SECONDS -lt "$deadline" ]; do
    local got
    got=$(curl -s "$@" 2>/dev/null || true)
    if [ "$got" = "$expected" ]; then
      log "$desc"
      return 0
    fi
    sleep 1
  done
  fail "$desc（超时，期望 \"$expected\"）"
}

# ============================================================
step "1/5 服务可达性"
wait_url "$GATEWAY_URL/_mock/state" "gateway-mock"
wait_url "$AGENT_MOCK_URL/health" "agent-mock"
wait_url "$FRONTEND_URL/health" "frontend"
# backend：不仅要可达，还校验 schemaVersion 与代码一致（取 migrations 最大序号）
EXPECTED_VERSION=$(ls "$PROJECT_ROOT/backend/migrations" | grep -oE '^[0-9]{4}' | sort -n | tail -1 | sed 's/^0*//')
wait_url "$BACKEND_URL/api/health" "backend"
HEALTH=$(curl -sf "$BACKEND_URL/api/health")
GOT_VERSION=$(grep -o '"schemaVersion":[0-9]*' <<<"$HEALTH" | cut -d: -f2)
[ "$GOT_VERSION" = "$EXPECTED_VERSION" ] \
  || fail "schemaVersion 不一致：backend=$GOT_VERSION，migrations=$EXPECTED_VERSION（migration 未执行？）"
log "schemaVersion=$GOT_VERSION，与 migrations 一致"
# db：经容器内 psql 验证可连接
docker exec "$DB_CONTAINER" psql -U app -d app -t -A -c 'SELECT 1' | grep -q 1 \
  || fail "db 不可连接"
log "db 可连接"

# 事件流水线自愈：无论此前脚本留下何种状态，保证"后端游标 ≤ 网关计数器"。
# 归零时必须同步 TRUNCATE inbox（旧行撞 PK 会被判重）与游标（旧高值会跳过新事件）。
curl -sf -X POST "$GATEWAY_URL/_mock/reset" -H 'Content-Type: application/json' \
  -d '{"resetEventCounter":true,"seedAccounts":["acct-1","acct-2","acct-3","acct-4"]}' >/dev/null
docker exec "$DB_CONTAINER" psql -U app -d app -q -c \
  "TRUNCATE events_inbox; UPDATE events_cursor SET last_seen_event_id = 0 WHERE id = 1"
# 账号回到确定性起点（connect 会重新上线）
docker exec "$DB_CONTAINER" psql -U app -d app -q -c \
  "UPDATE accounts SET status='idle', platform_user_id=NULL, rate_limited_until=NULL \
   WHERE account_id IN ('acct-1','acct-2','acct-3','acct-4')"
log "事件流水线已重置（计数器/游标/inbox 一致）"

# ============================================================
step "2/5 登录与权限"
TOKEN=$(curl -sf -X POST "$BACKEND_URL/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
[ -n "$TOKEN" ] || fail "admin 登录失败"
log "admin 登录成功"

VIEWER_TOKEN=$(curl -sf -X POST "$BACKEND_URL/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"viewer","password":"viewer"}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
[ -n "$VIEWER_TOKEN" ] || fail "viewer 登录失败"
log "viewer 登录成功"

CODE=$(http_code -X POST "$BACKEND_URL/api/accounts/acct-1/connect" \
  -H "Authorization: Bearer $VIEWER_TOKEN")
[ "$CODE" = "403" ] || fail "viewer 写操作应 403，实际 $CODE"
log "viewer 写操作 403"

# 未认证请求
CODE=$(http_code "$BACKEND_URL/api/accounts")
[ "$CODE" = "401" ] || fail "无 token 应 401，实际 $CODE"
log "无 token 401"

# ============================================================
step "3/5 连接账号 + 建群"
for a in acct-1 acct-2; do
  curl -sf -X POST "$BACKEND_URL/api/accounts/$a/connect" \
    -H "Authorization: Bearer $TOKEN" >/dev/null
done
log "acct-1/acct-2 online"

JOB=$(curl -sf -X POST "$BACKEND_URL/api/groups" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"creatorAccountId":"acct-1","memberAccountIds":["acct-2"]}')
JOB_ID=$(grep -o '"jobId":"[^"]*"' <<<"$JOB" | cut -d'"' -f4)
[ -n "$JOB_ID" ] || fail "建群未返回 jobId：$JOB"

# 轮询 job → finished（≤30s）
deadline=$((SECONDS + 30))
while [ $SECONDS -lt "$deadline" ]; do
  JBODY=$(curl -sf "$BACKEND_URL/api/jobs/$JOB_ID" -H "Authorization: Bearer $TOKEN")
  JSTATUS=$(grep -o '"status":"[^"]*"' <<<"$JBODY" | head -1 | cut -d'"' -f4)
  [ "$JSTATUS" = "finished" ] && break
  if [ "$JSTATUS" = "failed" ]; then
    fail "建群 job failed：$JBODY"
  fi
  sleep 1
done
[ "$JSTATUS" = "finished" ] || fail "建群 job 30s 未 finished（最后状态 $JSTATUS）"
log "建群 job finished"

# 群经 groups.created_by_job_id 反向关联建群 job（列表 DTO 不带该字段，走 psql）
# -F ' '：psql 非对齐分隔符由默认的 | 改为空格，供 read 拆两个变量
read -r GROUP_UUID GATEWAY_GROUP_ID < <(docker exec "$DB_CONTAINER" psql -U app -d app -t -A -F ' ' \
  -c "SELECT id, gateway_group_id FROM groups WHERE created_by_job_id = '$JOB_ID'")
[ -n "$GROUP_UUID" ] && [ -n "$GATEWAY_GROUP_ID" ] || fail "未找到建群 job 关联的群"

# 成员角色：creator + admin
ROLES=$(curl -sf "$BACKEND_URL/api/groups/$GROUP_UUID" -H "Authorization: Bearer $TOKEN" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const g=JSON.parse(s);console.log(g.members.map(m=>m.role).sort().join(','))})")
[ "$ROLES" = "admin,creator" ] || fail "成员角色应为 admin,creator，实际 $ROLES"
log "群成员角色正确（creator + admin）"

# ============================================================
step "4/5 发消息 → 投递 sent"
curl -sf -X POST "$BACKEND_URL/api/groups/$GROUP_UUID/send" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"accountId":"acct-1","text":"smoke test message"}' >/dev/null

# 时间线中该消息 deliveryStatus → sent（≤20s）
deadline=$((SECONDS + 20))
while [ $SECONDS -lt "$deadline" ]; do
  DSTATUS=$(curl -sf "$BACKEND_URL/api/groups/$GROUP_UUID/messages?limit=20" \
    -H "Authorization: Bearer $TOKEN" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const m=j.items.find(x=>x.text==='smoke test message');process.stdout.write(m?m.deliveryStatus:'missing')})")
  [ "$DSTATUS" = "sent" ] && break
  [ "$DSTATUS" = "failed" ] && fail "消息投递 failed"
  sleep 1
done
[ "$DSTATUS" = "sent" ] || fail "消息 20s 未 sent（最后 $DSTATUS）"
log "消息投递 sent，时间线可查"

# ============================================================
step "5/5 Agent run 全链路"
# agent-mock 恢复默认 normal 行为（防止此前测试留下的坏行为模式）
curl -sf -X POST "$AGENT_MOCK_URL/_mock/behavior" \
  -H 'Content-Type: application/json' -d '{"mode":"normal"}' >/dev/null
curl -sf -X PATCH "$BACKEND_URL/api/groups/$GROUP_UUID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"agentEnabled":true}' >/dev/null

RUNS_BEFORE=$(curl -sf "$BACKEND_URL/api/groups/$GROUP_UUID/agent-runs" \
  -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).length))")

curl -sf -X POST "$GATEWAY_URL/_mock/messages/inject" \
  -H 'Content-Type: application/json' \
  -d "[{\"groupId\":\"$GATEWAY_GROUP_ID\",\"senderPlatformUserId\":\"smoke-external\",\"text\":\"请处理\",\"sentAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\"}]" >/dev/null

# 新 run → finished（≤20s）
deadline=$((SECONDS + 20))
RUN_STATUS=""
while [ $SECONDS -lt "$deadline" ]; do
  RUN_STATUS=$(curl -sf "$BACKEND_URL/api/groups/$GROUP_UUID/agent-runs" \
    -H "Authorization: Bearer $TOKEN" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const rs=JSON.parse(s);process.stdout.write(rs.length>$RUNS_BEFORE?rs[0].status:'waiting')})")
  [ "$RUN_STATUS" = "finished" ] && break
  sleep 1
done
[ "$RUN_STATUS" = "finished" ] || fail "agent run 20s 未 finished（最后 $RUN_STATUS）"
log "agent run finished"

echo ""
echo "============================================================"
echo "PASS: 部署冒烟全部通过——5 服务 / 权限 / 建群 / 投递 / Agent"
echo "============================================================"
