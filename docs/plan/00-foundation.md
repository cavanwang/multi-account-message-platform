# 切片 0：地基（脚手架 / 迁移 / 鉴权 / 错误契约）

> 上游依据：`docs/examination_project.md`、`docs/requirements.md`
> 对应需求组：**A0**（P0）；为 A1–A5 / B 组的公共地基。
> 独立 commit：**是**（一次 commit 完成本切片）。

---

## 1. 目标与范围

把"任何功能都要用到、且晚做贵得离谱"的横切关注点一次性做掉：

1. docker-compose 一键部署骨架（db / backend / gateway-mock / agent-mock / frontend 五个 service，本切片只需 db + backend 能起来）。
2. 后端工程骨架：TypeScript 严格模式、目录分层、配置读取、启动自检。
3. **数据库迁移框架**：可重复执行；`schema` 落后于代码时**拒绝启动**。
4. 统一错误响应格式、请求 ID、错误码常量。
5. `GET /api/health`。
6. `POST /api/auth/login` + access token 鉴权 + `viewer` 写操作 `403`。

**明确不在本切片内**：任何业务端点（账号/群/消息/agent/序列）、WS、refresh token（属 B3）、网关模拟器（切片 1）。

---

## 2. 技术选型（本切片定死，后续不再改）

| 项 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node.js 20 LTS（容器 `node:20-slim`） | 稳定，`pg`/`jose` 支持好 |
| 语言 | TypeScript 5，`strict: true`，`noUncheckedIndexedAccess` | CLAUDE.md 禁止 any / ts-ignore |
| HTTP 框架 | Fastify 4 | 内建 JSON schema 校验、插件体系、性能好 |
| 数据库 | PostgreSQL 16 + `pg` 连接池（**不引 ORM**） | schema 复杂、要手写 `ON CONFLICT` / advisory lock / partial unique index，裸 SQL 更可控 |
| 迁移 | **自研 SQL 迁移 runner**（见 §4），不引 knex/prisma | 要"可重复执行"和"schema 落后拒绝启动"，自研 20 行更直白 |
| 鉴权 | `jose`（HS256 JWT），`JWT_SECRET` 来自环境变量 | access token 15 分钟，无状态 |
| 口令 | `bcryptjs`（纯 JS，无原生编译，避免容器 build 依赖） | 两个预置用户而已 |
| 校验 | Fastify JSON Schema + zod（仅用于请求体） | 二选一即可，统一用 zod，schema 复用给 TS 类型 |
| 日志 | `pino`（Fastify 内建） | `requestId` 可直接进日志与错误体 |

**分层约定**（后续所有切片遵守，单文件 < 50KB / < 1000 行）：

```
backend/src/
  config/       环境变量解析与校验（启动即失败）
  db/           pool、迁移 runner、事务助手 withTransaction()
  domain/       纯业务逻辑（状态机、占位符解析等），不碰 IO
  repos/        每个聚合一个 repository，SQL 只出现在这里
  services/     编排：repo + domain + 外部 HTTP 调用
  http/         Fastify 路由、schema、鉴权 hook、错误映射
  workers/      后台消费者（事件流、job 执行、序列调度）
  index.ts      启动自检 + 监听
```

---

## 3. 对外契约

### 3.1 环境变量

| 变量 | 说明 | 本切片 |
|---|---|---|
| `PORT` | 后端端口，默认 3000 | 必用 |
| `DATABASE_URL` | `postgres://user:pass@db:5432/app` | 必用 |
| `GATEWAY_URL` | 网关模拟器地址，如 `http://gateway-mock:3100` | 只读取校验 |
| `AGENT_URL` | Agent 模拟器地址，如 `http://agent-mock:3200` | 只读取校验 |
| `JWT_SECRET` | HS256 签名密钥 | 必用 |
| `ACCESS_TOKEN_TTL_SECONDS` | 默认 900（15 分钟） | 必用 |
| `LOG_LEVEL` | 默认 `info` | 必用 |

启动时全部校验，缺失/格式错 → **进程退出码非 0 并打印明文错误**。

### 3.2 统一错误响应

```jsonc
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "requestId": "…" /* , ...业务字段 */ } }
```

- `401` → `code = UNAUTHORIZED`
- `403` → `code = FORBIDDEN`
- 业务字段（如后续的 `stepIndex`/`key`）平铺进 `error` 对象。

错误码常量集中定义在 `http/error-codes.ts`，后续切片只增不改。

### 3.3 端点

| 端点 | 请求 | 响应 |
|---|---|---|
| `GET /api/health` | — | `{ ok: true, schemaVersion: <number> }`；DB 不可用 → `503 { ok: false, … }` |
| `POST /api/auth/login` | `{ username, password }` | `200 { accessToken }`；凭证错 → `401 UNAUTHORIZED`；body 非法 → `400 VALIDATION_ERROR` |

**预置用户**：`admin/admin`（`role = admin`，全权限）、`viewer/viewer`（`role = viewer`，只读）。

鉴权方式：`Authorization: Bearer <accessToken>`。缺 token / 过期 / 签名错 → `401 UNAUTHORIZED`。
**权限 hook**：非 `GET` 方法一律要求 `role = admin`，否则 `403 FORBIDDEN`。该规则在切片 0 就生效，后续所有写端点自动继承（新增写端点无需重复判断）。

---

## 4. 数据库

### 4.1 迁移框架设计

- 迁移文件：`backend/migrations/NNNN_<name>.sql`，序号 4 位、只增不改。
- 记录表：

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT        NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- 执行规则：
  1. 启动时对 `schema_migrations` 表本身用 `CREATE TABLE IF NOT EXISTS`（**保证整体可重复执行**）。
  2. 取已应用的最大 `version`；只执行 `version > applied` 的文件，按序号升序。
  3. 每个迁移文件在**单个事务**内执行 + 写入一条 `schema_migrations`；失败整体回滚。
  4. 并发启动保护：迁移前取 `pg_advisory_lock(<固定常数>)`，避免多实例同时迁移。
- **落后拒绝启动**：代码里维护 `EXPECTED_SCHEMA_VERSION` 常量（= 迁移文件数量）。
  - `max(applied) < EXPECTED_SCHEMA_VERSION` → 抛错，进程退出，日志写明 `schema is behind code: applied=N expected=M`。
  - `max(applied) > EXPECTED_SCHEMA_VERSION` → 同样拒绝启动（代码比库旧）。
- CLI：`npm run migrate`（应用） / `npm run migrate:check`（只校验，供健康检查与 CI）。

### 4.2 表结构

**本切片只建与地基相关的表**，其余表在对应切片用新迁移文件追加（序号递增）。

```sql
-- 0001_init.sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

启用扩展：`CREATE EXTENSION IF NOT EXISTS pgcrypto;`（提供 `gen_random_uuid()`）。

**seed**（`0002_seed_users.sql`，幂等 `ON CONFLICT (username) DO NOTHING`）：写入 admin / viewer，口令用 bcrypt 哈希常量（哈希值由脚本生成后写死在 SQL 里，避免运行期依赖）。

---

## 5. 任务拆解

| # | 任务 | 产出 | 优先级 |
|---|---|---|---|
| 0.1 | 目录骨架 + `package.json` + `tsconfig.json`（strict） | `backend/` 可 `npm run typecheck` | P0 |
| 0.2 | `docker-compose.yml`：`db`(postgres:16, healthcheck) / `backend`（依赖 db healthy，启动前跑 migrate）/ `gateway-mock` / `agent-mock` / `frontend` 占位 | `docker compose up` 全绿 | P0 |
| 0.3 | `config/env.ts`：环境变量 zod 校验 | 缺变量时启动失败 | P0 |
| 0.4 | `db/pool.ts` + `db/withTransaction.ts` | 后续所有事务的基础 | P0 |
| 0.5 | 迁移 runner + CLI + `EXPECTED_SCHEMA_VERSION` 校验 | `npm run migrate`、`migrate:check` | P0 |
| 0.6 | `0001_init.sql`（users）+ `0002_seed_users.sql` | 迁移可重复执行 | P0 |
| 0.7 | 错误契约：`AppError` 类 + Fastify `setErrorHandler` + `requestId` 注入 | 所有错误统一格式 | P0 |
| 0.8 | `GET /api/health`（含 `schemaVersion`、DB ping） | — | P0 |
| 0.9 | `POST /api/auth/login` + `jose` 签发/校验 + 鉴权/权限 hook | viewer 写操作 403 | P0 |
| 0.10 | `.env.example`、`.gitignore` 补 `media/`、README「如何跑起来」骨架 | 面试官可自查 | P0 |
| 0.11 | 单测：迁移幂等、状态机无关（本切片仅测 auth/权限） | `npm test` 通过 | P1 |

---

## 6. 验收标准

- [ ] 空库执行 `docker compose up` → 迁移自动应用，`GET /api/health` 返回 `{ ok: true, schemaVersion: 2 }`。
- [ ] 再次 `docker compose up`（已有数据）→ 迁移不再重复执行，服务正常启动；`npm run migrate` 可反复执行。
- [ ] 手动把 `schema_migrations` 删掉一行（模拟库落后）→ 启动**失败**并打印明确错误。
- [ ] `admin/admin` 登录拿到 token；`viewer/viewer` 登录拿到 token。
- [ ] 用 viewer 的 token 调任意写端点 → `403 { error: { code: "FORBIDDEN" } }`。
- [ ] 无 token / 过期 token / 篡改 token → `401 { error: { code: "UNAUTHORIZED" } }`。
- [ ] 错误响应都带 `requestId`，且与日志中的 requestId 一致。
- [ ] 仓库中不存在 `.env`、密钥、`media/` 提交。

---

## 7. 风险

| 风险 | 对策 |
|---|---|
| 迁移与后续切片并行修改冲突 | 序号只增不改；每次切片自测"从零重建 + 增量应用"两条路径 |
| seed 口令哈希写死导致改密码困难 | 提供 `npm run seed:hash <password>` 工具重新生成；seed 用 `ON CONFLICT DO NOTHING` |
| `EXPECTED_SCHEMA_VERSION` 靠人工同步易漏 | 迁移文件名序号即版本，runner 启动时用 `readdir` 计算，**不做手写常量**（避免不一致） |
| 权限 hook 一刀切"非 GET 即 admin"可能误伤后续只读 POST | 后续若出现只读 POST，改用显式 `requiredRole` 声明；本切片在 hook 中留 TODO 注明 |

---

## 8. Commit 边界

一次 commit，信息形如：

```
feat(foundation): scaffold backend, migrations, auth and error contract

- docker-compose with db/backend (+ gateway/agent/frontend placeholders)
- repeatable SQL migration runner, refuse to boot when schema is behind
- unified error envelope with requestId
- /api/health, /api/auth/login, viewer read-only enforcement
```
