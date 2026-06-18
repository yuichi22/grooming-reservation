// Firestore データモデル (§5) の型定義。
// 時刻は "HH:MM"（24h, ローカル）、所要時間は分。

export type StaffRole = 'admin' | 'trimmer';
export type BookingStatus = 'reserved' | 'done' | 'canceled' | 'noshow';
export type TenantStatus = 'active' | 'suspended';

/** "HH:MM" 形式の時刻文字列 */
export type TimeStr = string;
/** "YYYY-MM-DD" 形式の日付文字列 */
export type DateStr = string;
/** ISO8601 文字列 (例: "2026-06-20T11:50:00+09:00") */
export type IsoStr = string;

/** superAdmins/{uid} (§5) */
export interface SuperAdmin {
  uid: string;
  email?: string;
  createdAt: IsoStr;
}

/** テナントごとの LINE 設定 (§4) */
export interface LineConfig {
  providerId: string;
  miniAppChannelId: string;
  messagingApiChannelId: string;
  /** リマインド送信用のチャネルアクセストークン (§9)。未設定なら env フォールバック */
  messagingChannelAccessToken?: string;
  liffId: string;
}

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
  /** キャンセル締切（予約開始の何時間前まで可）(§11) */
  cancelDeadlineHours?: number;
  /** 店舗情報（LINE 文面に使用・任意） */
  address?: string;
  mapUrl?: string;
  phone?: string;
  /** 店舗ロゴ画像URL（ヘッダー中央に表示・任意） */
  logoUrl?: string;
}

/** tenants/{tenantId}/closures/{YYYY-MM-DD} — 臨時休業/祝日 (§11) */
export interface Closure {
  id: string; // = YYYY-MM-DD
  reason?: string;
  /** false で半日など将来拡張用。省略/true は終日休業 */
  fullDay?: boolean;
}

/** tenants/{tenantId} (§5) */
export interface Tenant {
  id: string;
  name: string;
  plan: string;
  status: TenantStatus;
  lineConfig: LineConfig;
  settings: TenantSettings;
  createdAt: IsoStr;
}

/** tenants/{tenantId}/staff/{staffId} (§5) */
export interface Staff {
  id: string;
  name: string;
  role: StaffRole;
  active: boolean;
  firebaseUid: string;
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

/**
 * tenants/{tenantId}/customers/{customerId} (§5)
 * 予約 SaaS 内のローカル顧客。中央会員(memberId)への参照を持ち、
 * find-or-link (§3) で同一人物に結びつく。
 */
export interface Customer {
  id: string;
  /** 中央会員への参照。未連携の間は null (§3) */
  memberId: string | null;
  ownerName: string;
  phone?: string | null;
  lineUserId?: string | null;
  /** 手動マージで統合された場合の統合先 (§11)。設定済みなら無効レコード */
  mergedInto?: string | null;
  createdAt: IsoStr;
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
  lastServiceAt?: IsoStr | null;
}

/** tenants/{tenantId}/dogs/{dogId}/records/{recordId} — カルテ履歴 (§5/§7) */
export interface ServiceRecord {
  id: string;
  bookingId: string;
  date: DateStr;
  menuId: string;
  staffId: string;
  durationMin: number;
  price: number;
  notes?: string;
}

/** tenants/{tenantId}/bookings/{bookingId} (§5) */
export interface Booking {
  id: string;
  dogId: string;
  customerId: string;
  menuId: string;
  /** 指名なしは null。確定時に割当 (§8) */
  staffId: string | null;
  date: DateStr;
  startTime: TimeStr;
  durationMin: number;
  bufferMin: number;
  /** startTime + durationMin + bufferMin。占有はこの終端まで (§6) */
  slotEnd: TimeStr;
  status: BookingStatus;
  finalDurationMin?: number | null;
  finalPrice?: number | null;
  /** 前日リマインド送信済みの印（冪等化, §9）。未送信なら未設定 */
  reminderSentAt?: IsoStr | null;
  /** 予約完了メッセージ送信済みの印（冪等化）。未送信なら未設定 */
  confirmationSentAt?: IsoStr | null;
  /** キャンセル日時 (§11) */
  canceledAt?: IsoStr | null;
  createdAt: IsoStr;
}
