// 整页换排法的时机（B6 电脑版面板；../swap-guard.ts 的 useSwapWhenSafe）：今天页、随手记页从原来的一列换成面板是整页重挂一次，
// 和动画实现换上同一个守卫：want 为真、later 放行、模块下好、页里没有焦点和按住的指针，才交出模块；下载失败一直是 null；want 变假立刻 null
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSwapGuardForTest, SWAP_PATIENCE_MS, SWAP_RETRY_MS, useSwapWhenSafe } from '../swap-guard.ts';

afterEach(() => {
  cleanup();
  resetSwapGuardForTest();
});

const wait = (ms: number) => act(() => new Promise<void>((ok) => setTimeout(ok, ms)));
const MOD = { name: '面板' };

function Page({ want, load, later = (fn) => fn() }: { want: boolean; load: () => Promise<typeof MOD>; later?: (fn: () => void) => void }) {
  const page = useRef<HTMLDivElement>(null);
  const m = useSwapWhenSafe(want, page, load, later);
  return (
    <div ref={page}>
      <button type="button" data-testid="btn">
        按钮
      </button>
      <p data-testid="mode">{m ? m.name : '一列'}</p>
    </div>
  );
}
const mode = () => screen.getByTestId('mode').textContent;

describe('useSwapWhenSafe', () => {
  it('下好了、页里没有焦点：交出模块；want 变假立刻回到 null，再变真直接交出、不再下载', async () => {
    const load = vi.fn(() => Promise.resolve(MOD));
    const v = render(<Page want load={load} />);
    await wait(0);
    expect(mode()).toBe('面板');
    v.rerender(<Page want={false} load={load} />);
    expect(mode()).toBe('一列');
    v.rerender(<Page want load={load} />);
    expect(mode()).toBe('面板');
    expect(load).toHaveBeenCalledTimes(1);
    // 切页回来重新挂上：第一次渲染就是面板，不先画一列
    v.unmount();
    const first: (string | null)[] = [];
    function Probe() {
      const page = useRef<HTMLDivElement>(null);
      const m = useSwapWhenSafe(true, page, load, (fn) => fn());
      first.push(m ? m.name : null);
      return <div ref={page} />;
    }
    render(<Probe />);
    expect(first[0]).toBe('面板');
  });

  it('焦点在页里时不换，移开以后隔一会儿再看就换上', async () => {
    let done!: (m: typeof MOD) => void;
    const load = () => new Promise<typeof MOD>((ok) => (done = ok));
    render(<Page want load={load} />);
    screen.getByTestId('btn').focus();
    await act(async () => done(MOD));
    await wait(SWAP_RETRY_MS * 2);
    expect(mode()).toBe('一列');
    screen.getByTestId('btn').blur();
    await wait(SWAP_RETRY_MS * 2);
    expect(mode()).toBe('面板');
  });

  it('传了 keep：焦点一直停在页里的按钮上，等满 SWAP_PATIENCE_MS 也换上；停在 keep 说要留住的元素上就一直等', async () => {
    vi.useFakeTimers();
    try {
      const keep = (el: Element) => el.tagName === 'INPUT';
      function KeepPage({ field }: { field: boolean }) {
        const page = useRef<HTMLDivElement>(null);
        const m = useSwapWhenSafe(true, page, () => Promise.resolve(MOD), (fn) => fn(), keep);
        return (
          <div ref={page}>
            {field ? <input data-testid="field" /> : <button type="button" data-testid="btn">按钮</button>}
            <p data-testid="mode">{m ? m.name : '一列'}</p>
          </div>
        );
      }
      const v = render(<KeepPage field={false} />);
      screen.getByTestId('btn').focus();
      await act(async () => vi.advanceTimersByTimeAsync(SWAP_PATIENCE_MS - SWAP_RETRY_MS * 2));
      expect(mode()).toBe('一列');
      await act(async () => vi.advanceTimersByTimeAsync(SWAP_RETRY_MS * 3));
      expect(mode()).toBe('面板');
      v.unmount();
      resetSwapGuardForTest();
      render(<KeepPage field />);
      screen.getByTestId('field').focus();
      await act(async () => vi.advanceTimersByTimeAsync(SWAP_PATIENCE_MS * 3));
      expect(mode()).toBe('一列');
    } finally {
      vi.useRealTimers();
    }
  });

  it('按住不放的指针：松开以后才换', async () => {
    render(<Page want load={() => Promise.resolve(MOD)} />);
    fireEvent.pointerDown(document, { pointerId: 3 });
    await wait(SWAP_RETRY_MS * 2);
    expect(mode()).toBe('一列');
    fireEvent.pointerUp(document, { pointerId: 3 });
    await wait(SWAP_RETRY_MS * 2);
    expect(mode()).toBe('面板');
  });

  it('later 没放行不下载；want 一直为假不下载；下载失败一直照原来的排法', async () => {
    const load = vi.fn(() => Promise.resolve(MOD));
    let go: (() => void) | null = null;
    const v = render(<Page want load={load} later={(fn) => (go = fn)} />);
    await wait(0);
    expect(load).not.toHaveBeenCalled();
    act(() => go?.());
    await wait(0);
    expect(mode()).toBe('面板');
    v.unmount();
    const never = vi.fn(() => Promise.resolve(MOD));
    render(<Page want={false} load={never} />);
    await wait(0);
    expect(never).not.toHaveBeenCalled();
    cleanup();
    render(<Page want load={() => Promise.reject(new Error('net'))} />);
    await wait(SWAP_RETRY_MS);
    expect(mode()).toBe('一列');
  });
});
