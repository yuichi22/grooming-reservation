import { describe, expect, it } from 'vitest';
import { maxUsablePoints, redeemIdempotencyKey } from './crmPoints.js';

describe('redeemIdempotencyKey', () => {
  it('付与(bookingId)と衝突しないキーにする', () => {
    // Core は付与・利用ともに pointEventReceipts/{key} で重複判定するため、
    // bookingId をそのまま使うと「利用が付与の重複」と誤判定される。
    const bookingId = 'bk_123';
    expect(redeemIdempotencyKey(bookingId)).toBe('redeem-bk_123');
    expect(redeemIdempotencyKey(bookingId)).not.toBe(bookingId);
  });
});

describe('maxUsablePoints', () => {
  const oneToOne = { yenPerPoint: 1, unit: 1 };

  it('残高と支払額の小さい方が上限になる', () => {
    expect(maxUsablePoints(500, 3000, oneToOne)).toBe(500);
    expect(maxUsablePoints(5000, 3000, oneToOne)).toBe(3000);
  });

  it('会計額を超えて使わせない', () => {
    expect(maxUsablePoints(10000, 0, oneToOne)).toBe(0);
  });

  it('利用単位に切り下げる', () => {
    expect(maxUsablePoints(1050, 99999, { yenPerPoint: 1, unit: 100 })).toBe(1000);
    expect(maxUsablePoints(1050, 99999, { yenPerPoint: 1, unit: 500 })).toBe(1000);
    // 単位に満たなければ使えない
    expect(maxUsablePoints(400, 99999, { yenPerPoint: 1, unit: 500 })).toBe(0);
  });

  it('1pt=複数円のレートでも支払額を超えない', () => {
    // 1pt=10円。支払 3,000円 なら 300pt まで
    expect(maxUsablePoints(1000, 3000, { yenPerPoint: 10, unit: 1 })).toBe(300);
  });

  it('不正値は0扱いにする（負の会計額・NaN）', () => {
    expect(maxUsablePoints(500, -100, oneToOne)).toBe(0);
    expect(maxUsablePoints(Number.NaN, 1000, oneToOne)).toBe(0);
    expect(maxUsablePoints(500, Number.NaN, oneToOne)).toBe(0);
  });
});
