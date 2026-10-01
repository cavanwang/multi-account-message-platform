/**
 * member_joined 事件 handler：有人加入群。
 *
 * 语义：
 *  - gatewayGroupId → group UUID；
 *  - platformUserId → 服务账号 UUID（查 accounts 表）；
 *  - INSERT group_members ON CONFLICT DO NOTHING（role='member'，幂等）。
 *
 * 如果 platformUserId 不在 accounts 中，说明是外部用户加入——我们**不管理外部用户**的成员关系，
 * 直接静默返回（不抛错，不中断消费）。
 */
import { GroupRepo } from '../../repos/groups.js';
import { AccountRepo } from '../../repos/accounts.js';
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

  await groupRepo.addMember(ctx.client, group.id, account.id, platformUserId, 'member');

  ctx.log.info(
    { groupId: group.id, accountId: account.id, platformUserId },
    'handler: member_joined 已处理',
  );
}
