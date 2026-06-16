// 前日リマインド (§9) の純粋ロジック。

/** 指定タイムゾーンでの「その時刻の日付」を YYYY-MM-DD で返す。 */
export function dateStrInTimeZone(date: Date, timeZone: string): string {
  // en-CA ロケールは YYYY-MM-DD 形式
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** YYYY-MM-DD に日数を加算（UTC 基準の純粋計算）。 */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** tz における「翌日」の日付文字列。リマインド対象日 (§9)。 */
export function tomorrowInTimeZone(now: Date, timeZone: string): string {
  return addDays(dateStrInTimeZone(now, timeZone), 1);
}

export interface ReminderContext {
  tenantName: string;
  dogName: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
}

/**
 * リマインド文面 (§9: 無断キャンセル抑制)。
 * 注: 確定文面・送信時刻は §11 で要調整。ここは暫定テンプレート。
 */
export function buildReminderMessage(ctx: ReminderContext): string {
  return (
    `【${ctx.tenantName}】明日 ${ctx.date} ${ctx.startTime} に ` +
    `${ctx.dogName} ちゃんのトリミングのご予約があります。お気をつけてお越しください。`
  );
}
