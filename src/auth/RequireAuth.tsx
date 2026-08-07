import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { isAdminRole } from '../lib/types';

/**
 * 認証ガード。未ログインは /login へ。
 * adminOnly のページは admin / superAdmin 以外を拒否 (§2)。
 */
export function RequireAuth({
  children,
  adminOnly = false,
}: {
  children: ReactNode;
  adminOnly?: boolean;
}) {
  const { user, claims, loading } = useAuth();
  const location = useLocation();

  if (loading) return <p style={{ padding: '2rem' }}>読み込み中…</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;

  if (adminOnly && !(isAdminRole(claims.role) || claims.superAdmin)) {
    return (
      <div style={{ padding: '2rem' }}>
        <h2>権限がありません</h2>
        <p>この画面は管理者(admin)のみ利用できます。</p>
      </div>
    );
  }
  return <>{children}</>;
}
