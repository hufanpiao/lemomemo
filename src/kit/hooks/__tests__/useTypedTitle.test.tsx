// 带去新建页的一份（kit/state/new-item.ts + kit/hooks/useTypedTitle.ts；B3 R-353 不丢字；11-24 AI 助手卡片“改一下”带整条）：
// • 一处存放：日子看一眼（newItemDay）不清、clearNewItemDay 只清日子；字和整条取一次就清（takeNewItem），日子不动
// • 新建页（id 'new'）挂上时取走、交给 apply 一次；StrictMode 下也只交一次；空白字不填；编辑已有条目（id 不是 'new'）不取
// • 整条按“记下来”同一个映射（captureRow）拼成一行交出去：时长、重要、提醒、备注都在
import { cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureItem } from '../../../../shared/logic/capture-map.ts';
import { clearNewItemDay, newItemDay, setNewItem, takeNewItem } from '../../state/new-item.ts';
import { rowOfItem, useTypedTitle } from '../useTypedTitle.ts';

afterEach(() => {
  cleanup();
  setNewItem({});
});

function Form({ id, change }: { id: string; change: (p: { title?: string; row?: Readonly<Record<string, unknown>> }) => void }) {
  useTypedTitle(id, change);
  return null;
}

const ITEM: CaptureItem = {
  kind: 'todo', title: '交报告', date: null, time: '18:00', duration_min: null, due: '2026-11-28', important: true,
  project: '工作', body: '带上周的数据', short: null, remind: false, anniv: null,
};
// 2026-11-24 10:00 首尔
const NOW = Date.UTC(2026, 10, 24, 1, 0);

describe('new-item', () => {
  it('日子：看一眼不清；clearNewItemDay 只清日子，字留着', () => {
    setNewItem({ day: '2026-11-09', title: '买牛奶' });
    expect(newItemDay()).toBe('2026-11-09');
    expect(newItemDay()).toBe('2026-11-09');
    clearNewItemDay();
    expect(newItemDay()).toBeNull();
    expect(takeNewItem().title).toBe('买牛奶');
  });

  it('字和整条：取走就清，日子不动；再放一次没给的几样清掉', () => {
    setNewItem({ day: '2026-11-09', title: '买牛奶', item: ITEM });
    expect(takeNewItem()).toEqual({ title: '买牛奶', item: ITEM });
    expect(takeNewItem()).toEqual({ title: null, item: null });
    expect(newItemDay()).toBe('2026-11-09');
    setNewItem({ title: 'x' });
    expect(newItemDay()).toBeNull();
  });
});

describe('rowOfItem：和“记下来”同一个映射', () => {
  it('待办：截止日、截止时刻、重要、提醒关、项目、备注都在', () => {
    expect(rowOfItem(ITEM, NOW, 'Asia/Seoul')).toMatchObject({
      title: '交报告', due: '2026-11-28', due_time: '18:00', priority: 'high', remind_before_min: null, project: '工作', note: '带上周的数据',
    });
  });

  it('日程：时长、时区、提醒照记下的默认；全天的时长按天', () => {
    const ev: CaptureItem = { ...ITEM, kind: 'event', date: '2026-11-25', time: '15:00', duration_min: 90, due: null, remind: undefined };
    expect(rowOfItem(ev, NOW, 'Asia/Seoul')).toMatchObject({ date: '2026-11-25', time: '15:00', duration_min: 90, tz: 'Asia/Seoul', remind_min: 15 });
    expect(rowOfItem({ ...ev, time: null, duration_min: null }, NOW, 'Asia/Seoul')).toMatchObject({ time: null, tz: null, remind_min: null });
  });

  it('随手记不在这两个新建页：null', () => {
    expect(rowOfItem({ ...ITEM, kind: 'note' }, NOW, 'Asia/Seoul')).toBeNull();
  });
});

describe('useTypedTitle', () => {
  it('新建页挂上：取走字填进标题，StrictMode 下也只填一次，取走以后下次新建不沿用', () => {
    setNewItem({ title: '明天下午三点开会' });
    const change = vi.fn();
    render(
      <StrictMode>
        <Form id="new" change={change} />
      </StrictMode>,
    );
    expect(change).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledWith({ title: '明天下午三点开会' });
    expect(takeNewItem().title).toBeNull();
  });

  it('空白字不填；没带字不填', () => {
    setNewItem({ title: '   ' });
    const change = vi.fn();
    render(<Form id="new" change={change} />);
    cleanup();
    render(<Form id="new" change={change} />);
    expect(change).not.toHaveBeenCalled();
  });

  it('AI 助手卡片“改一下”带整条（11-24）：拼成一行交一次，取走就清', () => {
    setNewItem({ item: ITEM });
    const change = vi.fn();
    render(
      <StrictMode>
        <Form id="new" change={change} />
      </StrictMode>,
    );
    expect(change).toHaveBeenCalledTimes(1);
    expect(change.mock.calls[0]?.[0]).toEqual({ row: expect.objectContaining({ title: '交报告', due: '2026-11-28', priority: 'high', note: '带上周的数据' }) });
    expect(takeNewItem().item).toBeNull();
  });

  it('编辑已有条目不取字（留给下一次新建）', () => {
    setNewItem({ title: '买牛奶' });
    const change = vi.fn();
    render(<Form id="abc" change={change} />);
    expect(change).not.toHaveBeenCalled();
    expect(takeNewItem().title).toBe('买牛奶');
  });
});
