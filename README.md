# 多账号群组消息平台

全栈开发工程师笔试题实现。平台代管若干服务账号、管理若干群、把群消息记成可靠时间线、按定时序列以指定角色发消息，并接入一个只能通过工具调用的 Agent。

- 权威需求：`docs/examination_project.md`
- 需求梳理：`docs/requirements.md`
- 实现规划：`docs/plan/`（切片 0–5 各一份说明文档）

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Node.js 22 + TypeScript（strict）+ Fastify |
| 数据库 | PostgreSQL 16（裸 SQL + `pg`，SQL migration 管理） |
| 前端 | React 18 + TypeScript + Vite（nginx 伺服 + 反代 /api、/ws） |
| 部署 | docker-compose 一键启动 |

## 架构设计

### 总览

```
                         浏览器控制台 (React 18 + Vite)
                                   │  REST (/api) ＋ WebSocket (/ws)
                         Fastify HTTP 层（路由 / 鉴权 / 统一错误契约）
                                   │
        ┌──────────────────────────┴───────────────────────────┐
        │                    services 编排层                    │
        │   事务边界 · 状态机推进 · 外部调用 · Agent 主循环      │
        └──────────────────────────┬───────────────────────────┘
                                   │ （SQL 只出现在这一层之下）
                              repos 仓储层
                                   │
                            PostgreSQL 16  ◄──── 唯一事实来源 / 并发协调点
                                   ▲
   10 个后台 workers（轮询 DB，状态全程持久化，崩溃后从 DB 恢复）：
     event-consumer · outbox-sender · reconcile-504 · rate-limit-sweeper
     group-job · leave-all-job · agent-runner-worker · sequence-runner-worker
     ws-publisher · media-cleaner
                                   │
              消息网关模拟器 (HTTP+SSE)    Agent 服务模拟器 (tool-use 协议)
```

**核心架构取舍**

- **单进程单体**：HTTP 服务与全部 worker 同进程协作，通过数据库传递状态，无内存队列作为可靠性依赖。
- **PostgreSQL 既是唯一事实来源，也是多实例协调点**：多实例并发不靠分布式锁服务，而用数据库原语——
  partial unique index（互斥）、`pg_advisory_lock`（临界区）、`FOR UPDATE SKIP LOCKED`（工作认领）、聚合根 `version`（CAS 乐观锁）。
- **一切异步状态持久化**：worker 只做「读 DB → 推进一小步 → 写 DB」，无内存定时器作为崩溃恢复依据；
  进程任意时刻重启，均从数据库重建现场（题面总则：任意重启前后行为都成立）。
- **严格分层**：`domain/`（纯业务逻辑，如 6×6 状态转移表，无 IO）→ `repos/`（SQL 唯一出处）→
  `services/`（事务与编排）→ `http/`（路由/鉴权）→ `workers/`（后台循环）。

### 核心事务一致性处理

**1. 出站：事务性发件箱（Transactional Outbox）**
消息受理时先在事务内写 `outbox_messages`（`client_msg_id` 由后端生成 UUID，先于任何 HTTP 调用持久化），
再由 `OutboxSender` 用 `FOR UPDATE SKIP LOCKED` 短事务认领、调网关，按响应以 CAS 推进状态。
因此不可能出现「网关已发出而库里无记录」，也不可能「一行记录对应网关多条消息」。
见 [outbox-sender.ts](file:///home/ubuntu/multi-account-message-platform/backend/src/workers/outbox-sender.ts)。

**2. 504 未知态收敛**
收到 504 时，同一事务内置 `delivery_status='unknown'` 并写入 `pending_reconciliations`（持久化定时任务，而非内存定时器）。
收敛 worker 到期用 by-client-id 查询：已落地 → 回填 `accepted`；确认未发出 → `prepareResend` 先 CAS 落库
（`resend_count+1`/`generation+1`）再用同一 `clientMsgId` 重发，**至多重发一次**；查询不可用保持 `unknown` 退避重试。
从收到 504 起 5 秒内必为 `accepted`/`sent`/`failed` 之一。见
[reconcile-504.ts](file:///home/ubuntu/multi-account-message-platform/backend/src/workers/reconcile-504.ts)。

**3. 入站：收件箱 + 游标（Inbox Pattern）**
SSE 每一帧在同一事务内 `INSERT events_inbox ON CONFLICT DO NOTHING`（eventId 主键去重）并推进 `events_cursor`。
独立的消费循环逐条在独立事务内 dispatch，成功才置 `processed_at`；失败则 `attempts+1`、记录 `last_error`
并入队 `inconsistency` 前端事件，**不中断后续事件**。断流/停机期间的事件靠 SSE 独占语义
（`since=last_seen_event_id`）重连补拉，不会遗漏。见
[event-consumer.ts](file:///home/ubuntu/multi-account-message-platform/backend/src/workers/event-consumer.ts)。

**4. 账号终态原子后果**
进入 `suspended`/`session_expired` 时，`markTerminal` 用单个事务完成「CAS 进终态 → 移出所有群 →
排队中发送置 `cancelled`(failCode=ACCOUNT_TERMINAL) → 对应序列步骤置 `skipped` → 入队 `account_terminal` 事件」，
要么全部生效要么全部不生效；发送错误、网关事件、操作员标记、Agent 四种来源共用同一函数。
群不可写（`GROUP_WRITE_FORBIDDEN`）同理：群置 `unreachable`、停运行中序列、消息置 failed 也在同事务原子完成。见
[account-terminal.ts](file:///home/ubuntu/multi-account-message-platform/backend/src/services/account-terminal.ts)。

**5. 前端事件事务化（INV-5）**
所有面向前端的通知写入 `web_events`（BIGSERIAL 全局单调 seq），且必须在**业务事务内**插入——
因此推给前端的状态事件必定对应已提交的状态，不会推送幻觉状态。`WsPublisher` 轮询该表广播并推进推送游标；
客户端断线重连带 `sinceSeq` 直接从库补发，断线期间事件不丢不重。见
[web-events.ts](file:///home/ubuntu/multi-account-message-platform/backend/src/repos/web-events.ts)。

**6. Agent 崩溃恢复与幂等**
Agent 的对话块（`agent_run_messages`）、每一步（`agent_steps`）、工具调用记录（`agent_tool_calls`）全程持久化。
重启续跑时重建对话历史，并检查末尾是否有未配对的 assistant tool_use：按工具调用状态判定——
`executed` → 查 outbox 回填结果；`pending_execution` 且 outbox 已存在 → 补标记后回填；无记录 → 才重放执行。
**已对外生效的调用绝不重放**。同一 run 内相同 `idempotency_key` 的 send_message 二次调用直接返回该消息当前状态，
不再审计、不再发送。见
[agent-runner.ts](file:///home/ubuntu/multi-account-message-platform/backend/src/services/agent-runner.ts)。

**7. 多实例并发控制（数据库原语）**

| 机制 | 用途 |
|---|---|
| partial unique index `... WHERE status='running'` | 同一群至多一个 running 的 agent run / 序列 run，DB 级兜底 |
| `pg_try_advisory_lock(hashtext(id))` | 建群 job、序列 run 等 worker 临界区互斥，拿不到锁即跳过 |
| `FOR UPDATE SKIP LOCKED` | outbox 消息的多实例工作认领 |
| 聚合根 `version` + CAS UPDATE | accounts/groups/outbox/run 的并发变更，后写不覆盖先写，冲突方可重试或跳过 |

### 需求关注点实现对照

题面 `docs/examination_project.md` 的关键关注点及其落点：

| 关注点 | 实现方式 |
|---|---|
| A0 迁移可重复 / schema 门禁 | 自研迁移框架：单事务 + advisory lock 串行化；启动只校验不执行 DDL，版本不一致拒绝启动 |
| A0 错误契约 / viewer 只读 | 统一 `{error:{code,message,requestId}}`；RBAC 钩子在路由层拦截，viewer 写操作一律 403 |
| A1 账号状态机 | 6×6 转移表在 `domain/account-fsm.ts` 纯枚举（单测全表覆盖）；手动转移 `expectedFrom` CAS，冲突返 409 |
| A1 限流自动恢复 | 429 置 `rate_limited` + `rate_limited_until`，排队消息保持 `queued`；sweeper 周期扫描到期自动回 online |
| A2 错误码处理 | `DeliveryService` 按网关码统一分发：限流/终态/群不可写/消息级失败/504，各有确定后果 |
| A3 异步建群 | create→invite→join→promote 状态化推进；JOIN_TIMEOUT（10s）判定；promote 遇 NOT_MEMBER_YET 至多 2 次 |
| A4 时间线 / WS | 游标分页按 `(sent_at DESC, msg_id DESC)`，并发写入下不重不漏；WS 帧 seq 单调、sinceSeq 补发 |
| A5 预算与协议错误 | 上限 12 步 / 60s（`accumulated_ms` 持久化，停机时间不计）/ 连续 3 协议错误；turn 超时记 TURN_TIMEOUT |
| A5 审计 | send/kick 执行前审计；error/超时最多 3 次（不计步），3 次未果 → run blocked(audit_blocked) |
| A5 两类协议错误 | 未知工具/入参不合 schema：追加 is_error tool_result；坏 JSON/重复 id/超时：追加 PROTOCOL_ERROR 文本步 |
| B1 定时序列 | 黏性变量（stepVars 步进覆盖、空串不改）；启动前全步占位符预检，不通过 422 且一条不发 |
| B1 排期与重启 | 以 `message_sent` 落地为「发出」排下一步；重启只重排最早过期步，不会一次性全发 |
| B2 群生命周期 | INVITE_NOT_READY/EXPIRED/ALREADY_MEMBER 分别处理；leave-all 非群主先退、群主最后退，失败记 errors[] 且 DB 与网关成员保持一致 |
| B3 会话 | refresh token 仅 HttpOnly cookie、每次轮换；复用旧 token → 401 并作废整个会话；logout 使 access token 立即失效；前端 single-flight 续期 |
| C1 媒体 | 5s 超时 / 10MB 上限 / UUID 文件名防穿越 / `.tmp`+rename 原子落盘；清理按下载时刻判龄，running run 关联文件受保护 |
| C2 真实 LLM | 统一 AgentClient 接口：Anthropic Messages 直通；OpenAI Chat 完成 tool_calls 双向转换，改 provider 即切换 |

## 一键启动

前提：已安装 Docker 与 docker compose 插件（v2）。

```bash
docker compose up --build
```

首次构建约 1–2 分钟。启动后所有服务自动健康：

| 服务 | 地址 | 说明 |
|---|---|---|
| 后端 API | http://localhost:3000 | 自动执行 migration 后启动 |
| PostgreSQL | localhost:5432 | 用户/口令/库名均为 `app` |
| 消息网关模拟器 | http://localhost:3100 | 完整接口 + `/_mock` 故障注入 |
| Agent 模拟器 | http://localhost:3200 | `/agent/turn` + `/agent/audit` + `/_mock` 行为切换 |
| 前端控制台 | http://localhost:5173 | 登录页：`admin/admin` 或 `viewer/viewer` |

后端容器启动命令为 `node dist/db/migrate-cli.js up && node dist/index.js`：先应用所有未执行迁移，再启动服务。
数据库 schema 落后于代码时**应用会拒绝启动**并打印明确错误。

停止并清理数据卷（彻底重置）：

```bash
docker compose down -v
```

---

## 功能验证指南

以下所有命令在宿主机执行，只调用容器服务，无需直连数据库（个别场景用 `docker exec` 查库）。

### 0. 健康检查

```bash
curl http://localhost:3000/api/health
# 期望：{"ok":true,"schemaVersion":13}
```

### 1. 登录与权限

预置两个用户：`admin/admin`（全权限）、`viewer/viewer`（只读）。

```bash
# 登录拿 accessToken
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

# 带 token 访问账号列表
curl http://localhost:3000/api/accounts -H "Authorization: Bearer $TOKEN"

# viewer 只读：写接口返回 403
VIEWER_TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"viewer","password":"viewer"}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
curl -X POST http://localhost:3000/api/accounts/acct-1/transition \
  -H "Authorization: Bearer $VIEWER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"to":"online","expectedFrom":"idle"}'
# 期望：403 FORBIDDEN
```

### 2. 账号状态机

预置 4 个账号 `acct-1` … `acct-4`，初始 `idle`。状态转移需带 `expectedFrom` 做 CAS 乐观锁。

```bash
# idle → online（也可直接用 POST /api/accounts/:id/connect，效果相同）
curl -X POST http://localhost:3000/api/accounts/acct-1/transition \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"to":"online","expectedFrom":"idle"}'

# rate_limited 不能手动转移——它只由网关返回 429 触发。
# 模拟 429 限流（60s，之后自动恢复 online）：
curl -X POST http://localhost:3100/_mock/accounts/acct-1/rate-limit \
  -H 'Content-Type: application/json' -d '{"retryAfterSeconds":60}'

# 查看状态
curl http://localhost:3000/api/accounts -H "Authorization: Bearer $TOKEN"
```

状态转移图：`idle ⇄ online → rate_limited → online`，`online → disconnected → idle`。
非法转移、`expectedFrom` 不匹配返回 409；手动转 `rate_limited` 返回 400（网关 429 专属）。

### 3. 建群与消息时间线

建群是异步 job：受理后返回 202 + jobId，由 `GroupJobWorker` 调网关完成建群+入群。
**建群要求所有参与账号在线**，需先连接：

```bash
# 前置：连接建群涉及的账号（creator + 成员），否则返回 400 ACCOUNT_NOT_ONLINE
for a in acct-1 acct-2; do
  curl -X POST http://localhost:3000/api/accounts/$a/connect \
    -H "Authorization: Bearer $TOKEN"
done

# 建群（creator=acct-1，成员=[acct-2]）
JOB=$(curl -s -X POST http://localhost:3000/api/groups \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"creatorAccountId":"acct-1","memberAccountIds":["acct-2"]}')
JOB_ID=$(echo "$JOB" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)

# 轮询 job 状态（running → finished；失败为 failed 并带 errors[]）
curl http://localhost:3000/api/jobs/$JOB_ID -H "Authorization: Bearer $TOKEN"

# 群列表
curl http://localhost:3000/api/groups -H "Authorization: Bearer $TOKEN"
GROUP_UUID=$(curl -s http://localhost:3000/api/groups -H "Authorization: Bearer $TOKEN" \
  | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

# 群详情（含成员 + activeRunId）
curl http://localhost:3000/api/groups/$GROUP_UUID -H "Authorization: Bearer $TOKEN"

# 发送消息到群（入 outbox，OutboxSender 异步投递）
# accountId 为必填：指定用哪个服务账号的身份发送
curl -X POST http://localhost:3000/api/groups/$GROUP_UUID/send \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"accountId":"acct-1","text":"hello world"}'

# 消息时间线（游标分页）
curl "http://localhost:3000/api/groups/$GROUP_UUID/messages?limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

### 4. WebSocket 实时推送

```bash
# 用 token 建连，接收 message_received / message_sent / account_status 等事件
ws://localhost:3000/ws?token=<accessToken>

# 断线重连：带 sinceSeq 只补发 seq > sinceSeq 的事件
ws://localhost:3000/ws?token=<accessToken>&sinceSeq=10
```

### 5. Agent 运行

Agent 在「群收到非自己消息」时自动触发。需先开启群的 `agentEnabled`。

```bash
# 开启群的 agent 功能
curl -X PATCH http://localhost:3000/api/groups/$GROUP_UUID \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"agentEnabled":true}'

# 通过网关模拟器向群注入一条外部消息（非服务账号所发）→ 触发 agent run
GATEWAY_GROUP_ID=$(curl -s http://localhost:3000/api/groups/$GROUP_UUID \
  -H "Authorization: Bearer $TOKEN" | grep -o '"gatewayGroupId":"[^"]*"' | cut -d'"' -f4)

curl -X POST http://localhost:3100/_mock/messages/inject \
  -H 'Content-Type: application/json' \
  -d "[{\"groupId\":\"$GATEWAY_GROUP_ID\",\"senderPlatformUserId\":\"external-user-1\",\"text\":\"请帮我发条消息\",\"sentAt\":\"2026-01-01T00:00:01.000Z\"}]"

# 查看该群的 agent runs
curl http://localhost:3000/api/groups/$GROUP_UUID/agent-runs \
  -H "Authorization: Bearer $TOKEN"

# 查看某次 run 的步骤
RUN_ID=$(curl -s http://localhost:3000/api/groups/$GROUP_UUID/agent-runs \
  -H "Authorization: Bearer $TOKEN" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
curl http://localhost:3000/api/agent-runs/$RUN_ID -H "Authorization: Bearer $TOKEN"
```

**Agent 行为控制**（通过 agent-mock 的 `/_mock` 接口）：

```bash
# 切换 turn 行为：
#   normal | bad_json | unknown_tool | invalid_input | duplicate_id |
#   retry_same_key | never_finish | repeat_get | slow | hang
curl -X POST http://localhost:3200/_mock/behavior \
  -H 'Content-Type: application/json' -d '{"mode":"normal"}'

# 切换 audit 行为：pass | fail | error
curl -X POST http://localhost:3200/_mock/audit \
  -H 'Content-Type: application/json' -d '{"mode":"pass"}'

# 重置状态
curl -X POST http://localhost:3200/_mock/reset
```

Agent 支持的工具：`get_recent_messages`、`send_message`（幂等）、`kick_user`（需 `autoKickEnabled`）、`finish`。

### 6. 故障注入与恢复（可选）

网关模拟器提供 `/_mock` 系列接口注入故障，验证后端的可靠性语义：

```bash
# 注入消息（模拟外部用户发消息）
curl -X POST http://localhost:3100/_mock/messages/inject \
  -H 'Content-Type: application/json' \
  -d '[{"groupId":"<gatewayGroupId>","senderPlatformUserId":"u1","text":"hi","sentAt":"2026-01-01T00:00:01.000Z"}]'

# 事件重播 / 乱序 / 去重模式（开关参数名为 on）
curl -X POST http://localhost:3100/_mock/events/replay -H 'Content-Type: application/json' -d '{"count":5}'
curl -X POST http://localhost:3100/_mock/events/shuffle-mode -H 'Content-Type: application/json' -d '{"on":true}'
curl -X POST http://localhost:3100/_mock/events/duplicate-mode -H 'Content-Type: application/json' -d '{"on":true}'

# 故障注入：send 端点 504 一次、1500ms 后落地（题面 S5）
curl -X POST http://localhost:3100/_mock/faults -H 'Content-Type: application/json' \
  -d '{"endpoint":"send","mode":"504","count":1,"landAfterMs":1500}'
# 也支持 mode:"503"/"delay"；{"clearAll":true} 清除所有已注册故障
```

### 7. 媒体文件下载与清理（C1 选做）

message 事件带 `mediaUrl` 时，后端自动把文件下载到本地 media 目录，路径记入消息行；
超过保留天数（默认 30 天，可配）后由清理 worker 删除，运行中 agent run 关联的文件受保护。

```bash
# 注入一条带媒体的消息
curl -X POST http://localhost:3100/_mock/messages/inject \
  -H 'Content-Type: application/json' \
  -d '[{"groupId":"<gatewayGroupId>","senderPlatformUserId":"u1","text":"pic",
       "sentAt":"2026-01-01T00:00:01.000Z","mediaUrl":"/media/pic-1"}]'

# 查看已下载文件（backend 容器内 MEDIA_DIR=/app/media，named volume 持久化）
docker compose exec backend ls -l /app/media

# 查看消息行的本地路径与下载时刻
docker compose exec db psql -U app -d app -c \
  "SELECT msg_id, local_file_path, media_downloaded_at FROM messages
   WHERE local_file_path IS NOT NULL ORDER BY media_downloaded_at DESC;"
```

下载有 5 秒超时与 10MB 大小上限；媒体 404/网络故障不阻塞事件消费，路径保持 NULL，
重复事件到达时可重新下载。相关环境变量：`MEDIA_DIR` / `MEDIA_RETENTION_DAYS` /
`MEDIA_CLEAN_INTERVAL_SECONDS`（见 `.env.example`）。

### 8. 真实 LLM 接入（C2 选做）

默认 agent run 由 agent-mock 驱动（离线、S1–S8 可重复）。配置提供方后可改由真实大模型驱动，
runner 的工具协议、审计累计、预算与崩溃恢复逻辑对两者完全相同：

```bash
# docker-compose.yml backend.environment 增加（或宿主机本地开发时写入 backend/.env）：
AGENT_PROVIDER: openai            # 或 anthropic
AGENT_API_KEY: sk-...             # 必填，缺失则启动即失败
# AGENT_MODEL / AGENT_BASE_URL 留空即取官方默认，也可指向任意 OpenAI 兼容网关
```

- anthropic：Messages API，内容块协议与本项目同源、直通；
- openai：Chat Completions，自动完成「工具定义 / tool_calls / role:tool」双向转换；
- 审计（callAudit）由同一模型配合强约束 JSON prompt 充当审计员。

注意：真实模型行为不确定，S1–S8 脚本断言基于 mock，请在验证脚本场景时保持 `AGENT_PROVIDER=mock`。

## 一键脚本验证（题面场景 S1–S8）

题面 `docs/examination_project.md` §2.4 的 8 个场景已全部脚本化，宿主机执行、只调容器 HTTP，
正常约 1 分钟跑完，结尾打印 `PASS`：

```bash
./scripts/test-e2e-s1-s5.sh   # S1 时序 / S2 事件重复 / S3 自身回流 / S4 限流 / S5 504 收敛 + agent 重试
./scripts/test-e2e-s6-s8.sh   # S6 Agent 坏响应 / S7 序列并发 201+409 / S8 占位符预检 422
```

**部署冒烟（一键部署后建议首先执行）**：约 30 秒验证整套部署的主链路——
5 服务可达、schemaVersion 与 migrations 一致、登录/viewer 403、建群 finished、消息 sent、agent run finished。

```bash
./scripts/test-smoke.sh       # 部署冒烟（步骤 1 自愈事件流水线，任意历史状态下都可运行）
./scripts/test-all.sh         # 总入口：按序执行下面 7 个 HTTP/协议级集成脚本
```

其余集成脚本：

```bash
./scripts/test-gateway-mock.sh    # 网关模拟器契约 + 故障注入自测
./scripts/test-group-job.sh       # 建群 job 全流程 + JOIN_TIMEOUT
./scripts/test-auth-session.sh    # B3 会话：refresh 轮换 / 复用全家作废 / logout
./scripts/test-leave-all.sh       # B2 全员退群（含网关 500 瞬时重试）
./scripts/test-event-recovery.sh  # 停机恢复 INV-4（断流补齐）
./scripts/test-ws-reconnect.sh    # WebSocket 断线重连 + sinceSeq 补发
./scripts/test-playwright.sh      # C3：Playwright UI 自动化（首次自动下载 chromium）
```

> 脚本隔离约定：对网关执行 `resetEventCounter`（事件 id 归零）的脚本，都会同步
> `TRUNCATE events_inbox` 并把后端 `events_cursor` 游标归零——否则旧高游标会跳过
> 新事件、旧 inbox 行会与新事件撞 PK 被判重（表现为建群 JOIN_TIMEOUT）。

---

## 宿主机本地开发（不用容器跑后端）

```bash
# 只用容器跑数据库 + 模拟器
docker compose up -d db gateway-mock agent-mock

cd backend
cp ../.env.example .env      # 确认 DATABASE_URL / GATEWAY_URL / AGENT_URL 指向 localhost
npm install
npm run migrate              # 应用迁移
npm run dev                  # 启动后端（热重载，端口 3000）
```

npm scripts（`dev` / `migrate` / `migrate:check` / `start`）通过 Node 的
`--env-file-if-exists=.env` 自动加载 backend 目录下的 `.env`，无需 dotenv；
shell 中已导出的同名环境变量优先级更高。需要 Node ≥ 20.12（见 package.json engines）。

## 常用命令（backend/）

| 命令 | 作用 |
|---|---|
| `npm run typecheck` | 类型检查，不产出文件 |
| `npm run build` | 编译到 `dist/` |
| `npm run migrate` | 应用所有未执行的迁移（可重复执行） |
| `npm run migrate:check` | 只校验 schema 版本，不一致时退出码 1 |
| `npm run seed:hash -- <pw>` | 生成 bcrypt 哈希，用于 seed 迁移 |
| `npm test` | 运行单元测试（vitest） |
| `npm run dev` | 热重载开发模式 |

### 单元测试

测试需要可连接的 PostgreSQL（`docker compose up -d db` 即可）。首次运行时 vitest 的
globalSetup 会**自动创建并迁移独立的 `app_test` 数据库**，不影响 `app` 库；每个用例开始前自动重置数据。

```bash
docker compose up -d db
cd backend
npm test
```

当前共 245 个用例（23 个测试文件）。覆盖范围：账号状态机 6×6 转移表全枚举、
CAS 乐观锁并发、终态原子事务、限流到期自动恢复、出站投递与 504 收敛、
事件消费乱序/重复、建群 job、Agent 运行（审计/幂等/崩溃恢复/预算/取消/续跑 stepNo）、
定时序列（占位符/黏性变量/账号选择/并发冲突）、C1 媒体（下载幂等/到期清理/run 保护）、
C2 真实 LLM 适配器（请求转换/审计 JSON 解析，mock fetch 验证，无需 key）。

### Playwright UI 测试（C3 选做）

界面层端到端（登录/权限渲染、viewer 无写按钮且接口 403、状态按钮按 FSM 显隐、退出与路由守卫）：

```bash
docker compose up -d           # 前端 5173 / 后端 3000 就绪
./scripts/test-playwright.sh   # 首次自动 npm install + 下载 chromium（约 120MB）
# 浏览器启动报缺共享库时：cd frontend && sudo npx playwright install-deps chromium
```

## 数据库迁移约定

- 迁移文件位于 `backend/migrations/`，命名 `NNNN_<name>.sql`（4 位序号）。
- 序号即版本号，**只增不改**：已应用的迁移文件不得修改内容。
- 每个迁移在单个事务内执行，并记录到 `schema_migrations`；失败整体回滚。
- 多个实例同时启动时用 PostgreSQL advisory lock 串行化迁移。
- 服务启动时校验「数据库最大版本 == 代码最大版本」，不一致则拒绝启动。

## 目录结构

```
backend/
  migrations/            SQL 迁移（按序号执行）
  src/
    config/              环境变量解析与校验（启动即失败）
    db/                  连接池、事务助手、迁移框架
    domain/              纯业务逻辑（状态机等）
    repos/               SQL 只出现在这一层
    services/            编排：repo + domain + 外部调用
      agent-runner.ts    Agent 运行主循环（预算/审计/幂等/崩溃恢复）
      event-handlers/    网关事件消费（message/member_joined/...）
    http/                Fastify 路由、鉴权钩子、统一错误契约
    workers/             后台消费者（事件流、job、outbox、agent-runner、ws）
gateway-mock/            消息网关模拟器（建群/入群/踢人/事件流 + 故障注入）
agent-mock/              Agent 服务模拟器（/agent/turn + /agent/audit + 坏行为注入）
frontend/                控制台前端（React 18 + Vite；nginx 伺服并反代 /api、/ws）
docs/plan/               实现规划文档（切片 0–5）
scripts/                 集成测试脚本
```

## 实现进度

- [x] **切片 0 地基**：docker-compose、迁移框架、统一错误契约、登录与 viewer 只读
- [x] **切片 1 网关模拟器**：完整接口 + 故障注入（乱序/重复/504/断线）
- [x] **切片 2 账号状态机**：6×6 转移表 / CAS 乐观锁 / 终态原子后果 / 限流自动恢复
- [x] **切片 3 出站投递 + 网关事件消费**：outbox 可靠投递 / 504 收敛 / 事件幂等与乱序
- [x] **切片 4 建群 / 时间线分页 / WebSocket**：异步建群 job / 游标分页 / sinceSeq 补发
- [x] **切片 5 Agent**：Agent 模拟器 + 运行主循环 + 审计 + kick_user + 幂等键 + 崩溃恢复 + 大小限制 + 取消
- [x] **切片 5 定时序列执行（B1）**：模板/运行/步骤执行/变量占位符/账号选择
- [x] **切片 5 全量退群（B2）**：非群主先退、群主最后退、失败记 errors[]
- [x] **切片 5 登录会话（B3）**：refresh token 轮换、复用作废、logout 立即失效；前端自动续期 + single-flight
- [x] **A6 前端页面 1–3**：登录 / 账号列表 / 群详情（React 18 + Vite）
- [x] **B4 前端页面 4–5**：agent run 步骤详情、序列运行与预检；WebSocket 断线补齐验证
- [x] **题面 S1–S8 场景脚本化**：两个 e2e 脚本一键复现（5.23），各两轮验证通过
- [x] **C1 媒体文件（选做，5.25）**：mediaUrl 下载到本地 / 到期清理 / 运行中 run 保护
- [x] **C2 真实 LLM 接入（选做，5.26）**：Anthropic/OpenAI 双协议适配器 + 审计 LLM 化，默认仍走 mock
- [x] **C3 Playwright 自动化（选做，5.26）**：6 个 UI e2e 用例，两轮验证通过

## 已知限制

- 网关/Agent 模拟器的内部状态保存在内存中，**进程重启即清空**（题目未要求持久化）。
- 当前 `JWT_SECRET` 为演示用固定值，生产环境应通过 secret 注入。
- C2 真实 LLM 已具备接入能力但默认不启用：需要外网与付费 API key，
  且真实模型行为不可预测，验证 S1–S8 脚本时应保持 mock。
- Playwright 浏览器二进制不随仓库/镜像分发，首次运行脚本时自动下载到宿主机。
