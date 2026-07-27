import { describe, expect, it } from 'vitest';
import { buildCheckoutRequest, checkoutRequestId } from './posCheckout';

describe('buildCheckoutRequest (①会計連携)', () => {
  it('会計依頼伝票のペイロードを組み立てる（明細1行＋オプションはnote）', () => {
    expect(
      buildCheckoutRequest({
        coreTenantId: 'suomi',
        coreSpaceId: 'AtHfu4ml6VtQmRWQsrfN',
        groomTenantId: 'groomhaus',
        bookingId: 'bk_1',
        serviceName: 'カットコース',
        optionNames: ['爪切り', '歯磨き'],
        finalPrice: 8800,
        ownerName: '山田',
        dogName: 'ポチ',
        memberId: 'MBR_xxx',
        lineUserId: 'U_line1',
      }),
    ).toEqual({
      source: 'groom',
      tenantId: 'suomi',
      spaceId: 'AtHfu4ml6VtQmRWQsrfN',
      action: 'create',
      request: {
        requestId: 'groom_groomhaus_bk_1',
        groomTenantId: 'groomhaus',
        bookingId: 'bk_1',
        personId: 'MBR_xxx',
        lineUserId: 'U_line1',
        customerName: '山田様（ポチ）',
        totalAmount: 8800,
        lines: [{ name: 'カットコース', qty: 1, unitPrice: 8800, taxRate: 10, taxRateType: 'standard' }],
        note: 'オプション: 爪切り, 歯磨き',
      },
    });
  });

  it('memberId 未連携(null)・オプション無しでも送れる', () => {
    const p = buildCheckoutRequest({
      coreTenantId: 'suomi',
      coreSpaceId: 'sp_1',
      groomTenantId: 'groomhaus',
      bookingId: 'bk_2',
      serviceName: 'シャンプー',
      optionNames: [],
      finalPrice: 3300,
      ownerName: '佐藤',
      dogName: 'ハチ',
    });
    expect(p.request.personId).toBeNull();
    expect(p.request.lineUserId).toBeNull();
    expect(p.request.note).toBeNull();
    expect(p.request.totalAmount).toBe(3300);
  });

  it('requestId は groom_{tenantId}_{bookingId} の決定的な冪等キー', () => {
    expect(checkoutRequestId('groomhaus', 'bk_9')).toBe('groom_groomhaus_bk_9');
  });
});
