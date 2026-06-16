// Cloud Functions (M1): テナント発行とスタッフ権限付与。
// 認証は custom claims に基づく (§2)。
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue, type DocumentReference } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { resolveLink, type CustomerIdentifiers } from './findOrLink.js';
import { verifyLineAccessToken } from './line.js';
import { availability, effectiveDuration, toMinutes, toTimeStr, unionStarts } from './slots.js';
import { buildPointEvent, deliverPointEvent, type PointEventStatus } from './crm.js';

initializeApp();
const db = getFirestore();
const auth = getAuth();

type StaffRole = 'admin' | 'trimmer';

const DEFAULT_SETTINGS = {
  timezone: 'Asia/Tokyo',
  businessHours: [{ start: '09:00', end: '19:00' }],
  bufferMin: 10,
  workTimeOptions: [50, 80, 110],
};

const EMPTY_LINE_CONFIG = {
  providerId: '',
  miniAppChannelId: '',
  messagingApiChannelId: '',
  liffId: '',
};

interface CreateTenantData {
  tenantId: string;
  name: string;
  plan?: string;
  lineConfig?: Partial<typeof EMPTY_LINE_CONFIG>;
  settings?: Partial<typeof DEFAULT_SETTINGS>;
}

/**
 * テナント発行 (§4)。superAdmin のみ。
 * tenants/{tenantId} を作成する（既存ならエラー）。
 */
export const createTenant = onCall<CreateTenantData>(async (request) => {
  if (request.auth?.token.superAdmin !== true) {
    throw new HttpsError('permission-denied', 'superAdmin only');
  }
  const { tenantId, name } = request.data;
  if (!tenantId || !name) {
    throw new HttpsError('invalid-argument', 'tenantId and name are required');
  }

  const ref = db.collection('tenants').doc(tenantId);
  if ((await ref.get()).exists) {
    throw new HttpsError('already-exists', `tenant ${tenantId} already exists`);
  }

  await ref.set({
    name,
    plan: request.data.plan ?? 'standard',
    status: 'active',
    lineConfig: { ...EMPTY_LINE_CONFIG, ...request.data.lineConfig },
    settings: { ...DEFAULT_SETTINGS, ...request.data.settings },
    createdAt: FieldValue.serverTimestamp(),
  });

  return { tenantId };
});

interface SetStaffRoleData {
  tenantId: string;
  targetUid: string;
  name: string;
  role: StaffRole;
}

/**
 * スタッフへ custom claims(tenantId, role) を付与し staff ドキュメントを作成 (§2)。
 * superAdmin、または対象テナントの admin のみ実行可。
 */
export const setStaffRole = onCall<SetStaffRoleData>(async (request) => {
  const caller = request.auth?.token;
  const { tenantId, targetUid, name, role } = request.data;

  if (!tenantId || !targetUid || !name || (role !== 'admin' && role !== 'trimmer')) {
    throw new HttpsError('invalid-argument', 'tenantId, targetUid, name, role(admin|trimmer) required');
  }

  const isSuper = caller?.superAdmin === true;
  const isTenantAdmin = caller?.tenantId === tenantId && caller?.role === 'admin';
  if (!isSuper && !isTenantAdmin) {
    throw new HttpsError('permission-denied', 'superAdmin or tenant admin only');
  }

  // superAdmin を別テナントに巻き込まない安全策
  const target = await auth.getUser(targetUid);
  if (target.customClaims?.superAdmin === true) {
    throw new HttpsError('failed-precondition', 'cannot assign tenant role to a superAdmin');
  }

  await auth.setCustomUserClaims(targetUid, { tenantId, role });

  await db
    .collection('tenants')
    .doc(tenantId)
    .collection('staff')
    .doc(targetUid)
    .set({ name, role, active: true, firebaseUid: targetUid }, { merge: true });

  return { tenantId, targetUid, role };
});

// ===== 顧客向け（LIFF）: LINE トークン検証によるサーバ権威の予約フロー =====

interface MenuLike {
  defaultDurationMin: number;
  fixedDuration: boolean;
}
interface BusinessHours {
  start: string;
  end: string;
}
interface SettingsLike {
  businessHours: BusinessHours[];
  bufferMin: number;
}

async function loadSettings(tenantId: string): Promise<SettingsLike> {
  const snap = await db.collection('tenants').doc(tenantId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'tenant not found');
  const s = (snap.data()?.settings ?? {}) as Partial<SettingsLike>;
  return { businessHours: s.businessHours ?? [], bufferMin: s.bufferMin ?? 0 };
}

async function loadMenu(tenantId: string, menuId: string): Promise<MenuLike> {
  const snap = await db.collection('tenants').doc(tenantId).collection('menus').doc(menuId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'menu not found');
  const m = snap.data() as MenuLike;
  return { defaultDurationMin: m.defaultDurationMin, fixedDuration: m.fixedDuration };
}

async function loadDogDuration(tenantId: string, dogId?: string): Promise<number | null> {
  if (!dogId) return null;
  const snap = await db.collection('tenants').doc(tenantId).collection('dogs').doc(dogId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'dog not found');
  return (snap.data()?.confirmedDurationMin ?? null) as number | null;
}

interface BookingRow {
  staffId: string | null;
  startTime: string;
  slotEnd: string;
  status: string;
}

async function loadDayBookings(tenantId: string, date: string): Promise<BookingRow[]> {
  const q = await db.collection('tenants').doc(tenantId).collection('bookings').where('date', '==', date).get();
  return q.docs
    .map((d) => d.data() as BookingRow)
    .filter((b) => b.status === 'reserved' || b.status === 'done');
}

async function loadActiveStaffIds(tenantId: string): Promise<string[]> {
  const q = await db.collection('tenants').doc(tenantId).collection('staff').where('active', '==', true).get();
  return q.docs.map((d) => d.id);
}

/** 指定スタッフ視点の占有区間。未割当(null)予約は全スタッフを塞ぐ扱い。 */
function occupiedFor(bookings: BookingRow[], staffId: string): { start: string; end: string }[] {
  return bookings
    .filter((b) => b.staffId === staffId || b.staffId == null)
    .map((b) => ({ start: b.startTime, end: b.slotEnd }));
}

/**
 * 顧客セッション確立 + find-or-link (§3)。
 * LINE トークンを検証し、tenant 内の customers を識別子照合して結びつける/作成する。
 */
export const customerSession = onCall<{
  tenantId: string;
  accessToken: string;
  ownerName?: string;
  phone?: string;
}>(async (request) => {
  const { tenantId, accessToken, ownerName, phone } = request.data;
  if (!tenantId) throw new HttpsError('invalid-argument', 'tenantId required');
  const { lineUserId } = await verifyLineAccessToken(accessToken);

  const customersRef = db.collection('tenants').doc(tenantId).collection('customers');
  const existing: CustomerIdentifiers[] = [];
  const byLine = await customersRef.where('lineUserId', '==', lineUserId).get();
  byLine.forEach((d) => existing.push({ id: d.id, ...(d.data() as Omit<CustomerIdentifiers, 'id'>) }));
  if (phone) {
    const byPhone = await customersRef.where('phone', '==', phone).get();
    byPhone.forEach((d) => {
      if (!existing.some((e) => e.id === d.id)) {
        existing.push({ id: d.id, ...(d.data() as Omit<CustomerIdentifiers, 'id'>) });
      }
    });
  }

  const decision = resolveLink(existing, { lineUserId, phone });
  let customerId: string;
  if (decision.action === 'create') {
    const ref = await customersRef.add({
      memberId: null,
      ownerName: ownerName ?? '',
      phone: phone ?? null,
      lineUserId,
      createdAt: FieldValue.serverTimestamp(),
    });
    customerId = ref.id;
  } else {
    customerId = decision.customerId;
    if (decision.action === 'link') {
      const patch: Record<string, unknown> = {};
      if (decision.addLineUserId) patch.lineUserId = decision.addLineUserId;
      if (decision.addPhone) patch.phone = decision.addPhone;
      if (Object.keys(patch).length > 0) await customersRef.doc(customerId).update(patch);
    }
  }

  const finalSnap = await customersRef.doc(customerId).get();
  const finalPhone = (finalSnap.data()?.phone ?? null) as string | null;
  return { customerId, lineUserId, needsPhone: !finalPhone };
});

/** 空きスロット取得 (§6 + §8 指名スコープ)。 */
export const getAvailability = onCall<{
  tenantId: string;
  accessToken: string;
  date: string;
  menuId: string;
  dogId?: string;
  staffId?: string;
}>(async (request) => {
  const { tenantId, accessToken, date, menuId, dogId, staffId } = request.data;
  if (!tenantId || !date || !menuId) throw new HttpsError('invalid-argument', 'tenantId, date, menuId required');
  await verifyLineAccessToken(accessToken); // 顧客認証ゲート

  const [settings, menu, confirmed] = await Promise.all([
    loadSettings(tenantId),
    loadMenu(tenantId, menuId),
    loadDogDuration(tenantId, dogId),
  ]);
  const durationMin = effectiveDuration(confirmed, menu);
  const bookings = await loadDayBookings(tenantId, date);

  let slots: string[];
  if (staffId) {
    // 指名あり: そのスタッフの予約のみで計算 (§8)
    slots = availability({
      businessHours: settings.businessHours,
      bufferMin: settings.bufferMin,
      durationMin,
      occupied: occupiedFor(bookings, staffId),
    });
  } else {
    // 指名なし: 全アクティブスタッフの空きの和集合 (§8)
    const staffIds = await loadActiveStaffIds(tenantId);
    if (staffIds.length === 0) {
      slots = availability({
        businessHours: settings.businessHours,
        bufferMin: settings.bufferMin,
        durationMin,
        occupied: bookings.map((b) => ({ start: b.startTime, end: b.slotEnd })),
      });
    } else {
      slots = unionStarts(
        staffIds.map((sid) =>
          availability({
            businessHours: settings.businessHours,
            bufferMin: settings.bufferMin,
            durationMin,
            occupied: occupiedFor(bookings, sid),
          }),
        ),
      );
    }
  }

  return { slots, durationMin, bufferMin: settings.bufferMin };
});

/** 予約確定 (§6/§7/§8)。サーバで空きを再検証し、指名なしは空きスタッフを割当。 */
export const createBooking = onCall<{
  tenantId: string;
  accessToken: string;
  customerId: string;
  dogId: string;
  menuId: string;
  date: string;
  startTime: string;
  staffId?: string;
}>(async (request) => {
  const { tenantId, accessToken, customerId, dogId, menuId, date, startTime, staffId } = request.data;
  if (!tenantId || !customerId || !dogId || !menuId || !date || !startTime) {
    throw new HttpsError('invalid-argument', 'missing required fields');
  }
  const { lineUserId } = await verifyLineAccessToken(accessToken);

  // 顧客本人確認: customerId が当該 lineUserId のものか
  const custSnap = await db.collection('tenants').doc(tenantId).collection('customers').doc(customerId).get();
  if (!custSnap.exists || custSnap.data()?.lineUserId !== lineUserId) {
    throw new HttpsError('permission-denied', 'customer does not belong to this LINE user');
  }

  const [settings, menu, confirmed] = await Promise.all([
    loadSettings(tenantId),
    loadMenu(tenantId, menuId),
    loadDogDuration(tenantId, dogId),
  ]);
  const durationMin = effectiveDuration(confirmed, menu);
  const bufferMin = settings.bufferMin;
  const slotEnd = toTimeStr(toMinutes(startTime) + durationMin + bufferMin);

  const bookings = await loadDayBookings(tenantId, date);

  // 割当スタッフを決定し、その視点で startTime が空いているか再検証
  function isFree(sid: string): boolean {
    return availability({
      businessHours: settings.businessHours,
      bufferMin,
      durationMin,
      occupied: occupiedFor(bookings, sid),
    }).includes(startTime);
  }

  let assigned: string | null = null;
  if (staffId) {
    if (!isFree(staffId)) throw new HttpsError('failed-precondition', 'nominated staff is not available');
    assigned = staffId;
  } else {
    const staffIds = await loadActiveStaffIds(tenantId);
    assigned = staffIds.find((sid) => isFree(sid)) ?? null;
    if (staffIds.length > 0 && assigned == null) {
      throw new HttpsError('failed-precondition', 'no staff available at this time');
    }
  }

  const ref = await db
    .collection('tenants')
    .doc(tenantId)
    .collection('bookings')
    .add({
      dogId,
      customerId,
      menuId,
      staffId: assigned,
      date,
      startTime,
      durationMin,
      bufferMin,
      slotEnd,
      status: 'reserved',
      createdAt: FieldValue.serverTimestamp(),
    });

  return { bookingId: ref.id, staffId: assigned, slotEnd };
});

/** customerId が当該 LINE ユーザのものか検証する共通ガード。 */
async function assertCustomerOwnership(tenantId: string, customerId: string, lineUserId: string) {
  const snap = await db.collection('tenants').doc(tenantId).collection('customers').doc(customerId).get();
  if (!snap.exists || snap.data()?.lineUserId !== lineUserId) {
    throw new HttpsError('permission-denied', 'customer does not belong to this LINE user');
  }
}

/** 予約画面の選択肢（メニュー・指名候補スタッフ・自分の犬）を一括取得。 */
export const getBookingOptions = onCall<{ tenantId: string; accessToken: string; customerId: string }>(
  async (request) => {
    const { tenantId, accessToken, customerId } = request.data;
    if (!tenantId || !customerId) throw new HttpsError('invalid-argument', 'tenantId, customerId required');
    const { lineUserId } = await verifyLineAccessToken(accessToken);
    await assertCustomerOwnership(tenantId, customerId, lineUserId);

    const base = db.collection('tenants').doc(tenantId);
    const [menusSnap, staffSnap, dogsSnap] = await Promise.all([
      base.collection('menus').where('active', '==', true).get(),
      base.collection('staff').where('active', '==', true).get(),
      base.collection('dogs').where('customerId', '==', customerId).get(),
    ]);

    return {
      menus: menusSnap.docs.map((d) => {
        const m = d.data();
        return {
          id: d.id,
          name: m.name,
          defaultDurationMin: m.defaultDurationMin,
          fixedDuration: m.fixedDuration,
          price: m.price,
        };
      }),
      staff: staffSnap.docs.map((d) => ({ id: d.id, name: d.data().name })),
      dogs: dogsSnap.docs.map((d) => ({
        id: d.id,
        name: d.data().name,
        confirmedDurationMin: (d.data().confirmedDurationMin ?? null) as number | null,
      })),
    };
  },
);

/** 顧客が自分の犬を登録 (§7 初回は confirmedDurationMin=null)。 */
export const registerDog = onCall<{
  tenantId: string;
  accessToken: string;
  customerId: string;
  name: string;
  breed?: string;
}>(async (request) => {
  const { tenantId, accessToken, customerId, name, breed } = request.data;
  if (!tenantId || !customerId || !name?.trim()) {
    throw new HttpsError('invalid-argument', 'tenantId, customerId, name required');
  }
  const { lineUserId } = await verifyLineAccessToken(accessToken);
  await assertCustomerOwnership(tenantId, customerId, lineUserId);

  const ref = await db
    .collection('tenants')
    .doc(tenantId)
    .collection('dogs')
    .add({
      customerId,
      name: name.trim(),
      breed: breed?.trim() || null,
      confirmedDurationMin: null,
    });
  return { dogId: ref.id };
});

// ===== M4: 施術完了 (§7) と 中央台帳イベント連携 (§10) =====

/**
 * 施術完了 (§7)。スタッフ(admin/trimmer)が確定作業時間・確定料金を入力。
 * トランザクションで: booking を done に / records に追記 / dog の確定値を更新。
 * record id = bookingId とし、再実行に対して冪等。
 */
export const completeBooking = onCall<{
  tenantId: string;
  bookingId: string;
  finalDurationMin: number;
  finalPrice: number;
  notes?: string;
}>(async (request) => {
  const caller = request.auth?.token;
  const { tenantId, bookingId, finalDurationMin, finalPrice, notes } = request.data;
  if (!tenantId || !bookingId || !(finalDurationMin > 0) || !(finalPrice >= 0)) {
    throw new HttpsError('invalid-argument', 'tenantId, bookingId, finalDurationMin, finalPrice required');
  }
  const isSuper = caller?.superAdmin === true;
  const isStaff = caller?.tenantId === tenantId && (caller?.role === 'admin' || caller?.role === 'trimmer');
  if (!isSuper && !isStaff) throw new HttpsError('permission-denied', 'tenant staff only');

  const base = db.collection('tenants').doc(tenantId);
  const bookingRef = base.collection('bookings').doc(bookingId);

  await db.runTransaction(async (tx) => {
    const bookingSnap = await tx.get(bookingRef);
    if (!bookingSnap.exists) throw new HttpsError('not-found', 'booking not found');
    const booking = bookingSnap.data() as {
      dogId: string;
      menuId: string;
      staffId: string | null;
      date: string;
      status: string;
    };
    if (booking.status === 'canceled') throw new HttpsError('failed-precondition', 'booking is canceled');

    const dogRef = base.collection('dogs').doc(booking.dogId);
    const recordRef = dogRef.collection('records').doc(bookingId);
    const nowIso = new Date().toISOString();

    tx.update(bookingRef, { status: 'done', finalDurationMin, finalPrice });
    tx.set(recordRef, {
      bookingId,
      date: booking.date,
      menuId: booking.menuId,
      staffId: booking.staffId ?? '',
      durationMin: finalDurationMin,
      price: finalPrice,
      ...(notes ? { notes } : {}),
    });
    // §7: 次回予約に自動適用される確定値を更新
    tx.update(dogRef, {
      confirmedDurationMin: finalDurationMin,
      confirmedPrice: finalPrice,
      lastServiceAt: nowIso,
    });
  });

  return { bookingId, status: 'done' };
});

/** イベントをアウトボックスに書き、可能なら配信して状態を更新する。 */
async function persistAndDeliver(
  eventRef: DocumentReference,
  payload: ReturnType<typeof buildPointEvent>,
): Promise<void> {
  // bookingId をドキュメント ID にしているため、create で重複生成を防ぐ（冪等 §11）
  try {
    await eventRef.create({ ...payload, status: 'pending' as PointEventStatus, attempts: 0, createdAt: FieldValue.serverTimestamp() });
  } catch {
    return; // 既に生成済み（トリガの at-least-once 再発火）
  }
  await tryDeliver(eventRef, payload);
}

async function tryDeliver(
  eventRef: DocumentReference,
  payload: ReturnType<typeof buildPointEvent>,
): Promise<void> {
  try {
    const sent = await deliverPointEvent(payload);
    if (sent) {
      await eventRef.update({ status: 'sent', deliveredAt: FieldValue.serverTimestamp(), attempts: FieldValue.increment(1) });
    } else {
      // Webhook 未設定: pending のまま貯める（CRM 完成後にリトライで配信）
      await eventRef.update({ attempts: FieldValue.increment(1) });
    }
  } catch (e) {
    logger.warn('point event delivery failed', { bookingId: payload.bookingId, error: String(e) });
    await eventRef.update({ status: 'failed', attempts: FieldValue.increment(1) });
  }
}

/**
 * booking が done かつ finalPrice 確定になった時に §10 イベントを生成・配信。
 * Firestore トリガは at-least-once のため、bookingId キーで冪等化。
 */
export const onBookingDone = onDocumentUpdated('tenants/{tenantId}/bookings/{bookingId}', async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!after) return;
  const becameDone = before?.status !== 'done' && after.status === 'done';
  if (!becameDone || after.finalPrice == null) return;

  const { tenantId, bookingId } = event.params;
  const base = db.collection('tenants').doc(tenantId);

  const [tenantSnap, custSnap] = await Promise.all([
    base.get(),
    base.collection('customers').doc(after.customerId).get(),
  ]);
  const brand = (tenantSnap.data()?.name as string) ?? tenantId;
  const cust = custSnap.data() ?? {};

  const payload = buildPointEvent({
    bookingId,
    tenantId,
    brand,
    amount: after.finalPrice as number,
    at: new Date().toISOString(),
    memberId: (cust.memberId ?? null) as string | null,
    lineUserId: (cust.lineUserId ?? null) as string | null,
  });

  await persistAndDeliver(base.collection('pointEvents').doc(bookingId), payload);
});

/** pending/failed のイベントを定期再送（§11 リトライ）。CRM 完成後の取りこぼし回収にも使う。 */
export const retryPointEvents = onSchedule('every 30 minutes', async () => {
  const MAX_ATTEMPTS = 24;
  const snap = await db
    .collectionGroup('pointEvents')
    .where('status', 'in', ['pending', 'failed'])
    .limit(100)
    .get();

  for (const doc of snap.docs) {
    const data = doc.data();
    if ((data.attempts ?? 0) >= MAX_ATTEMPTS) continue;
    const { status: _status, attempts: _a, createdAt: _c, deliveredAt: _d, ...payload } = data;
    await tryDeliver(doc.ref, payload as ReturnType<typeof buildPointEvent>);
  }
});
