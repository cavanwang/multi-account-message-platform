/**
 * 序列运行页（页面 5，B4）。
 *
 * 流程（§4 页面 5）：
 *   选序列 → 填 vars（默认值）与 stepVars（按步覆盖）→ 预检弹窗
 *   （每步每个占位符 key 的最终取值与来源 default/step:n + 解析后文本）
 *   → 确认启动；运行中显示每步进度（状态/排期/发出时间/取值/来源）。
 *   预检不通过：显示 stepIndex 与 key（页面上换算成 1 基"第 N 步"）。
 *
 * 约定：后端 stepIndex/stepVars 的键为 0 基（与 GET /api/sequence-runs/:id 一致），
 * 页面展示统一 +1 显示为"第 N 步"。
 *
 * 实时性：running 的 run 每 1.5s 轮询；WS sequence_run 事件立即刷新。
 * viewer 只读：预检/启动按钮隐藏（后端 POST 也会 403）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, type SessionInfo } from '../api/client';
import { useWebSocket } from '../api/useWebSocket';
import type {
  PrecheckResultDto,
  SequenceDto,
  SequenceRunDetailDto,
  SequenceRunListItemDto,
  SequenceRunStepDto,
} from '../api/types';

/** 与后端 PLACEHOLDER_RE 一致：{key}，key 匹配 [A-Za-z0-9_]+。 */
const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

function extractPlaceholders(text: string): string[] {
  const keys = new Set<string>();
  let m: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) keys.add(m[1]!);
  return [...keys];
}

const RUN_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  finished: '已完成',
  failed: '失败',
  stopped: '已停止',
};

const STEP_STATUS_LABEL: Record<string, string> = {
  pending: '等待中',
  accepted: '已受理',
  sent: '已发出',
  skipped: '已跳过',
  failed: '失败',
};

const ROLE_LABEL: Record<string, string> = { admin: '管理员', member: '成员' };

function formatTime(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
}

interface Props {
  session: SessionInfo;
}

// ---------------------------------------------------------------------------
// 运行进度面板
// ---------------------------------------------------------------------------

function RunProgress({
  runId,
  onLoaded,
}: {
  runId: string;
  onLoaded?: (run: SequenceRunDetailDto) => void;
}): JSX.Element {
  const [run, setRun] = useState<SequenceRunDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const detail = await api<SequenceRunDetailDto>(`/api/sequence-runs/${runId}`);
      setRun(detail);
      setError(null);
      onLoaded?.(detail);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载运行详情失败');
    }
  }, [runId, onLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  // running 时轮询；终态停止
  useEffect(() => {
    if (run === null || run.status !== 'running') return;
    const timer = setTimeout(() => void load(), 1500);
    return () => clearTimeout(timer);
  }, [run, load]);

  // WS：本 run 进度/终态变化立即刷新
  const onWsEvent = useCallback(
    (frame: { type: string; payload: Record<string, unknown> }) => {
      if (frame.type === 'sequence_run' && frame.payload['runId'] === runId) {
        void load();
      }
    },
    [runId, load],
  );
  useWebSocket({ onEvent: onWsEvent, enabled: true });

  if (error !== null) return <p className="error-text">{error}</p>;
  if (run === null) return <p className="hint">加载中…</p>;

  const total = run.steps.length;
  const current = run.currentStepIndex + 1;

  return (
    <div className="run-panel">
      <p>
        <span className={`badge ${run.status}`}>{RUN_STATUS_LABEL[run.status] ?? run.status}</span>
        {'　'}
        {run.status === 'running' ? `进度：第 ${current} / ${total} 步` : `共 ${total} 步`}
        {'　'}
        <span className="mono">run: {run.id.slice(0, 8)}…</span>
      </p>
      <table className="data">
        <thead>
          <tr>
            <th>步骤</th>
            <th>状态</th>
            <th>排期时间</th>
            <th>发出时间</th>
            <th>取值与来源</th>
          </tr>
        </thead>
        <tbody>
          {run.steps.map((s: SequenceRunStepDto) => (
            <tr key={s.stepIndex} className={s.stepIndex === run.currentStepIndex && run.status === 'running' ? 'row-current' : undefined}>
              <td>第 {s.stepIndex + 1} 步</td>
              <td>
                <span className={`badge step-${s.status}`}>{STEP_STATUS_LABEL[s.status] ?? s.status}</span>
              </td>
              <td className="mono">{formatTime(s.scheduledAt)}</td>
              <td className="mono">{formatTime(s.sentAt)}</td>
              <td className="vars-cell">
                {s.resolvedVars !== null &&
                  Object.entries(s.resolvedVars).map(([k, v]) => (
                    <span key={k} className="var-chip">
                      {k}={v}
                      <em className="var-source">{s.varSources?.[k] ?? ''}</em>
                    </span>
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 预检弹窗
// ---------------------------------------------------------------------------

function PrecheckDialog({
  result,
  busy,
  onCancel,
  onConfirm,
}: {
  result: PrecheckResultDto;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal">
        <h2>预检结果：{result.name}</h2>
        <p className="hint">
          每个占位符的最终取值与来源（default = 启动 vars；step:n = 第 n+1 步给出并沿用）。确认后才会真正启动。
        </p>
        <table className="data">
          <thead>
            <tr>
              <th>步骤</th>
              <th>角色/延迟</th>
              <th>模板 → 解析后文本</th>
              <th>本步占位符取值</th>
            </tr>
          </thead>
          <tbody>
            {result.steps.map((s) => {
              const usedKeys = extractPlaceholders(s.text);
              return (
                <tr key={s.stepIndex}>
                  <td>第 {s.stepIndex + 1} 步</td>
                  <td>
                    {ROLE_LABEL[s.accountRole] ?? s.accountRole} · {s.delaySeconds}s
                  </td>
                  <td>
                    <div className="hint">{s.text}</div>
                    <div>→ {s.resolvedText}</div>
                  </td>
                  <td>
                    {usedKeys.map((k) => (
                      <span key={k} className="var-chip">
                        {k}={s.resolvedVars[k] ?? ''}
                        <em className="var-source">{s.varSources[k] ?? ''}</em>
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={onConfirm} disabled={busy}>
            {busy ? '启动中…' : '确认启动'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 主页面
// ---------------------------------------------------------------------------

export default function SequencePage({ session }: Props): JSX.Element {
  const { id: groupId = '' } = useParams();
  const isAdmin = session.role === 'admin';

  const [sequences, setSequences] = useState<SequenceDto[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [varsMap, setVarsMap] = useState<Record<string, string>>({});
  // 按步覆盖：stepOverrides[0 基 stepIndex][key] = 值（空串=这一步不改）
  const [stepOverrides, setStepOverrides] = useState<Record<number, Record<string, string>>>({});
  const [precheck, setPrecheck] = useState<PrecheckResultDto | null>(null);
  const [unresolved, setUnresolved] = useState<{ stepIndex: number; key: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [recentRuns, setRecentRuns] = useState<SequenceRunListItemDto[]>([]);

  const selected = useMemo(
    () => sequences.find((s) => s.id === selectedId) ?? null,
    [sequences, selectedId],
  );

  // 该序列所有步骤出现过的占位符 key（并集，去重，按首次出现顺序）
  const allKeys = useMemo(() => {
    if (selected === null) return [];
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const step of selected.steps) {
      for (const k of extractPlaceholders(step.text)) {
        if (!seen.has(k)) {
          seen.add(k);
          ordered.push(k);
        }
      }
    }
    return ordered;
  }, [selected]);

  /** 组装后端入参（空串值不放入 stepVars，语义=不覆盖；vars 空串后端视为未提供）。 */
  const buildPayload = useCallback(() => {
    const stepVars: Record<string, Record<string, string>> = {};
    for (const [idxStr, kvs] of Object.entries(stepOverrides)) {
      const nonEmpty = Object.fromEntries(Object.entries(kvs).filter(([, v]) => v !== ''));
      if (Object.keys(nonEmpty).length > 0) stepVars[idxStr] = nonEmpty;
    }
    return { sequenceId: selectedId, vars: varsMap, stepVars };
  }, [selectedId, varsMap, stepOverrides]);

  const loadRecentRuns = useCallback(async (): Promise<void> => {
    try {
      setRecentRuns(
        await api<SequenceRunListItemDto[]>(`/api/groups/${groupId}/sequence-runs`),
      );
    } catch {
      // 列表加载失败不阻塞主表单
    }
  }, [groupId]);

  useEffect(() => {
    void api<SequenceDto[]>('/api/sequences')
      .then((list) => {
        setSequences(list);
        if (list.length > 0) setSelectedId(list[0]!.id);
      })
      .catch(() => undefined);
    void loadRecentRuns();
  }, [loadRecentRuns]);

  // 切换序列：重置所有表单状态
  const handleSelect = (id: string): void => {
    setSelectedId(id);
    setVarsMap({});
    setStepOverrides({});
    setPrecheck(null);
    setUnresolved(null);
    setFormError(null);
  };

  const setVar = (key: string, value: string): void => {
    setVarsMap((prev) => ({ ...prev, [key]: value }));
  };

  const setOverride = (stepIndex: number, key: string, value: string): void => {
    setStepOverrides((prev) => ({
      ...prev,
      [stepIndex]: { ...(prev[stepIndex] ?? {}), [key]: value },
    }));
  };

  const handlePrecheck = async (): Promise<void> => {
    setBusy(true);
    setFormError(null);
    setUnresolved(null);
    try {
      const result = await api<PrecheckResultDto>('/api/sequences/precheck', {
        method: 'POST',
        body: buildPayload(),
      });
      setPrecheck(result);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'UNRESOLVED_PLACEHOLDER') {
        const d = err.body?.error;
        setUnresolved({
          stepIndex: Number(d?.['stepIndex'] ?? 0),
          key: String(d?.['key'] ?? ''),
        });
      } else {
        setFormError(err instanceof ApiError ? err.message : '预检失败');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleStart = async (): Promise<void> => {
    setBusy(true);
    setFormError(null);
    try {
      const { runId } = await api<{ runId: string }>(
        `/api/groups/${groupId}/sequence-runs`,
        { method: 'POST', body: buildPayload() },
      );
      setPrecheck(null);
      setActiveRunId(runId);
      await loadRecentRuns();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : '启动失败');
    } finally {
      setBusy(false);
    }
  };

  // WS：本群任意序列状态变化 → 刷新最近运行列表；活动 run 由 RunProgress 自己监听
  const onWsEvent = useCallback(
    (frame: { type: string; payload: Record<string, unknown> }) => {
      if (frame.type === 'sequence_run' && frame.payload['groupId'] === groupId) {
        void loadRecentRuns();
      }
    },
    [groupId, loadRecentRuns],
  );
  useWebSocket({ onEvent: onWsEvent, enabled: true });

  return (
    <>
      <div className="card">
        <h2>序列运行</h2>
        <p className="hint">
          <Link to={`/groups/${groupId}`}>← 返回群详情</Link>
        </p>

        <label className="form-label" htmlFor="seq-select">
          选择序列
        </label>
        <select
          id="seq-select"
          className="input"
          value={selectedId}
          onChange={(e) => handleSelect(e.target.value)}
        >
          {sequences.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}（{s.steps.length} 步）
            </option>
          ))}
          {sequences.length === 0 && <option value="">（暂无序列模板）</option>}
        </select>

        {selected !== null && (
          <>
            {/* 序列步骤预览 */}
            <table className="data" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>步骤</th>
                  <th>角色</th>
                  <th>延迟(s)</th>
                  <th>文本模板</th>
                </tr>
              </thead>
              <tbody>
                {selected.steps.map((s, i) => (
                  <tr key={i}>
                    <td>第 {i + 1} 步</td>
                    <td>{ROLE_LABEL[s.accountRole] ?? s.accountRole}</td>
                    <td>{s.delaySeconds}</td>
                    <td>{s.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* vars 默认值 */}
            <h3 className="form-section">变量默认值（vars）</h3>
            {allKeys.length === 0 && <p className="hint">该序列没有占位符。</p>}
            <div className="kv-grid">
              {allKeys.map((k) => (
                <label key={k} className="kv-row">
                  <span className="mono">{'{'}{k}{'}'}</span>
                  <input
                    className="input"
                    value={varsMap[k] ?? ''}
                    onChange={(e) => setVar(k, e.target.value)}
                    placeholder="默认值"
                  />
                </label>
              ))}
            </div>

            {/* stepVars 按步覆盖：只列出现在该步文本里的 key */}
            <h3 className="form-section">按步覆盖（stepVars，留空=不覆盖）</h3>
            {selected.steps.map((step, i) => {
              const keys = extractPlaceholders(step.text);
              if (keys.length === 0) {
                return (
                  <p key={i} className="hint">
                    第 {i + 1} 步：无占位符
                  </p>
                );
              }
              return (
                <div key={i} className="step-override">
                  <div className="hint">第 {i + 1} 步：{step.text}</div>
                  <div className="kv-grid">
                    {keys.map((k) => (
                      <label key={k} className="kv-row">
                        <span className="mono">{'{'}{k}{'}'}</span>
                        <input
                          className="input"
                          value={stepOverrides[i]?.[k] ?? ''}
                          onChange={(e) => setOverride(i, k, e.target.value)}
                          placeholder="本步起覆盖"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}

            {unresolved !== null && (
              <p className="error-text">
                预检不通过：第 {unresolved.stepIndex + 1} 步（stepIndex={unresolved.stepIndex}）的占位符{' '}
                {'{'}{unresolved.key}{'}'} 无法解析，请补充变量值。
              </p>
            )}
            {formError !== null && <p className="error-text">{formError}</p>}

            {isAdmin ? (
              <div style={{ marginTop: 12 }}>
                <button type="button" className="btn primary" onClick={() => void handlePrecheck()} disabled={busy}>
                  {busy ? '处理中…' : '预检'}
                </button>
              </div>
            ) : (
              <p className="hint" style={{ marginTop: 12 }}>
                只读模式：预检与启动按钮已隐藏。
              </p>
            )}
          </>
        )}
      </div>

      {/* 运行进度 */}
      {activeRunId !== null && (
        <div className="card">
          <h2>当前运行</h2>
          <RunProgress runId={activeRunId} onLoaded={() => void loadRecentRuns()} />
        </div>
      )}

      {/* 最近运行 */}
      <div className="card">
        <h2>本群最近的序列运行</h2>
        <table className="data">
          <thead>
            <tr>
              <th>Run ID</th>
              <th>状态</th>
              <th>当前步骤</th>
              <th>开始时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {recentRuns.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.id.slice(0, 8)}…</td>
                <td>
                  <span className={`badge ${r.status}`}>{RUN_STATUS_LABEL[r.status] ?? r.status}</span>
                </td>
                <td>
                  {r.status === 'running' ? `第 ${r.currentStepIndex + 1} 步` : '—'}
                </td>
                <td className="mono">{formatTime(r.createdAt)}</td>
                <td>
                  <button type="button" className="btn" onClick={() => setActiveRunId(r.id)}>
                    查看
                  </button>
                </td>
              </tr>
            ))}
            {recentRuns.length === 0 && (
              <tr>
                <td colSpan={5} className="hint">
                  暂无运行记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {precheck !== null && (
        <PrecheckDialog
          result={precheck}
          busy={busy}
          onCancel={() => setPrecheck(null)}
          onConfirm={() => void handleStart()}
        />
      )}
    </>
  );
}
