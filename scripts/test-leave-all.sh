#!/usr/bin/env bash
# 全员退群测试（B2，切片 5）。
#
# 验证（docs/examination_project.md A4 + 规划 05 §3）：
#   1. 建群 finished（creator + member 在线）
#   2. POST /api/groups/:id/leave-all → 异步 job finished
#   3. 本地群 status=left、成员数 0；网关侧群成员同步为 0
#
# 前提：docker compose up -d。用法：./scripts/test-leave-all.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3100}"
DB_CONTAINER="${DB_CONTAINER:-multi-account-message-platform-db-1}"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo ""; log "=== $* ==="; }

# 轮询 job 到终态
poll_job() { # <jobId> <timeoutSec> → 输出最终 status
  local job_id="$1" timeout="$2" deadline=$((SECONDS + $2))
  local status=""
  while [ $SECONDS -lt "$deadline" ]; do
    status=$(curl -sf "$BACKEND_URL/api/jobs/$job_id" \
      -H "Authorization: Bearer $TOKEN" \
      | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ "$status" = "finished" ] || [ "$status" = "failed" ]; then
      echo "$status"
      return 0
    fi
    sleep 1
  done
  echo "$status"
}

step "1/4 重置 + 登录 + 连接账号 + 建群"
# 事件流水线自愈：保证建群 member_joined 不被此前脚本的高游标跳过
curl -sf -X POST "$GATEWAY_URL/_mock/reset" -H 'Content-Type: application/json' \
  -d '{"resetEventCounter":true,"seedAccounts":["acct-1","acct-2"]}' >/dev/null
docker exec "$DB_CONTAINER" psql -U app -d app -q -c \
  "TRUNCATE events_inbox; UPDATE events_cursor SET last_seen_event_id = 0 WHERE id = 1;
   UPDATE accounts SET status='idle', platform_user_id=NULL, rate_limited_until=NULL
   WHERE account_id IN ('acct-1','acct-2')"

TOKEN=$(curl -sf -X POST "$BACKEND_URL/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
for a in acct-1 acct-2; do
  curl -sf -X POST "$BACKEND_URL/api/accounts/$a/connect" \
    -H "Authorization: Bearer $TOKEN" >/dev/null
done
log "acct-1/acct-2 online"

CREATE_BODY=$(curl -sf -X POST "$BACKEND_URL/api/groups" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"creatorAccountId":"acct-1","memberAccountIds":["acct-2"]}')
CREATE_JOB=$(grep -o '"jobId":"[^"]*"' <<<"$CREATE_BODY" | cut -d'"' -f4)
ST=$(poll_job "$CREATE_JOB" 30)
[ "$ST" = "finished" ] || fail "建群 job 未 finished：$ST"
log "建群 finished"

# 群经 groups.created_by_job_id 反向关联建群 job；据此取本地/网关群 id
# -F ' '：把 psql 非对齐分隔符由默认的 | 改为空格，供 read 拆成两个变量
read -r GROUP_UUID GATEWAY_GROUP_ID < <(docker exec "$DB_CONTAINER" psql -U app -d app -t -A -F ' ' -c \
  "SELECT id, gateway_group_id FROM groups WHERE created_by_job_id = '$CREATE_JOB'")
[ -n "$GROUP_UUID" ] && [ -n "$GATEWAY_GROUP_ID" ] \
  || fail "未找到建群 job 关联的群"
log "群：$GROUP_UUID / 网关群：$GATEWAY_GROUP_ID"

# 建群后网关应有成员
GW_BEFORE=$(curl -sf "$GATEWAY_URL/_mock/state" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const g=j.groups.find(x=>x.groupId==='$GATEWAY_GROUP_ID');console.log(g?g.members.length:-1)})")
[ "$GW_BEFORE" -ge 1 ] || fail "退群前网关群应有成员，实际 $GW_BEFORE"
log "退群前网关成员数：$GW_BEFORE"

step "2/4 发起 leave-all"
LEAVE_BODY=$(curl -s -X POST "$BACKEND_URL/api/groups/$GROUP_UUID/leave-all" \
  -H "Authorization: Bearer $TOKEN")
LEAVE_JOB=$(grep -o '"jobId":"[^"]*"' <<<"$LEAVE_BODY" | cut -d'"' -f4)
[ -n "$LEAVE_JOB" ] || fail "leave-all 未返回 jobId：$LEAVE_BODY"

ST=$(poll_job "$LEAVE_JOB" 30)
[ "$ST" = "finished" ] || fail "leave-all job 未 finished：$ST"
log "leave-all job finished"

step "3/4 本地群状态"
DETAIL=$(curl -sf "$BACKEND_URL/api/groups/$GROUP_UUID" -H "Authorization: Bearer $TOKEN")
LSTATUS=$(node -e "const g=$DETAIL;console.log(g.status)")
LMEMBERS=$(node -e "const g=$DETAIL;console.log(g.members.length)")
[ "$LSTATUS" = "left" ] || fail "本地群状态应 left，实际 $LSTATUS"
[ "$LMEMBERS" = "0" ] || fail "本地成员应清空，实际 $LMEMBERS"
log "本地群 left，成员 0"

step "4/4 网关成员一致性"
GW_AFTER=$(curl -sf "$GATEWAY_URL/_mock/state" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const g=j.groups.find(x=>x.groupId==='$GATEWAY_GROUP_ID');console.log(g?g.members.length:0)})")
[ "$GW_AFTER" = "0" ] || fail "网关成员应同步为 0，实际 $GW_AFTER"
log "网关成员 0"

echo ""
echo "============================================================"
echo "PASS: 全员退群通过——job finished / 本地 left / 网关一致"
echo "============================================================"
