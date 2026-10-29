// UI-4 M-2（架构 17.2 第 3 点）：navigate() 在 View Transition 的回调里同步把新页面画完（flushSync），
// 浏览器前进 / 后退（hashchange）走同一条路。TC-B1-51：支持 View Transitions 时切页、不支持时直接切换（无报错），两条路都在这里。用假的 startViewTransition 抓住回调，回调一返回就看 DOM
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

/** 派一个带 hasUAVisualTransition 的 popstate（jsdom 的 PopStateEvent 没有这个属性，手动挂上） */
function popState(ua: boolean | undefined): void {
  const e = new PopStateEvent('popstate', { state: null });
  if (ua !== undefined) Object.defineProperty(e, 'hasUAVisualTransition', { value: ua });
  window.dispatchEvent(e);
}

describe('iPhone 侧滑返回不叠两次动画（UI-4 第二轮 N-1）', () => {
  it('popstate.hasUAVisualTransition 为 true：紧接着的 hashchange 不起 View Transition，直接画完', async () => {
    render(<Where />);
    const { spy } = fakeVt();
    await act(async () => {
      history.replaceState(null, '', '#/calendar');
      popState(true);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await Promise.resolve();
    });
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId('where').textContent).toBe('calendar');
  });

  it('标记只管紧接着的这一次：下一次普通后退照常起 View Transition', async () => {
    render(<Where />);
    const { spy, seen } = fakeVt();
    await act(async () => {
      history.replaceState(null, '', '#/calendar');
      popState(true);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      history.replaceState(null, '', '#/todos');
      popState(false);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await Promise.resolve();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['todos']);
  });

  it('侧滑 popstate 后没有 hashchange（两条历史 hash 相同）：之后点链接、navigate 到别页照常起动画', async () => {
    render(<Where />);
    const { spy, seen } = fakeVt();
    await act(async () => {
      popState(true); // 地址还是 #/today，没有 hashchange
      history.pushState(null, '', '#/calendar'); // 相当于点链接：地址变了再来 hashchange
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await navigate('todos');
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(['calendar', 'todos']);
  });

  it('hasUAVisualTransition 为 false 或没有这个属性（老浏览器）：照常起 View Transition', async () => {
    render(<Where />);
    const { spy, seen } = fakeVt();
    await act(async () => {
      history.replaceState(null, '', '#/calendar');
      popState(undefined);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await Promise.resolve();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['calendar']);
  });
});

describe('跳到当前页不起空 transition（UI-4 第二轮 N-2）', () => {
  it('地址没变：不调 startViewTransition、不加历史', async () => {
    render(<Where />);
    const { spy } = fakeVt();
    const before = history.length;
    await act(async () => {
      await navigate('today');
    });
    expect(spy).not.toHaveBeenCalled();
    expect(history.length).toBe(before);
    expect(screen.getByTestId('where').textContent).toBe('today');
  });

  it('带参数的当前页同样直接返回', async () => {
    history.replaceState(null, '', '#/notes/a%20b');
    render(<Where />);
    const { spy } = fakeVt();
    await act(async () => {
      await navigate('notes', 'a b');
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

function Where2() {
  const r = useRoute();
  return <span>{r.name}</span>;
}
