// LIFF 初期化ラッパ (§2 顧客認証)。
// VITE_LIFF_ID が無い場合は開発モードとして、サーバの "dev:" バイパスと整合する
// モックトークン/プロフィールを返す（ローカルでフロー検証可能にする）。
import liff from '@line/liff';

export interface LiffProfile {
  userId: string;
  displayName: string;
}

const LIFF_ID = import.meta.env.VITE_LIFF_ID as string | undefined;
const DEV_USER_ID = 'Udev_local_tester';
/** OA 友だち追加URL（例: https://lin.ee/xxxx）。A方式の友だち必須化で使用。 */
export const ADD_FRIEND_URL = (import.meta.env.VITE_LINE_ADD_FRIEND_URL as string | undefined) ?? '';

let initialized = false;
export const isDevMode = !LIFF_ID;

export async function initLiff(): Promise<void> {
  if (initialized) return;
  if (isDevMode) {
    initialized = true;
    return;
  }
  await liff.init({ liffId: LIFF_ID! });
  if (!liff.isLoggedIn()) {
    liff.login();
  }
  initialized = true;
}

export async function getProfile(): Promise<LiffProfile> {
  if (isDevMode) {
    return { userId: DEV_USER_ID, displayName: '開発テスター' };
  }
  const p = await liff.getProfile();
  return { userId: p.userId, displayName: p.displayName };
}

/**
 * OA を友だち追加済みか（A方式の必須化ゲート用）。
 * 開発モードは true（ローカル検証を止めない）。判定不能時は安全側で false。
 */
export async function isFriend(): Promise<boolean> {
  if (isDevMode) return true;
  try {
    const r = await liff.getFriendship();
    return r.friendFlag;
  } catch {
    return false;
  }
}

/** LINE内で OA の友だち追加画面を開く。 */
export function openAddFriend(): void {
  if (!ADD_FRIEND_URL) return;
  try {
    liff.openWindow({ url: ADD_FRIEND_URL, external: false });
  } catch {
    window.open(ADD_FRIEND_URL, '_blank');
  }
}

/**
 * LIFF ウィンドウを閉じて LINE に戻る。
 * 開発モードや（外部ブラウザ等で）閉じられない環境では false を返す＝呼び出し側でフォールバック。
 */
export function closeLiff(): boolean {
  if (isDevMode) return false;
  try {
    liff.closeWindow();
    return true;
  } catch {
    return false;
  }
}

/** Cloud Functions に渡すアクセストークン。開発モードでは "dev:<userId>"。 */
export function getAccessToken(): string {
  if (isDevMode) return `dev:${DEV_USER_ID}`;
  const token = liff.getAccessToken();
  if (!token) throw new Error('LINE access token を取得できません');
  return token;
}
