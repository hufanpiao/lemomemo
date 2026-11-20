// UI-4 M-2（架构 17.2 第 3 点）：navigate() 在整页切换（motion 的 transition）的回调里同步把新页面画完（flushSync），
// 别的办法换地址（hashchange）走同一条路。TC-B1-51：有切页动画时切页、没有时直接切换（无报错），两条路都在这里。
// 11-20 起整页切换不用 View Transition（motion/page-swap.ts）：这里把 motion 的 transition 换成替身抓住回调，回调一返回就看 DOM（动画本身在 motion/__tests__/push-swap.test.ts）
// R-487：iPhone 侧滑返回的 hasUAVisualTransition 判断删了（浏览器历史只有一条，系统侧滑没东西可退），原来那组用例一起删
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Motion from '../../motion/index.ts';
import { goBack, navigate, stackOf, useRoute } from '../router.ts';

const fake = vi.hoisted(() => ({ on: false, spy: null as null | ((update: () => void, back?: boolean) => Promise<void>) }));
vi.mock('../../motion/index.ts', async (orig) => {
  const m = await orig<typeof Motion>();
  return { ...m, transition: (update: () => void, back?: boolean) => (fake.on && fake.spy ? fake.spy(update, back) : m.transition(update, back)) };
});

function Where() {
  const r = useRoute();
  return <p data-testid="where">{[r.name, ...r.params].join('/')}</p>;
}

/** 替身：记下回调，调完立刻记下当时的 DOM（回调一返回就该已经是新页面）和方向 */
function fakeVt() {
  const seen: string[] = [];
  const backs: boolean[] = [];
  const spy = vi.fn((update: () => void, back = false) => {
    update();
    seen.push(screen.getByTestId('where').textContent ?? '');
    backs.push(back);
    return Promise.resolve();
  });
  fake.spy = spy;
  fake.on = true;
  return { spy, seen, backs };
}

beforeEach(() => {
  history.replaceState(null, '', '#/today');
});

afterEach(() => {
  cleanup();
  fake.on = false;
  history.replaceState(null, '', '#');
});

describe('navigate：新页面在整页切换的回调里画完（M-2）', () => {
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
    const { spy, seen, backs } = fakeVt();
    await act(async () => {
      goBack();
      await Promise.resolve();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['today']);
    expect(backs, '返回方向').toEqual([true]);
    expect(stackOf()).toEqual([]);
  });

  it('别的办法换地址（hashchange）也包进整页切换，回调里画完', async () => {
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

  it('多个组件订阅路由：一次切换只起一次整页切换', async () => {
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

  it('没有切页动画（实现没到、jsdom）：直接切换，同样同步画完', async () => {
    render(<Where />);
    act(() => {
      void navigate('settings');
    });
    expect(screen.getByTestId('where').textContent).toBe('settings');
  });
});

describe('跳到当前页不起空 transition（UI-4 第二轮 N-2）', () => {
  it('地址没变：不起整页切换、不加历史', async () => {
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
