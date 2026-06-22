// Cloud Functions (M1): テナント発行とスタッフ権限付与。
// 認証は custom claims に基づく (§2)。
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue, type DocumentReference } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger, setGlobalOptions } from 'firebase-functions/v2';
import { defineInt } from 'firebase-functions/params';
import { resolveLink, type CustomerIdentifiers } from './findOrLink.js';
import { verifyLineAccessToken, pushLineMessage } from './line.js';
import { availability, toMinutes, toTimeStr, unionStarts } from './slots.js';
import { buildPointEvent, deliverPointEvent, type PointEventStatus } from './crm.js';
import { buildConfirmationMessage, buildReminderMessage, tomorrowInTimeZone } from './reminders.js';
import { isCancellableNow, mergeIdentifiers, type Identifiers } from './policy.js';

initializeApp();
// 全関数を東京リージョンに（Firestore も asia-northeast1）。クライアント(日本)→関数、
// 関数→Firestore の往復レイテンシを削減（旧 us-central1 では太平洋往復が積み重なっていた）。
setGlobalOptions({ region: 'asia-northeast1' });
const db = getFirestore();
const auth = getAuth();

type StaffRole = 'admin' | 'trimmer';

// 顧客フローの要関数のウォーム維持台数。deploy 時に .env.<projectId> の MIN_INSTANCES から解決。
// prod のみ 1（.env.groomhaus-prod）、dev は default 0（無料）。
const minInstancesParam = defineInt('MIN_INSTANCES', { default: 0 });

const DEFAULT_SETTINGS = {
  timezone: 'Asia/Tokyo',
  businessHours: [{ start: '09:00', end: '19:00' }],
  bufferMin: 10,
  workTimeOptions: [50, 80, 110],
  cancelDeadlineHours: 24, // §11 キャンセル締切（既定: 前日同時刻）
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

interface BusinessHours {
  start: string;
  end: string;
}
interface SettingsLike {
  businessHours: BusinessHours[];
  bufferMin: number;
  timezone: string;
  cancelDeadlineHours: number;
  bookingCutoffHours: number;
}

/** メッセージ文面に使う店舗情報（settings に保持・任意）。 */
interface StoreSettings {
  address?: string;
  mapUrl?: string;
  phone?: string;
  cancelDeadlineHours?: number;
}

async function loadSettings(tenantId: string): Promise<SettingsLike> {
  const snap = await db.collection('tenants').doc(tenantId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'tenant not found');
  const s = (snap.data()?.settings ?? {}) as Partial<SettingsLike>;
  return {
    businessHours: s.businessHours ?? [],
    bufferMin: s.bufferMin ?? 0,
    timezone: s.timezone ?? 'Asia/Tokyo',
    cancelDeadlineHours: s.cancelDeadlineHours ?? 24,
    bookingCutoffHours: s.bookingCutoffHours ?? 0,
  };
}

/** タイムゾーンの現在時刻を「壁時計をUTCに見立てた」比較用ミリ秒で返す（同一tz同士の比較に使う）。 */
function tzNowWallMs(tz: string): number {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? '0' : p.hour), +p.minute);
}
function slotWallMs(date: string, hhmm: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm);
}
/** 受付締切＋過去時刻の除外。slot は date(YYYY-MM-DD) の HH:MM。 */
function afterCutoff(date: string, hhmm: string, settings: SettingsLike): boolean {
  const threshold = tzNowWallMs(settings.timezone) + settings.bookingCutoffHours * 3600_000;
  return slotWallMs(date, hhmm) >= threshold;
}

/** その日が臨時休業/祝日で終日クローズか (§11 営業時間の例外)。 */
async function isClosedDate(tenantId: string, date: string): Promise<boolean> {
  const snap = await db.collection('tenants').doc(tenantId).collection('closures').doc(date).get();
  return snap.exists && snap.data()?.fullDay !== false;
}

const DEFAULT_DURATION_MIN = 60;

interface DogInfo {
  breedId: string | null;
  customerId: string | null;
  /** サービスごとの個別加算時間（分）。{ [serviceId]: 加算分 } */
  serviceAdjustments: Record<string, number>;
  optionAdjustments: Record<string, number>;
  name: string;
}
async function loadDog(tenantId: string, dogId?: string): Promise<DogInfo | null> {
  if (!dogId) return null;
  const snap = await db.collection('tenants').doc(tenantId).collection('dogs').doc(dogId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'dog not found');
  const d = snap.data() ?? {};
  return {
    breedId: (d.breedId ?? null) as string | null,
    customerId: (d.customerId ?? null) as string | null,
    serviceAdjustments: (d.serviceAdjustments ?? {}) as Record<string, number>,
    optionAdjustments: (d.optionAdjustments ?? {}) as Record<string, number>,
    name: (d.name as string) ?? 'ワンちゃん',
  };
}

/** 50円単位で切り上げ。 */
const ceil50 = (n: number) => Math.ceil(n / 50) * 50;

/**
 * 「標準（時間・料金）＋ 個別追加時間」の実効値。
 * 追加料金 = 単価(標準料金 ÷ 標準時間) × 個別追加時間 を 50円切上げ。
 */
function effectiveItem(
  stdDurationMin: number,
  stdPrice: number | null,
  addMin: number,
): { durationMin: number; price: number | null } {
  const unit = stdPrice != null && stdDurationMin > 0 ? stdPrice / stdDurationMin : 0;
  const addCharge = ceil50(unit * addMin);
  return {
    durationMin: stdDurationMin + addMin,
    price: stdPrice == null ? null : stdPrice + addCharge,
  };
}

interface OptionSnapshot {
  id: string;
  name: string;
  price: number;
  durationMin: number;
}
/**
 * オプションマスタ(options)から選択分を取り出し、時間・料金を合計する。
 * 各オプションの実効値 = 「マスタ時間/料金 + 犬ごとの個別追加時間(optionAdjustments)」。
 * 個別追加時間ぶんの料金は 単価(料金÷時間)×追加分 を50円切上げで加算。
 */
async function loadSelectedOptions(
  tenantId: string,
  optionIds: string[] | undefined,
  adjustments: Record<string, number>,
): Promise<{ options: OptionSnapshot[]; durationMin: number; price: number }> {
  if (!optionIds || optionIds.length === 0) return { options: [], durationMin: 0, price: 0 };
  const snaps = await Promise.all(
    optionIds.map((id) => db.collection('tenants').doc(tenantId).collection('options').doc(id).get()),
  );
  const picked: OptionSnapshot[] = snaps
    .filter((s) => s.exists)
    .map((s) => {
      const o = s.data() ?? {};
      const eff = effectiveItem((o.durationMin ?? 0) as number, (o.price ?? 0) as number, adjustments[s.id] ?? 0);
      return { id: s.id, name: (o.name ?? '') as string, price: eff.price ?? 0, durationMin: eff.durationMin };
    });
  return {
    options: picked,
    durationMin: picked.reduce((s, o) => s + o.durationMin, 0),
    price: picked.reduce((s, o) => s + o.price, 0),
  };
}

interface PriceCell {
  price: number;
  durationMin: number;
}
/** 料金表セル（犬種×サービス）。未登録は null。 */
async function loadPriceCell(tenantId: string, breedId: string | null, serviceId: string): Promise<PriceCell | null> {
  if (!breedId) return null;
  const snap = await db
    .collection('tenants')
    .doc(tenantId)
    .collection('pricing')
    .doc(`${breedId}__${serviceId}`)
    .get();
  if (!snap.exists) return null;
  const p = snap.data() ?? {};
  return { price: (p.price ?? 0) as number, durationMin: (p.durationMin ?? DEFAULT_DURATION_MIN) as number };
}

/**
 * 基準（犬種×サービス）の実効値。
 * 標準時間/料金は料金表セル（無ければ既定時間・料金なし）。これに犬の個別加算時間を上乗せし、
 * 個別加算ぶんの料金は 単価(セル料金÷セル時間)×加算分 を50円切上げで加算する。
 */
function effectiveBase(
  dog: DogInfo | null,
  cell: PriceCell | null,
  serviceId: string,
): { durationMin: number; price: number | null } {
  const stdDuration = cell?.durationMin ?? DEFAULT_DURATION_MIN;
  const stdPrice = cell?.price ?? null;
  const addMin = dog?.serviceAdjustments?.[serviceId] ?? 0;
  return effectiveItem(stdDuration, stdPrice, addMin);
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
}>({ minInstances: minInstancesParam }, async (request) => {
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
  const needsPhone = !finalPhone;
  // 起動時の往復削減 (B): 電話登録済みなら予約オプションも同梱して返す（追加の getBookingOptions 呼び出しを省く）
  const options = needsPhone ? null : await fetchBookingOptions(tenantId, customerId);
  // 店舗情報（登録画面でもロゴ表示できるよう常に返す）
  const tSnap = await db.collection('tenants').doc(tenantId).get();
  const store = {
    name: (tSnap.data()?.name ?? '') as string,
    logoUrl: (tSnap.data()?.settings?.logoUrl ?? null) as string | null,
  };
  // 「このLINEユーザーが使った店」をインデックス化（リッチメニューの店選択/直近店に使用）
  await upsertUserTenant(lineUserId, tenantId, store.name, store.logoUrl);
  return { customerId, lineUserId, needsPhone, options, store };
});

/**
 * lineUsers/{lineUserId}/tenants/{tenantId} に「利用した店」を記録（マージ）。
 * テナント横断のため top-level コレクション。クライアント直読み不可（callable 経由のみ）。
 */
async function upsertUserTenant(lineUserId: string, tenantId: string, name: string, logoUrl: string | null) {
  await db
    .collection('lineUsers')
    .doc(lineUserId)
    .collection('tenants')
    .doc(tenantId)
    .set({ tenantId, name, logoUrl, lastUsedAt: FieldValue.serverTimestamp() }, { merge: true });
}

/** このLINEユーザーが利用した店の一覧（最終利用が新しい順）。リッチメニューの店選択に使用。 */
export const getMyTenants = onCall<{ accessToken: string }>({ minInstances: minInstancesParam }, async (request) => {
  const { accessToken } = request.data;
  const { lineUserId } = await verifyLineAccessToken(accessToken);
  const snap = await db.collection('lineUsers').doc(lineUserId).collection('tenants').get();
  const tenants = snap.docs
    .map((d) => {
      const x = d.data();
      return {
        tenantId: d.id,
        name: (x.name ?? '') as string,
        logoUrl: (x.logoUrl ?? null) as string | null,
        lastUsedAt: (x.lastUsedAt?.toMillis?.() ?? 0) as number,
      };
    })
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .map((t) => ({ tenantId: t.tenantId, name: t.name, logoUrl: t.logoUrl }));
  return { tenants };
});

/** 店選択リストから1店を外す（自分のリストから削除。店舗側の予約/カルテは残す）。 */
export const removeMyTenant = onCall<{ accessToken: string; tenantId: string }>(
  { minInstances: minInstancesParam },
  async (request) => {
    const { accessToken, tenantId } = request.data;
    if (!tenantId) throw new HttpsError('invalid-argument', 'tenantId required');
    const { lineUserId } = await verifyLineAccessToken(accessToken);
    await db.collection('lineUsers').doc(lineUserId).collection('tenants').doc(tenantId).delete();
    return { ok: true };
  },
);

/** 空きスロット取得 (§6 + §8 指名スコープ)。所要時間は犬種×サービスの料金表セルから。 */
export const getAvailability = onCall<{
  tenantId: string;
  accessToken: string;
  date: string;
  serviceId: string;
  dogId?: string;
  staffId?: string;
  optionIds?: string[];
}>({ minInstances: minInstancesParam }, async (request) => {
  const { tenantId, accessToken, date, serviceId, dogId, staffId, optionIds } = request.data;
  if (!tenantId || !date || !serviceId) throw new HttpsError('invalid-argument', 'tenantId, date, serviceId required');
  await verifyLineAccessToken(accessToken); // 顧客認証ゲート

  const [settings, dog] = await Promise.all([loadSettings(tenantId), loadDog(tenantId, dogId)]);
  const opts = await loadSelectedOptions(tenantId, optionIds, dog?.optionAdjustments ?? {});
  const cell = await loadPriceCell(tenantId, dog?.breedId ?? null, serviceId);
  // トータル時間 = 基準(料金表セル + 犬のサービス別個別加算) + オプション（個別追加込み）
  const base = effectiveBase(dog, cell, serviceId);
  const durationMin = base.durationMin + opts.durationMin;
  const price = base.price == null && opts.price === 0 ? null : (base.price ?? 0) + opts.price;

  // 臨時休業/祝日は空きなし (§11)
  if (await isClosedDate(tenantId, date)) {
    return { slots: [], durationMin, bufferMin: settings.bufferMin, price, businessHours: settings.businessHours, closed: true };
  }

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

  return { slots, durationMin, bufferMin: settings.bufferMin, price, businessHours: settings.businessHours };
});

/** 予約確定 (§6/§7/§8)。サーバで空きを再検証し、指名なしは空きスタッフを割当。 */
export const createBooking = onCall<{
  tenantId: string;
  accessToken: string;
  customerId: string;
  dogId: string;
  serviceId: string;
  date: string;
  startTime: string;
  staffId?: string;
  optionIds?: string[];
}>({ minInstances: minInstancesParam }, async (request) => {
  const { tenantId, accessToken, customerId, dogId, serviceId, date, startTime, staffId, optionIds } = request.data;
  if (!tenantId || !customerId || !dogId || !serviceId || !date || !startTime) {
    throw new HttpsError('invalid-argument', 'missing required fields');
  }
  const { lineUserId } = await verifyLineAccessToken(accessToken);

  // 顧客本人確認: customerId が当該 lineUserId のものか
  const custSnap = await db.collection('tenants').doc(tenantId).collection('customers').doc(customerId).get();
  if (!custSnap.exists || custSnap.data()?.lineUserId !== lineUserId) {
    throw new HttpsError('permission-denied', 'customer does not belong to this LINE user');
  }

  if (await isClosedDate(tenantId, date)) {
    throw new HttpsError('failed-precondition', 'the salon is closed on this date');
  }

  const [settings, dog] = await Promise.all([loadSettings(tenantId), loadDog(tenantId, dogId)]);
  const opts = await loadSelectedOptions(tenantId, optionIds, dog?.optionAdjustments ?? {});
  const cell = await loadPriceCell(tenantId, dog?.breedId ?? null, serviceId);
  // トータル時間 = 基準(料金表セル + 犬のサービス別個別加算) + オプション（個別追加込み）
  const durationMin = effectiveBase(dog, cell, serviceId).durationMin + opts.durationMin;
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
      serviceId,
      optionIds: optionIds ?? [],
      options: opts.options,
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

// ===== 複数頭まとめ予約（カート）: 同じ担当が連続で施術する v1（連続ブロック） =====

interface GroupItemInput {
  dogId: string;
  serviceId: string;
  optionIds?: string[];
}
interface ComputedGroupItem {
  dogId: string;
  serviceId: string;
  optionIds: string[];
  durationMin: number;
  price: number | null;
  options: OptionSnapshot[];
}
/** カート各項目の所要時間・料金・オプションスナップショットを算出（getAvailability と同じ規則）。 */
async function computeGroupItems(tenantId: string, items: GroupItemInput[]): Promise<ComputedGroupItem[]> {
  return Promise.all(
    items.map(async (it) => {
      const dog = await loadDog(tenantId, it.dogId);
      const opts = await loadSelectedOptions(tenantId, it.optionIds, dog?.optionAdjustments ?? {});
      // serviceId 空 = メニュー無し（単体オプション）予約。基準は 0、合計はオプションのみ。
      const base = it.serviceId
        ? effectiveBase(dog, await loadPriceCell(tenantId, dog?.breedId ?? null, it.serviceId), it.serviceId)
        : { durationMin: 0, price: 0 };
      return {
        dogId: it.dogId,
        serviceId: it.serviceId,
        optionIds: it.optionIds ?? [],
        durationMin: base.durationMin + opts.durationMin,
        price: base.price == null ? null : base.price + opts.price,
        options: opts.options,
      };
    }),
  );
}

/** 複数頭の合計時間で空きを返す。指名ありはその担当、なしは全担当の和集合（1人が合計時間ぶん連続で空いている枠）。 */
export const getGroupAvailability = onCall<{
  tenantId: string;
  accessToken: string;
  date: string;
  items: GroupItemInput[];
  staffId?: string;
}>({ minInstances: minInstancesParam }, async (request) => {
  const { tenantId, accessToken, date, items, staffId } = request.data;
  if (!tenantId || !date || !items?.length) throw new HttpsError('invalid-argument', 'tenantId, date, items required');
  await verifyLineAccessToken(accessToken); // 顧客認証ゲート

  const settings = await loadSettings(tenantId);
  const computed = await computeGroupItems(tenantId, items);
  const durationMin = computed.reduce((s, c) => s + c.durationMin, 0);
  const price = computed.some((c) => c.price == null) ? null : computed.reduce((s, c) => s + (c.price ?? 0), 0);

  if (await isClosedDate(tenantId, date)) {
    return { slots: [], durationMin, bufferMin: settings.bufferMin, price, businessHours: settings.businessHours, closed: true };
  }

  const bookings = await loadDayBookings(tenantId, date);
  let slots: string[];
  if (staffId) {
    slots = availability({
      businessHours: settings.businessHours,
      bufferMin: settings.bufferMin,
      durationMin,
      occupied: occupiedFor(bookings, staffId),
    });
  } else {
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

  // 受付締切＋過去時刻を除外（その日が今日のときに効く）
  slots = slots.filter((s) => afterCutoff(date, s, settings));

  return { slots, durationMin, bufferMin: settings.bufferMin, price, businessHours: settings.businessHours };
});

/** 複数頭をまとめて確定。同じ担当が startTime から連続で施術し、頭数ぶんの予約を groupId で束ねて作成。 */
export const createGroupBooking = onCall<{
  tenantId: string;
  accessToken: string;
  customerId: string;
  date: string;
  startTime: string;
  items: GroupItemInput[];
  staffId?: string;
}>({ minInstances: minInstancesParam }, async (request) => {
  const { tenantId, accessToken, customerId, date, startTime, items, staffId } = request.data;
  if (!tenantId || !customerId || !date || !startTime || !items?.length) {
    throw new HttpsError('invalid-argument', 'missing required fields');
  }
  const { lineUserId } = await verifyLineAccessToken(accessToken);
  await assertCustomerOwnership(tenantId, customerId, lineUserId);

  if (await isClosedDate(tenantId, date)) {
    throw new HttpsError('failed-precondition', 'the salon is closed on this date');
  }

  const settings = await loadSettings(tenantId);
  if (!afterCutoff(date, startTime, settings)) {
    throw new HttpsError('failed-precondition', 'past the booking cutoff');
  }
  const computed = await computeGroupItems(tenantId, items);
  const totalDuration = computed.reduce((s, c) => s + c.durationMin, 0);
  const bufferMin = settings.bufferMin;
  const bookings = await loadDayBookings(tenantId, date);

  // 合計時間ぶん連続で空いている担当を確定（指名ありはその担当のみ）
  function isFree(sid: string): boolean {
    return availability({
      businessHours: settings.businessHours,
      bufferMin,
      durationMin: totalDuration,
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

  const bookingsRef = db.collection('tenants').doc(tenantId).collection('bookings');
  const groupId = bookingsRef.doc().id;
  let cursor = toMinutes(startTime);
  const bookingIds: string[] = [];
  for (let i = 0; i < computed.length; i++) {
    const c = computed[i];
    const isLast = i === computed.length - 1;
    const bBuffer = isLast ? bufferMin : 0; // 占有はブロック末尾にだけバッファを足す
    const bStart = toTimeStr(cursor);
    const slotEnd = toTimeStr(cursor + c.durationMin + bBuffer);
    const ref = await bookingsRef.add({
      dogId: c.dogId,
      customerId,
      serviceId: c.serviceId,
      optionIds: c.optionIds,
      options: c.options,
      groupId,
      staffId: assigned,
      date,
      startTime: bStart,
      durationMin: c.durationMin,
      bufferMin: bBuffer,
      slotEnd,
      status: 'reserved',
      createdAt: FieldValue.serverTimestamp(),
      // 確認メッセージは先頭の1件のみ送信（2件目以降は送信済み扱いで抑止）
      ...(i > 0 ? { confirmationSentAt: FieldValue.serverTimestamp() } : {}),
    });
    bookingIds.push(ref.id);
    cursor += c.durationMin;
  }

  const slotEnd = toTimeStr(toMinutes(startTime) + totalDuration + bufferMin);
  return { bookingIds, groupId, staffId: assigned, slotEnd, startTime, durationMin: totalDuration };
});

/** スタッフ（管理者/トリマー）による予約作成。LINE トークン不要・Firebase Auth で認可。 */
export const createBookingByStaff = onCall<{
  tenantId: string;
  dogId: string;
  serviceId: string;
  date: string;
  startTime: string;
  staffId?: string;
  optionIds?: string[];
}>(async (request) => {
  const { tenantId, dogId, serviceId, date, startTime, staffId, optionIds } = request.data;
  if (!tenantId || !dogId || !serviceId || !date || !startTime) {
    throw new HttpsError('invalid-argument', 'missing required fields');
  }
  const caller = request.auth?.token;
  const isSuper = caller?.superAdmin === true;
  const isStaff = caller?.tenantId === tenantId && (caller?.role === 'admin' || caller?.role === 'trimmer');
  if (!isSuper && !isStaff) throw new HttpsError('permission-denied', 'tenant staff only');

  if (await isClosedDate(tenantId, date)) {
    throw new HttpsError('failed-precondition', 'the salon is closed on this date');
  }

  const [settings, dog] = await Promise.all([loadSettings(tenantId), loadDog(tenantId, dogId)]);
  if (!dog) throw new HttpsError('not-found', 'dog not found');
  const opts = await loadSelectedOptions(tenantId, optionIds, dog.optionAdjustments);
  const cell = await loadPriceCell(tenantId, dog.breedId, serviceId);
  const durationMin = effectiveBase(dog, cell, serviceId).durationMin + opts.durationMin;
  const bufferMin = settings.bufferMin;
  const slotEnd = toTimeStr(toMinutes(startTime) + durationMin + bufferMin);

  const bookings = await loadDayBookings(tenantId, date);
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
      customerId: dog.customerId,
      serviceId,
      optionIds: optionIds ?? [],
      options: opts.options,
      staffId: assigned,
      date,
      startTime,
      durationMin,
      bufferMin,
      slotEnd,
      status: 'reserved',
      createdAt: FieldValue.serverTimestamp(),
    });

  return { bookingId: ref.id, staffId: assigned, slotEnd, durationMin };
});

/** customerId が当該 LINE ユーザのものか検証する共通ガード。 */
async function assertCustomerOwnership(tenantId: string, customerId: string, lineUserId: string) {
  const snap = await db.collection('tenants').doc(tenantId).collection('customers').doc(customerId).get();
  if (!snap.exists || snap.data()?.lineUserId !== lineUserId) {
    throw new HttpsError('permission-denied', 'customer does not belong to this LINE user');
  }
}

/** 予約画面の選択肢（サービス・犬種・指名候補スタッフ・自分の犬・料金表）。customerSession でも再利用。 */
async function fetchBookingOptions(tenantId: string, customerId: string) {
  const base = db.collection('tenants').doc(tenantId);
  const [tenantSnap, servicesSnap, optionsSnap, breedsSnap, staffSnap, dogsSnap, pricingSnap] = await Promise.all([
    base.get(),
    base.collection('services').where('active', '==', true).get(),
    base.collection('options').where('active', '==', true).get(),
    base.collection('breeds').where('active', '==', true).get(),
    base.collection('staff').where('active', '==', true).get(),
    base.collection('dogs').where('customerId', '==', customerId).get(),
    base.collection('pricing').get(),
  ]);
  const tdata = tenantSnap.data() ?? {};
  return {
    store: {
      name: (tdata.name ?? '') as string,
      logoUrl: (tdata.settings?.logoUrl ?? null) as string | null,
    },
    services: servicesSnap.docs.map((d) => ({ id: d.id, name: d.data().name })),
    options: optionsSnap.docs.map((d) => ({
      id: d.id,
      name: d.data().name as string,
      price: (d.data().price ?? 0) as number,
      durationMin: (d.data().durationMin ?? 0) as number,
      standalone: (d.data().standalone ?? false) as boolean,
    })),
    breeds: breedsSnap.docs.map((d) => ({ id: d.id, name: d.data().name })),
    staff: staffSnap.docs.map((d) => ({ id: d.id, name: d.data().name })),
    dogs: dogsSnap.docs.map((d) => ({
      id: d.id,
      name: d.data().name,
      breedId: (d.data().breedId ?? null) as string | null,
      serviceAdjustments: (d.data().serviceAdjustments ?? {}) as Record<string, number>,
      optionAdjustments: (d.data().optionAdjustments ?? {}) as Record<string, number>,
    })),
    // 料金表: breedId×serviceId → {price, durationMin}。クライアントで金額表示に使う。
    pricing: pricingSnap.docs.map((d) => {
      const p = d.data();
      return {
        breedId: p.breedId as string,
        serviceId: p.serviceId as string,
        price: (p.price ?? 0) as number,
        durationMin: (p.durationMin ?? 0) as number,
      };
    }),
  };
}

/** 予約画面の選択肢を取得（犬の登録後などの再取得用）。 */
export const getBookingOptions = onCall<{ tenantId: string; accessToken: string; customerId: string }>(
  async (request) => {
    const { tenantId, accessToken, customerId } = request.data;
    if (!tenantId || !customerId) throw new HttpsError('invalid-argument', 'tenantId, customerId required');
    const { lineUserId } = await verifyLineAccessToken(accessToken);
    await assertCustomerOwnership(tenantId, customerId, lineUserId);
    return fetchBookingOptions(tenantId, customerId);
  },
);

/** 休業日の一覧（顧客カレンダー表示用）。指定範囲 [from, to] の終日休業の日付を返す。 */
export const getClosedDates = onCall<{ tenantId: string; accessToken: string; from: string; to: string }>(
  async (request) => {
    const { tenantId, accessToken, from, to } = request.data;
    if (!tenantId || !from || !to) throw new HttpsError('invalid-argument', 'tenantId, from, to required');
    await verifyLineAccessToken(accessToken); // 顧客認証ゲート
    const snap = await db.collection('tenants').doc(tenantId).collection('closures').get();
    const dates = snap.docs
      .filter((d) => d.id >= from && d.id <= to && d.data()?.fullDay !== false)
      .map((d) => d.id);
    return { dates };
  },
);

/** 顧客が自分の犬を登録 (§7 初回は confirmedDurationMin=null)。 */
export const registerDog = onCall<{
  tenantId: string;
  accessToken: string;
  customerId: string;
  name: string;
  breedId?: string;
}>(async (request) => {
  const { tenantId, accessToken, customerId, name, breedId } = request.data;
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
      breedId: breedId || null,
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
      serviceId: string;
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
      serviceId: booking.serviceId ?? '',
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

// ===== M5: 前日リマインド (§9) =====

/** テナントの Messaging API チャネルアクセストークンを解決。 */
function reminderChannelToken(lineConfig: Record<string, unknown> | undefined): string | null {
  const fromTenant = (lineConfig?.messagingChannelAccessToken as string) || null;
  return fromTenant ?? process.env.LINE_CHANNEL_ACCESS_TOKEN ?? null;
}

/**
 * 指定テナント・対象日の reserved 予約にリマインドを送る。
 * lineUserId を持つ顧客のみ対象 (§9)。reminderSentAt で冪等化（再実行で二重送信しない）。
 */
async function runReminders(tenantId: string, date: string): Promise<{ sent: number; skipped: number }> {
  const base = db.collection('tenants').doc(tenantId);
  const tenantSnap = await base.get();
  const tenant = tenantSnap.data();
  if (!tenant || tenant.status !== 'active') return { sent: 0, skipped: 0 };

  const tenantName = (tenant.name as string) ?? tenantId;
  const token = reminderChannelToken(tenant.lineConfig);
  const s = (tenant.settings ?? {}) as StoreSettings;

  const bookings = await base.collection('bookings').where('date', '==', date).get();
  let sent = 0;
  let skipped = 0;

  for (const bookingDoc of bookings.docs) {
    const b = bookingDoc.data();
    if (b.status !== 'reserved' || b.reminderSentAt) {
      skipped++;
      continue;
    }
    const [custSnap, dogSnap] = await Promise.all([
      base.collection('customers').doc(b.customerId).get(),
      base.collection('dogs').doc(b.dogId).get(),
    ]);
    const lineUserId = custSnap.data()?.lineUserId as string | undefined;
    if (!lineUserId) {
      skipped++; // LINE 未連携は対象外 (§9)
      continue;
    }
    const message = buildReminderMessage({
      tenantName,
      dogName: (dogSnap.data()?.name as string) ?? 'ワンちゃん',
      date,
      startTime: b.startTime as string,
      address: s.address ?? null,
      mapUrl: s.mapUrl ?? null,
      phone: s.phone ?? null,
      cancelDeadlineHours: s.cancelDeadlineHours ?? null,
    });
    const result = await pushLineMessage(token, lineUserId, message);
    if (result === 'sent') {
      await bookingDoc.ref.update({ reminderSentAt: FieldValue.serverTimestamp() });
      sent++;
    } else {
      skipped++;
    }
  }

  logger.info('reminders run', { tenantId, date, sent, skipped });
  return { sent, skipped };
}

/**
 * 前日リマインド (§9)。毎日 18:00 (Asia/Tokyo) に全アクティブテナントの翌日分を送る。
 * 翌日判定は各テナントの settings.timezone に従う。送信時刻は §11 で要調整。
 */
export const sendReminders = onSchedule({ schedule: 'every day 18:00', timeZone: 'Asia/Tokyo' }, async () => {
  const tenants = await db.collection('tenants').where('status', '==', 'active').get();
  for (const t of tenants.docs) {
    const tz = (t.data().settings?.timezone as string) ?? 'Asia/Tokyo';
    const date = tomorrowInTimeZone(new Date(), tz);
    await runReminders(t.id, date);
  }
});

/** リマインドの手動実行（テスト用）。superAdmin または対象テナント admin。 */
export const sendRemindersNow = onCall<{ tenantId: string; date: string }>(async (request) => {
  const caller = request.auth?.token;
  const { tenantId, date } = request.data;
  if (!tenantId || !date) throw new HttpsError('invalid-argument', 'tenantId, date required');
  const ok = caller?.superAdmin === true || (caller?.tenantId === tenantId && caller?.role === 'admin');
  if (!ok) throw new HttpsError('permission-denied', 'superAdmin or tenant admin only');
  return runReminders(tenantId, date);
});

/**
 * 予約成立(作成)時に確認メッセージを送る（リマインドとは別・即時）。
 * lineUserId を持つ顧客のみ。confirmationSentAt で冪等化（トリガ at-least-once 対策）。
 */
export const onBookingCreated = onDocumentCreated('tenants/{tenantId}/bookings/{bookingId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const b = snap.data();
  if (b.status !== 'reserved' || b.confirmationSentAt) return;

  const { tenantId } = event.params;
  const base = db.collection('tenants').doc(tenantId);
  // serviceId 空（単体オプション予約）は services を引かない（doc('') は不正）
  const [tenantSnap, custSnap, dogSnap, serviceSnap] = await Promise.all([
    base.get(),
    base.collection('customers').doc(b.customerId).get(),
    base.collection('dogs').doc(b.dogId).get(),
    b.serviceId ? base.collection('services').doc(b.serviceId).get() : Promise.resolve(null),
  ]);

  const lineUserId = custSnap.data()?.lineUserId as string | undefined;
  if (!lineUserId) return; // LINE 未連携は対象外

  // メニュー名: サービスがあればその名前、無ければオプション名（単体予約）
  const optionNames = Array.isArray(b.options) ? (b.options as { name: string }[]).map((o) => o.name).filter(Boolean) : [];
  const menuName = (serviceSnap?.data()?.name as string) ?? (optionNames.length ? optionNames.join('・') : 'メニュー');

  const token = reminderChannelToken(tenantSnap.data()?.lineConfig);
  const s = (tenantSnap.data()?.settings ?? {}) as StoreSettings;
  const message = buildConfirmationMessage({
    tenantName: (tenantSnap.data()?.name as string) ?? tenantId,
    dogName: (dogSnap.data()?.name as string) ?? 'ワンちゃん',
    menuName,
    date: b.date as string,
    startTime: b.startTime as string,
    slotEnd: b.slotEnd as string,
    address: s.address ?? null,
    mapUrl: s.mapUrl ?? null,
    phone: s.phone ?? null,
    cancelDeadlineHours: s.cancelDeadlineHours ?? null,
  });

  const result = await pushLineMessage(token, lineUserId, message);
  if (result === 'sent') {
    await snap.ref.update({ confirmationSentAt: FieldValue.serverTimestamp() });
  }
  logger.info('booking confirmation', { tenantId, bookingId: event.params.bookingId, result });
});

// ===== M6: キャンセル (§11) / 顧客マージ (§11) =====

/** 顧客が自分の予約をキャンセル (§11)。締切(cancelDeadlineHours)前のみ可。 */
export const cancelBookingByCustomer = onCall<{ tenantId: string; accessToken: string; bookingId: string }>(
  async (request) => {
    const { tenantId, accessToken, bookingId } = request.data;
    if (!tenantId || !bookingId) throw new HttpsError('invalid-argument', 'tenantId, bookingId required');
    const { lineUserId } = await verifyLineAccessToken(accessToken);

    const base = db.collection('tenants').doc(tenantId);
    const bookingRef = base.collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) throw new HttpsError('not-found', 'booking not found');
    const b = bookingSnap.data() as { customerId: string; date: string; startTime: string; status: string };
    if (b.status !== 'reserved') throw new HttpsError('failed-precondition', 'only reserved bookings can be canceled');

    const custSnap = await base.collection('customers').doc(b.customerId).get();
    if (custSnap.data()?.lineUserId !== lineUserId) {
      throw new HttpsError('permission-denied', 'booking does not belong to this LINE user');
    }

    const settings = await loadSettings(tenantId);
    if (!isCancellableNow(Date.now(), b.date, b.startTime, settings.timezone, settings.cancelDeadlineHours)) {
      throw new HttpsError('failed-precondition', `キャンセル期限（${settings.cancelDeadlineHours}時間前）を過ぎています`);
    }

    await bookingRef.update({ status: 'canceled', canceledAt: FieldValue.serverTimestamp() });
    return { bookingId, status: 'canceled' as const };
  },
);

/**
 * 顧客の手動マージ (§11 任意・CRM 完全性向上)。admin/superAdmin のみ。
 * source の識別子で target の欠けを補完し、source の犬・予約を target へ付け替え、
 * source に mergedInto を記録（監査のため削除はしない）。
 */
export const mergeCustomers = onCall<{ tenantId: string; sourceCustomerId: string; targetCustomerId: string }>(
  async (request) => {
    const caller = request.auth?.token;
    const { tenantId, sourceCustomerId, targetCustomerId } = request.data;
    if (!tenantId || !sourceCustomerId || !targetCustomerId || sourceCustomerId === targetCustomerId) {
      throw new HttpsError('invalid-argument', 'distinct tenantId, sourceCustomerId, targetCustomerId required');
    }
    const ok = caller?.superAdmin === true || (caller?.tenantId === tenantId && caller?.role === 'admin');
    if (!ok) throw new HttpsError('permission-denied', 'superAdmin or tenant admin only');

    const base = db.collection('tenants').doc(tenantId);
    const [srcSnap, tgtSnap] = await Promise.all([
      base.collection('customers').doc(sourceCustomerId).get(),
      base.collection('customers').doc(targetCustomerId).get(),
    ]);
    if (!srcSnap.exists || !tgtSnap.exists) throw new HttpsError('not-found', 'customer not found');

    const patch = mergeIdentifiers(tgtSnap.data() as Identifiers, srcSnap.data() as Identifiers);

    const [dogs, bookings] = await Promise.all([
      base.collection('dogs').where('customerId', '==', sourceCustomerId).get(),
      base.collection('bookings').where('customerId', '==', sourceCustomerId).get(),
    ]);

    const batch = db.batch();
    if (Object.keys(patch).length > 0) batch.update(base.collection('customers').doc(targetCustomerId), patch);
    dogs.forEach((d) => batch.update(d.ref, { customerId: targetCustomerId }));
    bookings.forEach((bk) => batch.update(bk.ref, { customerId: targetCustomerId }));
    batch.update(base.collection('customers').doc(sourceCustomerId), {
      mergedInto: targetCustomerId,
      mergedAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();

    return { targetCustomerId, movedDogs: dogs.size, movedBookings: bookings.size, patch };
  },
);
