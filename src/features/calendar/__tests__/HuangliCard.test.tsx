// 黄历卡（R-431）：选中那天清单标题行下面；内容来自 shared/logic/anniv/lunar-huangli.ts（真数据，按需加载）
// 集合、节假日文件用替身；“今天”固定在 2026-11-05
// • HUANGLI_LIB 换成转手的替身：每条用例在 beforeEach 新建一个 lazyLib（真加载），要慢加载、加载失败的用例自己换，互不串
// • 截断：jsdom 不排版，scrollWidth / clientWidth 都是 0（= 没截断）；要截断的用例把字多于 12 个的那一格量成 100 > 50
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import type * as AnnivLibMod from '../../../core/anniv-lib.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import type { AppJson } from '../../../platform/app-static.ts';

vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: () => [] }));
vi.mock('../../../platform/app-static.ts', () => ({ fetchAppJsonStatus: async (): Promise<AppJson> => ({ kind: 'missing' }) }));
const hl = vi.hoisted(() => ({ cur: null as AnnivLibMod.LazyLib<AnnivLibMod.HuangliLib> | null }));
vi.mock('../../../core/anniv-lib.ts', async (orig) => {
  const real = await orig<typeof AnnivLibMod>();
  const cur = (): AnnivLibMod.LazyLib<AnnivLibMod.HuangliLib> => hl.cur ?? real.HUANGLI_LIB;
  return { ...real, HUANGLI_LIB: { load: () => cur().load(), ready: () => cur().ready(), get: () => cur().get() } };
});

const { default: CalendarPage } = await import('../ui/CalendarPage.tsx');
const { resetLunarForTest } = await import('../hooks/useLunar.ts');
const { lazyLib } = await import('../../../core/anniv-lib.ts');
const realLunar = await import('../../../../shared/logic/anniv/lunar.ts');
const realHuangli = await import('../../../../shared/logic/anniv/lunar-huangli.ts');

const TZ = currentTz();

function open(hash: string) {
  window.history.replaceState(null, '', `/app/${hash}`);
  return render(<CalendarPage />);
}
const pick = (date: string) => fireEvent.click(document.querySelector(`[data-testid="cal-month"] [data-date="${date}"]`) as HTMLElement);
const card = (): HTMLElement => screen.getByTestId('cal-huangli');
const toggle = (): HTMLElement | null => screen.queryByTestId('cal-huangli-toggle');
const head = (): string => document.getElementById('cal-day-title')?.textContent ?? '';
const dateCol = (): Element | null => card().firstElementChild?.matches('button') ? (card().children.item(1) ?? null) : card().firstElementChild;

/** 字多于 12 个的事项格量成被截断（scrollWidth 100 > clientWidth 50） */
function clipLongRows(): void {
  const long = (el: HTMLElement): boolean => (el.textContent ?? '').length > 12;
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return long(this) ? 100 : 10;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 50);
}

beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(msAt('2026-11-05', 9 * 60, TZ));
  resetLunarForTest(lazyLib('lunar', async () => realLunar));
  hl.cur = lazyLib('huangli', async () => realHuangli);
  uiStore.getState().setLocale('zh-CN');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('黄历卡', () => {
  it('韩文界面不出卡片，也不占位', async () => {
    uiStore.getState().setLocale('ko-KR');
    open('#/cal/month/2026-11');
    pick('2026-11-15');
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('cal-huangli')).toBeNull();
    expect(screen.queryByTestId('cal-huangli-wait')).toBeNull();
  });

  it('中文界面：大字“初七”、“丙午年 · 十月”，宜、忌各一行，事项用“ · ”隔开；标题行不再写农历', async () => {
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

  it('没截断：就是普通的块，没有按钮、没有 aria-expanded，日期那一栏读屏读得到', async () => {
    open('#/cal/month/2026-11');
    pick('2026-11-15');
    await waitFor(() => expect(screen.queryByTestId('cal-huangli')).not.toBeNull());
    expect(toggle()).toBeNull();
    expect(card().querySelector('button, [aria-expanded]')).toBeNull();
    expect(dateCol()?.getAttribute('aria-hidden')).toBeNull();
  });

  it('截断了：盖一层按钮，读屏名字是短的一句；宜忌两行在按钮外、读屏直接读得到；点了展开、再点收起；换一天回到收起', async () => {
    clipLongRows();
    open('#/cal/month/2026-11');
    pick('2026-11-15');
    await waitFor(() => expect(toggle()).not.toBeNull());
    const b = toggle() as HTMLElement;
    expect(b.tagName).toBe('BUTTON');
    expect(b.getAttribute('aria-label')).toBe('黄历，初七，丙午年十月，宜 5 项，忌 2 项');
    expect(b.childElementCount).toBe(0);
    expect(b.contains(screen.getByTestId('cal-huangli-yi'))).toBe(false);
    expect(screen.getByTestId('cal-huangli-yi').closest('[aria-hidden="true"]')).toBeNull();
    expect(dateCol()?.getAttribute('aria-hidden')).toBe('true');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(b);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle() as HTMLElement);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle() as HTMLElement);
    pick('2026-11-08');
    await waitFor(() => expect(card().textContent).toContain('三十'));
    expect(toggle()?.getAttribute('aria-expanded') ?? 'false').toBe('false');
  });

  it('那一边没有事项：画“—”（读屏隐藏），另给读屏一个“无”（2026-11-07 立冬：忌无）', async () => {
    open('#/cal/month/2026-11');
    pick('2026-11-07');
    await waitFor(() => expect(screen.queryByTestId('cal-huangli')).not.toBeNull());
    expect(screen.getByTestId('cal-huangli-yi').textContent).toBe('宜解除 · 余事勿取');
    const ji = screen.getByTestId('cal-huangli-ji');
    expect(ji.querySelector('[aria-hidden="true"]')?.textContent).toBe('—');
    expect(ji.textContent).toBe('忌—无');
  });

  it('黄历加载中：先占好卡片的位置（读屏隐藏），标题行也不写农历；加载完换成卡片', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    hl.cur = lazyLib('huangli', () => gate.then(() => realHuangli));
    open('#/cal/month/2026-11');
    await waitFor(() => expect(document.querySelector('[data-testid="cal-month"] [data-date="2026-11-15"]')?.getAttribute('aria-label')).toContain('农历'));
    pick('2026-11-15');
    expect(screen.getByTestId('cal-huangli-wait').getAttribute('aria-hidden')).toBe('true');
    expect(head()).not.toContain('农历');
    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => expect(screen.queryByTestId('cal-huangli')).not.toBeNull());
    expect(screen.queryByTestId('cal-huangli-wait')).toBeNull();
    expect(head()).not.toContain('农历');
  });

  it('黄历加载失败：不画卡片也不占位，标题行照旧写农历', async () => {
    hl.cur = lazyLib('huangli', () => Promise.reject(new Error('chunk 加载失败')));
    open('#/cal/month/2026-11');
    pick('2026-11-15');
    await waitFor(() => expect(head()).toContain('农历'));
    expect(screen.queryByTestId('cal-huangli')).toBeNull();
    expect(screen.queryByTestId('cal-huangli-wait')).toBeNull();
  });

  it('超出数据范围（1901-01-20 以前）：不加载黄历、不画卡片也不占位', async () => {
    const load = vi.fn(async () => realHuangli);
    hl.cur = lazyLib('huangli', load);
    open('#/cal/month/1900-06');
    pick('1900-06-15');
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('cal-huangli')).toBeNull();
    expect(screen.queryByTestId('cal-huangli-wait')).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});
