import { describe, expect, it } from 'vitest';
import { netAmountForPoints, maxUsablePoints, redeemIdempotencyKey } from './crmPoints.js';

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

describe('netAmountForPoints（CRMへ送る売上額）', () => {
  it('ポイント利用は売上値引きなので、値引き後の対価を送る', () => {
    // ¥5,000 の施術で 1,000pt(=¥1,000) 利用 → 売上は ¥4,000。付与も ¥4,000 に対して行う
    expect(netAmountForPoints(5000, 1000)).toBe(4000);
  });

  it('ポイント未使用なら施術料金そのまま', () => {
    expect(netAmountForPoints(5000, 0)).toBe(5000);
  });

  it('全額ポイントなら売上0（付与も0になる）', () => {
    expect(netAmountForPoints(5000, 5000)).toBe(0);
  });

  it('値引きが料金を超えてもマイナスにしない', () => {
    expect(netAmountForPoints(3000, 9999)).toBe(0);
  });

  it('不正値は0扱い', () => {
    expect(netAmountForPoints(Number.NaN, 100)).toBe(0);
    expect(netAmountForPoints(5000, Number.NaN)).toBe(5000);
  });
})
