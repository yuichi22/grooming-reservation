// 予約スロット計算（コアロジック, §6）
import type { Booking, BusinessHours, Dog, Menu, TenantSettings, TimeStr } from './types';

// ---- 時刻ユーティリティ ("HH:MM" ↔ 分) ----

/** "HH:MM" → 0:00 からの経過分。不正な入力は例外。 */
export function toMinutes(t: TimeStr): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) throw new Error(`invalid time string: ${t}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`invalid time string: ${t}`);
  return h * 60 + min;
}

/** 経過分 → "HH:MM" */
export function toTimeStr(min: number): TimeStr {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

interface Interval {
  start: number; // 分
  end: number; // 分
}

/**
 * 実効作業時間 (§6)。
 * 固定メニュー → メニュー標準時間。
 * それ以外 → 犬の confirmedDurationMin、なければメニュー標準時間。
 */
export function effectiveDuration(dog: Pick<Dog, 'confirmedDurationMin'>, menu: Menu): number {
  if (menu.fixedDuration) return menu.defaultDurationMin;
  return dog.confirmedDurationMin ?? menu.defaultDurationMin;
}

/** 営業時間区間から占有区間を引いた空き gap を返す。 */
function subtractOccupied(business: Interval[], occupied: Interval[]): Interval[] {
  // 占有をマージ（重なり・隣接を結合）
  const occ = [...occupied].filter((o) => o.end > o.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const o of occ) {
    const last = merged[merged.length - 1];
    if (last && o.start <= last.end) {
      last.end = Math.max(last.end, o.end);
    } else {
      merged.push({ ...o });
    }
  }

  const gaps: Interval[] = [];
  for (const b of business) {
    let cursor = b.start;
    for (const o of merged) {
      if (o.end <= cursor || o.start >= b.end) continue; // この営業区間と無関係
      const segStart = Math.max(cursor, b.start);
      const segEnd = Math.min(o.start, b.end);
      if (segEnd > segStart) gaps.push({ start: segStart, end: segEnd });
      cursor = Math.max(cursor, o.end);
    }
    if (cursor < b.end) gaps.push({ start: Math.max(cursor, b.start), end: b.end });
  }
  return gaps;
}

export interface AvailabilityParams {
  settings: Pick<TenantSettings, 'businessHours' | 'bufferMin'>;
  dog: Pick<Dog, 'confirmedDurationMin'>;
  menu: Menu;
  /** 対象スタッフスコープの既存予約 (reserved 等の占有分)。slotEnd 込み (§6/§8) */
  bookings: Pick<Booking, 'startTime' | 'slotEnd'>[];
  /** グリッド刻み（分）。既定 15 (§6) */
  gridStep?: number;
}

/**
 * 空きスロット開始時刻の一覧を返す (§6)。
 * need = effectiveDuration + bufferMin。
 * 各空き gap に対し gap.start ≤ start かつ start + need ≤ gap.end を満たす start を
 * gridStep 刻みで列挙する。
 */
export function availability(params: AvailabilityParams): TimeStr[] {
  const { settings, dog, menu, bookings, gridStep = 15 } = params;

  const need = effectiveDuration(dog, menu) + settings.bufferMin;

  const business: Interval[] = settings.businessHours.map((b: BusinessHours) => ({
    start: toMinutes(b.start),
    end: toMinutes(b.end),
  }));
  const occupied: Interval[] = bookings.map((b) => ({
    start: toMinutes(b.startTime),
    end: toMinutes(b.slotEnd),
  }));

  const gaps = subtractOccupied(business, occupied);

  const starts: number[] = [];
  for (const gap of gaps) {
    // gap.start から gridStep 刻みで、終端が gap.end を超えない開始時刻を出力
    for (let s = gap.start; s + need <= gap.end; s += gridStep) {
      starts.push(s);
    }
  }
  starts.sort((a, b) => a - b);
  return starts.map(toTimeStr);
}
