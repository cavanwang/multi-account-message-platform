#!/usr/bin/env bash
# 集成测试：WebSocket 断线补齐（B4 页面 4–5 / §2.3、§4.2 INV-10）
#
# 验证点：
#   1. 客户端断开期间产生的事件，重连带 sinceSeq 后能补发
#   2. 缺口事件在 auth 成功后 3 秒内到达
#   3. 补发的事件 seq 全部严格大于 sinceSeq（不会重放旧事件）
#   4. 收到的所有帧 seq 唯一、无重复（补发与实时推送不重样）
#
# 与 scripts/test-event-recovery.sh 的分工：
#   那个脚本验证事件消费侧（events_inbox 停机补偿）；
#   本脚本验证前端推送侧（web_events → WS sinceSeq 补发）。
#
# 前提：docker compose 已启动（db / backend 健康）。
# 用法：./scripts/test-ws-reconnect.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"
WS_URL="${WS_URL:-ws://localhost:3000/ws}"
DB_CONTAINER="${DB_CONTAINER:-multi-account-message-platform-db-1}"
# 复用根 node_modules 中 hoisted 的 ws（@fastify/websocket 的传递依赖）。
# ESM 动态 import CJS 包不支持目录导入，需显式指到 index.js
WS_MODULE="$PROJECT_ROOT/node_modules/ws/index.js"
EVENT_TYPE="reconnect_selftest"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

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

[ -f "$WS_MODULE" ] || fail "未找到 ws 模块：$WS_MODULE（请先在项目根 npm install）"

log "=== 步骤 0：前置检查 ==="
wait_http "$BACKEND_URL/api/health" "backend"

# 清掉历史自测事件，避免干扰
psql_exec "DELETE FROM web_events WHERE type='$EVENT_TYPE'" >/dev/null

log "=== 步骤 1：登录拿 access token ==="
LOGIN_JSON=$(curl -sf -X POST "$BACKEND_URL/api/auth/login" \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin"}')
TOKEN=$(printf '%s' "$LOGIN_JSON" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
[ -n "$TOKEN" ] || fail "登录未返回 accessToken"

# node 内联客户端：
#   drain <token>                —— 排空当前积压，stdout 输出已见最大 seq
#   replay <token> <since> <csv> —— 带 sinceSeq 重连，断言缺口事件 3s 内补齐
CLIENT_FILE="${TMPDIR:-/tmp}/.tmp-ws-client-$$.mjs"
cat > "$CLIENT_FILE" <<'JS'
// ws 是 CJS 包，动态 import 拿 default 构造器
const WebSocket = (await import(process.argv[2])).default;
const mode = process.argv[3];
const url = process.argv[4];
const token = process.argv[5];

/** 建立连接并发 auth 帧；auth 成功后 resolve（含 auth 成功时刻与帧列表）。 */
function connect(sinceSeq) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames = [];
    let authed = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('auth 超时'));
    }, 5000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', accessToken: token, sinceSeq }));
    });
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'auth') {
        clearTimeout(timer);
        if (!frame.success) {
          ws.close();
          reject(new Error('auth 被服务端拒绝'));
          return;
        }
        authed = true;
        resolve({ ws, frames, authedAt: Date.now() });
        return;
      }
      if (authed && typeof frame.seq === 'number') {
        frames.push({ ...frame, receivedAt: Date.now() });
      }
    });
    ws.on('error', reject);
  });
}

if (mode === 'drain') {
  const { ws, frames } = await connect(0);
  // 收 1.5s 历史补发，确定"断线前已见"的最大 seq
  await new Promise((r) => setTimeout(r, 1500));
  ws.close();
  console.log(frames.reduce((m, f) => Math.max(m, f.seq), 0));
} else if (mode === 'replay') {
  const sinceSeq = Number(process.argv[6]);
  const expected = process.argv[7].split(',').filter(Boolean).map(Number);
  const { ws, frames, authedAt } = await connect(sinceSeq);

  // 从 auth 成功起最多等 3s（验收门槛）
  const deadline = authedAt + 3000;
  while (Date.now() < deadline) {
    if (expected.every((s) => frames.some((f) => f.seq === s))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  ws.close();

  const errors = [];
  const got = frames.filter((f) => expected.includes(f.seq));
  for (const s of expected) {
    if (!got.some((f) => f.seq === s)) errors.push(`缺口 seq=${s} 未在 3s 内补发`);
  }
  // 不能重放旧事件
  const stale = frames.filter((f) => f.seq <= sinceSeq);
  if (stale.length > 0) errors.push(`收到 ${stale.length} 条 seq<=sinceSeq 的旧事件`);
  // 所有帧 seq 唯一（补发与实时推送交叠时也不能重复）
  if (new Set(frames.map((f) => f.seq)).size !== frames.length) {
    errors.push('收到重复 seq 的帧');
  }
  const gapMs = got.reduce((m, f) => Math.max(m, f.receivedAt - authedAt), 0);

  if (errors.length > 0) {
    console.error(JSON.stringify({ errors, replayed: got.map((f) => f.seq).sort((a, b) => a - b) }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ replayed: got.map((f) => f.seq).sort((a, b) => a - b), gapMs, totalFrames: frames.length }));
} else {
  console.error(`未知模式: ${mode}`);
  process.exit(2);
}
JS

cleanup() {
  rm -f "$CLIENT_FILE"
  psql_exec "DELETE FROM web_events WHERE type='$EVENT_TYPE'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "=== 步骤 2：首连排空历史积压 ==="
MAX_SEQ=$(node "$CLIENT_FILE" "$WS_MODULE" drain "$WS_URL" "$TOKEN")
log "客户端断线前已见最大 seq=$MAX_SEQ"

log "=== 步骤 3：模拟断线期间产生 3 条事件（直接写 web_events）==="
SEQ_LIST=""
for i in 1 2 3; do
  S=$(psql_exec "INSERT INTO web_events (type, payload) VALUES ('$EVENT_TYPE', '{\"n\":$i,\"groupId\":\"__reconnect_selftest__\"}'::jsonb) RETURNING seq" | head -n1)
  SEQ_LIST="${SEQ_LIST}${SEQ_LIST:+,}$S"
done
log "断线期间新事件 seq=$SEQ_LIST"

log "=== 步骤 4：重连带 sinceSeq=$MAX_SEQ，验证补齐 ==="
RESULT=$(node "$CLIENT_FILE" "$WS_MODULE" replay "$WS_URL" "$TOKEN" "$MAX_SEQ" "$SEQ_LIST")
log "补发结果：$RESULT"

echo ""
echo "============================================================"
echo "PASS: 断线期间 3 条事件重连后 3 秒内补齐，无旧事件、无重复"
echo "============================================================"
