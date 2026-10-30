// 登录页·邀请码注册部分（架构 5.6、0.38 第 20、27、30 条；TC-B1-62）：start → 验证码 → verify，各种出错回到哪一屏
// 登录部分在 AuthPage.test.tsx；共用的假接口和渲染在 auth-page-harness.tsx，假 Turnstile 在 turnstile-fake.ts
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../i18n/zh.ts';
import { fakeApi, renderPage, resetHarness, toInviteCode, typeEmailAndSend } from './auth-page-harness.tsx';
import { turnstile } from './turnstile-fake.ts';

vi.mock('../../../platform/turnstile.ts', async () => (await import('./turnstile-fake.ts')).fakeTurnstileModule);

beforeEach(resetHarness);
afterEach(cleanup);

describe('新邮箱：邀请码注册（TC-B1-62、5.6）', () => {
  it('账号建好了但换不到会话：回邮箱那一屏（邮箱保留），提示“注册成功，请用邮箱验证码登录”', async () => {
    const api = fakeApi({
      sendCode: vi.fn(async () => ({ ok: false as const, error: 'not_registered' as const })),
      inviteVerify: vi.fn(async () => ({ ok: false as const, error: 'registered_login' as const })),
    });
    const onDone = await renderPage(api);
    await typeEmailAndSend('new@example.com');
    fireEvent.change(screen.getByLabelText(zh['auth.invite.label']), { target: { value: 'ABCDEFGHJKMN' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.invite.next'] }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(zh['auth.code.label']), { target: { value: '654321' } });
    });
    const card = screen.getByTestId('auth-error');
    expect(card.dataset['error']).toBe('registered_login');
    expect(card.textContent).toContain(zh['auth.err.registeredLogin.title']);
    expect(card.textContent).toContain(zh['auth.err.registeredLogin.body']);
    expect((screen.getByLabelText(zh['auth.email.label']) as HTMLInputElement).value).toBe('new@example.com');
    expect(screen.queryByLabelText(zh['auth.invite.label'])).toBeNull();
    // 刚发过邀请验证码，60 秒倒计时还在：按钮显示倒计时，走完才变回“发验证码”
    expect(screen.getByRole('button', { name: zh['auth.code.resendIn'].replace('{s}', '60') })).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('还没注册 → 显示提示和邀请码框 → start → 验证码 → verify → 跳回 App', async () => {
    const api = fakeApi({ sendCode: vi.fn(async () => ({ ok: false as const, error: 'not_registered' as const })) });
    const onDone = await renderPage(api);
    await typeEmailAndSend('new@example.com');
    expect(screen.getByTestId('auth-not-registered').textContent).toBe(zh['auth.invite.notRegistered']);
    expect(screen.getByText(zh['auth.invite.noCode'])).toBeTruthy();
    expect(screen.queryByTestId('auth-error')).toBeNull();

    fireEvent.change(screen.getByLabelText(zh['auth.invite.label']), { target: { value: 'abcd-efgh-jkmn' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.invite.next'] }));
    });
    // 进邀请那一屏，小窗按 action 'invite_start' 重画（安全审查 10、架构 0.38 第 30 条），用的是重画以后的令牌
    expect(turnstile.actions).toEqual(['login', 'invite_start']);
    expect(api.inviteStart).toHaveBeenCalledWith({ email: 'new@example.com', code: 'ABCDEFGHJKMN', captchaToken: 'tok-3', locale: 'zh-CN' });
    expect(screen.getByText(zh['auth.invite.sent'])).toBeTruthy();
    // 0.38 第 27 条：start 限流、码错、发信失败都回 {ok}，只能提示没收到怎么办
    expect(screen.getByText(zh['auth.invite.noMail'])).toBeTruthy();
    // 负责人 10-30 定（明早清单第 26 条）：没收到时先提醒看垃圾邮件
    expect(zh['auth.invite.noMail']).toContain('垃圾邮件');
    // 邀请这一屏已经有上面那句，不再叠加老邮箱那行小字
    expect(screen.queryByTestId('auth-code-spam')).toBeNull();

    await act(async () => {
      fireEvent.change(screen.getByLabelText(zh['auth.code.label']), { target: { value: '654321' } });
    });
    expect(api.inviteVerify).toHaveBeenCalledWith({ email: 'new@example.com', code: 'ABCDEFGHJKMN', emailOtp: '654321', locale: 'zh-CN' });
    expect(api.verifyCode).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('邀请码位数不对：提示，不调函数', async () => {
    const api = fakeApi({ sendCode: vi.fn(async () => ({ ok: false as const, error: 'not_registered' as const })) });
    await renderPage(api);
    await typeEmailAndSend('new@example.com');
    fireEvent.change(screen.getByLabelText(zh['auth.invite.label']), { target: { value: 'ABC' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.invite.next'] }));
    });
    expect(screen.getByTestId('auth-hint').textContent).toBe(zh['auth.invite.format']);
    expect(api.inviteStart).not.toHaveBeenCalled();
  });

  it('输进 0、1、I、O：输入框下当场提示，不自动替换；改对以后提示消失（10-30 预览注册事故）', async () => {
    const api = fakeApi({ sendCode: vi.fn(async () => ({ ok: false as const, error: 'not_registered' as const })) });
    await renderPage(api);
    await typeEmailAndSend('new@example.com');
    const box = screen.getByLabelText(zh['auth.invite.label']) as HTMLInputElement;
    // 读屏（审查建议 1）：提示区一直挂着 role="status"，平时是空的，只换里面的文字；输入框 aria-describedby 指向它
    const tip = screen.getByTestId('auth-invite-confusable');
    expect(tip.getAttribute('role')).toBe('status');
    expect(tip.textContent).toBe('');
    expect(box.getAttribute('aria-describedby')?.split(' ')).toContain(tip.id);
    expect(box.getAttribute('aria-invalid')).toBeNull();
    fireEvent.change(box, { target: { value: 'ABCD-EFGH-JK0' } });
    expect(screen.getByTestId('auth-invite-confusable')).toBe(tip);
    expect(tip.textContent).toBe('邀请码里没有 0、1、I、O，请再看一眼');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.value).toBe('ABCD-EFGH-JK0');
    expect(box.compareDocumentPosition(tip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(box, { target: { value: 'ABCD-EFGH-JKMN' } });
    expect(tip.textContent).toBe('');
    expect(box.getAttribute('aria-invalid')).toBeNull();
  });

  it('含 O 的 12 位码点“下一步”：不调函数，只显示易混提示一句，不再叠格式提示（审查建议 3）', async () => {
    const api = fakeApi({ sendCode: vi.fn(async () => ({ ok: false as const, error: 'not_registered' as const })) });
    await renderPage(api);
    await typeEmailAndSend('new@example.com');
    fireEvent.change(screen.getByLabelText(zh['auth.invite.label']), { target: { value: 'ABCDEFGHJKON' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.invite.next'] }));
    });
    expect(screen.queryByTestId('auth-hint')).toBeNull();
    expect(screen.getByTestId('auth-invite-confusable').textContent).toBe(zh['auth.invite.confusable']);
    expect(api.inviteStart).not.toHaveBeenCalled();
  });

  it('位数不对的格式提示写明不含 0、1、I、O（审查建议 3）', () => {
    expect(zh['auth.invite.format']).toBe('邀请码是 12 位字母和数字，不含 0、1、I、O');
  });

  it('邀请码用不了（verify 时才知道）：出卡片，“重新输入”回到邀请码那一屏', async () => {
    const api = fakeApi({
      sendCode: vi.fn(async () => ({ ok: false as const, error: 'not_registered' as const })),
      inviteVerify: vi.fn(async () => ({ ok: false as const, error: 'invite_invalid' as const })),
    });
    await renderPage(api);
    await typeEmailAndSend('new@example.com');
    fireEvent.change(screen.getByLabelText(zh['auth.invite.label']), { target: { value: 'ABCDEFGHJKMN' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.invite.next'] }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(zh['auth.code.label']), { target: { value: '654321' } });
    });
    expect(screen.getByTestId('auth-error').dataset['error']).toBe('invite_invalid');
    fireEvent.click(screen.getByRole('button', { name: zh['auth.err.retry'] }));
    expect((screen.getByLabelText(zh['auth.invite.label']) as HTMLInputElement).value).toBe('');
  });
});

describe('邀请注册的出错口径（架构 5.6、0.38 第 20、27 条）', () => {
  const notReg = { sendCode: vi.fn(async () => ({ ok: false as const, error: 'not_registered' as const })) };

  for (const [err, title, body] of [
    ['email_exists', 'auth.err.emailExists.title', 'auth.err.emailExists.body'],
    ['too_many_tries', 'auth.err.tooManyTries.title', 'auth.err.tooManyTries.body'],
  ] as const) {
    it(`${err}：回到填邮箱那一屏（邮箱保留、邀请码清空），出卡片`, async () => {
      const api = fakeApi({ ...notReg, inviteVerify: vi.fn(async () => ({ ok: false as const, error: err })) });
      const onDone = await renderPage(api);
      await toInviteCode(api);
      const main = document.querySelector('main[data-feature="auth"]') as HTMLElement;
      expect(main.dataset['step']).toBe('email');
      const card = screen.getByTestId('auth-error');
      expect(card.dataset['error']).toBe(err);
      expect(card.textContent).toContain(zh[title]);
      expect(card.textContent).toContain(zh[body]);
      expect((screen.getByLabelText(zh['auth.email.label']) as HTMLInputElement).value).toBe('new@example.com');
      expect(screen.queryByLabelText(zh['auth.invite.label'])).toBeNull();
      expect(onDone).not.toHaveBeenCalled();
    });
  }

  it('try_later：出“服务暂时不通”，“重新输入”后留在验证码这一屏可以再试', async () => {
    const inviteVerify = vi.fn().mockResolvedValueOnce({ ok: false as const, error: 'try_later' as const }).mockResolvedValue({ ok: true as const, value: undefined });
    const api = fakeApi({ ...notReg, inviteVerify });
    const onDone = await renderPage(api);
    await toInviteCode(api);
    const card = screen.getByTestId('auth-error');
    expect(card.dataset['error']).toBe('try_later');
    expect(card.textContent).toContain(zh['auth.err.tryLater.title']);
    fireEvent.click(screen.getByRole('button', { name: zh['auth.err.retry'] }));
    expect(screen.queryByTestId('auth-error')).toBeNull();
    await act(async () => {
      fireEvent.change(screen.getByLabelText(zh['auth.code.label']), { target: { value: '65432' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(zh['auth.code.label']), { target: { value: '654321' } });
    });
    expect(inviteVerify).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('start 回 try_later：出“服务暂时不通”，留在邀请码那一屏', async () => {
    const api = fakeApi({ ...notReg, inviteStart: vi.fn(async () => ({ ok: false as const, error: 'try_later' as const })) });
    await renderPage(api);
    await typeEmailAndSend('new@example.com');
    fireEvent.change(screen.getByLabelText(zh['auth.invite.label']), { target: { value: 'ABCDEFGHJKMN' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.invite.next'] }));
    });
    expect(screen.getByTestId('auth-error').dataset['error']).toBe('try_later');
    expect(screen.getByLabelText(zh['auth.invite.label'])).toBeTruthy();
  });

  it('verify 被限流（429）：出“试得太频繁”，不说“60 秒”、不倒计时', async () => {
    const api = fakeApi({ ...notReg, inviteVerify: vi.fn(async () => ({ ok: false as const, error: 'verify_limited' as const })) });
    await renderPage(api);
    await toInviteCode(api);
    const card = screen.getByTestId('auth-error');
    expect(card.dataset['error']).toBe('verify_limited');
    expect(card.textContent).toContain(zh['auth.err.verifyLimited.title']);
    expect(card.textContent).not.toContain('60');
  });
});
