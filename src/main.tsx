import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

// AuthProvider は StaffApp 側に移動（/book バンドルに Auth を載せないため A）。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

// [試作] ?tint=1 で店の色を地に混ぜた見た目を確認
try {
  if (new URLSearchParams(location.search).get('tint') === '1') document.documentElement.classList.add('tint');
} catch {
  /* noop */
}
try {
  if (new URLSearchParams(location.search).get('ui') === 'blue') document.documentElement.classList.add('ui-blue');
} catch {
  /* noop */
}
try {
  if (new URLSearchParams(location.search).get('tabline') === '1') document.documentElement.classList.add('tabline');
} catch {
  /* noop */
}
