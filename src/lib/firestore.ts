// 型付き Firestore コレクション参照 (§5)。
// ドキュメント内には id を保持しないため、変換時に id を剥がす/付与する。
import {
  collection,
  doc,
  type CollectionReference,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from '../firebase';
import type {
  Booking,
  Customer,
  Dog,
  Menu,
  ServiceRecord,
  Staff,
  Tenant,
} from './types';

/** id フィールドを持つ型に対する、id を除いたデータ部 */
type WithoutId<T> = Omit<T, 'id'>;

function converter<T extends { id: string }>(): FirestoreDataConverter<T> {
  return {
    toFirestore(model: T): DocumentData {
      const { id: _id, ...rest } = model;
      return rest;
    },
    fromFirestore(snap: QueryDocumentSnapshot): T {
      return { id: snap.id, ...(snap.data() as WithoutId<T>) } as T;
    },
  };
}

const tenantConverter = converter<Tenant>();
const staffConverter = converter<Staff>();
const menuConverter = converter<Menu>();
const customerConverter = converter<Customer>();
const dogConverter = converter<Dog>();
const recordConverter = converter<ServiceRecord>();
const bookingConverter = converter<Booking>();

export const tenantsCol = (): CollectionReference<Tenant> =>
  collection(db, 'tenants').withConverter(tenantConverter);

export const tenantDoc = (tenantId: string) => doc(tenantsCol(), tenantId);

export const staffCol = (tenantId: string): CollectionReference<Staff> =>
  collection(db, 'tenants', tenantId, 'staff').withConverter(staffConverter);

export const menusCol = (tenantId: string): CollectionReference<Menu> =>
  collection(db, 'tenants', tenantId, 'menus').withConverter(menuConverter);

export const customersCol = (tenantId: string): CollectionReference<Customer> =>
  collection(db, 'tenants', tenantId, 'customers').withConverter(customerConverter);

export const dogsCol = (tenantId: string): CollectionReference<Dog> =>
  collection(db, 'tenants', tenantId, 'dogs').withConverter(dogConverter);

export const recordsCol = (
  tenantId: string,
  dogId: string,
): CollectionReference<ServiceRecord> =>
  collection(db, 'tenants', tenantId, 'dogs', dogId, 'records').withConverter(recordConverter);

export const bookingsCol = (tenantId: string): CollectionReference<Booking> =>
  collection(db, 'tenants', tenantId, 'bookings').withConverter(bookingConverter);
