// 黄历卡的按需加载（R-431）：hooks/useHuangli.ts、core/anniv-lib.ts 的 lazyLib、kit/hooks/useAnnivLib.ts 的 useLazyLib
// • 每条用例自己新建 lazyLib 实例注入，不碰全局 HUANGLI_LIB，各条可单独跑（R-431 独立评审第 9 条）
// • 韩文界面、没选日子、范围外不加载；加载中回 'wait'；加载好给内容；日期格式不对记 `huangli bad_date`、回 null
// • 加载失败：日志正好一行 `<名字> lib-load failed`、状态 failed、不自己反复重试；online 事件或 want 由假变真时重试，重试时先回 loading（独立评审第 2 条）
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { UiLocale } from '../../../../shared/i18n/pick-locale.ts';
import { lazyLib } from '../../../core/anniv-lib.ts';
import { useLazyLib } from '../../../kit/hooks/useAnnivLib.ts';
import { useHuangli } from '../hooks/useHuangli.ts';

const realHuangli = await import('../../../../shared/logic/anniv/lunar-huangli.ts');

const logLines = (): string[] => {
  const lines: string[] = [];
  (globalThis as Record<string, unknown>)['__lemoRunLog'] = { q: [], sink: (l: string) => lines.push(l) };
  return lines;
};
const tick = () => new Promise((r) => setTimeout(r, 20));
const fresh = () => {
  const load = vi.fn(async () => realHuangli);
  return { lib: lazyLib('huangli', load), load };
};

describe('useHuangli', () => {
  it('韩文界面不加载黄历这一块、回 null', async () => {
    const { lib, load } = fresh();
    const { result } = renderHook(() => useHuangli('2026-11-15', 'ko-KR', lib));
    await tick();
    expect(result.current).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('没有选中的日子、超出数据范围（1901-01-20 以前、2100 年以后）都不加载、回 null', async () => {
    const { lib, load } = fresh();
    const { result, rerender } = renderHook(({ d }: { d: DateStr | null }) => useHuangli(d, 'zh-CN', lib), { initialProps: { d: null as DateStr | null } });
    await tick();
    expect(result.current).toBeNull();
    rerender({ d: '1901-01-19' });
    await tick();
    expect(result.current).toBeNull();
    rerender({ d: '2101-01-01' });
    await tick();
    expect(result.current).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("加载中回 'wait'；加载好给那一天的内容；换一天跟着换", async () => {
    const { lib } = fresh();
    const { result, rerender } = renderHook(({ d }: { d: DateStr }) => useHuangli(d, 'zh-CN', lib), { initialProps: { d: '2026-11-15' } });
    expect(result.current).toBe('wait');
    await waitFor(() => expect(result.current).not.toBe('wait'));
    expect(result.current).toMatchObject({ day: '初七', yearGz: '丙午', month: '十月', ji: ['嫁娶', '安葬'] });
    rerender({ d: '2026-11-07' });
    expect(result.current).toMatchObject({ day: '廿九', month: '九月', yi: ['解除', '余事勿取'], ji: [] });
  });

  it('日期格式不对：记一行 huangli bad_date、回 null，不抛', async () => {
    const lines = logLines();
    const { lib } = fresh();
    const { result } = renderHook(() => useHuangli('2026-13-01', 'zh-CN', lib));
    await waitFor(() => expect(lib.ready()).toBe(true));
    expect(result.current).toBeNull();
    expect(lines.filter((l) => l === 'huangli bad_date')).toHaveLength(1);
  });

  it('韩文 → 中文：换回中文界面才加载', async () => {
    const { lib, load } = fresh();
    const { result, rerender } = renderHook(({ l }: { l: UiLocale }) => useHuangli('2026-11-15', l, lib), { initialProps: { l: 'ko-KR' } });
    await tick();
    expect(load).not.toHaveBeenCalled();
    rerender({ l: 'zh-CN' });
    await waitFor(() => expect(result.current).toMatchObject({ day: '初七' }));
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('lazyLib / useLazyLib', () => {
  it('加载失败：日志正好一行、状态 failed、不自己反复加载；lib.get 抛', async () => {
    const lines = logLines();
    const load = vi.fn(() => Promise.reject(new Error('net')));
    const lib = lazyLib('probe', load);
    const { result } = renderHook(() => useLazyLib(lib));
    await waitFor(() => expect(result.current).toBe('failed'));
    await tick();
    expect(lines.filter((l) => l.includes('lib-load failed'))).toEqual(['probe lib-load failed']);
    expect(load).toHaveBeenCalledTimes(1);
    expect(lib.ready()).toBe(false);
    expect(() => lib.get()).toThrow('probe_lib_not_loaded');
  });

  it('失败后 online：先回 loading 再重新加载，好了回 ready', async () => {
    let fail = true;
    let release: () => void = () => {};
    const load = vi.fn(() => (fail ? Promise.reject(new Error('net')) : new Promise<{ ok: number }>((r) => (release = () => r({ ok: 1 })))));
    const lib = lazyLib('probe', load);
    const { result } = renderHook(() => useLazyLib(lib));
    await waitFor(() => expect(result.current).toBe('failed'));
    fail = false;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current).toBe('loading');
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current).toBe('ready'));
    expect(lib.get()).toEqual({ ok: 1 });
  });

  it('失败后 want 由假变真：先回 loading 再重新加载', async () => {
    let fail = true;
    const load = vi.fn(() => (fail ? Promise.reject(new Error('net')) : Promise.resolve({ ok: 1 })));
    const lib = lazyLib('probe', load);
    const { result, rerender } = renderHook(({ w }: { w: boolean }) => useLazyLib(lib, w), { initialProps: { w: true } });
    await waitFor(() => expect(result.current).toBe('failed'));
    rerender({ w: false });
    expect(result.current).toBe('off');
    fail = false;
    rerender({ w: true });
    expect(result.current).toBe('loading');
    await waitFor(() => expect(result.current).toBe('ready'));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('want 为假回 off、不加载', async () => {
    let n = 0;
    const lib = lazyLib('idle', () => Promise.resolve(++n));
    const { result } = renderHook(() => useLazyLib(lib, false));
    await tick();
    expect(result.current).toBe('off');
    expect(n).toBe(0);
  });
});
