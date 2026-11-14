// 设置页本人退出时删本机会话只删本页那一个（接手清单 K6-sugg3 ①；从 exit.test.tsx 拆出来）。会话不认那一路交给 exitDevice，不在这里
// 会话两步用真的（platform/sign-out.ts 的 defaultExitSteps → session.ts 的 clearLocalSessionIf / readSessionId），
// 清库卡在 gate 上（= 清库那几秒）时别的标签页登录了新会话，看最后本机会话还在不在
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { readSessionUserId, resetSelfSignOutForTest } from '../../../platform/session.ts';
import { defaultExitSteps } from '../../../platform/sign-out.ts';
import { zh } from '../i18n/zh.ts';
import { clickSignOut, deferred, fakeApi, fakeExit, renderPage, text } from './fakes.tsx';

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
    exit.clearLocalSessionIf.mockImplementation((sid: string | null) => defaultExitSteps.clearLocalSessionIf(sid));
    exit.readSessionId.mockImplementation(() => defaultExitSteps.readSessionId());
    return { exit, order, gate };
  }

  it('自己退出、服务器没退成：兜底删会话、跳登录页前再删都只删退出前那一个；退出期间别的标签页登录的新会话不删', async () => {
    seed('s1');
    // ④ 前会话已换成 s2：改用旧令牌直接 logout（复审建议 1：不真的发相对路径请求）；旧令牌过期，401 = 服务器没退成
    const fetchFn = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchFn);
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
    expect(api.dropLocalSession).not.toHaveBeenCalled();   // ④ 前会话已换成 s2：不调 supabase-js，改用旧令牌直接 logout（R-257）
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain('/auth/v1/logout?scope=local');
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${tok('s1')}`);   // 带的是旧令牌
    expect(readSessionUserId()).toBe(B);
    await act(async () => {
      fireEvent.click(within(dlg).getByRole('button', { name: zh['settings.revoked.go'] }));
    });
    await waitFor(() => expect(exit.goToAuth).toHaveBeenCalledTimes(1));
    expect(readSessionUserId()).toBe(B);
    vi.unstubAllGlobals();
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
