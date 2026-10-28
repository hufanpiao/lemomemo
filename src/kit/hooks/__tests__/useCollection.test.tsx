// TC-B0-18（架构 2.0、1.3 B0；QA 第二节“部分”）：useCollection / useItem 订阅集合，组件卸载后不残留订阅
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllCollections, collection } from '../../../core/store.ts';
import { useCollection } from '../useCollection.ts';
import { useItem } from '../useItem.ts';

interface Todo {
  id: string;
  text: string;
}

function List() {
  const rows = useCollection<Todo>('todos');
  return <p data-testid="list">{rows.map((r) => r.text).join(',')}</p>;
}

function One({ id }: { id: string }) {
  const row = useItem<Todo>('todos', id);
  return <p data-testid="one">{row?.text ?? '-'}</p>;
}

/** 数一数集合现在有几个订阅者：包一层 subscribe */
function countSubscribers(name: string) {
  const c = collection<Todo>(name);
  const original = c.subscribe.bind(c);
  let live = 0;
  const spy = vi.spyOn(c, 'subscribe').mockImplementation((l) => {
    live += 1;
    const off = original(l);
    return () => {
      live -= 1;
      off();
    };
  });
  return { live: () => live, restore: () => spy.mockRestore() };
}

beforeEach(() => {
  clearAllCollections();
});

afterEach(() => {
  cleanup();
});

describe('useCollection / useItem', () => {
  it('集合变了就重画；useItem 只看那一条', () => {
    render(
      <>
        <List />
        <One id="b" />
      </>,
    );
    expect(screen.getByTestId('list').textContent).toBe('');
    act(() => collection<Todo>('todos').upsert([{ id: 'a', text: '1' }]));
    expect(screen.getByTestId('list').textContent).toBe('1');
    expect(screen.getByTestId('one').textContent).toBe('-');
    act(() => collection<Todo>('todos').upsert([{ id: 'b', text: '2' }]));
    expect(screen.getByTestId('one').textContent).toBe('2');
  });

  it('组件卸载后没有残留订阅（TC-B0-18）', () => {
    const subs = countSubscribers('todos');
    try {
      const { unmount } = render(
        <>
          <List />
          <List />
          <One id="a" />
        </>,
      );
      expect(subs.live()).toBeGreaterThan(0);
      unmount();
      expect(subs.live()).toBe(0);
      // 卸载后再写入，不会碰到已卸载的组件（React 也不会报“更新已卸载组件”）
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      collection<Todo>('todos').upsert([{ id: 'a', text: 'x' }]);
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    } finally {
      subs.restore();
    }
  });
});
