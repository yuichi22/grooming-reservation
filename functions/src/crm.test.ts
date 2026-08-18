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
