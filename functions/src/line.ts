// LINE アクセストークンの検証 (§2 顧客認証)。
// 顧客は Firebase Auth を持たないため、LIFF から渡されたアクセストークンを
// LINE プラットフォームで検証して lineUserId を得る。
import { HttpsError } from 'firebase-functions/v2/https';

export interface LineIdentity {
  lineUserId: string;
}

/**
 * LIFF アクセストークンを検証し lineUserId を返す。
 * 開発/エミュレータ用に "dev:<userId>" 形式のトークンはネットワーク検証を
 * スキップして許可する（本番では使われない想定）。
 */
export async function verifyLineAccessToken(accessToken: string): Promise<LineIdentity> {
  if (!accessToken) throw new HttpsError('unauthenticated', 'accessToken required');

  // 開発用バイパス
  if (accessToken.startsWith('dev:')) {
    const lineUserId = accessToken.slice('dev:'.length);
    if (!lineUserId) throw new HttpsError('unauthenticated', 'invalid dev token');
    return { lineUserId };
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
  return { lineUserId: profile.userId };
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
