// UI-4 M-2（架构 17.2 第 3 点）：navigate() 在 View Transition 的回调里同步把新页面画完（flushSync），
// 别的办法换地址（hashchange）走同一条路。TC-B1-51：支持 View Transitions 时切页、不支持时直接切换（无报错），两条路都在这里。用假的 startViewTransition 抓住回调，回调一返回就看 DOM
// R-487：iPhone 侧滑返回的 hasUAVisualTransition 判断删了（浏览器历史只有一条，系统侧滑没东西可退），原来那组用例一起删
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPageSwap } from '../../motion/index.ts';
import { goBack, navigate, stackOf, useRoute } from '../router.ts';

// 整页过渡的实现首屏画完才下载（motion/page-vt.ts，11-20 挪出首屏）：真机由 main.tsx 调 loadPageSwap，这里先下好
beforeAll(() => loadPageSwap());

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
  it('回调返回时 DOM 已经是新路由；地址也改了，原页压进返回栈、浏览器历史不多一条（R-487）', async () => {
    render(<Where />);
    expect(screen.getByTestId('where').textContent).toBe('today');
    const { spy, seen } = fakeVt();
    const before = history.length;
    await act(async () => {
      await navigate('note', 'abc');
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['note/abc']);
    expect(location.hash).toBe('#/note/abc');
    expect(stackOf()).toEqual(['#/today']);
    expect(history.length).toBe(before);
  });

  it('goBack 走同一套：回调里画完上一页', async () => {
    render(<Where />);
    await act(async () => {
      await navigate('note', 'abc');
    });
    const { spy, seen } = fakeVt();
    await act(async () => {
      goBack();
      await Promise.resolve();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['today']);
    expect(stackOf()).toEqual([]);
  });

  it('别的办法换地址（hashchange）也包进 View Transition，回调里画完', async () => {
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
