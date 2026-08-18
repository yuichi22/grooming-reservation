// Cloud Functions (M1): テナント発行とスタッフ権限付与。
// 認証は custom claims に基づく (§2)。
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldPath, FieldValue, type DocumentReference } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger, setGlobalOptions } from 'firebase-functions/v2';
import { defineInt } from 'firebase-functions/params';
import { resolveLink, type CustomerIdentifiers } from './findOrLink.js';
import { verifyLineAccessToken, pushLineMessage, isLineFriend } from './line.js';
import { availability, freeIntervals, packDogs, toMinutes, toTimeStr, unionStarts } from './slots.js';
import { staffHoursFor, type ShiftDay } from './shifts.js';
import { buildPointEvent, deliverPointEvent, crmWebhookSecret, type PointEventStatus } from './crm.js';
import { buildCheckoutRequest, checkoutRequestId, deliverCheckoutRequest } from './posCheckout.js';
import { buildConfirmationMessage, buildReminderMessage, tomorrowInTimeZone } from './reminders.js';
import { isCancellableNow, mergeIdentifiers, type Identifiers } from './policy.js';

// provisioning.ts 側の自衛初期化と共存するためガード（ESMのimport評価順対策）
if (!getApps().length) initializeApp();
// 全関数を東京リージョンに（Firestore も asia-northeast1）。クライアント(日本)→関数、
// 関数→Firestore の往復レイテンシを削減（旧 us-central1 では太平洋往復が積み重なっていた）。
setGlobalOptions({ region: 'asia-northeast1' });
const db = getFirestore();
const auth = getAuth();

type StaffRole = 'admin' | 'admin_trimmer' | 'trimmer';
const VALID_ROLES: StaffRole[] = ['admin', 'admin_trimmer', 'trimmer'];
/** 管理者権限を持つロール（管理者・管理者兼トリマー） */
const isAdminRole = (r: unknown): boolean => r === 'admin' || r === 'admin_trimmer';
/** テナント所属スタッフのロール（管理者系＋トリマー） */
const isStaffRole = (r: unknown): boolean => isAdminRole(r) || r === 'trimmer';

// 顧客フローの要関数のウォーム維持台数。deploy 時に .env.<projectId> の MIN_INSTANCES から解決。
// prod のみ 1（.env.groomhaus-prod）、dev は default 0（無料）。
const minInstancesParam = defineInt('MIN_INSTANCES', { default: 0 });

import { DEFAULT_SETTINGS, EMPTY_LINE_CONFIG } from './tenantDefaults.js';

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

  if (!tenantId || !targetUid || !name || !VALID_ROLES.includes(role)) {
    throw new HttpsError('invalid-argument', 'tenantId, targetUid, name, role(admin|trimmer) required');
  }

  const isSuper = caller?.superAdmin === true;
  const isTenantAdmin = caller?.tenantId === tenantId && isAdminRole(caller?.role);
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

/**
 * メール招待でスタッフを追加（SaaS向けオンボーディング）。
 * 管理者は氏名・メール・ロールを入れるだけ。Authユーザーを用意し custom claims 付与＋staff作成。
 * 新規作成時はクライアントが sendPasswordResetEmail でパスワード設定メールを送る（created=true）。
 * superAdmin、または対象テナントの admin のみ実行可。
 */
export const inviteStaff = onCall<{ tenantId: string; email: string; name: string; role: StaffRole }>(async (request) => {
  const caller = request.auth?.token;
  const { tenantId, name, role } = request.data;
  const email = (request.data.email ?? '').trim().toLowerCase();
  if (!tenantId || !email || !email.includes('@') || !name?.trim() || !VALID_ROLES.includes(role)) {
    throw new HttpsError('invalid-argument', 'tenantId, email, name, role(admin|trimmer) required');
  }
  const isSuper = caller?.superAdmin === true;
  const isTenantAdmin = caller?.tenantId === tenantId && isAdminRole(caller?.role);
  if (!isSuper && !isTenantAdmin) {
    throw new HttpsError('permission-denied', 'superAdmin or tenant admin only');
  }

  // 既存ユーザーを探し、無ければ作成（管理者はUIDを触らない）
  let user;
  let created = false;
  try {
    user = await auth.getUserByEmail(email);
  } catch {
    user = await auth.createUser({ email });
    created = true;
  }

  // 安全策: superAdmin や別テナント所属を巻き込まない
  if (user.customClaims?.superAdmin === true) {
    throw new HttpsError('failed-precondition', 'cannot assign tenant role to a superAdmin');
  }
  const existingTenant = user.customClaims?.tenantId as string | undefined;
  if (existingTenant && existingTenant !== tenantId) {
    throw new HttpsError('failed-precondition', 'this email already belongs to another tenant');
  }

  await auth.setCustomUserClaims(user.uid, { tenantId, role });
  await db
    .collection('tenants')
    .doc(tenantId)
    .collection('staff')
    .doc(user.uid)
    .set({ name: name.trim(), email, role, active: true, firebaseUid: user.uid }, { merge: true });

  // 注: ここではパスワード設定リンクを生成しない。Firebase Auth は新しいコードの発行で
  // 古いコードを失効させるため、この後クライアントが送るメール(sendPasswordResetEmail)と
  // 二重発行になり、どちらかが必ず死ぬ。メール不達時は getStaffInviteLink で最新を再発行する。
  return { uid: user.uid, email, role, created };
});

/**
 * スタッフのパスワード設定リンクを再発行（メールが届かない/期限切れ時の共有用）。
 * superAdmin、または対象テナントの admin のみ。リンクは約1時間有効。
 */
export const getStaffInviteLink = onCall<{ tenantId: string; targetUid: string }>(async (request) => {
  const caller = request.auth?.token;
  const { tenantId, targetUid } = request.data;
  if (!tenantId || !targetUid) throw new HttpsError('invalid-argument', 'tenantId, targetUid required');
  const isSuper = caller?.superAdmin === true;
  const isTenantAdmin = caller?.tenantId === tenantId && isAdminRole(caller?.role);
  if (!isSuper && !isTenantAdmin) {
    throw new HttpsError('permission-denied', 'superAdmin or tenant admin only');
  }
  const user = await auth.getUser(targetUid);
  if ((user.customClaims?.tenantId as string | undefined) !== tenantId) {
    throw new HttpsError('failed-precondition', 'staff does not belong to this tenant');
  }
  if (!user.email) throw new HttpsError('failed-precondition', 'staff has no email');
  const link = await auth.generatePasswordResetLink(user.email);
  return { email: user.email, link };
});

/**
 * スタッフの氏名・ロールを編集（在籍状態・メールは変更しない）。
 * ロール変更時は custom claims も同期。superAdmin、または対象テナントの admin のみ。
 * 自分自身を admin から外すロックアウトは防止。
 */
export const updateStaff = onCall<{ tenantId: string; targetUid: string; name: string; role: StaffRole }>(
  async (request) => {
    const caller = request.auth?.token;
    const callerUid = request.auth?.uid;
    const { tenantId, targetUid, name, role } = request.data;
    if (!tenantId || !targetUid || !name?.trim() || !VALID_ROLES.includes(role)) {
      throw new HttpsError('invalid-argument', 'tenantId, targetUid, name, role(admin|trimmer) required');
    }
    const isSuper = caller?.superAdmin === true;
    const isTenantAdmin = caller?.tenantId === tenantId && isAdminRole(caller?.role);
    if (!isSuper && !isTenantAdmin) {
      throw new HttpsError('permission-denied', 'superAdmin or tenant admin only');
    }
    if (callerUid === targetUid && !isAdminRole(role)) {
      throw new HttpsError('failed-precondition', 'cannot remove your own admin role');
    }

    const target = await auth.getUser(targetUid);
    if (target.customClaims?.superAdmin === true) {
      throw new HttpsError('failed-precondition', 'cannot modify a superAdmin');
    }
    const existingTenant = target.customClaims?.tenantId as string | undefined;
    if (existingTenant && existingTenant !== tenantId) {
      throw new HttpsError('failed-precondition', 'this staff belongs to another tenant');
    }

    await auth.setCustomUserClaims(targetUid, { tenantId, role });
    await db
      .collection('tenants')
      .doc(tenantId)
      .collection('staff')
      .doc(targetUid)
      .set({ name: name.trim(), role }, { merge: true });

    return { targetUid, name: name.trim(), role };
  },
);

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
  /** 予約受付範囲: 今月を含めて何ヶ月先の月末まで受け付けるか。シフト管理画面と連動。既定 3 */
  bookingHorizonMonths: number;
  /** 予約可能スタッフ全員が終日休みの日を顧客に「休業日」として見せるか。既定 true */
  autoCloseWhenAllOff: boolean;
  /**
   * シフトが誰も決まっていない日を「未定」として予約不可にするか。既定 false（=未設定は出勤扱い）。
   * ON時: 1人でもシフトが決まればその決まったスタッフだけで受付（未定スタッフは枠に入らない）。
   */
  requireShiftForBooking: boolean;
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
    bookingHorizonMonths: s.bookingHorizonMonths ?? 3,
    autoCloseWhenAllOff: s.autoCloseWhenAllOff ?? true,
    requireShiftForBooking: s.requireShiftForBooking ?? false,
  };
}

/** その日にシフトが決まっている（何らかのエントリがある）スタッフだけを返す（未定ゲート用）。 */
function decidedStaffIds(shiftDay: ShiftDay | null | undefined, staffIds: string[]): string[] {
  return staffIds.filter((sid) => !!shiftDay?.staff?.[sid]);
}

/**
 * 未定ゲート適用後の「予約枠に入れるスタッフ」。
 * requireShiftForBooking がONのとき、シフト未定のスタッフは枠に入らない。
 * 全員未定なら null（=その日は「未定」として受付しない）。OFFなら従来どおり全員。
 */
function bookablePool(
  shiftDay: ShiftDay | null | undefined,
  staffIds: string[],
  settings: SettingsLike,
): string[] | null {
  if (!settings.requireShiftForBooking || staffIds.length === 0) return staffIds;
  const decided = decidedStaffIds(shiftDay, staffIds);
  return decided.length === 0 ? null : decided;
}

/**
 * 予約可能スタッフ全員がその日終日休みか（自動休業の導出）。
 * closures ドキュメントは作らず空き計算時に導出する＝シフトを戻せば自動で解除され、同期ズレが無い。
 * スタッフが1人もいない場合は false（従来どおり拠点営業時間で受け付ける）。
 */
function isAllStaffOff(
  shiftDay: ShiftDay | null | undefined,
  staffIds: string[],
  settings: SettingsLike,
): boolean {
  if (!settings.autoCloseWhenAllOff || staffIds.length === 0) return false;
  return staffIds.every((sid) => staffHoursFor(shiftDay, sid, settings.businessHours).length === 0);
}

/**
 * 予約受付範囲の最終日(YYYY-MM-DD)＝当月 + bookingHorizonMonths ヶ月先の月末。
 * これを超える日付は顧客からは「空きなし」に見える（シフト未計画の期間を漏らさない）。
 */
function horizonEndDate(settings: SettingsLike): string {
  const [y, m] = tzTodayStr(settings.timezone).split('-').map(Number);
  const end = new Date(y, m - 1 + settings.bookingHorizonMonths + 1, 0);
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
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
/** タイムゾーンの「今日」を YYYY-MM-DD で返す。 */
function tzTodayStr(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
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
/**
 * 標準値に犬ごとの個別加算を反映した実効値。加算は ± 両方向。
 *
 * ⚠ 返す時間は2種類ある。用途を取り違えないこと（クライアント側の規則は src/lib/adjust.ts）。
 *   durationMin         確定時間。予約枠の占有はこちら。短縮ぶんだけ枠が空く
 *   customerDurationMin お客様に伝える時間。短縮は伏せる（早い仕上がりを約束しない）
 *
 * ⚠ 料金は加算方向のみ反映。短縮しても値引きしない（メニュー料金が下限）。
 */
function effectiveItem(
  stdDurationMin: number,
  stdPrice: number | null,
  addMin: number,
): { durationMin: number; customerDurationMin: number; price: number | null } {
  const charge = Math.max(0, addMin);
  const unit = stdPrice != null && stdDurationMin > 0 ? stdPrice / stdDurationMin : 0;
  return {
    durationMin: Math.max(0, stdDurationMin + addMin),
    customerDurationMin: stdDurationMin + charge,
    price: stdPrice == null ? null : stdPrice + ceil50(unit * charge),
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
): Promise<{ options: OptionSnapshot[]; durationMin: number; customerDurationMin: number; price: number }> {
  if (!optionIds || optionIds.length === 0)
    return { options: [], durationMin: 0, customerDurationMin: 0, price: 0 };
  const snaps = await Promise.all(
    optionIds.map((id) => db.collection('tenants').doc(tenantId).collection('options').doc(id).get()),
  );
  const picked = snaps
    .filter((s) => s.exists)
    .map((s) => {
      const o = s.data() ?? {};
      const eff = effectiveItem((o.durationMin ?? 0) as number, (o.price ?? 0) as number, adjustments[s.id] ?? 0);
      return {
        id: s.id,
        name: (o.name ?? '') as string,
        price: eff.price ?? 0,
        durationMin: eff.durationMin,
        customerDurationMin: eff.customerDurationMin,
      };
    });
  return {
    // スナップショットに残すのは確定時間（会計・履歴の実績値）
    options: picked.map(({ id, name, price, durationMin }) => ({ id, name, price, durationMin })),
    durationMin: picked.reduce((s, o) => s + o.durationMin, 0),
    customerDurationMin: picked.reduce((s, o) => s + o.customerDurationMin, 0),
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
): { durationMin: number; customerDurationMin: number; price: number | null } {
  const stdDuration = cell?.durationMin ?? DEFAULT_DURATION_MIN;
  const stdPrice = cell?.price ?? null;
  const addMin = dog?.serviceAdjustments?.[serviceId] ?? 0;
  return effectiveItem(stdDuration, stdPrice, addMin);
}

/**
 * 予約が入った犬のアーカイブを解除する。
 *
 * ⚠ 犬を隠すフラグは2つあり、別物なので取り違えないこと。
 *   archivedAt       スタッフがカルテ一覧から隠す（来店されなくなった子の整理）。ここで解除する
 *   hiddenByCustomer 顧客が自分の予約アプリの選択リストから外す（hideDog）。店の都合で戻さない
 */
async function unarchiveDogs(tenantId: string, dogIds: string[]): Promise<void> {
  const base = db.collection('tenants').doc(tenantId).collection('dogs');
  await Promise.all(
    [...new Set(dogIds.filter(Boolean))].map(async (id) => {
      const snap = await base.doc(id).get();
      if (snap.exists && snap.data()?.archivedAt) await base.doc(id).set({ archivedAt: null }, { merge: true });
    }),
  );
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

/** 予約割当の対象スタッフ（active かつ管理者ロールを除く）。管理者は予約枠に入れない。 */
async function loadBookableStaffIds(tenantId: string): Promise<string[]> {
  const q = await db.collection('tenants').doc(tenantId).collection('staff').where('active', '==', true).get();
  return q.docs.filter((d) => d.data().role !== 'admin').map((d) => d.id);
}

/** 指定スタッフ視点の占有区間。未割当(null)予約は全スタッフを塞ぐ扱い。 */
function occupiedFor(bookings: BookingRow[], staffId: string): { start: string; end: string }[] {
  return bookings
    .filter((b) => b.staffId === staffId || b.staffId == null)
    .map((b) => ({ start: b.startTime, end: b.slotEnd }));
}

/** その日のシフトdoc（シフト①）。無ければ null（=全員が営業時間どおり）。 */
async function loadShiftDay(tenantId: string, date: string): Promise<ShiftDay | null> {
  const snap = await db.collection('tenants').doc(tenantId).collection('shifts').doc(date).get();
  return snap.exists ? (snap.data() as ShiftDay) : null;
}

/** 日付範囲 [from, to] のシフトdocをまとめて取得（月カレンダー判定用）。 */
async function loadShiftDays(tenantId: string, from: string, to: string): Promise<Map<string, ShiftDay>> {
  const snap = await db
    .collection('tenants')
    .doc(tenantId)
    .collection('shifts')
    .where(FieldPath.documentId(), '>=', from)
    .where(FieldPath.documentId(), '<=', to)
    .get();
  const map = new Map<string, ShiftDay>();
  snap.docs.forEach((d) => map.set(d.id, d.data() as ShiftDay));
  return map;
}

/**
 * 顧客セッション確立 + find-or-link (§3)。
 * LINE トークンを検証し、tenant 内の customers を識別子照合して結びつける/作成する。
 */
/**
 * OA 友だち登録を必須化（A方式のサーバ強制）。未追加なら予約フローに入れない。
 * dev トークンやチャネルトークン未設定では検証不能のため通す（クライアント側ゲートで担保）。
 */
async function assertLineFriend(tenantId: string, lineUserId: string, dev: boolean): Promise<void> {
  if (dev) return;
  const tSnap = await db.collection('tenants').doc(tenantId).get();
  const token = reminderChannelToken(tSnap.data()?.lineConfig as Record<string, unknown> | undefined);
  if (!(await isLineFriend(token, lineUserId))) {
    throw new HttpsError('failed-precondition', 'line-friend-required');
  }
}

export const customerSession = onCall<{
  tenantId: string;
  accessToken: string;
  ownerName?: string;
  phone?: string;
}>({ minInstances: minInstancesParam }, async (request) => {
  const { tenantId, accessToken, ownerName, phone } = request.data;
  if (!tenantId) throw new HttpsError('invalid-argument', 'tenantId required');
  const { lineUserId, dev } = await verifyLineAccessToken(accessToken);
  await assertLineFriend(tenantId, lineUserId, dev);

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
    addFriendUrl: (tSnap.data()?.lineConfig?.addFriendUrl ?? '') as string,
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
  // 予約受付範囲外は「空きなし」（休みとは見せない）
  if (date > horizonEndDate(settings)) {
    return { slots: [], durationMin, bufferMin: settings.bufferMin, price, businessHours: settings.businessHours };
  }

  const [bookings, shiftDay, allStaffIds] = await Promise.all([
    loadDayBookings(tenantId, date),
    loadShiftDay(tenantId, date),
    loadBookableStaffIds(tenantId),
  ]);

  // 全員終日休みは「休業日」として見せる（自動休業。設定でOFF可）
  if (isAllStaffOff(shiftDay, allStaffIds, settings)) {
    return { slots: [], durationMin, bufferMin: settings.bufferMin, price, businessHours: settings.businessHours, closed: true };
  }

  // 未定ゲート: シフトが誰も決まっていない日は「未定」で受付しない。未定スタッフの指名も不可（設定ONのとき）
  const pool = bookablePool(shiftDay, allStaffIds, settings);
  if (pool === null || (staffId && settings.requireShiftForBooking && allStaffIds.length > 0 && !pool.includes(staffId))) {
    return { slots: [], durationMin, bufferMin: settings.bufferMin, price, businessHours: settings.businessHours, undecided: true };
  }

  let slots: string[];
  if (staffId) {
    // 指名あり: そのスタッフの予約のみで計算 (§8)。勤務時間はシフト①で解決
    slots = availability({
      businessHours: staffHoursFor(shiftDay, staffId, settings.businessHours),
      bufferMin: settings.bufferMin,
      durationMin,
      occupied: occupiedFor(bookings, staffId),
    });
  } else {
    // 指名なし: 枠に入れるスタッフ（未定ゲート適用後）の空きの和集合 (§8)
    const staffIds = pool;
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
            businessHours: staffHoursFor(shiftDay, sid, settings.businessHours),
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
  if (date > horizonEndDate(settings)) {
    throw new HttpsError('failed-precondition', 'beyond the booking horizon');
  }
  const opts = await loadSelectedOptions(tenantId, optionIds, dog?.optionAdjustments ?? {});
  const cell = await loadPriceCell(tenantId, dog?.breedId ?? null, serviceId);
  // トータル時間 = 基準(料金表セル + 犬のサービス別個別加算) + オプション（個別追加込み）
  const durationMin = effectiveBase(dog, cell, serviceId).durationMin + opts.durationMin;
  const bufferMin = settings.bufferMin;
  const slotEnd = toTimeStr(toMinutes(startTime) + durationMin + bufferMin);

  const [bookings, shiftDay, allStaffIds] = await Promise.all([
    loadDayBookings(tenantId, date),
    loadShiftDay(tenantId, date),
    loadBookableStaffIds(tenantId),
  ]);
  // 未定ゲート: シフトが誰も決まっていない日・未定スタッフの指名は確定させない（設定ONのとき）
  const pool = bookablePool(shiftDay, allStaffIds, settings);
  if (pool === null) throw new HttpsError('failed-precondition', 'shift not planned for this date');
  if (staffId && settings.requireShiftForBooking && allStaffIds.length > 0 && !pool.includes(staffId)) {
    throw new HttpsError('failed-precondition', 'nominated staff is not available');
  }

  // 割当スタッフを決定し、その視点で startTime が空いているか再検証（勤務時間はシフト①で解決）
  function isFree(sid: string): boolean {
    return availability({
      businessHours: staffHoursFor(shiftDay, sid, settings.businessHours),
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
    const staffIds = pool;
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
  /** 登録済みの犬。ゲスト(未ログイン)下書きでは未指定 */
  dogId?: string;
  /** dogId 無しのときの犬種（ゲストの空き照会用。個別加算なしの標準時間で概算） */
  breedId?: string | null;
  /** 確定時に新規登録する犬（ゲスト予約のLINEログイン後確定で使用） */
  newDog?: { name: string; breedId?: string | null };
  serviceId: string;
  optionIds?: string[];
}
interface ComputedGroupItem {
  dogId: string;
  newDog?: { name: string; breedId: string | null };
  serviceId: string;
  optionIds: string[];
  /** 確定時間（予約枠の占有・保存される booking.durationMin） */
  durationMin: number;
  /** お客様に伝える時間（仕上がり予定の表示だけに使う） */
  customerDurationMin: number;
  price: number | null;
  options: OptionSnapshot[];
}
/**
 * カート各項目の所要時間・料金・オプションスナップショットを算出（getAvailability と同じ規則）。
 * dogId 無し（ゲスト）は犬種のみで算出する。新規犬には個別加算が無いため確定時と同値になる。
 */
async function computeGroupItems(tenantId: string, items: GroupItemInput[]): Promise<ComputedGroupItem[]> {
  return Promise.all(
    items.map(async (it) => {
      const dog = await loadDog(tenantId, it.dogId);
      const breedId = dog ? (dog.breedId ?? null) : ((it.breedId ?? it.newDog?.breedId) || null);
      const opts = await loadSelectedOptions(tenantId, it.optionIds, dog?.optionAdjustments ?? {});
      // serviceId 空 = メニュー無し（単体オプション）予約。基準は 0、合計はオプションのみ。
      const base = it.serviceId
        ? effectiveBase(dog, await loadPriceCell(tenantId, breedId, it.serviceId), it.serviceId)
        : { durationMin: 0, customerDurationMin: 0, price: 0 };
      return {
        dogId: it.dogId ?? '',
        ...(it.newDog?.name?.trim() ? { newDog: { name: it.newDog.name.trim(), breedId: it.newDog.breedId || null } } : {}),
        serviceId: it.serviceId,
        optionIds: it.optionIds ?? [],
        durationMin: base.durationMin + opts.durationMin,
        customerDurationMin: base.customerDurationMin + opts.customerDurationMin,
        price: base.price == null ? null : base.price + opts.price,
        options: opts.options,
      };
    }),
  );
}

/**
 * 複数頭の合計時間で空きを返す。指名ありはその担当、なしは全担当の和集合（1人が合計時間ぶん連続で空いている枠）。
 * 認証不要: 返す内容は空き枠のみ（ユーザー非依存の公開情報）。Web集客のゲスト閲覧を
 * LINEログイン前に通すため、トークンは検証しない（予約確定側は従来どおり検証する）。
 */
export const getGroupAvailability = onCall<{
  tenantId: string;
  accessToken?: string;
  date: string;
  items: GroupItemInput[];
  staffId?: string;
}>({ minInstances: minInstancesParam }, async (request) => {
  const { tenantId, date, items, staffId } = request.data;
  if (!tenantId || !date || !items?.length) throw new HttpsError('invalid-argument', 'tenantId, date, items required');

  const settings = await loadSettings(tenantId);
  const computed = await computeGroupItems(tenantId, items);
  const durations = computed.map((c) => c.durationMin);
  // 枠取りは確定時間、お客様に見せる所要時間・仕上がり時刻は customerDurationMin で出す
  const durationMin = computed.reduce((s, c) => s + c.customerDurationMin, 0);
  const customerTotalMin = durationMin;
  const price = computed.some((c) => c.price == null) ? null : computed.reduce((s, c) => s + (c.price ?? 0), 0);
  // バッファはメニュー（サービス）にのみ適用。単品オプションのみの予約はバッファ0。
  const effBuffer = computed.some((c) => c.serviceId) ? settings.bufferMin : 0;

  if (await isClosedDate(tenantId, date)) {
    return { slots: [], finishByStart: {}, durationMin, bufferMin: effBuffer, price, businessHours: settings.businessHours, closed: true };
  }
  // 予約受付範囲外は「空きなし」（休みとは見せない。シフト未計画期間の誤予約防止）
  if (date > horizonEndDate(settings)) {
    return { slots: [], finishByStart: {}, durationMin, bufferMin: effBuffer, price, businessHours: settings.businessHours };
  }

  const [bookings, shiftDay, allStaffIds] = await Promise.all([
    loadDayBookings(tenantId, date),
    loadShiftDay(tenantId, date),
    loadBookableStaffIds(tenantId),
  ]);

  // 全員終日休みは「休業日」として見せる（自動休業。設定でOFF可）
  if (isAllStaffOff(shiftDay, allStaffIds, settings)) {
    return { slots: [], finishByStart: {}, durationMin, bufferMin: effBuffer, price, businessHours: settings.businessHours, closed: true };
  }

  // 未定ゲート: シフトが誰も決まっていない日は「未定」で受付しない。未定スタッフの指名も不可（設定ONのとき）
  const pool = bookablePool(shiftDay, allStaffIds, settings);
  if (pool === null || (staffId && settings.requireShiftForBooking && allStaffIds.length > 0 && !pool.includes(staffId))) {
    return { slots: [], finishByStart: {}, durationMin, bufferMin: effBuffer, price, businessHours: settings.businessHours, undecided: true };
  }
  // 1スタッフの空きに頭数を順に詰め、入る開始時刻(15分グリッド)→施術終了 の対応を作る（連続不可なら自動分割）。
  // hours = そのスタッフの実効勤務時間（シフト①）
  const planForStaff = (
    hours: { start: string; end: string }[],
    occupied: { start: string; end: string }[],
  ): Map<number, number> => {
    const gaps = freeIntervals(hours, occupied);
    const out = new Map<number, number>();
    for (const g of gaps) {
      const first = Math.ceil(g.start / 15) * 15;
      for (let t = first; t < g.end; t += 15) {
        const packed = packDogs(gaps, durations, effBuffer, t);
        if (packed && packed.starts[0] === t) out.set(t, packed.finishMin);
      }
    }
    return out;
  };

  const plan = new Map<number, number>();
  const mergePlan = (p: Map<number, number>) => {
    for (const [t, fin] of p) {
      const cur = plan.get(t);
      if (cur == null || fin < cur) plan.set(t, fin); // 指名なしは最も早く終わる担当を採用
    }
  };
  const hoursOf = (sid: string) => staffHoursFor(shiftDay, sid, settings.businessHours);
  if (staffId) {
    mergePlan(planForStaff(hoursOf(staffId), occupiedFor(bookings, staffId)));
  } else {
    const staffIds = pool;
    if (staffIds.length === 0)
      mergePlan(planForStaff(settings.businessHours, bookings.map((b) => ({ start: b.startTime, end: b.slotEnd }))));
    else for (const sid of staffIds) mergePlan(planForStaff(hoursOf(sid), occupiedFor(bookings, sid)));
  }

  // 受付締切＋過去時刻を除外し、開始時刻→終了時刻のマップを作る
  const slots: string[] = [];
  const finishByStart: Record<string, string> = {};
  for (const t of [...plan.keys()].sort((a, b) => a - b)) {
    const ts = toTimeStr(t);
    if (!afterCutoff(date, ts, settings)) continue;
    slots.push(ts);
    // ⚠ 実際の終了(plan)より早い時刻は出さない。マイナス加算で早く終わる場合も
    //   お客様には標準時間ぶんの仕上がり時刻を伝える（早い仕上がりを約束しない）
    finishByStart[ts] = toTimeStr(Math.max(plan.get(t)!, t + customerTotalMin));
  }

  return { slots, finishByStart, durationMin, bufferMin: effBuffer, price, businessHours: settings.businessHours };
});

/**
 * 選択中の内容(items)が「入る日」を月範囲で返す。月カレンダーのグレーアウト判定に使う。
 * 認証不要（getGroupAvailability と同じ理由。公開情報のみ）。
 */
export const getMonthAvailability = onCall<{
  tenantId: string;
  accessToken?: string;
  items: GroupItemInput[];
  from: string; // YYYY-MM-DD
  to: string;
  staffId?: string;
}>({ minInstances: minInstancesParam }, async (request) => {
  const { tenantId, items, from, to, staffId } = request.data;
  if (!tenantId || !from || !to || !items?.length) throw new HttpsError('invalid-argument', 'tenantId, from, to, items required');

  const settings = await loadSettings(tenantId);
  const computed = await computeGroupItems(tenantId, items);
  const durations = computed.map((c) => c.durationMin);
  const effBuffer = computed.some((c) => c.serviceId) ? settings.bufferMin : 0;

  const base = db.collection('tenants').doc(tenantId);
  const [closSnap, shiftDays] = await Promise.all([base.collection('closures').get(), loadShiftDays(tenantId, from, to)]);
  const closed = new Set(closSnap.docs.filter((d) => d.id >= from && d.id <= to && d.data()?.fullDay !== false).map((d) => d.id));
  const bSnap = await base.collection('bookings').where('date', '>=', from).where('date', '<=', to).get();
  const byDate = new Map<string, BookingRow[]>();
  bSnap.docs.forEach((d) => {
    const b = d.data() as BookingRow & { date: string };
    if (b.status === 'reserved' || b.status === 'done') {
      const arr = byDate.get(b.date) ?? [];
      arr.push(b);
      byDate.set(b.date, arr);
    }
  });
  const staffIds = staffId ? [staffId] : await loadBookableStaffIds(tenantId);

  // その日に「全頭が収まる開始時刻が1つでもあるか」（締切・過去時刻も考慮。勤務時間はシフト①で解決）
  const fitsOnDay = (date: string): boolean => {
    if (closed.has(date)) return false;
    const dayBookings = byDate.get(date) ?? [];
    const shiftDay = shiftDays.get(date) ?? null;
    // 未定ゲート: シフトが誰も決まっていない日（指名時は未定スタッフ）は開いていない扱い
    const pool = bookablePool(shiftDay, staffIds, settings);
    if (pool === null) return false;
    const checkOccupied = (hours: { start: string; end: string }[], occupied: { start: string; end: string }[]): boolean => {
      const gaps = freeIntervals(hours, occupied);
      for (const g of gaps) {
        const first = Math.ceil(g.start / 15) * 15;
        for (let t = first; t < g.end; t += 15) {
          const packed = packDogs(gaps, durations, effBuffer, t);
          if (packed && packed.starts[0] === t && afterCutoff(date, toTimeStr(t), settings)) return true;
        }
      }
      return false;
    };
    if (staffIds.length === 0)
      return checkOccupied(settings.businessHours, dayBookings.map((b) => ({ start: b.startTime, end: b.slotEnd })));
    return pool.some((sid) =>
      checkOccupied(staffHoursFor(shiftDay, sid, settings.businessHours), occupiedFor(dayBookings, sid)),
    );
  };

  const openDates: string[] = [];
  const horizon = horizonEndDate(settings);
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const cur = new Date(fy, fm - 1, fd);
  const end = new Date(ty, tm - 1, td);
  while (cur <= end) {
    const ds = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
    // 予約受付範囲外は開いている日に含めない（月カレンダーで×表示になる）
    if (ds <= horizon && fitsOnDay(ds)) openDates.push(ds);
    cur.setDate(cur.getDate() + 1);
  }
  return { openDates };
});

/**
 * 複数頭をまとめて確定。同じ担当が startTime から連続で施術し、頭数ぶんの予約を groupId で束ねて作成。
 * items は登録済みの dogId か newDog（ゲスト予約でログイン後にまとめて確定）のどちらか。
 * newDog は空き検証が通ってから登録する（枠が取れなかったのに犬だけ残るのを防ぐ）。
 */
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
  if (items.some((it) => !it.dogId && !it.newDog?.name?.trim())) {
    throw new HttpsError('invalid-argument', 'each item requires dogId or newDog');
  }
  const { lineUserId, dev } = await verifyLineAccessToken(accessToken);
  await assertCustomerOwnership(tenantId, customerId, lineUserId);
  await assertLineFriend(tenantId, lineUserId, dev);

  if (await isClosedDate(tenantId, date)) {
    throw new HttpsError('failed-precondition', 'the salon is closed on this date');
  }

  const settings = await loadSettings(tenantId);
  if (!afterCutoff(date, startTime, settings)) {
    throw new HttpsError('failed-precondition', 'past the booking cutoff');
  }
  if (date > horizonEndDate(settings)) {
    throw new HttpsError('failed-precondition', 'beyond the booking horizon');
  }
  const computed = await computeGroupItems(tenantId, items);
  const durations = computed.map((c) => c.durationMin);
  const totalDuration = durations.reduce((s, d) => s + d, 0);
  // バッファはメニュー（サービス）にのみ適用。単品オプションのみの予約はバッファ0。
  const bufferMin = computed.some((c) => c.serviceId) ? settings.bufferMin : 0;
  const [bookings, shiftDay, allStaffIds] = await Promise.all([
    loadDayBookings(tenantId, date),
    loadShiftDay(tenantId, date),
    loadBookableStaffIds(tenantId),
  ]);
  // 未定ゲート: シフトが誰も決まっていない日・未定スタッフの指名は確定させない（設定ONのとき）
  const pool = bookablePool(shiftDay, allStaffIds, settings);
  if (pool === null) throw new HttpsError('failed-precondition', 'shift not planned for this date');
  if (staffId && settings.requireShiftForBooking && allStaffIds.length > 0 && !pool.includes(staffId)) {
    throw new HttpsError('failed-precondition', 'nominated staff is not available');
  }
  const startMin = toMinutes(startTime);

  // startTime から頭数を詰めた配置（連続不可なら自動分割）。先頭が startTime ちょうどでなければ空き無し扱い。
  // hours = そのスタッフの実効勤務時間（シフト①）
  const planFor = (hours: { start: string; end: string }[], occupied: { start: string; end: string }[]) => {
    const packed = packDogs(freeIntervals(hours, occupied), durations, bufferMin, startMin);
    return packed && packed.starts[0] === startMin ? packed : null;
  };

  let assigned: string | null = null;
  let packed: { starts: number[]; finishMin: number } | null = null;
  if (staffId) {
    packed = planFor(staffHoursFor(shiftDay, staffId, settings.businessHours), occupiedFor(bookings, staffId));
    if (!packed) throw new HttpsError('failed-precondition', 'nominated staff is not available');
    assigned = staffId;
  } else {
    const staffIds = pool;
    if (staffIds.length === 0) {
      packed = planFor(settings.businessHours, bookings.map((b) => ({ start: b.startTime, end: b.slotEnd })));
    } else {
      for (const sid of staffIds) {
        const p = planFor(staffHoursFor(shiftDay, sid, settings.businessHours), occupiedFor(bookings, sid));
        if (p) {
          assigned = sid;
          packed = p;
          break;
        }
      }
    }
    if (!packed) throw new HttpsError('failed-precondition', 'no staff available at this time');
  }

  // ゲスト予約の新規犬を登録して dogId を確定（空き検証が通った後）。§7 初回は confirmedDurationMin=null。
  const dogsRef = db.collection('tenants').doc(tenantId).collection('dogs');
  const resolvedDogIds: string[] = [];
  for (const c of computed) {
    if (c.dogId) {
      resolvedDogIds.push(c.dogId);
    } else {
      const ref = await dogsRef.add({
        customerId,
        name: c.newDog!.name,
        breedId: c.newDog!.breedId,
        confirmedDurationMin: null,
      });
      resolvedDogIds.push(ref.id);
    }
  }

  const bookingsRef = db.collection('tenants').doc(tenantId).collection('bookings');
  const groupId = bookingsRef.doc().id;
  const bookingIds: string[] = [];
  for (let i = 0; i < computed.length; i++) {
    const c = computed[i];
    const isLast = i === computed.length - 1;
    const bBuffer = isLast ? bufferMin : 0; // バッファは最後の頭にだけ付与
    const bStart = packed.starts[i];
    const ref = await bookingsRef.add({
      dogId: resolvedDogIds[i],
      customerId,
      serviceId: c.serviceId,
      optionIds: c.optionIds,
      options: c.options,
      groupId,
      staffId: assigned,
      date,
      startTime: toTimeStr(bStart),
      durationMin: c.durationMin,
      bufferMin: bBuffer,
      slotEnd: toTimeStr(bStart + c.durationMin + bBuffer),
      status: 'reserved',
      createdAt: FieldValue.serverTimestamp(),
      // 確認メッセージは先頭の1件のみ送信（2件目以降は送信済み扱いで抑止）
      ...(i > 0 ? { confirmationSentAt: FieldValue.serverTimestamp() } : {}),
    });
    bookingIds.push(ref.id);
  }

  // 予約が入った子はアーカイブから戻す。
  // アーカイブは「来店されなくなった子を一覧から隠す」だけの整理なので、また予約が入ったら
  // 隠れたままにしない（スタッフがカルテを探せなくなる）。
  await unarchiveDogs(tenantId, resolvedDogIds);

  // 表示用の終了時刻＝最後の頭の施術終了（バッファ除く）
  return { bookingIds, groupId, staffId: assigned, slotEnd: toTimeStr(packed.finishMin), startTime, durationMin: totalDuration };
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
  const isStaff = caller?.tenantId === tenantId && isStaffRole(caller?.role);
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

  const [bookings, shiftDay, allStaffIds] = await Promise.all([
    loadDayBookings(tenantId, date),
    loadShiftDay(tenantId, date),
    loadBookableStaffIds(tenantId),
  ]);
  // 未定ゲートON時はスタッフ作成もシフト未定のスタッフ/日を弾く（管理グリッドの「未定」表示と対）
  const staffPool = bookablePool(shiftDay, allStaffIds, settings);
  if (settings.requireShiftForBooking && allStaffIds.length > 0) {
    if (staffPool === null) {
      throw new HttpsError('failed-precondition', 'shift not planned for this date');
    }
    if (staffId && !staffPool.includes(staffId)) {
      throw new HttpsError('failed-precondition', 'staff shift is undecided for this date');
    }
  }
  // スタッフ作成でもシフトを尊重する（休みの人に入れたい場合はシフトを直してから）
  function isFree(sid: string): boolean {
    return availability({
      businessHours: staffHoursFor(shiftDay, sid, settings.businessHours),
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
    const staffIds = staffPool ?? allStaffIds;
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

  await unarchiveDogs(tenantId, [dogId]);

  return { bookingId: ref.id, staffId: assigned, slotEnd, durationMin };
});

/**
 * 予約の日時変更（スタッフ用）。date/startTime 無しで「今日〜受付範囲」の日別空き候補を返し、
 * 指定すると移動を確定する（別日への移動も可。日付が変わったら前日リマインドを再送対象に戻す）。
 * 候補・検証とも本人の予約を占有から除外し、担当のシフト（勤務時間）と手動休業日を尊重する。
 * 受付締切(afterCutoff)は適用しない（当日の繰り上げ等はスタッフ判断でできるように）。
 */
export const rescheduleBooking = onCall<{ tenantId: string; bookingId: string; date?: string; startTime?: string }>(
  async (request) => {
    const caller = request.auth?.token;
    const { tenantId, bookingId, date, startTime } = request.data;
    if (!tenantId || !bookingId) throw new HttpsError('invalid-argument', 'tenantId, bookingId required');
    const isSuper = caller?.superAdmin === true;
    const isStaff = caller?.tenantId === tenantId && isStaffRole(caller?.role);
    if (!isSuper && !isStaff) throw new HttpsError('permission-denied', 'tenant staff only');

    const base = db.collection('tenants').doc(tenantId);
    const ref = base.collection('bookings').doc(bookingId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'booking not found');
    const b = snap.data() as {
      date: string;
      startTime: string;
      durationMin: number;
      bufferMin?: number;
      staffId: string | null;
      status: string;
    };
    if (b.status !== 'reserved') throw new HttpsError('failed-precondition', 'only reserved bookings can be moved');

    const settings = await loadSettings(tenantId);
    const pool = await loadBookableStaffIds(tenantId);
    const from = tzTodayStr(settings.timezone);
    const to = horizonEndDate(settings);
    const [bSnap, closSnap, shiftDays] = await Promise.all([
      base.collection('bookings').where('date', '>=', from).where('date', '<=', to).get(),
      base.collection('closures').get(),
      loadShiftDays(tenantId, from, to),
    ]);
    const closed = new Set(
      closSnap.docs.filter((d) => d.id >= from && d.id <= to && d.data()?.fullDay !== false).map((d) => d.id),
    );
    // 本人を除いた占有を日付ごとに（loadDayBookings と同じ絞り込み）
    const byDate = new Map<string, BookingRow[]>();
    bSnap.docs.forEach((d) => {
      if (d.id === bookingId) return;
      const row = d.data() as BookingRow & { date: string };
      if (row.status !== 'reserved' && row.status !== 'done') return;
      const arr = byDate.get(row.date) ?? [];
      arr.push(row);
      byDate.set(row.date, arr);
    });

    const duration = b.durationMin;
    const buffer = b.bufferMin ?? 0;
    const slotsFor = (ds: string): string[] => {
      if (closed.has(ds)) return [];
      const others = byDate.get(ds) ?? [];
      const shiftDay = shiftDays.get(ds) ?? null;
      // 未定ゲートON時: シフト未定の担当/日は移動先候補にしない（スタッフ作成と同じ扱い）
      if (settings.requireShiftForBooking && pool.length > 0) {
        if (b.staffId) {
          if (!shiftDay?.staff?.[b.staffId]) return [];
        } else if (decidedStaffIds(shiftDay, pool).length === 0) {
          return [];
        }
      }
      const hoursFor = (sid: string) => staffHoursFor(shiftDay, sid, settings.businessHours);
      if (b.staffId) {
        return availability({
          businessHours: hoursFor(b.staffId),
          bufferMin: buffer,
          durationMin: duration,
          occupied: occupiedFor(others, b.staffId),
        });
      }
      if (pool.length === 0) {
        return availability({
          businessHours: settings.businessHours,
          bufferMin: buffer,
          durationMin: duration,
          occupied: others.map((o) => ({ start: o.startTime, end: o.slotEnd })),
        });
      }
      // 指名なし(null)は全スタッフを塞ぐ予約のため、全員が空いている枠のみ候補にする
      return pool
        .map((sid) =>
          availability({
            businessHours: hoursFor(sid),
            bufferMin: buffer,
            durationMin: duration,
            occupied: occupiedFor(others, sid),
          }),
        )
        .reduce((acc, list) => acc.filter((s) => list.includes(s)));
    };

    if (!startTime) {
      // 候補一覧: 今日〜受付範囲で空きのある日だけ返す（本人の現枠は除外）
      const days: { date: string; slots: string[] }[] = [];
      const [fy, fm, fd] = from.split('-').map(Number);
      const [ty, tm, td] = to.split('-').map(Number);
      const cur = new Date(fy, fm - 1, fd);
      const endD = new Date(ty, tm - 1, td);
      while (cur <= endD) {
        const ds = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
        const s = slotsFor(ds).filter((t) => !(ds === b.date && t === b.startTime));
        if (s.length > 0) days.push({ date: ds, slots: s });
        cur.setDate(cur.getDate() + 1);
      }
      return { current: { date: b.date, startTime: b.startTime }, days };
    }

    const targetDate = date ?? b.date;
    if (targetDate < from || targetDate > to) {
      throw new HttpsError('failed-precondition', 'the selected date is out of range');
    }
    if (targetDate === b.date && startTime === b.startTime) {
      throw new HttpsError('failed-precondition', 'same as the current time');
    }
    if (!slotsFor(targetDate).includes(startTime)) {
      throw new HttpsError('failed-precondition', 'the selected time is not available');
    }
    await ref.update({
      date: targetDate,
      startTime,
      slotEnd: toTimeStr(toMinutes(startTime) + duration + buffer),
      // 日付が変わったら前日リマインドを再送対象に戻す
      ...(targetDate !== b.date ? { reminderSentAt: null } : {}),
    });
    return { current: { date: targetDate, startTime }, days: [] };
  },
);

/** customerId が当該 LINE ユーザのものか検証する共通ガード。 */
async function assertCustomerOwnership(tenantId: string, customerId: string, lineUserId: string) {
  const snap = await db.collection('tenants').doc(tenantId).collection('customers').doc(customerId).get();
  if (!snap.exists || snap.data()?.lineUserId !== lineUserId) {
    throw new HttpsError('permission-denied', 'customer does not belong to this LINE user');
  }
}

/**
 * 予約画面の選択肢（サービス・犬種・指名候補スタッフ・自分の犬・料金表）。customerSession でも再利用。
 * customerId が null のときは犬を除いたテナント公開カタログのみ（ゲスト閲覧用）。
 */
async function fetchBookingOptions(tenantId: string, customerId: string | null) {
  const base = db.collection('tenants').doc(tenantId);
  const [tenantSnap, servicesSnap, optionsSnap, breedsSnap, staffSnap, dogsSnap, pricingSnap] = await Promise.all([
    base.get(),
    base.collection('services').where('active', '==', true).get(),
    base.collection('options').where('active', '==', true).get(),
    base.collection('breeds').where('active', '==', true).get(),
    base.collection('staff').where('active', '==', true).get(),
    customerId ? base.collection('dogs').where('customerId', '==', customerId).get() : Promise.resolve(null),
    base.collection('pricing').get(),
  ]);
  const tdata = tenantSnap.data() ?? {};
  return {
    store: {
      name: (tdata.name ?? '') as string,
      logoUrl: (tdata.settings?.logoUrl ?? null) as string | null,
      // ⚠ 友だち追加URLはテナントごと。拠点OAのテナントが混在すると
      //   ビルド時固定のURLでは他店のOAへ誘導してしまうため必ずここから返す。
      addFriendUrl: (tdata.lineConfig?.addFriendUrl ?? '') as string,
    },
    // 予約受付範囲（今月+Nヶ月の月末まで）。クライアントのカレンダー送りの上限に使う
    bookingHorizonMonths: (tdata.settings?.bookingHorizonMonths ?? 3) as number,
    services: servicesSnap.docs.map((d) => ({ id: d.id, name: d.data().name })),
    options: optionsSnap.docs.map((d) => ({
      id: d.id,
      name: d.data().name as string,
      price: (d.data().price ?? 0) as number,
      durationMin: (d.data().durationMin ?? 0) as number,
      standalone: (d.data().standalone ?? false) as boolean,
    })),
    breeds: breedsSnap.docs.map((d) => ({ id: d.id, name: d.data().name })),
    // 指名候補も管理者ロールは除外（予約枠に入れない）
    staff: staffSnap.docs.filter((d) => d.data().role !== 'admin').map((d) => ({ id: d.id, name: d.data().name })),
    // hiddenByCustomer の犬は選択リストから除外（履歴・カルテは保持＝ソフト削除）
    dogs: (dogsSnap?.docs ?? [])
      .filter((d) => d.data().hiddenByCustomer !== true)
      .map((d) => ({
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

/**
 * ゲスト（LINEログイン前）向けの公開予約カタログ。Web集客導線で予約内容の検討まで
 * ログイン無しで進めるために使う。返すのは店舗の公開情報のみ（犬・顧客情報は含まない）。
 */
export const getPublicBookingOptions = onCall<{ tenantId: string }>(
  { minInstances: minInstancesParam },
  async (request) => {
    const { tenantId } = request.data;
    if (!tenantId) throw new HttpsError('invalid-argument', 'tenantId required');
    const tSnap = await db.collection('tenants').doc(tenantId).get();
    if (!tSnap.exists) throw new HttpsError('not-found', 'tenant not found');
    return fetchBookingOptions(tenantId, null);
  },
);

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

/**
 * 休業日の一覧（顧客カレンダー表示用）。指定範囲 [from, to] の終日休業の日付を返す。
 * closures に加え、「予約可能スタッフ全員が終日休みの日」も休業として返す（自動休業・設定でOFF可）。
 * 認証不要（ゲスト閲覧可。休業日はユーザー非依存の公開情報）。
 */
export const getClosedDates = onCall<{ tenantId: string; accessToken?: string; from: string; to: string }>(
  async (request) => {
    const { tenantId, from, to } = request.data;
    if (!tenantId || !from || !to) throw new HttpsError('invalid-argument', 'tenantId, from, to required');
    const [snap, settings] = await Promise.all([
      db.collection('tenants').doc(tenantId).collection('closures').get(),
      loadSettings(tenantId),
    ]);
    const dates = new Set(
      snap.docs.filter((d) => d.id >= from && d.id <= to && d.data()?.fullDay !== false).map((d) => d.id),
    );
    // シフト未定の日（未定ゲートON時）。顧客カレンダーに「未定」を出すために別枠で返す
    const undecidedDates: string[] = [];
    if (settings.autoCloseWhenAllOff || settings.requireShiftForBooking) {
      const [shiftDays, staffIds] = await Promise.all([loadShiftDays(tenantId, from, to), loadBookableStaffIds(tenantId)]);
      if (settings.autoCloseWhenAllOff) {
        // シフトdocがある日だけ判定すれば十分（doc無し=全員営業時間どおり出勤）
        for (const [date, shiftDay] of shiftDays) {
          if (date >= from && date <= to && isAllStaffOff(shiftDay, staffIds, settings)) dates.add(date);
        }
      }
      if (settings.requireShiftForBooking && staffIds.length > 0) {
        // 受付範囲内の全日を走査（doc無し=未定）。休業日は休業表示を優先
        const horizon = horizonEndDate(settings);
        const [fy, fm, fd] = from.split('-').map(Number);
        const [ty, tm, td] = to.split('-').map(Number);
        const cur = new Date(fy, fm - 1, fd);
        const end = new Date(ty, tm - 1, td);
        while (cur <= end) {
          const ds = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
          if (ds <= horizon && !dates.has(ds) && bookablePool(shiftDays.get(ds) ?? null, staffIds, settings) === null) {
            undecidedDates.push(ds);
          }
          cur.setDate(cur.getDate() + 1);
        }
      }
    }
    return { dates: [...dates].sort(), undecidedDates };
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

/**
 * 顧客が自分の犬を「リストから外す」(ソフト削除)。hiddenByCustomer を立てるだけで
 * 予約履歴・カルテ(records)はサロンに残す。今後の予約がある子は外せない。
 */
export const hideDog = onCall<{ tenantId: string; accessToken: string; customerId: string; dogId: string }>(
  async (request) => {
    const { tenantId, accessToken, customerId, dogId } = request.data;
    if (!tenantId || !customerId || !dogId) {
      throw new HttpsError('invalid-argument', 'tenantId, customerId, dogId required');
    }
    const { lineUserId } = await verifyLineAccessToken(accessToken);
    await assertCustomerOwnership(tenantId, customerId, lineUserId);

    const base = db.collection('tenants').doc(tenantId);
    const dogRef = base.collection('dogs').doc(dogId);
    const dogSnap = await dogRef.get();
    if (!dogSnap.exists || dogSnap.data()?.customerId !== customerId) {
      throw new HttpsError('not-found', 'dog not found for this customer');
    }

    // 今後の予約(本日以降・有効)があれば外させない（宙に浮く予約を防ぐ）
    const settings = await loadSettings(tenantId);
    const today = tzTodayStr(settings.timezone);
    const upcoming = await base
      .collection('bookings')
      .where('dogId', '==', dogId)
      .where('date', '>=', today)
      .get();
    const hasUpcoming = upcoming.docs.some((d) => {
      const s = d.data().status;
      return s === 'reserved' || s === 'pending';
    });
    if (hasUpcoming) {
      throw new HttpsError('failed-precondition', 'dog has upcoming bookings');
    }

    await dogRef.set({ hiddenByCustomer: true }, { merge: true });
    return { ok: true };
  },
);

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
  const isStaff = caller?.tenantId === tenantId && isStaffRole(caller?.role);
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

/**
 * 完了済み予約の会計依頼伝票を同一拠点のPOS(mobile_order)へ送る（①会計連携）。
 * 前提: tenant doc に coreTenantId/coreSpaceId（Core拠点への紐付け）が設定済み。
 * 冪等: requestId=groom_{tenantId}_{bookingId}。POS側が再送をno-opにするため再送ボタンは安全。
 * 結果は booking.posCheckout に記録（送信中フラグで連打も抑止）。
 */
export const sendCheckoutToPos = onCall<{ tenantId: string; bookingId: string }>(async (request) => {
  const caller = request.auth?.token;
  const { tenantId, bookingId } = request.data;
  if (!tenantId || !bookingId) {
    throw new HttpsError('invalid-argument', 'tenantId and bookingId required');
  }
  const isSuper = caller?.superAdmin === true;
  const isStaff = caller?.tenantId === tenantId && isStaffRole(caller?.role);
  if (!isSuper && !isStaff) throw new HttpsError('permission-denied', 'tenant staff only');

  const base = db.collection('tenants').doc(tenantId);
  const bookingRef = base.collection('bookings').doc(bookingId);
  const nowIso = new Date().toISOString();

  // 送信中ガード＋前提検証（トランザクションで連打時の二重fetchを抑止）
  const booking = await db.runTransaction(async (tx) => {
    const snap = await tx.get(bookingRef);
    if (!snap.exists) throw new HttpsError('not-found', 'booking not found');
    const b = snap.data() as {
      status: string;
      finalPrice?: number | null;
      customerId: string;
      dogId: string;
      serviceId: string;
      options?: { name: string }[];
      posCheckout?: { status?: string; sentAt?: string | null } | null;
    };
    if (b.status !== 'done' || b.finalPrice == null) {
      throw new HttpsError('failed-precondition', '完了(確定料金入力)後に送信できます');
    }
    const inFlight =
      b.posCheckout?.status === 'sending' &&
      b.posCheckout.sentAt != null &&
      Date.now() - Date.parse(b.posCheckout.sentAt) < 60_000;
    if (inFlight) throw new HttpsError('aborted', '送信処理中です');
    tx.update(bookingRef, {
      posCheckout: {
        requestId: checkoutRequestId(tenantId, bookingId),
        status: 'sending',
        sentAt: nowIso,
        storeId: null,
        posStatus: null,
        lastError: null,
      },
    });
    return b;
  });

  const tenantSnap = await base.get();
  const tenant = tenantSnap.data() ?? {};
  const coreTenantId = (tenant.coreTenantId as string | undefined) ?? '';
  const coreSpaceId = (tenant.coreSpaceId as string | undefined) ?? '';

  const fail = async (error: string, toThrow: HttpsError): Promise<never> => {
    await bookingRef.update({ 'posCheckout.status': 'failed', 'posCheckout.lastError': error });
    throw toThrow;
  };

  if (!coreTenantId || !coreSpaceId) {
    return fail(
      'pos_not_linked',
      new HttpsError('failed-precondition', 'POS未連携です（coreTenantId/coreSpaceId 未設定）'),
    );
  }

  const [custSnap, dogSnap, serviceSnap] = await Promise.all([
    base.collection('customers').doc(booking.customerId).get(),
    base.collection('dogs').doc(booking.dogId).get(),
    booking.serviceId ? base.collection('services').doc(booking.serviceId).get() : Promise.resolve(null),
  ]);
  const cust = custSnap.data() ?? {};
  const optionNames = (booking.options ?? []).map((o) => o.name);
  const serviceName =
    (serviceSnap?.data()?.name as string | undefined) ??
    (optionNames.length > 0 ? optionNames.join('・') : 'トリミング');

  const payload = buildCheckoutRequest({
    coreTenantId,
    coreSpaceId,
    groomTenantId: tenantId,
    bookingId,
    serviceName,
    optionNames,
    finalPrice: booking.finalPrice as number,
    ownerName: (cust.ownerName as string | undefined) ?? 'お客',
    dogName: (dogSnap.data()?.name as string | undefined) ?? '',
    memberId: (cust.memberId ?? null) as string | null,
    lineUserId: (cust.lineUserId ?? null) as string | null,
  });

  let result;
  try {
    result = await deliverCheckoutRequest(payload, crmWebhookSecret());
  } catch (e) {
    logger.warn('checkout request delivery failed', { tenantId, bookingId, error: String(e) });
    return fail('delivery_error', new HttpsError('unavailable', 'POSへの送信に失敗しました。時間をおいて再送してください'));
  }
  if (!result.ok) {
    logger.warn('checkout request rejected', { tenantId, bookingId, httpStatus: result.httpStatus, error: result.error });
    if (result.error === 'space_not_linked') {
      return fail(
        'space_not_linked',
        new HttpsError('failed-precondition', 'POS側に対応する店舗がありません（拠点未連携）'),
      );
    }
    return fail(result.error ?? 'pos_error', new HttpsError('unavailable', 'POSが伝票を受け付けませんでした'));
  }

  await bookingRef.update({
    posCheckout: {
      requestId: payload.request.requestId,
      status: 'sent',
      sentAt: nowIso,
      storeId: result.storeId,
      posStatus: result.status,
      lastError: null,
    },
  });
  return { requestId: payload.request.requestId, storeId: result.storeId, posStatus: result.status };
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
    // 中央 CRM の名寄せキー。決済/POS など LINE 以外の経路と同一人物に統合するため。
    phone: (cust.phone ?? null) as string | null,
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
  const ok = caller?.superAdmin === true || (caller?.tenantId === tenantId && isAdminRole(caller?.role));
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
    const ok = caller?.superAdmin === true || (caller?.tenantId === tenantId && isAdminRole(caller?.role));
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

// --- Core自動プロビジョニング（拠点でgroom有効化→テナント自動作成＋管理者招待） ---
export { provisionTenantForSpace, provisionGroomAdmin, registerGroomAdmin } from './provisioning.js';

// --- 公開URL（/{slug}）の入口解決 ---
export { resolveSpaceSlug } from './slugEntry.js';
