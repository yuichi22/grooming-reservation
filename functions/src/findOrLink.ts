// find-or-link（§3）の純粋ロジック。
// 取得できた識別子(lineUserId / phone)で既存会員を照合し、一致したら識別子を「追加」、
// なければ新規作成する。書き込みは呼び出し側が行う（ここは決定のみ）。

export interface CustomerIdentifiers {
  id: string;
  lineUserId?: string | null;
  phone?: string | null;
}

export interface Incoming {
  lineUserId?: string | null;
  phone?: string | null;
}

export type LinkDecision =
  | { action: 'found'; customerId: string }
  | { action: 'link'; customerId: string; addLineUserId?: string; addPhone?: string }
  | { action: 'create' };

/**
 * §3 の照合ルール:
 *  1) lineUserId 一致 → found（必要なら phone を追加リンク）
 *  2) phone 一致 → link（lineUserId を追加）
 *  3) どちらも無し → create
 */
export function resolveLink(existing: CustomerIdentifiers[], incoming: Incoming): LinkDecision {
  const { lineUserId, phone } = incoming;

  if (lineUserId) {
    const byLine = existing.find((c) => c.lineUserId && c.lineUserId === lineUserId);
    if (byLine) {
      // 既に LINE で確定済み。phone 未登録なら今回の phone を補完。
      if (phone && !byLine.phone) {
        return { action: 'link', customerId: byLine.id, addPhone: phone };
      }
      return { action: 'found', customerId: byLine.id };
    }
  }

  if (phone) {
    const byPhone = existing.find((c) => c.phone && c.phone === phone);
    if (byPhone) {
      // 電話で既存会員にヒット → lineUserId を束ねる（新規作成しない）
      return {
        action: 'link',
        customerId: byPhone.id,
        addLineUserId: lineUserId && !byPhone.lineUserId ? lineUserId : undefined,
      };
    }
  }

  return { action: 'create' };
}
