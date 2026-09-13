// 五十音ユーティリティ。カルテ一覧と予約作成のワンちゃん選択で並び順を揃えるためここに集約。
// 五十音インデックス（名前の先頭文字→行）。カタカナはひらがなに正規化して判定。
export const KANA_ROWS: [string, string][] = [
  ['あ', 'あいうえおぁぃぅぇぉ'],
  ['か', 'かきくけこがぎぐげご'],
  ['さ', 'さしすせそざじずぜぞ'],
  ['た', 'たちつてとだぢづでどっ'],
  ['な', 'なにぬねの'],
  ['は', 'はひふへほばびぶべぼぱぴぷぺぽ'],
  ['ま', 'まみむめも'],
  ['や', 'やゆよゃゅょ'],
  ['ら', 'らりるれろ'],
  ['わ', 'わをんゎ'],
];
export const ROW_ORDER = [...KANA_ROWS.map(([label]) => label), '他'];
export function kanaRow(name: string): string {
  let c = (name ?? '').trim().charAt(0);
  if (!c) return '他';
  const code = c.codePointAt(0)!;
  if (code >= 0x30a1 && code <= 0x30f6) c = String.fromCodePoint(code - 0x60); // カタカナ→ひらがな
  for (const [label, set] of KANA_ROWS) if (set.includes(c)) return label;
  return '他'; // 漢字・英数字・記号など
}
/** 漢字（CJK統合漢字・拡張A・繰返し記号）を含むか。含む場合はふりがな必須にする。 */
export function hasKanji(s: string): boolean {
  return /[㐀-䶿一-鿿豈-﫿々〆]/.test(s ?? '');
}

/** 名簿の索引キー。漢字名はふりがなで引く */
export function kanaKey(name: string, nameKana?: string | null): string {
  return (nameKana ?? '').trim() || name;
}

/** 五十音行でグループ化し、行内をキーの五十音順に並べる */
export function kanaGroups<T>(items: T[], key: (item: T) => string): { row: string; items: T[] }[] {
  const byRow = new Map<string, T[]>();
  for (const it of items) {
    const r = kanaRow(key(it));
    if (!byRow.has(r)) byRow.set(r, []);
    byRow.get(r)!.push(it);
  }
  for (const arr of byRow.values()) arr.sort((a, b) => key(a).localeCompare(key(b), 'ja'));
  return ROW_ORDER.filter((r) => byRow.has(r)).map((r) => ({ row: r, items: byRow.get(r)! }));
}
