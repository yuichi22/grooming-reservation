// 中央 CRM / ポイント台帳へのイベント連携 (§10)。
// SaaS は「投げる側」。CRM 未構築でも取りこぼさないよう、イベントを
// アウトボックス(tenants/{tenantId}/pointEvents/{bookingId})に冪等キー付きで保持し、
// Webhook URL が設定されていれば配信、無ければ pending のまま貯める。

export type PointEventStatus = 'pending' | 'sent' | 'failed';

/**
 * §10 のペイロード。memberId 未確定(識別子未連携)時の解決用に lineUserId も載せる。
 * phone は中央 CRM 側の名寄せキー（決済・POS など LINE 以外の経路と同一人物に統合するため）。
 */
export interface PointEventPayload {
  bookingId: string;
  memberId: string | null;
  lineUserId: string | null;
  phone: string | null;
  tenantId: string;
  brand: string;
  type: 'trimming';
  amount: number;
  at: string; // ISO8601
  /** true = 加算しない（会計はレジ側でやる）。顧客の紐付けのためイベント自体は送る。 */
  linkOnly?: boolean;
}

export interface BuildPointEventInput {
  bookingId: string;
  tenantId: string;
  brand: string;
  amount: number;
  at: string;
  memberId?: string | null;
  lineUserId?: string | null;
  phone?: string | null;
  linkOnly?: boolean;
}

/** §10 ペイロードを組み立てる（純粋関数）。 */
export function buildPointEvent(input: BuildPointEventInput): PointEventPayload {
  return {
    bookingId: input.bookingId,
    memberId: input.memberId ?? null,
    lineUserId: input.lineUserId ?? null,
    phone: input.phone ?? null,
    tenantId: input.tenantId,
    brand: input.brand,
    type: 'trimming',
    amount: input.amount,
    at: input.at,
    // レジ会計の予約は Core 側で加算しない（紐付けのみ）。二重付与の防止。
    ...(input.linkOnly ? { linkOnly: true } : {}),
  };
}

/** 配信先 Webhook URL（CRM 完成後に設定）。未設定なら null。 */
export function crmWebhookUrl(): string | null {
  return process.env.CRM_WEBHOOK_URL || null;
}

/** CRM Webhook の共有シークレット（Bearer 認証用）。未設定なら null。 */
export function crmWebhookSecret(): string | null {
  return process.env.CRM_WEBHOOK_SECRET || null;
}

/**
 * Webhook へ POST 配信。冪等性のため Idempotency-Key に bookingId を入れる。
 * 共有シークレットが設定されていれば Authorization: Bearer を付ける（CRM 側で認証）。
 * URL 未設定なら未配信(false)。
 */
export async function deliverPointEvent(payload: PointEventPayload): Promise<boolean> {
  const url = crmWebhookUrl();
  if (!url) return false;

  const secret = crmWebhookSecret();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': payload.bookingId,
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`CRM webhook responded ${res.status}`);
  }
  return true;
}
