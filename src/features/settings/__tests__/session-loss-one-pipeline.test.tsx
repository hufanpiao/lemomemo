// 设置页发现会话没了也只走一条退出管线（第三方审查前端-4、后端-3）：core/device-exit.ts 的 exitDevice
// • revoked（服务器说这次登录作废了）→ leaveAccount('removed', sid)：和主 App 本页 SIGNED_OUT 一样先查 session_fate 再定清不清库
// • signed_out（本机已经没有会话）→ followSignOut()：和别的标签页退出一样（core/device-exit.ts 的 exitOnSessionLoss）
// • 原来设置页自己清库（useSessionExit.onSessionLost），不认 exitDevice 的 exited：同一页已经在退出时还会再清一遍
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type { BootResult } from '../../../core/boot.ts';
import { defaultExitDeps, exitDevice, resetExitForTest, type ExitDeps } from '../../../core/device-exit.ts';
import { createLeaveAccount } from '../data/account-exit.ts';
import { zh } from '../i18n/zh.ts';
import SettingsPage from '../ui/SettingsPage.tsx';
import { confirmWith, fail, fakeApi, fakeExit, now, openAccount, rowAt } from './fakes.tsx';

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  localStorage.clear();
  resetExitForTest();
  window.history.replaceState(null, '', '#/settings');   // 上一条用例进了账号二级页，从设置首页开始
});
afterEach(() => cleanup());

describe('设置页的会话丢失交给 exitDevice', () => {
  it('读列表回 revoked：交给 leaveAccount("removed", 被拒那次的 sid)，设置页自己不清库', async () => {
    const { exit } = fakeExit();
    const leaveAccount = vi.fn(async () => undefined);
    const api = fakeApi({ loadDevices: vi.fn(async () => fail('revoked')) });
    render(<SettingsPage deps={{ api, exit, now, leaveAccount }} />);
    await waitFor(() => expect(leaveAccount).toHaveBeenCalledWith('removed', 's-me'));
    expect(exit.wipe).not.toHaveBeenCalled();
    expect(api.dropLocalSession).not.toHaveBeenCalled();
  });

  it('读列表回 signed_out：交给 followSignOut（同别的标签页退出），设置页自己不清库', async () => {
    const { exit } = fakeExit();
    const followSignOut = vi.fn();
    const leaveAccount = vi.fn(async () => undefined);
    const api = fakeApi({ loadDevices: vi.fn(async () => fail('signed_out')) });
    render(<SettingsPage deps={{ api, exit, now, leaveAccount, followSignOut }} />);
    await waitFor(() => expect(followSignOut).toHaveBeenCalledOnce());
    expect(leaveAccount).not.toHaveBeenCalled();
    expect(exit.wipe).not.toHaveBeenCalled();
  });

  for (const how of ['移除别的设备', '改语言'] as const) {
    it(`${how}时回 revoked：同样交给 leaveAccount("removed", sid)`, async () => {
      const { exit } = fakeExit();
      const leaveAccount = vi.fn(async () => undefined);
      const api = fakeApi({ removeDevice: vi.fn(async () => fail('revoked')), saveLocale: vi.fn(async () => fail('revoked')) });
      render(<SettingsPage deps={{ api, exit, now, leaveAccount }} />);
      await waitFor(() => expect(screen.getByTestId('settings-account-summary').textContent).toMatch(/\d/), { timeout: 5000 });
      if (how === '改语言') {
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: zh['settings.lang.ko'] }));
        });
      } else {
        await openAccount();
        fireEvent.click(within(rowAt(1)).getByRole('button'));
        await confirmWith(zh['settings.confirm.remove.ok']);
      }
      await waitFor(() => expect(leaveAccount).toHaveBeenCalledWith('removed', 's-me'));
      expect(exit.wipe).not.toHaveBeenCalled();
    });
  }

  it('这一页已经在退出（exitDevice 走过）：设置页再发现 revoked 不再清第二遍', async () => {
    const boot = { userId: 'u1', switching: false, cache: null, outbox: null } as unknown as BootResult;
    const wipe = vi.fn(async () => undefined);
    const deps: ExitDeps = { ...defaultExitDeps, getBoot: () => boot, wipe, broadcastReset: () => undefined, goToAuth: () => undefined, clearLocalSessionIf: async () => true };
    await exitDevice({ reason: 'pending_deletion', sid: 's-me', path: 'settings' }, deps);
    expect(wipe).toHaveBeenCalledOnce();
    const { exit } = fakeExit();
    const leaveAccount = createLeaveAccount({ ...deps, setNotice: () => undefined, authPath: 'settings' });
    const api = fakeApi({ loadDevices: vi.fn(async () => fail('revoked')) });
    render(<SettingsPage deps={{ api, exit, now, leaveAccount }} />);
    await waitFor(() => expect(api.loadDevices).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(wipe).toHaveBeenCalledOnce();
    expect(exit.wipe).not.toHaveBeenCalled();
  });
});
