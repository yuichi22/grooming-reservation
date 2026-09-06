// LINE アクセストークンの検証 (§2 顧客認証)。
// 顧客は Firebase Auth を持たないため、LIFF から渡されたアクセストークンを
// LINE プラットフォームで検証して lineUserId を得る。
import { HttpsError } from 'firebase-functions/v2/https';

export interface LineIdentity {
  lineUserId: string;
  /** 開発用 "dev:" トークン由来か（友だち判定など実APIに通さない処理の分岐用）。 */
  dev: boolean;
}

/**
 * LIFF アクセストークンを検証し lineUserId を返す。
 * 開発/エミュレータ用に "dev:<userId>" 形式のトークンはネットワーク検証を
 * スキップして許可するが、これは ALLOW_DEV_LINE_TOKEN=true のときだけ有効。
 * 既定（未設定）では無効で、本番では必ず未設定にして無効化する（成りすまし防止）。
 */
export async function verifyLineAccessToken(accessToken: string): Promise<LineIdentity> {
  if (!accessToken) throw new HttpsError('unauthenticated', 'accessToken required');

  // 開発用バイパス（環境変数フラグでゲート。既定は無効＝本番では使えない）
  if (accessToken.startsWith('dev:')) {
    if (process.env.ALLOW_DEV_LINE_TOKEN !== 'true') {
      throw new HttpsError('unauthenticated', 'dev token not allowed');
    }
    const lineUserId = accessToken.slice('dev:'.length);
    if (!lineUserId) throw new HttpsError('unauthenticated', 'invalid dev token');
    return { lineUserId, dev: true };
  }

  // 1) トークンの有効性確認
  const verifyRes = await fetch(
    `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`,
  );
  if (!verifyRes.ok) {
    throw new HttpsError('unauthenticated', 'invalid LINE access token');
  }

  // 2) プロフィール取得で userId を得る
  const profRes = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!profRes.ok) {
    throw new HttpsError('unauthenticated', 'failed to fetch LINE profile');
  }
  const profile = (await profRes.json()) as { userId?: string };
  if (!profile.userId) {
    throw new HttpsError('unauthenticated', 'LINE profile has no userId');
  }
  return { lineUserId: profile.userId, dev: false };
}

/**
 * このユーザーが OA を友だち追加しているか（Messaging API のプロフィール取得で判定）。
 * - チャネルトークン未設定/開発トークン → 検証不能のため true（誤ブロック回避。クライアント側ゲートで担保）。
 * - 404 → 友だちでない/ブロック中＝false（確定）。
 * - その他の一時エラー → true（フェイルオープン。一時障害で予約を止めない）。
 */
export async function isLineFriend(channelAccessToken: string | null, lineUserId: string): Promise<boolean> {
  if (!channelAccessToken || channelAccessToken.startsWith('dev:')) return true;
  const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`, {
    headers: { Authorization: `Bearer ${channelAccessToken}` },
  });
  if (res.status === 404) return false;
  return true;
}

export type PushResult = 'sent' | 'skipped';

/**
 * LINE Messaging API でプッシュ送信 (§9)。
 * チャネルアクセストークンが未設定/開発トークンの場合は送信せず 'skipped'。
 */
export async function pushLineMessage(
  channelAccessToken: string | null,
  to: string,
  text: string,
): Promise<PushResult> {
  if (!channelAccessToken || channelAccessToken.startsWith('dev:')) {
    return 'skipped';
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${channelAccessToken}`,
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  });
  if (!res.ok) {
    throw new Error(`LINE push responded ${res.status}`);
  }
  return 'sent';
}
