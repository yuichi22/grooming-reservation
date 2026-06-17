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

export const completeBooking = httpsCallable<
  { tenantId: string; bookingId: string; finalDurationMin: number; finalPrice: number; notes?: string },
  { bookingId: string; status: 'done' }
>(functions, 'completeBooking');

export const mergeCustomers = httpsCallable<
  { tenantId: string; sourceCustomerId: string; targetCustomerId: string },
  { targetCustomerId: string; movedDogs: number; movedBookings: number; patch: Record<string, unknown> }
>(functions, 'mergeCustomers');
