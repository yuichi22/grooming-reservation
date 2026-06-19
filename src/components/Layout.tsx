import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import { useAuth, useIsAdmin } from '../auth/AuthContext';
import { tenantDoc } from '../lib/firestore';
import { useDocument } from '../lib/useDocument';
import type { Tenant } from '../lib/types';

type NavItem = { to: string; label: string; icon: string; end?: boolean; admin?: boolean };

const NAV: NavItem[] = [
  { to: '/', label: 'ダッシュボード', icon: '🏠', end: true },
  // 予約・カルテはヘッダーのボタンに集約（サイドバーからは除外）
  { to: '/menus', label: 'メニュー', icon: '✂️', admin: true },
  { to: '/staff', label: 'スタッフ', icon: '👤', admin: true },
  { to: '/customers', label: '顧客', icon: '👥', admin: true },
  { to: '/settings', label: '設定', icon: '⚙️', admin: true },
];

export default function Layout() {
  const { user, claims, logout } = useAuth();
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(true);
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
        <button className="nav-toggle icon-btn" onClick={() => setNavOpen((o) => !o)} aria-label="メニュー開閉">
          {navOpen ? (
            <>
              <ChevronLeft className="ico-desktop" size={20} strokeWidth={2.25} />
              <ChevronUp className="ico-mobile" size={20} strokeWidth={2.25} />
            </>
          ) : (
            <>
              <ChevronRight className="ico-desktop" size={20} strokeWidth={2.25} />
              <ChevronDown className="ico-mobile" size={20} strokeWidth={2.25} />
            </>
          )}
        </button>
        <div className="header-center">
          {logoUrl && <img className="store-logo" src={logoUrl} alt={storeName} />}
          <span className="powered">CONNECTED BY AKUTO</span>
        </div>
        <span className="user">
          {user?.email}
          {claims.role ? `（${claims.role}）` : claims.superAdmin ? '（superAdmin）' : ''}
        </span>
        <div className="header-quick">
          <NavLink to="/bookings" className={({ isActive }) => `header-btn${isActive ? ' active' : ''}`}>
            予約
          </NavLink>
          <NavLink to="/karte" className={({ isActive }) => `header-btn${isActive ? ' active' : ''}`}>
            カルテ
          </NavLink>
        </div>
      </header>
      <div className={`app-body${navOpen ? '' : ' nav-collapsed'}`}>
        <nav className="sidenav">
          {NAV.filter((n) => !n.admin || isAdmin).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              <span className="nav-icon" aria-hidden="true">
                {n.icon}
              </span>
              {n.label}
            </NavLink>
          ))}
          <button className="nav-logout" onClick={onLogout}>
            ログアウト
          </button>
        </nav>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
