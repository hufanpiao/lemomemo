// 登录页测试的共用部分（AuthPage.test.tsx、AuthPage.invite.test.tsx）：假接口、可拨的时钟、渲染和常用输入
// 每个测试文件自己 vi.mock 平台的 turnstile.ts（见 turnstile-fake.ts），再在 beforeEach 里调 resetHarness()
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
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

/** 测试里的“现在”：用例里直接改 time.clock 拨时间 */
export const time = { clock: 1_000_000 };
export const now = () => time.clock;

export function resetHarness(): void {
  resetTurnstileFake();
  time.clock = 1_000_000;
  uiStore.getState().setLocale('zh-CN');
}

export async function renderPage(api: AuthApi, onDone = vi.fn()) {
  render(<AuthPage gate="login" deps={{ api, now, onDone }} />);
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
