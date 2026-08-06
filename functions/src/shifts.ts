// スタッフ日別シフト（シフト①）。
// tenants/{tenantId}/shifts/{date} = { staff: { [staffId]: { intervals: [{start,end}] } } }
// - スタッフのエントリが無い日 = 拠点の営業時間どおり出勤（既存テナント互換）
// - intervals: [] = 終日休み / 部分区間 = 半休・時短
// - 実効勤務時間は常に拠点営業時間との交差（営業時間外のシフトは無効）
// 拠点全体の休業は従来どおり closures が最優先（シフト以前に弾かれる）。
// シフト変更でシフト外になった既存予約は強制せず、管理画面の警告バッジのみ（運用で振替）。
import { intersectIntervals, type TimeInterval } from './slots.js';

/** shifts/{date} ドキュメントの形 */
export interface ShiftDay {
  staff?: Record<string, { intervals?: TimeInterval[] }>;
}

/**
 * その日のスタッフの実効勤務時間帯（純粋関数）。
 * シフト未設定なら営業時間そのまま、設定があれば 営業時間∩シフト。
 */
export function staffHoursFor(
  shiftDay: ShiftDay | null | undefined,
  staffId: string,
  businessHours: TimeInterval[],
): TimeInterval[] {
  const entry = shiftDay?.staff?.[staffId];
  if (!entry) return businessHours;
  const intervals = Array.isArray(entry.intervals) ? entry.intervals : [];
  return intersectIntervals(intervals, businessHours);
}

/** 予約 [startTime, endTime) がスタッフの勤務時間帯に収まっているか（警告バッジ判定と同じ規則）。 */
export function isWithinHours(hours: TimeInterval[], startTime: string, endTime: string): boolean {
  return intersectIntervals(hours, [{ start: startTime, end: endTime }]).some(
    (iv) => iv.start === startTime && iv.end === endTime,
  );
}
