// shared/logic/calendar/month-grid.ts、cal-items.ts（TC-B2-08；架构 5.12 第 2 点、4.6、第 9 节单元 month-grid）
// 每个用例都显式传设备时区，和进程的 TZ 无关（test:tz 三个时区结果必须相同）
import { describe, expect, it } from 'vitest';
import { placeEvent, projectColorIndex, PROJECT_COLORS } from '../../../shared/logic/calendar/cal-items.ts';
import { buildMonth, dayEntries, monthGridDates, MONTH_CELLS, type MonthCell } from '../../../shared/logic/calendar/month-grid.ts';
import { normalizeProject, projectColorIndex as colorFromModule } from '../../../shared/logic/project-color.ts';
import { ev, timed, todo, unsynced } from './fixtures.ts';

const SEOUL = 'Asia/Seoul';
const LA = 'America/Los_Angeles';
const SHANGHAI = 'Asia/Shanghai';

const base = { tz: SEOUL, today: '2026-10-24', weekStart: 1 as const, maxMarks: 2 };
const cellOf = (cells: readonly MonthCell[], date: string): MonthCell => {
  const c = cells.find((x) => x.date === date);
  if (!c) throw new Error(`no cell ${date}`);
  return c;
};

describe('6×7 格子', () => {
  it('2026-11：周一起始从 10-26 起，周日起始从 11-01 起；都是 42 格', () => {
    const mon = monthGridDates({ y: 2026, m: 11 }, 1);
    expect(mon).toHaveLength(MONTH_CELLS);
    expect(mon[0]).toBe('2026-10-26');
    expect(mon[41]).toBe('2026-12-06');
    const sun = monthGridDates({ y: 2026, m: 11 }, 0);
    expect(sun[0]).toBe('2026-11-01');
    expect(sun[41]).toBe('2026-12-12');
  });

  it('跨年：2026-12 的补位格到 2027-01，inMonth 为 false', () => {
    const cells = buildMonth({ y: 2026, m: 12 }, { events: [], todos: [] }, base);
    expect(cells[0]?.date).toBe('2026-11-30');
    expect(cells[0]?.inMonth).toBe(false);
    expect(cellOf(cells, '2026-12-31').inMonth).toBe(true);
    expect(cellOf(cells, '2027-01-01').inMonth).toBe(false);
    expect(cells.filter((c) => c.inMonth)).toHaveLength(31);
  });

  it('2027-01 周日起始从 2026-12-27 起', () => {
    expect(monthGridDates({ y: 2027, m: 1 }, 0)[0]).toBe('2026-12-27');
  });

  it('闰年 2028-02 有 29 天，平年 2027-02 有 28 天（且 2027-02-01 是周一，周一起始时第一格就是 1 日）', () => {
    const leap = buildMonth({ y: 2028, m: 2 }, { events: [], todos: [] }, base);
    expect(leap.filter((c) => c.inMonth).map((c) => c.date).at(-1)).toBe('2028-02-29');
    const plain = buildMonth({ y: 2027, m: 2 }, { events: [], todos: [] }, base);
    expect(plain.filter((c) => c.inMonth)).toHaveLength(28);
    expect(plain[0]?.date).toBe('2027-02-01');
    expect(plain[28]?.date).toBe('2027-03-01');
  });

  it('isToday 只标今天那一格；month 不合法、maxMarks 不合法时抛错', () => {
    const cells = buildMonth({ y: 2026, m: 10 }, { events: [], todos: [] }, base);
    expect(cells.filter((c) => c.isToday).map((c) => c.date)).toEqual(['2026-10-24']);
    expect(() => buildMonth({ y: 2026, m: 13 }, { events: [], todos: [] }, base)).toThrow('bad_month');
    expect(() => monthGridDates({ y: 2026, m: 0 }, 1)).toThrow('bad_month');
    expect(() => buildMonth({ y: 2026, m: 10 }, { events: [], todos: [] }, { ...base, maxMarks: -1 })).toThrow('bad_max_marks');
  });
});

describe('weekday、设备时区无效', () => {
  it('每格带星期几（0 = 周日）；2026-11-01 是周日', () => {
    const cells = buildMonth({ y: 2026, m: 11 }, { events: [], todos: [] }, { ...base, weekStart: 0 });
    expect(cells.slice(0, 7).map((c) => c.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(cells[0]?.date).toBe('2026-11-01');
  });

  it('opts.tz 无效时开头就抛 bad_tz（哪怕没有日程）', () => {
    expect(() => buildMonth({ y: 2026, m: 10 }, { events: [], todos: [] }, { ...base, tz: 'Foo/Bar' })).toThrow('bad_tz');
    expect(() => buildMonth({ y: 2026, m: 10 }, { events: [], todos: [] }, { ...base, tz: '' })).toThrow('bad_tz');
  });
});

describe('项目色', () => {
  it('挪到 shared/logic/project-color.ts，cal-items 转出的是同一个函数', () => {
    expect(colorFromModule).toBe(projectColorIndex);
  });

  it('读屏汇总按规整后的项目名分组（和分色同一套）', () => {
    const day = '2026-10-24';
    const cells = buildMonth(
      { y: 2026, m: 10 },
      { events: [ev({ id: 'a', date: day, project: 'NEOX' }), ev({ id: 'b', date: day, project: ' NEOX ' })], todos: [todo({ id: 'c', due: day, project: '  ' })] },
      base,
    );
    expect(cellOf(cells, day).a11y).toEqual([
      { project: 'NEOX', count: 2 },
      { project: '', count: 1 },
    ]);
    expect(normalizeProject(' NEOX ')).toBe('NEOX');
  });

  it('同名同色、范围 1–6，没有项目是 0；首尾空白不影响', () => {
    for (const name of ['NEOX', 'SignPlex', '柠檬记', '사이니지', 'a', 'b', 'c', 'd']) {
      const c = projectColorIndex(name);
      expect(c >= 1 && c <= PROJECT_COLORS, name).toBe(true);
      expect(projectColorIndex(` ${name} `)).toBe(c);
    }
    expect(projectColorIndex('')).toBe(0);
    expect(projectColorIndex('   ')).toBe(0);
  });
});

describe('一天 5 件事（TC-B2-08）', () => {
  const day = '2026-10-24';
  const items = {
    events: [
      // 首尔记的固定日程 10:00，项目 NEOX
      timed('e-neox', day, '10:00', SEOUL, 60, { project: 'NEOX', title: '校对稿件', created_at: 10 }),
      // 没项目的全天日程
      ev({ id: 'e-allday', date: day, title: '회의 준비', created_at: 5 }),
      // 洛杉矶记的固定日程：夏令时 UTC-7，10-23 17:30 = UTC 10-24 00:30 = 首尔 10-24 09:30
      timed('e-la', '2026-10-23', '17:30', LA, 30, { project: 'NEOX', title: 'NEOX call', created_at: 20 }),
      // 删掉的不算
      timed('e-deleted', day, '09:00', SEOUL, 60, { deleted_at: 99 }),
    ],
    todos: [
      todo({ id: 't-open', due: day, project: 'SignPlex', title: 'SignPlex review', created_at: 1 }),
      todo({ id: 't-done', due: day, done: true, project: 'SignPlex' }),
      todo({ id: 't-nodue', due: null }),
    ],
  };

  it('跨时区的固定日程落在换算后的那天：洛杉矶 10-23 17:30 → 首尔 10-24 09:30', () => {
    const p = placeEvent(timed('e-la', '2026-10-23', '17:30', LA, 30), SEOUL);
    expect(p?.date).toBe('2026-10-24');
    expect(p && !p.allDay ? p.startMin : null).toBe(9 * 60 + 30);
  });

  it('一件事一个 mark；按“有时刻的日程（按时刻）→ 全天 → 待办”排；电脑 4 个全显示', () => {
    const cell = cellOf(buildMonth({ y: 2026, m: 10 }, items, { ...base, maxMarks: 4 }), day);
    expect(cell.marks).toEqual([
      { itemId: 'e-la', kind: 'timed', colorIndex: projectColorIndex('NEOX'), short: 'NE' },
      { itemId: 'e-neox', kind: 'timed', colorIndex: projectColorIndex('NEOX'), short: '校对' },
      { itemId: 'e-allday', kind: 'allDay', colorIndex: 0, short: '회의' },
      { itemId: 't-open', kind: 'todo', colorIndex: projectColorIndex('SignPlex'), short: 'Si' },
    ]);
    expect(cell.more).toBe(0);
  });

  it('手机最多 2 个，其余记进 more；读屏 a11y 按项目汇总全部件数（含没显示的）', () => {
    const cell = cellOf(buildMonth({ y: 2026, m: 10 }, items, base), day);
    expect(cell.marks.map((m) => m.itemId)).toEqual(['e-la', 'e-neox']);
    expect(cell.more).toBe(2);
    expect(cell.a11y).toEqual([
      { project: 'NEOX', count: 2 },
      { project: '', count: 1 },
      { project: 'SignPlex', count: 1 },
    ]);
  });

  it('设备换到洛杉矶：首尔 10-24 10:00 变成洛杉矶 10-23 18:00，挪到前一天', () => {
    const cells = buildMonth({ y: 2026, m: 10 }, items, { ...base, tz: LA, maxMarks: 4 });
    expect(cellOf(cells, '2026-10-23').marks.map((m) => m.itemId)).toEqual(['e-la', 'e-neox']);
    // 全天日程、待办是浮动的，日期原样
    expect(cellOf(cells, day).marks.map((m) => m.itemId)).toEqual(['e-allday', 't-open']);
  });

  it('纪念日不占标签，只标 anniv；节假日、农历按 opts 带进格子', () => {
    const cells = buildMonth({ y: 2026, m: 10 }, items, {
      ...base,
      annivDates: new Set([day]),
      holidays: new Map([['2026-10-03', [{ country: 'kr' as const, kind: 'off' as const, name: '개천절' }]]]),
      dayInfo: (d) => (d === day ? { lunar: '九月十四', solarTerm: '霜降' } : {}),
    });
    const cell = cellOf(cells, day);
    expect(cell.anniv).toBe(true);
    expect(cell.marks).toHaveLength(2);
    expect(cell.lunar).toBe('九月十四');
    expect(cell.solarTerm).toBe('霜降');
    expect(cellOf(cells, '2026-10-03').holidays).toEqual([{ country: 'kr', kind: 'off', name: '개천절' }]);
    expect('lunar' in cellOf(cells, '2026-10-25')).toBe(false);
    expect(cellOf(cells, '2026-10-25').anniv).toBe(false);
  });

  it('同一时刻的两件事按创建时间排', () => {
    const cells = buildMonth({ y: 2026, m: 10 },
      { events: [timed('b', day, '08:00', SEOUL, 30, { created_at: 2 }), timed('a', day, '08:00', SEOUL, 30, { created_at: 3 })], todos: [] },
      base,
    );
    expect(cellOf(cells, day).marks.map((m) => m.itemId)).toEqual(['b', 'a']);
  });
});

describe('时区边界和夏令时', () => {
  it('首尔 00:30 的日程在上海是前一天 23:30', () => {
    const p = placeEvent(timed('x', '2026-10-25', '00:30', SEOUL), SHANGHAI);
    expect(p?.date).toBe('2026-10-24');
  });

  it('洛杉矶拨快那天 02:30 不存在，按拨快后的 03:30 算', () => {
    const p = placeEvent(timed('x', '2026-03-08', '02:30', LA), LA);
    expect(p && !p.allDay ? [p.date, p.startMin] : null).toEqual(['2026-03-08', 3 * 60 + 30]);
  });

  it('洛杉矶拨慢那天 01:30 出现两次，取先出现的那次（换到首尔是 17:30）', () => {
    const p = placeEvent(timed('x', '2026-11-01', '01:30', LA), SEOUL);
    expect(p && !p.allDay ? [p.date, p.startMin] : null).toEqual(['2026-11-01', 17 * 60 + 30]);
  });

  it('日程的时区名无效（TZ-invalid-b2）时当设备时区的时刻，照样显示；日期坏了跳过', () => {
    const p = placeEvent(timed('x', '2026-10-24', '10:00', 'Foo/Bar'), SEOUL);
    expect(p && !p.allDay ? [p.date, p.startMin] : null).toEqual(['2026-10-24', 600]);
    expect(placeEvent(ev({ id: 'y', date: '2026-02-30' }), SEOUL)).toBeNull();
    const cells = buildMonth({ y: 2026, m: 2 }, { events: [ev({ id: 'y', date: '2026-02-30' })], todos: [] }, base);
    expect(cells.every((c) => c.marks.length === 0)).toBe(true);
  });

  it('补位格里的事也算（下月初的待办出现在本月视图的补位格里）', () => {
    const cells = buildMonth({ y: 2026, m: 10 }, { events: [], todos: [todo({ id: 't', due: '2026-11-01' })] }, base);
    expect(cellOf(cells, '2026-11-01').inMonth).toBe(false);
    expect(cellOf(cells, '2026-11-01').marks.map((m) => m.itemId)).toEqual(['t']);
  });
});

describe('dayEntries：某一天有哪几件事（前端 A 会审 ③）', () => {
  const day = '2026-10-24';
  const items = {
    events: [
      timed('late', day, '18:00', SEOUL, 30),
      timed('early', day, '07:00', SEOUL, 30),
      ev({ id: 'all', date: day }),
      timed('gone', day, '09:00', SEOUL, 30, { deleted_at: 1 }),
      timed('other', '2026-10-25', '09:00', SEOUL, 30),
    ],
    todos: [todo({ id: 'open', due: day }), todo({ id: 'done', due: day, done: true })],
  };

  it('删掉的、已完成的待办不算；按 compareEntries 排；和 buildMonth 那一格的顺序一致', () => {
    const list = dayEntries(day, items, SEOUL);
    expect(list.map((e) => [e.itemId, e.kind])).toEqual([
      ['early', 'timed'],
      ['late', 'timed'],
      ['all', 'allDay'],
      ['open', 'todo'],
    ]);
    const cell = cellOf(buildMonth({ y: 2026, m: 10 }, items, { ...base, maxMarks: 10 }), day);
    expect(cell.marks.map((m) => m.itemId)).toEqual(list.map((e) => e.itemId));
  });

  it('换算时区：首尔 10-25 00:30 在上海算 10-24', () => {
    expect(dayEntries(day, { events: [timed('x', '2026-10-25', '00:30', SEOUL)], todos: [] }, SHANGHAI).map((e) => e.itemId)).toEqual(['x']);
  });

  it('日期差 2 天的极端时区也不漏（UTC−12 的 23:59 = UTC+14 的后天 01:59）', () => {
    const list = dayEntries('2026-10-26', { events: [timed('x', '2026-10-24', '23:59', 'Etc/GMT+12')], todos: [] }, 'Pacific/Kiritimati');
    expect(list.map((e) => e.itemId)).toEqual(['x']);
  });

  it('日期不合法抛错，时区无效抛 bad_tz', () => {
    expect(() => dayEntries('2026-02-30', items, SEOUL)).toThrow('bad_date');
    expect(() => dayEntries(day, items, 'Foo/Bar')).toThrow('bad_tz');
  });
});

describe('耗时（代码审查 A）', () => {
  it('3000 条日程分散在 3 年里，算一个月不超过 300 ms', () => {
    const events = Array.from({ length: 3000 }, (_, i) => {
      const date = `${2025 + (i % 3)}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;
      return timed(`e${i}`, date, `${String(i % 24).padStart(2, '0')}:00`, i % 2 === 0 ? SEOUL : LA, 30, { project: `P${i % 9}` });
    });
    const t0 = performance.now();
    const cells = buildMonth({ y: 2026, m: 10 }, { events, todos: [] }, base);
    const ms = performance.now() - t0;
    expect(cells.reduce((n, c) => n + c.marks.length + c.more, 0)).toBeGreaterThan(0);
    expect(ms).toBeLessThan(300);
  });
});

describe('删除、撤销的判断（前端 A 会审：和 today-model 的 isLive 一致）', () => {
  const day = '2026-10-24';

  it('离线新建、还没同步的日程和待办（没有 deleted_at、undone 两列）照样出现在月历和单日列表里', () => {
    const items = {
      events: [unsynced(timed('new-ev', day, '09:00', SEOUL, 30)), unsynced(ev({ id: 'new-all', date: day }))],
      todos: [unsynced(todo({ id: 'new-td', due: day }))],
    };
    expect(items.events.every((e) => !('deleted_at' in e))).toBe(true);
    expect(dayEntries(day, items, SEOUL).map((e) => e.itemId)).toEqual(['new-ev', 'new-all', 'new-td']);
    const cell = cellOf(buildMonth({ y: 2026, m: 10 }, items, { ...base, maxMarks: 10 }), day);
    expect(cell.marks.map((m) => m.itemId)).toEqual(['new-ev', 'new-all', 'new-td']);
  });

  it('撤销的（undone 为 true）日程和待办不算；undone 为 false 的照常', () => {
    const items = {
      events: [timed('undone-ev', day, '09:00', SEOUL, 30, { undone: true }), timed('kept-ev', day, '10:00', SEOUL, 30, { undone: false })],
      todos: [todo({ id: 'undone-td', due: day, undone: true }), todo({ id: 'kept-td', due: day, undone: false })],
    };
    expect(dayEntries(day, items, SEOUL).map((e) => e.itemId)).toEqual(['kept-ev', 'kept-td']);
    const cell = cellOf(buildMonth({ y: 2026, m: 10 }, items, { ...base, maxMarks: 10 }), day);
    expect(cell.marks.map((m) => m.itemId)).toEqual(['kept-ev', 'kept-td']);
    expect(cell.more).toBe(0);
  });
});
