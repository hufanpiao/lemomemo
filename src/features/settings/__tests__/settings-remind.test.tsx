// 设置 › 提醒与通知（REMIND-wiring；定稿线框 s13、sR7）：首页一行入口，点进二级页 #/settings/remind，
// 二级页最上面“未来 7 天的提醒 ›”再进一层 #/settings/remind/upcoming；返回同日历二级页：点进来的退一步，直接打开的原地换成上一层。
// 关于 分组里的“手机时间不准”（K8-clock）也在这里测。正文（RemindSettings、RemindUpcoming、ClockWrongNote）各自的细节在 reminders 的测试里
// 不引 reminders 的词典（别的功能只能 import 它的 index.ts）：要和它同词的地方直接写出期望的文字
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
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
  window.history.replaceState(null, '', '#/settings');
});
afterEach(() => {
  cleanup();
  clock.reset();
  window.history.replaceState(null, '', '#/settings');
});

/** 提醒的几块都是懒加载分包：全量并发跑时第一次加载可能超过 findBy 默认的 1 秒 */
const LAZY = { timeout: 10_000 } as const;
vi.setConfig({ testTimeout: 15_000 });
const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    fireEvent.click(el);
  });
};
/** reminders 词典里的几个词（remind.set.title、remind.set.upcoming、remind.clock.wrongNote） */
const R = { title: '提醒与通知', upcoming: '未来 7 天的提醒', clockWrong: '这台设备的时间和服务器差了约' } as const;
const h1Text = (): string => screen.getByRole('heading', { level: 1 }).textContent ?? '';

const openRemind = async (): Promise<void> => {
  await click(await screen.findByTestId('settings-remind-entry', {}, LAZY));
  await screen.findByTestId('settings-reminders', {}, LAZY);
};
const openUpcoming = async (): Promise<void> => {
  await click(await screen.findByTestId('remind-open-upcoming', {}, LAZY));
  await waitFor(() => expect(h1Text()).toBe(zh['settings.remind.upcoming']));
};

describe('设置首页“提醒与通知”一行（线框 s13）', () => {
  it('排在“日历”之后、“数据”之前；只有入口和摘要，二级页正文不在首页', async () => {
    await renderPage();
    const entry = await screen.findByTestId('settings-remind-entry', {}, LAZY);
    expect(entry.textContent).toContain(R.title);
    expect(screen.getByTestId('settings-remind-summary').textContent).not.toBe('');
    const slots = Array.from(document.querySelectorAll('[data-section-slot]')).map((n) => n.getAttribute('data-section-slot'));
    expect(slots.indexOf('reminders')).toBe(slots.indexOf('calendar') + 1);
    expect(slots.indexOf('reminders')).toBeLessThan(slots.indexOf('data'));
    expect(document.querySelector('[data-section-slot="reminders"]')?.contains(entry)).toBe(true);
    expect(screen.queryByTestId('settings-reminders')).toBeNull();
    expect(screen.queryByTestId('remind-open-upcoming')).toBeNull();
  });
});

describe('设置 › 提醒与通知 二级页（线框 sR7 左图）', () => {
  it('点入口 push #/settings/remind：顶栏“‹ 设置”、标题和入口行同一个词，焦点在标题上；首页分组、退出登录都不在', async () => {
    await renderPage();
    await openRemind();
    expect(window.location.hash).toBe('#/settings/remind');
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('提醒与通知');
    expect(zh['settings.remind.title']).toBe(R.title);
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(screen.getByTestId('settings-remind-back').textContent).toBe('‹ 设置');
    expect(screen.queryByTestId('settings-signout')).toBeNull();
    expect(screen.queryByTestId('settings-remind-entry')).toBeNull();
    expect(screen.queryByTestId('settings-cal-entry')).toBeNull();
    // 线框：未来 7 天的入口在正文最上面
    const body = screen.getByTestId('settings-reminders');
    const first = within(body).getAllByRole('button')[0];
    expect(first?.getAttribute('data-testid')).toBe('remind-open-upcoming');
  });

  it('“‹ 设置”退一步回首页（不多压历史）', async () => {
    await renderPage();
    const before = window.history.length;
    await openRemind();
    await click(screen.getByTestId('settings-remind-back'));
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
    expect(await screen.findByTestId('settings-remind-entry', {}, LAZY)).toBeTruthy();
    expect(screen.getByTestId('settings-signout')).toBeTruthy();
    expect(screen.queryByTestId('settings-reminders')).toBeNull();
    // 点进去压了一条，退一步后再进还是在同一位置：长度只比进来前多 1（前进那条）
    expect(window.history.length).toBe(before + 1);
  });

  it('直接打开 #/settings/remind：“‹ 设置”原地换成设置首页、不多压一条历史', async () => {
    window.history.replaceState(null, '', '#/settings/remind');
    const before = window.history.length;
    render(<SettingsPage deps={{ api: fakeApi(), exit: fakeExit().exit, now }} />);
    await screen.findByTestId('settings-reminders', {}, LAZY);
    await click(screen.getByTestId('settings-remind-back'));
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
    expect(screen.queryByTestId('settings-reminders')).toBeNull();
    expect(window.history.length).toBe(before);
  });
});

describe('设置 › 提醒与通知 › 未来 7 天的提醒（线框 sR7 右图）', () => {
  it('点“未来 7 天的提醒” push #/settings/remind/upcoming：顶栏“‹ 提醒与通知”，标题和入口同一个词，焦点在标题上', async () => {
    await renderPage();
    await openRemind();
    const rowName = screen.getByTestId('remind-open-upcoming').textContent ?? '';
    await openUpcoming();
    expect(window.location.hash).toBe('#/settings/remind/upcoming');
    expect(rowName.startsWith(h1Text())).toBe(true);
    expect(zh['settings.remind.upcoming']).toBe(R.upcoming);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 })));
    expect(screen.getByTestId('settings-remind-up-back').textContent).toBe('‹ 提醒与通知');
    // 这一层只画清单正文，提醒设置的正文、首页都不在
    expect(screen.queryByTestId('settings-reminders')).toBeNull();
    expect(screen.queryByTestId('settings-signout')).toBeNull();
  });

  it('“‹ 提醒与通知”退回提醒二级页，再“‹ 设置”退回首页（一层一层退）', async () => {
    await renderPage();
    await openRemind();
    await openUpcoming();
    await click(screen.getByTestId('settings-remind-up-back'));
    await waitFor(() => expect(window.location.hash).toBe('#/settings/remind'));
    expect(await screen.findByTestId('settings-reminders', {}, LAZY)).toBeTruthy();
    await click(screen.getByTestId('settings-remind-back'));
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
    expect(await screen.findByTestId('settings-remind-entry', {}, LAZY)).toBeTruthy();
  });

  it('侧滑 / 浏览器后退（history.back）也一层一层退', async () => {
    await renderPage();
    await openRemind();
    await openUpcoming();
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(window.location.hash).toBe('#/settings/remind'));
    expect(await screen.findByTestId('settings-reminders', {}, LAZY)).toBeTruthy();
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
    expect(await screen.findByTestId('settings-remind-entry', {}, LAZY)).toBeTruthy();
  });

  it('直接打开 #/settings/remind/upcoming：“‹ 提醒与通知”原地换成提醒二级页，再“‹ 设置”原地换成首页，都不多压历史', async () => {
    window.history.replaceState(null, '', '#/settings/remind/upcoming');
    const before = window.history.length;
    render(<SettingsPage deps={{ api: fakeApi(), exit: fakeExit().exit, now }} />);
    await waitFor(() => expect(h1Text()).toBe(zh['settings.remind.upcoming']));
    await click(screen.getByTestId('settings-remind-up-back'));
    await waitFor(() => expect(window.location.hash).toBe('#/settings/remind'));
    await screen.findByTestId('settings-reminders', {}, LAZY);
    await click(screen.getByTestId('settings-remind-back'));
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
    expect(window.history.length).toBe(before);
  });

  it('直接打开提醒二级页、点进未来 7 天后侧滑退回：“‹ 设置”仍原地换成首页（不会退出设置页）', async () => {
    window.history.replaceState(null, '', '#/settings/remind');
    render(<SettingsPage deps={{ api: fakeApi(), exit: fakeExit().exit, now }} />);
    await screen.findByTestId('settings-reminders', {}, LAZY);
    await openUpcoming();
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(window.location.hash).toBe('#/settings/remind'));
    await screen.findByTestId('settings-reminders', {}, LAZY);
    await click(screen.getByTestId('settings-remind-back'));
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
    expect(await screen.findByTestId('settings-remind-entry', {}, LAZY)).toBeTruthy();
  });

  it('从首页点进、侧滑退回首页后，再直接打开的未来 7 天：返回不会借用旧记号多退一步', async () => {
    await renderPage();
    await openRemind();
    await openUpcoming();
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(window.location.hash).toBe('#/settings/remind'));
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
    await screen.findByTestId('settings-remind-entry', {}, LAZY);
    // 首页时记号都清掉：这时换到 #/settings/remind/upcoming（不是从本页点进去的），返回应原地换成提醒二级页
    await act(async () => {
      window.history.replaceState(null, '', '#/settings/remind/upcoming');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await waitFor(() => expect(h1Text()).toBe(zh['settings.remind.upcoming']));
    const before = window.history.length;
    // jsdom 的历史在同一文件里是累积的，后退可能碰巧落到别的 #/settings/remind：直接看有没有调 history.back
    const back = vi.spyOn(window.history, 'back');
    await click(screen.getByTestId('settings-remind-up-back'));
    await waitFor(() => expect(window.location.hash).toBe('#/settings/remind'));
    expect(back).not.toHaveBeenCalled();
    back.mockRestore();
    expect(window.history.length).toBe(before);
  });
});

describe('韩文界面', () => {
  it('二级页顶栏跟着设置词典换语言（本文件把设置的韩文换成“[ko]+中文”）', async () => {
    uiStore.getState().setLocale('ko-KR');
    await renderPage();
    await openRemind();
    expect(h1Text()).toBe('[ko]提醒与通知');
    expect(screen.getByTestId('settings-remind-back').textContent).toBe('‹ [ko]设置');
    await openUpcomingKo();
    expect(screen.getByTestId('settings-remind-up-back').textContent).toBe('‹ [ko]提醒与通知');
  });

  it('设置韩文词典：两个标题和 reminders 韩文词典的入口行同一个词', async () => {
    const { ko } = await vi.importActual<{ ko: Record<string, string> }>('../i18n/ko.ts');
    // reminders 韩文词典：remind.set.title = '알림'，remind.set.upcoming = '앞으로 7일 알림'
    expect(ko['settings.remind.title']).toBe('알림');
    expect(ko['settings.remind.upcoming']).toBe('앞으로 7일 알림');
  });
});

async function openUpcomingKo(): Promise<void> {
  await click(await screen.findByTestId('remind-open-upcoming', {}, LAZY));
  await waitFor(() => expect(h1Text()).toBe(`[ko]${zh['settings.remind.upcoming']}`));
}

describe('设置 › 关于：手机时间不准（K8-clock）', () => {
  it('偏差正常时不画：先让提示出来，再把时钟调正常（又来了 5 次没偏差的样本），提示消失（代码复审第二轮 N4：只断言“没出现”可能是还没加载）', async () => {
    const local = Date.now();
    for (let i = 0; i < 5; i += 1) clock.record(new Date(local + 10 * 60_000).toUTCString(), local);
    await renderPage();
    await screen.findByTestId('clock-wrong', {}, LAZY);
    await act(async () => {
      for (let i = 0; i < 5; i += 1) clock.record(new Date(local).toUTCString(), local);
    });
    expect(clock.isClockWrong()).toBe(false);
    await waitFor(() => expect(screen.queryByTestId('clock-wrong')).toBeNull());
    // 关于 分组还在，农历出处照常
    expect(screen.getByTestId('settings-lunar-credit')).toBeTruthy();
  });

  it('服务器时间比本机快 10 分钟：关于 分组里只出一句“这台设备的时间和服务器差了约 10 分钟…”（N7 不再重复），排在农历出处之前', async () => {
    const local = Date.now();
    for (let i = 0; i < 5; i += 1) clock.record(new Date(local + 10 * 60_000).toUTCString(), local);
    expect(clock.isClockWrong()).toBe(true);
    await renderPage();
    const note = await screen.findByTestId('clock-wrong', {}, LAZY);
    const about = document.querySelector('[data-section="about"]') as HTMLElement;
    expect(about.contains(note)).toBe(true);
    expect(note.textContent).toContain(R.clockWrong);
    expect(note.textContent).toContain('10');
    expect(note.textContent).not.toContain('不准');
    const credit = screen.getByTestId('settings-lunar-credit');
    expect(note.compareDocumentPosition(credit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
