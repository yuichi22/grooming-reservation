import { useAuth } from '../auth/AuthContext';
import { BookingQrPanel } from '../components/BookingQrModal';
import { tenantDoc } from '../lib/firestore';
import { useDocument } from '../lib/useDocument';
import type { Tenant } from '../lib/types';

/** 予約QR(ヘッダーの「QR」タブ)。店頭掲示・SNS用のQRとリンク */
export default function QrPage() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId ?? '';
  const { data: tenant } = useDocument<Tenant>(tenantDoc(tenantId || '__none__'), [tenantId]);
  return (
    <section className="qr-page">
      <h1>予約QR</h1>
      {tenantId ? (
        <BookingQrPanel tenantId={tenantId} storeName={tenant?.name ?? ''} />
      ) : (
        <p className="muted">店舗が選ばれていません。</p>
      )}
    </section>
  );
}
