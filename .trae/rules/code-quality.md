---
alwaysApply: true
---

# 代码质量要求

- **清晰的注释**：避免 hardcode，关键逻辑必须有详细注释。
- **合理的分层/分文件**：每个代码文件不能超过 50KB，不能有超过 1000 行的代码文件。
- **类型安全**：不要为了过 typecheck 而使用 `any` 或 `@ts-ignore`；实在需要时写 TODO 注释。
- **数据库迁移**：数据库改动一律通过 migration，不要手动 psql 改 schema。
