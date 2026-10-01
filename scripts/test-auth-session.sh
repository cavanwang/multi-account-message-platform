#!/usr/bin/env bash
# 认证会话安全测试（B3，切片 5）。
#
# 验证（docs/examination_project.md A3 + 规划 05 §4）：
#   1. 登录 → access token 可用 + HttpOnly refresh cookie 下发（不在响应体）
#   2. refresh 轮换：新 access 可用；旧 access 立即失效（旧 session 已吊销）
#   3. 复用已换出的 refresh → 401，且当前 access / refresh 全部作废
#   4. logout → 204，access 立即失效；重复 logout 幂等 204
#   5. 无 cookie refresh → 401；错误口令 → 401
#
# 前提：docker compose up -d。用法：./scripts/test-auth-session.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo ""; log "=== $* ==="; }

http_code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }

# 从 cookie jar 提取 refresh_token（Netscape 格式第 7 列）
jar_token() { awk '/refresh_token/{print $7}' "$1"; }

# 登录并返回 accessToken（cookie 写入指定 jar）
do_login() { # <jarFile>
  curl -s -c "$1" -X POST "$BACKEND_URL/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"admin"}' \
    | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4
}

# access token 访问受保护端点的状态码
access_code() { http_code "$BACKEND_URL/api/accounts" -H "Authorization: Bearer $1"; }

JAR1="$WORKDIR/cj1.txt"
JAR2="$WORKDIR/cj2.txt"

# ============================================================
step "1/5 登录"
BODY=$(curl -s -c "$JAR1" -X POST "$BACKEND_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}')
A1=$(grep -o '"accessToken":"[^"]*"' <<<"$BODY" | cut -d'"' -f4)
[ -n "$A1" ] || fail "登录未返回 accessToken：$BODY"
# refresh 只走 cookie：响应体不得包含
grep -q 'refresh' <<<"$BODY" && fail "响应体泄露了 refresh 相关字段：$BODY"
R1=$(jar_token "$JAR1")
[ -n "$R1" ] || fail "未下发 refresh_token cookie"
log "access token + HttpOnly refresh cookie 下发，响应体无 refresh"

[ "$(access_code "$A1")" = "200" ] || fail "新 access token 应可访问"
log "access token 200"

# 错误口令
[ "$(http_code -X POST "$BACKEND_URL/api/auth/login" -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"bad"}')" = "401" ] || fail "错误口令应 401"
log "错误口令 401"

# ============================================================
step "2/5 refresh 轮换"
RBODY=$(curl -s -b "$JAR1" -c "$JAR1" -X POST "$BACKEND_URL/api/auth/refresh")
A2=$(grep -o '"accessToken":"[^"]*"' <<<"$RBODY" | cut -d'"' -f4)
[ -n "$A2" ] || fail "refresh 未返回 accessToken：$RBODY"
[ "$A1" != "$A2" ] || fail "轮换后 access token 未变化"
R2=$(jar_token "$JAR1")
[ -n "$R2" ] && [ "$R1" != "$R2" ] || fail "refresh cookie 未轮换"
log "access / refresh 均已轮换"

# 旧 access（sid 指向旧 session）立即失效
[ "$(access_code "$A1")" = "401" ] || fail "轮换后旧 access token 应立即 401"
log "旧 access token 401"
# 新 access 可用
[ "$(access_code "$A2")" = "200" ] || fail "新 access token 应 200"
log "新 access token 200"

# ============================================================
step "3/5 复用已换出的 refresh → 全会话作废"
# 手工构造 cookie 重放 R1（R1 已被轮换吊销）
[ "$(http_code -X POST "$BACKEND_URL/api/auth/refresh" -H "Cookie: refresh_token=$R1")" = "401" ] \
  || fail "复用旧 refresh 应 401"
log "复用旧 refresh 401"
# 当前 access 立即失效
[ "$(access_code "$A2")" = "401" ] || fail "复用后当前 access 应已作废"
log "当前 access 已作废"
# 当前 refresh（R2）同样失效
[ "$(http_code -b "$JAR1" -X POST "$BACKEND_URL/api/auth/refresh")" = "401" ] \
  || fail "复用后当前 refresh 应已作废"
log "当前 refresh 已作废"

# ============================================================
step "4/5 logout"
A3=$(do_login "$JAR2")
[ "$(access_code "$A3")" = "200" ] || fail "重新登录的 access 应可用"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR2" -X POST "$BACKEND_URL/api/auth/logout")
[ "$CODE" = "204" ] || fail "logout 应 204，实际 $CODE"
log "logout 204"
[ "$(access_code "$A3")" = "401" ] || fail "logout 后 access 应立即 401"
log "access 立即失效"
# 重复 logout：幂等
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR2" -X POST "$BACKEND_URL/api/auth/logout")
[ "$CODE" = "204" ] || fail "重复 logout 应幂等 204，实际 $CODE"
log "重复 logout 幂等 204"

# ============================================================
step "5/5 异常请求"
[ "$(http_code -X POST "$BACKEND_URL/api/auth/refresh")" = "401" ] \
  || fail "无 cookie refresh 应 401"
log "无 cookie refresh 401"

echo ""
echo "============================================================"
echo "PASS: 认证会话安全全部通过——轮换 / 复用作废 / logout / 异常请求"
echo "============================================================"
