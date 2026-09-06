import { describe, expect, it } from 'vitest';
import { resolveLink, type CustomerIdentifiers } from './findOrLink';

describe('resolveLink (§3 find-or-link)', () => {
  const existing: CustomerIdentifiers[] = [
    { id: 'c1', lineUserId: 'U_line1', phone: '09011112222' },
    { id: 'c2', lineUserId: null, phone: '09033334444' }, // 電話のみ会員
  ];

  it('lineUserId 一致は found（重複ポイントは構造的に発生しない §3）', () => {
    expect(resolveLink(existing, { lineUserId: 'U_line1' })).toEqual({ action: 'found', customerId: 'c1' });
  });

  it('phone 一致＋未連携なら lineUserId を追加リンク（新規作成しない）', () => {
    expect(resolveLink(existing, { lineUserId: 'U_new', phone: '09033334444' })).toEqual({
      action: 'link',
      customerId: 'c2',
      addLineUserId: 'U_new',
    });
  });

  it('lineUserId 既知だが phone 未登録なら phone を補完リンク', () => {
    const ex: CustomerIdentifiers[] = [{ id: 'c3', lineUserId: 'U_x', phone: null }];
    expect(resolveLink(ex, { lineUserId: 'U_x', phone: '09055556666' })).toEqual({
      action: 'link',
      customerId: 'c3',
      addPhone: '09055556666',
    });
  });

  it('どの識別子にも一致しなければ create', () => {
    expect(resolveLink(existing, { lineUserId: 'U_zzz', phone: '08000000000' })).toEqual({ action: 'create' });
  });
});
