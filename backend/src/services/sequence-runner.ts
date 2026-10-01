/**
 * 定时序列运行服务（规划 05 §3）。
 *
 * 职责：
 *   - 占位符解析：{key} 在发送时替换为 vars/stepVars 的值；
 *   - 预检：启动前检查所有步骤的占位符是否可解析（422 UNRESOLVED_PLACEHOLDER）；
 *   - 账号选择：admin 优先 creator/admin+online，member 取 role=member+online 字典序首；
 *   - 启动序列：创建 run + 写入所有步骤 + 排第 1 步；
 *   - 执行到期步骤：解析变量 → 选账号 → 入队 outbox → 标记 accepted。
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { SequenceRepo, SequenceStepDef } from '../repos/sequences.js';
import type { GroupRepo, GroupMemberRow } from '../repos/groups.js';
import type { AccountRepo } from '../repos/accounts.js';
import type { OutboxRepo } from '../repos/outbox.js';
import type { LoggerLike } from './gateway-client.js';

/** 占位符正则：{key}，key 匹配 [A-Za-z0-9_]+。 */
const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

export interface SequenceRunnerDeps {
  readonly pool: Pool;
  readonly sequenceRepo: SequenceRepo;
  readonly groupRepo: GroupRepo;
  readonly accountRepo: AccountRepo;
  readonly outboxRepo: OutboxRepo;
  readonly log: LoggerLike;
}

/** 预检失败信息。 */
export interface UnresolvedPlaceholder {
  readonly stepIndex: number;
  readonly key: string;
}

/** 单步解析结果：最终变量取值 + 来源。 */
export interface ResolvedStep {
  readonly text: string;
  readonly resolvedVars: Record<string, string>;
  readonly varSources: Record<string, string>;
}

/**
 * 提取文本中的所有占位符 key。
 */
export function extractPlaceholders(text: string): string[] {
  const keys = new Set<string>();
  let m: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    keys.add(m[1]!);
  }
  return [...keys];
}

/**
 * 计算黏性变量：遍历所有步骤，生成每步的最终取值与来源。
 *
 * 规则（规划 3.3）：
 *   - 初始值来自 vars；vars 里 "" 视为未提供。
 *   - stepVars[i] 给了值 → 从第 i 步起（含）用新值，直到更晚步骤再次给值。
 *   - stepVars[i] 里 "" → 这一步不改。
 *   - 沿用前面某步的值时，varSources 标最初给出它的那一步。
 */
export function computeStickyVars(
  steps: SequenceStepDef[],
  vars: Record<string, string>,
  stepVars: Record<string, Record<string, string>>,
): Array<{ resolvedVars: Record<string, string>; varSources: Record<string, string> }> {
  // 当前有效取值
  const current: Record<string, string> = {};
  // 每个 key 的来源（default 或 step:<index>）
  const sources: Record<string, string> = {};

  // 初始化：vars 里非空的值
  for (const [k, v] of Object.entries(vars)) {
    if (v !== '') {
      current[k] = v;
      sources[k] = 'default';
    }
  }

  const result: Array<{ resolvedVars: Record<string, string>; varSources: Record<string, string> }> = [];

  for (let i = 0; i < steps.length; i++) {
    const sv = stepVars[String(i)] ?? {};
    // 本步给的非空值覆盖（黏性）
    for (const [k, v] of Object.entries(sv)) {
      if (v !== '') {
        current[k] = v;
        // 沿用前面某步的值时，标最初给出它的那一步 → 只在第一次设置时记录来源
        if (sources[k] === undefined || sources[k] === 'default') {
          sources[k] = `step:${i}`;
        }
      }
    }
    result.push({
      resolvedVars: { ...current },
      varSources: { ...sources },
    });
  }

  return result;
}

/**
 * 预检所有步骤的占位符是否可解析。
 * 返回第一个不可解析的占位符（stepIndex, key），全部可解析返回 null。
 */
export function preflight(
  steps: SequenceStepDef[],
  vars: Record<string, string>,
  stepVars: Record<string, Record<string, string>>,
): UnresolvedPlaceholder | null {
  const sticky = computeStickyVars(steps, vars, stepVars);
  for (let i = 0; i < steps.length; i++) {
    const keys = extractPlaceholders(steps[i]!.text);
    for (const key of keys) {
      if (sticky[i]!.resolvedVars[key] === undefined) {
        return { stepIndex: i, key };
      }
    }
  }
  return null;
}

/** 用变量解析文本中的占位符。 */
export function resolveText(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (_, key: string) => vars[key] ?? `{${key}}`);
}

/**
 * 账号选择（规划 3.2）。
 *   - admin: role ∈ {creator, admin} 且 online，优先 admin；
 *   - member: role = member 且 online，按 accountId 字典序首。
 * 返回 undefined 表示没有匹配账号（→ skipped）。
 * rate_limited 的账号返回 null 表示需顺延（不算没有）。
 */
export function selectAccount(
  members: GroupMemberRow[],
  accounts: Array<{ id: string; accountId: string; status: string; rateLimitedUntil: Date | null }>,
  role: 'admin' | 'member',
):
  | { kind: 'found'; accountId: string }
  | { kind: 'rate_limited' }
  | { kind: 'none' } {
  const byId = new Map(accounts.map((a) => [a.id, a]));

  if (role === 'admin') {
    const eligible = members.filter((m) => m.role === 'creator' || m.role === 'admin');
    const found: Array<{ member: GroupMemberRow; account: (typeof accounts)[number] }> = [];
    for (const m of eligible) {
      const a = byId.get(m.accountId);
      if (a !== undefined) found.push({ member: m, account: a });
    }
    // 优先 admin，其次 creator
    found.sort((a, b) => {
      const ra = a.member.role === 'admin' ? 0 : 1;
      const rb = b.member.role === 'admin' ? 0 : 1;
      return ra - rb;
    });
    for (const { account } of found) {
      if (account.status === 'online') return { kind: 'found', accountId: account.id };
      if (account.status === 'rate_limited') return { kind: 'rate_limited' };
    }
    return { kind: 'none' };
  }

  // member
  const eligible = members.filter((m) => m.role === 'member');
  const withAccounts = eligible
    .map((m) => ({ member: m, account: byId.get(m.accountId) }))
    .filter((x): x is { member: GroupMemberRow; account: (typeof accounts)[number] } => x.account !== undefined)
    .sort((a, b) => a.account.accountId.localeCompare(b.account.accountId));

  for (const { account } of withAccounts) {
    if (account.status === 'online') return { kind: 'found', accountId: account.id };
    if (account.status === 'rate_limited') return { kind: 'rate_limited' };
  }
  return { kind: 'none' };
}

/**
 * 启动一个序列运行（规划 3.1 / 3.3 / 3.4）。
 *
 * 流程：
 *   1. 预检：占位符不可解析 → 抛 UnresolvedPlaceholderError（路由层转 422）。
 *   2. 创建 run（同群已有 running → 抛 AlreadyRunningError，路由层转 409）。
 *   3. 写入所有步骤，第 1 步 scheduled_at = now + delaySeconds，其余 null。
 */
export async function startSequenceRun(
  deps: SequenceRunnerDeps,
  groupId: string,
  sequenceId: string,
  vars: Record<string, string>,
  stepVars: Record<string, Record<string, string>>,
): Promise<string> {
  const client = await deps.pool.connect();
  try {
    const sequence = await deps.sequenceRepo.getSequence(client, sequenceId);
    if (sequence === undefined) {
      throw new Error(`SEQUENCE_NOT_FOUND: ${sequenceId}`);
    }

    // 预检
    const unresolved = preflight(sequence.steps, vars, stepVars);
    if (unresolved !== null) {
      const err = new Error(`UNRESOLVED_PLACEHOLDER: step ${unresolved.stepIndex} key ${unresolved.key}`) as Error & {
        stepIndex: number;
        key: string;
      };
      err.stepIndex = unresolved.stepIndex;
      err.key = unresolved.key;
      throw err;
    }

    await client.query('BEGIN');
    try {
      // 创建 run（同群已有 running → 唯一索引冲突 → null）
      const run = await deps.sequenceRepo.createRun(client, groupId, sequenceId, vars, stepVars);
      if (run === null) {
        await client.query('ROLLBACK');
        throw new Error('SEQUENCE_ALREADY_RUNNING');
      }

      // 写入所有步骤：第 1 步排期，其余待定
      const now = Date.now();
      const stepInserts = sequence.steps.map((s, i) => ({
        stepIndex: i,
        scheduledAt: i === 0 ? new Date(now + s.delaySeconds * 1000) : null,
      }));
      await deps.sequenceRepo.insertSteps(client, run.id, stepInserts);

      await client.query('COMMIT');
      deps.log.info({ runId: run.id, groupId, steps: sequence.steps.length }, 'sequence: run started');
      return run.id;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * 执行一个到期的 pending 步骤（规划 3.2 / 3.4）。
 *
 * 流程：
 *   1. 解析变量（黏性）；
 *   2. 账号选择：
 *      - found → 入队 outbox，标记 accepted；
 *      - rate_limited → 顺延（不更新状态，下次 tick 再试）；
 *      - none → 标记 skipped，排下一步。
 */
export async function executeDueStep(
  deps: SequenceRunnerDeps,
  runId: string,
  stepIndex: number,
): Promise<void> {
  const client = await deps.pool.connect();
  try {
    const run = await deps.sequenceRepo.getRun(client, runId);
    if (run === undefined || run.status !== 'running') return;

    const sequence = await deps.sequenceRepo.getSequence(client, run.sequenceId);
    if (sequence === undefined) return;

    const stepDef = sequence.steps[stepIndex];
    if (stepDef === undefined) return;

    // 计算黏性变量
    const sticky = computeStickyVars(sequence.steps, run.vars, run.stepVars);
    const { resolvedVars, varSources } = sticky[stepIndex]!;
    const text = resolveText(stepDef.text, resolvedVars);

    // 账号选择
    const members = await deps.groupRepo.listMembers(run.groupId);
    const accounts = await deps.accountRepo.findByUuids(members.map((m) => m.accountId));
    const sel = selectAccount(members, accounts, stepDef.accountRole);

    await client.query('BEGIN');
    try {
      if (sel.kind === 'rate_limited') {
        // 顺延：不更新状态，下次 tick 再试（scheduled_at 已 <= now）
        await client.query('ROLLBACK');
        return;
      }

      if (sel.kind === 'none') {
        // skipped
        await deps.sequenceRepo.markStepSkipped(client, runId, stepIndex);
        await scheduleNextStep(deps.sequenceRepo, client, runId, sequence.steps, stepIndex, new Date());
        await client.query('COMMIT');
        deps.log.info({ runId, stepIndex }, 'sequence: step skipped（无可用账号）');
        return;
      }

      // found → 入队 outbox
      const clientMsgId = randomUUID();
      const outbox = await deps.outboxRepo.enqueue(client, {
        groupId: run.groupId,
        accountId: sel.accountId,
        clientMsgId,
        text,
        origin: 'sequence',
      });
      await deps.sequenceRepo.markStepAccepted(client, runId, stepIndex, outbox.id, resolvedVars, varSources);
      await client.query('COMMIT');
      deps.log.info({ runId, stepIndex, outboxId: outbox.id }, 'sequence: step accepted（已入队）');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * 排下一步：第 n 步在第 n-1 步"发出"后 delaySeconds 秒发送。
 * skipped 步骤视为在跳过时刻"发出"。
 * 若已是最后一步 → finish run。
 */
export async function scheduleNextStep(
  sequenceRepo: SequenceRepo,
  client: PoolClient,
  runId: string,
  steps: SequenceStepDef[],
  currentStepIndex: number,
  sentAt: Date,
): Promise<void> {
  const nextIndex = currentStepIndex + 1;
  if (nextIndex >= steps.length) {
    await sequenceRepo.finishRun(client, runId, 'finished');
    return;
  }
  const nextDelay = steps[nextIndex]!.delaySeconds * 1000;
  const scheduledAt = new Date(sentAt.getTime() + nextDelay);
  await sequenceRepo.scheduleStep(client, runId, nextIndex, scheduledAt);
  await sequenceRepo.advanceCurrentStep(client, runId, nextIndex);
}
