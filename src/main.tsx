import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { settleLiffStateInUrl } from './liff/liffUrl';

// liff.line.me 経由の ?liff.state= を、ルーターが URL を読む前に自分で展開する（liffUrl.ts の説明）
settleLiffStateInUrl();

// /book（LINE から開く予約画面）は、画面部品（BookingPage チャンク）の取得と並行して
// LIFF の初期化を先に始める。以前は「チャンク取得→描画→初期化」が直列だった。
// liff.line.me 経由の初回は liff.init が ?liff.state= からの転送（ページの読み直し）を行うので、
// それも早く済む。
if (window.location.pathname === '/book') {
  import('./liff/liff').then((m) => m.startLiffInit()).catch(() => {});
}

// AuthProvider は StaffApp 側に移動（/book バンドルに Auth を載せないため A）。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

