// 登录页·登录部分（架构 5.6、5.9；TC-B1-17；线框 s14 和“加载与出错”）：iPhone 拦截、已有用户验证码登录、两种限频、语言
// 邀请注册在 AuthPage.invite.test.tsx，已登录先退出在 AuthPage.session.test.tsx；共用的假接口和渲染在 auth-page-harness.tsx，假 Turnstile 在 turnstile-fake.ts
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import AuthPage from '../ui/AuthPage.tsx';
import { fakeApi, renderPage, resetHarness, time, typeEmailAndSend } from './auth-page-harness.tsx';
import { turnstile } from './turnstile-fake.ts';

vi.mock('../../../platform/turnstile.ts', async () => (await import('./turnstile-fake.ts')).fakeTurnstileModule);

beforeEach(resetHarness);
afterEach(cleanup);

describe('iPhone / iPad 非主屏幕拦截（TC-B1-17、R-225）', () => {
  it('iOS Safari 非主屏幕：只显示“添加到主屏幕”教程，没有邮箱框，也不加载 Turnstile；不提示换 Safari', () => {
    render(<AuthPage gate="install" />);
    expect(screen.getByTestId('auth-install-guide')).toBeTruthy();
    expect(screen.getByText(zh['auth.ios.step2'])).toBeTruthy();
    expect(screen.queryByLabelText(zh['auth.email.label'])).toBeNull();
    expect(screen.queryByTestId('auth-open-in-safari')).toBeNull();
    // 安全审查低 3：照顾 Gmail 这类 App 里内嵌的 SFSafariViewController（UA 和 Safari 一样）
    expect(screen.getByText(zh['auth.ios.noShare'])).toBeTruthy();
    expect(turnstile.mounted).toBe(0);
  });

  it('iOS 上别的浏览器（Chrome、KakaoTalk、微信）：同样只给教程，另加一句“请在 Safari 里打开本页”', () => {
    render(<AuthPage gate="install-safari" />);
    expect(screen.getByTestId('auth-install-guide')).toBeTruthy();
    expect(screen.getByTestId('auth-open-in-safari').textContent).toBe(zh['auth.ios.openInSafari']);
    expect(screen.queryByLabelText(zh['auth.email.label'])).toBeNull();
    expect(turnstile.mounted).toBe(0);
  });
});

describe('已有用户：邮箱验证码登录', () => {
  it('发码带 Turnstile 令牌 → 填满 6 位自动校验 → 跳回 App', async () => {
    const api = fakeApi();
    const onDone = await renderPage(api);
    await typeEmailAndSend(' me@example.com ');
    expect(api.sendCode).toHaveBeenCalledWith('me@example.com', 'tok-1');
    expect(screen.getByText(zh['auth.code.sentTo'].replace('{email}', 'me@example.com'))).toBeTruthy();
    // 刚发过：60 秒倒计时
    expect(screen.getByRole('button', { name: zh['auth.code.resendIn'].replace('{s}', '60') })).toHaveProperty('disabled', true);
    await act(async () => {
      fireEvent.change(screen.getByLabelText(zh['auth.code.label']), { target: { value: '12 3456' } });
    });
    expect(api.verifyCode).toHaveBeenCalledWith('me@example.com', '123456');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.getByText(zh['auth.done'])).toBeTruthy();
  });

  it('填不满 6 位不提交', async () => {
    const api = fakeApi();
    await renderPage(api);
    await typeEmailAndSend('me@example.com');
    fireEvent.change(screen.getByLabelText(zh['auth.code.label']), { target: { value: '12345' } });
    expect(api.verifyCode).not.toHaveBeenCalled();
  });

  it('邮箱格式不对：提示，不发码', async () => {
    const api = fakeApi();
    await renderPage(api);
    await typeEmailAndSend('me@');
    expect(screen.getByTestId('auth-hint').textContent).toBe(zh['auth.email.invalid']);
    expect(api.sendCode).not.toHaveBeenCalled();
  });

  it('人机验证还没给令牌：提示等一下，不发码（TC-B1-09：不带令牌不调登录）', async () => {
    turnstile.auto = false;
    const api = fakeApi();
    await renderPage(api);
    await typeEmailAndSend('me@example.com');
    expect(screen.getByTestId('auth-hint').textContent).toBe(zh['auth.captcha.wait']);
    expect(api.sendCode).not.toHaveBeenCalled();
  });

  it('验证码不对：出“验证码不对”卡片，“重新输入”清空', async () => {
    const api = fakeApi({ verifyCode: vi.fn(async () => ({ ok: false as const, error: 'code_invalid' as const })) });
    await renderPage(api);
    await typeEmailAndSend('me@example.com');
    await act(async () => {
      fireEvent.change(screen.getByLabelText(zh['auth.code.label']), { target: { value: '000000' } });
    });
    const card = screen.getByTestId('auth-error');
    expect(card.dataset['error']).toBe('code_wrong');
    expect(card.textContent).toContain(zh['auth.err.codeWrong.title']);
    fireEvent.click(screen.getByRole('button', { name: zh['auth.err.retry'] }));
    expect(screen.queryByTestId('auth-error')).toBeNull();
    expect((screen.getByLabelText(zh['auth.code.label']) as HTMLInputElement).value).toBe('');
  });

  it('超过 10 分钟再填：出“验证码过期了”卡片，按钮是“重新发送”', async () => {
    const api = fakeApi({ verifyCode: vi.fn(async () => ({ ok: false as const, error: 'code_invalid' as const })) });
    await renderPage(api);
    await typeEmailAndSend('me@example.com');
    time.clock += 600_000;
    await act(async () => {
      fireEvent.change(screen.getByLabelText(zh['auth.code.label']), { target: { value: '000000' } });
    });
    expect(screen.getByTestId('auth-error').dataset['error']).toBe('code_expired');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['auth.err.resend'] }));
    });
    expect(api.sendCode).toHaveBeenCalledTimes(2);
    expect(api.sendCode).toHaveBeenLastCalledWith('me@example.com', 'tok-2');
  });

  it('发得太频繁：出卡片，发送按钮变成倒计时、不可点', async () => {
    const api = fakeApi({ sendCode: vi.fn(async () => ({ ok: false as const, error: 'rate_limited' as const })) });
    await renderPage(api);
    await typeEmailAndSend('me@example.com');
    expect(screen.getByTestId('auth-error').dataset['error']).toBe('rate_limited');
    expect(screen.getByRole('button', { name: zh['auth.code.resendIn'].replace('{s}', '60') })).toHaveProperty('disabled', true);
  });

  it('发得太频繁：倒计时用服务器原文里的 N 秒（K4 复审低 3）', async () => {
    const api = fakeApi({ sendCode: vi.fn(async () => ({ ok: false as const, error: 'rate_limited' as const, waitS: 23 })) });
    await renderPage(api);
    await typeEmailAndSend('me@example.com');
    expect(screen.getByRole('button', { name: zh['auth.code.resendIn'].replace('{s}', '23') })).toHaveProperty('disabled', true);
  });
});

describe('两种限频分开（安全审查必改 2）', () => {
  it('全站发信额度用完：出“现在发码的人太多”卡片，不倒计时、按钮照常可点', async () => {
    const api = fakeApi({ sendCode: vi.fn(async () => ({ ok: false as const, error: 'send_quota' as const })) });
    await renderPage(api);
    await typeEmailAndSend('me@example.com');
    const card = screen.getByTestId('auth-error');
    expect(card.dataset['error']).toBe('send_quota');
    expect(card.textContent).toContain(zh['auth.err.sendQuota.title']);
    expect(card.textContent).toContain(zh['auth.err.sendQuota.body']);
    expect(card.textContent).not.toContain('60');
    expect(screen.getByRole('button', { name: zh['auth.email.send'] })).toHaveProperty('disabled', false);
  });

  it('“请 60 秒后再发”只出现在同一邮箱限频那一张卡片上', () => {
    const others = Object.entries(zh).filter(([k]) => k !== 'auth.err.rateLimited.body');
    expect(zh['auth.err.rateLimited.body']).toContain('60 秒');
    expect(others.filter(([, v]) => v.includes('60 秒')).map(([k]) => k)).toEqual([]);
  });
});

describe('语言', () => {
  it('韩文界面用韩文词典（K4 先放中文占位，TODO）', async () => {
    uiStore.getState().setLocale('ko-KR');
    await renderPage(fakeApi());
    expect(screen.getByRole('heading').textContent).toBe(ko['auth.title']);
  });
});
