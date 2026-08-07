// Callable Cloud Functions のクライアントラッパ (§2/§4)。
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import type { StaffRole } from './types';

export const createTenant = httpsCallable<
  { tenantId: string; name: string; plan?: string },
  { tenantId: string }
>(functions, 'createTenant');

export const setStaffRole = httpsCallable<
  { tenantId: string; targetUid: string; name: string; role: StaffRole },
  { tenantId: string; targetUid: string; role: StaffRole }
>(functions, 'setStaffRole');

/** メール招待でスタッフを追加（Authユーザー用意＋権限付与＋staff作成）。created=新規作成。 */
export const inviteStaff = httpsCallable<
  { tenantId: string; email: string; name: string; role: StaffRole },
  { uid: string; email: string; role: StaffRole; created: boolean }
>(functions, 'inviteStaff');

/** スタッフのパスワード設定リンクを再発行（メール不達/期限切れ時の共有用）。 */
export const getStaffInviteLink = httpsCallable<
  { tenantId: string; targetUid: string },
  { email: string; link: string }
>(functions, 'getStaffInviteLink');

/** スタッフの氏名・ロールを編集（ロール変更時は custom claims も同期）。 */
export const updateStaff = httpsCallable<
  { tenantId: string; targetUid: string; name: string; role: StaffRole },
  { targetUid: string; name: string; role: StaffRole }
>(functions, 'updateStaff');

/** 予約の時間変更（スタッフ用）。startTime無し=同日の移動先候補を取得 / 指定=移動を確定。 */
export const rescheduleBooking = httpsCallable<
  { tenantId: string; bookingId: string; startTime?: string },
  { date: string; current: string; slots: string[] }
>(functions, 'rescheduleBooking');

export const completeBooking = httpsCallable<
  { tenantId: string; bookingId: string; finalDurationMin: number; finalPrice: number; notes?: string },
  { bookingId: string; status: 'done' }
>(functions, 'completeBooking');

/** 完了済み予約の会計依頼伝票をPOS(mobile_order)へ送信（①会計連携）。再送は冪等。 */
export const sendCheckoutToPos = httpsCallable<
  { tenantId: string; bookingId: string },
  { requestId: string; storeId: string | null; posStatus: string | null }
>(functions, 'sendCheckoutToPos');

export const createBookingByStaff = httpsCallable<
  {
    tenantId: string;
    dogId: string;
    serviceId: string;
    date: string;
    startTime: string;
    staffId?: string;
    optionIds?: string[];
  },
  { bookingId: string; staffId: string | null; slotEnd: string; durationMin: number }
>(functions, 'createBookingByStaff');

export const mergeCustomers = httpsCallable<
  { tenantId: string; sourceCustomerId: string; targetCustomerId: string },
  { targetCustomerId: string; movedDogs: number; movedBookings: number; patch: Record<string, unknown> }
>(functions, 'mergeCustomers');
