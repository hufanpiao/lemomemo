// 黄历卡（R-431）：选中那天清单标题行下面；内容来自 shared/logic/anniv/lunar-huangli.ts（真数据，按需加载）
// 集合、节假日文件用替身；“今天”固定在 2026-11-05
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import type { AppJson } from '../../../platform/app-static.ts';

vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: () => [] }));
vi.mock('../../../platform/app-static.ts', () => ({ fetchAppJsonStatus: async (): Promise<AppJson> => ({ kind: 'missing' }) }));

const { default: CalendarPage } = await import('../ui/CalendarPage.tsx');
const { resetLunarForTest } = await import('../hooks/useLunar.ts');
const { lazyLib } = await import('../../../core/anniv-lib.ts');
const realLunar = await import('../../../../shared/logic/anniv/lunar.ts');

const TZ = currentTz();

function open(hash: string) {
  window.history.replaceState(null, '', `/app/${hash}`);
  return render(<CalendarPage />);
}
const pick = (date: string) => fireEvent.click(document.querySelector(`[data-testid="cal-month"] [data-date="${date}"]`) as HTMLElement);
const card = (): HTMLElement => screen.getByTestId('cal-huangli');
const head = (): string => document.getElementById('cal-day-title')?.textContent ?? '';

beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(msAt('2026-11-05', 9 * 60, TZ));
  resetLunarForTest(lazyLib('lunar', async () => realLunar));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('黄历卡', () => {
  it('韩文界面不出卡片', async () => {
    uiStore.getState().setLocale('ko-KR');
    open('#/cal/month/2026-11');
    pick('2026-11-15');
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('cal-huangli')).toBeNull();
  });

  it('中文界面：大字“初七”、“丙午年 · 十月”，宜、忌各一行，事项用“ · ”隔开；有卡片时标题行不再写农历', async () => {
    uiStore.getState().setLocale('zh-CN');
    open('#/cal/month/2026-11');
    pick('2026-11-15');
    await waitFor(() => expect(screen.queryByTestId('cal-huangli')).not.toBeNull());
    expect(card().textContent).toContain('初七');
    expect(card().textContent).toContain('丙午年 · 十月');
    expect(screen.getByTestId('cal-huangli-yi').textContent).toBe('宜破屋 · 坏垣 · 求医 · 治病 · 余事勿取');
    expect(screen.getByTestId('cal-huangli-ji').textContent).toBe('忌嫁娶 · 安葬');
    expect(head()).toContain('11月15日');
    expect(head()).not.toContain('农历');
  });

  it('点卡片展开、再点收起（aria-expanded）；换一天回到收起', async () => {
    uiStore.getState().setLocale('zh-CN');
    open('#/cal/month/2026-11');
    pick('2026-11-15');
    await waitFor(() => expect(screen.queryByTestId('cal-huangli')).not.toBeNull());
    expect(card().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(card());
    expect(card().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(card());
    expect(card().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(card());
    pick('2026-11-07');
    expect(card().getAttribute('aria-expanded')).toBe('false');
    expect(card().textContent).toContain('廿九');
  });

  it('那一边没有事项写“—”（2026-11-07 立冬：忌无）', async () => {
    uiStore.getState().setLocale('zh-CN');
    open('#/cal/month/2026-11');
    pick('2026-11-07');
    await waitFor(() => expect(screen.queryByTestId('cal-huangli')).not.toBeNull());
    expect(screen.getByTestId('cal-huangli-yi').textContent).toBe('宜解除 · 余事勿取');
    expect(screen.getByTestId('cal-huangli-ji').textContent).toBe('忌—');
  });
});
