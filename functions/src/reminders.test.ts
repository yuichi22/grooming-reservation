import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildConfirmationMessage,
  buildReminderMessage,
  dateStrInTimeZone,
  formatDateJa,
  tomorrowInTimeZone,
} from './reminders';

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

describe('formatDateJa', () => {
  it('M/D（曜）形式・曜日が正しい', () => {
    expect(formatDateJa('2026-06-21')).toBe('6/21（日）');
    expect(formatDateJa('2026-06-22')).toBe('6/22（月）');
  });
});

describe('文面 (§9 / 予約完了)', () => {
  const store = {
    address: '島根県松江市〇〇1-2-3',
    mapUrl: 'https://maps.google.com/?q=groomhaus',
    phone: '0852-00-0000',
    cancelDeadlineHours: 24,
  };

  it('リマインド: 絵文字・曜日・店舗情報・キャンセル案内を含む', () => {
    const msg = buildReminderMessage({
      tenantName: 'GROOM HAUS',
      dogName: 'ポチ',
      date: '2026-06-21',
      startTime: '11:00',
      ...store,
    });
    expect(msg).toContain('🐾 明日のご予約のリマインド');
    expect(msg).toContain('📅 明日 6/21（日） 11:00〜');
    expect(msg).toContain('🐶 ポチ ちゃん');
    expect(msg).toContain('📍 島根県松江市〇〇1-2-3');
    expect(msg).toContain('🗺 https://maps.google.com/?q=groomhaus');
    expect(msg).toContain('❌ キャンセル・変更はご予約の24時間前までに、お電話（☎0852-00-0000）');
  });

  it('予約完了: 絵文字・店舗情報・キャンセル案内を含む', () => {
    const msg = buildConfirmationMessage({
      tenantName: 'GROOM HAUS',
      dogName: 'ポチ',
      menuName: 'シャンプー',
      date: '2026-06-22',
      startTime: '10:00',
      slotEnd: '11:00',
      ...store,
    });
    expect(msg).toContain('🐾 ご予約ありがとうございます！');
    expect(msg).toContain('📅 6/22（月） 10:00〜11:00');
    expect(msg).toContain('🐶 ポチ ちゃん / シャンプー');
    expect(msg).toContain('📍 島根県松江市〇〇1-2-3');
    expect(msg).toContain('ご来店をお待ちしております😊');
  });

  it('店舗情報が未設定なら 📍 行は出ない（電話なしのキャンセル文）', () => {
    const msg = buildConfirmationMessage({
      tenantName: 'GROOM HAUS',
      dogName: 'ポチ',
      menuName: 'シャンプー',
      date: '2026-06-22',
      startTime: '10:00',
      slotEnd: '11:00',
    });
    expect(msg).not.toContain('📍');
    expect(msg).not.toContain('🗺');
    expect(msg).toContain('❌ キャンセル・変更はご予約の24時間前までに、お電話またはこのトークから');
  });
});
