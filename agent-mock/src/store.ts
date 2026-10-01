/**
 * Agent 模拟器的内存状态（规划 05 §1）。
 *
 * - 按 runId 维护会话：记录上一次调用的工具、已用 tool_use.id、send 次数
 * - 坏行为模式：全局 behaviorMode + auditMode，通过 /_mock/ 切换
 */
import type { BehaviorMode, AuditMode } from './types.js';

/** 单个 run 的会话状态。 */
export interface AgentSession {
  /** 上一次调用的工具名（用于决定下一步）。 */
  lastTool: string | null;
  /** 已使用的 tool_use.id 集合（检测 duplicate_id）。 */
  usedToolIds: Set<string>;
  /** send_message 调用次数。 */
  sendCount: number;
  /** 最近一次生成的 idempotency_key（用于 retry_same_key）。 */
  lastIdempotencyKey: string | null;
}

class AgentStore {
  private readonly sessions = new Map<string, AgentSession>();
  private behaviorMode: BehaviorMode = 'normal';
  private auditMode: AuditMode = 'pass';

  /** 获取或创建一个 run 的会话。 */
  getOrCreateSession(runId: string): AgentSession {
    let session = this.sessions.get(runId);
    if (session === undefined) {
      session = {
        lastTool: null,
        usedToolIds: new Set<string>(),
        sendCount: 0,
        lastIdempotencyKey: null,
      };
      this.sessions.set(runId, session);
    }
    return session;
  }

  /** 清空指定 run 的会话（agent 结束或出错时调用）。 */
  clearSession(runId: string): void {
    this.sessions.delete(runId);
  }

  getBehaviorMode(): BehaviorMode {
    return this.behaviorMode;
  }

  setBehaviorMode(mode: BehaviorMode): void {
    this.behaviorMode = mode;
  }

  getAuditMode(): AuditMode {
    return this.auditMode;
  }

  setAuditMode(mode: AuditMode): void {
    this.auditMode = mode;
  }

  /** 重置所有状态（/_mock/reset）。 */
  reset(): void {
    this.sessions.clear();
    this.behaviorMode = 'normal';
    this.auditMode = 'pass';
  }
}

export const store = new AgentStore();
