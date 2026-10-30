// 设置页收到 account_disabled 先探测再定（R-256 ③、PROBE-sugg ②；data/account-exit.ts 的 leaveForDisabled）：
// • settings-api（RLS 一路，分不清停用和冷静期）：探测不出按 disabled_unsure；冷静期 → pending_deletion；signed_out → 被移除；active → 只提示
// • account-api（经 requireActiveUser，码精确）：探测不出仍按 disabled；active → 不离开，照常显示这次的错误
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type { ProbedExit } from '../../../platform/account-status.ts';
import { leaveForDisabled } from '../data/account-exit.ts';
import { handleAccountLoss } from '../hooks/useAccountActions.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import SettingsPage from '../ui/SettingsPage.tsx';
import { exportBtn, fakeAccount, setup } from './account-fakes.tsx';
import { fail, fakeApi, fakeExit, now } from './fakes.tsx';

beforeEach(() => uiStore.getState().setLocale('zh-CN'));
afterEach(cleanup);

describe('leaveForDisabled', () => {
  const run = async (r: ProbedExit | 'active', fallback?: 'disabled') => {
    const leave = vi.fn(async () => undefined);
    const onRevoked = vi.fn();
    const resolve = vi.fn(async () => r);
    const left = await leaveForDisabled('s1', { leave, onRevoked, resolve }, fallback);
    return { left, leave, onRevoked, resolve };
  };
  it('冷静期、已停用、不确定：按它离开；removed 交给 onRevoked；active 不离开（返回 false）', async () => {
    for (const n of ['pending_deletion', 'disabled', 'disabled_unsure'] as const) {
      const x = await run(n);
      expect(x.left).toBe(true);
      expect(x.leave).toHaveBeenCalledWith(n, 's1');
    }
    const rm = await run('removed');
    expect(rm.onRevoked).toHaveBeenCalledWith('s1');
    expect(rm.leave).not.toHaveBeenCalled();
    const ok = await run('active', 'disabled');
    expect(ok.left).toBe(false);
    expect(ok.leave).not.toHaveBeenCalled();
    expect(ok.resolve).toHaveBeenCalledWith('s1', 'disabled');
  });
});

describe('设备列表（settings-api）收到 account_disabled', () => {
  for (const [r, notice] of [['pending_deletion', 'pending_deletion'], ['disabled_unsure', 'disabled_unsure'], ['disabled', 'disabled']] as const) {
    it(`探测结果 ${r}：清本机、回登录页按 ${notice} 提示；探测用被拒那次的 sid，不给 fallback`, async () => {
      const api = fakeApi({ loadDevices: vi.fn(async () => fail('account_disabled')) });
      const { exit } = fakeExit();
      const leaveAccount = vi.fn(async () => undefined);
      const resolveDisabled = vi.fn(async () => r);
      render(<SettingsPage deps={{ api, exit, now, leaveAccount, resolveDisabled }} />);
      await waitFor(() => expect(leaveAccount).toHaveBeenCalledWith(notice, 's-me'));
      expect(resolveDisabled).toHaveBeenCalledWith('s-me', undefined);
    });
  }

  it('探测说会话已失效（removed）：走“被移除”，不走 leaveAccount', async () => {
    const api = fakeApi({ loadDevices: vi.fn(async () => fail('account_disabled')) });
    const { exit } = fakeExit();
    const leaveAccount = vi.fn(async () => undefined);
    render(<SettingsPage deps={{ api, exit, now, leaveAccount, resolveDisabled: async () => 'removed' }} />);
    await waitFor(() => expect(exit.clearLocalSessionIf).toHaveBeenCalledWith('s-me'));
    expect(leaveAccount).not.toHaveBeenCalled();
  });
});

describe('设备列表、改语言同一时刻只探测一次（第六轮审查建议 ③）', () => {
  it('读设备列表和改语言都回 account_disabled：探测中再来的不再探测；探测说账号正常后放开，再遇到可以再探测', async () => {
    const api = fakeApi({
      loadDevices: vi.fn(async () => fail('account_disabled')),
      saveLocale: vi.fn(async () => fail('account_disabled')),
    });
    const { exit } = fakeExit();
    const leaveAccount = vi.fn(async () => undefined);
    let answer = (_r: 'active'): void => undefined;
    const resolveDisabled = vi.fn(() => new Promise<'active'>((r) => (answer = r)));
    render(<SettingsPage deps={{ api, exit, now, leaveAccount, resolveDisabled }} />);
    await waitFor(() => expect(resolveDisabled).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['settings.lang.ko'] }));
    });
    await waitFor(() => expect(api.saveLocale).toHaveBeenCalledTimes(1));
    expect(resolveDisabled).toHaveBeenCalledTimes(1);
    await act(async () => answer('active'));
    // 探测中排进来的也一起通知：设备列表改显示“读不出来”，不说停用
    expect(await screen.findByText(new RegExp(`${zh['settings.devices.loadFailed']}|${ko['settings.devices.loadFailed']}`))).toBeTruthy();
    expect(screen.queryByText(new RegExp(`${zh['settings.err.accountDisabled']}|${ko['settings.err.accountDisabled']}`))).toBeNull();
    await act(async () => {
      // 刚切成了韩文：按钮文字中韩都可能
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`${zh['settings.devices.retry']}|${ko['settings.devices.retry']}`) }));
    });
    await waitFor(() => expect(resolveDisabled).toHaveBeenCalledTimes(2));
    expect(leaveAccount).not.toHaveBeenCalled();
  });

  it('探测出要离开：之后再来的一直不再探测', async () => {
    const api = fakeApi({ loadDevices: vi.fn(async () => fail('account_disabled')), saveLocale: vi.fn(async () => fail('account_disabled')) });
    const { exit } = fakeExit();
    const leaveAccount = vi.fn(async () => undefined);
    const resolveDisabled = vi.fn(async () => 'disabled' as const);
    render(<SettingsPage deps={{ api, exit, now, leaveAccount, resolveDisabled }} />);
    await waitFor(() => expect(leaveAccount).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['settings.lang.ko'] }));
    });
    await waitFor(() => expect(api.saveLocale).toHaveBeenCalledTimes(1));
    expect(resolveDisabled).toHaveBeenCalledTimes(1);
  });
});

describe('导出（account-api）收到 account_disabled', () => {
  it('探测说账号正常：不离开，照常显示这次的错误；探测带 fallback disabled', async () => {
    const account = fakeAccount({ startExport: vi.fn(async () => ({ ok: false as const, error: 'account_disabled' as const, sid: 's-me' })) });
    const resolveDisabled = vi.fn(async () => 'active' as const);
    const { leave } = setup({ account, resolveDisabled });
    await act(async () => {
      fireEvent.click(exportBtn());
    });
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // 账号正常就不说“已停用”，按设备列表同一口径提示通用错误（PROBE 遗留）
    expect(screen.getByRole('alert').textContent).toContain(zh['settings.err.unknown']);
    expect(screen.queryByText(zh['settings.err.accountDisabled'])).toBeNull();
    expect(resolveDisabled).toHaveBeenCalledWith('s-me', 'disabled');
    expect(leave).not.toHaveBeenCalled();
  });

  it('探测出冷静期：按冷静期离开（不再一律说“已停用”）', async () => {
    const account = fakeAccount({ startExport: vi.fn(async () => ({ ok: false as const, error: 'account_disabled' as const, sid: 's-me' })) });
    const { leave } = setup({ account, resolveDisabled: async () => 'pending_deletion' });
    await act(async () => {
      fireEvent.click(exportBtn());
    });
    await waitFor(() => expect(leave).toHaveBeenCalledWith('pending_deletion', 's-me'));
    expect(screen.queryByText(zh['settings.err.accountDisabled'])).toBeNull();
  });

  it('探测抛错（REVIEW-1030-fe-sugg ②）：handleAccountLoss 调 onStay，不留 unhandledrejection', async () => {
    const unhandled: unknown[] = [];
    const onNode = (why: unknown) => unhandled.push(why);
    const onWin = (ev: PromiseRejectionEvent) => unhandled.push(ev.reason);
    process.on('unhandledRejection', onNode);
    window.addEventListener('unhandledrejection', onWin);
    try {
      const onStay = vi.fn();
      const leave = vi.fn(async () => undefined);
      const handled = handleAccountLoss(
        { ok: false, error: 'account_disabled', sid: 's-me' },
        { leave, onRevoked: vi.fn(), onSignedOut: vi.fn(), resolveDisabled: () => Promise.reject(new Error('probe boom')) },
        onStay,
      );
      expect(handled).toBe(true);
      await waitFor(() => expect(onStay).toHaveBeenCalledTimes(1));
      // 多等一轮宏任务，让未处理的 reject 有机会报出来
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
      expect(leave).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onNode);
      window.removeEventListener('unhandledrejection', onWin);
    }
  });

  it('探测抛错：导出按钮不停在“忙”，照常显示通用错误', async () => {
    const account = fakeAccount({ startExport: vi.fn(async () => ({ ok: false as const, error: 'account_disabled' as const, sid: 's-me' })) });
    const { leave } = setup({ account, resolveDisabled: () => Promise.reject(new Error('probe boom')) });
    await act(async () => {
      fireEvent.click(exportBtn());
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(zh['settings.err.unknown']));
    expect(leave).not.toHaveBeenCalled();
  });
});
