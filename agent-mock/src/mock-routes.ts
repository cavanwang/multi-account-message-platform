/**
 * 坏行为注入端点（规划 05 §1.4）。
 *
 * POST /_mock/behavior  { mode }  — 切换 /agent/turn 的行为
 * POST /_mock/audit     { mode }  — 切换 /agent/audit 的行为
 * POST /_mock/reset              — 重置所有状态
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BehaviorMode, AuditMode } from './types.js';
import { readJsonBody, sendError, sendJson } from './lib/http.js';
import { store } from './store.js';

const VALID_BEHAVIOR_MODES: BehaviorMode[] = [
  'normal', 'bad_json', 'unknown_tool', 'invalid_input', 'duplicate_id',
  'retry_same_key', 'never_finish', 'repeat_get', 'slow', 'hang',
];

const VALID_AUDIT_MODES: AuditMode[] = [
  'pass', 'fail', 'error_500', 'bad_json', 'no_verdict', 'invalid_verdict', 'slow', 'hang',
];

export async function handleMockBehavior(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<{ mode?: unknown }>(req);
  const mode = body?.mode;
  if (typeof mode !== 'string' || !(VALID_BEHAVIOR_MODES as string[]).includes(mode)) {
    sendError(res, 400, 'BAD_REQUEST', `无效的 behavior mode: ${String(mode)}`);
    return;
  }
  store.setBehaviorMode(mode as BehaviorMode);
  sendJson(res, 200, { ok: true, mode: store.getBehaviorMode() });
}

export async function handleMockAudit(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<{ mode?: unknown }>(req);
  const mode = body?.mode;
  if (typeof mode !== 'string' || !(VALID_AUDIT_MODES as string[]).includes(mode)) {
    sendError(res, 400, 'BAD_REQUEST', `无效的 audit mode: ${String(mode)}`);
    return;
  }
  store.setAuditMode(mode as AuditMode);
  sendJson(res, 200, { ok: true, mode: store.getAuditMode() });
}

export function handleMockReset(_req: IncomingMessage, res: ServerResponse): void {
  store.reset();
  sendJson(res, 200, { ok: true });
}
