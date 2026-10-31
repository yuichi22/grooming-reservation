// liff.line.me/{liffId}?tenant=… から開くと、エンドポイントには
// `?liff.state=%3Ftenant%3D…` に包まれて届き、liff.init() がそれを本来のURLへ展開する。
// ⚠SDK の展開は「ページの読み直し」になることがあり、そのとき通信中の呼び出しが宙吊りになったり、
//   LINE の読み込み表示が出たまま止まったりする（Core の会員証で 2026-08 に実機で確認済み）。
//   そこで liff.init より前に自分で展開して URL を書き換え、SDK に展開させない（Core の /card と同じ）。
//   LIFF SDK を含まないファイルにしておき、main.tsx から描画前に同期で呼ぶ。

/** liff.state を剥がした後の pathname + search。liff.state が無ければ null（何もしない）。 */
export function unwrapLiffState(pathname: string, search: string): string | null {
  const raw = new URLSearchParams(search);
  const state = raw.get('liff.state');
  if (state === null) return null;
  // liff.state は "?a=b" / "/path?a=b" / "/path" のいずれか。path はエンドポイントの path に足される
  const qi = state.indexOf('?');
  const statePath = qi >= 0 ? state.slice(0, qi) : state.startsWith('/') ? state : '';
  const stateQuery = qi >= 0 ? state.slice(qi + 1) : state.startsWith('/') ? '' : state;
  const merged = new URLSearchParams(stateQuery);
  // 外側にしか無いパラメータ（ログイン戻りの code など）は残す
  for (const [k, v] of raw.entries()) {
    if (k !== 'liff.state' && !merged.has(k)) merged.set(k, v);
  }
  const base = statePath ? pathname.replace(/\/$/, '') + statePath : pathname;
  const q = merged.toString();
  return base + (q ? `?${q}` : '');
}

/** 描画前に呼ぶ。liff.state があれば URL を展開後の形に置き換える（ページ遷移はしない）。 */
export function settleLiffStateInUrl(): void {
  try {
    const next = unwrapLiffState(window.location.pathname, window.location.search);
    if (next !== null) window.history.replaceState(window.history.state, '', next + window.location.hash);
  } catch {
    /* noop: 失敗しても SDK が従来どおり展開する */
  }
}
