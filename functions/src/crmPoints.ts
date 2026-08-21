// レジ無しの店舗が groom の「完了して保存」でポイントを使うための Core 中継。
// 共有シークレットはサーバだけが持つ（ブラウザには絶対に出さない）。
// - lookup: 予約の顧客が中央CRMに紐づいていれば残高と利用ルールを返す
// - redeem: ポイント利用を確定する（会計取消時は refund で戻す）
//
// ⚠冪等キーは `redeem-{bookingId}`。付与(pointEvent)は bookingId をそのまま使っており、
//   Core は付与・利用ともに tenants/{tid}/pointEventReceipts/{key} で重複判定するため、
//   同じキーにすると「利用が付与の重複」と誤判定される。

import { crmWebhookSecret, crmWebhookUrl } from './crm.js';

export interface CrmPointRules {
  yenPerPoint: number;
  unit: number;
}

export interface CrmMemberPoints {
  personId: string;
  displayName: string | null;
  pointBalance: number;
  redeem: CrmPointRules;
}

/** ポイント利用の冪等キー。付与(bookingId)と衝突させない。 */
export function redeemIdempotencyKey(bookingId: string): string {
  return `redeem-${bookingId}`;
}

/**
 * Core の CRM エンドポイントのベースURL。
 * 受信口(CRM_WEBHOOK_URL)と同じデプロイなので末尾の関数名を差し替えて使う。
 */
export function crmApiBase(): string | null {
  const url = crmWebhookUrl();
  if (!url) return null;
  return url.replace(/\/receiveCrmPointEvent\/?$/, '');
}

async function callCore(path: string, body: unknown, idempotencyKey?: string): Promise<Record<string, unknown>> {
  const base = crmApiBase();
  const secret = crmWebhookSecret();
  if (!base || !secret) throw new Error('crm_not_configured');

  const res = await fetch(`${base}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = String(data?.error ?? res.status);
    throw new Error(err);
  }
  return data;
}

export interface MemberIdentifiers {
  /** 中央CRMの personId（customers.memberId）。分かっていればこれが最優先。 */
  personId?: string | null;
  lineUserId?: string | null;
  phone?: string | null;
}

/**
 * 顧客の残高・利用ルールを引く。紐づいていない顧客は null。
 * ⚠groom の customers.memberId は未連携のことが多いので、lineUserId / phone でも解決する
 *   （Core は取込と同じ HMAC 索引で person を引く。生PIIは Core に索引として残らない）。
 */
export async function lookupMemberPoints(
  coreTenantId: string,
  ids: MemberIdentifiers,
): Promise<CrmMemberPoints | null> {
  const personId = ids.personId ?? null;
  const lineUserId = ids.lineUserId ?? null;
  const phone = ids.phone ?? null;
  if (!personId && !lineUserId && !phone) return null;
  const data = await callCore('lookupCrmMember', {
    coreTenantId,
    ...(personId ? { personId } : {}),
    ...(!personId && lineUserId ? { lineUserId } : {}),
    ...(!personId && phone ? { phone } : {}),
  });
  const redeem = (data.redeem ?? {}) as Partial<CrmPointRules>;
  return {
    personId: String(data.personId ?? personId ?? ''),
    displayName: (data.displayName as string | null) ?? null,
    pointBalance: Number(data.pointBalance ?? 0),
    redeem: {
      yenPerPoint: Math.max(Number(redeem.yenPerPoint ?? 1), 1),
      unit: Math.max(Math.floor(Number(redeem.unit ?? 1)), 1),
    },
  };
}

/** ポイント利用を確定する。refund=true で会計取消時の戻し。 */
export async function redeemMemberPoints(input: {
  coreTenantId: string;
  coreSpaceId?: string | null;
  personId: string;
  points: number;
  bookingId: string;
  refund?: boolean;
}): Promise<Record<string, unknown>> {
  const key = redeemIdempotencyKey(input.bookingId);
  return callCore(
    'redeemCrmPoints',
    {
      coreTenantId: input.coreTenantId,
      coreSpaceId: input.coreSpaceId ?? null,
      personId: input.personId,
      points: Math.floor(input.points),
      idempotencyKey: key,
      provider: 'groom',
      refund: input.refund === true,
    },
    key,
  );
}

/**
 * 拠点が POS(レジ)を契約しているか。Core の契約状態(enabledApps)が唯一の出所。
 * ⚠契約が変われば結果も変わる＝これは正しい挙動。POSをやめたら「この場で会計」に戻る。
 * 落ちても会計は止めない（判定できなければ false=レジ無しとして扱う）。
 */
export async function hasPosApp(coreTenantId: string, coreSpaceId: string): Promise<boolean> {
  const base = crmApiBase();
  const secret = crmWebhookSecret();
  if (!base || !secret || !coreTenantId || !coreSpaceId) return false;
  try {
    const res = await fetch(`${base}/getSpaceEntitlements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ tenantId: coreTenantId, spaceId: coreSpaceId }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { enabledApps?: Record<string, boolean> };
    const apps = data.enabledApps ?? {};
    // レジ会計の受け口は mobile_order（pos / order のどちらの契約でも同じアプリが受ける）
    return apps.pos === true || apps.order === true;
  } catch {
    return false;
  }
}

/**
 * 会計で実際に使える上限(pt)。残高・支払額・利用単位の3つで決まる。
 * 端数が単位に満たない場合は切り捨てる（Core 側も単位違反を弾く）。
 */
export function maxUsablePoints(balance: number, payableYen: number, rules: CrmPointRules): number {
  const yenPerPoint = Math.max(Number(rules.yenPerPoint) || 1, 1);
  const unit = Math.max(Math.floor(Number(rules.unit) || 1), 1);
  const byPayable = Math.floor(Math.max(0, Number(payableYen) || 0) / yenPerPoint);
  const capped = Math.min(Math.floor(Number(balance) || 0), byPayable);
  return Math.max(0, Math.floor(capped / unit) * unit);
}
