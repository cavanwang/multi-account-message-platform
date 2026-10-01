#!/usr/bin/env bash
# e2e：题面 §2.4 场景 S1–S5（规划 05 任务 5.23，宿主机脚本只调容器 HTTP + psql 断言）
#
#   S1  受理与发出：202 → message_sent 前 deliveryStatus=accepted，之后 sent
#   S2  事件重复：duplicate-mode 下时间线无重复行、agent 不被重复触发
#   S3  自己的消息回流：isOwn=true，不产生新的 agent run
#   S4  限流：429 → 账号 rate_limited，到期前网关收不到该账号 send，到期自动恢复
#   S5  504 收敛四子项（落地 sent / 未落地重发一次 / by-client-id 503 保持 unknown / 双重 504 failed）
#       + Agent 用同一 idempotency_key 重试：网关恰好一条、幂等返回当前状态、run 正常结束
#
# 前提：docker compose 已启动（db / backend / gateway-mock / agent-mock 健康）。
# 用法：./scripts/test-e2e-s1-s5.sh

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
G1=""          # 普通群（agent 关）：S1 / S4 / S5 子项
G1_GW=""
G2=""          # agentEnabled 群：S2 / S3 / S5-agent
G2_GW=""

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

# 通用 JSON 求值（host 有 node，与 test-ws-reconnect.sh 同一前提）
APIQ_FILE="${TMPDIR:-/tmp}/.tmp-e2e-apiq-$$.mjs"
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

# 轮询 psql 直到表达式命中（$1=SQL 输出期望值，$2=SQL，$3=超时秒，$4=描述）
poll_sql_eq() {
  local want="$1" sql="$2" timeout="$3" desc="$4"
  local deadline=$((SECONDS + timeout)) got=""
  while [ $SECONDS -lt $deadline ]; do
    got=$(psql_exec "$sql" | head -n1)
    if [ "$got" = "$want" ]; then
      log "$desc"
      return 0
    fi
    sleep 0.5
  done
  fail "$desc —— 超时（${timeout}s），最后值=$got"
}

cleanup() {
  rm -f "$APIQ_FILE"
  gw_post /_mock/timing '{"profile":"real"}' 2>/dev/null || true
  gw_post /_mock/events/duplicate-mode '{"on":false}' 2>/dev/null || true
  gw_post /_mock/faults '{"clearAll":true}' 2>/dev/null || true
  curl -sf -X POST "$AGENT_URL/_mock/reset" >/dev/null 2>&1 || true
  [ -n "$G1" ] && psql_exec "DELETE FROM groups WHERE id='$G1'" >/dev/null 2>&1 || true
  [ -n "$G2" ] && psql_exec "DELETE FROM groups WHERE id='$G2'" >/dev/null 2>&1 || true
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

LOGIN_JSON=$(curl -sf -X POST "$BACKEND_URL/api/auth/login" \
  -H 'content-type: application/json' -d '{"username":"admin","password":"admin"}')
TOKEN=$(json_str "$LOGIN_JSON" accessToken)
[ -n "$TOKEN" ] || fail "登录失败"

# connect acct-1（DB online + 网关 online + platformUserId）
PU1=$(json_str "$(curl -sf -X POST "$BACKEND_URL/api/accounts/acct-1/connect" \
  -H "Authorization: Bearer $TOKEN")" platformUserId)
[ -n "$PU1" ] || fail "acct-1 connect 失败"

# 直插两个群（跳过建群 job，聚焦 S1–S5 本身）：
#   G1 agent 关；G2 agentEnabled=true。成员均只有 acct-1（creator）。
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
read -r G1 G1_GW <<<"$(make_group false)"
read -r G2 G2_GW <<<"$(make_group true)"
log "G1=$G1（agent 关），G2=$G2（agentEnabled）"

# 最新一条 outbox 的 client_msg_id / status
ob_field() { psql_exec "SELECT $2 FROM outbox_messages WHERE group_id='$1' ORDER BY created_at DESC LIMIT 1" | head -n1; }

step "S1：受理与发出 —— message_sent 前 accepted，之后 sent"
gw_post /_mock/timing '{"profile":"real"}' # real 时序拉开 accepted→sent 间隔，便于观测
curl -sf -X POST "$BACKEND_URL/api/groups/$G1/send" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"accountId":"acct-1","text":"s1 hello"}' >/dev/null || fail "S1 send 失败"
S1_SEQ=""
S1_LAST=""
S1_DEADLINE=$((SECONDS + 20))
while [ $SECONDS -lt $S1_DEADLINE ]; do
  S=$(ob_field "$G1" delivery_status)
  if [ "$S" != "$S1_LAST" ]; then
    S1_SEQ="${S1_SEQ}${S1_SEQ:+ }$S"
    S1_LAST="$S"
  fi
  [ "$S" = "sent" ] && break
  [ "$S" = "failed" ] && fail "S1 不应 failed（序列：$S1_SEQ）"
  sleep 0.2
done
[ "$S1_LAST" = "sent" ] || fail "S1 20s 内未 sent（序列：$S1_SEQ）"
grep -q 'accepted' <<<"$S1_SEQ" || fail "S1 未观察到 accepted 中间态（序列：$S1_SEQ）"
log "S1 状态序列：$S1_SEQ（含 accepted → sent）"
gw_post /_mock/timing '{"profile":"fast"}'

step "S2：事件重复 —— 时间线无重复行，agent 不被重复触发"
gw_post /_mock/events/duplicate-mode '{"on":true}' || fail "开 duplicate-mode 失败"
curl -sf -X POST "$GATEWAY_URL/_mock/messages/inject" -H 'content-type: application/json' \
  -d "[{\"groupId\":\"$G2_GW\",\"senderPlatformUserId\":\"pu_ext_user\",\"text\":\"s2-mark\",\"sentAt\":\"$(now_iso)\"}]" >/dev/null
poll_sql_eq 1 "SELECT COUNT(*) FROM messages WHERE group_id='$G2' AND text='s2-mark'" 10 \
  "S2：注入消息已落库且恰好 1 行"
# agent 触发：轮询 runs=1
DEADLINE=$((SECONDS + 15))
RUNS=0
while [ $SECONDS -lt $DEADLINE ]; do
  RUNS=$(curl -sf "$BACKEND_URL/api/groups/$G2/agent-runs" -H "Authorization: Bearer $TOKEN" | api_q 'j.length')
  [ "$RUNS" = "1" ] && break
  sleep 0.5
done
[ "$RUNS" = "1" ] || fail "S2：agent 应恰好触发 1 次，实际 runs=$RUNS"
# 等 run 结束，再确认没有第二次触发（pending 再触发会在结束后立刻出现）
RUN_ID=$(curl -sf "$BACKEND_URL/api/groups/$G2/agent-runs" -H "Authorization: Bearer $TOKEN" | api_q 'j[0].id')
DEADLINE=$((SECONDS + 45))
ST="running"
while [ $SECONDS -lt $DEADLINE ]; do
  ST=$(curl -sf "$BACKEND_URL/api/agent-runs/$RUN_ID" -H "Authorization: Bearer $TOKEN" \
    | grep -o '"status":"[^"]*"' | head -n1 | cut -d'"' -f4)
  if [ "$ST" = "finished" ] || [ "$ST" = "failed" ] || [ "$ST" = "blocked" ]; then
    break
  fi
  sleep 0.5
done
[ "$ST" = "finished" ] || fail "S2：run 45s 内未正常结束（$ST）"
sleep 2
RUNS=$(curl -sf "$BACKEND_URL/api/groups/$G2/agent-runs" -H "Authorization: Bearer $TOKEN" | api_q 'j.length')
[ "$RUNS" = "1" ] || fail "S2：重复事件不应再触发 agent，runs=$RUNS"
DUP=$(psql_exec "SELECT COUNT(*) - COUNT(DISTINCT msg_id) FROM messages WHERE group_id='$G2'")
[ "$DUP" = "0" ] || fail "S2：时间线存在重复 msg_id"
gw_post /_mock/events/duplicate-mode '{"on":false}' || fail "关 duplicate-mode 失败"
log "S2：时间线无重复行，runs=1（run $RUN_ID 已结束：$ST）"

step "S3：自己的消息回流 —— isOwn=true，不产生新 run"
curl -sf -X POST "$BACKEND_URL/api/groups/$G2/send" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"accountId":"acct-1","text":"s3-own"}' >/dev/null || fail "S3 send 失败"
poll_sql_eq sent "SELECT delivery_status FROM outbox_messages WHERE group_id='$G2' ORDER BY created_at DESC LIMIT 1" 15 \
  "S3：自己的消息已 sent"
CMID3=$(ob_field "$G2" client_msg_id)
poll_sql_eq t "SELECT is_own FROM messages WHERE group_id='$G2' AND client_msg_id='$CMID3'" 10 \
  "S3：回流行 isOwn=true"
sleep 2
RUNS=$(curl -sf "$BACKEND_URL/api/groups/$G2/agent-runs" -H "Authorization: Bearer $TOKEN" | api_q 'j.length')
[ "$RUNS" = "1" ] || fail "S3：自己的消息不应触发新 run，runs=$RUNS"
log "S3：isOwn=true，runs 仍为 1"

step "S4：限流 —— 429 → rate_limited → 到期前网关收不到 send → 到期自动恢复"
gw_post /_mock/accounts/acct-1/rate-limit '{"retryAfterSeconds":3}' || fail "预置限流失败"
curl -sf -X POST "$BACKEND_URL/api/groups/$G1/send" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"accountId":"acct-1","text":"s4 rate limited"}' >/dev/null || fail "S4 send 失败"
# 账号进入 rate_limited
DEADLINE=$((SECONDS + 10))
ACCT_ST=""
while [ $SECONDS -lt $DEADLINE ]; do
  ACCT_ST=$(curl -sf "$BACKEND_URL/api/accounts" -H "Authorization: Bearer $TOKEN" \
    | api_q 'j.find(a=>a.id==="acct-1").status')
  [ "$ACCT_ST" = "rate_limited" ] && break
  sleep 0.5
done
[ "$ACCT_ST" = "rate_limited" ] || fail "S4：acct-1 应进入 rate_limited，实际 $ACCT_ST"
log "S4：acct-1 已 rate_limited"
CMID4=$(ob_field "$G1" client_msg_id)
ST4=$(ob_field "$G1" delivery_status)
[ "$ST4" = "queued" ] || fail "S4：限流期间 outbox 应保持 queued，实际 $ST4"
GW_GOT=$(mock_q "j.messages.filter(m=>m.clientMsgId===\"$CMID4\").length")
[ "$GW_GOT" = "0" ] || fail "S4：到期前网关不应收到该账号 send，实际 $GW_GOT 条"
log "S4：outbox=queued，网关未收到该 clientMsgId"
# 到期自动恢复 + 消息发出
DEADLINE=$((SECONDS + 15))
while [ $SECONDS -lt $DEADLINE ]; do
  ACCT_ST=$(curl -sf "$BACKEND_URL/api/accounts" -H "Authorization: Bearer $TOKEN" \
    | api_q 'j.find(a=>a.id==="acct-1").status')
  [ "$ACCT_ST" = "online" ] && break
  sleep 0.5
done
[ "$ACCT_ST" = "online" ] || fail "S4：到期后应自动恢复 online，实际 $ACCT_ST"
poll_sql_eq sent "SELECT delivery_status FROM outbox_messages WHERE group_id='$G1' AND client_msg_id='$CMID4'" 15 \
  "S4：恢复后消息已 sent"

step "S5-a：504 但消息落地 → 5 秒内 sent（不是 failed）"
gw_post /_mock/faults '{"endpoint":"send","mode":"504","count":1,"landAfterMs":120}' || fail "注入 504 失败"
T0=$SECONDS
curl -sf -X POST "$BACKEND_URL/api/groups/$G1/send" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"accountId":"acct-1","text":"s5a landed"}' >/dev/null || fail "S5a send 失败"
poll_sql_eq sent "SELECT delivery_status FROM outbox_messages WHERE group_id='$G1' ORDER BY created_at DESC LIMIT 1" 10 \
  "S5a：$((SECONDS - T0))s 内收敛为 sent"

step "S5-b：504 且未接收 → 确认后重发一次 → 网关恰好一条"
gw_post /_mock/faults '{"endpoint":"send","mode":"504","count":1,"landAfterMs":0}' || fail "注入 504 失败"
curl -sf -X POST "$BACKEND_URL/api/groups/$G1/send" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"accountId":"acct-1","text":"s5b resend once"}' >/dev/null || fail "S5b send 失败"
poll_sql_eq sent "SELECT delivery_status FROM outbox_messages WHERE group_id='$G1' ORDER BY created_at DESC LIMIT 1" 25 \
  "S5b：重发后 sent"
CMID5B=$(ob_field "$G1" client_msg_id)
GW_CNT=$(mock_q "j.messages.filter(m=>m.clientMsgId===\"$CMID5B\").length")
[ "$GW_CNT" = "1" ] || fail "S5b：网关应恰好 1 条（重发仅一次），实际 $GW_CNT"
log "S5b：网关恰好 1 条消息"

step "S5-c：504 后 by-client-id 503 → 保持 unknown；恢复后 2 秒内定态"
gw_post /_mock/faults '{"endpoint":"send","mode":"504","count":1,"landAfterMs":0}' || fail "注入 send 504 失败"
gw_post /_mock/faults '{"endpoint":"by-client-id","mode":"503","persist":true}' || fail "注入 bycid 503 失败"
curl -sf -X POST "$BACKEND_URL/api/groups/$G1/send" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"accountId":"acct-1","text":"s5c unknown holds"}' >/dev/null || fail "S5c send 失败"
sleep 4 # 给收敛 worker 足够 tick；期间 by-client-id 一直 503
ST5C=$(ob_field "$G1" delivery_status)
[ "$ST5C" = "unknown" ] || fail "S5c：by-client-id 不可用期间应保持 unknown，实际 $ST5C"
log "S5c：by-client-id 503 期间保持 unknown"
gw_post /_mock/faults '{"clear":"by-client-id"}' || fail "清除 bycid 故障失败"
T0=$SECONDS
poll_sql_eq sent "SELECT delivery_status FROM outbox_messages WHERE group_id='$G1' ORDER BY created_at DESC LIMIT 1" 15 \
  "S5c：查询恢复后 $((SECONDS - T0))s 内定态 sent"

step "S5-d：重发也 504 → failed(NETWORK_TIMEOUT)，且无第三次发送"
gw_post /_mock/faults '{"endpoint":"send","mode":"504","count":2,"landAfterMs":0}' || fail "注入双重 504 失败"
curl -sf -X POST "$BACKEND_URL/api/groups/$G1/send" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"accountId":"acct-1","text":"s5d double 504"}' >/dev/null || fail "S5d send 失败"
poll_sql_eq failed "SELECT delivery_status FROM outbox_messages WHERE group_id='$G1' ORDER BY created_at DESC LIMIT 1" 30 \
  "S5d：两次 504 后 failed"
CMID5D=$(ob_field "$G1" client_msg_id)
FAILCODE=$(ob_field "$G1" fail_code)
[ "$FAILCODE" = "NETWORK_TIMEOUT" ] || fail "S5d：failCode 应为 NETWORK_TIMEOUT，实际 $FAILCODE"
GW_CNT=$(mock_q "j.messages.filter(m=>m.clientMsgId===\"$CMID5D\").length")
[ "$GW_CNT" = "0" ] || fail "S5d：网关不应有消息，实际 $GW_CNT"
sleep 3
GW_CNT=$(mock_q "j.messages.filter(m=>m.clientMsgId===\"$CMID5D\").length")
[ "$GW_CNT" = "0" ] || fail "S5d：出现第三次发送（网关 $GW_CNT 条）"
log "S5d：failed(NETWORK_TIMEOUT)，网关 0 条，无第三次发送"

step "S5-agent：504 落地 + agent 同 idempotency_key 重试 → 恰好一条、run 正常结束"
gw_post /_mock/faults '{"endpoint":"send","mode":"504","count":1,"landAfterMs":1500}' || fail "注入 504 失败"
curl -sf -X POST "$AGENT_URL/_mock/behavior" -H 'content-type: application/json' \
  -d '{"mode":"retry_same_key"}' >/dev/null || fail "切 retry_same_key 失败"
curl -sf -X POST "$GATEWAY_URL/_mock/messages/inject" -H 'content-type: application/json' \
  -d "[{\"groupId\":\"$G2_GW\",\"senderPlatformUserId\":\"pu_ext_user\",\"text\":\"s5-agent-trigger\",\"sentAt\":\"$(now_iso)\"}]" >/dev/null
# 等新 run 出现（S2 已有 1 个，现在应变 2）
DEADLINE=$((SECONDS + 30))
RUNS=""
while [ $SECONDS -lt $DEADLINE ]; do
  RUNS=$(curl -sf "$BACKEND_URL/api/groups/$G2/agent-runs" -H "Authorization: Bearer $TOKEN" | api_q 'j.length')
  [ "$RUNS" = "2" ] && break
  sleep 0.5
done
[ "$RUNS" = "2" ] || fail "S5-agent：应触发新 run，runs=$RUNS"
RUN_ID=$(curl -sf "$BACKEND_URL/api/groups/$G2/agent-runs" -H "Authorization: Bearer $TOKEN" | api_q 'j[0].id')
# retry_same_key 会同 key 重试 2 次后正常 finish（步骤毫秒级完成，直接等终态）
DEADLINE=$((SECONDS + 45))
RUN_ST=""
while [ $SECONDS -lt $DEADLINE ]; do
  RUN_BODY=$(curl -sf "$BACKEND_URL/api/agent-runs/$RUN_ID" -H "Authorization: Bearer $TOKEN")
  RUN_ST=$(json_str "$RUN_BODY" status)
  [ "$RUN_ST" = "finished" ] && break
  [ "$RUN_ST" = "failed" ] || [ "$RUN_ST" = "blocked" ] && fail "S5-agent：run 应正常结束，实际 $RUN_ST（$RUN_BODY）"
  sleep 0.5
done
[ "$RUN_ST" = "finished" ] || fail "S5-agent：run 未正常结束（$RUN_ST）"
curl -sf -X POST "$AGENT_URL/_mock/behavior" -H 'content-type: application/json' \
  -d '{"mode":"normal"}' >/dev/null
# 步骤结构：1=get_recent，2=send(queued)，3/4=同 key 幂等重试（idempotent，不报错），5=final
NSTEPS=$(echo "$RUN_BODY" | api_q 'j.steps.length')
[ "$NSTEPS" = "5" ] || fail "S5-agent：应 5 步（get→send→重试×2→finish），实际 $NSTEPS（$RUN_BODY）"
STEP3_ERR=$(echo "$RUN_BODY" | api_q 'j.steps[2].isError')
STEP4_ERR=$(echo "$RUN_BODY" | api_q 'j.steps[3].isError')
[ "$STEP3_ERR" = "false" ] && [ "$STEP4_ERR" = "false" ] \
  || fail "S5-agent：幂等重试步应返回当前状态而非错误（isError=$STEP3_ERR/$STEP4_ERR）"
# 幂等命中应带 idempotent:true
STEP3_IDEM=$(echo "$RUN_BODY" | api_q 'j.steps[2].resultSummary.includes("idempotent")')
[ "$STEP3_IDEM" = "true" ] || fail "S5-agent：重试步应幂等命中（resultSummary 不含 idempotent）"
# 等 outbox 收敛为 sent（504 landAfter=1500ms，收敛 worker 5s 内 by-client-id 查明）
poll_sql_eq sent "SELECT delivery_status FROM outbox_messages WHERE group_id='$G2' ORDER BY created_at DESC LIMIT 1" 15 \
  "S5-agent：504 落地后应收敛 sent"
# 网关恰好一条（取本次 outbox 的 clientMsgId 对网关计数）
CMID5A=$(ob_field "$G2" client_msg_id)
GW_CNT=$(mock_q "j.messages.filter(m=>m.clientMsgId===\"$CMID5A\").length")
[ "$GW_CNT" = "1" ] || fail "S5-agent：网关应恰好 1 条，实际 $GW_CNT"
log "S5-agent：run finished（5 步），重试步幂等命中，504 落地收敛 sent，网关恰好 1 条"

echo ""
echo "============================================================"
echo "PASS: e2e S1–S5 全部通过"
echo "============================================================"
