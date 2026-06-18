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

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** YYYY-MM-DD → "6/22（日）"。曜日は日付要素から純粋計算（tz 非依存）。 */
export function formatDateJa(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = WEEKDAY_JA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}（${wd}）`;
}

/** 店舗情報（任意）。設定済みの項目だけメッセージに出す。 */
export interface StoreInfo {
  address?: string | null;
  mapUrl?: string | null;
  phone?: string | null;
  cancelDeadlineHours?: number | null;
}

function storeLines(s: StoreInfo): string[] {
  const out: string[] = [];
  if (s.address) out.push(`📍 ${s.address}`);
  if (s.mapUrl) out.push(`🗺 ${s.mapUrl}`);
  if (s.phone) out.push(`☎ ${s.phone}`);
  return out;
}

function cancelLine(s: StoreInfo): string {
  const h = s.cancelDeadlineHours ?? 24;
  const tel = s.phone ? `お電話（☎${s.phone}）` : 'お電話';
  return `❌ キャンセル・変更はご予約の${h}時間前までに、${tel}またはこのトークからご連絡ください。`;
}

export interface ReminderContext extends StoreInfo {
  tenantName: string;
  dogName: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
}

/** 前日リマインド文面 (§9: 無断キャンセル抑制)。絵文字・店舗情報・キャンセル案内入り。 */
export function buildReminderMessage(ctx: ReminderContext): string {
  const lines = [
    '🐾 明日のご予約のリマインドです',
    '',
    `【${ctx.tenantName}】`,
    `📅 明日 ${formatDateJa(ctx.date)} ${ctx.startTime}〜`,
    `🐶 ${ctx.dogName} ちゃん`,
  ];
  const store = storeLines(ctx);
  if (store.length) lines.push('', ...store);
  lines.push('', cancelLine(ctx), '', 'お気をつけてお越しください😊');
  return lines.join('\n');
}

export interface ConfirmationContext extends StoreInfo {
  tenantName: string;
  dogName: string;
  menuName: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  slotEnd: string; // HH:MM
}

/** 予約完了メッセージ（予約成立直後・リマインドとは別）。絵文字・店舗情報・キャンセル案内入り。 */
export function buildConfirmationMessage(ctx: ConfirmationContext): string {
  const lines = [
    '🐾 ご予約ありがとうございます！',
    '',
    `【${ctx.tenantName}】`,
    `📅 ${formatDateJa(ctx.date)} ${ctx.startTime}〜${ctx.slotEnd}`,
    `🐶 ${ctx.dogName} ちゃん / ${ctx.menuName}`,
  ];
  const store = storeLines(ctx);
  if (store.length) lines.push('', ...store);
  lines.push('', cancelLine(ctx), '', 'ご来店をお待ちしております😊');
  return lines.join('\n');
}
