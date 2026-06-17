import { describe, expect, it } from 'vitest';
import { isCancellableNow, mergeIdentifiers, zonedTimeToEpoch } from './policy';

describe('zonedTimeToEpoch (§11)', () => {
  it('JST のウォールクロックを UTC エポックに変換', () => {
    // 2026-06-22 11:00 JST = 2026-06-22 02:00 UTC
    expect(zonedTimeToEpoch('2026-06-22', '11:00', 'Asia/Tokyo')).toBe(Date.parse('2026-06-22T02:00:00Z'));
  });
});

describe('isCancellableNow (§11 キャンセル締切)', () => {
  const date = '2026-06-22';
  const start = '11:00'; // JST → 02:00Z
  const tz = 'Asia/Tokyo';

  it('締切(24h前)より前ならキャンセル可', () => {
    const now = Date.parse('2026-06-21T01:00:00Z'); // 開始25h前
    expect(isCancellableNow(now, date, start, tz, 24)).toBe(true);
  });

  it('締切を過ぎていればキャンセル不可', () => {
    const now = Date.parse('2026-06-21T03:00:00Z'); // 開始23h前
    expect(isCancellableNow(now, date, start, tz, 24)).toBe(false);
  });

  it('ちょうど締切時刻は可（境界）', () => {
    const now = Date.parse('2026-06-21T02:00:00Z'); // 開始24h前ちょうど
    expect(isCancellableNow(now, date, start, tz, 24)).toBe(true);
  });
});

describe('mergeIdentifiers (§11 手動マージ)', () => {
  it('target の欠けている識別子だけ source で埋める', () => {
    expect(
      mergeIdentifiers({ memberId: null, lineUserId: null, phone: '090' }, { memberId: 'M1', lineUserId: 'U1', phone: '080' }),
    ).toEqual({ memberId: 'M1', lineUserId: 'U1' });
  });

  it('target が既に持つ値は上書きしない', () => {
    expect(mergeIdentifiers({ lineUserId: 'Ua', phone: '090' }, { lineUserId: 'Ub', phone: '080' })).toEqual({});
  });
});
