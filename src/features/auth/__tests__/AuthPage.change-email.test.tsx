// 登录页“换一个邮箱”（负责人 10-30 17:35 iPhone 主屏幕版：“邮箱输错以后无法修改，要重新打开”）：
// 邀请码那一步、验证码那一步点“换一个邮箱”都回到填邮箱那一步，邮箱框能改、保留原值；邀请码清空；人机验证按 login 重新出令牌。
// 邀请码那一步直接点邮箱框改字，也回到填邮箱那一步，按“发验证码”重新查注册状态
import { act, cleanup, fireEvent, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthFlow } from '../hooks/useAuthFlow.ts';
import { zh } from '../i18n/zh.ts';
import { fakeApi, renderPage, resetHarness, typeEmailAndSend } from './auth-page-harness.tsx';
import { turnstile } from './turnstile-fake.ts';

vi.mock('../../../platform/turnstile.ts', async () => (await import('./turnstile-fake.ts')).fakeTurnstileModule);

beforeEach(resetHarness);
afterEach(cleanup);

const emailBox = (): HTMLInputElement => screen.getByLabelText(zh['auth.email.label']) as HTMLInputElement;
const notRegisteredFirst = () =>
  vi.fn(async (email: string) => (email === 'hufanp@gamil.com' ? { ok: false as const, error: 'not_registered' as const } : { ok: true as const, value: undefined }));

async function send(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: zh['auth.email.send'] }));
  });
}

describe('换一个邮箱', () => {
  it('邀请码那一步点“换一个邮箱”：回填邮箱那一步，邮箱框能改、保留原值，邀请码清空；改对了按“发验证码”重新查注册', async () => {
    const api = fakeApi({ sendCode: notRegisteredFirst() });
    await renderPage(api);
    await typeEmailAndSend('hufanp@gamil.com');
    expect(screen.getByTestId('auth-not-registered')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(zh['auth.invite.label']), { target: { value: 'ABCD' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.code.changeEmail'] }));
    });
    expect(screen.queryByTestId('auth-not-registered')).toBeNull();
    expect(screen.queryByLabelText(zh['auth.invite.label'])).toBeNull();
    expect(emailBox().readOnly).toBe(false);
    expect(emailBox().value).toBe('hufanp@gamil.com');
    fireEvent.change(emailBox(), { target: { value: 'hufanp@gmail.com' } });
    await send();
    expect(api.sendCode).toHaveBeenLastCalledWith('hufanp@gmail.com', expect.any(String));
    expect(screen.getByLabelText(zh['auth.code.label'])).toBeTruthy();
    // 回到登录：小窗按 action 'login' 重画、给新令牌
    expect(turnstile.actions.at(-1)).toBe('login');
  });

  it('邀请码那一步直接点邮箱框改字：邮箱框能改，改了就回填邮箱那一步（邀请码框收起、清空），按“发验证码”重新查注册', async () => {
    const api = fakeApi({ sendCode: notRegisteredFirst() });
    await renderPage(api);
    await typeEmailAndSend('hufanp@gamil.com');
    expect(emailBox().readOnly).toBe(false);
    fireEvent.change(screen.getByLabelText(zh['auth.invite.label']), { target: { value: 'ABCD' } });
    fireEvent.change(emailBox(), { target: { value: 'hufanp@gmail.com' } });
    expect(screen.queryByTestId('auth-not-registered')).toBeNull();
    expect(screen.queryByLabelText(zh['auth.invite.label'])).toBeNull();
    expect(emailBox().value).toBe('hufanp@gmail.com');
    await send();
    expect(api.sendCode).toHaveBeenLastCalledWith('hufanp@gmail.com', expect.any(String));
  });

  it('验证码那一步点“换一个邮箱”：回填邮箱那一步，邮箱框能改、保留原值', async () => {
    const api = fakeApi();
    await renderPage(api);
    await typeEmailAndSend('a@example.com');
    expect(screen.getByLabelText(zh['auth.code.label'])).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.code.changeEmail'] }));
    });
    expect(emailBox().readOnly).toBe(false);
    expect(emailBox().value).toBe('a@example.com');
  });

  // 审查必改（10-30）：请求还在路上就改邮箱，旧请求回来的结果整个丢掉
  function hold<T>() {
    let release: (v: T) => void = () => undefined;
    const p = new Promise<T>((r) => (release = r));
    return { p, release: (v: T) => release(v) };
  }

  it('邀请码那一步按“下一步”、inviteStart 还没回来就改邮箱：回第一步；旧请求回来 ok 也不进验证码那一步、不开始倒计时', async () => {
    const started = hold<{ ok: true; value: undefined }>();
    const api = fakeApi({ sendCode: notRegisteredFirst(), inviteStart: vi.fn(() => started.p) });
    await renderPage(api);
    await typeEmailAndSend('hufanp@gamil.com');
    fireEvent.change(screen.getByLabelText(zh['auth.invite.label']), { target: { value: 'ABCDEFGHJKMN' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.invite.next'] }));
    });
    expect(api.inviteStart).toHaveBeenCalledTimes(1);
    fireEvent.change(emailBox(), { target: { value: 'hufanp@gmail.com' } });
    await act(async () => {
      started.release({ ok: true, value: undefined });
    });
    expect(screen.queryByLabelText(zh['auth.code.label'])).toBeNull();
    expect(screen.queryByText(zh['auth.invite.sent'])).toBeNull();
    expect(emailBox().value).toBe('hufanp@gmail.com');
    // 没开始倒计时：按钮还是“发验证码”、能按
    const btn = screen.getByRole('button', { name: zh['auth.email.send'] }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('同上，点“换一个邮箱”而不是直接改字：旧请求回来照样丢掉', async () => {
    const started = hold<{ ok: true; value: undefined }>();
    const api = fakeApi({ sendCode: notRegisteredFirst(), inviteStart: vi.fn(() => started.p) });
    await renderPage(api);
    await typeEmailAndSend('hufanp@gamil.com');
    fireEvent.change(screen.getByLabelText(zh['auth.invite.label']), { target: { value: 'ABCDEFGHJKMN' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.invite.next'] }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.code.changeEmail'] }));
    });
    await act(async () => {
      started.release({ ok: true, value: undefined });
    });
    expect(screen.queryByLabelText(zh['auth.code.label'])).toBeNull();
    expect((screen.getByRole('button', { name: zh['auth.email.send'] }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('第一步 sendCode 还没回来就改邮箱：回来的“还没注册”不显示在新邮箱上，也不进验证码那一步、不开始倒计时', async () => {
    for (const result of [{ ok: false as const, error: 'not_registered' as const }, { ok: true as const, value: undefined }]) {
      cleanup();
      resetHarness();
      const sent = hold<typeof result>();
      const api = fakeApi({ sendCode: vi.fn(() => sent.p) });
      await renderPage(api);
      await typeEmailAndSend('hufanp@gamil.com');
      expect(api.sendCode).toHaveBeenCalledTimes(1);
      fireEvent.change(emailBox(), { target: { value: 'hufanp@gmail.com' } });
      await act(async () => {
        sent.release(result);
      });
      expect(screen.queryByTestId('auth-not-registered')).toBeNull();
      expect(screen.queryByLabelText(zh['auth.code.label'])).toBeNull();
      expect(emailBox().value).toBe('hufanp@gmail.com');
      expect((screen.getByRole('button', { name: zh['auth.email.send'] }) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  // 复审必改（10-30）：校验成功时 Supabase 已把会话写进本机，校验途中不能换邮箱；万一换了，成功的结果也照常进 App
  it('验证码那一步校验还没回来：“换一个邮箱”是灰的（和验证码框一样）', async () => {
    const checking = hold<{ ok: true; value: undefined }>();
    const api = fakeApi({ verifyCode: vi.fn(() => checking.p) });
    await renderPage(api);
    await typeEmailAndSend('a@example.com');
    await act(async () => {
      fireEvent.change(screen.getByLabelText(zh['auth.code.label']), { target: { value: '123456' } });
    });
    expect(api.verifyCode).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: zh['auth.code.changeEmail'] }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(zh['auth.code.label']) as HTMLInputElement).disabled).toBe(true);
    await act(async () => {
      checking.release({ ok: true, value: undefined });
    });
  });

  it('双保险：校验途中被作废（直接调 backToEmail）后，校验回来 ok 仍照常进 App；回来失败才丢掉', async () => {
    const captcha = { ready: true, failed: false, take: () => 'tok' };
    for (const ok of [true, false]) {
      const checking = hold<{ ok: true; value: undefined } | { ok: false; error: 'code_wrong' }>();
      const api = fakeApi({ verifyCode: vi.fn(() => checking.p) });
      const onDone = vi.fn();
      const { result } = renderHook(() => useAuthFlow(captcha, { api, onDone, now: () => 1_000_000 }));
      act(() => result.current.setEmail('a@example.com'));
      await act(async () => {
        await result.current.sendCode();
      });
      expect(result.current.state.step).toBe('code');
      act(() => result.current.setCode('123456'));
      act(() => result.current.backToEmail());
      await act(async () => {
        checking.release(ok ? { ok: true, value: undefined } : { ok: false, error: 'code_wrong' });
      });
      if (ok) {
        expect(onDone).toHaveBeenCalledTimes(1);
        expect(result.current.state.step).toBe('done');
      } else {
        expect(onDone).not.toHaveBeenCalled();
        expect(result.current.state.step).toBe('email');
        expect(result.current.state.error).toBeNull();
      }
    }
  });
});
