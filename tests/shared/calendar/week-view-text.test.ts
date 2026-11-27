// shared/logic/calendar/week-view.ts 手机色块写完整标题、按字宽撑开（负责人 11-17“周历上显示全部文字，时间以开始时间为准，结束时间对不上也没关系”）
// 手机用 dayPx = 1440（1 px = 1 分钟）方便核对；minBlockPx = 28；量字用假的 textPx（每个字 10 px 加 12 px 内边距）
import { describe, expect, it } from 'vitest';
import { buildWeek, type PhoneDay } from '../../../shared/logic/calendar/week-view.ts';
import { timed } from './fixtures.ts';

const SEOUL = 'Asia/Seoul';
const WEEK = '2026-10-19'; // 周一
const DAY = '2026-10-20';
const phone = { layout: 'phone' as const, tz: SEOUL, minBlockPx: 28, dayPx: 1440 };
const textPx = (s: string): number => [...s].length * 10 + 12;
const wide = { ...phone, textPx };

function dayOf(days: readonly PhoneDay[]): PhoneDay {
  const d = days.find((x) => x.date === DAY);
  if (!d) throw new Error(`no day ${DAY}`);
  return d;
}

describe('手机色块写完整标题：按字宽撑开', () => {
  it('短时长的块写不下长标题：撑开到字宽，开始位置不动；块上带完整标题', () => {
    const d = dayOf(buildWeek(WEEK, { todos: [], events: [timed('a', DAY, '09:00', SEOUL, 10, { title: '坐高铁去釜山出差' })] }, wide));
    expect(d.blocks.map((b) => [b.title, b.startPx, b.widthPx, b.row])).toEqual([['坐高铁去釜山出差', 540, 92, 0]]);
  });

  it('按时长已经够宽的不缩：取按时长的宽', () => {
    const d = dayOf(buildWeek(WEEK, { todos: [], events: [timed('a', DAY, '09:00', SEOUL, 120, { title: '会' })] }, wide));
    expect(d.blocks.map((b) => b.widthPx)).toEqual([120]);
  });

  it('撑开后撞上后一块：后一块进第二排，不叠在一起；再撞上的进第三排（负责人 11-18 全部显示，不再收成“+N”）', () => {
    const events = [
      timed('a', DAY, '09:00', SEOUL, 30, { title: '坐高铁去釜山出差' }), // 540～632
      timed('b', DAY, '10:00', SEOUL, 30, { title: '周会' }), // 600 起，撞上 a
      timed('c', DAY, '10:10', SEOUL, 30, { title: '交报告' }), // 610 起，前两排都占着
      timed('d', DAY, '12:00', SEOUL, 30, { title: '午饭' }), // 720 起，不撞
    ];
    const d = dayOf(buildWeek(WEEK, { todos: [], events }, wide));
    expect(d.blocks.map((b) => [b.itemId, b.row])).toEqual([['a', 0], ['b', 1], ['c', 2], ['d', 0]]);
    expect(d.rows).toBe(3);
    // 同一排的块左右不交叠
    for (const r of [0, 1, 2]) {
      const xs = d.blocks.filter((b) => b.row === r).sort((x, y) => x.startPx - y.startPx);
      for (let i = 1; i < xs.length; i++) expect((xs.at(i)?.startPx ?? 0) >= (xs.at(i - 1)?.startPx ?? 0) + (xs.at(i - 1)?.widthPx ?? 0)).toBe(true);
    }
  });

  it('撑到轨道末端为止（endPx），剩下的交给省略号；开始位置不往左挪', () => {
    const d = dayOf(buildWeek(WEEK, { todos: [], events: [timed('a', DAY, '21:30', SEOUL, 30, { title: '和客户开很长很长的视频会议' })] }, { ...wide, endPx: 1320 }));
    expect(d.blocks.map((b) => [b.startPx, b.widthPx])).toEqual([[1290, 30]]);
  });

  it('离轨道末端不到 minBlockPx：保留原来的兜底，右端对齐末端、往左补足', () => {
    const d = dayOf(buildWeek(WEEK, { todos: [], events: [timed('a', DAY, '21:50', SEOUL, 10, { title: '长标题长标题' })] }, { ...wide, endPx: 1320 }));
    expect(d.blocks.map((b) => [b.startPx, b.widthPx])).toEqual([[1292, 28]]);
  });

  it('不传 textPx、endPx：和原来一样按时长和 minBlockPx 排', () => {
    const events = [timed('a', DAY, '09:00', SEOUL, 10, { title: '坐高铁去釜山出差' }), timed('b', DAY, '23:50', SEOUL, 10)];
    const d = dayOf(buildWeek(WEEK, { todos: [], events }, phone));
    expect(d.blocks.map((b) => [b.itemId, b.startPx, b.widthPx])).toEqual([['a', 540, 28], ['b', 1412, 28]]);
  });

  it('跨天的这一段右端写“2/3”：textPx 带上第几天、共几天，色块宽把这几个字也算进去（11-17 日历整块评审第 1 条）', () => {
    const seen: [string, string][] = [];
    // 假的量法：标题每字 10 px，跨天的另加 30 px 写“2/2”，再加 12 px 内边距
    const withOf = (title: string, of?: { index: number; days: number }): number => {
      seen.push([title, of ? `${of.index}/${of.days}` : '']);
      return [...title].length * 10 + (of ? 30 : 0) + 12;
    };
    // 10-20 23:30 起两小时，跨到 10-21 01:30：第二天那一段 0～90 分钟
    const events = [timed('a', DAY, '23:30', SEOUL, 120, { title: '和客户开视频会' }), timed('b', DAY, '09:00', SEOUL, 10, { title: '周会' })];
    const days = buildWeek(WEEK, { todos: [], events }, { ...phone, textPx: withOf });
    const next = days.find((x) => x.date === '2026-10-21');
    expect(next?.blocks.map((b) => [b.itemId, b.startPx, b.widthPx, b.dayOf])).toEqual([['a', 0, 112, { index: 2, days: 2 }]]);
    expect(seen).toContainEqual(['和客户开视频会', '2/2']);
    expect(seen).toContainEqual(['周会', '']);
  });
});
