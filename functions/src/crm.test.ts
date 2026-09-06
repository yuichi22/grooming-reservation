import { describe, expect, it } from 'vitest';
import { buildPointEvent } from './crm';

describe('buildPointEvent (§10)', () => {
  it('施術完了イベントのペイロードを組み立てる', () => {
    expect(
      buildPointEvent({
        bookingId: 'bk_1',
        tenantId: 'groomhaus',
        brand: 'GROOM HAUS',
        amount: 5500,
        at: '2026-06-20T11:50:00+09:00',
        memberId: 'MBR_xxx',
        lineUserId: 'U_line1',
        phone: '09012345678',
      }),
    ).toEqual({
      bookingId: 'bk_1',
      memberId: 'MBR_xxx',
      lineUserId: 'U_line1',
      phone: '09012345678',
      // 飼い主名は未指定なので null（Core の person.displayName になる）
      displayName: null,
      tenantId: 'groomhaus',
      brand: 'GROOM HAUS',
      type: 'trimming',
      amount: 5500,
      at: '2026-06-20T11:50:00+09:00',
    });
  });

  it('memberId 未連携(null)でも lineUserId で解決できるようにする (§3)', () => {
    const ev = buildPointEvent({
      bookingId: 'bk_2',
      tenantId: 'groomhaus',
      brand: 'GROOM HAUS',
      amount: 3300,
      at: '2026-06-20T12:00:00+09:00',
      lineUserId: 'U_line2',
    });
    expect(ev.memberId).toBeNull();
    expect(ev.lineUserId).toBe('U_line2');
    // phone 未指定は null（中央CRM側は lineUserId で解決する）
    expect(ev.phone).toBeNull();
  });
});

describe('buildPointEvent の linkOnly（レジ会計の二重付与防止）', () => {
  const base = {
    bookingId: 'bk1',
    tenantId: 'groomhaus',
    brand: 'GROOM HAUS',
    amount: 5000,
    at: '2026-08-21T00:00:00Z',
    lineUserId: 'U1',
    phone: '09012345678',
  };

  it('通常（この場で会計）は linkOnly を載せない＝Core が加算する', () => {
    const ev = buildPointEvent(base);
    expect(ev.linkOnly).toBeUndefined();
    expect(ev.amount).toBe(5000);
  });

  it('レジ会計なら linkOnly=true。⚠金額と識別子はそのまま送る（顧客の紐付けは続ける）', () => {
    const ev = buildPointEvent({ ...base, linkOnly: true });
    expect(ev.linkOnly).toBe(true);
    expect(ev.lineUserId).toBe('U1');
    expect(ev.phone).toBe('09012345678');
  });

  it('linkOnly=false は載せない（既定と同じ扱い）', () => {
    expect(buildPointEvent({ ...base, linkOnly: false }).linkOnly).toBeUndefined();
  });
});
