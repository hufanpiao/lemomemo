// 设置页发现会话没了也只走一条退出管线（第三方审查前端-4、后端-3）：core/device-exit.ts 的 exitDevice
// • revoked（服务器说这次登录作废了）→ leaveAccount('removed', sid)：和主 App 本页 SIGNED_OUT 一样先查 session_fate 再定清不清库
// • signed_out（本机已经没有会话）→ followSignOut()：和别的标签页退出一样（core/device-exit.ts 的 exitOnSessionLoss）
// • 原来设置页自己清库（useSessionExit.onSessionLost），不认 exitDevice 的 exited：同一页已经在退出时还会再清一遍
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type { BootResult } from '../../../core/boot.ts';
import { beginExit, CONFIRM_REMOVED_TIMEOUT_MS, defaultExitDeps, exitDevice, exitOnSessionLoss, exitStarted, resetExitForTest, type ExitDeps } from '../../../core/device-exit.ts';
import { createFollowSignOut, createLeaveAccount } from '../../../core/account-leave.ts';
import { zh } from '../i18n/zh.ts';
import SettingsPage from '../ui/SettingsPage.tsx';
import { clickSignOut, confirmWith, deferred, fail, fakeApi, fakeExit, now, openAccount, renderPage, rowAt } from './fakes.tsx';

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

  it('11-18 评审加密组第 6 条：revoked 带的原始状态一路交到 exitDevice（记进 lemo.authloss），判断用的码照旧 session_revoked（照样查 session_fate）', async () => {
    const { exit } = fakeExit();
    const leaveAccount = vi.fn(async () => undefined);
    const api = fakeApi({ loadDevices: vi.fn(async () => ({ ...fail('revoked'), why: { code: 'session_not_found', status: 403 } })) });
    render(<SettingsPage deps={{ api, exit, now, leaveAccount }} />);
    await waitFor(() => expect(leaveAccount).toHaveBeenCalledWith('removed', 's-me', { status: 403 }));
    const U = '11111111-1111-4111-8111-111111111111';
    const S = '22222222-2222-4222-8222-222222222222';
    const boot = { userId: U, switching: false, cache: null, outbox: null } as unknown as BootResult;
    const resolveAuthLoss = vi.fn(async () => 'expired' as const);
    const deps: ExitDeps = { ...defaultExitDeps, getBoot: () => boot, wipe: vi.fn(async () => undefined), goToAuth: () => undefined, resolveAuthLoss, broadcastReset: () => undefined, clearLocalSessionIf: async () => true, keep: () => true };
    await createLeaveAccount({ ...deps, setNotice: () => undefined, authPath: 'settings' })('removed', S, { status: 403 });
    expect(resolveAuthLoss).toHaveBeenCalledWith(expect.objectContaining({ path: 'settings', code: 'session_revoked', status: 403 }));
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

describe('本人退出也算“这一页已经在退出”（退出整块评审第 1 条）', () => {
  it('beginExit 之后：同步层的 removed、本页 SIGNED_OUT、别的标签页退出、设置页的 signed_out 都不再查服务器、清库、跳转', async () => {
    const boot = { userId: 'u1', switching: false, cache: null, outbox: null } as unknown as BootResult;
    const wipe = vi.fn(async () => undefined);
    const goToAuth = vi.fn();
    const resolveAuthLoss = vi.fn(async () => 'removed' as const);
    const deps: ExitDeps = { ...defaultExitDeps, getBoot: () => boot, wipe, goToAuth, resolveAuthLoss, broadcastReset: () => undefined, clearLocalSessionIf: async () => true, keep: () => true };
    beginExit(boot);
    expect(boot.switching).toBe(true);
    expect(exitStarted(boot)).toBe(true);
    await exitDevice({ reason: 'removed', sid: 's-me', path: 'outbox' }, deps);
    exitOnSessionLoss({ here: true, sid: 's-me', failure: null }, deps);
    exitOnSessionLoss({ here: false }, deps);
    createFollowSignOut(deps)();
    await new Promise((r) => setTimeout(r, 20));
    expect(resolveAuthLoss).not.toHaveBeenCalled();
    expect(wipe).not.toHaveBeenCalled();
    expect(goToAuth).not.toHaveBeenCalled();
  });

  it('设置页点退出：任何请求之前先 beginExit（删本机行还没回来时同步层再报被移除也不会另清一遍）', async () => {
    const { exit } = fakeExit();
    const row = deferred();
    const api = fakeApi({ deleteOwnDevice: vi.fn(() => row.promise) });
    await renderPage(api, exit);
    await clickSignOut();
    await waitFor(() => expect(api.deleteOwnDevice).toHaveBeenCalled());
    expect(exit.beginExit).toHaveBeenCalledOnce();
    expect(exit.beginExit.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.deleteOwnDevice).mock.invocationCallOrder[0] ?? 0);
    row.resolve();
    await waitFor(() => expect(exit.goToAuth).toHaveBeenCalled());
  });
});

describe('被移除查服务器有总上限（退出整块评审第 4 条）', () => {
  it('resolveAuthLoss 一直不回（分包、哈希、请求卡住）：到 CONFIRM_REMOVED_TIMEOUT_MS 按 expired 只退出、不清库', async () => {
    vi.useFakeTimers();
    try {
      const U = '11111111-1111-4111-8111-111111111111';
      const S = '22222222-2222-4222-8222-222222222222';
      const boot = { userId: U, switching: false, cache: null, outbox: null } as unknown as BootResult;
      const wipe = vi.fn(async () => undefined);
      const goToAuth = vi.fn();
      const deps: ExitDeps = {
        ...defaultExitDeps, getBoot: () => boot, wipe, goToAuth, broadcastReset: () => undefined, clearLocalSessionIf: async () => true,
        resolveAuthLoss: () => new Promise(() => undefined),
      };
      void exitDevice({ reason: 'removed', sid: S, path: 'outbox' }, deps);
      await vi.advanceTimersByTimeAsync(CONFIRM_REMOVED_TIMEOUT_MS);
      expect(goToAuth).toHaveBeenCalledWith('expired', S);
      expect(wipe).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
