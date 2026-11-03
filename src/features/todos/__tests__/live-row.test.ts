// “这一行还在不在”只留一份（前端 B 日历审查建议 1）：今天页、待办页都改用 shared/logic/calendar 的 isLiveRow，
// 本机缓存的行列都是 unknown，传进去要断言一次类型。这里用同一组输入（含类型不对的怪值）对照结果（今天页那份在 today/__tests__/live-row.test.ts），
// 并和原来本地的写法（deleted_at 为 null 或没有、undone 不是 true）逐条比，保证断言不改变行为
import { describe, expect, it } from 'vitest';
import { isLiveRow } from '../../../../shared/logic/calendar/cal-items.ts';
import { isLive as todoIsLive } from '../data/todo-list.ts';

type Row = Readonly<{ id: string } & Record<string, unknown>>;
const old = (r: Row): boolean => (r['deleted_at'] === null || r['deleted_at'] === undefined) && r['undone'] !== true;

const VALUES: unknown[] = [undefined, null, 0, 1, 1700000000000, -1, '', '0', 'x', true, false, NaN, {}, []];

describe('todo-list 的 isLive 和 isLiveRow 一致', () => {
  it('deleted_at、undone 各种取值（含没有这一列、类型不对的怪值）结果都相同，且和原来的写法相同', () => {
    const rows: Row[] = [{ id: 'none' }];
    for (const d of VALUES) {
      for (const u of VALUES) {
        const r: Record<string, unknown> = { id: 'r' };
        if (d !== undefined) r['deleted_at'] = d;
        if (u !== undefined) r['undone'] = u;
        rows.push(r as Row);
      }
    }
    rows.push({ id: 'explicit-undef', deleted_at: undefined, undone: undefined });
    for (const r of rows) {
      const want = old(r);
      const label = JSON.stringify(r);
      expect(todoIsLive(r), label).toBe(want);
      expect(isLiveRow(r as Parameters<typeof isLiveRow>[0]), label).toBe(want);
    }
    // 几条看得懂的
    expect(todoIsLive({ id: 'a', deleted_at: null, undone: false })).toBe(true);
    expect(todoIsLive({ id: 'a', deleted_at: 5 })).toBe(false);
    expect(todoIsLive({ id: 'a', undone: true })).toBe(false);
  });
});
