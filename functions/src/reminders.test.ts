import { describe, expect, it } from 'vitest';
import { addDays, buildReminderMessage, dateStrInTimeZone, tomorrowInTimeZone } from './reminders';

describe('日付計算 (§9)', () => {
  it('addDays は月跨ぎ・うるう年を正しく扱う', () => {
    expect(addDays('2026-06-20', 1)).toBe('2026-06-21');
    expect(addDays('2026-06-30', 1)).toBe('2026-07-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('dateStrInTimeZone は tz を反映する', () => {
    // 2026-06-20T16:30:00Z は Asia/Tokyo では 翌日 01:30
    const d = new Date('2026-06-20T16:30:00Z');
    expect(dateStrInTimeZone(d, 'Asia/Tokyo')).toBe('2026-06-21');
    expect(dateStrInTimeZone(d, 'UTC')).toBe('2026-06-20');
  });

  it('tomorrowInTimeZone は tz の翌日を返す', () => {
    const d = new Date('2026-06-20T10:00:00Z'); // JST 19:00
    expect(tomorrowInTimeZone(d, 'Asia/Tokyo')).toBe('2026-06-21');
  });
});

describe('文面 (§9)', () => {
  it('暫定テンプレートを組み立てる', () => {
    expect(
      buildReminderMessage({ tenantName: 'GROOM HAUS', dogName: 'ポチ', date: '2026-06-21', startTime: '11:00' }),
    ).toBe('【GROOM HAUS】明日 2026-06-21 11:00 に ポチ ちゃんのトリミングのご予約があります。お気をつけてお越しください。');
  });
});
