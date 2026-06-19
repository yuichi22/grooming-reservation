import { useMemo, useState } from 'react';
import { deleteDoc, doc, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { bookingsCol, closuresCol, dogsCol, servicesCol, staffCol } from '../lib/firestore';
import { completeBooking } from '../lib/functions';
import { useCollection } from '../lib/useCollection';
import type { Booking, Closure, Dog, Service, Staff } from '../lib/types';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];

/** ローカル日付を YYYY-MM-DD に（toISOString は UTC ずれするため使わない）。 */
function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayStr() {
  return fmt(new Date());
}
function formatDateJa(ds: string): string {
  const [y, m, d] = ds.split('-').map(Number);
  const dow = DOW[new Date(y, m - 1, d).getDay()];
  return `${y}年${m}月${d}日（${dow}）`;
}

export default function BookingsPage() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId;
  if (!tenantId) return <p className="error">テナントが割り当てられていません。</p>;
  return <BookingsInner tenantId={tenantId} />;
}

function BookingsInner({ tenantId }: { tenantId: string }) {
  const today = todayStr();
  const [view, setView] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [selected, setSelected] = useState(today);

  // カレンダーグリッド: 月初の週の日曜から6週間（42日）
  const gridDays = useMemo(() => {
    const first = new Date(view.y, view.m, 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [view]);
  const rangeStart = fmt(gridDays[0]);
  const rangeEnd = fmt(gridDays[41]);

  const { data: monthBookings } = useCollection<Booking>(
    query(bookingsCol(tenantId), where('date', '>=', rangeStart), where('date', '<=', rangeEnd)),
    [tenantId, rangeStart, rangeEnd],
  );
  const { data: closures } = useCollection<Closure>(closuresCol(tenantId), [tenantId]);

  const countByDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of monthBookings) {
      if (b.status === 'reserved' || b.status === 'done') m.set(b.date, (m.get(b.date) ?? 0) + 1);
    }
    return m;
  }, [monthBookings]);
  const closedDates = useMemo(
    () => new Set(closures.filter((c) => c.fullDay !== false).map((c) => c.id)),
    [closures],
  );

  function go(delta: number) {
    setView((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  }
  function pickDay(d: Date) {
    setSelected(fmt(d));
    if (d.getMonth() !== view.m || d.getFullYear() !== view.y) setView({ y: d.getFullYear(), m: d.getMonth() });
  }

  return (
    <section>
      <h1>予約カレンダー</h1>
      <div className="cal-head">
        <button type="button" onClick={() => go(-1)} aria-label="前の月">
          ‹
        </button>
        <span className="cal-title">
          {view.y}年 {view.m + 1}月
        </span>
        <button type="button" onClick={() => go(1)} aria-label="次の月">
          ›
        </button>
        <button
          type="button"
          className="cal-today-btn"
          onClick={() => {
            const d = new Date();
            setView({ y: d.getFullYear(), m: d.getMonth() });
            setSelected(todayStr());
          }}
        >
          今日
        </button>
      </div>

      <div className="cal-grid">
        {DOW.map((w, i) => (
          <div key={w} className={`cal-dow${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}`}>
            {w}
          </div>
        ))}
        {gridDays.map((d) => {
          const ds = fmt(d);
          const dow = d.getDay();
          const inMonth = d.getMonth() === view.m;
          const count = countByDate.get(ds) ?? 0;
          const closed = closedDates.has(ds);
          const cls = ['cal-cell'];
          if (!inMonth) cls.push('other');
          if (ds === today) cls.push('today');
          if (ds === selected) cls.push('selected');
          if (closed) cls.push('closed');
          return (
            <button key={ds} type="button" className={cls.join(' ')} onClick={() => pickDay(d)}>
              <span className={`cal-daynum${dow === 0 ? ' sun' : dow === 6 ? ' sat' : ''}`}>{d.getDate()}</span>
              {closed ? (
                <span className="cal-badge closed">休</span>
              ) : count > 0 ? (
                <span className="cal-badge count">{count}件</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <DayDetail tenantId={tenantId} date={selected} closed={closedDates.has(selected)} />
    </section>
  );
}

function DayDetail({ tenantId, date, closed }: { tenantId: string; date: string; closed: boolean }) {
  const { data: bookings, loading } = useCollection<Booking>(
    query(bookingsCol(tenantId), where('date', '==', date)),
    [tenantId, date],
  );
  const { data: dogs } = useCollection<Dog>(dogsCol(tenantId), [tenantId]);
  const { data: staff } = useCollection<Staff>(staffCol(tenantId), [tenantId]);
  const { data: services } = useCollection<Service>(servicesCol(tenantId), [tenantId]);
  const dogName = useMemo(() => new Map(dogs.map((d) => [d.id, d.name])), [dogs]);
  const staffName = useMemo(() => new Map(staff.map((s) => [s.id, s.name])), [staff]);
  const serviceName = useMemo(() => new Map(services.map((s) => [s.id, s.name])), [services]);

  const sorted = [...bookings].sort((a, b) => a.startTime.localeCompare(b.startTime));

  async function toggleClosure() {
    const ref = doc(closuresCol(tenantId), date);
    if (closed) {
      await deleteDoc(ref);
    } else {
      await setDoc(ref, { fullDay: true } as Omit<Closure, 'id'> as Closure);
    }
  }

  return (
    <>
      <div className="cal-detail-head">
        <h2>{formatDateJa(date)}</h2>
        <button type="button" className={closed ? 'btn-closed' : ''} onClick={toggleClosure}>
          {closed ? '休業日を解除' : '休業日にする'}
        </button>
      </div>
      {closed && <p className="muted">この日は休業日です（空き計算で「空きなし」・予約受付なし §11）。</p>}

      {loading ? (
        <p>読み込み中…</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>時間</th>
                <th>ワンちゃん</th>
                <th>メニュー</th>
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
                  <td>
                    {serviceName.get(b.serviceId) ?? b.serviceId}
                    {b.options && b.options.length > 0 ? `＋${b.options.length}` : ''}
                  </td>
                  <td>{b.staffId ? staffName.get(b.staffId) ?? b.staffId : '未割当'}</td>
                  <td>{statusLabel(b.status)}</td>
                  <td>
                    {b.status === 'reserved' ? (
                      <>
                        <CompleteForm tenantId={tenantId} booking={b} />
                        <div className="row-form" style={{ margin: '4px 0 0' }}>
                          <button onClick={() => setStatus(tenantId, b.id, 'canceled')}>キャンセル</button>
                          <button onClick={() => setStatus(tenantId, b.id, 'noshow')}>無断欠席</button>
                        </div>
                      </>
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
                  <td colSpan={6} className="muted">
                    この日の予約はありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function statusLabel(s: Booking['status']): string {
  return { reserved: '予約', done: '完了', canceled: 'キャンセル', noshow: '無断欠席' }[s];
}

// スタッフはルール上 bookings を直接更新できる（§2）
async function setStatus(tenantId: string, bookingId: string, status: Booking['status']) {
  const label = status === 'canceled' ? 'キャンセル' : '無断欠席';
  if (confirm(`この予約を「${label}」にしますか？`)) {
    await updateDoc(doc(bookingsCol(tenantId), bookingId), { status });
  }
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
