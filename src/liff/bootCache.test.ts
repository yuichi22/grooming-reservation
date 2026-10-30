import { describe, expect, it } from 'vitest';
import { BOOT_CACHE_TTL_MS, clearBootSnapshot, loadBootSnapshot, saveBootSnapshot, type BootSnapshot } from './bootCache';

const memStorage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

const store = { name: 'GROOM HAUS', logoUrl: null };
const snap: BootSnapshot = {
  customerId: 'c1',
  store,
  options: { store, services: [], options: [], breeds: [], staff: [], dogs: [], pricing: [] },
};

describe('bootCache', () => {
  it('同じ店・同じLINEユーザーなら前回の内容を返す', () => {
    const s = memStorage();
    saveBootSnapshot('t1', 'U1', snap, 1000, s);
    expect(loadBootSnapshot('t1', 'U1', 2000, s)).toEqual(snap);
  });

  it('別の店・別のLINEユーザー・ユーザー不明では返さない', () => {
    const s = memStorage();
    saveBootSnapshot('t1', 'U1', snap, 1000, s);
    expect(loadBootSnapshot('t2', 'U1', 2000, s)).toBeNull();
    expect(loadBootSnapshot('t1', 'U2', 2000, s)).toBeNull();
    expect(loadBootSnapshot('t1', null, 2000, s)).toBeNull();
  });

  it('期限切れ・消去後・壊れた値は返さない', () => {
    const s = memStorage();
    saveBootSnapshot('t1', 'U1', snap, 0, s);
    expect(loadBootSnapshot('t1', 'U1', BOOT_CACHE_TTL_MS + 1, s)).toBeNull();
    saveBootSnapshot('t1', 'U1', snap, 0, s);
    clearBootSnapshot(s);
    expect(loadBootSnapshot('t1', 'U1', 1, s)).toBeNull();
    s.setItem('groom_boot_cache_v1', '{oops');
    expect(loadBootSnapshot('t1', 'U1', 1, s)).toBeNull();
  });

  it('ストレージが使えない環境でも落ちない', () => {
    saveBootSnapshot('t1', 'U1', snap, 0, null);
    expect(loadBootSnapshot('t1', 'U1', 0, null)).toBeNull();
  });
});
