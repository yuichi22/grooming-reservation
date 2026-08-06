// 顧客向け Cloud Functions のクライアントラッパ (§3/§6/§7/§8)。
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

export interface PriceCell {
  breedId: string;
  serviceId: string;
  price: number;
  durationMin: number;
}
export interface ServiceOption {
  id: string;
  name: string;
  price: number;
  durationMin: number;
  /** true ならメニューと同列で単体予約も可 */
  standalone?: boolean;
}
export interface BookingOptions {
  store: { name: string; logoUrl: string | null };
  /** 予約受付範囲（今月+Nヶ月の月末まで）。カレンダー送りの上限に使う */
  bookingHorizonMonths?: number;
  services: { id: string; name: string }[];
  options: ServiceOption[];
  breeds: { id: string; name: string }[];
  staff: { id: string; name: string }[];
  dogs: {
    id: string;
    name: string;
    breedId: string | null;
    serviceAdjustments: Record<string, number>;
    optionAdjustments: Record<string, number>;
  }[];
  pricing: PriceCell[];
}

export const customerSession = httpsCallable<
  { tenantId: string; accessToken: string; ownerName?: string; phone?: string },
  // options は電話登録済みのとき同梱（起動時の getBookingOptions 呼び出しを省く B）
  {
    customerId: string;
    lineUserId: string;
    needsPhone: boolean;
    options: BookingOptions | null;
    store: { name: string; logoUrl: string | null };
  }
>(functions, 'customerSession');

/** このLINEユーザーが利用した店の1件 */
export interface MyTenant {
  tenantId: string;
  name: string;
  logoUrl: string | null;
}

export const getMyTenants = httpsCallable<{ accessToken: string }, { tenants: MyTenant[] }>(
  functions,
  'getMyTenants',
);

export const removeMyTenant = httpsCallable<{ accessToken: string; tenantId: string }, { ok: boolean }>(
  functions,
  'removeMyTenant',
);

export const getBookingOptions = httpsCallable<
  { tenantId: string; accessToken: string; customerId: string },
  BookingOptions
>(functions, 'getBookingOptions');

/** ゲスト（LINEログイン前）向けの公開予約カタログ。dogs は含まれない。 */
export const getPublicBookingOptions = httpsCallable<
  { tenantId: string },
  Omit<BookingOptions, 'dogs'>
>(functions, 'getPublicBookingOptions');

export const getClosedDates = httpsCallable<
  { tenantId: string; accessToken?: string; from: string; to: string },
  // undecidedDates = シフト未定で受付前の日（requireShiftForBooking がONのテナントのみ）
  { dates: string[]; undecidedDates?: string[] }
>(functions, 'getClosedDates');

export const registerDog = httpsCallable<
  { tenantId: string; accessToken: string; customerId: string; name: string; breedId?: string },
  { dogId: string }
>(functions, 'registerDog');

/** 自分の犬をリストから外す（ソフト削除）。今後の予約があると failed-precondition。 */
export const hideDog = httpsCallable<
  { tenantId: string; accessToken: string; customerId: string; dogId: string },
  { ok: boolean }
>(functions, 'hideDog');

export const getAvailability = httpsCallable<
  {
    tenantId: string;
    accessToken: string;
    date: string;
    serviceId: string;
    dogId?: string;
    staffId?: string;
    optionIds?: string[];
  },
  {
    slots: string[];
    durationMin: number;
    bufferMin: number;
    price: number | null;
    businessHours: { start: string; end: string }[];
    closed?: boolean;
  }
>(functions, 'getAvailability');

/**
 * カート（複数頭まとめ予約）の1項目 = 犬×メニュー×オプション。
 * dogId は登録済みの犬。ゲスト（未ログイン）の空き照会は breedId のみ、
 * ログイン後の確定は newDog（サーバ側で登録して予約に紐付け）を使う。
 */
export interface GroupItem {
  dogId?: string;
  breedId?: string | null;
  newDog?: { name: string; breedId?: string | null };
  serviceId: string;
  optionIds?: string[];
}

export const getGroupAvailability = httpsCallable<
  { tenantId: string; accessToken?: string; date: string; items: GroupItem[]; staffId?: string },
  {
    slots: string[];
    /** 開始時刻(HH:MM) → 施術終了時刻(HH:MM)。複数頭は自動分割のため終了は開始ごとに異なる */
    finishByStart: Record<string, string>;
    durationMin: number;
    bufferMin: number;
    price: number | null;
    businessHours: { start: string; end: string }[];
    closed?: boolean;
    /** シフト未定のため受付前（requireShiftForBooking がONのテナントのみ） */
    undecided?: boolean;
  }
>(functions, 'getGroupAvailability');

export const getMonthAvailability = httpsCallable<
  { tenantId: string; accessToken?: string; items: GroupItem[]; from: string; to: string; staffId?: string },
  { openDates: string[] }
>(functions, 'getMonthAvailability');

export const createGroupBooking = httpsCallable<
  {
    tenantId: string;
    accessToken: string;
    customerId: string;
    date: string;
    startTime: string;
    items: GroupItem[];
    staffId?: string;
  },
  { bookingIds: string[]; groupId: string; staffId: string | null; slotEnd: string; startTime: string; durationMin: number }
>(functions, 'createGroupBooking');

export const cancelBookingByCustomer = httpsCallable<
  { tenantId: string; accessToken: string; bookingId: string },
  { bookingId: string; status: 'canceled' }
>(functions, 'cancelBookingByCustomer');

export const createBooking = httpsCallable<
  {
    tenantId: string;
    accessToken: string;
    customerId: string;
    dogId: string;
    serviceId: string;
    date: string;
    startTime: string;
    staffId?: string;
    optionIds?: string[];
  },
  { bookingId: string; staffId: string | null; slotEnd: string }
>(functions, 'createBooking');
