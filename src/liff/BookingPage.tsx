import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, ChevronDown, ChevronUp, PawPrint, Pencil, Plus, Trash2, X } from 'lucide-react';
import { ADD_FRIEND_URL, buildLiffDeepLink, closeLiff, getAccessToken, getProfile, initLiff, initLiffOptional, isDevMode, loginForBooking, openAddFriend } from './liff';
import {
  createGroupBooking,
  customerSession,
  getBookingOptions,
  getClosedDates,
  getGroupAvailability,
  getMonthAvailability,
  getMyTenants,
  getPublicBookingOptions,
  hideDog,
  registerDog,
  removeMyTenant,
  type BookingOptions,
  type GroupItem,
  type MyTenant,
} from './customerApi';

type Phase = 'init' | 'needFriend' | 'needPhone' | 'ready' | 'done' | 'error';

/**
 * カート1項目 = 犬×（メニュー or 単品オプション）。
 * - serviceId あり: 本メニュー予約。optionIds は追加オプション（複数可）。
 * - serviceId 空: 単品オプション予約。optionIds が選んだ単品オプション（複数可）。追加オプションは無し。
 */
interface CartItem {
  id: string;
  dogId: string;
  serviceId: string;
  optionIds: string[];
}
/** 追加/編集中の下書き（id が null なら新規） */
interface Draft {
  id: string | null;
  dogId: string;
  serviceId: string;
  optionIds: string[];
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const rid = () => Math.random().toString(36).slice(2, 10);

// スマホ判定（案内文の出し分け用）。スマホはLINEアプリへの自動ジャンプ、PCはWebログインになる
const isMobileUA = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

/** ゲスト（LINEログイン前）がその場で入力した犬。確定時に newDog としてサーバ登録される */
interface GuestDog {
  id: string; // 'guest:' プレフィックス付きのローカルID
  name: string;
  breedId: string | null;
}
const isGuestDogId = (id: string) => id.startsWith('guest:');

/**
 * ゲスト予約の下書き（LINEログインのリダイレクトをまたいで復元するための永続化）。
 * ログイン往復・友だち追加・電話番号登録を挟んでも選択内容を失わない。
 */
interface GuestDraft {
  tenantId: string;
  guestDogs: GuestDog[];
  cart: CartItem[];
  staffId: string;
  date: string;
  slot: string | null;
  savedAt: number;
}
const GUEST_DRAFT_KEY = 'groomGuestBookingDraft';
const GUEST_DRAFT_TTL_MS = 2 * 60 * 60 * 1000; // 2時間

function saveGuestDraft(draft: GuestDraft): void {
  try {
    localStorage.setItem(GUEST_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* プライベートブラウズ等で保存できなくても続行（復元できないだけ） */
  }
}
function loadGuestDraft(tenantId: string): GuestDraft | null {
  try {
    const raw = localStorage.getItem(GUEST_DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as GuestDraft;
    if (d.tenantId !== tenantId || !Array.isArray(d.cart) || d.cart.length === 0) return null;
    if (Date.now() - (d.savedAt ?? 0) > GUEST_DRAFT_TTL_MS) return null;
    return d;
  } catch {
    return null;
  }
}
function clearGuestDraft(): void {
  try {
    localStorage.removeItem(GUEST_DRAFT_KEY);
  } catch {
    /* noop */
  }
}

/** 下書きの妥当性検証（テナント一致・中身あり・TTL内）。URL経由/localStorage経由の共通判定 */
function isValidDraft(d: GuestDraft | null, tenantId: string): d is GuestDraft {
  return (
    !!d &&
    d.tenantId === tenantId &&
    Array.isArray(d.cart) &&
    d.cart.length > 0 &&
    Date.now() - (d.savedAt ?? 0) <= GUEST_DRAFT_TTL_MS
  );
}

// LINEアプリ内ブラウザは外部ブラウザ(Safari等)とストレージが別のため、
// 下書きはURLパラメータ(base64)でも運ぶ。UTF-8安全なエンコードにする。
function encodeDraft(d: GuestDraft): string {
  const bytes = new TextEncoder().encode(JSON.stringify(d));
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}
function decodeDraft(s: string): GuestDraft | null {
  try {
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as GuestDraft;
  } catch {
    return null;
  }
}

/** URLの draft パラメータ → localStorage の順で下書きを探す */
function findPendingDraft(tenantId: string): GuestDraft | null {
  const p = new URLSearchParams(window.location.search).get('draft');
  if (p) {
    const d = decodeDraft(p);
    if (isValidDraft(d, tenantId)) return d;
  }
  const d = loadGuestDraft(tenantId);
  return isValidDraft(d, tenantId) ? d : null;
}

/** 予約成立後にURLの draft パラメータを消す（リロードや「続けて予約」での再復元を防ぐ） */
function stripDraftParam(): void {
  const u = new URL(window.location.href);
  if (u.searchParams.has('draft')) {
    u.searchParams.delete('draft');
    window.history.replaceState(null, '', u.toString());
  }
}

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
  const [storeInfo, setStoreInfo] = useState<{
    name: string;
    logoUrl: string | null;
    addFriendUrl?: string;
  } | null>(null);

  // ゲストモード（Web集客導線）: LINE未ログインのまま閲覧〜内容決定まで進め、確定時にログインへ誘導。
  // ?guest=1 は開発モードでゲスト動線を試すための強制フラグ。
  const [guest, setGuest] = useState(false);
  const [guestDogs, setGuestDogs] = useState<GuestDog[]>([]);

  // 予約カート（複数頭）＋ 共通の指名
  const [cart, setCart] = useState<CartItem[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dogFormOpen, setDogFormOpen] = useState(false); // モーダルの新規ワンちゃん登録フォーム表示
  const [staffId, setStaffId] = useState('');
  const [staffPickerOpen, setStaffPickerOpen] = useState(false); // 指名リストの開閉（既定は指名なしで折りたたみ）

  const [date, setDate] = useState(todayStr());
  const [view, setView] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [closedMonth, setClosedMonth] = useState<Set<string>>(new Set());
  const [undecidedMonth, setUndecidedMonth] = useState<Set<string>>(new Set()); // シフト未定（受付前）の日
  const [openMonth, setOpenMonth] = useState<Set<string> | null>(null); // 選択中の内容が入る日（null=判定前/カート空）
  const [openMonthMin, setOpenMonthMin] = useState<Set<string> | null>(null); // 最短まで縮めた内容なら入る日（△判定用）

  // 空き状況（カート合計時間ぶん）
  const [slots, setSlots] = useState<string[] | null>(null);
  const [finishByStart, setFinishByStart] = useState<Record<string, string>>({});
  const [closedDay, setClosedDay] = useState(false);
  const [undecidedDay, setUndecidedDay] = useState(false); // シフト未定で受付前
  const [loadingSlots, setLoadingSlots] = useState(false);

  const [selectPrompt, setSelectPrompt] = useState(false);
  const [confirmSlot, setConfirmSlot] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState<{ startTime: string; slotEnd: string } | null>(null);

  // 短縮提案（入らない日に「内容を短くすれば入る案」を提示）
  type Suggestion = { title: string; cart: CartItem[]; slot: string; finish: string };
  const [suggest, setSuggest] = useState<{ date: string; results: Suggestion[] } | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);

  // ワンちゃんを「リストから外す」（ソフト削除）
  const [removeDog, setRemoveDog] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function loadOptions(cid: string) {
    const res = await getBookingOptions({ tenantId, accessToken: getAccessToken(), customerId: cid });
    setOptions(res.data);
  }

  // LINEログイン往復（＋友だち追加・電話番号登録）後にゲスト下書きを復元する。
  // LINEアプリ内で開いた場合はURLパラメータから、同一ブラウザならlocalStorageから。
  // 下書きは予約成功まで消さない（途中離脱しても再開できる）。
  function resumeGuestDraft() {
    const saved = findPendingDraft(tenantId);
    if (!saved) return;
    setGuestDogs(saved.guestDogs ?? []);
    setCart(saved.cart);
    setStaffId(saved.staffId ?? '');
    setDate(saved.date);
    if (saved.slot) setConfirmSlot(saved.slot);
  }

  async function boot() {
    setPhase('init');
    try {
      const forceGuest = new URLSearchParams(window.location.search).get('guest') === '1';
      const loggedIn = forceGuest ? false : await initLiffOptional();
      if (!loggedIn) {
        // ゲストモード: 公開カタログだけで予約内容の検討まで進める（LINE登録は確定時）
        const res = await getPublicBookingOptions({ tenantId });
        setOptions({ ...res.data, dogs: [] });
        setStoreInfo(res.data.store);
        setGuest(true);
        const saved = findPendingDraft(tenantId);
        if (saved) {
          setGuestDogs(saved.guestDogs ?? []);
          setCart(saved.cart);
          setStaffId(saved.staffId ?? '');
          setDate(saved.date);
        }
        setPhase('ready');
        return;
      }
      setGuest(false);
      await getProfile();
      // A方式: 友だち必須化はサーバ判定を正とする（クライアントの getFriendship は
      // チャネル-OAリンク状況で友だちでも false を返すことがあり誤ブロックの原因になる）。
      // 未追加ならサーバが 'line-friend-required' を返し、下の catch で needFriend に分岐。
      const res = await customerSession({ tenantId, accessToken: getAccessToken() });
      setCustomerId(res.data.customerId);
      setStoreInfo(res.data.store);
      if (res.data.needsPhone) {
        setPhase('needPhone');
      } else {
        if (res.data.options) setOptions(res.data.options);
        else await loadOptions(res.data.customerId);
        setPhase('ready');
        resumeGuestDraft();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      // サーバ側の友だち必須化に弾かれた場合も案内画面へ
      if (/line-friend-required/.test(msg)) {
        // customerSession が例外で抜けているため店舗情報が未取得。
        // 公開カタログ（認証不要）から取り直す。ロゴ表示と、
        // テナントごとの友だち追加URLの取得に必要。
        try {
          const pub = await getPublicBookingOptions({ tenantId });
          setStoreInfo(pub.data.store);
        } catch {
          // 取得できなくても案内画面自体は出す（フォールバックURLで動く）
        }
        setPhase('needFriend');
        return;
      }
      setError(msg || '初期化に失敗しました');
      setPhase('error');
    }
  }

  useEffect(() => {
    boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // カート項目をAPIのitemsへ変換。ゲスト入力の犬は breedId のみ（dogIdは未登録）で照会する。
  const toAvailabilityItems = (list: CartItem[]): GroupItem[] =>
    list.map((c) => {
      const g = guestDogs.find((x) => x.id === c.dogId);
      return g
        ? { breedId: g.breedId, serviceId: c.serviceId, optionIds: c.optionIds }
        : { dogId: c.dogId, serviceId: c.serviceId, optionIds: c.optionIds };
    });
  // 確定用: ゲスト入力の犬は newDog としてサーバ登録してもらう。
  const toBookingItems = (list: CartItem[]): GroupItem[] =>
    list.map((c) => {
      const g = guestDogs.find((x) => x.id === c.dogId);
      return g
        ? { newDog: { name: g.name, breedId: g.breedId }, serviceId: c.serviceId, optionIds: c.optionIds }
        : { dogId: c.dogId, serviceId: c.serviceId, optionIds: c.optionIds };
    });
  // ゲストはLINEトークンが無い（空き系APIは認証不要になっている）
  const authToken = () => (guest ? {} : { accessToken: getAccessToken() });

  // カート（合計時間）の空き状況を自動取得
  const cartKey = cart.map((c) => `${c.dogId}:${c.serviceId}:${c.optionIds.join('|')}`).join(',');
  useEffect(() => {
    if (phase !== 'ready' || cart.length === 0) {
      setSlots(null);
      return;
    }
    let cancelled = false;
    setLoadingSlots(true);
    (async () => {
      try {
        const res = await getGroupAvailability({
          tenantId,
          ...authToken(),
          date,
          items: toAvailabilityItems(cart),
          staffId: staffId || undefined,
        });
        if (cancelled) return;
        setSlots(res.data.slots);
        setFinishByStart(res.data.finishByStart ?? {});
        setClosedDay(!!res.data.closed);
        setUndecidedDay(!!res.data.undecided);
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
        const res = await getClosedDates({ tenantId, ...authToken(), from: fmt(gs), to: fmt(ge) });
        if (!cancelled) {
          setClosedMonth(new Set(res.data.dates));
          setUndecidedMonth(new Set(res.data.undecidedDates ?? []));
        }
      } catch {
        /* 表示用なので失敗は無視 */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, view.y, view.m]);

  // 月範囲で「選択中の内容が入る日(openMonth)」と「最短まで縮めれば入る日(openMonthMin)」を取得。
  // どちらにも入らない=× / 現状ダメだが最短なら入る=△ の判定に使う。
  useEffect(() => {
    if (phase !== 'ready' || cart.length === 0) {
      setOpenMonth(null);
      setOpenMonthMin(null);
      return;
    }
    const first = new Date(view.y, view.m, 1);
    const gs = new Date(first);
    gs.setDate(1 - first.getDay());
    const ge = new Date(gs);
    ge.setDate(gs.getDate() + 41);
    const from = fmt(gs);
    const to = fmt(ge);
    const staff = staffId || undefined;
    const minItems = minimalCart();
    const reducible = JSON.stringify(minItems) !== JSON.stringify(cart);
    let cancelled = false;
    (async () => {
      try {
        const res = await getMonthAvailability({
          tenantId,
          ...authToken(),
          items: toAvailabilityItems(cart),
          from,
          to,
          staffId: staff,
        });
        if (!cancelled) setOpenMonth(new Set(res.data.openDates));
      } catch {
        if (!cancelled) setOpenMonth(null);
      }
      // 縮小余地が無ければ △ は発生しない（最短=現状）
      if (!reducible) {
        if (!cancelled) setOpenMonthMin(null);
        return;
      }
      try {
        const resMin = await getMonthAvailability({
          tenantId,
          ...authToken(),
          items: toAvailabilityItems(minItems),
          from,
          to,
          staffId: staff,
        });
        if (!cancelled) setOpenMonthMin(new Set(resMin.data.openDates));
      } catch {
        if (!cancelled) setOpenMonthMin(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, cartKey, staffId, view.y, view.m]);

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
      resumeGuestDraft();
    } catch (e) {
      setError(e instanceof Error ? e.message : '登録に失敗しました');
    }
  }

  // 下書きモーダル内でワンちゃんを新規登録 → その子を選択
  // ゲストはローカル保持のみ（サーバ登録は予約確定＝LINEログイン後に newDog でまとめて行う）
  async function addDogToDraft(e: FormEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const name = (form.elements.namedItem('dogName') as HTMLInputElement).value.trim();
    const breedId = (form.elements.namedItem('breedId') as HTMLSelectElement).value;
    if (!name) return;
    if (guest) {
      const id = `guest:${rid()}`;
      setGuestDogs((prev) => [...prev, { id, name, breedId: breedId || null }]);
      setDraft((dr) => (dr ? { ...dr, dogId: id } : dr));
      form.reset();
      return;
    }
    const res = await registerDog({ tenantId, accessToken: getAccessToken(), customerId, name, breedId: breedId || undefined });
    await loadOptions(customerId);
    setDraft((dr) => (dr ? { ...dr, dogId: res.data.dogId } : dr));
    form.reset();
  }

  // ワンちゃんをリストから外す（履歴・カルテはサロンに保持＝ソフト削除）
  // ゲスト入力の犬はローカル削除のみ。
  async function confirmRemoveDog() {
    if (!removeDog || removing) return;
    if (isGuestDogId(removeDog.id)) {
      const id = removeDog.id;
      setGuestDogs((prev) => prev.filter((g) => g.id !== id));
      setCart((prev) => prev.filter((c) => c.dogId !== id));
      setDraft((dr) => (dr && dr.dogId === id ? { ...dr, dogId: '', serviceId: '', optionIds: [] } : dr));
      setRemoveDog(null);
      return;
    }
    setRemoving(true);
    setRemoveError(null);
    try {
      await hideDog({ tenantId, accessToken: getAccessToken(), customerId, dogId: removeDog.id });
      await loadOptions(customerId);
      // 外した子がカート/下書きに残っていたら除去
      setCart((prev) => prev.filter((c) => c.dogId !== removeDog.id));
      setDraft((dr) => (dr && dr.dogId === removeDog.id ? { ...dr, dogId: '', serviceId: '', optionIds: [] } : dr));
      setRemoveDog(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setRemoveError(
        /upcoming/.test(msg)
          ? 'この子は今後のご予約があります。先にご予約をキャンセルしてください。'
          : 'リストから外せませんでした。時間をおいてお試しください。',
      );
    } finally {
      setRemoving(false);
    }
  }

  // 予約受付範囲（今月+Nヶ月の月末まで）。超えた日付はサーバも空きなしを返すが、
  // カレンダー送り自体をここで止めて「進めるのに空きが無い」体験を避ける。
  const horizonMonths = options?.bookingHorizonMonths ?? 3;
  const horizonEnd = (() => {
    const now = new Date();
    return fmt(new Date(now.getFullYear(), now.getMonth() + horizonMonths + 1, 0));
  })();
  const horizonView = { y: Number(horizonEnd.slice(0, 4)), m: Number(horizonEnd.slice(5, 7)) - 1 };
  const atHorizonMonth = view.y === horizonView.y && view.m === horizonView.m;

  // ---- 表示ヘルパ ----
  // ゲスト入力の犬（未登録・ローカル保持）も登録済みと同じ形で引けるようにする（個別加算なし）
  const guestDogEntry = (g: GuestDog) => ({
    id: g.id,
    name: g.name,
    breedId: g.breedId,
    serviceAdjustments: {} as Record<string, number>,
    optionAdjustments: {} as Record<string, number>,
  });
  const dogById = (id: string) => {
    const registered = options?.dogs.find((d) => d.id === id);
    if (registered) return registered;
    const g = guestDogs.find((x) => x.id === id);
    return g ? guestDogEntry(g) : undefined;
  };
  const breedName = (id: string | null | undefined) => options?.breeds.find((b) => b.id === id)?.name;
  const serviceName = (id: string) => options?.services.find((s) => s.id === id)?.name;
  const optionName = (id: string) => options?.options.find((o) => o.id === id)?.name;
  const staffName = (id: string) => options?.staff.find((s) => s.id === id)?.name;
  // カート/確認のメニュー表示: サービスならサービス名、単品予約なら選んだ単品オプション名（複数可）
  const menuLabel = (it: { serviceId: string; optionIds: string[] }) =>
    it.serviceId
      ? serviceName(it.serviceId)
      : it.optionIds.map((id) => optionName(id)).filter(Boolean).join('・') || '単品オプション';
  const priceCell = (breedId: string | null | undefined, svcId: string) =>
    options?.pricing.find((p) => p.breedId === breedId && p.serviceId === svcId) ?? null;

  // 1項目（犬×メニュー×オプション）の所要時間・料金の見積り
  function estimateItem(it: { dogId: string; serviceId: string; optionIds: string[] }): {
    dur: number | null;
    amt: number | null;
  } {
    const dog = dogById(it.dogId);
    const standalone = !it.serviceId; // メニュー無し（単品オプション）予約
    const cell = priceCell(dog?.breedId ?? null, it.serviceId);
    const addMin = dog?.serviceAdjustments?.[it.serviceId] ?? 0;
    const stdDur = cell?.durationMin ?? null;
    const stdAmt = cell?.price ?? null;
    const baseDur = standalone ? 0 : stdDur != null ? stdDur + addMin : null;
    const baseAmt = standalone ? 0 : stdAmt != null ? stdAmt + ceil50((stdDur ? stdAmt / stdDur : 0) * addMin) : null;
    const opts = (options?.options ?? []).filter((o) => it.optionIds.includes(o.id));
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
    setDogFormOpen(false);
    setStaffPickerOpen(false);
    setDraft({ id: null, dogId: '', serviceId: '', optionIds: [] });
  }
  function openEditItem(it: CartItem) {
    setDogFormOpen(false);
    setStaffPickerOpen(false);
    setDraft({ id: it.id, dogId: it.dogId, serviceId: it.serviceId, optionIds: [...it.optionIds] });
  }
  const isStandaloneOpt = (id: string) => !!options?.options.find((o) => o.id === id)?.standalone;
  // 本メニュー（サービス）を選択/解除。選択時は既存の選択(単品含む)を追加オプションとして保持。
  // 同じメニューを再タップで解除し、単品オプションのみ残す（メニュー無し予約に戻す）。
  function pickService(serviceId: string) {
    setDraft((dr) => {
      if (!dr) return dr;
      if (dr.serviceId === serviceId) return { ...dr, serviceId: '', optionIds: dr.optionIds.filter((x) => isStandaloneOpt(x)) };
      return { ...dr, serviceId };
    });
  }
  // 追加オプション（メニュー併用）をトグル。
  function toggleAddon(id: string) {
    setDraft((dr) =>
      dr ? { ...dr, optionIds: dr.optionIds.includes(id) ? dr.optionIds.filter((x) => x !== id) : [...dr.optionIds, id] } : dr,
    );
  }
  // 単品オプション（メニュー無し・複数可）をトグル。メニュー側はクリア（排他）。
  function toggleStandalone(id: string) {
    setDraft((dr) => {
      if (!dr) return dr;
      if (dr.serviceId) return { ...dr, serviceId: '', optionIds: [id] }; // メニューから単品へ切替
      return { ...dr, serviceId: '', optionIds: dr.optionIds.includes(id) ? dr.optionIds.filter((x) => x !== id) : [...dr.optionIds, id] };
    });
  }
  function saveDraft() {
    if (!draft || !draft.dogId || (!draft.serviceId && draft.optionIds.length === 0)) return;
    const item = { dogId: draft.dogId, serviceId: draft.serviceId, optionIds: draft.optionIds };
    setCart((prev) => {
      if (draft.id) return prev.map((it) => (it.id === draft.id ? { id: it.id, ...item } : it));
      return [...prev, { id: rid(), ...item }];
    });
    setDraft(null);
  }
  function removeItem(id: string) {
    setCart((prev) => prev.filter((it) => it.id !== id));
  }

  // ---- 短縮提案（Phase3）----
  // 犬種で予約できるメニューのうち、所要時間が最短のサービスID
  function shortestServiceFor(dogId: string): string | null {
    const breedId = dogById(dogId)?.breedId ?? null;
    const cells = (options?.pricing ?? []).filter((p) => p.breedId === breedId);
    if (cells.length === 0) return null;
    return cells.reduce((a, b) => (b.durationMin < a.durationMin ? b : a)).serviceId;
  }
  // 最短まで縮めたカート（各メニューを最短サービス＋オプション無しに。単品はそのまま）
  function minimalCart(): CartItem[] {
    return cart.map((c) => {
      if (!c.serviceId) return c;
      const sid = shortestServiceFor(c.dogId) ?? c.serviceId;
      return { ...c, serviceId: sid, optionIds: [] };
    });
  }
  // 「内容を短くすれば入る」候補（カート全体の縮小案）を作る
  function buildReductions(): { title: string; cart: CartItem[] }[] {
    const out: { title: string; cart: CartItem[] }[] = [];
    const hasAddon = cart.some((c) => c.serviceId && c.optionIds.length > 0);
    // A: オプションを外す（本メニューは維持）
    if (hasAddon) {
      out.push({ title: 'オプションを外して予約', cart: cart.map((c) => (c.serviceId ? { ...c, optionIds: [] } : c)) });
    }
    // 最短メニューに置き換えたカート
    const shortCart = cart.map((c) => {
      if (!c.serviceId) return c;
      const sid = shortestServiceFor(c.dogId);
      return sid && sid !== c.serviceId ? { ...c, serviceId: sid } : c;
    });
    const menuChanged = shortCart.some((c, i) => c.serviceId !== cart[i].serviceId);
    if (menuChanged) {
      const names = [...new Set(shortCart.filter((c) => c.serviceId).map((c) => serviceName(c.serviceId)).filter(Boolean))].join('・');
      // B: メニューを最短に（オプションは維持）
      out.push({ title: `メニューを「${names}」にして予約`, cart: shortCart });
      // C: メニュー最短＋オプション無し
      if (hasAddon) {
        out.push({ title: `「${names}」のみ（オプション無し）で予約`, cart: shortCart.map((c) => (c.serviceId ? { ...c, optionIds: [] } : c)) });
      }
    }
    return out;
  }
  // CTA タップ: 候補それぞれをこの日で空き判定し、入る案だけをモーダルに出す
  async function findSuggestions() {
    const cands = buildReductions();
    setSuggest({ date, results: [] });
    setSuggestLoading(true);
    const results: Suggestion[] = [];
    for (const cand of cands) {
      try {
        const res = await getGroupAvailability({
          tenantId,
          ...authToken(),
          date,
          items: toAvailabilityItems(cand.cart),
          staffId: staffId || undefined,
        });
        if (!res.data.closed && res.data.slots.length > 0) {
          const slot = [...res.data.slots].sort()[0];
          results.push({ title: cand.title, cart: cand.cart, slot, finish: res.data.finishByStart?.[slot] ?? '' });
        }
      } catch {
        /* この案は不可。スキップ */
      }
    }
    setSuggest({ date, results });
    setSuggestLoading(false);
  }
  // 提案を採用: カートを差し替え、確認モーダルをその最短枠で開く
  function applySuggestion(s: Suggestion) {
    setCart(s.cart);
    setSuggest(null);
    setConfirmSlot(s.slot);
  }

  // 予約する子が未登録なら日付操作をブロックして案内
  function ensureSelected(): boolean {
    if (cart.length === 0) {
      setSelectPrompt(true);
      return false;
    }
    return true;
  }
  function goMonth(delta: number) {
    setView((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      // 受付範囲の月まで（それより先の月は表示しない）
      if (delta > 0 && (d.getFullYear() > horizonView.y || (d.getFullYear() === horizonView.y && d.getMonth() > horizonView.m))) {
        return v;
      }
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  }
  // 日付タップでカレンダー先頭（月ナビ）を画面上端へスライドし、カレンダー＋時間枠が1画面に収まるようにする。
  // 直後のReact再レンダー（枠の読み込み表示への差し替え）でsmoothスクロールが中断されるため、
  // 再レンダー後に固定位置へ scrollTo する（scrollIntoView 即時呼びでは動かない）。
  const calRef = useRef<HTMLDivElement | null>(null);
  function pickDay(d: Date) {
    if (!ensureSelected()) return;
    setDate(fmt(d));
    if (d.getMonth() !== view.m || d.getFullYear() !== view.y) setView({ y: d.getFullYear(), m: d.getMonth() });
    setTimeout(() => {
      const el = calRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY - 6;
      window.scrollTo({ top, behavior: 'smooth' });
      // 一部環境（バックグラウンドタブ等）でsmoothが中断される保険。届いていなければ即時ジャンプ
      // （実機のsmooth完了を待ってから判定し、アニメーション中に割り込んで揺らさない）
      setTimeout(() => {
        if (el.getBoundingClientRect().top > 60) {
          window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 6 });
        }
      }, 800);
    }, 120);
  }

  async function confirm() {
    if (!confirmSlot || cart.length === 0 || submitting) return;

    // ゲストはここでLINEログインへ（Web集客導線: LINE登録は最後）。
    // スマホではliff.line.meディープリンクでLINEアプリを起動し、アプリのログイン状態を
    // そのまま使う（Webログインのパスワード入力を回避）。アプリ内はストレージが別のため
    // 下書きはURLに載せて運び、localStorageは同一ブラウザで戻ってきた場合の保険。
    if (guest) {
      const draft: GuestDraft = { tenantId, guestDogs, cart, staffId, date, slot: confirmSlot, savedAt: Date.now() };
      saveGuestDraft(draft);
      if (isDevMode) {
        // 開発モード: ?guest=1 を外してリロード＝「ログインして戻ってきた」を再現
        const url = new URL(window.location.href);
        url.searchParams.delete('guest');
        window.location.href = url.toString();
        return;
      }
      const deepLink = buildLiffDeepLink({ tenant: tenantId, draft: encodeDraft(draft) });
      if (deepLink) window.location.href = deepLink;
      else loginForBooking();
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await createGroupBooking({
        tenantId,
        accessToken: getAccessToken(),
        customerId,
        date,
        startTime: confirmSlot,
        items: toBookingItems(cart),
        staffId: staffId || undefined,
      });
      clearGuestDraft();
      stripDraftParam();
      setConfirmation({ startTime: confirmSlot, slotEnd: res.data.slotEnd });
      setPhase('done');
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setError(
        /not available|no staff available/.test(msg)
          ? 'この時間は埋まってしまいました。別の時間を選び直してください。'
          : msg || '予約に失敗しました',
      );
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
    // ゲスト入力の犬は予約確定でサーバ登録済み。ローカル分は破棄し、登録済みリストを取り直す
    if (guestDogs.length > 0) {
      setGuestDogs([]);
      if (customerId) void loadOptions(customerId);
    }
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

  // A方式: 友だち未追加は予約に進めない（追加後に「ご予約に進む」で再判定）
  if (phase === 'needFriend') {
    return (
      <div className="liff-shell">
        <StoreLogo store={storeInfo} />
        <section style={{ marginTop: 4 }}>
          <h2>ご予約の前に友だち追加をお願いします</h2>
          <p className="muted">
            ご予約の確認や前日のリマインドを LINE でお送りするため、まず公式アカウントの友だち追加が必要です。
          </p>
          {/* テナント設定のURLを優先。未設定テナントは環境変数のフォールバック */}
          {(storeInfo?.addFriendUrl || ADD_FRIEND_URL) ? (
            <button
              type="button"
              className="book-start"
              style={{ width: '100%' }}
              onClick={() => openAddFriend(storeInfo?.addFriendUrl)}
            >
              友だち追加する
            </button>
          ) : (
            <p className="muted">店頭の友だち追加QR、または公式アカウントの検索から追加してください。</p>
          )}
          <button type="button" className="done-again" style={{ width: '100%', marginTop: 10 }} onClick={boot}>
            追加したのでご予約に進む
          </button>
        </section>
      </div>
    );
  }

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
          <p className="muted">前日にLINEでリマインドをお送りします。</p>
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

  // 登録済み＋ゲスト入力（ローカル）の犬。ゲストモードでは登録済みは常に空
  const dogs = [...(options?.dogs ?? []), ...guestDogs.map(guestDogEntry)].filter(
    (d, i, a) => a.findIndex((x) => x.id === d.id) === i,
  );
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

  const draftHasMenu = !!draft && (!!draft.serviceId || draft.optionIds.length > 0);
  const draftEst = draft && draft.dogId && draftHasMenu ? estimateItem(draft) : null;
  // 追加用の犬リスト: 既にカートに入っている子は隠す（編集中のその子は残す）
  const availDogs = dogs.filter((d) => !cart.some((c) => c.dogId === d.id) || d.id === draft?.dogId);

  return (
    <div className="liff-shell">
      <StoreLogo store={options?.store ?? storeInfo} />
      {isDevMode && <p className="muted" style={{ textAlign: 'center' }}>（開発モード: モックの LINE ユーザ{guest ? '・ゲスト' : ''}）</p>}
      {guest && (
        <p className="muted" style={{ textAlign: 'center', margin: '0 0 8px' }}>
          {isMobileUA ? '最後に本人確認のためLINEアプリが開きます。' : '最後にLINEログインで本人確認が必要です。'}
        </p>
      )}

      {/* 予約開始（主CTA）はカートが空の時だけ。追加後は下のカード内「ワンちゃんを追加」に集約 */}
      {cart.length === 0 && (
        <div className="book-quick">
          <button type="button" className="book-start" onClick={openNewItem}>
            <Plus size={20} style={{ verticalAlign: '-4px', marginRight: 4 }} />
            予約をはじめる
          </button>
        </div>
      )}

      {/* ご予約内容: 合計・犬リスト・追加ボタンを1枚のカードに統合 */}
      {cart.length > 0 && (
        <div className="book-cart-card">
          <div className="book-cart-head">
            <PawPrint size={18} />
            <span>ご予約内容（{cart.length}頭）</span>
            <span className="book-cart-sum">
              {totalDur}分{totalAmt > 0 ? ` / ¥${totalAmt.toLocaleString()}${hasUnpriced ? '〜' : ''}` : ''}
            </span>
          </div>
          <div className="cart-list" style={{ marginTop: 8 }}>
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
                      {it.serviceId && opts.length ? `＋ ${opts.map((o) => o.name).join('・')}` : ''}
                      {' ・ '}
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
          <button type="button" className="book-cart-add" onClick={openNewItem}>
            <Plus size={16} style={{ verticalAlign: '-3px', marginRight: 4 }} />
            ワンちゃんを追加
          </button>
        </div>
      )}

      {/* 月カレンダーは常時表示（トグル・日ナビ廃止）。日付タップで下に時間枠が出る一本道。
          ワンちゃん未選択の間はグレーアウトし、タップしたら「予約をはじめる」への案内を出す */}
      <div
        className={cart.length === 0 ? 'cal-disabled' : undefined}
        onClickCapture={(e) => {
          if (cart.length === 0) {
            e.preventDefault();
            e.stopPropagation();
            setSelectPrompt(true);
          }
        }}
      >
        <div className="cal-acc-body" ref={calRef}>
          <div className="cal-head">
            <button type="button" onClick={() => goMonth(-1)} aria-label="前の月">
              ‹
            </button>
            <span className="cal-title">
              {view.y}年 {view.m + 1}月
            </span>
            <button type="button" onClick={() => goMonth(1)} aria-label="次の月" disabled={atHorizonMonth}>
              ›
            </button>
          </div>
          <div className="cal-selected-date">
            {Number(date.slice(8, 10))}日（{DOW[new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getDay()]}）
            {date === today && <span className="day-today">今日</span>}
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
              const past = ds < today || ds > horizonEnd; // 過去と受付範囲外は選べない
              const closed = closedMonth.has(ds);
              // シフト未定（受付前）の日は「未定」表示（×とは区別）
              const undecided = !past && !closed && undecidedMonth.has(ds);
              // 選択中の内容が入らない日（休業/過去/未定を除く）
              const noFit = openMonth != null && !openMonth.has(ds) && !past && !closed && !undecided;
              // 現状はダメでも、最短まで縮めれば入る日 → △（変更すれば可能）
              const maybe = noFit && openMonthMin != null && openMonthMin.has(ds);
              // 最短でも入らない日 → ×（本当にダメ）
              const hardFull = noFit && !maybe;
              const cls = ['cal-cell'];
              if (d.getMonth() !== view.m) cls.push('other');
              if (ds === today) cls.push('today');
              if (ds === date) cls.push('selected');
              if (past) cls.push('other');
              if (closed) cls.push('closed');
              if (maybe) cls.push('maybe');
              if (hardFull || undecided) cls.push('nofit');
              return (
                <button
                  key={ds}
                  type="button"
                  className={cls.join(' ')}
                  disabled={past || closed || hardFull || undecided}
                  onClick={() => pickDay(d)}
                >
                  <span className={`cal-daynum${dow === 0 ? ' sun' : dow === 6 ? ' sat' : ''}`}>{d.getDate()}</span>
                  {closed && <span className="cal-badge closed">休</span>}
                  {undecided && <span className="cal-badge undecided">未定</span>}
                  {maybe && <span className="cal-badge maybe">△</span>}
                  {hardFull && <span className="cal-badge nofit">×</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* 選択日の時間枠（カレンダーの直下に常時表示）。
          エリアの高さを固定し、読込中は前の枠を薄く残す＝差し替えでカレンダー位置が揺れない */}
      {cart.length === 0 ? (
        <p className="tg-hint">上の「予約をはじめる」から、ワンちゃんとメニューを選んでください。</p>
      ) : (
        <div className="slot-area">
          <h3 className="slot-head">時間を選択してください</h3>
          {slots == null && loadingSlots ? (
            <p className="tg-hint">空き時間を読み込み中…</p>
          ) : (
            <div className={loadingSlots ? 'slot-loading' : undefined}>
              <AvailabilityGrid
                slots={slots ?? []}
                closed={closedDay}
                undecided={undecidedDay}
                selected={confirmSlot}
                onPick={(s) => setConfirmSlot(s)}
              />
              {/* 空きが無い日でも、内容を短くすれば入る場合は提案（未定日・読込中は出さない） */}
              {!loadingSlots && !closedDay && !undecidedDay && slots != null && slots.length === 0 && buildReductions().length > 0 && (
                <div className="suggest-cta">
                  <button type="button" onClick={findSuggestions}>
                    内容を短くして空きを探す
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 追加/編集モーダル（犬→メニュー→オプション） */}
      {draft && (
        <Modal title={draft.id ? 'ご予約内容の編集' : '予約するワンちゃん'} onClose={() => setDraft(null)}>
          {/* 犬（カート済みの子は非表示。編集中のその子は残す） */}
          <h3 className="pick-head">ワンちゃん</h3>
          {draft.dogId ? (
            // 選択済み: 選んだ子だけ表示（タップで変更）→ メニューに進む
            <div className="opt-list">
              <button
                type="button"
                className="opt-item set"
                style={{ textAlign: 'left', cursor: 'pointer' }}
                onClick={() => setDraft((dr) => (dr ? { ...dr, dogId: '' } : dr))}
              >
                {dogById(draft.dogId)?.name}
                {breedName(dogById(draft.dogId)?.breedId) ? `（${breedName(dogById(draft.dogId)?.breedId)}）` : ''}
                <span className="opt-meta">変更</span>
              </button>
            </div>
          ) : (
            <>
              <div className="opt-list">
                {availDogs.map((d) => (
                  <div key={d.id} className="opt-row">
                    <button
                      type="button"
                      className="opt-item"
                      style={{ textAlign: 'left', cursor: 'pointer', flex: 1 }}
                      onClick={() => setDraft((dr) => (dr ? { ...dr, dogId: d.id, serviceId: '', optionIds: [] } : dr))}
                    >
                      {d.name}
                      {breedName(d.breedId) ? `（${breedName(d.breedId)}）` : ''}
                    </button>
                    <button
                      type="button"
                      className="opt-remove"
                      aria-label={`${d.name}をリストから外す`}
                      onClick={() => {
                        setRemoveError(null);
                        setRemoveDog({ id: d.id, name: d.name });
                      }}
                    >
                      外す
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="opt-item dog-add"
                  style={{ textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => setDogFormOpen((o) => !o)}
                >
                  ＋ 新しくワンちゃんを追加
                </button>
              </div>
              {(dogFormOpen || availDogs.length === 0) && (
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
              )}
            </>
          )}

          {/* 犬を選んだら下へ誘導 */}
          {draft.dogId && <FlowArrow />}

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
                  {/* 本メニュー（1つ選択） */}
                  {menuServices.length > 0 && (
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
                      </div>
                    </>
                  )}

                  {/* メニューを選んだら下へ誘導 */}
                  {draft.serviceId && <FlowArrow />}

                  {/* 追加オプション（メニュー選択時のみ・複数可）。単品オプションもここに混ぜて同列表示 */}
                  {draft.serviceId && allOptions.length > 0 && (
                    <>
                      <h3 className="pick-head">オプション（任意・複数可）</h3>
                      <div className="opt-list">
                        {allOptions.map((o) => {
                          const e = optEff(o);
                          const on = draft.optionIds.includes(o.id);
                          return (
                            <button
                              key={o.id}
                              type="button"
                              className={`opt-item${on ? ' set' : ''}`}
                              style={{ textAlign: 'left', cursor: 'pointer' }}
                              onClick={() => toggleAddon(o.id)}
                            >
                              <span className="opt-check" aria-hidden="true">{on ? <Check size={16} strokeWidth={3} /> : null}</span>
                              {o.name}
                              <span className="opt-meta">
                                +¥{e.amt.toLocaleString()} / +{e.dur}分
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}

                  {/* 単品オプション（メニュー未選択時のみ。メニュー選択時は上のオプションに混在表示） */}
                  {!draft.serviceId && standaloneOpts.length > 0 && (
                    <>
                      <h3 className="pick-head">単品オプション（メニュー無しで予約・複数可）</h3>
                      <div className="opt-list">
                        {standaloneOpts.map((o) => {
                          const e = optEff(o);
                          const on = !draft.serviceId && draft.optionIds.includes(o.id);
                          return (
                            <button
                              key={o.id}
                              type="button"
                              className={`opt-item${on ? ' set' : ''}`}
                              style={{ textAlign: 'left', cursor: 'pointer' }}
                              onClick={() => toggleStandalone(o.id)}
                            >
                              <span className="opt-check" aria-hidden="true">{on ? <Check size={16} strokeWidth={3} /> : null}</span>
                              {o.name}
                              <span className="opt-meta">
                                ¥{e.amt.toLocaleString()} / {e.dur}分
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </>
              );
            })()}

          {/* メニュー/オプション/単品を選んだら下へ誘導 */}
          {draft.dogId && draftHasMenu && <FlowArrow />}

          {/* トリマー指名（任意・全頭共通）。既定は「指名なし」で折りたたみ、タップでスタッフリストを開く */}
          {draft.dogId && draftHasMenu && staffList.length > 0 && (
            <>
              <h3 className="pick-head">トリマー指名（任意）</h3>
              <p className="muted" style={{ margin: '0 0 6px' }}>指名は予約するすべての子で同じ担当になります。</p>
              <div className="opt-list">
                <button
                  type="button"
                  className={`opt-item${staffId ? ' set' : ''}`}
                  style={{ textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => setStaffPickerOpen((o) => !o)}
                >
                  {staffId ? staffName(staffId) : '指名なし（空いているスタッフ）'}
                  <span className="opt-meta">
                    {staffPickerOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </span>
                </button>
                {staffPickerOpen && (
                  <>
                    <button
                      type="button"
                      className={`opt-item${!staffId ? ' set' : ''}`}
                      style={{ textAlign: 'left', cursor: 'pointer' }}
                      onClick={() => {
                        setStaffId('');
                        setStaffPickerOpen(false);
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
                          setStaffPickerOpen(false);
                        }}
                      >
                        {s.name}
                      </button>
                    ))}
                  </>
                )}
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
              {draft.id ? '更新' : '決定して日時を選ぶ'}
            </button>
          </div>
        </Modal>
      )}

      {/* 予約する子が未登録の案内 */}
      {selectPrompt && (
        <Modal title="ご予約の準備" onClose={() => setSelectPrompt(false)}>
          <p>先に「予約をはじめる」から、ワンちゃんとメニューを選択してください。</p>
          <div className="modal-actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                setSelectPrompt(false);
                openNewItem();
              }}
            >
              予約をはじめる
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
            {formatDateJa(date)} {confirmSlot}〜{finishByStart[confirmSlot] ?? toHHMM(toMin(confirmSlot) + totalDur)}
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
                      {it.serviceId && opts.length ? `＋ ${opts.map((o) => o.name).join('・')}` : ''}
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
          {guest && (
            <p className="muted" style={{ marginTop: 8 }}>
              予約の確定にはLINEログインと公式アカウントの友だち追加が必要です。ログイン後、この内容のまま確定できます。
            </p>
          )}
          {error && <p className="error">{error}</p>}
          <div className="modal-actions">
            <button type="button" onClick={() => { setConfirmSlot(null); setError(null); }}>
              戻る
            </button>
            <button type="button" className="primary" disabled={submitting} onClick={confirm}>
              {submitting ? '送信中…' : guest ? 'LINEで予約を確定する' : '予約する'}
            </button>
          </div>
        </Modal>
      )}

      {/* 短縮提案（この日に入る縮小プラン） */}
      {suggest && (
        <Modal title="この日の空きを探す" onClose={() => setSuggest(null)}>
          <p className="muted">
            {formatDateJa(suggest.date)} は、いまの内容（{totalDur}分）では空きがありません。
            内容を短くすると、この日に予約できる場合があります。
          </p>
          {suggestLoading ? (
            <p className="tg-hint">空きを探しています…</p>
          ) : suggest.results.length === 0 ? (
            <p className="muted">短くしても、この日に空く時間は見つかりませんでした。別の日もお試しください。</p>
          ) : (
            <div className="opt-list">
              {suggest.results.map((r) => (
                <button
                  key={r.title}
                  type="button"
                  className="opt-item suggest-item"
                  style={{ textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => applySuggestion(r)}
                >
                  {r.title}
                  <span className="opt-meta">最短 {r.slot}〜{r.finish || ''}</span>
                </button>
              ))}
            </div>
          )}
          <div className="modal-actions">
            <button type="button" onClick={() => setSuggest(null)}>
              閉じる
            </button>
          </div>
        </Modal>
      )}

      {/* ワンちゃんをリストから外す（ソフト削除）確認 */}
      {removeDog && (
        <Modal title="リストから外す" onClose={() => !removing && setRemoveDog(null)}>
          <p>「{removeDog.name}」をリストから外しますか？</p>
          {isGuestDogId(removeDog.id) ? (
            <p className="muted">入力した内容を取り消します（まだサロンには登録されていません）。</p>
          ) : (
            <p className="muted">過去のご予約・カルテはサロンに残り、選択リストに表示されなくなるだけです。元に戻したいときはサロンへご連絡ください。</p>
          )}
          {removeError && <p className="error">{removeError}</p>}
          <div className="modal-actions">
            <button type="button" onClick={() => setRemoveDog(null)} disabled={removing}>
              キャンセル
            </button>
            <button type="button" className="primary" onClick={confirmRemoveDog} disabled={removing}>
              {removing ? '処理中…' : 'リストから外す'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** 空き開始時刻（15分グリッド）をチップで表示。入る枠だけが渡ってくる。 */
function AvailabilityGrid({
  slots,
  closed,
  undecided,
  selected,
  onPick,
}: {
  slots: string[];
  closed: boolean;
  undecided?: boolean;
  selected: string | null;
  onPick: (s: string) => void;
}) {
  if (closed) return <div className="slot-empty">休業日</div>;
  if (undecided) return <div className="slot-empty">この日はまだ受付前です（シフト調整中）</div>;
  if (slots.length === 0) return <div className="slot-empty">この日に空きはありません</div>;
  const sorted = [...slots].sort();
  return (
    <div className="slot-chips">
      {sorted.map((s) => (
        <button
          key={s}
          type="button"
          className={`slot-chip${selected === s ? ' selected' : ''}`}
          onClick={() => onPick(s)}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

/** ステップ間の視線誘導用の下向き矢印 */
function FlowArrow() {
  return (
    <div className="flow-arrow" aria-hidden="true">
      <ChevronDown size={22} strokeWidth={2.5} />
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
