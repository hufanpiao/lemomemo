// UI-4 M-2（架构 17.2 第 3 点）：navigate() 在 View Transition 的回调里同步把新页面画完（flushSync），
// 浏览器前进 / 后退（hashchange）走同一条路。用假的 startViewTransition 抓住回调，回调一返回就看 DOM
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigate, useRoute } from '../router.ts';

function Where() {
  const r = useRoute();
  return <p data-testid="where">{[r.name, ...r.params].join('/')}</p>;
}

// 假的 startViewTransition 挂在 document 上（jsdom 没有这个 API）；测完删掉
type FakeVt = (cb: () => void) => { finished: Promise<void> };
const doc = document as unknown as { startViewTransition?: FakeVt };

/** 假的 View Transitions：记下回调，由测试决定什么时候“截完旧画面”再调；调完立刻记下当时的 DOM */
function fakeVt() {
  const seen: string[] = [];
  const spy = vi.fn((cb: () => void) => {
    cb();
    // 回调一返回浏览器就截“新画面”：这时 DOM 必须已经是新页面
    seen.push(screen.getByTestId('where').textContent ?? '');
    return { finished: Promise.resolve() };
  });
  doc.startViewTransition = spy;
  return { spy, seen };
}

beforeEach(() => {
  history.replaceState(null, '', '#/today');
});

afterEach(() => {
  cleanup();
  delete doc.startViewTransition;
  history.replaceState(null, '', '#');
});

describe('navigate：新页面在 View Transition 的回调里画完（M-2）', () => {
  it('回调返回时 DOM 已经是新路由；地址也改了、留了一条历史', async () => {
    render(<Where />);
    expect(screen.getByTestId('where').textContent).toBe('today');
    const { spy, seen } = fakeVt();
    const before = history.length;
    await act(async () => {
      await navigate('notes', 'abc');
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['notes/abc']);
    expect(location.hash).toBe('#/notes/abc');
    expect(history.length).toBe(before + 1);
  });

  it('浏览器前进 / 后退（hashchange）也包进 View Transition，回调里画完', async () => {
    render(<Where />);
    const { spy, seen } = fakeVt();
    await act(async () => {
      history.replaceState(null, '', '#/calendar');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await Promise.resolve();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['calendar']);
  });

  it('多个组件订阅路由：一次切换只起一个 View Transition', async () => {
    render(
      <>
        <Where />
        <Where2 />
      </>,
    );
    const { spy } = fakeVt();
    await act(async () => {
      history.replaceState(null, '', '#/todos');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await Promise.resolve();
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('不支持 View Transitions：直接切换，同样同步画完', async () => {
    render(<Where />);
    act(() => {
      void navigate('settings');
    });
    expect(screen.getByTestId('where').textContent).toBe('settings');
  });
});

function Where2() {
  const r = useRoute();
  return <span>{r.name}</span>;
}
