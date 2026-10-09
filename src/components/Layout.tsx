import { PoweredByAkuto } from './AkutoWordmark';
import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight, LogOut, QrCode, Scissors, Settings, SlidersHorizontal, UserRound, Users, X } from 'lucide-react';
import type { ReactNode } from 'react';
import MobileNumpad from './MobileNumpad';
import { useAuth, useIsAdmin } from '../auth/AuthContext';
import { tenantDoc } from '../lib/firestore';
import { useDocument } from '../lib/useDocument';
import { STAFF_ROLE_LABELS, type Tenant } from '../lib/types';

type NavItem = { to: string; label: string; icon: ReactNode; end?: boolean; admin?: boolean };

// 予約・カルテ・シフトはヘッダーのボタンに集約（サイドバーからは除外）。
// ダッシュボードは内容が無いため廃止し、顧客を先頭に。
const NAV: NavItem[] = [
  // アイコンは線幅1.5の線アイコン(AKUTO: 絵文字・塗りアイコンは使わない)
  { to: '/customers', label: '顧客', icon: <Users size={16} strokeWidth={1.5} />, admin: true },
  { to: '/menus', label: 'メニュー', icon: <Scissors size={16} strokeWidth={1.5} />, admin: true },
  { to: '/staff', label: 'スタッフ', icon: <UserRound size={16} strokeWidth={1.5} />, admin: true },
  { to: '/settings', label: '設定', icon: <SlidersHorizontal size={16} strokeWidth={1.5} />, admin: true },
];

// サイドバーの各ページのパス。モバイルでこれらを開いた状態でメニューを閉じたら予約画面に戻す。
const SIDEBAR_PATHS = NAV.map((n) => n.to);

export default function Layout() {
  const { user, claims, logout } = useAuth();
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();
  const location = useLocation();
  // スマホ: 歯車で「アカウントと管理」のモーダル(アコーディオンはファイルのタブと相性が悪いので廃止 2026-10-09)
  const [menuOpen, setMenuOpen] = useState(false);
  const { data: tenant } = useDocument<Tenant>(tenantDoc(claims.tenantId ?? '__none__'), [claims.tenantId]);

  const storeName = tenant?.name ?? 'サロン';
  // PC: 「管理」タブの中(顧客・メニュー・スタッフ・設定)にいる間だけ左に切り替えを出す
  const onAdminPage = SIDEBAR_PATHS.some(
    (p) => location.pathname === p || location.pathname.startsWith(p + '/'),
  );
  const roleLabel = claims.role
    ? `（${STAFF_ROLE_LABELS[claims.role] ?? claims.role}）`
    : claims.superAdmin
      ? '（superAdmin）'
      : '';
  const logoUrl = tenant?.settings?.logoUrl;

  function closeNavOnMobile() {
    setMenuOpen(false);
  }

  async function onLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="header-center">
          {logoUrl ? (
            <img className="store-logo" src={logoUrl} alt={storeName} />
          ) : (
            <span className="store-name">{storeName}</span>
          )}
        </div>
        <div className="topbar-right">
          <button type="button" className="menu-btn icon-btn" onClick={() => setMenuOpen(true)} aria-label="アカウントと管理">
          <Settings size={20} strokeWidth={1.5} />
          </button>
        </div>
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
            <NavLink to="/qr" onClick={closeNavOnMobile} className={({ isActive }) => `header-btn${isActive ? ' active' : ''}`}>
              <QrCode size={15} strokeWidth={1.75} style={{ marginRight: 4 }} />
              QR
            </NavLink>
          )}
        </div>
      </header>
      {/* 管理(顧客〜設定)の中にいる間だけ切り替えを出す。PC=左の縦並び、スマホ=タブの下の丸ボタン */}
      <div className={`app-body${onAdminPage ? ' admin-open' : ''}`}>
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
          {/* AKUTO は前に出ない: 店のロゴの下ではなく画面の一番下に小さく */}
          <footer className="app-footer">
            <PoweredByAkuto />
          </footer>
        </main>
      </div>
      <MobileNumpad />
      {menuOpen && (
        <div className="modal-backdrop account-backdrop" onClick={() => setMenuOpen(false)}>
          <div className="modal account-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="アカウントと管理">
            <div className="modal-head">
              <div>
                <div className="account-email">{user?.email}</div>
                <div className="account-role">{roleLabel.replace(/[（）]/g, '') || 'スタッフ'}</div>
              </div>
              <button type="button" className="modal-close" onClick={() => setMenuOpen(false)} aria-label="閉じる">
                <X size={20} strokeWidth={1.5} />
              </button>
            </div>
            {isAdmin && (
              <div className="account-links">
                <div className="account-label">管理</div>
                {NAV.filter((n) => !n.admin || isAdmin).map((n) => (
                  <NavLink key={n.to} to={n.to} onClick={() => setMenuOpen(false)} className="account-link">
                    <span className="nav-icon" aria-hidden="true">{n.icon}</span>
                    <span className="account-link-label">{n.label}</span>
                    <ChevronRight size={16} strokeWidth={1.5} className="account-chev" />
                  </NavLink>
                ))}
              </div>
            )}
            <button type="button" className="account-logout" onClick={onLogout}>
              <LogOut size={16} strokeWidth={1.5} />
              ログアウト
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
