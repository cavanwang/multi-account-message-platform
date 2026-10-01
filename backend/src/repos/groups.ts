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
}
