// 黄历卡的按需加载（R-431）：hooks/useHuangli.ts、core/anniv-lib.ts 的 lazyLib / HUANGLI_LIB
// • 韩文界面不加载、回 null；中文界面加载好后给内容；超出数据范围回 null
// • lazyLib 加载失败：记运行日志 `<名字> lib-load failed`、状态 failed；再调一次重新加载
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HUANGLI_LIB, lazyLib } from '../../../core/anniv-lib.ts';
import { useLazyLib } from '../../../kit/hooks/useAnnivLib.ts';
import { useHuangli } from '../hooks/useHuangli.ts';

const logLines = (): string[] => {
  const lines: string[] = [];
  (globalThis as Record<string, unknown>)['__lemoRunLog'] = { q: [], sink: (l: string) => lines.push(l) };
  return lines;
};

describe('useHuangli', () => {
  it('韩文界面不加载黄历这一块、回 null', async () => {
    const { result } = renderHook(() => useHuangli('2026-11-15', 'ko-KR'));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();
    expect(HUANGLI_LIB.ready()).toBe(false);
  });

  it('没有选中的日子不加载', async () => {
    const { result } = renderHook(() => useHuangli(null, 'zh-CN'));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();
    expect(HUANGLI_LIB.ready()).toBe(false);
  });

  it('中文界面加载好后给那一天的内容；换一天跟着换', async () => {
    const { result, rerender } = renderHook(({ d }) => useHuangli(d, 'zh-CN'), { initialProps: { d: '2026-11-15' } });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toMatchObject({ day: '初七', yearGz: '丙午', month: '十月', ji: ['嫁娶', '安葬'] });
    rerender({ d: '2026-11-07' });
    expect(result.current).toMatchObject({ day: '廿九', month: '九月', yi: ['解除', '余事勿取'], ji: [] });
  });

  it('超出数据范围回 null', async () => {
    const { result } = renderHook(() => useHuangli('2101-01-01', 'zh-CN'));
    await waitFor(() => expect(HUANGLI_LIB.ready()).toBe(true));
    expect(result.current).toBeNull();
  });
});

describe('lazyLib', () => {
  it('加载失败：记一行运行日志、状态 failed；下次再调重新加载', async () => {
    const lines = logLines();
    let fail = true;
    const lib = lazyLib('probe', () => (fail ? Promise.reject(new Error('net')) : Promise.resolve({ ok: 1 })));
    const { result } = renderHook(() => useLazyLib(lib));
    await waitFor(() => expect(result.current).toBe('failed'));
    expect(lines).toContain('probe lib-load failed');
    expect(lib.ready()).toBe(false);
    expect(() => lib.get()).toThrow('probe_lib_not_loaded');
    fail = false;
    await expect(lib.load()).resolves.toEqual({ ok: 1 });
    expect(lib.get()).toEqual({ ok: 1 });
  });

  it('want 为假回 off、不加载', async () => {
    let n = 0;
    const lib = lazyLib('idle', () => Promise.resolve(++n));
    const { result } = renderHook(() => useLazyLib(lib, false));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBe('off');
    expect(n).toBe(0);
  });
});
