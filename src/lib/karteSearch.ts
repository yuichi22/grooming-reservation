// カルテ一覧の検索。犬の名前（ふりがな含む）・飼い主名・電話番号の部分一致。

/** 比較用に正規化: 全角/半角を揃え(NFKC)、カタカナ→ひらがな、小文字化、空白除去 */
export function normalizeSearch(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKC')
    .replace(/[ァ-ヶ]/g, (c) => String.fromCodePoint(c.codePointAt(0)! - 0x60))
    .toLowerCase()
    .replace(/\s+/g, '');
}

export interface KarteSearchTarget {
  name: string;
  nameKana?: string | null;
  ownerName?: string | null;
  phone?: string | null;
}

/**
 * 検索語に一致するか。空の検索語は全件一致。
 * 電話番号はハイフン等を無視して数字で比べる（「090-1234」でも「0901234」でも当たる）。
 */
export function matchesKarteQuery(t: KarteSearchTarget, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  if ([t.name, t.nameKana, t.ownerName].some((v) => normalizeSearch(v).includes(q))) return true;
  const qDigits = q.replace(/\D/g, '');
  // 数字以外を含む語（名前検索）で電話を当てない。区切り記号だけは許す
  if (qDigits && /^[\d\-()+.]+$/.test(q)) {
    return (t.phone ?? '').normalize('NFKC').replace(/\D/g, '').includes(qDigits);
  }
  return false;
}
