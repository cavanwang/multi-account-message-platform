/**
 * ID 生成与 platformUserId 派生。
 *
 * 题面要求：同一个 accountId 每次 connect 都返回同一个 platformUserId。
 * 因此 platformUserId 必须由 accountId **确定性派生**，而不能用随机数——
 * 否则模拟器进程重启后（内存清空）同一个账号会拿到不同的 platformUserId，
 * 后端的成员表就会和网关对不上，且无法自愈。
 *
 * 这里用 SHA-256 取前 16 位十六进制。不直接用 accountId 是为了让平台侧的 ID
 * "看起来是另一套体系"（真实网关不会把内部账号名当作平台用户 ID 暴露出来）。
 */
import { createHash, randomUUID } from 'node:crypto';

/** 由 accountId 确定性派生 platformUserId。 */
export function derivePlatformUserId(accountId: string): string {
  const digest = createHash('sha256').update(`platform-user:${accountId}`).digest('hex');
  return `pu_${digest.slice(0, 16)}`;
}

/** 新建群 ID。 */
export function newGroupId(): string {
  return `grp_${randomUUID()}`;
}

/** 新建消息 ID。 */
export function newMsgId(): string {
  return `msg_${randomUUID()}`;
}

/** 新建邀请链接。随机且不透明，符合"链接可能过期、可能尚未 ready"的语义。 */
export function newInviteLink(): string {
  return `https://invite.mock/${randomUUID()}`;
}

/** 媒体 URL（C1 选做才会真正下载，这里只提供地址）。 */
export function mediaUrlFor(mediaId: string): string {
  return `/media/${mediaId}`;
}
