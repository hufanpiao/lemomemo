// 设置页骨架（TC-B1-18、TC-B1-19、TC-B1-77～79 的界面部分；架构 0.29 续第 98、103、111 条，0.38 第 38 条）
// 韩文词典换成“[ko]+中文”，好分辨文字是不是真的跟着语言变（真韩文由 K17 翻）；离开本机的流程在 exit.test.tsx
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { zh } from '../i18n/zh.ts';
import SettingsPage from '../ui/SettingsPage.tsx';
import { confirmWith, fail, fakeApi, fakeExit, now, renderPage, ROWS, rowAt, text } from './fakes.tsx';

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

describe('已登录设备', () => {
  it('本机排第一并标“本机”；session_id 为空的、在 signed_out_device_ids 里的标“已退出”且能移除；很久没用的写自动移除日期；另有 N 个登录', async () => {
    await renderPage();
    const rows = screen.getAllByTestId('settings-device');
    expect(rows.map((r) => r.getAttribute('data-current'))).toEqual(['1', null, null, null]);
    expect(text(rows[0])).toContain(zh['settings.platform.windows']);
    expect(text(rows[0])).toContain(zh['settings.devices.thisDevice']);
    expect(text(rows[0])).not.toContain(zh['settings.devices.signedOut']);
    expect(text(rows[1])).toContain('A 的 iPhone');
    expect(text(rows[1])).not.toContain(zh['settings.devices.signedOut']);
    // 会话已不在的“旧电脑”（TC-B1-79 ②）和 session_id 为空的网页
    expect(text(rows[2])).toContain('旧电脑');
    expect(text(rows[2])).toContain(zh['settings.devices.signedOut']);
    expect(within(rows[2] as HTMLElement).getByRole('button').hasAttribute('disabled')).toBe(false);
    expect(text(rows[3])).toContain(zh['settings.devices.signedOut']);
    expect(text(rows[3])).toContain('很久没用');
    expect(text(screen.getByTestId('settings-orphans'))).toContain('另有 2 个登录没有设备记录');
  });

  it('读屏名包含看得见的文字：本机行是“退出这台设备（名字）”，其他行是“移除 名字”', async () => {
    await renderPage();
    expect(within(rowAt(0)).getByRole('button').getAttribute('aria-label')).toBe(`${zh['settings.devices.removeThis']}（${zh['settings.platform.windows']}）`);
    expect(within(rowAt(1)).getByRole('button').getAttribute('aria-label')).toBe(`${zh['settings.devices.remove']} A 的 iPhone`);
  });

  it('没有游离会话时不显示“另有 N 个登录”，“退出其他所有设备”照样在', async () => {
    const api = fakeApi({
      loadDevices: vi.fn(async () => ({
        ok: true as const,
        value: { rows: ROWS, sessions: [{ orphan_count: 0, orphan_last_at: null, signed_out_device_ids: [] }], session: 's-me' },
      })),
    });
    await renderPage(api);
    expect(screen.queryByTestId('settings-orphans')).toBeNull();
    expect((screen.getByRole('button', { name: zh['settings.devices.signOutOthers'] }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('移除别的设备：先确认，调 remove_device，提示、重新读列表，焦点移到列表标题', async () => {
    const api = fakeApi();
    await renderPage(api);
    fireEvent.click(within(rowAt(1)).getByRole('button'));
    await confirmWith(zh['settings.confirm.remove.ok']);
    expect(api.removeDevice).toHaveBeenCalledWith('x');
    expect(await screen.findByText('已移除“A 的 iPhone”', { exact: false })).toBeTruthy();
    expect(api.loadDevices).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(document.activeElement?.id).toBe('settings-devices-title'));
  });

  it('移除本机 = 退出登录：确认后按“删本机行 → 清库和缓存 → signOut”的顺序退出，回登录页（不调 remove_device）', async () => {
    const { exit, order } = fakeExit();
    const api = fakeApi({}, order);
    await renderPage(api, exit);
    await act(async () => {
      fireEvent.click(within(rowAt(0)).getByRole('button'));
    });
    await confirmWith(zh['settings.confirm.removeThis.ok']);
    await waitFor(() => expect(exit.goToAuth).toHaveBeenCalled());
    expect(api.deleteOwnDevice).toHaveBeenCalledWith('y');
    expect(api.removeDevice).not.toHaveBeenCalled();
    // 会话放最后：中途被打断最坏是“有会话、没库”（跳转前再同步删一次本机会话）
    expect(order).toEqual(['row', 'wipe', 'caches', 'signout', 'deleteDb', 'session', 'auth']);
  });

  it('设备列表里点“退出这台设备”也先数没上传的：有 2 条时确认框写条数', async () => {
    const api = fakeApi();
    const { exit } = fakeExit(2);
    await renderPage(api, exit);
    await act(async () => {
      fireEvent.click(within(rowAt(0)).getByRole('button'));
    });
    const dlg = await screen.findByRole('dialog');
    expect(text(dlg)).toContain('还有 2 条改动或草稿没上传');
    expect(exit.pendingCount).toHaveBeenCalledTimes(1);
    expect(api.deleteOwnDevice).not.toHaveBeenCalled();
  });

  it('服务器回 is_current_device（列表没认出本机）：只提示“这是本机，请用退出登录”，不自动退出、不清本机', async () => {
    const api = fakeApi({ removeDevice: vi.fn(async () => fail('is_current_device')) });
    const { exit } = fakeExit();
    await renderPage(api, exit);
    fireEvent.click(within(rowAt(1)).getByRole('button'));
    await confirmWith(zh['settings.confirm.remove.ok']);
    expect(text(await screen.findByRole('alert'))).toBe(zh['settings.devices.isCurrent']);
    expect(api.deleteOwnDevice).not.toHaveBeenCalled();
    expect(api.dropLocalSession).not.toHaveBeenCalled();
    expect(exit.wipe).not.toHaveBeenCalled();
    expect(exit.goToAuth).not.toHaveBeenCalled();
    // 按钮已恢复可点
    expect(within(rowAt(1)).getByRole('button').hasAttribute('disabled')).toBe(false);
  });

  it('退出其他所有设备：确认后调 signOutOthers，提示并刷新列表', async () => {
    const api = fakeApi();
    await renderPage(api);
    fireEvent.click(screen.getByRole('button', { name: zh['settings.devices.signOutOthers'] }));
    await confirmWith(zh['settings.confirm.others.ok']);
    expect(api.signOutOthers).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(zh['settings.devices.signOutOthersDone'])).toBeTruthy();
    expect(api.loadDevices).toHaveBeenCalledTimes(2);
  });

  it('try_later 只提示，不清本机、不回登录页（0.29 续第 119 条②）', async () => {
    const api = fakeApi({ signOutOthers: vi.fn(async () => fail('try_later')) });
    const { exit } = fakeExit();
    await renderPage(api, exit);
    fireEvent.click(screen.getByRole('button', { name: zh['settings.devices.signOutOthers'] }));
    await confirmWith(zh['settings.confirm.others.ok']);
    expect(text(await screen.findByRole('alert'))).toContain(zh['settings.err.tryLater']);
    expect(exit.wipe).not.toHaveBeenCalled();
    expect(exit.goToAuth).not.toHaveBeenCalled();
  });

  it('断网读不出列表：给“重试”，不清本机、不清会话、不回登录页；点了再读', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(fail('offline'))
      .mockResolvedValue({ ok: true, value: { rows: ROWS, sessions: null, session: 's-me' } });
    const api = fakeApi({ loadDevices: load });
    const { exit } = fakeExit();
    render(<SettingsPage deps={{ api, exit, now }} />);
    expect(await screen.findByText(zh['settings.devices.loadFailed'])).toBeTruthy();
    expect(exit.wipe).not.toHaveBeenCalled();
    expect(exit.clearLocalSessionIf).not.toHaveBeenCalled();
    expect(api.dropLocalSession).not.toHaveBeenCalled();
    expect(exit.goToAuth).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['settings.devices.retry'] }));
    });
    expect(screen.getAllByTestId('settings-device')).toHaveLength(4);
  });

  it('账号停用或在注销冷静期（account_disabled）：探测期间不说“已停用”；探测说账号正常（active）就只提示读取失败，不清本机（PROBE 遗留；探测其余结果见 settings-disabled-probe.test.tsx）', async () => {
    const api = fakeApi({ loadDevices: vi.fn(async () => fail('account_disabled')) });
    const { exit } = fakeExit();
    const leaveAccount = vi.fn(async () => undefined);
    let answer: (v: 'active') => void = () => undefined;
    const resolveDisabled = vi.fn(() => new Promise<'active'>((r) => (answer = r)));
    render(<SettingsPage deps={{ api, exit, now, leaveAccount, resolveDisabled }} />);
    await waitFor(() => expect(resolveDisabled).toHaveBeenCalledWith('s-me', undefined));
    expect(screen.queryByText(zh['settings.err.accountDisabled'])).toBeNull();
    expect(screen.queryByText(zh['settings.devices.loadFailed'])).toBeNull();
    await act(async () => answer('active'));
    expect(await screen.findByText(zh['settings.devices.loadFailed'])).toBeTruthy();
    expect(screen.queryByText(zh['settings.err.accountDisabled'])).toBeNull();
    expect(leaveAccount).not.toHaveBeenCalled();
    expect(exit.wipe).not.toHaveBeenCalled();
  });
});

describe('退出登录（页面最底下单独一行）', () => {
  it('退出登录先数没上传的，确认以后才开始清库（计数在封存之前）', async () => {
    const { exit, order } = fakeExit(2);
    exit.pendingCount.mockImplementation(async () => {
      order.push('count');
      return 2;
    });
    const api = fakeApi({}, order);
    await renderPage(api, exit);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['settings.account.signOut'] }));
    });
    expect(order).toEqual(['count']);
    await confirmWith(zh['settings.confirm.signOut.ok']);
    await waitFor(() => expect(exit.goToAuth).toHaveBeenCalled());
    expect(order).toEqual(['count', 'row', 'wipe', 'caches', 'signout', 'deleteDb', 'session', 'auth']);
  });

  it('跳登录页抛错：“去登录”恢复可点、放开退出时占住的“忙”（页面能自己重新载入）；再点再跳', async () => {
    const api = fakeApi({ loadDevices: vi.fn(async () => fail('revoked')) });
    const { exit } = fakeExit();
    exit.goToAuth.mockImplementationOnce(() => {
      throw new Error('SecurityError');
    });
    render(<SettingsPage deps={{ api, exit, now }} />);
    const dlg = await screen.findByRole('dialog');
    const go = await within(dlg).findByRole('button', { name: zh['settings.revoked.go'] });
    await act(async () => {
      fireEvent.click(go);
    });
    await waitFor(() => expect(exit.goToAuth).toHaveBeenCalledTimes(1));
    expect(exit.releaseHold).toHaveBeenCalledTimes(1);
    expect((go as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(go);
    });
    await waitFor(() => expect(exit.goToAuth).toHaveBeenCalledTimes(2));
  });
});

// TC-B1-71（R-256 改过）：账号第一，其余按定稿线框（第 996～998 行）的相对顺序；“退出登录”单独一行在所有分组之后。
// 已有的分组按这个相对顺序出现即可；后面各批加分组时复跑，B7a 时齐全。只认二级标题（分组名），已登录设备是账号里的三级标题
describe('设置分组顺序（TC-B1-71）', () => {
  const ORDER = [
    '账号', '界面语言', '皮肤', '字体', '随手记显示方式', '日历', '提醒与通知', '语音与 AI', '隐私记', '时区',
    '数据', '在 Claude 聊天里记事', '邀请朋友', '电脑', '符号说明', '关于',
  ];

  it('账号排第一、界面语言紧随、数据在后；分组不重复；“退出登录”在最后一个分组之后', async () => {
    await renderPage();
    const heads = screen.getAllByRole('heading', { level: 2 });
    const groups = heads.map((h) => (h.textContent ?? '').trim()).filter((n) => ORDER.includes(n));
    expect(groups.slice(0, 3)).toEqual(['账号', '界面语言', '数据']);
    expect(groups).toEqual([...groups].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)));
    expect(new Set(groups).size).toBe(groups.length);
    // 已登录设备、退出其他所有设备、注销入口都在账号这一组里
    const account = screen.getByRole('heading', { level: 2, name: '账号' }).closest('section') as HTMLElement;
    expect(within(account).getByRole('heading', { level: 3, name: zh['settings.devices.title'] })).toBeTruthy();
    expect(within(account).getByRole('button', { name: zh['settings.devices.signOutOthers'] })).toBeTruthy();
    expect(within(account).getByTestId('settings-delete-entry')).toBeTruthy();
    expect(within(account).queryByTestId('settings-signout')).toBeNull();
    // 退出登录：在 DOM 里排在最后一个分组之后
    const signOut = screen.getByTestId('settings-signout');
    const last = heads[heads.length - 1]?.closest('section') as HTMLElement;
    expect(last.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(last.contains(signOut)).toBe(false);
  });
});
