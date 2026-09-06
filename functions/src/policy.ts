// キャンセルポリシー (§11) と顧客マージ (§11) の純粋ロジック。

/**
 * tz でのウォールクロック日時(date+time)を UTC エポックms に変換する。
 * tz ライブラリ不使用。オフセット補正の定石（DST 境界の希なケースは近似）。
 */
export function zonedTimeToEpoch(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi);
  const guessDate = new Date(utcGuess);
  const asTz = new Date(guessDate.toLocaleString('en-US', { timeZone: tz }));
  const asUtc = new Date(guessDate.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offset = asUtc.getTime() - asTz.getTime();
  return utcGuess + offset;
}

/**
 * 予約開始の deadlineHours 前までならキャンセル可 (§11)。
 * nowEpoch <= 開始 - deadline。
 */
export function isCancellableNow(
  nowEpoch: number,
  date: string,
  startTime: string,
  tz: string,
  deadlineHours: number,
): boolean {
  const start = zonedTimeToEpoch(date, startTime, tz);
  return nowEpoch <= start - deadlineHours * 3600_000;
}

export interface Identifiers {
  memberId?: string | null;
  lineUserId?: string | null;
  phone?: string | null;
}

/**
 * source の識別子で target の欠けている項目だけを埋める patch を返す (§3 find-or-link 思想)。
 * 既に target が値を持つ項目は上書きしない。
 */
export function mergeIdentifiers(target: Identifiers, source: Identifiers): Partial<Identifiers> {
  const patch: Partial<Identifiers> = {};
  if (!target.memberId && source.memberId) patch.memberId = source.memberId;
  if (!target.lineUserId && source.lineUserId) patch.lineUserId = source.lineUserId;
  if (!target.phone && source.phone) patch.phone = source.phone;
  return patch;
}
