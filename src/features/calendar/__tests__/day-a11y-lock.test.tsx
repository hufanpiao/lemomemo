// 日期格、泳道按钮的读屏名字锁定（11-17 日历整块评审第 6 条：DayNum 组件、公共 dayA11y 抽出来以后，念出来的文字和抽之前一字不差）
// 快照是抽之前的代码录下来的：月格（中文、韩文）、手机周泳道（中文）各一整页的 aria-label；节假日文件用替身（中文界面：放假两天连休、带补班尾巴的补班日；
// 韩文界面默认按韩国节假日，替身里没有，只锁住韩文的拼法），
// 有今天、农历、跨天全天日程、有时刻的日程、逾期待办。“今天”固定在 2026-11-05（周四）09:00
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import type { AppJson } from '../../../platform/app-static.ts';

type Row = { id: string } & Record<string, unknown>;
const data: { events: Row[]; todos: Row[]; settings: Row[] } = { events: [], todos: [], settings: [] };
const collections: Record<string, () => Row[]> = { events: () => data.events, todos: () => data.todos, settings: () => data.settings };
vi.mock('../../../kit/hooks/useCollection.ts', () => ({
  useCollection: (name: string) => collections[name]?.() ?? [],
}));
const hols = (country: string): AppJson => ({
  kind: 'ok',
  json: {
    country,
    year: 2026,
    days: [
      { date: '2026-11-03', kind: 'off', name: { zh: '测试假', ko: '테스트휴일' } },
      { date: '2026-11-04', kind: 'off', name: { zh: '测试假', ko: '테스트휴일' } },
      { date: '2026-11-07', kind: 'work', name: { zh: '测试假补班', ko: '테스트휴일 대체 근무일' } },
    ],
  },
});
vi.mock('../../../platform/app-static.ts', () => ({
  fetchAppJsonStatus: async (p: string): Promise<AppJson> => (p === 'holidays/cn/2026.json' ? hols('cn') : p === 'holidays/kr/2026.json' ? hols('kr') : { kind: 'missing' }),
}));

const { default: CalendarPage } = await import('../ui/CalendarPage.tsx');
const { resetHolidayCacheForTest } = await import('../hooks/useHolidays.ts');
const { resetLunarForTest } = await import('../hooks/useLunar.ts');
const { lazyLib } = await import('../../../core/anniv-lib.ts');
const realLunar = await import('../../../../shared/logic/anniv/lunar.ts');

const TZ = currentTz();
const NOW = msAt('2026-11-05', 9 * 60, TZ);
const W = 336;

const ev = (id: string, over: Record<string, unknown> = {}): Row => ({
  id, title: `日程${id}`, short: null, short_by: null, project: '', date: '2026-11-05', time: '10:00', tz: TZ, duration_min: 60, created_at: 1, deleted_at: null, undone: false, ...over,
});
const todo = (id: string, over: Record<string, unknown> = {}): Row => ({
  id, title: `待办${id}`, short: null, short_by: null, project: '', due: '2026-11-04', due_time: null, done: false, created_at: 1, deleted_at: null, undone: false, ...over,
});

class FakeRO {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: W, height: 44, x: 0, y: 0, top: 0, left: 0, right: W, bottom: 44, toJSON: () => ({}) } as DOMRect);
  vi.stubGlobal('ResizeObserver', FakeRO);
  data.events = [
    ev('1', { title: '出差深圳', date: '2026-11-05', time: null, duration_min: 3 * 1440, project: 'NEOX' }),
    ev('2', { title: '周会', date: '2026-11-06', time: '10:00' }),
  ];
  data.todos = [todo('1', { title: '交报告' })];
  data.settings = [];
  resetHolidayCacheForTest();
  resetLunarForTest(lazyLib('lunar', async () => realLunar));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function labels(hash: string, sel: string, wait: string): Promise<string[]> {
  window.history.replaceState(null, '', `/app/${hash}`);
  render(<CalendarPage />);
  const all = (): string[] => [...document.querySelectorAll(sel)].map((b) => b.getAttribute('aria-label') ?? '');
  await waitFor(() => expect(all().join('\n')).toContain(wait));
  return all();
}

describe('读屏名字和抽 DayNum、dayA11y 之前一字不差', () => {
  it('月格（中文）', async () => {
    uiStore.getState().setLocale('zh-CN');
    const got = await labels('#/cal/month/2026-11', '[data-testid="cal-month"] button[data-date]', '农历');
    expect(got.filter((s) => /11月[2-9]日/.test(s))).toMatchInlineSnapshot(`
      [
        "2 廿四，11月2日，周一，农历九月廿四，没有安排",
        "3 测试假，11月3日，周二，测试假，农历九月廿五，没有安排",
        "4 廿六 交报告，11月4日，周三，测试假，农历九月廿六，共 1 件，未分项目 1 件",
        "5 廿七 出差深圳，11月5日，周四，今天，农历九月廿七，共 1 件，NEOX 1 件",
        "6 廿八 周会，11月6日，周五，农历九月廿八，共 2 件，未分项目 1 件，NEOX 1 件",
        "7 班 测试假，11月7日，周六，测试假补班，立冬，农历九月廿九，共 1 件，NEOX 1 件",
        "8 三十，11月8日，周日，农历九月三十，没有安排",
        "9 十月，11月9日，周一，农历十月初一，没有安排",
      ]
    `);
  });

  it('月格（韩文）', async () => {
    uiStore.getState().setLocale('ko-KR');
    const got = await labels('#/cal/month/2026-11', '[data-testid="cal-month"] button[data-date]', '목요일');
    expect(got.filter((s) => /11월 [2-9]일/.test(s))).toMatchInlineSnapshot(`
      [
        "2, 11월 2일, 월요일, 일정 없음",
        "3, 11월 3일, 화요일, 일정 없음",
        "4 交报告, 11월 4일, 수요일, 모두 1건, 프로젝트 없음 1건",
        "5 出差深圳, 11월 5일, 목요일, 오늘, 모두 1건, NEOX 1건",
        "6 周会, 11월 6일, 금요일, 모두 2건, 프로젝트 없음 1건, NEOX 1건",
        "7, 11월 7일, 토요일, 모두 1건, NEOX 1건",
        "8, 11월 8일, 일요일, 일정 없음",
        "9, 11월 9일, 월요일, 일정 없음",
      ]
    `);
  });

  it('手机周泳道（中文）', async () => {
    uiStore.getState().setLocale('zh-CN');
    const got = await labels('#/cal/week/2026-11-05', '[data-testid="cal-week"] li[data-date] > button', '测试假');
    expect(got).toMatchInlineSnapshot(`
      [
        "周一 2 廿四，11月2日，没有安排",
        "周二 3 测试假，11月3日，测试假，没有安排",
        "周三 4 廿六，11月4日，测试假，共 1 件，有逾期的待办",
        "周四 5 廿七 出差深圳 1/3，11月5日，今天，共 1 件",
        "周五 6 廿八 出差深圳 2/3 周会，11月6日，共 2 件",
        "周六 7 班 测试假 出差深圳 3/3，11月7日，测试假补班，共 1 件",
        "周日 8 三十，11月8日，没有安排",
      ]
    `);
  });
});
