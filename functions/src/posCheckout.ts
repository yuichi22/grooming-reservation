// POS(mobile_order)への会計依頼伝票の配信（groom→POS 会計連携①）。
// 「作業完了・お会計」で、同一拠点のPOSレジに伝票(checkoutRequest)を送る。
// 拠点の対応付けは Akuto Core の tenantId/spaceId（groom側は tenant doc の
// coreTenantId/coreSpaceId に保持）。POS側が coreLinks で自店舗に逆引きする。
// 認証は CRM 連携と同じ第一者共有シークレット Bearer（CRM_WEBHOOK_SECRET）。

/** 伝票の明細行。トリミングは店内役務のため標準税率10%固定。 */
export interface CheckoutLine {
  name: string;
  qty: number;
  unitPrice: number; // 円整数・税込
  taxRate: number;
  taxRateType: 'standard' | 'reduced';
}

/** POS受け口(receiveCheckoutRequest)へのPOSTボディ。 */
export interface CheckoutRequestPayload {
  source: 'groom';
  /** Core の拠点識別子（groom自身のtenantIdではない） */
  tenantId: string;
  spaceId: string;
  action: 'create';
  request: {
    /** groom側発番の冪等キー（POS側doc IDになる） */
    requestId: string;
    groomTenantId: string;
    bookingId: string;
    /** CRM顧客ID（②のポイント付与用）。未連携なら null */
    personId: string | null;
    lineUserId: string | null;
    customerName: string | null;
    totalAmount: number; // 円整数・税込
    lines: CheckoutLine[];
    note: string | null;
  };
}

export interface BuildCheckoutRequestInput {
  coreTenantId: string;
  coreSpaceId: string;
  groomTenantId: string;
  bookingId: string;
  serviceName: string;
  optionNames: string[];
  finalPrice: number;
  ownerName: string;
  dogName: string;
  memberId?: string | null;
  lineUserId?: string | null;
}

/** レジに出す顧客名。飼い主名が空でも「様（犬名）」にならないようにする。 */
export function buildCustomerLabel(ownerName?: string | null, dogName?: string | null): string {
  const owner = String(ownerName ?? '').trim();
  const dog = String(dogName ?? '').trim();
  if (owner && dog) return `${owner}様（${dog}）`;
  if (owner) return `${owner}様`;
  if (dog) return `${dog}のお客様`;
  return 'お客様';
}

/** 伝票の冪等キー。POS側 checkoutRequests の doc ID になる。 */
export function checkoutRequestId(groomTenantId: string, bookingId: string): string {
  return `groom_${groomTenantId}_${bookingId}`;
}

/**
 * 会計依頼伝票を組み立てる（純粋関数）。
 * finalPrice は完了時に手入力される調整済み最終金額のため、明細は1行に集約し
 * オプションは note に列挙する（按分して複数行にすると実額と乖離した明細になる）。
 */
export function buildCheckoutRequest(input: BuildCheckoutRequestInput): CheckoutRequestPayload {
  return {
    source: 'groom',
    tenantId: input.coreTenantId,
    spaceId: input.coreSpaceId,
    action: 'create',
    request: {
      requestId: checkoutRequestId(input.groomTenantId, input.bookingId),
      groomTenantId: input.groomTenantId,
      bookingId: input.bookingId,
      personId: input.memberId ?? null,
      lineUserId: input.lineUserId ?? null,
      // ⚠飼い主名は空のことがある（LIFF登録で氏名未入力など）。
      //   `??` は空文字を拾えず「様（ポロ）」になってレジで名前が消えるので trim で判定する。
      customerName: buildCustomerLabel(input.ownerName, input.dogName),
      totalAmount: input.finalPrice,
      lines: [
        {
          name: input.serviceName,
          qty: 1,
          unitPrice: input.finalPrice,
          taxRate: 10,
          taxRateType: 'standard',
        },
      ],
      note: input.optionNames.length > 0 ? `オプション: ${input.optionNames.join(', ')}` : null,
    },
  };
}

/** POS受け口URL（.env.<projectId> の POS_CHECKOUT_URL）。未設定なら null。 */
export function posCheckoutUrl(): string | null {
  return process.env.POS_CHECKOUT_URL || null;
}

export interface DeliverCheckoutResult {
  ok: boolean;
  httpStatus: number;
  /** POS側の伝票状態（pending/claimed/paid など） */
  status: string | null;
  storeId: string | null;
  error: string | null;
}

/**
 * POS受け口へPOST配信。受け口側が requestId で冪等化しているため再送は安全。
 * URL/secret 未設定は設定不備として throw（CRMと違い貯めずに即時エラーでUIに返す）。
 */
export async function deliverCheckoutRequest(
  payload: CheckoutRequestPayload,
  secret: string | null,
): Promise<DeliverCheckoutResult> {
  const url = posCheckoutUrl();
  if (!url) throw new Error('POS_CHECKOUT_URL is not configured');
  if (!secret) throw new Error('CRM_WEBHOOK_SECRET is not configured');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': payload.request.requestId,
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    status?: string;
    storeId?: string;
    error?: string;
  } | null;
  return {
    ok: res.ok && body?.ok === true,
    httpStatus: res.status,
    status: body?.status ?? null,
    storeId: body?.storeId ?? null,
    error: body?.error ?? (res.ok ? null : `POS responded ${res.status}`),
  };
}
