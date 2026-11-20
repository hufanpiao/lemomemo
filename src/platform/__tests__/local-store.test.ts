// 本机存储读写不抛错的 safeGet / safeSet：读得到照原样回、v 为 null 删键、存储抛错时读回 null 写回 false
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeGet, safeSet } from '../local-store.ts';

function mem(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

const fail = (): never => {
  throw new Error('SecurityError');
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('safeGet / safeSet', () => {
  it('能用时照原样读写，v 为 null 删掉这个键', () => {
    const s = mem();
    vi.stubGlobal('localStorage', s);
    expect(safeGet('k')).toBeNull();
    expect(safeSet('k', 'v')).toBe(true);
    expect(s.getItem('k')).toBe('v');
    expect(safeGet('k')).toBe('v');
    expect(safeSet('k', null)).toBe(true);
    expect(s.getItem('k')).toBeNull();
  });

  it('存储读写抛错（隐私模式、配额满）：不抛，读回 null、写回 false', () => {
    vi.stubGlobal('localStorage', { getItem: fail, setItem: fail, removeItem: fail } as unknown as Storage);
    expect(safeGet('k')).toBeNull();
    expect(safeSet('k', 'v')).toBe(false);
    expect(safeSet('k', null)).toBe(false);
  });

  it('连 localStorage 都没有：照样不抛', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(safeGet('k')).toBeNull();
    expect(safeSet('k', 'v')).toBe(false);
  });
});
