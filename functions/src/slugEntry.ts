// slugEntry.ts
// 公開URL（https://groom.akuto.app/{slug}）の入口解決。
// Core の slugs/{slug}（公開読取ルール）を REST で引いて拠点(coreTenantId/coreSpaceId)を得て、
// 自プロジェクトの coreLinks から groom テナントIDへ変換する。
// 認証不要（公開情報のみ返す）。存在しないスラッグは ok:false を返し、クライアントは通常導線へ流す。
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall } from 'firebase-functions/v2/https';

if (!getApps().length) initializeApp();
const db = getFirestore();

const str = (v: unknown) => String(v ?? '').trim();

// Core 側 slugRules と同じ形式（英小文字始まり・英小文字数字ハイフン・3〜30文字）
const SLUG_RE = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;

/** Core の公開スラッグを引く。Web APIキーはクライアント配布前提の公開値。 */
async function fetchCoreSlug(slug: string): Promise<{ tenantId: string; spaceId: string } | null> {
  const projectId = str(process.env.CORE_PROJECT_ID);
  const apiKey = str(process.env.CORE_API_KEY);
  if (!projectId || !apiKey) {
    console.warn('[resolveSpaceSlug] CORE_PROJECT_ID/CORE_API_KEY 未設定（functions/.env.<projectId> を確認）');
    return null;
  }

  const url =
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/slugs/` +
    `${encodeURIComponent(slug)}?key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null; // 未登録スラッグは404

  const data = (await res.json()) as { fields?: Record<string, { stringValue?: string }> };
  const tenantId = str(data.fields?.tenantId?.stringValue);
  const spaceId = str(data.fields?.spaceId?.stringValue);
  if (!tenantId || !spaceId) return null;
  return { tenantId, spaceId };
}

export const resolveSpaceSlug = onCall({ region: 'asia-northeast1' }, async (request) => {
  const slug = str((request.data as { slug?: unknown })?.slug).toLowerCase();
  if (!SLUG_RE.test(slug)) return { ok: false as const, reason: 'invalid-slug' };

  let core: { tenantId: string; spaceId: string } | null = null;
  try {
    core = await fetchCoreSlug(slug);
  } catch (e) {
    console.warn('[resolveSpaceSlug] Core接続失敗:', (e as Error)?.message || e);
    return { ok: false as const, reason: 'core-unavailable' };
  }
  if (!core) return { ok: false as const, reason: 'not-found' };

  const linkSnap = await db.collection('coreLinks').doc(`${core.tenantId}__${core.spaceId}`).get();
  const tenantId = str(linkSnap.data()?.groomTenantId);
  // groom を使っていない拠点（POSのみ等）もスラッグは持つため、未リンクは not-found 扱い
  if (!tenantId) return { ok: false as const, reason: 'not-found' };

  return { ok: true as const, tenantId };
});
