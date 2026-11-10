// 设置 › 日历 二级页（R-320、R-321）：从 SettingsPage.test.tsx 拆出来（文件超 300 行，SETTINGS-merge-cards 11-06）
// 韩文词典换成“[ko]+中文”，同原文件
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { zh } from '../i18n/zh.ts';
import SettingsPage from '../ui/SettingsPage.tsx';
import { fakeApi, fakeExit, now, renderPage } from './fakes.tsx';

vi.mock('../i18n/ko.ts', async () => {
  const { zh: z } = await vi.importActual<{ zh: Record<string, string> }>('../i18n/zh.ts');
  return { ko: Object.fromEntries(Object.entries(z).map(([k, v]) => [k, `[ko]${v}`])) };
});

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  localStorage.clear();
  document.documentElement.lang = 'zh-CN';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// R-320（负责人 11-03 按定稿线框）：设置 › 日历 是二级页 #/settings/calendar；首页只有一行“日历 … 节假日：中国 ›”（负责人 11-04：不提农历），不内联展开。
// R-321：不加农历开关。返回同注销页：点进来的退一步（侧滑、后退一样），直接打开的原地换成设置首页、不多压一条历史
describe('设置 › 日历 二级页（R-320、R-321）', () => {
  beforeEach(() => window.history.replaceState(null, '', '#/settings'));
  afterEach(() => window.history.replaceState(null, '', '#/settings'));

  const openCal = async (): Promise<void> => {
    await act(async () => {
      fireEvent.click(await screen.findByTestId('settings-cal-entry'));
    });
    await screen.findByTestId('settings-calendar');
  };

  it('首页只有一行入口和摘要（“节假日：中国”，不提农历），不出现节假日单选、每周第一天、农历开关', async () => {
    await renderPage();
    // 值由日历功能懒加载（M4）：本文件第一条先等分包到。B3 FA-4 起首页还要懒加载 plus 的设置值，第一次转译分包更慢，等 5 秒
    await waitFor(() => expect(screen.getByTestId('settings-cal-summary').textContent).toBe('节假日：中国'), { timeout: 5000 });
    expect(screen.getByTestId('settings-cal-entry').textContent).not.toContain('农历');
    expect(screen.queryByTestId('settings-calendar')).toBeNull();
    expect(screen.queryByTestId('settings-cal-hol-cn')).toBeNull();
    expect(screen.queryByTestId('settings-cal-ws-1')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('点入口 push #/settings/calendar：只显示日历二级页（首页分组、退出登录都不在）；“‹ 设置”退回首页', async () => {
    await renderPage();
    await openCal();
    expect(window.location.hash).toBe('#/settings/calendar');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('日历');
    expect(screen.queryByTestId('settings-signout')).toBeNull();
    expect(screen.queryByTestId('settings-delete-entry')).toBeNull();
    expect(screen.getByTestId('settings-cal-hol-cn')).toBeTruthy();
    expect(screen.getByTestId('settings-cal-ws-1')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-cal-back'));
    });
    await waitFor(() => expect(screen.queryByTestId('settings-calendar')).toBeNull());
    expect(window.location.hash).toBe('#/settings');
    expect(await screen.findByTestId('settings-cal-entry')).toBeTruthy();
    expect(screen.getByTestId('settings-signout')).toBeTruthy();
  });

  it('侧滑 / 浏览器后退（history.back）也回设置首页', async () => {
    await renderPage();
    await openCal();
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(screen.queryByTestId('settings-calendar')).toBeNull());
    expect(window.location.hash).toBe('#/settings');
  });

  it('直接打开 #/settings/calendar：显示二级页；“‹ 设置”原地换成设置首页、不多压一条历史', async () => {
    window.history.replaceState(null, '', '#/settings/calendar');
    const before = window.history.length;
    render(<SettingsPage deps={{ api: fakeApi(), exit: fakeExit().exit, now }} />);
    await screen.findByTestId('settings-calendar');
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-cal-back'));
    });
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
    expect(screen.queryByTestId('settings-calendar')).toBeNull();
    expect(window.history.length).toBe(before);
  });

  it('二级页顶栏：“‹ 设置”和标题“日历”（和首页入口行名同一个词，代码审查 L4），进来时焦点在标题上；正文不提农历', async () => {
    await renderPage();
    const rowName = (await screen.findByTestId('settings-cal-entry')).textContent ?? '';
    await openCal();
    expect(rowName.startsWith(screen.getByRole('heading', { level: 1 }).textContent ?? '?')).toBe(true);
    expect(screen.getByTestId('settings-calendar').textContent).not.toContain('农历');
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe(zh['settings.cal.title']);
    expect(zh['settings.cal.title']).toBe('日历');
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(screen.getByTestId('settings-cal-back').textContent).toBe('‹ 设置');
  });

  it('韩文界面：首页摘要“공휴일: 한국”（不写음력，calendar 用真韩文词典）；二级页顶栏跟着设置词典换语言', async () => {
    uiStore.getState().setLocale('ko-KR');
    await renderPage();
    expect((await screen.findByTestId('settings-cal-summary')).textContent).toBe('공휴일: 한국');
    await openCal();
    // 本文件把设置的韩文词典换成“[ko]+中文”，真韩文在下一条核对
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('[ko]日历');
    expect(screen.getByTestId('settings-cal-back').textContent).toBe('‹ [ko]设置');
    expect(screen.getByText('공휴일')).toBeTruthy();
  });

  it('设置韩文词典：二级页标题“캘린더”（B2K-05）、返回“설정”', async () => {
    const { ko } = await vi.importActual<{ ko: Record<string, string> }>('../i18n/ko.ts');
    expect(ko['settings.cal.title']).toBe('캘린더');
    expect(ko['settings.title']).toBe('설정');
  });
});
