// Firestore データモデル (§5) の型定義。
// 時刻は "HH:MM"（24h, ローカル）、所要時間は分。

export type StaffRole = 'admin' | 'admin_trimmer' | 'trimmer';

/** ロールの表示名（UIは日本語ラベルで統一） */
export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  admin: '管理者',
  admin_trimmer: '管理者兼トリマー',
  trimmer: 'トリマー',
};

/** 管理者権限を持つロールか（管理者・管理者兼トリマー） */
export const isAdminRole = (r: string | null | undefined): boolean => r === 'admin' || r === 'admin_trimmer';
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
  /** 予約受付の締切（予約開始の何時間前まで受付可）。0=直前まで（過去の時刻は常に不可）。既定 0 */
  bookingCutoffHours?: number;
  /** 予約受付範囲: 今月を含めて何ヶ月先の月末まで受付・シフト計画するか（シフト管理画面で設定）。既定 3 */
  bookingHorizonMonths?: number;
  /** 予約可能スタッフ全員が終日休みの日を顧客に「休業日」として見せるか（シフト管理画面で設定）。既定 true */
  autoCloseWhenAllOff?: boolean;
  /** シフトが誰も決まっていない日を「未定」として予約不可にするか（シフト管理画面で設定）。既定 false */
  requireShiftForBooking?: boolean;
  /** 店舗情報（LINE 文面に使用・任意） */
  address?: string;
  mapUrl?: string;
  phone?: string;
  /** 店舗ロゴ画像URL（ヘッダー中央に表示・任意） */
  logoUrl?: string;
  /** 消費税率(%)。既定 10 */
  taxRate?: number;
  /** 料金の税表示: 税込 or 税抜。既定 'exclusive'(税抜) */
  taxMode?: 'inclusive' | 'exclusive';
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
  /** メール招待で登録した場合のログイン用メール */
  email?: string;
}

/**
 * tenants/{tenantId}/shifts/{date} — スタッフ日別シフト（シフト①）。id = YYYY-MM-DD。
 * staff にエントリが無いスタッフは拠点営業時間どおり出勤。intervals: [] = 終日休み。
 */
export interface ShiftDayDoc {
  id: string; // = date
  /** work:true = 出勤を明示確定（営業時間どおり）。intervals:[] = 終日休み / 部分区間 = 時間指定 */
  staff?: Record<string, { work?: boolean; intervals?: { start: TimeStr; end: TimeStr }[] }>;
}

/** tenants/{tenantId}/breeds/{breedId} — 犬種マスタ */
export interface Breed {
  id: string;
  name: string;
  active: boolean;
  /** 料金表での犬種カードの並び順（小さいほど上） */
  order?: number;
}

/** オプションの基本形（予約時スナップショットにも使う）。 */
export interface ServiceOption {
  id: string;
  name: string;
  price: number;
  /** 追加所要時間（分）。トータル時間に加算しカレンダー占有に反映 */
  durationMin: number;
}

/** tenants/{tenantId}/options/{optionId} — オプションマスタ（サービスから独立） */
export interface Option extends ServiceOption {
  active: boolean;
  /** 表示順 */
  order?: number;
  /**
   * 単体予約可（オプションのみ可）。true なら予約画面でメニューと同列にも表示し、
   * メニュー未選択でもこれ単体で予約できる。false/未設定はメニューの追加オプション専用。
   */
  standalone?: boolean;
}

/** tenants/{tenantId}/services/{serviceId} — サービスメニュー マスタ */
export interface Service {
  id: string;
  name: string;
  active: boolean;
}

/**
 * tenants/{tenantId}/pricing/{breedId__serviceId} — 料金表（犬種×サービス）。
 * 金額と所要時間をセルごとに保持。
 */
export interface PriceEntry {
  id: string; // = `${breedId}__${serviceId}`
  breedId: string;
  serviceId: string;
  price: number;
  durationMin: number;
  active: boolean;
  /** 料金表カードの並び順（小さいほど上） */
  order?: number;
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
  /** 犬種マスタ(breeds)への参照。料金表の引当に使う */
  breedId?: string | null;
  /** 旧: 自由入力の犬種名（表示フォールバック） */
  breed?: string;
  size?: string;
  notes?: string;
  allergies?: string;
  /**
   * サービスごとの個別加算時間（分）。{ [serviceId]: 加算分 }。この子だけ標準より余計にかかる分。
   * 予約の所要時間 = 料金表(犬種×サービス)の標準時間 + これ（+ オプション）。
   */
  serviceAdjustments?: Record<string, number>;
  /** 旧: 全サービス共通の個別加算（廃止・後方互換の任意残置） */
  additionalDurationMin?: number | null;
  /** オプションごとの個別追加時間（分）。{ [optionId]: 追加分 }。この子だけ余計にかかる分 */
  optionAdjustments?: Record<string, number>;
  /** 旧: 絶対値の確定作業時間/料金（廃止・後方互換のため任意で残置） */
  confirmedDurationMin?: number | null;
  basePrice?: number | null;
  confirmedPrice?: number | null;
  lastServiceAt?: IsoStr | null;
}

/** tenants/{tenantId}/dogs/{dogId}/records/{recordId} — カルテ履歴 (§5/§7) */
export interface ServiceRecord {
  id: string;
  bookingId: string;
  date: DateStr;
  serviceId: string;
  staffId: string;
  durationMin: number;
  price: number;
  notes?: string;
}

/** POS(mobile_order)への会計依頼伝票の送信記録（①会計連携）。booking.posCheckout */
export interface PosCheckoutInfo {
  /** groom側発番の冪等キー（POS側 checkoutRequests の doc ID） */
  requestId: string;
  status: 'sending' | 'sent' | 'failed';
  sentAt?: IsoStr | null;
  /** 逆引きされたPOS店舗 */
  storeId?: string | null;
  /** 送信時点のPOS側伝票状態（pending/claimed/paid など） */
  posStatus?: string | null;
  lastError?: string | null;
}

/** tenants/{tenantId}/bookings/{bookingId} (§5) */
export interface Booking {
  id: string;
  dogId: string;
  customerId: string;
  serviceId: string;
  /** 選択されたオプションの id（§オプション） */
  optionIds?: string[];
  /** 予約時点のオプション内容スナップショット（後の料金表変更に影響されない） */
  options?: ServiceOption[];
  /** 複数頭まとめ予約のグループ識別子（同時予約を束ねる） */
  groupId?: string;
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
  /** POSへの会計依頼伝票の送信記録（①会計連携）。未送信なら未設定 */
  posCheckout?: PosCheckoutInfo | null;
  createdAt: IsoStr;
}
