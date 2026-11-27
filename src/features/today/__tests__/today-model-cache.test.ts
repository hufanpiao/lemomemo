// 今天页按行缓存（前端-15）：同一个行对象、同一时区换算出来的是同一个对象（kit TodoRow、今天页日程行的 memo 靠它），
// 换了时区、行对象换了（数据层改一条就换一个新对象）才重算；跨天文字按日程、天、时区缓存
import { describe, expect, it } from 'vitest';
import { eventOcc, eventSpanText, eventsOn, todayTodos, todoOcc, type Row } from '../data/today-model.ts';
import { msAt } from '../../../../shared/core/date.ts';

const SEOUL = 'Asia/Seoul';
const SH = 'Asia/Shanghai';
const DAY = '2026-11-05';
const base = { project: '', deleted_at: null, undone: false };
const ev = (id: string, over: Record<string, unknown> = {}): Row => ({ ...base, id, title: id, date: DAY, time: '14:00', tz: SEOUL, duration_min: 60, ...over });
const td = (id: string, over: Record<string, unknown> = {}): Row => ({ ...base, id, title: id, done: false, important: false, due: DAY, due_time: null, ...over });

describe('按行缓存', () => {
  it('日程：同一行同一时区回同一个对象；换时区重算，换回来照样对', () => {
    const r = ev('e1');
    const a = eventOcc(r, SEOUL);
    expect(eventOcc(r, SEOUL)).toBe(a);
    const b = eventOcc(r, SH);
    expect(b).not.toBe(a);
    expect(b?.time).toBe('13:00');
    expect(eventOcc(r, SEOUL)?.time).toBe('14:00');
  });

  it('日程：行对象换了（改了时刻）就重算，不拿旧的', () => {
    const r = ev('e2');
    expect(eventOcc(r, SEOUL)?.time).toBe('14:00');
    const r2 = { ...r, time: '15:30' };
    expect(eventOcc(r2, SEOUL)?.time).toBe('15:30');
  });

  it('eventsOn 两遍出来的是同一批对象（今天页日程行 memo 不因别的行重画）', () => {
    const rows = [ev('e3'), ev('e4', { time: '09:00' })];
    const x = eventsOn(rows, DAY, SEOUL);
    const y = eventsOn(rows, DAY, SEOUL);
    expect(y).toHaveLength(2);
    y.forEach((o, i) => expect(o).toBe(x[i]));
  });

  it('跨天文字：同一条、同一天、同一时区回同一个对象；换天重算', () => {
    const o = eventOcc(ev('e5', { time: '22:00', duration_min: 240 }), SEOUL);
    if (!o) throw new Error('没换算出来');
    const s = eventSpanText(o, DAY, SEOUL);
    expect(eventSpanText(o, DAY, SEOUL)).toBe(s);
    const next = eventSpanText(o, '2026-11-06', SEOUL);
    expect(next).not.toBe(s);
    expect(next.lead).not.toBe('start');
  });

  it('待办：同一行回同一个对象，行换了重算；todayTodos 出来的也是它', () => {
    const r = td('t1');
    const a = todoOcc(r);
    expect(todoOcc(r)).toBe(a);
    expect(todayTodos([r], msAt(DAY, 600, SEOUL), SEOUL)[0]).toBe(a);
    const r2 = { ...r, title: '改了' };
    expect(todoOcc(r2).title).toBe('改了');
  });
});
