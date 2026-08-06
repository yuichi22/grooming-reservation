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
    // 開始時刻は絶対 15分グリッド（:00/:15/:30/:45）に丸める。隙間の途中の半端な時刻は出さない。
    const first = Math.ceil(gap.start / gridStep) * gridStep;
    for (let s = first; s + need <= gap.end; s += gridStep) starts.push(s);
  }
  starts.sort((a, b) => a - b);
  return starts.map(toTimeStr);
}

/**
 * 2つの時間帯リストの交差（シフト∩営業時間）。シフト①: スタッフの実効勤務時間の算出に使う。
 * どちらも "HH:MM" 区間の配列。結果は昇順・重複マージ済み。
 */
export function intersectIntervals(a: TimeInterval[], b: TimeInterval[]): TimeInterval[] {
  const norm = (list: TimeInterval[]): Interval[] =>
    list
      .map((x) => ({ start: toMinutes(x.start), end: toMinutes(x.end) }))
      .filter((x) => x.end > x.start)
      .sort((x, y) => x.start - y.start);
  const out: Interval[] = [];
  for (const ia of norm(a)) {
    for (const ib of norm(b)) {
      const start = Math.max(ia.start, ib.start);
      const end = Math.min(ia.end, ib.end);
      if (end > start) out.push({ start, end });
    }
  }
  out.sort((x, y) => x.start - y.start);
  const merged: Interval[] = [];
  for (const o of out) {
    const last = merged[merged.length - 1];
    if (last && o.start <= last.end) last.end = Math.max(last.end, o.end);
    else merged.push({ ...o });
  }
  return merged.map((x) => ({ start: toTimeStr(x.start), end: toTimeStr(x.end) }));
}

/** 営業時間から占有を引いた「空き区間」（分・昇順）。 */
export function freeIntervals(businessHours: TimeInterval[], occupied: TimeInterval[]): Interval[] {
  const business: Interval[] = businessHours.map((b) => ({ start: toMinutes(b.start), end: toMinutes(b.end) }));
  const occ: Interval[] = occupied.map((o) => ({ start: toMinutes(o.start), end: toMinutes(o.end) }));
  return subtractOccupied(business, occ);
}

/**
 * 複数頭を fromMin 以降の空き区間に「順番に」詰める（連続できなければ既存予約の合間に分割）。
 * - durations: 各頭の所要時間（分・順序どおり）。
 * - lastBuffer: 最後の頭にだけ足す占有（メニューのバッファ）。頭間にはバッファを入れない。
 * - 返り: 各頭の開始分 starts と、最後の頭の施術終了分 finishMin（バッファ除く）。配置不能なら null。
 */
export function packDogs(
  gaps: Interval[],
  durations: number[],
  lastBuffer: number,
  fromMin: number,
): { starts: number[]; finishMin: number } | null {
  if (durations.length === 0) return null;
  let cursor = fromMin;
  const starts: number[] = [];
  for (let i = 0; i < durations.length; i++) {
    const need = durations[i] + (i === durations.length - 1 ? lastBuffer : 0);
    let placed: number | null = null;
    for (const g of gaps) {
      const s = Math.max(g.start, cursor);
      if (s + need <= g.end) {
        placed = s;
        break;
      }
    }
    if (placed == null) return null;
    starts.push(placed);
    cursor = placed + durations[i]; // 次の頭は施術直後から（バッファは末尾のみ占有）
  }
  return { starts, finishMin: starts[starts.length - 1] + durations[durations.length - 1] };
}

/** 複数開始時刻リストの和集合（昇順・重複排除）。指名なし時の全スタッフ和集合 (§8)。 */
export function unionStarts(lists: string[][]): string[] {
  const set = new Set<string>();
  for (const l of lists) for (const s of l) set.add(s);
  return [...set].sort((a, b) => toMinutes(a) - toMinutes(b));
}
