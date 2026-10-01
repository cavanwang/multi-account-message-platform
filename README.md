# 多账号群组消息平台

全栈开发工程师笔试题实现。平台代管若干服务账号、管理若干群、把群消息记成可靠时间线、按定时序列以指定角色发消息，并接入一个只能通过工具调用的 Agent。

- 权威需求：`docs/examination_project.md`
- 需求梳理：`docs/requirements.md`
- 实现规划：`docs/plan/`（切片 0–5 各一份说明文档）

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Node.js 22 + TypeScript（strict）+ Fastify |
| 数据库 | PostgreSQL 16（裸 SQL + `pg`，通过 SQL migration 管理） |
| 前端 | React 18 + TypeScript + Vite（切片 5） |
| 部署 | docker-compose 一键启动 |

## 快速开始

前提：已安装 Docker 与 docker compose 插件。

```bash
docker compose up --build
```

启动后：

| 服务 | 地址 | 说明 |
|---|---|---|
| 后端 API | http://localhost:3000 | |
| PostgreSQL | localhost:5432 | 用户/口令/库名均为 `app` |
| 消息网关模拟器 | http://localhost:3100 | 切片 1 已实现（正式路径 + `/_mock` 故障注入） |
| Agent 模拟器 | http://localhost:3200 | 切片 5 实现，当前为占位 |
| 前端控制台 | http://localhost:5173 | 切片 5 实现，当前为占位 |

后端容器启动时会自动执行 migration；数据库 schema 落后于代码时**应用会拒绝启动**并打印明确错误。

### 冒烟验证

```bash
# 健康检查：schemaVersion 应为当前迁移版本
curl http://localhost:3000/api/health

# 登录（预置用户：admin/admin 全权限，viewer/viewer 只读）
curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'

# 受保护路由：带 token 可访问账号列表
curl http://localhost:3000/api/accounts -H "Authorization: Bearer <accessToken>"

# viewer 只读：用 viewer 登录得到的 token 调写接口，返回 403 FORBIDDEN
curl -X POST http://localhost:3000/api/accounts/acct-1/transition \
  -H "Authorization: Bearer <viewerToken>" \
  -H 'Content-Type: application/json' \
  -d '{"to":"online","expectedFrom":"idle"}'
```

### 宿主机本地开发（不用容器跑后端）

```bash
# 只用容器跑数据库
docker compose up -d db

cd backend
cp ../.env.example .env      # 并确认 DATABASE_URL 指向 localhost
npm install
npm run migrate              # 应用迁移
npm run dev                  # 启动后端（热重载）
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

## 数据库迁移约定

- 迁移文件位于 `backend/migrations/`，命名 `NNNN_<name>.sql`（4 位序号）。
- 序号即版本号，**只增不改**：已应用的迁移文件不得修改内容。
- 每个迁移在单个事务内执行，并记录到 `schema_migrations`；失败整体回滚。
- 多个实例同时启动时用 PostgreSQL advisory lock 串行化迁移。
- 服务启动时校验「数据库最大版本 == 代码最大版本」，不一致则拒绝启动（落后或超前都拒绝）。

新增迁移：

```bash
# 例如新增 0003_xxx.sql，然后在 backend/ 下执行
npm run migrate
```

## 目录结构

```
backend/
  migrations/            SQL 迁移（按序号执行）
  src/
    config/              环境变量解析与校验（启动即失败）
    db/                  连接池、事务助手、迁移框架
    domain/              纯业务逻辑（状态机、占位符解析等）
    repos/               SQL 只出现在这一层
    services/            编排：repo + domain + 外部调用
    http/                Fastify 路由、鉴权钩子、统一错误契约
    workers/             后台消费者（事件流、job、序列调度）
gateway-mock/            消息网关模拟器（切片 1）
agent-mock/              Agent 服务模拟器（切片 5）
frontend/                控制台前端（切片 5）
docs/plan/               实现规划文档
```

## 实现进度

- [x] **切片 0 地基**：docker-compose、迁移框架、统一错误契约、登录与 viewer 只读
- [x] **切片 1 网关模拟器**：完整接口 + 故障注入
- [ ] 切片 2 账号状态机（转移表 / CAS / 终态原子后果）
- [ ] 切片 3 出站投递 + 网关事件消费
- [ ] 切片 4 建群 / 时间线分页 / WebSocket
- [ ] 切片 5 Agent 模拟器 + Agent 接入 + 定时序列 + 前端

## 已知限制

- 网关/Agent 模拟器的内部状态保存在内存中，**进程重启即清空**（题目未要求持久化）。
- 当前 `JWT_SECRET` 为演示用固定值，生产环境应通过 secret 注入。
