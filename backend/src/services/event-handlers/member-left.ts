/**
 * member_left 事件 handler：有人离开/被移出群。
 *
 * 语义：
 *  - gatewayGroupId → group UUID；
 *  - DELETE FROM group_members WHERE group_id=? AND platform_user_id=?；
 *  - 不存在时静默忽略（幂等）。
 */
import { GroupRepo } from '../../repos/groups.js';
import type { HandlerContext } from './types.js';
import { asRecord, reqStr } from './types.js';

export async function handleMemberLeft(ctx: HandlerContext, payload: unknown): Promise<void> {
  const rec = asRecord(payload, 'member_left');
  const gatewayGroupId = reqStr(rec, 'groupId', 'member_left');
  const platformUserId = reqStr(rec, 'platformUserId', 'member_left');

  const groupRepo = new GroupRepo(ctx.pool);
  const group = await groupRepo.findByGatewayGroupId(gatewayGroupId, ctx.client);
  if (group === undefined) {
    throw new Error(`member_left: 群不存在（gatewayGroupId=${gatewayGroupId}）`);
  }

  await groupRepo.removeMemberByPlatformUserId(ctx.client, group.id, platformUserId);

  ctx.log.info(
    { groupId: group.id, platformUserId },
    'handler: member_left 已处理',
  );
}
