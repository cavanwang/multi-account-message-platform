/**
 * 事件 handler 的公共类型与 payload 收窄工具。
 *
 * 网关事件 payload 来自 SSE 帧的 JSON（events_inbox.payload JSONB），
 * 编译期无法信任其形状，这里做**最小运行时校验**：
 * 缺字段/类型不符即抛错 → 走 attempts+1 / inconsistency 路径（INV-4），
 * 不会让半解析的数据写进业务表。
 */
import type { Pool, PoolClient } from 'pg';
import type { LoggerLike } from '../gateway-client.js';

/**
 * handler 上下文：
 *  - client：本事件的业务事务连接（所有 DB 写 + web_event 都在其中，INV-5）；
 *  - pool：终态服务 markTerminal 需要自持事务（advisory lock 串行化），不能用 client；
 *  - log：结构化日志；
 *  - media：C1 媒体下载所需配置（目录/保留天数）。
 */
export interface MediaConfig {
  readonly mediaDir: string;
  readonly mediaRetentionDays: number;
  readonly mediaCleanIntervalSeconds: number;
  /** 媒体所在网关地址：相对 mediaUrl（`/media/x`）按它补全。 */
  readonly gatewayUrl: string;
}

export interface HandlerContext {
  readonly client: PoolClient;
  readonly pool: Pool;
  readonly log: LoggerLike;
  readonly media: MediaConfig;
}

export type EventHandler = (ctx: HandlerContext, payload: unknown) => Promise<void>;

/** 把 unknown 收窄为 Record；非对象即抛错（视为畸形事件）。 */
export function asRecord(payload: unknown, eventType: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`${eventType}: payload 不是对象`);
  }
  return payload as Record<string, unknown>;
}

/** 取必填字符串字段；缺失/空串/非字符串即抛错。 */
export function reqStr(rec: Record<string, unknown>, field: string, eventType: string): string {
  const v = rec[field];
  if (typeof v !== 'string' || v === '') {
    throw new Error(`${eventType}: 缺少必填字段 ${field}`);
  }
  return v;
}

/** 取可选字符串字段；不存在或 null → undefined。 */
export function optStr(rec: Record<string, unknown>, field: string): string | undefined {
  const v = rec[field];
  return typeof v === 'string' ? v : undefined;
}

/** 取可空字符串字段（网关节点用 null 表达"无"，如 senderPlatformUserId）。 */
export function nullableStr(rec: Record<string, unknown>, field: string): string | null {
  const v = rec[field];
  return typeof v === 'string' && v !== '' ? v : null;
}

/** 解析 ISO 时间戳字段；非法即抛错。 */
export function reqDate(rec: Record<string, unknown>, field: string, eventType: string): Date {
  const raw = reqStr(rec, field, eventType);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${eventType}: 字段 ${field} 不是合法时间戳: ${raw}`);
  }
  return d;
}
