// 设置页收到 account_disabled 先探测再定（R-256 ③、PROBE-sugg ②；core/account-leave.ts 的 createDisabledGate、exitForAccountDisabled，和主 App、告知页同一个入口）：
// • 设备列表、改语言、换头像（settings-api，RLS 一路）和导出、注销（account-api）都走这一页的同一个闸：同一时刻只探测一次
// • 探测不出（unknown）一律按 disabled 只退出、不清本机（11-20 收口；原来 settings-api 一路按 disabled_unsure 清库）；冷静期 → pending_deletion；
//   signed_out → 被移除；active → 不离开、各自提示通用错误
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type { AccountProbe } from '../../../platform/account-status.ts';
import type { BootResult } from '../../../core/boot.ts';
import { createDisabledGate, DISABLED_KEEP_MS, exitForAccountDisabled } from '../../../core/account-leave.ts';
import { probeOf } from '../../../core/__tests__/disabled-probe-fakes.ts';
import { handleAccountLoss } from '../hooks/useAccountActions.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import SettingsPage from '../ui/SettingsPage.tsx';
import { exportBtn, fakeAccount, setup } from './account-fakes.tsx';
import { fail, fakeApi, fakeExit, now } from './fakes.tsx';

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  // 合卡以后有的用例会点进账号二级页：每条从设置首页开始，上一条留下的地址不带过来
  window.history.replaceState(null, '', '#/settings');
});
afterEach(cleanup);

const noBoot = (): BootResult | null => null;

describe('exitForAccountDisabled（统一入口）', () => {
  const run = async (r: Parameters<typeof probeOf>[0]) => {
    const leave = vi.fn(async () => undefined);
    const resolve = vi.fn(async (_sid: string | null) => probeOf(r));
    const gate = createDisabledGate({ resolve });
    const out = await exitForAccountDisabled('s1', { gate, getBoot: noBoot, leave });
    return { out, leave, resolve, gate };
  };

  it('冷静期、已停用、探测不出（按 disabled）、被移除：按它离开一次；active 不离开、闸不记离开', async () => {
    for (const [r, n] of [['pending_deletion', 'pending_deletion'], ['disabled', 'disabled'], ['unknown', 'disabled'], ['removed', 'removed']] as const) {
      const x = await run(r);
      expect(x.out).toBe('left');
      expect(x.leave).toHaveBeenCalledWith(n, 's1');
      expect(x.gate.left).toBe(true);
    }
    const ok = await run('active');
    expect(ok.out).toBe('active');
    expect(ok.leave).not.toHaveBeenCalled();
    expect(ok.gate.left).toBe(false);
    expect(ok.resolve).toHaveBeenCalledWith('s1');
  });

  it('同一个闸：探测中再来的合用那一次（不再探测）；离开以后再来的直接跳过', async () => {
    let answer = (_r: AccountProbe): void => undefined;
    const resolve = vi.fn((_sid: string | null) => new Promise<AccountProbe>((r) => (answer = r)));
    const gate = createDisabledGate({ resolve });
    const leave = vi.fn(async () => undefined);
    const a = exitForAccountDisabled('s1', { gate, getBoot: noBoot, leave });
    const b = exitForAccountDisabled('s1', { gate, getBoot: noBoot, leave });
    await waitFor(() => expect(gate.busy()).toBe(true));
    answer({ kind: 'disabled' });
    expect(await a).toBe('left');
    expect(await b).toBe('skipped');
    expect(await exitForAccountDisabled('s1', { gate, getBoot: noBoot, leave })).toBe('skipped');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('active：合用同一次探测的都收到 active；之后再遇到可以再探', async () => {
    let answer = (_r: AccountProbe): void => undefined;
    const resolve = vi.fn((_sid: string | null) => new Promise<AccountProbe>((r) => (answer = r)));
    const gate = createDisabledGate({ resolve });
    const leave = vi.fn(async () => undefined);
    const a = exitForAccountDisabled('s1', { gate, getBoot: noBoot, leave });
    const b = exitForAccountDisabled('s1', { gate, getBoot: noBoot, leave });
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    answer({ kind: 'active' });
    expect([await a, await b]).toEqual(['active', 'active']);
    void exitForAccountDisabled('s1', { gate, getBoot: noBoot, leave });
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    expect(leave).not.toHaveBeenCalled();
  });

  it('这一页已在换账号：不探测、不离开', async () => {
    const resolve = vi.fn(async (_sid: string | null) => probeOf('disabled'));
    const gate = createDisabledGate({ resolve });
    const leave = vi.fn();
    const boot = { switching: true } as unknown as BootResult;
    expect(await exitForAccountDisabled('s1', { gate, getBoot: () => boot, leave })).toBe('skipped');
    expect(resolve).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  });

  it('探测抛错按 unknown（= disabled 只退出），不往外抛', async () => {
    const gate = createDisabledGate({ resolve: () => Promise.reject(new Error('boom')) });
    expect(await gate.probe('s1')).toEqual({ r: { kind: 'unknown' }, first: true });
  });

  it('keep（Q-15）：已停用、冷静期记 DISABLED_KEEP_MS，同一个 sid 下一次沿用、用一次就清；active 不记；过期不用', async () => {
    let t = 0;
    const answers: AccountProbe[] = [{ kind: 'disabled' }, { kind: 'active' }, { kind: 'pending_deletion', purgeAfter: null }, { kind: 'active' }];
    const resolve = vi.fn(async (_sid: string | null): Promise<AccountProbe> => answers.shift() ?? { kind: 'unknown' });
    const gate = createDisabledGate({ resolve, now: () => t });
    expect((await gate.probe('s1', { keep: true })).r.kind).toBe('disabled');
    expect((await gate.probe('s1')).r.kind).toBe('disabled');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect((await gate.probe('s1')).r.kind).toBe('active');
    expect((await gate.probe('s1', { keep: true })).r.kind).toBe('pending_deletion');
    t = DISABLED_KEEP_MS;
    expect((await gate.probe('s1')).r.kind).toBe('active');
    expect(resolve).toHaveBeenCalledTimes(4);
  });
});

describe('设备列表（settings-api）收到 account_disabled', () => {
  for (const [r, notice] of [['pending_deletion', 'pending_deletion'], ['unknown', 'disabled'], ['disabled', 'disabled']] as const) {
    it(`探测结果 ${r}：回登录页按 ${notice} 提示；探测用被拒那次的 sid`, async () => {
      const api = fakeApi({ loadDevices: vi.fn(async () => fail('account_disabled')) });
      const { exit } = fakeExit();
      const leaveAccount = vi.fn(async () => undefined);
      const resolveDisabled = vi.fn(async (_sid: string | null) => probeOf(r));
      render(<SettingsPage deps={{ api, exit, now, leaveAccount, resolveDisabled }} />);
      await waitFor(() => expect(leaveAccount).toHaveBeenCalledWith(notice, 's-me'));
      expect(resolveDisabled).toHaveBeenCalledWith('s-me');
    });
  }

  it('探测说会话已失效（removed）：走“被移除”= leaveAccount("removed", sid)（和别的出口同一条 exitDevice），设置页自己不清库', async () => {
    const api = fakeApi({ loadDevices: vi.fn(async () => fail('account_disabled')) });
    const { exit } = fakeExit();
    const leaveAccount = vi.fn(async () => undefined);
    render(<SettingsPage deps={{ api, exit, now, leaveAccount, resolveDisabled: async () => probeOf('removed') }} />);
    await waitFor(() => expect(leaveAccount).toHaveBeenCalledWith('removed', 's-me'));
    expect(exit.wipe).not.toHaveBeenCalled();
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
    let answer = (_r: AccountProbe): void => undefined;
    const resolveDisabled = vi.fn((_sid: string | null) => new Promise<AccountProbe>((r) => (answer = r)));
    render(<SettingsPage deps={{ api, exit, now, leaveAccount, resolveDisabled }} />);
    await waitFor(() => expect(resolveDisabled).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['settings.lang.ko'] }));
    });
    await waitFor(() => expect(api.saveLocale).toHaveBeenCalledTimes(1));
    expect(resolveDisabled).toHaveBeenCalledTimes(1);
    await act(async () => answer({ kind: 'active' }));
    // 探测中排进来的也一起通知：首页“账号”一行写“读不出来”，账号二级页的设备列表也是，不说停用
    expect(await screen.findByText(new RegExp(`${zh['settings.account.devicesFailed']}|${ko['settings.account.devicesFailed']}`))).toBeTruthy();
    expect(screen.queryByText(new RegExp(`${zh['settings.err.accountDisabled']}|${ko['settings.err.accountDisabled']}`))).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-account-entry'));
    });
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
    const resolveDisabled = vi.fn(async (_sid: string | null) => probeOf('disabled'));
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
  const disabledExport = () => fakeAccount({ startExport: vi.fn(async () => ({ ok: false as const, error: 'account_disabled' as const, sid: 's-me' })) });

  it('探测说账号正常：不离开，照常显示这次的错误', async () => {
    const resolveDisabled = vi.fn(async (_sid: string | null) => probeOf('active'));
    const { leave } = setup({ account: disabledExport(), resolveDisabled });
    await act(async () => {
      fireEvent.click(exportBtn());
    });
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // 账号正常就不说“已停用”，按设备列表同一口径提示通用错误（PROBE 遗留）
    expect(screen.getByRole('alert').textContent).toContain(zh['settings.err.unknown']);
    expect(screen.queryByText(zh['settings.err.accountDisabled'])).toBeNull();
    expect(resolveDisabled).toHaveBeenCalledWith('s-me');
    expect(leave).not.toHaveBeenCalled();
  });

  it('探测出冷静期：按冷静期离开（不再一律说“已停用”）', async () => {
    const { leave } = setup({ account: disabledExport(), resolveDisabled: async () => probeOf('pending_deletion') });
    await act(async () => {
      fireEvent.click(exportBtn());
    });
    await waitFor(() => expect(leave).toHaveBeenCalledWith('pending_deletion', 's-me'));
    expect(screen.queryByText(zh['settings.err.accountDisabled'])).toBeNull();
  });

  it('handleAccountLoss 把 onStay 交给 onDisabled；onDisabled 里出错时调 onStay，不留 unhandledrejection（REVIEW-1030-fe-sugg ②）', async () => {
    const unhandled: unknown[] = [];
    const onNode = (why: unknown) => unhandled.push(why);
    const onWin = (ev: PromiseRejectionEvent) => unhandled.push(ev.reason);
    process.on('unhandledRejection', onNode);
    window.addEventListener('unhandledrejection', onWin);
    try {
      const onStay = vi.fn();
      const leave = vi.fn(async () => undefined);
      const onDisabled = (_sid: string | null, stay?: () => void): void => void Promise.reject(new Error('probe boom')).catch(() => stay?.());
      const handled = handleAccountLoss({ ok: false, error: 'account_disabled', sid: 's-me' }, { leave, onRevoked: vi.fn(), onSignedOut: vi.fn(), onDisabled }, onStay);
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

  it('探测抛错：按探测不出处理（只退出 disabled，设置页不清本机）', async () => {
    const { leave, exit } = setup({ account: disabledExport(), resolveDisabled: () => Promise.reject(new Error('probe boom')) });
    await act(async () => {
      fireEvent.click(exportBtn());
    });
    await waitFor(() => expect(leave).toHaveBeenCalledWith('disabled', 's-me'));
    expect(exit.wipe).not.toHaveBeenCalled();
  });

  it('导出和读设备列表同时回 account_disabled：整页只探测一次、只离开一次（11-20 收口前导出一路自己另探）', async () => {
    window.history.replaceState(null, '', '#/settings/data');
    let answer = (_r: AccountProbe): void => undefined;
    const resolveDisabled = vi.fn((_sid: string | null) => new Promise<AccountProbe>((r) => (answer = r)));
    const api = fakeApi({ loadDevices: vi.fn(async () => fail('account_disabled')) });
    const { exit } = fakeExit();
    const account = disabledExport();
    const leaveAccount = vi.fn(async () => undefined);
    const recentExports = { list: vi.fn(async () => ({ kind: 'none' as const })) };
    render(<SettingsPage deps={{ api, exit, now, account, leaveAccount, readDeviceId: async () => 'dev-1', recentExports, resolveDisabled }} />);
    await waitFor(() => expect(resolveDisabled).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(exportBtn());
    });
    await waitFor(() => expect(account.startExport).toHaveBeenCalledTimes(1));
    expect(resolveDisabled).toHaveBeenCalledTimes(1);
    await act(async () => answer({ kind: 'pending_deletion', purgeAfter: null }));
    await waitFor(() => expect(leaveAccount).toHaveBeenCalledWith('pending_deletion', 's-me'));
    expect(resolveDisabled).toHaveBeenCalledTimes(1);
    expect(leaveAccount).toHaveBeenCalledTimes(1);
  });
});
