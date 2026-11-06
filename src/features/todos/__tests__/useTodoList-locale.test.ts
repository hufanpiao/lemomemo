// useTodoList 把当前界面语言传给排序（今天页、待办第四轮复查 L6；变异 X10、X11）：
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

const { useTodoList } = await import('../hooks/useTodoList.ts');

const base = { project: '', done: false, important: false, deleted_at: null, undone: false, done_at: 0 };
const td = (id: string, title: string, over: Record<string, unknown> = {}): Row => ({ id, title, due: DAY, due_time: '18:00', due_tz: null, ...base, ...over });
const ZH = ['北京', '가나'];
const KO = ['가나', '北京'];

beforeEach(() => {
  data.todos = [td('t1', '北京'), td('t2', '가나'), td('t3', '北京', { due: '2026-11-04', due_time: '09:00' }), td('t4', '가나', { due: '2026-11-04', due_time: '09:00' })];
});
afterEach(() => act(() => uiStore.getState().setLocale('zh-CN')));

describe('useTodoList 按当前语言排（X10、X11）', () => {
  it('分组里同一截止时刻按标题；项目筛选条条数一样按项目名', () => {
    data.todos = [td('t1', '北京', { project: '北京' }), td('t2', '가나', { project: '가나' })];
    for (const [loc, want] of [['zh-CN', ZH], ['ko-KR', KO]] as const) {
      act(() => uiStore.getState().setLocale(loc));
      const { result, unmount } = renderHook(() => useTodoList());
      const items = result.current.groups.flatMap((g) => g.items.map((i) => i.todo.title));
      expect(items, `${loc} 分组`).toEqual(want);
      expect(result.current.projects.map((p) => p.project), `${loc} 项目`).toEqual(want);
      unmount();
    }
  });
});
