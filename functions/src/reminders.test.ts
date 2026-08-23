import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildCancelMessage,
  buildConfirmationMessage,
  buildPickupMessage,
  buildReminderMessage,
  buildRescheduleMessage,
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

describe('buildCancelMessage', () => {
  const base = { tenantName: 'GROOM HAUS', dogName: 'ポロ', date: '2026-08-25', startTime: '10:00' };

  it('キャンセルの事実と再予約の案内を入れる', () => {
    const m = buildCancelMessage(base);
    expect(m).toContain('ご予約を取り消しました');
    expect(m).toContain('GROOM HAUS');
    expect(m).toContain('ポロ');
    expect(m).toContain('またご予約をお待ちしております');
  });

  it('無断欠席でも責める書き方にしない', () => {
    const m = buildCancelMessage({ ...base, noshow: true });
    expect(m).toContain('ご来店を確認できなかった');
    // 「無断」「キャンセル料」等の刺さる語を入れない
    expect(m).not.toContain('無断');
    expect(m).not.toContain('ペナルティ');
  });
});

describe('buildRescheduleMessage', () => {
  it('変更前後を並べて誤解を防ぐ', () => {
    const m = buildRescheduleMessage({
      tenantName: 'GROOM HAUS', dogName: 'ポロ',
      beforeDate: '2026-08-25', beforeStartTime: '10:00',
      afterDate: '2026-08-27', afterStartTime: '14:30',
    });
    expect(m).toContain('変更前');
    expect(m).toContain('変更後');
    expect(m).toContain('14:30');
    expect(m.indexOf('変更前')).toBeLessThan(m.indexOf('変更後'));
  });
});

describe('buildPickupMessage', () => {
  it('営業終了時刻が分かれば具体的に書く', () => {
    expect(buildPickupMessage({ tenantName: 'GROOM HAUS', dogName: 'ポロ', closeTime: '19:00' }))
      .toContain('本日 19:00 までにお迎え');
  });

  it('分からなければ「営業時間内」にする', () => {
    const m = buildPickupMessage({ tenantName: 'GROOM HAUS', dogName: 'ポロ' });
    expect(m).toContain('営業時間内にお迎え');
    expect(m).not.toContain('null');
  });
});
