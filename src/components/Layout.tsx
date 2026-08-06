import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, QrCode } from 'lucide-react';
import MobileNumpad from './MobileNumpad';
import BookingQrModal from './BookingQrModal';
import { useAuth, useIsAdmin } from '../auth/AuthContext';
import { tenantDoc } from '../lib/firestore';
import { useDocument } from '../lib/useDocument';
import type { Tenant } from '../lib/types';

type NavItem = { to: string; label: string; icon: string; end?: boolean; admin?: boolean };

const NAV: NavItem[] = [
  { to: '/dashboard', label: 'ダッシュボード', icon: '🏠' },
  // 予約・カルテはヘッダーのボタンに集約（サイドバーからは除外）
  { to: '/menus', label: 'メニュー', icon: '✂️', admin: true },
  { to: '/staff', label: 'スタッフ', icon: '👤', admin: true },
  { to: '/customers', label: '顧客', icon: '👥', admin: true },
  { to: '/settings', label: '設定', icon: '⚙️', admin: true },
];

// サイドバーの各ページのパス。モバイルでこれらを開いた状態でメニューを閉じたら予約画面に戻す。
const SIDEBAR_PATHS = NAV.map((n) => n.to);

export default function Layout() {
  const { user, claims, logout } = useAuth();
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  // モバイルでメニューを閉じる操作。サイドバーの各ページを開いていた場合は予約画面に戻す。
  function toggleNav() {
    const next = !navOpen;
    setNavOpen(next);
    const onSidebarPage = SIDEBAR_PATHS.some(
      (p) => location.pathname === p || location.pathname.startsWith(p + '/'),
    );
    if (!next && window.innerWidth < 820 && onSidebarPage) {
      navigate('/bookings');
    }
  }
  const { data: tenant } = useDocument<Tenant>(tenantDoc(claims.tenantId ?? '__none__'), [claims.tenantId]);

  const storeName = tenant?.name ?? 'サロン';
  const logoUrl = tenant?.settings?.logoUrl;

  // 予約・カルテへ移動するときはモバイルのサイドバー（ダッシュボード〜設定）を閉じる。
  function closeNavOnMobile() {
    if (window.innerWidth < 820) setNavOpen(false);
  }

  async function onLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="nav-toggle icon-btn" onClick={toggleNav} aria-label="メニュー開閉">
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
          {logoUrl ? (
            <img className="store-logo" src={logoUrl} alt={storeName} />
          ) : (
            <span className="store-name">{storeName}</span>
          )}
          <span className="powered">CONNECTED BY AKUTO</span>
        </div>
        <span className="user">
          {user?.email}
          {claims.role ? `（${claims.role}）` : claims.superAdmin ? '（superAdmin）' : ''}
        </span>
        <div className="header-quick">
          <NavLink to="/bookings" onClick={closeNavOnMobile} className={({ isActive }) => `header-btn${isActive ? ' active' : ''}`}>
            予約
          </NavLink>
          <NavLink to="/karte" onClick={closeNavOnMobile} className={({ isActive }) => `header-btn${isActive ? ' active' : ''}`}>
            カルテ
          </NavLink>
          {/* シフトは週次で触る運用ページなのでヘッダーに昇格（admin専用。トリマーは従来の3つ） */}
          {isAdmin && (
            <NavLink to="/shifts" onClick={closeNavOnMobile} className={({ isActive }) => `header-btn${isActive ? ' active' : ''}`}>
              シフト
            </NavLink>
          )}
          {claims.tenantId && (
            <button type="button" className="header-btn" onClick={() => setQrOpen(true)} aria-label="予約QR">
              <QrCode size={15} style={{ verticalAlign: '-2px', marginRight: 3 }} />
              QR
            </button>
          )}
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
      <MobileNumpad />
      {qrOpen && claims.tenantId && (
        <BookingQrModal tenantId={claims.tenantId} storeName={storeName} onClose={() => setQrOpen(false)} />
      )}
    </div>
  );
}
