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
# 期望：{"ok":true,"schemaVersion":9,...}
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
# idle → online
curl -X POST http://localhost:3000/api/accounts/acct-1/transition \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"to":"online","expectedFrom":"idle"}'

# online → rate_limited（带 60s 限流）
curl -X POST http://localhost:3000/api/accounts/acct-1/transition \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"to":"rate_limited","expectedFrom":"online","retryAfterSeconds":60}'

# 查看状态
curl http://localhost:3000/api/accounts -H "Authorization: Bearer $TOKEN"
```

状态转移图：`idle ⇄ online → rate_limited → online`，`online → disconnected → idle`。
非法转移或 `expectedFrom` 不匹配返回 409。

### 3. 建群与消息时间线

建群是异步 job：受理后返回 202 + jobId，由 `GroupJobWorker` 调网关完成建群+入群。

```bash
# 建群（creator=acct-1，成员=[acct-2]）
JOB=$(curl -s -X POST http://localhost:3000/api/groups \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"creatorAccountId":"acct-1","memberAccountIds":["acct-2"]}')
JOB_ID=$(echo "$JOB" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)

# 轮询 job 状态（accepted → done）
curl http://localhost:3000/api/jobs/$JOB_ID -H "Authorization: Bearer $TOKEN"

# 群列表
curl http://localhost:3000/api/groups -H "Authorization: Bearer $TOKEN"
GROUP_UUID=$(curl -s http://localhost:3000/api/groups -H "Authorization: Bearer $TOKEN" \
  | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

# 群详情（含成员 + activeRunId）
curl http://localhost:3000/api/groups/$GROUP_UUID -H "Authorization: Bearer $TOKEN"

# 发送消息到群（入 outbox，OutboxSender 异步投递）
curl -X POST http://localhost:3000/api/groups/$GROUP_UUID/send \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"hello world"}'

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
# 切换 turn 行为：normal | never_finish | repeat_get | bad_json | duplicate_tool_use | timeout
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

# 事件重播 / 乱序 / 去重模式
curl -X POST http://localhost:3100/_mock/events/replay -H 'Content-Type: application/json' -d '{"count":5}'
curl -X POST http://localhost:3100/_mock/events/shuffle-mode -H 'Content-Type: application/json' -d '{"enabled":true}'
curl -X POST http://localhost:3100/_mock/events/duplicate-mode -H 'Content-Type: application/json' -d '{"enabled":true}'

# 一次性 504（下次 kick 返回 NETWORK_TIMEOUT）
curl -X POST http://localhost:3100/_mock/faults -H 'Content-Type: application/json' -d '{"kickTimeoutOnce":true}'
```

集成测试脚本（验证停机恢复 INV-4）：

```bash
./scripts/test-event-recovery.sh
```

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

覆盖范围：账号状态机 6×6 转移表全枚举、CAS 乐观锁并发、终态原子事务、限流到期自动恢复、
出站投递与 504 收敛、事件消费乱序/重复、建群 job、Agent 运行（审计/幂等/崩溃恢复/预算/取消）。

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
- [x] **切片 5 Agent（部分）**：Agent 模拟器 + 运行主循环 + 审计 + kick_user + 幂等键 + 崩溃恢复 + 大小限制 + 取消
- [x] **切片 5 定时序列执行（B1）**：模板/运行/步骤执行/变量占位符/账号选择
- [x] **切片 5 全量退群（B2）**：非群主先退、群主最后退、失败记 errors[]
- [x] **切片 5 登录会话（B3）**：refresh token 轮换、复用作废、logout 立即失效；前端自动续期 + single-flight
- [x] **A6 前端页面 1–3**：登录 / 账号列表 / 群详情（React 18 + Vite）
- [ ] B4 前端页面 4–5（agent run 详情、序列运行）与断线补齐验证

## 已知限制

- 网关/Agent 模拟器的内部状态保存在内存中，**进程重启即清空**（题目未要求持久化）。
- 当前 `JWT_SECRET` 为演示用固定值，生产环境应通过 secret 注入。
- 前端页面 4–5（agent run 详情、序列运行）属于 B4，尚未实现。
