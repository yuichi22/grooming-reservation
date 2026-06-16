// Firestore データモデル (§5) の型定義。
// 時刻は "HH:MM"（24h, ローカル）、所要時間は分。

export type StaffRole = 'admin' | 'trimmer';
export type BookingStatus = 'reserved' | 'done' | 'canceled' | 'noshow';

/** "HH:MM" 形式の時刻文字列 */
export type TimeStr = string;

/** 営業時間の1区間 (§5 settings.businessHours[]) */
export interface BusinessHours {
  start: TimeStr;
  end: TimeStr;
}

/** tenants/{tenantId}.settings (§5) */
export interface TenantSettings {
  timezone: string;
  businessHours: BusinessHours[];
  bufferMin: number;
  /** 作業時間の選択肢。フリー入力不可 (§6) */
  workTimeOptions: number[];
}

/** tenants/{tenantId}/menus/{menuId} (§5) */
export interface Menu {
  id: string;
  name: string;
  defaultDurationMin: number;
  /** true なら犬ごとのオーバーライドを無視し defaultDurationMin 固定 (例: シャンプー=50分) */
  fixedDuration: boolean;
  price: number;
  active: boolean;
}

/** tenants/{tenantId}/dogs/{dogId} (§5) */
export interface Dog {
  id: string;
  customerId: string;
  name: string;
  breed?: string;
  size?: string;
  notes?: string;
  allergies?: string;
  /** 確定作業時間。null なら未確定（メニュー標準を使う）(§7) */
  confirmedDurationMin: number | null;
  confirmedPrice?: number | null;
  lastServiceAt?: string | null;
}

/** tenants/{tenantId}/bookings/{bookingId} (§5) — 空き計算で使う最小フィールド */
export interface Booking {
  id: string;
  dogId: string;
  customerId: string;
  menuId: string;
  staffId: string | null;
  date: string;
  startTime: TimeStr;
  durationMin: number;
  bufferMin: number;
  /** startTime + durationMin + bufferMin。占有はこの終端まで (§6) */
  slotEnd: TimeStr;
  status: BookingStatus;
}
