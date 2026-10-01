/**
 * Agent 运行详情页（页面 4，B4）。
 *
 * 展示 GET /api/agent-runs/:id：
 *   - run 状态 / endReason / 摘要 / 耗时
 *   - 每一步：stepNo、kind（工具调用 / 正常结束 / 协议错误）、工具名、
 *     入参（JSON）、结果摘要、审计结论、错误码、toolUseId
 *   - 协议错误步可展开查看 Agent 服务的原始响应体（rawResponse，≤2KB）
 *
 * 实时性：
 *   - running 的 run 每 2 秒轮询一次（保证步骤逐条出现）；
 *   - WS agent_run 事件（同 runId）立即刷新；终态后停止轮询。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useWebSocket } from '../api/useWebSocket';
import type { AgentRunDetailDto, AgentStepDto } from '../api/types';

const RUN_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  finished: '已完成',
  failed: '失败',
  blocked: '已阻塞',
  cancelled: '已取消',
};

const STEP_KIND_LABEL: Record<string, string> = {
  tool_use: '工具调用',
  final: '正常结束',
  protocol_error: '协议错误',
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/** 稳定渲染任意 JSON 入参；字符串/数字等原始值也能展示。 */
function formatJson(value: unknown): string {
  if (value === null) return '—';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 单个协议错误步（或任何带 rawResponse 的步）的原始响应体折叠块。 */
function RawResponseBlock({ raw }: { raw: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="raw-block">
      <button type="button" className="btn" onClick={() => setOpen((v) => !v)}>
        {open ? '收起原始响应体' : '查看原始响应体'}
      </button>
      {open && <pre className="json-pre raw-pre">{raw}</pre>}
    </div>
  );
}

/** 单个步骤卡片。 */
function StepCard({ step }: { step: AgentStepDto }): JSX.Element {
  const kindClass =
    step.kind === 'protocol_error' || step.isError ? 'step-card error' : 'step-card';
  return (
    <div className={kindClass}>
      <div className="step-head">
        <span className="step-no">#{step.stepNo}</span>
        <span className={`badge kind-${step.kind}`}>{STEP_KIND_LABEL[step.kind] ?? step.kind}</span>
        {step.name !== null && <span className="mono tool-name">{step.name}</span>}
        {step.isError && step.errorCode !== null && (
          <span className="badge error-code">{step.errorCode}</span>
        )}
        {step.auditVerdict !== null && (
          <span className={`badge audit-${step.auditVerdict}`}>
            审计：{step.auditVerdict === 'pass' ? '通过' : '拒绝'}
          </span>
        )}
      </div>

      <dl className="step-body">
        <dt>入参</dt>
        <dd>
          <pre className="json-pre">{formatJson(step.input)}</pre>
        </dd>

        {step.resultSummary !== null && (
          <>
            <dt>结果摘要</dt>
            <dd>{step.resultSummary}</dd>
          </>
        )}

        {step.toolUseId !== null && (
          <>
            <dt>tool_use_id</dt>
            <dd className="mono">{step.toolUseId}</dd>
          </>
        )}
      </dl>

      {step.rawResponse !== null && <RawResponseBlock raw={step.rawResponse} />}
    </div>
  );
}

export default function AgentRunDetailPage(): JSX.Element {
  const { id: runId = '' } = useParams();
  const [run, setRun] = useState<AgentRunDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 轮询定时器引用，run 进入终态后清掉
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const detail = await api<AgentRunDetailDto>(`/api/agent-runs/${runId}`);
      setRun(detail);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载 agent run 失败');
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  // running 时 2 秒轮询；终态停止
  useEffect(() => {
    if (run === null || run.status !== 'running') return;
    pollTimer.current = setTimeout(() => void load(), 2000);
    return () => {
      if (pollTimer.current !== null) clearTimeout(pollTimer.current);
    };
  }, [run, load]);

  // WS：本 run 状态变化立即刷新
  const onWsEvent = useCallback(
    (frame: { type: string; payload: Record<string, unknown> }) => {
      if (frame.type === 'agent_run' && frame.payload['runId'] === runId) {
        void load();
      }
    },
    [runId, load],
  );
  useWebSocket({ onEvent: onWsEvent, enabled: true });

  if (error !== null) {
    return (
      <div className="card">
        <p className="error-text">{error}</p>
        <p className="hint">
          <Link to="/groups">← 返回群列表</Link>
        </p>
      </div>
    );
  }

  if (run === null) {
    return (
      <div className="card">
        <p className="hint">加载中…</p>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h2>
          Agent 运行 <span className="mono">{run.id.slice(0, 8)}…</span>
        </h2>
        <p className="hint">
          <span className={`badge ${run.status}`}>{RUN_STATUS_LABEL[run.status] ?? run.status}</span>
          {'　'}
          结束原因：{run.endReason ?? '—'} · 开始：{formatTime(run.createdAt)} · 累计耗时：
          {(run.accumulatedMs / 1000).toFixed(1)}s
        </p>
        {run.summary !== null && (
          <p>
            <strong>摘要：</strong>
            {run.summary}
          </p>
        )}
        <p className="hint">
          <Link to={`/groups/${run.groupId}`}>← 返回群详情</Link>
        </p>
      </div>

      <div className="card">
        <h2>执行步骤（{run.steps.length}）</h2>
        {run.steps.map((s) => (
          <StepCard key={s.stepNo} step={s} />
        ))}
        {run.steps.length === 0 && <p className="hint">暂无步骤</p>}
      </div>
    </>
  );
}
