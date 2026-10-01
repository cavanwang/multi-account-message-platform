/**
 * 群仓储层：SQL 只出现在这里。
 *
 * 聚合根架构（见项目记忆）：
 *   - groups 是聚合根，有 version 字段
 *   - group_members 是关联表，无 version，用唯一约束防重复
 */
import type { Pool, PoolClient } from 'pg';

export type GroupStatus = 'active' | 'unreachable' | 'left';
export type MemberRole = 'creator' | 'admin' | 'member';

export interface GroupRow {
  readonly id: string;
  readonly gatewayGroupId: string;
  readonly status: GroupStatus;
  readonly creatorAccountId: string;
  readonly agentEnabled: boolean;
  readonly autoKickEnabled: boolean;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** 关联的建群 job id（未关联为 null）。 */
  readonly createdByJobId: string | null;
}

export interface GroupMemberRow {
  readonly groupId: string;
  readonly accountId: string;
  readonly platformUserId: string;
  readonly role: MemberRole;
  readonly joinedAt: Date;
}

interface DbGroupRow {
  id: string;
  gateway_group_id: string;
  status: GroupStatus;
  creator_account_id: string;
  agent_enabled: boolean;
  auto_kick_enabled: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
  created_by_job_id: string | null;
}

interface DbGroupMemberRow {
  group_id: string;
  account_id: string;
  platform_user_id: string;
  role: MemberRole;
  joined_at: Date;
}

function fromDbGroup(row: DbGroupRow): GroupRow {
  return {
    id: row.id,
    gatewayGroupId: row.gateway_group_id,
    status: row.status,
    creatorAccountId: row.creator_account_id,
    agentEnabled: row.agent_enabled,
    autoKickEnabled: row.auto_kick_enabled,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByJobId: row.created_by_job_id,
  };
}

function fromDbMember(row: DbGroupMemberRow): GroupMemberRow {
  return {
    groupId: row.group_id,
    accountId: row.account_id,
    platformUserId: row.platform_user_id,
    role: row.role,
    joinedAt: row.joined_at,
  };
}

export class GroupRepo {
  constructor(private readonly pool: Pool) {}

  /**
   * 按账号 ID 移除该账号在所有群的成员记录。
   * 用于终态原子后果：进入终态时移出所有群。
   * @returns 被移除的成员记录数
   */
  async removeMemberFromAllGroups(accountId: string, client?: PoolClient): Promise<number> {
    const executor = client ?? this.pool;
    const { rowCount } = await executor.query(
      'DELETE FROM group_members WHERE account_id = $1',
      [accountId],
    );
    return rowCount ?? 0;
  }

  /**
   * 按 platformUserId 反查账号 ID（用于事件处理）。
   */
  async findAccountIdByPlatformUserId(platformUserId: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ account_id: string }>(
      'SELECT account_id FROM group_members WHERE platform_user_id = $1 LIMIT 1',
      [platformUserId],
    );
    return rows[0]?.account_id;
  }

  /**
   * 标记群为 unreachable（GROUP_WRITE_FORBIDDEN 后果，幂等：已是 unreachable 时不动）。
   * 必须在调用方事务内执行（与序列停止、outbox 失败原子生效）。
   */
  async markUnreachable(client: PoolClient, groupId: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE groups
       SET status = 'unreachable', version = version + 1, updated_at = now()
       WHERE id = $1 AND status = 'active'`,
      [groupId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * 按网关群 ID 查群（事件消费：事件里的 groupId 是网关文本 ID，需映射到聚合根 UUID）。
   * 可在调用方事务内调用（传 client）。
   */
  async findByGatewayGroupId(
    gatewayGroupId: string,
    client?: PoolClient,
  ): Promise<GroupRow | undefined> {
    const executor = client ?? this.pool;
    const { rows } = await executor.query<DbGroupRow>(
      'SELECT * FROM groups WHERE gateway_group_id = $1',
      [gatewayGroupId],
    );
    return rows[0] !== undefined ? fromDbGroup(rows[0]) : undefined;
  }

  /**
   * 判断 platformUserId 是否为该群的**服务账号成员**（message 事件的 isOwn 判定）。
   * sender 是外部用户时无此记录 → false。
   */
  async isMemberByPlatformUserId(
    client: PoolClient,
    groupId: string,
    platformUserId: string,
  ): Promise<boolean> {
    const { rowCount } = await client.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND platform_user_id = $2',
      [groupId, platformUserId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * 添加成员（member_joined 事件；幂等：PK 冲突忽略）。
   */
  async addMember(
    client: PoolClient,
    groupId: string,
    accountId: string,
    platformUserId: string,
    role: MemberRole = 'member',
  ): Promise<void> {
    await client.query(
      `INSERT INTO group_members (group_id, account_id, platform_user_id, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (group_id, account_id) DO NOTHING`,
      [groupId, accountId, platformUserId, role],
    );
  }

  /**
   * 按 accountId（UUID）移除群成员（leave-all job 用；不存在时静默忽略）。
   * 必须在调用方事务内调用（与 job 状态更新原子生效）。
   */
  async removeMemberByAccountId(
    client: PoolClient,
    groupId: string,
    accountId: string,
  ): Promise<void> {
    await client.query(
      'DELETE FROM group_members WHERE group_id = $1 AND account_id = $2',
      [groupId, accountId],
    );
  }

  /**
   * 标记群为 left（leave-all 完成后果，幂等：已是 left 时不动）。
   * 必须在调用方事务内调用。
   */
  async markLeft(client: PoolClient, groupId: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE groups
       SET status = 'left', version = version + 1, updated_at = now()
       WHERE id = $1 AND status <> 'left'`,
      [groupId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * 按 platformUserId 移除群成员（member_left 事件；不存在时静默忽略）。
   */
  async removeMemberByPlatformUserId(
    client: PoolClient,
    groupId: string,
    platformUserId: string,
  ): Promise<void> {
    await client.query(
      'DELETE FROM group_members WHERE group_id = $1 AND platform_user_id = $2',
      [groupId, platformUserId],
    );
  }

  /**
   * 判断账号是否为群成员（切片 3 send 端点的成员校验）。
   * 群不存在时同样返回 false（不存在的群自然没有成员）。
   */
  async isMember(groupId: string, accountId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = $2',
      [groupId, accountId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * 获取账号在所有群的成员记录。
   */
  async getMembershipsByAccountId(accountId: string): Promise<GroupMemberRow[]> {
    const { rows } = await this.pool.query<DbGroupMemberRow>(
      'SELECT * FROM group_members WHERE account_id = $1',
      [accountId],
    );
    return rows.map(fromDbMember);
  }

  // -------------------------------------------------------------------------
  // 批次 3：群查询与设置（4.8-4.9）
  // -------------------------------------------------------------------------

  /** 按 UUID 查群（群详情页用）。 */
  async findById(groupId: string): Promise<GroupRow | undefined> {
    const { rows } = await this.pool.query<DbGroupRow>(
      'SELECT * FROM groups WHERE id = $1',
      [groupId],
    );
    return rows[0] !== undefined ? fromDbGroup(rows[0]) : undefined;
  }

  /** 列出全部群（群列表页用）。按创建时间倒序，新建的群排在前面。 */
  async listAll(): Promise<GroupRow[]> {
    const { rows } = await this.pool.query<DbGroupRow>(
      'SELECT * FROM groups ORDER BY created_at DESC, id DESC',
    );
    return rows.map(fromDbGroup);
  }

  /** 列出群的全部成员（群详情页 members 字段）。 */
  async listMembers(groupId: string): Promise<GroupMemberRow[]> {
    const { rows } = await this.pool.query<DbGroupMemberRow>(
      'SELECT * FROM group_members WHERE group_id = $1 ORDER BY joined_at ASC, account_id ASC',
      [groupId],
    );
    return rows.map(fromDbMember);
  }

  /**
   * 更新群设置（agentEnabled / autoKickEnabled），CAS version 防止并发覆盖。
   * 不传的字段保持原值（COALESCE）；返回更新后的行，冲突返回 null。
   */
  async updateSettings(
    groupId: string,
    expectedVersion: number,
    updates: { agentEnabled?: boolean; autoKickEnabled?: boolean },
  ): Promise<GroupRow | null> {
    const { rows, rowCount } = await this.pool.query<DbGroupRow>(
      `UPDATE groups
       SET agent_enabled      = COALESCE($2, agent_enabled),
           auto_kick_enabled  = COALESCE($3, auto_kick_enabled),
           version            = version + 1,
           updated_at         = now()
       WHERE id = $1 AND version = $4
       RETURNING *`,
      [
        groupId,
        updates.agentEnabled ?? null,
        updates.autoKickEnabled ?? null,
        expectedVersion,
      ],
    );
    if (rowCount === 0 || rows[0] === undefined) return null;
    return fromDbGroup(rows[0]);
  }

  /**
   * 查该群当前 running 的序列 run id（群详情 activeRunId 字段）。
   * 同一群至多一个 running（partial unique index 保证），故 LIMIT 1。
   * 切片 5 才会真正写入 sequence_runs；当前恒返回 null。
   */
  async findActiveRunId(groupId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM sequence_runs
       WHERE group_id = $1 AND status = 'running'
       LIMIT 1`,
      [groupId],
    );
    return rows[0]?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // 批次 2：建群 job 专用（4.3-4.6）
  // -------------------------------------------------------------------------

  /**
   * 按 job id 查群（create 步骤幂等校验：已建群则跳过）。
   */
  async findByJobId(jobId: string, client?: PoolClient): Promise<GroupRow | undefined> {
    const executor = client ?? this.pool;
    const { rows } = await executor.query<DbGroupRow>(
      'SELECT * FROM groups WHERE created_by_job_id = $1',
      [jobId],
    );
    return rows[0] !== undefined ? fromDbGroup(rows[0]) : undefined;
  }

  /**
   * 建群成功后写 groups 行 + 创建者成员行（role='creator'）。
   * 必须在调用方事务内调用（与 gateway createGroup 写 DB 原子生效）。
   */
  async insertGroup(
    client: PoolClient,
    params: {
      gatewayGroupId: string;
      creatorAccountId: string;
      creatorPlatformUserId: string;
      jobId: string;
    },
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO groups
         (gateway_group_id, creator_account_id, agent_enabled, auto_kick_enabled, version, created_by_job_id)
       VALUES ($1, $2, false, false, 1, $3)
       RETURNING id`,
      [params.gatewayGroupId, params.creatorAccountId, params.jobId],
    );
    const groupId = rows[0]?.id;
    if (groupId === undefined) throw new Error('insertGroup 失败');

    await client.query(
      `INSERT INTO group_members (group_id, account_id, platform_user_id, role, joined_at)
       VALUES ($1, $2, $3, 'creator', now())
       ON CONFLICT (group_id, account_id) DO NOTHING`,
      [groupId, params.creatorAccountId, params.creatorPlatformUserId],
    );
    return groupId;
  }
}
