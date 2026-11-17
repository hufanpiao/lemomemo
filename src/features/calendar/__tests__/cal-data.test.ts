// 本机行 → 月历输入（B2 FA-3）：坏行跳过、缺列给默认值，删除 / 撤销原样带给纯逻辑
import { describe, expect, it } from 'vitest';
import { placeEvent } from '../../../../shared/logic/calendar/event-span.ts';
import { calItemsOf, todoDueMinutes } from '../data/cal-data.ts';

describe('calItemsOf', () => {
  it('合法的日程、待办逐列取；删除、撤销原样带过去', () => {
    const r = calItemsOf(
      [{ id: 'e1', title: '会', date: '2026-11-05', time: '09:00', tz: 'Asia/Seoul', duration_min: 60, project: 'A', short: null, created_at: 3, deleted_at: 9, undone: false }],
      [{ id: 't1', title: '买', due: '2026-11-06', done: false, project: '', short: '买', created_at: 2, undone: true }],
    );
    expect(r.events[0]).toEqual({
      id: 'e1', title: '会', short: null, project: 'A', date: '2026-11-05', time: '09:00', tz: 'Asia/Seoul', duration_min: 60, created_at: 3, deleted_at: 9, undone: false,
    });
    expect(r.todos[0]).toMatchObject({ id: 't1', due: '2026-11-06', done: false, deleted_at: null, undone: true });
  });

  it('没有日期的日程跳过；时刻、时长原样交给 placeEvent（坏时刻统一不显示，同提醒、今天页）；标题坏了给空串；待办截止日坏了当没有', () => {
    const r = calItemsOf(
      [
        { id: 'bad', title: 'x' },
        { id: 'e2', title: 5, date: '2026-11-05', time: '25:00', duration_min: -3 },
      ],
      [{ id: 't2', due: '11/06', done: 'yes' }],
    );
    expect(r.events.map((e) => e.id)).toEqual(['e2']);
    expect(r.events[0]).toMatchObject({ title: '', time: '25:00', tz: null, duration_min: -3, created_at: 0, deleted_at: null });
    // 第二轮评审必改 1：不再自己把坏时刻改成全天；placeEvent 放不下就不显示
    expect(placeEvent(r.events[0]!, 'Asia/Seoul')).toBeNull();
    expect(r.todos[0]).toMatchObject({ due: null, done: false, title: '' });
  });
});

describe('todoDueMinutes', () => {
  it('“HH:MM” → 当天第几分钟；没有、格式不对的不进表', () => {
    const m = todoDueMinutes([
      { id: 'a', due_time: '09:30' },
      { id: 'b', due_time: '23:59:00' },
      { id: 'c', due_time: null },
      { id: 'd', due_time: '24:00' },
      { id: 'e', due_time: '7:00' },
    ]);
    expect([...m]).toEqual([
      ['a', 570],
      ['b', 1439],
    ]);
  });
});
