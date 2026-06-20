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
}
export interface BookingOptions {
  store: { name: string; logoUrl: string | null };
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

export const getBookingOptions = httpsCallable<
  { tenantId: string; accessToken: string; customerId: string },
  BookingOptions
>(functions, 'getBookingOptions');

export const getClosedDates = httpsCallable<
  { tenantId: string; accessToken: string; from: string; to: string },
  { dates: string[] }
>(functions, 'getClosedDates');

export const registerDog = httpsCallable<
  { tenantId: string; accessToken: string; customerId: string; name: string; breedId?: string },
  { dogId: string }
>(functions, 'registerDog');

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

/** カート（複数頭まとめ予約）の1項目 = 犬×メニュー×オプション */
export interface GroupItem {
  dogId: string;
  serviceId: string;
  optionIds?: string[];
}

export const getGroupAvailability = httpsCallable<
  { tenantId: string; accessToken: string; date: string; items: GroupItem[]; staffId?: string },
  {
    slots: string[];
    durationMin: number;
    bufferMin: number;
    price: number | null;
    businessHours: { start: string; end: string }[];
    closed?: boolean;
  }
>(functions, 'getGroupAvailability');

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
