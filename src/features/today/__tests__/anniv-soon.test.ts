// 今天页顶部的纪念日一行（B5 S14）：7 天内最近的一个，用服务器的 next_date
import { describe, expect, it } from 'vitest';
import { annivSoon } from '../data/anniv-soon.ts';

const r = (id: string, x: Record<string, unknown>) => ({ id, name: id, deleted_at: null, undone: false, archived_at: null, ...x });

describe('annivSoon', () => {
  it('7 天内（含今天、含第 7 天）最近的一个；同一天按名字', () => {
    const rows = [r('b', { next_date: '2026-11-16' }), r('a', { next_date: '2026-11-16' }), r('far', { next_date: '2026-11-21' }), r('edge', { next_date: '2026-11-20' })];
    expect(annivSoon(rows, '2026-11-13')).toMatchObject({ row: { id: 'a' }, days: 3 });
    expect(annivSoon([rows[3] as never], '2026-11-13')?.days).toBe(7);
    expect(annivSoon([r('t', { next_date: '2026-11-13' })], '2026-11-13')?.days).toBe(0);
  });

  it('已删、撤销、已归档、没有 next_date、next_date 早于今天、超过 7 天的不出', () => {
    const rows = [
      r('d', { next_date: '2026-11-14', deleted_at: 1 }),
      r('u', { next_date: '2026-11-14', undone: true }),
      r('ar', { next_date: '2026-11-14', archived_at: 1 }),
      r('n', {}),
      r('old', { next_date: '2026-11-12' }),
      r('far', { next_date: '2026-11-21' }),
    ];
    expect(annivSoon(rows, '2026-11-13')).toBeNull();
  });
});
