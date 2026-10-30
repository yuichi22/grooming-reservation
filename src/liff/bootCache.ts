// 予約画面の「前回の起動結果」を端末に覚えておく（LINE から開いたときの待ちを短くする）。
//
// ⚠起動時の customerSession（LINEトークン確認→友だち確認→顧客の名寄せ→メニュー一式）は
//   Cloud Functions への往復1本で、コールドスタートに当たると数秒「確認しています」で止まって見える。
//   前回この端末・このLINEユーザー・この店で予約画面まで進めていれば、覚えておいた内容で先に
//   画面を出し、customerSession は裏で流して結果で差し替える（友だち解除・電話未登録になっていたら
//   そこで案内画面へ切り替える）。
//   守りはサーバ側（予約・犬の登録などは毎回 LINE トークンと customerId の持ち主を確認する）にあり、
//   この覚え書きで出来ることは増えない。
import type { BookingOptions } from './customerApi';

export interface BootSnapshot {
  customerId: string;
  options: BookingOptions;
  store: BookingOptions['store'];
}

interface Stored extends BootSnapshot {
  key: string;
  savedAt: number;
}

const STORAGE_KEY = 'groom_boot_cache_v1';
/** これより古い覚え書きは使わない（メニューや店の設定が大きく変わっている可能性があるため） */
export const BOOT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const defaultStorage = (): StorageLike | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};

const cacheKey = (tenantId: string, lineUserId: string) => `${tenantId}:${lineUserId}`;

export function loadBootSnapshot(
  tenantId: string,
  lineUserId: string | null,
  now = Date.now(),
  storage: StorageLike | null = defaultStorage(),
): BootSnapshot | null {
  if (!lineUserId || !storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Stored>;
    if (s.key !== cacheKey(tenantId, lineUserId)) return null;
    if (typeof s.savedAt !== 'number' || now - s.savedAt > BOOT_CACHE_TTL_MS) return null;
    if (!s.customerId || !s.options || !s.store) return null;
    return { customerId: s.customerId, options: s.options, store: s.store };
  } catch {
    return null;
  }
}

/** 1端末1件だけ持つ（別の店・別のLINEユーザーで開いたら上書き） */
export function saveBootSnapshot(
  tenantId: string,
  lineUserId: string | null,
  snap: BootSnapshot,
  now = Date.now(),
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!lineUserId || !storage) return;
  try {
    const v: Stored = { ...snap, key: cacheKey(tenantId, lineUserId), savedAt: now };
    storage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* 容量超過などは無視（次回は通常どおり待つだけ） */
  }
}

export function clearBootSnapshot(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}
