import { Fragment, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { deleteDoc, doc, documentId, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import {
  bookingsCol,
  breedsCol,
  closuresCol,
  customersCol,
  dogsCol,
  optionsCol,
  pricingCol,
  recordsCol,
  servicesCol,
  shiftDoc,
  shiftsCol,
  staffCol,
  tenantDoc,
} from '../lib/firestore';
import { completeBooking, createBookingByStaff, rescheduleBooking, sendCheckoutToPos } from '../lib/functions';
import { useCollection } from '../lib/useCollection';
import { useDocument } from '../lib/useDocument';
import { isWithinHours, staffHoursFor, subtractIntervals } from '../lib/shifts';
import type { Booking, Breed, Closure, Customer, Dog, Option, PriceEntry, Service, ServiceRecord, ShiftDayDoc, Staff, Tenant } from '../lib/types';

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
/** 予約変更リスト用の短い日付表示（例: 8/9（日）） */
function mdLabel(ds: string): string {
  const [y, m, d] = ds.split('-').map(Number);
  return `${m}/${d}（${DOW[new Date(y, m - 1, d).getDay()]}）`;
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

  // 全員終日休みの自動休業も月カレンダーに「休」を出す（シフト①・顧客側getClosedDatesと同じ導出）
  const { data: calTenant } = useDocument<Tenant>(tenantDoc(tenantId), [tenantId]);
  const { data: calStaff } = useCollection<Staff>(staffCol(tenantId), [tenantId]);
  const { data: calShiftDays } = useCollection<ShiftDayDoc>(
    query(shiftsCol(tenantId), where(documentId(), '>=', rangeStart), where(documentId(), '<=', rangeEnd)),
    [tenantId, rangeStart, rangeEnd],
  );
  const bookableIds = useMemo(
    () => calStaff.filter((x) => x.active && x.role !== 'admin').map((x) => x.id),
    [calStaff],
  );
  const autoClosedDates = useMemo(() => {
    const s = calTenant?.settings;
    if ((s?.autoCloseWhenAllOff ?? true) === false) return new Set<string>();
    const bh = s?.businessHours && s.businessHours.length > 0 ? s.businessHours : [{ start: '09:00', end: '19:00' }];
    if (bookableIds.length === 0) return new Set<string>();
    const out = new Set<string>();
    for (const sd of calShiftDays) {
      if (bookableIds.every((sid) => staffHoursFor(sd.staff, sid, bh).length === 0)) out.add(sd.id);
    }
    return out;
  }, [calTenant, bookableIds, calShiftDays]);
  // シフトが誰も決まっていない日は「未定」バッジ（未定ゲートON時・今日以降。顧客アプリと同じ見え方）
  const undecidedDates = useMemo(() => {
    if (!(calTenant?.settings?.requireShiftForBooking ?? false) || bookableIds.length === 0) return new Set<string>();
    const byDate = new Map(calShiftDays.map((s) => [s.id, s]));
    const out = new Set<string>();
    for (const d of gridDays) {
      const ds = fmt(d);
      if (ds < today) continue;
      const sd = byDate.get(ds);
      if (!bookableIds.some((sid) => !!sd?.staff?.[sid])) out.add(ds);
    }
    return out;
  }, [calTenant, bookableIds, calShiftDays, gridDays, today]);

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

      {/* 月カレンダー開閉と時間/リスト切替を1行に */}
      <div className="cal-tools-row">
        <button type="button" className="cal-acc-head" onClick={() => setMonthOpen((o) => !o)}>
          {monthOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          月カレンダー
        </button>
        <div className="view-toggle">
          <button type="button" className={dayView === 'time' ? 'active' : ''} onClick={() => setDayView('time')}>
            時間
          </button>
          <button type="button" className={dayView === 'list' ? 'active' : ''} onClick={() => setDayView('list')}>
            リスト
          </button>
        </div>
      </div>
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
              const autoClosed = !closed && autoClosedDates.has(ds); // 全員終日休み（シフト由来）
              const cls = ['cal-cell'];
              if (!inMonth) cls.push('other');
              if (ds === today) cls.push('today');
              if (ds === selected) cls.push('selected');
              if (closed || autoClosed) cls.push('closed');
              return (
                <button key={ds} type="button" className={cls.join(' ')} onClick={() => pickDay(d)}>
                  <span className={`cal-daynum${dow === 0 ? ' sun' : dow === 6 ? ' sat' : ''}`}>{d.getDate()}</span>
                  {closed || autoClosed ? (
                    <span className="cal-badge closed" title={autoClosed ? 'スタッフ全員が終日休み' : '休業日'}>
                      休
                    </span>
                  ) : count > 0 ? (
                    <span className="cal-badge count">{count}件</span>
                  ) : undecidedDates.has(ds) ? (
                    <span className="cal-badge undecided" title="シフトが未設定（未定ゲートONのため受付停止中）">
                      未定
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <DaySection tenantId={tenantId} date={selected} closed={selectedClosed} dayView={dayView} />

      {/* 下固定バーに隠れないための余白 */}
      <div style={{ height: 56 }} aria-hidden />

      {/* 日ナビ: 画面最下部に固定（表の長さに関係なく常にピッタリ下）。休業日の切替もここに集約 */}
      <div className="day-nav day-nav-fixed">
        <div className="day-center">
          <button type="button" onClick={() => shiftDay(-1)} aria-label="前日">
            ‹
          </button>
          <span className="day-label">{formatDateJa(selected)}</span>
          <button type="button" onClick={() => shiftDay(1)} aria-label="翌日">
            ›
          </button>
        </div>
        {!selectedClosed && autoClosedDates.has(selected) ? (
          // シフト由来の休業（全員終日休み）。手動休業とは別物なのでボタンではなく状態表示
          <span className="closeday-btn allday-off" title="スタッフ全員が終日休みのため休業表示中。シフトで出勤に戻すと解除されます">
            全員休み
          </span>
        ) : (
          <button
            type="button"
            className={`closeday-btn${selectedClosed ? ' btn-closed' : ''}`}
            onClick={toggleClosure}
          >
            {selectedClosed ? '休業日を解除' : '休業日にする'}
          </button>
        )}
      </div>
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
  // 予約詳細モーダル（リスト行の操作＋カルテを合体）。購読中の bookings から常に最新を引く
  const [detailId, setDetailId] = useState<string | null>(null);

  const businessHours =
    tenant?.settings?.businessHours && tenant.settings.businessHours.length > 0
      ? tenant.settings.businessHours
      : [{ start: '09:00', end: '19:00' }];

  // シフト①: この日のシフト。シフト外になった既存予約は動かさず警告バッジのみ（運用で振替）
  const { data: shiftDay } = useDocument<ShiftDayDoc>(shiftDoc(tenantId, date), [tenantId, date]);
  const offShift = (b: Booking): boolean => {
    if (!b.staffId || b.status !== 'reserved') return false;
    const hours = staffHoursFor(shiftDay?.staff, b.staffId, businessHours);
    return !isWithinHours(hours, b.startTime, b.slotEnd);
  };
  // スタッフ列のシフト休み帯（営業時間 − 実効勤務時間）。グリッドのグレー表示＋作成ブロックに使う
  const offIntervalsFor = (staffId: string) =>
    subtractIntervals(businessHours, staffHoursFor(shiftDay?.staff, staffId, businessHours));
  // 未定ゲートON時: シフト未定のスタッフ列は「未定」表示にして予約作成も弾く（サーバ側も拒否）
  const requireShift = tenant?.settings?.requireShiftForBooking ?? false;
  const undecidedFor = (staffId: string) => requireShift && !shiftDay?.staff?.[staffId];

  const sorted = [...bookings].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const detailBooking = detailId ? sorted.find((b) => b.id === detailId) ?? null : null;

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
            offShift={offShift}
            offIntervalsFor={offIntervalsFor}
            undecidedFor={undecidedFor}
            onCreateAt={(start, staffId) => setCreateInfo({ start, staffId })}
            onOpen={(b) => setDetailId(b.id)}
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
          offShift={offShift}
          onOpen={(b) => setDetailId(b.id)}
        />
      )}

      {detailBooking && (
        <BookingDetailModal
          tenantId={tenantId}
          booking={detailBooking}
          dog={dogs.find((d) => d.id === detailBooking.dogId) ?? null}
          customer={customers.find((c) => c.id === detailBooking.customerId) ?? null}
          staffName={staffName}
          serviceName={serviceName}
          pricing={pricing}
          offShift={offShift}
          onClose={() => setDetailId(null)}
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
  offShift,
  offIntervalsFor,
  undecidedFor,
  onCreateAt,
  onOpen,
}: {
  bookings: Booking[];
  businessHours: { start: string; end: string }[];
  staff: Staff[];
  dogName: Map<string, string>;
  serviceName: Map<string, string>;
  closed: boolean;
  offShift: (b: Booking) => boolean;
  offIntervalsFor: (staffId: string) => { start: string; end: string }[];
  undecidedFor: (staffId: string) => boolean;
  onCreateAt: (startTime: string, staffId: string) => void;
  onOpen: (b: Booking) => void;
}) {
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
    const colStaffId = columns[col]?.id ?? '';
    // シフト休み・未定の列には作成させない（オーバーレイが吸うが、保険としてここでも判定）
    if (colStaffId && undecidedFor(colStaffId)) return;
    if (colStaffId && offIntervalsFor(colStaffId).some((iv) => min >= toMin(iv.start) && min < toMin(iv.end))) return;
    onCreateAt(toHHMM(min), colStaffId);
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
        {/* シフト未定の列（未定ゲートON時）。列全体を覆い、作成もブロック */}
        {columns.map((s, i) => {
          if (!undecidedFor(s.id)) return null;
          const bhStart = Math.min(...businessHours.map((h) => toMin(h.start)));
          const bhEnd = Math.max(...businessHours.map((h) => toMin(h.end)));
          return (
            <div
              key={`undecided:${s.id}`}
              className="tg-off tg-undecided"
              title={`${s.name} はこの日のシフトが未定です（シフトを設定すると予約できます）`}
              style={{
                top: (bhStart - axisStart) * PX_PER_MIN,
                height: (bhEnd - bhStart) * PX_PER_MIN,
                left: `calc(56px + ${i} * (100% - 66px) / ${colCount} + 2px)`,
                width: `calc((100% - 66px) / ${colCount} - 4px)`,
              }}
            >
              未定
            </div>
          );
        })}
        {/* シフト休みの帯（スタッフ列単位）。クリック層より上に重ねて作成もブロック */}
        {columns.map((s, i) => {
          if (undecidedFor(s.id)) return null;
          const offs = offIntervalsFor(s.id);
          const bhStart = Math.min(...businessHours.map((h) => toMin(h.start)));
          const bhEnd = Math.max(...businessHours.map((h) => toMin(h.end)));
          return offs.map((iv) => {
            const st = toMin(iv.start);
            const en = toMin(iv.end);
            const fullDay = st <= bhStart && en >= bhEnd;
            return (
              <div
                key={`${s.id}:${iv.start}`}
                className="tg-off"
                title={`${s.name} はこの時間シフト休みです`}
                style={{
                  top: (st - axisStart) * PX_PER_MIN,
                  height: (en - st) * PX_PER_MIN,
                  left: `calc(56px + ${i} * (100% - 66px) / ${colCount} + 2px)`,
                  width: `calc((100% - 66px) / ${colCount} - 4px)`,
                }}
              >
                {fullDay ? 'お休み' : '休'}
              </div>
            );
          });
        })}
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
                onClick={() => onOpen(b)}
                title="予約の詳細を開く"
                style={{
                  top: (s - axisStart) * PX_PER_MIN,
                  height: Math.max(18, b.durationMin * PX_PER_MIN - 2),
                  left: spanning ? '58px' : `calc(56px + ${colIndex} * (100% - 66px) / ${colCount} + 2px)`,
                  width: spanning ? 'calc(100% - 68px)' : `calc((100% - 66px) / ${colCount} - 4px)`,
                }}
              >
                <div className="b-time">
                  {b.startTime}–{b.slotEnd}
                  {offShift(b) && (
                    <span title="担当スタッフのシフト外です（シフト変更後の振替待ち）" style={{ color: '#c0392b' }}>
                      {' '}
                      ⚠
                    </span>
                  )}
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
  offShift,
  onOpen,
}: {
  tenantId: string;
  bookings: Booking[];
  dogName: Map<string, string>;
  staffName: Map<string, string>;
  serviceName: Map<string, string>;
  offShift: (b: Booking) => boolean;
  onOpen: (b: Booking) => void;
}) {
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
            <th>施術完了</th>
          </tr>
        </thead>
        <tbody>
          {bookings.map((b) => (
            <tr key={b.id}>
              <td data-label="時間">
                {b.startTime}〜{b.slotEnd}
              </td>
              <td data-label="ワンちゃん">
                <button type="button" className="link-btn" onClick={() => onOpen(b)} title="予約の詳細を開く">
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
              <td data-label="状態">
                {statusLabel(b.status)}
                {offShift(b) && (
                  <span className="error" title="担当スタッフのシフト外です。担当か日時の変更をご検討ください">
                    {' '}
                    ⚠シフト外
                  </span>
                )}
              </td>
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
 * 予約詳細モーダル: 予約操作とカルテ（作業時間・料金/オプション超過/メモ/アレルギー）を合体。
 * 「完了して履歴を保存」でカルテの編集内容を犬docへ保存し、completeBooking で
 * 確定時間・確定料金・施術メモを記録する。確定料金は料金表×個別加算からの自動合算（手修正可）。
 * booking は購読中のリストから渡されるため、完了後もモーダルを開いたまま done 表示に切り替わる。
 */
const ceil50 = (n: number) => Math.ceil(n / 50) * 50;

function BookingDetailModal({
  tenantId,
  booking,
  dog,
  customer,
  staffName,
  serviceName,
  pricing,
  offShift,
  onClose,
}: {
  tenantId: string;
  booking: Booking;
  dog: Dog | null;
  customer: Customer | null;
  staffName: Map<string, string>;
  serviceName: Map<string, string>;
  pricing: PriceEntry[];
  offShift: (b: Booking) => boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { data: breeds } = useCollection<Breed>(breedsCol(tenantId), [tenantId]);
  const { data: records } = useCollection<ServiceRecord>(recordsCol(tenantId, booking.dogId), [tenantId, booking.dogId]);
  const recent = useMemo(() => [...records].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3), [records]);
  const breedLabel = dog?.breedId ? breeds.find((b) => b.id === dog.breedId)?.name ?? dog?.breed ?? '' : dog?.breed ?? '';

  // この予約のサービスの料金表セル（犬種×サービス）
  const cell = useMemo(
    () =>
      booking.serviceId && dog?.breedId
        ? pricing.find((c) => c.breedId === dog.breedId && c.serviceId === booking.serviceId && c.active !== false) ?? null
        : null,
    [pricing, booking.serviceId, dog?.breedId],
  );
  const bookedOptions = booking.options ?? [];

  // カルテ編集フォーム（開いた予約ごとに犬docから初期化）
  const [svcAdj, setSvcAdj] = useState(0);
  const [optAdj, setOptAdj] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState('');
  const [allergies, setAllergies] = useState('');
  const [recNotes, setRecNotes] = useState('');
  const [price, setPrice] = useState(0);
  const [priceTouched, setPriceTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setSvcAdj(booking.serviceId ? dog?.serviceAdjustments?.[booking.serviceId] ?? 0 : 0);
    const oa: Record<string, number> = {};
    for (const o of booking.options ?? []) oa[o.id] = dog?.optionAdjustments?.[o.id] ?? 0;
    setOptAdj(oa);
    setNotes(dog?.notes ?? '');
    setAllergies(dog?.allergies ?? '');
    setRecNotes('');
    setPriceTouched(false);
    setErr(null);
    setReschedDays(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking.id]);

  // 予約変更: 今日〜受付範囲の日別空き候補（サーバ算出・シフト/休業/他予約考慮）をスクロールリストで提示
  const [reschedDays, setReschedDays] = useState<{ date: string; slots: string[] }[] | null>(null);
  const [reschedBusy, setReschedBusy] = useState(false);
  async function openResched() {
    if (reschedDays != null) {
      setReschedDays(null);
      return;
    }
    setReschedBusy(true);
    setErr(null);
    try {
      const res = await rescheduleBooking({ tenantId, bookingId: booking.id });
      setReschedDays(res.data.days);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '空き時間を取得できませんでした');
    } finally {
      setReschedBusy(false);
    }
  }
  async function doResched(ds: string, s: string) {
    if (reschedBusy) return;
    if (!confirm(`${mdLabel(booking.date)} ${booking.startTime} → ${mdLabel(ds)} ${s} に変更しますか？`)) return;
    setReschedBusy(true);
    setErr(null);
    try {
      await rescheduleBooking({ tenantId, bookingId: booking.id, date: ds, startTime: s });
      setReschedDays(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '変更できませんでした（他の予約と重なった可能性があります）');
    } finally {
      setReschedBusy(false);
    }
  }

  // 確定時間・確定料金の自動合算（料金表の標準＋個別加算・超過。加算分は分単価×時間を50円単位切上げ）
  const svcDur = cell ? cell.durationMin + svcAdj : 0;
  const svcPrice = cell ? cell.price + ceil50((cell.durationMin > 0 ? cell.price / cell.durationMin : 0) * svcAdj) : 0;
  const optCalc = bookedOptions.map((o) => {
    const add = optAdj[o.id] ?? 0;
    const unit = o.durationMin > 0 ? o.price / o.durationMin : 0;
    return { ...o, add, dur: o.durationMin + add, effPrice: o.price + ceil50(unit * add) };
  });
  const autoDur = svcDur + optCalc.reduce((s, o) => s + o.dur, 0);
  const autoPrice = svcPrice + optCalc.reduce((s, o) => s + o.effPrice, 0);
  useEffect(() => {
    if (!priceTouched) setPrice(autoPrice);
  }, [autoPrice, priceTouched]);

  const finalDur = autoDur > 0 ? autoDur : booking.durationMin;

  // 完了して履歴を保存: カルテ（犬doc）更新 → completeBooking（確定値＋施術メモ→records）
  async function onCompleteAndSave() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      if (dog) {
        const nextSvcAdj = { ...(dog.serviceAdjustments ?? {}) };
        if (booking.serviceId) {
          if (svcAdj > 0) nextSvcAdj[booking.serviceId] = svcAdj;
          else delete nextSvcAdj[booking.serviceId];
        }
        const nextOptAdj = { ...(dog.optionAdjustments ?? {}) };
        for (const o of bookedOptions) {
          const v = optAdj[o.id] ?? 0;
          if (v > 0) nextOptAdj[o.id] = v;
          else delete nextOptAdj[o.id];
        }
        await updateDoc(doc(dogsCol(tenantId), dog.id), {
          serviceAdjustments: nextSvcAdj,
          optionAdjustments: nextOptAdj,
          notes,
          allergies,
        });
      }
      await completeBooking({
        tenantId,
        bookingId: booking.id,
        finalDurationMin: finalDur,
        finalPrice: price,
        ...(recNotes.trim() ? { notes: recNotes.trim() } : {}),
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  const menu = booking.serviceId
    ? `${serviceName.get(booking.serviceId) ?? booking.serviceId}${
        bookedOptions.length > 0 ? ` ＋${bookedOptions.map((o) => o.name).join('・')}` : ''
      }`
    : bookedOptions.map((o) => o.name).join('・') || '—';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {/* 1. 閉じる✕は最上段の右寄せ（名前より上・独立行） */}
        <button type="button" className="modal-close bdm-close" onClick={onClose} aria-label="閉じる">
          ✕
        </button>
        {/* 名前（大きめ）＋犬種 */}
        <div className="bdm-head">
          <div>
            <div className="bdm-name">{dog?.name ?? 'ワンちゃん'}</div>
            <div className="muted" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {breedLabel || '犬種未設定'}
              <button type="button" className="link-btn" onClick={() => navigate(`/karte/${booking.dogId}`)}>
                カルテを見る
              </button>
            </div>
          </div>
        </div>

        {/* 2. 時間 / 予約メニュー・担当（日付・状態表記は省略。開いた日の予約なので自明） */}
        <p style={{ margin: '0 0 4px' }}>
          <strong>
            {booking.startTime}〜{booking.slotEnd}
          </strong>
          {offShift(booking) && (
            <span className="error" title="担当スタッフのシフト外です。担当か日時の変更をご検討ください">
              {' '}
              ⚠シフト外
            </span>
          )}
        </p>
        <p className="muted" style={{ margin: '0 0 12px' }}>
          予約メニュー: {menu} ／ 担当: {booking.staffId ? staffName.get(booking.staffId) ?? booking.staffId : '未割当'}
        </p>

        {/* 3. 予約の操作（変更・取り消し系。予約情報の直下） */}
        {booking.status === 'reserved' && (
          <>
            <div className="row-form" style={{ margin: '0 0 8px' }}>
              <button onClick={openResched} disabled={reschedBusy}>
                {reschedBusy ? '空きを確認中…' : '予約変更'}
              </button>
              <button onClick={() => setStatus(tenantId, booking.id, 'canceled')}>キャンセル</button>
              <button onClick={() => setStatus(tenantId, booking.id, 'noshow')}>無断欠席</button>
            </div>
            {reschedDays != null && (
              <div style={{ margin: '0 0 14px' }}>
                {reschedDays.length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>
                    受付範囲内に空きがありません。
                  </p>
                ) : (
                  <>
                    <p className="muted" style={{ margin: '0 0 4px' }}>
                      日付ごとの空きです。時間をタップすると {mdLabel(booking.date)} {booking.startTime} から変更します。
                    </p>
                    <div className="resched-list">
                      {reschedDays.map((d) => (
                        <div key={d.date} className="resched-day">
                          <div className={`resched-date${d.date === booking.date ? ' current' : ''}`}>
                            {mdLabel(d.date)}
                            {d.date === booking.date && <span className="muted">（現在の日）</span>}
                          </div>
                          <div className="slot-chips">
                            {d.slots.map((s) => (
                              <button key={s} type="button" className="slot-chip" onClick={() => doResched(d.date, s)}>
                                {s}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {/* 4. 飼い主・連絡手段 */}
        {customer && (
          <>
            <p className="muted" style={{ margin: 0 }}>
              飼い主: {customer.ownerName}
              {customer.phone ? `（${customer.phone}）` : ''}
            </p>
            <div className="row-form" style={{ margin: '6px 0 0' }}>
              {customer.phone && (
                <a className="header-btn" href={`tel:${customer.phone}`}>
                  電話
                </a>
              )}
              {customer.lineUserId && (
                <a className="header-btn" href="https://chat.line.biz/" target="_blank" rel="noreferrer">
                  LINEで連絡
                </a>
              )}
            </div>
          </>
        )}

        {booking.status === 'reserved' ? (
          <>
            {/* 7. カルテ（この予約のサービス/オプションに絞って編集） */}
            <fieldset style={{ marginTop: 12 }}>
              <legend>作業時間・料金（料金表 犬種×サービス）</legend>
              {!booking.serviceId ? (
                <p className="muted">単品オプションのご予約です（下のオプション超過で調整できます）。</p>
              ) : !cell ? (
                <p className="muted">この犬種×サービスの料金表が未設定です。メニューの料金表で登録してください。</p>
              ) : (
                <div className="karte-line">
                  <span className="muted">標準 {cell.durationMin}分 / ¥{cell.price.toLocaleString()}</span>
                  <span className="karte-adj">
                    個別加算 ＋
                    <input
                      type="number"
                      min={0}
                      step={5}
                      value={svcAdj}
                      onChange={(e) => setSvcAdj(Math.max(0, Number(e.target.value)))}
                    />
                    分
                  </span>
                  <strong>→ {svcDur}分 / ¥{svcPrice.toLocaleString()}</strong>
                </div>
              )}
            </fieldset>

            {optCalc.length > 0 && (
              <fieldset style={{ marginTop: 8 }}>
                <legend>オプション超過時間の設定</legend>
                {optCalc.map((o) => (
                  <div key={o.id} className="karte-line">
                    <span>
                      {o.name}
                      <span className="muted">（標準{o.durationMin}分 / ¥{o.price.toLocaleString()}）</span>
                    </span>
                    <span className="karte-adj">
                      超過 ＋
                      <input
                        type="number"
                        min={0}
                        step={5}
                        value={o.add}
                        onChange={(e) => setOptAdj((m) => ({ ...m, [o.id]: Math.max(0, Number(e.target.value)) }))}
                      />
                      分
                    </span>
                    <strong>→ {o.dur}分 / ¥{o.effPrice.toLocaleString()}</strong>
                  </div>
                ))}
              </fieldset>
            )}

            <label style={{ marginTop: 8 }}>
              メモ（噛み癖・サイズ等）
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </label>
            <label>
              アレルギー
              <textarea value={allergies} onChange={(e) => setAllergies(e.target.value)} rows={2} />
            </label>
            <label>
              施術メモ（今回の施術内容・履歴に残ります）
              <textarea value={recNotes} onChange={(e) => setRecNotes(e.target.value)} rows={2} />
            </label>

            {/* 8. 確定料金（自動合算・手修正可）＋確定時間 */}
            <div className="book-summary" style={{ marginTop: 10 }}>
              確定 {finalDur}分 ／ 確定料金
              {/* ¥とカンマ付きでフィールド内に表示（数字だけ拾って保存） */}
              <input
                type="text"
                inputMode="numeric"
                className="bdm-price"
                value={`¥${price.toLocaleString()}`}
                onChange={(e) => {
                  const digits = e.target.value.replace(/[^0-9]/g, '');
                  setPriceTouched(true);
                  setPrice(digits ? Math.min(9_999_999, Number(digits)) : 0);
                }}
              />
              {priceTouched && price !== autoPrice && (
                <button type="button" className="link-btn" style={{ marginLeft: 8 }} onClick={() => { setPriceTouched(false); setPrice(autoPrice); }}>
                  自動計算に戻す（¥{autoPrice.toLocaleString()}）
                </button>
              )}
            </div>
          </>
        ) : booking.status === 'done' ? (
          <div style={{ marginTop: 10 }}>
            <span className="muted">
              確定: {booking.finalDurationMin}分 / ¥{(booking.finalPrice ?? 0).toLocaleString()}
            </span>
            <PosSendButton tenantId={tenantId} booking={booking} />
          </div>
        ) : null}

        {/* 9. 前回の施術履歴 */}
        <h3 className="pick-head" style={{ marginTop: 14 }}>
          前回の施術履歴
        </h3>
        {(dog?.allergies || dog?.notes) && booking.status !== 'reserved' && (
          <p className="muted" style={{ margin: '0 0 6px' }}>
            {dog?.allergies ? `アレルギー: ${dog.allergies}　` : ''}
            {dog?.notes ? `メモ: ${dog.notes}` : ''}
          </p>
        )}
        {recent.length === 0 ? (
          <p className="muted">施術履歴はまだありません。</p>
        ) : (
          <div className="cart-list">
            {recent.map((r) => (
              <div key={r.id} className="cart-item">
                <div className="cart-item-body">
                  <div className="cart-item-title">
                    {r.date}
                    {r.serviceId ? ` ${serviceName.get(r.serviceId) ?? ''}` : ''}
                    {r.staffId ? `（${staffName.get(r.staffId) ?? ''}）` : ''}
                  </div>
                  <div className="cart-item-meta">
                    {r.durationMin}分 / ¥{r.price.toLocaleString()}
                    {r.notes ? ` ・ 施術メモ: ${r.notes}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {err && <p className="error">{err}</p>}

        {/* 10. 完了して履歴を保存 / 閉じる */}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            閉じる
          </button>
          {booking.status === 'reserved' && (
            <button type="button" className="primary" disabled={busy} onClick={onCompleteAndSave}>
              {busy ? '保存中…' : '完了して履歴を保存'}
            </button>
          )}
        </div>
      </div>
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
  // POS未連携テナント(coreTenantId/coreSpaceId無し)ではボタンを出さない。
  // prodなど連携未設定の環境で「押すとエラー」になるのを防ぐ自己ガード。
  const { data: tenant } = useDocument<Tenant & { coreTenantId?: string; coreSpaceId?: string }>(
    tenantDoc(tenantId),
    [tenantId],
  );
  const posLinked = Boolean(tenant?.coreTenantId && tenant?.coreSpaceId);
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

  if (!posLinked) return null;
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
