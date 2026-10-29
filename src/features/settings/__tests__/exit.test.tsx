// 离开这台设备（架构 4.1、0.29 续第 98 条、0.38 第 7 条；K9 第二轮审查 N1、N2、L1～L3）
// 被移除 / 已退出：清理做完才跳登录页；自己退出：删本机行 → 清库和缓存 → signOut，8 秒总超时、晚到再清
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { isSelfSignOut, resetSelfSignOutForTest } from '../../../platform/session.ts';
import type { LocalSignOut } from '../data/settings-api.ts';
import { zh } from '../i18n/zh.ts';
import SettingsPage from '../ui/SettingsPage.tsx';
import { clickSignOut, confirmWith, deferred, fail, fakeApi, fakeExit, now, renderPage, rowAt, text } from './fakes.tsx';

vi.mock('../i18n/ko.ts', async () => {
  const { zh: z } = await vi.importActual<{ zh: Record<string, string> }>('../i18n/zh.ts');
  return { ko: Object.fromEntries(Object.entries(z).map(([k, v]) => [k, `[ko]${v}`])) };
});

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  localStorage.clear();
  resetSelfSignOutForTest();
  document.documentElement.lang = 'zh-CN';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('会话没了：提示后回登录页（0.29 续第 98 条、0.38 第 7 条）', () => {
  it('读列表回 revoked：先清本机库和缓存，清完马上同步删本机会话，signOut 放后台；弹“需要重新登录”，点“去登录”回登录页', async () => {
    const { exit, order } = fakeExit();
    const api = fakeApi({ loadDevices: vi.fn(async () => fail('revoked')) }, order);
    render(<SettingsPage deps={{ api, exit, now }} />);
    const dlg = await screen.findByRole('dialog');
    expect(text(dlg)).toContain(zh['settings.revoked.body']);
    await waitFor(() => expect(order).toEqual(['wipe', 'caches', 'session', 'signout', 'deleteDb']));
    const go = await within(dlg).findByRole('button', { name: zh['settings.revoked.go'] });
    await act(async () => {
      fireEvent.click(go);
    });
    await waitFor(() => expect(exit.goToAuth).toHaveBeenCalledTimes(1));
  });

  it('被移除后 signOut 一直不返回：不等它，清完库就删本机会话，“去登录”可点', async () => {
    const { exit } = fakeExit();
    const api = fakeApi({ loadDevices: vi.fn(async () => fail('revoked')), dropLocalSession: vi.fn(() => new Promise<LocalSignOut>(() => undefined)) });
    render(<SettingsPage deps={{ api, exit, now }} />);
    const dlg = await screen.findByRole('dialog');
    await waitFor(() => expect(exit.clearLocalSession).toHaveBeenCalled());
    const go = await within(dlg).findByRole('button', { name: zh['settings.revoked.go'] });
    expect((go as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(go);
    });
    await waitFor(() => expect(exit.goToAuth).toHaveBeenCalledTimes(1));
  });

  it('弹框一出来就点、或自动跳转先到：都等清空本机和删本机会话做完再跳（清理中按钮禁用）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { exit, order } = fakeExit();
    const gate = deferred();
    exit.wipe.mockImplementation(async () => {
      await gate.promise;
      order.push('wipe');
      return true;
    });
    const api = fakeApi({ loadDevices: vi.fn(async () => fail('revoked')) }, order);
    render(<SettingsPage deps={{ api, exit, now, redirectMs: 1000 }} />);
    const dlg = await screen.findByRole('dialog');
    const go = within(dlg).getByTestId('settings-revoked-go') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(text(go)).toBe(zh['settings.busy']);
    fireEvent.click(go);
    // 自动跳转的时间到了，清理还没完：不跳
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(exit.goToAuth).not.toHaveBeenCalled();
    expect(exit.clearLocalSession).not.toHaveBeenCalled();
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(exit.goToAuth).toHaveBeenCalledTimes(1));
    expect(order.indexOf('wipe')).toBeLessThan(order.indexOf('auth'));
    expect(order.indexOf('caches')).toBeLessThan(order.indexOf('auth'));
    expect(order.indexOf('session')).toBeLessThan(order.indexOf('auth'));
  });

  it('本机已经没有会话（别的标签页退出了）：提示“已退出登录”，不说“被移除”', async () => {
    const api = fakeApi({ loadDevices: vi.fn(async () => fail('signed_out')) });
    const { exit } = fakeExit();
    render(<SettingsPage deps={{ api, exit, now }} />);
    const dlg = await screen.findByRole('dialog');
    expect(text(dlg)).toContain(zh['settings.signedOut.body']);
    expect(text(dlg)).not.toContain(zh['settings.revoked.body']);
    await waitFor(() => expect(exit.clearLocalSession).toHaveBeenCalled());
  });

  it('移除设备时回 revoked：同样处理；按钮复位；不点按钮几秒后自动回登录页', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeApi({ removeDevice: vi.fn(async () => fail('revoked')) });
    const { exit } = fakeExit();
    await renderPage(api, exit, 3000);
    fireEvent.click(within(rowAt(1)).getByRole('button'));
    await confirmWith(zh['settings.confirm.remove.ok']);
    expect(await screen.findByText(zh['settings.revoked.body'])).toBeTruthy();
    expect(within(rowAt(1)).getByRole('button', { hidden: true }).hasAttribute('disabled')).toBe(false);
    expect(exit.goToAuth).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await waitFor(() => expect(exit.goToAuth).toHaveBeenCalledTimes(1));
    expect(exit.wipe).toHaveBeenCalledTimes(1);
    expect(api.dropLocalSession).toHaveBeenCalledTimes(1);
  });

  it('改语言时写账号回 revoked：同样处理', async () => {
    const api = fakeApi({ saveLocale: vi.fn(async () => fail('revoked')) });
    const { exit } = fakeExit();
    await renderPage(api, exit);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['settings.lang.ko'] }));
    });
    expect(await screen.findByText(`[ko]${zh['settings.revoked.body']}`)).toBeTruthy();
    expect(exit.wipe).toHaveBeenCalled();
    await waitFor(() => expect(exit.clearLocalSession).toHaveBeenCalled());
  });
});

describe('退出登录（K9 第二轮 N2、L1、L2、L3）', () => {
  it('退出登录（没有待发改动和草稿）：不弹确认，删本机行 → 清空本机 → signOut，回登录页', async () => {
    const { exit, order } = fakeExit();
    const api = fakeApi({}, order);
    await renderPage(api, exit);
    await clickSignOut();
    await waitFor(() => expect(exit.goToAuth).toHaveBeenCalled());
    expect(order).toEqual(['row', 'wipe', 'caches', 'signout', 'deleteDb', 'session', 'auth']);
    expect(api.deleteOwnDevice).toHaveBeenCalledWith('y');
  });

  it('数不出没上传的（库是 version_too_new / unavailable，队列为 null）：照样先确认，写“可能有改动还没上传”', async () => {
    const api = fakeApi();
    const { exit } = fakeExit(null);
    await renderPage(api, exit);
    await clickSignOut();
    const dlg = await screen.findByRole('dialog');
    expect(text(dlg)).toContain(zh['settings.confirm.signOut.unknownTitle']);
    expect(api.deleteOwnDevice).not.toHaveBeenCalled();
  });

  it('有 3 条待发改动或草稿：先弹确认（写明条数），取消不退出，确认才退出', async () => {
    const api = fakeApi();
    const { exit } = fakeExit(3);
    await renderPage(api, exit);
    await clickSignOut();
    let dlg = await screen.findByRole('dialog');
    expect(text(dlg)).toContain('还有 3 条改动或草稿没上传');
    fireEvent.click(within(dlg).getByRole('button', { name: zh['settings.cancel'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.deleteOwnDevice).not.toHaveBeenCalled();
    await clickSignOut();
    dlg = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dlg).getByRole('button', { name: zh['settings.confirm.signOut.ok'] }));
    });
    await waitFor(() => expect(exit.goToAuth).toHaveBeenCalled());
  });

  it('服务器那边没退成（serverDone: false）：本机照样清空并删本机会话，提示“服务器上的这次登录暂时没能吊销”，点“去登录”再走', async () => {
    const api = fakeApi({ dropLocalSession: vi.fn(async () => ({ serverDone: false })) });
    const { exit } = fakeExit();
    await renderPage(api, exit);
    await clickSignOut();
    const dlg = await screen.findByRole('dialog');
    expect(text(dlg)).toContain(zh['settings.offlineOut.body']);
    expect(text(dlg)).not.toContain('没联网');
    expect(exit.wipe).toHaveBeenCalled();
    expect(exit.clearLocalSession).toHaveBeenCalled();
    expect(exit.goToAuth).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dlg).getByRole('button', { name: zh['settings.revoked.go'] }));
    });
    await waitFor(() => expect(exit.goToAuth).toHaveBeenCalledTimes(1));
  });

  it('退出时 signOut 永远不返回：8 秒后本机已清空、本机会话已删，出现提示；之后请求才回来、旧会话被写回就再删一次', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const signOut = deferred<LocalSignOut>();
    const api = fakeApi({ dropLocalSession: vi.fn(() => signOut.promise) });
    const { exit } = fakeExit();
    await renderPage(api, exit);
    await clickSignOut();
    await waitFor(() => expect(api.dropLocalSession).toHaveBeenCalled());
    expect(exit.wipe).toHaveBeenCalled();
    expect(screen.queryByText(zh['settings.offlineOut.body'])).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(8000);
    });
    expect(await screen.findByText(zh['settings.offlineOut.body'])).toBeTruthy();
    expect(exit.clearLocalSession).toHaveBeenCalledTimes(1);
    expect(exit.goToAuth).not.toHaveBeenCalled();
    // 晚到：本机会话还是退出前那个 user_id（令牌刷新把旧会话写回了）
    await act(async () => {
      signOut.resolve({ serverDone: true });
    });
    await waitFor(() => expect(exit.clearLocalSession).toHaveBeenCalledTimes(2));
  });

  it('晚到时本机已经是别的账号（或没有会话）：不再删', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const signOut = deferred<LocalSignOut>();
    const api = fakeApi({ dropLocalSession: vi.fn(() => signOut.promise) });
    const { exit } = fakeExit();
    await renderPage(api, exit);
    await clickSignOut();
    await waitFor(() => expect(api.dropLocalSession).toHaveBeenCalled());
    await act(async () => {
      vi.advanceTimersByTime(8000);
    });
    expect(await screen.findByText(zh['settings.offlineOut.body'])).toBeTruthy();
    exit.readUserId.mockReturnValue('u2');
    await act(async () => {
      signOut.resolve({ serverDone: true });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(exit.clearLocalSession).toHaveBeenCalledTimes(1);
  });

  it('删本机行一直不返回：最多等总超时的一半，接着清本机、signOut', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { exit, order } = fakeExit();
    const api = fakeApi({ deleteOwnDevice: vi.fn(() => new Promise<void>(() => undefined)) }, order);
    await renderPage(api, exit);
    await clickSignOut();
    expect(exit.wipe).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    await waitFor(() => expect(exit.goToAuth).toHaveBeenCalled());
    expect(order).toEqual(['wipe', 'caches', 'signout', 'deleteDb', 'session', 'auth']);
  });

  it('删本机行晚到（超时以后才回来）：不删本机会话，signOut 照常做；服务器没退成照样提示', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const del = deferred();
    const { exit, order } = fakeExit();
    const api = fakeApi({ deleteOwnDevice: vi.fn(() => del.promise), dropLocalSession: vi.fn(async () => ({ serverDone: false })) }, order);
    await renderPage(api, exit);
    await clickSignOut();
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(await screen.findByText(zh['settings.offlineOut.body'])).toBeTruthy();
    expect(exit.clearLocalSession).toHaveBeenCalledTimes(1);
    // 删行这时才回来，本机会话里还是同一个 user_id：不因为它再删
    await act(async () => {
      del.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(exit.clearLocalSession).toHaveBeenCalledTimes(1);
  });

  it('数没上传的卡住（读库挡着）：最多等 2.5 秒，按数不出来处理，照样先确认', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeApi();
    const { exit } = fakeExit();
    exit.pendingCount.mockImplementation(() => new Promise<number | null>(() => undefined));
    await renderPage(api, exit);
    await clickSignOut();
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    const dlg = await screen.findByRole('dialog');
    expect(text(dlg)).toContain(zh['settings.confirm.signOut.unknownTitle']);
    expect(api.deleteOwnDevice).not.toHaveBeenCalled();
  });

  it('退出过程中一直写着“正在退出…”，退出按钮禁用；服务器没退成、弹提示时收起', async () => {
    const signOut = deferred<LocalSignOut>();
    const api = fakeApi({ dropLocalSession: vi.fn(() => signOut.promise) });
    const { exit } = fakeExit();
    await renderPage(api, exit);
    expect(text(screen.getByTestId('settings-signing-out'))).toBe('');
    await clickSignOut();
    await waitFor(() => expect(text(screen.getByTestId('settings-signing-out'))).toBe(zh['settings.signingOut']));
    expect(screen.getByTestId('settings-signing-out').getAttribute('role')).toBe('status');
    expect((screen.getByTestId('settings-signout') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      signOut.resolve({ serverDone: false });
    });
    expect(await screen.findByText(zh['settings.offlineOut.body'])).toBeTruthy();
    expect(text(screen.getByTestId('settings-signing-out'))).toBe('');
  });
});

describe('自己调 signOut 之前先打“自己退出”的标记（K6-signedout：会话层的 SIGNED_OUT 监听见到就不再按“被移除”重复处理）', () => {
  it('退出登录：删本机行之前就打了标记', async () => {
    const { exit, order } = fakeExit();
    const marked: boolean[] = [];
    const api = fakeApi({ deleteOwnDevice: vi.fn(async () => void marked.push(isSelfSignOut())) }, order);
    expect(isSelfSignOut()).toBe(false);
    await renderPage(api, exit);
    await clickSignOut();
    await waitFor(() => expect(exit.goToAuth).toHaveBeenCalled());
    expect(marked).toEqual([true]);
  });

  it('读列表回 revoked（本页自己处理被移除，后台调 signOut）：signOut 之前已打标记，只打本页的', async () => {
    const { exit } = fakeExit();
    const marked: boolean[] = [];
    const api = fakeApi({
      loadDevices: vi.fn(async () => fail('revoked')),
      dropLocalSession: vi.fn(async () => (marked.push(isSelfSignOut()), { serverDone: true } satisfies LocalSignOut)),
    });
    render(<SettingsPage deps={{ api, exit, now }} />);
    await screen.findByRole('dialog');
    await waitFor(() => expect(marked).toEqual([true]));
    expect(localStorage.getItem('lemo.self_signout')).toBeNull();   // 只打本页的（审查建议 4）
  });
});
