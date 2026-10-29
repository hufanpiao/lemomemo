// 设置页离开这台设备时删本机会话只删本页那一个（接手清单 K6-sugg3 ①；从 exit.test.tsx 拆出来，那边已超过 300 行）
// 会话两步用真的（platform/sign-out.ts 的 defaultExitSteps → session.ts 的 clearLocalSession / clearLocalSessionIf / readSessionId），
// 清库卡在 gate 上（= 清库那几秒）时别的标签页登录了新会话，看最后本机会话还在不在
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { readSessionUserId, resetSelfSignOutForTest } from '../../../platform/session.ts';
import { defaultExitSteps } from '../../../platform/sign-out.ts';
import { zh } from '../i18n/zh.ts';
import SettingsPage from '../ui/SettingsPage.tsx';
import { clickSignOut, deferred, fail, fakeApi, fakeExit, now, renderPage, text } from './fakes.tsx';

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  localStorage.clear();
  resetSelfSignOutForTest();
  document.documentElement.lang = 'zh-CN';
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('删本机会话只删本页那一个（K6-sugg3 ①，真的 localStorage）', () => {
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';
  const KEY = 'sb-lemotest-auth-token';
  const tok = (sid: string): string => `h.${btoa(JSON.stringify({ session_id: sid })).replace(/=+$/, '')}.s`;
  const seed = (sid: string, user = A): void => localStorage.setItem(KEY, JSON.stringify({ access_token: tok(sid), user: { id: user } }));

  function realExit() {
    const { exit, order } = fakeExit();
    const gate = deferred();
    exit.wipe.mockImplementation(async () => {
      await gate.promise;
      order.push('wipe');
      return true;
    });
    exit.clearLocalSession.mockImplementation((onlyIf?: string | null) => defaultExitSteps.clearLocalSession(onlyIf));
    exit.readSessionId.mockImplementation(() => defaultExitSteps.readSessionId());
    return { exit, order, gate };
  }

  for (const [label, user] of [['别的账号', B], ['同一账号的新会话', A]] as const) {
    it(`被移除：一发现就删；清库期间别的标签页登录了${label}（s2）：清完、回登录页都不删它`, async () => {
      seed('s1');
      const { exit, gate } = realExit();
      const api = fakeApi({ loadDevices: vi.fn(async () => fail('revoked')) });
      render(<SettingsPage deps={{ api, exit, now }} />);
      const dlg = await screen.findByRole('dialog');
      expect(readSessionUserId()).toBeNull();   // 发现被移除的同一刻就删了，清库还没完
      expect(api.dropLocalSession).toHaveBeenCalledWith('s1');   // signOut 紧接着放后台，它的兜底也只删 s1
      seed('s2', user);
      await act(async () => {
        gate.resolve();
      });
      const go = within(dlg).getByTestId('settings-revoked-go') as HTMLButtonElement;
      await waitFor(() => expect(go.disabled).toBe(false));
      await act(async () => {
        fireEvent.click(go);
      });
      await waitFor(() => expect(exit.goToAuth).toHaveBeenCalledTimes(1));
      expect(readSessionUserId()).toBe(user);
    });
  }

  it('被移除：清库期间旧会话 s1 被晚到的令牌刷新写回：清完再删一次', async () => {
    seed('s1');
    const { exit, gate } = realExit();
    const api = fakeApi({ loadDevices: vi.fn(async () => fail('revoked')) });
    render(<SettingsPage deps={{ api, exit, now }} />);
    await screen.findByRole('dialog');
    seed('s1');
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(exit.deleteDb).toHaveBeenCalled());
    expect(readSessionUserId()).toBeNull();
  });

  it('自己退出、服务器没退成：兜底删会话、跳登录页前再删都只删退出前那一个；退出期间别的标签页登录的新会话不删', async () => {
    seed('s1');
    const { exit, gate } = realExit();
    const api = fakeApi({ dropLocalSession: vi.fn(async () => ({ serverDone: false })) });
    await renderPage(api, exit);
    await clickSignOut();
    await waitFor(() => expect(exit.wipe).toHaveBeenCalled());
    seed('s2', B);   // 退出那几秒：别的标签页登录了 B
    await act(async () => {
      gate.resolve();
    });
    const dlg = await screen.findByRole('dialog');
    expect(text(dlg)).toContain(zh['settings.offlineOut.body']);
    expect(api.dropLocalSession).toHaveBeenCalledWith('s1');
    expect(readSessionUserId()).toBe(B);
    await act(async () => {
      fireEvent.click(within(dlg).getByRole('button', { name: zh['settings.revoked.go'] }));
    });
    await waitFor(() => expect(exit.goToAuth).toHaveBeenCalledTimes(1));
    expect(readSessionUserId()).toBe(B);
  });

  it('对照：自己退出、服务器没退成、没有别的标签页登录：退出前那个会话照样删掉', async () => {
    seed('s1');
    const { exit, gate } = realExit();
    gate.resolve();
    const api = fakeApi({ dropLocalSession: vi.fn(async () => ({ serverDone: false })) });
    await renderPage(api, exit);
    await clickSignOut();
    await screen.findByText(zh['settings.offlineOut.body']);
    expect(readSessionUserId()).toBeNull();
  });
});
