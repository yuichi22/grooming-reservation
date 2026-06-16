// 予約スロット計算（§6）— サーバ権威での空き計算・予約検証に使う。
// クライアント src/lib/slots.ts と同一アルゴリズム。parity は slots.test.ts で担保。

export interface TimeInterval {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

export function toMinutes(t: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) throw new Error(`invalid time string: ${t}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`invalid time string: ${t}`);
  return h * 60 + min;
}

export function toTimeStr(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

interface Interval {
  start: number;
  end: number;
}

/** 実効作業時間 (§6): 固定メニューは標準時間、それ以外は犬の確定時間 ?? 標準時間。 */
export function effectiveDuration(
  confirmedDurationMin: number | null,
  menu: { defaultDurationMin: number; fixedDuration: boolean },
): number {
  if (menu.fixedDuration) return menu.defaultDurationMin;
  return confirmedDurationMin ?? menu.defaultDurationMin;
}

function subtractOccupied(business: Interval[], occupied: Interval[]): Interval[] {
  const occ = [...occupied].filter((o) => o.end > o.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const o of occ) {
    const last = merged[merged.length - 1];
    if (last && o.start <= last.end) last.end = Math.max(last.end, o.end);
    else merged.push({ ...o });
  }

  const gaps: Interval[] = [];
  for (const b of business) {
    let cursor = b.start;
    for (const o of merged) {
      if (o.end <= cursor || o.start >= b.end) continue;
      const segStart = Math.max(cursor, b.start);
      const segEnd = Math.min(o.start, b.end);
      if (segEnd > segStart) gaps.push({ start: segStart, end: segEnd });
      cursor = Math.max(cursor, o.end);
    }
    if (cursor < b.end) gaps.push({ start: Math.max(cursor, b.start), end: b.end });
  }
  return gaps;
}

export interface AvailabilityArgs {
  businessHours: TimeInterval[];
  bufferMin: number;
  /** 実効作業時間（effectiveDuration の結果） */
  durationMin: number;
  /** 対象スコープの占有区間（slotEnd 込み） */
  occupied: TimeInterval[];
  gridStep?: number;
}

/** 空き開始時刻の一覧 (§6) */
export function availability(args: AvailabilityArgs): string[] {
  const { businessHours, bufferMin, durationMin, occupied, gridStep = 15 } = args;
  const need = durationMin + bufferMin;

  const business: Interval[] = businessHours.map((b) => ({ start: toMinutes(b.start), end: toMinutes(b.end) }));
  const occ: Interval[] = occupied.map((o) => ({ start: toMinutes(o.start), end: toMinutes(o.end) }));
  const gaps = subtractOccupied(business, occ);

  const starts: number[] = [];
  for (const gap of gaps) {
    for (let s = gap.start; s + need <= gap.end; s += gridStep) starts.push(s);
  }
  starts.sort((a, b) => a - b);
  return starts.map(toTimeStr);
}

/** 複数開始時刻リストの和集合（昇順・重複排除）。指名なし時の全スタッフ和集合 (§8)。 */
export function unionStarts(lists: string[][]): string[] {
  const set = new Set<string>();
  for (const l of lists) for (const s of l) set.add(s);
  return [...set].sort((a, b) => toMinutes(a) - toMinutes(b));
}
