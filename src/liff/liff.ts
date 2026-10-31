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

export const isDevMode = !LIFF_ID;

// ⚠liff.init は1回だけ走らせ、呼び出し側は同じ Promise を待つ。
//   main.tsx が /book のとき画面部品の読み込みと並行して先に始めるので、
//   BookEntry / BookingPage から後で呼ばれても二重に初期化しない。
let initPromise: Promise<void> | null = null;

function initOnce(): Promise<void> {
  if (isDevMode) return Promise.resolve();
  if (!initPromise) {
    initPromise = liff.init({ liffId: LIFF_ID! }).catch((e) => {
      initPromise = null; // 失敗したら次の呼び出しでやり直せるようにする
      throw e;
    });
  }
  return initPromise;
}

/** 初期化だけ先に始める（結果は待たない）。main.tsx から使う */
export function startLiffInit(): void {
  initOnce().catch(() => {
    /* 失敗は initLiff / initLiffOptional の呼び出し側で扱う */
  });
}

export async function initLiff(): Promise<void> {
  await initOnce();
  if (isDevMode || liff.isLoggedIn()) return;
  // ⚠LINE アプリ内（LIFF ブラウザ）で liff.login() を呼ぶのは LINE 公式の禁止パターンで、
  //   リダイレクトが宙吊りになり読み込み表示のまま止まる（Core の会員証で実機確認済み）。
  //   アプリ内で未ログインになるのは異常系なので、止めずにエラーとして案内する。
  if (liff.isInClient()) throw new Error('LINE との接続を確認できませんでした。お手数ですが、閉じて開き直してください。');
  liff.login();
}

/**
 * ログインを強制しない初期化（Web集客のゲスト閲覧用）。戻り値 = ログイン済みか。
 * 未ログインでも予約内容の検討まで進め、確定時に loginForBooking でLINEへ誘導する。
 * 開発モードは常にログイン済み扱い（"dev:" トークンで動く）。
 */
export async function initLiffOptional(): Promise<boolean> {
  await initOnce();
  if (isDevMode) return true;
  return liff.isLoggedIn();
}

/**
 * 通信せずに分かる LINE の userId（端末に覚えた起動結果の持ち主確認に使う）。
 * LIFF ブラウザでは getContext に入っている。取れない環境では null（＝覚え書きを使わない）。
 */
export function getLocalUserId(): string | null {
  if (isDevMode) return DEV_USER_ID;
  try {
    const id = liff.getContext()?.userId ?? liff.getDecodedIDToken()?.sub;
    if (id) return id;
    // LINE アプリ内は端末のLINEアカウント1つに紐づくので、userId が取れなくても「この端末のLINE」として扱う
    return liff.isInClient() ? 'liff-client' : null;
  } catch {
    return null;
  }
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

/** サーバが LINE トークンを受け付けなかった（期限切れ等）エラーか */
export function isLineAuthError(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'functions/unauthenticated';
}

/**
 * 期限切れの LINE アクセストークン対策（Core の会員証 liffQuery.js と同じ）。
 * LIFF を閉じるとトークンは失効するが、SDK は次に開いたとき失効済みのトークンを返すことがある。
 * 1セッション1回だけ logout → 読み直しで、init の自動ログインに新しいトークンを発行させる。
 * @returns true = 読み直し/ログインへ遷移した（呼び出し側は処理を打ち切る）
 */
export function reloginOnce(): boolean {
  if (isDevMode) return false;
  const key = 'groom-liff-relogin';
  try {
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, '1');
  } catch {
    return false; // 回数を数えられない環境では無限読み直しを避けて何もしない
  }
  try {
    liff.logout();
  } catch {
    /* noop */
  }
  // ⚠LIFF ブラウザ内では liff.login() を使わない（initLiff の説明）。読み直せば init が再発行する。
  if (liff.isInClient()) {
    // ログイン戻りの認可コードを残したまま読み直すと、同じコードの二重使用で init が落ちる
    try {
      const p = new URLSearchParams(window.location.search);
      for (const k of ['code', 'state', 'liffClientId', 'liffRedirectUri', 'error', 'errorCode', 'error_description']) p.delete(k);
      const q = p.toString();
      window.history.replaceState(window.history.state, '', window.location.pathname + (q ? `?${q}` : ''));
    } catch {
      /* noop */
    }
    window.location.reload();
  } else {
    liff.login({ redirectUri: window.location.href });
  }
  return true;
}

/** Cloud Functions に渡すアクセストークン。開発モードでは "dev:<userId>"。 */
export function getAccessToken(): string {
  if (isDevMode) return `dev:${DEV_USER_ID}`;
  const token = liff.getAccessToken();
  if (!token) throw new Error('LINE access token を取得できません');
  return token;
}
