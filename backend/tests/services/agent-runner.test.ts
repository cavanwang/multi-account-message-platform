/**
 * Agent Runner 主循环测试（F1）。
 *
 * 覆盖：正常流程、BAD_JSON、UNKNOWN_TOOL、12步预算、60s墙钟、连续3次协议错误。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContentBlock, AgentMessage, AgentTool, TurnResult } from '../../src/services/agent-client.js';
import { runAgent, type AgentRunnerDeps, type AgentClientLike, type AuditResultLike } from '../../src/services/agent-runner.js';
import type { GroupGateway } from '../../src/services/gateway-client.js';
import { AgentRunRepo } from '../../src/repos/agent-runs.js';
import { GroupRepo } from '../../src/repos/groups.js';
import { OutboxRepo } from '../../src/repos/outbox.js';
import { AccountRepo } from '../../src/repos/accounts.js';
import { pool, resetDb, seedGroupWithMember } from '../helpers/db.js';

/** Mock AgentClient：按预设脚本返回响应。 */
class MockAgentClient implements AgentClientLike {
  constructor(private readonly script: AgentMessage[]) {}
  private callCount = 0;
  async callTurn(_runId: string, _tools: AgentTool[], _messages: AgentMessage[]): Promise<TurnResult> {
    const msg = this.script[this.callCount];
    this.callCount++;
    if (msg === undefined) {
      return { kind: 'ok', response: { id: 'r', model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } };
    }
    const block = (msg.content as AgentContentBlock[])[0]!;
    const stopReason = block.type === 'tool_use' ? 'tool_use' : 'end_turn';
    return { kind: 'ok', response: { id: 'r', model: 'm', stop_reason: stopReason, content: [block] } };
  }
  async callAudit(): Promise<AuditResultLike> {
    return { kind: 'pass' };
  }
}

/** 构造一个会返回 BAD_JSON 的 mock client。 */
class BadJsonClient implements AgentClientLike {
  async callTurn(): Promise<TurnResult> {
    return { kind: 'protocol_error', code: 'BAD_JSON', raw: 'not json' };
  }
  async callAudit(): Promise<AuditResultLike> {
    return { kind: 'pass' };
  }
}

/** Mock GroupGateway。 */
function makeMockGroupGateway(): GroupGateway {
  return {
    createGroup: async () => ({ kind: 'ok', data: { groupId: 'g' } }),
    createInvite: async () => ({ kind: 'ok', data: { inviteLink: 'l', readyAfterMs: 0 } }),
    join: async () => ({ kind: 'ok', data: undefined }),
    promote: async () => ({ kind: 'ok', data: undefined }),
    kickMember: async () => ({ kind: 'ok', data: undefined }),
  };
}

function makeDeps(agentClient: AgentClientLike, groupGateway: GroupGateway = makeMockGroupGateway()): AgentRunnerDeps {
  return {
    pool,
    agentRunRepo: new AgentRunRepo(pool),
    groupRepo: new GroupRepo(pool),
    outboxRepo: new OutboxRepo(pool),
    accountRepo: new AccountRepo(pool),
    agentClient,
    groupGateway,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

/** 创建一个 running 的 agent run。 */
async function createRunningRun(groupId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO agent_runs (group_id, status) VALUES ($1, 'running') RETURNING id`,
    [groupId],
  );
  return rows[0]!.id;
}

describe('AgentRunner F1', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('正常流程：get_recent → send_message → finish', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const runId = await createRunningRun(groupId);

    const script: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'get_recent_messages', input: { limit: 10 } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'send_message', input: { text: 'hi', idempotency_key: '22222222-2222-2222-2222-222222222222' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu3', name: 'finish', input: { summary: 'done' } }] },
    ];
    const deps = makeDeps(new MockAgentClient(script));
    await runAgent(deps, runId);

    const run = await deps.agentRunRepo.getRun(pool, runId);
    expect(run?.status).toBe('finished');
    expect(run?.endReason).toBe('final');
    expect(run?.summary).toBe('done');

    const steps = await deps.agentRunRepo.listSteps(pool, runId);
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.name)).toEqual(['get_recent_messages', 'send_message', 'finish']);
  });

  it('BAD_JSON：追加 user PROTOCOL_ERROR 块，不计 assistant 块', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const runId = await createRunningRun(groupId);

    // 第一次 BAD_JSON，第二次 finish
    let count = 0;
    const client: AgentClientLike = {
      callTurn: async () => {
        count++;
        if (count === 1) return { kind: 'protocol_error', code: 'BAD_JSON', raw: 'not json' };
        return { kind: 'ok', response: { id: 'r', model: 'm', stop_reason: 'end_turn', content: [{ type: 'tool_use', id: 'tu1', name: 'finish', input: { summary: 'done' } }] } };
      },
      callAudit: async () => ({ kind: 'pass' }),
    };

    const deps = makeDeps(client);
    await runAgent(deps, runId);

    const run = await deps.agentRunRepo.getRun(pool, runId);
    expect(run?.status).toBe('finished');

    const steps = await deps.agentRunRepo.listSteps(pool, runId);
    expect(steps[0]?.kind).toBe('protocol_error');
    expect(steps[0]?.errorCode).toBe('BAD_JSON');
    expect(steps[1]?.kind).toBe('final');

    const messages = await deps.agentRunRepo.loadMessages(pool, runId);
    // 第 1 条应为 user 的 PROTOCOL_ERROR 文本块
    expect(messages[0]?.role).toBe('user');
  });

  it('UNKNOWN_TOOL：第 1 类协议错误，is_error tool_result，正常计入对话', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const runId = await createRunningRun(groupId);

    const script: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'unknown_tool', input: {} }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'finish', input: { summary: 'done' } }] },
    ];
    const deps = makeDeps(new MockAgentClient(script));
    await runAgent(deps, runId);

    const steps = await deps.agentRunRepo.listSteps(pool, runId);
    expect(steps[0]?.kind).toBe('tool_use');
    expect(steps[0]?.isError).toBe(true);
    expect(steps[0]?.errorCode).toBe('UNKNOWN_TOOL');
  });

  it('超出 12 步预算 → failed/budget_exhausted', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const runId = await createRunningRun(groupId);

    // 一直返回 get_recent_messages，不 finish
    const client: AgentClientLike = {
      callTurn: async () => ({
        kind: 'ok',
        response: { id: 'r', model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu${Math.random()}`, name: 'get_recent_messages', input: { limit: 10 } }] },
      }),
      callAudit: async () => ({ kind: 'pass' }),
    };

    const deps = makeDeps(client);
    await runAgent(deps, runId);

    const run = await deps.agentRunRepo.getRun(pool, runId);
    expect(run?.status).toBe('failed');
    expect(run?.endReason).toBe('budget_exhausted');
  });

  it('连续 3 次协议错误 → failed/protocol_errors', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const runId = await createRunningRun(groupId);

    const deps = makeDeps(new BadJsonClient());
    await runAgent(deps, runId);

    const run = await deps.agentRunRepo.getRun(pool, runId);
    expect(run?.status).toBe('failed');
    expect(run?.endReason).toBe('protocol_errors');
  });

  it('60s 墙钟超限 → failed/wall_clock', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const runId = await createRunningRun(groupId);
    // 预置 accumulated_ms 为 59999，下一次 tick 会超 60000
    await pool.query('UPDATE agent_runs SET accumulated_ms = 59999 WHERE id = $1', [runId]);

    const script: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'get_recent_messages', input: { limit: 10 } }] },
    ];
    const deps = makeDeps(new MockAgentClient(script));
    await runAgent(deps, runId);

    const run = await deps.agentRunRepo.getRun(pool, runId);
    expect(run?.status).toBe('failed');
    expect(run?.endReason).toBe('wall_clock');
  });

  it('send_message 审计 fail → AUDIT_REJECTED，不占用幂等键', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const runId = await createRunningRun(groupId);

    // 审计返回 fail
    const client: AgentClientLike = {
      callTurn: async () => ({
        kind: 'ok',
        response: { id: 'r', model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'send_message', input: { text: 'hi', idempotency_key: '22222222-2222-2222-2222-222222222222' } }] },
      }),
      callAudit: async () => ({ kind: 'fail', reason: 'blocked content' }),
    };

    const deps = makeDeps(client);
    await runAgent(deps, runId);

    const steps = await deps.agentRunRepo.listSteps(pool, runId);
    expect(steps[0]?.errorCode).toBe('AUDIT_REJECTED');
    expect(steps[0]?.auditVerdict).toBe('fail');

    // 幂等键不应被记录（被拒的不占用）
    const tc = await deps.agentRunRepo.getToolCall(pool, runId, '22222222-2222-2222-2222-222222222222');
    expect(tc).toBeUndefined();
  });

  it('审计连续 3 次 error → run blocked', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const runId = await createRunningRun(groupId);

    const client: AgentClientLike = {
      callTurn: async () => ({
        kind: 'ok',
        response: { id: 'r', model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'send_message', input: { text: 'hi', idempotency_key: '22222222-2222-2222-2222-222222222222' } }] },
      }),
      callAudit: async () => ({ kind: 'error', message: 'audit down' }),
    };

    const deps = makeDeps(client);
    await runAgent(deps, runId);

    const run = await deps.agentRunRepo.getRun(pool, runId);
    expect(run?.status).toBe('blocked');
    expect(run?.endReason).toBe('audit_blocked');
  });

  it('kick_user autoKickEnabled=false → POLICY_DENIED', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    await pool.query('UPDATE groups SET auto_kick_enabled = false WHERE id = $1', [groupId]);
    const runId = await createRunningRun(groupId);

    const script: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'kick_user', input: { platform_user_id: 'pu_x', reason: 'bad' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'finish', input: { summary: 'done' } }] },
    ];
    const deps = makeDeps(new MockAgentClient(script));
    await runAgent(deps, runId);

    const steps = await deps.agentRunRepo.listSteps(pool, runId);
    expect(steps[0]?.errorCode).toBe('POLICY_DENIED');
  });

  it('kick_user 正常流程（autoKickEnabled=true）→ kicked', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    // 设为 creator 角色（seed 默认是 member）+ 开启 autoKick
    await pool.query(`UPDATE group_members SET role = 'creator' WHERE group_id = $1`, [groupId]);
    await pool.query(`UPDATE groups SET auto_kick_enabled = true WHERE id = $1`, [groupId]);
    const runId = await createRunningRun(groupId);

    const script: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'kick_user', input: { platform_user_id: 'pu_x', reason: 'bad' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'finish', input: { summary: 'done' } }] },
    ];
    const deps = makeDeps(new MockAgentClient(script));
    await runAgent(deps, runId);

    const steps = await deps.agentRunRepo.listSteps(pool, runId);
    expect(steps[0]?.isError).toBe(false);
    expect(steps[0]?.auditVerdict).toBe('pass');
  });

  it('send_message 幂等键：第二次相同 key 不重发，返回当前状态', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const runId = await createRunningRun(groupId);
    const sameKey = '11111111-1111-1111-1111-111111111111';

    // 第一次 send_message（audit pass），第二次用相同 key
    let turnCount = 0;
    const client: AgentClientLike = {
      callTurn: async () => {
        turnCount++;
        if (turnCount <= 2) {
          return { kind: 'ok', response: { id: 'r', model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu${turnCount}`, name: 'send_message', input: { text: 'hi', idempotency_key: sameKey } }] } };
        }
        return { kind: 'ok', response: { id: 'r', model: 'm', stop_reason: 'end_turn', content: [{ type: 'tool_use', id: 'tu3', name: 'finish', input: { summary: 'done' } }] } };
      },
      callAudit: async () => ({ kind: 'pass' }),
    };

    const deps = makeDeps(client);
    await runAgent(deps, runId);

    // outbox 里应该只有 1 条消息（幂等去重）
    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM outbox_messages WHERE client_msg_id = $1',
      [sameKey],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('send_message 无 online 账号 → NO_AVAILABLE_ACCOUNT', async () => {
    const { groupId, accountUuid } = await seedGroupWithMember('acct-1');
    // 把账号设为 disconnected
    await pool.query(`UPDATE accounts SET status = 'disconnected' WHERE id = $1`, [accountUuid]);
    const runId = await createRunningRun(groupId);

    const script: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'send_message', input: { text: 'hi', idempotency_key: '22222222-2222-2222-2222-222222222222' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'finish', input: { summary: 'done' } }] },
    ];
    const deps = makeDeps(new MockAgentClient(script));
    await runAgent(deps, runId);

    const steps = await deps.agentRunRepo.listSteps(pool, runId);
    expect(steps[0]?.errorCode).toBe('NO_AVAILABLE_ACCOUNT');
  });
});
