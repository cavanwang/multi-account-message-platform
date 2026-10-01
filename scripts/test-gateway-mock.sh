#!/usr/bin/env bash
# 自测脚本：消息网关模拟器（规划 01 任务 1.10，覆盖 §5 验收点 + S1–S5 的网关侧）
#
# 验证点：
#   契约  connect 幂等 / disconnect→409 / 同 clientMsgId 不去重、by-client-id 返回最早一条
#   S1    send 202 → SSE 收到 message_sent
#   S2    duplicate-mode 每个事件推两次（eventId 相同）
#   S3    自己的消息回流：message 事件 msgId 与 message_sent 相同、sender 是自己
#   S4    429 RATE_LIMITED 带 retryAfterSeconds，窗口内重发仍 429
#   S5    504+落地 → 收敛窗内 by-client-id 有；504+不落地 → 收敛窗后仍 404
#   故障  503 注入（send / by-client-id）
#   事件  shuffle-mode 全部到达且 eventId 唯一 / replay 补投旧 sentAt 消息 /
#         break-connection 后 since 补拉 / suspend 移出群+403 / external-join 推 member_joined
#   C1    /media/:id 200 返回字节；未注册/expire 后 404
#
# 前提：docker compose 已启动（gateway-mock 健康）。
# 用法：./scripts/test-gateway-mock.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

GATEWAY_URL="${GATEWAY_URL:-http://localhost:3100}"

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

# 从扁平 JSON 里取字符串字段（与现有脚本一致的 grep/cut 风格）
json_str() { grep -o "\"$2\":\"[^\"]*\"" <<<"$1" | head -n1 | cut -d'"' -f4; }

# 只取 HTTP 状态码
http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# 通用 JSON 求值工具（/_mock/state 是嵌套结构，grep 不可靠；host 有 node——
# test-ws-reconnect.sh 同样依赖它）。从 stdin 读 JSON，argv 为以 j 为根的 JS 表达式。
STATEQ_FILE="${TMPDIR:-/tmp}/.tmp-gw-stateq-$$.mjs"
cat > "$STATEQ_FILE" <<'JS'
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const j = JSON.parse(s);
  // eslint-disable-next-line no-eval
  const v = eval(process.argv[2]);
  console.log(typeof v === 'object' ? JSON.stringify(v) : String(v));
});
JS
stateq() { curl -sf "$GATEWAY_URL/_mock/state" | node "$STATEQ_FILE" "$1"; }

# --- SSE 采样：后台 curl 落临时文件，max-time 到期自动结束 ---
SSE_DIR="${TMPDIR:-/tmp}/.tmp-gw-sse-$$"
SSE_PIDS=()
mkdir -p "$SSE_DIR"

sse_start() { # <outfile> <seconds> [since]
  local out="$1" secs="$2" since="${3:-0}"
  : > "$out"
  curl -sN --max-time "$secs" "$GATEWAY_URL/events?since=$since" >"$out" 2>/dev/null &
  SSE_PIDS+=($!)
  sleep 0.3 # 等连接建立，再触发后续动作
}
sse_wait() {
  for p in "${SSE_PIDS[@]}"; do wait "$p" 2>/dev/null || true; done
  SSE_PIDS=()
}

cleanup() {
  rm -f "$STATEQ_FILE"
  rm -rf "$SSE_DIR"
  # 恢复默认：实时时序、行为开关全关、故障清空（reset 会连带清故障与业务状态）
  curl -sf -X POST "$GATEWAY_URL/_mock/timing" -H 'content-type: application/json' \
    -d '{"profile":"real"}' >/dev/null 2>&1 || true
  curl -sf -X POST "$GATEWAY_URL/_mock/events/duplicate-mode" -H 'content-type: application/json' \
    -d '{"on":false}' >/dev/null 2>&1 || true
  curl -sf -X POST "$GATEWAY_URL/_mock/events/shuffle-mode" -H 'content-type: application/json' \
    -d '{"on":false}' >/dev/null 2>&1 || true
  curl -sf -X POST "$GATEWAY_URL/_mock/reset" -H 'content-type: application/json' \
    -d '{}' >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "步骤 0：前置检查 + 重置"
wait_http "$GATEWAY_URL/_mock/state" "gateway-mock"
curl -sf -X POST "$GATEWAY_URL/_mock/reset" -H 'content-type: application/json' \
  -d '{"resetEventCounter":true,"seedAccounts":["acct-1","acct-2"]}' >/dev/null || fail "reset 失败"
# 事件 id 归零后必须同步重置后端：否则旧高游标会跳过新事件，
# 且 events_inbox 旧行会与新事件撞 PK 被判重（后续脚本将出现 JOIN_TIMEOUT）。
# 与 test-e2e-s1-s5.sh 的重置方式保持一致。
docker exec "${DB_CONTAINER:-multi-account-message-platform-db-1}" \
  psql -U app -d app -q -c \
  "TRUNCATE events_inbox; UPDATE events_cursor SET last_seen_event_id = 0 WHERE id = 1" \
  || fail "后端事件游标/inbox 重置失败"
curl -sf -X POST "$GATEWAY_URL/_mock/timing" -H 'content-type: application/json' \
  -d '{"profile":"fast"}' >/dev/null || fail "切换 fast 时序失败"
log "已重置（eventId 归零）并切到 fast 时序"

step "步骤 1：connect 幂等 —— 同 accountId 反复 connect，platformUserId 恒等"
PU1_A=$(json_str "$(curl -sf -X POST "$GATEWAY_URL/accounts/acct-1/connect")" platformUserId)
PU1_B=$(json_str "$(curl -sf -X POST "$GATEWAY_URL/accounts/acct-1/connect")" platformUserId)
[ -n "$PU1_A" ] && [ "$PU1_A" = "$PU1_B" ] || fail "connect 不幂等：$PU1_A vs $PU1_B"
PU2=$(json_str "$(curl -sf -X POST "$GATEWAY_URL/accounts/acct-2/connect")" platformUserId)
[ -n "$PU2" ] || fail "acct-2 connect 失败"
log "acct-1 → $PU1_A（两次一致），acct-2 → $PU2"

step "步骤 2：主流程 —— 建群 → invite → join → members"
GROUP_ID=$(json_str "$(curl -sf -X POST "$GATEWAY_URL/groups" \
  -H 'content-type: application/json' -d '{"creatorAccountId":"acct-1"}')" groupId)
[ -n "$GROUP_ID" ] || fail "建群失败"
INVITE=$(curl -sf -X POST "$GATEWAY_URL/groups/$GROUP_ID/invite" \
  -H 'content-type: application/json' -d '{"readyAfterMs":0}')
INVITE_LINK=$(json_str "$INVITE" inviteLink)
[ -n "$INVITE_LINK" ] || fail "申请邀请链接失败"
JOIN_CODE=$(http_code -X POST "$GATEWAY_URL/groups/$GROUP_ID/join" \
  -H 'content-type: application/json' -d "{\"accountId\":\"acct-2\",\"inviteLink\":\"$INVITE_LINK\"}")
[ "$JOIN_CODE" = "202" ] || fail "join 应返回 202，实际 $JOIN_CODE"
sleep 0.5 # fast 时序 join 落地 1–20ms
MEMBER_COUNT=$(stateq "j.groups.find(g=>g.groupId===\"$GROUP_ID\").members.length")
[ "$MEMBER_COUNT" = "2" ] || fail "members 应为 2，实际 $MEMBER_COUNT"
log "群 $GROUP_ID 成员 2 人（creator + acct-2）"

step "步骤 3：S1 + S3 —— send 202 → message_sent；message 回流 msgId 相同、sender 是自己"
F="$SSE_DIR/s1.log"
sse_start "$F" 1.5
CODE=$(http_code -X POST "$GATEWAY_URL/groups/$GROUP_ID/send" \
  -H 'content-type: application/json' \
  -d '{"accountId":"acct-1","clientMsgId":"c1","text":"hello s1"}')
sse_wait
[ "$CODE" = "202" ] || fail "send 应返回 202，实际 $CODE"
SENT_LINE=$(grep '^data: ' "$F" | grep '"type":"message_sent"' | grep '"clientMsgId":"c1"' || true)
[ -n "$SENT_LINE" ] || fail "SSE 未收到 message_sent"
MSG_ID=$(json_str "$SENT_LINE" msgId)
MSG_LINE=$(grep '^data: ' "$F" | grep '"type":"message"' | grep "\"msgId\":\"$MSG_ID\"" || true)
[ -n "$MSG_LINE" ] || fail "SSE 未收到回流的 message（msgId=$MSG_ID）"
MSG_SENDER=$(json_str "$MSG_LINE" senderPlatformUserId)
[ "$MSG_SENDER" = "$PU1_A" ] || fail "message sender 应是自己 $PU1_A，实际 $MSG_SENDER"
log "message_sent 与 message 回流 msgId 均为 $MSG_ID，sender=$MSG_SENDER"

step "步骤 4：不去重 —— 同 clientMsgId 再发一次，by-client-id 返回最早一条"
CODE=$(http_code -X POST "$GATEWAY_URL/groups/$GROUP_ID/send" \
  -H 'content-type: application/json' \
  -d '{"accountId":"acct-1","clientMsgId":"c1","text":"hello s1 dup"}')
[ "$CODE" = "202" ] || fail "第二次 send 应返回 202，实际 $CODE"
sleep 0.5
DUP_COUNT=$(stateq "j.messages.filter(m=>m.clientMsgId===\"c1\").length")
[ "$DUP_COUNT" = "2" ] || fail "同 clientMsgId 应落地 2 条，实际 $DUP_COUNT"
BYC=$(curl -sf "$GATEWAY_URL/groups/$GROUP_ID/messages/by-client-id/c1")
BYC_MSG_ID=$(json_str "$BYC" msgId)
[ "$BYC_MSG_ID" = "$MSG_ID" ] || fail "by-client-id 应返回最早一条 $MSG_ID，实际 $BYC_MSG_ID"
log "clientMsgId=c1 共 2 条，by-client-id 返回最早一条 $BYC_MSG_ID"

step "步骤 5：disconnect 后 send → 409 ACCOUNT_OFFLINE"
curl -sf -X POST "$GATEWAY_URL/accounts/acct-2/disconnect" >/dev/null
CODE=$(http_code -X POST "$GATEWAY_URL/groups/$GROUP_ID/send" \
  -H 'content-type: application/json' \
  -d '{"accountId":"acct-2","clientMsgId":"c-off","text":"x"}')
[ "$CODE" = "409" ] || fail "离线 send 应返回 409，实际 $CODE"
curl -sf -X POST "$GATEWAY_URL/accounts/acct-2/connect" >/dev/null
log "离线 send 返回 409；acct-2 已重连"

step "步骤 6：S4 —— 429 RATE_LIMITED 带 retryAfterSeconds，窗口内重发仍 429"
curl -sf -X POST "$GATEWAY_URL/_mock/accounts/acct-2/rate-limit" \
  -H 'content-type: application/json' -d '{"retryAfterSeconds":5}' >/dev/null
R1=$(curl -s -X POST "$GATEWAY_URL/groups/$GROUP_ID/send" \
  -H 'content-type: application/json' \
  -d '{"accountId":"acct-2","clientMsgId":"c-rl1","text":"x"}')
grep -q 'RATE_LIMITED' <<<"$R1" || fail "限流 send 应返回 RATE_LIMITED，实际 $R1"
grep -q 'retryAfterSeconds' <<<"$R1" || fail "429 响应应带 retryAfterSeconds，实际 $R1"
R2=$(curl -s -X POST "$GATEWAY_URL/groups/$GROUP_ID/send" \
  -H 'content-type: application/json' \
  -d '{"accountId":"acct-2","clientMsgId":"c-rl2","text":"x"}')
grep -q 'RATE_LIMITED' <<<"$R2" || fail "窗口内重发应仍 429，实际 $R2"
curl -sf -X POST "$GATEWAY_URL/_mock/accounts/acct-2/clear-rate-limit" \
  -H 'content-type: application/json' -d '{}' >/dev/null
log "两次 send 均 429 RATE_LIMITED；已解除限流"

step "步骤 7：503 故障注入 —— send 与 by-client-id"
curl -sf -X POST "$GATEWAY_URL/_mock/faults" -H 'content-type: application/json' \
  -d '{"endpoint":"send","mode":"503","persist":true}' >/dev/null
CODE=$(http_code -X POST "$GATEWAY_URL/groups/$GROUP_ID/send" \
  -H 'content-type: application/json' \
  -d '{"accountId":"acct-1","clientMsgId":"c-503","text":"x"}')
[ "$CODE" = "503" ] || fail "send 应返回 503，实际 $CODE"
curl -sf -X POST "$GATEWAY_URL/_mock/faults" -H 'content-type: application/json' \
  -d '{"endpoint":"by-client-id","mode":"503","persist":true}' >/dev/null
CODE=$(http_code "$GATEWAY_URL/groups/$GROUP_ID/messages/by-client-id/c1")
[ "$CODE" = "503" ] || fail "by-client-id 应返回 503，实际 $CODE"
curl -sf -X POST "$GATEWAY_URL/_mock/faults" -H 'content-type: application/json' \
  -d '{"clearAll":true}' >/dev/null
CODE=$(http_code "$GATEWAY_URL/groups/$GROUP_ID/messages/by-client-id/c1")
[ "$CODE" = "200" ] || fail "故障清除后 by-client-id 应恢复 200，实际 $CODE"
log "send/by-client-id 503 注入与恢复均正确"

step "步骤 8：S5（前半）—— 504 但消息落地 → 收敛窗内 by-client-id 有"
curl -sf -X POST "$GATEWAY_URL/_mock/faults" -H 'content-type: application/json' \
  -d '{"endpoint":"send","mode":"504","count":1,"landAfterMs":120}' >/dev/null
CODE=$(http_code -X POST "$GATEWAY_URL/groups/$GROUP_ID/send" \
  -H 'content-type: application/json' \
  -d '{"accountId":"acct-1","clientMsgId":"c-504a","text":"landed"}')
[ "$CODE" = "504" ] || fail "send 应返回 504，实际 $CODE"
sleep 0.6 # fast 收敛窗 120ms，0.6s 足够落地
CODE=$(http_code "$GATEWAY_URL/groups/$GROUP_ID/messages/by-client-id/c-504a")
[ "$CODE" = "200" ] || fail "504 落地后 by-client-id 应 200，实际 $CODE"
log "504 → 消息已落地，by-client-id 200"

step "步骤 9：S5（后半）—— 504 且未接收 → 收敛窗后 by-client-id 仍 404"
curl -sf -X POST "$GATEWAY_URL/_mock/faults" -H 'content-type: application/json' \
  -d '{"endpoint":"send","mode":"504","count":1,"landAfterMs":0}' >/dev/null
CODE=$(http_code -X POST "$GATEWAY_URL/groups/$GROUP_ID/send" \
  -H 'content-type: application/json' \
  -d '{"accountId":"acct-1","clientMsgId":"c-504b","text":"not landed"}')
[ "$CODE" = "504" ] || fail "send 应返回 504，实际 $CODE"
sleep 0.6
CODE=$(http_code "$GATEWAY_URL/groups/$GROUP_ID/messages/by-client-id/c-504b")
[ "$CODE" = "404" ] || fail "504 未落地 by-client-id 应 404，实际 $CODE"
log "504 → 消息未落地，by-client-id 持续 404"

step "步骤 10：S2 —— duplicate-mode 每个事件推两次（eventId 相同）"
curl -sf -X POST "$GATEWAY_URL/_mock/events/duplicate-mode" \
  -H 'content-type: application/json' -d '{"on":true}' >/dev/null
F="$SSE_DIR/dup.log"
sse_start "$F" 1.5
curl -sf -X POST "$GATEWAY_URL/_mock/messages/inject" -H 'content-type: application/json' \
  -d "[{\"groupId\":\"$GROUP_ID\",\"senderPlatformUserId\":\"$PU2\",\"text\":\"dup-mark\"}]" >/dev/null
sse_wait
curl -sf -X POST "$GATEWAY_URL/_mock/events/duplicate-mode" \
  -H 'content-type: application/json' -d '{"on":false}' >/dev/null
mapfile -t DUP_IDS < <(grep '^data: ' "$F" | grep '"type":"message"' | grep 'dup-mark' \
  | grep -o '"eventId":[0-9]*' | cut -d: -f2)
[ "${#DUP_IDS[@]}" = "2" ] || fail "duplicate-mode 下应收到 2 条相同事件，实际 ${#DUP_IDS[@]} 条"
[ "${DUP_IDS[0]}" = "${DUP_IDS[1]}" ] || fail "两条推送 eventId 应相同：${DUP_IDS[*]}"
log "同一事件（eventId=${DUP_IDS[0]}）被推送两次"

step "步骤 11：shuffle-mode —— 窗口内事件全部到达且 eventId 唯一"
curl -sf -X POST "$GATEWAY_URL/_mock/events/shuffle-mode" \
  -H 'content-type: application/json' -d '{"on":true}' >/dev/null
F="$SSE_DIR/shuffle.log"
sse_start "$F" 1.5
for i in 1 2 3; do
  curl -sf -X POST "$GATEWAY_URL/_mock/messages/inject" -H 'content-type: application/json' \
    -d "[{\"groupId\":\"$GROUP_ID\",\"senderPlatformUserId\":\"$PU2\",\"text\":\"shuffle-$i\"}]" >/dev/null
done
sse_wait
curl -sf -X POST "$GATEWAY_URL/_mock/events/shuffle-mode" \
  -H 'content-type: application/json' -d '{"on":false}' >/dev/null
# 乱序不改变 eventId 的分配（仍单调分配），只打乱推送时刻——断言到达完整且唯一即可，
# 不断言"必须乱序"（是否发生乱序是概率性的，断言了会 flaky）。
SHUF_COUNT=$(grep '^data: ' "$F" | grep '"type":"message"' | grep -c 'shuffle-' || true)
[ "$SHUF_COUNT" = "3" ] || fail "shuffle-mode 下应收到 3 条，实际 $SHUF_COUNT"
SHUF_UNIQUE=$(grep '^data: ' "$F" | grep 'shuffle-' | grep -o '"eventId":[0-9]*' | sort -u | wc -l)
[ "$SHUF_UNIQUE" = "3" ] || fail "shuffle 事件 eventId 应唯一"
log "3 条事件全部到达，eventId 唯一"

step "步骤 12：replay —— 带旧 sentAt 的消息也能补投"
LAST_ID=$(stateq "j.lastEventId")
REPLAY_ID=$((LAST_ID + 1))
curl -sf -X POST "$GATEWAY_URL/_mock/messages/inject" -H 'content-type: application/json' \
  -d "[{\"groupId\":\"$GROUP_ID\",\"senderPlatformUserId\":\"$PU2\",\"text\":\"replay-mark\",\"sentAt\":\"2026-01-01T00:00:00.000Z\"}]" >/dev/null
F="$SSE_DIR/replay.log"
sse_start "$F" 1.5
curl -sf -X POST "$GATEWAY_URL/_mock/events/replay" -H 'content-type: application/json' \
  -d "{\"fromEventId\":$REPLAY_ID,\"count\":1}" >/dev/null
sse_wait
REPLAY_COUNT=$(grep '^data: ' "$F" | grep -c "\"eventId\":$REPLAY_ID" || true)
[ "$REPLAY_COUNT" = "2" ] || fail "eventId=$REPLAY_ID 应出现 2 次（原始+重推），实际 $REPLAY_COUNT"
log "eventId=$REPLAY_ID 原始推送 + replay 重推各一次"

step "步骤 13：break-connection 后带 since 重连 —— 补齐断流期间事件"
LAST_ID=$(stateq "j.lastEventId")
curl -sf -X POST "$GATEWAY_URL/_mock/events/break-connection" \
  -H 'content-type: application/json' -d '{}' >/dev/null
for i in 1 2; do
  curl -sf -X POST "$GATEWAY_URL/_mock/messages/inject" -H 'content-type: application/json' \
    -d "[{\"groupId\":\"$GROUP_ID\",\"senderPlatformUserId\":\"$PU2\",\"text\":\"gap-$i\"}]" >/dev/null
done
F="$SSE_DIR/since.log"
sse_start "$F" 1.5 "$LAST_ID"
sse_wait
GAP_COUNT=$(grep -c '^data: ' "$F" || true)
[ "$GAP_COUNT" = "2" ] || fail "since=$LAST_ID 应恰好补 2 条，实际 $GAP_COUNT"
grep -q "eventId\":$((LAST_ID + 1))" "$F" || fail "缺少 eventId=$((LAST_ID + 1))"
grep -q "eventId\":$((LAST_ID + 2))" "$F" || fail "缺少 eventId=$((LAST_ID + 2))"
log "断流期间 2 条事件经 since=$LAST_ID 补齐"

step "步骤 14：suspend —— 移出所有群、推 member_left、后续请求 403"
F="$SSE_DIR/suspend.log"
sse_start "$F" 1.5
curl -sf -X POST "$GATEWAY_URL/_mock/accounts/acct-1/suspend" \
  -H 'content-type: application/json' -d '{}' >/dev/null
sse_wait
grep '^data: ' "$F" | grep -q '"type":"member_left"' || fail "suspend 应推 member_left"
grep '^data: ' "$F" | grep '"type":"member_left"' | grep -q "$PU1_A" \
  || fail "member_left 应携带被 suspend 的 $PU1_A"
MEMBER_COUNT=$(stateq "j.groups.find(g=>g.groupId===\"$GROUP_ID\").members.length")
[ "$MEMBER_COUNT" = "1" ] || fail "suspend 后 members 应只剩 1 人，实际 $MEMBER_COUNT"
CODE=$(http_code -X POST "$GATEWAY_URL/accounts/acct-1/connect")
[ "$CODE" = "403" ] || fail "suspend 后 connect 应 403，实际 $CODE"
CODE=$(http_code -X POST "$GATEWAY_URL/groups/$GROUP_ID/send" \
  -H 'content-type: application/json' \
  -d '{"accountId":"acct-1","clientMsgId":"c-sus","text":"x"}')
[ "$CODE" = "403" ] || fail "suspend 后 send 应 403，实际 $CODE"
log "acct-1 被移出群（推 member_left），后续请求均 403 ACCOUNT_SUSPENDED"

step "步骤 15：external-join —— 外部用户进群推 member_joined"
F="$SSE_DIR/extjoin.log"
sse_start "$F" 1.5
curl -sf -X POST "$GATEWAY_URL/_mock/groups/$GROUP_ID/external-join" \
  -H 'content-type: application/json' -d '{"platformUserId":"pu_ext_user"}' >/dev/null
sse_wait
grep '^data: ' "$F" | grep '"type":"member_joined"' | grep -q 'pu_ext_user' \
  || fail "external-join 应推 member_joined(pu_ext_user)"
HAS_EXT=$(stateq "j.groups.find(g=>g.groupId===\"$GROUP_ID\").members.some(m=>m.platformUserId===\"pu_ext_user\")")
[ "$HAS_EXT" = "true" ] || fail "members 应包含 pu_ext_user"
log "外部用户 pu_ext_user 进群，member_joined 已推送"

step "步骤 16：C1 媒体契约 —— GET /media/:id 字节下载；未注册/过期 404"
# 注册自定义内容
curl -sf -X POST "$GATEWAY_URL/_mock/media" -H 'content-type: application/json' \
  -d '{"id":"tmedia-1","contentType":"text/plain","content":"media-body-123"}' >/dev/null
CODE=$(http_code "$GATEWAY_URL/media/tmedia-1")
[ "$CODE" = "200" ] || fail "已注册媒体应 200，实际 $CODE"
BODY=$(curl -sf "$GATEWAY_URL/media/tmedia-1")
[ "$BODY" = "media-body-123" ] || fail "媒体内容应为 media-body-123，实际 $BODY"
CODE=$(http_code "$GATEWAY_URL/media/never-registered-id")
[ "$CODE" = "404" ] || fail "未注册媒体应 404，实际 $CODE"
# 标记过期 → 404
EXPIRED=$(curl -sf -X POST "$GATEWAY_URL/_mock/media/tmedia-1/expire")
grep -q '"ok":true' <<<"$EXPIRED" || fail "expire 应返回 ok:true，实际 $EXPIRED"
CODE=$(http_code "$GATEWAY_URL/media/tmedia-1")
[ "$CODE" = "404" ] || fail "过期媒体应 404，实际 $CODE"
log "媒体下载 200/内容正确；未注册与过期均 404"

echo ""
echo "============================================================"
echo "PASS: 网关模拟器自测全部通过（契约 + S1–S5 网关侧 + 故障/事件 + C1 媒体）"
echo "============================================================"
