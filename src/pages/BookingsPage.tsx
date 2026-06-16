import { useMemo, useState } from 'react';
import { query, where } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { bookingsCol, dogsCol } from '../lib/firestore';
import { completeBooking } from '../lib/functions';
import { useCollection } from '../lib/useCollection';
import type { Booking, Dog } from '../lib/types';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export default function BookingsPage() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId;
  if (!tenantId) return <p className="error">テナントが割り当てられていません。</p>;
  return <BookingsInner tenantId={tenantId} />;
}

function BookingsInner({ tenantId }: { tenantId: string }) {
  const [date, setDate] = useState(todayStr());
  const { data: bookings, loading } = useCollection<Booking>(
    query(bookingsCol(tenantId), where('date', '==', date)),
    [tenantId, date],
  );
  const { data: dogs } = useCollection<Dog>(dogsCol(tenantId), [tenantId]);
  const dogName = useMemo(() => new Map(dogs.map((d) => [d.id, d.name])), [dogs]);

  const sorted = [...bookings].sort((a, b) => a.startTime.localeCompare(b.startTime));

  return (
    <section>
      <h1>予約</h1>
      <label className="inline">
        日付
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>

      {loading ? (
        <p>読み込み中…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>時間</th>
              <th>ワンちゃん</th>
              <th>担当</th>
              <th>状態</th>
              <th>施術完了 (§7)</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((b) => (
              <tr key={b.id}>
                <td>
                  {b.startTime}〜{b.slotEnd}
                </td>
                <td>{dogName.get(b.dogId) ?? b.dogId}</td>
                <td>{b.staffId ?? '未割当'}</td>
                <td>{statusLabel(b.status)}</td>
                <td>
                  {b.status === 'reserved' ? (
                    <CompleteForm tenantId={tenantId} booking={b} />
                  ) : b.status === 'done' ? (
                    <span className="muted">
                      {b.finalDurationMin}分 / ¥{(b.finalPrice ?? 0).toLocaleString()}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  この日の予約はありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}

function statusLabel(s: Booking['status']): string {
  return { reserved: '予約', done: '完了', canceled: 'キャンセル', noshow: '無断欠席' }[s];
}

function CompleteForm({ tenantId, booking }: { tenantId: string; booking: Booking }) {
  const [durationMin, setDuration] = useState(booking.durationMin);
  const [price, setPrice] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onComplete() {
    setBusy(true);
    setErr(null);
    try {
      // done にすると onBookingDone トリガが §10 イベントを生成・配信する
      await completeBooking({ tenantId, bookingId: booking.id, finalDurationMin: durationMin, finalPrice: price });
    } catch (e) {
      setErr(e instanceof Error ? e.message : '完了処理に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row-form" style={{ margin: 0 }}>
      <label className="inline">
        確定分
        <input type="number" min={1} step={5} value={durationMin} onChange={(e) => setDuration(Number(e.target.value))} />
      </label>
      <label className="inline">
        確定料金
        <input type="number" min={0} step={100} value={price} onChange={(e) => setPrice(Number(e.target.value))} />
      </label>
      <button type="button" onClick={onComplete} disabled={busy}>
        {busy ? '処理中…' : '完了にする'}
      </button>
      {err && <span className="error">{err}</span>}
    </div>
  );
}
