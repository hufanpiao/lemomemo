// core/blob-urls.ts：头像仓、随手记插图共用的 blob: 地址表（改善报告 11-20 二-4）：换地址撤旧的、超上限撤最早的、prune 只留 live、同一个键同时只取一次
import { describe, expect, it, vi } from 'vitest';
import { createBlobUrls } from '../blob-urls.ts';

describe('createBlobUrls', () => {
  it('同一个键换了地址撤旧的；超上限撤最早的；有增减就 onChange', () => {
    const revoke = vi.fn();
    const onChange = vi.fn();
    const u = createBlobUrls({ max: 2, revoke, onChange });
    u.keep('a', 'blob:a');
    u.keep('a', 'blob:a2');
    expect(revoke).toHaveBeenCalledWith('blob:a');
    u.keep('b', 'blob:b');
    u.keep('c', 'blob:c');
    expect(revoke).toHaveBeenLastCalledWith('blob:a2');
    expect([u.peek('a'), u.peek('b'), u.peek('c')]).toEqual([null, 'blob:b', 'blob:c']);
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('prune 只留 live 里的，回被撤掉的键；没撤掉东西不 onChange', () => {
    const revoke = vi.fn();
    const onChange = vi.fn();
    const u = createBlobUrls({ max: 9, revoke, onChange });
    u.keep('a', 'blob:a');
    u.keep('b', 'blob:b');
    onChange.mockClear();
    expect(u.prune(new Set(['a', 'b']))).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
    expect(u.prune(new Set(['b']))).toEqual(['a']);
    expect(revoke).toHaveBeenCalledWith('blob:a');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(u.prune(new Set())).toEqual(['b']);
  });

  it('once：同一个键取着的时候再要，给同一个 Promise；取完就忘，下次重新取', async () => {
    const u = createBlobUrls({ max: 9, revoke: vi.fn() });
    const run = vi.fn(() => Promise.resolve(1));
    const p1 = u.once('a', run);
    expect(u.once('a', run)).toBe(p1);
    expect(await p1).toBe(1);
    await u.once('a', run);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
