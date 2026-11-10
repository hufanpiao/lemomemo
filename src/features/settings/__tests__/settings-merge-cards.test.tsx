// 设置合卡（R-325，SETTINGS-merge-cards 方案定稿第 8 节）里页面测试没覆盖到的几条：
// • M4：二级页正文的分包下不来时写“这一页没加载出来”，顶栏返回照常能点；首页懒加载的值出错只是空着，行照样能点
// • 评审 A：首页“账号”一行在读设备列表时是固定宽度的占位，读不出来写“设备列表读不出来”
// 分包失败用替身模拟：calendar 的二级页正文和首页的值都直接抛错（React.lazy 下载失败时同样是抛到最近的错误边界）
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { zh } from '../i18n/zh.ts';
import type { QuickAddHotkey } from '../hooks/useQuickAddHotkey.ts';
import SettingsPage from '../ui/SettingsPage.tsx';
import { SettingsHome } from '../ui/SettingsHome.tsx';
import { deferred, fail, fakeApi, fakeExit, now } from './fakes.tsx';

const me = vi.hoisted(() => ({ initial: null as string | null }));
vi.mock('../../../kit/hooks/useMeInitial.ts', () => ({ useMeInitial: () => me.initial, nameInitial: () => me.initial }));

vi.mock('../../calendar/index.ts', () => {
  const boom = (): never => {
    throw new Error('chunk load failed');
  };
  return { CalendarSettings: boom, CalendarSettingsValue: boom };
});

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  localStorage.clear();
  window.history.replaceState(null, '', '#/settings');
  // 错误边界接住的错误 React 会再打一遍 console.error：这里是故意的，不刷屏
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('M4：分包下不来', () => {
  it('首页“日历”一行的值出错：只是空着，行照样在、能点进去', async () => {
    render(<SettingsPage deps={{ api: fakeApi(), exit: fakeExit().exit, now }} />);
    const entry = await screen.findByTestId('settings-cal-entry');
    expect(screen.getByTestId('settings-cal-summary').textContent).toBe('');
    expect(screen.getByTestId('settings-signout')).toBeTruthy();
    await act(async () => {
      fireEvent.click(entry);
    });
    await waitFor(() => expect(window.location.hash).toBe('#/settings/calendar'));
  });

  it('二级页正文出错：写“这一页没加载出来”（role=alert），顶栏标题和返回照常，返回回到首页', async () => {
    window.history.replaceState(null, '', '#/settings/calendar');
    render(<SettingsPage deps={{ api: fakeApi(), exit: fakeExit().exit, now }} />);
    const failed = await screen.findByTestId('settings-sub-failed');
    expect(failed.textContent).toBe(zh['settings.sub.failed']);
    expect(failed.getAttribute('role')).toBe('alert');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(zh['settings.cal.title']);
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-cal-back'));
    });
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
    expect(await screen.findByTestId('settings-cal-entry')).toBeTruthy();
  });

  it('S1：二级页之间直接换地址（不经过首页）：上一页的失败提示不带过来，新一页的标题拿到焦点', async () => {
    window.history.replaceState(null, '', '#/settings/calendar');
    render(<SettingsPage deps={{ api: fakeApi(), exit: fakeExit().exit, now }} />);
    expect(await screen.findByTestId('settings-sub-failed')).toBeTruthy();
    act(() => {
      window.location.hash = '#/settings/about';
    });
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(zh['settings.about.title']));
    expect(screen.queryByTestId('settings-sub-failed')).toBeNull();
    expect(screen.getByTestId('settings-about-back')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 })));
  });
});

describe('评审 A：首页“账号”一行的值', () => {
  it('读设备列表时：固定宽度的占位（读屏不读），没有文字；读到了换成“N 台设备：…”', async () => {
    const gate = deferred<Awaited<ReturnType<ReturnType<typeof fakeApi>['loadDevices']>>>();
    const base = fakeApi();
    const real = base.loadDevices;
    const api = fakeApi({
      loadDevices: vi.fn(async () => {
        await gate.promise;
        return real();
      }),
    });
    render(<SettingsPage deps={{ api, exit: fakeExit().exit, now }} />);
    const ph = await screen.findByTestId('settings-account-loading');
    expect(ph.getAttribute('aria-hidden')).toBe('true');
    expect(ph.className).not.toBe('');
    expect(screen.getByTestId('settings-account-summary').textContent).toBe('');
    await act(async () => gate.resolve(await real()));
    await waitFor(() => expect(screen.getByTestId('settings-account-summary').textContent).toMatch(/^4 台设备：/));
    expect(screen.queryByTestId('settings-account-loading')).toBeNull();
  });

  it('读不出来：写“设备列表读不出来”', async () => {
    render(<SettingsPage deps={{ api: fakeApi({ loadDevices: vi.fn(async () => fail('offline')) }), exit: fakeExit().exit, now }} />);
    await waitFor(() => expect(screen.getByTestId('settings-account-summary').textContent).toBe(zh['settings.account.devicesFailed']));
  });
});

describe('账号一行的头像圈（负责人 11-05 ①：用今天页那个头像，同一组件）', () => {
  afterEach(() => {
    me.initial = null;
    cleanup();
  });

  it('有名字写第一个字，没有名字画人形；在账号这一行的按钮里、读屏不念', async () => {
    me.initial = '林';
    const { unmount } = render(<SettingsPage deps={{ api: fakeApi(), exit: fakeExit().exit, now }} />);
    const av = await screen.findByTestId('settings-account-avatar');
    expect(av.textContent).toBe('林');
    expect(av.getAttribute('aria-hidden')).toBe('true');
    expect(av.closest('[data-testid="settings-account-entry"]')).not.toBeNull();
    unmount();
    me.initial = null;
    render(<SettingsPage deps={{ api: fakeApi(), exit: fakeExit().exit, now }} />);
    const av2 = await screen.findByTestId('settings-account-avatar');
    expect(av2.textContent).toBe('');
    expect(av2.querySelector('svg')).not.toBeNull();
  });
});

describe('S3：SettingsHome 账号一行上下两行排', () => {
  const hotkey: QuickAddHotkey = {
    status: null,
    recording: false,
    saving: false,
    notice: null,
    startRecording: () => undefined,
    cancelRecording: () => undefined,
    onKey: () => false,
    resetDefault: async () => undefined,
  };
  it('邮箱和设备摘要在同一个上下两行的容器里（值不和行名并排）；别的行（关于）照旧并排', () => {
    render(
      <SettingsHome
        email="long.name@example.com"
        devices={{ kind: 'loading' }}
        locale={{ current: 'zh', sync: 'idle', choose: async () => undefined }}
        exportState={{ kind: 'idle' }}
        hotkey={hotkey}
        onOpen={() => undefined}
        footer={null}
      />,
    );
    const btn = screen.getByTestId('settings-account-entry');
    const value = screen.getByTestId('settings-account-summary');
    const label = value.previousElementSibling;
    expect(label?.textContent).toBe('long.name@example.com');
    // 两行排：行名和值包在按钮里的同一个容器里，值不是按钮的直接子元素
    expect(value.parentElement).not.toBe(btn);
    expect(value.parentElement?.parentElement).toBe(btn);
    expect(label?.parentElement).toBe(value.parentElement);
    const about = screen.getByTestId('settings-about-summary');
    expect(about.parentElement).toBe(screen.getByTestId('settings-about-entry'));
  });
});
