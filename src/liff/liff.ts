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

/**
 * ログインを強制しない初期化（Web集客のゲスト閲覧用）。戻り値 = ログイン済みか。
 * 未ログインでも予約内容の検討まで進め、確定時に loginForBooking でLINEへ誘導する。
 * 開発モードは常にログイン済み扱い（"dev:" トークンで動く）。
 */
export async function initLiffOptional(): Promise<boolean> {
  if (isDevMode) {
    initialized = true;
    return true;
  }
  if (!initialized) {
    await liff.init({ liffId: LIFF_ID! });
    initialized = true;
  }
  return liff.isLoggedIn();
}

/**
 * ゲストが予約確定に進むときのLINEログイン。認証後に元のURLへ戻る
 * （呼び出し側が下書きを保存してから呼ぶこと。リダイレクトでページ状態は失われる）。
 */
export function loginForBooking(): void {
  if (isDevMode) return;
  liff.login({ redirectUri: window.location.href });
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
