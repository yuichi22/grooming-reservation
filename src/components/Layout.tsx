import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth, useIsAdmin } from '../auth/AuthContext';

export default function Layout() {
  const { user, claims, logout } = useAuth();
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();

  async function onLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <strong>GROOM HAUS 管理</strong>
        <span className="muted">
          {user?.email}
          {claims.role ? `（${claims.role}）` : claims.superAdmin ? '（superAdmin）' : ''}
          {claims.tenantId ? ` / ${claims.tenantId}` : ''}
        </span>
        <button onClick={onLogout}>ログアウト</button>
      </header>
      <div className="app-body">
        <nav className="sidenav">
          <NavLink to="/">ダッシュボード</NavLink>
          <NavLink to="/bookings">予約</NavLink>
          <NavLink to="/karte">カルテ</NavLink>
          {isAdmin && <NavLink to="/menus">メニュー</NavLink>}
          {isAdmin && <NavLink to="/staff">スタッフ</NavLink>}
          {isAdmin && <NavLink to="/customers">顧客</NavLink>}
          {isAdmin && <NavLink to="/settings">設定</NavLink>}
        </nav>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
