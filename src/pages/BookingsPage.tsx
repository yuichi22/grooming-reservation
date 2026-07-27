import { Fragment, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { deleteDoc, doc, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import {
  bookingsCol,
  closuresCol,
  customersCol,
  dogsCol,
  optionsCol,
  pricingCol,
  servicesCol,
  staffCol,
  tenantDoc,
} from '../lib/firestore';
import { completeBooking, createBookingByStaff, sendCheckoutToPos } from '../lib/functions';
import { useCollection } from '../lib/useCollection';
import { useDocument } from '../lib/useDocument';
import type { Booking, Closure, Customer, Dog, Option, PriceEntry, Service, Staff, Tenant } from '../lib/types';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const PX_PER_MIN = 1; // 時間軸の縮尺
const SLOT_ROUND = 15; // クリック時刻の丸め（分）
const EDGE_PAD = 30; // 営業時間前後の余白（分）

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayStr() {
  return fmt(new Date());
}
function formatDateJa(ds: string): string {
  const [y, m, d] = ds.split('-').map(Number);
  return `${y}年${m}月${d}日（${DOW[new Date(y, m - 1, d).getDay()]}）`;
}
const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const toHHMM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export default function BookingsPage() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId;
  if (!tenantId) return <p className="error">テナントが割り当てられていません。</p>;
  return <BookingsInner tenantId={tenantId} />;
}

function BookingsInner({ tenantId }: { tenantId: string }) {
  const today = todayStr();
  const [monthOpen, setMonthOpen] = useState(false);
  const [view, setView] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [selected, setSelected] = useState(today);
  const [dayView, setDayView] = useState<'time' | 'list'>('time');

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
  const selectedClosed = closedDates.has(selected);

  function goMonth(delta: number) {
    setView((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  }
  function pickDay(d: Date) {
    setSelected(fmt(d));
    if (d.getMonth() !== view.m || d.getFullYear() !== view.y) setView({ y: d.getFullYear(), m: d.getMonth() });
  }
  function shiftDay(delta: number) {
    const [y, m, d] = selected.split('-').map(Number);
    const nd = new Date(y, m - 1, d + delta);
    setSelected(fmt(nd));
    if (nd.getMonth() !== view.m || nd.getFullYear() !== view.y) setView({ y: nd.getFullYear(), m: nd.getMonth() });
  }
  async function toggleClosure() {
    const ref = doc(closuresCol(tenantId), selected);
    if (selectedClosed) await deleteDoc(ref);
    else await setDoc(ref, { fullDay: true } as Omit<Closure, 'id'> as Closure);
  }
  function goToday() {
    const d = new Date();
    setView({ y: d.getFullYear(), m: d.getMonth() });
    setSelected(todayStr());
  }

  return (
    <section>
      <div className="cal-title-row">
        <h1>予約カレンダー</h1>
        <button type="button" className="cal-today-btn" onClick={goToday}>
          今日
        </button>
      </div>

      {/* 月カレンダー（アコーディオン・既定で閉） */}
      <button type="button" className="cal-acc-head" onClick={() => setMonthOpen((o) => !o)}>
        {monthOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        月カレンダー
      </button>
      {monthOpen && (
        <div className="cal-acc-body">
          <div className="cal-head">
            <button type="button" onClick={() => goMonth(-1)} aria-label="前の月">
              ‹
            </button>
            <span className="cal-title">
              {view.y}年 {view.m + 1}月
            </span>
            <button type="button" onClick={() => goMonth(1)} aria-label="次の月">
              ›
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
          <div className="cal-closeday">
            <span className="muted">選択日: {formatDateJa(selected)}</span>
            <button type="button" className={selectedClosed ? 'btn-closed' : ''} onClick={toggleClosure}>
              {selectedClosed ? '休業日を解除' : '休業日にする'}
            </button>
          </div>
        </div>
      )}

      {/* 日ナビ */}
      <div className="day-nav">
        <div className="day-center">
          <button type="button" onClick={() => shiftDay(-1)} aria-label="前日">
            ‹
          </button>
          <span className="day-label">{formatDateJa(selected)}</span>
          <button type="button" onClick={() => shiftDay(1)} aria-label="翌日">
            ›
          </button>
        </div>
        <div className="view-toggle">
          <button type="button" className={dayView === 'time' ? 'active' : ''} onClick={() => setDayView('time')}>
            時間
          </button>
          <button type="button" className={dayView === 'list' ? 'active' : ''} onClick={() => setDayView('list')}>
            リスト
          </button>
        </div>
      </div>

      <DaySection tenantId={tenantId} date={selected} closed={selectedClosed} dayView={dayView} />
    </section>
  );
}

function DaySection({
  tenantId,
  date,
  closed,
  dayView,
}: {
  tenantId: string;
  date: string;
  closed: boolean;
  dayView: 'time' | 'list';
}) {
  const { data: bookings, loading } = useCollection<Booking>(
    query(bookingsCol(tenantId), where('date', '==', date)),
    [tenantId, date],
  );
  const { data: tenant } = useDocument<Tenant>(tenantDoc(tenantId), [tenantId]);
  const { data: dogs } = useCollection<Dog>(dogsCol(tenantId), [tenantId]);
  const { data: customers } = useCollection<Customer>(customersCol(tenantId), [tenantId]);
  const { data: staff } = useCollection<Staff>(staffCol(tenantId), [tenantId]);
  const { data: services } = useCollection<Service>(servicesCol(tenantId), [tenantId]);
  const { data: options } = useCollection<Option>(optionsCol(tenantId), [tenantId]);
  const { data: pricing } = useCollection<PriceEntry>(pricingCol(tenantId), [tenantId]);

  const dogName = useMemo(() => new Map(dogs.map((d) => [d.id, d.name])), [dogs]);
  const staffName = useMemo(() => new Map(staff.map((s) => [s.id, s.name])), [staff]);
  const serviceName = useMemo(() => new Map(services.map((s) => [s.id, s.name])), [services]);
  // 予約枠の対象スタッフ＝active かつ管理者ロールを除く（管理者は予約に入れない）
  const activeStaff = useMemo(
    () => staff.filter((s) => s.active && s.role !== 'admin').sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    [staff],
  );

  const [createInfo, setCreateInfo] = useState<{ start: string; staffId: string } | null>(null);

  const businessHours =
    tenant?.settings?.businessHours && tenant.settings.businessHours.length > 0
      ? tenant.settings.businessHours
      : [{ start: '09:00', end: '19:00' }];

  const sorted = [...bookings].sort((a, b) => a.startTime.localeCompare(b.startTime));

  return (
    <>
      {loading ? (
        <p>読み込み中…</p>
      ) : dayView === 'time' ? (
        <>
          <TimeGrid
            bookings={sorted}
            businessHours={businessHours}
            staff={activeStaff}
            dogName={dogName}
            serviceName={serviceName}
            closed={closed}
            onCreateAt={(start, staffId) => setCreateInfo({ start, staffId })}
          />
          {!closed && <p className="tg-hint">空き時間をクリックすると予約を作成できます。</p>}
        </>
      ) : (
        <ListView
          tenantId={tenantId}
          bookings={sorted}
          dogName={dogName}
          staffName={staffName}
          serviceName={serviceName}
        />
      )}

      {createInfo && (
        <CreateModal
          tenantId={tenantId}
          date={date}
          startTime={createInfo.start}
          defaultStaffId={createInfo.staffId}
          dogs={dogs}
          customers={customers}
          services={services}
          options={options}
          staff={staff}
          pricing={pricing}
          onClose={() => setCreateInfo(null)}
        />
      )}
    </>
  );
}

function TimeGrid({
  bookings,
  businessHours,
  staff,
  dogName,
  serviceName,
  closed,
  onCreateAt,
}: {
  bookings: Booking[];
  businessHours: { start: string; end: string }[];
  staff: Staff[];
  dogName: Map<string, string>;
  serviceName: Map<string, string>;
  closed: boolean;
  onCreateAt: (startTime: string, staffId: string) => void;
}) {
  const navigate = useNavigate();
  // 営業時間前後に余白を足した軸
  const axisStart = Math.min(...businessHours.map((h) => toMin(h.start))) - EDGE_PAD;
  const axisEnd = Math.max(...businessHours.map((h) => toMin(h.end))) + EDGE_PAD;
  const height = (axisEnd - axisStart) * PX_PER_MIN;

  const hours: number[] = [];
  for (let h = Math.ceil(axisStart / 60) * 60; h <= axisEnd; h += 60) hours.push(h);

  const columns = staff; // スタッフ列
  const colCount = Math.max(1, columns.length);

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (closed) return;
    const layer = e.currentTarget;
    const min = axisStart + Math.round(e.nativeEvent.offsetY / PX_PER_MIN / SLOT_ROUND) * SLOT_ROUND;
    const seg = businessHours.find((h) => min >= toMin(h.start) && min < toMin(h.end));
    if (!seg) return; // 営業時間外
    const colW = layer.clientWidth / colCount;
    const col = Math.min(colCount - 1, Math.max(0, Math.floor(e.nativeEvent.offsetX / colW)));
    onCreateAt(toHHMM(min), columns[col]?.id ?? '');
  }

  return (
    <>
      {/* スタッフ列ヘッダー */}
      <div className="tg-colhead">
        <div className="gutter" />
        {columns.length > 0 ? (
          columns.map((s) => (
            <div key={s.id} className="col">
              {s.name}
            </div>
          ))
        ) : (
          <div className="col muted">（スタッフ未登録）</div>
        )}
      </div>

      <div className="tg" style={{ height }}>
        {/* 営業時間の白背景 */}
        {businessHours.map((h, i) => (
          <div
            key={i}
            className="tg-open"
            style={{
              top: (toMin(h.start) - axisStart) * PX_PER_MIN,
              height: (toMin(h.end) - toMin(h.start)) * PX_PER_MIN,
            }}
          />
        ))}
        {/* 時刻ライン＋ラベル（ラベルは .tg 直下に置き左ガターに配置） */}
        {hours.map((h) => (
          <Fragment key={h}>
            <div className="tg-hour" style={{ top: (h - axisStart) * PX_PER_MIN }} />
            <span className="tg-hour-label" style={{ top: (h - axisStart) * PX_PER_MIN }}>
              {toHHMM(h)}
            </span>
          </Fragment>
        ))}
        {/* 時間列（ガター）の区切り線 */}
        <div className="tg-colsep" style={{ left: '56px' }} />
        {/* スタッフ列の区切り線 */}
        {Array.from({ length: colCount - 1 }, (_, i) => (
          <div
            key={i}
            className="tg-colsep"
            style={{ left: `calc(56px + ${i + 1} * (100% - 66px) / ${colCount})` }}
          />
        ))}
        {/* クリックで作成 */}
        <div className="tg-clicklayer" onClick={handleClick} />
        {/* 予約ブロック */}
        {bookings
          .filter((b) => b.status === 'reserved' || b.status === 'done')
          .map((b) => {
            const s = toMin(b.startTime);
            const colIndex = columns.findIndex((c) => c.id === b.staffId);
            const spanning = colIndex < 0;
            return (
              <button
                key={b.id}
                type="button"
                className={`tg-block${b.status === 'done' ? ' done' : ''}`}
                onClick={() => navigate(`/karte/${b.dogId}`)}
                title="カルテを開く"
                style={{
                  top: (s - axisStart) * PX_PER_MIN,
                  height: Math.max(18, b.durationMin * PX_PER_MIN - 2),
                  left: spanning ? '58px' : `calc(56px + ${colIndex} * (100% - 66px) / ${colCount} + 2px)`,
                  width: spanning ? 'calc(100% - 68px)' : `calc((100% - 66px) / ${colCount} - 4px)`,
                }}
              >
                <div className="b-time">
                  {b.startTime}–{b.slotEnd}
                </div>
                {dogName.get(b.dogId) ?? b.dogId}
                <div style={{ opacity: 0.9, fontSize: '0.7rem' }}>
                  {b.serviceId ? serviceName.get(b.serviceId) ?? '' : b.options?.map((o) => o.name).join('・') ?? ''}
                </div>
              </button>
            );
          })}
        {closed && <div className="tg-closed">休業日</div>}
      </div>
    </>
  );
}

function CreateModal({
  tenantId,
  date,
  startTime,
  defaultStaffId,
  dogs,
  customers,
  services,
  options,
  staff,
  pricing,
  onClose,
}: {
  tenantId: string;
  date: string;
  startTime: string;
  defaultStaffId: string;
  dogs: Dog[];
  customers: Customer[];
  services: Service[];
  options: Option[];
  staff: Staff[];
  pricing: PriceEntry[];
  onClose: () => void;
}) {
  const customerName = useMemo(() => new Map(customers.map((c) => [c.id, c.ownerName])), [customers]);
  const [start, setStart] = useState(startTime);
  const [dogId, setDogId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [optionIds, setOptionIds] = useState<string[]>([]);
  const [staffId, setStaffId] = useState(defaultStaffId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dog = dogs.find((d) => d.id === dogId);
  const cell = dog && serviceId ? pricing.find((p) => p.breedId === dog.breedId && p.serviceId === serviceId) : null;
  const baseDur = cell ? cell.durationMin + (dog?.serviceAdjustments?.[serviceId] ?? 0) : null;
  const activeOptions = options.filter((o) => o.active);
  const optDur = activeOptions
    .filter((o) => optionIds.includes(o.id))
    .reduce((s, o) => s + o.durationMin + (dog?.optionAdjustments?.[o.id] ?? 0), 0);
  const previewDur = baseDur != null ? baseDur + optDur : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!dogId || !serviceId) {
      setErr('ワンちゃんとサービスを選んでください');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await createBookingByStaff({
        tenantId,
        dogId,
        serviceId,
        date,
        startTime: start,
        staffId: staffId || undefined,
        optionIds,
      });
      onClose();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : '予約の作成に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>予約を作成</h2>
        <p className="muted">{formatDateJa(date)}</p>
        <form onSubmit={submit}>
          <label className="inline">
            開始時刻
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            ワンちゃん
            <select value={dogId} onChange={(e) => setDogId(e.target.value)}>
              <option value="">選択してください</option>
              {dogs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {customerName.get(d.customerId) ? `（${customerName.get(d.customerId)}）` : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            サービス
            <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="">選択してください</option>
              {services.filter((s) => s.active).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {dog && serviceId && !cell && (
            <p className="muted">※ この犬種×サービスは料金表が未設定です（既定時間で確保されます）。</p>
          )}
          {activeOptions.length > 0 && (
            <div>
              <label>オプション（複数選択可）</label>
              <div className="opt-list">
                {activeOptions.map((o) => (
                  <label key={o.id} className="opt-item">
                    <input
                      type="checkbox"
                      checked={optionIds.includes(o.id)}
                      onChange={() =>
                        setOptionIds((prev) =>
                          prev.includes(o.id) ? prev.filter((x) => x !== o.id) : [...prev, o.id],
                        )
                      }
                    />
                    {o.name}
                    <span className="opt-meta">+{o.durationMin + (dog?.optionAdjustments?.[o.id] ?? 0)}分</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <label>
            指名（任意）
            <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              <option value="">指名なし（空いているスタッフ）</option>
              {staff.filter((s) => s.active && s.role !== 'admin').map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {previewDur != null && <p className="muted">所要 {previewDur}分（バッファ込みで枠を確保）</p>}
          {err && <p className="error">{err}</p>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              キャンセル
            </button>
            <button type="submit" disabled={busy}>
              {busy ? '作成中…' : '予約する'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ListView({
  tenantId,
  bookings,
  dogName,
  staffName,
  serviceName,
}: {
  tenantId: string;
  bookings: Booking[];
  dogName: Map<string, string>;
  staffName: Map<string, string>;
  serviceName: Map<string, string>;
}) {
  const navigate = useNavigate();
  return (
    <div className="table-wrap">
      <table className="booking-list">
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
          {bookings.map((b) => (
            <tr key={b.id}>
              <td data-label="時間">
                {b.startTime}〜{b.slotEnd}
              </td>
              <td data-label="ワンちゃん">
                <button type="button" className="link-btn" onClick={() => navigate(`/karte/${b.dogId}`)} title="カルテを開く">
                  {dogName.get(b.dogId) ?? b.dogId}
                </button>
              </td>
              <td data-label="メニュー">
                {b.serviceId
                  ? `${serviceName.get(b.serviceId) ?? b.serviceId}${b.options && b.options.length > 0 ? ` ＋${b.options.length}` : ''}`
                  : b.options && b.options.length > 0
                    ? b.options.map((o) => o.name).join('・')
                    : '—'}
              </td>
              <td data-label="担当">{b.staffId ? staffName.get(b.staffId) ?? b.staffId : '未割当'}</td>
              <td data-label="状態">{statusLabel(b.status)}</td>
              <td data-label="施術完了" className="bl-action">
                {b.status === 'reserved' ? (
                  <>
                    <CompleteForm tenantId={tenantId} booking={b} />
                    <div className="row-form" style={{ margin: '4px 0 0' }}>
                      <button onClick={() => setStatus(tenantId, b.id, 'canceled')}>キャンセル</button>
                      <button onClick={() => setStatus(tenantId, b.id, 'noshow')}>無断欠席</button>
                    </div>
                  </>
                ) : b.status === 'done' ? (
                  <>
                    <span className="muted">
                      {b.finalDurationMin}分 / ¥{(b.finalPrice ?? 0).toLocaleString()}
                    </span>
                    <PosSendButton tenantId={tenantId} booking={b} />
                  </>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
          {bookings.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                この日の予約はありません
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 完了済み予約の「POSへ会計送信」ボタン（①会計連携）。
 * 送信結果は booking.posCheckout に載って購読で反映されるが、
 * 反映前の連打を防ぐためローカルでも送信済み表示に切り替える。再送は冪等で安全。
 */
function PosSendButton({ tenantId, booking }: { tenantId: string; booking: Booking }) {
  const [busy, setBusy] = useState(false);
  const [sentLocal, setSentLocal] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sent = sentLocal || booking.posCheckout?.status === 'sent';
  const paid = booking.posCheckout?.posStatus === 'paid';

  async function onSend() {
    setBusy(true);
    setErr(null);
    try {
      await sendCheckoutToPos({ tenantId, bookingId: booking.id });
      setSentLocal(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'POSへの送信に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  if (paid) return <div className="row-form" style={{ margin: '4px 0 0' }}><span className="muted">POS会計済み ✓</span></div>;
  return (
    <div className="row-form" style={{ margin: '4px 0 0' }}>
      <button type="button" onClick={onSend} disabled={busy}>
        {busy ? '送信中…' : sent ? 'POSへ再送' : 'POSへ会計送信'}
      </button>
      {sent && !busy && <span className="muted">送信済 ✓</span>}
      {err && <span className="error">{err}</span>}
    </div>
  );
}

function statusLabel(s: Booking['status']): string {
  return { reserved: '予約', done: '完了', canceled: 'キャンセル', noshow: '無断欠席' }[s];
}

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
