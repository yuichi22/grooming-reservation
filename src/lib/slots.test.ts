import { describe, expect, it } from 'vitest';
import { availability, effectiveDuration, toMinutes, toTimeStr } from './slots';
import type { Booking, Dog, Menu } from './types';

// §6 の例:
//   営業 9:00–13:00 / バッファ 10分。
//   9:00–10:00 と 11:00–13:00 が予約済 → 空きは 10:00–11:00 の 60分枠のみ。
//   50分の犬 (need=60) は 10:00 が出る / 80分の犬 (need=90) は出ない /
//   シャンプー(50分固定) なら 80分の犬でも 10:00 が出る。

const settings = {
  businessHours: [{ start: '09:00', end: '13:00' }],
  bufferMin: 10,
};

// 占有は slotEnd 込み（既存予約が確保している範囲そのもの）
const bookings: Pick<Booking, 'startTime' | 'slotEnd'>[] = [
  { startTime: '09:00', slotEnd: '10:00' },
  { startTime: '11:00', slotEnd: '13:00' },
];

const trimMenu: Menu = {
  id: 'trim',
  name: 'カット',
  defaultDurationMin: 80,
  fixedDuration: false,
  price: 5500,
  active: true,
};

const shampooMenu: Menu = {
  id: 'shampoo',
  name: 'シャンプー',
  defaultDurationMin: 50, // 50分固定
  fixedDuration: true,
  price: 3300,
  active: true,
};

const dog50: Pick<Dog, 'confirmedDurationMin'> = { confirmedDurationMin: 50 };
const dog80: Pick<Dog, 'confirmedDurationMin'> = { confirmedDurationMin: 80 };

describe('時刻ユーティリティ', () => {
  it('toMinutes / toTimeStr が往復する', () => {
    expect(toMinutes('10:00')).toBe(600);
    expect(toMinutes('09:15')).toBe(555);
    expect(toTimeStr(600)).toBe('10:00');
    expect(toTimeStr(555)).toBe('09:15');
  });
});

describe('effectiveDuration (§6)', () => {
  it('固定メニューは犬の確定時間を無視して標準時間を使う', () => {
    expect(effectiveDuration(dog80, shampooMenu)).toBe(50);
  });
  it('非固定メニューは犬の confirmedDurationMin を優先する', () => {
    expect(effectiveDuration(dog50, trimMenu)).toBe(50);
    expect(effectiveDuration(dog80, trimMenu)).toBe(80);
  });
  it('confirmedDurationMin が null ならメニュー標準時間にフォールバック', () => {
    expect(effectiveDuration({ confirmedDurationMin: null }, trimMenu)).toBe(80);
  });
});

describe('availability — §6 の例（10:00–11:00 の 60分枠）', () => {
  it('50分の犬 (need=60) は 10:00 枠が出る', () => {
    const slots = availability({ settings, dog: dog50, menu: trimMenu, bookings });
    expect(slots).toEqual(['10:00']);
  });

  it('80分の犬 (need=90) は枠が出ない', () => {
    const slots = availability({ settings, dog: dog80, menu: trimMenu, bookings });
    expect(slots).toEqual([]);
  });

  it('シャンプー(50分固定) なら 80分の犬でも 10:00 枠が出る', () => {
    const slots = availability({ settings, dog: dog80, menu: shampooMenu, bookings });
    expect(slots).toEqual(['10:00']);
  });
});

describe('availability — 補助ケース', () => {
  it('予約が無ければ営業時間全体から枠が並ぶ（need=60, grid=15）', () => {
    const slots = availability({
      settings,
      dog: dog50,
      menu: trimMenu,
      bookings: [],
    });
    // 9:00 開始で最終は 12:00 開始 (12:00+60=13:00)。15分刻み。
    expect(slots[0]).toBe('09:00');
    expect(slots[slots.length - 1]).toBe('12:00');
    expect(slots).toContain('11:00');
  });

  it('グリッド刻みを変えられる（grid=30 で 10:00 のみ）', () => {
    const slots = availability({ settings, dog: dog50, menu: trimMenu, bookings, gridStep: 30 });
    expect(slots).toEqual(['10:00']);
  });
});
