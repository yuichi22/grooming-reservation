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

export const completeBooking = httpsCallable<
  { tenantId: string; bookingId: string; finalDurationMin: number; finalPrice: number; notes?: string },
  { bookingId: string; status: 'done' }
>(functions, 'completeBooking');

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
