/**
 * 应用骨架：会话恢复、路由、布局（侧边导航）。
 *
 * 路由：
 *   /login        登录页（未登录）
 *   /accounts     账号列表（页面 2）
 *   /groups       群列表（导航用，便于进入群详情）
 *   /groups/:id   群详情（页面 3）
 */
import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import {
  getSessionInfo,
  logout,
  restoreSession,
  setOnSessionExpired,
  type SessionInfo,
} from './api/client';
import LoginPage from './pages/Login';
import AccountsPage from './pages/Accounts';
import GroupsPage from './pages/Groups';
import GroupDetailPage from './pages/GroupDetail';

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  // booting：启动时先用 refresh cookie 尝试恢复会话，期间显示加载页
  const [booting, setBooting] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    // 会话被强制失效（refresh 失败/被复用作废）→ 回登录页
    setOnSessionExpired(() => {
      setSession(null);
      navigate('/login');
    });

    void (async () => {
      const ok = await restoreSession();
      if (ok) setSession(getSessionInfo());
      setBooting(false);
    })();

    return () => setOnSessionExpired(null);
  }, [navigate]);

  if (booting) {
    return <p className="hint" style={{ padding: 32 }}>正在恢复会话…</p>;
  }

  if (session === null) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage onLoggedIn={setSession} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const handleLogout = (): void => {
    void logout().then(() => {
      setSession(null);
      navigate('/login');
    });
  };

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">消息平台控制台</div>
        <NavLink to="/accounts">账号</NavLink>
        <NavLink to="/groups">群</NavLink>
        <div className="user">
          <div>
            {session.username}（{session.role === 'admin' ? '管理员' : '只读'}）
          </div>
          <button className="btn" style={{ marginTop: 8 }} onClick={handleLogout}>
            退出登录
          </button>
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/accounts" element={<AccountsPage session={session} />} />
          <Route path="/groups" element={<GroupsPage />} />
          <Route path="/groups/:id" element={<GroupDetailPage session={session} />} />
          <Route path="*" element={<Navigate to="/accounts" replace />} />
        </Routes>
        <p className="hint">
          <Link to="/accounts">账号</Link> · <Link to="/groups">群</Link>
        </p>
      </main>
    </div>
  );
}
