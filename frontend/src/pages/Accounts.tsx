/**
 * 账号列表页（页面 2）。
 *
 * - 显示状态徽标、platformUserId、限流到期时间
 * - 写操作按钮按状态机合法性出现（与后端转移表一致）：
 *     标记离线：online / rate_limited → disconnected
 *     重连：    idle / disconnected → online（走 connect 端点）
 *     释放账号：online / rate_limited → idle
 *   （终态 suspended / session_expired 无任何出边，不显示按钮）
 * - viewer 看不到任何写操作按钮（后端也会对写操作返回 403，双保险）
 * - WS 事件驱动实时刷新：account_status_changed / account_terminal
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type SessionInfo } from '../api/client';
import { useWebSocket } from '../api/useWebSocket';
import type { AccountDto, AccountStatus } from '../api/types';

const STATUS_LABEL: Record<AccountStatus, string> = {
  idle: '空闲',
  online: '在线',
  disconnected: '已离线',
  rate_limited: '限流中',
  suspended: '已停用',
  session_expired: '会话失效',
};

/** 与后端 domain/account-fsm.ts 转移表对齐的按钮显隐规则。 */
function visibleActions(status: AccountStatus): {
  markOffline: boolean;
  reconnect: boolean;
  release: boolean;
} {
  return {
    // 标记离线：online → disconnected；rate_limited → disconnected
    markOffline: status === 'online' || status === 'rate_limited',
    // 重连：idle / disconnected → online
    reconnect: status === 'idle' || status === 'disconnected',
    // 释放账号：online → idle；rate_limited 没有直达 idle 的出边，不显示
    release: status === 'online',
  };
}

interface Props {
  session: SessionInfo;
}

export default function AccountsPage({ session }: Props) {
  const [accounts, setAccounts] = useState<AccountDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const isAdmin = session.role === 'admin';

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await api<AccountDto[]>('/api/accounts');
      setAccounts(list);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 账号状态变化时实时刷新（替代轮询）
  const onWsEvent = useCallback(
    (frame: { type: string }) => {
      if (frame.type === 'account_status_changed' || frame.type === 'account_terminal') {
        void load();
      }
    },
    [load],
  );
  useWebSocket({ onEvent: onWsEvent, enabled: true });

  /** 写操作统一入口：乐观关按钮 → 调接口 → 无论成败都重拉列表。 */
  const runAction = async (
    accountId: string,
    action: () => Promise<unknown>,
  ): Promise<void> => {
    setPendingId(accountId);
    setError(null);
    try {
      await action();
    } catch (err) {
      // CAS_CONFLICT（并发改了状态）等错误展示给操作员，随后重拉以拿到最新状态
      setError(err instanceof ApiError ? `${err.message}（${err.code}）` : '操作失败');
    } finally {
      setPendingId(null);
      await load();
    }
  };

  const markOffline = (a: AccountDto): Promise<void> =>
    runAction(a.id, () =>
      api(`/api/accounts/${a.id}/transition`, {
        method: 'POST',
        body: { to: 'disconnected', expectedFrom: a.status },
      }),
    );

  const reconnect = (a: AccountDto): Promise<void> =>
    runAction(a.id, () => api(`/api/accounts/${a.id}/connect`, { method: 'POST' }));

  const release = (a: AccountDto): Promise<void> =>
    runAction(a.id, () =>
      api(`/api/accounts/${a.id}/transition`, {
        method: 'POST',
        body: { to: 'idle', expectedFrom: a.status },
      }),
    );

  return (
    <div className="card">
      <h2>账号列表</h2>
      {error !== null && <p className="error-text">{error}</p>}
      <table className="data">
        <thead>
          <tr>
            <th>账号 ID</th>
            <th>状态</th>
            <th>平台用户 ID</th>
            <th>限流至</th>
            {isAdmin && <th>操作</th>}
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => {
            const actions = visibleActions(a.status);
            const busy = pendingId === a.id;
            return (
              <tr key={a.id}>
                <td className="mono">{a.id}</td>
                <td>
                  <span className={`badge ${a.status}`}>{STATUS_LABEL[a.status]}</span>
                </td>
                <td className="mono">{a.platformUserId ?? '—'}</td>
                <td className="mono">
                  {a.rateLimitedUntil !== null
                    ? new Date(a.rateLimitedUntil).toLocaleTimeString()
                    : '—'}
                </td>
                {isAdmin && (
                  <td>
                    {actions.markOffline && (
                      <button
                        className="btn danger"
                        disabled={busy}
                        onClick={() => void markOffline(a)}
                      >
                        标记离线
                      </button>
                    )}
                    {actions.reconnect && (
                      <button className="btn" disabled={busy} onClick={() => void reconnect(a)}>
                        重连
                      </button>
                    )}
                    {actions.release && (
                      <button className="btn" disabled={busy} onClick={() => void release(a)}>
                        释放账号
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
          {accounts.length === 0 && (
            <tr>
              <td colSpan={isAdmin ? 5 : 4} className="hint">
                暂无账号
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
