// useToday 把当前界面语言传给排序（今天页、待办第四轮复查 L6；变异 X12；useTodoList 的在 todos/__tests__/useTodoList-locale.test.ts）：
// 用一对中韩两种语言排序结果不同的标题——中文里汉字在韩文前（“北京”在“가나”前），韩文里韩文在汉字前。
// 只用“1、2、10”分不出来（两种语言数字都按数值排），漏传语言回到默认 'zh-CN' 时这里会红
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';

type Row = { id: string } & Record<string, unknown>;
const data: Record<string, Row[]> = { events: [], todos: [] };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: (name: string) => data[name] ?? [] }));
vi.mock('../../../core/current-tz.ts', () => ({ currentTz: () => 'Asia/Seoul' }));
const TZ = 'Asia/Seoul';
const DAY = '2026-11-05';
const NOW = msAt(DAY, 14 * 60, TZ);
vi.mock('../../../platform/clock.ts', () => ({
  clock: { now: () => NOW, subscribe: () => () => undefined, offset: () => 0, isClockWrong: () => false },
}));

const { useToday } = await import('../hooks/useToday.ts');

const base = { project: '', done: false, important: false, deleted_at: null, undone: false, done_at: 0 };
const td = (id: string, title: string, over: Record<string, unknown> = {}): Row => ({ id, title, due: DAY, due_time: '18:00', due_tz: null, ...base, ...over });
const ev = (id: string, title: string): Row => ({ id, title, project: '', date: DAY, time: '16:00', tz: TZ, duration_min: 60, deleted_at: null, undone: false });
const ZH = ['北京', '가나'];
const KO = ['가나', '北京'];

beforeEach(() => {
  data.todos = [td('t1', '北京'), td('t2', '가나'), td('t3', '北京', { due: '2026-11-04', due_time: '09:00' }), td('t4', '가나', { due: '2026-11-04', due_time: '09:00' })];
  data.events = [ev('e1', '北京'), ev('e2', '가나')];
});
afterEach(() => act(() => uiStore.getState().setLocale('zh-CN')));

describe('useToday 按当前语言排（X12）', () => {
  it('今天的日程、今天的待办、已过期的待办', () => {
    for (const [loc, want] of [['zh-CN', ZH], ['ko-KR', KO]] as const) {
      act(() => uiStore.getState().setLocale(loc));
      const { result, unmount } = renderHook(() => useToday());
      expect(result.current.events.map((o) => o.title), `${loc} 日程`).toEqual(want);
      expect(result.current.todos.map((o) => o.title), `${loc} 待办`).toEqual(want);
      expect(result.current.late.map((o) => o.todo.title), `${loc} 过期`).toEqual(want);
      unmount();
    }
  });
});
