import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';

// ルート単位のコード分割（バンドル削減 A）。
// /book（顧客）は BookingPage + Functions のみ。staff 用は別チャンク（Auth/Firestore を含む）。
const BookingPage = lazy(() => import('./liff/BookingPage'));
const StaffApp = lazy(() => import('./StaffApp'));

export default function App() {
  return (
    <Suspense fallback={<p style={{ padding: '2rem' }}>読み込み中…</p>}>
      <Routes>
        {/* 顧客向け LIFF（公開ルート, §2 LINE 認証） */}
        <Route path="/book" element={<BookingPage />} />
        {/* それ以外はスタッフ用アプリ（遅延読み込み） */}
        <Route path="/*" element={<StaffApp />} />
      </Routes>
    </Suspense>
  );
}
