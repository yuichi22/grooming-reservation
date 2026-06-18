import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth, useIsAdmin } from '../auth/AuthContext';
import { tenantDoc } from '../lib/firestore';
import { useDocument } from '../lib/useDocument';
import type { Tenant } from '../lib/types';

type NavItem = { to: string; label: string; icon: string; end?: boolean; admin?: boolean };

const NAV: NavItem[] = [
  { to: '/', label: 'ダッシュボード', icon: '🏠', end: true },
  { to: '/bookings', label: '予約', icon: '📅' },
  { to: '/karte', label: 'カルテ', icon: '🐶' },
  { to: '/menus', label: 'メニュー', icon: '✂️', admin: true },
  { to: '/staff', label: 'スタッフ', icon: '👤', admin: true },
  { to: '/customers', label: '顧客', icon: '👥', admin: true },
  { to: '/settings', label: '設定', icon: '⚙️', admin: true },
];

export default function Layout() {
  const { user, claims, logout } = useAuth();
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();
  // 店舗名・ロゴ取得（superAdmin で tenantId 無しの場合は存在しない doc → null）
  const { data: tenant } = useDocument<Tenant>(tenantDoc(claims.tenantId ?? '__none__'), [claims.tenantId]);

  const storeName = tenant?.name ?? 'サロン';
  const logoUrl = tenant?.settings?.logoUrl;

  async function onLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="brand">{storeName} 予約管理</span>
        <div className="header-center">
          {logoUrl && <img className="store-logo" src={logoUrl} alt={storeName} />}
          <span className="powered">CONNECTED BY AKUTO</span>
        </div>
        <div className="topbar-right">
          <span className="user">
            {user?.email}
            {claims.role ? `（${claims.role}）` : claims.superAdmin ? '（superAdmin）' : ''}
          </span>
          <button onClick={onLogout}>ログアウト</button>
        </div>
      </header>
      <div className="app-body">
        <nav className="sidenav">
          {NAV.filter((n) => !n.admin || isAdmin).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              <span className="nav-icon" aria-hidden="true">
                {n.icon}
              </span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
