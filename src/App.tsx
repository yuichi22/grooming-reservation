import { lazy, Suspense } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';

// ルート単位のコード分割（バンドル削減 A）。
// /book（顧客）は BookingPage + Functions のみ。staff 用は別チャンク（Auth/Firestore を含む）。
const BookingPage = lazy(() => import('./liff/BookingPage'));
const SlugEntry = lazy(() => import('./liff/SlugEntry'));
const StaffApp = lazy(() => import('./StaffApp'));

// 公開URL(スラッグ) /suomi-matsue 等の1セグメントパス。アプリ自身のパスは除外する。
// 形式は Core 側の slugRules（英小文字始まり・英小文字数字ハイフン・3〜30文字）と同じ。
const SLUG_PATH_RE = /^\/([a-z][a-z0-9-]{1,28}[a-z0-9])$/;
const LOCAL_TOP_PATHS = new Set([
  'book',
  'login',
  'register',
  'dashboard',
  'bookings',
  'karte',
  'menus',
  'staff',
  'shifts',
  'customers',
  'settings',
]);

function matchEntrySlug(pathname: string): string | null {
  const m = pathname.match(SLUG_PATH_RE);
  if (!m || LOCAL_TOP_PATHS.has(m[1])) return null;
  return m[1];
}

export default function App() {
  const { pathname } = useLocation();
  const entrySlug = matchEntrySlug(pathname);

  return (
    <Suspense fallback={<p style={{ padding: '2rem' }}>読み込み中…</p>}>
      {entrySlug ? (
        // 公開URLの入口はログイン状態に関係なく予約導線へ変換する
        <SlugEntry slug={entrySlug} />
      ) : (
        <Routes>
          {/* 顧客向け LIFF（公開ルート, §2 LINE 認証） */}
          <Route path="/book" element={<BookingPage />} />
          {/* それ以外はスタッフ用アプリ（遅延読み込み） */}
          <Route path="/*" element={<StaffApp />} />
        </Routes>
      )}
    </Suspense>
  );
}
