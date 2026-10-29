// 告知与同意页（架构 15.5、R-103、R-115、0.40 R-239、R-240；TC-B1-11）：清单和送出内容、默认不勾、两个按钮、确认后调 record_consent；
// 请求落定前保持忙碌、慢网提示；失败留在本页；no_policy 只给“继续使用”；会话被吊销交给 onRevoked；中韩切换
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type { ConsentApi, Result } from '../data/consent-api.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import ConsentPage from '../ui/ConsentPage.tsx';

function fakeApi(results: Result[] = [{ ok: true, value: undefined }]) {
  const calls: boolean[] = [];
  let i = 0;
  const api: ConsentApi = {
    record: vi.fn(async (agree: boolean): Promise<Result> => {
      calls.push(agree);
      return results[Math.min(i++, results.length - 1)] ?? { ok: true, value: undefined };
    }),
    noticeState: vi.fn(async () => ({ ok: true as const, value: 'first' as const })),
  };
  return { api, calls };
}

const handlers = () => ({ onDone: vi.fn(), onRevoked: vi.fn(), onDisabled: vi.fn(), onSkip: vi.fn() });
const checkbox = () => screen.getByRole('checkbox', { name: zh['consent.check'] }) as HTMLInputElement;
const agreeBtn = () => screen.getByRole('button', { name: zh['consent.agree'] }) as HTMLButtonElement;
const declineBtn = () => screen.getByRole('button', { name: zh['consent.decline'] }) as HTMLButtonElement;

beforeEach(() => { uiStore.getState().setLocale('zh-CN'); });
afterEach(cleanup);

describe('告知与同意页（TC-B1-11）', () => {
  it('视觉稿的六行清单（“图片和附件”带“新”标签）、R-115 句、条款句、会送出去的东西都在', () => {
    const { api } = fakeApi();
    render(<ConsentPage api={api} {...handlers()} />);
    const items = screen.getByTestId('consent-items').querySelectorAll('li');
    expect(items).toHaveLength(6);
    expect(items[2]?.textContent).toBe(`${zh['consent.item.media']}${zh['consent.newTag']}${zh['consent.item.media.d']}`);
    expect(screen.getByTestId('consent-privacy').textContent).toBe(zh['consent.privacy']);
    expect(screen.getByText(zh['consent.terms'])).toBeTruthy();
    const send = screen.getByTestId('consent-send').textContent ?? '';
    expect(send).toContain(zh['consent.send.body']);
    expect(send).toContain(zh['consent.send.msBody']);
    expect(send).toContain('证件照');
    expect(screen.getByText(zh['consent.declineNote'])).toBeTruthy();
  });

  it('勾选框默认不勾；没勾时“同意并继续”是 aria-disabled 并说明要先勾选，点了不提交；“先不同意，直接用”可以点（R-103、R-240）', () => {
    const { api } = fakeApi();
    render(<ConsentPage api={api} {...handlers()} />);
    expect(checkbox().checked).toBe(false);
    expect(agreeBtn().getAttribute('aria-disabled')).toBe('true');
    const hintId = agreeBtn().getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(hintId)?.textContent).toBe(zh['consent.needCheck']);
    expect(declineBtn().disabled).toBe(false);
    fireEvent.click(agreeBtn());
    expect(api.record).not.toHaveBeenCalled();
    fireEvent.click(checkbox());
    expect(agreeBtn().getAttribute('aria-disabled')).toBe('false');
    expect(agreeBtn().getAttribute('aria-describedby')).toBeNull();
  });

  it('勾上后点“同意并继续”：调 record_consent（同意），成功后 onDone(true)', async () => {
    const { api, calls } = fakeApi();
    const h = handlers();
    render(<ConsentPage api={api} {...h} />);
    fireEvent.click(checkbox());
    await act(async () => { fireEvent.click(agreeBtn()); });
    expect(calls).toEqual([true]);
    expect(h.onDone).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('不勾直接点“先不同意，直接用”：照样调 record_consent（不同意），onDone(false)', async () => {
    const { api, calls } = fakeApi();
    const h = handlers();
    render(<ConsentPage api={api} {...h} />);
    await act(async () => { fireEvent.click(declineBtn()); });
    expect(calls).toEqual([false]);
    expect(h.onDone).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('勾上以后又点“不同意”：按不同意记（以按的按钮为准）', async () => {
    const { api, calls } = fakeApi();
    render(<ConsentPage api={api} {...handlers()} />);
    fireEvent.click(checkbox());
    await act(async () => { fireEvent.click(declineBtn()); });
    expect(calls).toEqual([false]);
  });

  it('请求落定前一直忙碌（慢网时亮“还在保存”），两个按钮都点不了，不会重复提交', async () => {
    let release: (r: Result) => void = () => undefined;
    let slow: (() => void) | undefined;
    const api: ConsentApi = {
      record: vi.fn((_agree: boolean, onSlow?: () => void) => { slow = onSlow; return new Promise<Result>((res) => { release = res; }); }),
      noticeState: vi.fn(async () => ({ ok: true as const, value: 'first' as const })),
    };
    const h = handlers();
    render(<ConsentPage api={api} {...h} />);
    fireEvent.click(checkbox());
    fireEvent.click(agreeBtn());
    const busyAgree = screen.getByRole('button', { name: zh['consent.busy'] }) as HTMLButtonElement;
    expect(busyAgree.disabled).toBe(true);
    expect(declineBtn().disabled).toBe(true);
    expect(screen.queryByTestId('consent-slow')).toBeNull();
    act(() => { slow?.(); });
    expect(screen.getByTestId('consent-slow').textContent).toBe(zh['consent.slow']);
    fireEvent.click(busyAgree);
    fireEvent.click(declineBtn());
    expect(api.record).toHaveBeenCalledTimes(1);
    await act(async () => { release({ ok: true, value: undefined }); });
    expect(h.onDone).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.queryByTestId('consent-slow')).toBeNull();
  });

  it('失败（断网、版本刚升、不确定记下没有）：留在本页给提示，不调 onDone；再点一次成功', async () => {
    const { api, calls } = fakeApi([{ ok: false, error: 'offline' }, { ok: false, error: 'version_changed' }, { ok: false, error: 'unsure' }, { ok: true, value: undefined }]);
    const h = handlers();
    render(<ConsentPage api={api} {...h} />);
    fireEvent.click(checkbox());
    for (const key of ['consent.err.offline', 'consent.err.version', 'consent.err.unsure'] as const) {
      await act(async () => { fireEvent.click(agreeBtn()); });
      expect(screen.getByTestId('consent-error').textContent).toBe(zh[key]);
      expect(h.onDone).not.toHaveBeenCalled();
      expect(checkbox().checked).toBe(true);
    }
    await act(async () => { fireEvent.click(agreeBtn()); });
    expect(screen.queryByTestId('consent-error')).toBeNull();
    expect(calls).toEqual([true, true, true, true]);
    expect(h.onDone).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('R-239：notice 为空或认不出（no_policy）——不说“刚更新过”，提示先不使用 AI；只剩“继续使用”→ onSkip', async () => {
    const { api } = fakeApi([{ ok: false, error: 'no_policy' }]);
    const h = handlers();
    render(<ConsentPage api={api} {...h} />);
    await act(async () => { fireEvent.click(declineBtn()); });
    expect(screen.getByTestId('consent-error').textContent).toBe(zh['consent.err.noPolicy']);
    expect(screen.queryByText(zh['consent.err.version'])).toBeNull();
    expect(screen.queryByRole('button', { name: zh['consent.agree'] })).toBeNull();
    expect(screen.queryByRole('button', { name: zh['consent.decline'] })).toBeNull();
    expect(checkbox().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: zh['consent.continue'] }));
    expect(h.onSkip).toHaveBeenCalledOnce();
    expect(h.onDone).not.toHaveBeenCalled();
    expect(api.record).toHaveBeenCalledTimes(1);
  });

  it('会话被吊销：交给 onRevoked，不显示本页的提示', async () => {
    const { api } = fakeApi([{ ok: false, error: 'revoked' }]);
    const h = handlers();
    render(<ConsentPage api={api} {...h} />);
    await act(async () => { fireEvent.click(declineBtn()); });
    expect(h.onRevoked).toHaveBeenCalledOnce();
    expect(h.onDone).not.toHaveBeenCalled();
    expect(screen.queryByTestId('consent-error')).toBeNull();
  });

  it('账号停用（disabled）：交给 onDisabled，不走 onRevoked、不显示本页提示', async () => {
    const { api } = fakeApi([{ ok: false, error: 'disabled' }]);
    const h = handlers();
    render(<ConsentPage api={api} {...h} />);
    fireEvent.click(checkbox());
    await act(async () => { fireEvent.click(agreeBtn()); });
    expect(h.onDisabled).toHaveBeenCalledOnce();
    expect(h.onRevoked).not.toHaveBeenCalled();
    expect(h.onDone).not.toHaveBeenCalled();
    expect(screen.queryByTestId('consent-error')).toBeNull();
  });

  it('韩文界面：视觉稿韩文、R-115 韩文句，链接新开页面指向 /ko/privacy、/ko/terms', () => {
    uiStore.getState().setLocale('ko-KR');
    const { api } = fakeApi();
    render(<ConsentPage api={api} {...handlers()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(ko['consent.title']);
    expect(screen.getByTestId('consent-privacy').textContent).toBe(ko['consent.privacy']);
    expect(screen.getByRole('button', { name: ko['consent.decline'] })).toBeTruthy();
    expect(screen.getByTestId('consent-send').textContent).toBe(`${ko['consent.send.label']} ${ko['consent.send.body']} ${ko['consent.send.msLabel']} ${ko['consent.send.msBody']}`);
    const link = screen.getByRole('link', { name: ko['consent.privacyLink'] });
    expect(link.getAttribute('href')).toBe('/ko/privacy');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('link', { name: ko['consent.termsLink'] }).getAttribute('href')).toBe('/ko/terms');
  });

  it('中文界面：链接指向 /zh/privacy、/zh/terms，新开页面带 noopener noreferrer', () => {
    const { api } = fakeApi();
    render(<ConsentPage api={api} {...handlers()} />);
    expect(screen.getByTestId('consent-send').textContent).toBe(`${zh['consent.send.label']}${zh['consent.send.body']}${zh['consent.send.msLabel']}${zh['consent.send.msBody']}`);
    for (const [name, href] of [[zh['consent.privacyLink'], '/zh/privacy'], [zh['consent.termsLink'], '/zh/terms']] as const) {
      const a = screen.getByRole('link', { name });
      expect(a.getAttribute('href')).toBe(href);
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });
});
