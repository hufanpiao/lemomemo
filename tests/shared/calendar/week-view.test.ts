// shared/logic/calendar/week-view.ts（TC-B2-09；架构 5.12 第 2 点、R-107、R-109、R-110、第 9 节单元“buildWeek 布局”）
// 手机用 dayPx = 1440（1 px = 1 分钟）方便核对；minBlockPx = 28
import { describe, expect, it } from 'vitest';
import { buildWeek, type PhoneDay, type DeskDay } from '../../../shared/logic/calendar/week-view.ts';
import { dayEntries } from '../../../shared/logic/calendar/cal-items.ts';
import { ev, timed, todo, unsynced } from './fixtures.ts';

const SEOUL = 'Asia/Seoul';
const LA = 'America/Los_Angeles';
const WEEK = '2026-10-19'; // 周一
const phone = { layout: 'phone' as const, tz: SEOUL, minBlockPx: 28, dayPx: 1440 };
const desk = { layout: 'desk' as const, tz: SEOUL };

function dayOf<T extends PhoneDay | DeskDay>(days: readonly T[], date: string): T {
  const d = days.find((x) => x.date === date);
  if (!d) throw new Error(`no day ${date}`);
  return d;
}

describe('手机布局（R-109、R-110）', () => {
  it('7 天、从 weekStart 起', () => {
    expect(buildWeek(WEEK, { todos: [], events: [] }, phone).map((d) => d.date)).toEqual([
      '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25',
    ]);
  });

  it('10 分钟的事项显示长度不小于 28 px，从自己的开始时刻画起；带简称', () => {
    const d = dayOf(buildWeek(WEEK, { todos: [], events: [timed('a', '2026-10-20', '09:00', SEOUL, 10, { title: '校对稿件' })] }, phone), '2026-10-20');
    expect(d.blocks).toEqual([
      { itemId: 'a', colorIndex: 0, short: '校对', startMin: 540, endMin: 550, startPx: 540, widthPx: 28, row: 0, rows: 1 },
    ]);
    expect(d.groups).toEqual([{ moreAtPx: 568, more: 0, hiddenIds: [] }]);
  });

  it('相隔 5 分钟的两件短事项：一个 row 0、一个 row 1，rows 都是 2，startPx 各自对位', () => {
    const d = dayOf(
      buildWeek(WEEK, { todos: [], events: [timed('a', '2026-10-20', '09:00', SEOUL, 10), timed('b', '2026-10-20', '09:05', SEOUL, 10)] }, phone),
      '2026-10-20',
    );
    expect(d.blocks.map((b) => [b.itemId, b.startPx, b.row, b.rows])).toEqual([
      ['a', 540, 0, 2],
      ['b', 545, 1, 2],
    ]);
  });

  it('三件同时段的短事项：第 3 件不画，这一组 more = 1，“+N”写在最后一个可见块右边', () => {
    const d = dayOf(
      buildWeek(
        WEEK,
        {
          todos: [],
          events: [
            timed('a', '2026-10-20', '09:00', SEOUL, 10),
            timed('b', '2026-10-20', '09:02', SEOUL, 10),
            timed('c', '2026-10-20', '09:04', SEOUL, 10),
          ],
        },
        phone,
      ),
      '2026-10-20',
    );
    expect(d.blocks.map((b) => b.itemId)).toEqual(['a', 'b']);
    expect(d.groups).toEqual([{ moreAtPx: 542 + 28, more: 1, hiddenIds: ['c'] }]);
  });

  it('上排空出来以后第 3 件放回上排（不是一律不画）', () => {
    const d = dayOf(
      buildWeek(
        WEEK,
        {
          todos: [],
          events: [
            timed('a', '2026-10-20', '09:00', SEOUL, 10),
            timed('b', '2026-10-20', '09:20', SEOUL, 60),
            timed('c', '2026-10-20', '09:30', SEOUL, 10),
          ],
        },
        phone,
      ),
      '2026-10-20',
    );
    // a [540,568]、b [560,620] 交叠 → b 下排；c 从 570 开始，上排 568 已空 → 上排
    expect(d.blocks.map((b) => [b.itemId, b.row, b.rows])).toEqual([
      ['a', 0, 2],
      ['b', 1, 2],
      ['c', 0, 2],
    ]);
    expect(d.groups).toEqual([{ moreAtPx: 620, more: 0, hiddenIds: [] }]);
  });

  it('没有重叠的块 rows = 1，各成一组；首尾正好相接不算重叠', () => {
    const d = dayOf(
      buildWeek(
        WEEK,
        { todos: [], events: [timed('a', '2026-10-20', '09:00', SEOUL, 60), timed('b', '2026-10-20', '10:00', SEOUL, 60), timed('c', '2026-10-20', '15:00', SEOUL, 30)] },
        phone,
      ),
      '2026-10-20',
    );
    expect(d.blocks.map((b) => [b.itemId, b.row, b.rows])).toEqual([
      ['a', 0, 1],
      ['b', 0, 1],
      ['c', 0, 1],
    ]);
    expect(d.groups).toHaveLength(3);
  });

  it('全天事项不进时间轴，计入“全天 N”；N = 1 时带简称', () => {
    const days = buildWeek(
      WEEK,
      {
        todos: [],
        events: [
          ev({ id: 'x', date: '2026-10-21', title: '회의 준비' }),
          ev({ id: 'y', date: '2026-10-22', title: '甲', created_at: 2 }),
          ev({ id: 'z', date: '2026-10-22', title: '乙', created_at: 1 }),
        ],
      },
      phone,
    );
    expect(dayOf(days, '2026-10-21')).toEqual({ date: '2026-10-21', allDay: { count: 1, short: '회의', itemIds: ['x'], kinds: ['allDay'] }, todos: [], blocks: [], groups: [] });
    expect(dayOf(days, '2026-10-22').allDay).toEqual({ count: 2, short: null, itemIds: ['z', 'y'], kinds: ['allDay', 'allDay'] });
    expect(dayOf(days, '2026-10-20').allDay.count).toBe(0);
  });

  it('23:30–01:00 的事项在午夜切成两段，cont 标被切的一边', () => {
    const days = buildWeek(WEEK, { todos: [], events: [timed('a', '2026-10-20', '23:30', SEOUL, 90)] }, phone);
    expect(dayOf(days, '2026-10-20').blocks.map((b) => [b.startMin, b.endMin, b.cont])).toEqual([[1410, 1440, 'end']]);
    expect(dayOf(days, '2026-10-21').blocks.map((b) => [b.startMin, b.endMin, b.cont, b.startPx, b.widthPx])).toEqual([[0, 60, 'start', 0, 60]]);
  });

  it('23:55 开始的 10 分钟事项：当天那段右端对齐当天末尾、宽度仍是 28 px', () => {
    const days = buildWeek(WEEK, { todos: [], events: [timed('a', '2026-10-20', '23:55', SEOUL, 10)] }, phone);
    const first = dayOf(days, '2026-10-20').blocks[0];
    expect([first?.startPx, first?.widthPx, first?.startMin, first?.cont]).toEqual([1440 - 28, 28, 1435, 'end']);
    expect(dayOf(days, '2026-10-21').blocks.map((b) => [b.startMin, b.endMin, b.widthPx])).toEqual([[0, 5, 28]]);
  });

  it('拉长后超出末尾但截完仍够最小长度的，只截不挪', () => {
    const b = dayOf(buildWeek(WEEK, { todos: [], events: [timed('a', '2026-10-20', '23:00', SEOUL, 60)] }, { ...phone, minBlockPx: 28 }), '2026-10-20').blocks[0];
    expect([b?.startPx, b?.widthPx]).toEqual([1380, 60]);
  });

  it('按 dayPx 缩放（360 px 一天）', () => {
    const b = dayOf(buildWeek(WEEK, { todos: [], events: [timed('a', '2026-10-20', '12:00', SEOUL, 240)] }, { ...phone, dayPx: 360 }), '2026-10-20').blocks[0];
    expect([b?.startPx, b?.widthPx]).toEqual([180, 60]);
  });

  it('不在这一周的、删掉的不出现；dayPx 不合法时抛错', () => {
    const days = buildWeek(
      WEEK,
      { todos: [], events: [timed('a', '2026-10-26', '09:00', SEOUL), timed('b', '2026-10-20', '09:00', SEOUL, 60, { deleted_at: 5 })] },
      phone,
    );
    expect(days.every((d) => d.blocks.length === 0)).toBe(true);
    expect(() => buildWeek(WEEK, { todos: [], events: [] }, { ...phone, dayPx: 0 })).toThrow('bad_week_opts');
    expect(() => buildWeek(WEEK, { todos: [], events: [] }, { ...phone, tz: 'Foo/Bar' })).toThrow('bad_tz');
    expect(() => buildWeek(WEEK, { todos: [], events: [] }, { ...desk, tz: 'Foo/Bar' })).toThrow('bad_tz');
  });

  it('跨周：上一周最后一天 23:30 开始的事项，切下来的后半段落进这一周第一天', () => {
    const days = buildWeek(WEEK, { todos: [], events: [timed('a', '2026-10-18', '23:30', SEOUL, 60)] }, phone);
    expect(dayOf(days, WEEK).blocks.map((b) => [b.itemId, b.startMin, b.endMin, b.cont])).toEqual([['a', 0, 30, 'start']]);
  });
});

describe('跨时区和夏令时', () => {
  it('预筛不漏：极端时区下前一天开始、跨午夜进到这一周第一天的后半段照样算', () => {
    // UTC−12 的 10-16 22:30 起 1440 分钟 = UTC+14 的 10-18 00:30 → 10-19 00:30；ev.date 比这一周第一天（10-19）早 3 天，
    // 预筛要放宽 2 天（时区差）再加 1 天（跨午夜）才不漏；切下来的后半段是 10-19 的 0–30 分钟
    const days = buildWeek(WEEK, { todos: [], events: [timed('x', '2026-10-16', '22:30', 'Etc/GMT+12', 1440)] }, { ...phone, tz: 'Pacific/Kiritimati' });
    expect(dayOf(days, WEEK).blocks.map((b) => [b.itemId, b.startMin, b.endMin, b.cont])).toEqual([['x', 0, 30, 'start']]);
  });

  it('首尔记的 10-21 08:00 在洛杉矶周视图里落在 10-20 16:00', () => {
    const days = buildWeek(WEEK, { todos: [], events: [timed('a', '2026-10-21', '08:00', SEOUL, 60)] }, { ...phone, tz: LA });
    expect(dayOf(days, '2026-10-20').blocks.map((b) => [b.startMin, b.endMin])).toEqual([[960, 1020]]);
  });

  it('洛杉矶拨慢那天（2026-11-01）01:30 开始 120 分钟：墙上时间 01:30 → 02:30', () => {
    const days = buildWeek('2026-10-26', { todos: [], events: [timed('a', '2026-11-01', '01:30', LA, 120)] }, { ...phone, tz: LA });
    expect(dayOf(days, '2026-11-01').blocks.map((b) => [b.startMin, b.endMin])).toEqual([[90, 150]]);
  });

  it('洛杉矶拨快那天（2026-03-08）22:00 开始 180 分钟：午夜切开，次日 00:00–01:00', () => {
    const days = buildWeek('2026-03-02', { todos: [], events: [timed('a', '2026-03-07', '22:00', LA, 180)] }, { ...phone, tz: LA });
    expect(dayOf(days, '2026-03-07').blocks.map((b) => [b.startMin, b.endMin, b.cont])).toEqual([[1320, 1440, 'end']]);
    expect(dayOf(days, '2026-03-08').blocks.map((b) => [b.startMin, b.endMin, b.cont])).toEqual([[0, 60, 'start']]);
  });
});

describe('电脑布局（minBlockPx = 0、时间轴纵向）', () => {
  it('按真实时长，重叠的并排分列；一簇共用 columns，不重叠的单独一列', () => {
    const d = dayOf(
      buildWeek(
        WEEK,
        {
          todos: [],
          events: [
            timed('a', '2026-10-20', '09:00', SEOUL, 60),
            timed('b', '2026-10-20', '09:30', SEOUL, 60),
            timed('c', '2026-10-20', '10:00', SEOUL, 60),
            timed('d', '2026-10-20', '12:00', SEOUL, 10),
          ],
        },
        desk,
      ),
      '2026-10-20',
    );
    expect(d.blocks.map((b) => [b.itemId, b.startMin, b.endMin, b.column, b.columns])).toEqual([
      ['a', 540, 600, 0, 2],
      ['b', 570, 630, 1, 2],
      ['c', 600, 660, 0, 2],
      ['d', 720, 730, 0, 1],
    ]);
    expect('startPx' in (d.blocks[3] ?? {})).toBe(false);
  });

  it('三件同时开始的分 3 列，跨午夜的照样切段', () => {
    const days = buildWeek(
      WEEK,
      {
        todos: [],
        events: [
          timed('a', '2026-10-20', '23:00', SEOUL, 120),
          timed('b', '2026-10-20', '23:00', SEOUL, 30, { created_at: 2 }),
          timed('c', '2026-10-20', '23:00', SEOUL, 30, { created_at: 3 }),
        ],
      },
      desk,
    );
    expect(dayOf(days, '2026-10-20').blocks.map((b) => [b.itemId, b.column, b.columns])).toEqual([
      ['a', 0, 3],
      ['b', 1, 3],
      ['c', 2, 3],
    ]);
    expect(dayOf(days, '2026-10-21').blocks.map((b) => [b.itemId, b.startMin, b.endMin, b.cont, b.columns])).toEqual([['a', 0, 60, 'start', 1]]);
  });
});

describe('待办（和前端 A 对过的接口：手机 todos、电脑并进全天那一行）', () => {
  const todos = [
    todo({ id: 't1', due: '2026-10-20', created_at: 2 }),
    todo({ id: 't0', due: '2026-10-20', created_at: 1, project: '工作' }),
    todo({ id: 'done', due: '2026-10-20', done: true }),
    todo({ id: 'del', due: '2026-10-20', deleted_at: 9 }),
    todo({ id: 'nodue', due: null }),
    todo({ id: 'out', due: '2026-10-26' }),
    todo({ id: 'sun', due: '2026-10-25' }),
  ];
  const events = [ev({ id: 'all', date: '2026-10-20' }), timed('tm', '2026-10-20', '09:00', SEOUL)];

  it('手机：截止日那天的 todos，kind 为 todo、按创建时间排；全天和时间轴不含待办', () => {
    const days = buildWeek(WEEK, { events, todos }, phone);
    const d = dayOf(days, '2026-10-20');
    expect(d.todos.map((e) => [e.itemId, e.kind])).toEqual([
      ['t0', 'todo'],
      ['t1', 'todo'],
    ]);
    expect(d.todos[0]?.project).toBe('工作');
    expect(d.allDay.itemIds).toEqual(['all']);
    expect(d.blocks.map((b) => b.itemId)).toEqual(['tm']);
    expect(dayOf(days, '2026-10-25').todos.map((e) => e.itemId)).toEqual(['sun']);
    expect(days.flatMap((x) => x.todos.map((e) => e.itemId))).not.toContain('out');
  });

  it('电脑：待办并进全天那一行，排在全天日程后面', () => {
    const d = dayOf(buildWeek(WEEK, { events, todos }, desk), '2026-10-20');
    expect(d.allDay).toEqual({ count: 3, short: null, itemIds: ['all', 't0', 't1'], kinds: ['allDay', 'todo', 'todo'] });
    expect(d.blocks.map((b) => b.itemId)).toEqual(['tm']);
  });

  it('电脑：那天只有一件待办时，全天那一行带它的简称', () => {
    const d = dayOf(buildWeek(WEEK, { events: [], todos: [todo({ id: 'x', due: '2026-10-21', title: '交稿' })] }, desk), '2026-10-21');
    expect(d.allDay.count).toBe(1);
    expect(d.allDay.short).not.toBeNull();
    expect(d.allDay.itemIds).toEqual(['x']);
    expect(d.allDay.kinds).toEqual(['todo']);
  });

  it('过滤规则和月历一致：同一份数据，每天的待办和 dayEntries 里的待办一样', () => {
    const items = { events, todos };
    const days = buildWeek(WEEK, items, phone);
    for (const d of days) {
      const fromMonth = dayEntries(d.date, items, SEOUL).filter((e) => e.kind === 'todo');
      expect(d.todos).toEqual(fromMonth);
    }
  });

  it('待办截止日是浮动日期，换设备时区也不挪天', () => {
    const d = dayOf(buildWeek(WEEK, { events: [], todos }, { ...phone, tz: LA }), '2026-10-20');
    expect(d.todos.map((e) => e.itemId)).toEqual(['t0', 't1']);
  });
});

describe('删除、撤销的判断（前端 A 会审：和月历同一条 isLiveRow）', () => {
  it('没有 deleted_at、undone 两列的本机新行照样上周视图；撤销的日程、待办不上', () => {
    const fresh = unsynced(timed('fresh', '2026-10-20', '09:00', SEOUL));
    expect('deleted_at' in fresh || 'undone' in fresh).toBe(false);
    const items = {
      events: [fresh, timed('gone', '2026-10-20', '11:00', SEOUL, 60, { undone: true })],
      todos: [todo({ id: 'td-undone', due: '2026-10-20', undone: true }), todo({ id: 'td', due: '2026-10-20' })],
    };
    const p = dayOf(buildWeek(WEEK, items, phone), '2026-10-20');
    expect(p.blocks.map((b) => b.itemId)).toEqual(['fresh']);
    expect(p.todos.map((e) => e.itemId)).toEqual(['td']);
    const d = dayOf(buildWeek(WEEK, items, desk), '2026-10-20');
    expect(d.blocks.map((b) => b.itemId)).toEqual(['fresh']);
    expect(d.allDay.itemIds).toEqual(['td']);
  });
});
