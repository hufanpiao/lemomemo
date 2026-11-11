// 日历页右上角的设置入口头像（R-381，负责人 11-11“进入设置的头像页面在日历跟代办上也放一个吧，不然不和谐”；四页共用 kit 的 MeLink）
// 从 CalendarPage.test.tsx 拆出来（那个文件已过 max-lines 300）；集合、节假日用同样的替身，“今天”固定在 2026-11-05
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import type { AppJson } from '../../../platform/app-static.ts';

vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: () => [] }));
const fetchStatus = vi.fn(async (_p: string): Promise<AppJson> => ({ kind: 'missing' }));
vi.mock('../../../platform/app-static.ts', () => ({ fetchAppJsonStatus: (p: string) => fetchStatus(p) }));

const { default: CalendarPage } = await import('../ui/CalendarPage.tsx');
const { resetHolidayCacheForTest } = await import('../hooks/useHolidays.ts');
const { resetLunarForTest } = await import('../hooks/useLunar.ts');
const realLunar = await import('../../../../shared/logic/anniv/lunar.ts');
const { styles } = await import('./css-of.ts');

const NOW = msAt('2026-11-05', 9 * 60, currentTz());

function open(hash: string) {
  window.history.replaceState(null, '', `/app/${hash}`);
  return render(<CalendarPage />);
}

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  resetHolidayCacheForTest();
  resetLunarForTest(async () => realLunar);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('日历页顶栏（R-381）', () => {
  it('右上角头像是设置入口（R-381）：和月份胶囊在同一行的右端，不在翻页容器里（横滑翻页不吃掉它）；月视图、周视图都有', () => {
    open('#/calendar');
    const me = screen.getByTestId('cal-settings');
    expect(me.getAttribute('href')).toContain('#/settings');
    expect(me.getAttribute('aria-label')).toBe('设置');
    const row = me.parentElement;
    expect(row?.className).toBe(styles.top);
    expect(row?.contains(screen.getByTestId('cal-title'))).toBe(true);
    expect(row?.lastElementChild).toBe(me);
    expect(screen.getByTestId('cal-pager').contains(me)).toBe(false);
    cleanup();
    open('#/cal/week/2026-11-05');
    expect(screen.getByTestId('cal-week')).toBeTruthy();
    expect(screen.getByTestId('cal-settings').closest('[data-testid="cal-pager"]')).toBeNull();
  });
});
