import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { RequireAuth } from './auth/RequireAuth';
import LoginPage from './auth/LoginPage';
import RegisterPage from './auth/RegisterPage';
import Layout from './components/Layout';
import BookingsPage from './pages/BookingsPage';
import MenusPage from './pages/MenusPage';
import StaffPage from './pages/StaffPage';
import ShiftsPage from './pages/ShiftsPage';
import SettingsPage from './pages/SettingsPage';
import KartePage from './pages/KartePage';
import DogDetailPage from './pages/DogDetailPage';
import CustomersPage from './pages/CustomersPage';

// スタッフ用アプリ全体（Auth + 管理画面）。App.tsx から遅延読み込みされ、
// /book（顧客）バンドルには含まれない（バンドル削減 A）。
export default function StaffApp() {
  // 管理側だけAKUTOカラーのファビコンに差し替える（顧客側 /book は index.html の既定のまま）。
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    link.href = '/favicon-admin.svg';
    return () => {
      link.href = '/favicon.svg';
    };
  }, []);
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/bookings" replace />} />
          <Route path="bookings" element={<BookingsPage />} />
          <Route path="karte" element={<KartePage />} />
          <Route path="karte/:dogId" element={<DogDetailPage />} />
          <Route
            path="menus"
            element={
              <RequireAuth adminOnly>
                <MenusPage />
              </RequireAuth>
            }
          />
          <Route
            path="staff"
            element={
              <RequireAuth adminOnly>
                <StaffPage />
              </RequireAuth>
            }
          />
          <Route
            path="shifts"
            element={
              <RequireAuth adminOnly>
                <ShiftsPage />
              </RequireAuth>
            }
          />
          <Route
            path="customers"
            element={
              <RequireAuth adminOnly>
                <CustomersPage />
              </RequireAuth>
            }
          />
          <Route
            path="settings"
            element={
              <RequireAuth adminOnly>
                <SettingsPage />
              </RequireAuth>
            }
          />
          {/* 廃止した /dashboard 等の未知パスは予約へ（空白画面を出さない） */}
          <Route path="*" element={<Navigate to="/bookings" replace />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
