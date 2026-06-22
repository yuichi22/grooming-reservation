import { describe, expect, it } from 'vitest';
import { availability, effectiveDuration, unionStarts } from './slots';

// クライアント src/lib/slots.test.ts と同じ §6 の例でサーバ側ロジックの parity を確認。
// 営業 9:00–13:00 / バッファ 10分 / 9:00–10:00, 11:00–13:00 予約済 → 空きは 10:00–11:00。

const businessHours = [{ start: '09:00', end: '13:00' }];
const occupied = [
  { start: '09:00', end: '10:00' },
  { start: '11:00', end: '13:00' },
];

describe('effectiveDuration (§6)', () => {
  it('固定メニューは確定時間を無視', () => {
    expect(effectiveDuration(80, { defaultDurationMin: 50, fixedDuration: true })).toBe(50);
  });
  it('非固定は確定時間優先、null は標準', () => {
    expect(effectiveDuration(50, { defaultDurationMin: 80, fixedDuration: false })).toBe(50);
    expect(effectiveDuration(null, { defaultDurationMin: 80, fixedDuration: false })).toBe(80);
  });
});

describe('availability (§6 の例)', () => {
  it('50分(need=60)は 10:00 が出る', () => {
    expect(availability({ businessHours, bufferMin: 10, durationMin: 50, occupied })).toEqual(['10:00']);
  });
  it('80分(need=90)は出ない', () => {
    expect(availability({ businessHours, bufferMin: 10, durationMin: 80, occupied })).toEqual([]);
  });
  it('シャンプー固定50分なら 80分の犬でも 10:00 が出る', () => {
    const d = effectiveDuration(80, { defaultDurationMin: 50, fixedDuration: true });
    expect(availability({ businessHours, bufferMin: 10, durationMin: d, occupied })).toEqual(['10:00']);
  });
  it('開始時刻は絶対15分グリッドに丸める（隙間の半端な開始は出さない）', () => {
    // 営業 9:00–12:00 / 9:00–9:40 予約済 → 隙間 9:40–12:00。30分は 9:45 始まり。
    const bh = [{ start: '09:00', end: '12:00' }];
    const occ = [{ start: '09:00', end: '09:40' }];
    const slots = availability({ businessHours: bh, bufferMin: 0, durationMin: 30, occupied: occ });
    expect(slots[0]).toBe('09:45');
    expect(slots.every((s) => Number(s.slice(3)) % 15 === 0)).toBe(true);
  });
});

describe('unionStarts (§8 指名なしの和集合)', () => {
  it('複数スタッフの空きを昇順・重複排除で結合', () => {
    expect(unionStarts([['10:00', '10:15'], ['10:15', '11:00'], []])).toEqual(['10:00', '10:15', '11:00']);
  });
});
