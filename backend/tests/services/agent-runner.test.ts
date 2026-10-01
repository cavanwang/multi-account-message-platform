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
    leaveMember: async () => ({ kind: 'ok', data: undefined }),
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

/** 创建一个 running 的 agent run（同时开启群的 agent_enabled）。 */
async function createRunningRun(groupId: string): Promise<string> {
  await pool.query(`UPDATE groups SET agent_enabled = true WHERE id = $1`, [groupId]);
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

  it('run 结束时发且只发一条 agent_run 终态事件（§2.3）', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const runId = await createRunningRun(groupId);

    const script: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'finish', input: { summary: 'done' } }] },
    ];
    const deps = makeDeps(new MockAgentClient(script));
    await runAgent(deps, runId);

    const { rows } = await pool.query<{ type: string; payload: { status: string; endReason: string | null } }>(
      `SELECT type, payload FROM web_events
       WHERE type = 'agent_run' AND payload->>'runId' = $1
       ORDER BY seq ASC`,
      [runId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.status).toBe('finished');
    expect(rows[0]!.payload.endReason).toBe('final');
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

    // outbox 里应该只有 1 条消息（幂等去重）。
    // client_msg_id 是后端生成的 UUID，需经 agent_tool_calls.outbox_id 关联断言。
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM outbox_messages o
       JOIN agent_tool_calls t ON t.outbox_id = o.id
       WHERE t.run_id = $1 AND t.idempotency_key = $2`,
      [runId, sameKey],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('send_message 非 UUID 幂等键（agent-mock 风格 "ik-1"）：全链路不崩（0011 回归）', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const runId = await createRunningRun(groupId);
    // agent 幂等键是 opaque string（无 UUID 格式约束），绝不能直接写进 outbox.client_msg_id
    const opaqueKey = 'ik-1';

    let turnCount = 0;
    const client: AgentClientLike = {
      callTurn: async () => {
        turnCount++;
        if (turnCount <= 2) {
          return { kind: 'ok', response: { id: 'r', model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu${turnCount}`, name: 'send_message', input: { text: 'hi', idempotency_key: opaqueKey } }] } };
        }
        return { kind: 'ok', response: { id: 'r', model: 'm', stop_reason: 'end_turn', content: [{ type: 'tool_use', id: 'tu3', name: 'finish', input: { summary: 'done' } }] } };
      },
      callAudit: async () => ({ kind: 'pass' }),
    };

    const deps = makeDeps(client);
    await runAgent(deps, runId);

    // 第二次同 key 幂等去重：outbox 恰好 1 条（经 agent_tool_calls.outbox_id 关联）
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM outbox_messages o
       JOIN agent_tool_calls t ON t.outbox_id = o.id
       WHERE t.run_id = $1 AND t.idempotency_key = $2`,
      [runId, opaqueKey],
    );
    expect(Number(rows[0]?.count)).toBe(1);
    // 映射列记录的是后端生成的 UUID，而不是 agent 的 opaque key
    const tc = await deps.agentRunRepo.getToolCall(pool, runId, opaqueKey);
    expect(tc?.state).toBe('executed');
    expect(tc?.clientMsgId).toMatch(/^[0-9a-f-]{36}$/);
    const run = await deps.agentRunRepo.getRun(pool, runId);
    expect(run?.status).toBe('finished');
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

  // ---- F3：崩溃恢复 ----

  it('崩溃恢复：executed 状态 → 回填 tool_result，不重发', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const runId = await createRunningRun(groupId);
    const idemKey = '33333333-3333-3333-3333-333333333333';

    // 模拟 crash 前状态：assistant tool_use 已持久化，tool_call 已 executed
    const toolUseBlock: AgentContentBlock = { type: 'tool_use', id: 'tu-crash', name: 'send_message', input: { text: 'hi', idempotency_key: idemKey } };
    {
      const c = await pool.connect();
      try {
        await new AgentRunRepo(pool).appendMessage(c, runId, 'assistant', [toolUseBlock]);
      } finally {
        c.release();
      }
    }

    // 手动插入 outbox + agent_tool_calls(executed)
    const { rows: outboxRows } = await pool.query<{ id: string }>(
      `INSERT INTO outbox_messages (group_id, account_id, client_msg_id, text, delivery_status, origin)
       SELECT $1, (SELECT id FROM accounts WHERE account_id='acct-1'), $2, 'hi', 'sent', 'agent'
       RETURNING id`,
      [groupId, idemKey],
    );
    await pool.query(
      `INSERT INTO agent_tool_calls (run_id, idempotency_key, outbox_id, tool_use_id, state, client_msg_id)
       VALUES ($1, $2, $3, 'tu-crash', 'executed', $2)`,
      [runId, idemKey, outboxRows[0]!.id],
    );

    // agent 第 2 轮直接 finish
    const script: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'finish', input: { summary: 'done' } }] },
    ];
    const deps = makeDeps(new MockAgentClient(script));
    await runAgent(deps, runId);

    // 不应重发：outbox 只有 1 条
    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM outbox_messages WHERE client_msg_id = $1',
      [idemKey],
    );
    expect(Number(rows[0]?.count)).toBe(1);

    // run 正常 finished
    const run = await deps.agentRunRepo.getRun(pool, runId);
    expect(run?.status).toBe('finished');
  });

  it('崩溃恢复：pending_execution + outbox 已存在 → 回填标记，不重发', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const runId = await createRunningRun(groupId);
    const idemKey = '44444444-4444-4444-4444-444444444444';

    const toolUseBlock: AgentContentBlock = { type: 'tool_use', id: 'tu-pending', name: 'send_message', input: { text: 'hi', idempotency_key: idemKey } };
    {
      const c = await pool.connect();
      try {
        await new AgentRunRepo(pool).appendMessage(c, runId, 'assistant', [toolUseBlock]);
      } finally {
        c.release();
      }
    }

    // outbox 已入队但 tool_call 仍是 pending_execution（crash 在 mark 之前）
    await pool.query(
      `INSERT INTO outbox_messages (group_id, account_id, client_msg_id, text, delivery_status, origin)
       SELECT $1, (SELECT id FROM accounts WHERE account_id='acct-1'), $2, 'hi', 'queued', 'agent'`,
      [groupId, idemKey],
    );
    await pool.query(
      `INSERT INTO agent_tool_calls (run_id, idempotency_key, tool_use_id, state, client_msg_id)
       VALUES ($1, $2, 'tu-pending', 'pending_execution', $2)`,
      [runId, idemKey],
    );

    const script: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'finish', input: { summary: 'done' } }] },
    ];
    const deps = makeDeps(new MockAgentClient(script));
    await runAgent(deps, runId);

    // 恢复后应标记为 executed
    const tc = await deps.agentRunRepo.getToolCall(pool, runId, idemKey);
    expect(tc?.state).toBe('executed');

    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM outbox_messages WHERE client_msg_id = $1',
      [idemKey],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('崩溃恢复续跑：stepNo 从已有步骤数续排，不撞 (run_id, step_no) 唯一键', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const runId = await createRunningRun(groupId);

    // 模拟 crash 前已完成第 1 步：配对的 tool_use/tool_result + step_no=1
    const toolUseBlock: AgentContentBlock = { type: 'tool_use', id: 'tu1', name: 'get_recent_messages', input: { limit: 10 } };
    const toolResultBlock: AgentContentBlock = { type: 'tool_result', tool_use_id: 'tu1', content: '[]', is_error: false };
    {
      const c = await pool.connect();
      try {
        const repo = new AgentRunRepo(pool);
        await repo.appendMessage(c, runId, 'assistant', [toolUseBlock]);
        await repo.appendMessage(c, runId, 'user', [toolResultBlock]);
        await repo.insertStep(c, runId, 1, {
          kind: 'tool_use', toolUseId: 'tu1', name: 'get_recent_messages', input: { limit: 10 },
          resultSummary: '[]', isError: false, errorCode: null, auditVerdict: null, rawResponse: null,
        });
      } finally {
        c.release();
      }
    }

    // 续跑：agent 直接 finish → 应落 step_no=2，而不是从 1 重排撞唯一键
    const script: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'finish', input: { summary: 'done' } }] },
    ];
    const deps = makeDeps(new MockAgentClient(script));
    await runAgent(deps, runId);

    const run = await deps.agentRunRepo.getRun(pool, runId);
    expect(run?.status).toBe('finished');

    const steps = await deps.agentRunRepo.listSteps(pool, runId);
    expect(steps.map((s) => s.stepNo)).toEqual([1, 2]);
    expect(steps[1]?.kind).toBe('final');
  });

  // ---- F3：agentEnabled / unreachable → cancelled ----

  it('agentEnabled 关闭 → run cancelled', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const runId = await createRunningRun(groupId);
    // createRunningRun 会开启 agent_enabled，这里关闭
    await pool.query(`UPDATE groups SET agent_enabled = false WHERE id = $1`, [groupId]);

    const script: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'get_recent_messages', input: { limit: 10 } }] },
    ];
    const deps = makeDeps(new MockAgentClient(script));
    await runAgent(deps, runId);

    const run = await deps.agentRunRepo.getRun(pool, runId);
    expect(run?.status).toBe('cancelled');
    expect(run?.endReason).toBe('cancelled');
  });

  it('群 unreachable → run cancelled', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    await pool.query(`UPDATE groups SET status = 'unreachable' WHERE id = $1`, [groupId]);
    const runId = await createRunningRun(groupId);

    const script: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'get_recent_messages', input: { limit: 10 } }] },
    ];
    const deps = makeDeps(new MockAgentClient(script));
    await runAgent(deps, runId);

    const run = await deps.agentRunRepo.getRun(pool, runId);
    expect(run?.status).toBe('cancelled');
  });

  // ---- F3：重复 get_recent_messages ----

  it('连续第 2 次相同入参 get_recent_messages → INVALID_INPUT', async () => {
    const { groupId } = await seedGroupWithMember('acct-1');
    const runId = await createRunningRun(groupId);

    // 两次相同入参的 get_recent_messages，然后 finish
    const script: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'get_recent_messages', input: { limit: 10 } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'get_recent_messages', input: { limit: 10 } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu3', name: 'finish', input: { summary: 'done' } }] },
    ];
    const deps = makeDeps(new MockAgentClient(script));
    await runAgent(deps, runId);

    const steps = await deps.agentRunRepo.listSteps(pool, runId);
    // 第 1 次正常（无 errorCode），第 2 次 INVALID_INPUT
    expect(steps[0]?.isError).toBe(false);
    expect(steps[1]?.errorCode).toBe('INVALID_INPUT');
  });
});
