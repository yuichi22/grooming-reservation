import { Route, Routes } from 'react-router-dom';
import BookingPage from './liff/BookingPage';
import LoginPage from './auth/LoginPage';
import { RequireAuth } from './auth/RequireAuth';
import Layout from './components/Layout';
import DashboardPage from './pages/DashboardPage';
import BookingsPage from './pages/BookingsPage';
import MenusPage from './pages/MenusPage';
import StaffPage from './pages/StaffPage';
import SettingsPage from './pages/SettingsPage';
import KartePage from './pages/KartePage';
import DogDetailPage from './pages/DogDetailPage';

export default function App() {
  return (
    <Routes>
      {/* 顧客向け LIFF（公開ルート, §2 LINE 認証） */}
      <Route path="/book" element={<BookingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
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
          path="settings"
          element={
            <RequireAuth adminOnly>
              <SettingsPage />
            </RequireAuth>
          }
        />
      </Route>
    </Routes>
  );
}
