#!/usr/bin/env bash
# e2e：题面 §2.4 场景 S6–S8（规划 05 任务 5.23，宿主机脚本只调容器 HTTP + psql 断言）
#
#   S6  Agent 坏响应：
#         run A bad_json ×3 → failed(protocol_errors)，每步 protocol_error + rawResponse
#         run B unknown_tool 一次 → is_error(UNKNOWN_TOOL) 计入对话 → finished(final)
#         结尾 backend / agent-mock health 均 200（坏响应不打挂服务）
#   S7  序列并发：同群两个并发 POST sequence-runs → 恰好 201 + 409 SEQUENCE_ALREADY_RUNNING
#   S8  序列预检：第 3 步占位符不可解析 → 422 UNRESOLVED_PLACEHOLDER {stepIndex, key}，
#         网关消息数不变（不产生任何发送）
#
# 前提：docker compose 已启动（db / backend / gateway-mock / agent-mock 健康）。
# 用法：./scripts/test-e2e-s6-s8.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3100}"
AGENT_URL="${AGENT_URL:-http://localhost:3200}"
DB_CONTAINER="${DB_CONTAINER:-multi-account-message-platform-db-1}"

TOKEN=""
PU1=""
G2=""          # agentEnabled 群：S6 两个 run
G2_GW=""
G3=""          # 普通群（agent 关）：S7 / S8
G3_GW=""

log() { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo ""; log "=== $* ==="; }

wait_http() {
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

psql_exec() { docker exec "$DB_CONTAINER" psql -U app -d app -t -A -c "$1"; }
json_str() { grep -o "\"$2\":\"[^\"]*\"" <<<"$1" | head -n1 | cut -d'"' -f4; }
# 注入事件的 sentAt 为必填（缺省会变成 inbox 毒药事件被无限重试）
now_iso() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }

# 通用 JSON 求值（host 有 node，与 test-e2e-s1-s5.sh 同一前提）
APIQ_FILE="${TMPDIR:-/tmp}/.tmp-e2e-s68-apiq-$$.mjs"
cat > "$APIQ_FILE" <<'JS'
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const j = JSON.parse(s);
  // eslint-disable-next-line no-eval
  const v = eval(process.argv[2]);
  console.log(typeof v === 'object' ? JSON.stringify(v) : String(v));
});
JS
api_q() { node "$APIQ_FILE" "$1"; }                     # stdin: 任意 API JSON
mock_q() { curl -sf "$GATEWAY_URL/_mock/state" | api_q "$1"; }  # 网关 /_mock/state

gw_post() { curl -sf -X POST "$GATEWAY_URL$1" -H 'content-type: application/json' -d "$2" >/dev/null; }

cleanup() {
  rm -f "$APIQ_FILE"
  gw_post /_mock/faults '{"clearAll":true}' 2>/dev/null || true
  curl -sf -X POST "$AGENT_URL/_mock/reset" >/dev/null 2>&1 || true
  # sequence_runs/steps 有群外键，先删；序列模板是全局表，一并清掉
  [ -n "$G2" ] && psql_exec "DELETE FROM groups WHERE id='$G2'" >/dev/null 2>&1 || true
  [ -n "$G3" ] && psql_exec "DELETE FROM groups WHERE id='$G3'" >/dev/null 2>&1 || true
  psql_exec "DELETE FROM sequence_steps; DELETE FROM sequence_runs; DELETE FROM sequences" >/dev/null 2>&1 || true
  # 清掉本脚本可能留下的未处理事件（失败中途退出时避免毒药事件热重试）
  psql_exec "DELETE FROM events_inbox WHERE processed_at IS NULL" >/dev/null 2>&1 || true
  psql_exec "UPDATE accounts SET status='idle', platform_user_id=NULL, rate_limited_until=NULL, retry_after_seconds=NULL WHERE account_id IN ('acct-1','acct-2','acct-3','acct-4')" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "步骤 0：前置检查 + 重置"
wait_http "$BACKEND_URL/api/health" "backend"
wait_http "$GATEWAY_URL/_mock/state" "gateway-mock"
wait_http "$AGENT_URL/health" "agent-mock"
gw_post /_mock/reset '{"resetEventCounter":true,"seedAccounts":["acct-1","acct-2","acct-3","acct-4"]}' || fail "gateway reset 失败"
gw_post /_mock/timing '{"profile":"fast"}' || fail "切 fast 时序失败"
curl -sf -X POST "$AGENT_URL/_mock/reset" >/dev/null || fail "agent-mock reset 失败"
# 网关事件计数已归零：backend 的 cursor/inbox 必须同步归零，否则新事件被 since/去重丢弃
psql_exec "TRUNCATE events_inbox" >/dev/null
psql_exec "UPDATE events_cursor SET last_seen_event_id = 0 WHERE id = 1" >/dev/null
psql_exec "UPDATE accounts SET status='idle', platform_user_id=NULL, rate_limited_until=NULL, retry_after_seconds=NULL WHERE account_id IN ('acct-1','acct-2','acct-3','acct-4')" >/dev/null
# 清掉历史序列运行（同群 running 唯一约束会挡 S7）
psql_exec "DELETE FROM sequence_steps; DELETE FROM sequence_runs; DELETE FROM sequences" >/dev/null

LOGIN_JSON=$(curl -sf -X POST "$BACKEND_URL/api/auth/login" \
  -H 'content-type: application/json' -d '{"username":"admin","password":"admin"}')
TOKEN=$(json_str "$LOGIN_JSON" accessToken)
[ -n "$TOKEN" ] || fail "登录失败"

# connect acct-1（DB online + 网关 online + platformUserId）
PU1=$(json_str "$(curl -sf -X POST "$BACKEND_URL/api/accounts/acct-1/connect" \
  -H "Authorization: Bearer $TOKEN")" platformUserId)
[ -n "$PU1" ] || fail "acct-1 connect 失败"

# 直插两个群（跳过建群 job，聚焦 S6–S8 本身）：
#   G2 agentEnabled=true（S6）；G3 agent 关（S7/S8）。成员均只有 acct-1（creator）。
make_group() { # <agent_enabled:true|false> → 打印 "<dbUuid> <gatewayGroupId>"
  local agent_enabled="$1" gw_gid db_gid
  gw_gid=$(json_str "$(curl -sf -X POST "$GATEWAY_URL/groups" \
    -H 'content-type: application/json' -d '{"creatorAccountId":"acct-1"}')" groupId)
  [ -n "$gw_gid" ] || fail "网关建群失败"
  db_gid=$(psql_exec "INSERT INTO groups (gateway_group_id, creator_account_id, agent_enabled) VALUES ('$gw_gid', (SELECT id FROM accounts WHERE account_id='acct-1'), $agent_enabled) RETURNING id" | head -n1)
  [ -n "$db_gid" ] || fail "DB 建群失败"
  psql_exec "INSERT INTO group_members (group_id, account_id, platform_user_id, role) VALUES ('$db_gid', (SELECT id FROM accounts WHERE account_id='acct-1'), '$PU1', 'creator')" >/dev/null
  echo "$db_gid $gw_gid"
}
read -r G2 G2_GW <<<"$(make_group true)"
read -r G3 G3_GW <<<"$(make_group false)"
log "G2=$G2（agentEnabled），G3=$G3（agent 关）"

# 注入一条外部消息触发 agent run，并等待"新 run"到达终态；打印 run 详情 JSON。
# 必须先记录注入前的最新 run id：否则第一轮轮询就会拿到上一个已终态的 run 并误break。
trigger_and_wait_run() { # <injectText> <timeoutSec>
  local text="$1" timeout="$2"
  local prev_id
  prev_id=$(curl -sf "$BACKEND_URL/api/groups/$G2/agent-runs" -H "Authorization: Bearer $TOKEN" \
    | api_q 'j.length > 0 ? j[0].id : ""')
  curl -sf -X POST "$GATEWAY_URL/_mock/messages/inject" -H 'content-type: application/json' \
    -d "[{\"groupId\":\"$G2_GW\",\"senderPlatformUserId\":\"pu_ext_user\",\"text\":\"$text\",\"sentAt\":\"$(now_iso)\"}]" >/dev/null
  local deadline=$((SECONDS + timeout)) body="" st="" run_id=""
  while [ $SECONDS -lt $deadline ]; do
    body=$(curl -sf "$BACKEND_URL/api/groups/$G2/agent-runs" -H "Authorization: Bearer $TOKEN")
    run_id=$(echo "$body" | api_q 'j.length > 0 ? j[0].id : ""')
    if [ -n "$run_id" ] && [ "$run_id" != "$prev_id" ]; then
      st=$(echo "$body" | api_q 'j[0].status')
      case "$st" in
        finished|failed|blocked|cancelled) break ;;
      esac
    fi
    sleep 0.5
  done
  [ -n "$run_id" ] && [ "$run_id" != "$prev_id" ] || fail "未等到新 run（prev=$prev_id）"
  case "$st" in
    finished|failed|blocked|cancelled) ;;
    *) fail "run 未在 ${timeout}s 内到达终态（status=$st）" ;;
  esac
  curl -sf "$BACKEND_URL/api/agent-runs/$run_id" -H "Authorization: Bearer $TOKEN"
}

step "S6-a：bad_json 连续 3 次 → failed(protocol_errors)，每步带 rawResponse"
curl -sf -X POST "$AGENT_URL/_mock/behavior" -H 'content-type: application/json' \
  -d '{"mode":"bad_json"}' >/dev/null || fail "切 bad_json 失败"
RUN_A=$(trigger_and_wait_run "s6a-trigger" 30)
RUN_A_ST=$(echo "$RUN_A" | api_q 'j.status')
RUN_A_ER=$(echo "$RUN_A" | api_q 'j.endReason')
[ "$RUN_A_ST" = "failed" ] && [ "$RUN_A_ER" = "protocol_errors" ] \
  || fail "S6a：应 failed(protocol_errors)，实际 $RUN_A_ST($RUN_A_ER)（$RUN_A）"
RUN_A_KINDS=$(echo "$RUN_A" | api_q 'j.steps.map(s=>s.kind+":"+String(s.errorCode)).join(",")')
[ "$RUN_A_KINDS" = "protocol_error:BAD_JSON,protocol_error:BAD_JSON,protocol_error:BAD_JSON" ] \
  || fail "S6a：应 3 步 protocol_error:BAD_JSON，实际 $RUN_A_KINDS"
RUN_A_RAW=$(echo "$RUN_A" | api_q 'j.steps.every(s=>typeof s.rawResponse==="string" && s.rawResponse.length>0)')
[ "$RUN_A_RAW" = "true" ] || fail "S6a：每个协议错误步应带非空 rawResponse"
log "S6-a：failed(protocol_errors)，3 步 BAD_JSON 且 rawResponse 非空"

step "S6-b：unknown_tool 一次 → is_error 计入对话 → finished(final)"
curl -sf -X POST "$AGENT_URL/_mock/behavior" -H 'content-type: application/json' \
  -d '{"mode":"unknown_tool"}' >/dev/null || fail "切 unknown_tool 失败"
RUN_B=$(trigger_and_wait_run "s6b-trigger" 30)
curl -sf -X POST "$AGENT_URL/_mock/behavior" -H 'content-type: application/json' \
  -d '{"mode":"normal"}' >/dev/null
RUN_B_ST=$(echo "$RUN_B" | api_q 'j.status')
RUN_B_ER=$(echo "$RUN_B" | api_q 'j.endReason')
[ "$RUN_B_ST" = "finished" ] && [ "$RUN_B_ER" = "final" ] \
  || fail "S6b：应 finished(final)，实际 $RUN_B_ST($RUN_B_ER)（$RUN_B）"
B_STEP1_KIND=$(echo "$RUN_B" | api_q 'j.steps[0].kind')
B_STEP1_ERR=$(echo "$RUN_B" | api_q 'j.steps[0].isError')
B_STEP1_CODE=$(echo "$RUN_B" | api_q 'j.steps[0].errorCode')
[ "$B_STEP1_KIND" = "tool_use" ] && [ "$B_STEP1_ERR" = "true" ] && [ "$B_STEP1_CODE" = "UNKNOWN_TOOL" ] \
  || fail "S6b：第 1 步应 tool_use/isError/UNKNOWN_TOOL，实际 $B_STEP1_KIND/$B_STEP1_ERR/$B_STEP1_CODE"
B_LAST_KIND=$(echo "$RUN_B" | api_q 'j.steps[j.steps.length-1].kind')
[ "$B_LAST_KIND" = "final" ] || fail "S6b：末步应 final，实际 $B_LAST_KIND"
log "S6-b：UNKNOWN_TOOL 以 is_error 计入对话（第 1 类协议错误），run finished(final)"

step "S6-c：坏响应后服务仍健康"
curl -sf "$BACKEND_URL/api/health" >/dev/null || fail "backend health 非 200"
curl -sf "$AGENT_URL/health" >/dev/null || fail "agent-mock health 非 200"
log "S6-c：backend / agent-mock health 均 200"

step "S7：同群并发启动序列 → 恰好 201 + 409 SEQUENCE_ALREADY_RUNNING"
SEQ_BODY='{"name":"s7-seq","steps":[
  {"text":"s7 step1 {who}","delaySeconds":0,"accountRole":"admin"},
  {"text":"s7 step2 {who}","delaySeconds":120,"accountRole":"admin"}
]}'
SEQ_ID=$(curl -sf -X POST "$BACKEND_URL/api/sequences" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$SEQ_BODY" | api_q 'j.id')
[ -n "$SEQ_ID" ] || fail "创建序列失败"
# 并发两个启动请求（step2 delaySeconds=120：run 长时间保持 running，
# 既保证第二次并发撞 409，也避免 step2 在 S8 期间发出干扰"网关消息数不变"断言）
RUN_BODY="{\"sequenceId\":\"$SEQ_ID\",\"vars\":{\"who\":\"tester\"}}"
curl -s -o /tmp/.s7-r1.json -w '%{http_code}' -X POST "$BACKEND_URL/api/groups/$G3/sequence-runs" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$RUN_BODY" > /tmp/.s7-c1 &
CURL1_PID=$!
curl -s -o /tmp/.s7-r2.json -w '%{http_code}' -X POST "$BACKEND_URL/api/groups/$G3/sequence-runs" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$RUN_BODY" > /tmp/.s7-c2 &
CURL2_PID=$!
wait "$CURL1_PID" "$CURL2_PID"
CODE1=$(cat /tmp/.s7-c1); CODE2=$(cat /tmp/.s7-c2)
rm -f /tmp/.s7-c1 /tmp/.s7-c2
CODES=$(printf '%s\n%s\n' "$CODE1" "$CODE2" | sort | tr -d '\n')
[ "$CODES" = "201409" ] || fail "S7：并发应恰好 201+409，实际 $CODE1+$CODE2"
# 409 的错误码断言（取是 409 的那份响应）
R409=/tmp/.s7-r1.json; [ "$CODE1" = "409" ] || R409=/tmp/.s7-r2.json
ERR_CODE=$(api_q 'j.error.code' < "$R409")
BODY409=$(cat "$R409")
[ "$ERR_CODE" = "SEQUENCE_ALREADY_RUNNING" ] || fail "S7：409 应 SEQUENCE_ALREADY_RUNNING，实际 $ERR_CODE（$BODY409）"
rm -f /tmp/.s7-r1.json /tmp/.s7-r2.json
# run 确实在 running
S7_ST=$(curl -sf "$BACKEND_URL/api/groups/$G3/sequence-runs" -H "Authorization: Bearer $TOKEN" | api_q 'j[0].status')
[ "$S7_ST" = "running" ] || fail "S7：序列运行应 running，实际 $S7_ST"
log "S7：并发 201+409 SEQUENCE_ALREADY_RUNNING，run 保持 running"

step "S8：第 3 步占位符不可解析 → 422 UNRESOLVED_PLACEHOLDER，网关零发送"
SEQ8_BODY='{"name":"s8-seq","steps":[
  {"text":"s8 step1 {who}","delaySeconds":0,"accountRole":"admin"},
  {"text":"s8 step2 {who}","delaySeconds":1,"accountRole":"admin"},
  {"text":"s8 step3 {who} {missingKey}","delaySeconds":1,"accountRole":"admin"}
]}'
SEQ8_ID=$(curl -sf -X POST "$BACKEND_URL/api/sequences" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$SEQ8_BODY" | api_q 'j.id')
[ -n "$SEQ8_ID" ] || fail "创建 S8 序列失败"
GW_BEFORE=$(mock_q 'j.messages.length')
# 启动端点：预检应在创建任何运行/发送任何消息之前拦截
HTTP8=$(curl -s -o /tmp/.s8-resp.json -w '%{http_code}' -X POST "$BACKEND_URL/api/groups/$G3/sequence-runs" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"sequenceId\":\"$SEQ8_ID\",\"vars\":{\"who\":\"tester\"}}")
BODY8=$(cat /tmp/.s8-resp.json)
[ "$HTTP8" = "422" ] || fail "S8：启动应 422，实际 $HTTP8（$BODY8）"
E8_CODE=$(api_q 'j.error.code' < /tmp/.s8-resp.json)
E8_STEP=$(api_q 'j.error.stepIndex' < /tmp/.s8-resp.json)
E8_KEY=$(api_q 'j.error.key' < /tmp/.s8-resp.json)
[ "$E8_CODE" = "UNRESOLVED_PLACEHOLDER" ] || fail "S8：错误码应 UNRESOLVED_PLACEHOLDER，实际 $E8_CODE"
[ "$E8_STEP" = "2" ] || fail "S8：stepIndex 应 2（0-based 第 3 步），实际 $E8_STEP"
[ "$E8_KEY" = "missingKey" ] || fail "S8：key 应 missingKey，实际 $E8_KEY"
# precheck 端点：同形 422（前端预检弹窗复用）
HTTP8P=$(curl -s -o /tmp/.s8-pre.json -w '%{http_code}' -X POST "$BACKEND_URL/api/sequences/precheck" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"sequenceId\":\"$SEQ8_ID\",\"vars\":{\"who\":\"tester\"}}")
[ "$HTTP8P" = "422" ] || fail "S8：precheck 应 422，实际 $HTTP8P"
E8P_CODE=$(api_q 'j.error.code' < /tmp/.s8-pre.json)
E8P_KEY=$(api_q 'j.error.key' < /tmp/.s8-pre.json)
[ "$E8P_CODE" = "UNRESOLVED_PLACEHOLDER" ] && [ "$E8P_KEY" = "missingKey" ] \
  || fail "S8：precheck 错误应同形，实际 $E8P_CODE/$E8P_KEY"
rm -f /tmp/.s8-resp.json /tmp/.s8-pre.json
# 预检失败不得产生任何发送：网关消息数不变
GW_AFTER=$(mock_q 'j.messages.length')
[ "$GW_AFTER" = "$GW_BEFORE" ] || fail "S8：网关消息数不应变化（$GW_BEFORE → $GW_AFTER）"
log "S8：启动 + precheck 均 422 {stepIndex:2,key:missingKey}，网关消息数不变（$GW_BEFORE）"

echo ""
echo "============================================================"
echo "PASS: e2e S6–S8 全部通过"
echo "============================================================"
