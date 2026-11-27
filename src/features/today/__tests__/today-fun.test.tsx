// 今天页没日程时的组合区（负责人 11-22、11-23 定稿 今天页空白趣味 方案4.html；ui/TodayFun.tsx、data/today-fun.ts）：
// • 这周做完：一周从周日起（负责人 11-23 原话），柱子 日 一 二 三 四 五 六；上周也是周日到周六；删掉的、没完成的、done_at 坏了的不算；按首尔时区的日子落
// • 顺手做：没完成、没定日期的待办里按 H → M → L、再按创建时间排第一的；只读行跳过；“N 天前记的”按首尔的日子算
// • 柱子高度：定稿 6 + 件数 × 8（3 件正好 30），一天超过 3 件按最多那天压到 30，0 件一截 4px
// • 组件：画出顺手做那一件、件数、比上周、七根柱子的星期字和今天那根；点“放进今天”把截止日写成今天；挂上时运行日志只记数，不记待办标题
// • 中韩词条占位符逐键一致
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { barHeight, quickTodo, weekDone } from '../data/today-fun.ts';
import { todayFunKo } from '../i18n/fun-ko.ts';
import { todayFunZh } from '../i18n/fun-zh.ts';

const TZ = 'Asia/Seoul';
const TODAY = '2026-11-25'; // 周三；这周从 11-22（周日）起
const at = (d: string, hm = '12:00'): number => msAt(d, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)), TZ);
const row = (id: string, o: Record<string, unknown> = {}) => ({
  id, title: `待办 ${id}`, done: false, due: null, priority: 'mid', created_at: at('2026-11-20'), done_at: 0, deleted_at: null, undone: false, ...o,
});
const done = (id: string, d: string, hm?: string) => row(id, { done: true, done_at: at(d, hm), due: d });

describe('这周做完（周日起）', () => {
  it('周日到周六一根一天，今天是第几根；上周周日到周六算进比上周', () => {
    const rows = [
      done('a', '2026-11-22', '00:10'), // 周日凌晨（首尔）：这周第一根
      done('b', '2026-11-23'), done('c', '2026-11-23'),
      done('d', '2026-11-25'),
      done('e', '2026-11-21', '23:50'), // 上周六：算上周
      done('f', '2026-11-15'), // 上周日：算上周
      done('g', '2026-11-14'), // 上上周六：不算
      row('h', { done: true, done_at: at('2026-11-24'), deleted_at: 1 }), // 删了不算
      row('i', { done: false, done_at: at('2026-11-24') }), // 没完成不算
      row('j', { done: true, done_at: 0 }), // 没有完成时刻不算
    ];
    const w = weekDone(rows, TODAY, TZ);
    expect(w.bars).toEqual([1, 2, 0, 1, 0, 0, 0]);
    expect(w.n).toBe(4);
    expect(w.diff).toBe(2);
    expect(w.todayIdx).toBe(3);
  });
  it('今天是周日时只有第一根，上周整周都算上周', () => {
    const w = weekDone([done('a', '2026-11-22'), done('b', '2026-11-21'), done('c', '2026-11-20'), done('d', '2026-11-16')], '2026-11-22', TZ);
    expect(w.bars).toEqual([1, 0, 0, 0, 0, 0, 0]);
    expect(w.todayIdx).toBe(0);
    expect(w.diff).toBe(1 - 3);
  });
});

describe('顺手做挑哪一件', () => {
  it('没完成、没定日期的里按 H → M → L 再按创建时间；只读、做完、有日期、删掉的跳过', () => {
    const rows = [
      row('old-low', { priority: 'low', created_at: at('2026-11-01') }),
      row('mid-new', { created_at: at('2026-11-24') }),
      row('mid-old', { created_at: at('2026-11-22') }),
      row('ro-high', { priority: 'high' }),
      row('dated-high', { priority: 'high', due: TODAY }),
      row('done-high', { priority: 'high', done: true }),
      row('del-high', { priority: 'high', deleted_at: 5 }),
    ];
    const q = quickTodo(rows, TODAY, TZ, new Set(['ro-high']));
    expect(q?.todo.id).toBe('mid-old');
    expect(q?.ago).toBe(3);
  });
  it('今天记的是 0 天；一件都没有回 null', () => {
    expect(quickTodo([row('x', { created_at: at(TODAY, '08:00') })], TODAY, TZ, new Set())?.ago).toBe(0);
    expect(quickTodo([row('y', { due: TODAY })], TODAY, TZ, new Set())).toBeNull();
  });
});

describe('柱子高度', () => {
  it('定稿 6 + 件数 × 8；超过 3 件按最多那天压到 30；0 件 4px', () => {
    expect([0, 1, 2, 3].map((n) => barHeight(n, 3))).toEqual([4, 14, 22, 30]);
    expect(barHeight(6, 6)).toBe(30);
    expect(barHeight(3, 6)).toBe(18);
    expect(barHeight(1, 1)).toBe(14);
  });
});

describe('词条', () => {
  it('中韩键一样、占位符一样', () => {
    expect(Object.keys(todayFunKo).sort()).toEqual(Object.keys(todayFunZh).sort());
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(todayFunZh) as (keyof typeof todayFunZh)[]) expect(ph(todayFunKo[k])).toEqual(ph(todayFunZh[k]));
    expect([...todayFunZh['fun.wd']]).toHaveLength(7);
    expect([...todayFunKo['fun.wd']]).toHaveLength(7);
  });
});

// ---------- 组件 ----------
const st = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], logs: [] as string[], dues: [] as [string, string][] }));
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: (name: string) => (name === 'todos' ? st.rows : []) }));
vi.mock('../../../core/current-tz.ts', () => ({ currentTz: () => 'Asia/Seoul' }));
vi.mock('../../../platform/run-log-api.ts', () => ({ rlog: (l: string) => st.logs.push(l) }));
vi.mock('../../calendar/index.ts', () => ({ FortuneTile: () => <div data-testid="fake-fortune" /> }));
vi.mock('../../../core/todo-writes.ts', () => ({
  setTodoDue: async (r: { id: string }, due: string) => {
    st.dues.push([r.id, due]);
    return 'saved';
  },
}));

const { default: TodayFun } = await import('../ui/TodayFun.tsx');

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  st.logs = [];
  st.dues = [];
  st.rows = [row('q1', { title: '换卧室的灯泡', created_at: at('2026-11-22') }), done('a', '2026-11-23'), done('b', '2026-11-23'), done('c', '2026-11-24'), done('z', '2026-11-18')];
});
afterEach(cleanup);

describe('组合区', () => {
  it('顺手做、今日小运、这周做完照定稿排；柱子 日 到 六、今天那根加深', () => {
    render(<TodayFun today={TODAY} />);
    const quick = screen.getByTestId('today-fun-quick');
    expect(quick.textContent).toContain('今天空着，要不要把它做了？');
    expect(quick.textContent).toContain('换卧室的灯泡');
    expect(quick.textContent).toContain('没定日期 · 3 天前记的');
    expect(screen.getByTestId('today-fun-go').textContent).toBe('放进今天');
    expect(screen.getByTestId('fake-fortune')).toBeTruthy();
    const week = screen.getByTestId('today-fun-week');
    expect(week.textContent).toContain('这周做完');
    expect(week.textContent).toContain('3件');
    expect(week.textContent).toContain('比上周 +2');
    const cols = [...screen.getByTestId('today-fun-bars').children];
    expect(cols.map((c) => c.textContent).join('')).toBe('日一二三四五六');
    expect(cols.map((c) => c.getAttribute('data-n'))).toEqual(['0', '2', '1', '0', '0', '0', '0']);
    expect(cols[3]?.className).toMatch(/today/);
    // 运行日志只记数，不记标题
    expect(st.logs).toContain('today-fun show quick=1 week=3 diff=2');
    expect(st.logs.join('\n')).not.toContain('灯泡');
  });
  it('点“放进今天”把截止日写成今天', async () => {
    render(<TodayFun today={TODAY} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('today-fun-go'));
    });
    await vi.waitFor(() => expect(st.dues).toEqual([['q1', TODAY]]));
    expect(st.logs).toContain('today-fun put ok');
  });
  it('没有没定日期的待办时不画顺手做；比上周少了写“比上周 −N”', () => {
    st.rows = [done('a', '2026-11-23'), done('x', '2026-11-18'), done('y', '2026-11-19')];
    render(<TodayFun today={TODAY} />);
    expect(screen.queryByTestId('today-fun-quick')).toBeNull();
    expect(screen.getByTestId('today-fun-week').textContent).toContain('比上周 −1');
  });
});
