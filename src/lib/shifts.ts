// スタッフ日別シフト（シフト①）のクライアント側ロジック。
// functions/src/shifts.ts と同一規則（実効勤務時間 = シフト∩営業時間、エントリ無し=営業時間どおり）。
// 空き計算はサーバ権威。ここでは表示（シフト外予約の警告バッジ・シフト編集UI）にのみ使う。

export interface TimeInterval {
  start: string; // "HH:MM"
  end: string;
}

/** tenants/{t}/shifts/{date} の staff マップの1エントリ */
export interface ShiftEntry {
  intervals?: TimeInterval[];
}

const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const toStr = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** 2つの時間帯リストの交差（昇順・マージ済み）。サーバの intersectIntervals と同一。 */
export function intersectIntervals(a: TimeInterval[], b: TimeInterval[]): TimeInterval[] {
  const norm = (list: TimeInterval[]) =>
    list
      .map((x) => ({ start: toMin(x.start), end: toMin(x.end) }))
      .filter((x) => x.end > x.start)
      .sort((x, y) => x.start - y.start);
  const out: { start: number; end: number }[] = [];
  for (const ia of norm(a)) {
    for (const ib of norm(b)) {
      const start = Math.max(ia.start, ib.start);
      const end = Math.min(ia.end, ib.end);
      if (end > start) out.push({ start, end });
    }
  }
  out.sort((x, y) => x.start - y.start);
  const merged: { start: number; end: number }[] = [];
  for (const o of out) {
    const last = merged[merged.length - 1];
    if (last && o.start <= last.end) last.end = Math.max(last.end, o.end);
    else merged.push({ ...o });
  }
  return merged.map((x) => ({ start: toStr(x.start), end: toStr(x.end) }));
}

/** その日のスタッフの実効勤務時間帯。エントリ無し=営業時間どおり、intervals:[]=終日休み。 */
export function staffHoursFor(
  staffMap: Record<string, ShiftEntry> | undefined | null,
  staffId: string,
  businessHours: TimeInterval[],
): TimeInterval[] {
  const entry = staffMap?.[staffId];
  if (!entry) return businessHours;
  const intervals = Array.isArray(entry.intervals) ? entry.intervals : [];
  return intersectIntervals(intervals, businessHours);
}

/** 予約 [startTime, endTime) が勤務時間帯に収まっているか（シフト外予約の警告判定）。 */
export function isWithinHours(hours: TimeInterval[], startTime: string, endTime: string): boolean {
  return intersectIntervals(hours, [{ start: startTime, end: endTime }]).some(
    (iv) => iv.start === startTime && iv.end === endTime,
  );
}
