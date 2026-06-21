import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, ChevronDown, ChevronUp, Pencil, Plus, ShoppingCart, Trash2, X } from 'lucide-react';
import { closeLiff, getAccessToken, getProfile, initLiff, isDevMode } from './liff';
import {
  createGroupBooking,
  customerSession,
  getBookingOptions,
  getClosedDates,
  getGroupAvailability,
  getMyTenants,
  registerDog,
  removeMyTenant,
  type BookingOptions,
  type MyTenant,
} from './customerApi';

type Phase = 'init' | 'needPhone' | 'ready' | 'done' | 'error';

/**
 * カート1項目 = 犬×メニュー×オプション（id はローカル編集用）。
 * serviceId が空のときは「メニュー無し（単体オプション）」予約で、primaryOptionId が主役。
 * optionIds は追加オプション（primaryOptionId は含まない）。
 */
interface CartItem {
  id: string;
  dogId: string;
  serviceId: string;
  primaryOptionId: string; // 単体オプション予約のときのみ。サービス選択時は ''
  optionIds: string[];
}
/** 追加/編集中の下書き（id が null なら新規） */
interface Draft {
  id: string | null;
  dogId: string;
  serviceId: string;
  primaryOptionId: string;
  optionIds: string[];
}

/** 予約計算/送信用の実効オプションid（単体予約は primary を先頭に含める） */
function mergedOptionIds(it: { primaryOptionId: string; optionIds: string[] }): string[] {
  return it.primaryOptionId ? [it.primaryOptionId, ...it.optionIds] : it.optionIds;
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const PX_PER_MIN = 1;
const EDGE_PAD = 30;
const rid = () => Math.random().toString(36).slice(2, 10);

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
const ceil50 = (n: number) => Math.ceil(n / 50) * 50;

function BookingPage({ tenantId }: { tenantId: string }) {
  const [phase, setPhase] = useState<Phase>('init');
  const [error, setError] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [options, setOptions] = useState<BookingOptions | null>(null);
  const [storeInfo, setStoreInfo] = useState<{ name: string; logoUrl: string | null } | null>(null);

  // 予約カート（複数頭）＋ 共通の指名
  const [cart, setCart] = useState<CartItem[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [staffId, setStaffId] = useState('');

  const [date, setDate] = useState(todayStr());
  const [monthOpen, setMonthOpen] = useState(false);
  const [view, setView] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [closedMonth, setClosedMonth] = useState<Set<string>>(new Set());

  // 空き状況（カート合計時間ぶん）
  const [slots, setSlots] = useState<string[] | null>(null);
  const [businessHours, setBusinessHours] = useState<{ start: string; end: string }[] | null>(null);
  const [closedDay, setClosedDay] = useState(false);
  const [loadingSlots, setLoadingSlots] = useState(false);

  const [selectPrompt, setSelectPrompt] = useState(false);
  const [confirmSlot, setConfirmSlot] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
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
        setStoreInfo(res.data.store);
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

  // カート（合計時間）の空き状況を自動取得
  const cartKey = cart.map((c) => `${c.dogId}:${c.serviceId}:${c.primaryOptionId}:${c.optionIds.join('|')}`).join(',');
  useEffect(() => {
    if (phase !== 'ready' || cart.length === 0) {
      setSlots(null);
      setBusinessHours(null);
      return;
    }
    let cancelled = false;
    setLoadingSlots(true);
    (async () => {
      try {
        const res = await getGroupAvailability({
          tenantId,
          accessToken: getAccessToken(),
          date,
          items: cart.map((c) => ({ dogId: c.dogId, serviceId: c.serviceId, optionIds: mergedOptionIds(c) })),
          staffId: staffId || undefined,
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
  }, [phase, cartKey, staffId, date]);

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

  // カートが空になったら一覧モーダルを自動で閉じる
  useEffect(() => {
    if (cartOpen && cart.length === 0) setCartOpen(false);
  }, [cartOpen, cart.length]);

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

  // 下書きモーダル内でワンちゃんを新規登録 → その子を選択
  async function addDogToDraft(e: FormEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const name = (form.elements.namedItem('dogName') as HTMLInputElement).value.trim();
    const breedId = (form.elements.namedItem('breedId') as HTMLSelectElement).value;
    if (!name) return;
    const res = await registerDog({ tenantId, accessToken: getAccessToken(), customerId, name, breedId: breedId || undefined });
    await loadOptions(customerId);
    setDraft((dr) => (dr ? { ...dr, dogId: res.data.dogId } : dr));
    form.reset();
  }

  // ---- 表示ヘルパ ----
  const dogById = (id: string) => options?.dogs.find((d) => d.id === id);
  const breedName = (id: string | null | undefined) => options?.breeds.find((b) => b.id === id)?.name;
  const serviceName = (id: string) => options?.services.find((s) => s.id === id)?.name;
  const optionName = (id: string) => options?.options.find((o) => o.id === id)?.name;
  const staffName = (id: string) => options?.staff.find((s) => s.id === id)?.name;
  // カート/確認のメニュー表示: サービスならサービス名、単体予約ならオプション名
  const menuLabel = (it: { serviceId: string; primaryOptionId: string }) =>
    it.serviceId ? serviceName(it.serviceId) : optionName(it.primaryOptionId) ?? 'オプション';
  const priceCell = (breedId: string | null | undefined, svcId: string) =>
    options?.pricing.find((p) => p.breedId === breedId && p.serviceId === svcId) ?? null;

  // 1項目（犬×メニュー×オプション）の所要時間・料金の見積り
  function estimateItem(it: { dogId: string; serviceId: string; primaryOptionId: string; optionIds: string[] }): {
    dur: number | null;
    amt: number | null;
  } {
    const dog = dogById(it.dogId);
    const standalone = !it.serviceId; // メニュー無し（単体オプション）予約
    const cell = priceCell(dog?.breedId ?? null, it.serviceId);
    const addMin = dog?.serviceAdjustments?.[it.serviceId] ?? 0;
    const stdDur = cell?.durationMin ?? null;
    const stdAmt = cell?.price ?? null;
    const baseDur = standalone ? 0 : stdDur != null ? stdDur + addMin : null;
    const baseAmt = standalone ? 0 : stdAmt != null ? stdAmt + ceil50((stdDur ? stdAmt / stdDur : 0) * addMin) : null;
    const ids = mergedOptionIds(it);
    const opts = (options?.options ?? []).filter((o) => ids.includes(o.id));
    const optAdj = (id: string) => dog?.optionAdjustments?.[id] ?? 0;
    const optDur = opts.reduce((s, o) => s + o.durationMin + optAdj(o.id), 0);
    const optAmt = opts.reduce((s, o) => s + o.price + ceil50((o.durationMin > 0 ? o.price / o.durationMin : 0) * optAdj(o.id)), 0);
    const dur = baseDur != null ? baseDur + optDur : null;
    const amt = baseAmt != null || optAmt > 0 ? (baseAmt ?? 0) + optAmt : null;
    return { dur, amt };
  }

  const cartEstimates = cart.map((it) => ({ it, ...estimateItem(it) }));
  const totalDur = cartEstimates.reduce((s, e) => s + (e.dur ?? 0), 0);
  const totalAmt = cartEstimates.reduce((s, e) => s + (e.amt ?? 0), 0);
  const hasUnpriced = cartEstimates.some((e) => e.amt == null);

  // ---- カート操作 ----
  function openNewItem() {
    setCartOpen(false);
    setDraft({ id: null, dogId: '', serviceId: '', primaryOptionId: '', optionIds: [] });
  }
  function openEditItem(it: CartItem) {
    setCartOpen(false);
    setDraft({ id: it.id, dogId: it.dogId, serviceId: it.serviceId, primaryOptionId: it.primaryOptionId, optionIds: [...it.optionIds] });
  }
  function toggleDraftOption(id: string) {
    setDraft((dr) =>
      dr ? { ...dr, optionIds: dr.optionIds.includes(id) ? dr.optionIds.filter((x) => x !== id) : [...dr.optionIds, id] } : dr,
    );
  }
  // メニュー選択（サービス or 単体オプション）。単体は serviceId 空＋primaryOptionId、追加から重複除去。
  function pickService(serviceId: string) {
    setDraft((dr) => (dr ? { ...dr, serviceId, primaryOptionId: '' } : dr));
  }
  function pickStandalone(optionId: string) {
    setDraft((dr) =>
      dr ? { ...dr, serviceId: '', primaryOptionId: optionId, optionIds: dr.optionIds.filter((x) => x !== optionId) } : dr,
    );
  }
  function saveDraft() {
    if (!draft || !draft.dogId || (!draft.serviceId && !draft.primaryOptionId)) return;
    const item = {
      dogId: draft.dogId,
      serviceId: draft.serviceId,
      primaryOptionId: draft.primaryOptionId,
      optionIds: draft.optionIds,
    };
    setCart((prev) => {
      if (draft.id) return prev.map((it) => (it.id === draft.id ? { id: it.id, ...item } : it));
      return [...prev, { id: rid(), ...item }];
    });
    setDraft(null);
  }
  function removeItem(id: string) {
    setCart((prev) => prev.filter((it) => it.id !== id));
  }

  // 予約する子が未登録なら日付操作をブロックして案内
  function ensureSelected(): boolean {
    if (cart.length === 0) {
      setSelectPrompt(true);
      return false;
    }
    return true;
  }
  function shiftDay(delta: number) {
    if (!ensureSelected()) return;
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
    if (!ensureSelected()) return;
    setDate(fmt(d));
    setMonthOpen(false);
    if (d.getMonth() !== view.m || d.getFullYear() !== view.y) setView({ y: d.getFullYear(), m: d.getMonth() });
  }

  async function confirm() {
    if (!confirmSlot || cart.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const res = await createGroupBooking({
        tenantId,
        accessToken: getAccessToken(),
        customerId,
        date,
        startTime: confirmSlot,
        items: cart.map((c) => ({ dogId: c.dogId, serviceId: c.serviceId, optionIds: mergedOptionIds(c) })),
        staffId: staffId || undefined,
      });
      setConfirmation({ startTime: confirmSlot, slotEnd: res.data.slotEnd });
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : '予約に失敗しました');
    } finally {
      setSubmitting(false);
    }
  }

  // 完了画面から予約画面に戻る（カートをリセットして新規予約へ）
  function startOver() {
    setCart([]);
    setConfirmation(null);
    setConfirmSlot(null);
    setStaffId('');
    setDate(todayStr());
    setPhase('ready');
  }

  // 完了画面の閉じる: LIFF を閉じて LINE に戻す（開発モード等で閉じられなければ予約画面へ）
  function closeOrBack() {
    if (!closeLiff()) startOver();
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
      <div className="liff-shell">
        <StoreLogo store={storeInfo} />
        <section style={{ marginTop: 4 }}>
          <h2>はじめてのご予約</h2>
          <p className="muted">ご予約にはお名前と電話番号の登録が必要です（初回のみ）。</p>
          <form onSubmit={submitPhone}>
            <label>
              お名前
              <input name="ownerName" placeholder="例: 山田 花子" required />
            </label>
            <label>
              電話番号
              <input name="phone" type="tel" placeholder="例: 09012345678" required />
            </label>
            <button type="submit" style={{ width: '100%', marginTop: 8 }}>
              登録して予約に進む
            </button>
          </form>
        </section>
      </div>
    );
  }

  if (phase === 'done' && confirmation) {
    return (
      <div className="liff-shell">
        <div className="done-card">
          <button type="button" className="modal-close done-close" onClick={closeOrBack} aria-label="閉じてLINEに戻る">
            <X size={20} />
          </button>
          <h2>予約が完了しました</h2>
          <p>
            {formatDateJa(date)} {confirmation.startTime}〜{confirmation.slotEnd}
          </p>
          <p className="muted">
            {cart.length}頭：{cart.map((c) => dogById(c.dogId)?.name).filter(Boolean).join('・')}
          </p>
          <p className="muted">前日にLINEでリマインドをお送りします (§9)。</p>
          <button type="button" className="done-back primary" onClick={closeOrBack}>
            LINEに戻る
          </button>
          <button type="button" className="done-again" onClick={startOver}>
            続けて予約する
          </button>
        </div>
      </div>
    );
  }

  const dogs = (options?.dogs ?? []).filter((d, i, a) => a.findIndex((x) => x.id === d.id) === i);
  const services = options?.services ?? [];
  const staffList = options?.staff ?? [];
  const allOptions = options?.options ?? [];
  const today = todayStr();
  const first = new Date(view.y, view.m, 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - first.getDay());
  const gridDays = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });

  const draftHasMenu = !!draft && (!!draft.serviceId || !!draft.primaryOptionId);
  const draftEst = draft && draft.dogId && draftHasMenu ? estimateItem(draft) : null;
  // 追加用の犬リスト: 既にカートに入っている子は隠す（編集中のその子は残す）
  const availDogs = dogs.filter((d) => !cart.some((c) => c.dogId === d.id) || d.id === draft?.dogId);

  return (
    <div className="liff-shell">
      <StoreLogo store={options?.store ?? storeInfo} />
      {isDevMode && <p className="muted" style={{ textAlign: 'center' }}>（開発モード: モックの LINE ユーザ）</p>}

      {/* 予約する子を追加 */}
      <div className="book-quick">
        <button type="button" onClick={openNewItem}>
          <Plus size={18} style={{ verticalAlign: '-3px', marginRight: 4 }} />
          予約するワンちゃんを追加
        </button>
      </div>

      {/* カート */}
      <button type="button" className={`cart-bar${cart.length ? ' set' : ''}`} onClick={() => cart.length && setCartOpen(true)}>
        <ShoppingCart size={18} />
        <span className="cart-bar-main">
          {cart.length ? `ご予約リスト（${cart.length}頭）` : 'まだ追加されていません'}
        </span>
        {cart.length > 0 && (
          <span className="cart-bar-sum">
            {totalDur}分{totalAmt > 0 ? ` / ¥${totalAmt.toLocaleString()}${hasUnpriced ? '〜' : ''}` : ''}
          </span>
        )}
      </button>

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
          <span className="day-label">
            {formatDateJa(date)}
            {date === today && <span className="day-today">今日</span>}
          </span>
          <button type="button" onClick={() => shiftDay(1)} aria-label="翌日">
            ›
          </button>
        </div>
      </div>

      {/* カレンダー（空き時間・合計時間ぶん） */}
      {cart.length === 0 ? (
        <p className="tg-hint">「予約するワンちゃんを追加」から、犬・メニューを選んでください。</p>
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

      {/* 追加/編集モーダル（犬→メニュー→オプション） */}
      {draft && (
        <Modal title={draft.id ? 'ご予約内容の編集' : '予約するワンちゃん'} onClose={() => setDraft(null)}>
          {/* 犬（カート済みの子は非表示。編集中のその子は残す） */}
          <h3 className="pick-head">ワンちゃん</h3>
          {availDogs.length > 0 && (
            <div className="opt-list">
              {availDogs.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`opt-item${draft.dogId === d.id ? ' set' : ''}`}
                  style={{ textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => setDraft((dr) => (dr ? { ...dr, dogId: d.id } : dr))}
                >
                  {d.name}
                  {breedName(d.breedId) ? `（${breedName(d.breedId)}）` : ''}
                </button>
              ))}
            </div>
          )}
          {availDogs.length === 0 && dogs.length > 0 && (
            <p className="muted">追加できるワンちゃんは全て追加済みです。新しい子は下から登録できます。</p>
          )}
          <details open={availDogs.length === 0} style={{ marginTop: 8 }}>
            <summary className="muted">＋ ワンちゃんを登録</summary>
            <form className="row-form" onSubmit={addDogToDraft} style={{ marginTop: 8 }}>
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

          {/* メニュー（犬選択後）。サービス（料金設定済み）＋「オプションのみ可」を同列に表示 */}
          {draft.dogId &&
            (() => {
              const breedId = dogById(draft.dogId)?.breedId ?? null;
              const menuServices = services.map((s) => ({ s, c: priceCell(breedId, s.id) })).filter((x) => x.c);
              const standaloneOpts = allOptions.filter((o) => o.standalone);
              const optEff = (o: { id: string; price: number; durationMin: number }) => {
                const adj = dogById(draft.dogId)?.optionAdjustments?.[o.id] ?? 0;
                return {
                  dur: o.durationMin + adj,
                  amt: o.price + ceil50((o.durationMin > 0 ? o.price / o.durationMin : 0) * adj),
                };
              };
              if (menuServices.length === 0 && standaloneOpts.length === 0) {
                return (
                  <>
                    <h3 className="pick-head">メニュー</h3>
                    <p className="muted">このワンちゃんで予約できるメニューがありません。</p>
                  </>
                );
              }
              return (
                <>
                  <h3 className="pick-head">メニュー</h3>
                  <div className="opt-list">
                    {menuServices.map(({ s, c }) => (
                      <button
                        key={s.id}
                        type="button"
                        className={`opt-item${draft.serviceId === s.id ? ' set' : ''}`}
                        style={{ textAlign: 'left', cursor: 'pointer' }}
                        onClick={() => pickService(s.id)}
                      >
                        {s.name}
                        <span className="opt-meta">
                          ¥{c!.price.toLocaleString()} / {c!.durationMin}分
                        </span>
                      </button>
                    ))}
                    {/* 単体オプションはサービス未選択のときだけメニュー欄に表示（サービス選択後はオプション欄へ） */}
                    {!draft.serviceId &&
                      standaloneOpts.map((o) => {
                        const e = optEff(o);
                        return (
                          <button
                            key={o.id}
                            type="button"
                            className={`opt-item${draft.primaryOptionId === o.id ? ' set' : ''}`}
                            style={{ textAlign: 'left', cursor: 'pointer' }}
                            onClick={() => pickStandalone(o.id)}
                          >
                            {o.name}
                            <span className="opt-meta">
                              ¥{e.amt.toLocaleString()} / {e.dur}分
                            </span>
                          </button>
                        );
                      })}
                  </div>
                </>
              );
            })()}

          {/* オプション（メニュー選択後・任意の追加。単体予約の主オプションは除外） */}
          {draft.dogId && draftHasMenu && allOptions.filter((o) => o.id !== draft.primaryOptionId).length > 0 && (
            <>
              <h3 className="pick-head">オプション（任意・複数可）</h3>
              <div className="opt-list">
                {allOptions
                  .filter((o) => o.id !== draft.primaryOptionId)
                  .map((o) => {
                    const adj = dogById(draft.dogId)?.optionAdjustments?.[o.id] ?? 0;
                    const dur = o.durationMin + adj;
                    const amt = o.price + ceil50((o.durationMin > 0 ? o.price / o.durationMin : 0) * adj);
                    const on = draft.optionIds.includes(o.id);
                    return (
                    <button
                      key={o.id}
                      type="button"
                      className={`opt-item${on ? ' set' : ''}`}
                      style={{ textAlign: 'left', cursor: 'pointer' }}
                      onClick={() => toggleDraftOption(o.id)}
                    >
                      <span className="opt-check" aria-hidden="true">{on ? <Check size={16} strokeWidth={3} /> : null}</span>
                      {o.name}
                      <span className="opt-meta">
                        +¥{amt.toLocaleString()} / +{dur}分
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* トリマー指名（任意・全頭共通） */}
          {draft.dogId && draftHasMenu && (
            <>
              <h3 className="pick-head">トリマー指名（任意）</h3>
              <p className="muted" style={{ margin: '0 0 6px' }}>指名は予約するすべての子で同じ担当になります。</p>
              <div className="opt-list">
                <button
                  type="button"
                  className={`opt-item${!staffId ? ' set' : ''}`}
                  style={{ textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => setStaffId('')}
                >
                  指名なし（空いているスタッフ）
                </button>
                {staffList.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`opt-item${staffId === s.id ? ' set' : ''}`}
                    style={{ textAlign: 'left', cursor: 'pointer' }}
                    onClick={() => setStaffId(s.id)}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </>
          )}

          {draftEst && (
            <div className="book-summary" style={{ marginTop: 12 }}>
              この子：{draftEst.dur}分{draftEst.amt != null ? ` / ¥${draftEst.amt.toLocaleString()}` : ''}
              {staffId ? ` ・ 指名: ${staffName(staffId)}` : ''}
            </div>
          )}
          <div className="modal-actions">
            <button type="button" onClick={() => setDraft(null)}>
              キャンセル
            </button>
            <button type="button" className="primary" disabled={!draft.dogId || !draftHasMenu} onClick={saveDraft}>
              {draft.id ? '更新' : 'カートに入れる'}
            </button>
          </div>
        </Modal>
      )}

      {/* カート詳細 */}
      {cartOpen && (
        <Modal title={`ご予約リスト（${cart.length}頭）`} onClose={() => setCartOpen(false)}>
          <div className="cart-list">
            {cartEstimates.map(({ it, dur, amt }) => {
              const dog = dogById(it.dogId);
              const opts = allOptions.filter((o) => it.optionIds.includes(o.id));
              return (
                <div key={it.id} className="cart-item">
                  <div className="cart-item-body">
                    <div className="cart-item-title">
                      {dog?.name}
                      {breedName(dog?.breedId) ? `（${breedName(dog?.breedId)}）` : ''}
                    </div>
                    <div className="cart-item-meta">
                      {menuLabel(it)}
                      {opts.length ? `＋ ${opts.map((o) => o.name).join('・')}` : ''}
                    </div>
                    <div className="cart-item-meta">
                      {dur}分{amt != null ? ` / ¥${amt.toLocaleString()}` : ' / 料金未設定'}
                    </div>
                  </div>
                  <div className="cart-item-actions">
                    <button type="button" aria-label="編集" onClick={() => openEditItem(it)}>
                      <Pencil size={16} />
                    </button>
                    <button type="button" aria-label="削除" onClick={() => removeItem(it.id)}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="book-summary" style={{ marginTop: 12 }}>
            合計 {totalDur}分{totalAmt > 0 ? ` / ¥${totalAmt.toLocaleString()}${hasUnpriced ? '〜' : ''}` : ''}
          </div>
          <div className="modal-actions">
            <button type="button" onClick={openNewItem}>
              <Plus size={16} style={{ verticalAlign: '-3px' }} /> 追加
            </button>
            <button type="button" className="primary" onClick={() => setCartOpen(false)}>
              この内容で時間を選ぶ
            </button>
          </div>
        </Modal>
      )}

      {/* 予約する子が未登録の案内 */}
      {selectPrompt && (
        <Modal title="ご予約の準備" onClose={() => setSelectPrompt(false)}>
          <p>先に「予約するワンちゃんを追加」から、犬とメニューを選択してください。</p>
          <div className="modal-actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                setSelectPrompt(false);
                openNewItem();
              }}
            >
              ワンちゃんを追加
            </button>
            <button type="button" onClick={() => setSelectPrompt(false)}>
              閉じる
            </button>
          </div>
        </Modal>
      )}

      {/* 予約確認 */}
      {confirmSlot && (
        <Modal title="この内容で予約しますか？" onClose={() => setConfirmSlot(null)}>
          <p>
            {formatDateJa(date)} {confirmSlot}〜{toHHMM(toMin(confirmSlot) + totalDur)}
          </p>
          <div className="cart-list">
            {cartEstimates.map(({ it, dur, amt }) => {
              const dog = dogById(it.dogId);
              const opts = allOptions.filter((o) => it.optionIds.includes(o.id));
              return (
                <div key={it.id} className="cart-item">
                  <div className="cart-item-body">
                    <div className="cart-item-title">
                      {dog?.name}
                      {breedName(dog?.breedId) ? `（${breedName(dog?.breedId)}）` : ''}
                    </div>
                    <div className="cart-item-meta">
                      {menuLabel(it)}
                      {opts.length ? `＋ ${opts.map((o) => o.name).join('・')}` : ''}
                      {' ・ '}
                      {dur}分{amt != null ? ` / ¥${amt.toLocaleString()}` : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="muted">
            {staffId ? `指名: ${staffName(staffId)}` : '指名なし（空いているスタッフ）'}
          </p>
          <div className="book-summary">
            合計 {totalDur}分{totalAmt > 0 ? ` / ¥${totalAmt.toLocaleString()}${hasUnpriced ? '〜' : ''}` : ''}
          </div>
          <div className="modal-actions">
            <button type="button" onClick={() => setConfirmSlot(null)}>
              戻る
            </button>
            <button type="button" className="primary" disabled={submitting} onClick={confirm}>
              {submitting ? '送信中…' : '予約する'}
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

  // 見やすさ優先で30分刻みに間引く（30分始まりが無ければ全件）
  const sorted = useMemo(() => {
    const all = [...slots].sort();
    const half = all.filter((s) => toMin(s) % 30 === 0);
    return half.length ? half : all;
  }, [slots]);
  const SLOT_H = 28; // スロットの高さ(px)

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
              style={{ top: top - SLOT_H / 2, height: SLOT_H }}
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
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="閉じる">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function StoreLogo({ store }: { store: { name: string; logoUrl: string | null } | null }) {
  return (
    <div className="book-logo">
      {store?.logoUrl ? (
        <img className="store-logo" src={store.logoUrl} alt={store.name} />
      ) : (
        <span className="store-name">{store?.name || 'ご予約'}</span>
      )}
      <span className="powered">CONNECTED BY AKUTO</span>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="liff-shell">{children}</div>;
}

/**
 * /book の入口。
 * - ?tenant= 指定あり（店ごとQR）→ そのまま予約画面。
 * - 指定なし（リッチメニュー等）→ 利用店を解決: 0件=案内 / 1件=直行 / 複数=店選択。
 */
export default function BookEntry() {
  const [params] = useSearchParams();
  const paramTenant = params.get('tenant');

  const [tenantId, setTenantId] = useState<string | null>(paramTenant);
  const [phase, setPhase] = useState<'init' | 'go' | 'choose' | 'empty' | 'error'>(paramTenant ? 'go' : 'init');
  const [tenants, setTenants] = useState<MyTenant[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function resolve() {
    try {
      await initLiff();
      await getProfile();
      const res = await getMyTenants({ accessToken: getAccessToken() });
      const list = res.data.tenants;
      if (list.length === 0) {
        setPhase('empty');
      } else if (list.length === 1) {
        setTenantId(list[0].tenantId);
        setPhase('go');
      } else {
        setTenants(list);
        setPhase('choose');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '読み込みに失敗しました');
      setPhase('error');
    }
  }

  useEffect(() => {
    if (paramTenant) return; // 店ごとQR は直接予約画面へ
    resolve();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramTenant]);

  async function onRemove(id: string) {
    try {
      await removeMyTenant({ accessToken: getAccessToken(), tenantId: id });
    } catch {
      /* 失敗しても表示は更新する */
    }
    const left = tenants.filter((t) => t.tenantId !== id);
    if (left.length === 1) {
      setTenantId(left[0].tenantId);
      setPhase('go');
    } else if (left.length === 0) {
      setPhase('empty');
    } else {
      setTenants(left);
    }
  }

  if (phase === 'go' && tenantId) return <BookingPage key={tenantId} tenantId={tenantId} />;
  if (phase === 'init') return <Center>読み込み中…</Center>;
  if (phase === 'error')
    return (
      <Center>
        <p className="error">{error}</p>
      </Center>
    );
  if (phase === 'empty')
    return (
      <Center>
        <StoreLogo store={null} />
        <section style={{ marginTop: 4 }}>
          <h2>ご予約できる店舗がありません</h2>
          <p className="muted">店舗で配布されているQRコード（予約リンク）から始めてください。</p>
        </section>
      </Center>
    );

  // choose: 複数店から選ぶ（不要な店は削除できる）
  return (
    <div className="liff-shell">
      <StoreLogo store={null} />
      <h2 style={{ textAlign: 'center' }}>ご予約する店舗を選択</h2>
      <div className="cart-list" style={{ marginTop: 12 }}>
        {tenants.map((t) => (
          <div key={t.tenantId} className="cart-item">
            <button
              type="button"
              className="cart-item-body"
              style={{ background: 'transparent', border: 'none', textAlign: 'left', cursor: 'pointer', padding: 0 }}
              onClick={() => {
                setTenantId(t.tenantId);
                setPhase('go');
              }}
            >
              <div className="cart-item-title">
                {t.logoUrl ? <img className="store-logo" src={t.logoUrl} alt={t.name} style={{ height: 24, verticalAlign: '-6px', marginRight: 8 }} /> : null}
                {t.name || t.tenantId}
              </div>
            </button>
            <div className="cart-item-actions">
              <button type="button" aria-label="リストから削除" onClick={() => onRemove(t.tenantId)}>
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="muted" style={{ marginTop: 12 }}>行かない店舗は削除できます。1店舗だけになると次回から自動で開きます。</p>
    </div>
  );
}
