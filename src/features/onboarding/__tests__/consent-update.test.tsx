// “隐私说明更新了”那一屏（接手清单 CONSENT-updated；R-115；视觉稿 皮肤视觉稿.html 的 PH.privupd、PH.privupdko；TC-B1-11 的单元一侧）：
// • 页面：标题、四行“这次多了什么”（图片和附件、日程和待办带“新”标签）、会送出去的东西、R-115 句；勾选框默认不勾，勾上才能“同意并继续”；
//   两个按钮都调 record_consent（写回 profiles.consent_policy_ver，服务器 RPC 不变）；中韩切换
// • 关口：noticeState 回 updated 时先显示这一屏、不画 App；同意 → 写 ai.enabled = true 后放行；不同意 → 不写、放行
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type { ConsentApi, NoticeState, Result } from '../data/consent-api.ts';
import type { ConsentWiringDeps } from '../hooks/useConsentWiring.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import ConsentGate from '../ui/ConsentGate.tsx';
import ConsentPage from '../ui/ConsentPage.tsx';

/** results：record 依次返回的结果（用完以后一直回最后一个；不给就一直成功） */
function fakeApi(notice: NoticeState = 'updated', results: Result[] = [{ ok: true, value: undefined }]) {
  const calls: boolean[] = [];
  let i = 0;
  const api: ConsentApi = {
    record: vi.fn(async (agree: boolean): Promise<Result> => {
      calls.push(agree);
      return results[Math.min(i++, results.length - 1)] ?? { ok: true, value: undefined };
    }),
    noticeState: vi.fn(async (): Promise<Result<NoticeState>> => ({ ok: true, value: notice })),
  };
  return { api, calls };
}

const handlers = () => ({ onDone: vi.fn(), onRevoked: vi.fn(), onDisabled: vi.fn(), onSkip: vi.fn() });
const updateShown = (): boolean => document.querySelector('main[data-feature="onboarding"][data-step="policy-update"]') !== null;
const firstShown = (): boolean => document.querySelector('[data-step="consent"]') !== null;
const checkbox = () => screen.getByRole('checkbox', { name: zh['consent.update.check'] }) as HTMLInputElement;
const agreeBtn = () => screen.getByRole('button', { name: zh['consent.agree'] }) as HTMLButtonElement;
const declineBtn = () => screen.getByRole('button', { name: zh['consent.decline'] }) as HTMLButtonElement;

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  window.history.replaceState(null, '', '#/today');
});
afterEach(cleanup);

describe('“隐私说明更新了”那一屏（PH.privupd）', () => {
  it('标题、四行“这次多了什么”（图片和附件、日程和待办带“新”）、会送出去的东西、R-115 句都在；没有首次告知页的条款句', () => {
    const { api } = fakeApi();
    render(<ConsentPage api={api} variant="updated" {...handlers()} />);
    expect(updateShown()).toBe(true);
    expect(firstShown()).toBe(false);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(zh['consent.update.title']);
    expect(screen.getByText(zh['consent.update.lead'])).toBeTruthy();
    const items = [...screen.getByTestId('consent-items').querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual([
      `${zh['consent.item.media']}${zh['consent.newTag']}${zh['consent.update.item.media.d']}`,
      `${zh['consent.item.plus']}${zh['consent.update.item.plus.d']}`,
      `${zh['consent.item.cal']}${zh['consent.newTag']}${zh['consent.update.item.cal.d']}`,
      `${zh['consent.update.item.ppt']}${zh['consent.update.item.ppt.d']}`,
    ]);
    expect(screen.getByTestId('consent-privacy').textContent).toBe(zh['consent.privacy']);
    expect(screen.queryByText(zh['consent.terms'])).toBeNull();
    expect(screen.getByTestId('consent-send').textContent).toContain(zh['consent.send.msBody']);
    expect(screen.getByText(zh['consent.update.declineNote'])).toBeTruthy();
    expect(screen.queryByText(zh['consent.declineNote'])).toBeNull();
  });

  it('勾选框默认不勾；没勾时点“同意并继续”不提交；勾上后同意 → record_consent(同意)、onDone(true)', async () => {
    const { api, calls } = fakeApi();
    const h = handlers();
    render(<ConsentPage api={api} variant="updated" {...h} />);
    expect(checkbox().checked).toBe(false);
    expect(agreeBtn().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(agreeBtn());
    expect(api.record).not.toHaveBeenCalled();
    fireEvent.click(checkbox());
    await act(async () => { fireEvent.click(agreeBtn()); });
    expect(calls).toEqual([true]);
    expect(h.onDone).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('“先不同意，直接用”：record_consent(不同意)、onDone(false)', async () => {
    const { api, calls } = fakeApi();
    const h = handlers();
    render(<ConsentPage api={api} variant="updated" {...h} />);
    await act(async () => { fireEvent.click(declineBtn()); });
    expect(calls).toEqual([false]);
    expect(h.onDone).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('韩文：照 PH.privupdko', () => {
    act(() => uiStore.getState().setLocale('ko-KR'));
    const { api } = fakeApi();
    render(<ConsentPage api={api} variant="updated" {...handlers()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('개인정보 처리 안내가 바뀌었어요');
    expect(screen.getByRole('checkbox', { name: '바뀐 내용에 동의해요' })).toBeTruthy();
    expect(screen.getByRole('button', { name: ko['consent.agree'] })).toBeTruthy();
    expect(screen.getByTestId('consent-items').querySelectorAll('li')[3]?.textContent)
      .toBe('PPT 미리보기파일이 마이크로소프트로 가요 (비밀 메모의 PPT 포함)');
  });
});

describe('启动关口遇到 updated（CONSENT-updated）', () => {
  function deps() {
    const enableAi = vi.fn(async (): Promise<unknown> => undefined);
    const leave = vi.fn(async (): Promise<boolean | void> => undefined);
    return { deps: { enableAi, leave } satisfies ConsentWiringDeps, enableAi };
  }

  async function renderGate(api: ConsentApi, wiring: ConsentWiringDeps) {
    const onPass = vi.fn();
    await act(async () => {
      render(<ConsentGate api={api} wiring={wiring} onPass={onPass} />);
    });
    return onPass;
  }

  it('先显示更新页、不放行；同意 → 写 ai.enabled = true 后放行（只一次）', async () => {
    const { api, calls } = fakeApi();
    const { deps: w, enableAi } = deps();
    const onPass = await renderGate(api, w);
    expect(updateShown()).toBe(true);
    expect(firstShown()).toBe(false);
    expect(onPass).not.toHaveBeenCalled();
    fireEvent.click(checkbox());
    await act(async () => { fireEvent.click(agreeBtn()); });
    expect(calls).toEqual([true]);
    expect(enableAi).toHaveBeenCalledOnce();
    expect(onPass).toHaveBeenCalledOnce();
    expect(updateShown()).toBe(false);
  });

  it('不同意 → 不写 ai.enabled、放行', async () => {
    const { api, calls } = fakeApi();
    const { deps: w, enableAi } = deps();
    const onPass = await renderGate(api, w);
    await act(async () => { fireEvent.click(declineBtn()); });
    expect(calls).toEqual([false]);
    expect(enableAi).not.toHaveBeenCalled();
    expect(onPass).toHaveBeenCalledOnce();
  });

  const failures: [string, Result][] = [
    ['offline', { ok: false, error: 'offline' }],
    ['version_changed', { ok: false, error: 'version_changed' }],
  ];
  it.each(failures)('record 回 %s：留在更新页、给提示、不放行；再点一次成功才放行', async (code, fail) => {
    const { api, calls } = fakeApi('updated', [fail, { ok: true, value: undefined }]);
    const { deps: w, enableAi } = deps();
    const onPass = await renderGate(api, w);
    fireEvent.click(checkbox());
    await act(async () => { fireEvent.click(agreeBtn()); });
    expect(calls).toEqual([true]);
    expect(updateShown()).toBe(true);
    expect(screen.getByTestId('consent-error').getAttribute('data-error')).toBe(code);
    expect(onPass).not.toHaveBeenCalled();
    expect(enableAi).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(agreeBtn()); });
    expect(calls).toEqual([true, true]);
    expect(enableAi).toHaveBeenCalledOnce();
    expect(onPass).toHaveBeenCalledOnce();
    expect(updateShown()).toBe(false);
  });

  it('first 照旧显示首次告知页（不是更新页）', async () => {
    const { api } = fakeApi('first');
    await renderGate(api, deps().deps);
    expect(firstShown()).toBe(true);
    expect(updateShown()).toBe(false);
  });
});
