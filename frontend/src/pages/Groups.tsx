/**
 * 群列表页（导航用）：列出所有群，点击进入群详情（页面 3）。
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { GroupSummaryDto } from '../api/types';

const GROUP_STATUS_LABEL: Record<string, string> = {
  active: '正常',
  unreachable: '不可达',
  left: '已退群',
};

export default function GroupsPage() {
  const [groups, setGroups] = useState<GroupSummaryDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<GroupSummaryDto[]>('/api/groups')
      .then(setGroups)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : '加载失败');
      });
  }, []);

  return (
    <div className="card">
      <h2>群列表</h2>
      {error !== null && <p className="error-text">{error}</p>}
      <table className="data">
        <thead>
          <tr>
            <th>群 ID</th>
            <th>状态</th>
            <th>Agent</th>
            <th>自动移除</th>
            <th>创建时间</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.id}>
              <td>
                <Link to={`/groups/${g.id}`} className="mono">
                  {g.id}
                </Link>
              </td>
              <td>{GROUP_STATUS_LABEL[g.status] ?? g.status}</td>
              <td>{g.agentEnabled ? '开' : '关'}</td>
              <td>{g.autoKickEnabled ? '开' : '关'}</td>
              <td className="mono">{new Date(g.createdAt).toLocaleString()}</td>
            </tr>
          ))}
          {groups.length === 0 && (
            <tr>
              <td colSpan={5} className="hint">
                暂无群
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
