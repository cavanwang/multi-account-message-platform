/**
 * account_status 事件 handler：账号状态变更通知。
 *
 * 语义：
 *  - status 为 suspended / session_expired → 走终态原子事务（markTerminal）；
 *  - 其他状态（online / rate_limited 等）→ 只记录日志，不修改（我们只信任本地 CAS 状态机）。
 */
import { markTerminal } from '../account-terminal.js';
import type { HandlerContext } from './types.js';
import { asRecord, reqStr } from './types.js';

export async function handleAccountStatus(ctx: HandlerContext, payload: unknown): Promise<void> {
  const rec = asRecord(payload, 'account_status');
  const accountId = reqStr(rec, 'accountId', 'account_status');
  const status = reqStr(rec, 'status', 'account_status');

  if (status === 'suspended' || status === 'session_expired') {
    const result = await markTerminal(ctx.pool, accountId, status, 'gateway_event');
    ctx.log.info(
      { accountId, status, terminalResult: result },
      'handler: account_status 触发终态',
    );
    return;
  }

  ctx.log.debug(
    { accountId, status },
    'handler: account_status 非终态，仅记录日志',
  );
}
