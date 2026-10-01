/**
 * 群详情页（页面 3）。
 *
 * 三个区块：
 *   1. 群信息 + 成员列表（含 role）
 *   2. 消息时间线：升序展示（新消息在底部）；"加载更早"游标分页；
 *      WS 实时追加；自己的消息显示 deliveryStatus
 *   3. 该群最近的 agent run 列表（status、endReason），blocked 行醒目提示
 *
 * 实时性：WS 事件驱动。
 *   - message（本群）        → 重拉最新一页消息并合并（去重）
 *   - agent_run（本群）      → 重拉 run 列表
 *   - 断线重连由 useWebSocket 内部用 sinceSeq 补发，不丢事件
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, type SessionInfo } from '../api/client';
import { useWebSocket } from '../api/useWebSocket';
import type {
  AgentRunListItemDto,
  GroupDetailDto,
  TimelineItemDto,
  TimelinePageDto,
} from '../api/types';

/** 消息去重键：网关消息用 msgId；尚未落地的出站消息用 clientMsgId。 */
function messageKey(m: TimelineItemDto): string {
  if (m.msgId !== null) return `msg:${m.msgId}`;
  if (m.clientMsgId !== null) return `client:${m.clientMsgId}`;
  return `anon:${m.senderPlatformUserId}:${m.sentAt}:${m.text.slice(0, 16)}`;
}

const DELIVERY_LABEL: Record<string, string> = {
  queued: '排队中',
  accepted: '已受理',
  sent: '已发出',
  failed: '发送失败',
  unknown: '状态未知',
  cancelled: '已取消',
};

const ROLE_LABEL: Record<string, string> = {
  creator: '群主',
  admin: '管理员',
  member: '成员',
};

const RUN_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  finished: '已完成',
  failed: '失败',
  blocked: '已阻塞',
  cancelled: '已取消',
};

const GROUP_STATUS_LABEL: Record<string, string> = {
  active: '正常',
  unreachable: '不可达',
  left: '已退群',
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
}

interface Props {
  session: SessionInfo;
}

export default function GroupDetailPage({ session }: Props) {
  const { id: groupId = '' } = useParams();
  const [group, setGroup] = useState<GroupDetailDto | null>(null);
  // messages 按 sentAt 升序（渲染顺序：旧 → 新）
  const [messages, setMessages] = useState<TimelineItemDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [runs, setRuns] = useState<AgentRunListItemDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const isAdmin = session.role === 'admin';

  // ---- 数据加载 ----

  const loadGroup = useCallback(async (): Promise<void> => {
    try {
      setGroup(await api<GroupDetailDto>(`/api/groups/${groupId}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载群信息失败');
    }
  }, [groupId]);

  /** 把一页（API 返回为倒序）合并进升序列表，按 key 去重，新数据覆盖旧数据。 */
  const mergePage = useCallback((page: TimelinePageDto, prepend: boolean) => {
    setMessages((prev) => {
      const incoming = [...page.items].reverse(); // → 升序
      const map = new Map<string, TimelineItemDto>();
      // prepend（加载更早）时旧数据优先保留在右侧；refresh 时新数据覆盖
      const base = prepend ? incoming : prev;
      const over = prepend ? prev : incoming;
      for (const m of base) map.set(messageKey(m), m);
      for (const m of over) map.set(messageKey(m), m);
      return [...map.values()].sort((a, b) => {
        const t = Date.parse(a.sentAt) - Date.parse(b.sentAt);
        if (t !== 0) return t;
        // 同一毫秒可能多条：用 msgId 字典序兜底，保证渲染稳定
        return (a.msgId ?? '').localeCompare(b.msgId ?? '');
      });
    });
  }, []);

  /** 拉最新一页（WS 提示有新消息 / 自己消息状态变化时调用）。 */
  const refreshLatest = useCallback(async (): Promise<void> => {
    try {
      const page = await api<TimelinePageDto>(
        `/api/groups/${groupId}/messages?limit=50`,
      );
      mergePage(page, false);
      // 仅在还没有游标时（首屏）初始化 nextCursor
      setNextCursor((cur) => cur ?? page.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载消息失败');
    }
  }, [groupId, mergePage]);

  const loadEarlier = async (): Promise<void> => {
    if (nextCursor === null || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await api<TimelinePageDto>(
        `/api/groups/${groupId}/messages?limit=50&before=${encodeURIComponent(nextCursor)}`,
      );
      mergePage(page, true);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载更早消息失败');
    } finally {
      setLoadingEarlier(false);
    }
  };

  const loadRuns = useCallback(async (): Promise<void> => {
    try {
      setRuns(await api<AgentRunListItemDto[]>(`/api/groups/${groupId}/agent-runs`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载 agent run 失败');
    }
  }, [groupId]);

  useEffect(() => {
    setMessages([]);
    setNextCursor(null);
    void loadGroup();
    void refreshLatest();
    void loadRuns();
  }, [loadGroup, refreshLatest, loadRuns]);

  // ---- WS 实时刷新 ----
  const onWsEvent = useCallback(
    (frame: { type: string; payload: Record<string, unknown> }) => {
      if (frame.type === 'message' && frame.payload['groupId'] === groupId) {
        void refreshLatest();
      }
      if (frame.type === 'agent_run' && frame.payload['groupId'] === groupId) {
        void loadRuns();
      }
    },
    [groupId, refreshLatest, loadRuns],
  );
  useWebSocket({ onEvent: onWsEvent, enabled: true });

  if (group === null) {
    return (
      <div className="card">
        {error !== null ? <p className="error-text">{error}</p> : <p className="hint">加载中…</p>}
      </div>
    );
  }

  return (
    <>
      {/* ---- 群信息 + 成员 ---- */}
      <div className="card">
        <h2>
          群 <span className="mono">{group.id.slice(0, 8)}…</span>（
          {GROUP_STATUS_LABEL[group.status] ?? group.status}）
        </h2>
        <p className="hint">
          Agent：{group.agentEnabled ? '开' : '关'} · 自动移除：
          {group.autoKickEnabled ? '开' : '关'} · 网关群 ID：
          <span className="mono">{group.gatewayGroupId}</span>
          {group.activeRunId !== null && (
            <>
              {' '}
              · 活动 run：<span className="mono">{group.activeRunId.slice(0, 8)}…</span>
            </>
          )}
        </p>
        <table className="data">
          <thead>
            <tr>
              <th>平台用户 ID</th>
              <th>角色</th>
              <th>账号 ID</th>
              <th>入群时间</th>
            </tr>
          </thead>
          <tbody>
            {group.members.map((m) => (
              <tr key={m.platformUserId}>
                <td className="mono">{m.platformUserId}</td>
                <td>{ROLE_LABEL[m.role] ?? m.role}</td>
                <td className="mono">{m.accountId ?? '（外部用户）'}</td>
                <td className="mono">{formatTime(m.joinedAt)}</td>
              </tr>
            ))}
            {group.members.length === 0 && (
              <tr>
                <td colSpan={4} className="hint">
                  暂无成员
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ---- 消息时间线 ---- */}
      <div className="card">
        <h2>消息时间线</h2>
        {error !== null && <p className="error-text">{error}</p>}
        {nextCursor !== null && (
          <button className="btn" disabled={loadingEarlier} onClick={() => void loadEarlier()}>
            {loadingEarlier ? '加载中…' : '加载更早'}
          </button>
        )}
        <div className="timeline">
          {messages.map((m) => (
            <div key={messageKey(m)} className={m.isOwn ? 'msg own' : 'msg'}>
              <div className="meta">
                <span className="mono">{formatTime(m.sentAt)}</span>{' '}
                <span className="mono">{m.senderPlatformUserId}</span>
                {m.isOwn && m.deliveryStatus !== null && (
                  <>
                    {' '}
                    · {DELIVERY_LABEL[m.deliveryStatus] ?? m.deliveryStatus}
                    {m.failCode !== null && <span className="error-text">（{m.failCode}）</span>}
                  </>
                )}
              </div>
              <div className="text">{m.text}</div>
            </div>
          ))}
          {messages.length === 0 && <p className="hint">暂无消息</p>}
        </div>
      </div>

      {/* ---- Agent run 列表 ---- */}
      <div className="card">
        <h2>最近的 Agent 运行</h2>
        <table className="data">
          <thead>
            <tr>
              <th>Run ID</th>
              <th>状态</th>
              <th>结束原因</th>
              <th>摘要</th>
              <th>开始时间</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className={r.status === 'blocked' ? 'row-blocked' : undefined}>
                <td className="mono">{r.id.slice(0, 8)}…</td>
                <td>
                  <span className={`badge ${r.status}`}>
                    {RUN_STATUS_LABEL[r.status] ?? r.status}
                  </span>
                </td>
                <td className="mono">{r.endReason ?? '—'}</td>
                <td>{r.summary ?? '—'}</td>
                <td className="mono">{formatTime(r.createdAt)}</td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan={5} className="hint">
                  暂无运行记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {!isAdmin && <p className="hint">只读模式：写操作按钮已隐藏。</p>}
        <p className="hint">
          <Link to="/groups">← 返回群列表</Link>
        </p>
      </div>
    </>
  );
}
