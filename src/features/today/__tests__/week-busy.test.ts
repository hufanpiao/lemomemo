// 电脑版今天页“本周”块（data/week-busy.ts）和“快到了”块（data/anniv-soon.ts 的 annivUpcoming）的纯逻辑（B6，5.9b）
import { describe, expect, it } from 'vitest';
import { annivUpcoming } from '../data/anniv-soon.ts';
import type { Row } from '../data/today-model.ts';
import { weekBusy } from '../data/week-busy.ts';

const SEOUL = 'Asia/Seoul';
let n = 0;
const ev = (over: Record<string, unknown>): Row => ({ id: `e${++n}`, title: 'x', project: '', date: '2026-11-11', time: null, tz: null, duration_min: 60, deleted_at: null, undone: false, ...over });
const td = (over: Record<string, unknown>): Row => ({ id: `t${++n}`, title: 'x', project: '', done: false, important: false, due: null, due_time: null, deleted_at: null, undone: false, ...over });

describe('weekBusy', () => {
  it('周一到周日 7 天；每天 = 日程 + 没完成、那天截止的待办；删除、撤销、完成的不算', () => {
    // 2026-11-14 是周六 → 这一周 11-09（一）～ 11-15（日）
    const events = [ev({ date: '2026-11-09' }), ev({ date: '2026-11-09' }), ev({ date: '2026-11-15' }), ev({ date: '2026-11-10', deleted_at: 1 }), ev({ date: '2026-11-16' })];
    const todos = [td({ due: '2026-11-09' }), td({ due: '2026-11-12', done: true }), td({ due: '2026-11-12', undone: true }), td({ due: '2026-11-13' })];
    const w = weekBusy(events, todos, '2026-11-14', SEOUL, 'zh-CN');
    expect(w.map((d) => d.date)).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
    expect(w.map((d) => d.n)).toEqual([3, 0, 0, 0, 1, 0, 1]);
  });

  it('今天是周一、周日：都落在同一周里', () => {
    expect(weekBusy([], [], '2026-11-09', SEOUL, 'zh-CN')[0]?.date).toBe('2026-11-09');
    expect(weekBusy([], [], '2026-11-15', SEOUL, 'zh-CN')[0]?.date).toBe('2026-11-09');
  });
});

describe('annivUpcoming', () => {
  const r = (id: string, x: Record<string, unknown>) => ({ id, name: id, deleted_at: null, undone: false, archived_at: null, ...x });
  it('within 天内、最多 max 个，按天数再按名字排；删除、归档、过去的不出', () => {
    const rows = [r('c', { next_date: '2026-12-10' }), r('b', { next_date: '2026-11-20' }), r('a', { next_date: '2026-11-20' }), r('far', { next_date: '2026-12-20' }), r('d', { next_date: '2026-11-15', deleted_at: 1 }), r('old', { next_date: '2026-11-01' })];
    expect(annivUpcoming(rows, '2026-11-14', 30, 3).map((x) => [x.row.id, x.days])).toEqual([
      ['a', 6],
      ['b', 6],
      ['c', 26],
    ]);
    expect(annivUpcoming(rows, '2026-11-14', 30, 1)).toHaveLength(1);
  });
});
