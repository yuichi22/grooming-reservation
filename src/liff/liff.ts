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
/**
 * OA 友だち追加URL（例: https://lin.ee/xxxx）のフォールバック。
 *
 * ⚠ ビルド時に1つしか焼き込めないため、拠点OAを持つテナントが混在すると
 *   別テナントの顧客に他店のOAを追加させてしまう。
 *   正はテナント設定（lineConfig.addFriendUrl → store.addFriendUrl）で、
 *   これは未設定テナント向けの後方互換用。
 */
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
 * ゲストが予約確定に進むときのLINEログイン（Webログインへのリダイレクト）。
 * 通常は buildLiffDeepLink を優先し、こちらはフォールバック。
 */
export function loginForBooking(): void {
  if (isDevMode) return;
  liff.login({ redirectUri: window.location.href });
}

/**
 * liff.line.me 経由のディープリンクURL。スマホではユニバーサルリンクでLINEアプリが起動し、
 * アプリのログイン状態がそのまま使われる（Webログインのパスワード入力が不要になる）。
 * アプリ未導入/PCはLINEのWebログインへ自然にフォールバックする。
 * 注: LINEアプリ内ブラウザは外部ブラウザとストレージが別のため、状態はURLパラメータで運ぶこと。
 */
export function buildLiffDeepLink(params: Record<string, string>): string | null {
  if (isDevMode || !LIFF_ID) return null;
  const q = new URLSearchParams(params).toString();
  return `https://liff.line.me/${LIFF_ID}${q ? `?${q}` : ''}`;
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

/**
 * LINE内で OA の友だち追加画面を開く。
 * @param url テナント設定の友だち追加URL。未指定なら環境変数のフォールバックを使う。
 */
export function openAddFriend(url?: string): void {
  const target = url || ADD_FRIEND_URL;
  if (!target) return;
  try {
    liff.openWindow({ url: target, external: false });
  } catch {
    window.open(target, '_blank');
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
