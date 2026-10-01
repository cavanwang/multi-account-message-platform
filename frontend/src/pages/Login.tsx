/**
 * 登录页（页面 1）。
 * admin/admin（管理员，可写）、viewer/viewer（只读）。
 * 成功后 access token 存内存，refresh token 由后端通过 HttpOnly cookie 下发。
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, ApiError, type SessionInfo } from '../api/client';

interface Props {
  onLoggedIn: (session: SessionInfo) => void;
}

export default function LoginPage({ onLoggedIn }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    login(username.trim(), password)
      .then((session) => {
        onLoggedIn(session);
        navigate('/accounts');
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : '网络错误，请稍后重试');
        setSubmitting(false);
      });
  };

  return (
    <div className="login-box">
      <h1>多账号群组消息平台</h1>
      <form
        onSubmit={(e) => {
          handleSubmit(e);
        }}
      >
        <label htmlFor="username">用户名</label>
        <input
          id="username"
          className="input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
        />
        <label htmlFor="password">密码</label>
        <input
          id="password"
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        {error !== null && <p className="error-text">{error}</p>}
        <button
          className="btn primary"
          type="submit"
          style={{ width: '100%', marginTop: 16, padding: '8px 0' }}
          disabled={submitting || username.trim() === '' || password === ''}
        >
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>
      <p className="hint" style={{ marginTop: 16 }}>
        预置账号：admin / admin（管理员）、viewer / viewer（只读）
      </p>
    </div>
  );
}
