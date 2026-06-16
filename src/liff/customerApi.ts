// 顧客向け Cloud Functions のクライアントラッパ (§3/§6/§7/§8)。
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

export const customerSession = httpsCallable<
  { tenantId: string; accessToken: string; ownerName?: string; phone?: string },
  { customerId: string; lineUserId: string; needsPhone: boolean }
>(functions, 'customerSession');

export interface BookingOptions {
  menus: { id: string; name: string; defaultDurationMin: number; fixedDuration: boolean; price: number }[];
  staff: { id: string; name: string }[];
  dogs: { id: string; name: string; confirmedDurationMin: number | null }[];
}

export const getBookingOptions = httpsCallable<
  { tenantId: string; accessToken: string; customerId: string },
  BookingOptions
>(functions, 'getBookingOptions');

export const registerDog = httpsCallable<
  { tenantId: string; accessToken: string; customerId: string; name: string; breed?: string },
  { dogId: string }
>(functions, 'registerDog');

export const getAvailability = httpsCallable<
  { tenantId: string; accessToken: string; date: string; menuId: string; dogId?: string; staffId?: string },
  { slots: string[]; durationMin: number; bufferMin: number }
>(functions, 'getAvailability');

export const createBooking = httpsCallable<
  {
    tenantId: string;
    accessToken: string;
    customerId: string;
    dogId: string;
    menuId: string;
    date: string;
    startTime: string;
    staffId?: string;
  },
  { bookingId: string; staffId: string | null; slotEnd: string }
>(functions, 'createBooking');
