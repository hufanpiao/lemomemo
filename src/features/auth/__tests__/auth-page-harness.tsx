// 登录页测试的共用部分（AuthPage.test.tsx、AuthPage.invite.test.tsx）：假接口、可拨的时钟、渲染和常用输入
// 每个测试文件自己 vi.mock 平台的 turnstile.ts（见 turnstile-fake.ts），再在 beforeEach 里调 resetHarness()
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type { AccountGateApi } from '../data/account-gate.ts';
import type { AuthApi } from '../data/auth-api.ts';
import { zh } from '../i18n/zh.ts';
import AuthPage from '../ui/AuthPage.tsx';
import { resetTurnstileFake, turnstile } from './turnstile-fake.ts';

export type FakeApi = AuthApi & Record<keyof AuthApi, ReturnType<typeof vi.fn>>;

export function fakeApi(over: Partial<AuthApi> = {}): FakeApi {
  const ok = { ok: true as const, value: undefined };
  return {
    sendCode: vi.fn(async () => ok),
    verifyCode: vi.fn(async () => ok),
    inviteStart: vi.fn(async () => ok),
    inviteVerify: vi.fn(async () => ok),
    signOutHere: vi.fn(async () => ok),
    ...over,
  } as FakeApi;
}

export type FakeAccount = AccountGateApi & Record<keyof AccountGateApi, ReturnType<typeof vi.fn>>;

/** 假的 account（status、restore、signOut local）；默认 status 回 active，不挡登录 */
export function fakeAccount(over: Partial<AccountGateApi> = {}): FakeAccount {
  return {
    status: vi.fn(async () => ({ kind: 'active' as const })),
    restore: vi.fn(async () => ({ ok: true as const })),
    signOutLocal: vi.fn(async () => true),
    ...over,
  } as FakeAccount;
}

/** 测试里的“现在”：用例里直接改 time.clock 拨时间 */
export const time = { clock: 1_000_000 };
export const now = () => time.clock;

export function resetHarness(): void {
  resetTurnstileFake();
  time.clock = 1_000_000;
  uiStore.getState().setLocale('zh-CN');
}

export async function renderPage(api: AuthApi, onDone = vi.fn(), account: AccountGateApi = fakeAccount()) {
  render(<AuthPage gate="login" deps={{ api, now, onDone, account }} />);
  await waitFor(() => expect(turnstile.mounted).toBe(1));
  return onDone;
}

export async function typeEmailAndSend(email: string) {
  fireEvent.change(screen.getByLabelText(zh['auth.email.label']), { target: { value: email } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: zh['auth.email.send'] }));
  });
}

/** 新邮箱走到邀请验证码那一屏并填满 6 位 */
export async function toInviteCode(api: AuthApi) {
  await typeEmailAndSend('new@example.com');
  fireEvent.change(screen.getByLabelText(zh['auth.invite.label']), { target: { value: 'ABCDEFGHJKMN' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: zh['auth.invite.next'] }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText(zh['auth.code.label']), { target: { value: '654321' } });
  });
  return api;
}

/** 恢复页测试共用：记下本机清理每一步（readSessionId 固定回 s1） */
export function exitSpy(log: string[]) {
  return {
    clearLocalSessionIf: vi.fn((sid: string | null) => void log.push(`clearLocalSessionIf:${sid}`)),
    readSessionId: () => 's1',
    deleteDb: vi.fn(async () => {
      log.push('deleteDb');
      return 'deleted' as const;
    }),
    clearCacheStorage: vi.fn(async () => void log.push('clearCacheStorage')),
  };
}

/** 恢复页测试共用：渲染登录表单、填邮箱、填满 6 位验证码 */
export async function loginWith(account: AccountGateApi, log: string[] = []) {
  const api = fakeApi();
  const onDone = vi.fn(() => void log.push('onDone'));
  const localExit = exitSpy(log);
  render(<AuthPage gate="login" deps={{ api, now, onDone, account, localExit }} />);
  await typeEmailAndSend('me@example.com');
  await act(async () => {
    fireEvent.change(screen.getByLabelText(zh['auth.code.label']), { target: { value: '123456' } });
  });
  return { api, onDone, localExit };
}
