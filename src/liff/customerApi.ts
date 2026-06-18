// 顧客向け Cloud Functions のクライアントラッパ (§3/§6/§7/§8)。
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

export interface PriceCell {
  breedId: string;
  serviceId: string;
  price: number;
  durationMin: number;
}
export interface BookingOptions {
  services: { id: string; name: string }[];
  breeds: { id: string; name: string }[];
  staff: { id: string; name: string }[];
  dogs: { id: string; name: string; breedId: string | null; confirmedDurationMin: number | null }[];
  pricing: PriceCell[];
}

export const customerSession = httpsCallable<
  { tenantId: string; accessToken: string; ownerName?: string; phone?: string },
  // options は電話登録済みのとき同梱（起動時の getBookingOptions 呼び出しを省く B）
  { customerId: string; lineUserId: string; needsPhone: boolean; options: BookingOptions | null }
>(functions, 'customerSession');

export const getBookingOptions = httpsCallable<
  { tenantId: string; accessToken: string; customerId: string },
  BookingOptions
>(functions, 'getBookingOptions');

export const registerDog = httpsCallable<
  { tenantId: string; accessToken: string; customerId: string; name: string; breedId?: string },
  { dogId: string }
>(functions, 'registerDog');

export const getAvailability = httpsCallable<
  { tenantId: string; accessToken: string; date: string; serviceId: string; dogId?: string; staffId?: string },
  { slots: string[]; durationMin: number; bufferMin: number; price: number | null; closed?: boolean }
>(functions, 'getAvailability');

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
  },
  { bookingId: string; staffId: string | null; slotEnd: string }
>(functions, 'createBooking');
