import { describe, expect, it } from 'vitest';
import { unwrapLiffState } from './liffUrl';

describe('unwrapLiffState', () => {
  it('liff.state が無ければ何もしない', () => {
    expect(unwrapLiffState('/book', '?tenant=groomhaus')).toBeNull();
    expect(unwrapLiffState('/book', '')).toBeNull();
  });
  it('クエリだけの liff.state を展開する', () => {
    expect(unwrapLiffState('/book', '?liff.state=%3Ftenant%3Dgroomhaus')).toBe('/book?tenant=groomhaus');
  });
  it('パス付きの liff.state はエンドポイントのパスに足す', () => {
    expect(unwrapLiffState('/book', '?liff.state=%2Fx%3Fa%3D1')).toBe('/book/x?a=1');
    expect(unwrapLiffState('/', '?liff.state=%2Fbook%3Ftenant%3Dt1')).toBe('/book?tenant=t1');
  });
  it('外側のパラメータは残し、liff.state 側を優先する', () => {
    expect(unwrapLiffState('/book', '?code=abc&tenant=old&liff.state=%3Ftenant%3Dnew')).toBe('/book?tenant=new&code=abc');
  });
});
