/**
 * member_joined 事件 handler：有人加入群。
 *
 * 语义：
 *  - gatewayGroupId → group UUID；
 *  - platformUserId → 服务账号 UUID（查 accounts 表）；
 *  - 若该账号属于某 running create_group job 名单（且本群由该 job 创建、
 *    已发 join 请求），则按名单决定 role：
 *      名单第一个（memberAccountIds[0]）→ 'admin'，其余 → 'member'；
 *    同事务 markJoined（消除 JOIN_TIMEOUT 超时风险）；
 *  - 否则（普通入群 / 外部账号被拉进群）→ INSERT group_members(role='member')；
 *  - 全部 INSERT 走 ON CONFLICT DO NOTHING（幂等）。
 *
 * 终态账号不重新加回群（与 markTerminal 的"移出所有群"对冲）。
 * 外部用户（platformUserId 不在 accounts 中）不管理成员关系，静默跳过。
 */
import { GroupRepo } from '../../repos/groups.js';
import { AccountRepo } from '../../repos/accounts.js';
import { JobRepo } from '../../repos/jobs.js';
import type { HandlerContext } from './types.js';
import { asRecord, reqStr } from './types.js';

export async function handleMemberJoined(ctx: HandlerContext, payload: unknown): Promise<void> {
  const rec = asRecord(payload, 'member_joined');
  const gatewayGroupId = reqStr(rec, 'groupId', 'member_joined');
  const platformUserId = reqStr(rec, 'platformUserId', 'member_joined');

  const groupRepo = new GroupRepo(ctx.pool);
  const group = await groupRepo.findByGatewayGroupId(gatewayGroupId, ctx.client);
  if (group === undefined) {
    throw new Error(`member_joined: 群不存在（gatewayGroupId=${gatewayGroupId}）`);
  }

  const accountRepo = new AccountRepo(ctx.pool);
  const account = await accountRepo.findByPlatformUserId(platformUserId);
  if (account === undefined) {
    // 外部用户：不管理，不抛错
    ctx.log.debug(
      { gatewayGroupId, platformUserId },
      'handler: member_joined 为外部用户，跳过',
    );
    return;
  }

  // 终态账号不应被重新加回群（与 markTerminal 的"移出所有群"对冲，P3b）
  if (account.status === 'suspended' || account.status === 'session_expired') {
    ctx.log.warn(
      { groupId: group.id, accountId: account.id, platformUserId, status: account.status },
      'handler: member_joined 目标账号已终态，跳过加群',
    );
    return;
  }

  // ---- 建群 job 回填：该群由 running job 创建，且账号在名单内 ----
  let role: 'creator' | 'admin' | 'member' = 'member';
  let matchedJobId: string | undefined;

  if (group.createdByJobId !== null) {
    const jobRepo = new JobRepo(ctx.pool);
    const job = await jobRepo.findById(group.createdByJobId);
    if (job !== undefined && job.status === 'running') {
      const members = await jobRepo.listJobMembers(job.id);
      const hit = members.find((m) => m.accountId === account.id);
      // 只有"已发 join 请求"的成员才被回填；未发 join 却收到事件说明是乱序/补投，
      // 仍按普通 member 处理（joined_at 留给 job worker 的 join 步骤落）
      if (hit !== undefined && hit.joinRequestedAt !== null) {
        const memberAccountIds = (job.payload['memberAccountIds'] as string[] | undefined) ?? [];
        // 名单第一个 → admin；其余 → member
        role = memberAccountIds[0] === account.accountId ? 'admin' : 'member';
        matchedJobId = job.id;
      }
    }
  }

  await groupRepo.addMember(ctx.client, group.id, account.id, platformUserId, role);

  // 同事务 markJoined：事件落库与 job 进度推进原子生效（INV-4 / INV-5）
  if (matchedJobId !== undefined) {
    const jobRepo = new JobRepo(ctx.pool);
    await jobRepo.markJoined(ctx.client, matchedJobId, account.id);
  }

  ctx.log.info(
    { groupId: group.id, accountId: account.id, platformUserId, role, matchedJobId },
    'handler: member_joined 已处理',
  );
}
