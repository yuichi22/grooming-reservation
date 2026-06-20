import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { getAccessToken, getProfile, initLiff, isDevMode } from './liff';
import {
  createBooking,
  customerSession,
  getAvailability,
  getBookingOptions,
  getClosedDates,
  registerDog,
  type BookingOptions,
} from './customerApi';

type Phase = 'init' | 'needPhone' | 'ready' | 'done' | 'error';
type Picker = null | 'dog' | 'service' | 'option' | 'staff';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const PX_PER_MIN = 1;
const EDGE_PAD = 30;

function fmt(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayStr() {
  return fmt(new Date());
}
function formatDateJa(ds: string) {
  const [y, m, d] = ds.split('-').map(Number);
  return `${y}年${m}月${d}日（${DOW[new Date(y, m - 1, d).getDay()]}）`;
}
const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const toHHMM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export default function BookingPage() {
  const [params] = useSearchParams();
  const tenantId = params.get('tenant') ?? (import.meta.env.VITE_DEFAULT_TENANT_ID as string) ?? 'groomhaus';

  const [phase, setPhase] = useState<Phase>('init');
  const [error, setError] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [options, setOptions] = useState<BookingOptions | null>(null);

  // 予約選択
  const [dogId, setDogId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [optionIds, setOptionIds] = useState<string[]>([]);
  const [staffId, setStaffId] = useState('');
  const [date, setDate] = useState(todayStr());
  const [monthOpen, setMonthOpen] = useState(false);
  const [view, setView] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [closedMonth, setClosedMonth] = useState<Set<string>>(new Set());

  // 空き状況
  const [slots, setSlots] = useState<string[] | null>(null);
  const [businessHours, setBusinessHours] = useState<{ start: string; end: string }[] | null>(null);
  const [closedDay, setClosedDay] = useState(false);
  const [loadingSlots, setLoadingSlots] = useState(false);

  const [picker, setPicker] = useState<Picker>(null);
  const [confirmSlot, setConfirmSlot] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ startTime: string; slotEnd: string } | null>(null);

  async function loadOptions(cid: string) {
    const res = await getBookingOptions({ tenantId, accessToken: getAccessToken(), customerId: cid });
    setOptions(res.data);
  }

  useEffect(() => {
    (async () => {
      try {
        await initLiff();
        await getProfile();
        const res = await customerSession({ tenantId, accessToken: getAccessToken() });
        setCustomerId(res.data.customerId);
        if (res.data.needsPhone) {
          setPhase('needPhone');
        } else {
          if (res.data.options) setOptions(res.data.options);
          else await loadOptions(res.data.customerId);
          setPhase('ready');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : '初期化に失敗しました');
        setPhase('error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 犬・サービス選択時に空き状況を自動取得
  useEffect(() => {
    if (phase !== 'ready' || !dogId || !serviceId) {
      setSlots(null);
      setBusinessHours(null);
      return;
    }
    let cancelled = false;
    setLoadingSlots(true);
    (async () => {
      try {
        const res = await getAvailability({
          tenantId,
          accessToken: getAccessToken(),
          date,
          serviceId,
          dogId,
          staffId: staffId || undefined,
          optionIds,
        });
        if (cancelled) return;
        setSlots(res.data.slots);
        setBusinessHours(res.data.businessHours);
        setClosedDay(!!res.data.closed);
      } catch {
        if (!cancelled) setSlots([]);
      } finally {
        if (!cancelled) setLoadingSlots(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, dogId, serviceId, staffId, date, optionIds.join(',')]);

  // 月カレンダー表示範囲の休業日を取得（顧客はFirestore直読み不可のため関数経由）
  useEffect(() => {
    if (phase !== 'ready') return;
    const first = new Date(view.y, view.m, 1);
    const gs = new Date(first);
    gs.setDate(1 - first.getDay());
    const ge = new Date(gs);
    ge.setDate(gs.getDate() + 41);
    let cancelled = false;
    (async () => {
      try {
        const res = await getClosedDates({ tenantId, accessToken: getAccessToken(), from: fmt(gs), to: fmt(ge) });
        if (!cancelled) setClosedMonth(new Set(res.data.dates));
      } catch {
        /* 表示用なので失敗は無視 */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, view.y, view.m]);

  async function submitPhone(e: FormEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const phone = (form.elements.namedItem('phone') as HTMLInputElement).value.trim();
    const ownerName = (form.elements.namedItem('ownerName') as HTMLInputElement).value.trim();
    try {
      const res = await customerSession({ tenantId, accessToken: getAccessToken(), phone, ownerName });
      setCustomerId(res.data.customerId);
      if (res.data.options) setOptions(res.data.options);
      else await loadOptions(res.data.customerId);
      setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : '登録に失敗しました');
    }
  }

  async function addDog(e: FormEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const name = (form.elements.namedItem('dogName') as HTMLInputElement).value.trim();
    const breedId = (form.elements.namedItem('breedId') as HTMLSelectElement).value;
    if (!name) return;
    const res = await registerDog({ tenantId, accessToken: getAccessToken(), customerId, name, breedId: breedId || undefined });
    await loadOptions(customerId);
    setDogId(res.data.dogId);
    form.reset();
    setPicker(null);
  }

  // ---- 派生 ----
  const selectedDog = options?.dogs.find((d) => d.id === dogId);
  const breedName = (id: string | null) => options?.breeds.find((b) => b.id === id)?.name;
  const serviceName = (id: string) => options?.services.find((s) => s.id === id)?.name;
  const staffName = (id: string) => options?.staff.find((s) => s.id === id)?.name;
  const priceFor = (svcId: string) =>
    options?.pricing.find((p) => p.breedId === selectedDog?.breedId && p.serviceId === svcId) ?? null;

  const ceil50 = (n: number) => Math.ceil(n / 50) * 50;
  const allOptions = options?.options ?? [];
  const optAdj = (id: string) => selectedDog?.optionAdjustments?.[id] ?? 0;
  const addMin = selectedDog?.serviceAdjustments?.[serviceId] ?? 0;
  const cell = priceFor(serviceId);
  const baseStdDur = cell?.durationMin ?? null;
  const baseStdAmt = cell?.price ?? null;
  const baseDur = baseStdDur != null ? baseStdDur + addMin : null;
  const baseAmt = baseStdAmt != null ? baseStdAmt + ceil50((baseStdDur ? baseStdAmt / baseStdDur : 0) * addMin) : null;
  const optEffDur = (o: { id: string; durationMin: number }) => o.durationMin + optAdj(o.id);
  const optEffAmt = (o: { id: string; price: number; durationMin: number }) =>
    o.price + ceil50((o.durationMin > 0 ? o.price / o.durationMin : 0) * optAdj(o.id));
  const chosenOptions = allOptions.filter((o) => optionIds.includes(o.id));
  const optDur = chosenOptions.reduce((s, o) => s + optEffDur(o), 0);
  const optAmt = chosenOptions.reduce((s, o) => s + optEffAmt(o), 0);
  const estDur = baseDur != null ? baseDur + optDur : null;
  const estAmt = baseAmt != null || optAmt > 0 ? (baseAmt ?? 0) + optAmt : null;

  function toggleOption(id: string) {
    setOptionIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function shiftDay(delta: number) {
    const [y, m, d] = date.split('-').map(Number);
    setDate(fmt(new Date(y, m - 1, d + delta)));
  }
  function goMonth(delta: number) {
    setView((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  }
  function pickDay(d: Date) {
    setDate(fmt(d));
    setMonthOpen(false);
    if (d.getMonth() !== view.m || d.getFullYear() !== view.y) setView({ y: d.getFullYear(), m: d.getMonth() });
  }

  async function confirm() {
    if (!confirmSlot) return;
    const res = await createBooking({
      tenantId,
      accessToken: getAccessToken(),
      customerId,
      dogId,
      serviceId,
      date,
      startTime: confirmSlot,
      staffId: staffId || undefined,
      optionIds,
    });
    setConfirmation({ startTime: confirmSlot, slotEnd: res.data.slotEnd });
    setPhase('done');
  }

  if (phase === 'init') return <Center>読み込み中…</Center>;
  if (phase === 'error')
    return (
      <Center>
        <p className="error">{error}</p>
      </Center>
    );

  if (phase === 'needPhone') {
    return (
      <Center>
        <h2>初回登録</h2>
        <p className="muted">ご予約には電話番号の登録が必要です (§3 初回電話番号取得)。</p>
        <form onSubmit={submitPhone}>
          <label>
            お名前
            <input name="ownerName" required />
          </label>
          <label>
            電話番号
            <input name="phone" type="tel" required />
          </label>
          <button type="submit">登録して進む</button>
        </form>
      </Center>
    );
  }

  if (phase === 'done' && confirmation) {
    return (
      <Center>
        <h2>予約が完了しました</h2>
        <p>
          {formatDateJa(date)} {confirmation.startTime}〜{confirmation.slotEnd}
        </p>
        <p className="muted">前日にLINEでリマインドをお送りします (§9)。</p>
      </Center>
    );
  }

  const dogs = options?.dogs ?? [];
  const services = options?.services ?? [];
  const staffList = options?.staff ?? [];
  const today = todayStr();
  const first = new Date(view.y, view.m, 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - first.getDay());
  const gridDays = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });

  return (
    <div className="liff-shell">
      {/* ロゴ */}
      <div className="book-logo">
        {options?.store.logoUrl ? (
          <img className="store-logo" src={options.store.logoUrl} alt={options.store.name} />
        ) : (
          <span className="store-name">{options?.store.name || 'ご予約'}</span>
        )}
        <span className="powered">CONNECTED BY AKUTO</span>
      </div>
      {isDevMode && <p className="muted" style={{ textAlign: 'center' }}>（開発モード: モックの LINE ユーザ）</p>}

      {/* 予約するワンちゃん */}
      <div className="book-quick">
        <button type="button" className={selectedDog ? 'set' : ''} onClick={() => setPicker('dog')}>
          🐶 {selectedDog ? `${selectedDog.name}${breedName(selectedDog.breedId) ? `（${breedName(selectedDog.breedId)}）` : ''}` : '予約するワンちゃんを選択・登録'}
        </button>
      </div>

      {/* 常時表示ピル */}
      <div className="book-pills">
        <button type="button" className={serviceId ? 'set' : ''} onClick={() => setPicker('service')}>
          メニュー：{serviceId ? serviceName(serviceId) : '選択'}
        </button>
        <button type="button" className={optionIds.length ? 'set' : ''} onClick={() => setPicker('option')}>
          オプション：{optionIds.length ? `${optionIds.length}件` : '選択'}
        </button>
        <button type="button" className={staffId ? 'set' : ''} onClick={() => setPicker('staff')}>
          指名：{staffId ? staffName(staffId) : 'なし'}
        </button>
      </div>

      {/* 合計 */}
      {serviceId && estDur != null && (
        <div className="book-summary">
          合計 {estDur}分{estAmt != null ? ` / ¥${estAmt.toLocaleString()}` : ''}
        </div>
      )}

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
              const past = ds < today;
              const closed = closedMonth.has(ds);
              const cls = ['cal-cell'];
              if (d.getMonth() !== view.m) cls.push('other');
              if (ds === today) cls.push('today');
              if (ds === date) cls.push('selected');
              if (past) cls.push('other');
              if (closed) cls.push('closed');
              return (
                <button
                  key={ds}
                  type="button"
                  className={cls.join(' ')}
                  disabled={past || closed}
                  onClick={() => pickDay(d)}
                >
                  <span className={`cal-daynum${dow === 0 ? ' sun' : dow === 6 ? ' sat' : ''}`}>{d.getDate()}</span>
                  {closed && <span className="cal-badge closed">休</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 日ナビ */}
      <div className="day-nav">
        <div className="day-center">
          <button type="button" onClick={() => shiftDay(-1)} aria-label="前日" disabled={date <= today}>
            ‹
          </button>
          <span className="day-label">{formatDateJa(date)}</span>
          <button type="button" onClick={() => shiftDay(1)} aria-label="翌日">
            ›
          </button>
        </div>
        <button type="button" className="cal-today-btn" onClick={() => setDate(todayStr())}>
          今日
        </button>
      </div>

      {/* カレンダー（空き時間） */}
      {!dogId || !serviceId ? (
        <p className="tg-hint">ワンちゃんとメニューを選ぶと、空き時間が表示されます。</p>
      ) : loadingSlots ? (
        <p className="tg-hint">空き時間を読み込み中…</p>
      ) : (
        <AvailabilityGrid
          businessHours={businessHours}
          slots={slots ?? []}
          closed={closedDay}
          selected={confirmSlot}
          onPick={(s) => setConfirmSlot(s)}
        />
      )}

      {/* ピッカー（モーダル） */}
      {picker === 'dog' && (
        <Modal title="ワンちゃん" onClose={() => setPicker(null)}>
          {dogs.length > 0 && (
            <div className="opt-list" style={{ marginBottom: 12 }}>
              {dogs.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`opt-item${dogId === d.id ? ' set' : ''}`}
                  style={{ textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => {
                    setDogId(d.id);
                    setPicker(null);
                  }}
                >
                  {d.name}
                  {breedName(d.breedId) ? `（${breedName(d.breedId)}）` : ''}
                </button>
              ))}
            </div>
          )}
          <details open={dogs.length === 0}>
            <summary className="muted">＋ ワンちゃんを登録</summary>
            <form className="row-form" onSubmit={addDog} style={{ marginTop: 8 }}>
              <input name="dogName" placeholder="名前" required />
              <select name="breedId" defaultValue="">
                <option value="">犬種を選択</option>
                {options?.breeds.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <button type="submit">登録</button>
            </form>
          </details>
        </Modal>
      )}

      {picker === 'service' && (
        <Modal title="メニュー（サービス）" onClose={() => setPicker(null)}>
          <div className="opt-list">
            {services.map((s) => {
              const c = priceFor(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`opt-item${serviceId === s.id ? ' set' : ''}`}
                  style={{ textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => {
                    setServiceId(s.id);
                    setPicker(null);
                  }}
                >
                  {s.name}
                  <span className="opt-meta">{c ? `¥${c.price.toLocaleString()} / ${c.durationMin}分` : '料金未設定'}</span>
                </button>
              );
            })}
          </div>
        </Modal>
      )}

      {picker === 'option' && (
        <Modal title="オプション（複数選択可）" onClose={() => setPicker(null)}>
          <div className="opt-list">
            {allOptions.map((o) => (
              <label key={o.id} className="opt-item">
                <input type="checkbox" checked={optionIds.includes(o.id)} onChange={() => toggleOption(o.id)} />
                {o.name}
                <span className="opt-meta">
                  +¥{optEffAmt(o).toLocaleString()} / +{optEffDur(o)}分
                </span>
              </label>
            ))}
            {allOptions.length === 0 && <p className="muted">オプションはありません。</p>}
          </div>
          <div className="modal-actions">
            <button type="button" onClick={() => setPicker(null)}>
              決定
            </button>
          </div>
        </Modal>
      )}

      {picker === 'staff' && (
        <Modal title="指名（任意）" onClose={() => setPicker(null)}>
          <div className="opt-list">
            <button
              type="button"
              className={`opt-item${!staffId ? ' set' : ''}`}
              style={{ textAlign: 'left', cursor: 'pointer' }}
              onClick={() => {
                setStaffId('');
                setPicker(null);
              }}
            >
              指名なし（空いているスタッフ）
            </button>
            {staffList.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`opt-item${staffId === s.id ? ' set' : ''}`}
                style={{ textAlign: 'left', cursor: 'pointer' }}
                onClick={() => {
                  setStaffId(s.id);
                  setPicker(null);
                }}
              >
                {s.name}
              </button>
            ))}
          </div>
        </Modal>
      )}

      {/* 予約確認 */}
      {confirmSlot && (
        <Modal title="この内容で予約しますか？" onClose={() => setConfirmSlot(null)}>
          <p>
            <strong>{selectedDog?.name}</strong>
            {breedName(selectedDog?.breedId ?? null) ? `（${breedName(selectedDog?.breedId ?? null)}）` : ''}
          </p>
          <p>
            {formatDateJa(date)} {confirmSlot}〜
          </p>
          <p className="muted">
            {serviceName(serviceId)}
            {chosenOptions.length ? `＋ ${chosenOptions.map((o) => o.name).join('・')}` : ''}
            {staffId ? `／指名: ${staffName(staffId)}` : ''}
          </p>
          {estAmt != null && (
            <p>
              所要 {estDur}分 / <strong>¥{estAmt.toLocaleString()}</strong>
            </p>
          )}
          <div className="modal-actions">
            <button type="button" onClick={() => setConfirmSlot(null)}>
              戻る
            </button>
            <button type="submit" onClick={confirm}>
              予約する
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** 空き時間の時間軸グリッド（管理画面の日ビューと同じ見た目）。 */
function AvailabilityGrid({
  businessHours,
  slots,
  closed,
  selected,
  onPick,
}: {
  businessHours: { start: string; end: string }[] | null;
  slots: string[];
  closed: boolean;
  selected: string | null;
  onPick: (s: string) => void;
}) {
  const bh = businessHours && businessHours.length > 0 ? businessHours : [{ start: '09:00', end: '19:00' }];
  const axisStart = Math.min(...bh.map((h) => toMin(h.start))) - EDGE_PAD;
  const axisEnd = Math.max(...bh.map((h) => toMin(h.end))) + EDGE_PAD;
  const height = (axisEnd - axisStart) * PX_PER_MIN;
  const hours: number[] = [];
  for (let h = Math.ceil(axisStart / 60) * 60; h <= axisEnd; h += 60) hours.push(h);

  const sorted = useMemo(() => [...slots].sort(), [slots]);
  const step = sorted.length > 1 ? Math.max(15, toMin(sorted[1]) - toMin(sorted[0])) : 30;

  return (
    <div className="tg" style={{ height }}>
      {bh.map((h, i) => (
        <div
          key={i}
          className="tg-open"
          style={{ top: (toMin(h.start) - axisStart) * PX_PER_MIN, height: (toMin(h.end) - toMin(h.start)) * PX_PER_MIN }}
        />
      ))}
      {hours.map((h) => (
        <span key={h} className="tg-hour-label" style={{ top: (h - axisStart) * PX_PER_MIN }}>
          {toHHMM(h)}
        </span>
      ))}
      {hours.map((h) => (
        <div key={'l' + h} className="tg-hour" style={{ top: (h - axisStart) * PX_PER_MIN }} />
      ))}
      {!closed &&
        sorted.map((s) => {
          const top = (toMin(s) - axisStart) * PX_PER_MIN;
          return (
            <button
              key={s}
              type="button"
              className={`tg-slot${selected === s ? ' selected' : ''}`}
              style={{ top: top + 1, height: Math.max(16, step * PX_PER_MIN - 2) }}
              onClick={() => onPick(s)}
            >
              {s}
            </button>
          );
        })}
      {closed && <div className="tg-closed">休業日</div>}
      {!closed && sorted.length === 0 && (
        <div className="tg-closed" style={{ color: 'var(--muted)', background: 'transparent' }}>
          この日に空きはありません
        </div>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="liff-shell">{children}</div>;
}
