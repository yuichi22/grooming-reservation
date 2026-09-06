// SlugEntry.tsx
// 公開URL https://groom.akuto.app/{slug} の入口。
// resolveSpaceSlug（公開callable）で拠点スラッグ → groom テナントIDに変換し、
// /book?tenant=<tenantId> へ置き換え遷移する。
// 未登録スラッグや解決失敗は /book（通常の入口＝利用店の解決フロー）へ流す。
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase';

export default function SlugEntry({ slug }: { slug: string }) {
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    (async () => {
      let target = '/book';
      try {
        const fn = httpsCallable<{ slug: string }, { ok: boolean; tenantId?: string }>(
          functions,
          'resolveSpaceSlug',
        );
        const res = await fn({ slug });
        if (res.data?.ok && res.data.tenantId) {
          target = `/book?tenant=${encodeURIComponent(res.data.tenantId)}`;
        }
      } catch {
        // 解決できない場合は通常の入口へ合流
      }
      if (!cancelled) navigate(target, { replace: true });
    })();

    return () => {
      cancelled = true;
    };
  }, [slug, navigate]);

  return <p style={{ padding: '2rem' }}>読み込み中…</p>;
}
