import { describe, expect, it } from 'vitest';
import { intersectIntervals } from './slots';
import { isWithinHours, staffHoursFor } from './shifts';

const BH = [{ start: '09:00', end: '19:00' }];

describe('intersectIntervals（シフト∩営業時間）', () => {
  it('部分重なりは重なった区間だけ返す', () => {
    expect(intersectIntervals([{ start: '13:00', end: '21:00' }], BH)).toEqual([{ start: '13:00', end: '19:00' }]);
  });
  it('重ならなければ空', () => {
    expect(intersectIntervals([{ start: '20:00', end: '22:00' }], BH)).toEqual([]);
  });
  it('複数区間（中抜けシフト）も交差できる', () => {
    expect(
      intersectIntervals(
        [
          { start: '08:00', end: '12:00' },
          { start: '15:00', end: '20:00' },
        ],
        BH,
      ),
    ).toEqual([
      { start: '09:00', end: '12:00' },
      { start: '15:00', end: '19:00' },
    ]);
  });
});

describe('staffHoursFor（シフト①の実効勤務時間）', () => {
  it('シフトdoc無し/エントリ無し = 営業時間どおり（既存互換）', () => {
    expect(staffHoursFor(null, 's1', BH)).toEqual(BH);
    expect(staffHoursFor({ staff: { other: { intervals: [] } } }, 's1', BH)).toEqual(BH);
  });
  it('intervals: [] = 終日休み', () => {
    expect(staffHoursFor({ staff: { s1: { intervals: [] } } }, 's1', BH)).toEqual([]);
  });
  it('work:true = 出勤を明示確定（営業時間どおり。intervalsが残っていても優先）', () => {
    expect(staffHoursFor({ staff: { s1: { work: true } } }, 's1', BH)).toEqual(BH);
    expect(staffHoursFor({ staff: { s1: { work: true, intervals: [] } } }, 's1', BH)).toEqual(BH);
  });
  it('半休（午後出勤）は営業時間と交差した区間になる', () => {
    expect(staffHoursFor({ staff: { s1: { intervals: [{ start: '13:00', end: '19:00' }] } } }, 's1', BH)).toEqual([
      { start: '13:00', end: '19:00' },
    ]);
  });
  it('営業時間外にはみ出したシフトはクランプされる', () => {
    expect(staffHoursFor({ staff: { s1: { intervals: [{ start: '07:00', end: '12:00' }] } } }, 's1', BH)).toEqual([
      { start: '09:00', end: '12:00' },
    ]);
  });
});

describe('isWithinHours（シフト外予約の警告判定）', () => {
  const hours = [{ start: '13:00', end: '19:00' }];
  it('勤務内に収まる予約は true', () => {
    expect(isWithinHours(hours, '13:00', '14:30')).toBe(true);
  });
  it('勤務外にかかる予約は false（半休の午前に食い込む等）', () => {
    expect(isWithinHours(hours, '12:30', '14:00')).toBe(false);
    expect(isWithinHours([], '10:00', '11:00')).toBe(false);
  });
});
