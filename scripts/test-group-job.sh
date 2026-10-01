#!/usr/bin/env bash
# 集成测试：建群 job 全流程 + JOIN_TIMEOUT（规划 04 任务 4.16，§5 验收前 3 条）
#
# 场景 A（全流程）：
#   3 个账号 connect → POST /api/groups → 轮询 GET /api/jobs/:jobId → finished
#   → GET /api/groups/:id members role 依次 creator/admin/member
#   → 网关侧成员列表与 DB 一致
#   附带校验分支：memberAccountIds 为空 → 400 VALIDATION_ERROR；
#                 含离线账号 → 422 ACCOUNT_NOT_ONLINE
# 场景 B（JOIN_TIMEOUT）：
#   网关 joinNeverArrives=1（member_joined 永不推）→ 建群
#   → 10 秒后 job failed，errors[].code = JOIN_TIMEOUT 且 step 为 join:<accountId>
#
# 前提：docker compose 已启动（db / backend / gateway-mock 健康）。
# 用法：./scripts/test-group-job.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3100}"
DB_CONTAINER="${DB_CONTAINER:-multi-account-message-platform-db-1}"

TOKEN=""
GROUP_UUIDS=() # 本脚本创建的群，退出时清理

log() { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo ""; log "=== $* ==="; }

wait_http() {
  local url="$1" name="$2" timeout="${3:-30}"
  for _ in $(seq 1 "$timeout"); do
    if curl -sf "$url" >/dev/null 2>&1; then
      log "$name 就绪"
      return 0
    fi
    sleep 1
  done
  fail "$name 等待超时（${timeout}s）"
}

psql_exec() {
  docker exec "$DB_CONTAINER" psql -U app -d app -t -A -c "$1"
}

json_str() { grep -o "\"$2\":\"[^\"]*\"" <<<"$1" | head -n1 | cut -d'"' -f4; }

# 通用 JSON 求值工具（嵌套结构断言用；host 有 node——test-ws-reconnect.sh 同样依赖它）
APIQ_FILE="${TMPDIR:-/tmp}/.tmp-groupjob-apiq-$$.mjs"
cat > "$APIQ_FILE" <<'JS'
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const j = JSON.parse(s);
  // eslint-disable-next-line no-eval
  const v = eval(process.argv[2]);
  console.log(typeof v === 'object' ? JSON.stringify(v) : String(v));
});
JS

# 轮询 job 到目标状态；提前进入 failed（非目标）视为失败
poll_job() { # <jobId> <wantedStatus> <timeoutSec>
  local job_id="$1" want="$2" timeout="$3"
  local deadline=$((SECONDS + timeout))
  while [ $SECONDS -lt $deadline ]; do
    local body status
    body=$(curl -sf "$BACKEND_URL/api/jobs/$job_id" -H "Authorization: Bearer $TOKEN")
    status=$(json_str "$body" status)
    if [ "$status" = "$want" ]; then
      echo "$body"
      return 0
    fi
    if [ "$status" = "failed" ] && [ "$want" != "failed" ]; then
      fail "job $job_id 意外 failed：$body"
    fi
    sleep 1
  done
  fail "job $job_id 等待 $want 超时（${timeout}s）"
}

api_connect() { # <accountId> —— connect 并打印 platformUserId
  local body
  body=$(curl -sf -X POST "$BACKEND_URL/api/accounts/$1/connect" \
    -H "Authorization: Bearer $TOKEN")
  json_str "$body" platformUserId
}

cleanup() {
  rm -f "$APIQ_FILE"
  # 恢复 mock 默认：joinNeverArrives=0、real 时序、故障清空
  curl -sf -X POST "$GATEWAY_URL/_mock/behavior" -H 'content-type: application/json' \
    -d '{"joinNeverArrives":0}' >/dev/null 2>&1 || true
  curl -sf -X POST "$GATEWAY_URL/_mock/timing" -H 'content-type: application/json' \
    -d '{"profile":"real"}' >/dev/null 2>&1 || true
  # 删除本脚本创建的群（group_members 级联删除），jobs 作为历史保留
  for g in ${GROUP_UUIDS[@]+"${GROUP_UUIDS[@]}"}; do
    psql_exec "DELETE FROM groups WHERE id='$g'" >/dev/null 2>&1 || true
  done
  # 账号回到确定性起点
  psql_exec "UPDATE accounts SET status='idle', platform_user_id=NULL, rate_limited_until=NULL, retry_after_seconds=NULL WHERE account_id IN ('acct-1','acct-2','acct-3','acct-4')" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "步骤 0：前置检查 + 状态重置"
wait_http "$BACKEND_URL/api/health" "backend"
wait_http "$GATEWAY_URL/_mock/state" "gateway-mock"
curl -sf -X POST "$GATEWAY_URL/_mock/reset" -H 'content-type: application/json' \
  -d '{"seedAccounts":["acct-1","acct-2","acct-3","acct-4"]}' >/dev/null || fail "mock reset 失败"
curl -sf -X POST "$GATEWAY_URL/_mock/behavior" -H 'content-type: application/json' \
  -d '{"joinNeverArrives":0}' >/dev/null || fail "behavior 重置失败"
curl -sf -X POST "$GATEWAY_URL/_mock/timing" -H 'content-type: application/json' \
  -d '{"profile":"fast"}' >/dev/null || fail "切换 fast 时序失败"
psql_exec "UPDATE accounts SET status='idle', platform_user_id=NULL, rate_limited_until=NULL, retry_after_seconds=NULL WHERE account_id IN ('acct-1','acct-2','acct-3','acct-4')" >/dev/null
log "mock 与 DB 账号均已重置为确定性起点（idle）"

step "步骤 1：登录拿 token"
LOGIN_JSON=$(curl -sf -X POST "$BACKEND_URL/api/auth/login" \
  -H 'content-type: application/json' -d '{"username":"admin","password":"admin"}')
TOKEN=$(json_str "$LOGIN_JSON" accessToken)
[ -n "$TOKEN" ] || fail "登录未返回 accessToken"

step "步骤 2：connect 3 个账号（idle → online，同步 platformUserId 到网关）"
PU1=$(api_connect acct-1)
PU2=$(api_connect acct-2)
PU3=$(api_connect acct-3)
[ -n "$PU1" ] && [ -n "$PU2" ] && [ -n "$PU3" ] || fail "connect 失败"
log "acct-1/2/3 已 online（$PU1 / $PU2 / $PU3）"

step "步骤 3：校验分支 —— memberAccountIds 为空 → 400 VALIDATION_ERROR"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BACKEND_URL/api/groups" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"creatorAccountId":"acct-1","memberAccountIds":[]}')
[ "$CODE" = "400" ] || fail "空成员应 400，实际 $CODE"
log "空成员 → 400"

step "步骤 4：校验分支 —— 含离线账号 → 422 ACCOUNT_NOT_ONLINE"
RESP=$(curl -s -X POST "$BACKEND_URL/api/groups" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"creatorAccountId":"acct-1","memberAccountIds":["acct-4"]}')
grep -q 'ACCOUNT_NOT_ONLINE' <<<"$RESP" || fail "离线账号应 422 ACCOUNT_NOT_ONLINE，实际 $RESP"
log "acct-4（idle）→ 422 ACCOUNT_NOT_ONLINE"

step "步骤 5：场景 A —— 建群全流程（creator=acct-1, members=[acct-2, acct-3]）"
JOB=$(curl -sf -X POST "$BACKEND_URL/api/groups" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"creatorAccountId":"acct-1","memberAccountIds":["acct-2","acct-3"]}')
JOB_A=$(json_str "$JOB" jobId)
[ -n "$JOB_A" ] || fail "建群未返回 jobId"
log "job 已受理：$JOB_A"

JOB_BODY=$(poll_job "$JOB_A" finished 40)
ERRORS=$(echo "$JOB_BODY" | node "$APIQ_FILE" 'j.errors.length')
[ "$ERRORS" = "0" ] || fail "finished 的 job errors 应为空，实际 $JOB_BODY"
log "job finished，errors 为空"

step "步骤 6：场景 A —— members role 依次 creator/admin/member"
read -r GROUP_UUID GATEWAY_GID <<<"$(psql_exec "SELECT id, gateway_group_id FROM groups WHERE created_by_job_id='$JOB_A'" | head -n1 | tr '|' ' ')"
[ -n "${GROUP_UUID:-}" ] && [ -n "${GATEWAY_GID:-}" ] || fail "DB 查不到 job $JOB_A 对应的群"
GROUP_UUIDS+=("$GROUP_UUID")
DETAIL=$(curl -sf "$BACKEND_URL/api/groups/$GROUP_UUID" -H "Authorization: Bearer $TOKEN")
ROLE1=$(echo "$DETAIL" | node "$APIQ_FILE" "j.members.find(m=>m.platformUserId===\"$PU1\")?.role")
ROLE2=$(echo "$DETAIL" | node "$APIQ_FILE" "j.members.find(m=>m.platformUserId===\"$PU2\")?.role")
ROLE3=$(echo "$DETAIL" | node "$APIQ_FILE" "j.members.find(m=>m.platformUserId===\"$PU3\")?.role")
[ "$ROLE1" = "creator" ] || fail "acct-1 应为 creator，实际 $ROLE1"
[ "$ROLE2" = "admin" ] || fail "memberAccountIds[0]=acct-2 应被 promote 为 admin，实际 $ROLE2"
[ "$ROLE3" = "member" ] || fail "acct-3 应为 member，实际 $ROLE3"
MEMBER_TOTAL=$(echo "$DETAIL" | node "$APIQ_FILE" 'j.members.length')
[ "$MEMBER_TOTAL" = "3" ] || fail "members 应为 3，实际 $MEMBER_TOTAL"
log "role 序列正确：acct-1=creator, acct-2=admin, acct-3=member"

step "步骤 7：场景 A —— 网关成员列表与 DB 一致"
GW_MEMBERS=$(curl -sf "$GATEWAY_URL/groups/$GATEWAY_GID/members" | node "$APIQ_FILE" 'j.length')
[ "$GW_MEMBERS" = "3" ] || fail "网关侧 members 应为 3，实际 $GW_MEMBERS"
log "网关侧 3 名成员，与 DB 一致"

step "步骤 8：场景 B —— JOIN_TIMEOUT（member_joined 永不推 → 10s 后 job failed）"
curl -sf -X POST "$GATEWAY_URL/_mock/behavior" -H 'content-type: application/json' \
  -d '{"joinNeverArrives":1}' >/dev/null || fail "开启 joinNeverArrives 失败"
PU4=$(api_connect acct-4)
[ -n "$PU4" ] || fail "acct-4 connect 失败"
JOB=$(curl -sf -X POST "$BACKEND_URL/api/groups" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"creatorAccountId":"acct-1","memberAccountIds":["acct-4"]}')
JOB_B=$(json_str "$JOB" jobId)
[ -n "$JOB_B" ] || fail "场景 B 建群未返回 jobId"
log "job 已受理：$JOB_B（joinNeverArrives=1，等待 10s 超时判定）"

JOB_BODY=$(poll_job "$JOB_B" failed 30)
JT=$(echo "$JOB_BODY" | node "$APIQ_FILE" \
  'j.errors.some(e=>e.code==="JOIN_TIMEOUT" && typeof e.step==="string" && e.step.startsWith("join:"))')
[ "$JT" = "true" ] || fail "errors 应含 code=JOIN_TIMEOUT 且 step=join:<accountId>，实际 $JOB_BODY"
# 记录场景 B 的群用于清理（群已建出但成员没进来）
B_GROUP=$(psql_exec "SELECT id FROM groups WHERE created_by_job_id='$JOB_B'" | head -n1)
[ -n "$B_GROUP" ] && GROUP_UUIDS+=("$B_GROUP")
log "job failed，errors[] 含 JOIN_TIMEOUT（step=join:acct-4）"

echo ""
echo "============================================================"
echo "PASS: 建群全流程（creator/admin/member + 网关一致）+ JOIN_TIMEOUT"
echo "============================================================"
